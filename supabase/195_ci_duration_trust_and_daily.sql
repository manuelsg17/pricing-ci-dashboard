-- ════════════════════════════════════════════════════════════════════════
-- 195_ci_duration_trust_and_daily.sql — que la duración se pueda AUDITAR y
-- que la suma por hub y día deje de duplicar minutos.
--
-- Dos pedidos del user, medidos contra datos REALES de producción antes de
-- escribir una línea:
--
--   · 20 de 26 hub-días tienen MÁS DE UNA fila en ci_sessions (77%). La peor
--     suma ingenua da 827 minutos: casi 14 horas en un día, imposible.
--     Reabrir una sesión para corregir una celda inserta una fila nueva a
--     propósito (es el rastro de revisiones), pero sus turno_timings se
--     SOLAPAN con los de la fila original. Sumar duration_minutes cuenta dos
--     veces el mismo minuto de reloj.
--   · El techo de 4 h por turno (mig 194) se aplica en SILENCIO. Un número
--     capado entra a la base indistinguible de uno exacto, así que un
--     promedio los mezcla y nadie puede saber cuáles mirar con desconfianza.
--
-- ── PARTE 1 · La marca de confianza ──────────────────────────────────
-- `src/lib/sessionDuration.js` YA calcula `{minutos, confiable, motivo}` — la
-- información existía y se tiraba a la basura al escribir la fila. Acá se le
-- hace lugar.
--
-- Columnas ADITIVAS y nullable: un cliente viejo que no las manda sigue
-- funcionando exactamente igual (paso "expandir" de CLAUDE.md §4). No hay
-- contract pendiente: `duration_minutes` se conserva tal cual.
--
--   duration_confiable = NULL  → fila vieja, anterior a esta migración
--                        true  → todos los tramos con inicio y fin reales
--                        false → hubo que estimar o recortar; ver motivo
--
-- ── PARTE 2 · La suma por hub y día ──────────────────────────────────
-- `ci_hub_daily_minutes()` NO suma `duration_minutes`: junta los tramos de
-- TODAS las filas del hub en ese día y los UNE antes de medir. Dos filas que
-- cubren el mismo minuto de reloj lo cuentan una sola vez.
--
-- Se une a través de ciudades y zonas a propósito: una persona no puede
-- trabajar en dos lados a la vez, así que la unión responde la pregunta real
-- —"¿cuánto tiempo estuvo esta persona cargando datos hoy?"— y no
-- "¿cuánto suman sus registros?".
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── PARTE 1 ───────────────────────────────────────────────────────────
ALTER TABLE public.ci_sessions
  ADD COLUMN IF NOT EXISTS duration_confiable boolean,
  ADD COLUMN IF NOT EXISTS duration_motivo    text;

COMMENT ON COLUMN public.ci_sessions.duration_confiable IS
  'true = todos los tramos de turno tenían inicio y fin reales y ninguno tocó '
  'el techo de 4h. false = hubo que estimar o recortar (ver duration_motivo). '
  'NULL = fila anterior a la mig 195, no se puede saber.';

COMMENT ON COLUMN public.ci_sessions.duration_motivo IS
  'Por qué la duración no es confiable: turno_recortado (tocó el techo de 4h, '
  'el real fue MAYOR), turno_estimado (un turno sin endedAt se cerró con el '
  'fin de sesión), reloj_recortado / sin_timings (no había turnos medibles y '
  'se cayó al reloj de pared). NULL cuando es confiable.';

-- Índice parcial para el uso real: "dame lo confiable de este país".
CREATE INDEX IF NOT EXISTS idx_ci_sessions_confiables
  ON public.ci_sessions(country, observed_date)
  WHERE duration_confiable IS TRUE;

-- ── Espejo SQL de la calidad ──────────────────────────────────────────
-- Lo necesita `admin_close_ci_session`, que escribe filas sin pasar por el
-- cliente. Tener DOS fuentes de verdad para la misma columna es lo que ya
-- causó divergencia antes (CLAUDE.md §4): esta función y la de JS tienen que
-- decidir igual, y hay una prueba de paridad que lo verifica.
CREATE OR REPLACE FUNCTION public.ci_duration_quality_from_timings(
  p_timings jsonb,
  p_fin     timestamptz DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_max_turno constant interval := interval '4 hours';
  r record;
  v_hubo_medible  boolean := false;
  v_hubo_estimado boolean := false;
  v_hubo_recorte  boolean := false;
BEGIN
  IF p_timings IS NULL OR jsonb_typeof(p_timings) <> 'object' THEN
    RETURN 'sin_timings';
  END IF;

  FOR r IN
    SELECT ci_ts_or_null(e.value->>'startedAt') AS ini,
           ci_ts_or_null(e.value->>'endedAt')   AS fin
    FROM jsonb_each(p_timings) e
    WHERE jsonb_typeof(e.value) = 'object'
  LOOP
    CONTINUE WHEN r.ini IS NULL;

    -- Mismo criterio que tramosDeTurnos() en JS: un fin ausente O anterior a
    -- su propio inicio (pasa con relojes desincronizados) no sirve, y cerrarlo
    -- con el fin de sesión es una ESTIMACIÓN, no un dato.
    IF r.fin IS NULL OR r.fin < r.ini THEN
      IF p_fin IS NOT NULL AND p_fin >= r.ini THEN
        v_hubo_estimado := true;
        v_hubo_medible  := true;
        IF p_fin - r.ini > v_max_turno THEN v_hubo_recorte := true; END IF;
      END IF;
      -- Sin fin de sesión el turno no aporta minutos y tampoco ensucia la
      -- calidad: simplemente no se pudo medir.
      CONTINUE;
    END IF;

    -- `>` y no `>=`: un tramo de ancho CERO es un artefacto de una grilla que
    -- llegó completa de un saque, no "trabajo que duró nada".
    IF r.fin > r.ini THEN
      v_hubo_medible := true;
      IF r.fin - r.ini > v_max_turno THEN v_hubo_recorte := true; END IF;
    END IF;
  END LOOP;

  IF NOT v_hubo_medible   THEN RETURN 'sin_timings';    END IF;
  -- El recorte gana sobre la estimación: es el que más distorsiona (el número
  -- real fue MAYOR que el guardado, y no se sabe cuánto).
  IF v_hubo_recorte       THEN RETURN 'turno_recortado'; END IF;
  IF v_hubo_estimado      THEN RETURN 'turno_estimado';  END IF;
  RETURN NULL;   -- confiable
END;
$function$;

REVOKE ALL ON FUNCTION public.ci_duration_quality_from_timings(jsonb, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ci_duration_quality_from_timings(jsonb, timestamptz) TO authenticated;

-- ── Backfill de las filas existentes ──────────────────────────────────
-- Acotado y observable (CLAUDE.md §4): son decenas de filas, no millones.
-- Se recalcula la calidad de todo lo que ya está, para que el histórico sea
-- auditable desde el día uno en vez de quedar como un hueco de NULLs.
UPDATE public.ci_sessions s
   SET duration_motivo    = ci_duration_quality_from_timings(s.turno_timings, s.ended_at),
       duration_confiable = (ci_duration_quality_from_timings(s.turno_timings, s.ended_at) IS NULL)
 WHERE s.duration_confiable IS NULL;

-- ── PARTE 2 · minutos reales por hub y día ────────────────────────────
CREATE OR REPLACE FUNCTION public.ci_hub_daily_minutes(
  p_country text,
  p_from    date,
  p_to      date
)
RETURNS TABLE (
  user_email    text,
  observed_date date,
  minutos       numeric,
  sesiones      int,
  confiable     boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- SECURITY DEFINER + gate explícito: sin esto la función bypasearía la RLS
  -- de ci_sessions (CLAUDE.md §3 — is_admin() no puede sostener el
  -- aislamiento por país sin decirlo).
  PERFORM require_country_access(p_country);

  RETURN QUERY
  WITH tramos AS (
    -- Todos los tramos de TODAS las filas del hub en ese día, ya acotados al
    -- techo de 4h y sin los de ancho cero.
    SELECT s.user_email AS ue,
           s.observed_date AS od,
           ci_ts_or_null(e.value->>'startedAt') AS ini,
           LEAST(
             coalesce(ci_ts_or_null(e.value->>'endedAt'), s.ended_at),
             ci_ts_or_null(e.value->>'startedAt') + interval '4 hours'
           ) AS fin
    FROM ci_sessions s,
         LATERAL jsonb_each(coalesce(s.turno_timings, '{}'::jsonb)) e
    WHERE s.country = p_country
      AND s.observed_date BETWEEN p_from AND p_to
      AND jsonb_typeof(e.value) = 'object'
      AND ci_ts_or_null(e.value->>'startedAt') IS NOT NULL
  ),
  validos AS (
    SELECT ue, od, ini, fin FROM tramos WHERE fin IS NOT NULL AND fin > ini
  ),
  -- Unión de intervalos por hub+día. `marca` detecta dónde arranca un grupo
  -- nuevo: un tramo cuyo inicio es posterior al máximo fin visto hasta ahí.
  ordenados AS (
    SELECT ue, od, ini, fin,
           CASE WHEN ini > max(fin) OVER (
                  PARTITION BY ue, od ORDER BY ini
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
                THEN 1 ELSE 0 END AS marca
    FROM validos
  ),
  grupos AS (
    SELECT ue, od, ini, fin,
           sum(marca) OVER (PARTITION BY ue, od ORDER BY ini) AS grupo
    FROM ordenados
  ),
  unidos AS (
    SELECT ue, od, grupo, min(ini) AS ini, max(fin) AS fin
    FROM grupos GROUP BY ue, od, grupo
  ),
  totales AS (
    SELECT ue, od, sum(EXTRACT(EPOCH FROM (fin - ini)) / 60.0) AS mins
    FROM unidos GROUP BY ue, od
  )
  SELECT t.ue,
         t.od,
         round(t.mins::numeric, 1),
         (SELECT count(*)::int FROM ci_sessions x
           WHERE x.country = p_country AND x.user_email = t.ue AND x.observed_date = t.od),
         -- El día es confiable solo si TODAS sus filas lo son. Una sola fila
         -- capada contamina el total: no se puede saber cuánto falta.
         (SELECT bool_and(coalesce(x.duration_confiable, false)) FROM ci_sessions x
           WHERE x.country = p_country AND x.user_email = t.ue AND x.observed_date = t.od)
  FROM totales t
  ORDER BY t.od DESC, t.ue;
END;
$function$;

REVOKE ALL ON FUNCTION public.ci_hub_daily_minutes(text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ci_hub_daily_minutes(text, date, date) TO authenticated;

COMMENT ON FUNCTION public.ci_hub_daily_minutes(text, date, date) IS
  'Minutos REALES por hub y día (mig 195). NO suma duration_minutes: une los '
  'tramos de todas las filas del día antes de medir, así una sesión reabierta '
  'para corregir no cuenta sus minutos dos veces.';

-- ── Minutos por TURNO — la pregunta del user ──────────────────────────
-- "Quiero saber cuánto tiempo real les toma cada corte, en la mañana, tarde
-- y noche." Misma unión, pero agrupando por etiqueta de turno.
CREATE OR REPLACE FUNCTION public.ci_turno_minutes(
  p_country text,
  p_from    date,
  p_to      date
)
RETURNS TABLE (
  turno       text,
  muestras    bigint,
  min_prom    numeric,
  min_mediana numeric,
  min_min     numeric,
  min_max     numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_country_access(p_country);

  RETURN QUERY
  WITH tramos AS (
    SELECT e.key AS etiqueta,
           ci_ts_or_null(e.value->>'startedAt') AS ini,
           LEAST(
             coalesce(ci_ts_or_null(e.value->>'endedAt'), s.ended_at),
             ci_ts_or_null(e.value->>'startedAt') + interval '4 hours'
           ) AS fin
    FROM ci_sessions s,
         LATERAL jsonb_each(coalesce(s.turno_timings, '{}'::jsonb)) e
    WHERE s.country = p_country
      AND s.observed_date BETWEEN p_from AND p_to
      -- SOLO tramos confiables: un promedio que mezcla capados y exactos es
      -- justamente el número en el que el user no puede confiar.
      AND s.duration_confiable IS TRUE
      AND jsonb_typeof(e.value) = 'object'
      AND ci_ts_or_null(e.value->>'startedAt') IS NOT NULL
  ),
  medidos AS (
    SELECT etiqueta, EXTRACT(EPOCH FROM (fin - ini)) / 60.0 AS mins
    FROM tramos WHERE fin IS NOT NULL AND fin > ini
  )
  SELECT m.etiqueta,
         count(*),
         round(avg(m.mins)::numeric, 1),
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY m.mins)::numeric, 1),
         round(min(m.mins)::numeric, 1),
         round(max(m.mins)::numeric, 1)
  FROM medidos m
  GROUP BY m.etiqueta
  ORDER BY m.etiqueta;
END;
$function$;

REVOKE ALL ON FUNCTION public.ci_turno_minutes(text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ci_turno_minutes(text, date, date) TO authenticated;

-- ── admin_close_ci_session también escribe la calidad ─────────────────
-- Sin esto, las filas que cierra un admin quedarían con duration_confiable
-- NULL para siempre — el mismo hueco de dos fuentes de verdad que la 194 vino
-- a cerrar para duration_minutes.
CREATE OR REPLACE FUNCTION public.ci_close_fill_quality()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.duration_confiable IS NULL THEN
    NEW.duration_motivo :=
      ci_duration_quality_from_timings(NEW.turno_timings, NEW.ended_at);
    NEW.duration_confiable := (NEW.duration_motivo IS NULL);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_ci_close_fill_quality ON public.ci_sessions;
CREATE TRIGGER trg_ci_close_fill_quality
  BEFORE INSERT ON public.ci_sessions
  FOR EACH ROW EXECUTE FUNCTION public.ci_close_fill_quality();

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- 1) Las columnas existen y el backfill corrió (0 filas sin clasificar):
--    SELECT count(*) FROM ci_sessions WHERE duration_confiable IS NULL;  → 0
--
-- 2) Distribución de la calidad — cuánto del histórico es confiable:
--    SELECT duration_confiable, duration_motivo, count(*)
--      FROM ci_sessions GROUP BY 1,2 ORDER BY 3 DESC;
--
-- 3) La suma por hub/día deja de duplicar. Comparar contra la ingenua:
--    SELECT h.user_email, h.observed_date, h.minutos AS union_real,
--           (SELECT sum(duration_minutes) FROM ci_sessions x
--             WHERE x.user_email=h.user_email AND x.observed_date=h.observed_date)
--           AS suma_ingenua
--      FROM ci_hub_daily_minutes('Peru', current_date - 30, current_date) h
--     ORDER BY suma_ingenua - h.minutos DESC NULLS LAST LIMIT 10;
--    → la ingenua debe ser MAYOR o igual, nunca menor.
--
-- 4) Tiempo por turno, solo sobre lo confiable:
--    SELECT * FROM ci_turno_minutes('Peru', current_date - 30, current_date);
--
-- 5) Paridad SQL↔JS de la calidad: scripts/simulate-session-duration.sql
-- 6) search_path fijado y anon sin EXECUTE en las 3 funciones nuevas.
