-- ════════════════════════════════════════════════════════════════════════
-- Migración 233 — Disparador de RESPALDO del bot sync desde pg_cron
--
-- PROBLEMA (revisión de arquitectura 2026-09-03, Fase 2b):
--   El único disparador automático del sync es el `schedule: */20` de
--   GitHub Actions, y GitHub no garantiza los crons: el 2026-09-02/03 el
--   dashboard estuvo 5-13 h sin datos nuevos y el motivo fue mitad helioho
--   caído y mitad crons de GitHub que directamente no corrieron. No hay
--   forma de "arreglar" eso desde el repo.
--
-- SOLUCIÓN:
--   pg_cron (que sí es confiable: refresca los agregados cada hora hace
--   meses) llama por pg_net a la Edge Function `trigger-bot-sync`, que ya
--   sabe disparar el workflow (tiene el GITHUB_PAT como secret). Es un
--   RESPALDO: `cron_trigger_bot_sync()` solo dispara si en `bot_sync_log`
--   no hay NINGUNA corrida en los últimos 20 min — cuando el cron de
--   GitHub cumple, esto no gasta un minuto de Actions.
--
-- AUTENTICACIÓN (sin CLI, sin secrets del Dashboard):
--   La Edge Function exige un JWT de admin. pg_cron no tiene uno, así que
--   se agrega un segundo camino: header `x-cron-secret`. El valor se
--   genera ACÁ, dentro de Vault, y la Edge Function lo valida llamando a
--   `cron_trigger_secret_matches()` (SECURITY DEFINER, solo service_role)
--   — el secreto nunca sale de la base ni entra al repo. Local genera el
--   suyo propio; como local no tiene la URL en Vault, la función no
--   dispara nada (esperado).
--
-- PASO MANUAL EN PROD (una sola vez, documentado abajo en §4): cargar en
-- Vault `trigger_bot_sync_url` y `supabase_anon_key`. La anon key es
-- pública (va en el bundle), pero no se hardcodea en una migración que
-- también corre en local.
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1. pg_net ────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ── 2. Secreto compartido en Vault (idempotente) ─────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cron_trigger_secret') THEN
    PERFORM vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'cron_trigger_secret',
      'Secreto compartido pg_cron -> Edge Function trigger-bot-sync (mig 233). Rotar: vault.update_secret.'
    );
  END IF;
END $$;

-- ── 3. Validación del secreto (la llama la Edge Function con service_role)
CREATE OR REPLACE FUNCTION public.cron_trigger_secret_matches(p_secret text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets
    WHERE name = 'cron_trigger_secret'
      AND length(coalesce(p_secret, '')) >= 32
      AND decrypted_secret = p_secret
  );
$$;
REVOKE ALL ON FUNCTION public.cron_trigger_secret_matches(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_trigger_secret_matches(text) TO service_role;
COMMENT ON FUNCTION public.cron_trigger_secret_matches(text) IS
  'mig 233: compara el header x-cron-secret contra Vault. Solo service_role (Edge Function).';

-- ── 4. El disparador de respaldo ─────────────────────────────────────────
-- Prod necesita, una sola vez (ejecutar como postgres, NO va en el repo):
--   SELECT vault.create_secret('https://<ref>.supabase.co/functions/v1/trigger-bot-sync',
--                              'trigger_bot_sync_url', 'mig 233');
--   SELECT vault.create_secret('<anon key>', 'supabase_anon_key', 'mig 233 (clave pública)');
CREATE OR REPLACE FUNCTION public.cron_trigger_bot_sync()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_url    text;
  v_anon   text;
  v_secret text;
  v_last   timestamptz;
  v_req    bigint;
BEGIN
  SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'trigger_bot_sync_url';
  SELECT decrypted_secret INTO v_anon   FROM vault.decrypted_secrets WHERE name = 'supabase_anon_key';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'cron_trigger_secret';

  IF v_url IS NULL OR v_anon IS NULL OR v_secret IS NULL THEN
    RETURN jsonb_build_object('fired', false, 'reason', 'vault_incomplete',
                              'missing', jsonb_build_array(
                                CASE WHEN v_url    IS NULL THEN 'trigger_bot_sync_url' END,
                                CASE WHEN v_anon   IS NULL THEN 'supabase_anon_key'    END,
                                CASE WHEN v_secret IS NULL THEN 'cron_trigger_secret'  END));
  END IF;

  -- Respaldo, no duplicado: si GitHub ya corrió (cualquier status, incluso
  -- 'running' o 'error' — significa que el cron de GitHub SÍ despertó), no
  -- disparamos. 20 min = un ciclo del `*/20` de GitHub.
  SELECT max(started_at) INTO v_last FROM public.bot_sync_log;
  IF v_last IS NOT NULL AND v_last > now() - interval '20 minutes' THEN
    RETURN jsonb_build_object('fired', false, 'reason', 'recent_run', 'last_started_at', v_last);
  END IF;

  SELECT net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'apikey',        v_anon,
      'Authorization', 'Bearer ' || v_anon,
      'x-cron-secret', v_secret),
    body    := jsonb_build_object('limit', 20000, 'source', 'pg_cron'),
    timeout_milliseconds := 15000
  ) INTO v_req;

  RETURN jsonb_build_object('fired', true, 'request_id', v_req, 'last_started_at', v_last);
END;
$$;
REVOKE ALL ON FUNCTION public.cron_trigger_bot_sync() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.cron_trigger_bot_sync() IS
  'mig 233: respaldo del cron de GitHub. Dispara trigger-bot-sync vía pg_net solo si no hubo corrida en 20 min. Resultado en net._http_response.';

-- ── 5. Cron: minutos 10/30/50, desfasado del */20 de GitHub (00/20/40) ──
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'trigger-bot-sync-fallback';
SELECT cron.schedule(
  'trigger-bot-sync-fallback',
  '10,30,50 * * * *',
  $$SELECT public.cron_trigger_bot_sync()$$
);

COMMIT;

-- ── Verificación (prod, después de cargar los 2 secretos de Vault) ───────
--   SELECT public.cron_trigger_bot_sync();          -- fired=true, request_id=N
--   SELECT status_code, left(content,120) FROM net._http_response
--    WHERE id = N;                                    -- 200 {"ok":true,"caller":"pg_cron"...}
--   SELECT * FROM cron.job_run_details WHERE jobid = (SELECT jobid FROM cron.job
--    WHERE jobname='trigger-bot-sync-fallback') ORDER BY start_time DESC LIMIT 3;
