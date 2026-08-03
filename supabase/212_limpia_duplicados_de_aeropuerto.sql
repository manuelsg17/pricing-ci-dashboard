-- ════════════════════════════════════════════════════════════════════════
-- 212 — limpia las copias que dejó el bug de la 211 (el borrado buscaba la
--       zona pre-trigger y las filas vivían en la post-trigger).
--
-- ⚠️  NO APLICADA A PRODUCCIÓN. Borra filas de `pricing_observations` en
--     producción: requiere autorización explícita del user nombrando tabla,
--     filas y motivo (CLAUDE.md §8), aparte de la de la 211.
--
-- ⚠️  APLICAR DESPUÉS DE LA 211. Si se corre antes, el bug sigue vivo y las
--     copias vuelven con el próximo guardado de cualquier hub.
--
-- ── EL ALCANCE ES ACOTADO A PROPÓSITO ───────────────────────────────────
-- En `pricing_observations` hay 27.454 filas que, agrupadas por ruta exacta
-- + dueño, tienen un hermano. **Solo 10.080 se borran acá.** El resto NO se
-- toca, y el motivo es la parte importante de esta migración:
--
--   ┌─ SE BORRA (10.080 copias, 2.472 grupos) ────────────────────────────┐
--   │ Aeropuerto · con dueño · desde 2026-07-31 (cuando entró el trigger  │
--   │ de zona de la mig 180, que es lo que dispara el bug).               │
--   │ FIRMA: 2.469 de los 2.472 grupos tienen EL MISMO PRECIO y difieren  │
--   │ solo en `observed_time` — que es la hora real de captura y se       │
--   │ re-estampa en CADA click de guardar (mig 148). O sea: la misma      │
--   │ medición escrita N veces, no N mediciones.                          │
--   └─────────────────────────────────────────────────────────────────────┘
--
--   ┌─ NO SE BORRA — Y NO SON DUPLICADOS. NO LAS LIMPIE NADIE. ───────────┐
--   │                                                                     │
--   │ ⚠️ CORREGIDO 2026-08-03 (revisión adversarial posterior). La versión │
--   │ original de este bloque decía que estas 17.374 filas eran duplicados │
--   │ "que necesitan su propio diagnóstico". ESO ERA UN ARMA CARGADA: dejó │
--   │ escrita, al lado, la clave de agrupación con la que borrarlas.       │
--   │                                                                     │
--   │ LA CLAVE DE ESTE ARCHIVO NO IDENTIFICA UNA OBSERVACIÓN: le falta     │
--   │ `observed_time`. Agregándolo, las 17.374 caen a 6.592 (-62%).        │
--   │ Descomposición medida en producción:                                │
--   │   · 12.188 (70%) son capturas a HORAS DISTINTAS = mediciones reales  │
--   │   ·  2.881 (17%) no tienen precio y la MV ya las descarta            │
--   │   ·  2.120 (12%) comparten ruta y minuto; de esas solo 1.451 son     │
--   │                  clones byte-a-byte con precio usable                │
--   │                                                                     │
--   │ Y el "63% con precios distintos" que la versión vieja leía como      │
--   │ señal de peligro es EVIDENCIA A FAVOR DE CONSERVARLAS: son capturas  │
--   │ separadas del mismo turno, con dispersión normal (ratio medio        │
--   │ max/min = 1,32; el 96% por debajo de 3x).                           │
--   │                                                                     │
--   │ COSTO MEDIDO DE BORRARLAS CON LA CLAVE DE ESTE ARCHIVO:             │
--   │   12.040 observaciones destruidas · 7.473 celdas del dashboard que   │
--   │   DESAPARECEN · 671 celdas con el promedio desviado >5% (máx 55,5%). │
--   │   Mecanismo: 5.675 grupos abarcan más de un `time_of_day`, así que   │
--   │   el "conservar la más nueva" deja celdas enteras sin ninguna fila.  │
--   │                                                                     │
--   │ Impacto de NO borrarlas: 12 celdas sobre 284.933 (0,004%) tienen el  │
--   │ promedio movido. Conservarlas es la opción correcta por lejos.       │
--   └─────────────────────────────────────────────────────────────────────┘
--
-- ── POR QUÉ EL ALCANCE DE ARRIBA SÍ ERA BORRABLE ────────────────────────
-- La duda razonable tras lo anterior: si `observed_time` distingue capturas,
-- ¿no habré borrado mediciones reales acá también? No, y esto se midió:
-- en el camino de la app, `observed_time` NO es la hora de medición sino el
-- reloj del click de Guardar (DataEntry.jsx estampa una sola marca por click,
-- igual para todas las filas de ese guardado — mig 148). Verificado en
-- producción: el 81% de las filas con dueño tiene `observed_time` a menos de
-- 2 minutos de su `uploaded_at`.
-- Por eso, para una fila de HUB, "mismo precio + distinta observed_time" es
-- la misma grilla guardada dos veces. Para una fila de EXCEL, en cambio, la
-- hora viene de la planilla y sí distingue capturas. De ahí que el alcance
-- de arriba (con dueño) sea borrable y el de abajo (sin dueño) no lo sea.
--
-- ── CUÁL SE CONSERVA ────────────────────────────────────────────────────
-- La MÁS NUEVA (`uploaded_at DESC, id DESC`). Es lo que habría quedado si el
-- DELETE hubiera funcionado: el último guardado del hub es su última palabra.
-- En los 3 grupos donde el precio cambió entre copias, conservar la nueva es
-- justamente lo correcto — el hub estaba corrigiendo.
--
-- ── SEGURIDAD DEL BORRADO ───────────────────────────────────────────────
-- Acotado (predicado explícito, nunca un DELETE sin WHERE), observable
-- (reporta antes/después) y verificable: la cuenta de grupos NO cambia, solo
-- desaparecen los hermanos sobrantes. Si el número no cuadra, aborta.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_grupos_antes   int;
  v_filas_antes    bigint;
  v_borradas       int;
  v_grupos_despues int;
  v_filas_despues  bigint;
  v_esperado       int;
BEGIN
  SELECT count(*), coalesce(sum(n),0) INTO v_grupos_antes, v_filas_antes
  FROM (
    SELECT count(*) AS n FROM pricing_observations
    WHERE data_source='manual' AND observed_date >= DATE '2026-07-31'
      AND city LIKE '%\_Airport\_%' AND uploaded_by IS NOT NULL
    GROUP BY country,city,observed_date,category,timeslot,distance_bracket,
             competition_name,point_a,point_b,zone,uploaded_by
    HAVING count(*) > 1
  ) g;

  v_esperado := (v_filas_antes - v_grupos_antes)::int;

  RAISE NOTICE '[212] a limpiar: % grupos, % filas → deberían quedar % (se borran %)',
    v_grupos_antes, v_filas_antes, v_grupos_antes, v_esperado;

  IF v_grupos_antes = 0 THEN
    RAISE NOTICE '[212] nada que limpiar — la 211 ya estaba puesta o no hay copias.';
    RETURN;
  END IF;

  -- El borrado. `rn > 1` = todo menos la más nueva de cada grupo.
  -- La subconsulta acota el universo con el MISMO predicado del conteo de
  -- arriba: nunca puede alcanzar una fila fuera del alcance declarado.
  WITH ranked AS (
    SELECT id, observed_date,
           row_number() OVER (
             PARTITION BY country,city,observed_date,category,timeslot,
                          distance_bracket,competition_name,point_a,point_b,
                          zone,uploaded_by
             ORDER BY uploaded_at DESC, id DESC) AS rn
    FROM pricing_observations
    WHERE data_source='manual' AND observed_date >= DATE '2026-07-31'
      AND city LIKE '%\_Airport\_%' AND uploaded_by IS NOT NULL
  )
  DELETE FROM pricing_observations p
  USING ranked r
  WHERE p.id = r.id AND p.observed_date = r.observed_date AND r.rn > 1;
  GET DIAGNOSTICS v_borradas = ROW_COUNT;

  SELECT count(*), coalesce(sum(n),0) INTO v_grupos_despues, v_filas_despues
  FROM (
    SELECT count(*) AS n FROM pricing_observations
    WHERE data_source='manual' AND observed_date >= DATE '2026-07-31'
      AND city LIKE '%\_Airport\_%' AND uploaded_by IS NOT NULL
    GROUP BY country,city,observed_date,category,timeslot,distance_bracket,
             competition_name,point_a,point_b,zone,uploaded_by
    HAVING count(*) > 1
  ) g;

  RAISE NOTICE '[212] borradas % filas · grupos con duplicado: % → %',
    v_borradas, v_grupos_antes, v_grupos_despues;

  -- Invariantes. Cualquiera que falle revierte la transacción entera.
  IF v_borradas <> v_esperado THEN
    RAISE EXCEPTION '[212] ABORTA: se borraron % filas y se esperaban %', v_borradas, v_esperado;
  END IF;
  IF v_grupos_despues <> 0 THEN
    RAISE EXCEPTION '[212] ABORTA: quedan % grupos con duplicados', v_grupos_despues;
  END IF;
END $$;

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- 1) Ningún grupo duplicado en el alcance limpiado:
--      SELECT count(*) FROM (
--        SELECT 1 FROM pricing_observations
--         WHERE data_source='manual' AND observed_date >= '2026-07-31'
--           AND city LIKE '%\_Airport\_%' AND uploaded_by IS NOT NULL
--         GROUP BY country,city,observed_date,category,timeslot,distance_bracket,
--                  competition_name,point_a,point_b,zone,uploaded_by
--        HAVING count(*) > 1) x;                                    → 0
--
-- 2) Lo que se decidió NO tocar sigue intacto:
--      las 17.374 copias fuera del alcance siguen ahí, a propósito.
--
-- 3) Ninguna celda quedó VACÍA por el borrado — de cada grupo sobrevive una:
--      el count de grupos antes == el count de filas de esas rutas después.
--
-- 4) Guardar de nuevo desde la app (con la 211 puesta) no vuelve a duplicar.
