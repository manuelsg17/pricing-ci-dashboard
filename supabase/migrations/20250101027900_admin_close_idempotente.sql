-- ════════════════════════════════════════════════════════════════════════
-- 198_admin_close_idempotente.sql — el doble clic del admin deja de duplicar.
--
-- EL BUG
-- `admin_close_ci_session` inserta en `ci_sessions` SIEMPRE, exista o no una
-- sesión activa que cerrar. Un doble clic en Monitoreo —o dos admins mirando
-- la misma pantalla— escribe dos filas para el mismo cierre, y esa duración
-- se cuenta dos veces en cualquier agregado.
--
-- POR QUÉ NO SIRVE LA CLAVE DE IDEMPOTENCIA DEL HUB (mig 197)
-- El token del hub lo genera el cliente y vive en su localStorage. Acá el
-- disparador es un click en Monitoreo, donde no hay una "intención de cierre"
-- que persista entre clics. Y un token determinístico por `started_at`
-- tampoco: una revisión legítima conserva el mismo inicio y quedaría
-- descartada en silencio, que es peor que el duplicado.
--
-- EL DISEÑO CORRECTO ES OTRO, y sale de leer qué significa la función.
-- "Cerrar la sesión activa" solo tiene sentido si HAY una sesión activa. La
-- fila de `ci_active_sessions` YA es la marca de "esto está abierto", y la
-- propia función la borra al terminar. O sea que el estado necesario para
-- distinguir "primer clic" de "segundo clic" ya existía y no se estaba
-- mirando.
--
--   1er clic → hay latido  → cierra, inserta, borra el latido
--   2do clic → no hay      → no hace nada (idempotente)
--   Cierre legítimamente nuevo → el hub volvió a trabajar, hay latido nuevo
--                                → cierra de verdad e inserta
--
-- Es más simple que un token, no necesita columna nueva, y no puede descartar
-- un cierre legítimo: si hay algo que cerrar, lo cierra.
--
-- SOBRE LA CARRERA: dos clics simultáneos podrían leer el latido los dos
-- antes de que ninguno lo borre. Se toma un advisory lock por sesión y se
-- re-verifica DENTRO del lock — el mismo patrón que la mig 191.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- DROP obligatorio: Postgres NO permite cambiar el tipo de retorno con
-- CREATE OR REPLACE ("cannot change return type of existing function"). Pasa
-- de `void` a `jsonb` para poder informar si cerró o si fue un duplicado.
--
-- Los PARÁMETROS son idénticos, así que esto NO crea un overload — que es el
-- riesgo real (PGRST203 rompería la pantalla para todos los clientes). Se
-- borra y se recrea la MISMA firma.
DROP FUNCTION IF EXISTS public.admin_close_ci_session(text, text, text, date, text);

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
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Solo un administrador puede cerrar una sesión ajena';
  END IF;
  PERFORM require_country_access(p_country);

  -- Serializa dos clics simultáneos sobre la MISMA sesión. Sin esto los dos
  -- podrían ver el latido antes de que ninguno lo borre, y duplicar igual.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_user_email || '|' || p_country || '|' || p_city || '|' ||
      coalesce(nullif(p_zone, ''), '') || '|' || p_observed_date::text, 0)
  );

  -- ¿Hay algo que cerrar? Se lee DENTRO del lock.
  --
  -- Los timings viven en `turno_progress->'timings'` (mig 159), NO en una
  -- columna `turno_timings` — esa existe en ci_sessions, no en el latido.
  -- Escribirlo mal no falla al crear la función: plpgsql no valida columnas
  -- hasta ejecutarla. Es exactamente la trampa de la mig 182, y acá se cayó
  -- en ella hasta que la simulación la ejecutó de verdad.
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
    -- Segundo clic, o una sesión que el hub ya cerró por su cuenta. No hay
    -- nada que cerrar: se devuelve el resultado del cierre ANTERIOR si
    -- existe, para que la pantalla muestre algo coherente en vez de un error.
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

  v_inicio := COALESCE(ci_started_from_timings(v_turno_timings), v_started_at, v_now);

  v_duracion := COALESCE(
    ci_duration_from_timings(v_turno_timings, v_now),
    CASE WHEN v_started_at IS NOT NULL AND v_started_at <= v_now
      THEN round((LEAST(EXTRACT(EPOCH FROM (v_now - v_started_at)), 43200) / 60.0)::numeric, 1)
    END
  );

  -- La calidad se calcula igual que en el cierre del hub (mig 195). Si la
  -- duración salió del reloj del latido y no de los turnos, NO es confiable
  -- aunque los turnos parezcan completos.
  v_motivo := ci_duration_quality_from_timings(v_turno_timings, v_now);
  IF ci_duration_from_timings(v_turno_timings, v_now) IS NULL THEN
    v_motivo := COALESCE(v_motivo, 'reloj_latido');
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

COMMENT ON FUNCTION public.admin_close_ci_session(text, text, text, date, text) IS
  'Cierra la sesión activa de un hub (solo admin). IDEMPOTENTE desde la mig '
  '198: sin fila en ci_active_sessions no hay nada que cerrar y no inserta. '
  'Devuelve {id, duplicado, cerrada}.';

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- 1) Una sola firma (un overload rompería PostgREST con PGRST203):
--    SELECT count(*) FROM pg_proc WHERE proname='admin_close_ci_session';  → 1
--
-- 2) Sigue siendo DEFINER con search_path fijado y anon sin EXECUTE.
--
-- 3) Doble clic no duplica, cierre nuevo sí inserta:
--    ver scripts/simulate-admin-close.sql
--
-- ⚠️ CAMBIO DE TIPO DE RETORNO: de `void` a `jsonb`. Un cliente viejo que
-- ignora el resultado sigue funcionando igual — PostgREST devuelve el valor y
-- el cliente lo descarta. Como los parámetros no cambian, no hay overload.
