-- ============================================================
-- 111 — surge_windows: qué franjas horarias tienen surge
-- ============================================================
-- CONTEXTO
--   El filtro SURGE del dashboard usaba el flag `surge` que viene del
--   scraper por observación, pero ese flag es poco confiable (el bot no
--   siempre lo marca bien). El analista SÍ sabe en qué franjas del día
--   hay surge en cada ciudad — esta tabla captura esa regla de negocio.
--
-- USO
--   Una fila por (country, city, time_of_day) = "esta franja tiene surge".
--   city NULL = aplica a todas las ciudades del país.
--   El frontend (usePricingData) traduce Surge=Yes/No del filtro a una
--   lista de franjas time_of_day para los RPCs _fast, en lugar de pasar
--   p_surge. Si un país/ciudad no tiene filas, se cae al flag del scraper
--   (comportamiento anterior).
--
-- VERIFICACIÓN
--   select * from surge_windows; → seed de Peru (tarde/noche en todas
--   las ciudades) visible y editable desde Config → Timing → Surge.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.surge_windows (
  id          serial PRIMARY KEY,
  country     text NOT NULL,
  city        text,                          -- NULL = todas las ciudades del país
  time_of_day text NOT NULL CHECK (time_of_day IN
                ('early_morning','morning','midday','afternoon','evening')),
  is_active   boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- UNIQUE con city NULL-safe (Postgres permite N nulls en UNIQUE normal)
CREATE UNIQUE INDEX IF NOT EXISTS surge_windows_uniq
  ON public.surge_windows (country, COALESCE(city, '*'), time_of_day);

-- RLS: patrón mig 60/100 — SELECT country-aware, writes solo con can_edit().
-- (NO usar auth_all: un viewer no debe poder alterar las reglas de surge
-- que cambian lo que ve todo el mundo en el dashboard.)
ALTER TABLE public.surge_windows ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_all" ON public.surge_windows;
DROP POLICY IF EXISTS surge_windows_select ON public.surge_windows;
DROP POLICY IF EXISTS surge_windows_insert ON public.surge_windows;
DROP POLICY IF EXISTS surge_windows_update ON public.surge_windows;
DROP POLICY IF EXISTS surge_windows_delete ON public.surge_windows;
CREATE POLICY surge_windows_select ON public.surge_windows
  FOR SELECT TO authenticated USING (can_access_country(country));
CREATE POLICY surge_windows_insert ON public.surge_windows
  FOR INSERT TO authenticated WITH CHECK (can_edit());
CREATE POLICY surge_windows_update ON public.surge_windows
  FOR UPDATE TO authenticated USING (can_edit()) WITH CHECK (can_edit());
CREATE POLICY surge_windows_delete ON public.surge_windows
  FOR DELETE TO authenticated USING (can_edit());

-- Seed Peru: tarde y noche con surge en todas las ciudades (ajustable
-- después desde Config → Timing → Surge). Idempotente.
INSERT INTO public.surge_windows (country, city, time_of_day)
SELECT 'Peru', NULL, t
FROM unnest(ARRAY['afternoon','evening']) AS t
ON CONFLICT DO NOTHING;

-- Audit trigger (mig 62) → habilita live-sync 'config:changed' entre sesiones
DROP TRIGGER IF EXISTS trg_audit_surge_windows ON public.surge_windows;
CREATE TRIGGER trg_audit_surge_windows
  AFTER INSERT OR UPDATE OR DELETE ON public.surge_windows
  FOR EACH ROW EXECUTE FUNCTION log_changes();

SELECT * FROM public.surge_windows ORDER BY country, city NULLS FIRST, time_of_day;
