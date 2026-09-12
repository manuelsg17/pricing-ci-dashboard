-- ════════════════════════════════════════════════════════════════════════
-- Mig 249 — el guardado de Ingresar CI podía duplicar rutas de TukTuk/
-- Aeropuerto cuando un admin editaba distance_thresholds a mitad de sesión:
-- el cliente seguía mandando el bracket viejo, y el DELETE de save_ci_batch
-- lo buscaba (o buscaba el nuevo) sin encontrar la fila real.
--
-- Reproduce el caso límite que invalidó el primer intento de fix (recalcular
-- el bracket EFECTIVO también para el DELETE) y confirma que la versión que
-- sí quedó (point_a/point_b como única llave cuando existen) lo resuelve.
--
-- Corre con `docker exec ... psql -U postgres` y revierte todo al final.
-- ════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
\pset pager off

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.ok(p_cond boolean, p_msg text, p_got text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond THEN
    RAISE NOTICE '  ok  % %', p_msg, COALESCE('→ ' || p_got, '');
  ELSE
    RAISE EXCEPTION 'FALLÓ: % %', p_msg, COALESCE('→ ' || p_got, '');
  END IF;
END $$;

INSERT INTO roles (name, label, permissions)
VALUES ('qa249_hub', 'QA 249 hub', '{"sections":["dataentry"],"countries":["Peru"]}'::jsonb)
ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions;

INSERT INTO user_profiles (email, role_id, is_active)
SELECT 'qa249.hub@local.test', id, true FROM roles WHERE name='qa249_hub'
ON CONFLICT (email) DO UPDATE SET role_id = EXCLUDED.role_id, is_active = true;

CREATE OR REPLACE FUNCTION pg_temp.como(p_email text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', p_email, 'role','authenticated')::text, true);
END $$;

DO $$
DECLARE
  r1 jsonb; r2 jsonb; v_n int; v_bracket_hoy text;
  rutas_bracket_viejo jsonb;
  filas_comunes jsonb;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '── 1 · EL BUG: umbrales cambian a mitad de sesión, cliente manda el bracket viejo ──';
  PERFORM pg_temp.como('qa249.hub@local.test');

  -- Umbrales de TukTuk/Lima ANTES del cambio del admin (simulado): con estos,
  -- 2.5 km cae en 'median' (very_short<=1, short<=2, median<=3).
  DELETE FROM distance_thresholds WHERE city='Lima' AND category='TukTuk';
  INSERT INTO distance_thresholds (country, city, category, bracket, max_km) VALUES
    ('Peru','Lima','TukTuk','very_short',1.0),
    ('Peru','Lima','TukTuk','short',2.0),
    ('Peru','Lima','TukTuk','median',3.0),
    ('Peru','Lima','TukTuk','average',5.0),
    ('Peru','Lima','TukTuk','long',8.0),
    ('Peru','Lima','TukTuk','very_long',NULL);

  filas_comunes := '[{"category":"TukTuk","competition_name":"Uber","timeslot":"Morning",
     "distance_bracket":"median","distance_km":2.5,"point_a":"QA_TT_A","point_b":"QA_TT_B",
     "observed_time":"09:00","price_without_discount":8.5,"year":2026,"week":33}]'::jsonb;

  -- 1er guardado: el cliente calculó 'median' con distance_references (que
  -- en este punto coincide con los umbrales vigentes).
  r1 := save_ci_batch('Peru','Lima', DATE '2026-08-17', 'VES',
    'qa249.hub@local.test',
    '[{"category":"TukTuk","timeslot":"Morning","bracket":"median",
       "point_a":"QA_TT_A","point_b":"QA_TT_B","competitors":["Uber"]}]'::jsonb,
    filas_comunes, 'qa249-t1', NULL, true);

  SELECT count(*) INTO v_n FROM pricing_observations
   WHERE city='Lima' AND point_a='QA_TT_A' AND observed_date='2026-08-17';
  PERFORM pg_temp.ok(v_n = 1, '1er guardado deja 1 fila', v_n::text);

  SELECT distance_bracket INTO v_bracket_hoy FROM pricing_observations
   WHERE city='Lima' AND point_a='QA_TT_A' AND observed_date='2026-08-17';
  PERFORM pg_temp.ok(v_bracket_hoy = 'median', 'guardada con bracket median', v_bracket_hoy);

  -- El admin edita los umbrales: ahora 2.5 km cae en 'average', no 'median'.
  UPDATE distance_thresholds SET max_km = 2.0 WHERE city='Lima' AND category='TukTuk' AND bracket='median';
  UPDATE distance_thresholds SET max_km = 2.3 WHERE city='Lima' AND category='TukTuk' AND bracket='short';

  -- 2do guardado, MISMA ruta, el cliente sigue mandando 'median' (su
  -- distance_references no se recalculó solo). Antes de esta migración:
  -- el DELETE buscaba distance_bracket='median' y SÍ lo encontraba (porque
  -- la fila vieja también decía 'median')... el bug real requiere que el
  -- valor GUARDADO haya sido escrito con un bracket, y el próximo guardado
  -- calcule OTRO — que es justo lo que pasa acá: la fila vieja quedó en
  -- 'median' (paso 1) pero HOY, con los umbrales nuevos, 2.5 km recalcula a
  -- 'average'. Sin el fix, el INSERT de esta segunda pasada escribiría
  -- 'median' de nuevo (el cliente no sabe que cambió) — el bug real es más
  -- sutil: el cliente en producción SÍ manda el bracket recalculado la
  -- primera vez que abre la pestaña después del cambio (distance_references
  -- se actualiza eventualmente), así que el mismatch ocurre ENTRE flujos.
  -- Para este test forzamos el escenario límite: el cliente manda 'median'
  -- (viejo) pero el bracket EFECTIVO de hoy es 'average' — el fix debe
  -- guardar 'average' y encontrar/reemplazar la fila vieja igual.
  r2 := save_ci_batch('Peru','Lima', DATE '2026-08-17', 'VES',
    'qa249.hub@local.test',
    '[{"category":"TukTuk","timeslot":"Morning","bracket":"median",
       "point_a":"QA_TT_A","point_b":"QA_TT_B","competitors":["Uber"]}]'::jsonb,
    filas_comunes, 'qa249-t1', NULL, true);

  SELECT count(*) INTO v_n FROM pricing_observations
   WHERE city='Lima' AND point_a='QA_TT_A' AND observed_date='2026-08-17';
  PERFORM pg_temp.ok(v_n = 1, '2do guardado sigue dejando 1 SOLA fila (no 2)', v_n::text);

  SELECT distance_bracket INTO v_bracket_hoy FROM pricing_observations
   WHERE city='Lima' AND point_a='QA_TT_A' AND observed_date='2026-08-17';
  PERFORM pg_temp.ok(v_bracket_hoy = 'average',
    'la fila sobreviviente quedó con el bracket EFECTIVO de hoy (average), no el viejo', v_bracket_hoy);

  RAISE NOTICE '';
  RAISE NOTICE '── 2 · Categorías sin ruta fija (Economy/Comfort) no cambian ──';
  r1 := save_ci_batch('Peru','Lima', DATE '2026-08-18', NULL,
    'qa249.hub@local.test',
    '[{"category":"Economy/Comfort","timeslot":"Morning","bracket":"median",
       "point_a":null,"point_b":null,"competitors":["Uber"]}]'::jsonb,
    '[{"category":"Economy/Comfort","competition_name":"Uber","timeslot":"Morning",
       "distance_bracket":"median","point_a":null,"point_b":null,
       "observed_time":"09:00","price_without_discount":12.0,"year":2026,"week":33}]'::jsonb,
    'qa249-t2', NULL, true);

  SELECT distance_bracket INTO v_bracket_hoy FROM pricing_observations
   WHERE city='Lima' AND category='Economy/Comfort' AND observed_date='2026-08-18'
     AND competition_name='Uber' AND point_a IS NULL;
  PERFORM pg_temp.ok(v_bracket_hoy = 'median',
    'sin point_a/point_b, el bracket que manda el cliente NO se toca', v_bracket_hoy);

  RAISE NOTICE '';
  RAISE NOTICE 'TODO OK ✓';
END $$;

ROLLBACK;
