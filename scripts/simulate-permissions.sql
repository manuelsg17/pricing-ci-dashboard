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

  PERFORM pg_temp.esperar('NO escribe competitor_commissions (no tiene config)',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO competitor_commissions (country,competitor_name,commission_pct)
         VALUES ('Peru','QA-Comp',10)$q$), false);

  PERFORM pg_temp.esperar('NO escribe market_events (no tiene events)',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO market_events (country,city,event_date,event_type,description,impact)
         VALUES ('Peru','Lima',current_date,'otro','QA','bajo')$q$), false);
END $$;

\echo ''
\echo '════ 2. Se le AGREGA config — solo editando roles.permissions, sin SQL de políticas ════'
UPDATE roles SET permissions = '{"sections":["distances","config"],"countries":["Peru"]}'::jsonb
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
UPDATE roles SET permissions = '{"sections":["config"],"countries":["Peru"]}'::jsonb
 WHERE name='qa_temp';

DO $$ BEGIN
  PERFORM pg_temp.esperar('ya NO escribe distance_references',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO distance_references (city,category,bracket,country,point_a,point_b)
         VALUES ('Lima','TukTuk','short','Peru','QA-C','QA-D')$q$), false);

  PERFORM pg_temp.esperar('conserva config',
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

UPDATE roles SET permissions = '{"sections":["config"],"countries":["Peru","Colombia"]}'::jsonb
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
UPDATE roles SET permissions = '{"sections":["access","config"],"countries":["Peru"]}'::jsonb
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
UPDATE roles SET permissions = '{"sections":["dashboard","config"],"countries":["Peru"]}'::jsonb
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

-- ════════════════════════════════════════════════════════════════════════
-- BLOQUES 13-22 — los casos que las 22 aserciones originales NO cubrían.
--
-- Las primeras 12 probaban el camino feliz del modelo genérico: un rol al que
-- se le agrega y se le quita una sección. Faltaban las formas en que el user
-- va a usar esto de verdad — un rol vacío, un rol solo-lectura, dos roles con
-- la misma sección, una sección mal escrita, sacarle todo a alguien que está
-- trabajando — y los caminos que el modelo todavía no cubría cuando se
-- escribieron: las tablas con gate 'admin'/'owner' (mig 192) y las RPCs
-- (mig 193).
-- ════════════════════════════════════════════════════════════════════════

-- ¿Puede este usuario EJECUTAR esto? Mismo mecanismo que puede_insertar
-- (JWT simulado + rol authenticated + solo 42501), con otro nombre porque acá
-- lo que se prueba es una RPC, no una política.
CREATE OR REPLACE FUNCTION pg_temp.puede_ejecutar(p_email text, p_sql text)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('SET LOCAL request.jwt.claims TO %L',
                 json_build_object('email', p_email, 'role', 'authenticated')::text);
  SET LOCAL ROLE authenticated;
  BEGIN
    EXECUTE p_sql;
    RESET ROLE;
    RETURN true;
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RETURN false;
  END;
END $$;

\echo ''
\echo '════ 13. Las tablas del mapa con gate admin/owner NO se conceden (mig 192) ════'
-- La 187 protegía `roles`/`user_profiles` por AUSENCIA: no estaban en el mapa.
-- Una ausencia no se defiende sola — el día que alguien agregara la fila "de
-- buena fe" abriría una escalación. Ahora la fila EXISTE, con gate='admin', y
-- sigue sin conceder. Esta es la aserción que antes no se podía escribir.
DO $$
DECLARE v_gate text;
BEGIN
  SELECT gate INTO v_gate FROM section_write_grants
   WHERE section='access' AND table_name='roles';
  PERFORM pg_temp.esperar('access→roles está DECLARADO en el mapa', v_gate IS NOT NULL, true);
  PERFORM pg_temp.esperar('…y su gate es admin (declarado, no concedido)', v_gate = 'admin', true);
END $$;

UPDATE roles SET permissions = '{"sections":["access"],"countries":["Peru"]}'::jsonb
 WHERE name='qa_temp';

DO $$ BEGIN
  PERFORM pg_temp.esperar('con la fila presente, sections=[access] sigue SIN escribir roles',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO roles (name,label,permissions) VALUES ('qa_esc3','x','{}'::jsonb)$q$), false);

  PERFORM pg_temp.esperar('can_write_table ignora las filas gate=admin',
    (SELECT NOT can_write_table('roles')
       FROM (SELECT set_config('request.jwt.claims',
              '{"email":"qa.temp@local.test","role":"authenticated"}', true)) _), true);
END $$;

\echo ''
\echo '════ 14. Un rol de SOLO LECTURA no escribe nada ════'
-- `report` y `competitividad` no están en el mapa a propósito: son pantallas
-- de lectura. El rol debe verlas y no poder escribir en ningún lado.
UPDATE roles SET permissions = '{"sections":["report","competitividad"],"countries":["Peru"]}'::jsonb
 WHERE name='qa_temp';

DO $$ BEGIN
  PERFORM pg_temp.esperar('solo-lectura: no escribe distance_references',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO distance_references (city,category,bracket,country,point_a,point_b)
         VALUES ('Lima','TukTuk','short','Peru','QA-RO','QA-RO')$q$), false);

  PERFORM pg_temp.esperar('solo-lectura: no escribe competitor_commissions',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO competitor_commissions (country,competitor_name,commission_pct)
         VALUES ('Peru','QA-RO',5)$q$), false);
END $$;

\echo ''
\echo '════ 15. Rol SIN secciones, rol con secciones vacías, y sección inventada ════'
-- Los tres son configuraciones que el user puede crear sin querer desde la
-- pantalla de Accesos (crear un rol y no tildar nada, o renombrar una sección
-- en el código y dejar la vieja guardada en la fila). Ninguna debe ABRIR nada,
-- y ninguna debe reventar: el modelo tiene que fallar cerrado y en silencio.
UPDATE roles SET permissions = '{"countries":["Peru"]}'::jsonb WHERE name='qa_temp';
DO $$ BEGIN
  PERFORM pg_temp.esperar('sin la clave "sections": no escribe',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO competitor_commissions (country,competitor_name,commission_pct)
         VALUES ('Peru','QA-NS',5)$q$), false);
END $$;

UPDATE roles SET permissions = '{"sections":[],"countries":["Peru"]}'::jsonb WHERE name='qa_temp';
DO $$ BEGIN
  PERFORM pg_temp.esperar('sections=[] : no escribe',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO competitor_commissions (country,competitor_name,commission_pct)
         VALUES ('Peru','QA-EMPTY',5)$q$), false);
END $$;

UPDATE roles SET permissions = '{"sections":["seccion_que_no_existe"],"countries":["Peru"]}'::jsonb
 WHERE name='qa_temp';
DO $$ BEGIN
  PERFORM pg_temp.esperar('sección inventada: no escribe NADA (no abre por descarte)',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO competitor_commissions (country,competitor_name,commission_pct)
         VALUES ('Peru','QA-FAKE',5)$q$), false);

  PERFORM pg_temp.esperar('sección inventada: tampoco escribe market_events',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO market_events (country,city,event_date,event_type,description,impact)
         VALUES ('Peru','Lima',current_date,'otro','QA-FAKE','bajo')$q$), false);
END $$;

\echo ''
\echo '════ 16. countries=[] : sin país no hay escritura, aunque tenga la sección ════'
-- El aislamiento por país y el permiso por sección son controles SEPARADOS y
-- ambos obligatorios. Un rol con `earnings` y ningún país no debe poder
-- escribir "en ningún lado" por no tener país asignado — el AND tiene que
-- cerrar, no quedar en "no aplica".
UPDATE roles SET permissions = '{"sections":["config"],"countries":[]}'::jsonb WHERE name='qa_temp';
DO $$ BEGIN
  PERFORM pg_temp.esperar('countries=[] : la sección sola no alcanza',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO competitor_commissions (country,competitor_name,commission_pct)
         VALUES ('Peru','QA-NOCOUNTRY',5)$q$), false);
END $$;

\echo ''
\echo '════ 17. Dos roles distintos con la MISMA sección ════'
-- Caso normal el día que el user cree un segundo rol operativo. Lo que hay que
-- verificar es que no se pisen: quitarle la sección a uno no puede afectar al
-- otro, ni al revés. Si el modelo se resolviera por rol y no por usuario, acá
-- se rompería.
INSERT INTO roles (name, label, permissions)
VALUES ('qa_temp2', 'QA temporal 2', '{"sections":["config"],"countries":["Peru"]}'::jsonb);
INSERT INTO user_profiles (email, first_name, last_name, role_id, is_active)
VALUES ('qa.temp2@local.test', 'QA', 'Dos', (SELECT id FROM roles WHERE name='qa_temp2'), true);

UPDATE roles SET permissions = '{"sections":["config"],"countries":["Peru"]}'::jsonb
 WHERE name='qa_temp';

DO $$ BEGIN
  PERFORM pg_temp.esperar('rol A escribe comisiones',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO competitor_commissions (country,competitor_name,commission_pct)
         VALUES ('Peru','QA-DUO-A',5)$q$), true);
  PERFORM pg_temp.esperar('rol B, misma sección, también',
    pg_temp.puede_insertar('qa.temp2@local.test',
      $q$INSERT INTO competitor_commissions (country,competitor_name,commission_pct)
         VALUES ('Peru','QA-DUO-B',5)$q$), true);
END $$;

UPDATE roles SET permissions = '{"sections":[],"countries":["Peru"]}'::jsonb WHERE name='qa_temp';

DO $$ BEGIN
  PERFORM pg_temp.esperar('al vaciar el rol A, A pierde el permiso',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO competitor_commissions (country,competitor_name,commission_pct)
         VALUES ('Peru','QA-DUO-A2',5)$q$), false);
  PERFORM pg_temp.esperar('…y B NO se ve afectado',
    pg_temp.puede_insertar('qa.temp2@local.test',
      $q$INSERT INTO competitor_commissions (country,competitor_name,commission_pct)
         VALUES ('Peru','QA-DUO-B2',5)$q$), true);
END $$;

\echo ''
\echo '════ 18. Quitarle TODAS las secciones a alguien con trabajo en curso ════'
-- Es la operación que más miedo da hacer en vivo. Lo importante no es solo que
-- deje de escribir: es que el trabajo YA GUARDADO siga ahí y siga siendo
-- legible por quien corresponde. Revocar un permiso no puede parecerse a
-- perder datos.
UPDATE roles SET permissions = '{"sections":["events"],"countries":["Peru"]}'::jsonb
 WHERE name='qa_temp';

DO $$
DECLARE v_antes int; v_despues int;
BEGIN
  PERFORM pg_temp.puede_insertar('qa.temp@local.test',
    $q$INSERT INTO market_events (country,city,event_date,event_type,description,impact)
       VALUES ('Peru','Lima',current_date,'otro','QA-EN-CURSO','bajo')$q$);
  SELECT count(*) INTO v_antes FROM market_events WHERE description='QA-EN-CURSO';
  PERFORM pg_temp.esperar('quedó trabajo guardado antes de revocar', v_antes = 1, true);

  UPDATE roles SET permissions = '{"sections":[],"countries":["Peru"]}'::jsonb WHERE name='qa_temp';

  PERFORM pg_temp.esperar('tras revocar TODO: no puede seguir escribiendo',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO market_events (country,city,event_date,event_type,description,impact)
         VALUES ('Peru','Lima',current_date,'otro','QA-POST-REVOCA','bajo')$q$), false);

  SELECT count(*) INTO v_despues FROM market_events WHERE description='QA-EN-CURSO';
  PERFORM pg_temp.esperar('el trabajo anterior NO se perdió', v_despues = 1, true);
END $$;

\echo ''
\echo '════ 19. Borrar una fila de section_write_grants con un hub trabajando ════'
-- El mapa es editable sin migración: hay que saber qué pasa si se toca en
-- caliente. La respuesta correcta es "la revocación es inmediata, en la
-- siguiente sentencia" — sin caché ni ventana en la que el permiso siga vivo
-- porque la sesión ya estaba abierta.
UPDATE roles SET permissions = '{"sections":["events"],"countries":["Peru"]}'::jsonb
 WHERE name='qa_temp';

DO $$ BEGIN
  PERFORM pg_temp.esperar('con la fila events→market_events: escribe',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO market_events (country,city,event_date,event_type,description,impact)
         VALUES ('Peru','Lima',current_date,'otro','QA-MAP-1','bajo')$q$), true);
END $$;

DELETE FROM section_write_grants WHERE section='events' AND table_name='market_events';

DO $$ BEGIN
  PERFORM pg_temp.esperar('borrada la fila: deja de escribir en el acto',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO market_events (country,city,event_date,event_type,description,impact)
         VALUES ('Peru','Lima',current_date,'otro','QA-MAP-2','bajo')$q$), false);
END $$;

INSERT INTO section_write_grants (section, table_name, gate, note)
VALUES ('events','market_events','section','restaurada en la simulación');

DO $$ BEGIN
  PERFORM pg_temp.esperar('repuesta la fila: vuelve a escribir, sin tocar el rol',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO market_events (country,city,event_date,event_type,description,impact)
         VALUES ('Peru','Lima',current_date,'otro','QA-MAP-3','bajo')$q$), true);
END $$;

\echo ''
\echo '════ 20. gate=owner: "all" no vuelve a nadie dueño de lo ajeno ════'
-- ci_active_sessions se gatea por dueño, no por sección. Un rol con TODAS las
-- secciones no debe poder pisar la sesión de otro hub — el permiso ahí no es
-- "qué sección tenés" sino "es tuyo", y el comodín no puede saltearlo.
UPDATE roles SET permissions = '{"sections":["all"],"countries":["all"]}'::jsonb
 WHERE name='qa_temp';

DO $$ BEGIN
  PERFORM pg_temp.esperar('sections=[all] NO escribe la sesión de otro hub',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO ci_active_sessions (user_email,country,city,observed_date)
         VALUES ('otro.hub@local.test','Peru','Lima',current_date)$q$), false);

  PERFORM pg_temp.esperar('…y sí escribe la suya',
    pg_temp.puede_insertar('qa.temp@local.test',
      $q$INSERT INTO ci_active_sessions (user_email,country,city,observed_date)
         VALUES ('qa.temp@local.test','Peru','Lima',current_date)$q$), true);
END $$;

\echo ''
\echo '════ 21. RPCs genéricas (mig 193): la sección alcanza, el país sigue cerrando ════'
-- Antes de la 193 estas funciones exigían is_admin(). Un rol con `config` veía
-- la pantalla, guardaba en los formularios (RLS ya lo permitía desde la 188) y
-- el botón de al lado rebotaba: un permiso a medias, que es peor que uno
-- negado. Y al aflojar el guard había que agregar el chequeo de país: estas
-- funciones son SECURITY DEFINER y el aislamiento lo daba `is_admin()` de
-- rebote.
UPDATE roles SET permissions = '{"sections":["config"],"countries":["Peru"]}'::jsonb
 WHERE name='qa_temp';

DO $$ BEGIN
  PERFORM pg_temp.esperar('con `config`: congela promedios de SU país',
    pg_temp.puede_ejecutar('qa.temp@local.test',
      $q$SELECT freeze_pricing_wa('Peru','qa-sim')$q$), true);

  PERFORM pg_temp.esperar('con `config`: NO congela los de otro país',
    pg_temp.puede_ejecutar('qa.temp@local.test',
      $q$SELECT freeze_pricing_wa('Colombia','qa-sim')$q$), false);

  PERFORM pg_temp.esperar('con `config`: recalcula brackets de su país',
    pg_temp.puede_ejecutar('qa.temp@local.test',
      $q$SELECT recompute_brackets_for('Peru','Lima','Economy')$q$), true);

  PERFORM pg_temp.esperar('con `config`: NO recalcula los de otro país',
    pg_temp.puede_ejecutar('qa.temp@local.test',
      $q$SELECT recompute_brackets_for('Colombia','Bogota','Economy')$q$), false);
END $$;

UPDATE roles SET permissions = '{"sections":["dashboard"],"countries":["Peru"]}'::jsonb
 WHERE name='qa_temp';

DO $$ BEGIN
  PERFORM pg_temp.esperar('sin `config`: no congela nada',
    pg_temp.puede_ejecutar('qa.temp@local.test',
      $q$SELECT freeze_pricing_wa('Peru','qa-sim-2')$q$), false);

  PERFORM pg_temp.esperar('sin `upload`: no toca el watermark del bot',
    pg_temp.puede_ejecutar('qa.temp@local.test',
      $q$SELECT reset_bot_watermark('Peru', 1)$q$), false);
END $$;

UPDATE roles SET permissions = '{"sections":["upload"],"countries":["Peru"]}'::jsonb
 WHERE name='qa_temp';

DO $$ BEGIN
  PERFORM pg_temp.esperar('con `upload`: sí toca el watermark de su país',
    pg_temp.puede_ejecutar('qa.temp@local.test',
      $q$SELECT reset_bot_watermark('Peru', 1)$q$), true);

  PERFORM pg_temp.esperar('con `upload`: NO el de otro país',
    pg_temp.puede_ejecutar('qa.temp@local.test',
      $q$SELECT reset_bot_watermark('Colombia', 1)$q$), false);
END $$;

\echo ''
\echo '════ 22. list_audit_log: la bitácora también se filtra por país ════'
-- Es la RPC más delicada de la 193: devuelve `old_data`/`new_data` de otras
-- tablas. Aflojarla a la sección sin filtrar por fila habría convertido la
-- bitácora en una puerta trasera para leer la operación de otro país.
DO $$
DECLARE v_peru int; v_otros int; v_admin int;
BEGIN
  INSERT INTO audit_log (user_email, action, table_name, country)
  VALUES ('sim@local.test','UPDATE','competitor_commissions','Peru'),
         ('sim@local.test','UPDATE','competitor_commissions','Colombia'),
         ('sim@local.test','UPDATE','competitor_commissions',NULL);

  UPDATE roles SET permissions='{"sections":["config"],"countries":["Peru"]}'::jsonb
   WHERE name='qa_temp';

  SET LOCAL request.jwt.claims TO '{"email":"qa.temp@local.test","role":"authenticated"}';
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_peru  FROM list_audit_log() WHERE country = 'Peru';
  SELECT count(*) INTO v_otros FROM list_audit_log() WHERE country IS DISTINCT FROM 'Peru';
  RESET ROLE;

  PERFORM pg_temp.esperar('con `config` ve la bitácora de SU país', v_peru > 0, true);
  PERFORM pg_temp.esperar('y NO ve la de otros países ni las globales', v_otros = 0, true);

  SET LOCAL request.jwt.claims TO '{"email":"admin@local.test","role":"authenticated"}';
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_admin FROM list_audit_log() WHERE country IS DISTINCT FROM 'Peru';
  RESET ROLE;

  PERFORM pg_temp.esperar('el admin sigue viendo todo, incluidas las globales',
    v_admin > 0, true);
END $$;

\echo ''
\echo '════ 23. El mapa cubre lo que la app escribe (invariante estructural) ════'
-- No reemplaza a `npm run check:section-grants` —que es el que mira el código—
-- pero sí ancla acá dos invariantes que ninguna fila suelta debe romper.
DO $$
DECLARE v_malos int;
BEGIN
  SELECT count(*) INTO v_malos FROM section_write_grants
   WHERE gate NOT IN ('section','owner','admin');
  PERFORM pg_temp.esperar('ningún gate fuera de section/owner/admin', v_malos = 0, true);

  SELECT count(*) INTO v_malos FROM section_write_grants
   WHERE table_name IN ('roles','user_profiles') AND gate <> 'admin';
  PERFORM pg_temp.esperar('roles y user_profiles NUNCA con gate=section', v_malos = 0, true);
END $$;

\echo ''
\echo '✓ TODAS LAS SIMULACIONES PASARON'
\echo '  (se revierte todo: no quedan roles, usuarios ni filas de prueba)'

ROLLBACK;
