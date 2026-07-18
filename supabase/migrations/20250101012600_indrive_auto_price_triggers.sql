-- ════════════════════════════════════════════════════════════════════════
-- Migración 86 — Triggers automáticos de precios InDrive
--
-- CONTEXTO:
--   Hasta hoy, después de cada sync del bot el usuario tenía que apretar
--   manualmente el botón "⟳ Precios InDrive (bot)" del módulo Gestión de
--   Datos (RawData.jsx) para que el RPC `apply_indrive_bot_prices` hiciera
--   un UPDATE masivo poblando `price_without_discount` con
--   `recommended_price * (1 + adjustment_pct/100)`. Si se olvidaban del
--   click, el dashboard mostraba precios incorrectos hasta que alguien
--   se acordara.
--
--   Lo mismo pasaba al editar `indrive_config.adjustment_pct`: nada
--   pasaba con la data existente hasta el siguiente click.
--
-- DESIGN:
--   Mover la lógica al motor de la base con DOS triggers:
--
--     1) BEFORE INSERT en pricing_observations (fila a fila)
--        → Cada nueva fila InDrive bot lookupea indrive_config por
--          (country, city, category) y setea price_without_discount
--          inline. Cost: 1 SELECT por insert (índice
--          idx_indrive_config_country_city, ~µs). Cero impacto en
--          inserts no-InDrive (early-return por filtro).
--
--     2) AFTER UPDATE en indrive_config (statement-level efectivo,
--        FOR EACH ROW pero solo dispara cuando cambia adjustment_pct)
--        → Re-aplica la fórmula al subconjunto de pricing_observations
--          afectado, con el mismo guard idempotente y statement_timeout
--          de mig 73+75.
--
-- QUÉ HACE:
--   • Trigger #1 elimina la necesidad del click después de cada sync:
--     las filas nuevas ya entran con el precio correcto.
--   • Trigger #2 elimina la necesidad del click después de editar el %:
--     la propagación a filas existentes es automática.
--   • El botón manual sigue existiendo como "force re-apply" de
--     emergencia (p.ej. si alguien hace un backfill raro o si el
--     adjustment_pct se cambia masivamente vía SQL directo).
--
-- COEXISTENCIA CON OTROS TRIGGERS:
--   pricing_observations ya tiene:
--     • airport_route_before_insert (mig 83) — modifica NEW.city
--     • normalize_competitor_before_insert (mig 70) — modifica
--       NEW.competition_name
--   Postgres dispara triggers BEFORE en orden alfabético del nombre.
--   Nombramos este trigger `zz_indrive_price_before_insert` para que
--   corra DESPUÉS de airport_route (cambia city) y de
--   normalize_competitor (cambia competition_name). Así el lookup a
--   indrive_config se hace con los valores ya canonicalizados.
--   Modifican columnas distintas (city vs competition_name vs
--   price_without_discount) → no hay conflicto de escritura.
--
-- IDEMPOTENCIA:
--   CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS.
--   Re-aplicar la mig N veces es seguro.
--
-- SEGURIDAD:
--   SECURITY DEFINER + search_path = public, pg_temp.
--   Los triggers leen indrive_config saltando RLS (el INSERT lo hace
--   `authenticated` o `service_role`; indrive_config tiene policy
--   auth_all en SELECT pero igual blindamos por si endurecemos RLS
--   en el futuro).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. BEFORE INSERT: setear price_without_discount inline ────────────

CREATE OR REPLACE FUNCTION trg_apply_indrive_price_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_adj numeric;
BEGIN
  -- Early return: solo nos importan filas InDrive bot con recomendado válido
  IF NEW.competition_name IS DISTINCT FROM 'InDrive'
     OR NEW.data_source    IS DISTINCT FROM 'bot'
     OR NEW.recommended_price IS NULL
     OR NEW.recommended_price <= 0
     OR NEW.country  IS NULL
     OR NEW.city     IS NULL
     OR NEW.category IS NULL
  THEN
    RETURN NEW;
  END IF;

  -- Lookup del ajuste (índice idx_indrive_config_country_city)
  SELECT ic.adjustment_pct
    INTO v_adj
  FROM indrive_config ic
  WHERE ic.country  = NEW.country
    AND ic.city     = NEW.city
    AND ic.category = NEW.category
  LIMIT 1;

  -- Si no hay config para (country,city,category) → no tocar (mantiene
  -- comportamiento histórico: el RPC tampoco actualizaba esos casos)
  IF v_adj IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.price_without_discount := ROUND(
    NEW.recommended_price * (1 + v_adj / 100.0),
    2
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_indrive_price_before_insert ON public.pricing_observations;

CREATE TRIGGER zz_indrive_price_before_insert
  BEFORE INSERT ON public.pricing_observations
  FOR EACH ROW
  EXECUTE FUNCTION trg_apply_indrive_price_on_insert();

COMMENT ON FUNCTION trg_apply_indrive_price_on_insert() IS
  'BEFORE INSERT: si la fila es InDrive bot con recommended_price válido, '
  'busca indrive_config.adjustment_pct para (country,city,category) y '
  'setea NEW.price_without_discount = recommended_price * (1 + adj/100). '
  'Reemplaza el click manual del botón "⟳ Precios InDrive (bot)" para '
  'filas nuevas. Se llama zz_* para correr DESPUÉS de '
  'airport_route_before_insert (mig 83) y normalize_competitor (mig 70).';


-- ── 2. AFTER UPDATE en indrive_config: propagar a filas existentes ────

CREATE OR REPLACE FUNCTION trg_indrive_config_propagate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '120s'
AS $$
BEGIN
  -- Solo propagamos si cambió adjustment_pct (otros cambios — note,
  -- updated_at — no afectan el precio)
  IF NEW.adjustment_pct IS NOT DISTINCT FROM OLD.adjustment_pct THEN
    RETURN NEW;
  END IF;

  -- Mismo UPDATE que apply_indrive_bot_prices (mig 73/75), restringido
  -- al (country, city, category) de la fila que cambió. Guard idempotente
  -- para evitar re-escribir filas que ya tienen el valor correcto
  -- (paranoia: cubre el caso de que adjustment_pct cambie y vuelva).
  UPDATE pricing_observations po
  SET price_without_discount = ROUND(
    po.recommended_price * (1 + NEW.adjustment_pct / 100.0),
    2
  )
  WHERE po.competition_name   = 'InDrive'
    AND po.data_source         = 'bot'
    AND po.recommended_price  IS NOT NULL
    AND po.recommended_price   > 0
    AND po.country             = NEW.country
    AND po.city                = NEW.city
    AND po.category            = NEW.category
    AND po.price_without_discount IS DISTINCT FROM
        ROUND(po.recommended_price * (1 + NEW.adjustment_pct / 100.0), 2);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS indrive_config_propagate_after_update ON public.indrive_config;

CREATE TRIGGER indrive_config_propagate_after_update
  AFTER UPDATE ON public.indrive_config
  FOR EACH ROW
  EXECUTE FUNCTION trg_indrive_config_propagate();

COMMENT ON FUNCTION trg_indrive_config_propagate() IS
  'AFTER UPDATE en indrive_config: si cambia adjustment_pct, recomputa '
  'price_without_discount para todas las filas InDrive bot existentes '
  'de ese (country,city,category). Mismo guard idempotente y '
  'statement_timeout=120s que apply_indrive_bot_prices (mig 73/75). '
  'Reemplaza el click manual del botón después de editar el % de ajuste.';

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--
-- 1. Triggers creados:
--    SELECT tgname, tgrelid::regclass, tgenabled
--    FROM pg_trigger
--    WHERE tgname IN ('zz_indrive_price_before_insert',
--                     'indrive_config_propagate_after_update');
--    → ambos con tgenabled = 'O'
--
-- 2. Funciones con SECURITY DEFINER + search_path + (timeout en #2):
--    SELECT proname, prosecdef, proconfig
--    FROM pg_proc
--    WHERE proname IN ('trg_apply_indrive_price_on_insert',
--                      'trg_indrive_config_propagate');
--    → prosecdef = true en ambas
--    → proconfig contiene "search_path=public, pg_temp"
--    → la segunda además contiene "statement_timeout=120s"
--
-- 3. Smoke test BEFORE INSERT (rollback al final):
--    BEGIN;
--    -- Suponiendo indrive_config tiene (Peru, Lima, Economy, adj=10)
--    INSERT INTO pricing_observations
--      (country, city, category, competition_name, data_source,
--       observed_date, recommended_price, price_without_discount)
--    VALUES ('Peru', 'Lima', 'Economy', 'InDrive', 'bot',
--            CURRENT_DATE, 10.00, NULL);
--    SELECT price_without_discount
--    FROM pricing_observations
--    WHERE competition_name = 'InDrive' AND data_source = 'bot'
--      AND country = 'Peru' AND city = 'Lima' AND category = 'Economy'
--      AND observed_date = CURRENT_DATE
--    ORDER BY id DESC LIMIT 1;
--    -- esperás: 11.00 (10 * 1.10)
--    ROLLBACK;
--
-- 4. Smoke test AFTER UPDATE en indrive_config (rollback al final):
--    BEGIN;
--    -- Pre: contar filas que cambiarían
--    SELECT COUNT(*) FROM pricing_observations
--    WHERE competition_name = 'InDrive' AND data_source = 'bot'
--      AND country = 'Peru' AND city = 'Lima' AND category = 'Economy'
--      AND recommended_price > 0;
--    UPDATE indrive_config SET adjustment_pct = adjustment_pct + 0.01
--    WHERE country = 'Peru' AND city = 'Lima' AND category = 'Economy';
--    -- El trigger debe haber recomputado el price_without_discount
--    SELECT price_without_discount, recommended_price,
--           ROUND(price_without_discount / recommended_price, 4) AS factor
--    FROM pricing_observations
--    WHERE competition_name = 'InDrive' AND data_source = 'bot'
--      AND country = 'Peru' AND city = 'Lima' AND category = 'Economy'
--      AND recommended_price > 0
--    LIMIT 5;
--    -- factor debe reflejar el nuevo adjustment_pct
--    ROLLBACK;
--
-- 5. El botón manual ("⟳ Precios InDrive (bot)") puede quedarse como
--    botón de emergencia "force re-apply": llama al RPC mig 75, que
--    sigue siendo idempotente y barato gracias al guard IS DISTINCT FROM.
-- ════════════════════════════════════════════════════════════════════════
