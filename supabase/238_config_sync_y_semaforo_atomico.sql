-- ════════════════════════════════════════════════════════════════════════
-- Migración 238 — Configuración P0: live-sync que no sincronizaba y
-- semáforo atómico (auditoría de la sección Config, 2026-09-03)
--
-- 1. `airport_markers` y `yango_gmv_tiers` NUNCA tuvieron trigger de
--    auditoría (mig 62 lista 17 tablas; estas dos nacieron después). Como
--    el live-sync entre sesiones viaja por audit_log (useRealtimeSync), sus
--    editores tenían `liveSyncTable` decorativo: otra sesión (o el propio
--    ConfigProvider de Rentabilidad) no se enteraba de un cambio hasta
--    recargar. Mismo trigger genérico `log_changes()` que el resto.
--
-- 2. `saveSemaforo` era DELETE + INSERT en dos requests: si el INSERT
--    rebotaba (RLS de país, validación, red) el país quedaba SIN semáforo.
--    `replace_semaforo(p_country, p_rows)` lo hace en una transacción,
--    valida las bandas y está gateada por can_write_table + país.
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1. Auditoría (= live-sync) para las dos tablas huérfanas ─────────────
DROP TRIGGER IF EXISTS trg_audit_airport_markers ON public.airport_markers;
CREATE TRIGGER trg_audit_airport_markers
  AFTER INSERT OR UPDATE OR DELETE ON public.airport_markers
  FOR EACH ROW EXECUTE FUNCTION log_changes();

DROP TRIGGER IF EXISTS trg_audit_yango_gmv_tiers ON public.yango_gmv_tiers;
CREATE TRIGGER trg_audit_yango_gmv_tiers
  AFTER INSERT OR UPDATE OR DELETE ON public.yango_gmv_tiers
  FOR EACH ROW EXECUTE FUNCTION log_changes();

-- ── 2. Semáforo: reemplazo atómico y validado ────────────────────────────
-- p_rows: [{band, min_pct, max_pct, note}] — NULL = sin límite.
CREATE OR REPLACE FUNCTION public.replace_semaforo(p_country text, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_n integer;
BEGIN
  IF NOT can_write_table('semaforo_config') THEN
    RAISE EXCEPTION 'No tenés permiso para editar el semáforo.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'El semáforo necesita al menos una banda.' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) r
    WHERE r->>'band' NOT IN ('green', 'yellow', 'red')
       OR (r->>'min_pct' IS NOT NULL AND r->>'max_pct' IS NOT NULL
           AND (r->>'min_pct')::numeric > (r->>'max_pct')::numeric)
  ) THEN
    RAISE EXCEPTION 'Banda inválida: color desconocido o mínimo mayor que máximo.' USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM public.semaforo_config WHERE country = p_country;
  INSERT INTO public.semaforo_config (country, band, min_pct, max_pct, note)
  SELECT p_country, r->>'band',
         NULLIF(r->>'min_pct', '')::numeric, NULLIF(r->>'max_pct', '')::numeric,
         NULLIF(r->>'note', '')
  FROM jsonb_array_elements(p_rows) r;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.replace_semaforo(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_semaforo(text, jsonb) TO authenticated;
COMMENT ON FUNCTION public.replace_semaforo(text, jsonb) IS
  'mig 238: reemplaza las bandas del semáforo de un país en UNA transacción (antes DELETE+INSERT en dos requests podía dejar el país sin semáforo). Gate: can_write_table + país.';

COMMIT;

-- Verificación:
--   SELECT tgname FROM pg_trigger WHERE tgrelid IN ('airport_markers'::regclass,'yango_gmv_tiers'::regclass) AND tgname LIKE 'trg_audit%';
--   -- como authenticated con config: SELECT replace_semaforo('Peru', '[{"band":"green","min_pct":-5,"max_pct":5}]');
