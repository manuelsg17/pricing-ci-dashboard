-- ════════════════════════════════════════════════════════════════════════
-- 173_fix_stale_pointer_to_pricing_observations_old.sql — bug real P0
-- (2026-07-29): el Dashboard dejó de mostrar datos nuevos desde el
-- particionado de pricing_observations (migs 168-169, 2026-07-26).
--
-- CAUSA RAÍZ: la vista v_effective_price (fuente de TODOS los agregados
-- del dashboard vía refresh_ci_aggregates) y la vista materializada
-- v_bot_vs_manual_mv quedaron con `FROM pricing_observations_old` — la
-- tabla de respaldo CONGELADA que dejó el swap del particionado. Esa
-- tabla nunca recibe filas nuevas, así que todo lo cargado desde el
-- 26 de julio en adelante era invisible para el dashboard, aunque
-- estuviera perfecto en la tabla real `pricing_observations`.
--
-- Detectado: el user reportó que la semana del 27 de julio no aparecía
-- en el Dashboard pese a refrescar. Confirmado con SQL directo: miles de
-- filas en pricing_observations para 2026-07-27/28, CERO en
-- v_effective_price para las mismas fechas.
--
-- FIX: repuntar ambos objetos a `pricing_observations` (la tabla real,
-- particionada). v_effective_price es CREATE OR REPLACE (mismo shape de
-- columnas, security_invoker=true preservado). v_bot_vs_manual_mv es una
-- materialized view — Postgres no permite CREATE OR REPLACE MATERIALIZED
-- VIEW, así que se DROP + CREATE con el mismo índice único
-- (idx_bvm_mv_unique) que ya tenía, necesario para que el refresh
-- CONCURRENTLY del cron job "refresh-mv-botvsmanual" siga funcionando.
--
-- VERIFICACIÓN POST-FIX (hecha en producción antes de este archivo):
--   - v_effective_price ahora devuelve filas para 2026-07-27/28.
--   - refresh_ci_aggregates(14) repobló v_bracket_weekly_avg_mv: la
--     semana ISO 31/2026 pasó de 0 a miles de observaciones reales.
--   - v_bot_vs_manual_mv recreada con 333 filas, mismos grants que antes
--     (solo postgres/service_role, sin anon/authenticated) — verificado
--     contra pg_class.relacl.
--
-- PENDIENTE (fuera de alcance de este fix): decidir cuándo hacer
-- DROP TABLE pricing_observations_old — ya no la lee ningún objeto
-- conocido, pero se deja como respaldo hasta confirmación explícita del
-- user en una sesión aparte.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.v_effective_price
WITH (security_invoker = true)
AS
SELECT id, country, city, year, week, observed_date, observed_time, time_of_day,
    category, zone, competition_name, distance_km, distance_bracket, surge,
    rush_hour, timeslot, data_source, upload_batch_id,
    CASE
        WHEN competition_name = 'InDrive'::text AND (COALESCE(bid_1, 0::numeric) + COALESCE(bid_2, 0::numeric) + COALESCE(bid_3, 0::numeric) + COALESCE(bid_4, 0::numeric) + COALESCE(bid_5, 0::numeric)) > 0::numeric
        THEN (COALESCE(NULLIF(bid_1, 0::numeric), 0::numeric) + COALESCE(NULLIF(bid_2, 0::numeric), 0::numeric) + COALESCE(NULLIF(bid_3, 0::numeric), 0::numeric) + COALESCE(NULLIF(bid_4, 0::numeric), 0::numeric) + COALESCE(NULLIF(bid_5, 0::numeric), 0::numeric))
             / NULLIF(
                (CASE WHEN COALESCE(bid_1,0::numeric) > 0::numeric THEN 1 ELSE 0 END) +
                (CASE WHEN COALESCE(bid_2,0::numeric) > 0::numeric THEN 1 ELSE 0 END) +
                (CASE WHEN COALESCE(bid_3,0::numeric) > 0::numeric THEN 1 ELSE 0 END) +
                (CASE WHEN COALESCE(bid_4,0::numeric) > 0::numeric THEN 1 ELSE 0 END) +
                (CASE WHEN COALESCE(bid_5,0::numeric) > 0::numeric THEN 1 ELSE 0 END), 0)::numeric
        ELSE COALESCE(price_without_discount, recommended_price)
    END AS effective_price
FROM public.pricing_observations;

DROP MATERIALIZED VIEW public.v_bot_vs_manual_mv;

CREATE MATERIALIZED VIEW public.v_bot_vs_manual_mv AS
SELECT country, city, category, competition_name, data_source,
    count(*) AS cnt,
    avg(COALESCE(price_without_discount, price_with_discount, recommended_price))::numeric(10,2) AS avg_price
FROM public.pricing_observations po
WHERE data_source = ANY (ARRAY['bot'::text, 'manual'::text])
GROUP BY country, city, category, competition_name, data_source;

CREATE UNIQUE INDEX idx_bvm_mv_unique ON public.v_bot_vs_manual_mv
  USING btree (country, city, category, competition_name, data_source) NULLS NOT DISTINCT;

-- Repoblar los agregados semanales/diarios/rival ahora que la fuente es
-- correcta — sin esto, el fix queda aplicado pero el dashboard sigue
-- mostrando los datos viejos hasta el próximo cron horario.
SELECT public.refresh_ci_aggregates(14);
