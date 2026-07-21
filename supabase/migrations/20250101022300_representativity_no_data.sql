-- ════════════════════════════════════════════════════════════════════════
-- Migración 142 — get_representativity expone no_data_n ("atendida sin oferta")
--
-- CONTEXTO 2026-07-21 (Fase 4b-repr):
--   Las celdas marcadas "sin data" (S/D, mig 141: no_data=true, precio null) NO
--   entran a v_bracket_weekly_avg_mv (esa MV filtra effective_price>0), así que
--   eran invisibles para el panel. Decisión del usuario: mostrarlas como estado
--   APARTE ("atendida sin oferta") — NO suman al piso de muestras de precio, pero
--   tampoco cuentan como celda faltante.
--
--   Se agrega la columna `no_data_n` al RETURNS TABLE. La RPC ahora hace FULL
--   OUTER JOIN entre:
--     · price = conteos de precio (bot_n/manual_n) desde la MV (como antes), y
--     · nd    = conteo de filas no_data=true leídas EN VIVO de pricing_observations
--               (son pocas; índice parcial de mig 141), por la misma semana ISO.
--   El FULL OUTER JOIN hace que una celda que SOLO tiene S/D (sin ninguna muestra
--   de precio) también aparezca, con bot_n=manual_n=0 y no_data_n>0. El frontend
--   (lib/representativity.js) la clasifica como "atendida sin oferta".
--
--   ⚠ Cambia la FIRMA (agrega no_data_n) → toca RepresentativityCard.jsx +
--   lib/representativity.js (ya actualizados). CREATE OR REPLACE con distinto
--   RETURNS TABLE requiere DROP previo (Postgres no deja cambiar el tipo de
--   retorno con OR REPLACE).
-- ════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.get_representativity(text, int, int);

CREATE OR REPLACE FUNCTION public.get_representativity(
  p_country text,
  p_year    int DEFAULT NULL,
  p_week    int DEFAULT NULL
)
 RETURNS TABLE(
   city             text,
   category         text,
   competition_name text,
   distance_bracket text,
   bot_n            bigint,
   manual_n         bigint,
   no_data_n        bigint
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_year int := COALESCE(p_year, EXTRACT(isoyear FROM (now() AT TIME ZONE 'America/Lima')::date)::int);
  v_week int := COALESCE(p_week, EXTRACT(week    FROM (now() AT TIME ZONE 'America/Lima')::date)::int);
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  WITH price AS (
    SELECT
      v.city, v.category, v.competition_name, v.distance_bracket,
      COALESCE(SUM(v.observation_count) FILTER (WHERE v.data_source = 'bot'), 0)::bigint    AS bot_n,
      COALESCE(SUM(v.observation_count) FILTER (WHERE v.data_source = 'manual'), 0)::bigint AS manual_n
    FROM v_bracket_weekly_avg_mv v
    WHERE v.country = p_country
      AND v.year = v_year
      AND v.week = v_week
    GROUP BY v.city, v.category, v.competition_name, v.distance_bracket
  ),
  nd AS (
    SELECT
      po.city, po.category, po.competition_name, po.distance_bracket,
      count(*)::bigint AS no_data_n
    FROM pricing_observations po
    WHERE po.country = p_country
      AND po.data_source = 'manual'
      AND po.no_data = true
      AND po.year = v_year
      AND po.week = v_week
    GROUP BY po.city, po.category, po.competition_name, po.distance_bracket
  )
  SELECT
    COALESCE(price.city, nd.city),
    COALESCE(price.category, nd.category),
    COALESCE(price.competition_name, nd.competition_name),
    COALESCE(price.distance_bracket, nd.distance_bracket),
    COALESCE(price.bot_n, 0)::bigint,
    COALESCE(price.manual_n, 0)::bigint,
    COALESCE(nd.no_data_n, 0)::bigint
  FROM price
  FULL OUTER JOIN nd
    ON price.city = nd.city
   AND price.category = nd.category
   AND price.competition_name = nd.competition_name
   AND price.distance_bracket = nd.distance_bracket;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_representativity(text, int, int) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   SELECT * FROM get_representativity('Peru', 2026, 30)
--    WHERE no_data_n > 0 ORDER BY no_data_n DESC LIMIT 20;
-- ════════════════════════════════════════════════════════════════════════
