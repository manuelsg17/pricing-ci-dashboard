-- ════════════════════════════════════════════════════════════════════════
-- Migración 63 — updated_at + optimistic locking en tablas críticas
--
-- POR QUÉ:
--   Con cuentas compartidas (mismo email en varios browsers), dos
--   sesiones pueden abrir el mismo form (ej: wizard de Peru), una
--   guarda, la otra guarda 30s después sin saber del cambio → clobber
--   silencioso. El audit_log de la mig 62 deja evidencia pero el dato
--   ya se perdió.
--
-- DISEÑO:
--   - Cada tabla crítica tiene columna updated_at (la mayoría ya la
--     tiene). Si falta, agregar.
--   - Trigger BEFORE UPDATE que actualiza updated_at a now() y verifica
--     que el cliente mandó el updated_at que leyó originalmente.
--   - Si NEW.updated_at <> OLD.updated_at → RAISE EXCEPTION con código
--     'P0001' y mensaje localizable. El cliente lo intercepta y muestra:
--       "Esta config fue modificada por otra sesión. Refrescá antes de
--        guardar."
--
-- HOW THE CLIENT USES IT:
--   1. Lee row → guarda updated_at en estado local.
--   2. Al guardar, manda el updated_at original como WHERE clause:
--        UPDATE country_config
--        SET label = $1, ...
--        WHERE country_key = $2 AND updated_at = $3
--   3. Si 0 filas afectadas → otra sesión ganó → mostrar warning.
--   4. ALTERNATIVA: trigger compara NEW.updated_at vs OLD.updated_at.
--      Si difieren → ABORT.
--
--   Elegimos la alternativa (trigger) porque es más simple para el
--   cliente: no tiene que poner el updated_at en WHERE. El cliente solo
--   asegura mandar el updated_at viejo en el UPDATE.
--
-- BACKWARDS-COMPAT:
--   Si el cliente NO manda updated_at, el trigger NO falla (NEW.updated_at
--   = NULL o = now()). Solo se activa cuando el cliente Sí lo manda y
--   no coincide con la DB. Esto permite rollout gradual de la UI.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A. Asegurar updated_at en tablas críticas ──────────────────────────

DO $migration$
DECLARE
  t text;
  tables_need_updated_at text[] := ARRAY[
    'country_config',
    'catalog_extras',
    'bracket_weights',
    'bracket_weights_by_category',
    'distance_thresholds',
    'semaforo_config',
    'rush_hour_windows',
    'price_validation_rules',
    'indrive_config',
    'bot_rules'
  ];
BEGIN
  FOREACH t IN ARRAY tables_need_updated_at LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()',
        t
      );
      RAISE NOTICE 'updated_at ensured: %', t;
    END IF;
  END LOOP;
END
$migration$;


-- ── B. Trigger: optimistic locking ─────────────────────────────────────
--
-- Lógica:
--   - Si NEW.updated_at es NULL → cliente no mandó nada → asumir que es
--     ok (modo legacy). Setear NEW.updated_at = now().
--   - Si NEW.updated_at = OLD.updated_at → cliente leyó la versión actual
--     → ok. Setear NEW.updated_at = now() (avanza el versionado).
--   - Si difieren → otra sesión modificó. ABORT.

CREATE OR REPLACE FUNCTION check_optimistic_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- INSERT: solo setear updated_at, no hay nada que verificar
  IF TG_OP = 'INSERT' THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  -- UPDATE: chequear versión
  IF TG_OP = 'UPDATE' THEN
    -- Cliente NO mandó updated_at → modo legacy, solo avanzar timestamp
    IF NEW.updated_at IS NULL OR NEW.updated_at = OLD.updated_at THEN
      NEW.updated_at := now();
      RETURN NEW;
    END IF;

    -- Cliente mandó un updated_at distinto al actual de la DB →
    -- esto significa que el cliente leyó una versión vieja Y otra
    -- sesión actualizó la fila mientras tanto. ABORT.
    --
    -- Hack: si NEW.updated_at > OLD.updated_at, asumimos que el cliente
    -- está re-aplicando una versión "futura" (raro) y NO bloqueamos.
    -- El caso peligroso es NEW < OLD (cliente leyó viejo, otra sesión
    -- ya actualizó OLD.updated_at).
    IF NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION
        'stale_update: row was modified by another session at %. Current value: %. Refresh and try again.',
        OLD.updated_at, NEW.updated_at
        USING ERRCODE = 'P0001',
              HINT    = 'reload_required';
    END IF;

    -- Avanzar timestamp
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

GRANT EXECUTE ON FUNCTION check_optimistic_lock() TO authenticated;


-- ── C. Aplicar trigger a tablas críticas ──────────────────────────────

DO $migration$
DECLARE
  t text;
  locked_tables text[] := ARRAY[
    'country_config',
    'catalog_extras',
    'bracket_weights',
    'bracket_weights_by_category',
    'distance_thresholds',
    'semaforo_config',
    'rush_hour_windows',
    'price_validation_rules',
    'indrive_config',
    'bot_rules'
  ];
BEGIN
  FOREACH t IN ARRAY locked_tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_optimistic_lock_%I ON public.%I', t, t);
      EXECUTE format(
        'CREATE TRIGGER trg_optimistic_lock_%I
         BEFORE INSERT OR UPDATE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION check_optimistic_lock()',
        t, t
      );
      RAISE NOTICE 'Optimistic locking attached: %', t;
    END IF;
  END LOOP;
END
$migration$;


COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN POST-APLICACIÓN
--
-- 1. Leer un row:
--      SELECT country_key, updated_at FROM country_config WHERE country_key='Peru';
--      → guarda timestamp T1
--
-- 2. Simular otra sesión actualizando:
--      UPDATE country_config SET label = label WHERE country_key='Peru';
--      → updated_at ahora es T2 > T1
--
-- 3. Cliente intenta guardar con T1:
--      UPDATE country_config SET label = 'X', updated_at = 'T1'::timestamptz
--      WHERE country_key='Peru';
--      → debe fallar con: stale_update: row was modified...
--
-- 4. Sin updated_at (modo legacy):
--      UPDATE country_config SET label = 'X' WHERE country_key='Peru';
--      → funciona (no verifica versión, solo avanza timestamp)
-- ════════════════════════════════════════════════════════════════════════
