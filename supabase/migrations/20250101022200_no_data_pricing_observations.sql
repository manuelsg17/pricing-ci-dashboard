-- ════════════════════════════════════════════════════════════════════════
-- Migración 141 — columna no_data en pricing_observations ("sin data" por celda)
--
-- CONTEXTO 2026-07-21:
--   En "Ingresar CI" un hub necesita poder marcar una celda como "S/D" (no había
--   oferta / el competidor no cotizó en ese momento) — hoy una celda vacía
--   bloquea el guardado (fila 'partial' = error) y es indistinguible de "todavía
--   no la cargué". Se agrega `no_data boolean` para registrar el INTENTO:
--     · una fila no_data=true va SIN precio (price_without_discount NULL, sin
--       bids/rec/eta/disc) → effective_price NULL → las MV de promedio la excluyen
--       (WHERE effective_price>0), así NO ensucia ningún promedio;
--     · destraba el guardado (la celda cuenta como "resuelta", no 'partial');
--     · queda auditable (distinto de "no medido").
--   La representatividad la usa en la mig siguiente (get_representativity con
--   no_data_n) para mostrar "atendida sin oferta" como estado aparte (no suma al
--   piso de muestras de precio, pero tampoco cuenta como celda faltante).
--
--   ADD COLUMN con DEFAULT false NOT NULL: en Postgres ≥11 es metadata-only (no
--   reescribe la tabla de ~1.2 GB) porque el default es constante. Las filas
--   existentes leen false sin backfill físico.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.pricing_observations
  ADD COLUMN IF NOT EXISTS no_data boolean NOT NULL DEFAULT false;

-- Índice parcial chico: las filas "sin data" son pocas y las consulta el panel
-- de representatividad por (país, año/semana). Solo indexa las true.
CREATE INDEX IF NOT EXISTS idx_pobs_no_data
  ON public.pricing_observations (country, year, week)
  WHERE no_data = true AND data_source = 'manual';

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   SELECT column_name, column_default, is_nullable FROM information_schema.columns
--    WHERE table_name='pricing_observations' AND column_name='no_data';
--   SELECT count(*) FROM pricing_observations WHERE no_data = true; -- 0 al inicio
-- ════════════════════════════════════════════════════════════════════════
