-- ════════════════════════════════════════════════════════════════════════
-- Migración 118 — Backfill: etiqueta zone de las filas de aeropuerto ya cargadas
--
-- CONTEXTO:
--   Antes de mig 117 el sync del bot ponía zone=NULL en data de aeropuerto, y
--   algunas cargas manuales de aeropuerto tampoco traían zone. Quedaron filas
--   en ciudades _Airport_A / _Airport_B con zone vacío → inconsistente con el
--   resto (la data manual de aeropuerto sí trae zone='Airport_A'/'Airport_B') y
--   el selector de Zona del dashboard las mostraba en blanco.
--
--   Filas afectadas (Perú, snapshot 2026-06-21):
--     · Arequipa_Airport_B  → bot 1742 + manual 411
--     · Lima_Airport_A      → manual 104
--     · Lima_Airport_B      → manual 119
--     (Arequipa_Airport_A, Trujillo_*, Lima_* con zone ya seteado: sin cambios.)
--
-- APPROACH:
--   Toda fila en una ciudad split de aeropuerto debe llevar como zone el tag de
--   su lado: '_Airport_A' → 'Airport_A', '_Airport_B' → 'Airport_B' (= el
--   right(city,1) prefijado con 'Airport_'). Idempotente: el predicado
--   `zone IS DISTINCT FROM <target>` hace que re-correr no toque nada. No
--   sobreescribe distritos ni tags correctos (no había ninguno mal: verificado
--   antes de correr, 0 zones inesperados).
--
-- NOTA: backfill explícito de datos (no DDL), al estilo mig 81. El ruteo a
--   futuro lo garantiza el trigger de mig 83 + el passthrough de zone de mig 117.
-- ════════════════════════════════════════════════════════════════════════

UPDATE pricing_observations
SET zone = ('Airport_' || right(city, 1))
WHERE country = 'Peru'
  AND (right(city, 10) = '_Airport_A' OR right(city, 10) = '_Airport_B')
  AND zone IS DISTINCT FROM ('Airport_' || right(city, 1));

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN:
--   SELECT count(*) FILTER (
--     WHERE zone IS DISTINCT FROM ('Airport_' || right(city,1))
--   ) AS remaining_mismatches
--   FROM pricing_observations
--   WHERE country='Peru'
--     AND (right(city,10)='_Airport_A' OR right(city,10)='_Airport_B');
--   -- esperás: 0
--
--   El selector de Zona del dashboard refleja el cambio tras el refresh horario
--   de la MV (pg_cron @ :10) o un REFRESH MATERIALIZED VIEW CONCURRENTLY manual.
-- ════════════════════════════════════════════════════════════════════════
