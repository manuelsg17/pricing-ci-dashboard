-- ============================================================
-- MIGRACIÓN 155: horas de sesión + filas/disponibles en Detalle (pedido 11)
-- ============================================================
--
-- CONTEXTO: "Detalle por ciudad, fecha y hub" (get_hub_monitoring, mig 140)
-- solo mostraba filas/categorías/competidores agregados de
-- pricing_observations — sin hora de inicio/fin de sesión ni cuánto
-- representa eso sobre el total disponible. `ci_sessions` ya guarda
-- started_at/ended_at reales (mig 1) — solo faltaba `total_expected`
-- (el mismo valor que el heartbeat en vivo ya calcula del lado del
-- cliente, mig 146) para poder mostrar "filas guardadas / disponibles".
--
-- El agregado de sesión se computa por (ciudad, fecha, hub) IGNORANDO
-- zone al nivel externo (mismo criterio que get_hub_monitoring, que ya
-- mezcla distritos de TukTuk bajo una sola fila) pero sumando
-- total_expected POR DISTRITO/zona distinta (cada una es una ruta
-- adicional real) — para eso, sess_zone dedupea revisiones de la MISMA
-- zona (se queda con la más reciente) antes de sumar entre zonas.
-- ============================================================

ALTER TABLE public.ci_sessions
  ADD COLUMN IF NOT EXISTS total_expected int;

COMMENT ON COLUMN public.ci_sessions.total_expected IS
  'Total de celdas esperadas para esa vista al momento de Finalizar (mismo cálculo que ya manda el heartbeat en vivo, mig 146) — persistido para poder mostrar "filas guardadas / disponibles" en Monitoreo. NULL en sesiones previas a esta migración.';

-- El RETURNS TABLE gana columnas nuevas → CREATE OR REPLACE no alcanza
-- (Postgres no permite cambiar el tipo de retorno de una función existente).
DROP FUNCTION IF EXISTS public.get_hub_monitoring(text, date, date);

CREATE OR REPLACE FUNCTION public.get_hub_monitoring(
  p_country text,
  p_from    date,
  p_to      date
) RETURNS TABLE(
  city           text,
  observed_date  date,
  uploaded_by    text,
  n_rows         bigint,
  n_categories   bigint,
  n_competitors  bigint,
  started_at     timestamptz,
  ended_at       timestamptz,
  total_expected bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'access_denied: el monitoreo es solo para admin'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

  RETURN QUERY
  WITH agg AS (
    SELECT
      po.city,
      po.observed_date,
      COALESCE(po.uploaded_by, '(sin dueño)') AS uploaded_by,
      count(*)::bigint                            AS n_rows,
      count(DISTINCT po.category)::bigint         AS n_categories,
      count(DISTINCT po.competition_name)::bigint AS n_competitors
    FROM pricing_observations po
    WHERE po.country = p_country
      AND po.data_source = 'manual'
      AND po.observed_date BETWEEN p_from AND p_to
    GROUP BY po.city, po.observed_date, COALESCE(po.uploaded_by, '(sin dueño)')
  ),
  -- Última revisión conocida por (ciudad, fecha, hub, zona) — así una
  -- corrección posterior no duplica el total_expected de esa MISMA zona.
  sess_zone AS (
    SELECT DISTINCT ON (cs.city, cs.observed_date, cs.user_email, cs.zone)
      cs.city, cs.observed_date, cs.user_email, cs.zone,
      cs.total_expected, cs.started_at, cs.ended_at
    FROM ci_sessions cs
    WHERE cs.country = p_country
      AND cs.observed_date BETWEEN p_from AND p_to
    ORDER BY cs.city, cs.observed_date, cs.user_email, cs.zone, cs.started_at DESC
  ),
  sess_agg AS (
    SELECT
      sz.city, sz.observed_date, sz.user_email,
      MIN(sz.started_at)                              AS started_at,
      MAX(sz.ended_at)                                 AS ended_at,
      SUM(COALESCE(sz.total_expected, 0))::bigint      AS total_expected
    FROM sess_zone sz
    GROUP BY sz.city, sz.observed_date, sz.user_email
  )
  SELECT
    a.city, a.observed_date, a.uploaded_by,
    a.n_rows, a.n_categories, a.n_competitors,
    s.started_at, s.ended_at, s.total_expected
  FROM agg a
  LEFT JOIN sess_agg s
    ON s.city = a.city AND s.observed_date = a.observed_date AND s.user_email = a.uploaded_by;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_hub_monitoring(text, date, date) TO authenticated;

-- ============================================================
-- VERIFICACIÓN
--   SELECT * FROM get_hub_monitoring('Peru', current_date - 7, current_date);
--    (falla si no sos admin; started_at/ended_at/total_expected en NULL
--     para filas legacy sin ci_sessions o sin total_expected)
-- ============================================================
