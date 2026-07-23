-- ============================================================
-- MIGRACIÓN 154: matriz semanal de cobertura por bracket (pedido 9)
-- ============================================================
--
-- CONTEXTO: el admin quiere ver, de un vistazo, cuántos datapoints
-- manuales se acumularon en la semana por (ciudad × tipo de CI) y
-- bracket — para mapear rápido un mínimo aceptable y ver si van a
-- llegar, sin tener que armarlo a mano desde Reporte Semanal. Deriva
-- "tipo" (Normal/Corp/Aeropuerto A/Aeropuerto B/TukTuk) directamente de
-- `city`/`category` — no hace falta ninguna tabla nueva.
--
-- Deliberadamente NO calcula ningún "esperado"/color de cumplimiento acá:
-- el propio admin pidió ver los números crudos para juzgar el mínimo
-- aceptable él mismo — automatizar ese juicio hubiera sido inventar un
-- criterio que no pidió.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_weekly_ci_coverage(
  p_country text,
  p_year    int DEFAULT NULL,
  p_week    int DEFAULT NULL
) RETURNS TABLE(
  base_city        text,
  tipo             text,
  distance_bracket text,
  n_rows           bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_year int := COALESCE(p_year, EXTRACT(isoyear FROM current_date)::int);
  v_week int := COALESCE(p_week, EXTRACT(week FROM current_date)::int);
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'access_denied: el monitoreo es solo para admin'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

  RETURN QUERY
  SELECT
    CASE
      WHEN po.category = 'TukTuk' THEN po.city
      ELSE regexp_replace(po.city, '_Airport_[AB]$', '')
    END AS base_city,
    CASE
      WHEN po.category = 'TukTuk' THEN 'TukTuk'
      WHEN po.city = 'Corp' THEN 'Corp'
      WHEN po.city ~ '_Airport_A$' THEN 'Airport_A'
      WHEN po.city ~ '_Airport_B$' THEN 'Airport_B'
      ELSE 'Normal'
    END AS tipo,
    po.distance_bracket,
    count(*)::bigint AS n_rows
  FROM pricing_observations po
  WHERE po.country = p_country
    AND po.data_source = 'manual'
    AND po.year = v_year
    AND po.week = v_week
  GROUP BY 1, 2, 3;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_weekly_ci_coverage(text, int, int) TO authenticated;

-- ============================================================
-- VERIFICACIÓN
--   SELECT * FROM get_weekly_ci_coverage('Peru') ORDER BY base_city, tipo, distance_bracket;
--    (falla con access_denied si el que llama no es admin)
-- ============================================================
