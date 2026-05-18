-- ════════════════════════════════════════════════════════════════════════
-- Migración 70 — Trigger de normalización de competition_name + backfill
--
-- POR QUÉ:
--   Tras aplicar mig 68 y mig 69, el admin re-subió el Excel pero el front
--   en el browser tenía cacheado el código viejo (pre-fix). Resultado:
--     - 728 filas entraron sin espacio (YangoEconomy, CabifyLite, ...)
--     - 1452 filas se aplastaron de Premier+Comfort+ → 'Yango' anónimo.
--     - 228 filas como 'YangoPlus' (probable typo en Excel).
--     - Las ~595 que mig 68 dejó canónicas quedaron en 5-7 c/u tras
--       el DELETE-por-rango del Upload.jsx.
--
--   Tener la normalización SÓLO en el frontend es frágil: cualquier cache
--   stale, deploy parcial o pipeline alterno revive el bug.
--
-- ESTRATEGIA DE DEFENSA EN PROFUNDIDAD:
--   Trigger BEFORE INSERT OR UPDATE en pricing_observations que normaliza
--   competition_name según city. Independiente del cliente que escriba.
--
--   Lógica del trigger (mismo dict que src/lib/normalize.js):
--     1. Casing universal: 'uber'→'Uber', 'yango'→'Yango', etc.
--     2. Si city='Corp', mapear sub-variantes pegadas a canónico con espacio:
--          YangoEconomy   → Yango Economy
--          YangoComfort   → Yango Comfort
--          YangoComfort+  → Yango Comfort+
--          YangoComfortPlus → Yango Comfort+
--          YangoPlus      → Yango Comfort+   (hipótesis verificada por precios)
--          YangoPremier   → Yango Premier
--          YangoXL        → Yango XL
--          CabifyLite     → Cabify Lite
--          CabifyExtraComfort → Cabify Extra Comfort
--          CabifyXL       → Cabify XL
--     3. Pass-through cualquier otra cosa.
--
-- ADICIONAL:
--   - Backfill exhaustivo aplicando las mismas reglas a las filas actuales
--     en Corp.
--   - DELETE de las 1452 filas Corp con competition_name='Yango' anónimo
--     (irrecuperables; el admin debe re-subir el Excel).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── (A) Función helper de normalización ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.normalize_competitor_name(
  raw  text,
  city text
) RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  trimmed text;
  lc      text;
  fp      text;
BEGIN
  IF raw IS NULL THEN RETURN NULL; END IF;
  trimmed := btrim(raw);
  IF trimmed = '' THEN RETURN trimmed; END IF;
  lc := lower(trimmed);

  -- (1) Casing universal — siempre aplica
  CASE lc
    WHEN 'uber'    THEN RETURN 'Uber';
    WHEN 'yango'   THEN RETURN 'Yango';
    WHEN 'didi'    THEN RETURN 'Didi';
    WHEN 'indrive' THEN RETURN 'InDrive';
    WHEN 'cabify'  THEN RETURN 'Cabify';
    ELSE
      -- continúa
  END CASE;

  -- (2) Corp aliases — sólo si city='Corp'
  IF city = 'Corp' THEN
    -- "fingerprint": lowercase sin espacios. Tolera variantes.
    fp := regexp_replace(lc, '\s+', '', 'g');
    CASE fp
      WHEN 'yangoeconomy'        THEN RETURN 'Yango Economy';
      WHEN 'yangocomfort'        THEN RETURN 'Yango Comfort';
      WHEN 'yangocomfort+'       THEN RETURN 'Yango Comfort+';
      WHEN 'yangocomfortplus'    THEN RETURN 'Yango Comfort+';
      WHEN 'yangoplus'           THEN RETURN 'Yango Comfort+';
      WHEN 'yangopremier'        THEN RETURN 'Yango Premier';
      WHEN 'yangoxl'             THEN RETURN 'Yango XL';
      WHEN 'cabifylite'          THEN RETURN 'Cabify Lite';
      WHEN 'cabifyextracomfort'  THEN RETURN 'Cabify Extra Comfort';
      WHEN 'cabifyxl'            THEN RETURN 'Cabify XL';
      ELSE
        -- continúa con passthrough
    END CASE;
  END IF;

  -- (3) Pass-through
  RETURN trimmed;
END;
$$;

COMMENT ON FUNCTION public.normalize_competitor_name(text, text) IS
  'Normaliza competition_name. Espejo SQL de src/lib/normalize.js normalizeCompetitorName. Si modificás uno, modificá el otro y los tests JS.';

-- ── (B) Trigger BEFORE INSERT/UPDATE en pricing_observations ────────────
CREATE OR REPLACE FUNCTION public.tg_normalize_pricing_observations()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.competition_name IS NOT NULL THEN
    NEW.competition_name := public.normalize_competitor_name(NEW.competition_name, NEW.city);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_competitor ON public.pricing_observations;
CREATE TRIGGER trg_normalize_competitor
  BEFORE INSERT OR UPDATE OF competition_name, city
  ON public.pricing_observations
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_normalize_pricing_observations();

COMMENT ON TRIGGER trg_normalize_competitor ON public.pricing_observations IS
  'Aplica normalize_competitor_name antes de cada INSERT/UPDATE. Defense-in-depth: aunque el cliente envíe nombres no canónicos (frontend cache stale, script externo, etc.) la DB siempre persiste el canónico.';

-- ── (C) Backfill exhaustivo del estado actual ────────────────────────────
-- Aplicar la función a las filas existentes en Corp. Idempotente.
DO $audit$
DECLARE
  v_changed int;
BEGIN
  WITH updated AS (
    UPDATE public.pricing_observations
       SET competition_name = public.normalize_competitor_name(competition_name, city)
     WHERE country = 'Peru'
       AND city    = 'Corp'
       AND competition_name <> public.normalize_competitor_name(competition_name, city)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_changed FROM updated;
  RAISE NOTICE '[mig 70] Backfill Corp: % filas re-normalizadas.', v_changed;
END
$audit$;

-- También limpiar typos de casing fuera de Corp ('uber'→'Uber', etc.)
DO $audit$
DECLARE
  v_changed int;
BEGIN
  WITH updated AS (
    UPDATE public.pricing_observations
       SET competition_name = public.normalize_competitor_name(competition_name, city)
     WHERE country = 'Peru'
       AND competition_name IN ('uber','yango','didi','indrive','cabify','Indrive','DiDi')
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_changed FROM updated;
  RAISE NOTICE '[mig 70] Backfill casing universal: % filas re-normalizadas.', v_changed;
END
$audit$;

-- ── (D) DELETE de las filas Corp aplastadas a 'Yango' anónimo ───────────
-- Estas son Premier+Comfort+ que el frontend cacheado aplastó. Irrecuperables
-- desde la DB. El admin debe re-subir el Excel (con el front deployed).
DO $audit$
DECLARE
  v_deleted int;
BEGIN
  WITH deleted AS (
    DELETE FROM public.pricing_observations
     WHERE country='Peru'
       AND city='Corp'
       AND competition_name='Yango'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_deleted FROM deleted;
  RAISE NOTICE '[mig 70] DELETE de filas Corp "Yango" anónimas: % filas. RE-SUBIR EL EXCEL DESPUÉS DE CONFIRMAR QUE EL FRONT TIENE EL FIX.', v_deleted;
END
$audit$;

-- ── (E) Verificación final ────────────────────────────────────────────────
DO $verify$
DECLARE
  v_state text;
BEGIN
  SELECT string_agg(competition_name || '=' || n, ', ' ORDER BY n DESC)
    INTO v_state
    FROM (
      SELECT competition_name, COUNT(*) AS n
        FROM pricing_observations
       WHERE country='Peru' AND city='Corp'
       GROUP BY competition_name
       ORDER BY n DESC
       LIMIT 15
    ) s;
  RAISE NOTICE '[mig 70] Estado final Corp: %', v_state;
END
$verify$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- DESPUÉS DE APLICAR ESTA MIGRACIÓN:
--
-- 1. Hacer HARD RELOAD del dashboard en el browser (Ctrl+Shift+R en Windows
--    o Cmd+Shift+R en macOS) para que descargue el JS nuevo con el fix.
--
-- 2. Confirmar visualmente que la página de Upload/Gestión tiene el código
--    nuevo. Test rápido: abrir Console del navegador (F12) y ejecutar:
--      console.log('test')
--    Si pide recargar, recargar.
--
-- 3. Re-subir el Excel original con datos de Corp.
--    AHORA, aunque el frontend escapara la normalización, el TRIGGER de
--    la DB la aplica al INSERT. Las filas siempre quedan canónicas.
--
-- 4. Verificar con:
--    SELECT competition_name, COUNT(*) FROM pricing_observations
--    WHERE country='Peru' AND city='Corp'
--    GROUP BY competition_name ORDER BY 2 DESC;
--
--    Esperado: 'Yango Premier' y 'Yango Comfort+' con ~595 filas cada uno.
-- ════════════════════════════════════════════════════════════════════════
