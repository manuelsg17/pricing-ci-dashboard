-- ════════════════════════════════════════════════════════════════════════
-- 163_incremental_aggregates.sql — refresco INCREMENTAL de los agregados
-- del Dashboard. Segunda mitad de la dieta de Disk IO (ver mig 162).
--
-- PROBLEMA: `REFRESH MATERIALIZED VIEW` recalcula SIEMPRE toda la historia.
-- v_bracket_weekly_avg_mv tiene 88k filas que van de 2025-07 a hoy, y para
-- reconstruirlas escanea 1,58 M de filas de pricing_observations (888 MB) —
-- cada corrida. Pero los datos de hace más de dos semanas casi nunca cambian:
-- estábamos recomputando 12 meses inmutables para actualizar la semana en
-- curso. v_yango_rival_diff_mv (207 MB) además derrama ~1,1 GB de temporales
-- por corrida.
--
-- SOLUCIÓN: convertir las 3 MVs pesadas en TABLAS reales y refrescar solo una
-- ventana móvil con DELETE + INSERT.
--
-- ── Decisiones de diseño (todas salidas de una revisión adversarial que
--    encontró bugs reales en el primer borrador de esta migración) ─────────
--
-- 1. LA VENTANA SE DERIVA DEL CALENDARIO, NO DE LOS DATOS.
--    Primer borrador: `WHERE (year, week) IN (SELECT DISTINCT year, week FROM
--    pricing_observations WHERE observed_date >= cutoff)`. Dos bugs:
--      a) Si una semana se quedaba SIN filas dentro de la ventana (un hub
--         rehace las únicas sesiones que la semana tenía en el rango), esa
--         semana desaparecía del subquery → el DELETE no la tocaba y el
--         agregado viejo quedaba huérfano hasta el rebuild siguiente.
--      b) `(year, week) IN (...)` NO es indexable: ningún índice de
--         pricing_observations arranca por `year` (idx_po_city_week es
--         (city,year,week)). El plan hacía Seq Scan de las 1,58 M de filas —
--         o sea, no ahorraba el escaneo, que es justo el IO que queríamos
--         cortar. Solo el agregado diario se salvaba.
--    Ahora la ventana es un RANGO DE FECHAS que arranca en el lunes ISO de la
--    fecha de corte (`v_week_start`). Como una semana ISO es un rango
--    contiguo de fechas, cubrir "desde ese lunes" equivale a cubrir semanas
--    completas, y el filtro `observed_date >= v_week_start` sí usa idx_po_date.
--    La lista de (year, week) a borrar se genera con generate_series sobre el
--    calendario, así que una semana sin datos se borra igual.
--
-- 2. LAS TRES VENTANAS ESTÁN ALINEADAS. Antes el semanal cubría "toda semana
--    tocada por los últimos 14 días" (hasta 20 días atrás) y el diario
--    exactamente 14 → un dato que caía en ese hueco actualizaba una vista y
--    no la otra, y las pestañas Semanal y Diaria mostraban totales distintos
--    para el mismo dato. Ahora las tres arrancan en `v_week_start`.
--
-- 3. NADA DE TRUNCATE. El primer borrador usaba TRUNCATE + INSERT para el
--    rebuild completo con el comentario "los lectores siguen viendo la
--    versión anterior hasta el commit (MVCC)". Es FALSO: TRUNCATE toma un
--    ACCESS EXCLUSIVE que los lectores NO esquivan — se quedan bloqueados
--    (medido: 5958 ms contra 605 ms normales). Habría sido una regresión
--    frente a `REFRESH MATERIALIZED VIEW CONCURRENTLY`, que nunca bloqueaba.
--    DELETE + INSERT sí es MVCC: los lectores ven la versión vieja hasta el
--    commit y nunca esperan.
--
-- 4. UNA SOLA FUNCIÓN, PARAMETRIZADA POR VENTANA. No hace falta un "full"
--    aparte: `refresh_ci_aggregates(4000)` ES el rebuild completo, con la
--    misma mecánica MVCC. Menos código, menos caminos que puedan divergir.
--
-- 5. POR QUÉ SIGUE HABIENDO RECONCILIACIONES MÁS ANCHAS: un hub puede reabrir
--    y corregir una sesión de CUALQUIER fecha desde "Historial de sesiones", y
--    reconcile_indrive_bot_prices reescribe precios de filas viejas. La
--    ventana de 14 h no alcanza para eso, así que hay una pasada diaria de 90
--    días y una semanal completa. Patrón estándar: incremental en el camino
--    caliente + reconciliación periódica.
--
-- 6. SEGURIDAD. Las MVs tenían `anon=arwdDxtm` heredado de un
--    ALTER DEFAULT PRIVILEGES (invisible en information_schema, que no lista
--    materialized views — hay que mirar pg_class.relacl). Siendo MVs eso era
--    solo lectura de más; siendo TABLAS habilitaría DELETE/UPDATE anónimo con
--    la clave pública que viaja en el bundle del frontend. Las tablas nuevas
--    nacen con ese mismo default, así que hay que REVOCAR explícitamente y
--    encender RLS. Sin esto, esta migración abriría un agujero grave.
--
-- v_bot_vs_manual_mv se deja como MV con su propio cron: pesa 144 kB y tarda
-- 8s, no justifica la complejidad.
--
-- SWAP DEL DEPLOY: se construyen tablas `_new` completas (sin tocar las MVs
-- vivas), se indexan, y recién al final se hace el intercambio. El lock
-- exclusivo sobre las MVs viejas dura milisegundos en vez de los ~2 min de la
-- reconstrucción.
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. Construir las tablas nuevas (sin impacto en producción) ──────────

CREATE TABLE public.v_bracket_weekly_avg_new AS
SELECT country, city, year, week, category,
       COALESCE(zone, 'All'::text) AS zone,
       competition_name, distance_bracket, surge, data_source, time_of_day, rush_hour,
       count(*) AS observation_count,
       avg(effective_price) AS avg_price,
       min(observed_date) AS week_start_date
FROM v_effective_price
WHERE effective_price IS NOT NULL AND effective_price > 0::numeric
GROUP BY country, city, year, week, category, COALESCE(zone, 'All'::text),
         competition_name, distance_bracket, surge, data_source, time_of_day, rush_hour;

CREATE UNIQUE INDEX tmp_bwa_unique ON public.v_bracket_weekly_avg_new
  (country, city, year, week, category, zone, competition_name, distance_bracket,
   surge, data_source, time_of_day, rush_hour) NULLS NOT DISTINCT;
CREATE INDEX tmp_bwa_dashboard ON public.v_bracket_weekly_avg_new
  (country, city, category, year, week);
-- La ventana incremental borra por (year, week); sin este índice el DELETE
-- haría seq scan del agregado entero.
CREATE INDEX tmp_bwa_window ON public.v_bracket_weekly_avg_new (year, week);

CREATE TABLE public.v_bracket_daily_avg_new AS
SELECT country, city, observed_date,
       (EXTRACT(isodow FROM observed_date))::integer AS day_of_week,
       category,
       COALESCE(zone, 'All'::text) AS zone,
       competition_name, distance_bracket, surge, data_source, time_of_day, rush_hour,
       count(*) AS observation_count,
       avg(effective_price) AS avg_price
FROM v_effective_price
WHERE effective_price IS NOT NULL AND effective_price > 0::numeric
GROUP BY country, city, observed_date, category, COALESCE(zone, 'All'::text),
         competition_name, distance_bracket, surge, data_source, time_of_day, rush_hour;

CREATE UNIQUE INDEX tmp_bda_unique ON public.v_bracket_daily_avg_new
  (country, city, observed_date, category, zone, competition_name, distance_bracket,
   surge, data_source, time_of_day, rush_hour) NULLS NOT DISTINCT;
CREATE INDEX tmp_bda_dashboard ON public.v_bracket_daily_avg_new
  (country, city, category, observed_date);
CREATE INDEX tmp_bda_window ON public.v_bracket_daily_avg_new (observed_date);

-- Lee de la tabla weekly RECIÉN construida para quedar consistente con ella.
CREATE TABLE public.v_yango_rival_diff_new AS
WITH rival_ref AS (
  SELECT v.country, v.city, v.category, v.distance_bracket, v.year, v.week,
         v.competition_name AS rival_name,
         sum(v.avg_price * v.observation_count::numeric)
           / NULLIF(sum(v.observation_count), 0::numeric) AS rival_avg_price,
         sum(v.observation_count)::bigint AS rival_obs_count
  FROM public.v_bracket_weekly_avg_new v
  WHERE v.competition_name !~~* 'Yango%'::text
    AND v.category <> 'Corp'::text
    AND v.competition_name IS NOT NULL
    AND v.distance_bracket IS NOT NULL
  GROUP BY v.country, v.city, v.category, v.distance_bracket, v.year, v.week, v.competition_name
), yango_obs AS (
  SELECT e.id AS yango_observation_id, e.country, e.city, e.category, e.distance_bracket,
         e.year, e.week, e.observed_date, e.data_source, e.effective_price AS yango_price
  FROM v_effective_price e
  WHERE e.competition_name = 'Yango'::text
    AND e.category <> 'Corp'::text
    AND e.effective_price IS NOT NULL
    AND e.effective_price > 0::numeric
    AND e.distance_bracket = ANY (ARRAY['very_short','short','median','average','long','very_long'])
)
SELECT y.yango_observation_id, y.country, y.city, y.category, y.distance_bracket,
       y.year, y.week, y.observed_date, y.data_source,
       r.rival_name AS competitor_name,
       y.yango_price,
       round(r.rival_avg_price, 2) AS rival_avg_price,
       r.rival_obs_count,
       round(((y.yango_price - r.rival_avg_price) / NULLIF(r.rival_avg_price, 0::numeric)) * 100::numeric, 6) AS pct_diff
FROM yango_obs y
JOIN rival_ref r ON r.country = y.country AND r.city = y.city AND r.category = y.category
                AND r.distance_bracket = y.distance_bracket AND r.year = y.year AND r.week = y.week;

CREATE UNIQUE INDEX tmp_yrd_unique ON public.v_yango_rival_diff_new
  (yango_observation_id, competitor_name);
CREATE INDEX tmp_yrd_lookup ON public.v_yango_rival_diff_new
  (country, competitor_name, category, year, week);
CREATE INDEX tmp_yrd_window ON public.v_yango_rival_diff_new (year, week);

-- ── 2. Swap atómico (lock de milisegundos) ──────────────────────────────
DROP MATERIALIZED VIEW public.v_yango_rival_diff_mv;   -- depende del semanal
DROP MATERIALIZED VIEW public.v_bracket_weekly_avg_mv;
DROP MATERIALIZED VIEW public.v_bracket_daily_avg_mv;

ALTER TABLE public.v_bracket_weekly_avg_new RENAME TO v_bracket_weekly_avg_mv;
ALTER TABLE public.v_bracket_daily_avg_new  RENAME TO v_bracket_daily_avg_mv;
ALTER TABLE public.v_yango_rival_diff_new   RENAME TO v_yango_rival_diff_mv;

ALTER INDEX public.tmp_bwa_unique    RENAME TO idx_bwa_mv_unique;
ALTER INDEX public.tmp_bwa_dashboard RENAME TO idx_bwa_mv_dashboard;
ALTER INDEX public.tmp_bwa_window    RENAME TO idx_bwa_mv_window;
ALTER INDEX public.tmp_bda_unique    RENAME TO idx_bda_mv_unique;
ALTER INDEX public.tmp_bda_dashboard RENAME TO idx_bda_mv_dashboard;
ALTER INDEX public.tmp_bda_window    RENAME TO idx_bda_mv_window;
ALTER INDEX public.tmp_yrd_unique    RENAME TO ux_yango_rival_diff_mv;
ALTER INDEX public.tmp_yrd_lookup    RENAME TO idx_yango_rival_diff_lookup;
ALTER INDEX public.tmp_yrd_window    RENAME TO idx_yango_rival_diff_window;

COMMENT ON TABLE public.v_bracket_weekly_avg_mv IS
  'Agregado semanal del Dashboard. Era MATERIALIZED VIEW hasta la mig 163; ahora tabla real con refresco incremental (refresh_ci_aggregates). Conserva el sufijo _mv para no tocar los 9 RPC que la leen.';
COMMENT ON TABLE public.v_bracket_daily_avg_mv IS
  'Agregado diario del Dashboard. Era MATERIALIZED VIEW hasta la mig 163; ahora tabla con refresco incremental.';
COMMENT ON TABLE public.v_yango_rival_diff_mv IS
  'Yango vs rivales por observación (Competitividad). Era MATERIALIZED VIEW hasta la mig 163; ahora tabla con refresco incremental.';

-- ── 3. SEGURIDAD: cerrar el acceso que heredan por default ──────────────
-- Sin esto, cualquiera con la clave anon (que viaja pública en el bundle)
-- podría BORRAR estos agregados vía la API REST. Ver nota 6 del encabezado.
REVOKE ALL ON public.v_bracket_weekly_avg_mv FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.v_bracket_daily_avg_mv  FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.v_yango_rival_diff_mv   FROM anon, authenticated, PUBLIC;

-- Cinturón y tiradores: RLS sin políticas = nadie pasa. Los 9 RPC que las
-- leen son SECURITY DEFINER propiedad de postgres (dueño de la tabla), así
-- que la saltean por diseño. Además silencia el advisor
-- `rls_disabled_in_public`, que ahora aplica porque son relkind='r'.
ALTER TABLE public.v_bracket_weekly_avg_mv ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.v_bracket_daily_avg_mv  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.v_yango_rival_diff_mv   ENABLE ROW LEVEL SECURITY;

-- ── 4. Refresco por ventana (única función) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.refresh_ci_aggregates(p_days integer DEFAULT 14)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '900s'
AS $function$
DECLARE
  -- Lunes ISO de la semana que contiene la fecha de corte. Alinea las tres
  -- ventanas a semanas COMPLETAS y permite filtrar por observed_date (que sí
  -- tiene índice) en vez de por (year, week) (que no).
  v_week_start date := date_trunc('week', current_date - GREATEST(p_days, 1))::date;
  v_max_date   date;
  t_start      timestamptz := clock_timestamp();
  v_weekly bigint; v_daily bigint; v_rival bigint;
BEGIN
  -- Dos corridas simultáneas (el cron diario pisando al horario, o alguien
  -- disparándolo a mano) chocan con duplicate key y una muere. El lock las
  -- serializa; se libera solo al terminar la transacción.
  PERFORM pg_advisory_xact_lock(hashtext('refresh_ci_aggregates'));

  -- Cota superior real: si hubiera filas con fecha futura (errores de tipeo),
  -- su semana tiene que entrar igual en la lista a borrar, o el INSERT las
  -- reinsertaría sobre filas viejas y reventaría el índice único.
  SELECT GREATEST(current_date, COALESCE(max(observed_date), current_date))
    INTO v_max_date FROM pricing_observations;

  -- ── Semanal ──
  DELETE FROM v_bracket_weekly_avg_mv t
  WHERE (t.year, t.week) IN (
    SELECT DISTINCT EXTRACT(isoyear FROM d)::int, EXTRACT(week FROM d)::int
    FROM generate_series(v_week_start::timestamp, v_max_date::timestamp, interval '1 day') d
  );
  INSERT INTO v_bracket_weekly_avg_mv (
    country, city, year, week, category, zone, competition_name, distance_bracket,
    surge, data_source, time_of_day, rush_hour, observation_count, avg_price, week_start_date)
  SELECT e.country, e.city, e.year, e.week, e.category, COALESCE(e.zone, 'All'),
         e.competition_name, e.distance_bracket, e.surge, e.data_source, e.time_of_day, e.rush_hour,
         count(*), avg(e.effective_price), min(e.observed_date)
  FROM v_effective_price e
  WHERE e.effective_price IS NOT NULL AND e.effective_price > 0
    AND e.observed_date >= v_week_start
  GROUP BY e.country, e.city, e.year, e.week, e.category, COALESCE(e.zone, 'All'),
           e.competition_name, e.distance_bracket, e.surge, e.data_source, e.time_of_day, e.rush_hour;
  GET DIAGNOSTICS v_weekly = ROW_COUNT;

  -- ── Diario (misma ventana que el semanal, ver nota 2) ──
  DELETE FROM v_bracket_daily_avg_mv t WHERE t.observed_date >= v_week_start;
  INSERT INTO v_bracket_daily_avg_mv (
    country, city, observed_date, day_of_week, category, zone, competition_name,
    distance_bracket, surge, data_source, time_of_day, rush_hour, observation_count, avg_price)
  SELECT e.country, e.city, e.observed_date, EXTRACT(isodow FROM e.observed_date)::int,
         e.category, COALESCE(e.zone, 'All'), e.competition_name, e.distance_bracket,
         e.surge, e.data_source, e.time_of_day, e.rush_hour,
         count(*), avg(e.effective_price)
  FROM v_effective_price e
  WHERE e.effective_price IS NOT NULL AND e.effective_price > 0
    AND e.observed_date >= v_week_start
  GROUP BY e.country, e.city, e.observed_date, e.category, COALESCE(e.zone, 'All'),
           e.competition_name, e.distance_bracket, e.surge, e.data_source, e.time_of_day, e.rush_hour;
  GET DIAGNOSTICS v_daily = ROW_COUNT;

  -- ── Yango vs rivales (depende del semanal YA actualizado arriba) ──
  DELETE FROM v_yango_rival_diff_mv t
  WHERE (t.year, t.week) IN (
    SELECT DISTINCT EXTRACT(isoyear FROM d)::int, EXTRACT(week FROM d)::int
    FROM generate_series(v_week_start::timestamp, v_max_date::timestamp, interval '1 day') d
  );
  INSERT INTO v_yango_rival_diff_mv (
    yango_observation_id, country, city, category, distance_bracket, year, week,
    observed_date, data_source, competitor_name, yango_price, rival_avg_price,
    rival_obs_count, pct_diff)
  WITH rival_ref AS (
    -- Seguro restringir por fecha: `week` está en el GROUP BY, así que acotar
    -- a semanas completas no puede alterar la composición de ningún grupo que
    -- sobreviva (verificado fila-por-fila contra el rebuild completo).
    SELECT v.country, v.city, v.category, v.distance_bracket, v.year, v.week,
           v.competition_name AS rival_name,
           sum(v.avg_price * v.observation_count::numeric)
             / NULLIF(sum(v.observation_count), 0::numeric) AS rival_avg_price,
           sum(v.observation_count)::bigint AS rival_obs_count
    FROM v_bracket_weekly_avg_mv v
    WHERE v.week_start_date >= v_week_start
      AND v.competition_name !~~* 'Yango%' AND v.category <> 'Corp'
      AND v.competition_name IS NOT NULL AND v.distance_bracket IS NOT NULL
    GROUP BY v.country, v.city, v.category, v.distance_bracket, v.year, v.week, v.competition_name
  ), yango_obs AS (
    SELECT e.id AS yango_observation_id, e.country, e.city, e.category, e.distance_bracket,
           e.year, e.week, e.observed_date, e.data_source, e.effective_price AS yango_price
    FROM v_effective_price e
    WHERE e.observed_date >= v_week_start
      AND e.competition_name = 'Yango' AND e.category <> 'Corp'
      AND e.effective_price IS NOT NULL AND e.effective_price > 0
      AND e.distance_bracket = ANY (ARRAY['very_short','short','median','average','long','very_long'])
  )
  SELECT y.yango_observation_id, y.country, y.city, y.category, y.distance_bracket,
         y.year, y.week, y.observed_date, y.data_source, r.rival_name,
         y.yango_price, round(r.rival_avg_price, 2), r.rival_obs_count,
         round(((y.yango_price - r.rival_avg_price) / NULLIF(r.rival_avg_price, 0)) * 100, 6)
  FROM yango_obs y
  JOIN rival_ref r ON r.country = y.country AND r.city = y.city AND r.category = y.category
                  AND r.distance_bracket = y.distance_bracket AND r.year = y.year AND r.week = y.week;
  GET DIAGNOSTICS v_rival = ROW_COUNT;

  RETURN jsonb_build_object(
    'window_days', GREATEST(p_days, 1), 'week_start', v_week_start,
    'weekly_rows', v_weekly, 'daily_rows', v_daily, 'rival_rows', v_rival,
    'total_ms', round(EXTRACT(EPOCH FROM (clock_timestamp() - t_start)) * 1000),
    'refreshed_at', now()
  );
END;
$function$;

-- ── 5. refresh_dashboard_mv(): botón de pánico del admin (vía MCP) ───────
-- Redefinido porque su cuerpo viejo hacía REFRESH MATERIALIZED VIEW sobre
-- objetos que ahora son tablas: fallaría. Nada en src/ ni scripts/ consume su
-- JSON, así que cambiar la forma del retorno es seguro (verificado por grep).
CREATE OR REPLACE FUNCTION public.refresh_dashboard_mv()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '900s'
AS $function$
BEGIN
  RETURN public.refresh_ci_aggregates(4000);  -- toda la historia
END;
$function$;

-- ── 6. SEGURIDAD de las funciones ───────────────────────────────────────
-- Por default toda función nace con EXECUTE para PUBLIC. Sin revocarlo,
-- cualquiera con la clave anon podía disparar un rebuild completo en loop y
-- tumbar el rendimiento de la base a pedido. Las llama el cron (que corre
-- como postgres) y el admin por MCP; nadie más las necesita.
REVOKE EXECUTE ON FUNCTION public.refresh_ci_aggregates(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refresh_dashboard_mv() FROM PUBLIC, anon, authenticated;

-- ── 7. Cron ─────────────────────────────────────────────────────────────
-- Los 3 jobs de REFRESH pesado quedan sin objeto (ya no son MVs). El DO
-- tolera que alguno no exista, para que la migración sea re-ejecutable.
DO $$
DECLARE j text;
BEGIN
  FOREACH j IN ARRAY ARRAY['refresh-mv-weekly','refresh-mv-daily','refresh-mv-competitive-bands'] LOOP
    BEGIN
      PERFORM cron.unschedule(j);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'job % no existía, sigo', j;
    END;
  END LOOP;
END $$;
-- `refresh-mv-botvsmanual` se deja como está: v_bot_vs_manual_mv sigue siendo
-- una MV y se refresca sola cada hora (144 kB, 8s). No la tocamos acá para no
-- duplicar el trabajo.

-- Horario activo (mig 162): 0-3 y 11-23 UTC = 19:00-22:59 y 06:00-18:59 Lima.
SELECT cron.schedule('refresh-ci-incremental', '10 0-3,11-23 * * *',
  'SELECT public.refresh_ci_aggregates(14)');

-- Reconciliación media: 90 días, 1x/día al abrir la ventana activa
-- (11:05 UTC = 06:05 Lima), antes del turno de los hubs. Cubre correcciones
-- de sesiones viejas que la ventana de 14 días no alcanza.
SELECT cron.schedule('refresh-ci-reconcile-90d', '5 11 * * *',
  'SELECT public.refresh_ci_aggregates(90)');

-- Reconciliación total: domingos 08:00 UTC = 03:00 Lima, hora muerta.
-- Es la red de seguridad final contra cualquier deriva.
SELECT cron.schedule('refresh-ci-reconcile-full', '0 8 * * 0',
  'SELECT public.refresh_ci_aggregates(4000)');
