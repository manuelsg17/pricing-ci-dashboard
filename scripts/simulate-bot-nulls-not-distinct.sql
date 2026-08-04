-- ════════════════════════════════════════════════════════════════════════
-- Mig 213 — el índice único del bot deja pasar duplicados con bracket NULL.
--
-- Lo que hay que probar no es solo que el duplicado deje de entrar: es que
-- `bot_upsert_observations` SIGA funcionando. Su `ON CONFLICT` infiere el
-- índice por columnas + predicado, y si esa inferencia dejara de resolver con
-- el flag nuevo, el sync horario del bot se rompería entero — un precio mucho
-- más alto que los 302 clones que esto viene a limpiar.
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

-- Inserta una observación del bot por el MISMO camino que el sync real.
-- OJO con `distance_km`: el trigger de campos computados DERIVA el bracket de
-- la distancia, así que mandarla haría que `distance_bracket` NUNCA quede NULL
-- y el escenario del agujero sería irreproducible. Va NULL a propósito — es la
-- condición exacta de las 302 filas reales de Kathmandu.
CREATE OR REPLACE FUNCTION pg_temp.fila_bot(p_bracket text, p_precio numeric)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO pricing_observations
    (country, city, observed_date, observed_time, category, competition_name,
     distance_bracket, surge, data_source, price_without_discount, year, week,
     point_a, point_b, distance_km)
  VALUES ('Nepal','QAktm','2026-04-07','10:00','Economy/Comfort','Yango',
          p_bracket, false, 'bot', p_precio, 2026, 15, 'QA_A','QA_B',
          CASE WHEN p_bracket IS NULL THEN NULL ELSE 3.2 END);
END $$;

-- Rebobinar al estado PRE-fix. Sin esto el script solo se podría correr una
-- vez —antes de aplicar la mig 213— y un test que deja de correr en cuanto se
-- arregla el bug no sirve para detectar que el bug VUELVA. Todo revierte con
-- el ROLLBACK del final.
DROP INDEX IF EXISTS public.ux_po_bot_natural_key;
CREATE UNIQUE INDEX ux_po_bot_natural_key
  ON public.pricing_observations
  USING btree (country, city, observed_date, observed_time, category,
               competition_name, distance_bracket, surge, data_source)
  WHERE (data_source = 'bot');

DO $$
DECLARE v_n int;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '── 1 · El agujero, ANTES del fix ────────────────────────────';
  PERFORM pg_temp.fila_bot(NULL, 100);
  PERFORM pg_temp.fila_bot(NULL, 113);   -- mismo todo, otro precio
  SELECT count(*) INTO v_n FROM pricing_observations
   WHERE city='QAktm' AND data_source='bot';
  PERFORM pg_temp.ok(v_n = 2,
    'con bracket NULL entran DOS filas: el índice no las considera iguales', v_n::text);

  -- Con bracket NO nulo el índice sí protege, y eso es lo que hace que el
  -- agujero sea invisible salvo en el caso exacto.
  BEGIN
    PERFORM pg_temp.fila_bot('median', 100);
    PERFORM pg_temp.fila_bot('median', 113);
    PERFORM pg_temp.ok(false, 'con bracket NO nulo debería haber rebotado');
  EXCEPTION WHEN unique_violation THEN
    PERFORM pg_temp.ok(true, 'con bracket NO nulo el índice SÍ rechaza el duplicado');
  END;
END $$;

-- ── El fix ─────────────────────────────────────────────────────────────
DO $$
DECLARE v_borradas int;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '── 2 · Aplicando el fix (limpieza + índice) ─────────────────';
  WITH ranked AS (
    SELECT id, observed_date,
           row_number() OVER (
             PARTITION BY country, city, observed_date, observed_time, category,
                          competition_name, distance_bracket, surge
             ORDER BY id DESC) AS rn
    FROM pricing_observations WHERE data_source='bot'
  )
  DELETE FROM pricing_observations p USING ranked r
  WHERE p.id = r.id AND p.observed_date = r.observed_date AND r.rn > 1;
  GET DIAGNOSTICS v_borradas = ROW_COUNT;
  PERFORM pg_temp.ok(v_borradas >= 1, 'la limpieza borró los clones', v_borradas::text);
END $$;

DROP INDEX IF EXISTS public.ux_po_bot_natural_key;
CREATE UNIQUE INDEX ux_po_bot_natural_key
  ON public.pricing_observations
  USING btree (country, city, observed_date, observed_time, category,
               competition_name, distance_bracket, surge, data_source)
  NULLS NOT DISTINCT
  WHERE (data_source = 'bot');

DO $$
DECLARE v_flag boolean; v_valido boolean; v_hijos int; v_n int; v_precio numeric;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '── 3 · El índice quedó bien formado ─────────────────────────';
  SELECT ix.indnullsnotdistinct, ix.indisvalid,
         (SELECT count(*) FROM pg_inherits WHERE inhparent = ix.indexrelid)
    INTO v_flag, v_valido, v_hijos
  FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid
  WHERE c.relname = 'ux_po_bot_natural_key';

  PERFORM pg_temp.ok(v_flag, 'NULLS NOT DISTINCT activo', v_flag::text);
  PERFORM pg_temp.ok(v_valido, 'el índice es válido', v_valido::text);
  PERFORM pg_temp.ok(v_hijos > 0,
    'y quedó adjunto a las particiones (si no, no enforza nada)', v_hijos::text);

  RAISE NOTICE '';
  RAISE NOTICE '── 4 · El agujero, DESPUÉS ─────────────────────────────────';
  BEGIN
    PERFORM pg_temp.fila_bot(NULL, 999);
    PERFORM pg_temp.ok(false, 'un duplicado con bracket NULL debería rebotar ahora');
  EXCEPTION WHEN unique_violation THEN
    PERFORM pg_temp.ok(true, 'con bracket NULL el duplicado YA rebota');
  END;
END $$;

DO $$
DECLARE v_n int; v_precio numeric;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '── 5 · EL QUE IMPORTA: el sync del bot sigue funcionando ────';
  -- Si la inferencia del ON CONFLICT dejara de resolver, el sync horario se
  -- rompe entero. Se prueba por el camino REAL, no con un INSERT a mano.
  PERFORM bot_upsert_observations(
    jsonb_build_array(jsonb_build_object(
      'country','Nepal','city','QAktm2','observed_date','2026-04-07',
      'observed_time','11:00','category','Economy/Comfort','competition_name','Yango',
      'distance_bracket', NULL, 'surge', false,
      'price_without_discount', 200, 'year', 2026, 'week', 15,
      'point_a','QA_A','point_b','QA_B')));

  SELECT count(*) INTO v_n FROM pricing_observations WHERE city='QAktm2';
  PERFORM pg_temp.ok(v_n = 1, 'el upsert insertó la fila nueva', v_n::text);

  -- El MISMO lote otra vez: debe ACTUALIZAR, no insertar.
  PERFORM bot_upsert_observations(
    jsonb_build_array(jsonb_build_object(
      'country','Nepal','city','QAktm2','observed_date','2026-04-07',
      'observed_time','11:00','category','Economy/Comfort','competition_name','Yango',
      'distance_bracket', NULL, 'surge', false,
      'price_without_discount', 250, 'year', 2026, 'week', 15,
      'point_a','QA_A','point_b','QA_B')));

  SELECT count(*), max(price_without_discount) INTO v_n, v_precio
    FROM pricing_observations WHERE city='QAktm2';
  PERFORM pg_temp.ok(v_n = 1,
    'el segundo lote NO duplicó — el ON CONFLICT sigue infiriendo el índice', v_n::text);
  PERFORM pg_temp.ok(v_precio = 250,
    'y ACTUALIZÓ el precio: gana el último, que es la semántica declarada', v_precio::text);
END $$;

DO $$ BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '✓ TODAS LAS SIMULACIONES DE LA 213 PASARON';
END $$;

ROLLBACK;
