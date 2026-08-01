-- ════════════════════════════════════════════════════════════════════════
-- 194_ci_duration_single_source.sql — que `ci_sessions.duration_minutes`
-- deje de mentir, y que tenga UNA sola fuente de verdad.
--
-- REPORTE DEL USER (2026-08-01): "no tenga data de sesiones terminadas en
-- 0.1 minutos que es lo que sucede actualmente". Quiere confiar en el número
-- para saber cuánto le toma a cada hub el corte de la mañana, el de la tarde
-- y el de la noche.
--
-- Había DOS caminos que escribían esa misma columna, con dos algoritmos
-- distintos, y los dos producían basura:
--
--  A) El cliente (DataEntry.jsx) restaba un cronómetro de reloj de pared
--     (`sessionStartRef`) que se pisa con `Date.now()` en cinco lugares. El
--     caso que reportó el user: Aeropuerto "Ambos" — el hub llena Punto A y
--     Punto B en la misma sentada y cierra los dos seguidos; al cerrar A el
--     cronómetro se reinicia, así que B (una hora de trabajo) se guardaba
--     con los SEGUNDOS que pasaron entre un click y el otro → 0.1 min.
--
--  B) Esta función, `admin_close_ci_session`, medía desde
--     `ci_active_sessions.started_at` y escribía **0 literal** cuando no
--     encontraba fila de latido. Y esa fila se borra en cualquier navegación
--     interna del cliente (SESIONES_HALLAZGOS.md P1-4), así que el 0 no era
--     un caso raro. En la dirección opuesta, un `started_at` heredado de
--     ayer (P1-5) escribía ~24h.
--
-- EL CAMBIO
-- La duración se DERIVA de `turno_timings` (mig 159), que es lo único que
-- mide trabajo real: startedAt en el primer fill de cada turno, endedAt al
-- completarlo, estampado una sola vez y nunca sobreescrito. Sobrevive al F5
-- (viaja en el borrador, en el latido y en ci_sessions) y no le importa
-- cuándo se apretó "Terminar".
--
--   duración = minutos de la UNIÓN de los tramos [startedAt, endedAt]
--
-- Unión y no suma: un hub puede intercalar Mañana y Tarde, y sumar los dos
-- tramos contaría dos veces el mismo minuto de pared.
--
-- Este archivo es el lado servidor. El cliente usa el MISMO algoritmo en
-- src/lib/sessionDuration.js (simulaciones en scripts/test-session-duration.mjs);
-- que sean dos implementaciones es inevitable —una corre en el navegador y la
-- otra en Postgres— pero las reglas y las constantes están escritas iguales a
-- propósito, y cualquier cambio a una obliga a tocar la otra.
--
-- NO se agrega ni se borra ninguna columna: `duration_minutes` ya era
-- nullable. El cambio es aditivo y compatible hacia atrás — un bundle viejo
-- sigue funcionando contra este esquema (CLAUDE.md §4).
-- ════════════════════════════════════════════════════════════════════════

-- ── Cast seguro ─────────────────────────────────────────────────────────
-- `turno_timings` es jsonb libre: una clave con texto que no es una fecha
-- haría abortar el cierre administrativo entero con un error de cast. Se
-- prefiere ignorar ese turno antes que impedirle al admin cerrar la sesión.
CREATE OR REPLACE FUNCTION public.ci_ts_or_null(p_txt text)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_txt IS NULL OR p_txt = '' THEN
    RETURN NULL;
  END IF;
  RETURN p_txt::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION public.ci_ts_or_null(text) IS
  'Cast a timestamptz que devuelve NULL en vez de fallar. Para leer turno_timings (jsonb sin esquema).';

-- ── Inicio real del trabajo ─────────────────────────────────────────────
-- El startedAt más antiguo entre los turnos que el hub llegó a tocar. Es un
-- `started_at` mucho más honesto que el del latido, que puede venir heredado
-- de una sesión de ayer (P1-5).
CREATE OR REPLACE FUNCTION public.ci_started_from_timings(p_timings jsonb)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT min(ci_ts_or_null(e.value->>'startedAt'))
  FROM jsonb_each(
    CASE WHEN jsonb_typeof(COALESCE(p_timings, 'null'::jsonb)) = 'object'
      THEN p_timings ELSE '{}'::jsonb END
  ) e
  WHERE jsonb_typeof(e.value) = 'object';
$function$;

COMMENT ON FUNCTION public.ci_started_from_timings(jsonb) IS
  'Inicio real del trabajo: el startedAt más antiguo de turno_timings. NULL si el hub no tocó ningún turno.';

-- ── Duración ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ci_duration_from_timings(
  p_timings jsonb,
  p_fin     timestamptz DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- Techo de UN turno. Un turno son 36-108 celdas: llenarlo lleva minutos,
  -- no horas. Un tramo más largo no es trabajo lento, es la laptop cerrada
  -- (P1-6) o un turno que quedó abierto de ayer. Debe coincidir con
  -- TURNO_MAX_MS de src/lib/sessionDuration.js.
  v_max_turno constant interval := interval '4 hours';
  r        record;
  v_cur_i  timestamptz;
  v_cur_f  timestamptz;
  v_total  interval := interval '0 seconds';
  v_any    boolean := false;
BEGIN
  IF p_timings IS NULL OR jsonb_typeof(p_timings) <> 'object' THEN
    RETURN NULL;
  END IF;

  FOR r IN
    WITH crudo AS (
      SELECT ci_ts_or_null(e.value->>'startedAt') AS ini,
             ci_ts_or_null(e.value->>'endedAt')   AS fin
      FROM jsonb_each(p_timings) e
      WHERE jsonb_typeof(e.value) = 'object'
    ),
    -- Turno abierto (sin endedAt) o corrupto (fin anterior a su inicio, pasa
    -- con relojes de máquina desincronizados): se cierra con el fin de
    -- sesión. Si no hay fin de sesión, el turno no aporta minutos — no se
    -- le inventa una duración.
    con_fin AS (
      SELECT ini,
             CASE WHEN fin IS NULL OR fin < ini THEN p_fin ELSE fin END AS fin
      FROM crudo
      WHERE ini IS NOT NULL
    ),
    acotado AS (
      SELECT ini, LEAST(fin, ini + v_max_turno) AS fin
      FROM con_fin
      WHERE fin IS NOT NULL AND fin >= ini
    )
    SELECT ini, fin FROM acotado ORDER BY ini
  LOOP
    v_any := true;
    IF v_cur_i IS NULL THEN
      v_cur_i := r.ini;
      v_cur_f := r.fin;
    ELSIF r.ini <= v_cur_f THEN
      -- Se solapa o es contiguo con el tramo en curso: extenderlo, no sumarlo
      -- aparte (si no, se cuenta dos veces el mismo minuto de pared).
      IF r.fin > v_cur_f THEN v_cur_f := r.fin; END IF;
    ELSE
      v_total := v_total + (v_cur_f - v_cur_i);
      v_cur_i := r.ini;
      v_cur_f := r.fin;
    END IF;
  END LOOP;

  -- NULL, no 0. Un 0 entra en cualquier promedio y hace creer que el corte
  -- fue instantáneo; un NULL se excluye. Es la diferencia entre "no sé" y
  -- "tardó nada", y es justo la que rompía la métrica.
  IF NOT v_any THEN
    RETURN NULL;
  END IF;

  v_total := v_total + (v_cur_f - v_cur_i);
  RETURN round((EXTRACT(EPOCH FROM v_total) / 60.0)::numeric, 1);
END;
$function$;

COMMENT ON FUNCTION public.ci_duration_from_timings(jsonb, timestamptz) IS
  'Minutos de trabajo real = unión de los tramos [startedAt,endedAt] de turno_timings, con cada tramo acotado a 4h. NULL si no hay ningún turno medible (nunca 0). Espejo SQL de duracionDeSesion() en src/lib/sessionDuration.js.';

-- Higiene de permisos (CLAUDE.md §3): son helpers puros, pero por defecto
-- Postgres da EXECUTE a PUBLIC y quedarían expuestas como RPC de PostgREST
-- sin motivo. `admin_close_ci_session` es SECURITY DEFINER y las ejecuta como
-- su dueño, así que no necesita estos grants.
REVOKE ALL ON FUNCTION public.ci_ts_or_null(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ci_started_from_timings(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ci_duration_from_timings(jsonb, timestamptz) FROM PUBLIC, anon, authenticated;

-- ── Cierre administrativo: misma fuente de verdad que el cliente ────────
-- Firma IDÉNTICA a la de mig 159 → `CREATE OR REPLACE` la reemplaza de
-- verdad y no crea un overload (CLAUDE.md §3). Por eso no hay DROP acá.
CREATE OR REPLACE FUNCTION public.admin_close_ci_session(p_country text, p_city text, p_zone text, p_observed_date date, p_user_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_admin          text := auth.email();
  v_started_at     timestamptz;
  v_total_expected int;
  v_turno_timings  jsonb;
  v_rows_saved     bigint;
  v_now            timestamptz := now();
  v_inicio         timestamptz;
  v_duracion       numeric;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'access_denied: cerrar sesiones es solo para admin'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

  -- turno_progress->'timings' (mig 159): mismo motivo que total_expected
  -- (mig 157) — un latido en vuelo puede tener el dato más fresco que lo
  -- que el cliente llegue a mandar en su propio Terminar Sesión.
  SELECT started_at, total_expected, turno_progress->'timings'
    INTO v_started_at, v_total_expected, v_turno_timings
  FROM ci_active_sessions
  WHERE user_email = p_user_email
    AND country = p_country
    AND city = p_city
    AND COALESCE(NULLIF(zone, ''), '') = COALESCE(NULLIF(p_zone, ''), '')
    AND observed_date = p_observed_date
  LIMIT 1;

  SELECT count(*) INTO v_rows_saved
  FROM pricing_observations po
  WHERE po.country = p_country
    AND po.city = p_city
    AND COALESCE(NULLIF(po.zone, ''), '') = COALESCE(NULLIF(p_zone, ''), '')
    AND po.observed_date = p_observed_date
    AND po.uploaded_by = p_user_email
    AND po.data_source = 'manual';

  -- Inicio real del trabajo. El del latido queda como respaldo porque puede
  -- venir heredado de una sesión de ayer (P1-5); el de los turnos no.
  v_inicio := COALESCE(
    ci_started_from_timings(v_turno_timings),
    v_started_at,
    v_now
  );

  v_duracion := COALESCE(
    -- 1. Trabajo real medido por turno. Es la fuente preferida.
    ci_duration_from_timings(v_turno_timings, v_now),
    -- 2. Sin ningún turno tocado no queda más que el reloj de pared del
    --    latido, acotado a 12h (3 turnos × 4h) para que un started_at
    --    heredado de ayer no escriba ~24h. Se sabe que es un número flojo,
    --    pero es mejor que nada y está acotado.
    CASE WHEN v_started_at IS NOT NULL AND v_started_at <= v_now
      THEN round((LEAST(EXTRACT(EPOCH FROM (v_now - v_started_at)), 43200) / 60.0)::numeric, 1)
    END
    -- 3. Ni turnos ni latido → NULL. Antes acá se escribía 0, que es una
    --    mentira que se promedia. Ahora se puede excluir con IS NULL.
  );

  INSERT INTO ci_sessions (
    country, city, zone, observed_date, user_email,
    started_at, ended_at, duration_minutes, rows_saved, total_expected,
    turno_timings, closed_by
  ) VALUES (
    p_country, p_city, p_zone, p_observed_date, p_user_email,
    v_inicio, v_now,
    v_duracion,
    COALESCE(v_rows_saved, 0),
    v_total_expected,
    v_turno_timings,
    v_admin
  );

  DELETE FROM ci_active_sessions
  WHERE user_email = p_user_email
    AND country = p_country
    AND city = p_city
    AND COALESCE(NULLIF(zone, ''), '') = COALESCE(NULLIF(p_zone, ''), '')
    AND observed_date = p_observed_date;
END;
$function$;
