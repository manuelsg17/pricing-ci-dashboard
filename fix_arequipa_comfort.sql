-- ============================================================
-- REPARACIÓN DINÁMICA: AREQUIPA COMFORT
-- Este script usa tu configuración actual de 'Configuración'
-- para arreglar los brackets de Arequipa Comfort.
-- ============================================================

DO $$
DECLARE
    found_thresholds int;
BEGIN
    -- 1. Verificar si existen thresholds para Arequipa Comfort
    SELECT count(*) INTO found_thresholds 
    FROM distance_thresholds 
    WHERE city = 'Arequipa' AND category = 'Comfort';

    IF found_thresholds = 0 THEN
        RAISE NOTICE 'No se encontraron umbrales para Arequipa Comfort. Inicializando con valores por defecto...';
        -- Solo insertamos si no existen para no sobreescribir tus cambios
        INSERT INTO distance_thresholds (city, category, bracket, max_km) VALUES
          ('Arequipa', 'Comfort', 'very_short', 1.94),
          ('Arequipa', 'Comfort', 'short',      3.19),
          ('Arequipa', 'Comfort', 'median',     4.11),
          ('Arequipa', 'Comfort', 'average',    5.60),
          ('Arequipa', 'Comfort', 'long',       8.76),
          ('Arequipa', 'Comfort', 'very_long',  NULL);
    ELSE
        RAISE NOTICE 'Se encontraron % umbrales. Usando configuración existente.', found_thresholds;
    END IF;

    -- 2. Asegurar Referencias de Distancia (References)
    -- Crea una ruta de referencia por cada bracket que tengas configurado si no existe ninguna.
    INSERT INTO distance_references (city, category, bracket, point_a, point_b, waze_distance)
    SELECT 'Arequipa', 'Comfort', t.bracket, 'Ref ' || t.bracket, 'Destino', 
           COALESCE(t.max_km - 0.2, 15.0)
    FROM distance_thresholds t
    WHERE t.city = 'Arequipa' AND t.category = 'Comfort'
      AND NOT EXISTS (
        SELECT 1 FROM distance_references r 
        WHERE r.city = 'Arequipa' AND r.category = 'Comfort' AND r.bracket = t.bracket
      );

    -- 3. BACKFILL: Recalcular brackets para observaciones existentes
    -- Esto dispara el trigger 'before_insert_pricing' que usa la función 'get_distance_bracket'
    -- con tus umbrales actuales.
    RAISE NOTICE 'Re-calculando brackets para observaciones de Arequipa Comfort...';
    UPDATE pricing_observations
    SET distance_bracket = get_distance_bracket(city, category, distance_km)
    WHERE city = 'Arequipa' AND category = 'Comfort';

    RAISE NOTICE 'Proceso completado con éxito.';
END $$;
