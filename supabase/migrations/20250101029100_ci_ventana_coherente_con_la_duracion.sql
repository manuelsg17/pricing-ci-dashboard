-- ════════════════════════════════════════════════════════════════════════
-- 210 — la ventana de la sesión no contiene al trabajo que dice medir:
--       19 de 60 filas confiables reportan más minutos de los que hay entre
--       su `started_at` y su `ended_at`.
--
-- ⚠️  NO APLICADA A PRODUCCIÓN. Requiere autorización explícita del user para
--     ESTA migración puntual (CLAUDE.md §3).
--
-- ── EL DIAGNÓSTICO DEL PLAN MAESTRO ESTABA AL REVÉS ─────────────────────
-- El plan lo anotó como "el piso de plausibilidad solo defiende el lado bajo:
-- una duración inventada de 400 minutos entra marcada como confiable", y la
-- cura implícita era un TECHO que le sacara la marca de confianza.
--
-- Se miró el dato antes de escribir el techo, y era exactamente lo contrario:
-- la duración está BIEN y lo que está mal es la ventana. El caso peor,
-- rayrodriguez / Lima_Airport_B / 2026-07-25, dice 211.0 minutos con una
-- ventana de 13 segundos. Sus `turno_timings`:
--
--     Mañana  14:42:43 → 16:36:07   = 113.4 min
--     Tarde   19:19:44 → 20:03:43   =  44.0 min
--     Noche   22:22:27 → 23:16:02   =  53.6 min
--                                     ─────────
--                                      211.0 min   ← exacto
--
-- O sea que `duration_minutes` es la unión real de los tramos trabajados. Un
-- techo contra la ventana habría tirado a la basura 19 mediciones legítimas
-- —justo el reporte de productividad que se quería proteger— por culpa de un
-- `started_at` viejo. Es el mismo error que ya se cometió una vez con el piso
-- (mig 201 §3: "cambiar un número chico y honesto por uno grande e inventado
-- es peor que el problema original"), en la otra dirección.
--
-- ── DE DÓNDE SALE EL `started_at` MALO ──────────────────────────────────
-- El cliente viejo lo tomaba de `sessionStartRef` (reloj de pared) en el
-- instante del cierre. En una sesión multi-frente —Aeropuerto A y B, o varios
-- distritos de TukTuk— el hub llena todo y recién ahí cierra los frentes uno
-- tras otro: cada cierre reseteaba el reloj, así que el `started_at` de cada
-- frente terminaba siendo el `ended_at` del anterior. Se ve en el dato, los
-- cierres están encadenados con 0 segundos de diferencia entre uno y el
-- siguiente.
--
-- `src/lib/sessionDuration.js` YA lo arregló del lado del cliente: devuelve
-- `inicio = min(startedAt de los tramos medibles)` y `DataEntry.jsx` lo manda
-- como `started_at`. Medido contra producción, el fix funciona:
--
--     PRE-deploy            65 filas → 14 violan
--     bundle intermedio     19 filas →  5 violan
--     POST-deploy            4 filas →  0 violan   ← el cliente nuevo está sano
--
-- Así que esto NO es un bug vivo: es residuo. La mig 196 backfilleó
-- `duration_minutes` y se olvidó de la ventana que lo tiene que contener.
--
-- ── QUÉ HACE ESTA MIGRACIÓN ─────────────────────────────────────────────
-- 1. Backfill de las filas históricas: `started_at` pasa a ser el más
--    temprano entre el que tiene y el que dicen sus turnos.
-- 2. Un guard en el trigger para que la base deje de depender de que el
--    cliente se porte bien — mismo criterio con el que la mig 194 movió la
--    duración a una fuente única en SQL.
--
-- ── POR QUÉ `LEAST` Y NO UNA ASIGNACIÓN DIRECTA ─────────────────────────
-- La ventana solo se ENSANCHA, nunca se achica. Un hub que arrancó la sesión
-- a las 09:00 y recién llenó su primera celda a las 09:40 tiene una ventana
-- legítimamente más ancha que sus timings, y esos 40 minutos de preparación
-- no son un error que haya que recortar. Con `LEAST` el caso bueno queda
-- intacto (es idempotente) y solo se corrige el caso roto.
--
-- No se toca `ended_at`: es el instante del cierre y siempre fue correcto.
-- Tampoco se toca `duration_minutes`: es el número que se quería salvar.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1 · El guard, para que no vuelva a entrar una fila incoherente ──────
-- Se suma al trigger que ya corre en TODO INSERT a `ci_sessions` (mig 201),
-- que es el único punto por el que pasan los dos caminos de cierre —el del
-- hub (`close_ci_session`, que toma el valor del payload del cliente) y el
-- del admin (`admin_close_ci_session`, que lo calcula en SQL).
CREATE OR REPLACE FUNCTION public.ci_close_fill_quality()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inicio_timings timestamptz;
BEGIN
  -- Completar lo que el cliente no mandó (mig 195/199).
  IF NEW.duration_confiable IS NULL THEN
    NEW.duration_motivo :=
      ci_duration_quality_from_timings(NEW.turno_timings, NEW.ended_at);
    NEW.duration_confiable := (NEW.duration_motivo IS NULL);
  END IF;

  -- PISO DE PLAUSIBILIDAD (mig 201). Un corte son 36-108 celdas: menos de un
  -- minuto no es una medición corta, es una grilla que llegó completa de un
  -- saque. NO se toca `duration_minutes`: se le quita la marca de confianza,
  -- que es lo que lo excluye de los promedios.
  IF NEW.duration_minutes IS NOT NULL AND NEW.duration_minutes < 1 THEN
    NEW.duration_confiable := false;
    NEW.duration_motivo    := 'duracion_de_juguete';
  END IF;

  -- ── NUEVO (210) · la ventana tiene que contener al trabajo ────────────
  -- Un cliente viejo —o cualquiera que mande el reloj de pared del momento
  -- del cierre— dejaba `started_at` DESPUÉS del primer turno trabajado. La
  -- fila quedaba diciendo 211 minutos de trabajo en una ventana de 13
  -- segundos: internamente incoherente, y visible así en Monitoreo.
  --
  -- Solo ensancha (LEAST). Ver la cabecera para por qué achicar sería un bug.
  v_inicio_timings := ci_started_from_timings(NEW.turno_timings);
  IF v_inicio_timings IS NOT NULL THEN
    NEW.started_at := LEAST(COALESCE(NEW.started_at, v_inicio_timings), v_inicio_timings);
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.ci_close_fill_quality() FROM PUBLIC, anon, authenticated;

-- ── 2 · Mismo criterio cuando el backfill reescribe la duración ─────────
-- La mig 196 recalcula `duration_minutes` con un UPDATE. Si la duración
-- cambia, la ventana que la contiene tiene que seguir siendo válida.
CREATE OR REPLACE FUNCTION public.ci_update_refresh_quality()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inicio_timings timestamptz;
BEGIN
  NEW.duration_motivo :=
    ci_duration_quality_from_timings(NEW.turno_timings, NEW.ended_at);
  NEW.duration_confiable := (NEW.duration_motivo IS NULL);

  IF NEW.duration_minutes IS NOT NULL AND NEW.duration_minutes < 1 THEN
    NEW.duration_confiable := false;
    NEW.duration_motivo    := 'duracion_de_juguete';
  END IF;

  v_inicio_timings := ci_started_from_timings(NEW.turno_timings);
  IF v_inicio_timings IS NOT NULL THEN
    NEW.started_at := LEAST(COALESCE(NEW.started_at, v_inicio_timings), v_inicio_timings);
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.ci_update_refresh_quality() FROM PUBLIC, anon, authenticated;

-- ── 3 · Backfill del residuo histórico ─────────────────────────────────
-- Acotado (solo las filas incoherentes), observable (reporta cuántas tocó) y
-- sin WHERE abierto sobre la tabla entera — CLAUDE.md §4.
--
-- El UPDATE toca `started_at`, que NO dispara `trg_ci_update_refresh_quality`
-- (ese mira `duration_minutes`), así que no hay recursión ni recálculo de la
-- marca de confianza: las filas conservan la calidad que ya tenían.
DO $$
DECLARE
  v_antes  int;
  v_tocadas int;
  v_despues int;
BEGIN
  SELECT count(*) INTO v_antes
  FROM ci_sessions
  WHERE duration_confiable
    AND duration_minutes > extract(epoch from (ended_at - started_at))/60 + 1;

  WITH corregibles AS (
    SELECT id, ci_started_from_timings(turno_timings) AS inicio_real
    FROM ci_sessions
    WHERE duration_minutes IS NOT NULL
      AND started_at IS NOT NULL
      AND duration_minutes > extract(epoch from (ended_at - started_at))/60 + 1
      AND ci_started_from_timings(turno_timings) IS NOT NULL
      AND ci_started_from_timings(turno_timings) < started_at
  )
  UPDATE ci_sessions s
  SET started_at = c.inicio_real
  FROM corregibles c
  WHERE s.id = c.id;
  GET DIAGNOSTICS v_tocadas = ROW_COUNT;

  SELECT count(*) INTO v_despues
  FROM ci_sessions
  WHERE duration_confiable
    AND duration_minutes > extract(epoch from (ended_at - started_at))/60 + 1;

  RAISE NOTICE '[210] ventana incoherente: % antes → % después (% filas corregidas)',
    v_antes, v_despues, v_tocadas;

  IF v_despues > 0 THEN
    RAISE WARNING '[210] quedan % filas incoherentes: sus turno_timings no alcanzan para reconstruir la ventana. Revisar a mano.', v_despues;
  END IF;
END $$;

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- Las dos invariantes de calidad de la duración, juntas:
--
--   SELECT count(*) FROM ci_sessions
--    WHERE duration_confiable AND duration_minutes < 1;                    → 0
--   SELECT count(*) FROM ci_sessions
--    WHERE duration_confiable
--      AND duration_minutes > extract(epoch FROM (ended_at-started_at))/60 + 1;  → 0
--
-- Y que el backfill no haya inventado nada:
--   · ninguna fila con started_at > ended_at
--   · `duration_minutes` sin cambios (esta migración no lo toca)
--   · el total de filas confiables no cambia (no se degradó ninguna marca)
--
-- Del lado del guard, con una fila nueva:
--   1) started_at posterior al primer turno   → se corrige al del turno
--   2) started_at anterior al primer turno    → se RESPETA (solo ensancha)
--   3) sin turno_timings                      → se respeta tal cual
