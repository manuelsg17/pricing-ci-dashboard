-- check-normalization-drift.sql
--
-- Fase 1.4 (paso 1 — monitoreo, sin tocar código todavía): detecta filas de
-- pricing_observations donde competition_name/distance_bracket guardado NO
-- coincide con lo que normalize_competitor_name()/normalize_distance_bracket()
-- producirían hoy. Es el chequeo que la propia normalización de la BD debería
-- garantizar en cada write — un resultado con filas es la señal de que el
-- trigger no corrió (path que lo evadió) o de que la lógica cambió de un
-- lado sin el otro.
--
-- Contexto (investigación 2026-07-18): competition_name SÍ tiene doble
-- normalización real (JS del cliente antes del insert + trigger SQL en el
-- insert) — hoy coinciden (0 divergencia en 1.36M filas), pero tardaron 4
-- migraciones (68→70→72→97) en converger, y es exactamente el patrón que
-- causó el incidente de corrupción de datos documentado en esas mismas
-- migraciones. distance_bracket es distinto: NO hay doble escritura, hay
-- cobertura desigual — la función SQL completa (mig 51) es código huérfano,
-- el pipeline vivo (scripts/bot-sync/bot_sync_push.py) tiene una versión
-- desactualizada sin ese fix, y el upload manual (Upload.jsx vía
-- src/lib/normalize.js normalizeBracket) casi no normaliza nada. Que hoy dé
-- ~0 filas es la ventana sana para monitorear ANTES de tocar el código —
-- correr esto periódicamente (ej. semanal) documenta si empieza a crecer.
--
-- Uso: correr contra producción vía MCP o local vía psql. Acotar con
-- country/observed_date si la tabla creció mucho (no hay índice funcional
-- de apoyo sobre estas expresiones).
SELECT
  data_source,
  count(*) FILTER (
    WHERE competition_name IS DISTINCT FROM public.normalize_competitor_name(competition_name, city)
  ) AS competitor_diverge,
  count(*) FILTER (
    WHERE distance_bracket IS DISTINCT FROM public.normalize_distance_bracket(distance_bracket)
  ) AS bracket_diverge,
  count(*) AS total
FROM pricing_observations
GROUP BY data_source
ORDER BY bracket_diverge DESC;
