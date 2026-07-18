-- ════════════════════════════════════════════════════════════════════════
-- Migración 71 — Guard estricto Corp + DELETE final de Yango anónimos
--
-- POR QUÉ:
--   Tras mig 70 (trigger de normalización), el usuario re-subió el Excel
--   con un browser cacheado (JS pre-fix). El trigger normalizó el SHAPE
--   (espacios) pero no pudo "des-aplastar" Premier+Comfort+ → 'Yango'
--   porque la información de sub-variante ya se había perdido en el
--   cliente. Resultado: 1452 filas como 'Yango' anónimo en Corp persisten.
--
--   El trigger de mig 70 es PERMISIVO (normaliza, no rechaza). Para que
--   este bug NO PUEDA volver a ocurrir silenciosamente, este trigger es
--   ESTRICTO: rechaza inserts inválidos en Corp con error claro.
--
-- LÓGICA DEL GUARD:
--   En city='Corp', el competidor 'Yango' (sin sufijo) NO es válido —
--   el catálogo (competitorsByDbCityCategory.Corp.Corp) requiere
--   {Yango Economy, Yango Comfort, Yango Comfort+, Yango Premier, Yango XL,
--    Cabify, Cabify Lite, Cabify Extra Comfort, Cabify XL}.
--
--   Si llega 'Yango' anónimo, es señal de que un cliente aplastó
--   Premier/Comfort+ por error. RAISE EXCEPTION con mensaje accionable.
--
--   En el resto de cities, 'Yango' es válido (es el competidor principal
--   en Lima E/C, Trujillo, Arequipa, etc.). NO afectamos esos paths.
--
-- ADICIONAL:
--   - DELETE de las 1452 filas Corp 'Yango' restantes (irrecuperables).
--   - El trigger se llama BEFORE INSERT OR UPDATE y CORRE DESPUÉS de
--     trg_normalize_competitor (mismo evento, orden alfabético por nombre).
--     Entonces el rechazo aplica sobre el competition_name YA normalizado.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── (A) DELETE de las 1452 filas anónimas restantes ─────────────────────
DO $cleanup$
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
  RAISE NOTICE '[mig 71] DELETE final de filas Corp "Yango" anónimas: % filas.', v_deleted;
END
$cleanup$;

-- ── (B) Función guard: rechaza inserts/updates inválidos ────────────────
CREATE OR REPLACE FUNCTION public.tg_guard_corp_competitor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Sólo aplicamos guard a Corp. El resto de cities mantienen 'Yango'
  -- como competidor legítimo (Lima E/C, Trujillo, etc.).
  IF NEW.city = 'Corp' THEN
    -- Rechazar 'Yango' anónimo en Corp. Mensaje accionable para el cliente
    -- que recibió el error: el fix está en src/algorithms/ingestionFilters.js
    -- y src/pages/Upload.jsx (COMPETITOR_YANGO_MASTER_FLATTEN debe NO
    -- aplicarse cuando city='Corp').
    IF NEW.competition_name = 'Yango' THEN
      RAISE EXCEPTION
        'Corp_invalid_competitor: "Yango" anónimo no es válido en city=Corp. '
        'Debe ser uno de: Yango Economy, Yango Comfort, Yango Comfort+, '
        'Yango Premier, Yango XL. Si estás re-subiendo un Excel, '
        'el frontend está cacheado — hacé hard reload (Ctrl+Shift+R) '
        'y verificá el deploy del último commit.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ── (C) Attach trigger AFTER del normalize trigger ──────────────────────
-- Orden de ejecución en pg: BEFORE triggers se disparan en orden alfabético
-- de su nombre. trg_normalize_competitor (mig 70) corre primero porque
-- empieza con 'trg_normalize'. trg_zz_guard_corp_competitor corre después
-- (prefijo 'trg_zz_' garantiza orden). Así el guard valida el competition_name
-- YA normalizado por mig 70.
DROP TRIGGER IF EXISTS trg_zz_guard_corp_competitor ON public.pricing_observations;
CREATE TRIGGER trg_zz_guard_corp_competitor
  BEFORE INSERT OR UPDATE OF competition_name, city
  ON public.pricing_observations
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_guard_corp_competitor();

COMMENT ON TRIGGER trg_zz_guard_corp_competitor ON public.pricing_observations IS
  'Guard estricto: rechaza ingestas a Corp con competition_name="Yango" anónimo. Captura el bug de aplastamiento Premier/Comfort+ → Yango cuando el cliente tiene COMPETITOR_NORMALIZE no-context-aware.';

-- ── (D) Verificación de estado tras la limpieza ─────────────────────────
DO $verify$
DECLARE
  v_remaining int;
  v_state text;
BEGIN
  SELECT COUNT(*) INTO v_remaining
    FROM pricing_observations
   WHERE country='Peru' AND city='Corp' AND competition_name='Yango';

  IF v_remaining > 0 THEN
    RAISE WARNING '[mig 71] Quedan % filas Corp "Yango" tras el DELETE — el guard NO ejecutará para esas; investigar.', v_remaining;
  END IF;

  SELECT string_agg(competition_name || '=' || n, ', ' ORDER BY n DESC)
    INTO v_state
    FROM (
      SELECT competition_name, COUNT(*) AS n
        FROM pricing_observations
       WHERE country='Peru' AND city='Corp'
       GROUP BY competition_name
       ORDER BY n DESC
       LIMIT 20
    ) s;
  RAISE NOTICE '[mig 71] Estado final Corp: %', v_state;
  RAISE NOTICE '[mig 71] El trigger BEFORE INSERT rechazará cualquier futuro intento de meter "Yango" anónimo en Corp.';
END
$verify$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- DESPUÉS DE APLICAR ESTA MIGRACIÓN:
--
-- 1. La DB queda blindada — el frontend cacheado YA NO puede aplastar
--    Premier/Comfort+ silenciosamente. Si intenta, el INSERT falla con
--    error 'Corp_invalid_competitor' visible en la UI.
--
-- 2. Para que el frontend NO produzca el error:
--    (a) HARD RELOAD del browser (Ctrl+Shift+R en Windows, Cmd+Shift+R en macOS).
--    (b) Si corrés `npm run dev` localmente: Ctrl+C y arrancarlo de nuevo
--        (Vite a veces cachea módulos transformados).
--    (c) Si tenés un host (Vercel/Netlify/etc.), forzá rebuild del último
--        commit (commit 50bf512 o posterior).
--
-- 3. Verificar que el deploy es el correcto:
--    Abrir DevTools (F12) > Console del navegador y ejecutar:
--      window.location.reload(true)
--    Después confirmar que la página vuelve a cargar JS fresco (Network tab
--    debe mostrar 200 OK con tiempos > 0, no "(memory cache)").
--
-- 4. Re-subir el Excel desde Gestión > Cargar Data.
--    - Si el front tiene el fix → entra OK, ves Premier y Comfort+ en DB.
--    - Si el front sigue stale → INSERT falla con error claro en la UI.
--
-- 5. Verificar resultado:
--    SELECT competition_name, COUNT(*) FROM pricing_observations
--    WHERE country='Peru' AND city='Corp'
--    GROUP BY competition_name ORDER BY 2 DESC;
--
--    Esperado: 'Yango Premier' y 'Yango Comfort+' con ~595-733 filas
--    cada uno. CERO filas 'Yango' anónimo.
-- ════════════════════════════════════════════════════════════════════════
