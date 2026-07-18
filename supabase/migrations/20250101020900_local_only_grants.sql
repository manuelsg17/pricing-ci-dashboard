-- ════════════════════════════════════════════════════════════════════════
-- LOCAL-ONLY, sin equivalente en supabase/*.sql (Fase 0, hallazgo real).
--
-- En producción, Supabase (hosteado) otorga GRANT amplio (SELECT/INSERT/
-- UPDATE/DELETE/etc.) a anon/authenticated/service_role sobre cada tabla
-- de `public` automáticamente al crearla — esto pasa fuera de cualquier
-- migración, como parte del provisioning propio de la plataforma. RLS es
-- la barrera real de seguridad por encima de ese grant amplio. El
-- Postgres local del CLI NO hace esto solo — confirmado en vivo: sin este
-- paso, hasta un usuario autenticado recibe "permission denied for table
-- country_config" pese a que las policies de RLS son correctas.
--
-- Este archivo replica ese comportamiento para que el schema local se
-- comporte igual que producción. Nunca se aplica a producción — ahí ya
-- está así.
-- ════════════════════════════════════════════════════════════════════════

GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
