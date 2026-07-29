-- ════════════════════════════════════════════════════════════════════════
-- 174_drop_pricing_observations_old.sql — housekeeping post-particionado
-- (2026-07-29): borra la tabla de respaldo que quedó del particionado de
-- pricing_observations (migs 168-169, 26 jul). Ya no la usa ningún objeto
-- (confirmado con un barrido completo de vistas/materialized views/
-- funciones antes de este archivo — ver mig 173, que corrigió las 2 únicas
-- que la referenciaban).
--
-- DETALLE NO OBVIO: pricing_observations_id_seq seguía siendo "propiedad"
-- (OWNED BY) de pricing_observations_old.id en el catálogo de Postgres,
-- aunque la tabla real la usa activamente para generar sus IDs — un DROP
-- TABLE directo hubiera arrastrado la secuencia (CASCADE) y roto la
-- generación de IDs en pricing_observations y sus 19 particiones.
-- Postgres lo bloqueó solo (ERROR 2BP01). Fix: reasignar la propiedad de
-- la secuencia a la tabla real ANTES del DROP — solo metadata de catálogo,
-- no toca el valor actual de la secuencia ni ningún dato.
--
-- Autorizado explícitamente por el user (2026-07-29), nombrando la tabla
-- puntual, tras confirmar 2 veces que no hay dependencias externas.
-- ════════════════════════════════════════════════════════════════════════

ALTER SEQUENCE public.pricing_observations_id_seq
  OWNED BY public.pricing_observations.id;

DROP TABLE public.pricing_observations_old;
