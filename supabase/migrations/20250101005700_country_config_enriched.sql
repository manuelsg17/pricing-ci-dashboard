-- ════════════════════════════════════════════════════════════════════════
-- Migración 57 — Enriquecer schema country_config
--
-- POR QUÉ:
--   Hoy hay duplicación entre src/lib/constants.js (COUNTRY_ISO,
--   COUNTRY_NATIVE_LABEL, CITY_DISPLAY_NAMES) y la tabla DB. El plan
--   long-term es migrar todo a DB. Esta migración agrega los campos
--   faltantes con defaults sensatos para no romper nada existente.
--
-- CAMPOS NUEVOS:
--   - iso2:                código ISO 3166-1 alfa-2 (PE, CO, BO, etc.)
--                          usado para renderizar la bandera
--   - native_label:        nombre nativo del país (Perú, Colombia, etc.)
--                          usado en topbar para fallback de bandera
--   - status:              draft | active. Solo 'active' aparece en el
--                          selector global. 'draft' permite onboardear
--                          sin afectar a otros usuarios.
--
-- RETROCOMPAT:
--   - Todos los campos tienen default
--   - Países existentes (Peru, Colombia, etc.) se seedean automáticamente
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE country_config
  ADD COLUMN IF NOT EXISTS iso2          text,
  ADD COLUMN IF NOT EXISTS native_label  text,
  ADD COLUMN IF NOT EXISTS status        text NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'active'));

CREATE INDEX IF NOT EXISTS idx_country_config_status
  ON country_config (status);

-- Seed: completar iso2 y native_label para países conocidos
UPDATE country_config SET iso2 = 'PE', native_label = 'Perú'      WHERE country_key = 'Peru'      AND iso2 IS NULL;
UPDATE country_config SET iso2 = 'CO', native_label = 'Colombia'  WHERE country_key = 'Colombia'  AND iso2 IS NULL;
UPDATE country_config SET iso2 = 'BO', native_label = 'Bolivia'   WHERE country_key = 'Bolivia'   AND iso2 IS NULL;
UPDATE country_config SET iso2 = 'NP', native_label = 'नेपाल'      WHERE country_key = 'Nepal'     AND iso2 IS NULL;
UPDATE country_config SET iso2 = 'VE', native_label = 'Venezuela' WHERE country_key = 'Venezuela' AND iso2 IS NULL;
UPDATE country_config SET iso2 = 'ZM', native_label = 'Zambia'    WHERE country_key = 'Zambia'    AND iso2 IS NULL;

COMMENT ON COLUMN country_config.iso2 IS 'Código ISO 3166-1 alfa-2 (PE, CO, etc.) para renderizar banderas en la UI.';
COMMENT ON COLUMN country_config.native_label IS 'Nombre nativo del país. Usado como fallback de la bandera.';
COMMENT ON COLUMN country_config.status IS 'draft = oculto del selector global. active = visible. Permite onboardear países sin afectar otros usuarios.';

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- POST-APLICACIÓN: el frontend ya consume status para filtrar países
-- visibles (mig 57 frontend, siguiente commit).
-- ════════════════════════════════════════════════════════════════════════
