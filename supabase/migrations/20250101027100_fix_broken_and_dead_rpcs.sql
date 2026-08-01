-- ════════════════════════════════════════════════════════════════════════
-- 190_fix_broken_and_dead_rpcs.sql — arregla 2 RPCs rotas y retira 3 objetos
-- muertos o peligrosos.
--
-- Salió de una auditoría de migraciones (2026-08-01) motivada por el caso de
-- la mig 182: "aplicó sin errores" no prueba que la función funcione. Se
-- ejecutaron las 45 RPCs expuestas contra la base local; estas fallaron.
--
-- ─────────────────────────────────────────────────────────────────────
-- P0 · get_discount_stats y get_rush_valley_stats — ROTAS EN PRODUCCIÓN
-- ─────────────────────────────────────────────────────────────────────
-- Fallan el 100% de las llamadas con:
--     42702  column reference "competition_name" is ambiguous
--
-- Causa: la mig 166 las convirtió de `LANGUAGE sql` a `LANGUAGE plpgsql` para
-- meterles `PERFORM require_country_access(p_country)`. En plpgsql, las
-- columnas del `RETURNS TABLE(competition_name text, ...)` son VARIABLES, así
-- que el `SELECT competition_name FROM pricing_observations` sin calificar
-- dentro del CTE pasó a ser ambiguo. En esa misma migración
-- `get_heatmap_dow_tod` sí quedó calificada con `po.` — a estas dos se les
-- escapó.
--
-- Por qué nadie lo notó: los dos call sites hacen
--     .then(({data, error}) => { if (error) console.error(...); setRows(data || []) })
-- El error muere en la consola del navegador del usuario y el panel del Market
-- renderiza VACÍO, indistinguible de "no hay datos en ese rango". Mismo patrón
-- de fallo silencioso que motivó la bitácora de errores de la mig 185.
--
-- Fix: alias explícito `po` y calificar cada columna. NO se cambia la
-- semántica: mismos filtros, mismos cálculos, misma firma.
--
-- ─────────────────────────────────────────────────────────────────────
-- P1 · upsert_pricing_batch — el patrón EXACTO del bug 182, todavía vivo
-- ─────────────────────────────────────────────────────────────────────
--     INSERT INTO pricing_observations
--     SELECT * FROM jsonb_populate_recordset(null::pricing_observations, p_rows)
--
-- Mismo NULL explícito en `id` que rompía save_ci_batch. Ya no la llama nadie
-- (el upload de Excel migró a insert directo), pero sigue SECURITY DEFINER y
-- expuesta por PostgREST. Lo que la vuelve peligrosa y no solo muerta: ANTES
-- del INSERT roto hace un DELETE por ciudad + rango de fechas. Si alguien la
-- "recupera" creyendo que anda, el DELETE corre y el INSERT explota.
-- Se retira en vez de arreglarse: arreglar código muerto es agregar superficie
-- para mantener. Si el día de mañana hace falta un upsert masivo, save_ci_batch
-- (migs 182/186) ya tiene el patrón correcto.
--
-- ─────────────────────────────────────────────────────────────────────
-- P1 · get_price_volatility_by_category — OVERLOAD, PGRST203 latente
-- ─────────────────────────────────────────────────────────────────────
-- La mig 128 le agregó `p_city` con CREATE OR REPLACE sobre una firma
-- distinta: eso NO reemplaza, crea un OVERLOAD (CLAUDE.md §3). Hoy anda de
-- casualidad porque el único caller manda siempre las 7 claves; cualquier
-- bundle viejo en caché o cualquier caller nuevo que omita `p_city` recibe
-- PGRST203 y la pantalla se rompe en silencio. Se retira la firma vieja de 6
-- argumentos.
--
-- ─────────────────────────────────────────────────────────────────────
-- P2 · get_distance_bracket(text,text,numeric) — shim con 'Peru' hardcodeado
-- ─────────────────────────────────────────────────────────────────────
-- Shim de 3 argumentos que llama al de 4 con `'Peru'` fijo. La mig 171 movió
-- el trigger a la firma de 4; no le queda ningún caller. Devolvería un bracket
-- de Perú para una ciudad de Colombia, y está expuesta. Se retira.
--
-- ⚠️  Las tres bajas son DROP FUNCTION. Se verificó que ninguna tiene callers
--     en src/, scripts/, otras funciones SQL, triggers ni pg_cron. La
--     verificación del pie las vuelve a chequear después de aplicar.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── P0.1 · get_discount_stats ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_discount_stats(
  p_country text, p_city text, p_category text, p_start_date date, p_end_date date
)
RETURNS TABLE(competition_name text, list_avg numeric, final_avg numeric,
              with_discount bigint, n_total bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  WITH paired AS (
    -- `po.` en TODAS las columnas: sin el alias, `competition_name` choca con
    -- la variable homónima del RETURNS TABLE (42702).
    SELECT
      po.competition_name AS comp,
      CASE
        WHEN po.competition_name = 'InDrive' THEN po.recommended_price
        ELSE po.price_without_discount
      END AS list_price,
      CASE
        WHEN po.competition_name = 'InDrive' THEN po.minimal_bid
        ELSE po.price_with_discount
      END AS final_price
    FROM pricing_observations po
    WHERE po.country  = p_country
      AND po.city     = p_city
      AND po.category = p_category
      AND po.observed_date BETWEEN p_start_date AND p_end_date
  ),
  filtered AS (
    SELECT * FROM paired p
    WHERE p.list_price IS NOT NULL AND p.list_price > 0
      AND p.final_price IS NOT NULL AND p.final_price > 0
  )
  SELECT
    f.comp,
    AVG(f.list_price)::numeric(10,2),
    AVG(f.final_price)::numeric(10,2),
    COUNT(*) FILTER (WHERE f.final_price < f.list_price * 0.99),
    COUNT(*)
  FROM filtered f
  GROUP BY f.comp;
END;
$function$;

-- ── P0.2 · get_rush_valley_stats ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_rush_valley_stats(
  p_country text, p_city text, p_category text, p_start_date date, p_end_date date
)
RETURNS TABLE(competition_name text, rush_avg numeric, rush_n bigint,
              valley_avg numeric, valley_n bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  WITH base AS (
    SELECT
      po.competition_name AS comp,
      po.rush_hour        AS rush,
      CASE
        WHEN po.competition_name = 'InDrive' THEN po.recommended_price
        ELSE po.price_without_discount
      END AS price
    FROM pricing_observations po
    WHERE po.country  = p_country
      AND po.city     = p_city
      AND po.category = p_category
      AND po.observed_date BETWEEN p_start_date AND p_end_date
      AND po.rush_hour IS NOT NULL
  ),
  filtered AS (
    SELECT * FROM base b WHERE b.price IS NOT NULL AND b.price > 0
  )
  SELECT
    f.comp,
    AVG(f.price) FILTER (WHERE f.rush = true)::numeric(10,2),
    COUNT(*)     FILTER (WHERE f.rush = true),
    AVG(f.price) FILTER (WHERE f.rush = false)::numeric(10,2),
    COUNT(*)     FILTER (WHERE f.rush = false)
  FROM filtered f
  GROUP BY f.comp;
END;
$function$;

-- ── Bajas ─────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.upsert_pricing_batch(text, jsonb, jsonb, uuid, text, integer);
DROP FUNCTION IF EXISTS public.get_price_volatility_by_category(text, text, integer, integer, integer, integer);
DROP FUNCTION IF EXISTS public.get_distance_bracket(text, text, numeric);

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- 1) Las dos RPCs ejecutan sin error (era el 100% de fallo):
--    SET request.jwt.claims TO '{"email":"<admin>","role":"authenticated"}';
--    SET ROLE authenticated;
--    SELECT * FROM get_discount_stats('Peru','Lima','Economy/Comfort','2026-07-01','2026-07-31');
--    SELECT * FROM get_rush_valley_stats('Peru','Lima','Economy/Comfort','2026-07-01','2026-07-31');
--
-- 2) Ya no hay overloads (PGRST203):
--    SELECT proname, count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--     WHERE n.nspname='public' GROUP BY proname HAVING count(*) > 1;   → 0 filas
--
-- 3) La llamada corta de volatilidad ya resuelve:
--    SELECT * FROM get_price_volatility_by_category('Peru','Economy/Comfort');
--
-- 4) Las funciones retiradas no existen y nadie las nombra:
--    SELECT proname FROM pg_proc WHERE proname IN
--      ('upsert_pricing_batch');                                        → 0 filas
--    grep -rn "upsert_pricing_batch\|get_distance_bracket(" src/ scripts/
