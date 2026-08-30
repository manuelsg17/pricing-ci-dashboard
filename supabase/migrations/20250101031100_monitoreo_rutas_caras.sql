-- ════════════════════════════════════════════════════════════════════════
-- Migración 230 — Monitoreo de rutas caras (F4)
--
-- PEDIDO (user 2026-08-30): dos vistas de análisis, sin considerar descuentos:
--   a) rutas donde Yango salió MÁS CARO que InDrive/Uber/Cabify/Didi, con el
--      DÍA y la HORA de captura;
--   b) rutas donde una categoría BAJA de Yango salió más cara que una ALTA
--      ("que rompa con la secuencia natural"), en cualquier ciudad.
--
-- ── Decisiones de diseño, todas derivadas de mirar la data real ──────────
--
-- 1. QUÉ PRECIO ES "SIN DESCUENTOS": `effective_price` de v_effective_price.
--    Verificado en prod: esa expresión NUNCA usa price_with_discount — es
--    COALESCE(price_without_discount, recommended_price), salvo InDrive con
--    bids reales, donde promedia los bids. Y `price_without_discount` está
--    poblado al 100% en las 6 marcas. Además es el campo canónico del
--    proyecto para InDrive (el trigger le escribe el ajuste de contraoferta:
--    467 de 477 filas donde difiere de recommended_price son de InDrive).
--    Usar v_effective_price en vez de pricing_observations directo NO es un
--    detalle: hereda gratis el filtro anti-TukTuk (mig 221) y la exclusión
--    de InDrive Bogotá/Cali por moneda rota (mig 223). Replicar esos guards
--    acá sería una segunda fuente de verdad que se despega en silencio.
--
-- 2. EL JOIN ES POR VENTANA DE TIEMPO, NO POR HORA EXACTA. Medido en prod
--    sobre una ruta real de Lima: Didi/Uber 00:06:48, Yango 00:06:52,
--    Cabify 00:07:10 — el bot recorre las apps una tras otra, así que
--    exigir observed_time igual devolvería CERO filas. Default 10 min:
--    holgado para los ~40s reales y muy por debajo del siguiente ciclo
--    (el mismo par de puntos vuelve a medirse recién 4 h después).
--
-- 3. RANGO ACOTADO Y OBLIGATORIO (máx 31 días). pricing_observations tiene
--    +2 M de filas particionadas y esto es un self-join: sin cota, un rango
--    largo escanea todo. El índice (country, observed_date) hace el recorte
--    barato. Es un límite explícito que el RPC informa al rechazar, nunca un
--    truncado silencioso (§5).
--
-- 4. ORDEN DE TIERS EN TABLA, NO HARDCODEADO. `category_tier_order` define
--    qué es "más alto" por país. Se siembra SOLO con la cadena inequívoca de
--    Perú (Economy/Comfort → Comfort+ → Premier), que es la que el user
--    nombró. XL queda deliberadamente SIN rank (= excluido del chequeo):
--    es un tier de CAPACIDAD, no de confort, y que XL salga más barato que
--    Comfort+ no es necesariamente un error. Sumarlo es un UPDATE de una
--    fila cuando el user lo decida — sin migración ni deploy.
--    Espera y Ahorra / Viaje / TukTuk / Corp tampoco entran por lo mismo.
--
-- 5. GATING: can_access_section('competitividad') + require_country_access.
--    Se reusa la sección existente en vez de crear una nueva a propósito:
--    una sección nueva obliga al user a concederla a mano en Accesos antes
--    de que la pantalla sirva (ya pasó con `projects`), y esto es
--    semánticamente análisis competitivo.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. v_effective_price expone la RUTA ─────────────────────────────────
-- Aditivo: las columnas nuevas van al FINAL, así que los 9 RPC y el refresh
-- de agregados que la leen por nombre no se enteran (patrón expandir de §4).
-- security_invoker explícito: CREATE OR REPLACE no debe perderlo (§3).
CREATE OR REPLACE VIEW public.v_effective_price
WITH (security_invoker = true) AS
SELECT po.id,
  po.country, po.city, po.year, po.week,
  po.observed_date, po.observed_time, po.time_of_day,
  po.category, po.zone, po.competition_name,
  po.distance_km, po.distance_bracket,
  po.surge, po.rush_hour, po.timeslot,
  po.data_source, po.upload_batch_id,
  CASE
    WHEN po.competition_name = 'InDrive'::text
     AND (COALESCE(po.bid_1,0::numeric) + COALESCE(po.bid_2,0::numeric) + COALESCE(po.bid_3,0::numeric)
        + COALESCE(po.bid_4,0::numeric) + COALESCE(po.bid_5,0::numeric)) > 0::numeric
    THEN (COALESCE(NULLIF(po.bid_1,0::numeric),0::numeric) + COALESCE(NULLIF(po.bid_2,0::numeric),0::numeric)
        + COALESCE(NULLIF(po.bid_3,0::numeric),0::numeric) + COALESCE(NULLIF(po.bid_4,0::numeric),0::numeric)
        + COALESCE(NULLIF(po.bid_5,0::numeric),0::numeric))
       / NULLIF(
           CASE WHEN COALESCE(po.bid_1,0::numeric) > 0::numeric THEN 1 ELSE 0 END +
           CASE WHEN COALESCE(po.bid_2,0::numeric) > 0::numeric THEN 1 ELSE 0 END +
           CASE WHEN COALESCE(po.bid_3,0::numeric) > 0::numeric THEN 1 ELSE 0 END +
           CASE WHEN COALESCE(po.bid_4,0::numeric) > 0::numeric THEN 1 ELSE 0 END +
           CASE WHEN COALESCE(po.bid_5,0::numeric) > 0::numeric THEN 1 ELSE 0 END, 0)::numeric
    ELSE COALESCE(po.price_without_discount, po.recommended_price)
  END AS effective_price,
  -- ── NUEVAS (al final, para no romper el orden de columnas) ──
  po.point_a,
  po.point_b
FROM pricing_observations po
  LEFT JOIN tuktuk_routes tr ON tr.point_a = po.point_a AND tr.point_b = po.point_b
WHERE (tr.point_a IS NULL OR po.category = 'TukTuk'::text)
  AND NOT (po.competition_name = 'InDrive'::text AND (po.city = ANY (ARRAY['Bogota'::text,'Cali'::text])));

-- ── 2. Orden de tiers por país (configuración, no código) ───────────────
CREATE TABLE IF NOT EXISTS public.category_tier_order (
  country   text NOT NULL,
  category  text NOT NULL,
  tier_rank int  NOT NULL,
  note      text,
  PRIMARY KEY (country, category)
);

COMMENT ON TABLE public.category_tier_order IS
  'Orden "natural" de categorías por país para detectar inversiones de precio (una categoría baja más cara que una alta). Una categoría SIN fila acá queda excluida del chequeo — así se evitan falsos positivos con tiers que no son comparables por confort (XL es capacidad, no confort).';

ALTER TABLE public.category_tier_order ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.category_tier_order FROM anon, authenticated, PUBLIC;
GRANT SELECT ON public.category_tier_order TO authenticated;

DROP POLICY IF EXISTS category_tier_order_select ON public.category_tier_order;
CREATE POLICY category_tier_order_select ON public.category_tier_order
  FOR SELECT TO authenticated USING (can_access_country(country));

INSERT INTO public.category_tier_order (country, category, tier_rank, note)
SELECT v.* FROM (VALUES
  ('Peru', 'Economy/Comfort', 1, 'Tier base.'),
  ('Peru', 'Comfort+',        2, NULL),
  ('Peru', 'Premier',         3, NULL)
) AS v(country, category, tier_rank, note)
WHERE NOT EXISTS (
  SELECT 1 FROM public.category_tier_order t
  WHERE t.country = v.country AND t.category = v.category
);

-- ── 3. RPC A: Yango más caro que un rival, misma ruta y momento ─────────
CREATE OR REPLACE FUNCTION public.get_route_price_gaps(
  p_country        text,
  p_date_from      date,
  p_date_to        date,
  p_city           text    DEFAULT NULL,
  p_category       text    DEFAULT NULL,
  p_min_gap_pct    numeric DEFAULT 0,
  p_window_minutes int     DEFAULT 10,
  p_limit          int     DEFAULT 500
)
RETURNS TABLE (
  observed_date    date,
  observed_time    time,
  city             text,
  point_a          text,
  point_b          text,
  distance_bracket text,
  category         text,
  yango_price      numeric,
  rival_name       text,
  rival_price      numeric,
  gap_abs          numeric,
  gap_pct          numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_country_access(p_country);
  IF NOT can_access_section('competitividad') THEN
    RAISE EXCEPTION 'Sin acceso al análisis competitivo.' USING ERRCODE = '42501';
  END IF;
  IF p_date_from IS NULL OR p_date_to IS NULL OR p_date_to < p_date_from THEN
    RAISE EXCEPTION 'Rango de fechas inválido.' USING ERRCODE = '22007';
  END IF;
  IF p_date_to - p_date_from > 31 THEN
    RAISE EXCEPTION 'El rango no puede superar 31 días (pediste %).', p_date_to - p_date_from
      USING ERRCODE = '22003';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT e.city, e.point_a, e.point_b, e.observed_date, e.observed_time,
           e.category, e.distance_bracket, e.competition_name, e.effective_price
    FROM v_effective_price e
    WHERE e.country = p_country
      AND e.observed_date BETWEEN p_date_from AND p_date_to
      AND (p_city     IS NULL OR e.city = p_city)
      AND (p_category IS NULL OR e.category = p_category)
      AND e.point_a IS NOT NULL AND e.point_b IS NOT NULL
      AND e.effective_price IS NOT NULL AND e.effective_price > 0
  ),
  y AS (SELECT * FROM base b WHERE b.competition_name = 'Yango'),
  r AS (SELECT * FROM base b WHERE b.competition_name !~~* 'Yango%')
  SELECT y.observed_date, y.observed_time, y.city, y.point_a, y.point_b,
         y.distance_bracket, y.category,
         round(y.effective_price, 2),
         r.competition_name,
         round(r.effective_price, 2),
         round(y.effective_price - r.effective_price, 2),
         round(((y.effective_price - r.effective_price) / r.effective_price) * 100, 1)
  FROM y
  JOIN r ON r.city = y.city
        AND r.point_a = y.point_a AND r.point_b = y.point_b
        AND r.observed_date = y.observed_date
        AND r.category = y.category
        AND abs(EXTRACT(EPOCH FROM (r.observed_time - y.observed_time))) <= p_window_minutes * 60
  WHERE y.effective_price > r.effective_price
    AND ((y.effective_price - r.effective_price) / r.effective_price) * 100 >= p_min_gap_pct
  ORDER BY ((y.effective_price - r.effective_price) / r.effective_price) DESC
  LIMIT p_limit;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_route_price_gaps(text,date,date,text,text,numeric,int,int) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_route_price_gaps(text,date,date,text,text,numeric,int,int) TO authenticated;

-- ── 4. RPC B: inversión de secuencia dentro de la misma marca ───────────
CREATE OR REPLACE FUNCTION public.get_category_sequence_inversions(
  p_country        text,
  p_date_from      date,
  p_date_to        date,
  p_city           text DEFAULT NULL,
  p_competitor     text DEFAULT 'Yango',
  p_window_minutes int  DEFAULT 10,
  p_limit          int  DEFAULT 500
)
RETURNS TABLE (
  observed_date    date,
  observed_time    time,
  city             text,
  point_a          text,
  point_b          text,
  distance_bracket text,
  competitor       text,
  lower_category   text,
  lower_price      numeric,
  higher_category  text,
  higher_price     numeric,
  gap_abs          numeric,
  gap_pct          numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_country_access(p_country);
  IF NOT can_access_section('competitividad') THEN
    RAISE EXCEPTION 'Sin acceso al análisis competitivo.' USING ERRCODE = '42501';
  END IF;
  IF p_date_from IS NULL OR p_date_to IS NULL OR p_date_to < p_date_from THEN
    RAISE EXCEPTION 'Rango de fechas inválido.' USING ERRCODE = '22007';
  END IF;
  IF p_date_to - p_date_from > 31 THEN
    RAISE EXCEPTION 'El rango no puede superar 31 días (pediste %).', p_date_to - p_date_from
      USING ERRCODE = '22003';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT e.city, e.point_a, e.point_b, e.observed_date, e.observed_time,
           e.category, e.distance_bracket, e.competition_name, e.effective_price,
           t.tier_rank
    FROM v_effective_price e
    -- INNER JOIN a propósito: una categoría sin rank NO participa del
    -- chequeo (ver nota 4 del encabezado).
    JOIN category_tier_order t
      ON t.country = e.country AND t.category = e.category
    WHERE e.country = p_country
      AND e.observed_date BETWEEN p_date_from AND p_date_to
      AND (p_city IS NULL OR e.city = p_city)
      AND e.competition_name = p_competitor
      AND e.point_a IS NOT NULL AND e.point_b IS NOT NULL
      AND e.effective_price IS NOT NULL AND e.effective_price > 0
  )
  SELECT lo.observed_date, lo.observed_time, lo.city, lo.point_a, lo.point_b,
         lo.distance_bracket, lo.competition_name,
         lo.category, round(lo.effective_price, 2),
         hi.category, round(hi.effective_price, 2),
         round(lo.effective_price - hi.effective_price, 2),
         round(((lo.effective_price - hi.effective_price) / hi.effective_price) * 100, 1)
  FROM base lo
  JOIN base hi ON hi.city = lo.city
              AND hi.point_a = lo.point_a AND hi.point_b = lo.point_b
              AND hi.observed_date = lo.observed_date
              AND abs(EXTRACT(EPOCH FROM (hi.observed_time - lo.observed_time))) <= p_window_minutes * 60
              -- la de tier MÁS ALTO...
              AND hi.tier_rank > lo.tier_rank
  -- ...pero MÁS BARATA que la de tier bajo → la secuencia está rota.
  WHERE lo.effective_price > hi.effective_price
  ORDER BY ((lo.effective_price - hi.effective_price) / hi.effective_price) DESC
  LIMIT p_limit;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_category_sequence_inversions(text,date,date,text,text,int,int) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_category_sequence_inversions(text,date,date,text,text,int,int) TO authenticated;

COMMIT;
