-- ════════════════════════════════════════════════════════════════════════
-- 196_ci_duration_backfill_historico.sql — recalcular las duraciones YA
-- GUARDADAS. Las migs 194/195 arreglaron el camino hacia adelante; el
-- histórico sigue mintiendo y no se corrige solo.
--
-- LO QUE SE MIDIÓ CONTRA PRODUCCIÓN (2026-08-01), antes de escribir nada:
--   · La suma ingenua de todos los hub-días da 5.632 minutos donde el trabajo
--     real fue 2.200 → 61% de inflación. (La 195 arregló la SUMA por hub/día
--     con `ci_hub_daily_minutes`, pero cada fila individual sigue con su
--     número viejo, y es el que se ve en el historial de sesiones.)
--   · 20 filas con MENOS de 2 minutos y MÁS de 20 celdas guardadas: el
--     síntoma original de "0.1 minutos" que reportó el user.
--   · 6 filas en exactamente 0 (el `0` literal que escribía la vieja
--     `admin_close_ci_session` cuando no encontraba fila de latido).
--   · 1 fila de más de 10 horas (`started_at` heredado de ayer, P1-5).
--
-- QUÉ HACE
--   duration_minutes := ci_duration_from_timings(turno_timings, ended_at)
--
-- que es EXACTAMENTE la misma función que usan hoy el cierre administrativo
-- (mig 194) y el cliente (src/lib/sessionDuration.js). No se inventa un
-- algoritmo nuevo para el histórico: si hubiera dos, volveríamos a tener dos
-- fuentes de verdad, que es lo que la 194 vino a cerrar.
--
-- NUNCA 0
-- Cuando no se puede determinar, se escribe NULL. Un 0 entra en cualquier
-- promedio y hace creer que el corte fue instantáneo; un NULL se excluye
-- solo. Ojo con el caso borde: `ci_duration_from_timings` nunca devuelve 0
-- para "no sé" (devuelve NULL), pero SÍ puede devolver 0.0 por redondeo si el
-- único tramo medible duró menos de 3 segundos. Eso no es una medición, es la
-- ausencia de una — el piso real de la métrica es 0.1. Por eso el backfill
-- pasa por `ci_duration_recalculada()`, que convierte ese 0.0 en NULL. No se
-- toca `ci_duration_from_timings` (la usa el cliente y hay paridad probada):
-- el NULLIF vive en un envoltorio propio y explícito.
--
-- SIN FALLBACK DE RELOJ DE PARED — decisión deliberada, y es la que más
-- filas mueve
-- `admin_close_ci_session` (mig 194) sí cae al reloj de pared cuando no hay
-- ningún turno medible: al cerrar, ese reloj es lo único que hay y está
-- fresco. Este backfill NO lo hace, y el motivo es que acá el reloj es
-- exactamente la medición contaminada que se está reemplazando: el
-- `started_at` de una fila vieja salió del cronómetro que se pisaba con
-- `Date.now()` en cinco lugares, o de un latido heredado de ayer — es el
-- origen de la fila de más de 10 horas y de buena parte del 61% de inflación.
-- Conservar una versión capada de ese número sería conservar el problema.
-- Entonces: una fila histórica sin turnos medibles queda en NULL
-- (clasificación `anulada` en la vista de auditoría), con su valor viejo
-- intacto en `duration_minutes_legacy` por si el user quiere volver a verlo.
--
-- REVERSIBLE — la razón por la que este archivo agrega columnas
-- Es un backfill sobre datos que el user usa para GESTIONAR gente. Pisar el
-- número sin guardar el original haría el cambio irreversible y no auditable:
-- no habría forma de contestar "¿qué me cambiaste?" ni de volver atrás.
--   · `duration_minutes_legacy`  → el valor original, estampado ANTES de
--     pisarlo, una sola vez (ver el guard de idempotencia más abajo).
--   · `duration_backfilled_at`   → cuándo se corrigió esa fila. NULL = el
--     backfill nunca la tocó.
-- Vuelta atrás completa, en un solo statement (ver VERIFICACIÓN al pie).
--
-- ACOTADO, REANUDABLE Y OBSERVABLE (CLAUDE.md §4)
-- Hoy son decenas de filas, pero el procedimiento no depende de eso: procesa
-- por lotes con `LIMIT` + `FOR UPDATE SKIP LOCKED`, acepta un techo de filas
-- por corrida, puede confirmar cada lote por separado (`p_commit_por_lote`),
-- tiene un modo `p_dry_run` que no escribe nada, y reporta por lote y en
-- total. Interrumpirlo a la mitad no rompe nada: lo ya corregido queda
-- marcado y la corrida siguiente sigue donde quedó.
--
-- IDEMPOTENTE Y SIN PISAR LO QUE YA ESTÁ BIEN
-- El candidato es "fila sin marcar Y cuyo valor guardado NO coincide con el
-- recálculo". Una fila que ya está correcta no se reescribe (ni una tupla
-- muerta), y una fila ya corregida no vuelve a entrar. Correrlo dos veces
-- seguidas deja exactamente el mismo estado y la segunda corrida reporta 0.
-- Corolario deliberado: `duration_minutes_legacy` nunca se pisa con un valor
-- que ya salió de este backfill — el original se conserva de verdad.
--
-- CAMBIO ADITIVO: dos columnas nullable nuevas, ningún DROP, ninguna columna
-- renombrada. Un bundle viejo con la pestaña abierta desde ayer sigue
-- funcionando contra este esquema (CLAUDE.md §4, paso "expandir").
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Guard de orden: esto va DESPUÉS de la 194 y de la 195 ───────────────
-- Sin las funciones de la 194 no hay con qué recalcular, y sin las columnas
-- de calidad de la 195 el resultado no se puede interpretar. Fallar acá con
-- un mensaje claro es infinitamente mejor que fallar adentro del backfill.
DO $$
BEGIN
  IF to_regprocedure('public.ci_duration_from_timings(jsonb, timestamptz)') IS NULL THEN
    RAISE EXCEPTION
      'mig 196: falta ci_duration_from_timings(jsonb,timestamptz) — aplicar la 194 primero';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ci_sessions'
       AND column_name = 'duration_confiable'
  ) THEN
    RAISE EXCEPTION
      'mig 196: falta ci_sessions.duration_confiable — aplicar la 195 primero';
  END IF;
END $$;

-- ── Las dos columnas que hacen el backfill reversible ───────────────────
ALTER TABLE public.ci_sessions
  ADD COLUMN IF NOT EXISTS duration_minutes_legacy numeric,
  ADD COLUMN IF NOT EXISTS duration_backfilled_at  timestamptz;

COMMENT ON COLUMN public.ci_sessions.duration_minutes_legacy IS
  'El duration_minutes ORIGINAL, tal como estaba antes del recálculo de la '
  'mig 196. Se estampa una sola vez y nunca se pisa. NULL con '
  'duration_backfilled_at NULL = el backfill nunca tocó esta fila. NULL con '
  'duration_backfilled_at NO NULL = el valor original ya era NULL.';

COMMENT ON COLUMN public.ci_sessions.duration_backfilled_at IS
  'Cuándo el backfill de la mig 196 corrigió esta fila. NULL = no la tocó '
  '(porque ya era correcta, o porque nació después con el algoritmo bueno). '
  'Es la marca de reanudación del backfill y el filtro exacto para revertirlo.';

-- ── El recálculo, en un solo lugar ──────────────────────────────────────
-- El procedimiento y las dos vistas de auditoría tienen que estar de acuerdo
-- sobre qué valor "debería" tener cada fila. Si esa expresión se copia en
-- tres lados, se desincroniza en el primer cambio — el mismo patrón que ya
-- causó divergencia en la normalización de competition_name (CLAUDE.md §4).
CREATE OR REPLACE FUNCTION public.ci_duration_recalculada(
  p_timings jsonb,
  p_fin     timestamptz DEFAULT NULL
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  -- NULLIF: ver "NUNCA 0" en la cabecera. 0.0 minutos no es una medición.
  SELECT NULLIF(public.ci_duration_from_timings(p_timings, p_fin), 0);
$function$;

COMMENT ON FUNCTION public.ci_duration_recalculada(jsonb, timestamptz) IS
  'Valor que DEBERÍA tener ci_sessions.duration_minutes según turno_timings '
  '(mig 196). Es ci_duration_from_timings() con un piso: un resultado de 0.0 '
  'se devuelve como NULL, porque un 0 se promedia y miente.';

REVOKE ALL ON FUNCTION public.ci_duration_recalculada(jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated;

-- ── El backfill ─────────────────────────────────────────────────────────
-- PROCEDURE y no FUNCTION a propósito: solo un procedimiento puede hacer
-- COMMIT entre lotes, que es lo que lo vuelve reanudable de verdad sobre una
-- tabla grande (una función mantendría UNA transacción abierta sobre toda la
-- tabla). Cuando se lo llama desde adentro de una transacción —como en esta
-- misma migración— hay que pasarle p_commit_por_lote => false, porque un
-- COMMIT ahí adentro aborta con 2D000.
CREATE OR REPLACE PROCEDURE public.ci_backfill_duration_minutes(
  p_lote             int     DEFAULT 500,
  p_max_filas        int     DEFAULT NULL,   -- techo por corrida; NULL = hasta terminar
  p_dry_run          boolean DEFAULT false,
  p_commit_por_lote  boolean DEFAULT true
)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $procedure$
DECLARE
  v_ids        int[];
  v_tam        int;
  v_lote       bigint;
  v_vistas     bigint := 0;
  v_a_null     bigint := 0;
  v_rescatadas bigint := 0;
  v_antes      numeric := 0;
  v_despues    numeric := 0;
  v_l_null     bigint;
  v_l_resc     bigint;
  v_l_antes    numeric;
  v_l_despues  numeric;
  v_pend       bigint;
BEGIN
  IF p_lote IS NULL OR p_lote < 1 THEN
    RAISE EXCEPTION 'ci_backfill_duration_minutes: p_lote debe ser >= 1 (recibido %)', p_lote;
  END IF;
  IF p_max_filas IS NOT NULL AND p_max_filas < 0 THEN
    RAISE EXCEPTION 'ci_backfill_duration_minutes: p_max_filas no puede ser negativo';
  END IF;

  -- ── Modo ensayo: no escribe NADA ──────────────────────────────────────
  -- Es lo primero que hay que correr contra producción (CLAUDE.md §8: el
  -- user autoriza ESTE backfill viendo ESTOS números, no un backfill en
  -- abstracto). Sale por acá y no entra al lote, porque sin marcar filas el
  -- bucle repetiría el mismo lote para siempre.
  IF p_dry_run THEN
    SELECT count(*),
           count(*) FILTER (WHERE q.nuevo IS NULL),
           count(*) FILTER (WHERE q.viejo IS NULL AND q.nuevo IS NOT NULL),
           coalesce(sum(q.viejo), 0),
           coalesce(sum(q.nuevo), 0)
      INTO v_vistas, v_a_null, v_rescatadas, v_antes, v_despues
      FROM (
        SELECT s.duration_minutes AS viejo,
               ci_duration_recalculada(s.turno_timings, s.ended_at) AS nuevo
          FROM ci_sessions s
         WHERE s.duration_backfilled_at IS NULL
           AND s.duration_minutes
               IS DISTINCT FROM ci_duration_recalculada(s.turno_timings, s.ended_at)
         ORDER BY s.id
         LIMIT coalesce(p_max_filas, 2147483647)
      ) q;

    RAISE NOTICE '[196][ENSAYO] % filas cambiarían | % quedarían en NULL | % pasarían de NULL a un número',
      v_vistas, v_a_null, v_rescatadas;
    RAISE NOTICE '[196][ENSAYO] minutos: % → % (delta %)',
      round(v_antes, 1), round(v_despues, 1), round(v_despues - v_antes, 1);
    RAISE NOTICE '[196][ENSAYO] no se escribió nada.';
    RETURN;
  END IF;

  -- ── Backfill por lotes ────────────────────────────────────────────────
  LOOP
    EXIT WHEN p_max_filas IS NOT NULL AND v_vistas >= p_max_filas;

    v_tam := CASE WHEN p_max_filas IS NULL THEN p_lote
                  ELSE least(p_lote, p_max_filas - v_vistas) END;
    EXIT WHEN v_tam < 1;

    -- SKIP LOCKED: dos corridas en paralelo se reparten el trabajo en vez de
    -- bloquearse. El lock se sostiene hasta el COMMIT del lote, así que entre
    -- este SELECT y el UPDATE nadie puede cambiar la fila por debajo.
    SELECT array_agg(q.id) INTO v_ids
      FROM (
        SELECT s.id
          FROM ci_sessions s
         WHERE s.duration_backfilled_at IS NULL
           AND s.duration_minutes
               IS DISTINCT FROM ci_duration_recalculada(s.turno_timings, s.ended_at)
         ORDER BY s.id
         LIMIT v_tam
         FOR UPDATE SKIP LOCKED
      ) q;

    EXIT WHEN v_ids IS NULL;

    WITH upd AS (
      UPDATE ci_sessions s
         -- El orden de los SET no importa: en un UPDATE, el lado derecho SIEMPRE
         -- lee los valores VIEJOS de la fila. `legacy` se queda con el original.
         SET duration_minutes_legacy = s.duration_minutes,
             duration_minutes        = ci_duration_recalculada(s.turno_timings, s.ended_at),
             duration_backfilled_at  = now()
       WHERE s.id = ANY(v_ids)
      RETURNING s.duration_minutes_legacy AS antes, s.duration_minutes AS despues
    )
    SELECT count(*),
           count(*) FILTER (WHERE u.despues IS NULL),
           count(*) FILTER (WHERE u.antes IS NULL AND u.despues IS NOT NULL),
           coalesce(sum(u.antes), 0),
           coalesce(sum(u.despues), 0)
      INTO v_lote, v_l_null, v_l_resc, v_l_antes, v_l_despues
      FROM upd u;

    v_vistas     := v_vistas + v_lote;
    v_a_null     := v_a_null + v_l_null;
    v_rescatadas := v_rescatadas + v_l_resc;
    v_antes      := v_antes + v_l_antes;
    v_despues    := v_despues + v_l_despues;

    RAISE NOTICE '[196] lote: % filas corregidas (acumulado %) | minutos % → %',
      v_lote, v_vistas, round(v_l_antes, 1), round(v_l_despues, 1);

    IF p_commit_por_lote THEN
      COMMIT;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_pend
    FROM ci_sessions s
   WHERE s.duration_minutes
         IS DISTINCT FROM ci_duration_recalculada(s.turno_timings, s.ended_at);

  RAISE NOTICE '[196] TOTAL: % filas corregidas | % quedaron en NULL | % pasaron de NULL a un número',
    v_vistas, v_a_null, v_rescatadas;
  RAISE NOTICE '[196] TOTAL minutos: % → % (delta %)',
    round(v_antes, 1), round(v_despues, 1), round(v_despues - v_antes, 1);
  RAISE NOTICE '[196] filas que todavía no coinciden con el recálculo: %', v_pend;
END;
$procedure$;

COMMENT ON PROCEDURE public.ci_backfill_duration_minutes(int, int, boolean, boolean) IS
  'Recalcula ci_sessions.duration_minutes desde turno_timings (mig 196), '
  'preservando el original en duration_minutes_legacy. Por lotes, reanudable '
  'e idempotente: no toca filas que ya coinciden con el recálculo ni filas ya '
  'corregidas. p_dry_run=true no escribe nada. p_commit_por_lote=false es '
  'OBLIGATORIO si se lo llama desde adentro de una transacción abierta.';

-- Mutación masiva: NO se expone por PostgREST. Solo el dueño de la base la
-- ejecuta, desde psql o el SQL editor (CLAUDE.md §3, deny by default).
REVOKE ALL ON PROCEDURE public.ci_backfill_duration_minutes(int, int, boolean, boolean)
  FROM PUBLIC, anon, authenticated;

-- ── Auditoría fila por fila: "¿qué me cambiaste?" ───────────────────────
-- `security_invoker = true` (CLAUDE.md §3): sin esto la vista leería
-- ci_sessions con los privilegios del dueño y bypasearía la RLS de la tabla.
CREATE OR REPLACE VIEW public.ci_duration_backfill_audit
WITH (security_invoker = true) AS
SELECT s.id,
       s.country,
       s.city,
       s.zone,
       s.observed_date,
       s.user_email,
       s.rows_saved,
       s.total_expected,
       -- El valor ORIGINAL: el legacy si el backfill tocó la fila; el actual
       -- si no la tocó (en ese caso original y actual son el mismo número).
       CASE WHEN s.duration_backfilled_at IS NOT NULL
            THEN s.duration_minutes_legacy ELSE s.duration_minutes END AS min_antes,
       s.duration_minutes                                              AS min_ahora,
       -- Aritmética NULL-aware a propósito: si alguno de los dos lados es
       -- desconocido, la diferencia es desconocida. Un 0 acá volvería a ser
       -- el mismo tipo de mentira que este trabajo vino a borrar.
       CASE WHEN s.duration_backfilled_at IS NOT NULL
            THEN round(s.duration_minutes - s.duration_minutes_legacy, 1)
            ELSE 0::numeric END                                        AS delta,
       CASE
         WHEN s.duration_backfilled_at IS NULL                    THEN 'sin_tocar'
         WHEN s.duration_minutes IS NULL                          THEN 'anulada'
         WHEN s.duration_minutes_legacy IS NULL                   THEN 'rescatada'
         WHEN s.duration_minutes < s.duration_minutes_legacy      THEN 'inflada_corregida'
         WHEN s.duration_minutes > s.duration_minutes_legacy      THEN 'subestimada_corregida'
         ELSE 'sin_cambio'
       END                                                             AS clasificacion,
       -- Por qué el número nuevo es el que es (mig 195): NULL = confiable,
       -- turno_recortado / turno_estimado / sin_timings = mirar con cuidado.
       s.duration_confiable,
       s.duration_motivo,
       -- Cuántos turnos llegó a tocar el hub. Un cambio grande sobre una fila
       -- de 0 turnos es esperable; sobre una de 3, hay que mirarlo.
       (SELECT count(*)
          FROM jsonb_each(coalesce(s.turno_timings, '{}'::jsonb)) e
         WHERE jsonb_typeof(e.value) = 'object'
           AND ci_ts_or_null(e.value->>'startedAt') IS NOT NULL)       AS turnos_tocados,
       s.started_at,
       s.ended_at,
       s.duration_backfilled_at
  FROM public.ci_sessions s;

COMMENT ON VIEW public.ci_duration_backfill_audit IS
  'Auditoría del backfill de la mig 196, fila por fila: valor viejo, valor '
  'nuevo, diferencia y motivo. clasificacion=sin_tocar significa que la fila '
  'ya era correcta (o nació después del backfill).';

-- ── Auditoría agregada: el titular ──────────────────────────────────────
CREATE OR REPLACE VIEW public.ci_duration_backfill_resumen
WITH (security_invoker = true) AS
SELECT count(*)                                                          AS filas,
       count(*) FILTER (WHERE s.duration_backfilled_at IS NOT NULL)      AS filas_corregidas,
       count(*) FILTER (WHERE s.duration_backfilled_at IS NULL)          AS filas_intactas,
       count(*) FILTER (WHERE s.duration_backfilled_at IS NOT NULL
                          AND s.duration_minutes IS NULL)                AS quedaron_en_null,
       count(*) FILTER (WHERE s.duration_backfilled_at IS NOT NULL
                          AND s.duration_minutes_legacy IS NOT NULL
                          AND s.duration_minutes IS NOT NULL
                          AND s.duration_minutes < s.duration_minutes_legacy) AS estaban_infladas,
       count(*) FILTER (WHERE s.duration_backfilled_at IS NOT NULL
                          AND s.duration_minutes_legacy IS NOT NULL
                          AND s.duration_minutes IS NOT NULL
                          AND s.duration_minutes > s.duration_minutes_legacy) AS estaban_cortas,
       -- Minutos totales antes y después. `min_antes` de la vista de detalle
       -- ya resuelve el caso de la fila intacta, así que los dos totales son
       -- comparables sobre el MISMO conjunto de filas.
       round(coalesce(sum(CASE WHEN s.duration_backfilled_at IS NOT NULL
                               THEN s.duration_minutes_legacy
                               ELSE s.duration_minutes END), 0), 1)      AS minutos_antes,
       round(coalesce(sum(s.duration_minutes), 0), 1)                    AS minutos_ahora,
       round(coalesce(sum(s.duration_minutes), 0)
             - coalesce(sum(CASE WHEN s.duration_backfilled_at IS NOT NULL
                                 THEN s.duration_minutes_legacy
                                 ELSE s.duration_minutes END), 0), 1)    AS delta_minutos,
       -- El número que importa después de correrlo: cuántas filas TODAVÍA no
       -- coinciden con el recálculo. Tiene que ser 0.
       count(*) FILTER (WHERE s.duration_minutes
                        IS DISTINCT FROM ci_duration_recalculada(s.turno_timings, s.ended_at))
                                                                         AS pendientes
  FROM public.ci_sessions s;

COMMENT ON VIEW public.ci_duration_backfill_resumen IS
  'Titular del backfill de la mig 196: cuántas filas se corrigieron, cuántas '
  'quedaron en NULL y cuánto cambió el total de minutos. `pendientes` debe '
  'ser 0; si no lo es, quedó trabajo por hacer.';

-- Deny by default (CLAUDE.md §3): ninguna pantalla consume estas vistas
-- todavía, así que no se le abre el endpoint a nadie. El día que una UI las
-- necesite, se agrega el GRANT en esa misma migración.
REVOKE ALL ON public.ci_duration_backfill_audit    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.ci_duration_backfill_resumen  FROM PUBLIC, anon, authenticated;

-- ── Correrlo ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_max_id bigint;
  v_pend   bigint;
BEGIN
  -- Foto del universo ANTES de empezar. El guard de más abajo mira SOLO
  -- estas filas: si un hub cierra una sesión mientras la migración corre, esa
  -- fila nace con el algoritmo bueno (mig 194) y no es asunto de este
  -- backfill — hacer que la migración aborte por eso sería una sorpresa cara
  -- en producción por una condición de carrera de milisegundos.
  SELECT coalesce(max(s.id), 0) INTO v_max_id FROM ci_sessions s;

  -- p_commit_por_lote => false: estamos DENTRO del BEGIN de esta migración.
  -- Si algo falla, no queda un backfill a medias: se revierte entero con el
  -- resto del cambio.
  CALL public.ci_backfill_duration_minutes(
    p_lote            => 500,
    p_max_filas       => NULL,
    p_dry_run         => false,
    p_commit_por_lote => false
  );

  -- Guard duro: si queda UNA sola fila vieja cuyo valor no coincide con el
  -- recálculo, la migración NO se aplica. Es la diferencia entre "la
  -- migración aplicó" y "la migración funcionó" (la 182 aplicó limpio y
  -- estuvo meses rota porque nadie verificó el resultado).
  SELECT count(*) INTO v_pend
    FROM ci_sessions s
   WHERE s.id <= v_max_id
     AND s.duration_minutes
         IS DISTINCT FROM ci_duration_recalculada(s.turno_timings, s.ended_at);

  IF v_pend <> 0 THEN
    RAISE EXCEPTION 'mig 196: quedaron % filas sin recalcular — se aborta', v_pend;
  END IF;
END $$;

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- 0) ENSAYO antes de tocar producción (no escribe nada):
--    CALL ci_backfill_duration_minutes(p_dry_run => true);
--    → imprime cuántas filas cambiarían y cuánto cambia el total de minutos.
--
-- 1) El titular. `pendientes` DEBE ser 0:
--    SELECT * FROM ci_duration_backfill_resumen;
--
-- 2) Las 20 peores correcciones, para mirar a ojo qué cambió y por qué:
--    SELECT id, user_email, observed_date, city, zone,
--           min_antes, min_ahora, delta, clasificacion, duration_motivo,
--           turnos_tocados, rows_saved
--      FROM ci_duration_backfill_audit
--     WHERE clasificacion <> 'sin_tocar'
--     ORDER BY abs(coalesce(delta, 999999)) DESC
--     LIMIT 20;
--
-- 3) El síntoma reportado tiene que haber desaparecido. Ninguna fila con
--    trabajo guardado puede quedar con una duración de juguete ni en 0:
--    SELECT count(*) FROM ci_sessions
--     WHERE coalesce(rows_saved, 0) > 20 AND duration_minutes < 2;   → 0 esperado
--    SELECT count(*) FROM ci_sessions WHERE duration_minutes = 0;    → 0 esperado
--    SELECT count(*) FROM ci_sessions WHERE duration_minutes > 720;  → 0 esperado
--    (720 = 3 turnos × el techo de 4h de la mig 194: nada puede superarlo.)
--
-- 4) Distribución de lo que quedó, cruzada con la marca de confianza:
--    SELECT clasificacion, duration_confiable, duration_motivo, count(*)
--      FROM ci_duration_backfill_audit GROUP BY 1,2,3 ORDER BY 4 DESC;
--
-- 5) Idempotencia: correrlo de nuevo no debe tocar nada.
--    CALL ci_backfill_duration_minutes();   → "TOTAL: 0 filas corregidas"
--
-- 6) VUELTA ATRÁS COMPLETA (si el user no quiere estos números):
--    UPDATE ci_sessions
--       SET duration_minutes = duration_minutes_legacy,
--           duration_minutes_legacy = NULL,
--           duration_backfilled_at  = NULL
--     WHERE duration_backfilled_at IS NOT NULL;
--    Solo toca las filas que el backfill cambió; las intactas ni se miran.
--
-- 7) Simulaciones con casos concretos: scripts/simulate-duration-backfill.sql
--    (npm run simulate:duration-backfill)
--
-- 8) Higiene §3: search_path fijado en la función nueva, las dos vistas con
--    security_invoker=true, y ni anon ni authenticated con permisos sobre el
--    procedimiento ni sobre las vistas:
--    SELECT relname, relacl FROM pg_class
--     WHERE relname IN ('ci_duration_backfill_audit','ci_duration_backfill_resumen');
