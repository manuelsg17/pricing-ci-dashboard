-- ════════════════════════════════════════════════════════════════════════
-- simulate-reasignar-destino.sql — mig 207. Supabase LOCAL, nunca producción.
--
--   docker exec -i supabase_db_pricing-ci-dashboard psql -U postgres -X \
--     < scripts/simulate-reasignar-destino.sql
--
-- LA PREGUNTA: ¿un relevo hacia un email equivocado deja de tragarse el trabajo
-- del hub? Y la contracara, que es la que importa igual o más: ¿el relevo
-- LEGÍTIMO sigue funcionando?
--
-- Corre como `authenticated` con JWT simulado. Transacción revertida.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

\set ON_ERROR_STOP on
\pset pager off

CREATE OR REPLACE FUNCTION pg_temp.esperar(p_caso text, p_obtenido text, p_esperado text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_obtenido IS DISTINCT FROM p_esperado THEN
    RAISE EXCEPTION E'\n  ✗ FALLA: %\n    esperado=% obtenido=%', p_caso, p_esperado, p_obtenido;
  END IF;
  RAISE NOTICE '  ok  % → %', p_caso, p_obtenido;
END $$;

-- Devuelve 'ok' | 'invalid_input' | 'denegado' | SQLSTATE. Se mira el texto del
-- error y no solo el estado: `invalid_input` y `nothing_to_reassign` comparten
-- SQLSTATE (P0001) y confundirlos haría pasar el test por el motivo equivocado.
CREATE OR REPLACE FUNCTION pg_temp.reasignar(p_admin text, p_to text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_msg text;
BEGIN
  EXECUTE format('SET LOCAL request.jwt.claims TO %L',
                 json_build_object('email', p_admin, 'role', 'authenticated')::text);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM admin_reassign_ci_session('Peru', 'Lima', '', current_date,
                                      'qa207.origen@local.test', p_to);
    RESET ROLE;
    RETURN 'ok';
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE; RETURN 'denegado';
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      RESET ROLE;
      RETURN split_part(v_msg, ':', 1);
  END;
END $$;

-- ── Elenco ────────────────────────────────────────────────────────────
INSERT INTO roles (name, label, permissions) VALUES
  ('qa207_hub_pe',   'QA hub PE',   '{"sections": ["dataentry"], "countries": ["Peru"]}'),
  ('qa207_hub_co',   'QA hub CO',   '{"sections": ["dataentry"], "countries": ["Colombia"]}');

-- El admin de prueba cuelga del rol 'admin' REAL, no de uno inventado:
-- `is_admin()` compara `r.name = 'admin'` literal, así que un rol de QA con
-- permisos amplios pero otro nombre NO es admin. La primera versión de este
-- script creaba uno propio y todo daba 'denegado' — el test habría "pasado"
-- por el motivo equivocado si hubiera esperado eso.
INSERT INTO user_profiles (email, role_id, is_active) VALUES
  ('qa207.admin@local.test',  (SELECT id FROM roles WHERE name = 'admin' LIMIT 1),  true),
  ('qa207.origen@local.test', (SELECT id FROM roles WHERE label = 'QA hub PE'), true),
  ('qa207.destino@local.test',(SELECT id FROM roles WHERE label = 'QA hub PE'), true),
  ('qa207.baja@local.test',   (SELECT id FROM roles WHERE label = 'QA hub PE'), false),
  ('qa207.colombia@local.test',(SELECT id FROM roles WHERE label = 'QA hub CO'), true);

-- Trabajo guardado del hub de origen — lo que un relevo mal hecho perdería.
INSERT INTO pricing_observations
  (country, city, zone, observed_date, category, competition_name, distance_bracket,
   price_without_discount, data_source, uploaded_by)
SELECT 'Peru', 'Lima', '', current_date, 'Economy/Comfort', 'Uber', 'short',
       10 + g, 'manual', 'qa207.origen@local.test'
FROM generate_series(1, 12) g;

DO $$
DECLARE v_admin text := 'qa207.admin@local.test';
BEGIN
  RAISE NOTICE E'\n── Destinos que la 207 rechaza ─────────────────────────';
  -- Antes de la 207 los tres decían 'ok' y se llevaban las 12 filas.
  PERFORM pg_temp.esperar('email inexistente (typo)',
                          pg_temp.reasignar(v_admin, 'qa207.destno@local.test'), 'invalid_input');
  PERFORM pg_temp.esperar('usuario dado de baja',
                          pg_temp.reasignar(v_admin, 'qa207.baja@local.test'), 'invalid_input');
  PERFORM pg_temp.esperar('hub sin acceso al país',
                          pg_temp.reasignar(v_admin, 'qa207.colombia@local.test'), 'invalid_input');
  PERFORM pg_temp.esperar('email vacío',
                          pg_temp.reasignar(v_admin, '   '), 'invalid_input');
END $$;

-- Nada de lo anterior tocó una sola fila: es el punto entero.
DO $$
DECLARE v_quedan int;
BEGIN
  SELECT count(*) INTO v_quedan FROM pricing_observations
  WHERE uploaded_by = 'qa207.origen@local.test' AND observed_date = current_date;
  PERFORM pg_temp.esperar('las 12 filas siguen siendo del hub original',
                          v_quedan::text, '12');
END $$;

-- ── Y el relevo legítimo, que es lo que no se puede romper ────────────
DO $$
DECLARE v_r text; v_destino int; v_origen int;
BEGIN
  RAISE NOTICE E'\n── El relevo real ──────────────────────────────────────';
  -- A propósito con OTRO CASING: el admin tipea como se le ocurre y el
  -- uploaded_by tiene que quedar con el casing de user_profiles, o el auto-load
  -- del destino (que compara exacto) no encontraría nada.
  v_r := pg_temp.reasignar('qa207.admin@local.test', 'QA207.Destino@Local.Test');
  PERFORM pg_temp.esperar('reasignar a un hub válido', v_r, 'ok');

  SELECT count(*) INTO v_destino FROM pricing_observations
  WHERE uploaded_by = 'qa207.destino@local.test' AND observed_date = current_date;
  SELECT count(*) INTO v_origen FROM pricing_observations
  WHERE uploaded_by = 'qa207.origen@local.test' AND observed_date = current_date;

  PERFORM pg_temp.esperar('las 12 filas quedaron en el destino', v_destino::text, '12');
  PERFORM pg_temp.esperar('y ninguna en el origen', v_origen::text, '0');
  -- Acotado a los emails de prueba: la base local tiene otras filas de Lima/hoy
  -- y un DISTINCT abierto traía más de una.
  PERFORM pg_temp.esperar('el casing es el de user_profiles, no el tipeado',
    (SELECT DISTINCT uploaded_by FROM pricing_observations
     WHERE observed_date = current_date
       AND uploaded_by ILIKE 'qa207.%@local.test'),
    'qa207.destino@local.test');
END $$;

-- ── El gate de admin sigue donde estaba ───────────────────────────────
DO $$
BEGIN
  RAISE NOTICE E'\n── No-admin ────────────────────────────────────────────';
  PERFORM pg_temp.esperar('un hub no puede reasignar',
    pg_temp.reasignar('qa207.destino@local.test', 'qa207.origen@local.test'), 'denegado');
END $$;

ROLLBACK;
