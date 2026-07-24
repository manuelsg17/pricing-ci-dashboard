-- ════════════════════════════════════════════════════════════════════════
-- 161_ci_session_fronts.sql — Monitoreo/presencia ven TODOS los frentes
-- abiertos de un hub, no solo la pestaña donde está parado.
--
-- Pedido del user (2026-07-24): "el monitoreo debe mostrar todos los frentes
-- abiertos de un hub a la vez... así yo sé quién está avanzando qué cosas y
-- los otros hubs también lo saben. Pero debería mostrarme siempre en dónde
-- está ahora mismo avanzando".
--
-- POR QUÉ: desde que se liberó la navegación entre pestañas dentro de una
-- misma sesión (commit 3f12e90), "una sesión = una ciudad" dejó de ser
-- cierto, pero el latido siguió mandando SOLO la vista actual. Consecuencias
-- reales:
--   - Monitoreo mostraba al hub en Corp mientras sus Puntos A y B seguían a
--     medias: los frentes pendientes eran invisibles del lado servidor.
--   - La presencia (mig 152), que existe para que dos hubs no se pisen, solo
--     lo mostraba en su última pestaña — otro hub entrando al Punto A no lo
--     veía y podían duplicar trabajo.
--
-- SOLUCIÓN: una columna `fronts` jsonb con la lista completa de frentes
-- abiertos, marcando cuál es el actual. Aditivo: `city`/`zone` siguen siendo
-- la vista actual (todos los consumidores existentes siguen funcionando
-- igual), y `fronts` es NULL para sesiones viejas o clientes sin actualizar.
--
-- Forma de cada elemento (la arma src/lib/sessionFronts.js):
--   {"bucket":"Lima_Airport_A","city":"Lima_Airport_A","zone":null,
--    "filled":12,"total":324,"current":true}
-- `total` puede ser null = "el cliente todavía no sabe el total de ese
-- frente" (solo conoce el de las vistas que el hub ya visitó). Monitoreo
-- debe mostrarlo como desconocido, NUNCA como 0.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.ci_active_sessions
  ADD COLUMN IF NOT EXISTS fronts jsonb;

COMMENT ON COLUMN public.ci_active_sessions.fronts IS
  'Frentes abiertos del hub en esta sesión: [{bucket, city, zone, filled, total, current}]. `city`/`zone` de la tabla siguen siendo la vista ACTUAL (retrocompatible); acá está la lista completa. total=null significa desconocido, no 0. NULL en sesiones previas a la mig 161.';

-- ── Latido: acepta la lista de frentes ──────────────────────────────────
-- DROP obligatorio: agregar un parámetro NO reemplaza la función, crea un
-- OVERLOAD. Con las dos firmas vivas, PostgREST no puede resolver la llamada
-- y devuelve PGRST203 ("could not choose the best candidate function") — el
-- latido se rompe en silencio (es best-effort) para cualquier hub que tenga
-- la pestaña abierta con el bundle viejo, que es el caso normal durante un
-- deploy. Justo el escenario que esta migración viene a evitar. Mismo patrón
-- que ya usaron las migs 150 y 151 al extender esta misma función.
DROP FUNCTION IF EXISTS public.upsert_ci_active_session(
  text, text, text, date, int, int, int, jsonb, text
);

CREATE OR REPLACE FUNCTION public.upsert_ci_active_session(
  p_country text, p_city text, p_zone text, p_observed_date date,
  p_filled_count integer, p_total_expected integer,
  p_recent_failures integer DEFAULT 0,
  p_turno_progress jsonb DEFAULT NULL::jsonb,
  p_scope_label text DEFAULT NULL::text,
  p_fronts jsonb DEFAULT NULL::jsonb
)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email text := auth.email();
BEGIN
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'no_session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Ver mig 156: sin este gate, alguien con acceso solo al país X podía
  -- mandar un latido falso para el país Y y aparecer como presencia real.
  PERFORM require_country_access(p_country);

  -- Defensa: `fronts` viene del cliente y se expone a OTROS hubs vía
  -- get_active_sessions_presence. Si no es un array JSON, se guarda NULL en
  -- vez de propagar basura a la expansión de presencia de abajo.
  IF p_fronts IS NOT NULL AND jsonb_typeof(p_fronts) <> 'array' THEN
    p_fronts := NULL;
  END IF;
  -- Tope también del lado servidor: el MAX_FRONTS del cliente
  -- (src/lib/sessionFronts.js) no es una garantía — un cliente manipulado
  -- podría mandar un array enorme, y la presencia lo expande con
  -- jsonb_array_elements en CADA poll de CADA hub del país (~20s).
  IF p_fronts IS NOT NULL AND jsonb_array_length(p_fronts) > 20 THEN
    p_fronts := NULL;
  END IF;

  INSERT INTO ci_active_sessions (
    user_email, country, city, zone, observed_date,
    filled_count, total_expected, recent_failures, turno_progress, scope_label,
    fronts, started_at, last_seen_at
  ) VALUES (
    v_email, p_country, p_city, p_zone, p_observed_date,
    p_filled_count, p_total_expected, p_recent_failures, p_turno_progress, p_scope_label,
    p_fronts, now(), now()
  )
  ON CONFLICT (user_email) DO UPDATE SET
    country         = EXCLUDED.country,
    city            = EXCLUDED.city,
    zone            = EXCLUDED.zone,
    observed_date   = EXCLUDED.observed_date,
    filled_count    = EXCLUDED.filled_count,
    total_expected  = EXCLUDED.total_expected,
    recent_failures = EXCLUDED.recent_failures,
    turno_progress  = EXCLUDED.turno_progress,
    scope_label     = EXCLUDED.scope_label,
    fronts          = EXCLUDED.fronts,
    last_seen_at    = now();
    -- started_at deliberadamente FUERA del SET (ver mig 146).
END;
$function$;

-- ── Presencia: una fila por FRENTE, no por hub ──────────────────────────
-- Misma firma de salida que antes (no rompe al cliente, que filtra por
-- city+zone): lo que cambia es que un hub con 3 frentes abiertos ahora
-- devuelve 3 filas en vez de 1, así el puntito verde aparece en TODOS los
-- lugares donde está trabajando y no solo en el último que tocó.
CREATE OR REPLACE FUNCTION public.get_active_sessions_presence(p_country text)
 RETURNS TABLE(user_email text, city text, zone text, scope_label text, last_seen_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
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
