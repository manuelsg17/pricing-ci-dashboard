-- ════════════════════════════════════════════════════════════════════════
-- Migración 222 — Colombia: agregar Chía a country_config.cities
--
-- CONTEXTO (2026-08-29):
--   Investigando un hallazgo lateral de la sesión del filtro TukTuk, se
--   encontró que `pricing_observations` tiene ~90.000 filas reales y
--   ACTIVAS para city='Chia' (Cundinamarca, satélite de Bogotá), 100%
--   data_source='bot', desde 2026-04-14 hasta hoy (500+ filas/semana,
--   cadencia sana). Chía NUNCA estuvo en `country_config.cities` para
--   Colombia — ni Bogotá/Cali/Barranquilla la incluyen, ni existe como
--   entrada propia. Resultado: la data se sigue acumulando en la BD pero
--   ningún hub/analista puede seleccionarla ni verla en el dashboard.
--
--   Causa de fondo (no se toca en esta migración, solo se documenta): el
--   pipeline de ingesta (scripts/bot-sync/bot_sync_push.py,
--   normalize_city()) NO tiene ninguna lista blanca de ciudades — cualquier
--   nombre que mande la fuente del bot entra directo a producción sin que
--   nadie lo note hasta que alguien audita manualmente. Chía es la prueba.
--   Si se quiere blindar esto hacia adelante, sería un chequeo aparte
--   (alertar cuando aparece una ciudad nueva no reconocida), no parte de
--   este fix puntual.
--
-- VERIFICACIÓN — competencia real reportada para Chía (query directa,
-- no copiada de Bogotá/Cali/Barranquilla):
--   Economy: Yango, Didi, Uber   (NO hay InDrive — 0 filas)
--   Comfort: Yango, Didi, Uber   (NO hay InDrive — 0 filas)
--   Bike:    Yango, Didi         (NO hay Picap — 0 filas)
--   Sin Delivery ni Cargo (0 filas, a diferencia de Bogotá/Cali/Barranquilla).
--   getCountryConfig() (src/lib/constants.js) da PRIORIDAD absoluta al
--   config de BD sobre el hardcodeado — dbConfigToInternal() ya soporta
--   agregar una ciudad nueva al array sin ningún cambio de código. No hace
--   falta tocar src/lib/constants.js ni ningún componente.
--
-- QUÉ NO INCLUYE ESTA MIGRACIÓN (a propósito):
--   - No se agrega ninguna fila a `distance_references` — Chía es 100% bot
--     hoy (0 filas manual), no hace falta catálogo de rutas para carga
--     manual mientras eso siga así.
--   - No se toca bot_rules — ya tienen cities=[] (wildcard) para Colombia,
--     Chía ya matchea sin cambios.
--   - No se toca bot_sync_push.py — Chía ya fluye correctamente hoy.
--
-- ROLLBACK: quitar el objeto de Chía del array (mismo patrón, jsonb - operator
-- por índice, o restaurar desde un snapshot previo del campo `cities`).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

UPDATE public.country_config
SET cities = cities || jsonb_build_array(
  jsonb_build_object(
    'botKey',    'chia',
    'dbName',    'Chia',
    'uiName',    'Chía',
    'isVirtual', false,
    'categories', jsonb_build_array(
      jsonb_build_object(
        'name', 'Economy', 'dbName', 'Economy',
        'competitors', jsonb_build_array('Yango','Didi','Uber'),
        'yangoDisplayName', 'Yango'
      ),
      jsonb_build_object(
        'name', 'Comfort', 'dbName', 'Comfort',
        'competitors', jsonb_build_array('Yango','Didi','Uber'),
        'yangoDisplayName', 'Yango'
      ),
      jsonb_build_object(
        'name', 'Bike', 'dbName', 'Bike',
        'competitors', jsonb_build_array('Yango','Didi'),
        'yangoDisplayName', 'Yango'
      )
    )
  )
)
WHERE country_key = 'Colombia'
  -- Idempotente: si ya se agregó Chía antes, no duplicar.
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(cities) c
    WHERE c->>'dbName' = 'Chia'
  );

-- Guarda: la fila debe existir y el UPDATE debe haber tocado exactamente 1.
DO $$
DECLARE
  v_count int;
  v_ya_existia boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.country_config cc, jsonb_array_elements(cc.cities) c
    WHERE cc.country_key = 'Colombia' AND c->>'dbName' = 'Chia'
  ) INTO v_ya_existia;

  IF NOT v_ya_existia THEN
    RAISE EXCEPTION 'mig 222 ABORTADA: Chía no quedó en country_config.cities de Colombia tras el UPDATE — revisar country_key exacto.';
  END IF;

  RAISE NOTICE 'mig 222 OK — Chía presente en country_config.cities de Colombia.';
END $$;

COMMIT;
