-- ════════════════════════════════════════════════════════════════════════
-- 214 — se puede asignar una tarea a alguien que NO puede abrir Proyectos,
--       y no hay error en ningún lado.
--
-- ⚠️  NO APLICADA A PRODUCCIÓN. Requiere autorización explícita del user para
--     ESTA migración puntual (CLAUDE.md §3).
--
-- ── EL AGUJERO ──────────────────────────────────────────────────────────
-- `assignable_users` (mig 184) filtra por PAÍS y nada más:
--
--     WHERE up.is_active AND can_access_country(p_country)
--       AND (r.permissions->'countries' ? p_country OR ... ? 'all')
--
-- Pero abrir la pantalla de Proyectos exige la sección `projects`
-- (App.jsx / Topbar.jsx filtran por `canAccess`). Los dos ejes existen y la
-- RPC mira uno solo.
--
-- Consecuencia medida: en producción hay 28 usuarios activos y **uno solo**
-- tiene la sección `projects`. Los 28 aparecen igual en el desplegable de
-- "Responsable". Se le asigna una tarea a cualquiera de los otros 27, la tarea
-- se crea bien, la RPC devuelve éxito, y esa persona **nunca la ve**: no tiene
-- la entrada en el menú. Sin error, sin aviso, sin nada que mirar.
--
-- Es el mismo "agujero negro" que PROYECTOS_DESIGN.md §15.2 quería matar,
-- entrando por la otra puerta: la mig 184 se cuidó del país y se olvidó de la
-- sección.
--
-- ── EL FIX ──────────────────────────────────────────────────────────────
-- Sumar el segundo eje. `can_access_section()` NO sirve acá: mira las secciones
-- de QUIEN LLAMA (`auth.email()`), y lo que hay que evaluar es si el CANDIDATO
-- las tiene. Se replica el predicado por email, igual que hizo la mig 207 con
-- `can_access_country` para validar el destino de una reasignación.
--
-- Se respetan las dos formas que ya usa `can_access_section`: la sección
-- explícita y el comodín `'all'`. Y el rol `admin` entra siempre, porque
-- `can_access_section` cortocircuita en `is_admin()` y la pantalla se le abre
-- aunque su rol no liste secciones.
--
-- ── LO QUE NO CAMBIA ────────────────────────────────────────────────────
-- El gate de quien PREGUNTA (`can_access_country(p_country)`) queda igual: esto
-- restringe a quién se puede elegir, no quién puede preguntar.
--
-- ── EFECTO PRÁCTICO HOY, DICHO CLARO ────────────────────────────────────
-- Con esta migración puesta y sin tocar los roles, el desplegable de
-- "Responsable" va a mostrar UNA sola persona (el admin) en vez de 28. Eso NO
-- es una regresión: es que hoy la lista miente. Para que el equipo aparezca hay
-- que darles la sección `projects` desde la pantalla de Accesos — que es un
-- cambio de DATOS, nunca una migración (CLAUDE.md §3).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.assignable_users(p_country text)
RETURNS TABLE (email text, role_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT up.email, r.name
  FROM user_profiles up
  JOIN roles r ON r.id = up.role_id
  WHERE up.is_active = true
    AND can_access_country(p_country)          -- quien pregunta debe tener el país
    AND (r.permissions->'countries' ? p_country
         OR r.permissions->'countries' ? 'all')
    -- 214 · el segundo eje: el candidato tiene que poder ABRIR Proyectos, o la
    -- tarea que se le asigne cae en un agujero negro. Se evalúa por email
    -- porque can_access_section() mira al que llama, no al candidato.
    AND (r.name = 'admin'
         OR r.permissions->'sections' ? 'projects'
         OR r.permissions->'sections' ? 'all')
  ORDER BY up.email;
$$;

COMMENT ON FUNCTION public.assignable_users(text) IS
  'Candidatos a responsable de una tarea. Filtra por los DOS ejes: el país y la '
  'sección projects (mig 214). Sin el segundo, se podía asignar a alguien que no '
  'puede abrir la pantalla y la tarea no la veía nadie.';

REVOKE ALL ON FUNCTION public.assignable_users(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assignable_users(text) TO authenticated;

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- `npm run simulate:assignable-users`, con SET LOCAL ROLE authenticated:
--   1) un candidato con el país pero SIN la sección  → NO aparece
--   2) con el país Y la sección                      → aparece
--   3) con sections:['all']                          → aparece
--   4) el rol admin                                  → aparece siempre
--   5) inactivo (is_active=false)                    → no aparece
--   6) de otro país                                  → no aparece
--   7) quien pregunta sin el país                    → lista vacía (sin cambios)
