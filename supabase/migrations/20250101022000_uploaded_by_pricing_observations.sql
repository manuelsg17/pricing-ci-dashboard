-- ════════════════════════════════════════════════════════════════════════
-- Migración 139 — uploaded_by en pricing_observations (atribución por hub +
-- guardado concurrente sin pisarse)
--
-- CONTEXTO 2026-07-21:
--   La carga manual ("Ingresar CI") guardaba con DELETE-por-scope + INSERT,
--   borrando TODAS las filas manuales de (país, ciudad, categoría, fecha,
--   franja) sin dueño. Resultado: si DOS hubs cargaban la misma ciudad+fecha,
--   el ÚLTIMO en guardar BORRABA lo del otro (clobbering silencioso).
--
--   Se agrega `uploaded_by` (email del hub que cargó la fila). El frontend:
--     · escribe uploaded_by = email del hub en cada fila manual;
--     · acota el DELETE a `uploaded_by = mi_email OR uploaded_by IS NULL`, así
--       cada hub solo reemplaza LO SUYO (y reclama las filas legacy sin dueño
--       en su primer guardado sobre ese scope);
--     · al reabrir una sesión del historial, carga solo las filas propias (+
--       legacy NULL), para no duplicar las de otro hub al re-guardar.
--   Dos hubs pueden así repartirse una misma sesión (por competidor, ruta o
--   franja) sin pisarse. Además da atribución por celda para el monitoreo
--   admin (fase siguiente).
--
--   `ADD COLUMN` nullable = metadata-only: NO reescribe la tabla (~1.2 GB), es
--   instantáneo. Las ~147k filas manuales legacy quedan con uploaded_by NULL
--   (se reclaman en el primer re-guardado). El bot escribe data_source='bot' y
--   NO usa esta columna. La MV de promedios agrupa por data_source (no por
--   uploaded_by), así que dos lecturas de la misma celda por dos hubs cuentan
--   como 2 observaciones reales (aceptable; los hubs se reparten el trabajo).
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.pricing_observations
  ADD COLUMN IF NOT EXISTS uploaded_by text;

-- Índice para el DELETE acotado por dueño y para el monitoreo por hub. Parcial
-- (solo filas manuales) — el bot no usa la columna, no vale la pena indexarlo.
CREATE INDEX IF NOT EXISTS idx_pobs_manual_uploaded_by
  ON public.pricing_observations (uploaded_by)
  WHERE data_source = 'manual';

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   SELECT column_name, is_nullable FROM information_schema.columns
--    WHERE table_name='pricing_observations' AND column_name='uploaded_by';
--   -- tras unos guardados nuevos:
--   SELECT uploaded_by, count(*) FROM pricing_observations
--    WHERE data_source='manual' GROUP BY uploaded_by ORDER BY 2 DESC;
-- ════════════════════════════════════════════════════════════════════════
