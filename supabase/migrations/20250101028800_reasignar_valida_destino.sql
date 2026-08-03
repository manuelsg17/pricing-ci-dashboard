-- ════════════════════════════════════════════════════════════════════════
-- 207 — reasignar una sesión a un email que no existe deja el trabajo huérfano.
--
-- ⚠️  NO APLICADA A PRODUCCIÓN. Requiere autorización explícita del user para
--     ESTA migración puntual (CLAUDE.md §3).
--
-- EL PROBLEMA
-- `admin_reassign_ci_session` (mig 160) toma `p_to_email` como texto libre y lo
-- escribe directo en `pricing_observations.uploaded_by`. La UI lo pide con un
-- <input> sin validar (UnfinishedSessionsPanel.jsx:87: `.trim()` y nada más).
--
-- Un typo —'jaun@yango.com', 'juan@yango.con', un espacio de más que el trim no
-- agarra porque está en el medio— no falla: la RPC encuentra las filas de
-- ORIGEN, las reasigna, y devuelve éxito. A partir de ahí esas filas no las
-- carga NADIE:
--
--   · el auto-load del hub filtra `uploaded_by = self` (mig 139), y ese self no
--     existe;
--   · el hub original ya no las tiene, porque se le quitaron;
--   · y el guardado idempotente borra por dueño, así que tampoco se pisan solas.
--
-- Son ~108 filas por turno que quedan en la tabla, cuentan en los agregados, y
-- ningún hub puede volver a editarlas. La UI ya avisó "listo".
--
-- ── POR QUÉ VA EN LA BASE Y NO EN EL FORMULARIO ────────────────────────
-- CLAUDE.md §3: "Validar toda entrada en el límite del servidor, no solo en el
-- formulario". Un regex de email en el <input> no arregla nada acá — el
-- problema no es la FORMA del string sino que apunte a una persona real con
-- acceso a ese país. Eso solo se puede contestar contra `user_profiles`.
--
-- ── LOS DOS CHEQUEOS ───────────────────────────────────────────────────
--  1. El destino existe y está activo. `is_active = false` cuenta como no
--     existe: reasignarle trabajo a alguien dado de baja es el mismo huérfano
--     con otro nombre.
--  2. El destino tiene acceso al país. Sin esto se puede mandar el turno de
--     Lima a un hub que solo tiene Colombia: técnicamente tiene dueño, en la
--     práctica nadie lo va a poder abrir. Se replica el predicado de
--     `can_access_country` pero por EMAIL en vez de por `auth.email()` — la
--     función original mira al usuario de la sesión, y acá el que importa es
--     el destinatario, no el admin que aprieta el botón.
--
-- Se conserva TODO lo demás igual: el gate de admin, el `require_country_access`
-- del que ejecuta, el cierre previo de la sesión de origen y el
-- `nothing_to_reassign` cuando no hay filas.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_reassign_ci_session(
  p_country text, p_city text, p_zone text, p_observed_date date,
  p_from_email text, p_to_email text
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rows_reassigned bigint;
  v_destino_ok      boolean;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'access_denied: reasignar sesiones es solo para admin'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

  IF p_from_email = p_to_email THEN
    RAISE EXCEPTION 'invalid_input: el hub origen y destino no pueden ser el mismo';
  END IF;

  -- ── El destino tiene que ser alguien que pueda recibir esto ──────────
  -- `btrim` acá y no en el cliente: la validación tiene que valer para
  -- cualquiera que llame la RPC, no solo para el que pasa por el formulario.
  p_to_email := btrim(coalesce(p_to_email, ''));
  IF p_to_email = '' THEN
    RAISE EXCEPTION 'invalid_input: falta el email del hub destino';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM user_profiles up
    JOIN roles r ON r.id = up.role_id
    WHERE lower(up.email) = lower(p_to_email)
      AND up.is_active = true
      AND (
        r.name = 'admin'
        OR r.permissions->'countries' ? p_country
        OR r.permissions->'countries' ? 'all'
      )
  ) INTO v_destino_ok;

  IF NOT v_destino_ok THEN
    -- Mensaje deliberadamente ambiguo entre "no existe" y "no tiene el país":
    -- distinguirlos le confirmaría a quien pregunta qué emails están dados de
    -- alta. Lo ve solo un admin, pero el hábito se mantiene (CLAUDE.md §3).
    RAISE EXCEPTION 'invalid_input: % no es un hub activo con acceso a %', p_to_email, p_country
      USING HINT = 'Verificá el email en Accesos y que el rol tenga ese país.';
  END IF;

  -- El email se persiste como está en user_profiles, no como lo tipeó el admin:
  -- si escribió 'Juan@Yango.com' y el perfil dice 'juan@yango.com', guardar la
  -- versión tipeada rompería el `uploaded_by = self` del auto-load, que compara
  -- exacto. Es el mismo huérfano que esta migración vino a cerrar, por casing.
  SELECT up.email INTO p_to_email
  FROM user_profiles up WHERE lower(up.email) = lower(p_to_email) AND up.is_active LIMIT 1;

  -- Cerrar primero la sesión activa de origen (si existe) — deja su rastro
  -- de tiempo/filas en ci_sessions ANTES de reasignar filas, mismo criterio
  -- que un cierre administrativo normal (mig 157/159): si no se hace acá,
  -- el tiempo parcial de Hub A en el turno que estaba trabajando se pierde.
  IF EXISTS (
    SELECT 1 FROM ci_active_sessions
    WHERE user_email = p_from_email
      AND country = p_country
      AND city = p_city
      AND COALESCE(NULLIF(zone, ''), '') = COALESCE(NULLIF(p_zone, ''), '')
      AND observed_date = p_observed_date
  ) THEN
    PERFORM admin_close_ci_session(p_country, p_city, p_zone, p_observed_date, p_from_email);
  END IF;

  -- Reasignar las filas YA guardadas: de acá en más son "de" p_to_email, así
  -- que el próximo auto-load de Hub B (loadObservationsIntoForm, que SIEMPRE
  -- filtra por uploaded_by=self) las trae solas, sin duplicar nada al
  -- re-guardar.
  UPDATE pricing_observations
  SET uploaded_by = p_to_email
  WHERE country = p_country
    AND city = p_city
    AND COALESCE(NULLIF(zone, ''), '') = COALESCE(NULLIF(p_zone, ''), '')
    AND observed_date = p_observed_date
    AND uploaded_by = p_from_email
    AND data_source = 'manual';
  GET DIAGNOSTICS v_rows_reassigned = ROW_COUNT;

  IF v_rows_reassigned = 0 THEN
    RAISE EXCEPTION 'nothing_to_reassign: % no tiene filas guardadas en %/%/%/% para reasignar',
      p_from_email, p_country, p_city, p_zone, p_observed_date;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_reassign_ci_session(text, text, text, date, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reassign_ci_session(text, text, text, date, text, text)
  TO authenticated;

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- Como admin, con filas guardadas de un hub de Perú:
--   1) destino inexistente ('typo@nada.test')          → invalid_input
--   2) destino existente pero is_active = false        → invalid_input
--   3) destino existente sin acceso a Perú             → invalid_input
--   4) destino válido                                  → reasigna, uploaded_by cambia
--   5) destino válido escrito con otro casing          → uploaded_by queda con el
--                                                        casing de user_profiles
--   6) el hub original ya no ve esas filas y el destino sí
-- Como no-admin: access_denied, como antes.
