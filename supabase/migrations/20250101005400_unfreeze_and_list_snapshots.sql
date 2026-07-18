-- ════════════════════════════════════════════════════════════════════════
-- Migración 54 — Gestión de snapshots de pricing_wa_frozen
--
-- POR QUÉ:
--   freeze_pricing_wa() crea snapshots (hard copy) que congelan los
--   valores históricos antes de aplicar cambios de pesos/umbrales. Pero
--   no hay forma de:
--     (a) Listar qué snapshots existen para un país
--     (b) Eliminar un snapshot específico si el operador decidió que el
--         cambio no aplicaba
--
--   Esta migración agrega dos RPCs simples + un wrapper que permite
--   guardar SIN crear snapshot ("modo confianza" para cambios pequeños
--   que no afectan datos históricos significativamente).
--
-- RPCs:
--   list_pricing_wa_snapshots(country) — devuelve cada (frozen_label,
--     frozen_at, rows_count) único.
--
--   unfreeze_pricing_wa(country, label) — elimina TODAS las filas con
--     ese label. Devuelve cantidad eliminada.
--
--   unfreeze_pricing_wa_by_id(country, id_list) — elimina filas por
--     PK (variante granular).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A. list_pricing_wa_snapshots ──────────────────────────────────────
-- Agrega por (frozen_label, frozen_at, country) — un "snapshot lógico"
-- es el conjunto de filas creadas en una sola corrida de freeze_pricing_wa.
-- DATE_TRUNC('second', frozen_at) agrupa filas creadas en el mismo segundo.

CREATE OR REPLACE FUNCTION list_pricing_wa_snapshots(p_country text)
RETURNS TABLE (
  frozen_label      text,
  frozen_at_second  timestamptz,
  rows_count        bigint,
  weeks_count       bigint,
  cities_count      bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    COALESCE(frozen_label, '(sin etiqueta)')      AS frozen_label,
    DATE_TRUNC('second', frozen_at)::timestamptz  AS frozen_at_second,
    count(*)                                       AS rows_count,
    count(DISTINCT (year, week))                   AS weeks_count,
    count(DISTINCT city)                           AS cities_count
  FROM pricing_wa_frozen
  WHERE country = p_country
  GROUP BY 1, 2
  ORDER BY 2 DESC;
$$;

GRANT EXECUTE ON FUNCTION list_pricing_wa_snapshots(text) TO authenticated;

COMMENT ON FUNCTION list_pricing_wa_snapshots(text) IS
  'Lista los snapshots únicos por (label, timestamp truncado a segundo) para un país. Permite a la UI mostrar qué hard copies existen.';


-- ── B. unfreeze_pricing_wa por label ──────────────────────────────────
-- Elimina TODAS las filas frozen con ese label exacto. Devuelve count.
-- IMPORTANTE: usar con cuidado — re-freeze no es trivial si la
-- configuración de pesos cambió entre medias.

CREATE OR REPLACE FUNCTION unfreeze_pricing_wa(
  p_country text,
  p_label   text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count bigint := 0;
BEGIN
  IF p_country IS NULL OR p_label IS NULL THEN
    RAISE EXCEPTION 'p_country y p_label son obligatorios';
  END IF;

  DELETE FROM pricing_wa_frozen
  WHERE country = p_country
    AND COALESCE(frozen_label, '(sin etiqueta)') = p_label;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION unfreeze_pricing_wa(text, text) TO authenticated;

COMMENT ON FUNCTION unfreeze_pricing_wa(text, text) IS
  'Elimina TODAS las filas de pricing_wa_frozen con (country, frozen_label) específico. Devuelve cantidad de filas eliminadas. Después de unfreeze, los períodos vuelven a calcularse en vivo desde v_bracket_weekly_avg.';


-- ── C. unfreeze_pricing_wa_by_id ──────────────────────────────────────
-- Variante granular para eliminar filas específicas por PK.

CREATE OR REPLACE FUNCTION unfreeze_pricing_wa_by_id(
  p_country text,
  p_ids     bigint[]
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count bigint := 0;
BEGIN
  IF p_country IS NULL OR p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN 0;
  END IF;

  DELETE FROM pricing_wa_frozen
  WHERE country = p_country
    AND id = ANY(p_ids);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION unfreeze_pricing_wa_by_id(text, bigint[]) TO authenticated;


COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- USAR ASÍ:
--
--   -- Listar snapshots de Colombia:
--   SELECT * FROM list_pricing_wa_snapshots('Colombia');
--
--   -- Eliminar un snapshot específico:
--   SELECT unfreeze_pricing_wa(
--     'Colombia',
--     'Pesos cambiados — 2026-05-11T14:23:45.678Z'
--   );
--
--   -- En la UI: tab "Snapshots" en /config muestra ambos y permite
--   -- eliminar con un click.
-- ════════════════════════════════════════════════════════════════════════
