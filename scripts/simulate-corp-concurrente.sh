#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# simulate-corp-concurrente.sh — los TRES hubs guardando Corp a la vez.
# Supabase LOCAL, nunca producción.
#
#   bash scripts/simulate-corp-concurrente.sh
#
# POR QUÉ NO ALCANZA EL SCRIPT SQL
# `simulate-corp-tres-hubs.sql` corre los tres guardados en UNA transacción,
# uno después del otro. Eso prueba la SEMÁNTICA (quién borra qué) pero no
# prueba nada sobre concurrencia real: nunca hay dos transacciones abiertas a
# la vez, así que un interleaving destructivo no tendría cómo aparecer.
#
# Acá van tres procesos psql de verdad, arrancando juntos, cada uno con su
# propia transacción y su propia identidad. Es el mismo criterio que ya se usó
# para el doble clic (simulate-doble-clic-concurrente.sh): un script secuencial
# pasa igual con el bug puesto.
#
# LO QUE TIENE QUE PASAR: 12 filas, 3 dueños, 4 filas cada uno. Cualquier otro
# número significa que un hub se llevó puesto el trabajo de otro.
# ════════════════════════════════════════════════════════════════════════
set -euo pipefail

DB="docker exec -i supabase_db_pricing-ci-dashboard psql -U postgres -X -q"
FECHA="2026-08-14"

echo "── Preparando escenario ─────────────────────────────────────────"
$DB <<SQL
DELETE FROM pricing_observations WHERE city='Corp' AND observed_date=DATE '$FECHA';
DELETE FROM ci_bucket_writes WHERE city='Corp' AND observed_date=DATE '$FECHA';
DELETE FROM user_profiles WHERE email LIKE 'qa.corp%@local.test';
DELETE FROM roles WHERE name='qa_corp_hub';
INSERT INTO roles (name, label, permissions)
VALUES ('qa_corp_hub','QA Corp Hub','{"sections":["dataentry"],"countries":["Peru"]}');
INSERT INTO user_profiles (email, role_id, is_active) VALUES
  ('qa.corp1@local.test',(SELECT id FROM roles WHERE name='qa_corp_hub'),true),
  ('qa.corp2@local.test',(SELECT id FROM roles WHERE name='qa_corp_hub'),true),
  ('qa.corp3@local.test',(SELECT id FROM roles WHERE name='qa_corp_hub'),true);
SQL

# Un guardado completo de un hub. `pg_sleep` en medio de la transacción para
# forzar el solapamiento: sin eso los tres procesos podrían terminar tan rápido
# que en la práctica corran uno detrás de otro y la prueba no probaría nada.
guardar() {
  local email="$1" precio="$2" ses="$3"
  $DB <<SQL
BEGIN;
SET LOCAL request.jwt.claims TO '{"email":"$email","role":"authenticated"}';
SET LOCAL ROLE authenticated;
SELECT pg_sleep(0.4);
SELECT save_ci_batch('Peru','Corp',DATE '$FECHA',NULL,'$email',
 jsonb_build_array(
   jsonb_build_object('category','Corp','timeslot','Morning','bracket','short',
                      'competitors',jsonb_build_array('YangoEconomy','Cabify')),
   jsonb_build_object('category','Corp','timeslot','Evening','bracket','short',
                      'competitors',jsonb_build_array('YangoEconomy','Cabify'))),
 jsonb_build_array(
   jsonb_build_object('year',2026,'week',33,'observed_time','09:00','timeslot','Morning',
     'category','Corp','competition_name','YangoEconomy','distance_bracket','short',
     'price_without_discount',$precio,'data_source','manual','time_of_day','Morning'),
   jsonb_build_object('year',2026,'week',33,'observed_time','09:00','timeslot','Morning',
     'category','Corp','competition_name','Cabify','distance_bracket','short',
     'price_without_discount',$precio+1,'data_source','manual','time_of_day','Morning'),
   jsonb_build_object('year',2026,'week',33,'observed_time','15:00','timeslot','Evening',
     'category','Corp','competition_name','YangoEconomy','distance_bracket','short',
     'price_without_discount',$precio+2,'data_source','manual','time_of_day','Evening'),
   jsonb_build_object('year',2026,'week',33,'observed_time','15:00','timeslot','Evening',
     'category','Corp','competition_name','Cabify','distance_bracket','short',
     'price_without_discount',$precio+3,'data_source','manual','time_of_day','Evening')),
 '$ses',NULL,false) AS "$email";
COMMIT;
SQL
}

echo ""
echo "── Los tres guardando a la vez ──────────────────────────────────"
guardar 'qa.corp1@local.test' 10 'ses-1' &
P1=$!
guardar 'qa.corp2@local.test' 20 'ses-2' &
P2=$!
guardar 'qa.corp3@local.test' 30 'ses-3' &
P3=$!
wait $P1 $P2 $P3

echo ""
echo "── Resultado ────────────────────────────────────────────────────"
$DB <<SQL
SELECT uploaded_by, count(*) AS filas,
       string_agg(price_without_discount::text, ',' ORDER BY price_without_discount) AS precios
  FROM pricing_observations
 WHERE city='Corp' AND observed_date=DATE '$FECHA'
 GROUP BY uploaded_by ORDER BY uploaded_by;

DO \$\$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM pricing_observations
   WHERE city='Corp' AND observed_date=DATE '$FECHA';
  IF v <> 12 THEN
    RAISE EXCEPTION '✗ FALLA: se esperaban 12 filas y hay % — un hub se llevo puesto a otro', v;
  END IF;
  RAISE NOTICE '  ok  12 filas: ningun hub perdio trabajo';

  SELECT count(*) INTO v FROM (
    SELECT uploaded_by FROM pricing_observations
     WHERE city='Corp' AND observed_date=DATE '$FECHA'
     GROUP BY uploaded_by HAVING count(*) <> 4) x;
  IF v <> 0 THEN
    RAISE EXCEPTION '✗ FALLA: % hub(s) no tienen exactamente sus 4 filas', v;
  END IF;
  RAISE NOTICE '  ok  cada hub con sus 4 filas exactas';

  SELECT count(*) INTO v FROM (
    SELECT category, timeslot, distance_bracket, competition_name, uploaded_by
      FROM pricing_observations
     WHERE city='Corp' AND observed_date=DATE '$FECHA'
     GROUP BY 1,2,3,4,5 HAVING count(*) > 1) y;
  IF v <> 0 THEN
    RAISE EXCEPTION '✗ FALLA: % grupo(s) duplicados dentro del mismo dueno', v;
  END IF;
  RAISE NOTICE '  ok  sin duplicados dentro de ningun hub';
END \$\$;

SELECT refresh_ci_aggregates(4000);
SELECT competition_name, time_of_day, observation_count, round(avg_price,2) AS promedio
  FROM v_bracket_daily_avg_mv
 WHERE city='Corp' AND observed_date=DATE '$FECHA'
 ORDER BY time_of_day, competition_name;
SQL

echo ""
echo "── Limpieza ─────────────────────────────────────────────────────"
$DB <<SQL
DELETE FROM pricing_observations WHERE city='Corp' AND observed_date=DATE '$FECHA';
DELETE FROM ci_bucket_writes WHERE city='Corp' AND observed_date=DATE '$FECHA';
DELETE FROM user_profiles WHERE email LIKE 'qa.corp%@local.test';
DELETE FROM roles WHERE name='qa_corp_hub';
SELECT refresh_ci_aggregates(4000);
SQL
echo "✓ simulate-corp-concurrente: todo OK"
