-- ════════════════════════════════════════════════════════════════════════
-- 213 — el índice único del bot deja pasar duplicados cuando `distance_bracket`
--       es NULL, porque Postgres considera los NULL DISTINTOS entre sí.
--
-- ⚠️  NO APLICADA A PRODUCCIÓN. Borra filas de `pricing_observations` y
--     reconstruye un índice de 216 MB: requiere autorización explícita del
--     user nombrando la acción (CLAUDE.md §3 y §8).
--
-- ── EL AGUJERO ──────────────────────────────────────────────────────────
-- `ux_po_bot_natural_key` es UNIQUE sobre (country, city, observed_date,
-- observed_time, category, competition_name, distance_bracket, surge,
-- data_source) WHERE data_source = 'bot'. Está sano: válido, con sus 19
-- índices hijos adjuntos a las 19 particiones, 216 MB.
--
-- Pero por defecto Postgres trata `NULL <> NULL` en un índice único. Dos filas
-- del bot idénticas salvo por un `distance_bracket` NULL NO chocan, así que el
-- `ON CONFLICT ... DO UPDATE` de `bot_upsert_observations` no dispara y entra
-- una fila nueva en vez de actualizar la que ya estaba.
--
-- ── MEDIDO EN PRODUCCIÓN, no deducido ───────────────────────────────────
--   156 grupos · 458 filas · 302 clones a borrar
--   los 156 tienen distance_bracket IS NULL   (0 por surge, 0 por hora)
--   0 grupos difieren en distancia, en ruta (point_a/point_b) o en zona
--    84 grupos son clones idénticos · 72 tienen otro precio
--   TODOS son Nepal/Kathmandu, 2026-04-07 y 04-08
--
-- Los 0 en distancia/ruta/zona son lo que descarta la hipótesis peligrosa: no
-- son rutas distintas cuyo bracket no se calculó, son la MISMA ruta al mismo
-- segundo. Es exactamente lo que el índice existe para impedir.
--
-- ── CUÁL SE CONSERVA, Y POR QUÉ ─────────────────────────────────────────
-- El más NUEVO (`id DESC`). No es una preferencia: `bot_upsert_observations`
-- declara `ON CONFLICT ... DO UPDATE`, o sea "gana el último". Conservar el
-- más nuevo deja exactamente la fila que habría quedado si el índice hubiera
-- funcionado. Por eso importan los 72 grupos con precio distinto: ahí la
-- elección cambia el dato, y la semántica del upsert la decide.
--
-- ── EL AGUJERO YA NO SE EJERCITA — POR QUÉ SE ARREGLA IGUAL ─────────────
-- Filas del bot sin bracket, por mes:
--     abril 1,84%  ·  mayo 0,34%  ·  junio 0%  ·  julio 0%  ·  agosto 0%
-- El cálculo del bracket se arregló aguas arriba y el hueco dejó de usarse
-- hace tres meses. Así que esto NO es un incendio: es cerrar la puerta que
-- quedó abierta, para que una regresión del cálculo no vuelva a meter
-- duplicados en silencio. Defensa en profundidad (CLAUDE.md §3), con el costo
-- explícito de un rebuild de índice.
--
-- ── EL COSTO, DICHO SIN ADORNOS ─────────────────────────────────────────
-- Reconstruir el índice toma un lock de escritura sobre `pricing_observations`
-- mientras dura. Son 1,57M filas de bot y 216 MB de índice sobre 19
-- particiones. NO se puede usar CONCURRENTLY: no funciona dentro de una
-- transacción y este archivo corre como una. Por eso va en una ventana sin
-- hubs trabajando y lejos de la corrida horaria del bot.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1 · Borrar los clones que el agujero dejó entrar ────────────────────
DO $$
DECLARE
  v_antes    int;
  v_borradas int;
  v_despues  int;
BEGIN
  SELECT count(*) INTO v_antes FROM (
    SELECT 1 FROM pricing_observations WHERE data_source='bot'
    GROUP BY country, city, observed_date, observed_time, category,
             competition_name, distance_bracket, surge
    HAVING count(*) > 1
  ) g;

  RAISE NOTICE '[213] grupos con clones antes: %', v_antes;

  WITH ranked AS (
    SELECT id, observed_date,
           row_number() OVER (
             PARTITION BY country, city, observed_date, observed_time, category,
                          competition_name, distance_bracket, surge
             ORDER BY id DESC) AS rn
    FROM pricing_observations
    WHERE data_source = 'bot'
  )
  DELETE FROM pricing_observations p
  USING ranked r
  WHERE p.id = r.id AND p.observed_date = r.observed_date AND r.rn > 1;
  GET DIAGNOSTICS v_borradas = ROW_COUNT;

  SELECT count(*) INTO v_despues FROM (
    SELECT 1 FROM pricing_observations WHERE data_source='bot'
    GROUP BY country, city, observed_date, observed_time, category,
             competition_name, distance_bracket, surge
    HAVING count(*) > 1
  ) g;

  RAISE NOTICE '[213] borradas % filas · grupos con clones: % -> %',
    v_borradas, v_antes, v_despues;

  -- Sin esto el CREATE INDEX de abajo falla y revierte todo, que también
  -- estaría bien — pero un mensaje claro vale más que un error de unicidad.
  IF v_despues <> 0 THEN
    RAISE EXCEPTION '[213] ABORTA: quedan % grupos con clones, el índice no podría crearse', v_despues;
  END IF;
END $$;

-- ── 2 · Recrear el índice sin el agujero ────────────────────────────────
-- `NULLS NOT DISTINCT` (Postgres 15+; producción corre 17.6) hace que dos
-- NULL cuenten como iguales, que es la semántica que este índice siempre
-- quiso tener: "una sola observación del bot por ruta y momento".
--
-- El DROP y el CREATE van juntos en la misma transacción: si el CREATE falla
-- por un duplicado que el paso 1 no cazó, el DROP también se revierte y la
-- tabla queda protegida como estaba. Nunca hay una ventana sin índice.
DROP INDEX IF EXISTS public.ux_po_bot_natural_key;

CREATE UNIQUE INDEX ux_po_bot_natural_key
  ON public.pricing_observations
  USING btree (country, city, observed_date, observed_time, category,
               competition_name, distance_bracket, surge, data_source)
  NULLS NOT DISTINCT
  WHERE (data_source = 'bot');

COMMENT ON INDEX public.ux_po_bot_natural_key IS
  'Una sola observación del bot por (país, ciudad, fecha, hora, categoría, '
  'competidor, bracket, surge). NULLS NOT DISTINCT (mig 213): sin eso, dos '
  'filas con distance_bracket NULL no chocaban y el ON CONFLICT de '
  'bot_upsert_observations no disparaba — 302 clones reales en Kathmandu.';

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- 1) El índice quedó con el flag y con sus hijos:
--      SELECT ix.indnullsnotdistinct, ix.indisvalid,
--             (SELECT count(*) FROM pg_inherits WHERE inhparent = ix.indexrelid) AS hijos
--        FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid
--       WHERE c.relname = 'ux_po_bot_natural_key';
--      → t | t | 19
--
-- 2) Cero grupos con clones:
--      → 0
--
-- 3) EL QUE IMPORTA — el upsert del bot sigue funcionando. `ON CONFLICT`
--    infiere el índice por columnas + predicado, y hay que confirmar que la
--    inferencia sigue resolviendo con el flag nuevo:
--      BEGIN;
--        SELECT bot_upsert_observations(<un lote de prueba>);
--        SELECT bot_upsert_observations(<el MISMO lote>);  -- debe ACTUALIZAR
--      ROLLBACK;
--    Y con distance_bracket NULL en las dos: antes insertaba 2 filas, ahora
--    tiene que dejar 1.
