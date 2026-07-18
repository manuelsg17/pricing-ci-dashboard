-- ════════════════════════════════════════════════════════════════════════
-- Migración 122 — Desacoplar la reescritura de precios del bot de InDrive
--
-- SÍNTOMA:
--   Tras arreglar el snapshot (mig 121), guardar los ajustes de InDrive seguía
--   fallando con "Error al guardar: canceling statement due to statement timeout".
--
-- CAUSA:
--   El upsert a indrive_config dispara el trigger AFTER UPDATE
--   `trg_indrive_config_propagate`, que corría UN `UPDATE pricing_observations`
--   POR CADA fila cambiada, reescribiendo TODAS las filas históricas del bot de
--   esa ciudad/categoría. Medido: Lima Economy/Comfort = 17,845 filas (~3s en
--   frío) SOLO para una; con ~14 filas cambiadas se pasa de los 8s del rol
--   `authenticated`. El `SET statement_timeout='120s'` del trigger NO aplica (el
--   timer de 8s del upsert ya está armado; un SET interno no lo re-arma — mismo
--   footgun de mig 119). El volumen (decenas de miles de filas) no cabe en 8s
--   síncrono por más índice que haya.
--
-- FIX (desacople):
--   1) El trigger de config se vuelve LIVIANO (no reescribe nada inline) →
--      guardar el % es instantáneo (solo escribe la config).
--   2) `reconcile_indrive_bot_prices()`: un solo UPDATE set-based, idempotente
--      (guard IS DISTINCT FROM), para TODOS los países, joineando indrive_config.
--      Corre como `postgres` (statement_timeout 600s), sin el cap de 8s.
--   3) pg_cron cada 10 min ejecuta el reconcile → auto-sanable. El INSERT trigger
--      `zz_indrive_price_before_insert` sigue aplicando el % a filas nuevas.
--
--   Efecto: guardar es instantáneo; el precio efectivo del bot en el dashboard se
--   actualiza en ≤10 min (+ refresh de MV). El snapshot (freeze_pricing_wa) sigue
--   corriendo ANTES del upsert, así que el "congelado" pre-cambio se preserva.
-- ════════════════════════════════════════════════════════════════════════

-- 1) Trigger de config → no-op (la propagación ahora es en segundo plano)
CREATE OR REPLACE FUNCTION public.trg_indrive_config_propagate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  -- DESACOPLADO (mig 122): ya NO reescribe pricing_observations inline.
  -- La reescritura la hace reconcile_indrive_bot_prices() vía pg_cron (cada
  -- 10 min, como postgres, sin el cap de 8s del browser). Se mantiene el trigger
  -- por compatibilidad, pero es un no-op.
  RETURN NEW;
END;
$function$;

-- 2) Reconcile set-based, idempotente, todos los países
CREATE OR REPLACE FUNCTION public.reconcile_indrive_bot_prices()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '600s'
AS $function$
DECLARE
  v_updated int;
BEGIN
  UPDATE pricing_observations po
  SET price_without_discount = ROUND(po.recommended_price * (1 + ic.adjustment_pct / 100.0), 2)
  FROM indrive_config ic
  WHERE po.competition_name  = 'InDrive'
    AND po.data_source        = 'bot'
    AND po.recommended_price IS NOT NULL
    AND po.recommended_price  > 0
    AND ic.country            = po.country
    AND ic.city               = po.city
    AND ic.category           = po.category
    AND po.price_without_discount IS DISTINCT FROM
        ROUND(po.recommended_price * (1 + ic.adjustment_pct / 100.0), 2);

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$function$;

-- 3) pg_cron: reconciliar cada 10 minutos (idempotente; no-op si nada cambió)
SELECT cron.schedule(
  'reconcile-indrive-bot-prices',
  '*/10 * * * *',
  'SELECT public.reconcile_indrive_bot_prices()'
);
