-- ════════════════════════════════════════════════════════════════════════
-- Migración 140 — Monitoreo de la carga de hubs (SOLO admin) + endurecer RLS
-- de ci_sessions
--
-- CONTEXTO 2026-07-21:
--   El analista/admin quiere una sección de MONITOREO para supervisar la carga
--   manual de los hubs (quién cargó qué ciudad/fecha, cuántas filas/categorías/
--   competidores), visible SOLO desde su cuenta admin. Datos ya disponibles:
--   pricing_observations (data_source='manual', con uploaded_by por celda desde
--   mig 139) y ci_sessions (quién/ciudad/fecha/duración/filas por sesión).
--
--   1) RPC get_hub_monitoring: agrega la carga manual por (ciudad, fecha, hub).
--      SECURITY DEFINER + IF NOT is_admin() RAISE (mismo patrón que las demás
--      RPCs sensibles) + require_country_access. El gate real vive acá, no en el
--      frontend. pricing_observations NO tiene created_at, así que el "cuándo"
--      lo aporta ci_sessions en la página.
--
--   2) Endurecer RLS de ci_sessions: hoy es abierta (policy auth_all USING true),
--      cualquier authenticated puede leer TODAS las sesiones. Se reemplaza por:
--        · SELECT: admin ve todo; cada usuario ve SOLO las suyas (user_email =
--          auth.email()) — así "Abrir sesión" del historial le sigue funcionando
--          al hub para editar lo propio, pero no puede espiar las de otros.
--        · INSERT: cada usuario inserta las suyas (DataEntry al "Terminar sesión"
--          setea user_email = su email) o admin.
--      (UPDATE/DELETE quedan sin policy → denegados; la app no los usa.)
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_hub_monitoring(
  p_country text,
  p_from    date,
  p_to      date
)
 RETURNS TABLE(
   city             text,
   observed_date    date,
   uploaded_by      text,
   n_rows           bigint,
   n_categories     bigint,
   n_competitors    bigint
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
    po.observed_date,
    COALESCE(po.uploaded_by, '(sin dueño)') AS uploaded_by,
    count(*)::bigint                           AS n_rows,
    count(DISTINCT po.category)::bigint        AS n_categories,
    count(DISTINCT po.competition_name)::bigint AS n_competitors
  FROM pricing_observations po
  WHERE po.country = p_country
    AND po.data_source = 'manual'
    AND po.observed_date BETWEEN p_from AND p_to
  GROUP BY po.city, po.observed_date, COALESCE(po.uploaded_by, '(sin dueño)');
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_hub_monitoring(text, date, date) TO authenticated;

-- ── Endurecer RLS de ci_sessions ────────────────────────────────────────
DROP POLICY IF EXISTS auth_all ON public.ci_sessions;

CREATE POLICY ci_sessions_select ON public.ci_sessions
  FOR SELECT TO authenticated
  USING (is_admin() OR user_email = auth.email());

CREATE POLICY ci_sessions_insert ON public.ci_sessions
  FOR INSERT TO authenticated
  WITH CHECK (user_email = auth.email() OR is_admin());

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   SELECT * FROM get_hub_monitoring('Peru', current_date - 7, current_date)
--    ORDER BY observed_date DESC, n_rows DESC;   -- (falla si no sos admin)
--   SELECT polname, polcmd FROM pg_policy WHERE polrelid='public.ci_sessions'::regclass;
-- ════════════════════════════════════════════════════════════════════════
