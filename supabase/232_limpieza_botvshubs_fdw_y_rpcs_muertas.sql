-- ════════════════════════════════════════════════════════════════════════
-- Migración 232 — Limpieza de objetos muertos (Fase 1 de la revisión de
-- arquitectura, 2026-09-03). Cuatro grupos, todos con evidencia medida:
--
-- 1. FEATURE "BOT VS HUBS" COMPLETA (decisión del user: "no la uso, ya no
--    tomo data manual"). Se va la MV v_bot_vs_manual_mv, su cron y su RPC.
--    Medido en prod (pg_stat_statements, 37 días): el REFRESH horario de
--    esa MV de 144 kB leía 30 M de bloques — 2.º mayor consumidor de disco
--    de toda la base — porque su definición escaneaba pricing_observations
--    ENTERA (sin filtro de fecha) 17 veces por día. El frontend se borra en
--    el mismo commit (página, ruta, nav, sección, i18n).
--
-- 2. RPCs DEL DASHBOARD SIN SUFIJO _fast (mig 103). Superadas por las _fast
--    (mig 105) que leen los agregados. Verificado por grep: ningún archivo
--    de src/ las llama. Mismo criterio que la mig 200 con _with_freeze:
--    una RPC viva sin caller es superficie de ataque gratis.
--
-- 3. FDW A HELIOHO (bot_quotes_remote + servidor + 3 user mappings) Y LAS 5
--    FUNCIONES QUE DEPENDEN DE ELLA. Está muerta: helioho bloquea las IPs
--    de Supabase (verificado en migs 227/230 — `SELECT 1 ... LIMIT 1`
--    cuelga 75 s). La ingesta real es scripts/bot-sync/bot_sync_push.py
--    vía GitHub Actions desde la mig 39 en adelante. Además es higiene de
--    seguridad: dejaba un user mapping con credencial remota asociado al
--    rol `authenticated` (el de los clientes). sync_bot_quotes /
--    probe_bot_quotes / validate_fdw_schema / diagnose_bot_rules_coverage
--    solo aparecen en src/ como comentarios (verificado).
--    La Edge Function dormida sync-bot-quotes (que llamaba a
--    sync_bot_quotes) se borra del repo en este commit. trigger-bot-sync
--    SE CONSERVA: no usa la FDW y sí la usa BotDbSync.jsx.
--
-- 4. TABLAS DE RESPALDO de las limpiezas TukTuk (jul/ago 2026, ~20 MB).
--    Cumplieron su función (las migs 220/221 verificaron conteos y
--    equivalencia); el user autorizó su borrado en esta revisión.
--
-- ROLLBACK: no aplica como "deshacer" — son objetos muertos. Si hiciera
-- falta la feature Bot vs Hubs de nuevo, se reconstruye desde mig 108 con
-- un filtro de fecha (nunca escaneo completo).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Bot vs Hubs ───────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM cron.unschedule('refresh-mv-botvsmanual');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'cron refresh-mv-botvsmanual no existía en este entorno, sigo';
END $$;

DROP FUNCTION IF EXISTS public.get_bot_vs_hubs_summary(text);
DROP MATERIALIZED VIEW IF EXISTS public.v_bot_vs_manual_mv;

-- La sección deja de existir en la app: se saca del rol que la tenía para
-- que Accesos no muestre un permiso fantasma. Guardado con COALESCE por si
-- el array quedara vacío.
UPDATE public.roles
   SET permissions = jsonb_set(
         permissions, '{sections}',
         COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(permissions->'sections') e
                   WHERE e <> to_jsonb('botvshubs'::text)), '[]'::jsonb))
 WHERE permissions->'sections' ? 'botvshubs';

DELETE FROM public.section_write_grants WHERE section = 'botvshubs';

-- ── 2. RPCs sin _fast ────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_dashboard_data_weekly(
  text, text, text, text, boolean, integer, integer, integer, integer, text, text[]);
DROP FUNCTION IF EXISTS public.get_dashboard_data_daily(
  text, text, text, text, boolean, date, date, text, text[]);

-- ── 3. FDW y dependientes ────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.sync_bot_quotes(text, integer);
DROP FUNCTION IF EXISTS public.probe_bot_quotes();
DROP FUNCTION IF EXISTS public.validate_fdw_schema();
DROP FUNCTION IF EXISTS public.diagnose_bot_rules_coverage(text, integer);
-- En prod es una FOREIGN TABLE (relkind 'f'); en local es un stub de tabla
-- común porque el FDW no se configura en desarrollo. DROP FOREIGN TABLE
-- sobre una tabla común revienta ("is not a foreign table"), así que se
-- resuelve por relkind — cazado en la validación local de esta migración.
DO $$
DECLARE v_kind "char";
BEGIN
  SELECT c.relkind INTO v_kind
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'bot_quotes_remote';
  IF v_kind = 'f' THEN
    EXECUTE 'DROP FOREIGN TABLE public.bot_quotes_remote';
  ELSIF v_kind = 'r' THEN
    EXECUTE 'DROP TABLE public.bot_quotes_remote';
  ELSIF v_kind = 'v' THEN
    EXECUTE 'DROP VIEW public.bot_quotes_remote';
  ELSIF v_kind IS NOT NULL THEN
    RAISE EXCEPTION 'bot_quotes_remote tiene relkind inesperado: %', v_kind;
  END IF;
END $$;
-- CASCADE se lleva los 3 user mappings (postgres/authenticated/service_role).
DROP SERVER IF EXISTS bot_db_server CASCADE;

-- ── 4. Respaldos TukTuk ──────────────────────────────────────────────────
DROP TABLE IF EXISTS public.pricing_observations_backup_tuktuk_taxi_20260827;
DROP TABLE IF EXISTS public.pricing_observations_backup_tuktuk_bot_20260714;
DROP TABLE IF EXISTS public.pricing_observations_backup_tuktuk_bot_20260720;
DROP TABLE IF EXISTS public.pricing_observations_backup_tuktuk_bot_all_20260720;

-- ── Verificación ─────────────────────────────────────────────────────────
DO $$
DECLARE v_restos int;
BEGIN
  SELECT count(*) INTO v_restos FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN (
    'v_bot_vs_manual_mv','bot_quotes_remote',
    'pricing_observations_backup_tuktuk_taxi_20260827',
    'pricing_observations_backup_tuktuk_bot_20260714',
    'pricing_observations_backup_tuktuk_bot_20260720',
    'pricing_observations_backup_tuktuk_bot_all_20260720');
  IF v_restos > 0 THEN RAISE EXCEPTION 'mig 232 ABORTADA: quedan % objetos', v_restos; END IF;

  SELECT count(*) INTO v_restos FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN (
    'get_bot_vs_hubs_summary','get_dashboard_data_weekly','get_dashboard_data_daily',
    'sync_bot_quotes','probe_bot_quotes','validate_fdw_schema','diagnose_bot_rules_coverage');
  IF v_restos > 0 THEN RAISE EXCEPTION 'mig 232 ABORTADA: quedan % funciones', v_restos; END IF;

  SELECT count(*) INTO v_restos FROM pg_foreign_server WHERE srvname='bot_db_server';
  IF v_restos > 0 THEN RAISE EXCEPTION 'mig 232 ABORTADA: el server FDW sigue vivo'; END IF;

  SELECT count(*) INTO v_restos FROM public.roles WHERE permissions->'sections' ? 'botvshubs';
  IF v_restos > 0 THEN RAISE EXCEPTION 'mig 232 ABORTADA: % roles conservan botvshubs', v_restos; END IF;

  RAISE NOTICE 'mig 232 OK — Bot vs Hubs, RPCs lentas, FDW y respaldos eliminados.';
END $$;

COMMIT;
