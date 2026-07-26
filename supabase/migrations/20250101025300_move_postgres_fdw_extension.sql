-- ════════════════════════════════════════════════════════════════════════
-- 172_move_postgres_fdw_extension.sql — hallazgo cosmético de la auditoría
-- de seguridad 2026-07-26: la extensión `postgres_fdw` vivía en el schema
-- `public` en vez del schema `extensions` dedicado (que Supabase ya crea
-- por defecto para este propósito exacto). Sin impacto de seguridad real
-- — la tabla foránea que usa (`bot_quotes_remote`) ya tenía grants
-- restringidos a `service_role`/`postgres` únicamente — es solo prolijidad
-- de organización de schemas.
--
-- La tabla foránea `bot_quotes_remote` NO se mueve en esta migración —
-- mover foreign tables entre schemas puede requerir recrear el mapeo de
-- usuario según la versión de Postgres, y esta ya está correctamente
-- asegurada (grants solo a service_role/postgres). Solo se reubica la
-- extensión, que es el hallazgo puntual del advisor.
-- ════════════════════════════════════════════════════════════════════════

-- Local (supabase db reset) nunca tuvo postgres_fdw habilitado vía
-- migración — se activó en producción a mano desde el dashboard en algún
-- momento (Database → Extensions), fuera del historial de migraciones.
-- Guard condicional para que este archivo sea un no-op seguro en
-- cualquier ambiente donde la extensión no exista todavía.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgres_fdw') THEN
    ALTER EXTENSION postgres_fdw SET SCHEMA extensions;
  END IF;
END $$;
