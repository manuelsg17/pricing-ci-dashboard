-- ════════════════════════════════════════════════════════════════════════
-- Migración 135 — bot_upsert_observations: persistir `zone` (distrito TukTuk)
--
-- CONTEXTO (2026-07-20):
--   El gate de TukTuk (mig 113) y el guardado del distrito vivían en la
--   función SQL sync_bot_quotes y en el Edge Function sync-bot-quotes —
--   NINGUNO corre en producción. El sync real es scripts/bot-sync/
--   bot_sync_push.py (GitHub Actions), que hace UPSERT vía esta RPC.
--   Resultado: durante 3+ meses TukTuk entró con rutas long/very_long
--   irreales (promedio inflado ~S/6.9 vs ~S/4.4 real) y con zone=NULL en el
--   100% de las filas, sin poder filtrar por distrito.
--
--   El gate ya se agregó al script Python (descarta TukTuk sin
--   main_category='tuktuk' + zone). Pero para que el DISTRITO se guarde, la
--   RPC tiene que incluir `zone` en su INSERT — hoy no lo hace, aunque el
--   script ya lo manda en el payload.
--
-- CAMBIO:
--   Agregar `zone` a la lista de columnas del INSERT y al SELECT, y
--   refrescarlo en el ON CONFLICT DO UPDATE (última escritura gana, igual
--   que los demás campos no-clave). `jsonb_populate_recordset` ya tipa
--   contra el rowtype completo de pricing_observations, así que `zone` del
--   payload ya venía parseado — solo faltaba insertarlo.
--   NO se toca la natural key del ON CONFLICT (zone NO es parte de la clave;
--   una ruta TukTuk se identifica por ciudad/fecha/hora/categoría/competidor/
--   bracket/surge, y el distrito es un atributo de esa fila).
--
-- SEGURIDAD / PERMISOS: sin cambios (SECURITY DEFINER, service_role).
-- ROLLBACK: re-aplicar mig 91 (versión sin zone).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.bot_upsert_observations(p_rows jsonb)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count int;
BEGIN
  INSERT INTO public.pricing_observations AS po (
    country, city, observed_date, observed_time,
    category, competition_name,
    recommended_price, price_with_discount, price_without_discount,
    eta_min, surge, distance_bracket, distance_km,
    zone,
    point_a, point_b, data_source
  )
  SELECT
    r.country, r.city, r.observed_date, r.observed_time,
    r.category, r.competition_name,
    r.recommended_price, r.price_with_discount, r.price_without_discount,
    r.eta_min, r.surge, r.distance_bracket, r.distance_km,
    r.zone,
    r.point_a, r.point_b, COALESCE(r.data_source, 'bot')
  FROM jsonb_populate_recordset(null::public.pricing_observations, p_rows) AS r
  ON CONFLICT (
    country, city, observed_date, observed_time,
    category, competition_name, distance_bracket, surge, data_source
  ) WHERE data_source = 'bot'
  DO UPDATE SET
    recommended_price      = EXCLUDED.recommended_price,
    price_with_discount    = EXCLUDED.price_with_discount,
    price_without_discount = EXCLUDED.price_without_discount,
    eta_min                = EXCLUDED.eta_min,
    distance_km            = COALESCE(EXCLUDED.distance_km, po.distance_km),
    zone                   = COALESCE(EXCLUDED.zone, po.zone),
    point_a                = COALESCE(EXCLUDED.point_a, po.point_a),
    point_b                = COALESCE(EXCLUDED.point_b, po.point_b);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

COMMENT ON FUNCTION public.bot_upsert_observations(jsonb) IS
  'Upsert atómico de pricing_observations para el bot (mig 91 + mig 135: persiste zone/distrito de TukTuk). Llamada exclusiva desde scripts/bot-sync/bot_sync_push.py con service_role key.';

REVOKE ALL ON FUNCTION public.bot_upsert_observations(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bot_upsert_observations(jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_upsert_observations(jsonb) TO service_role;

COMMIT;
