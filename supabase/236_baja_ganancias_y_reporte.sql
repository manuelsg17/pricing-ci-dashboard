-- ════════════════════════════════════════════════════════════════════════
-- Migración 236 — Baja de las secciones "Ganancias" (earnings) y
-- "Reporte" (report) del menú Análisis
--
-- DECISIÓN DEL USER (2026-09-03): "podemos eliminar la sección de GANANCIAS
-- y REPORTE porque ya no lo uso". Rentabilidad pasa a ser la vista principal
-- de comparación Yango vs competidores; Mercado, Competitividad y Monitoreo
-- de rutas se conservan.
--
-- QUÉ SE VA (lado base):
--   - `earnings_scenarios`: tabla exclusiva de Ganancias (0 filas en prod al
--     momento de esta migración), con sus 4 políticas RLS (mig 164/188).
--   - Las 3 filas `section_write_grants` de la sección 'earnings'. Dos de
--     ellas (competitor_commissions / competitor_bonuses) siguen concedidas
--     por 'config', que es donde se editan de verdad.
--   - 'earnings' y 'report' de `roles.permissions->'sections'`: un rol con
--     una sección que ya no existe en ROUTES hace fallar check-section-grants.
--
-- QUÉ NO SE TOCA: competitor_commissions, competitor_bonuses (las usan
-- Rentabilidad y Config), pricing_observations (Reporte solo la leía).
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

DELETE FROM public.section_write_grants WHERE section = 'earnings';

UPDATE public.roles
SET permissions = jsonb_set(
      permissions, '{sections}',
      COALESCE((SELECT jsonb_agg(s) FROM jsonb_array_elements(permissions->'sections') s
                WHERE s NOT IN ('"earnings"'::jsonb, '"report"'::jsonb)), '[]'::jsonb))
WHERE permissions->'sections' ?| ARRAY['earnings', 'report'];

DROP TABLE IF EXISTS public.earnings_scenarios;

COMMIT;

-- Verificación:
--   SELECT name, permissions->'sections' FROM roles;        -- sin earnings/report
--   SELECT count(*) FROM section_write_grants WHERE section='earnings';  -- 0
--   SELECT to_regclass('public.earnings_scenarios');        -- NULL
--   npm run check:section-grants                            -- sin huecos
