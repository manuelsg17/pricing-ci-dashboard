-- ════════════════════════════════════════════════════════════════════════
-- Migración 58 — Persistir bot_rules y airport subcategorías en country_config
--
-- POR QUÉ:
--   La función makeEditable() del frontend "promueve" un país de
--   COUNTRY_CONFIG (constants.js) a la tabla country_config. Pero el
--   shape de DB no tiene espacio para:
--     - botRules: lista de reglas (app, vc, ovc) → (competitor, category)
--       usadas por el path de CSV manual upload (botMapping.js)
--     - aeropuertoSubcategoriesByCity: mapeo Lima/Trujillo/Arequipa →
--       lista de subcategorías de aeropuerto (Peru-specific)
--
--   Sin estos campos, promover Peru a DB rompía silenciosamente:
--     - El upload manual de CSV para Peru
--     - El dropdown de Aeropuerto en filterbar de Peru
--
-- DISEÑO:
--   Agregar dos columnas JSONB con default '[]' / '{}'. Frontend
--   serializa/deserializa al hacer makeEditable / dbConfigToInternal.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE country_config
  ADD COLUMN IF NOT EXISTS bot_rules                   jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS airport_subcategories_by_city jsonb NOT NULL DEFAULT '{}';

COMMENT ON COLUMN country_config.bot_rules IS
  'Array de bot rules para el path CSV manual: [{app, vc, ovc, name, category}]. Independiente de la tabla bot_rules (que es para el path FDW/sync_bot_quotes).';

COMMENT ON COLUMN country_config.airport_subcategories_by_city IS
  'Mapeo Peru-style: {Lima: [subcat1, subcat2], Trujillo: [...]}. Vacío si el país no usa aeropuertos virtuales.';

COMMIT;
