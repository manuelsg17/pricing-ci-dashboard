-- ════════════════════════════════════════════════════════════════════════
-- Migración 248 — Dedupe de la carga masiva histórica duplicada en
--                 pricing_observations (pedido explícito del user, 2026-09-12)
--
-- POR QUÉ:
--   Investigando el pendiente de "duplicados de TukTuk" se encontró algo
--   mucho más grande: `pricing_observations` tiene varias cargas masivas
--   históricas (uploaded_by IS NULL, observed_date retroactivo) con rangos
--   de fecha que se SOLAPAN entre sí, sin que la carga más nueva haya
--   reemplazado a la vieja primero:
--
--     carga 2026-06-23 → 99.620 filas, observed_date 2025-07-01..2026-05-30
--     carga 2026-07-06 → 37.314 filas, observed_date 2026-03-07..2026-07-05
--     carga 2026-07-21 → 11.093 filas, observed_date 2026-05-22..2026-07-20
--
--   Los rangos 2026-03-07..2026-05-30 y 2026-05-22..2026-07-05 quedaron
--   cubiertos por DOS o TRES cargas a la vez. Verificado con GROUP BY por
--   ruta exacta (país+ciudad+zona+fecha+categoría+franja+bracket+competidor+
--   point_a+point_b): 16.857 filas sobran sobre 26.042 en grupos duplicados.
--
-- QUÉ NO ES:
--   NO es el mismo bug que el drift de bracket de TukTuk (documentado en
--   memoria de sesión, sin arreglar) — ahí `distance_bracket` DIFIERE entre
--   copias porque el cliente tenía un umbral cacheado viejo. Acá el 99.9% de
--   los grupos duplicados tienen el MISMO bracket: es la misma fila
--   reinsertada por una carga masiva que no reemplazó la anterior.
--
--   NO toca el patrón legítimo de "N hubs, N muestras" (Corp, verificado
--   2026-08-10): el criterio de "misma ruta" incluye SIEMPRE la igualdad
--   exacta y esto se acota a `uploaded_by IS NULL` — dos hubs reales (con
--   email distinto) que miden la misma ruta el mismo día NUNCA entran acá,
--   quedan con su propio uploaded_by y sus filas sobreviven intactas.
--
-- CRITERIO DE DEDUPE (validado con 4 casos sintéticos en local antes de
-- aplicar, incluido el caso adversarial que lo invalidaría):
--   1. Si el grupo tiene alguna fila con precio real (no_data=false), esa
--      SIEMPRE sobrevive sobre cualquier fila "sin oferta" (no_data=true) —
--      sin este orden, una carga posterior que marcó "sin oferta" por error
--      o por un scrape fallido habría borrado 12.789 precios reales para
--      quedarse con una fila vacía. Verificado: 0 casos donde esto ocurre
--      con el criterio final.
--   2. Entre filas con el mismo estado de no_data, sobrevive la de
--      `uploaded_at` más reciente — mismo criterio ya usado en este proyecto
--      para resolver conflictos de config duplicada (mig 239, "sobrevive la
--      fila más reciente").
--   3. Empate exacto de uploaded_at: sobrevive el id mayor (desempate
--      determinístico, no afecta el resultado en la práctica).
--
-- OJO — precios distintos entre "duplicados" (no son copias bit-a-bit):
--   en 6.766 grupos con 2+ filas de precio real, los precios difieren; en
--   ~4.174 la diferencia supera el 30%. No son la misma medición repetida
--   dos veces — probablemente cargas de fuentes/snapshots distintos para el
--   mismo rango de fechas. Se decidió igual quedarse con la más reciente
--   (mismo criterio que el resto del proyecto: la fuente más nueva gana),
--   con la salvedad de que TODA fila borrada queda respaldada completa en
--   `pricing_observations_dedup_backup_202609` — recuperable fila por fila
--   si algún análisis retrospectivo necesita el valor descartado.
--
-- SEGURIDAD: no toca RLS, grants, ni funciones — solo datos.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Paso 1 — Respaldo completo de cada fila que se va a borrar ──────────
CREATE TABLE IF NOT EXISTS public.pricing_observations_dedup_backup_202609 (
  LIKE public.pricing_observations INCLUDING ALL
);
COMMENT ON TABLE public.pricing_observations_dedup_backup_202609 IS
  'Respaldo de las filas borradas por la mig 248 (dedupe de carga masiva '
  'histórica duplicada, uploaded_by IS NULL). Recuperable fila por fila. '
  'No es una tabla operativa — no la usa la app.';

WITH grp AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY country, city, zone, observed_date, category, timeslot,
                        distance_bracket, competition_name, point_a, point_b
           ORDER BY no_data ASC, uploaded_at DESC, id DESC
         ) AS rn
  FROM public.pricing_observations
  WHERE data_source = 'manual' AND uploaded_by IS NULL
)
INSERT INTO public.pricing_observations_dedup_backup_202609
SELECT o.*
FROM public.pricing_observations o
JOIN grp ON grp.id = o.id
WHERE grp.rn > 1;

-- ── Paso 2 — Borrar los duplicados, dejar solo el sobreviviente ─────────
WITH grp AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY country, city, zone, observed_date, category, timeslot,
                        distance_bracket, competition_name, point_a, point_b
           ORDER BY no_data ASC, uploaded_at DESC, id DESC
         ) AS rn
  FROM public.pricing_observations
  WHERE data_source = 'manual' AND uploaded_by IS NULL
)
DELETE FROM public.pricing_observations o
USING grp
WHERE o.id = grp.id AND grp.rn > 1;

-- ── Verificación ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_backup int;
  v_restantes_duplicados int;
BEGIN
  SELECT count(*) INTO v_backup FROM public.pricing_observations_dedup_backup_202609;

  SELECT count(*) INTO v_restantes_duplicados FROM (
    SELECT 1
    FROM public.pricing_observations
    WHERE data_source = 'manual' AND uploaded_by IS NULL
    GROUP BY country, city, zone, observed_date, category, timeslot,
             distance_bracket, competition_name, point_a, point_b
    HAVING count(*) > 1
  ) x;

  RAISE NOTICE 'mig 248: % filas respaldadas y borradas, % grupos siguen duplicados (esperado: 0)',
    v_backup, v_restantes_duplicados;

  IF v_restantes_duplicados > 0 THEN
    RAISE EXCEPTION 'mig 248: quedaron % grupos duplicados sin resolver', v_restantes_duplicados;
  END IF;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- DESPUÉS DE APLICAR:
--   1. SELECT count(*) FROM pricing_observations_dedup_backup_202609;
--      -- esperado: 16.857
--   2. SELECT refresh_ci_aggregates(4000); -- los promedios históricos de
--      Trujillo/Arequipa Economy-Comfort y Comfort+ van a bajar de cobertura
--      (menos muestras, pero reales) — comparar contra el snapshot previo.
--   3. Si en unas semanas nadie necesitó recuperar una fila del respaldo,
--      es candidato a DROP TABLE — no antes, y con autorización puntual.
-- ════════════════════════════════════════════════════════════════════════
