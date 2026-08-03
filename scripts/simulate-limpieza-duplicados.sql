-- ════════════════════════════════════════════════════════════════════════
-- Mig 212 — la limpieza de duplicados de aeropuerto.
--
-- Lo que hay que probar NO es solo que borre: es que **no se lleve puesto
-- nada de lo que decidió no tocar**. Un backfill que borra de más es peor
-- que el duplicado que venía a limpiar.
--
-- Siembra las 4 clases de fila que hay en producción, corre la limpieza real
-- y verifica las dos mitades: lo que debe desaparecer y lo que debe quedar.
--
-- Corre con `docker exec ... psql -U postgres` y revierte todo al final.
-- ════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
\pset pager off

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.ok(p_cond boolean, p_msg text, p_got text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond THEN RAISE NOTICE '  ok  % %', p_msg, COALESCE('→ ' || p_got, '');
  ELSE RAISE EXCEPTION 'FALLÓ: % %', p_msg, COALESCE('→ ' || p_got, '');
  END IF;
END $$;

INSERT INTO airport_markers (country, base_city, city_from, city_to,
                             zone_from_value, zone_to_value, active)
VALUES ('Peru','QAlimp','QAlimp_Airport_A','QAlimp_Airport_B','Airport_A','Airport_B',true)
ON CONFLICT (country, base_city) DO UPDATE SET active = true;

CREATE OR REPLACE FUNCTION pg_temp.fila(
  p_city text, p_zone text, p_fecha date, p_hora time, p_precio numeric,
  p_dueno text, p_pb text DEFAULT 'QB'
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO pricing_observations
    (country, city, zone, observed_date, observed_time, category, competition_name,
     distance_bracket, timeslot, point_a, point_b, price_without_discount,
     data_source, year, week, uploaded_by, uploaded_at)
  VALUES ('Peru', p_city, p_zone, p_fecha, p_hora, 'Economy/Comfort','Uber',
          'median','Morning','QA', p_pb, p_precio, 'manual', 2026, 31, p_dueno,
          p_fecha + p_hora)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ── Siembra ────────────────────────────────────────────────────────────
DO $$
DECLARE v_keep bigint;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '── Sembrando las 4 clases que hay en producción ─────────────';

  -- [A] EN ALCANCE: aeropuerto, con dueño, post-31/07, mismo precio,
  --     distinta hora. Es la firma exacta del bug. 3 copias → deben quedar 1.
  PERFORM pg_temp.fila('QAlimp_Airport_A', NULL, '2026-08-01','10:00', 20.5,'hub@qa.test');
  PERFORM pg_temp.fila('QAlimp_Airport_A', NULL, '2026-08-01','10:30', 20.5,'hub@qa.test');
  v_keep := pg_temp.fila('QAlimp_Airport_A', NULL, '2026-08-01','11:00', 20.5,'hub@qa.test');
  PERFORM set_config('qa.keep', v_keep::text, true);

  -- [B] FUERA: mismo caso pero ANTERIOR al 31/07 → otra causa, no se toca.
  PERFORM pg_temp.fila('QAlimp_Airport_A', NULL, '2026-07-20','10:00', 30.0,'hub@qa.test');
  PERFORM pg_temp.fila('QAlimp_Airport_A', NULL, '2026-07-20','10:30', 30.0,'hub@qa.test');

  -- [C] FUERA: SIN dueño (carga de Excel) → 9.185 grupos así en prod.
  PERFORM pg_temp.fila('QAlimp_Airport_B', NULL, '2026-08-01','10:00', 40.0, NULL);
  PERFORM pg_temp.fila('QAlimp_Airport_B', NULL, '2026-08-01','10:30', 40.0, NULL);

  -- [D] FUERA: no es aeropuerto (TukTuk) → el bug no lo alcanza.
  PERFORM pg_temp.fila('Lima', 'Comas', '2026-08-01','10:00', 5.0,'hub@qa.test');
  PERFORM pg_temp.fila('Lima', 'Comas', '2026-08-01','10:30', 5.0,'hub@qa.test');

  -- [E] EN ALCANCE pero SIN hermano: una celda normal que no debe tocarse.
  PERFORM pg_temp.fila('QAlimp_Airport_A', NULL, '2026-08-02','09:00', 77.0,'hub@qa.test','SOLA');
END $$;

-- ── La limpieza REAL (mismo predicado que la mig 212) ──────────────────
DO $$
DECLARE v_borradas int;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '── Corriendo la limpieza ────────────────────────────────────';
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
  DELETE FROM pricing_observations p USING ranked r
  WHERE p.id = r.id AND p.observed_date = r.observed_date AND r.rn > 1;
  GET DIAGNOSTICS v_borradas = ROW_COUNT;
  PERFORM pg_temp.ok(v_borradas = 2, 'borró exactamente las 2 copias sobrantes de [A]', v_borradas::text);
END $$;

-- ── Lo que TENÍA que pasar ─────────────────────────────────────────────
DO $$
DECLARE v_n int; v_id bigint; v_precio numeric;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '── [A] en alcance: queda UNA, y es la más nueva ─────────────';
  SELECT count(*) INTO v_n FROM pricing_observations
   WHERE city='QAlimp_Airport_A' AND observed_date='2026-08-01' AND point_b='QB';
  PERFORM pg_temp.ok(v_n = 1, 'sobrevive una sola fila', v_n::text);

  SELECT id, price_without_discount INTO v_id, v_precio FROM pricing_observations
   WHERE city='QAlimp_Airport_A' AND observed_date='2026-08-01' AND point_b='QB';
  PERFORM pg_temp.ok(v_id = current_setting('qa.keep')::bigint,
    'y es la ÚLTIMA que guardó el hub, no una cualquiera', v_id::text);
  PERFORM pg_temp.ok(v_precio = 20.5, 'con su precio intacto', v_precio::text);
END $$;

DO $$
DECLARE v_n int;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '── Lo que NO se debía tocar sigue entero ────────────────────';

  SELECT count(*) INTO v_n FROM pricing_observations
   WHERE city='QAlimp_Airport_A' AND observed_date='2026-07-20';
  PERFORM pg_temp.ok(v_n = 2, '[B] anterior al 31/07 — intacto (otra causa)', v_n::text);

  SELECT count(*) INTO v_n FROM pricing_observations
   WHERE city='QAlimp_Airport_B' AND observed_date='2026-08-01' AND uploaded_by IS NULL;
  PERFORM pg_temp.ok(v_n = 2, '[C] sin dueño (Excel) — intacto', v_n::text);

  SELECT count(*) INTO v_n FROM pricing_observations
   WHERE city='Lima' AND zone='Comas' AND observed_date='2026-08-01' AND point_a='QA';
  PERFORM pg_temp.ok(v_n = 2, '[D] TukTuk — intacto', v_n::text);

  SELECT count(*) INTO v_n FROM pricing_observations
   WHERE city='QAlimp_Airport_A' AND observed_date='2026-08-02' AND point_b='SOLA';
  PERFORM pg_temp.ok(v_n = 1, '[E] celda sin hermano — intacta', v_n::text);
END $$;

DO $$
DECLARE v_n int;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '── Invariante: ninguna celda quedó VACÍA ────────────────────';
  -- Lo más grave que podría hacer un backfill así: borrar TODAS las copias
  -- de un grupo y dejar la celda sin ningún dato.
  SELECT count(*) INTO v_n FROM (
    SELECT 1 FROM pricing_observations
     WHERE data_source='manual' AND observed_date >= DATE '2026-07-31'
       AND city LIKE '%\_Airport\_%' AND uploaded_by IS NOT NULL
     GROUP BY country,city,observed_date,category,timeslot,distance_bracket,
              competition_name,point_a,point_b,zone,uploaded_by
    HAVING count(*) <> 1
  ) x;
  PERFORM pg_temp.ok(v_n = 0, 'toda ruta del alcance tiene exactamente 1 fila', v_n::text);
END $$;

DO $$ BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '✓ TODAS LAS SIMULACIONES DE LA 212 PASARON';
END $$;

ROLLBACK;
