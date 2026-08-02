-- ════════════════════════════════════════════════════════════════════════
-- 202_with_check_dueno_y_pais.sql — tres políticas de INSERT que validan
-- menos de lo que su tabla necesita.
--
-- ⚠️  NO APLICADA. Requiere autorización explícita del user (CLAUDE.md §3).
--
-- Son PREEXISTENTES (migs 24500 y 25700), no las introdujo el trabajo de esta
-- semana. Las tres se reprodujeron ejecutando el INSERT como `authenticated`
-- con jwt claims de un hub cuyo rol solo tiene Perú.
--
-- El patrón es siempre el mismo y es el que CLAUDE.md §3 describe: `USING`
-- filtra lo que ya existe, `WITH CHECK` valida el estado NUEVO. Cuando el
-- `WITH CHECK` mira menos ejes que la tabla, el gate de la RPC se vuelve
-- decorativo: PostgREST expone la tabla y se entra por al lado.
--
-- ── 1 · pricing_observations · falsificar el DUEÑO ──────────────────────
-- `pricing_observations_insert` valida el país y nada más. Reproducido:
--
--   INSERT INTO pricing_observations (…, uploaded_by) VALUES (…, 'VICTIMA@otro.test');
--   → PASÓ. filas_firmadas_a_nombre_ajeno = 1
--
-- Un hub firma observaciones a nombre de otro. Rompe la atribución de trabajo
-- (Monitoreo agrupa por `uploaded_by`), y las filas quedan fuera del DELETE
-- del atacante pero también del dueño real, porque el guardado idempotente
-- borra por dueño: basura con firma ajena que el dueño no puede limpiar.
--
-- El fix acepta `uploaded_by IS NULL` a propósito: Upload inserta así para el
-- bot y el histórico legacy. El único lugar que setea el campo es
-- `src/pages/DataEntry.jsx` con `uploaded_by: userEmail`.
--
-- ── 2 · ci_sessions · fabricar minutos en OTRO país ─────────────────────
-- `ci_sessions_insert` valida el dueño y nada más. Reproducido: un hub de Perú
-- insertó una sesión de Colombia con 240 minutos y `duration_confiable = true`.
-- Después aparece en `ci_hub_daily_minutes('Colombia', …)` como productividad
-- real. Es inyección directa en el reporte que se usa para gestionar gente.
--
-- La mig 201 le puso `require_country_access` a `close_ci_session`, pero eso
-- solo cierra la RPC: la tabla seguía abierta.
--
-- ── 3 · ci_active_sessions · presencia falsa en OTRO país ───────────────
-- Mismo patrón. `upsert_ci_active_session` SÍ tiene el gate —la mig 156 lo
-- agregó con el comentario "sin este gate, alguien con acceso solo al país X
-- podía mandar un latido falso para el país Y"— pero la política no lo repite.
-- Reproducido: el hub de Perú publicó un latido en Bogotá y aparece en el
-- panel de presencia de los admins de Colombia.
--
-- NOTA DE ESTILO (CLAUDE.md §3): `DROP POLICY IF EXISTS` explícito antes de
-- `CREATE POLICY`. Nunca asumir que la nueva "gana": las permisivas se
-- combinan con OR y la vieja laxa sobrevive en silencio.
--
-- ── UNA DIFERENCIA QUE SE VERIFICÓ, NO SE ASUMIÓ ───────────────────────
-- La política de INSERT de `pricing_observations` en producción trae el
-- predicado de país ESCRITO A MANO (un `country IN (SELECT
-- jsonb_array_elements_text(…))` más un EXISTS para `'all'`), no la función.
-- Acá se reemplaza por `can_access_country(country)`, y las dos NO son
-- idénticas: la función abre con `p_country IS NOT NULL AND (…)`, así que
-- devuelve false para country NULL incluso siendo admin, mientras que el
-- predicado inline lo dejaba pasar por la rama `is_admin()`.
--
-- Se comprobó contra producción antes de escribir esto:
--
--   pricing_observations.country  → NOT NULL, 0 filas nulas
--   ci_sessions.country           → NOT NULL, 0 filas nulas
--   ci_active_sessions.country    → NOT NULL, 0 filas nulas
--
-- El NOT NULL de la columna hace la diferencia inalcanzable: no existe un
-- INSERT válido con country NULL que la política nueva pudiera rechazar y la
-- vieja aceptara. En todo lo demás son equivalentes (`IN` sobre el array vs
-- `?` sobre el jsonb, y el mismo `is_admin()` de escape).
--
-- Si mañana alguien afloja ese NOT NULL, esta equivalencia deja de valer.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1 · El dueño de una observación no se puede falsificar ──────────────
DROP POLICY IF EXISTS pricing_observations_insert ON public.pricing_observations;
CREATE POLICY pricing_observations_insert
  ON public.pricing_observations
  FOR INSERT TO authenticated
  WITH CHECK (
    can_access_country(country)
    AND (
      (select is_admin())
      -- NULL sigue permitido: es como entran el bot y el upload masivo.
      OR uploaded_by IS NULL
      OR uploaded_by = (select auth.email())
    )
  );

-- ── 2 · Una sesión no se puede cerrar en un país ajeno ──────────────────
DROP POLICY IF EXISTS ci_sessions_insert ON public.ci_sessions;
CREATE POLICY ci_sessions_insert
  ON public.ci_sessions
  FOR INSERT TO authenticated
  WITH CHECK (
    ((user_email = (select auth.email())) OR (select is_admin()))
    AND can_access_country(country)
  );

-- ── 3 · Un latido no se puede publicar en un país ajeno ─────────────────
DROP POLICY IF EXISTS ci_active_sessions_insert ON public.ci_active_sessions;
CREATE POLICY ci_active_sessions_insert
  ON public.ci_active_sessions
  FOR INSERT TO authenticated
  WITH CHECK (
    ((user_email = (select auth.email())) OR (select is_admin()))
    AND can_access_country(country)
  );

-- El UPDATE del latido (upsert con merge-duplicates) necesita el mismo criterio:
-- sin WITH CHECK, una fila propia se podía MOVER a otro país después de creada.
DROP POLICY IF EXISTS ci_active_sessions_update ON public.ci_active_sessions;
CREATE POLICY ci_active_sessions_update
  ON public.ci_active_sessions
  FOR UPDATE TO authenticated
  USING      (((user_email = (select auth.email())) OR (select is_admin())) AND can_access_country(country))
  WITH CHECK (((user_email = (select auth.email())) OR (select is_admin())) AND can_access_country(country));

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- Como un hub con countries=["Peru"], SET LOCAL ROLE authenticated:
--   1) INSERT en pricing_observations con uploaded_by ajeno → violates RLS
--   2) INSERT en pricing_observations con el propio email   → pasa
--   3) INSERT en pricing_observations con uploaded_by NULL  → pasa (bot/upload)
--   4) INSERT en ci_sessions con country='Colombia'         → violates RLS
--   5) INSERT en ci_sessions con country='Peru'             → pasa
--   6) INSERT en ci_active_sessions con country='Colombia'  → violates RLS
--   7) El flujo normal del hub (save_ci_batch + close_ci_session) sigue igual.
--
-- Y sin drift:
--   SELECT tablename, cmd, count(*) FROM pg_policies WHERE schemaname='public'
--    GROUP BY 1,2 HAVING count(*) > 1;   → sin filas nuevas
--
-- ⚠️ OJO CON EL DETECTOR: `scripts/check-rls-policy-drift.sql` agrupaba por
-- (tablename, cmd) y una política `FOR ALL` nunca agrupa con las de comando
-- puntual — o sea que era ciego justo a la forma de drift de las migs 60-66.
-- Se corrige en el mismo cambio (ver el script).
