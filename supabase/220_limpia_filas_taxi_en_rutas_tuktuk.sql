-- ════════════════════════════════════════════════════════════════════════
-- Migración 220 — Limpieza del histórico: filas de TAXI sobre rutas TukTuk
--
-- DEPENDE DE LA MIGRACIÓN 219 (tabla public.tuktuk_routes). Aplicar 219
-- ANTES que ésta, y no al revés: si se borrara primero, el bot vuelve a
-- contaminar las MVs en la siguiente corrida horaria de pg_cron.
--
-- CONTEXTO: ver cabecera de mig 219. Resumen: una ruta con zona TukTuk está
-- diseñada para mototaxi; la cotización de Economy/Comfort, Comfort+,
-- Premier o XL sobre esa ruta no representa un viaje de taxi real.
--
-- ALCANCE MEDIDO EN PRODUCCIÓN (2026-08-27, antes de aplicar):
--   · 52.987 filas          (el conteo real al momento de aplicar puede ser
--                            mayor: la contaminación sigue entrando)
--   · data_source='bot'     → 52.987 (100 %)
--   · data_source<>'bot'    → 0       ← CERO trabajo manual de hubs afectado
--   · ciudades              → 1 (Lima)
--   · categorías            → Economy/Comfort, Comfort+, Premier, XL
--   · rango observed_date   → 2026-07-24 a 2026-08-27
--   Esa propiedad (100 % bot / 0 % manual) es lo que hace seguro el DELETE:
--   matemáticamente no puede tocar una fila cargada por un hub.
--
-- AUTORIZACIÓN: el user autorizó explícitamente este borrado nombrando
-- tabla, filas, motivo y respaldo previo (2026-08-27).
--
-- ★ BUG CORREGIDO EN VALIDACIÓN LOCAL (2026-08-28) — no repetir el patrón:
--   La primera versión usaba `CREATE TABLE IF NOT EXISTS <backup> AS SELECT`.
--   Si la tabla ya existe, Postgres OMITE EL SELECT ENTERO pero el DELETE
--   posterior corre igual → respaldo vacío + filas borradas = pérdida
--   irrecuperable. Se detectó en local, donde el db reset crea el respaldo
--   vacío (sin datos) y una segunda corrida habría borrado sin red.
--   Ahora: la estructura y el llenado del respaldo son pasos SEPARADOS, y
--   una guarda compara respaldadas vs. a-borrar ANTES de borrar.
--
-- ROLLBACK: restaurar desde la tabla de respaldo creada aquí:
--   INSERT INTO pricing_observations SELECT * FROM
--     pricing_observations_backup_tuktuk_taxi_20260827;
--   (la tabla de respaldo NO se borra en esta migración)
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1) Estructura del respaldo (solo esqueleto; el llenado va aparte a
--    propósito — ver BUG CORREGIDO en la cabecera)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pricing_observations_backup_tuktuk_taxi_20260827 AS
SELECT po.* FROM public.pricing_observations po WHERE false;

COMMENT ON TABLE public.pricing_observations_backup_tuktuk_taxi_20260827 IS
  'Respaldo mig 220: filas de categorías de taxi observadas sobre rutas '
  'exclusivas de TukTuk, borradas de pricing_observations el 2026-08-27. '
  '100% data_source=bot, 0% carga manual de hubs. Conservar hasta confirmar '
  'estabilidad en producción.';

-- Toda tabla nueva hereda permisos amplios por el ALTER DEFAULT PRIVILEGES
-- histórico de este proyecto (CLAUDE.md §3) — cerrarlos explícitamente.
-- Un respaldo no debe ser legible por la Data API bajo ninguna circunstancia.
REVOKE ALL ON public.pricing_observations_backup_tuktuk_taxi_20260827 FROM anon;
REVOKE ALL ON public.pricing_observations_backup_tuktuk_taxi_20260827 FROM authenticated;
ALTER TABLE public.pricing_observations_backup_tuktuk_taxi_20260827
  ENABLE ROW LEVEL SECURITY;   -- sin políticas ⇒ deny by default

-- ─────────────────────────────────────────────────────────────────────────
-- 2) Llenar el respaldo, verificar, y recién entonces borrar.
--    Todo en un solo bloque para que las tres cosas compartan transacción:
--    si algo no cuadra, RAISE aborta y no se pierde una sola fila.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_a_borrar   bigint;
  v_respaldadas bigint;
  v_borradas   bigint;
  v_restante   bigint;
  v_no_bot     bigint;
BEGIN
  -- Cuántas filas contaminadas hay AHORA
  SELECT count(*) INTO v_a_borrar
  FROM public.pricing_observations po
  WHERE po.category <> 'TukTuk'
    AND EXISTS (SELECT 1 FROM public.tuktuk_routes tr
                WHERE tr.point_a = po.point_a AND tr.point_b = po.point_b);

  IF v_a_borrar = 0 THEN
    RAISE NOTICE 'mig 220: no hay filas contaminadas — nada que hacer.';
    RETURN;
  END IF;

  -- Guarda de alcance: si aparece UNA fila que no sea del bot, abortar.
  -- El alcance autorizado es explícitamente 100% data_source='bot'.
  SELECT count(*) INTO v_no_bot
  FROM public.pricing_observations po
  WHERE po.category <> 'TukTuk'
    AND po.data_source IS DISTINCT FROM 'bot'
    AND EXISTS (SELECT 1 FROM public.tuktuk_routes tr
                WHERE tr.point_a = po.point_a AND tr.point_b = po.point_b);

  IF v_no_bot > 0 THEN
    RAISE EXCEPTION 'mig 220 ABORTADA: % filas contaminadas NO son del bot '
      '(posible trabajo manual de hub). El alcance autorizado era 100%% bot. '
      'Revisar manualmente antes de continuar.', v_no_bot;
  END IF;

  -- Llenar el respaldo (INSERT separado del CREATE: siempre corre)
  INSERT INTO public.pricing_observations_backup_tuktuk_taxi_20260827
  SELECT po.*
  FROM public.pricing_observations po
  WHERE po.category <> 'TukTuk'
    AND EXISTS (SELECT 1 FROM public.tuktuk_routes tr
                WHERE tr.point_a = po.point_a AND tr.point_b = po.point_b);
  GET DIAGNOSTICS v_respaldadas = ROW_COUNT;

  -- Nada se borra si el respaldo no tiene EXACTAMENTE lo que se va a borrar
  IF v_respaldadas <> v_a_borrar THEN
    RAISE EXCEPTION 'mig 220 ABORTADA: respaldadas % <> a borrar % — '
      'no se borra nada sin respaldo completo.', v_respaldadas, v_a_borrar;
  END IF;

  DELETE FROM public.pricing_observations po
  WHERE po.category <> 'TukTuk'
    AND EXISTS (SELECT 1 FROM public.tuktuk_routes tr
                WHERE tr.point_a = po.point_a AND tr.point_b = po.point_b);
  GET DIAGNOSTICS v_borradas = ROW_COUNT;

  IF v_borradas <> v_respaldadas THEN
    RAISE EXCEPTION 'mig 220 ABORTADA: borradas % <> respaldadas %',
      v_borradas, v_respaldadas;
  END IF;

  SELECT count(*) INTO v_restante
  FROM public.pricing_observations po
  WHERE po.category <> 'TukTuk'
    AND EXISTS (SELECT 1 FROM public.tuktuk_routes tr
                WHERE tr.point_a = po.point_a AND tr.point_b = po.point_b);

  IF v_restante <> 0 THEN
    RAISE EXCEPTION 'mig 220 ABORTADA: quedaron % filas contaminadas', v_restante;
  END IF;

  RAISE NOTICE 'mig 220 OK — % filas respaldadas y borradas, 0 restantes',
    v_borradas;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- PASO 3 — OBLIGATORIO, FUERA DE ESTA TRANSACCIÓN
--
-- refresh_ci_aggregates() reconstruye las MVs con ventana de 14 días por
-- defecto, pero la contaminación arranca el 24-jul. Sin este paso los
-- agregados de 24-jul a mediados de agosto quedan contaminados PARA SIEMPRE
-- — el cron horario nunca vuelve tan atrás. Ejecutar UNA vez tras el COMMIT:
--
--     SELECT refresh_ci_aggregates(45);
--
-- 45 días ⇒ v_week_start = date_trunc('week', current_date - 45), que cae
-- antes del 20-jul (primera semana con contaminación). Reconstruye las TRES
-- MVs afectadas: v_bracket_weekly_avg_mv, v_bracket_daily_avg_mv y
-- v_yango_rival_diff_mv. Es más pesado que la corrida normal (statement_
-- timeout de la función = 900s); correrlo fuera de horario de carga.
--
-- PASO 4 — VERIFICACIÓN POST-DEPLOY (CLAUDE.md §7.8), con datos reales:
--     SELECT count(*) FROM pricing_observations po
--     WHERE po.category <> 'TukTuk'
--       AND EXISTS (SELECT 1 FROM tuktuk_routes tr
--                   WHERE tr.point_a=po.point_a AND tr.point_b=po.point_b);
--     -- debe dar 0 (y volver a dar >0 con el correr de los días hasta que
--     --  el bot se corrija: el filtro de mig 219 los mantiene fuera del
--     --  análisis mientras tanto).
-- ════════════════════════════════════════════════════════════════════════
