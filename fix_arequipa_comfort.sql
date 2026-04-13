-- ============================================================
-- REPARACIÓN CRÍTICA: AREQUIPA COMFORT
-- 1. Normaliza el nombre de la categoría (UI -> DB)
-- 2. Recalcula los brackets según tus umbrales actuales
-- 3. Crea las rutas de referencia faltantes
-- ============================================================

DO $$
BEGIN
    -- 1. CORRECCIÓN DE NOMBRE
    -- Cambiamos 'Comfort/Comfort+' a 'Comfort' para que coincida con los umbrales
    RAISE NOTICE 'Corrigiendo nombres de categoría en pricing_observations...';
    UPDATE pricing_observations
    SET category = 'Comfort'
    WHERE category = 'Comfort/Comfort+';

    -- 2. INICIALIZAR UMBRALES SI NO EXISTEN
    -- Solo si no existen para 'Comfort', insertamos los básicos
    IF NOT EXISTS (SELECT 1 FROM distance_thresholds WHERE city='Arequipa' AND category='Comfort') THEN
        INSERT INTO distance_thresholds (city, category, bracket, max_km) VALUES
          ('Arequipa', 'Comfort', 'very_short', 1.94),
          ('Arequipa', 'Comfort', 'short',      3.19),
          ('Arequipa', 'Comfort', 'median',     4.11),
          ('Arequipa', 'Comfort', 'average',    5.60),
          ('Arequipa', 'Comfort', 'long',       8.76),
          ('Arequipa', 'Comfort', 'very_long',  NULL);
    END IF;

    -- 3. BACKFILL (RECÁLCULO)
    -- Ahora que el nombre es 'Comfort', el trigger 'trg_assign_computed_fields'
    -- encontrará los umbrales correctos y asignará Very Short, Short, etc.
    RAISE NOTICE 'Recalculando brackets de distancia para Arequipa Comfort...';
    UPDATE pricing_observations
    SET distance_bracket = get_distance_bracket(city, category, distance_km)
    WHERE city = 'Arequipa' AND category = 'Comfort';

    -- 4. REFERENCIAS
    -- Aseguramos que existan las rutas para entrar datos manualmente en el futuro
    RAISE NOTICE 'Asegurando rutas de referencia...';
    INSERT INTO distance_references (city, category, bracket, point_a, point_b, waze_distance)
    SELECT 'Arequipa', 'Comfort', t.bracket, 'Ref ' || t.bracket, 'Destino', 
           COALESCE(t.max_km - 0.2, 15.0)
    FROM distance_thresholds t
    WHERE t.city = 'Arequipa' AND t.category = 'Comfort'
      AND NOT EXISTS (
        SELECT 1 FROM distance_references r 
        WHERE r.city = 'Arequipa' AND r.category = 'Comfort' AND r.bracket = t.bracket
      );

    RAISE NOTICE 'Proceso completado con éxito. Ahora el Dashboard debería mostrar la data.';
END $$;
