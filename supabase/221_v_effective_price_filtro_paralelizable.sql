-- ════════════════════════════════════════════════════════════════════════
-- Migración 221 — v_effective_price: filtro TukTuk paralelizable
--
-- CONTEXTO: corrección de rendimiento de la migración 219, medida en
-- PRODUCCIÓN inmediatamente después de aplicarla (2026-08-28).
--
-- EL PROBLEMA (medido, no supuesto):
--   La mig 219 filtraba con
--       WHERE po.category = 'TukTuk' OR NOT EXISTS (SELECT 1 FROM tuktuk_routes ...)
--   El `OR` combinado con `NOT EXISTS` impide que el planner convierta la
--   subconsulta en un Anti Join: la degrada a un SubPlan hasheado, y eso
--   vuelve el nodo NO PARALELIZABLE. El plan perdió el `Gather`/`Parallel
--   Append` que tenía antes y pasó a Index Scan + Seq Scan seriales.
--
--   Medición del mismo scan (45 días, ~805k filas, producción):
--     · sin filtro (antes de mig 219) ............   655 ms   (paralelo)
--     · mig 219, OR + NOT EXISTS ................. 4.131 ms   (SERIAL)  ← 6,3x
--     · esta mig, LEFT JOIN ...................... 1.354 ms   (paralelo) ← 2,1x
--
--   Ojo con el diagnóstico fácil: el costo NO era leer tuktuk_routes. Ese
--   Seq Scan de 352 filas tarda 0,15 ms. El costo era la pérdida de
--   paralelismo que provocaba la forma de la expresión.
--
-- EL CAMBIO:
--   Misma semántica, expresada como LEFT JOIN + IS NULL, que el planner sí
--   resuelve como Hash Left Join paralelizable (hash de 352 filas, 49 kB).
--
--   Es seguro contra duplicación de filas porque tuktuk_routes tiene
--   CONSTRAINT tuktuk_routes_par_unico UNIQUE (point_a, point_b): cada fila
--   de pricing_observations puede casar con 1 fila del registro como máximo.
--
-- EQUIVALENCIA VERIFICADA en producción sobre las 2.197.975 filas, antes de
-- reemplazar la vista:
--     NOT EXISTS → 2.139.381 filas
--     LEFT JOIN  → 2.139.381 filas
--     sólo en una / sólo en la otra → 0 / 0
--     ids duplicados por el LEFT JOIN → 0
--
-- SEGURIDAD: sin cambios. Mantiene security_invoker = true. No toca
-- tuktuk_routes, ni sus políticas, ni sus grants.
--
-- ROLLBACK: re-aplicar la mig 219 (vuelve a la forma OR + NOT EXISTS, con la
-- penalización de rendimiento documentada arriba). El resultado de datos es
-- idéntico; sólo cambia el plan.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE VIEW public.v_effective_price
WITH (security_invoker = true) AS
SELECT
  po.id,
  po.country,
  po.city,
  po.year,
  po.week,
  po.observed_date,
  po.observed_time,
  po.time_of_day,
  po.category,
  po.zone,
  po.competition_name,
  po.distance_km,
  po.distance_bracket,
  po.surge,
  po.rush_hour,
  po.timeslot,
  po.data_source,
  po.upload_batch_id,
  CASE
    WHEN po.competition_name = 'InDrive'::text
     AND (COALESCE(po.bid_1, 0::numeric) + COALESCE(po.bid_2, 0::numeric)
        + COALESCE(po.bid_3, 0::numeric) + COALESCE(po.bid_4, 0::numeric)
        + COALESCE(po.bid_5, 0::numeric)) > 0::numeric
    THEN (COALESCE(NULLIF(po.bid_1, 0::numeric), 0::numeric)
        + COALESCE(NULLIF(po.bid_2, 0::numeric), 0::numeric)
        + COALESCE(NULLIF(po.bid_3, 0::numeric), 0::numeric)
        + COALESCE(NULLIF(po.bid_4, 0::numeric), 0::numeric)
        + COALESCE(NULLIF(po.bid_5, 0::numeric), 0::numeric))
        / NULLIF(
            CASE WHEN COALESCE(po.bid_1, 0::numeric) > 0::numeric THEN 1 ELSE 0 END +
            CASE WHEN COALESCE(po.bid_2, 0::numeric) > 0::numeric THEN 1 ELSE 0 END +
            CASE WHEN COALESCE(po.bid_3, 0::numeric) > 0::numeric THEN 1 ELSE 0 END +
            CASE WHEN COALESCE(po.bid_4, 0::numeric) > 0::numeric THEN 1 ELSE 0 END +
            CASE WHEN COALESCE(po.bid_5, 0::numeric) > 0::numeric THEN 1 ELSE 0 END, 0)::numeric
    ELSE COALESCE(po.price_without_discount, po.recommended_price)
  END AS effective_price
FROM public.pricing_observations po
-- ★ mig 221 — una ruta de TukTuk es SOLO para TukTuk.
--   LEFT JOIN + IS NULL en vez de OR + NOT EXISTS: misma semántica, pero
--   paralelizable (ver cabecera). Sin duplicación gracias al UNIQUE del
--   registro. Fail-open: si point_a/point_b es NULL no casa con el registro
--   (tr.point_a IS NULL) y la fila se conserva.
LEFT JOIN public.tuktuk_routes tr
       ON tr.point_a = po.point_a
      AND tr.point_b = po.point_b
WHERE tr.point_a IS NULL
   OR po.category = 'TukTuk';

COMMENT ON VIEW public.v_effective_price IS
  'Precio efectivo por observación (InDrive: promedio de bids reales si hay; '
  'resto: price_without_discount). mig 219/221: excluye observaciones de '
  'categorías de taxi sobre rutas registradas en tuktuk_routes (filtro por '
  'LEFT JOIN, paralelizable).';

COMMIT;
