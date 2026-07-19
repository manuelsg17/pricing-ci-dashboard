-- ════════════════════════════════════════════════════════════════════════
-- Migración — Trigger de normalización de distance_bracket
--
-- POR QUÉ (Fase 1.4 paso 2, distance_bracket):
--   competition_name ya tiene un trigger BEFORE INSERT/UPDATE que lo
--   normaliza sin importar quién escriba (mig 70/72/97, trg_normalize_
--   competitor). distance_bracket NUNCA tuvo el equivalente — la función
--   normalize_distance_bracket() existe desde mig 47 (con fallback de
--   prefijo agregado en mig 51), pero solo la invoca sync_bot_quotes(),
--   una RPC pull-based que el pipeline real (scripts/bot-sync/
--   bot_sync_push.py, push-based) no usa. Resultado: "cobertura desigual"
--   en vez de doble escritura (ver scripts/check-normalization-drift.sql
--   y el commit de Fase 1.4 paso 1) — el upload manual (Upload.jsx) solo
--   aplica un normalizador débil (BRACKET_NORMALIZE dict + toSnakeCase,
--   sin colapsar variantes zone-aware tipo long_a/airport_short_b/
--   *_zona_sur/*_madrid), y bot_sync_push.py tiene su propia reimplementación
--   Python desactualizada (sin el fallback de prefijo de mig 51).
--
-- QUÉ HACE:
--   Extiende el trigger existente trg_normalize_competitor (que ya corre
--   BEFORE INSERT/UPDATE en pricing_observations) para que TAMBIÉN
--   normalice distance_bracket con la función normalize_distance_bracket()
--   ya existente (mig 47/51, sin cambios de lógica acá). Un solo trigger,
--   un solo lugar donde se decide "qué se persiste", igual que ya se hizo
--   para competition_name. Se renombra a trg_normalize_pricing_observations
--   porque ya no es solo de competidor.
--
--   IMPORTANTE — alcance deliberadamente acotado (nunca atómico): esta
--   migración SOLO agrega el trigger. NO se toca todavía la normalización
--   JS redundante en Upload.jsx (BRACKET_NORMALIZE/normalizeBracket) ni
--   scripts/bot-sync/bot_sync_push.py (que corre en una máquina externa,
--   redeploy manual, fuera del alcance de este repo). Se deja corriendo
--   en paralelo con el trigger — igual que se hizo con competition_name
--   en su momento (mig 70) antes de confiar en borrar el lado cliente.
--   El lado JS se retira en un cambio aparte y más chico, después de
--   correr scripts/check-normalization-drift.sql como ventana de
--   observación.
--
-- BACKFILL:
--   El baseline de Fase 1.4 paso 1 (1.36M filas de producción) ya midió
--   bracket_diverge=2 en manual (typo real, no normalización) y =0 en
--   bot — así que el backfill de esta migración debería tocar ~0 filas.
--   Se incluye igual por completitud/idempotencia, mismo patrón que mig 51.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── (A) Trigger function: normaliza competition_name Y distance_bracket ──
CREATE OR REPLACE FUNCTION public.tg_normalize_pricing_observations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.competition_name IS NOT NULL THEN
    NEW.competition_name := public.normalize_competitor_name(NEW.competition_name, NEW.city);
  END IF;
  IF NEW.distance_bracket IS NOT NULL THEN
    NEW.distance_bracket := public.normalize_distance_bracket(NEW.distance_bracket);
  END IF;
  RETURN NEW;
END;
$$;

-- ── (B) Reemplazar el trigger: ahora cubre distance_bracket también ──────
DROP TRIGGER IF EXISTS trg_normalize_competitor ON public.pricing_observations;
DROP TRIGGER IF EXISTS trg_normalize_pricing_observations ON public.pricing_observations;
CREATE TRIGGER trg_normalize_pricing_observations
  BEFORE INSERT OR UPDATE OF competition_name, city, distance_bracket
  ON public.pricing_observations
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_normalize_pricing_observations();

COMMENT ON TRIGGER trg_normalize_pricing_observations ON public.pricing_observations IS
  'Normaliza competition_name (mig 70/72/97) y distance_bracket (mig 47/51) antes de cada INSERT/UPDATE. Defense-in-depth: sin importar qué cliente escriba (upload manual, bot, RPC), la DB siempre persiste el canónico.';

-- ── (C) Backfill exhaustivo del estado actual ────────────────────────────
DO $audit$
DECLARE
  v_changed int;
BEGIN
  WITH updated AS (
    UPDATE public.pricing_observations
       SET distance_bracket = public.normalize_distance_bracket(distance_bracket)
     WHERE distance_bracket IS NOT NULL
       AND distance_bracket IS DISTINCT FROM public.normalize_distance_bracket(distance_bracket)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_changed FROM updated;
  RAISE NOTICE '[normalize_distance_bracket_trigger] Backfill: % filas re-normalizadas.', v_changed;
END
$audit$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- Verificación post-aplicación:
--
--   SELECT normalize_distance_bracket('long_a');           -- 'long'
--   SELECT normalize_distance_bracket('airport_short_b');  -- 'short'
--   SELECT normalize_distance_bracket('Very Long');         -- 'very_long'
--
--   INSERT de prueba (rollback):
--   BEGIN;
--     INSERT INTO pricing_observations
--       (country, city, observed_date, category, competition_name, distance_bracket, data_source)
--     VALUES ('Peru', 'Lima', current_date, 'Economy/Comfort', 'Uber', 'Long_A', 'manual')
--     RETURNING distance_bracket;  -- esperado: 'long'
--   ROLLBACK;
--
--   Correr scripts/check-normalization-drift.sql después de aplicar —
--   bracket_diverge debería quedar en 0 en todas las fuentes.
-- ════════════════════════════════════════════════════════════════════════
