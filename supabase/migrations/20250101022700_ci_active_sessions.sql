-- ════════════════════════════════════════════════════════════════════════
-- Migración 146 — Sesiones EN VIVO de "Ingresar CI" (latido) para Monitoreo
--
-- CONTEXTO (2026-07-22): el admin necesita ver, en tiempo real, cuántos hubs
-- tienen una sesión de CI abierta ahora mismo y en qué ciudad/distrito.
-- `ci_sessions` (mig 140) solo registra una fila al TERMINAR — no existe hoy
-- ningún rastro server-side de una sesión EN CURSO (sessionActive vive solo
-- en el navegador del hub). Esta tabla es ese rastro: una fila por hub
-- (PK = user_email), que el cliente actualiza (upsert) cada ~25s mientras la
-- sesión esté activa, y borra al Terminar/descartar.
--
-- `started_at` se fija UNA sola vez (en el INSERT) y el UPSERT lo omite de su
-- SET — Postgres deja una columna no mencionada con su valor existente, así
-- que "cuándo empezó" no se resetea en cada latido sin necesitar lógica CASE.
--
-- RLS: mismo patrón que ci_sessions (mig 140) — SELECT: admin ve todo, el hub
-- ve solo la suya. A diferencia de ci_sessions (append-only, sin UPDATE/
-- DELETE), esta tabla SÍ necesita las 3 (INSERT/UPDATE/DELETE) porque el hub
-- actualiza su propio latido y lo borra al terminar/salir.
--
-- La RPC de upsert es SECURITY INVOKER (no DEFINER): no necesita saltarse
-- RLS, las policies de abajo ya la protegen — usa auth.email() del lado
-- servidor (no un parámetro del cliente) para que un hub no pueda escribir
-- la fila de otro.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ci_active_sessions (
  user_email      text PRIMARY KEY,
  country         text NOT NULL,
  city            text NOT NULL,
  zone            text,
  observed_date   date NOT NULL,
  filled_count    int NOT NULL DEFAULT 0,
  total_expected  int NOT NULL DEFAULT 0,
  started_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ci_active_sessions IS
  'Latido de sesión de Ingresar CI en curso — 1 fila por hub (user_email), actualizada cada ~25s mientras sessionActive=true en DataEntry.jsx. Se borra al Terminar/Descartar. Filas con last_seen_at viejo son sesiones abandonadas (refresh duro, cierre de laptop) — Monitoreo las trata como no-vivas por antigüedad, no hace falta borrarlas por cron.';

ALTER TABLE public.ci_active_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY ci_active_sessions_select ON public.ci_active_sessions
  FOR SELECT TO authenticated
  USING (is_admin() OR user_email = auth.email());

CREATE POLICY ci_active_sessions_insert ON public.ci_active_sessions
  FOR INSERT TO authenticated
  WITH CHECK (user_email = auth.email() OR is_admin());

CREATE POLICY ci_active_sessions_update ON public.ci_active_sessions
  FOR UPDATE TO authenticated
  USING (user_email = auth.email() OR is_admin())
  WITH CHECK (user_email = auth.email() OR is_admin());

CREATE POLICY ci_active_sessions_delete ON public.ci_active_sessions
  FOR DELETE TO authenticated
  USING (user_email = auth.email() OR is_admin());

CREATE OR REPLACE FUNCTION public.upsert_ci_active_session(
  p_country        text,
  p_city           text,
  p_zone           text,
  p_observed_date  date,
  p_filled_count   int,
  p_total_expected int
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email text := auth.email();
BEGIN
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'no_session' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO ci_active_sessions (
    user_email, country, city, zone, observed_date,
    filled_count, total_expected, started_at, last_seen_at
  ) VALUES (
    v_email, p_country, p_city, p_zone, p_observed_date,
    p_filled_count, p_total_expected, now(), now()
  )
  ON CONFLICT (user_email) DO UPDATE SET
    country        = EXCLUDED.country,
    city           = EXCLUDED.city,
    zone           = EXCLUDED.zone,
    observed_date  = EXCLUDED.observed_date,
    filled_count   = EXCLUDED.filled_count,
    total_expected = EXCLUDED.total_expected,
    last_seen_at   = now();
    -- started_at deliberadamente FUERA del SET: Postgres deja la columna
    -- omitida con su valor existente → "fijado una sola vez" gratis.
END;
$function$;

GRANT EXECUTE ON FUNCTION public.upsert_ci_active_session(text, text, text, date, int, int) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   SELECT upsert_ci_active_session('Peru','Lima',NULL,current_date,5,40);
--   SELECT * FROM ci_active_sessions;  -- started_at = last_seen_at la 1ra vez
--   SELECT upsert_ci_active_session('Peru','Lima',NULL,current_date,8,40);
--   SELECT * FROM ci_active_sessions;  -- started_at IGUAL, last_seen_at avanzó
-- ════════════════════════════════════════════════════════════════════════
