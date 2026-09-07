-- ════════════════════════════════════════════════════════════════════════
-- Migración 243 — Alerta al propio hub: sesiones de CI que quedaron a medias
--
-- POR QUÉ:
--   `get_unfinished_ci_sessions` (mig 147) ya detecta esto, pero es
--   admin-only y vive en Monitoreo — un hub que dejó algo a medias (cerró la
--   laptop, se cortó la luz) no se entera hasta que un admin lo revisa y le
--   avisa a mano. Pedido user 2026-09-07: avisarle AL PROPIO HUB, la próxima
--   vez que abra Ingresar CI, desde cualquier dispositivo (esto no depende
--   de localStorage — cubre el caso real que la mig 191/el aviso temprano de
--   conflicto NO cubren: no es que dos pantallas escribieron, es que NINGUNA
--   volvió a escribir).
--
-- QUÉ HACE:
--   RPC self-scoped (auth.email(), sin is_admin()) — mismo query shape que
--   get_unfinished_ci_sessions pero acotado a las propias filas del caller y
--   a una ventana configurable (default 7 días), excluyendo HOY (el trabajo
--   de hoy puede seguir legítimamente en curso). Mismo caveat heredado de la
--   147: diagnóstico best-effort, no autoritativo (ruido histórico de zona).
--
-- SEGURIDAD: SECURITY DEFINER con search_path fijo. No hay gate de sección
--   ni de país — un usuario autenticado solo puede ver SUS PROPIAS filas
--   (uploaded_by = auth.email() es la única condición de filtro posible, no
--   hay forma de pedir las de otro). GRANT solo a authenticated.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_my_unfinished_ci_sessions(
  p_days_back int DEFAULT 7
) RETURNS TABLE(
  city          text,
  zone          text,
  observed_date date,
  n_rows        bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email text := auth.email();
BEGIN
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'access_denied: requiere sesión iniciada'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT
    po.city,
    NULLIF(po.zone, '') AS zone,
    po.observed_date,
    count(*)::bigint AS n_rows
  FROM pricing_observations po
  WHERE po.data_source = 'manual'
    AND po.uploaded_by = v_email
    AND po.observed_date >= current_date - greatest(p_days_back, 1)
    AND po.observed_date < current_date
    AND NOT EXISTS (
      SELECT 1 FROM ci_sessions cs
      WHERE cs.city = po.city
        AND cs.observed_date = po.observed_date
        AND cs.user_email = po.uploaded_by
        AND COALESCE(NULLIF(cs.zone, ''), '') = COALESCE(NULLIF(po.zone, ''), '')
    )
  GROUP BY po.city, NULLIF(po.zone, ''), po.observed_date
  ORDER BY po.observed_date DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_my_unfinished_ci_sessions(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_unfinished_ci_sessions(int) TO authenticated;

COMMENT ON FUNCTION public.get_my_unfinished_ci_sessions(int) IS
  'Mig 243 — sesiones de CI del propio caller (auth.email()) con filas guardadas pero sin cierre en ci_sessions, últimos N días excluyendo hoy. Self-scoped, sin gate de sección/país: cada quien solo ve lo suyo.';

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   SELECT * FROM get_my_unfinished_ci_sessions(7);
--   (devuelve solo filas de auth.email() del caller — nunca de otro hub)
-- ════════════════════════════════════════════════════════════════════════
