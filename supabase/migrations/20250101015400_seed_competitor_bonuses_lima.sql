-- ════════════════════════════════════════════════════════════════════════
-- Migración 115 — Seed de bonos de competidor (Lima) desde COMPETIDOR_BONOS_DESIGN.md
--
-- CONTEXTO:
--   competitor_bonuses estaba VACÍA → Rentabilidad no mostraba ningún bono.
--   Se cargan los bonos DECISIÓN-CERRADA / sin ambigüedad del doc (§3, §7, §9)
--   para Lima. NO se cargan los que el doc deja al criterio del analista o con
--   datos parciales (quedan para completar en Config → Bonos):
--     · Uber welcome 8→S/20…220→S/1000 (escalera incompleta en el doc; new/one-off)
--     · Uber quests personalizadas (el analista elige cuál — §9.7.1)
--     · Didi racha/flash/surge_mult (necesitan streak_spec / mult_pct + datos)
--     · Provincias (Trujillo/Arequipa) — el equipo pasa las tablas
--
--   Modelado (§9.2): la escalera excluyente va en `tiers`; "25→55 y 50→310 que
--   SUMAN" (Cabify/Didi, §7) = DOS filas flat. category=NULL = aplica a todas.
--   bonus_type es legacy NOT NULL (CHECK viajes/horas/zona) — la lógica la maneja
--   `mechanism`; se usa 'viajes' como etiqueta válida.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- Idempotente: re-seedea Lima sin tocar otras ciudades.
DELETE FROM competitor_bonuses WHERE country = 'Peru' AND city = 'Lima';

INSERT INTO competitor_bonuses
  (competitor_name, country, city, category, bonus_type, threshold, bonus_amount,
   mechanism, segment, recurring, comm_pct, share_in_window, day_window, description, sort_order)
VALUES
  -- InDrive: 1% de comisión en ventana pico (decisión cerrada §3/§7). El % de
  -- viajes en ventana es tuneable desde el arquetipo (default 0.25).
  ('InDrive', 'Peru', 'Lima', NULL, 'viajes', 0, 0,
   'comm_discount', 'all', true, 1.0, 0.25, NULL,
   'InDrive: 1% de comisión en ventana pico (7-8am / 6-7pm). % de viajes en ventana tuneable.', 1),

  -- Didi: garantizado (piso sobre el neto) §7.
  ('Didi', 'Peru', 'Lima', NULL, 'viajes', 15, 120,
   'guarantee', 'active', true, NULL, NULL, NULL,
   'Didi: garantizado S/120 a 15 viajes/sem.', 2),

  -- Cabify: reconexión one-off (reactivado, Jue-Dom) §7.
  ('Cabify', 'Peru', 'Lima', NULL, 'viajes', 50, 150,
   'flat', 'reactivated', false, NULL, NULL, 'Jue-Dom',
   'Cabify: reconexión S/150 a 50 viajes (Jue-Dom). One-off, reactivado.', 3),

  -- Cabify: dos flats que SUMAN (total S/365 @50) §7/§9.7.2.
  ('Cabify', 'Peru', 'Lima', NULL, 'viajes', 25, 55,
   'flat', 'active', true, NULL, NULL, NULL,
   'Cabify: S/55 a 25 viajes/sem.', 4),
  ('Cabify', 'Peru', 'Lima', NULL, 'viajes', 50, 310,
   'flat', 'active', true, NULL, NULL, NULL,
   'Cabify: S/310 a 50 viajes/sem.', 5),

  -- Uber: flat simple §7 (las quests/welcome quedan para el analista).
  ('Uber', 'Peru', 'Lima', NULL, 'viajes', 28, 46,
   'flat', 'active', true, NULL, NULL, NULL,
   'Uber: S/46 a 28 viajes/sem.', 6),

  -- Didi: dos flats §7 (la racha/flash quedan pendientes de modelar).
  ('Didi', 'Peru', 'Lima', NULL, 'viajes', 25, 55,
   'flat', 'active', true, NULL, NULL, NULL,
   'Didi: S/55 a 25 viajes/sem.', 7),
  ('Didi', 'Peru', 'Lima', NULL, 'viajes', 40, 310,
   'flat', 'active', true, NULL, NULL, NULL,
   'Didi: S/310 a 40 viajes/sem.', 8);

COMMIT;
