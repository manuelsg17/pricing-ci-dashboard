-- ════════════════════════════════════════════════════════════════════════
-- Fix: country_config.bot_rules vacío para Peru/Colombia rompe el upload
-- manual de bot (BotUpload.jsx → mapBotRows con dbConfigs).
--
-- Hallazgo (2026-07-18, sesión de modernización Fase 1.3): getCountryConfig
-- da precedencia absoluta a dbConfigs[country] sobre el hardcoded de
-- constants.js. country_config.bot_rules quedó en '[]' desde mig 58/67
-- (nadie corrió CountriesConfig.jsx→makeEditable para Peru/Colombia). En
-- botMapping.js, `const botRules = Array.isArray(config.botRules) ? ... :
-- null` — un array VACÍO sigue siendo array, así que `if (botRules)` entra
-- igual (un [] es truthy en JS) y CADA fila se descarta con "Sin regla".
-- Confirmado con el usuario: usa la pantalla "Cargar Data" ~1x/semana para
-- data de hubs — este bug le venía descartando el 100% de esas filas en
-- silencio, sin ningún error visible más que el contador de "omitidas".
--
-- Fix: poblar bot_rules desde la tabla SQL bot_rules (fuente correcta y
-- viva, la que usa el sync automático real) en vez de desde el hardcoded
-- JS — mismo criterio que ya propone el plan de modernización (Fase 1.3c:
-- bot_rules SQL como única fuente de verdad a futuro). Dos ajustes de
-- forma necesarios para que matcheen con resolveByRules() en
-- src/lib/botMapping.js:
--   1. `competition_name` (columna SQL) → `name` (campo que lee el JS).
--   2. `cities = '{}'` (sin restricción, convención SQL) → `null` (sin
--      restricción, convención JS — un array VACÍO en JS se interpreta
--      como "no matchea ninguna ciudad", lo opuesto de lo que se quiere).
--   3. `app = 'yango_api'` → `'yango'` (APP_KEY_MAP en botMapping.js
--      normaliza el app crudo del bot a esta clave antes de comparar;
--      copiar 'yango_api' tal cual nunca matchearía nada).
-- ════════════════════════════════════════════════════════════════════════

UPDATE country_config
SET bot_rules = (
  SELECT jsonb_agg(jsonb_build_object(
    'app', CASE WHEN br.app = 'yango_api' THEN 'yango' ELSE br.app END,
    'vc', br.vc,
    'ovc', br.ovc,
    'name', br.competition_name,
    'category', br.category,
    'cities', CASE WHEN cardinality(br.cities) = 0 THEN NULL ELSE to_jsonb(br.cities) END
  ))
  FROM bot_rules br
  WHERE br.country = country_config.country_key AND br.active = true
)
WHERE country_key IN ('Peru', 'Colombia');
