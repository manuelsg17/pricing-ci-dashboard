-- ════════════════════════════════════════════════════════════════════════
-- Mig 250 — freeze_pricing_wa (el snapshot del WA) calculaba SIEMPRE
-- Promedio Ponderado, sin enterarse del corte a Promedio Simple que
-- src/algorithms/weightedAverage.js aplica en vivo desde la semana ISO
-- 2026-W25 (SIMPLE_AVG_SINCE). Hallazgo de auditoría 2026-09-12.
--
-- Este script arma DOS semanas sintéticas con pesos deliberadamente
-- desiguales (para que ponderado y simple den números DISTINTOS y
-- detectables) y verifica que freeze_pricing_wa elige la fórmula correcta
-- en cada una:
--   2026-W24 (antes del corte) → PONDERADO
--   2026-W25 (en el corte)     → SIMPLE
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

-- Pesos MUY desiguales para QA250/Lima/Economy — si el cálculo real fuera
-- ponderado, el promedio se acercaría mucho al bracket 'long' (peso 0.70);
-- si es simple, cae en la media aritmética plana de los 2 brackets.
INSERT INTO bracket_weights (country, city, category, bracket, weight)
VALUES
  ('QA250', 'LimaQA250', 'Economy', 'short', 0.30),
  ('QA250', 'LimaQA250', 'Economy', 'long',  0.70)
ON CONFLICT (country, city, category, bracket) DO UPDATE SET weight = EXCLUDED.weight;

-- Rol admin-like con acceso a QA250 y a la sección config (freeze_pricing_wa
-- exige can_access_section('config') + require_country_access).
INSERT INTO roles (name, label, permissions)
VALUES ('qa250_admin', 'QA 250 admin', '{"sections":["config"],"countries":["QA250"]}'::jsonb)
ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions;

INSERT INTO user_profiles (email, role_id, is_active)
SELECT 'qa250.admin@local.test', id, true FROM roles WHERE name='qa250_admin'
ON CONFLICT (email) DO UPDATE SET role_id = EXCLUDED.role_id, is_active = true;

-- 2026-W24 (semana ANTES del corte, 8-jun-2026 o antes): dos brackets,
-- precios 10 y 20 — ponderado con (0.30,0.70) da 17.0; simple daría 15.0.
INSERT INTO v_bracket_weekly_avg_mv
  (country, city, year, week, category, zone, competition_name, distance_bracket,
   surge, data_source, time_of_day, rush_hour, observation_count, avg_price,
   week_start_date, last_observed_date)
VALUES
  ('QA250','LimaQA250',2026,24,'Economy',NULL,'Yango','short',
   false,'manual','morning',false, 10, 10.00, '2026-06-08', '2026-06-08'),
  ('QA250','LimaQA250',2026,24,'Economy',NULL,'Yango','long',
   false,'manual','morning',false, 10, 20.00, '2026-06-08', '2026-06-08');

-- 2026-W25 (semana DEL corte en adelante, 15-jun-2026): mismos precios y
-- mismos pesos configurados — si freeze_pricing_wa NO respeta el corte,
-- daría el mismo 17.0 ponderado; con el fix debe dar 15.0 simple.
INSERT INTO v_bracket_weekly_avg_mv
  (country, city, year, week, category, zone, competition_name, distance_bracket,
   surge, data_source, time_of_day, rush_hour, observation_count, avg_price,
   week_start_date, last_observed_date)
VALUES
  ('QA250','LimaQA250',2026,25,'Economy',NULL,'Yango','short',
   false,'manual','morning',false, 10, 10.00, '2026-06-15', '2026-06-15'),
  ('QA250','LimaQA250',2026,25,'Economy',NULL,'Yango','long',
   false,'manual','morning',false, 10, 20.00, '2026-06-15', '2026-06-15');

-- Ejecuta freeze_pricing_wa como el rol autenticado real (no postgres) —
-- can_access_section/require_country_access leen auth.email().
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims', '{"email":"qa250.admin@local.test","role":"authenticated"}', true);

SELECT public.freeze_pricing_wa('QA250', 'qa250-test') AS filas_congeladas;

RESET role;

DO $$
DECLARE
  v_w24 numeric;
  v_w25 numeric;
BEGIN
  SELECT avg_price INTO v_w24 FROM pricing_wa_frozen
    WHERE country='QA250' AND year=2026 AND week=24 AND distance_bracket='_wa';
  SELECT avg_price INTO v_w25 FROM pricing_wa_frozen
    WHERE country='QA250' AND year=2026 AND week=25 AND distance_bracket='_wa';

  PERFORM pg_temp.ok(v_w24 IS NOT NULL, '2026-W24 (_wa) se congeló', v_w24::text);
  PERFORM pg_temp.ok(v_w25 IS NOT NULL, '2026-W25 (_wa) se congeló', v_w25::text);

  -- 2026-W24 (antes del corte) debe seguir siendo PONDERADO: 10*0.30 + 20*0.70 = 17.00
  PERFORM pg_temp.ok(v_w24 = 17.00, '2026-W24 usa PONDERADO (17.00 con pesos 0.30/0.70)', v_w24::text);

  -- 2026-W25 (en el corte) debe ser SIMPLE: (10+20)/2 = 15.00
  PERFORM pg_temp.ok(v_w25 = 15.00, '2026-W25 usa SIMPLE (15.00, media aritmética) — el fix', v_w25::text);

  -- Si el fix NO estuviera aplicado, W25 daría 17.00 igual que W24 — el
  -- assert de arriba ya lo cubre, pero lo hacemos explícito para que quede
  -- documentado qué falla sin el fix.
  PERFORM pg_temp.ok(v_w24 <> v_w25, 'W24 y W25 dan números DISTINTOS (si dieran igual, el corte no se está aplicando)');
END $$;

-- ── Regresión: los brackets NO-_wa siguen intactos (no tocamos esa rama) ──
DO $$
DECLARE v_short numeric;
BEGIN
  SELECT avg_price INTO v_short FROM pricing_wa_frozen
    WHERE country='QA250' AND year=2026 AND week=25 AND distance_bracket='short';
  PERFORM pg_temp.ok(v_short = 10.00, 'bracket short (no-_wa) sin cambios', v_short::text);
END $$;

DO $$ BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '✓ Todos los checks de freeze_pricing_wa (corte simple/ponderado) pasaron.';
END $$;

ROLLBACK;
