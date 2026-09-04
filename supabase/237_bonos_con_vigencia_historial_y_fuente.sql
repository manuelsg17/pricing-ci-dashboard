-- ════════════════════════════════════════════════════════════════════════
-- Migración 237 — Bonos con VIGENCIA, HISTORIAL y FUENTE (Fase A del plan
-- "estandarizar Análisis / actualizar bonos", 2026-09-03)
--
-- PROBLEMA:
--   `competitor_bonuses` y `yango_gmv_tiers` no tenían fecha desde/hasta:
--   Rentabilidad mostraba precios de la semana elegida pero SIEMPRE los
--   bonos y escaleras de hoy — la comparación histórica estaba mal por
--   construcción. Editar un bono pisaba el anterior sin rastro, y no había
--   forma de responder "¿de qué informe salió y para qué semana valía?".
--
-- SOLUCIÓN (aditiva, sin backfill destructivo):
--   - `valid_from` / `valid_to` (NULL = sigue vigente) en ambas tablas.
--     Lo existente queda vigente desde 2025-07-01 (inicio de los datos) y
--     abierto: nada cambia para la vista de hoy.
--   - Procedencia: `source_type` (informe_msye | captura | estimado | seed),
--     `source_ref` (link/ID del informe), `reported_week` (lunes de la
--     semana del informe), `captured_by` (email, lo estampa un trigger).
--   - Versionado ATÓMICO por RPC: `competitor_bonus_new_version` cierra la
--     versión vigente (valid_to = nuevo desde − 1 día) e inserta la copia
--     con los cambios; `yango_gmv_ladder_new_version` hace lo mismo con
--     una escalera completa (ciudad × variante). El UPDATE directo sigue
--     existiendo para corregir un error de tipeo dentro de la misma versión.
--   - `yango_gmv_tiers` tenía UNIQUE (country, city, variant, min_trips):
--     impedía dos versiones del mismo peldaño. Se reemplaza por el mismo
--     UNIQUE + valid_from.
--
-- SEGURIDAD: las RPCs son SECURITY DEFINER con search_path fijo, gateadas
--   por `can_write_table(<tabla>)` (= section_write_grants, sección
--   'config') + `require_country_access`. Sin EXECUTE para anon.
--   No hay política nueva: las de mig 167/188 siguen intactas.
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1. Columnas ──────────────────────────────────────────────────────────
ALTER TABLE public.competitor_bonuses
  ADD COLUMN IF NOT EXISTS valid_from    date NOT NULL DEFAULT '2025-07-01',
  ADD COLUMN IF NOT EXISTS valid_to      date,
  ADD COLUMN IF NOT EXISTS source_type   text NOT NULL DEFAULT 'seed',
  ADD COLUMN IF NOT EXISTS source_ref    text,
  ADD COLUMN IF NOT EXISTS reported_week date,
  ADD COLUMN IF NOT EXISTS captured_by   text;

ALTER TABLE public.yango_gmv_tiers
  ADD COLUMN IF NOT EXISTS valid_from    date NOT NULL DEFAULT '2025-07-01',
  ADD COLUMN IF NOT EXISTS valid_to      date,
  ADD COLUMN IF NOT EXISTS source_type   text NOT NULL DEFAULT 'seed',
  ADD COLUMN IF NOT EXISTS source_ref    text,
  ADD COLUMN IF NOT EXISTS reported_week date,
  ADD COLUMN IF NOT EXISTS captured_by   text;

-- Lo existente ya quedó como 'seed' vigente desde 2025-07-01. De acá en
-- adelante una fila nueva empieza HOY y se declara como captura, salvo que
-- el cliente diga otra cosa.
ALTER TABLE public.competitor_bonuses
  ALTER COLUMN valid_from SET DEFAULT CURRENT_DATE,
  ALTER COLUMN source_type SET DEFAULT 'captura';
ALTER TABLE public.yango_gmv_tiers
  ALTER COLUMN valid_from SET DEFAULT CURRENT_DATE,
  ALTER COLUMN source_type SET DEFAULT 'captura';

ALTER TABLE public.competitor_bonuses
  ADD CONSTRAINT competitor_bonuses_validity_chk CHECK (valid_to IS NULL OR valid_to >= valid_from),
  ADD CONSTRAINT competitor_bonuses_source_type_chk
    CHECK (source_type IN ('informe_msye', 'captura', 'estimado', 'seed'));
ALTER TABLE public.yango_gmv_tiers
  ADD CONSTRAINT yango_gmv_tiers_validity_chk CHECK (valid_to IS NULL OR valid_to >= valid_from),
  ADD CONSTRAINT yango_gmv_tiers_source_type_chk
    CHECK (source_type IN ('informe_msye', 'captura', 'estimado', 'seed'));

-- ── 2. UNIQUE de la escalera Yango: ahora por versión ────────────────────
DO $$
DECLARE v_name text;
BEGIN
  SELECT conname INTO v_name FROM pg_constraint
  WHERE conrelid = 'public.yango_gmv_tiers'::regclass AND contype = 'u'
    AND conkey = (SELECT array_agg(attnum ORDER BY attnum) FROM pg_attribute
                  WHERE attrelid = 'public.yango_gmv_tiers'::regclass
                    AND attname IN ('country','city','variant','min_trips'));
  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.yango_gmv_tiers DROP CONSTRAINT %I', v_name);
  END IF;
END $$;
ALTER TABLE public.yango_gmv_tiers
  ADD CONSTRAINT yango_gmv_tiers_version_key UNIQUE (country, city, variant, min_trips, valid_from);

CREATE INDEX IF NOT EXISTS competitor_bonuses_validity_idx
  ON public.competitor_bonuses (country, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS yango_gmv_tiers_validity_idx
  ON public.yango_gmv_tiers (country, city, valid_from, valid_to);

-- ── 3. captured_by lo estampa la base (no confiar en el cliente) ─────────
CREATE OR REPLACE FUNCTION public.stamp_captured_by()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.captured_by IS NULL THEN
    NEW.captured_by := (SELECT auth.email());
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS competitor_bonuses_stamp_captured_by ON public.competitor_bonuses;
CREATE TRIGGER competitor_bonuses_stamp_captured_by
  BEFORE INSERT ON public.competitor_bonuses FOR EACH ROW EXECUTE FUNCTION public.stamp_captured_by();
DROP TRIGGER IF EXISTS yango_gmv_tiers_stamp_captured_by ON public.yango_gmv_tiers;
CREATE TRIGGER yango_gmv_tiers_stamp_captured_by
  BEFORE INSERT ON public.yango_gmv_tiers FOR EACH ROW EXECUTE FUNCTION public.stamp_captured_by();

-- ── 4. Nueva versión de UN bono (cierra la vigente + inserta copia) ──────
-- `lineage_id` (self-FK, mig 237) identifica todas las versiones de "el mismo
-- bono" — sin esto, versionar dos veces la misma fila (o versionar una fila
-- que ya fue reemplazada por otra) dejaba DOS versiones abiertas que se
-- SUMABAN en Rentabilidad (hallazgo #1, revisión adversarial 2026-09-03).
ALTER TABLE public.competitor_bonuses
  ADD COLUMN IF NOT EXISTS lineage_id integer;
UPDATE public.competitor_bonuses SET lineage_id = id WHERE lineage_id IS NULL;
ALTER TABLE public.competitor_bonuses
  ALTER COLUMN lineage_id SET NOT NULL,
  ADD CONSTRAINT competitor_bonuses_lineage_fk
    FOREIGN KEY (lineage_id) REFERENCES public.competitor_bonuses(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS competitor_bonuses_lineage_idx ON public.competitor_bonuses (lineage_id);

CREATE OR REPLACE FUNCTION public.competitor_bonus_new_version(
  p_id integer, p_valid_from date, p_changes jsonb DEFAULT '{}'::jsonb, p_valid_to date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_old    public.competitor_bonuses;
  v_latest date;
  v_row    jsonb;
  v_new_id integer;
BEGIN
  IF NOT can_write_table('competitor_bonuses') THEN
    RAISE EXCEPTION 'No tenés permiso para editar bonos.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_old FROM public.competitor_bonuses WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El bono % no existe.', p_id USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM require_country_access(v_old.country);
  IF p_valid_from IS NULL OR p_valid_from <= v_old.valid_from THEN
    RAISE EXCEPTION 'invalid_valid_from' USING ERRCODE = 'check_violation',
      DETAIL = v_old.valid_from::text;
  END IF;
  IF p_valid_to IS NOT NULL AND p_valid_to < p_valid_from THEN
    RAISE EXCEPTION 'invalid_valid_to' USING ERRCODE = 'check_violation';
  END IF;

  -- La versión más nueva del linaje (no necesariamente p_id, si ya se
  -- versionó desde otra fila del mismo linaje). Versionar SIEMPRE parte de
  -- ahí — nunca de una fila ya reemplazada — para no dejar huecos ni
  -- solapes silenciosos.
  SELECT max(valid_from) INTO v_latest
  FROM public.competitor_bonuses WHERE lineage_id = v_old.lineage_id;
  IF v_old.valid_from <> v_latest THEN
    RAISE EXCEPTION 'not_latest_version' USING ERRCODE = 'check_violation',
      DETAIL = v_latest::text;
  END IF;

  UPDATE public.competitor_bonuses
  SET valid_to = p_valid_from - 1, updated_at = now()
  WHERE lineage_id = v_old.lineage_id AND valid_from = v_latest;

  -- Copia + cambios. Nunca se puede cambiar id/país/linaje/vigencia por p_changes.
  v_row := (to_jsonb(v_old) - 'id' - 'updated_at' - 'valid_to' - 'captured_by' - 'lineage_id')
        || (COALESCE(p_changes, '{}'::jsonb)
            - 'id' - 'country' - 'valid_from' - 'valid_to' - 'captured_by' - 'lineage_id')
        || jsonb_build_object(
             'id', nextval(pg_get_serial_sequence('public.competitor_bonuses', 'id')),
             'lineage_id', v_old.lineage_id,
             'valid_from', p_valid_from,
             'valid_to', p_valid_to,
             'updated_at', now(),
             'captured_by', (SELECT auth.email()),
             'source_type', COALESCE(NULLIF(p_changes->>'source_type', ''), 'captura'));
  INSERT INTO public.competitor_bonuses
  SELECT * FROM jsonb_populate_record(NULL::public.competitor_bonuses, v_row)
  RETURNING id INTO v_new_id;
  RETURN v_new_id;
END;
$$;
REVOKE ALL ON FUNCTION public.competitor_bonus_new_version(integer, date, jsonb, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.competitor_bonus_new_version(integer, date, jsonb, date) TO authenticated;
COMMENT ON FUNCTION public.competitor_bonus_new_version(integer, date, jsonb, date) IS
  'mig 237: versiona un bono dentro de su linaje — solo desde la versión más nueva (rechaza versionar una fila ya reemplazada, evita duplicados y huecos). Gate: can_write_table + país.';

-- ── 5. Nueva versión de una ESCALERA Yango (ciudad × variante) ───────────
CREATE OR REPLACE FUNCTION public.yango_gmv_ladder_new_version(
  p_country text, p_city text, p_variant text, p_valid_from date, p_tiers jsonb,
  p_source_type text DEFAULT 'captura', p_source_ref text DEFAULT NULL, p_reported_week date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_n integer;
BEGIN
  IF NOT can_write_table('yango_gmv_tiers') THEN
    RAISE EXCEPTION 'No tenés permiso para editar el bono GMV de Yango.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);
  IF p_variant NOT IN ('unbranded', 'branded', 'vip') THEN
    RAISE EXCEPTION 'Variante inválida: %', p_variant USING ERRCODE = 'check_violation';
  END IF;
  IF p_valid_from IS NULL THEN
    RAISE EXCEPTION 'Falta la fecha desde la que rige la escalera.' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_tiers) <> 'array' OR jsonb_array_length(p_tiers) = 0 THEN
    RAISE EXCEPTION 'La escalera necesita al menos un peldaño.' USING ERRCODE = 'check_violation';
  END IF;
  -- Peldaños repetidos o inválidos: error propio, no el del UNIQUE (que llega
  -- crudo al usuario con el nombre del constraint).
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_tiers) t
    GROUP BY (t->>'min_trips')::integer HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_tiers) t
    WHERE COALESCE((t->>'min_trips')::integer, -1) < 0
       OR COALESCE((t->>'pct')::numeric, -1) < 0 OR COALESCE((t->>'cap')::numeric, -1) < 0
  ) THEN
    RAISE EXCEPTION 'Peldaños repetidos o con valores inválidos (viajes, %% o tope).' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.yango_gmv_tiers
             WHERE country = p_country AND city = p_city AND variant = p_variant
               AND valid_from >= p_valid_from) THEN
    RAISE EXCEPTION 'Ya existe una versión de esta escalera que empieza el % o después.', p_valid_from
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.yango_gmv_tiers
  SET valid_to = p_valid_from - 1, updated_at = now()
  WHERE country = p_country AND city = p_city AND variant = p_variant
    AND valid_from < p_valid_from AND (valid_to IS NULL OR valid_to >= p_valid_from);

  INSERT INTO public.yango_gmv_tiers
    (country, city, variant, min_trips, pct, cap, is_active, valid_from, source_type, source_ref, reported_week)
  SELECT p_country, p_city, p_variant,
         (t->>'min_trips')::integer, (t->>'pct')::numeric, (t->>'cap')::numeric,
         true, p_valid_from, COALESCE(p_source_type, 'captura'), p_source_ref, p_reported_week
  FROM jsonb_array_elements(p_tiers) t;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.yango_gmv_ladder_new_version(text, text, text, date, jsonb, text, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.yango_gmv_ladder_new_version(text, text, text, date, jsonb, text, text, date) TO authenticated;
COMMENT ON FUNCTION public.yango_gmv_ladder_new_version(text, text, text, date, jsonb, text, text, date) IS
  'mig 237: nueva versión de una escalera Yango GMV (ciudad×variante): cierra la vigente e inserta los peldaños nuevos. Gate: can_write_table + país.';

COMMIT;

-- Verificación:
--   SELECT competitor_name, city, valid_from, valid_to, source_type FROM competitor_bonuses ORDER BY 1;
--   SELECT conname FROM pg_constraint WHERE conrelid='public.yango_gmv_tiers'::regclass AND contype='u';
--   -- como authenticated con permiso: SELECT competitor_bonus_new_version(<id>, current_date, '{"bonus_amount": 99}');
