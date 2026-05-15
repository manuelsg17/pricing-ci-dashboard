-- ════════════════════════════════════════════════════════════════════════
-- Migración 62 — audit_log + triggers genéricos
--
-- POR QUÉ:
--   Hoy no hay rastro de QUIÉN tocó QUÉ y CUÁNDO. Si dos sesiones tocan
--   la misma config (escenario común con cuentas compartidas) y algo se
--   rompe, no hay forma de bisectar el cambio.
--
-- DISEÑO:
--   1. Tabla audit_log con: user_email, action, table_name, row_id (text
--      porque diferentes tablas tienen distinto tipo de PK), old_data,
--      new_data, session_id, user_agent, country, ts.
--   2. Trigger genérico `log_changes()` AFTER INSERT/UPDATE/DELETE que
--      escribe a audit_log. Se aplica a las tablas sensibles.
--   3. Solo writes (INSERT/UPDATE/DELETE), NUNCA SELECT — sería ruido
--      enorme y no aporta valor de seguridad.
--   4. RLS: solo is_admin() puede SELECT. Nadie puede INSERT/UPDATE/
--      DELETE manualmente (solo el trigger del system).
--
-- COLUMNAS session_id + user_agent:
--   Cuando una cuenta es compartida (mismo email en varios browsers),
--   estas columnas distinguen sesiones. session_id viene de un header
--   custom (x-session-id) que el cliente JS genera al login. user_agent
--   viene del header HTTP estándar.
--
-- TAMAÑO:
--   ~21 tablas × ~5 writes/día por tabla × 30 días = ~3K filas/mes.
--   jsonb con old/new puede crecer. Retención: 90 días (limpieza vía
--   pg_cron en migración 39 — agregar acá).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A. Tabla audit_log ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_log (
  id           bigserial PRIMARY KEY,
  ts           timestamptz NOT NULL DEFAULT now(),
  user_email   text,            -- auth.email() del caller (NULL si bot/service-role)
  action       text NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  table_name   text NOT NULL,
  row_id       text,            -- PK serializada como text (cross-table)
  old_data     jsonb,           -- antes del cambio (NULL en INSERT)
  new_data     jsonb,           -- después del cambio (NULL en DELETE)
  country      text,            -- copy de NEW.country si existe (para filtrar UI)
  session_id   text,            -- header x-session-id del cliente
  user_agent   text             -- User-Agent del navegador
);

CREATE INDEX IF NOT EXISTS idx_audit_log_ts          ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_table       ON audit_log(table_name, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user        ON audit_log(user_email, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_country     ON audit_log(country, ts DESC)
  WHERE country IS NOT NULL;

COMMENT ON TABLE  audit_log              IS 'Bitácora de writes en tablas sensibles. Lectura admin-only.';
COMMENT ON COLUMN audit_log.row_id       IS 'PK serializada como text para soportar cualquier tipo (bigint, uuid, etc.).';
COMMENT ON COLUMN audit_log.session_id   IS 'Header x-session-id del cliente — distingue sesiones cuando un email es compartido.';
COMMENT ON COLUMN audit_log.user_agent   IS 'User-Agent HTTP — diferencia browsers/dispositivos.';


-- ── B. RLS: solo admin lee. Nadie escribe directamente (triggers sí). ──

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_select ON audit_log;
CREATE POLICY audit_log_select ON audit_log
  FOR SELECT TO authenticated USING (is_admin());

-- No CREATE POLICY for INSERT/UPDATE/DELETE → blocked for everyone via RLS.
-- Los triggers escriben con SECURITY DEFINER, bypaseando RLS.


-- ── C. Trigger genérico log_changes() ──────────────────────────────────

CREATE OR REPLACE FUNCTION log_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_email   text;
  v_session_id   text;
  v_user_agent   text;
  v_country      text;
  v_row_id       text;
  v_old          jsonb;
  v_new          jsonb;
BEGIN
  -- auth.email() puede ser NULL si el caller es el bot / service-role
  BEGIN
    v_user_email := auth.email();
  EXCEPTION WHEN OTHERS THEN
    v_user_email := NULL;
  END;

  -- Headers custom del cliente (set via PostgREST middleware o JS).
  -- current_setting con missing_ok=true devuelve '' si no existe.
  v_session_id := current_setting('request.headers.x-session-id', true);
  IF v_session_id = '' THEN v_session_id := NULL; END IF;

  -- user_agent del header HTTP estándar
  BEGIN
    v_user_agent := current_setting('request.headers', true)::jsonb->>'user-agent';
  EXCEPTION WHEN OTHERS THEN
    v_user_agent := NULL;
  END;

  -- Capturar old/new como jsonb (TG_OP determina cuál existe)
  IF TG_OP = 'DELETE' THEN
    v_old := to_jsonb(OLD);
    v_new := NULL;
    v_row_id := COALESCE(v_old->>'id', v_old->>'country_key', v_old::text);
    v_country := v_old->>'country';
  ELSIF TG_OP = 'INSERT' THEN
    v_old := NULL;
    v_new := to_jsonb(NEW);
    v_row_id := COALESCE(v_new->>'id', v_new->>'country_key', v_new::text);
    v_country := v_new->>'country';
  ELSE  -- UPDATE
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    v_row_id := COALESCE(v_new->>'id', v_new->>'country_key', v_new::text);
    v_country := v_new->>'country';
  END IF;

  -- No-op si UPDATE no cambia nada real (defensive)
  IF TG_OP = 'UPDATE' AND v_old = v_new THEN
    RETURN NULL;
  END IF;

  INSERT INTO audit_log (
    user_email, action, table_name, row_id,
    old_data, new_data, country, session_id, user_agent
  ) VALUES (
    v_user_email, TG_OP, TG_TABLE_NAME, v_row_id,
    v_old, v_new, v_country, v_session_id, v_user_agent
  );

  RETURN NULL;  -- AFTER trigger, no propaga retorno
END;
$$;

GRANT EXECUTE ON FUNCTION log_changes() TO authenticated;


-- ── D. Aplicar trigger a tablas sensibles ──────────────────────────────

DO $migration$
DECLARE
  t text;
  audited_tables text[] := ARRAY[
    'country_config',
    'catalog_extras',
    'bot_rules',
    'distance_thresholds',
    'bracket_weights',
    'bracket_weights_by_category',
    'semaforo_config',
    'rush_hour_windows',
    'price_validation_rules',
    'indrive_config',
    'distance_references',
    'ci_timeslots',
    'competitor_commissions',
    'competitor_bonuses',
    'market_events',
    'user_profiles',
    'roles'
  ];
BEGIN
  FOREACH t IN ARRAY audited_tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      -- Drop si ya existe (idempotente)
      EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_%I ON public.%I', t, t);
      -- AFTER trigger (no afecta la fila escrita)
      EXECUTE format(
        'CREATE TRIGGER trg_audit_%I
         AFTER INSERT OR UPDATE OR DELETE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION log_changes()',
        t, t
      );
      RAISE NOTICE 'Audit trigger attached: %', t;
    ELSE
      RAISE NOTICE 'Skip (tabla no existe): %', t;
    END IF;
  END LOOP;
END
$migration$;


-- ── E. Retención: limpiar logs > 90 días via pg_cron (si está activo) ──
--
-- Si pg_cron no está instalado, este step es no-op silencioso. La UI
-- también ofrecerá un botón manual "Limpiar logs > 90 días" para admin.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Reemplaza job previo si existía
    PERFORM cron.unschedule('audit_log_retention') WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'audit_log_retention'
    );
    PERFORM cron.schedule(
      'audit_log_retention',
      '0 4 * * *',  -- 04:00 UTC todos los días
      $clean$DELETE FROM audit_log WHERE ts < now() - interval '90 days'$clean$
    );
    RAISE NOTICE 'pg_cron audit_log_retention scheduled.';
  ELSE
    RAISE NOTICE 'pg_cron no instalado, limpieza manual desde UI.';
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Cron scheduling skipped: %', SQLERRM;
END
$$;


-- ── F. RPC helper para UI: list_audit_log con filtros ──────────────────
--
-- Devuelve filas paginadas. RLS aplica → solo admins ven datos.

CREATE OR REPLACE FUNCTION list_audit_log(
  p_table     text DEFAULT NULL,
  p_user      text DEFAULT NULL,
  p_country   text DEFAULT NULL,
  p_action    text DEFAULT NULL,
  p_since     timestamptz DEFAULT NULL,
  p_limit     int  DEFAULT 100,
  p_offset    int  DEFAULT 0
)
RETURNS TABLE (
  id           bigint,
  ts           timestamptz,
  user_email   text,
  action       text,
  table_name   text,
  row_id       text,
  old_data     jsonb,
  new_data     jsonb,
  country      text,
  session_id   text,
  user_agent   text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '15s'
AS $$
  SELECT id, ts, user_email, action, table_name, row_id,
         old_data, new_data, country, session_id, user_agent
  FROM audit_log
  WHERE
        is_admin()
    AND (p_table   IS NULL OR table_name = p_table)
    AND (p_user    IS NULL OR user_email = p_user)
    AND (p_country IS NULL OR country    = p_country)
    AND (p_action  IS NULL OR action     = p_action)
    AND (p_since   IS NULL OR ts        >= p_since)
  ORDER BY ts DESC
  LIMIT  GREATEST(1, LEAST(p_limit, 500))
  OFFSET GREATEST(0, p_offset);
$$;

GRANT EXECUTE ON FUNCTION list_audit_log(text, text, text, text, timestamptz, int, int) TO authenticated;


COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN POST-APLICACIÓN
--
-- 1. Como admin, hacer un cambio dummy:
--      UPDATE country_config SET label = label WHERE country_key = 'Peru';
--
-- 2. Ver el log:
--      SELECT * FROM list_audit_log(p_table => 'country_config', p_limit => 5);
--      → debería mostrar tu cambio con tu email + ts reciente.
--
-- 3. Como viewer non-admin:
--      SELECT * FROM list_audit_log();  -- debe devolver 0 filas (RLS aplica)
--      SELECT * FROM audit_log LIMIT 1; -- error de policy
-- ════════════════════════════════════════════════════════════════════════
