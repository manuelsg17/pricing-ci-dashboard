-- ════════════════════════════════════════════════════════════════════════
-- Migración 147 — RPC de diagnóstico: progreso guardado sin sesión terminada
--
-- CONTEXTO (2026-07-22): además de "quién está en vivo ahora" (mig 146), el
-- admin quiere ver combos (ciudad×fecha×hub) con filas manuales guardadas
-- pero SIN una fila correspondiente en ci_sessions — es decir, un hub guardó
-- progreso ("Guardar Progreso") pero nunca tocó "Terminar Sesión" (se cortó,
-- se olvidó, cerró la laptop). Mismo guard que get_hub_monitoring (mig 140).
--
-- OJO — diagnóstico BEST-EFFORT, no autoritativo: el anti-join normaliza
-- zone con NULLIF(zone,'') de los dos lados (Corp guarda zone='' en algunas
-- filas viejas, ver mig 145) pero el histórico de zona en pricing_observations
-- tiene ~76k filas legacy con zona no-null fuera de TukTuk — un combo puede
-- aparecer o no aparecer acá por ese ruido histórico. Sirve para que el admin
-- sepa a quién preguntarle, no como fuente de verdad de "qué falta terminar".
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_unfinished_ci_sessions(
  p_country text,
  p_from    date,
  p_to      date
) RETURNS TABLE(
  city          text,
  zone          text,
  observed_date date,
  uploaded_by   text,
  n_rows        bigint,
  n_categories  bigint,
  n_competitors bigint
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
  SELECT
    po.city,
    NULLIF(po.zone, '') AS zone,
    po.observed_date,
    po.uploaded_by,
    count(*)::bigint                            AS n_rows,
    count(DISTINCT po.category)::bigint         AS n_categories,
    count(DISTINCT po.competition_name)::bigint AS n_competitors
  FROM pricing_observations po
  WHERE po.country = p_country
    AND po.data_source = 'manual'
    AND po.uploaded_by IS NOT NULL
    AND po.observed_date BETWEEN p_from AND p_to
    AND NOT EXISTS (
      SELECT 1 FROM ci_sessions cs
      WHERE cs.country = p_country
        AND cs.city = po.city
        AND cs.observed_date = po.observed_date
        AND cs.user_email = po.uploaded_by
        AND COALESCE(NULLIF(cs.zone, ''), '') = COALESCE(NULLIF(po.zone, ''), '')
    )
  GROUP BY po.city, NULLIF(po.zone, ''), po.observed_date, po.uploaded_by;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_unfinished_ci_sessions(text, date, date) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   SELECT * FROM get_unfinished_ci_sessions('Peru', current_date - 7, current_date);
--    (falla si no sos admin)
-- ════════════════════════════════════════════════════════════════════════
