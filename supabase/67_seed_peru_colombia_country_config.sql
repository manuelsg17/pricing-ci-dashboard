-- ════════════════════════════════════════════════════════════════════════
-- Migración 67 — Seed Peru y Colombia en country_config
--
-- POR QUÉ:
--   Auditoría: "Peru y Colombia siguen sin estar en country_config en
--   producción". Toda la promesa multi-país data-driven se sostiene del
--   fallback CASE hardcoded de mig 64. La mig 64 misma documenta:
--
--     "Si Peru/Colombia ya están en country_config (vía botón 'Hacer
--      editable' del wizard), el paso 1 los resuelve y el legacy nunca
--      se ejecuta."
--
--   Nadie pulsó "Hacer editable" porque no había razón visible para
--   hacerlo. Este seed cierra ese gap.
--
--   También permite quitar `base=['Peru','Colombia']` del workflow
--   bot-sync.yml (la matriz dinámica los descubrirá vía status='active').
--
-- ESTRATEGIA:
--   INSERT con ON CONFLICT (country_key) DO NOTHING. Si Peru/Colombia ya
--   están (porque alguien hizo makeEditable o un seed anterior), no se
--   tocan. Si no están, se siembran con el snapshot de src/lib/constants.js
--   al 2026-05-15.
--
--   El CASE legacy de mig 64:129-142 se DEJA en su lugar como red de
--   seguridad. Una migración futura puede borrarlo después de validar
--   sync_bot_quotes en producción.
--
-- CAMPOS CRÍTICOS PARA sync_bot_quotes:
--   cities[].dbName  → nombre canónico en pricing_observations
--   cities[].botKey  → lo que el bot envía (lowercase, snake_case)
--   cities[].uiName  → nombre mostrado en la UI
--
-- OTROS CAMPOS:
--   currency, locale, label, iso2, native_label, outlier_threshold,
--   max_price, status='active', sort_order para mantener Peru/Colombia
--   primero.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PERU ─────────────────────────────────────────────────────────────────
INSERT INTO public.country_config (
  country_key, label, currency, locale,
  outlier_threshold, max_price, sort_order,
  iso2, native_label, status,
  cities
) VALUES (
  'Peru', 'Perú 🇵🇪', 'S/', 'es-PE',
  100, 300, 1,
  'PE', 'Perú', 'active',
  $cities$
  [
    {
      "uiName": "Lima",
      "dbName": "Lima",
      "botKey": "lima",
      "isVirtual": false,
      "categories": [
        {"name": "Economy/Comfort", "dbName": "Economy/Comfort", "competitors": ["Yango","YangoComfort","Uber","Didi","InDrive","Cabify"], "yangoDisplayName": "Yango"},
        {"name": "Comfort+",        "dbName": "Comfort+",        "competitors": ["Yango","Uber","InDrive","Cabify"],                    "yangoDisplayName": "Yango"},
        {"name": "Premier",         "dbName": "Premier",         "competitors": ["Yango","Uber","Cabify"],                              "yangoDisplayName": "Yango"},
        {"name": "XL",              "dbName": "XL",              "competitors": ["Yango","Uber","InDrive","Cabify"],                    "yangoDisplayName": "Yango"},
        {"name": "TukTuk",          "dbName": "TukTuk",          "competitors": ["Yango","Uber"],                                       "yangoDisplayName": "Yango"}
      ]
    },
    {
      "uiName": "Trujillo",
      "dbName": "Trujillo",
      "botKey": "trujillo",
      "isVirtual": false,
      "categories": [
        {"name": "Economy/Comfort", "dbName": "Economy/Comfort", "competitors": ["Yango","YangoComfort","Uber","Didi","InDrive","Cabify"], "yangoDisplayName": "Yango"},
        {"name": "Comfort+",        "dbName": "Comfort+",        "competitors": ["Yango","Uber","InDrive","Cabify"],                       "yangoDisplayName": "Yango"},
        {"name": "XL",              "dbName": "XL",              "competitors": ["Yango","Uber","InDrive","Cabify"],                       "yangoDisplayName": "Yango"}
      ]
    },
    {
      "uiName": "Arequipa",
      "dbName": "Arequipa",
      "botKey": "arequipa",
      "isVirtual": false,
      "categories": [
        {"name": "Economy/Comfort", "dbName": "Economy/Comfort", "competitors": ["Yango","YangoComfort","Uber","Didi","InDrive","Cabify"], "yangoDisplayName": "Yango"},
        {"name": "Comfort+",        "dbName": "Comfort+",        "competitors": ["Yango","Uber","InDrive","Cabify"],                       "yangoDisplayName": "Yango"},
        {"name": "XL",              "dbName": "XL",              "competitors": ["Yango","Uber","InDrive","Cabify"],                       "yangoDisplayName": "Yango"}
      ]
    },
    {
      "uiName": "Lima_Airport",
      "dbName": "Lima_Airport",
      "botKey": "lima_airport",
      "isVirtual": true,
      "categories": [
        {"name": "Economy/Comfort", "dbName": "Economy/Comfort", "competitors": ["Yango","YangoComfort","Uber","Didi","InDrive","Cabify"], "yangoDisplayName": "Yango"},
        {"name": "Comfort+",        "dbName": "Comfort+",        "competitors": ["Yango","Uber","InDrive","Cabify"],                       "yangoDisplayName": "Yango"},
        {"name": "Premier",         "dbName": "Premier",         "competitors": ["Yango","Uber","Cabify"],                                 "yangoDisplayName": "Yango"},
        {"name": "XL",              "dbName": "XL",              "competitors": ["Yango","Uber","InDrive","Cabify"],                       "yangoDisplayName": "Yango"}
      ]
    },
    {
      "uiName": "Trujillo_Airport",
      "dbName": "Trujillo_Airport",
      "botKey": "trujillo_airport",
      "isVirtual": true,
      "categories": [
        {"name": "Economy/Comfort", "dbName": "Economy/Comfort", "competitors": ["Yango","YangoComfort","Uber","Didi","InDrive","Cabify"], "yangoDisplayName": "Yango"},
        {"name": "Comfort+",        "dbName": "Comfort+",        "competitors": ["Yango","Uber","InDrive","Cabify"],                       "yangoDisplayName": "Yango"},
        {"name": "XL",              "dbName": "XL",              "competitors": ["Yango","Uber","InDrive","Cabify"],                       "yangoDisplayName": "Yango"}
      ]
    },
    {
      "uiName": "Arequipa_Airport",
      "dbName": "Arequipa_Airport",
      "botKey": "arequipa_airport",
      "isVirtual": true,
      "categories": [
        {"name": "Economy/Comfort", "dbName": "Economy/Comfort", "competitors": ["Yango","YangoComfort","Uber","Didi","InDrive","Cabify"], "yangoDisplayName": "Yango"},
        {"name": "Comfort+",        "dbName": "Comfort+",        "competitors": ["Yango","Uber","InDrive","Cabify"],                       "yangoDisplayName": "Yango"},
        {"name": "XL",              "dbName": "XL",              "competitors": ["Yango","Uber","InDrive","Cabify"],                       "yangoDisplayName": "Yango"}
      ]
    },
    {
      "uiName": "Corp",
      "dbName": "Corp",
      "botKey": "corp",
      "isVirtual": true,
      "categories": [
        {"name": "Corp", "dbName": "Corp", "competitors": ["Yango Economy","Yango Comfort","Yango Comfort+","Yango Premier","Yango XL","Cabify","Cabify Lite","Cabify Extra Comfort","Cabify XL"], "yangoDisplayName": "Yango Economy"}
      ]
    }
  ]
  $cities$::jsonb
)
ON CONFLICT (country_key) DO NOTHING;

-- ── COLOMBIA ─────────────────────────────────────────────────────────────
INSERT INTO public.country_config (
  country_key, label, currency, locale,
  outlier_threshold, max_price, sort_order,
  iso2, native_label, status,
  cities
) VALUES (
  'Colombia', 'Colombia 🇨🇴', 'COP', 'es-CO',
  300000, 1000000, 2,
  'CO', 'Colombia', 'active',
  $cities$
  [
    {
      "uiName": "Bogotá",
      "dbName": "Bogota",
      "botKey": "bogota",
      "isVirtual": false,
      "categories": [
        {"name": "Economy", "dbName": "Economy", "competitors": ["Yango","Didi","InDrive","Uber"],  "yangoDisplayName": "Yango"},
        {"name": "Bike",    "dbName": "Bike",    "competitors": ["Yango","Didi","InDrive","Picap"], "yangoDisplayName": "Yango"},
        {"name": "Comfort", "dbName": "Comfort", "competitors": ["Yango","Didi","InDrive","Uber"],  "yangoDisplayName": "Yango"}
      ]
    },
    {
      "uiName": "Cali",
      "dbName": "Cali",
      "botKey": "cali",
      "isVirtual": false,
      "categories": [
        {"name": "Economy", "dbName": "Economy", "competitors": ["Yango","Didi","InDrive","Uber"],  "yangoDisplayName": "Yango"},
        {"name": "Bike",    "dbName": "Bike",    "competitors": ["Yango","Didi","InDrive","Picap"], "yangoDisplayName": "Yango"},
        {"name": "Comfort", "dbName": "Comfort", "competitors": ["Yango","Didi","InDrive","Uber"],  "yangoDisplayName": "Yango"}
      ]
    },
    {
      "uiName": "Barranquilla",
      "dbName": "Barranquilla",
      "botKey": "barranquilla",
      "isVirtual": false,
      "categories": [
        {"name": "Economy", "dbName": "Economy", "competitors": ["Yango","Didi","InDrive","Uber"],  "yangoDisplayName": "Yango"},
        {"name": "Bike",    "dbName": "Bike",    "competitors": ["Yango","Didi","InDrive","Picap"], "yangoDisplayName": "Yango"},
        {"name": "Comfort", "dbName": "Comfort", "competitors": ["Yango","Didi","InDrive","Uber"],  "yangoDisplayName": "Yango"}
      ]
    }
  ]
  $cities$::jsonb
)
ON CONFLICT (country_key) DO NOTHING;

COMMIT;

-- ── Verificación ──────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_peru     int;
  v_colombia int;
BEGIN
  SELECT COUNT(*) INTO v_peru     FROM country_config WHERE country_key = 'Peru';
  SELECT COUNT(*) INTO v_colombia FROM country_config WHERE country_key = 'Colombia';
  IF v_peru = 0 OR v_colombia = 0 THEN
    RAISE WARNING 'Mig 67: Peru=% Colombia=% — al menos uno falta', v_peru, v_colombia;
  ELSE
    RAISE NOTICE 'Mig 67 OK: Peru y Colombia en country_config.';
  END IF;
END
$verify$;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN MANUAL POST-APLICACIÓN
--
-- 1. Confirmar que ambos países están con status='active':
--    SELECT country_key, status, jsonb_array_length(cities) AS n_cities
--    FROM country_config
--    WHERE country_key IN ('Peru','Colombia');
--    → Esperado: Peru con 7 ciudades, Colombia con 3.
--
-- 2. Probar el sync data-driven:
--    SELECT sync_bot_quotes('Peru', 100);
--    SELECT sync_bot_quotes('Colombia', 100);
--    → Deben funcionar igual que antes (el CASE legacy ya no se ejecuta,
--      el lookup data-driven los resuelve).
--
-- 3. (Opcional) Validar que sync_bot_quotes ya NO usa el fallback CASE
--    para estos dos países. Mig futura: borrar las líneas 129-142 de
--    mig 64 después de 1-2 semanas de operación sin incidentes.
-- ════════════════════════════════════════════════════════════════════════
