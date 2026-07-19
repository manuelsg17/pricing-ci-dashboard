-- ════════════════════════════════════════════════════════════════════════
-- Fix: "combos no matcheados" en BotRulesTable.jsx quedaba desactualizado
-- hasta 7 días después de arreglar una regla.
--
-- Hallazgo (2026-07-19): list_unmatched_combos() sumaba dropped_combos de
-- TODAS las corridas 'ok' de bot_sync_log dentro de p_days (la UI llama con
-- p_days=7) — una vez que un combo quedaba resuelto (regla nueva agregada),
-- seguía apareciendo en la suma hasta que esa corrida vieja se caía de la
-- ventana. Confirmado en vivo: el usuario agregó una regla para
-- indrive/economy/"viajes económicos" a las 17:21, la corrida de las 17:31
-- ya no la dropeaba — pero el banner de la UI (ventana de 7 días) seguía
-- mostrándola como no matcheada, dando la falsa impresión de que la regla
-- no había funcionado.
--
-- Fix: en vez de sumar N días de historia, leer solo dropped_combos de la
-- corrida 'ok' MÁS RECIENTE (p_days pasa a ser solo un tope de cuánto para
-- atrás buscar esa última corrida, por si el sync estuvo caído varios días
-- — sigue con default 2, la UI sigue llamando con p_days=7). Cada corrida
-- ya agrupa sus propios combos (GROUP BY app/vc/ovc/db_city dentro de
-- sync_bot_quotes()/bot_sync_push.py), así que no hace falta re-sumar.
-- Resultado: el banner se autocorrige en el siguiente sync (~1h) en vez de
-- tardar hasta una semana.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.list_unmatched_combos(p_country text, p_days integer DEFAULT 2)
 RETURNS TABLE(app text, vc text, ovc text, db_city text, total_n bigint)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH last_run AS (
    SELECT notes->'dropped_combos' AS dropped_combos
    FROM bot_sync_log
    WHERE country = p_country
      AND status  = 'ok'
      AND started_at > NOW() - (p_days || ' days')::interval
      AND notes ? 'dropped_combos'
    ORDER BY started_at DESC
    LIMIT 1
  )
  SELECT
    (combo->>'app')         AS app,
    (combo->>'vc')          AS vc,
    (combo->>'ovc')         AS ovc,
    (combo->>'db_city')     AS db_city,
    ((combo->>'n')::bigint) AS total_n
  FROM last_run,
       LATERAL jsonb_array_elements(dropped_combos) AS combo
  ORDER BY total_n DESC
  LIMIT 50;
$function$;
