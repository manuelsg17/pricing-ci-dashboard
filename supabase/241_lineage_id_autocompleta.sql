-- ════════════════════════════════════════════════════════════════════════
-- Migración 241 — competitor_bonuses.lineage_id se autocompleta
--
-- POR QUÉ (bug P0 en producción, introducido por la mig 237 el 2026-09-03):
--   La mig 237 agregó `lineage_id` NOT NULL (self-FK) para agrupar todas las
--   versiones de un mismo bono, y lo backfilleó con `lineage_id = id` para las
--   filas existentes. Pero NO le puso default ni trigger, y el cliente nunca
--   lo manda: `buildPayload()` en src/hooks/useCompetitorBonuses.js arma el
--   INSERT sin esa columna. Resultado: desde el 2026-09-03, crear un bono
--   NUEVO desde Configuración → Bonos falla con
--
--     null value in column "lineage_id" ... violates not-null constraint
--
--   Solo funcionaba "nueva versión" (la RPC competitor_bonus_new_version sí
--   propaga el lineage del padre) y editar un bono ya existente. Lo destapó
--   `npm run simulate:permissions` el 2026-09-04, no un reporte de usuario:
--   nadie había creado un bono en esas 24 h.
--
-- QUÉ HACE:
--   Trigger BEFORE INSERT que, si lineage_id viene NULL, lo siembra con el id
--   de la propia fila — el mismo criterio del backfill de la mig 237. En
--   BEFORE INSERT el default de `id` (nextval) ya está resuelto, así que
--   NEW.id es el valor definitivo. Idempotente y compatible con la RPC de
--   versionado, que sigue mandando el lineage explícito del padre.
--
-- SEGURIDAD: no es SECURITY DEFINER, search_path fijo, no toca RLS ni grants.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.stamp_bonus_lineage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.lineage_id IS NULL THEN
    NEW.lineage_id := NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_bonus_lineage ON public.competitor_bonuses;
CREATE TRIGGER trg_stamp_bonus_lineage
  BEFORE INSERT ON public.competitor_bonuses
  FOR EACH ROW EXECUTE FUNCTION public.stamp_bonus_lineage();

-- Red de seguridad: si alguna fila quedó sin lineage (no debería), se siembra.
UPDATE public.competitor_bonuses SET lineage_id = id WHERE lineage_id IS NULL;

COMMIT;
