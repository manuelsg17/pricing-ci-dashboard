-- ════════════════════════════════════════════════════════════════════════
-- 201_fix_regresiones_195_197_198.sql — tres bugs introducidos por las
-- migraciones que se aplicaron a producción el 2026-08-02.
--
-- ⚠️  NO APLICADA. Requiere autorización explícita del user (CLAUDE.md §3).
--
-- Los tres salieron de una revisión adversarial con agentes en paralelo y los
-- tres se reprodujeron ejecutándolos con `SET LOCAL ROLE authenticated`, no
-- leyendo el código.
--
-- ── 1 · FUGA · ci_hub_daily_minutes y ci_turno_minutes (mig 195) ────────
-- Las dos son SECURITY DEFINER con GRANT a `authenticated` y su único gate es
-- `require_country_access(p_country)`. Les falta el chequeo de USUARIO.
--
-- `ci_sessions` tiene RLS `SELECT USING (is_admin() OR user_email = auth.email())`.
-- Las RPCs la bypasean por ser DEFINER. Reproducido:
--
--   -- como hub A (rol no-admin, países ["Peru"])
--   SELECT count(*) FROM ci_sessions WHERE user_email='B';        → 0   (RLS OK)
--   SELECT * FROM ci_hub_daily_minutes('Peru', …);
--     user_email | observed_date | minutos | sesiones
--     B          | 2026-08-01    |    60.0 |        1                ← FUGA
--
-- O sea: cualquier hub autenticado enumera el email, los minutos trabajados
-- por día y la cantidad de sesiones de TODOS sus compañeros del país. Es dato
-- de gestión de personas que la RLS reserva a admin y al dueño.
--
-- Es la regla textual de CLAUDE.md §3: "la UI muestra un botón; la API no es
-- la UI". Las dos alimentan Monitoreo, que es `adminOnly: true` en App.jsx,
-- así que el guard correcto es `is_admin()` ADEMÁS del de país. `ci_turno_minutes`
-- devuelve agregados por turno sin identificar personas, pero se cierra igual:
-- alimenta la misma pantalla y no hay razón para que un hub la consulte.
--
-- ── 2 · FUGA · close_ci_session no valida el país (mig 197) ─────────────
-- La RPC nueva se apoya solo en la política `ci_sessions_insert`, que valida
-- `user_email = auth.email()` y nada más. Reproducido: un hub con
-- `permissions.countries = ["Peru"]` insertó una sesión de Bolivia.
--
--   SELECT close_ci_session('…'::uuid, jsonb_build_object('country','Bolivia', …));
--   → {"id": 148, "duplicado": false}
--   SELECT country, city, user_email FROM ci_sessions WHERE city='La Paz';
--   → Bolivia | La Paz | hub_de_peru
--
-- Esa fila después aparece en `ci_hub_daily_minutes('Bolivia', …)` y en el
-- panel de turnos de los admins de Bolivia: un hub contamina la métrica de un
-- país que no le corresponde. Es exactamente lo que CLAUDE.md §3 pide no
-- repetir: al aflojar un guard hay que agregar `require_country_access` en el
-- MISMO cambio.
--
-- ── 3 · MENTIRA · admin_close_ci_session escribe 0.0 "confiable" (mig 198) ─
-- Usa `ci_duration_from_timings()` directo en vez del envoltorio
-- `ci_duration_recalculada()` que la mig 196 creó justamente para esto: un
-- tramo de menos de 3 segundos redondea a `0.0`, y como `0.0 IS NOT NULL` el
-- COALESCE al reloj de pared nunca dispara.
--
--   turno de 2 segundos → dur = 0.0 | confiable = t | motivo = NULL
--
-- Es el síntoma que originó todo el trabajo ("sesiones terminadas en 0.1
-- minutos") volviendo por una puerta nueva, y peor que antes: marcado como
-- CONFIABLE, así que ningún filtro de calidad lo saca y entra a los promedios.
-- Rompe además la verificación (3) de la mig 196, que afirma que ninguna fila
-- puede quedar en 0.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1 · Cerrar la fuga entre hubs ───────────────────────────────────────
-- Firmas IDÉNTICAS → CREATE OR REPLACE reemplaza de verdad, sin overload.
CREATE OR REPLACE FUNCTION public.ci_hub_daily_minutes(
  p_country text,
  p_from    date,
  p_to      date
)
RETURNS TABLE (
  user_email    text,
  observed_date date,
  minutos       numeric,
  sesiones      int,
  confiable     boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- LO QUE FALTABA. Devuelve QUIÉN trabajó y CUÁNTO: es dato de gestión de
  -- personas, y la RLS de ci_sessions lo reserva a admin. Sin esto, ser
  -- DEFINER convertía la RPC en un bypass de esa política.
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'access_denied: los minutos por hub son solo para administradores'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

  RETURN QUERY
  WITH tramos AS (
    SELECT s.user_email AS ue,
           s.observed_date AS od,
           ci_ts_or_null(e.value->>'startedAt') AS ini,
           LEAST(
             coalesce(ci_ts_or_null(e.value->>'endedAt'), s.ended_at),
             ci_ts_or_null(e.value->>'startedAt') + interval '4 hours'
           ) AS fin
    FROM ci_sessions s,
         LATERAL jsonb_each(coalesce(s.turno_timings, '{}'::jsonb)) e
    WHERE s.country = p_country
      AND s.observed_date BETWEEN p_from AND p_to
      AND jsonb_typeof(e.value) = 'object'
      AND ci_ts_or_null(e.value->>'startedAt') IS NOT NULL
  ),
  validos AS (
    SELECT ue, od, ini, fin FROM tramos WHERE fin IS NOT NULL AND fin > ini
  ),
  ordenados AS (
    SELECT ue, od, ini, fin,
           CASE WHEN ini > max(fin) OVER (
                  PARTITION BY ue, od ORDER BY ini
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
                THEN 1 ELSE 0 END AS marca
    FROM validos
  ),
  grupos AS (
    SELECT ue, od, ini, fin,
           sum(marca) OVER (PARTITION BY ue, od ORDER BY ini) AS grupo
    FROM ordenados
  ),
  unidos AS (
    SELECT ue, od, grupo, min(ini) AS ini, max(fin) AS fin
    FROM grupos GROUP BY ue, od, grupo
  ),
  totales AS (
    SELECT ue, od, sum(EXTRACT(EPOCH FROM (fin - ini)) / 60.0) AS mins
    FROM unidos GROUP BY ue, od
  )
  SELECT t.ue,
         t.od,
         round(t.mins::numeric, 1),
         (SELECT count(*)::int FROM ci_sessions x
           WHERE x.country = p_country AND x.user_email = t.ue AND x.observed_date = t.od),
         (SELECT bool_and(coalesce(x.duration_confiable, false)) FROM ci_sessions x
           WHERE x.country = p_country AND x.user_email = t.ue AND x.observed_date = t.od)
  FROM totales t
  ORDER BY t.od DESC, t.ue;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ci_turno_minutes(
  p_country text,
  p_from    date,
  p_to      date
)
RETURNS TABLE (
  turno       text,
  muestras    bigint,
  min_prom    numeric,
  min_mediana numeric,
  min_min     numeric,
  min_max     numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Alimenta Monitoreo, que es adminOnly. No identifica personas, pero se
  -- cierra por el mismo criterio: la API no es la UI.
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'access_denied: los tiempos por turno son solo para administradores'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

  RETURN QUERY
  WITH tramos AS (
    SELECT e.key AS etiqueta,
           ci_ts_or_null(e.value->>'startedAt') AS ini,
           LEAST(
             coalesce(ci_ts_or_null(e.value->>'endedAt'), s.ended_at),
             ci_ts_or_null(e.value->>'startedAt') + interval '4 hours'
           ) AS fin
    FROM ci_sessions s,
         LATERAL jsonb_each(coalesce(s.turno_timings, '{}'::jsonb)) e
    WHERE s.country = p_country
      AND s.observed_date BETWEEN p_from AND p_to
      AND s.duration_confiable IS TRUE
      AND jsonb_typeof(e.value) = 'object'
      AND ci_ts_or_null(e.value->>'startedAt') IS NOT NULL
  ),
  medidos AS (
    SELECT etiqueta, EXTRACT(EPOCH FROM (fin - ini)) / 60.0 AS mins
    FROM tramos WHERE fin IS NOT NULL AND fin > ini
  )
  SELECT m.etiqueta,
         count(*),
         round(avg(m.mins)::numeric, 1),
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY m.mins)::numeric, 1),
         round(min(m.mins)::numeric, 1),
         round(max(m.mins)::numeric, 1)
  FROM medidos m
  GROUP BY m.etiqueta
  ORDER BY m.etiqueta;
END;
$function$;

-- ── 2 · close_ci_session: validar el país ───────────────────────────────
-- Se conserva SECURITY INVOKER: la política ci_sessions_insert sigue siendo la
-- autoridad sobre el dueño. Lo que se agrega es el eje que esa política no
-- mira, que es el país.
DROP FUNCTION IF EXISTS public.close_ci_session(uuid, jsonb);
CREATE FUNCTION public.close_ci_session(p_close_token uuid, p_session jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id       int;
  v_dup      boolean := false;
  v_country  text := p_session->>'country';
BEGIN
  IF p_close_token IS NULL THEN
    RAISE EXCEPTION 'close_ci_session: falta close_token (clave de idempotencia)'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- LO QUE FALTABA. Sin esto un hub de Perú cerraba sesiones de Bolivia y
  -- contaminaba la métrica de otro país (verificado).
  IF v_country IS NULL THEN
    RAISE EXCEPTION 'close_ci_session: falta country en el payload'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;
  PERFORM require_country_access(v_country);

  INSERT INTO ci_sessions (
    country, city, zone, observed_date, user_email,
    started_at, ended_at,
    duration_minutes, duration_confiable, duration_motivo,
    rows_saved, total_expected, turno_timings,
    active_minutes, idle_minutes, activity_trace,
    close_token
  )
  VALUES (
    v_country,
    p_session->>'city',
    NULLIF(p_session->>'zone', ''),
    (p_session->>'observed_date')::date,
    COALESCE(p_session->>'user_email', (select auth.email())),
    (p_session->>'started_at')::timestamptz,
    (p_session->>'ended_at')::timestamptz,
    (p_session->>'duration_minutes')::numeric,
    (p_session->>'duration_confiable')::boolean,
    p_session->>'duration_motivo',
    (p_session->>'rows_saved')::int,
    (p_session->>'total_expected')::int,
    NULLIF(p_session->'turno_timings', 'null'::jsonb),
    (p_session->>'active_minutes')::numeric,
    (p_session->>'idle_minutes')::numeric,
    NULLIF(p_session->'activity_trace', 'null'::jsonb),
    p_close_token
  )
  ON CONFLICT (close_token) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    v_dup := true;
    SELECT id INTO v_id FROM ci_sessions WHERE close_token = p_close_token;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'close_ci_session: el close_token pertenece a otra sesión'
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'duplicado', v_dup, 'close_token', p_close_token);
END;
$function$;

COMMENT ON FUNCTION public.close_ci_session(uuid, jsonb) IS
  'Cierre idempotente de una sesión de Ingresar CI. El mismo close_token no '
  'inserta dos veces. SECURITY INVOKER: la política ci_sessions_insert sigue '
  'siendo la autoridad sobre el dueño; el país lo valida require_country_access '
  '(mig 201).';

REVOKE ALL ON FUNCTION public.close_ci_session(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_ci_session(uuid, jsonb) TO authenticated;

-- ── 3 · admin_close: usar el envoltorio que convierte 0.0 en NULL ────────
-- Solo cambian las dos llamadas a ci_duration_from_timings por
-- ci_duration_recalculada. El resto del cuerpo es idéntico al de la mig 198.
CREATE OR REPLACE FUNCTION public.admin_close_ci_session(
  p_country       text,
  p_city          text,
  p_zone          text,
  p_observed_date date,
  p_user_email    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_admin          text := (select auth.email());
  v_now            timestamptz := now();
  v_started_at     timestamptz;
  v_turno_timings  jsonb;
  v_rows_saved     int;
  v_total_expected int;
  v_inicio         timestamptz;
  v_duracion       numeric;
  v_motivo         text;
  v_id             bigint;
  v_hay_latido     boolean;
  v_medida         numeric;   -- duración salida de los turnos (o NULL)
  v_piso           boolean := false;  -- se disparó el piso de plausibilidad
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Solo un administrador puede cerrar una sesión ajena';
  END IF;
  PERFORM require_country_access(p_country);

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_user_email || '|' || p_country || '|' || p_city || '|' ||
      coalesce(nullif(p_zone, ''), '') || '|' || p_observed_date::text, 0)
  );

  SELECT started_at, total_expected, turno_progress->'timings'
    INTO v_started_at, v_total_expected, v_turno_timings
  FROM ci_active_sessions
  WHERE user_email = p_user_email
    AND country = p_country
    AND city = p_city
    AND COALESCE(NULLIF(zone, ''), '') = COALESCE(NULLIF(p_zone, ''), '')
    AND observed_date = p_observed_date;

  v_hay_latido := FOUND;

  IF NOT v_hay_latido THEN
    SELECT id INTO v_id
    FROM ci_sessions
    WHERE user_email = p_user_email
      AND country = p_country
      AND city = p_city
      AND COALESCE(NULLIF(zone, ''), '') = COALESCE(NULLIF(p_zone, ''), '')
      AND observed_date = p_observed_date
    ORDER BY ended_at DESC NULLS LAST, id DESC
    LIMIT 1;

    RETURN jsonb_build_object('id', v_id, 'duplicado', true, 'cerrada', false);
  END IF;

  SELECT count(*)::int INTO v_rows_saved
  FROM pricing_observations po
  WHERE po.country = p_country
    AND po.city = p_city
    AND COALESCE(NULLIF(po.zone, ''), '') = COALESCE(NULLIF(p_zone, ''), '')
    AND po.observed_date = p_observed_date
    AND po.uploaded_by = p_user_email
    AND po.data_source = 'manual';

  -- ci_duration_recalculada, NO ci_duration_from_timings: el envoltorio de la
  -- mig 196 devuelve NULL donde la otra devuelve 0.0 por redondeo. Se calcula
  -- UNA vez y se reusa: llamarla dos veces invitaba a que las ramas se
  -- desincronizaran.
  v_medida := ci_duration_recalculada(v_turno_timings, v_now);

  -- ── PISO DE PLAUSIBILIDAD ────────────────────────────────────────────
  -- `ci_duration_recalculada` es `NULLIF(x, 0)`: caza el 0.0 EXACTO y nada
  -- más. Un turno de 4 segundos redondea a 0.1 y salía con motivo NULL, o sea
  -- CONFIABLE. Es el mismo "sesiones de 0.1 minutos" que originó todo este
  -- trabajo, apenas corrido un decimal.
  --
  -- Un corte son 36-108 celdas. Menos de UN minuto de trabajo medido en TODOS
  -- los turnos juntos no es una medición corta: es una grilla que llegó
  -- completa de un saque, o timings estampados en el mismo instante. Se trata
  -- igual que la ausencia de medición y se cae al reloj, marcado.
  IF v_medida IS NOT NULL AND v_medida < 1.0 THEN
    v_medida := NULL;
    v_piso   := true;
  END IF;

  v_duracion := COALESCE(
    v_medida,
    CASE WHEN v_started_at IS NOT NULL AND v_started_at <= v_now
      THEN round((LEAST(EXTRACT(EPOCH FROM (v_now - v_started_at)), 43200) / 60.0)::numeric, 1)
    END
  );

  -- ── LA VENTANA TIENE QUE DESCRIBIR LA DURACIÓN ───────────────────────
  -- Antes `v_inicio` salía SIEMPRE de los turnos y `v_duracion` podía salir
  -- del reloj del latido: dos fuentes distintas que se contradecían por
  -- órdenes de magnitud. Caso real medido: latido abierto hace 9 h + un turno
  -- de 2 segundos → la fila decía 540 minutos con started_at y ended_at
  -- separados por 2 segundos. Y `CompletedSessionsTable` muestra la duración
  -- en negrita, al lado de esas dos columnas.
  --
  -- Si la duración vino del reloj, el inicio también.
  IF v_medida IS NOT NULL THEN
    v_inicio := COALESCE(ci_started_from_timings(v_turno_timings), v_started_at, v_now);
  ELSE
    v_inicio := COALESCE(v_started_at, ci_started_from_timings(v_turno_timings), v_now);
  END IF;

  v_motivo := ci_duration_quality_from_timings(v_turno_timings, v_now);
  -- Si la duración NO salió de los turnos, la fila no es confiable aunque la
  -- calidad de los timings diera NULL.
  IF v_medida IS NULL THEN
    v_motivo := COALESCE(v_motivo, CASE WHEN v_piso THEN 'duracion_de_juguete' ELSE 'reloj_latido' END);
    -- El piso es más específico que "los turnos se veían bien": si se disparó,
    -- gana él, para que una auditoría pueda encontrar estas filas por motivo.
    IF v_piso THEN v_motivo := 'duracion_de_juguete'; END IF;
  END IF;

  INSERT INTO ci_sessions (
    country, city, zone, observed_date, user_email,
    started_at, ended_at, duration_minutes, rows_saved, total_expected,
    turno_timings, closed_by, duration_confiable, duration_motivo
  ) VALUES (
    p_country, p_city, p_zone, p_observed_date, p_user_email,
    v_inicio, v_now, v_duracion,
    COALESCE(v_rows_saved, 0), v_total_expected,
    v_turno_timings, v_admin,
    (v_motivo IS NULL), v_motivo
  )
  RETURNING id INTO v_id;

  DELETE FROM ci_active_sessions
  WHERE user_email = p_user_email
    AND country = p_country
    AND city = p_city
    AND COALESCE(NULLIF(zone, ''), '') = COALESCE(NULLIF(p_zone, ''), '')
    AND observed_date = p_observed_date;

  RETURN jsonb_build_object('id', v_id, 'duplicado', false, 'cerrada', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_close_ci_session(text, text, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_close_ci_session(text, text, text, date, text) TO authenticated;

REVOKE ALL ON FUNCTION public.ci_hub_daily_minutes(text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ci_hub_daily_minutes(text, date, date) TO authenticated;
REVOKE ALL ON FUNCTION public.ci_turno_minutes(text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ci_turno_minutes(text, date, date) TO authenticated;

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- 1) Un hub NO admin ya no ve a sus compañeros:
--      SET LOCAL ROLE authenticated;  -- claims de un hub cualquiera
--      SELECT * FROM ci_hub_daily_minutes('Peru', …);   → access_denied (42501)
--    Y un admin sí:                                      → filas
--
-- 2) Un hub de Perú ya no cierra sesiones de otro país:
--      SELECT close_ci_session(gen_random_uuid(),
--        jsonb_build_object('country','Bolivia', …));    → access_denied (42501)
--    Y en su país sigue funcionando igual (idempotencia intacta: mismo token
--    devuelve el mismo id, token nuevo inserta).
--
-- 3) admin_close con un turno de 2 segundos y otro de 4 segundos:
--      → los dos caen al reloj del latido, duration_confiable = false y
--        duration_motivo = 'duracion_de_juguete'
--      → started_at/ended_at describen la MISMA ventana que duration_minutes
--
--    La verificación anterior era VACUA: contaba `duration_minutes = 0`, que es
--    justo el único caso que NULLIF(x,0) ya manejaba. Un turno de 4 segundos da
--    0.1 y pasaba igual. Lo que hay que contar es:
--
--      SELECT count(*) FROM ci_sessions
--       WHERE duration_minutes < 1 AND duration_confiable;         → 0
--      SELECT count(*) FROM ci_sessions
--       WHERE duration_confiable
--         AND duration_minutes > EXTRACT(EPOCH FROM (ended_at-started_at))/60 + 1;  → 0
--        (la duración no puede exceder su propia ventana)
--
-- 4) Sin overloads: una sola firma para las 4 funciones tocadas.
-- 5) npm run check:anon-rpcs → nivel 1 en 0.
--
-- ⚠️ EL FRONTEND NO NECESITA CAMBIOS: `ci_turno_minutes` solo se llama desde
-- Monitoreo (adminOnly) y `ci_hub_daily_minutes` no se llama desde el cliente.
-- Verificar igual en navegador que el panel "Cuánto tarda cada corte" sigue
-- mostrando datos para un admin.
