-- ════════════════════════════════════════════════════════════════════════
-- Migración 229 — data_incidents: registro de "sin data por falla del
-- sistema" para marcar celdas vacías del dashboard con su motivo.
--
-- CONTEXTO (pedido del user 2026-08-30): cuando un día queda sin data por
-- una falla (del simulador, del guardado a BD, de un teléfono desconectado),
-- el dashboard muestra el mismo "—" que un hueco cualquiera, y quien lo mira
-- no sabe si faltó mercado o falló el sistema. Un banner general no sirve:
-- la marca tiene que estar EN la celda (muestras y precios), con leyenda.
--
-- MODELO: un incidente cubre (país, ciudad opcional, competidor opcional,
-- rango de fechas). NULL en city/competitor = aplica a todos. El frontend
-- cruza las celdas VACÍAS contra los incidentes: una celda con data real
-- nunca se marca (si un día degradado igual trajo muestras, esas muestras
-- son reales y el color por n bajo ya avisa).
--
-- ESCRITURA: admin-only (can_edit) — los incidentes son hechos operativos,
-- no data de mercado. Hoy se cargan por migración/SQL; si más adelante se
-- agrega una pantalla, el grant ya está listo y habrá que sumar la fila a
-- section_write_grants en ESE cambio (check:section-grants lo exigirá).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public.data_incidents (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  country     text NOT NULL,
  city        text,            -- NULL = todas las ciudades del país
  competitor  text,            -- NULL = todos los competidores
  date_from   date NOT NULL,
  date_to     date NOT NULL,
  reason      text NOT NULL,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_incidents_rango_valido CHECK (date_to >= date_from)
);

COMMENT ON TABLE public.data_incidents IS
  'Ventanas de "sin data por falla del sistema" (simulador, guardado a BD, teléfono desconectado). El dashboard marca con rayado las celdas vacías que caen dentro de un incidente. NULL en city/competitor = aplica a todos.';

-- La consulta del dashboard es "incidentes del país" — chico y por país.
CREATE INDEX IF NOT EXISTS idx_data_incidents_country
  ON public.data_incidents (country, date_from, date_to);

-- ── Seguridad: deny by default + RLS por operación (CLAUDE.md §3) ───────
ALTER TABLE public.data_incidents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.data_incidents FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.data_incidents TO authenticated;

DROP POLICY IF EXISTS data_incidents_select ON public.data_incidents;
CREATE POLICY data_incidents_select ON public.data_incidents
  FOR SELECT TO authenticated
  USING (can_access_country(country));

DROP POLICY IF EXISTS data_incidents_insert ON public.data_incidents;
CREATE POLICY data_incidents_insert ON public.data_incidents
  FOR INSERT TO authenticated
  WITH CHECK (can_edit());

DROP POLICY IF EXISTS data_incidents_update ON public.data_incidents;
CREATE POLICY data_incidents_update ON public.data_incidents
  FOR UPDATE TO authenticated
  USING (can_edit())
  WITH CHECK (can_edit());

DROP POLICY IF EXISTS data_incidents_delete ON public.data_incidents;
CREATE POLICY data_incidents_delete ON public.data_incidents
  FOR DELETE TO authenticated
  USING (can_edit());

-- ── Seed: los 2 incidentes reales ya diagnosticados en esta sesión ──────
-- 1. mar 25-ago, Lima: hueco real del scraper + lo poco que llegó era
--    contaminación TukTuk que la limpieza (mig 220) removió.
-- 2. InDrive 25→29-ago, todo Perú: el A23 (teléfono de InDrive) estuvo
--    desconectado por USB — alertas reales del watchdog los días 29 y 30.
--    El user pidió 25→28; se extiende al 29 porque el watchdog siguió
--    alertando ese día ("el A23 (inDrive) no esta conectado por USB").
INSERT INTO public.data_incidents (country, city, competitor, date_from, date_to, reason, created_by)
SELECT v.* FROM (VALUES
  ('Peru', 'Lima', NULL,
   DATE '2026-08-25', DATE '2026-08-25',
   'La data del día se perdió por una falla en el envío/guardado hacia la base de datos: el bot produjo muy poco y lo único que llegó eran rutas TukTuk mal etiquetadas, removidas en la limpieza posterior.',
   'mig 229'),
  ('Peru', NULL, 'InDrive',
   DATE '2026-08-25', DATE '2026-08-29',
   'El teléfono que captura InDrive (A23) estuvo desconectado por USB — alertado por el watchdog del scraper. Sin capturas de InDrive durante la ventana.',
   'mig 229')
) AS v(country, city, competitor, date_from, date_to, reason, created_by)
WHERE NOT EXISTS (
  SELECT 1 FROM public.data_incidents d
  WHERE d.country = v.country
    AND d.date_from = v.date_from AND d.date_to = v.date_to
    AND coalesce(d.city, '') = coalesce(v.city, '')
    AND coalesce(d.competitor, '') = coalesce(v.competitor, '')
);

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.data_incidents WHERE created_by='mig 229';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'mig 229 ABORTADA: se esperaban 2 incidentes seed, hay %.', v_n;
  END IF;
  RAISE NOTICE 'mig 229 OK — tabla data_incidents + 2 incidentes seed.';
END $$;

COMMIT;
