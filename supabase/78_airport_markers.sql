-- ════════════════════════════════════════════════════════════════════════
-- Migración 78 — airport_markers: split de aeropuertos por sentido del viaje
--
-- CONTEXTO:
--   Un viaje DESDE el aeropuerto y un viaje HACIA el aeropuerto tienen
--   dinámicas de precio radicalmente distintas (drop-off batches, dead
--   miles, premium de regreso, etc.). Antes vivían todos en un mismo
--   "Lima_Airport" — la analítica los mezclaba.
--
-- DISEÑO:
--   Una tabla parametrizable por (country, base_city) que define:
--     - city_from / city_to  → cómo nombrar la ciudad cuando el aeropuerto
--                              está en el origen vs destino.
--     - keywords (text[])    → lista de substrings que el bot busca en
--                              point_a/point_b (case-insensitive) para
--                              detectar presencia de aeropuerto.
--
--   Reglas de matching (implementadas en bot_sync_push.py):
--     1. Si keyword aparece en point_a            → city_from
--     2. Si keyword aparece en point_b            → city_to
--     3. Si keyword aparece en AMBOS              → city_from (tie-break)
--     4. Si la ciudad original es de aeropuerto
--        pero ningún keyword matchea              → ciudad base
--        (fallback al mercado no-aeropuerto)
--
-- UI:
--   AirportMarkersTable.jsx en /config permite agregar/editar markers.
--   Cualquier cambio se levanta en la próxima corrida del cron — no hay
--   cache en el script Python.
--
-- KEYWORDS:
--   Son substrings cortos en lowercase. La detección es OR (cualquier
--   keyword que matchee cuenta). Mantenerlos cortos minimiza el riesgo
--   de no matchear por geocodes alternativos (ej: "Jorge Chavez" cubre
--   "Aeropuerto Internacional Jorge Chávez", "Jorge Chavez Intl", etc).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public.airport_markers (
  id          bigserial PRIMARY KEY,
  country     text        NOT NULL,
  base_city   text        NOT NULL,
  city_from   text        NOT NULL,
  city_to     text        NOT NULL,
  keywords    text[]      NOT NULL DEFAULT ARRAY[]::text[],
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT airport_markers_country_base_uk UNIQUE (country, base_city)
);

CREATE INDEX IF NOT EXISTS idx_airport_markers_country
  ON public.airport_markers (country, active);

COMMENT ON TABLE  public.airport_markers IS
  'Define cómo el bot detecta y rutea viajes de aeropuerto a "ciudades" separadas según el aeropuerto sea origen (city_from) o destino (city_to).';
COMMENT ON COLUMN public.airport_markers.keywords IS
  'Substrings case-insensitive buscados en point_a/point_b. Match OR: cualquier keyword que aparezca activa la detección.';

-- ── RLS: mismo patrón que el resto (read open, write admin) ────────────
ALTER TABLE public.airport_markers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS airport_markers_select ON public.airport_markers;
DROP POLICY IF EXISTS airport_markers_insert ON public.airport_markers;
DROP POLICY IF EXISTS airport_markers_update ON public.airport_markers;
DROP POLICY IF EXISTS airport_markers_delete ON public.airport_markers;

CREATE POLICY airport_markers_select ON public.airport_markers
  FOR SELECT TO authenticated USING (true);
CREATE POLICY airport_markers_insert ON public.airport_markers
  FOR INSERT TO authenticated WITH CHECK (can_edit());
CREATE POLICY airport_markers_update ON public.airport_markers
  FOR UPDATE TO authenticated USING (can_edit()) WITH CHECK (can_edit());
CREATE POLICY airport_markers_delete ON public.airport_markers
  FOR DELETE TO authenticated USING (can_edit());

-- ── Trigger updated_at ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_airport_markers_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS airport_markers_updated_at ON public.airport_markers;
CREATE TRIGGER airport_markers_updated_at
  BEFORE UPDATE ON public.airport_markers
  FOR EACH ROW
  EXECUTE FUNCTION trg_airport_markers_set_updated_at();

-- ── Seed Peru ──────────────────────────────────────────────────────────
-- Keywords cortos: el bot recibe geocodes muy variables, mejor cubrir
-- nombres del aeropuerto que la dirección completa. Lowercase obligatorio
-- (el matching del Python también lowercasea ambos lados).
INSERT INTO public.airport_markers (country, base_city, city_from, city_to, keywords)
VALUES
  ('Peru', 'Lima',     'Lima_Airport_A',     'Lima_Airport_B',
   ARRAY['jorge chavez', 'jorge chávez', 'aicc', 'lim airport',
         'aeropuerto internacional jorge', 'callao 07031']),
  ('Peru', 'Trujillo', 'Trujillo_Airport_A', 'Trujillo_Airport_B',
   ARRAY['aeropuerto de trujillo', 'aeropuerto trujillo',
         'martinez de pinillos', 'martínez de pinillos',
         'carlos martinez de pinillos']),
  ('Peru', 'Arequipa', 'Arequipa_Airport_A', 'Arequipa_Airport_B',
   ARRAY['aeropuerto de arequipa', 'aeropuerto arequipa',
         'rodriguez ballon', 'rodríguez ballón'])
ON CONFLICT (country, base_city) DO NOTHING;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   SELECT country, base_city, city_from, city_to, array_length(keywords,1) AS n_kw
--   FROM airport_markers ORDER BY country, base_city;
--
--   Esperado para Peru: 3 filas (Lima, Trujillo, Arequipa) con n_kw > 0.
-- ════════════════════════════════════════════════════════════════════════
