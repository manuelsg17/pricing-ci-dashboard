-- ════════════════════════════════════════════════════════════════════════
-- 169_partition_pricing_observations_cutover.sql — corte final del
-- particionado (mig 168 preparó la tabla nueva y copió el histórico).
--
-- Esta migración SÍ es la que corta tráfico en vivo — hace catch-up de
-- cualquier fila insertada en la tabla vieja DESPUÉS del backfill de la
-- 168 (la ventana entre aplicar 168 y 169) y renombra. El RENAME de
-- Postgres es una operación de catálogo casi instantánea (no reescribe
-- datos), así que el lock es de milisegundos — mismo patrón ya usado en
-- mig 164 (cambio de políticas con 4 hubs activos en vivo, sin downtime
-- perceptible.
--
-- IMPORTANTE: aplicar esta migración INMEDIATAMENTE después de la 168
-- (minutos, no horas) — cuanto más tiempo pase, más filas nuevas hay que
-- catch-up (aunque el mecanismo es correcto igual, solo tarda más).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Catch-up: filas insertadas en la tabla vieja después del backfill
--    de la 168. Filtra por id > max(id) ya copiado (no escanea toda la
--    tabla vieja de nuevo) + ON CONFLICT DO NOTHING por si esta migración
--    se corre más de una vez (idempotente).
INSERT INTO public.pricing_observations_new
SELECT * FROM public.pricing_observations
WHERE id > (SELECT COALESCE(max(id), 0) FROM public.pricing_observations_new)
ORDER BY id
ON CONFLICT (id, observed_date) DO NOTHING;

-- ── 2. Liberar los nombres "limpios" de índices/constraint ANTES del
--    corte: renombrar la TABLA no renombra sus índices — si no hacemos
--    esto primero, el paso 4 (renombrar los índices nuevos a los nombres
--    limpios) choca con los nombres que la tabla vieja todavía tiene
--    (bug real encontrado validando esta migración en local).
ALTER INDEX public.idx_po_city_cat_bracket RENAME TO idx_po_old_city_cat_bracket;
ALTER INDEX public.idx_po_city_week RENAME TO idx_po_old_city_week;
ALTER INDEX public.idx_po_competitor RENAME TO idx_po_old_competitor;
ALTER INDEX public.idx_po_country_city_cat_bracket RENAME TO idx_po_old_country_city_cat_bracket;
ALTER INDEX public.idx_po_country_date RENAME TO idx_po_old_country_date;
ALTER INDEX public.idx_po_country_source RENAME TO idx_po_old_country_source;
ALTER INDEX public.idx_po_date RENAME TO idx_po_old_date;
ALTER INDEX public.idx_po_indrive_bot RENAME TO idx_po_old_indrive_bot;
ALTER INDEX public.idx_po_time_of_day RENAME TO idx_po_old_time_of_day;
ALTER INDEX public.idx_pobs_manual_uploaded_by RENAME TO idx_pobs_old_manual_uploaded_by;
ALTER INDEX public.idx_pobs_no_data RENAME TO idx_pobs_old_no_data;
ALTER INDEX public.ux_po_bot_natural_key RENAME TO ux_po_old_bot_natural_key;
ALTER TABLE public.pricing_observations
  RENAME CONSTRAINT pricing_observations_pkey TO pricing_observations_old_pkey;

-- ── 3. Corte: la tabla vieja pasa a "_old" (respaldo, NO se borra en esta
--    migración — queda unos días de margen antes de dropearla en una
--    migración separada, una vez confirmado que todo funciona en prod) y
--    la nueva particionada ocupa el nombre real.
ALTER TABLE public.pricing_observations RENAME TO pricing_observations_old;
ALTER TABLE public.pricing_observations_new RENAME TO pricing_observations;

-- ── 4. Los índices/PK de la tabla nueva pasan a los nombres limpios,
--    ahora libres.
ALTER INDEX public.idx_po_new_city_cat_bracket RENAME TO idx_po_city_cat_bracket;
ALTER INDEX public.idx_po_new_city_week RENAME TO idx_po_city_week;
ALTER INDEX public.idx_po_new_competitor RENAME TO idx_po_competitor;
ALTER INDEX public.idx_po_new_country_city_cat_bracket RENAME TO idx_po_country_city_cat_bracket;
ALTER INDEX public.idx_po_new_country_date RENAME TO idx_po_country_date;
ALTER INDEX public.idx_po_new_country_source RENAME TO idx_po_country_source;
ALTER INDEX public.idx_po_new_date RENAME TO idx_po_date;
ALTER INDEX public.idx_po_new_indrive_bot RENAME TO idx_po_indrive_bot;
ALTER INDEX public.idx_po_new_time_of_day RENAME TO idx_po_time_of_day;
ALTER INDEX public.idx_pobs_new_manual_uploaded_by RENAME TO idx_pobs_manual_uploaded_by;
ALTER INDEX public.idx_pobs_new_no_data RENAME TO idx_pobs_no_data;
ALTER INDEX public.ux_po_new_bot_natural_key RENAME TO ux_po_bot_natural_key;
ALTER TABLE public.pricing_observations
  RENAME CONSTRAINT pricing_observations_new_pkey TO pricing_observations_pkey;

-- ── 4. pg_cron: auto-crear la partición de 2 meses adelante, semanal ───
SELECT cron.schedule(
  'ensure-next-pricing-partition',
  '0 3 * * 1',  -- todos los lunes 03:00 UTC
  $$SELECT public.ensure_next_pricing_partition()$$
);

COMMIT;
