-- ════════════════════════════════════════════════════════════════════════
-- Migración 93 — Drop entradas legacy en indrive_config
--
-- CONTEXTO:
--   En algún momento del histórico se renombraron categorías:
--     'Economy'  → 'Economy/Comfort'
--     'Comfort'  → 'Comfort+'
--   pricing_observations + bot_rules + country_config se actualizaron pero
--   indrive_config quedó con AMBOS nombres conviviendo para Lima/Trujillo/
--   Arequipa. Los nombres legacy no se usan en ningún lookup hoy:
--     - El trigger trg_apply_indrive_price_on_insert (mig 86) hace lookup
--       por category EXACTA contra NEW.category, que siempre es 'Comfort+'
--       o 'Economy/Comfort' (la bot_rule lo normaliza).
--     - apply_indrive_bot_prices (mig 75) hace JOIN por category exacta.
--   Las filas con category='Comfort'/'Economy' son data muerta.
--
-- QUÉ HACE:
--   DELETE de las 6 filas legacy (Lima/Trujillo/Arequipa × Comfort/Economy).
--   Idempotente: si ya se borraron, no hace nada.
--
-- DEFENSIVO:
--   - WHERE strictly bound al país Peru y a las 6 combos exactas.
--   - Si se borrara algo no esperado, ROLLBACK manual desde Supabase.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

DELETE FROM public.indrive_config
WHERE country = 'Peru'
  AND (
    (city = 'Lima'     AND category IN ('Comfort', 'Economy')) OR
    (city = 'Trujillo' AND category IN ('Comfort', 'Economy')) OR
    (city = 'Arequipa' AND category IN ('Comfort', 'Economy'))
  );

-- Verificación
DO $check$
DECLARE
  v_remaining int;
BEGIN
  SELECT count(*) INTO v_remaining
  FROM public.indrive_config
  WHERE country = 'Peru'
    AND city IN ('Lima','Trujillo','Arequipa')
    AND category IN ('Comfort', 'Economy');

  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'Mig 93: quedan % filas legacy sin borrar — investigar.', v_remaining;
  END IF;

  RAISE NOTICE 'Mig 93 OK: 0 filas legacy restantes en indrive_config.';
END
$check$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN POST-APLICACIÓN
--   SELECT city, category, adjustment_pct FROM indrive_config
--   WHERE country='Peru' ORDER BY city, category;
--
--   Esperado:
--     Arequipa            Comfort+         11.9
--     Arequipa            Economy/Comfort  32.5
--     Arequipa            XL                  0
--     Arequipa_Airport_A  ... (3 filas)
--     Arequipa_Airport_B  ... (3 filas)
--     Lima                Comfort+         22.3
--     Lima                Economy/Comfort  25.2
--     Lima                Premier             0
--     Lima                TukTuk              0
--     Lima                XL                  0
--     Lima_Airport_A      ... (4 filas)
--     Lima_Airport_B      ... (4 filas)
--     Trujillo            Comfort+         14.9
--     Trujillo            Economy/Comfort  21.3
--     Trujillo            XL                  0
--     Trujillo_Airport_A  ... (3 filas)
--     Trujillo_Airport_B  ... (3 filas)
--
--   Sin filas con category='Comfort' o 'Economy'.
-- ════════════════════════════════════════════════════════════════════════
