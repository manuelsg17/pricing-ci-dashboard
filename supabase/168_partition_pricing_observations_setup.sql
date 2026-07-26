-- ════════════════════════════════════════════════════════════════════════
-- 168_partition_pricing_observations_setup.sql — Fase 4 de la auditoría
-- 2026-07-26 (arquitectura/escalabilidad). Prepara `pricing_observations`
-- para escala grande particionando por mes sobre `observed_date`, ANTES de
-- que el crecimiento (475.823 filas en los últimos 30 días — ~30% de todo
-- el volumen histórico de 13 meses entró en el último mes solo) haga que
-- mover la estructura sea caro/riesgoso en vez de barato.
--
-- Postgres NO permite convertir una tabla existente a particionada
-- in-place. Patrón seguro: crear tabla nueva particionada con la MISMA
-- estructura (columnas/índices/triggers/RLS/grants), copiar los datos
-- históricos en este mismo archivo, y el corte final (mig 169) hace un
-- último catch-up + RENAME swap.
--
-- Esta migración NO toca la tabla `pricing_observations` original — es
-- 100% aditiva (crea objetos nuevos), así que es segura de aplicar sin
-- afectar el tráfico en vivo (hubs guardando CI, bot sync corriendo).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Tabla nueva, particionada por RANGE mensual sobre observed_date ──
-- PK compuesta (id, observed_date): Postgres exige que la clave de
-- partición forme parte de toda constraint única. Se reusa la MISMA
-- secuencia de `id` que la tabla original (nextval sobre una secuencia
-- compartida funciona sin conflicto — no es una IDENTITY column exclusiva)
-- para que los ids sigan siendo continuos entre tabla vieja y nueva
-- durante la ventana de backfill.
CREATE TABLE public.pricing_observations_new (
  id                      bigint NOT NULL DEFAULT nextval('pricing_observations_id_seq'::regclass),
  city                    text NOT NULL,
  year                    integer,
  week                    integer,
  observed_date           date NOT NULL,
  observed_time           time without time zone,
  rush_hour               boolean,
  point_a                 text,
  point_b                 text,
  zone                    text,
  distance_km             numeric,
  distance_bracket        text,
  timeslot                text,
  category                text NOT NULL,
  competition_name        text NOT NULL,
  surge                   boolean DEFAULT false,
  travel_time_min         numeric,
  eta_min                 numeric,
  recommended_price       numeric,
  minimal_bid             numeric,
  price_with_discount     numeric,
  price_without_discount  numeric,
  bid_1                   numeric,
  bid_2                   numeric,
  bid_3                   numeric,
  upload_batch_id         uuid,
  uploaded_at             timestamptz DEFAULT now(),
  data_source             text DEFAULT 'manual'::text,
  country                 text NOT NULL DEFAULT 'Peru'::text,
  time_of_day             text,
  bid_4                   numeric,
  bid_5                   numeric,
  uploaded_by             text,
  no_data                 boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id, observed_date)
) PARTITION BY RANGE (observed_date);

-- ── 2. Particiones mensuales ──────────────────────────────────────────
-- Cubre todo el rango histórico real (min observed_date = 2025-07-01) más
-- 6 meses de margen hacia adelante desde hoy (2026-07-26) para que
-- ensure_next_pricing_partition() (pg_cron, más abajo) tenga tiempo de
-- crear la siguiente sin apuro. DEFAULT partition como red de seguridad:
-- si algún INSERT trae una fecha fuera de rango (dato corrupto o el cron
-- falló), cae ahí en vez de rechazar el insert.
DO $$
DECLARE
  d date := '2025-07-01'::date;
  last_d date := '2027-01-01'::date;
BEGIN
  WHILE d < last_d LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.pricing_observations_new FOR VALUES FROM (%L) TO (%L)',
      'pricing_observations_' || to_char(d, 'YYYY_MM'),
      d,
      (d + interval '1 month')::date
    );
    d := (d + interval '1 month')::date;
  END LOOP;
END $$;

CREATE TABLE public.pricing_observations_default
  PARTITION OF public.pricing_observations_new DEFAULT;

-- ── 3. Índices (idénticos a los 12 de la tabla original) ──────────────
-- Los índices creados sobre la tabla PADRE particionada se propagan
-- automáticamente a cada partición (PG11+) — no hay que crearlos por mes.
CREATE INDEX idx_po_new_city_cat_bracket ON public.pricing_observations_new
  USING btree (city, category, distance_bracket);
CREATE INDEX idx_po_new_city_week ON public.pricing_observations_new
  USING btree (city, year, week);
CREATE INDEX idx_po_new_competitor ON public.pricing_observations_new
  USING btree (competition_name);
CREATE INDEX idx_po_new_country_city_cat_bracket ON public.pricing_observations_new
  USING btree (country, city, category, distance_bracket);
CREATE INDEX idx_po_new_country_date ON public.pricing_observations_new
  USING btree (country, observed_date);
CREATE INDEX idx_po_new_country_source ON public.pricing_observations_new
  USING btree (country, data_source, city, category);
CREATE INDEX idx_po_new_date ON public.pricing_observations_new
  USING btree (observed_date);
CREATE INDEX idx_po_new_indrive_bot ON public.pricing_observations_new
  USING btree (country, city, category)
  WHERE (competition_name = 'InDrive'::text AND data_source = 'bot'::text);
CREATE INDEX idx_po_new_time_of_day ON public.pricing_observations_new
  USING btree (country, city, category, time_of_day);
CREATE INDEX idx_pobs_new_manual_uploaded_by ON public.pricing_observations_new
  USING btree (uploaded_by) WHERE (data_source = 'manual'::text);
CREATE INDEX idx_pobs_new_no_data ON public.pricing_observations_new
  USING btree (country, year, week)
  WHERE (no_data = true AND data_source = 'manual'::text);
-- Único parcial: incluye observed_date (clave de partición) → válido en
-- tabla particionada sin cambios.
CREATE UNIQUE INDEX ux_po_new_bot_natural_key ON public.pricing_observations_new
  USING btree (country, city, observed_date, observed_time, category, competition_name, distance_bracket, surge, data_source)
  WHERE (data_source = 'bot'::text);

-- ── 4. Triggers (idénticos a los 5 de la tabla original) ───────────────
-- Triggers row-level definidos sobre el padre se propagan a cada
-- partición automáticamente (PG13+) — mismo comportamiento que la tabla
-- original, verificado en mig 168 local antes de aplicar a prod.
CREATE TRIGGER airport_route_before_insert
  BEFORE INSERT ON public.pricing_observations_new
  FOR EACH ROW EXECUTE FUNCTION trg_airport_route_pricing_obs();
CREATE TRIGGER before_insert_pricing
  BEFORE INSERT OR UPDATE ON public.pricing_observations_new
  FOR EACH ROW EXECUTE FUNCTION trg_assign_computed_fields();
CREATE TRIGGER trg_zz_guard_corp_competitor
  BEFORE INSERT OR UPDATE OF competition_name, city ON public.pricing_observations_new
  FOR EACH ROW EXECUTE FUNCTION tg_guard_corp_competitor();
CREATE TRIGGER zz_indrive_price_before_insert
  BEFORE INSERT ON public.pricing_observations_new
  FOR EACH ROW EXECUTE FUNCTION trg_apply_indrive_price_on_insert();
CREATE TRIGGER trg_normalize_pricing_observations
  BEFORE INSERT OR UPDATE OF competition_name, city, distance_bracket ON public.pricing_observations_new
  FOR EACH ROW EXECUTE FUNCTION tg_normalize_pricing_observations();

-- ── 5. RLS (idéntico: mismo patrón can_access_country ya usado) ───────
ALTER TABLE public.pricing_observations_new ENABLE ROW LEVEL SECURITY;

CREATE POLICY pricing_observations_select ON public.pricing_observations_new
  FOR SELECT TO authenticated
  USING (can_access_country(country));
CREATE POLICY pricing_observations_insert ON public.pricing_observations_new
  FOR INSERT TO authenticated
  WITH CHECK (can_access_country(country));
CREATE POLICY pricing_observations_update ON public.pricing_observations_new
  FOR UPDATE TO authenticated
  USING (can_access_country(country))
  WITH CHECK (can_access_country(country));
CREATE POLICY pricing_observations_delete ON public.pricing_observations_new
  FOR DELETE TO authenticated
  USING (can_access_country(country));

-- ── 6. Grants — idénticos a los de la tabla original (mismos roles,
--    mismos privilegios; no se tocan por separado en esta mig, ver nota
--    en el plan sobre el grant amplio de `anon` ya neutralizado por RLS,
--    fuera de alcance de este particionado) ──────────────────────────
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.pricing_observations_new TO anon, authenticated, postgres, service_role;

-- ── 7. Auto-creación de particiones futuras (pg_cron) ──────────────────
-- Corre semanal, crea la partición de 2 meses adelante si no existe —
-- margen amplio para que nunca falte una partición aunque el cron se
-- salte una corrida.
CREATE OR REPLACE FUNCTION public.ensure_next_pricing_partition()
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  target_month date := date_trunc('month', now() + interval '2 months')::date;
  part_name text := 'pricing_observations_' || to_char(target_month, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.pricing_observations FOR VALUES FROM (%L) TO (%L)',
    part_name,
    target_month,
    (target_month + interval '1 month')::date
  );
END;
$$;

-- ── 8. Backfill histórico ──────────────────────────────────────────────
-- Copia TODO lo que hay hoy en la tabla original a la nueva particionada.
-- Es un SELECT sobre la tabla vieja (no la bloquea para escritura — bot
-- sync/hubs siguen insertando ahí normalmente durante este copy) + INSERT
-- en la nueva (que todavía nadie consulta). mig 169 hace el catch-up de
-- lo que haya entrado DESPUÉS de este punto y el corte final.
INSERT INTO public.pricing_observations_new
SELECT * FROM public.pricing_observations
ORDER BY id;

COMMIT;
