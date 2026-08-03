-- ════════════════════════════════════════════════════════════════════════
-- 206 — dos cosas que el plan maestro dejó abiertas:
--   A) las RPCs 2.2 y 2.3, que leen trabajo de OTRO hub con un solo eje de gate
--   B) los GRANT de escritura que `anon` todavía tiene sobre 30 tablas
--
-- ⚠️  NO APLICADA A PRODUCCIÓN. Requiere autorización explícita del user para
--     ESTA migración puntual (CLAUDE.md §3).
--
-- ════════════════════════════════════════════════════════════════════════
-- A · LAS DOS RPCs — Y POR QUÉ **NO** LLEVAN `is_admin()`
-- ════════════════════════════════════════════════════════════════════════
--
-- El plan maestro las anotó como "2.2 · entrega los horarios de otro hub" y
-- "2.3 · sin is_admin()", con la sugerencia implícita de cerrarlas por admin.
-- Se leyó el código antes de tocarlas y esa sugerencia era equivocada: las dos
-- leen trabajo ajeno A PROPÓSITO, y cerrarlas por admin rompe la función que
-- vinieron a cumplir.
--
--   · get_ci_session_turno_timings (mig 160) — existe para el RELEVO entre
--     hubs. Cuando el Hub B toma una (ciudad, zona, fecha) que el Hub A ya
--     trabajó, esta RPC le trae los `turno_timings` de A ANTES de que el efecto
--     de estampado corra sobre la grilla recién cargada. Sin ella, un turno ya
--     completo se re-estampa con el "ahora" de quien lo abre y la métrica de
--     velocidad queda arruinada. Se llama desde DataEntry.jsx:3119, o sea desde
--     el hub, que nunca es admin.
--
--   · get_active_sessions_presence (mig 152/161) — es el puntito verde de
--     "quién más está acá ahora", para que dos hubs no dupliquen el mismo Punto
--     de Aeropuerto o el mismo distrito de TukTuk. La mig 152 la escribió
--     explícitamente como visibilidad para coordinarse, nunca como candado. Se
--     llama desde DataEntry.jsx:3455.
--
-- Con `is_admin()` las dos quedarían vivas solo para quien no las usa. Sería
-- cambiar una fuga chica por un bug de producto.
--
-- ── LO QUE SÍ FALTABA ───────────────────────────────────────────────────
-- Las dos gatean por UN eje —`require_country_access`— y les falta el otro. Hoy
-- cualquier autenticado con el país entra, incluido un rol con
-- `{"sections": [], "countries": ["Peru"]}`: alguien a quien no se le dio NINGUNA
-- pantalla igual puede preguntar por PostgREST a qué hora trabajó un compañero
-- una ciudad, o quién está conectado y dónde.
--
-- El criterio del repo para eso ya está escrito (CLAUDE.md §3): una RPC llamada
-- desde una pantalla va por `can_access_section('<sección>')`, y la sección de
-- las dos es `dataentry` (App.jsx:38). `can_access_section` cortocircuita en
-- `is_admin()`, así que Monitoreo —que es adminOnly— sigue pasando si alguna vez
-- las llama.
--
-- Queda deliberadamente afuera del cierre: un hub CON la sección `dataentry` y
-- el país sigue viendo los timings y la presencia de sus compañeros del mismo
-- país. Eso es el equipo mirando su propio turno, es lo que Monitoreo ya muestra,
-- y es la premisa de las dos features.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.get_ci_session_turno_timings(
  p_country text, p_city text, p_zone text, p_observed_date date
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  -- LOS DOS EJES: la sección dice quién puede pedir esto, el país sobre cuál.
  IF NOT can_access_section('dataentry') THEN
    RAISE EXCEPTION 'access_denied: leer los tiempos de un turno requiere la sección Ingresar CI'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

  SELECT turno_timings INTO v_result
  FROM ci_sessions
  WHERE country = p_country
    AND city = p_city
    AND COALESCE(NULLIF(zone, ''), '') = COALESCE(NULLIF(p_zone, ''), '')
    AND observed_date = p_observed_date
    AND turno_timings IS NOT NULL
  ORDER BY started_at DESC
  LIMIT 1;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_active_sessions_presence(p_country text)
 RETURNS TABLE(user_email text, city text, zone text, scope_label text, last_seen_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT can_access_section('dataentry') THEN
    RAISE EXCEPTION 'access_denied: ver quién está trabajando requiere la sección Ingresar CI'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

  RETURN QUERY
  -- Sesiones CON lista de frentes (mig 161 en adelante): una fila por frente.
  SELECT
    cas.user_email,
    (f->>'city')::text,
    NULLIF(f->>'zone', '')::text,
    cas.scope_label,
    cas.last_seen_at
  FROM ci_active_sessions cas
  CROSS JOIN LATERAL jsonb_array_elements(cas.fronts) AS f
  WHERE cas.country = p_country
    AND cas.user_email <> auth.email()
    AND cas.last_seen_at > now() - interval '3 minutes'
    AND cas.fronts IS NOT NULL
    AND jsonb_typeof(cas.fronts) = 'array'
    AND f->>'city' IS NOT NULL
    -- Solo los frentes que el hub está USANDO de verdad: donde está parado
    -- ahora, donde ya escribió algo, o donde no sabemos cuánto lleva
    -- (filled null tras un refresh: el frente está en la lista porque lo
    -- declaró o lo tocó, así que sí es suyo). Se excluye únicamente el caso
    -- que sabemos vacío y no es el actual — un punto declarado de antemano
    -- pero todavía sin empezar NO debe encender el puntito verde, porque el
    -- tooltip dice "está trabajando acá ahora" y sería falso: otro hub se
    -- iría a otra cosa creyendo que ese frente ya está tomado.
    AND (
      (f->>'current')::boolean IS TRUE
      OR f->>'filled' IS NULL
      OR (f->>'filled')::int > 0
    )

  UNION

  -- Retrocompatible: sesiones sin `fronts` (cliente viejo, o latido anterior
  -- a esta migración) siguen reportando solo su vista actual, como siempre.
  SELECT
    cas.user_email,
    cas.city,
    cas.zone,
    cas.scope_label,
    cas.last_seen_at
  FROM ci_active_sessions cas
  WHERE cas.country = p_country
    AND cas.user_email <> auth.email()
    AND cas.last_seen_at > now() - interval '3 minutes'
    AND (cas.fronts IS NULL OR jsonb_typeof(cas.fronts) <> 'array');
END;
$function$;

-- Sin EXECUTE para anon: son de pantalla logueada (mismo criterio que la 200).
REVOKE ALL ON FUNCTION public.get_ci_session_turno_timings(text, text, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ci_session_turno_timings(text, text, text, date) TO authenticated;
REVOKE ALL ON FUNCTION public.get_active_sessions_presence(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_active_sessions_presence(text) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- B · `anon` TIENE INSERT/UPDATE/DELETE SOBRE 30 TABLAS
-- ════════════════════════════════════════════════════════════════════════
--
-- Medido en la base, no deducido:
--
--   SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
--   WHERE n.nspname='public' AND c.relkind IN ('r','v','m','p')
--     AND EXISTS (SELECT 1 FROM aclexplode(c.relacl) x
--                 WHERE x.grantee='anon'::regrole AND x.privilege_type <> 'SELECT');
--   → 30 filas, todas con DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
--
-- Entre ellas `roles` y `user_profiles`, que es donde vive quién puede qué.
--
-- Herencia del `ALTER DEFAULT PRIVILEGES` histórico de Supabase para objetos
-- creados por `supabase_admin` (el default de objetos creados por `postgres`
-- —o sea, por las migraciones— ya está cerrado y NO concede nada a anon).
--
-- ── ¿ESTÁ EXPLOTADO HOY? NO. ¿ALCANZA CON ESO? TAMPOCO ─────────────────
-- Se verificó: hay UNA sola política que alcanza a `anon`
-- (`user_filter_presets`, `FOR ALL TO public`), y filtra por `auth.uid()`, que
-- para anon es NULL — o sea que ninguna escritura anónima pasa hoy.
--
-- Pero CLAUDE.md §3 es explícito: "RLS y GRANT son controles complementarios, no
-- alternativos — el permiso se evalúa ANTES que la política, así que una tabla
-- con RLS impecable y un grant amplio sigue estando abierta". Toda la protección
-- descansa hoy en que nadie escriba una política laxa, y este repo ya tuvo fugas
-- de RLS reales en tres rondas de migraciones (60-66, 130, 164-165). Esto es
-- sacar el segundo control de "confiemos en el primero".
--
-- ── POR QUÉ NO SE TOCA `authenticated` ─────────────────────────────────
-- Tentador y equivocado. El modelo genérico de permisos (migs 187/192) decide
-- quién escribe qué con RLS + `section_write_grants`, NO con GRANT: el grant a
-- `authenticated` es el piso que esas políticas necesitan para poder evaluarse.
-- Recortarlo por tabla rompería el modelo entero y volvería a poner los permisos
-- en migraciones, que es justo lo que las 187/192 vinieron a eliminar.
--
-- Se saca solo la escritura; el SELECT de `anon` queda como está (es lo que
-- necesita el cliente antes del login y lo que RLS ya filtra).
-- ════════════════════════════════════════════════════════════════════════

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public FROM anon;

-- MAINTAIN (VACUUM/ANALYZE/REFRESH MATERIALIZED VIEW/REINDEX/CLUSTER) existe
-- recién desde Postgres 17. La primera versión de esta migración lo omitió y la
-- verificación lo cazó: quedaban 29 tablas con MAINTAIN para `anon`, o sea que
-- un anónimo podía disparar un REFRESH de las MV del dashboard — no lee datos,
-- pero es I/O gratis contra la base a pedido de cualquiera con la clave pública.
--
-- Va en dinámico porque local corre 17.6 y escribirlo fijo haría fallar la
-- migración con un error de sintaxis en cualquier instancia todavía en 15/16.
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON ALL TABLES IN SCHEMA public FROM anon';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE MAINTAIN ON TABLES FROM anon';
  END IF;
END $$;

-- Las secuencias iban por su cuenta: `anon` tenía USAGE y UPDATE sobre los
-- `*_id_seq`, o sea nextval/setval. Sin INSERT no sirve para escribir, pero
-- setval sobre una secuencia de identidad es corrupción de datos a un paso.
REVOKE USAGE, UPDATE, SELECT ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- Y hacia adelante, para lo que cree `supabase_admin` (las migraciones corren
-- como `postgres`, cuyo default ya está cerrado — esto cubre el otro dueño).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE USAGE, UPDATE, SELECT ON SEQUENCES FROM anon;

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- 1) Ninguna tabla con escritura para anon:
--      SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
--      WHERE n.nspname='public' AND c.relkind IN ('r','v','m','p')
--        AND EXISTS (SELECT 1 FROM aclexplode(c.relacl) x
--                    WHERE x.grantee='anon'::regrole AND x.privilege_type <> 'SELECT');
--      → 0
--
-- 2) Con SET LOCAL ROLE authenticated y claims de {"sections":[],"countries":["Peru"]}:
--      get_ci_session_turno_timings('Peru', …)  → access_denied (42501)
--      get_active_sessions_presence('Peru')     → access_denied (42501)
--
-- 3) Con {"sections":["dataentry"],"countries":["Peru"]}:
--      las dos devuelven datos de Perú, y siguen dando access_denied para Colombia.
--
-- 4) Con un admin: las dos funcionan en cualquier país (can_access_section
--    cortocircuita en is_admin).
--
-- 5) El flujo del hub entero sigue vivo: save_ci_batch → close_ci_session.
