-- ============================================================
-- MIGRACIÓN 152: presencia — "quién más está acá ahora" para hubs
-- ============================================================
--
-- CONTEXTO: con 3 hub experts (uno por ciudad, desde la semana próxima)
-- cubriendo Lima/Trujillo/Arequipa SIN restricción de ciudad, dos hubs
-- pueden terminar llenando el mismo Punto de Aeropuerto o el mismo
-- distrito de TukTuk sin saberlo — no hay ningún choque de DATOS (el
-- DELETE-antes-de-INSERT ya se acota por dueño, ver performSave), pero sí
-- se puede duplicar trabajo en vano. La solución NO es bloquear (la
-- flexibilidad de redistribuirse es intencional) sino dar visibilidad:
-- un badge chico "Fulano está acá ahora" en las sub-pestañas de
-- Aeropuerto y las píldoras de distrito de TukTuk.
--
-- `ci_active_sessions` (mig 146) ya tiene exactamente lo necesario, pero
-- su RLS de SELECT es `is_admin() OR user_email = auth.email()` — un hub
-- normal solo puede ver SU PROPIA fila, nunca la de un colega. Esta RPC
-- (SECURITY DEFINER, sin gate de admin) expone deliberadamente un
-- subconjunto MÍNIMO de columnas — nunca filled_count/total_expected/
-- turno_progress/recent_failures — para que sea presencia pura ("quién
-- está acá"), no un ranking de avance entre hubs.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_active_sessions_presence(
  p_country text
) RETURNS TABLE(
  user_email    text,
  city          text,
  zone          text,
  scope_label   text,
  last_seen_at  timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  SELECT
    cas.user_email,
    cas.city,
    cas.zone,
    cas.scope_label,
    cas.last_seen_at
  FROM ci_active_sessions cas
  WHERE cas.country = p_country
    AND cas.user_email <> auth.email()
    AND cas.last_seen_at > now() - interval '3 minutes';
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_active_sessions_presence(text) TO authenticated;

-- ============================================================
-- VERIFICACIÓN
--   SELECT * FROM get_active_sessions_presence('Peru');
--    (cualquier authenticated con acceso a ese país, no solo admin)
-- ============================================================
