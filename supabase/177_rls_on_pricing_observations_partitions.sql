-- ════════════════════════════════════════════════════════════════════════
-- 177_rls_on_pricing_observations_partitions.sql — habilita RLS en las
-- particiones de pricing_observations y hace que las futuras nazcan con
-- RLS activo.
--
-- CONTEXTO
-- El advisory de Supabase marca como "critical — RLS disabled" las 19
-- particiones de pricing_observations (2025_07..2026_12 + _default). La
-- tabla padre sí tiene RLS y sus 4 políticas (migs 175/176), pero las
-- particiones se crearon sin RLS propio.
--
-- El advisory es un FALSO POSITIVO en cuanto a exposición real, verificado
-- contra la BD antes de escribir esto (CLAUDE.md §3 exige mirar relacl
-- directo, no confiar en el advisory ni en information_schema):
--
--   - pg_class.relacl de cada partición = {postgres, service_role}. NO
--     tienen GRANT para anon/authenticated. En Postgres el chequeo de
--     privilegios ocurre ANTES que RLS, así que sin GRANT no se llega a
--     evaluar política alguna.
--   - Probado empíricamente: SET ROLE authenticated + SELECT directo sobre
--     pricing_observations_2026_07 → "permission denied". No hay lectura
--     posible hoy.
--   - pg_default_acl: las tablas creadas por `postgres` en public heredan
--     solo {postgres, service_role} — el ALTER DEFAULT PRIVILEGES laxo que
--     menciona CLAUDE.md §3 ya está cerrado para este camino. El cron
--     `ensure-next-pricing-partition` corre como `postgres` (verificado en
--     cron.job), así que las particiones futuras tampoco nacen expuestas.
--
-- Entonces esto NO cierra una fuga activa. Se aplica por dos motivos:
--
--   1. Defensa en profundidad. Hoy lo único que protege las particiones es
--      la ausencia de un GRANT. Un GRANT manual (o un cambio futuro de
--      default privileges) las expondría de inmediato, sin segunda línea.
--      Este proyecto ya tuvo fugas RLS reales en 3+ rondas de migraciones
--      (CLAUDE.md §3) — el costo de la redundancia acá es cero.
--   2. Higiene de alertas. El advisory queda en rojo "critical" de forma
--      permanente. Una alerta crítica que siempre está encendida y que
--      todos aprenden a ignorar es peor que no tenerla: la próxima fuga
--      REAL se pierde en el ruido.
--
-- APPROACH
-- Habilitar RLS en cada partición SIN crear políticas propias. Semántica
-- de Postgres para tablas particionadas, probada en esta misma BD con una
-- partición de juguete dentro de una transacción revertida:
--
--   - consultando por la tabla PADRE  → se aplican las políticas del padre,
--     se ven las filas normalmente (probe: 2 de 2 filas). La app NO se ve
--     afectada — usa siempre `pricing_observations`, nunca una partición
--     por nombre (verificado: 0 funciones, 0 vistas y 0 referencias en
--     src/ apuntan a una partición directa).
--   - consultando la PARTICIÓN directa → RLS activo sin políticas = deny
--     all (probe: 0 filas). Es exactamente el comportamiento buscado.
--
-- El padre tiene relforcerowsecurity=false, así que el owner (postgres)
-- sigue haciendo bypass: pg_cron, refresh_ci_aggregates y el bot sync no
-- se ven afectados.
--
-- Se usa un loop dinámico en vez de 19 ALTERs hardcodeados para que cubra
-- también cualquier partición que exista y no esté en la lista de hoy.
--
-- VERIFICACIÓN (post-aplicación)
--   - relrowsecurity = true en las 19 particiones.
--   - SELECT por el padre sigue devolviendo el mismo conteo que antes.
--   - Dashboard carga normal (RPCs _fast leen las tablas de agregados, no
--     las particiones — no deberían ni enterarse).
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. RLS en todas las particiones existentes ────────────────────────
DO $$
DECLARE
  part record;
  n int := 0;
BEGIN
  FOR part IN
    SELECT c.oid::regclass AS rel
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    WHERE i.inhparent = 'public.pricing_observations'::regclass
      AND c.relrowsecurity = false
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', part.rel);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'RLS habilitado en % particion(es) de pricing_observations', n;
END $$;

-- ── 2. Que las particiones futuras nazcan con RLS ─────────────────────
-- Sin esto el cron semanal `ensure-next-pricing-partition` seguiría
-- creando particiones sin RLS y el advisory volvería a encenderse solo
-- (la próxima sería 2027_01, creada en noviembre 2026).
CREATE OR REPLACE FUNCTION public.ensure_next_pricing_partition()
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  target_month date := date_trunc('month', now() + interval '2 months')::date;
  part_name text := 'pricing_observations_' || to_char(target_month, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.pricing_observations FOR VALUES FROM (%L) TO (%L)',
    part_name,
    target_month,
    (target_month + interval '1 month')::date
  );

  -- Defensa en profundidad, igual que la mig 177 hizo con las existentes:
  -- la partición queda deny-all para acceso directo; el acceso legítimo
  -- pasa por el padre, donde viven las políticas.
  EXECUTE format(
    'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
    part_name
  );
END;
$$;
