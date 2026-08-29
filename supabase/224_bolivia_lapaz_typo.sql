-- ════════════════════════════════════════════════════════════════════════
-- Migración 224 — Bolivia: dbName 'LaPaz' → 'La Paz' (typo en country_config)
--
-- ORIGEN: primer hallazgo real del guard "ciudades_desconocidas" del sync
-- (commit e13c43e), en su PRIMERA corrida en producción (2026-08-29):
-- reportó 1.426 filas de 'La Paz' como ciudad no reconocida para Bolivia.
--
-- CAUSA: country_config.cities para Bolivia tiene dbName='LaPaz' (sin
-- espacio), pero el 100% de las filas reales de pricing_observations están
-- bajo 'La Paz' (con espacio): 16.508 filas vs 0 bajo 'LaPaz' (verificado).
-- El selector del dashboard muestra "La Paz" (uiName, correcto) pero
-- consulta dbCity='LaPaz' → vacío. La ciudad aparece rota desde que se
-- configuró.
--
-- QUÉ NO ARREGLA ESTA MIGRACIÓN (hallazgos hermanos del mismo guard,
-- pendientes de decisión del user — necesitan criterio de negocio):
--   · Tarija: 1.261 filas reales sin entrada en country_config (patrón
--     Chía). ¿Se agrega o se descarta la ciudad?
--   · Categorías fragmentadas en Bolivia: la data vive bajo Economy,
--     Comfort, Bike, XL, Premier y Economy/Comfort según el competidor,
--     pero la config solo mapea 'Economy'→'Economy/Comfort'. Gran parte
--     de la data de Bolivia es invisible por esto, typo aparte.
--   · TODA la data de Bolivia se detuvo el 2026-07-10 (7 semanas sin
--     filas nuevas) — ¿el bot dejó de cubrir Bolivia?
--
-- ROLLBACK: mismo UPDATE con los valores invertidos.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

UPDATE public.country_config
SET cities = (
  SELECT jsonb_agg(
    CASE WHEN c->>'dbName' = 'LaPaz'
         THEN jsonb_set(c, '{dbName}', '"La Paz"')
         ELSE c
    END
  )
  FROM jsonb_array_elements(cities) c
)
WHERE country_key = 'Bolivia'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(cities) c
    WHERE c->>'dbName' = 'LaPaz'
  );

DO $$
DECLARE
  v_typo_restante int;
  v_bolivia_existe boolean;
BEGIN
  -- La guarda solo puede exigir lo que puede existir: en LOCAL Bolivia no
  -- está (se creó en prod vía CountryWizard, solo-DB, sin fila en el seed)
  -- y exigir "La Paz presente" hacía reventar el db reset — cazado en la
  -- validación local de esta misma migración. El invariante correcto es:
  -- que no QUEDE ningún 'LaPaz' con typo, exista Bolivia o no.
  SELECT count(*) INTO v_typo_restante
  FROM public.country_config cc, jsonb_array_elements(cc.cities) c
  WHERE cc.country_key = 'Bolivia' AND c->>'dbName' = 'LaPaz';

  IF v_typo_restante > 0 THEN
    RAISE EXCEPTION 'mig 224 ABORTADA: quedan % entradas LaPaz sin corregir.', v_typo_restante;
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.country_config WHERE country_key='Bolivia')
    INTO v_bolivia_existe;
  IF v_bolivia_existe THEN
    RAISE NOTICE 'mig 224 OK — dbName LaPaz → La Paz.';
  ELSE
    RAISE NOTICE 'mig 224 OK — Bolivia no existe en este entorno, nada que corregir.';
  END IF;
END $$;

COMMIT;
