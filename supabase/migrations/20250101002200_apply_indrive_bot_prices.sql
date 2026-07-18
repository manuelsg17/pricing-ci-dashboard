-- ============================================================
-- Función RPC: apply_indrive_bot_prices(p_city, p_category)
-- Recalcula price_without_discount para filas InDrive del bot
-- usando los porcentajes de ajuste configurados en indrive_config.
--
-- Fórmula: price_without_discount = recommended_price × (1 + adjustment_pct / 100)
--
-- También se instala un trigger en indrive_config para que el
-- recálculo ocurra automáticamente al guardar ajustes desde la app.
-- ============================================================

-- ── Función principal (RPC) ───────────────────────────────────
CREATE OR REPLACE FUNCTION apply_indrive_bot_prices(
  p_city     text DEFAULT NULL,
  p_category text DEFAULT NULL
)
RETURNS integer   -- cantidad de filas actualizadas
LANGUAGE plpgsql SECURITY DEFINER AS $$
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
    AND po.city               = ic.city
    AND po.category           = ic.category
    AND (p_city     IS NULL OR po.city     = p_city)
    AND (p_category IS NULL OR po.category = p_category);

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

GRANT EXECUTE ON FUNCTION apply_indrive_bot_prices(text, text) TO authenticated;

-- ── Función trigger (FOR EACH ROW) ───────────────────────────
-- Se dispara al guardar ajustes desde Config > InDrive.
-- Actualiza solo las filas de la ciudad/categoría modificada.
CREATE OR REPLACE FUNCTION trg_apply_indrive_prices_on_config()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE pricing_observations
  SET price_without_discount = ROUND(
    recommended_price * (1 + NEW.adjustment_pct / 100.0),
    2
  )
  WHERE competition_name  = 'InDrive'
    AND data_source        = 'bot'
    AND recommended_price IS NOT NULL
    AND recommended_price  > 0
    AND city               = NEW.city
    AND category           = NEW.category;
  RETURN NEW;
END;
$$;

-- ── Trigger ──────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_indrive_config_change ON indrive_config;
CREATE TRIGGER trg_indrive_config_change
  AFTER INSERT OR UPDATE ON indrive_config
  FOR EACH ROW
  EXECUTE FUNCTION trg_apply_indrive_prices_on_config();
