-- ════════════════════════════════════════════════════════════════════════
-- Migración 239 — Nombres de competidor canónicos en tablas de configuración
--
-- POR QUÉ:
--   Rentabilidad (local y prod) mostraba 'YangoComfort' y 'Yango Comfort'
--   como dos competidores. pricing_observations está limpia en todos los
--   países (forma pegada desde mig 72/96, verificado 2026-09-04 con
--   normalize_competitor_name(x,'Corp') sobre 1,4 M filas: 0 divergencias),
--   pero competitor_commissions (Perú, city NULL) acumuló 5 filas con la forma
--   legacy con espacio y 2 duplicados semánticos:
--
--     id 2 'YangoPremier'=15   | id 7 'Yango Premier'=15
--     id 3 'YangoComfort+'=15  | id 6 'Yango Comfort+'=15
--     id 4 'Yango Economy', id 5 'Yango Comfort', id 8 'Yango XL'
--
--   El nombre en estas tablas es la CLAVE contra pricing_observations
--   .competition_name (commissions[comp], bonusFor(comp)). Con espacio no
--   matchea nunca: la comisión configurada se ignora y cae al default de
--   20 %, y el chip fantasma aparece en cuanto la ciudad no tiene data.
--   Origen: el selector de Comisiones ofrecía Object.keys(COMPETITOR_COLORS),
--   que incluye las claves legacy con espacio de retrocompat.
--
-- QUÉ HACE (idempotente):
--   VERIFICADO EN PROD 2026-09-04 antes de aplicar: competitor_bonuses y
--   competitive_bands NO tienen dos nombres que colapsen al mismo canónico
--   (ninguna quedaría con linajes duplicados), y no hay bonos con nombre
--   Yango. El dedupe solo hace falta en competitor_commissions.
--
--   1. Trigger BEFORE INSERT/UPDATE en competitor_commissions,
--      competitor_bonuses y competitive_bands: competitor_name pasa por
--      normalize_competitor_name(x, 'Corp') — el diccionario de sub-marcas
--      con salida pegada, que es la forma canónica en TODA la base. Espejo JS:
--      canonicalCompetitorName() en src/lib/normalize.js.
--   2. Dedupe en competitor_commissions: dentro de cada
--      (country, city, nombre canónico) sobrevive la fila con updated_at más
--      reciente. En prod borra 2 filas (ids 6 y 2, ambas 15 %, mismo valor
--      que la que queda).
--   3. Backfill de las 3 tablas al nombre canónico.
--   4. La unicidad ya existe (índices parciales por city NULL / city); con
--      el trigger delante, 'Yango Premier' colisiona con 'YangoPremier' en
--      vez de duplicarlo.
--
-- SEGURIDAD: el trigger no es SECURITY DEFINER; la función es IMMUTABLE y
--   ya existía. No cambia RLS ni grants.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.normalize_config_competitor_name()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.competitor_name := public.normalize_competitor_name(NEW.competitor_name, 'Corp');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_competitor_name ON public.competitor_commissions;
CREATE TRIGGER trg_normalize_competitor_name
  BEFORE INSERT OR UPDATE OF competitor_name ON public.competitor_commissions
  FOR EACH ROW EXECUTE FUNCTION public.normalize_config_competitor_name();

DROP TRIGGER IF EXISTS trg_normalize_competitor_name ON public.competitor_bonuses;
CREATE TRIGGER trg_normalize_competitor_name
  BEFORE INSERT OR UPDATE OF competitor_name ON public.competitor_bonuses
  FOR EACH ROW EXECUTE FUNCTION public.normalize_config_competitor_name();

DROP TRIGGER IF EXISTS trg_normalize_competitor_name ON public.competitive_bands;
CREATE TRIGGER trg_normalize_competitor_name
  BEFORE INSERT OR UPDATE OF competitor_name ON public.competitive_bands
  FOR EACH ROW EXECUTE FUNCTION public.normalize_config_competitor_name();

-- 2. Dedupe comisiones: sobrevive la más reciente por clave canónica.
DELETE FROM public.competitor_commissions c
USING (
  SELECT id,
         row_number() OVER (
           PARTITION BY country, city, public.normalize_competitor_name(competitor_name, 'Corp')
           ORDER BY updated_at DESC NULLS LAST, id DESC
         ) AS rn
  FROM public.competitor_commissions
) d
WHERE c.id = d.id AND d.rn > 1;

-- 3. Backfill explícito. (El trigger sí dispara en cualquier UPDATE que
--    mencione competitor_name en el SET, valga lo mismo o no; se escribe el
--    canónico igual porque la función es idempotente y así el WHERE deja el
--    UPDATE acotado a las filas que de verdad cambian.)
UPDATE public.competitor_commissions
   SET competitor_name = public.normalize_competitor_name(competitor_name, 'Corp')
 WHERE competitor_name IS DISTINCT FROM public.normalize_competitor_name(competitor_name, 'Corp');

UPDATE public.competitor_bonuses
   SET competitor_name = public.normalize_competitor_name(competitor_name, 'Corp')
 WHERE competitor_name IS DISTINCT FROM public.normalize_competitor_name(competitor_name, 'Corp');

UPDATE public.competitive_bands
   SET competitor_name = public.normalize_competitor_name(competitor_name, 'Corp')
 WHERE competitor_name IS DISTINCT FROM public.normalize_competitor_name(competitor_name, 'Corp');

-- 4. Unicidad hacia adelante: ya la garantizan los índices parciales
--    competitor_commissions_ctry_comp_null_idx (city IS NULL) y
--    competitor_commissions_ctry_comp_city_idx. Con el trigger delante, la
--    forma con espacio ahora colisiona contra la pegada en vez de duplicarla.

-- Verificación: debe quedar 0 en las tres tablas.
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM (
    SELECT competitor_name FROM public.competitor_commissions
    UNION ALL SELECT competitor_name FROM public.competitor_bonuses
    UNION ALL SELECT competitor_name FROM public.competitive_bands
  ) x WHERE competitor_name IS DISTINCT FROM public.normalize_competitor_name(competitor_name, 'Corp');
  IF v > 0 THEN RAISE EXCEPTION 'mig 239: quedan % nombres no canónicos', v; END IF;
  RAISE NOTICE 'mig 239: 0 nombres no canónicos en tablas de configuración';
END $$;

COMMIT;
