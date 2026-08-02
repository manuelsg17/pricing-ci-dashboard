-- ════════════════════════════════════════════════════════════════════════
-- 197_ci_session_close_idempotency.sql — que un reintento de red deje de
-- duplicar la sesión, y que la duración pueda descontar la inactividad.
--
-- Dos partes, las dos sobre la MISMA fila: la que `ci_sessions` escribe
-- cuando el hub aprieta "Terminar".
--
-- ── PARTE 1 · El duplicado por reintento (SESIONES_HALLAZGOS.md P2-11) ──
-- El INSERT a `ci_sessions` no es atómico con `save_ci_batch`. Si el servidor
-- ejecuta el INSERT pero la respuesta se pierde —red caída, timeout del
-- proxy, la pestaña que se duerme— el cliente muestra "no se pudo cerrar la
-- sesión" y le pide al hub que reintente, que es lo correcto: el re-guardado
-- de precios ES idempotente (DELETE+INSERT por ruta exacta). El que no lo es
-- es este INSERT. Quedan DOS filas para el mismo cierre.
--
-- Evidencia real, ya documentada en el código: 2 filas para
-- `Arequipa_Airport_A` / `raisalopez` a 47 segundos de distancia, ambas con
-- 324/324. Y la consulta de diagnóstico de SESIONES_HALLAZGOS.md encuentra
-- el patrón:
--   SELECT city, zone, observed_date, user_email, count(*) FROM ci_sessions
--   GROUP BY 1,2,3,4 HAVING count(*) > 1;
--
-- POR QUÉ NO ES UNA CONSTRAINT ÚNICA
-- Reabrir una sesión cerrada para corregir una celda e insertar una fila
-- nueva es DELIBERADO: es el rastro de revisiones. Un
-- `UNIQUE (city, zone, observed_date, user_email)` mata el duplicado por
-- reintento y también la corrección legítima, en silencio — cambiaría un bug
-- que infla números por uno que pierde datos, que es peor.
--
-- La distinción "reintento del MISMO cierre" vs "cierre NUEVO" no la puede
-- inferir el servidor: dos pedidos idénticos son indistinguibles de un
-- reintento. La sabe el cliente, y la declara con una CLAVE DE IDEMPOTENCIA
-- por intento de cierre (`src/lib/sessionCloseToken.js`): un uuid que se crea
-- al apretar Terminar, se reusa en cada reintento —sobrevive al F5 porque
-- vive en localStorage, CLAUDE.md §2— y se retira recién cuando el servidor
-- confirma. La revisión posterior trae un token nuevo y SÍ inserta.
--
-- ── PARTE 2 · Espacio para la duración sin inactividad (P1-6) ───────────
-- `duration_minutes` mide reloj de pared entre el primer y el último fill de
-- cada turno. La laptop cerrada de 12 a 16 entra entera. Hoy eso lo tapa el
-- techo de 4h por turno (mig 194), que capa pero no mide: 4h por 150 minutos
-- reales sigue siendo el triple, y entra al promedio como dato bueno.
--
-- `src/lib/idleDetection.js` mide lo que falta, a partir de una traza de
-- actividad del propio hub. Estas columnas le hacen lugar. Son ADITIVAS y
-- nullable: un bundle viejo que no las manda sigue funcionando exactamente
-- igual, y `duration_minutes` NO cambia de significado (paso "expandir" de
-- CLAUDE.md §4 — no hay contract pendiente).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PARTE 1 · Clave de idempotencia ───────────────────────────────────
ALTER TABLE public.ci_sessions
  ADD COLUMN IF NOT EXISTS close_token uuid;

COMMENT ON COLUMN public.ci_sessions.close_token IS
  'Clave de idempotencia del INTENTO DE CIERRE, generada por el cliente '
  '(src/lib/sessionCloseToken.js). Igual en todos los reintentos del mismo '
  'cierre; distinta en un cierre nuevo (revisión). NULL en las filas '
  'anteriores a la mig 197 y en las que cierra un admin.';

-- Índice único NO parcial a propósito: en Postgres los NULL son distintos
-- entre sí, así que las filas históricas (y las que escribe
-- `admin_close_ci_session`, que no tiene token) conviven sin restricción
-- alguna. Un índice parcial `WHERE close_token IS NOT NULL` daría lo mismo en
-- semántica pero rompe la inferencia de `ON CONFLICT (close_token)` salvo que
-- el INSERT repita el predicado — y ese detalle se olvida exactamente una vez.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ci_sessions_close_token
  ON public.ci_sessions (close_token);

-- ── PARTE 2 · Duración sin inactividad ────────────────────────────────
ALTER TABLE public.ci_sessions
  ADD COLUMN IF NOT EXISTS active_minutes  numeric,
  ADD COLUMN IF NOT EXISTS idle_minutes    numeric,
  ADD COLUMN IF NOT EXISTS activity_trace  jsonb;

COMMENT ON COLUMN public.ci_sessions.active_minutes IS
  'Minutos de TRABAJO: la ventana de los turnos menos los silencios mayores '
  'al umbral de inactividad (5 min, ver src/lib/idleDetection.js). NULL = no '
  'se pudo medir (no había traza) — nunca 0, que es la mentira que se '
  'promedia. Cuando es NULL, el número a usar sigue siendo duration_minutes.';

COMMENT ON COLUMN public.ci_sessions.idle_minutes IS
  'Minutos descontados por inactividad. Su suma con active_minutes NO tiene '
  'por qué dar duration_minutes: esta última está capada a 4h por turno '
  '(mig 194) y el descuento se calcula sobre la ventana cruda.';

COMMENT ON COLUMN public.ci_sessions.activity_trace IS
  'Traza compacta de actividad: [{"inicio":epoch_ms,"fin":epoch_ms}, …], un '
  'tramo por ráfaga de trabajo (los eventos separados por menos del umbral se '
  'fusionan, así que una jornada entera son decenas de entradas, no miles). '
  'Se guarda para poder RECALIBRAR el umbral sobre datos reales sin haber '
  'perdido el detalle.';

-- ── El cierre idempotente ─────────────────────────────────────────────
-- SECURITY INVOKER a propósito: la política `ci_sessions_insert` ya exige
-- `user_email = auth.email()` (o admin), y es la autoridad correcta. Una
-- función DEFINER acá agregaría superficie de escalación para no ganar nada
-- (CLAUDE.md §3).
--
-- La firma es (uuid, jsonb) y se quiere ESTABLE: agregar una columna a
-- ci_sessions mañana no debe cambiar la firma, porque `CREATE OR REPLACE` con
-- parámetros distintos NO reemplaza, crea un OVERLOAD que PostgREST no puede
-- resolver (PGRST203) y rompe en silencio a cualquier cliente con bundle
-- viejo en caché — el problema exacto que documenta CLAUDE.md §3.
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
BEGIN
  -- Sin token no hay idempotencia posible: los NULL son distintos entre sí y
  -- el ON CONFLICT no dispararía nunca. Se rechaza en vez de insertar una
  -- fila que el próximo reintento duplicaría igual — un error ruidoso es
  -- mucho más barato que el duplicado silencioso que esto vino a matar.
  IF p_close_token IS NULL THEN
    RAISE EXCEPTION 'close_ci_session: falta close_token (clave de idempotencia)'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  INSERT INTO ci_sessions (
    country, city, zone, observed_date, user_email,
    started_at, ended_at,
    duration_minutes, duration_confiable, duration_motivo,
    rows_saved, total_expected, turno_timings,
    active_minutes, idle_minutes, activity_trace,
    close_token
  )
  VALUES (
    p_session->>'country',
    p_session->>'city',
    NULLIF(p_session->>'zone', ''),
    (p_session->>'observed_date')::date,
    -- Se cae a auth.email() si el cliente no lo manda. La política RLS es la
    -- que decide igual: un hub no puede escribir la sesión de otro.
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
    -- El cierre ya estaba registrado: es el reintento cuya primera respuesta
    -- se perdió. No se toca la fila existente — se responde OK con el id que
    -- ya tenía, que es lo que el cliente necesita para seguir adelante y
    -- limpiar el borrador.
    v_dup := true;
    SELECT id INTO v_id FROM ci_sessions WHERE close_token = p_close_token;

    -- El SELECT de arriba pasa por RLS: si no devuelve nada, el token existe
    -- pero es de OTRO usuario. Con uuid v4 esto no puede pasar por azar, así
    -- que significa un token reusado a mano o un bug — y tragárselo sería
    -- perder un cierre real en silencio.
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
  'inserta dos veces (devuelve duplicado=true con el id ya existente); un '
  'token nuevo SÍ inserta, que es como se conserva el rastro de revisiones. '
  'SECURITY INVOKER: la política ci_sessions_insert sigue siendo la autoridad.';

-- Higiene de permisos (CLAUDE.md §3): `anon` no cierra sesiones.
REVOKE ALL ON FUNCTION public.close_ci_session(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_ci_session(uuid, jsonb) TO authenticated;

-- ── PARTE 3 · Un bug que este trabajo destapó, no que introdujo ───────
-- El trigger `ci_close_fill_quality` (mig 195) es SECURITY INVOKER y llama a
-- `ci_duration_quality_from_timings` → `ci_ts_or_null`, dos funciones a las
-- que la mig 194 le REVOCÓ el EXECUTE a `authenticated` (a propósito: no
-- tienen por qué quedar expuestas como RPC de PostgREST).
--
-- Resultado: cualquier INSERT a ci_sessions hecho por un hub que traiga
-- `turno_timings` y NO traiga `duration_confiable` muere con
--
--     42501 · permission denied for function ci_ts_or_null
--
-- y el hub NO PUEDE TERMINAR LA SESIÓN. Hoy no se nota porque el cliente
-- actual siempre manda `duration_confiable` y el trigger corta antes de
-- llamar nada. Se nota en el único momento en que importa: la ventana entre
-- aplicar las migraciones y publicar el bundle nuevo (DESPLIEGUE_PENDIENTE.md
-- pide ese orden), en la que todo hub con la pestaña abierta desde antes
-- corre el bundle VIEJO — que manda turno_timings sin duration_confiable.
-- Es exactamente el "cliente con el bundle viejo todavía cargado" de
-- CLAUDE.md §4, con pérdida de la sesión entera.
--
-- Se descubrió llamando a la RPC nueva por HTTP real contra PostgREST; la
-- simulación SQL no lo veía porque su payload sí mandaba duration_confiable.
--
-- El fix es del trigger, no de los permisos: SECURITY DEFINER acá no abre
-- nada —la función no consulta tablas, solo completa dos columnas de NEW y ya
-- fija search_path— mientras que dar EXECUTE de los helpers a `authenticated`
-- desharía la decisión deliberada de la mig 194 y los publicaría como RPC.
CREATE OR REPLACE FUNCTION public.ci_close_fill_quality()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.duration_confiable IS NULL THEN
    NEW.duration_motivo :=
      ci_duration_quality_from_timings(NEW.turno_timings, NEW.ended_at);
    NEW.duration_confiable := (NEW.duration_motivo IS NULL);
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.ci_close_fill_quality() IS
  'Completa duration_confiable/duration_motivo cuando el que inserta no los '
  'manda. SECURITY DEFINER porque los helpers de la mig 194 no tienen EXECUTE '
  'para authenticated y sin eso un cliente con bundle viejo no puede cerrar '
  'su sesión (42501). No consulta ninguna tabla y fija search_path.';

-- Ahora que corre con privilegios del dueño, el EXECUTE que Postgres le da a
-- PUBLIC por defecto sobra. Postgres no re-chequea ese privilegio al disparar
-- el trigger (verificado en local: el INSERT como `authenticated` sigue
-- completando las columnas después del REVOKE), así que sacarlo no cuesta
-- nada y cierra la superficie — CLAUDE.md §3: verificar, no asumir.
REVOKE ALL ON FUNCTION public.ci_close_fill_quality() FROM PUBLIC, anon, authenticated;

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- Automatizada:  npm run simulate:session-idempotency
--
-- A mano, contra local:
-- 1) El índice existe y es único:
--    \d public.ci_sessions
--
-- 2) El reintento no duplica y el cierre nuevo sí inserta (la simulación lo
--    hace con RLS real y con dos hubs distintos a la vez).
--
-- 3) Duplicados históricos que este cambio NO borra —son datos, no basura, y
--    borrar filas de producción necesita autorización explícita (CLAUDE.md §8):
--    SELECT city, zone, observed_date, user_email, count(*)
--      FROM ci_sessions GROUP BY 1,2,3,4 HAVING count(*) > 1;
--    El impacto en la métrica ya está contenido: `ci_hub_daily_minutes`
--    (mig 195) une los tramos en vez de sumar duraciones.
--
-- ── PENDIENTE, declarado ──────────────────────────────────────────────
-- · `admin_close_ci_session` sigue insertando sin token: un doble click del
--   admin todavía puede duplicar. No se le puede poner un token determinístico
--   derivado de (usuario, ciudad, zona, fecha, started_at) porque una revisión
--   legítima conserva el mismo `startedAt` —turno_timings no se sobreescribe
--   nunca— y quedaría descartada en silencio, que es justo lo que esta
--   migración evita. Necesita su propio diseño.
-- · `active_minutes` queda NULL en las filas que cierra un admin hasta que el
--   latido de `ci_active_sessions` transporte la traza de actividad.
