-- ============================================================
-- MIGRACIÓN 07: Separar fuente de datos (bot vs manual)
-- Ejecutar en Supabase SQL Editor
-- ============================================================

-- 1. Agregar columna data_source
ALTER TABLE pricing_observations
  ADD COLUMN IF NOT EXISTS data_source TEXT DEFAULT 'manual';

-- 2. Marcar todas las existentes como 'manual'
UPDATE pricing_observations
  SET data_source = 'manual'
  WHERE data_source IS NULL;

-- 3. Índice para filtrar por fuente eficientemente
CREATE INDEX IF NOT EXISTS idx_po_source
  ON pricing_observations(data_source);

-- Verificación
SELECT data_source, COUNT(*) FROM pricing_observations GROUP BY data_source;
