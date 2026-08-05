#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# simulate-doble-clic-concurrente.sh — mig 217, la mitad que psql solo no
# puede probar. Supabase LOCAL, nunca producción.
#
#   bash scripts/simulate-doble-clic-concurrente.sh
#
# POR QUÉ EXISTE ESTE ARCHIVO Y NO ES UN .sql MÁS
# El bug de la mig 217 es una carrera: dos llamadas que leen el estado ANTES
# de que ninguna haya hecho COMMIT. Un script de psql corre todo en una sola
# sesión, secuencialmente — ahí la segunda llamada SIEMPRE ve lo que escribió
# la primera, aunque no hubiera candado. O sea: el test secuencial pasa igual
# con el bug puesto, y por eso no alcanza.
#
# Acá se lanzan DOS procesos psql de verdad, al mismo tiempo, contra la misma
# fila. Es la única forma de que el `FOR UPDATE` esté realmente bajo prueba.
#
# MUTACIÓN PARA COMPROBAR QUE PUEDE FALLAR: sacarle el `FOR UPDATE` a
# set_task_status y volver a correr — tiene que dar 2 transiciones.
# ════════════════════════════════════════════════════════════════════════
set -euo pipefail

DB=supendo
DB=supabase_db_pricing-ci-dashboard
psql_() { docker exec -i "$DB" psql -U postgres -X -q "$@"; }

echo "── Preparando el escenario ─────────────────────────────"
psql_ <<'SQL'
DELETE FROM projects WHERE name = 'QA217C proyecto';
DELETE FROM user_profiles WHERE email LIKE 'qa217c.%';
DELETE FROM roles WHERE name = 'qa217c_hub';

INSERT INTO roles (name, label, permissions)
VALUES ('qa217c_hub', 'QA217C hub', '{"sections": ["projects"], "countries": ["Peru"]}');
INSERT INTO user_profiles (email, role_id, is_active)
VALUES ('qa217c.hub@local.test', (SELECT id FROM roles WHERE name='qa217c_hub'), true);
INSERT INTO projects (country, name, created_by)
VALUES ('Peru', 'QA217C proyecto', 'qa217c.hub@local.test');
INSERT INTO project_tasks (project_id, title, owner_email, created_by)
SELECT id, 'QA217C tarea', 'qa217c.hub@local.test', 'qa217c.hub@local.test'
FROM projects WHERE name = 'QA217C proyecto';
SQL

TAREA=$(psql_ -tAc "SELECT id FROM project_tasks WHERE title='QA217C tarea'")
echo "   tarea: $TAREA"

# Las dos sesiones esperan en un advisory lock compartido y arrancan juntas,
# para que el solapamiento no dependa de la suerte del scheduler.
correr() {
  psql_ <<SQL
BEGIN;
SET LOCAL request.jwt.claims TO '{"email":"qa217c.hub@local.test","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT pg_advisory_xact_lock_shared(217217);
SELECT pg_sleep(0.15);
SELECT set_task_status('$TAREA'::uuid, 'doing', 'Avancé la mitad');
COMMIT;
SQL
}

echo "── Dos sesiones a la vez sobre la misma tarea ──────────"
correr > /tmp/qa217c_a.log 2>&1 &
A=$!
correr > /tmp/qa217c_b.log 2>&1 &
B=$!
wait $A || true
wait $B || true

echo "── Resultado ───────────────────────────────────────────"
psql_ <<SQL
\pset pager off
SELECT
  (SELECT status FROM project_tasks WHERE id = '$TAREA') AS estado,
  (SELECT count(*) FROM task_status_log WHERE task_id = '$TAREA') AS transiciones,
  (SELECT count(*) FROM task_comments WHERE task_id = '$TAREA' AND kind='progress') AS comentarios;

DO \$\$
DECLARE v_log int; v_com int;
BEGIN
  SELECT count(*) INTO v_log FROM task_status_log WHERE task_id = '$TAREA';
  SELECT count(*) INTO v_com FROM task_comments  WHERE task_id = '$TAREA' AND kind='progress';
  IF v_log <> 1 THEN
    RAISE EXCEPTION E'\n  ✗ FALLA: % transiciones para un solo cambio (esperado 1). El FOR UPDATE no está serializando.', v_log;
  END IF;
  IF v_com <> 1 THEN
    RAISE EXCEPTION E'\n  ✗ FALLA: % comentarios idénticos (esperado 1).', v_com;
  END IF;
  RAISE NOTICE E'\n  ✓ concurrencia real: 1 transición, 1 comentario\n';
END \$\$;
SQL

echo "── Limpieza ────────────────────────────────────────────"
psql_ <<'SQL'
DELETE FROM projects WHERE name = 'QA217C proyecto';
DELETE FROM user_profiles WHERE email LIKE 'qa217c.%';
DELETE FROM roles WHERE name = 'qa217c_hub';
SQL
echo "   listo"
