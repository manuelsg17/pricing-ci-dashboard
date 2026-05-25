-- ════════════════════════════════════════════════════════════════════════
-- Migración 79 — Split de aeropuertos en country_config (Peru)
--
-- DEPENDE DE: mig 78 (airport_markers).
--
-- CAMBIOS:
--   1. Reemplaza las 3 cities virtuales legacy (Lima_Airport,
--      Trujillo_Airport, Arequipa_Airport) por 6 nuevas:
--        Lima_AeroFrom, Lima_AeroTo
--        Trujillo_AeroFrom, Trujillo_AeroTo
--        Arequipa_AeroFrom, Arequipa_AeroTo
--      Las legacy se DEPRECAN — la mig 80 migra el histórico antes de
--      que esta entrada las desaparezca del UI.
--
--   2. Expande `bot_rules.cities` para que las reglas que mencionan
--      "Lima_Airport" cubran también los splits nuevos. Análogo para
--      Trujillo_Airport y Arequipa_Airport. Sin esto, después del re-
--      enrutado del Python las reglas dejarían de matchear.
--
-- CATEGORÍAS:
--   - Lima_AeroFrom / Lima_AeroTo:        Economy/Comfort, Comfort+, Premier, XL
--   - Trujillo_AeroFrom / Trujillo_AeroTo: Economy/Comfort, Comfort+, XL
--   - Arequipa_AeroFrom / Arequipa_AeroTo: Economy/Comfort, Comfort+, XL
--
-- ORDEN VISUAL EN LAS TABS (sort por uiName):
--   Lima · Trujillo · Arequipa · Lima_AeroFrom · Lima_AeroTo ·
--   Trujillo_AeroFrom · Trujillo_AeroTo · Arequipa_AeroFrom ·
--   Arequipa_AeroTo · Corp
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A. Reemplazar el JSONB `cities` de Peru ────────────────────────────
-- Reescribimos completo. ON CONFLICT en mig 67 era DO NOTHING, así que
-- una mig posterior tiene que hacer UPDATE explícito. Mantenemos la
-- estructura, solo cambiamos el array.

UPDATE public.country_config
SET cities = $cities$
[
  {
    "uiName": "Lima",
    "dbName": "Lima",
    "botKey": "lima",
    "isVirtual": false,
    "categories": [
      {"name": "Economy/Comfort", "dbName": "Economy/Comfort", "competitors": ["Yango","YangoComfort","Uber","Didi","InDrive","Cabify"], "yangoDisplayName": "Yango"},
      {"name": "Comfort+",        "dbName": "Comfort+",        "competitors": ["Yango","Uber","InDrive","Cabify"],                       "yangoDisplayName": "Yango"},
      {"name": "Premier",         "dbName": "Premier",         "competitors": ["Yango","Uber","Cabify"],                                 "yangoDisplayName": "Yango"},
      {"name": "XL",              "dbName": "XL",              "competitors": ["Yango","Uber","InDrive","Cabify"],                       "yangoDisplayName": "Yango"},
      {"name": "TukTuk",          "dbName": "TukTuk",          "competitors": ["Yango","Uber"],                                          "yangoDisplayName": "Yango"}
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
    "uiName": "Lima_AeroFrom",
    "dbName": "Lima_AeroFrom",
    "botKey": "lima_aerofrom",
    "isVirtual": true,
    "categories": [
      {"name": "Economy/Comfort", "dbName": "Economy/Comfort", "competitors": ["Yango","YangoComfort","Uber","Didi","InDrive","Cabify"], "yangoDisplayName": "Yango"},
      {"name": "Comfort+",        "dbName": "Comfort+",        "competitors": ["Yango","Uber","InDrive","Cabify"],                       "yangoDisplayName": "Yango"},
      {"name": "Premier",         "dbName": "Premier",         "competitors": ["Yango","Uber","Cabify"],                                 "yangoDisplayName": "Yango"},
      {"name": "XL",              "dbName": "XL",              "competitors": ["Yango","Uber","InDrive","Cabify"],                       "yangoDisplayName": "Yango"}
    ]
  },
  {
    "uiName": "Lima_AeroTo",
    "dbName": "Lima_AeroTo",
    "botKey": "lima_aeroto",
    "isVirtual": true,
    "categories": [
      {"name": "Economy/Comfort", "dbName": "Economy/Comfort", "competitors": ["Yango","YangoComfort","Uber","Didi","InDrive","Cabify"], "yangoDisplayName": "Yango"},
      {"name": "Comfort+",        "dbName": "Comfort+",        "competitors": ["Yango","Uber","InDrive","Cabify"],                       "yangoDisplayName": "Yango"},
      {"name": "Premier",         "dbName": "Premier",         "competitors": ["Yango","Uber","Cabify"],                                 "yangoDisplayName": "Yango"},
      {"name": "XL",              "dbName": "XL",              "competitors": ["Yango","Uber","InDrive","Cabify"],                       "yangoDisplayName": "Yango"}
    ]
  },
  {
    "uiName": "Trujillo_AeroFrom",
    "dbName": "Trujillo_AeroFrom",
    "botKey": "trujillo_aerofrom",
    "isVirtual": true,
    "categories": [
      {"name": "Economy/Comfort", "dbName": "Economy/Comfort", "competitors": ["Yango","YangoComfort","Uber","Didi","InDrive","Cabify"], "yangoDisplayName": "Yango"},
      {"name": "Comfort+",        "dbName": "Comfort+",        "competitors": ["Yango","Uber","InDrive","Cabify"],                       "yangoDisplayName": "Yango"},
      {"name": "XL",              "dbName": "XL",              "competitors": ["Yango","Uber","InDrive","Cabify"],                       "yangoDisplayName": "Yango"}
    ]
  },
  {
    "uiName": "Trujillo_AeroTo",
    "dbName": "Trujillo_AeroTo",
    "botKey": "trujillo_aeroto",
    "isVirtual": true,
    "categories": [
      {"name": "Economy/Comfort", "dbName": "Economy/Comfort", "competitors": ["Yango","YangoComfort","Uber","Didi","InDrive","Cabify"], "yangoDisplayName": "Yango"},
      {"name": "Comfort+",        "dbName": "Comfort+",        "competitors": ["Yango","Uber","InDrive","Cabify"],                       "yangoDisplayName": "Yango"},
      {"name": "XL",              "dbName": "XL",              "competitors": ["Yango","Uber","InDrive","Cabify"],                       "yangoDisplayName": "Yango"}
    ]
  },
  {
    "uiName": "Arequipa_AeroFrom",
    "dbName": "Arequipa_AeroFrom",
    "botKey": "arequipa_aerofrom",
    "isVirtual": true,
    "categories": [
      {"name": "Economy/Comfort", "dbName": "Economy/Comfort", "competitors": ["Yango","YangoComfort","Uber","Didi","InDrive","Cabify"], "yangoDisplayName": "Yango"},
      {"name": "Comfort+",        "dbName": "Comfort+",        "competitors": ["Yango","Uber","InDrive","Cabify"],                       "yangoDisplayName": "Yango"},
      {"name": "XL",              "dbName": "XL",              "competitors": ["Yango","Uber","InDrive","Cabify"],                       "yangoDisplayName": "Yango"}
    ]
  },
  {
    "uiName": "Arequipa_AeroTo",
    "dbName": "Arequipa_AeroTo",
    "botKey": "arequipa_aeroto",
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
WHERE country_key = 'Peru';

-- ── B. Expandir bot_rules.cities ───────────────────────────────────────
-- NOTA: bot_rules.cities es text[] (no jsonb). Usamos operadores de array:
--   - `= ANY(array)` para chequear pertenencia
--   - `||` para concatenar arrays
--   - `array(SELECT DISTINCT ...)` para deduplicar
--
-- Para cada regla cuyo array `cities` mencione un airport legacy, agregamos
-- también los nuevos splits. Idempotente: si ya están, el DISTINCT no duplica.
--
-- Esto preserva el comportamiento actual y agrega cobertura nueva. Si
-- mañana querés que una regla aplique SOLO al AeroFrom (no al Lima_Airport
-- legacy y no al AeroTo), la editás manualmente en /config.

UPDATE public.bot_rules br
SET cities = ARRAY(
  SELECT DISTINCT c
  FROM unnest(br.cities || ARRAY['Lima_AeroFrom','Lima_AeroTo']) AS c
)
WHERE br.country = 'Peru'
  AND 'Lima_Airport' = ANY(br.cities);

UPDATE public.bot_rules br
SET cities = ARRAY(
  SELECT DISTINCT c
  FROM unnest(br.cities || ARRAY['Trujillo_AeroFrom','Trujillo_AeroTo']) AS c
)
WHERE br.country = 'Peru'
  AND 'Trujillo_Airport' = ANY(br.cities);

UPDATE public.bot_rules br
SET cities = ARRAY(
  SELECT DISTINCT c
  FROM unnest(br.cities || ARRAY['Arequipa_AeroFrom','Arequipa_AeroTo']) AS c
)
WHERE br.country = 'Peru'
  AND 'Arequipa_Airport' = ANY(br.cities);

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   1. Country config:
--      SELECT country_key, jsonb_array_length(cities) AS n_cities
--      FROM country_config WHERE country_key='Peru';
--      -> 10 (Lima, Trujillo, Arequipa, 6 splits, Corp).
--
--   2. Bot rules expandidas:
--      SELECT app, vc, ovc, cities FROM bot_rules
--      WHERE country='Peru' AND 'Lima_Airport' = ANY(cities);
--      -> Cada fila ahora debe incluir también Lima_AeroFrom y Lima_AeroTo.
-- ════════════════════════════════════════════════════════════════════════
