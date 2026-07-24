-- ════════════════════════════════════════════════════════════════════════
-- 158_harden_secdef_search_path.sql — re-endurecer 5 funciones SECURITY
-- DEFINER que perdieron su search_path.
--
-- CONTEXTO: mig 61 (010100) endureció un set de funciones SECURITY DEFINER
-- agregándoles `SET search_path = public, pg_temp` (defensa contra
-- search_path hijacking). Pero migraciones POSTERIORES las redefinieron con
-- `CREATE OR REPLACE ... SET statement_timeout` OMITIENDO el search_path — y
-- una cláusula SET en CREATE OR REPLACE reemplaza el proconfig entero,
-- borrando el search_path que mig 61 había puesto. La auditoría de seguridad
-- (2026-07-24) detectó 5 funciones SECURITY DEFINER en prod sin search_path:
--   - get_dashboard_data_weekly_with_freeze  (hot path, cualquier authenticated)
--   - sync_bot_quotes(text,int)
--   - diagnose_bot_rules_coverage(text,int)
--   - trg_apply_indrive_prices_on_config()
--   - trg_indrive_config_propagate()
--
-- RIESGO REAL HOY: bajo — CREATE sobre el schema public está revocado para
-- authenticated/anon/PUBLIC, así que el ataque clásico (plantar objetos
-- maliciosos en public) no es explotable. Esto cierra el regress de
-- defensa-en-profundidad, no un hueco abierto.
--
-- FIX: ALTER FUNCTION ... SET search_path (no toca el cuerpo). Ninguna de las
-- 5 usa funciones de `extensions` sin calificar (verificado), así que
-- `public, pg_temp` es correcto — misma convención que is_admin(),
-- admin_close_ci_session(), etc.
--
-- NOTA para el futuro: incluir `SET search_path = public, pg_temp` INLINE en
-- cada CREATE OR REPLACE de funciones SECURITY DEFINER — el patrón de listas
-- hardcodeadas de mig 61 no cubre funciones creadas/redefinidas después.
-- ════════════════════════════════════════════════════════════════════════

ALTER FUNCTION public.get_dashboard_data_weekly_with_freeze(
  p_city text, p_category text, p_country text, p_zone text, p_surge boolean,
  p_week_start integer, p_year_start integer, p_week_end integer,
  p_year_end integer, p_data_source text, p_time_of_day text[], p_use_frozen boolean
) SET search_path = public, pg_temp;

ALTER FUNCTION public.sync_bot_quotes(p_country text, p_limit integer)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.diagnose_bot_rules_coverage(p_country text, p_days integer)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.trg_apply_indrive_prices_on_config()
  SET search_path = public, pg_temp;

ALTER FUNCTION public.trg_indrive_config_propagate()
  SET search_path = public, pg_temp;
