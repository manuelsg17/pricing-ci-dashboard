-- ============================================================
-- REPARACIÓN DE DATOS: AREQUIPA COMFORT
-- Ejecutar este script en el SQL Editor de Supabase
-- ============================================================

DO $$
BEGIN
    -- 1. Asegurar Umbrales de Distancia (Thresholds)
    -- Si faltaban para 'Comfort' en Arequipa, esto los crea
    INSERT INTO distance_thresholds (city, category, bracket, max_km) VALUES
      ('Arequipa', 'Comfort', 'very_short', 1.94),
      ('Arequipa', 'Comfort', 'short',      3.19),
      ('Arequipa', 'Comfort', 'median',     4.11),
      ('Arequipa', 'Comfort', 'average',    5.60),
      ('Arequipa', 'Comfort', 'long',       8.76),
      ('Arequipa', 'Comfort', 'very_long',  NULL)
    ON CONFLICT (city, category, bracket) DO UPDATE SET max_km = EXCLUDED.max_km;

    -- 2. Asegurar Referencias de Distancia (References)
    -- Esto crea una ruta base para cada bracket si no existen.
    -- El usuario podrá luego editarlas desde el panel "Distancias Ref."
    INSERT INTO distance_references (city, category, bracket, point_a, point_b, waze_distance)
    VALUES 
      ('Arequipa', 'Comfort', 'very_short', 'Referencia Muy Corta', 'Destino', 1.0),
      ('Arequipa', 'Comfort', 'short',      'Referencia Corta',     'Destino', 2.5),
      ('Arequipa', 'Comfort', 'median',     'Referencia Mediana',   'Destino', 3.5),
      ('Arequipa', 'Comfort', 'average',    'Referencia Promedio',  'Destino', 6.5),
      ('Arequipa', 'Comfort', 'long',       'Referencia Larga',     'Destino', 10.0),
      ('Arequipa', 'Comfort', 'very_long',  'Referencia Muy Larga', 'Destino', 15.0)
    ON CONFLICT DO NOTHING;

    -- 3. Intento de corregir observaciones existentes
    -- Si hay observaciones manuales en Arequipa/Comfort marcadas como 'very_long' 
    -- pero que tienen un distance_km pequeño, las re-categorizamos.
    UPDATE pricing_observations
    SET distance_bracket = 
      CASE 
        WHEN distance_km <= 1.94 THEN 'very_short'
        WHEN distance_km <= 3.19 THEN 'short'
        WHEN distance_km <= 4.11 THEN 'median'
        WHEN distance_km <= 5.60 THEN 'average'
        WHEN distance_km <= 8.76 THEN 'long'
        ELSE 'very_long'
      END
    WHERE city = 'Arequipa' 
      AND category = 'Comfort' 
      AND distance_bracket = 'very_long'
      AND distance_km IS NOT NULL;

END $$;
