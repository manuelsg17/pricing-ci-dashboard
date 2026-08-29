-- ════════════════════════════════════════════════════════════════════════
-- Migración 225 — Bolivia: agregar Tarija a country_config.cities
--
-- CONTEXTO: mismo patrón que Chía (mig 222) — el guard "ciudades_
-- desconocidas" (commit e13c43e) reportó Tarija en su primera corrida real.
-- 1.261 filas reales, 100% data_source='bot', 12-may a 10-jul 2026 (se
-- detuvo junto con el resto de Bolivia — ver nota abajo).
--
-- DIFERENCIA IMPORTANTE CON CHÍA: Tarija NUNCA tuvo datos de competidor.
-- Verificado con query directa: 100% de las filas son category='Economy',
-- competition_name='Yango' — cero filas de Uber/InDrive/Didi/etc. No es una
-- categoría de taxi con comparativa incompleta; es solo el precio propio
-- de Yango sin ningún punto de referencia externo. Se agrega igual porque
-- el user lo pidió explícitamente (2026-08-29), pero el dashboard va a
-- mostrar Yango solo, sin ninguna comparación, hasta que (si acaso) el bot
-- vuelva a mandar competidores para esa ciudad.
--
-- ESTRUCTURA: mismo shape que las otras 3 ciudades de Bolivia (Santa Cruz/
-- Cochabamba/La Paz) — dbName de categoría 'Economy/Comfort' (coincide con
-- el patrón de esas 3, NO con el valor crudo 'Economy' de la fila; el
-- dashboard normaliza por dbName de categoría, no por el category crudo).
-- competitors=['Yango'] refleja la realidad verificada, no se inventan
-- competidores que nunca se observaron ahí.
--
-- NOTA HEREDADA, NO RESUELTA ACÁ: toda la data de Bolivia (las 4 ciudades)
-- se detuvo el 2026-07-10 — 7 semanas sin filas nuevas al momento de este
-- commit. Agregar Tarija no reactiva el flujo; si el bot dejó de cubrir
-- Bolivia, esa es una conversación aparte con quien opera el simulador.
--
-- ROLLBACK: quitar el objeto de Tarija del array (mismo patrón que Chía).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

UPDATE public.country_config
SET cities = cities || jsonb_build_array(
  jsonb_build_object(
    'botKey',    'tarija',
    'dbName',    'Tarija',
    'uiName',    'Tarija',
    'isVirtual', false,
    'categories', jsonb_build_array(
      jsonb_build_object(
        'name', 'Economy', 'dbName', 'Economy/Comfort',
        'competitors', jsonb_build_array('Yango'),
        'yangoDisplayName', 'Yango'
      )
    )
  )
)
WHERE country_key = 'Bolivia'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(cities) c
    WHERE c->>'dbName' = 'Tarija'
  );

DO $$
DECLARE
  v_ya_existia boolean;
  v_bolivia_existe boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.country_config WHERE country_key='Bolivia')
    INTO v_bolivia_existe;

  IF NOT v_bolivia_existe THEN
    RAISE NOTICE 'mig 225 OK — Bolivia no existe en este entorno, nada que hacer.';
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.country_config cc, jsonb_array_elements(cc.cities) c
    WHERE cc.country_key = 'Bolivia' AND c->>'dbName' = 'Tarija'
  ) INTO v_ya_existia;

  IF NOT v_ya_existia THEN
    RAISE EXCEPTION 'mig 225 ABORTADA: Tarija no quedó en country_config.cities de Bolivia.';
  END IF;
  RAISE NOTICE 'mig 225 OK — Tarija presente en country_config.cities de Bolivia.';
END $$;

COMMIT;
