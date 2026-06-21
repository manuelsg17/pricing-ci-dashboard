-- ════════════════════════════════════════════════════════════════════════
-- Migración 116 — Bono Yango por % de GMV editable: tabla yango_gmv_tiers
--
-- CONTEXTO:
--   El bono GMV de Yango estaba HARDCODEADO en src/lib/yangoGmvBonus.js (F0).
--   El analista pidió poder editarlo desde Config. Se migra a una tabla; el
--   cálculo lo lee de ahí (con fallback al hardcode si la tabla está vacía).
--
-- MODELO: una fila = un peldaño. variant ∈ unbranded|branded|vip (VIP = Premier
--   en Lima, sin split de brandeo). bono = mín(pct% · fare·viajes, cap) del
--   peldaño máximo alcanzado por # de viajes. RLS = espejo de competitor_bonuses
--   (lectura libre autenticado, escritura can_edit()).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS yango_gmv_tiers (
  id         serial PRIMARY KEY,
  country    text    NOT NULL DEFAULT 'Peru',
  city       text    NOT NULL,
  variant    text    NOT NULL CHECK (variant IN ('unbranded', 'branded', 'vip')),
  min_trips  integer NOT NULL,
  pct        numeric NOT NULL,
  cap        numeric NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  updated_at timestamptz DEFAULT now(),
  UNIQUE (country, city, variant, min_trips)
);

ALTER TABLE yango_gmv_tiers ENABLE ROW LEVEL SECURITY;
CREATE POLICY yango_gmv_tiers_select ON yango_gmv_tiers FOR SELECT TO authenticated USING (true);
CREATE POLICY yango_gmv_tiers_insert ON yango_gmv_tiers FOR INSERT TO authenticated WITH CHECK (can_edit());
CREATE POLICY yango_gmv_tiers_update ON yango_gmv_tiers FOR UPDATE TO authenticated USING (can_edit()) WITH CHECK (can_edit());
CREATE POLICY yango_gmv_tiers_delete ON yango_gmv_tiers FOR DELETE TO authenticated USING (can_edit());

-- Seed: las tablas hardcodeadas de yangoGmvBonus.js (Lima/Trujillo/Arequipa + Lima VIP).
INSERT INTO yango_gmv_tiers (city, variant, min_trips, pct, cap) VALUES
  ('Lima','unbranded',10,9,50),('Lima','unbranded',30,10,110),('Lima','unbranded',50,11,150),('Lima','unbranded',75,12,200),('Lima','unbranded',100,14,280),('Lima','unbranded',125,16,340),('Lima','unbranded',150,18,400),
  ('Lima','branded',30,13,145),('Lima','branded',50,14,220),('Lima','branded',75,15,260),('Lima','branded',100,16,320),('Lima','branded',125,18,390),('Lima','branded',150,20,480),('Lima','branded',190,22,640),
  ('Lima','vip',2,40,64),('Lima','vip',4,43,135),('Lima','vip',6,46,205),('Lima','vip',8,49,300),('Lima','vip',10,52,395),('Lima','vip',15,56,640),('Lima','vip',20,60,900),
  ('Trujillo','unbranded',10,9,23),('Trujillo','unbranded',35,10,46),('Trujillo','unbranded',65,11,80),('Trujillo','unbranded',95,12,110),('Trujillo','unbranded',125,14,160),('Trujillo','unbranded',155,16,205),('Trujillo','unbranded',190,18,300),
  ('Trujillo','branded',35,13,55),('Trujillo','branded',65,14,100),('Trujillo','branded',95,15,170),('Trujillo','branded',125,16,225),('Trujillo','branded',155,18,280),('Trujillo','branded',190,20,350),('Trujillo','branded',230,22,410),
  ('Arequipa','unbranded',10,7,25),('Arequipa','unbranded',25,8,50),('Arequipa','unbranded',50,9,85),('Arequipa','unbranded',75,10,110),('Arequipa','unbranded',100,12,150),('Arequipa','unbranded',125,14,190),('Arequipa','unbranded',155,16,290),
  ('Arequipa','branded',25,10,65),('Arequipa','branded',50,11,120),('Arequipa','branded',75,12,180),('Arequipa','branded',100,13,240),('Arequipa','branded',125,14,320),('Arequipa','branded',155,16,440),('Arequipa','branded',195,18,520)
ON CONFLICT (country, city, variant, min_trips) DO NOTHING;

COMMIT;
