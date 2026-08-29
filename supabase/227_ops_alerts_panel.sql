-- ════════════════════════════════════════════════════════════════════════
-- Migración 227 — Panel de alertas operativas: tabla espejo + RPC de resolución
--
-- ORIGEN: pedido de un panel en el Dashboard que muestre las alertas del
-- watchdog del scraper (ridehailing.ops_alerts en la base remota de helioho).
--
-- POR QUÉ NO ES UNA FOREIGN TABLE (el diseño original propuesto):
--   Supabase NO puede conectarse a fudobi.helioho.st. Verificado el
--   2026-08-29 con 3 intentos sobre la foreign table YA existente
--   (bot_quotes_remote): `SELECT 1 ... LIMIT 1` cuelga a los 25s, 75s y
--   nunca devuelve error de conexión — la conexión jamás se establece.
--   Al mismo tiempo, el sync de GitHub Actions leyó ESA MISMA base con
--   éxito 4 veces por país en las últimas 24h. O sea: la base remota está
--   viva, pero helioho bloquea las IPs de Supabase — que es exactamente la
--   razón por la que existe .github/workflows/bot-sync.yml (lo documenta su
--   propio encabezado). `bot_quotes_remote` es un vestigio que hoy no
--   funciona; nada en producción la usa.
--
--   Peor todavía: `CREATE FOREIGN TABLE` es solo metadata y NO valida la
--   conexión, así que el DDL habría "funcionado" y el panel se habría
--   colgado recién en runtime, en cada carga de página, pareciendo un bug
--   del frontend en vez de un problema de red.
--
--   Y aun si la conexión funcionara: leer por FDW en cada render abriría
--   conexiones contra un shared hosting con max_connections muy bajo, que
--   ya causó incidentes reales acá (rechazos por "remaining connection
--   slots are reserved..." cuando 2 países sincronizaban en paralelo; se
--   arregló con max-parallel=1). Con ~23 usuarios sería peor.
--
-- DISEÑO ADOPTADO: mismo patrón que TODA la data de este proyecto — GitHub
-- Actions (cuyas IPs sí llegan a helioho) lee la tabla remota y la empuja
-- acá. El panel lee esta tabla local: rápido, con RLS real, y sin depender
-- de helioho durante la navegación.
--
-- `id` es el id REMOTO, no una secuencia local: es la clave de idempotencia
-- del sync (upsert por id), y permite rastrear una alerta hasta su origen.
--
-- RESOLUCIÓN: vive SOLO en local (decisión del user 2026-08-29 — el
-- watchdog no lee de vuelta la columna `resolved`). El sync solo TRAE
-- alertas; nunca pisa una resolución local (ver regla en el comentario de
-- `resolved`).
--
-- POR QUÉ EL BOTÓN VA POR RPC Y NO POR UN UPDATE DIRECTO:
--   El pedido original era que el botón hiciera `UPDATE ops_alerts SET
--   resolved = TRUE WHERE id = <id>` desde el cliente. Una política RLS no
--   puede restringir por COLUMNA (CLAUDE.md §3): un grant de UPDATE para
--   marcar `resolved` también dejaría reescribir `message` y `severity`,
--   o sea falsear el historial de alertas desde la consola del navegador.
--   Mismo patrón ya usado en migs 183/184.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Tabla espejo ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ops_alerts (
  -- id remoto (ridehailing.ops_alerts.id) — clave de idempotencia del sync.
  id             bigint      PRIMARY KEY,
  created_at_utc timestamptz NOT NULL,
  source         text,
  -- Sin CHECK a propósito: severity viene de un sistema que NO controlamos.
  -- Un CHECK haría fallar el sync entero si el watchdog agrega un nivel
  -- nuevo ('critical', 'info'…). La UI mapea problem→rojo, warning→amarillo
  -- y cualquier otro valor a un estilo neutro, en vez de romperse.
  severity       text        NOT NULL,
  message        text,
  -- Resolución LOCAL. El sync nunca la baja de true a false (ver mig y el
  -- upsert del script): si alguien resolvió acá, queda resuelta.
  resolved       boolean     NOT NULL DEFAULT false,
  resolved_at    timestamptz,
  resolved_by    text,
  synced_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ops_alerts IS
  'Espejo local de ridehailing.ops_alerts (base del scraper). Se puebla vía GitHub Actions porque Supabase no puede alcanzar helioho — ver mig 227. La columna resolved es LOCAL: el watchdog no la lee de vuelta.';

-- La consulta del panel es exactamente "abiertas, más nuevas primero".
-- Índice parcial: solo indexa las no resueltas (la minoría que crece poco),
-- no el histórico completo de alertas ya cerradas.
CREATE INDEX IF NOT EXISTS idx_ops_alerts_abiertas
  ON public.ops_alerts (created_at_utc DESC)
  WHERE resolved = false;

-- ── 2. Seguridad: deny by default ────────────────────────────────────────
-- CLAUDE.md §3: RLS y GRANT son controles COMPLEMENTARIOS. El permiso se
-- evalúa ANTES que la política, así que una tabla con RLS impecable y un
-- grant amplio sigue estando abierta.
ALTER TABLE public.ops_alerts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.ops_alerts FROM anon, authenticated, PUBLIC;

-- Lectura: solo quien tenga la sección 'dashboard' (el panel vive ahí).
-- El UPDATE/INSERT/DELETE NO se concede a authenticated: el sync escribe
-- con service_role (que saltea RLS) y la resolución va por la RPC de abajo.
GRANT SELECT ON public.ops_alerts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ops_alerts TO service_role;

DROP POLICY IF EXISTS ops_alerts_select ON public.ops_alerts;
CREATE POLICY ops_alerts_select ON public.ops_alerts
  FOR SELECT TO authenticated
  USING (can_access_section('dashboard'));

-- ── 3. Permiso de escritura por el modelo GENÉRICO (migs 187/192) ────────
-- gate='section' → can_write_table('ops_alerts') devuelve true para quien
-- tenga la sección 'dashboard'. Cambiar quién puede resolver alertas se
-- hace desde la pantalla de Accesos, NUNCA con una migración nueva.
INSERT INTO public.section_write_grants (section, table_name, gate, note)
VALUES ('dashboard', 'ops_alerts', 'section',
        'Resolver alertas del panel de ops. La escritura real pasa por resolve_ops_alert() (SECURITY DEFINER): la RPC solo toca resolved/resolved_at/resolved_by, nunca message ni severity.')
ON CONFLICT (section, table_name) DO UPDATE
  SET gate = EXCLUDED.gate, note = EXCLUDED.note;

-- ── 4. RPC de resolución ─────────────────────────────────────────────────
-- Escribe SOLO las 3 columnas de resolución. Devuelve la fila actualizada
-- para que el cliente refresque sin re-fetchear todo el listado.
CREATE OR REPLACE FUNCTION public.resolve_ops_alert(p_id bigint)
RETURNS public.ops_alerts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row public.ops_alerts;
BEGIN
  IF NOT can_write_table('ops_alerts') THEN
    RAISE EXCEPTION 'No tenés permiso para resolver alertas operativas.'
      USING ERRCODE = '42501';
  END IF;

  -- Idempotente: resolver dos veces (doble clic, dos pestañas) no pisa el
  -- autor ni la hora original. El WHERE NOT resolved hace que el segundo
  -- UPDATE no matchee; el SELECT de abajo devuelve igual la fila.
  UPDATE public.ops_alerts
     SET resolved    = true,
         resolved_at = now(),
         resolved_by = (select auth.email())
   WHERE id = p_id
     AND resolved = false
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    SELECT * INTO v_row FROM public.ops_alerts WHERE id = p_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'La alerta % no existe.', p_id USING ERRCODE = 'no_data_found';
    END IF;
  END IF;

  RETURN v_row;
END;
$function$;

-- Por default toda función nace con EXECUTE para PUBLIC — revocarlo primero
-- y conceder explícito solo a authenticated (el guard interno hace el resto).
REVOKE EXECUTE ON FUNCTION public.resolve_ops_alert(bigint) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.resolve_ops_alert(bigint) TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   1. Deny by default para anon:
--      SET ROLE anon; SELECT * FROM ops_alerts;  → debe fallar (sin grant).
--   2. RLS activa y con política de SELECT únicamente:
--      SELECT cmd, roles FROM pg_policies WHERE tablename='ops_alerts';
--      → 1 fila, cmd=SELECT.
--   3. La RPC no deja tocar message/severity: no recibe esos parámetros.
--   4. relacl sin permisos de escritura para authenticated:
--      SELECT relacl FROM pg_class WHERE relname='ops_alerts';
-- ════════════════════════════════════════════════════════════════════════
