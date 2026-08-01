-- ════════════════════════════════════════════════════════════════════════
-- 189_close_cross_country_reads.sql — cierra 3 lecturas entre países.
--
-- HALLAZGO (auditoría 2026-07-31, PERMISOS_DESIGN.md "Hallazgos laterales")
-- Tres tablas tienen columna `country` pero su política de SELECT es
-- `USING (true)`: cualquier usuario autenticado lee las rutas de referencia,
-- los overrides de catálogo y el historial de cargas de TODOS los países.
--
--   distance_references — rutas punto A/punto B de cada ciudad
--   catalog_extras      — overrides de categorías y competidores
--   upload_batches      — historial de cargas manuales
--
-- Es metadata, no precios, y por eso quedó P2 y no P0. Pero rompe el
-- aislamiento por país que TODO el resto del sistema sí mantiene: un hub de
-- Perú no debería poder enumerar la operación de Colombia. El resto de las
-- tablas ya filtra por can_access_country(country) desde las migs 60-66.
--
-- QUÉ NO SE TOCA, y por qué:
--   · `ci_timeslots` y `roles` también son USING(true), pero NO tienen columna
--     `country`: son catálogos GLOBALES por diseño (los turnos son iguales en
--     todos los países; la lista de roles la necesita la pantalla de Accesos).
--     CLAUDE.md §3 pide justificar cualquier USING(true) que se deje — esta es
--     la justificación.
--
-- RIESGO DE REGRESIÓN, y por qué es bajo:
-- Estas tres tablas se consultan siempre acotadas por el país activo desde el
-- cliente (ConfigProvider/useCountry), así que filtrar por país en la base no
-- le quita nada a un usuario que ya trabajaba en su propio país. El único
-- cambio de comportamiento observable sería para un usuario multi-país, y para
-- ese caso can_access_country() devuelve TODOS sus países, no uno.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- DROP explícito antes de cada CREATE: dos políticas permisivas para el mismo
-- comando se combinan con OR y la vieja `USING (true)` ganaría en silencio,
-- dejando la fuga abierta y el trabajo hecho a medias sin ningún error.
DROP POLICY IF EXISTS distance_references_select ON public.distance_references;
CREATE POLICY distance_references_select ON public.distance_references
  FOR SELECT TO authenticated
  USING (can_access_country(country));

DROP POLICY IF EXISTS catalog_extras_select ON public.catalog_extras;
CREATE POLICY catalog_extras_select ON public.catalog_extras
  FOR SELECT TO authenticated
  USING (can_access_country(country));

DROP POLICY IF EXISTS upload_batches_select ON public.upload_batches;
CREATE POLICY upload_batches_select ON public.upload_batches
  FOR SELECT TO authenticated
  USING (can_access_country(country));

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- 1) Las tres quedaron con el gate de país:
--    SELECT tablename, qual FROM pg_policies
--     WHERE schemaname='public' AND cmd='SELECT'
--       AND tablename IN ('distance_references','catalog_extras','upload_batches');
--
-- 2) Una sola política de SELECT por tabla (sin OR con la vieja):
--    npm run check:rls-drift   → 0 filas
--
-- 3) Prueba de aislamiento con JWT simulado (ejecutada en el cutover): un
--    usuario con countries=['Peru'] no ve filas de Colombia en ninguna de las
--    tres, y sí ve las suyas.
