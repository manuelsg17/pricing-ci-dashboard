-- ════════════════════════════════════════════════════════════════════════
-- Migración 90 — UNIQUE parcial para filas data_source='bot'
--
-- CONTEXTO:
--   scripts/bot-sync/bot_sync_push.py hace POST a /rest/v1/pricing_observations
--   SIN cabecera `resolution=merge-duplicates` y SIN restricción de unicidad
--   en la tabla. Resultado: si una corrida del bot falla a mitad de camino
--   y reintenta (o si el watermark se pierde / se rebobina), las filas se
--   re-insertan silenciosamente como duplicados. Hoy NO HAY forma de detectar
--   esto desde la app — los dashboards muestran promedios inflados sin
--   ninguna señal de error.
--
--   Migraciones previas relacionadas:
--     · mig 26 (upsert_pricing_batch) — uploads manuales hacen DELETE+INSERT,
--       no necesitan UNIQUE. NO debemos romper ese path.
--     · mig 35 (bot_sync_watermark)   — el watermark reduce la ventana de
--       duplicación pero no la elimina (reintentos dentro de la misma corrida
--       y rollback de watermark son casos reales).
--
-- DESIGN:
--   1. UNIQUE INDEX PARCIAL — sólo `WHERE data_source = 'bot'`.
--      · Razón: uploads manuales (data_source='manual'/'excel') legítimamente
--        pueden contener "duplicados" por re-subidas del mismo Excel; ese
--        path se maneja con DELETE+INSERT en upsert_pricing_batch (mig 26).
--      · Un UNIQUE total rompería esos re-uploads sin red de seguridad.
--
--   2. CLAVE NATURAL del bot (deriva del payload en bot_sync_push.py L667-686):
--        (country, city, observed_date, observed_time,
--         category, competition_name, distance_bracket, surge, data_source)
--      · `observed_time` con resolución de segundos (HH:MM:SS) — el bot emite
--        un único snapshot por (trip, momento). NO hay caso real de "mismo
--        viaje, mismo segundo, dos precios distintos".
--      · `data_source` redundante (el WHERE ya filtra a 'bot') pero lo dejamos
--        en la columna del índice para que PostgREST genere el on_conflict
--        completo y el planner pueda usar el índice en queries por data_source.
--      · `distance_bracket` y `surge` — distinguen casos legítimos: el mismo
--        viewport reportado con surge vs sin surge son observaciones distintas.
--
--   3. DEDUP PREVIO al CREATE — sin esto, la creación del índice falla con
--      "could not create unique index". El DELETE keepa la fila de MAYOR id
--      (= insertada más recientemente = más probable que tenga campos
--      enriquecidos por triggers posteriores).
--
--   4. DEFENSIVO — todo dentro de BEGIN/COMMIT. Si el COUNT de duplicados
--      antes vs después no cuadra, RAISE EXCEPTION y rollback.
--
-- PASOS:
--   (A) Contar duplicados existentes (informativo).
--   (B) DELETE de duplicados manteniendo MAX(id) por clave natural.
--   (C) Verificar post-DELETE (count debe ser 0).
--   (D) CREATE UNIQUE INDEX parcial.
--   (E) Verificar que el índice existe y reportar.
--
-- PERFORMANCE NOTE:
--   · El CREATE UNIQUE INDEX hace lock AccessExclusive sobre la tabla
--     durante la duración del build. Para tablas grandes (> 10M rows)
--     considerar CREATE UNIQUE INDEX CONCURRENTLY en una migración separada,
--     PERO eso no funciona dentro de un BEGIN/COMMIT. Si la tabla creció
--     mucho, partir esta migración en (90a: dedup + index normal en ventana
--     baja) o (90b: CONCURRENTLY fuera de transacción).
--   · El índice parcial es chico — sólo indexa filas bot, no afecta a
--     uploads manuales ni a triggers/RLS.
--
-- GOTCHA — NULLs:
--   PostgreSQL trata NULLs como DISTINTOS en UNIQUE indexes (default
--   NULLS DISTINCT, comportamiento SQL standard). Eso significa que si
--   `observed_time` o `distance_bracket` o `surge` son NULL en dos filas
--   con el resto idéntico, el índice NO las verá como duplicadas y
--   ambas pasarán. Para el bot esto es aceptable porque:
--     · observed_time → siempre seteado (derivado de timestamp_utc, L640-642)
--     · surge          → puede ser NULL si el bot no reporta; raro pero
--                        posible. Riesgo residual asumido.
--     · distance_bracket → puede ser NULL si normalize_distance_bracket
--                          devuelve None Y distance_km es NULL.
--   Si en el futuro queremos cerrar el agujero, usar NULLS NOT DISTINCT
--   (PG15+). Por ahora no, para no introducir comportamiento no-estándar.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── (A) Contar duplicados existentes (informativo) ──────────────────────
DO $count_pre$
DECLARE
  v_dup_groups bigint;
  v_dup_rows   bigint;
BEGIN
  WITH grp AS (
    SELECT country, city, observed_date, observed_time, category,
           competition_name, distance_bracket, surge, data_source,
           COUNT(*) AS n
      FROM public.pricing_observations
     WHERE data_source = 'bot'
     GROUP BY country, city, observed_date, observed_time, category,
              competition_name, distance_bracket, surge, data_source
    HAVING COUNT(*) > 1
  )
  SELECT COUNT(*), COALESCE(SUM(n - 1), 0)
    INTO v_dup_groups, v_dup_rows
    FROM grp;

  RAISE NOTICE '[mig 90] PRE-DEDUP · grupos con duplicados=% · filas a borrar=%',
               v_dup_groups, v_dup_rows;
END
$count_pre$;

-- ── (B) DELETE de duplicados — keep MAX(id) por clave natural ───────────
DO $dedup$
DECLARE
  v_deleted bigint;
BEGIN
  WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY country, city, observed_date, observed_time,
                          category, competition_name, distance_bracket,
                          surge, data_source
             ORDER BY id DESC
           ) AS rn
      FROM public.pricing_observations
     WHERE data_source = 'bot'
  ),
  victims AS (
    DELETE FROM public.pricing_observations po
     USING ranked r
     WHERE po.id = r.id
       AND r.rn > 1
    RETURNING po.id
  )
  SELECT COUNT(*) INTO v_deleted FROM victims;

  RAISE NOTICE '[mig 90] DEDUP · filas eliminadas=%', v_deleted;
END
$dedup$;

-- ── (C) Verificar post-DELETE: ya no debe quedar ningún duplicado ───────
DO $verify_clean$
DECLARE
  v_remaining bigint;
BEGIN
  SELECT COUNT(*) INTO v_remaining
    FROM (
      SELECT 1
        FROM public.pricing_observations
       WHERE data_source = 'bot'
       GROUP BY country, city, observed_date, observed_time, category,
                competition_name, distance_bracket, surge, data_source
      HAVING COUNT(*) > 1
    ) s;

  IF v_remaining > 0 THEN
    RAISE EXCEPTION
      '[mig 90] FALLO defensivo: quedan % grupos duplicados tras el DELETE — abortando para no crear UNIQUE INDEX inválido. Investigar manualmente.',
      v_remaining
      USING ERRCODE = 'data_exception';
  END IF;

  RAISE NOTICE '[mig 90] POST-DEDUP · duplicados restantes=0 (OK para crear UNIQUE INDEX).';
END
$verify_clean$;

-- ── (D) UNIQUE INDEX PARCIAL — sólo filas bot ───────────────────────────
-- Nombre del índice debe coincidir EXACTO con el on_conflict que PostgREST
-- recibe desde el cliente (bot_sync_push.py). Las columnas en este orden
-- son las que el script enviará en `?on_conflict=...`.
DROP INDEX IF EXISTS public.ux_po_bot_natural_key;
CREATE UNIQUE INDEX ux_po_bot_natural_key
    ON public.pricing_observations (
        country,
        city,
        observed_date,
        observed_time,
        category,
        competition_name,
        distance_bracket,
        surge,
        data_source
    )
    WHERE data_source = 'bot';

COMMENT ON INDEX public.ux_po_bot_natural_key IS
  'UNIQUE parcial para data_source=''bot''. Habilita upsert (ON CONFLICT) desde bot_sync_push.py y previene duplicados por reintentos del bot. NO afecta uploads manuales (data_source!=''bot''). Migración 90.';

-- ── (E) Verificación final ──────────────────────────────────────────────
DO $verify_index$
DECLARE
  v_exists boolean;
  v_total_bot bigint;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename  = 'pricing_observations'
       AND indexname  = 'ux_po_bot_natural_key'
  ) INTO v_exists;

  IF NOT v_exists THEN
    RAISE EXCEPTION '[mig 90] El índice ux_po_bot_natural_key no se creó — abortando.'
      USING ERRCODE = 'internal_error';
  END IF;

  SELECT COUNT(*) INTO v_total_bot
    FROM public.pricing_observations
   WHERE data_source = 'bot';

  RAISE NOTICE '[mig 90] OK · índice ux_po_bot_natural_key creado · filas bot indexadas=%', v_total_bot;
  RAISE NOTICE '[mig 90] SIGUIENTE PASO: deploy del bot_sync_push.py patcheado (mismo PR) para que use ?on_conflict + Prefer: resolution=merge-duplicates.';
END
$verify_index$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- DESPUÉS DE APLICAR ESTA MIGRACIÓN:
--
-- 1. El bot (bot_sync_push.py) debe estar deployado con el patch que
--    agrega `?on_conflict=country,city,observed_date,observed_time,
--    category,competition_name,distance_bracket,surge,data_source`
--    y `Prefer: resolution=merge-duplicates,return=minimal`.
--    Si NO se deploya: cualquier reintento del bot fallará con 409.
--
-- 2. Para verificar que no hay duplicados nuevos tras unas horas:
--    SELECT country, city, observed_date, observed_time, category,
--           competition_name, distance_bracket, surge, COUNT(*)
--      FROM pricing_observations
--     WHERE data_source = 'bot'
--       AND observed_date >= CURRENT_DATE - 1
--     GROUP BY 1,2,3,4,5,6,7,8
--    HAVING COUNT(*) > 1;
--    Esperado: 0 filas.
--
-- 3. Uploads manuales NO se ven afectados — siguen usando el path
--    upsert_pricing_batch (DELETE+INSERT, mig 26).
-- ════════════════════════════════════════════════════════════════════════
