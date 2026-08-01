-- ════════════════════════════════════════════════════════════════════════
-- simulate-permissions.sql — simulación del modelo de permisos genérico
-- (migs 187/188/189). Correr contra Supabase LOCAL, nunca producción.
--
--   docker exec -i supabase_db_pricing-ci-dashboard psql -U postgres -X \
--     < scripts/simulate-permissions.sql
--
-- LA PREGUNTA QUE RESPONDE: ¿el modelo es realmente genérico, o solo funciona
-- para la foto de roles de hoy? Todo el punto del diseño es que crear un rol,
-- o darle/quitarle una sección, NO requiera escribir SQL. Estas simulaciones
-- cambian permisos SOLO editando roles.permissions y verifican que la base
-- reaccione sola.
--
-- Todo corre dentro de una transacción que se REVIERTE al final: no deja
-- roles, usuarios ni filas de prueba. No toca auth.users (CLAUDE.md §2).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

\set ON_ERROR_STOP on
\pset pager off

-- ── Utilidades ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pg_temp.esperar(p_caso text, p_obtenido boolean, p_esperado boolean)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_obtenido IS DISTINCT FROM p_esperado THEN
    RAISE EXCEPTION E'\n  ✗ FALLA: %\n    esperado=% obtenido=%', p_caso, p_esperado, p_obtenido;
  ELSE
    RAISE NOTICE '  ok  %', p_caso;
  END IF;
END $$;

-- ¿Puede este usuario INSERTAR en esta tabla? Lo prueba de verdad: hace el
-- INSERT como `authenticated` con el JWT simulado y mira si RLS lo rebota.
-- Preguntarle a can_write_table() directamente NO alcanza — probaría la
-- función, no la política, que es donde estuvieron todas las fugas.
CREATE OR REPLACE FUNCTION pg_temp.puede_insertar(p_email text, p_sql text)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('SET LOCAL request.jwt.claims TO %L',
                 json_build_object('email', p_email, 'role', 'authenticated')::text);
  SET LOCAL ROLE authenticated;
  BEGIN
    EXECUTE p_sql;
    RESET ROLE;
    RETURN true;
  -- SOLO insufficient_privilege (42501), que es lo que levanta RLS al rebotar
  -- un WITH CHECK. Capturar además check_violation confundiría "no tenés
  -- permiso" con "el dato de prueba viola un CHECK de negocio", y un test mal
  -- escrito pasaría como si el permiso estuviera correctamente denegado.
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RETURN false;
  END;
END $$;

-- ── Escenario ─────────────────────────────────────────────────────────
-- Un rol NUEVO que no existía cuando se escribieron las políticas. Si el
-- modelo es genérico, tiene que funcionar sin que nadie toque SQL por él.
INSERT INTO roles (name, label, permissions)
VALUES ('qa_temp', 'QA temporal', '{"sections":["distances"],"countries":["Peru"]}'::jsonb);

INSERT INTO user_profiles (email, first_name, last_name, role_id, is_active)
VALUES ('qa.temp@local.test', 'QA', 'Temp', (SELECT id FROM roles WHERE name='qa_temp'), true);

\echo ''
\echo '════ 1. Rol nuevo con sections=[distances] ════'
DO $$ BEGIN
  PERFORM pg_temp.esperar('distances: escribe distance_references',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO distance_references (city,category,bracket,country,point_a,point_b)
         VALUES ('Lima','TukTuk','short','Peru','QA-A','QA-B')$q$), true);

  PERFORM pg_temp.esperar('NO escribe competitor_commissions (no tiene earnings)',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO competitor_commissions (country,competitor_name,commission_pct)
         VALUES ('Peru','QA-Comp',10)$q$), false);

  PERFORM pg_temp.esperar('NO escribe market_events (no tiene events)',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO market_events (country,city,event_date,event_type,description,impact)
         VALUES ('Peru','Lima',current_date,'otro','QA','bajo')$q$), false);
END $$;

\echo ''
\echo '════ 2. Se le AGREGA earnings — solo editando roles.permissions, sin SQL de políticas ════'
UPDATE roles SET permissions = '{"sections":["distances","earnings"],"countries":["Peru"]}'::jsonb
 WHERE name='qa_temp';

DO $$ BEGIN
  PERFORM pg_temp.esperar('ahora SÍ escribe competitor_commissions',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO competitor_commissions (country,competitor_name,commission_pct)
         VALUES ('Peru','QA-Comp2',11)$q$), true);

  PERFORM pg_temp.esperar('y competitor_bonuses',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO competitor_bonuses (country,competitor_name,bonus_type,threshold,bonus_amount)
         VALUES ('Peru','QA-Comp2','viajes',0,5)$q$), true);

  PERFORM pg_temp.esperar('sigue SIN market_events',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO market_events (country,city,event_date,event_type,description,impact)
         VALUES ('Peru','Lima',current_date,'otro','QA2','bajo')$q$), false);
END $$;

\echo ''
\echo '════ 3. Se le QUITA distances — debe perder ese permiso ════'
UPDATE roles SET permissions = '{"sections":["earnings"],"countries":["Peru"]}'::jsonb
 WHERE name='qa_temp';

DO $$ BEGIN
  PERFORM pg_temp.esperar('ya NO escribe distance_references',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO distance_references (city,category,bracket,country,point_a,point_b)
         VALUES ('Lima','TukTuk','short','Peru','QA-C','QA-D')$q$), false);

  PERFORM pg_temp.esperar('conserva earnings',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO competitor_commissions (country,competitor_name,commission_pct)
         VALUES ('Peru','QA-Comp3',12)$q$), true);
END $$;

\echo ''
\echo '════ 4. Aislamiento por país: countries=[Peru] no escribe Colombia ════'
DO $$ BEGIN
  PERFORM pg_temp.esperar('NO escribe una comisión de Colombia',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO competitor_commissions (country,competitor_name,commission_pct)
         VALUES ('Colombia','QA-CO',9)$q$), false);
END $$;

UPDATE roles SET permissions = '{"sections":["earnings"],"countries":["Peru","Colombia"]}'::jsonb
 WHERE name='qa_temp';

DO $$ BEGIN
  PERFORM pg_temp.esperar('al sumarle Colombia, ahora SÍ (tampoco tocó SQL)',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO competitor_commissions (country,competitor_name,commission_pct)
         VALUES ('Colombia','QA-CO2',9)$q$), true);
END $$;

\echo ''
\echo '════ 5. Escalación de privilegios: `access` NO concede escritura ════'
-- Es el caso más peligroso: un rol que pudiera escribir `roles` se
-- concedería a sí mismo cualquier permiso. Por eso `access` NO está en
-- section_write_grants y estas tablas siguen gateadas por is_admin().
UPDATE roles SET permissions = '{"sections":["access","earnings"],"countries":["Peru"]}'::jsonb
 WHERE name='qa_temp';

DO $$ BEGIN
  PERFORM pg_temp.esperar('con sections=[access] NO puede escribir roles',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO roles (name,label,permissions)
         VALUES ('qa_escalado','x','{"sections":["all"],"countries":["all"]}'::jsonb)$q$), false);

  PERFORM pg_temp.esperar('ni user_profiles (no puede auto-promoverse)',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO user_profiles (email,first_name,last_name,is_active)
         VALUES ('qa.escalado@local.test','x','y',true)$q$), false);
END $$;

\echo ''
\echo '════ 6. El comodín "all" sigue funcionando ════'
UPDATE roles SET permissions = '{"sections":["all"],"countries":["all"]}'::jsonb
 WHERE name='qa_temp';

DO $$ BEGIN
  PERFORM pg_temp.esperar('sections=[all] escribe cualquier tabla del mapa',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO market_events (country,city,event_date,event_type,description,impact)
         VALUES ('Peru','Lima',current_date,'otro','QA-all','bajo')$q$), true);

  -- Pero "all" NO es lo mismo que ser admin: `access` sigue fuera del mapa.
  PERFORM pg_temp.esperar('pero sections=[all] TAMPOCO escribe roles',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO roles (name,label,permissions)
         VALUES ('qa_escalado2','x','{}'::jsonb)$q$), false);
END $$;

\echo ''
\echo '════ 7. Usuario DESACTIVADO pierde todo ════'
UPDATE user_profiles SET is_active = false WHERE email='qa.temp@local.test';

DO $$ BEGIN
  PERFORM pg_temp.esperar('is_active=false no escribe nada',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO market_events (country,city,event_date,event_type,description,impact)
         VALUES ('Peru','Lima',current_date,'otro','QA-off','bajo')$q$), false);
END $$;

UPDATE user_profiles SET is_active = true WHERE email='qa.temp@local.test';

\echo ''
\echo '════ 8. Usuario SIN perfil (no invitado) no escribe ════'
DO $$ BEGIN
  PERFORM pg_temp.esperar('email desconocido no escribe',
    pg_temp.puede_insertar('desconocido@nadie.test',
      $q$INSERT INTO market_events (country,city,event_date,event_type,description,impact)
         VALUES ('Peru','Lima',current_date,'otro','QA-x','bajo')$q$), false);
END $$;

\echo ''
\echo '════ 9. Los DOS casos reales que originaron el diseño ════'
-- hub_expert + distances: reportado por un hub, parcheado a mano en la 181.
-- Ahora tiene que salir del modelo genérico, no de un parche.
UPDATE roles SET permissions = '{"sections":["dashboard","dataentry","rawdata","distances"],"countries":["Peru"]}'::jsonb
 WHERE name='qa_temp';
DO $$ BEGIN
  PERFORM pg_temp.esperar('caso hub_expert: guarda una ruta de referencia',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO distance_references (city,category,bracket,country,point_a,point_b)
         VALUES ('Lima','TukTuk','short','Peru','QA-E','QA-F')$q$), true);
END $$;

-- ms&e + earnings: 2 usuarios reales bloqueados hasta hoy.
UPDATE roles SET permissions = '{"sections":["dashboard","earnings","report"],"countries":["Peru"]}'::jsonb
 WHERE name='qa_temp';
DO $$ BEGIN
  PERFORM pg_temp.esperar('caso ms&e: guarda una comisión',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO competitor_commissions (country,competitor_name,commission_pct)
         VALUES ('Peru','QA-MSE',13)$q$), true);
END $$;

\echo ''
\echo '════ 10. Admin sigue pudiendo todo ════'
DO $$ BEGIN
  PERFORM pg_temp.esperar('admin escribe roles',
    pg_temp.puede_insertar('admin@local.test',
      $q$INSERT INTO roles (name,label,permissions)
         VALUES ('qa_admin_ok','x','{}'::jsonb)$q$), true);
  PERFORM pg_temp.esperar('admin escribe config',
    pg_temp.puede_insertar('admin@local.test',
      $q$INSERT INTO market_events (country,city,event_date,event_type,description,impact)
         VALUES ('Colombia','Bogota',current_date,'otro','QA-admin','bajo')$q$), true);
END $$;

\echo ''
\echo '════ 11. Lecturas cross-país cerradas (mig 189) ════'
DO $$
DECLARE v_vistas int;
BEGIN
  -- Sembrar una ruta de Colombia y mirarla como usuario de Perú.
  INSERT INTO distance_references (city,category,bracket,country,point_a,point_b)
  VALUES ('Bogota','Economy','short','Colombia','CO-A','CO-B');

  UPDATE roles SET permissions='{"sections":["distances"],"countries":["Peru"]}'::jsonb
   WHERE name='qa_temp';

  SET LOCAL request.jwt.claims TO '{"email":"qa.temp@local.test","role":"authenticated"}';
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_vistas FROM distance_references WHERE country='Colombia';
  RESET ROLE;

  PERFORM pg_temp.esperar('usuario de Peru NO ve rutas de Colombia', v_vistas = 0, true);
END $$;

\echo ''
\echo '════ 12. Sin drift de políticas ════'
DO $$
DECLARE v_drift int;
BEGIN
  SELECT count(*) INTO v_drift FROM (
    SELECT tablename, cmd FROM pg_policies WHERE schemaname='public'
    GROUP BY tablename, cmd HAVING count(*) > 1
  ) x;
  PERFORM pg_temp.esperar('ninguna tabla con 2+ políticas por comando', v_drift = 0, true);
END $$;

\echo ''
\echo '✓ TODAS LAS SIMULACIONES PASARON'
\echo '  (se revierte todo: no quedan roles, usuarios ni filas de prueba)'

ROLLBACK;
