-- ════════════════════════════════════════════════════════════════════════
-- 185_client_error_log.sql — bitácora de errores del cliente.
--
-- PROBLEMA QUE RESUELVE
-- Hasta hoy, si un hub en Arequipa ve una pantalla en blanco un martes,
-- NADIE se entera nunca. Los ErrorBoundary evitan que la app entera se caiga
-- —bien— pero el error muere en la consola del navegador del hub, que nadie
-- va a abrir. Y el fallo silencioso es la firma de este proyecto: el
-- `ci_sessions` que fallaba sin avisar, el dashboard que mentía sin dar error.
--
-- DECISIÓN: tabla propia, no servicio externo (decisión del user 2026-08-01).
-- Cero dependencias nuevas y los mensajes de error —que traen emails de hubs
-- y datos de la app— no salen de la infraestructura propia.
--
-- ANTI-INUNDACIÓN, el punto delicado del archivo
-- Un componente que crashea en loop de render puede intentar escribir miles
-- de filas en segundos. Por eso NO se expone un INSERT directo: se escribe
-- por `log_client_error()`, que colapsa las repeticiones del mismo error en
-- UNA fila con contador (`hits`) mientras siga dentro de la ventana de 1h.
-- Una tormenta de 5.000 errores idénticos = 1 fila con hits=5000.
-- El cliente además dedupe y se autolimita (ver src/lib/errorLog.js).
--
-- SEGURIDAD
--   · El email NUNCA viene del cliente: lo pone la función desde auth.email().
--     Si viniera por parámetro, cualquiera podría atribuirle errores a otro.
--   · SELECT solo admin: un error puede traer datos de cualquier país.
--   · Sin UPDATE ni DELETE para nadie — es bitácora, mismo criterio que
--     task_comments (mig 183) y audit_log.
--   · Solo `authenticated`. Se pierden los errores de la pantalla de login,
--     que es un costo aceptado a cambio de no dejar un INSERT abierto a
--     `anon` — sería un vector de inundación trivial desde fuera.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public.client_errors (
  id              bigserial PRIMARY KEY,
  fingerprint     text NOT NULL,        -- agrupa repeticiones del mismo error
  user_email      text NOT NULL,        -- lo pone la función, no el cliente
  country         text,
  route           text,                 -- en qué pantalla pasó
  source          text NOT NULL,        -- boundary | section | window | promise
  label           text,                 -- qué sección, si aplica
  message         text NOT NULL,
  stack           text,
  component_stack text,
  app_mode        text,                 -- production | development
  user_agent      text,
  hits            int  NOT NULL DEFAULT 1,
  first_seen      timestamptz NOT NULL DEFAULT now(),
  last_seen       timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,          -- lo marca el admin vía RPC
  CONSTRAINT client_errors_source_chk
    CHECK (source IN ('boundary', 'section', 'window', 'promise', 'manual')),
  CONSTRAINT client_errors_message_chk CHECK (btrim(message) <> '')
);

-- La consulta del panel es "sin resolver, más recientes primero".
CREATE INDEX IF NOT EXISTS idx_client_errors_open
  ON public.client_errors(last_seen DESC) WHERE resolved_at IS NULL;

-- Sostiene el UPDATE de colapso de la función de abajo.
CREATE INDEX IF NOT EXISTS idx_client_errors_dedupe
  ON public.client_errors(fingerprint, user_email, last_seen DESC);

COMMENT ON TABLE public.client_errors IS
  'Bitácora de errores del cliente (mig 185). Se escribe SOLO vía '
  'log_client_error(); las repeticiones se colapsan en una fila con `hits`.';

-- ── RLS ───────────────────────────────────────────────────────────────
ALTER TABLE public.client_errors ENABLE ROW LEVEL SECURITY;

-- Sin política de INSERT a propósito: nadie inserta directo, ni el admin.
-- El único camino de escritura es log_client_error() (SECURITY DEFINER).
DROP POLICY IF EXISTS client_errors_select_admin ON public.client_errors;
CREATE POLICY client_errors_select_admin ON public.client_errors
  FOR SELECT TO authenticated
  USING (is_admin());

REVOKE ALL ON public.client_errors FROM anon;
GRANT SELECT ON public.client_errors TO authenticated;

-- ── log_client_error() ────────────────────────────────────────────────
-- SECURITY DEFINER porque la tabla no tiene política de INSERT: es la única
-- puerta de escritura, y así puede imponer el email real y el colapso por
-- fingerprint sin depender de que el cliente coopere.
CREATE OR REPLACE FUNCTION public.log_client_error(
  p_fingerprint     text,
  p_source          text,
  p_message         text,
  p_route           text DEFAULT NULL,
  p_label           text DEFAULT NULL,
  p_stack           text DEFAULT NULL,
  p_component_stack text DEFAULT NULL,
  p_country         text DEFAULT NULL,
  p_app_mode        text DEFAULT NULL,
  p_user_agent      text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_email text := (select auth.email());
  v_id    bigint;
BEGIN
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'log_client_error requiere sesión autenticada';
  END IF;

  IF p_source NOT IN ('boundary', 'section', 'window', 'promise', 'manual') THEN
    RAISE EXCEPTION 'source inválido: %', p_source;
  END IF;

  IF btrim(coalesce(p_message, '')) = '' THEN
    RAISE EXCEPTION 'message vacío';
  END IF;

  -- Colapso: si el MISMO error del MISMO usuario ya se registró en la última
  -- hora, se suma al contador en vez de crear una fila nueva. Sin esto, un
  -- crash en loop de render llena la tabla en segundos.
  UPDATE public.client_errors
     SET hits      = hits + 1,
         last_seen = now()
   WHERE fingerprint = p_fingerprint
     AND user_email  = v_email
     AND resolved_at IS NULL
     AND last_seen   > now() - interval '1 hour'
   RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  -- Truncado defensivo: un stack de React puede ser enorme y no aporta nada
  -- después de los primeros frames.
  INSERT INTO public.client_errors (
    fingerprint, user_email, country, route, source, label,
    message, stack, component_stack, app_mode, user_agent
  ) VALUES (
    left(p_fingerprint, 64),
    v_email,
    left(p_country, 64),
    left(p_route, 200),
    p_source,
    left(p_label, 120),
    left(p_message, 2000),
    left(p_stack, 4000),
    left(p_component_stack, 4000),
    left(p_app_mode, 20),
    left(p_user_agent, 300)
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.log_client_error(text, text, text, text, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_client_error(text, text, text, text, text, text, text, text, text, text) TO authenticated;

COMMENT ON FUNCTION public.log_client_error(text, text, text, text, text, text, text, text, text, text) IS
  'Única puerta de escritura de client_errors. Impone el email real desde '
  'auth.email() y colapsa repeticiones del mismo fingerprint dentro de 1h.';

-- ── resolve_client_error() — solo admin ───────────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_client_error(p_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Solo un administrador puede marcar errores como resueltos';
  END IF;

  UPDATE public.client_errors
     SET resolved_at = now()
   WHERE id = p_id AND resolved_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_client_error(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_client_error(bigint) TO authenticated;

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- 1) RLS activo y sin política de INSERT (la escritura es solo por RPC):
--    SELECT relrowsecurity FROM pg_class WHERE relname = 'client_errors';
--    SELECT cmd, policyname FROM pg_policies WHERE tablename = 'client_errors';
--    → esperado: rowsecurity=true, y una sola política, de SELECT.
--
-- 2) `anon` sin permisos (information_schema NO alcanza — usar relacl):
--    SELECT relacl FROM pg_class WHERE relname = 'client_errors';
--    → no debe aparecer `anon=`.
--
-- 3) search_path fijado en las dos funciones:
--    SELECT proname, proconfig FROM pg_proc
--     WHERE proname IN ('log_client_error', 'resolve_client_error');
--    → esperado: {"search_path=public, pg_temp"} en ambas.
--
-- 4) El colapso funciona (dos llamadas iguales = una fila con hits=2):
--    SELECT log_client_error('fp-test', 'manual', 'prueba');
--    SELECT log_client_error('fp-test', 'manual', 'prueba');
--    SELECT hits FROM client_errors WHERE fingerprint = 'fp-test';  → 2
--    DELETE FROM client_errors WHERE fingerprint = 'fp-test';
