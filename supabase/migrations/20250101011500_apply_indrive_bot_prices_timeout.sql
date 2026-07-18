-- ════════════════════════════════════════════════════════════════════════
-- Migración 75 — apply_indrive_bot_prices con statement_timeout dedicado
--
-- CONTEXTO:
--   La mig 73 introdujo el guard idempotente. Funciona bien EN STEADY
--   STATE: re-runs son ~0 filas y vuelven en ms.
--
--   Pero después del catch-up del sync (26 días) hay 22k+ filas InDrive
--   bot pendientes de ajustar en la primera corrida. Eso son ~20-60s de
--   UPDATE en Supabase Free/Pro, lo que excede el statement_timeout
--   default del rol `authenticated` (8s) y se cancela.
--
-- FIX:
--   `SET statement_timeout = '120s'` a nivel de función. PG aplica el
--   timeout más permisivo del par (rol vs función) cuando entra al
--   SECURITY DEFINER. La mayoría de las clicks ahora son no-op (~ms),
--   solo el primero después de un catch-up grande puede tomar ~minuto.
--
--   No subimos el timeout del rol entero porque eso degrada el resto
--   del dashboard (queries lentas accidentales no fallarían rápido).
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
SET statement_timeout = '120s'
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
--   1. Verificar que el timeout quedó aplicado:
--      SELECT proname, proconfig FROM pg_proc
--      WHERE proname = 'apply_indrive_bot_prices';
--      proconfig debe contener "statement_timeout=120s".
--
--   2. Click "⟳ Precios InDrive (bot)" — primera vez ~30-90s, devuelve
--      22122 (o el N actual). Próximos clicks: 0 filas, instantáneo.
-- ════════════════════════════════════════════════════════════════════════
