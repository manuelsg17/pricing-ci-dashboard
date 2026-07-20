-- ════════════════════════════════════════════════════════════════════════
-- bot_coverage_recent(p_country) — frescura de la data del bot por
-- ciudad × bracket.
--
-- POR QUÉ (2026-07-19): el badge "Bot hace X min" (BotFreshnessBadge) se
-- basa en cuándo corrió el SYNC, no en qué tan fresca es la DATA. Cuando el
-- scraper externo deja de producir para una ciudad/bracket (ej. Lima dejó de
-- scrapear long/median/very_long/very_short después del barrido matutino),
-- el sync sigue corriendo cada hora (levanta short/average), status=ok, y el
-- badge queda VERDE — mientras la mayoría de los brackets están 13h stale.
-- Un stall del bot quedaba invisible.
--
-- Esta función expone, por ciudad y bracket, la ÚLTIMA observación que
-- tenemos y el conteo reciente, para que el panel de Bot DB Sync muestre de
-- un vistazo qué está fresco y qué se congeló. Comparación relativa dentro
-- de cada ciudad (bracket vs el más fresco de esa ciudad) → no depende de la
-- zona horaria del país.
--
-- Read-only. Respeta RLS (SECURITY INVOKER): quien ya puede leer
-- pricing_observations en el dashboard puede llamarla.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.bot_coverage_recent(p_country text)
 RETURNS TABLE(
   city              text,
   distance_bracket  text,
   last_date         date,
   last_time         time without time zone,
   n_recent          bigint
 )
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH base AS (
    SELECT po.city, po.distance_bracket, po.observed_date, po.observed_time, po.uploaded_at
    FROM pricing_observations po
    WHERE po.country = p_country
      AND po.data_source = 'bot'
      AND po.distance_bracket IS NOT NULL
      AND po.observed_date >= (CURRENT_DATE - 3)
  ),
  latest AS (
    SELECT DISTINCT ON (b.city, b.distance_bracket)
      b.city, b.distance_bracket,
      b.observed_date AS last_date,
      b.observed_time AS last_time
    FROM base b
    ORDER BY b.city, b.distance_bracket, b.observed_date DESC, b.observed_time DESC
  ),
  cnt AS (
    SELECT b.city, b.distance_bracket,
           count(*) FILTER (WHERE b.uploaded_at >= now() - INTERVAL '48 hours') AS n_recent
    FROM base b
    GROUP BY b.city, b.distance_bracket
  )
  SELECT l.city, l.distance_bracket, l.last_date, l.last_time, c.n_recent
  FROM latest l
  JOIN cnt c ON c.city = l.city AND c.distance_bracket = l.distance_bracket
  ORDER BY l.city, l.distance_bracket;
$function$;
