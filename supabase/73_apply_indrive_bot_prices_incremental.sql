-- ════════════════════════════════════════════════════════════════════════
-- Migración 73 — apply_indrive_bot_prices incremental / idempotente
--
-- PROBLEMA OBSERVADO (2026-05-23):
--   El botón "⟳ Precios InDrive (bot)" del módulo Gestión de Datos
--   devolvía "canceling statement due to statement timeout" durante el
--   catch-up del sync (watermark con 26 días de atraso → cientos de miles
--   de filas InDrive nuevas en pricing_observations).
--
--   Causa: la versión anterior (mig 65) hacía un UPDATE sobre TODAS las
--   filas InDrive bot del país, recomputando price_without_discount aún
--   cuando la fila ya tenía el valor correcto desde un click anterior.
--   El write masivo + WAL competía con los INSERTs del sync y reventaba
--   el statement_timeout.
--
-- FIX:
--   Agregar un guard `price_without_discount IS DISTINCT FROM <expected>`
--   en el WHERE. PG sigue escaneando las filas InDrive (rápido con
--   idx_po_competitor + filtro por country), pero solo escribe las que
--   realmente difieren. Después del primer click todas las filas ya
--   coinciden → re-runs son ~no-op, milisegundos.
--
--   Self-healing: si alguien sube el adjustment_pct en indrive_config,
--   las filas viejas dejan de coincidir y se actualizan en la próxima
--   corrida. Nada que recordar manualmente.
--
-- FIRMA / COMPAT:
--   Misma firma que mig 65 — (p_country, p_city, p_category). El JS de
--   RawData.jsx llama por nombre y no cambia.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

DROP FUNCTION IF EXISTS apply_indrive_bot_prices(text, text, text);

CREATE OR REPLACE FUNCTION apply_indrive_bot_prices(
  p_country  text,
  p_city     text DEFAULT NULL,
  p_category text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  updated_count integer;
BEGIN
  UPDATE pricing_observations po
  SET price_without_discount = ROUND(
    po.recommended_price * (1 + ic.adjustment_pct / 100.0),
    2
  )
  FROM indrive_config ic
  WHERE po.competition_name  = 'InDrive'
    AND po.data_source        = 'bot'
    AND po.recommended_price IS NOT NULL
    AND po.recommended_price  > 0
    AND po.country            = p_country
    AND po.city               = ic.city
    AND po.category           = ic.category
    AND ic.country            = p_country
    AND (p_city     IS NULL OR po.city     = p_city)
    AND (p_category IS NULL OR po.category = p_category)
    -- Guard idempotente: saltar filas que ya tienen el valor esperado.
    -- Sin esto, cada click reescribía cientos de miles de filas
    -- innecesariamente y rompía statement_timeout durante el catch-up.
    AND po.price_without_discount IS DISTINCT FROM
        ROUND(po.recommended_price * (1 + ic.adjustment_pct / 100.0), 2);

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

GRANT EXECUTE ON FUNCTION apply_indrive_bot_prices(text, text, text)
  TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   1. Primer click después del sync → devuelve N (filas nuevas ajustadas).
--   2. Segundo click inmediato → devuelve 0 (todas ya coinciden).
--   3. Cambiar indrive_config.adjustment_pct → próximo click devuelve
--      el total de filas afectadas para esa city/category.
-- ════════════════════════════════════════════════════════════════════════
