-- ════════════════════════════════════════════════════════════════════════
-- Paridad SQL ↔ JS del cálculo de `ci_sessions.duration_minutes` (mig 192).
--
-- POR QUÉ EXISTE
-- La duración se escribe por DOS caminos: el cliente cuando el hub aprieta
-- "Terminar" (src/lib/sessionDuration.js) y `admin_close_ci_session` cuando
-- un admin la cierra a la fuerza. Tener dos implementaciones del mismo
-- algoritmo es inevitable —una corre en el navegador y la otra en Postgres—
-- pero que DIVERJAN no: sería volver a tener dos fuentes de verdad, que es
-- exactamente el bug que la mig 192 vino a cerrar.
--
-- Los casos de acá son los MISMOS que scripts/test-session-duration.mjs, con
-- los mismos números esperados. Si uno de los dos cambia y el otro no, esto
-- lo caza.
--
--   npm run simulate:session-duration
-- ════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
\pset pager off

DO $$
DECLARE
  fallos int := 0;
  total  int := 0;

  v_got  numeric;
BEGIN
  -- ── [1] Sesión normal de 3 turnos → 40 + 35 + 25 = 100 ──────────────
  total := total + 1;
  v_got := ci_duration_from_timings(
    '{"Mañana":{"startedAt":"2026-08-01T09:00:00Z","endedAt":"2026-08-01T09:40:00Z"},
      "Tarde":{"startedAt":"2026-08-01T13:00:00Z","endedAt":"2026-08-01T13:35:00Z"},
      "Noche":{"startedAt":"2026-08-01T19:00:00Z","endedAt":"2026-08-01T19:25:00Z"}}'::jsonb,
    '2026-08-01T19:26:00Z'::timestamptz);
  IF v_got IS DISTINCT FROM 100 THEN
    RAISE WARNING '[1] sesión normal: esperaba 100, obtuve %', v_got; fallos := fallos + 1;
  END IF;

  -- ── [2] Aeropuerto "Ambos": el Punto B NO puede dar 0.1 ─────────────
  -- Es el síntoma reportado por el user. La duración no depende de cuándo
  -- se apretó Terminar, así que el fin de sesión no la mueve.
  total := total + 1;
  v_got := ci_duration_from_timings(
    '{"Mañana":{"startedAt":"2026-08-01T09:50:00Z","endedAt":"2026-08-01T10:45:00Z"}}'::jsonb,
    '2026-08-01T10:45:06Z'::timestamptz);
  IF v_got IS DISTINCT FROM 55 THEN
    RAISE WARNING '[2] Punto B: esperaba 55, obtuve %', v_got; fallos := fallos + 1;
  END IF;

  total := total + 1;
  v_got := ci_duration_from_timings(
    '{"Mañana":{"startedAt":"2026-08-01T09:50:00Z","endedAt":"2026-08-01T10:45:00Z"}}'::jsonb,
    '2026-08-01T13:45:06Z'::timestamptz);  -- 3h más tarde
  IF v_got IS DISTINCT FROM 55 THEN
    RAISE WARNING '[2b] terminar 3h más tarde debe dar lo mismo: obtuve %', v_got; fallos := fallos + 1;
  END IF;

  -- ── [3] F5 con la grilla completa: el trabajo sobrevive ─────────────
  total := total + 1;
  v_got := ci_duration_from_timings(
    '{"Mañana":{"startedAt":"2026-08-01T09:00:00Z","endedAt":"2026-08-01T09:40:00Z"},
      "Tarde":{"startedAt":"2026-08-01T09:40:00Z","endedAt":"2026-08-01T10:20:00Z"}}'::jsonb,
    '2026-08-01T10:21:30Z'::timestamptz);
  IF v_got IS DISTINCT FROM 80 THEN
    RAISE WARNING '[3] F5: esperaba 80, obtuve %', v_got; fallos := fallos + 1;
  END IF;

  -- ── [4] Turno abierto de ayer: se acota a 4h, no cuenta 15h ─────────
  total := total + 1;
  v_got := ci_duration_from_timings(
    '{"Mañana":{"startedAt":"2026-07-31T09:00:00Z","endedAt":"2026-07-31T09:45:00Z"},
      "Noche":{"startedAt":"2026-07-31T20:00:00Z"}}'::jsonb,
    '2026-08-01T11:00:00Z'::timestamptz);
  IF v_got IS DISTINCT FROM 285 THEN
    RAISE WARNING '[4] turno de ayer: esperaba 285 (45+240), obtuve %', v_got; fallos := fallos + 1;
  END IF;

  -- Sin fin de sesión, el turno abierto no aporta minutos.
  total := total + 1;
  v_got := ci_duration_from_timings(
    '{"Mañana":{"startedAt":"2026-07-31T09:00:00Z","endedAt":"2026-07-31T09:45:00Z"},
      "Noche":{"startedAt":"2026-07-31T20:00:00Z"}}'::jsonb,
    NULL);
  IF v_got IS DISTINCT FROM 45 THEN
    RAISE WARNING '[4b] sin fin: esperaba 45, obtuve %', v_got; fallos := fallos + 1;
  END IF;

  -- ── [5] Nada que medir → NULL, nunca 0 ──────────────────────────────
  -- Este es el reemplazo del `ELSE 0` de la mig 159, que era el otro camino
  -- por el que aparecían duraciones absurdamente bajas.
  total := total + 1;
  IF ci_duration_from_timings(NULL, now()) IS NOT NULL THEN
    RAISE WARNING '[5] timings NULL debe dar NULL'; fallos := fallos + 1;
  END IF;
  total := total + 1;
  IF ci_duration_from_timings('{}'::jsonb, now()) IS NOT NULL THEN
    RAISE WARNING '[5b] timings vacío debe dar NULL, no 0'; fallos := fallos + 1;
  END IF;
  total := total + 1;
  IF ci_duration_from_timings('"no soy un objeto"'::jsonb, now()) IS NOT NULL THEN
    RAISE WARNING '[5c] jsonb no-objeto debe dar NULL'; fallos := fallos + 1;
  END IF;

  -- ── [6] Laptop cerrada ──────────────────────────────────────────────
  -- Entre turnos: no cuenta.
  total := total + 1;
  v_got := ci_duration_from_timings(
    '{"Mañana":{"startedAt":"2026-08-01T09:00:00Z","endedAt":"2026-08-01T09:40:00Z"},
      "Tarde":{"startedAt":"2026-08-01T13:40:00Z","endedAt":"2026-08-01T14:15:00Z"}}'::jsonb,
    '2026-08-01T14:16:00Z'::timestamptz);
  IF v_got IS DISTINCT FROM 75 THEN
    RAISE WARNING '[6] pausa entre turnos: esperaba 75, obtuve %', v_got; fallos := fallos + 1;
  END IF;

  -- Dentro de un turno: se acota al techo de 4h.
  total := total + 1;
  v_got := ci_duration_from_timings(
    '{"Mañana":{"startedAt":"2026-08-01T09:00:00Z","endedAt":"2026-08-01T15:30:00Z"}}'::jsonb,
    '2026-08-01T15:31:00Z'::timestamptz);
  IF v_got IS DISTINCT FROM 240 THEN
    RAISE WARNING '[6b] pausa dentro del turno: esperaba 240, obtuve %', v_got; fallos := fallos + 1;
  END IF;

  -- ── [7] Turnos intercalados: unión, no suma ─────────────────────────
  total := total + 1;
  v_got := ci_duration_from_timings(
    '{"Mañana":{"startedAt":"2026-08-01T09:00:00Z","endedAt":"2026-08-01T10:00:00Z"},
      "Tarde":{"startedAt":"2026-08-01T09:30:00Z","endedAt":"2026-08-01T10:30:00Z"}}'::jsonb,
    '2026-08-01T10:31:00Z'::timestamptz);
  IF v_got IS DISTINCT FROM 90 THEN
    RAISE WARNING '[7] solapados: esperaba 90 (unión), obtuve % (¿sumó?)', v_got; fallos := fallos + 1;
  END IF;

  -- Un turno contenido en otro no agrega minutos.
  total := total + 1;
  v_got := ci_duration_from_timings(
    '{"A":{"startedAt":"2026-08-01T09:00:00Z","endedAt":"2026-08-01T09:10:00Z"},
      "B":{"startedAt":"2026-08-01T09:01:00Z","endedAt":"2026-08-01T09:02:00Z"}}'::jsonb,
    NULL);
  IF v_got IS DISTINCT FROM 10 THEN
    RAISE WARNING '[7b] contenido: esperaba 10, obtuve %', v_got; fallos := fallos + 1;
  END IF;

  -- ── [9] Corruptos: nunca rompen ni dan negativo ─────────────────────
  total := total + 1;
  IF ci_duration_from_timings('{"M":{"startedAt":"basura total"}}'::jsonb, now()) IS NOT NULL THEN
    RAISE WARNING '[9] startedAt no parseable debe ignorarse'; fallos := fallos + 1;
  END IF;

  total := total + 1;
  IF ci_duration_from_timings('{"M":{}}'::jsonb, now()) IS NOT NULL THEN
    RAISE WARNING '[9b] turno sin startedAt debe ignorarse (no 0 min)'; fallos := fallos + 1;
  END IF;

  -- endedAt anterior a su startedAt: cae al fin de sesión, nunca negativo.
  total := total + 1;
  v_got := ci_duration_from_timings(
    '{"M":{"startedAt":"2026-08-01T10:00:00Z","endedAt":"2026-08-01T09:00:00Z"}}'::jsonb,
    '2026-08-01T10:30:00Z'::timestamptz);
  IF v_got IS DISTINCT FROM 30 THEN
    RAISE WARNING '[9c] endedAt invertido: esperaba 30, obtuve %', v_got; fallos := fallos + 1;
  END IF;

  -- Fin de sesión ANTERIOR al inicio del turno: no cierra nada.
  total := total + 1;
  IF ci_duration_from_timings(
       '{"M":{"startedAt":"2026-08-01T10:00:00Z"}}'::jsonb,
       '2026-08-01T09:00:00Z'::timestamptz) IS NOT NULL THEN
    RAISE WARNING '[9d] fin anterior al inicio no debe cerrar el turno'; fallos := fallos + 1;
  END IF;

  -- ── [11] ci_started_from_timings ────────────────────────────────────
  total := total + 1;
  IF ci_started_from_timings(
       '{"Tarde":{"startedAt":"2026-08-01T13:00:00Z"},
         "Mañana":{"startedAt":"2026-08-01T09:00:00Z"}}'::jsonb)
     IS DISTINCT FROM '2026-08-01T09:00:00Z'::timestamptz THEN
    RAISE WARNING '[11] inicio real debe ser el startedAt más antiguo'; fallos := fallos + 1;
  END IF;

  total := total + 1;
  IF ci_started_from_timings('{}'::jsonb) IS NOT NULL THEN
    RAISE WARNING '[11b] sin turnos, sin inicio'; fallos := fallos + 1;
  END IF;

  total := total + 1;
  IF ci_started_from_timings(NULL) IS NOT NULL THEN
    RAISE WARNING '[11c] NULL no debe romper'; fallos := fallos + 1;
  END IF;

  -- ── Resultado ───────────────────────────────────────────────────────
  IF fallos = 0 THEN
    RAISE NOTICE '✓ % casos de paridad SQL↔JS pasaron', total;
  ELSE
    RAISE EXCEPTION '✗ % de % casos fallaron — SQL y JS divergieron', fallos, total;
  END IF;
END $$;

-- ── Permisos: los helpers NO deben quedar expuestos como RPC ───────────
-- (CLAUDE.md §3: verificar, no asumir. Por defecto Postgres da EXECUTE a
-- PUBLIC, y todo lo ejecutable por `authenticated` es una RPC de PostgREST.)
SELECT p.proname,
       has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_puede,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_puede,
       p.proconfig
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('ci_ts_or_null', 'ci_started_from_timings',
                    'ci_duration_from_timings', 'admin_close_ci_session')
ORDER BY p.proname;
