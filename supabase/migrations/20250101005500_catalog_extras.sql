-- ════════════════════════════════════════════════════════════════════════
-- Migración 55 — Catalog extras (overrides al catálogo JS)
--
-- POR QUÉ:
--   El catálogo canónico de categorías y competidores vive en
--   `src/lib/catalogs.js` para que los dropdowns funcionen sin DB.
--   Pero el operador a veces necesita agregar uno custom (ej.
--   competidor regional nuevo) sin esperar un redeploy.
--
--   Esta tabla guarda esos extras. Los componentes de UI muestran
--   la unión de `[CATALOG_JS, ...catalog_extras]`.
--
--   En modo "advisory" — NO hay FK enforcement contra
--   pricing_observations.category o bot_rules.competition_name todavía.
--   Eso se promueve a constraint en una migración futura cuando
--   tengamos 2 semanas de coverage 100%.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS catalog_extras (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('category', 'competitor')),
  value       text NOT NULL,
  country     text,         -- NULL = override global; text = scoped al país
  color       text,         -- solo para kind='competitor'
  bot_apps    text[],       -- solo para kind='competitor': qué apps del bot mapean acá
  aliases     text[],       -- variantes adicionales para normalize*
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  UNIQUE (kind, value, country)
);

CREATE INDEX IF NOT EXISTS idx_catalog_extras_lookup
  ON catalog_extras (kind, country);

COMMENT ON TABLE catalog_extras IS
  'Overrides al catálogo JS hardcoded (src/lib/catalogs.js). Permite agregar categorías/competidores custom por país sin redeploy.';

-- RLS — solo authenticated puede leer/escribir
ALTER TABLE catalog_extras ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS catalog_extras_rw ON catalog_extras;
CREATE POLICY catalog_extras_rw ON catalog_extras
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

GRANT ALL ON catalog_extras TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE catalog_extras_id_seq TO authenticated;

-- RPC helper: devuelve categorías + competidores válidos para un país
-- (catalog JS + extras de country o globales).
CREATE OR REPLACE FUNCTION list_catalog_extras(p_country text DEFAULT NULL)
RETURNS TABLE (
  kind     text,
  value    text,
  country  text,
  color    text,
  bot_apps text[],
  aliases  text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT kind, value, country, color, bot_apps, aliases
  FROM catalog_extras
  WHERE country IS NULL OR country = p_country
  ORDER BY kind, value;
$$;

GRANT EXECUTE ON FUNCTION list_catalog_extras(text) TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- USAR ASÍ:
--
--   -- Agregar competidor regional para Nepal:
--   INSERT INTO catalog_extras (kind, value, country, color, bot_apps, aliases)
--   VALUES ('competitor', 'Pathao', 'Nepal', '#1976D2',
--           ARRAY['pathao'], ARRAY['pathao', 'pathao_ride']);
--
--   -- Listar lo válido para Nepal (JS + extras):
--   SELECT * FROM list_catalog_extras('Nepal');
-- ════════════════════════════════════════════════════════════════════════
