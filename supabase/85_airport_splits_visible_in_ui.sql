-- ════════════════════════════════════════════════════════════════════════
-- Migración 85 — Airport splits visibles en el selector de city
--
-- DEPENDE DE: mig 79 + mig 84 (cities ya con naming Airport_A/B).
--
-- PROBLEMA:
--   En mig 79 los 6 airport split cities se sembraron con `isVirtual: true`.
--   El frontend `dbConfigToInternal` (src/lib/constants.js) construye
--   `uiCities` filtrando por `!c.isVirtual` — y el dropdown del Dashboard
--   usa `uiCities`. Resultado: Lima_Airport_A/B etc. NO aparecen en el
--   selector, aunque la data está bien.
--
--   El módulo Gestión de Datos usa `dbCities` (sin filtro virtual) por lo
--   que ahí sí se ven. La inconsistencia confunde.
--
-- DECISIÓN:
--   `isVirtual` = "no mostrar en UI". Los airport splits SÍ deben verse
--   en el Dashboard — son mercados independientes con su propia analítica.
--   Solo `Corp` queda como `isVirtual: true` (es una vista contable,
--   no un mercado real).
--
-- QUÉ HACE:
--   UPDATE de country_config.cities para Peru, fijando isVirtual=false en
--   los 6 entries cuyo dbName matchea '%_Airport_A' o '%_Airport_B'.
--   Idempotente: si ya están en false, no cambia nada.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

UPDATE public.country_config
SET cities = (
  SELECT jsonb_agg(
    CASE
      WHEN (elem->>'dbName') ~ '_Airport_[AB]$' THEN
        jsonb_set(elem, '{isVirtual}', 'false'::jsonb)
      ELSE
        elem
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements(cities) WITH ORDINALITY AS t(elem, ord)
)
WHERE country_key = 'Peru';

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   SELECT elem->>'dbName' AS dbname,
--          (elem->>'isVirtual')::boolean AS is_virtual
--   FROM country_config, jsonb_array_elements(cities) AS elem
--   WHERE country_key='Peru'
--   ORDER BY 1;
--
--   Esperado:
--     Arequipa            | false
--     Arequipa_Airport_A  | false   ← cambió
--     Arequipa_Airport_B  | false   ← cambió
--     Corp                | true
--     Lima                | false
--     Lima_Airport_A      | false   ← cambió
--     Lima_Airport_B      | false   ← cambió
--     Trujillo            | false
--     Trujillo_Airport_A  | false   ← cambió
--     Trujillo_Airport_B  | false   ← cambió
-- ════════════════════════════════════════════════════════════════════════
