-- ════════════════════════════════════════════════════════════════════════
-- 192_complete_section_write_map.sql — el mapa deja de tener puntos ciegos.
--
-- QUÉ FALLA HOY, después de las migs 187/188
-- El modelo genérico funciona, pero `section_write_grants` se sembró A MANO y
-- quedó INCOMPLETO: solo declara las secciones cuyas tablas se gatean por
-- can_write_table(). Las demás escrituras de la app — Proyectos, Ingresar CI,
-- Data Raw, Cargar Data, Accesos — no figuran en ningún lado.
--
-- Un mapa incompleto no es documentación floja: es el bug original disfrazado.
--   · Nadie puede responder "¿qué va a poder escribir este rol?" mirando una
--     sola cosa. La pantalla de Accesos tampoco, porque lee de acá.
--   · Un chequeo automático que compare app ↔ mapa no puede distinguir
--     "esta tabla se olvidó" de "esta tabla se gatea por dueño a propósito":
--     o reporta huecos falsos, o se acostumbra a ignorarlos y deja pasar el
--     verdadero. Un checker con ruido es un checker apagado.
--
-- ADEMÁS, un filo peligroso del diseño actual: la 187 dejó `access` FUERA del
-- mapa para evitar escalación de privilegios. Correcto, pero la protección es
-- una AUSENCIA — y una ausencia no se defiende sola. Hoy un admin que agregue
-- de buena fe la fila ('mi_seccion','roles') creería estar concediendo un
-- permiso más; en cuanto alguna política de `roles` pasara al patrón genérico,
-- estaría regalando la capacidad de auto-promoverse. La regla "estas tablas
-- NUNCA se conceden por sección" tiene que estar ESCRITA, no implícita.
--
-- LA SOLUCIÓN: columna `gate`, que declara CÓMO se gatea cada escritura.
--
--   'section' — la política RLS llama can_write_table(): tener la sección
--               concede la escritura. Es el caso de las migs 187/188.
--   'owner'   — la política gatea por DUEÑO (+país). Tener la sección no
--               alcanza ni hace falta: el criterio es "es tuyo". Declararlo
--               deja constancia de que la tabla se escribe desde esa pantalla
--               y de que el permiso vive en otro lado, a propósito.
--   'admin'   — solo admin, por diseño. Escalación de privilegios
--               (`roles`, `user_profiles`) o acción administrativa
--               (`projects`, `project_tasks`, mig 183 §17.2).
--
-- can_write_table() pasa a mirar SOLO las filas 'section'. Eso convierte la
-- protección de `access` en algo declarado y activo: la fila
-- ('access','roles','admin') existe, es visible en la pantalla de Accesos, y
-- NO concede nada. Agregar filas al mapa deja de poder abrir un agujero por
-- accidente — que es justo lo que uno quiere de una tabla pensada para
-- editarse sin migración.
--
-- Se acompaña de `npm run check:section-grants`, que camina el grafo de
-- imports desde cada ruta de App.jsx y falla si la app escribe algo que este
-- mapa no declara. El mapa deja de depender de que alguien se acuerde.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Columna `gate` ─────────────────────────────────────────────────
ALTER TABLE public.section_write_grants
  ADD COLUMN IF NOT EXISTS gate text NOT NULL DEFAULT 'section';

-- Las 22 filas de la 187 son todas del patrón genérico: el DEFAULT ya las
-- deja correctas. Se explicita igual por si esta migración corre sobre una
-- base donde alguien agregó filas a mano antes.
UPDATE public.section_write_grants SET gate = 'section' WHERE gate IS NULL;

ALTER TABLE public.section_write_grants
  DROP CONSTRAINT IF EXISTS section_write_grants_gate_chk;
ALTER TABLE public.section_write_grants
  ADD CONSTRAINT section_write_grants_gate_chk
  CHECK (gate IN ('section', 'owner', 'admin'));

COMMENT ON COLUMN public.section_write_grants.gate IS
  'Cómo se gatea esta escritura. section = can_write_table() (tener la sección '
  'alcanza). owner = la política filtra por dueño (+país); la sección no es el '
  'criterio. admin = solo admin por diseño. can_write_table() SOLO considera '
  'las filas ''section'' — por eso agregar una fila ''admin'' u ''owner'' '
  'documenta sin conceder.';

-- ── 2. can_write_table() respeta el gate ──────────────────────────────
-- Misma firma que la 187, así que CREATE OR REPLACE alcanza y no crea un
-- overload (CLAUDE.md §3: cambiar parámetros SÍ habría exigido DROP).
CREATE OR REPLACE FUNCTION public.can_write_table(p_table text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT is_admin() OR EXISTS (
    SELECT 1
    FROM public.user_profiles up
    JOIN public.roles r ON r.id = up.role_id
    JOIN public.section_write_grants g ON g.table_name = p_table
    WHERE up.email = (select auth.email())
      AND up.is_active = true
      AND g.gate = 'section'          -- ← 'owner'/'admin' documentan, no conceden
      AND (
        r.permissions->'sections' ? g.section OR
        r.permissions->'sections' ? 'all'
      )
  );
$$;

COMMENT ON FUNCTION public.can_write_table(text) IS
  '¿El rol del usuario actual puede escribir esta tabla? (migs 187/192). '
  'Genérica: no nombra roles ni secciones, resuelve contra section_write_grants '
  'y roles.permissions. Solo cuentan las filas con gate=''section''. Admin siempre puede.';

-- ── 3. Filas que faltaban ─────────────────────────────────────────────
-- Salidas de `npm run check:section-grants`, que las encontró caminando el
-- grafo de imports de cada ruta — no de una lectura a ojo.

INSERT INTO public.section_write_grants (section, table_name, gate, note) VALUES

  -- Proyectos (migs 183/184). El hub NO escribe directo: la RLS es solo-admin
  -- a propósito, porque una política no puede restringir por COLUMNA y con
  -- UPDATE abierto el hub podría cambiar título, fechas o dueño por API aunque
  -- la UI solo le muestre el botón de estado. El hub escribe por las RPCs
  -- set_task_status/add_task_comment, que validan país Y dueño.
  ('projects', 'projects',         'admin', 'Alta/edición de proyectos: solo admin (mig 183 §17.2).'),
  ('projects', 'project_tasks',    'admin', 'Alta/edición de tareas: solo admin. El hub cambia estado por RPC.'),
  ('projects', 'task_comments',    'admin', 'Bitácora. Se escribe por RPC; RLS directa solo-admin.'),
  ('projects', 'task_status_log',  'admin', 'Bitácora de estados. Idem task_comments.'),
  ('projects', 'section_last_seen','owner', '"Qué hay nuevo desde tu última visita": cada uno la suya.'),

  -- Accesos. La 187 lo dejaba fuera del mapa; ahora está DENTRO y declarado
  -- como no-concedible. La protección deja de ser una ausencia.
  ('access', 'roles',         'admin', 'ESCALACIÓN: quien escriba roles se concede cualquier permiso. Nunca por sección.'),
  ('access', 'user_profiles', 'admin', 'ESCALACIÓN: permite auto-promoverse cambiando role_id. Nunca por sección.'),

  -- Ingresar CI / Data Raw / Cargar Data. pricing_observations mantiene su
  -- lógica de país + dueño EN LÍNEA por rendimiento (migs 175/176: SELECT de
  -- 16,5s → 39-60ms sobre 1,6M+ filas). Meterla en el patrón genérico
  -- reintroduce el costo por fila. Se declara para que el mapa esté completo.
  ('dataentry', 'pricing_observations', 'owner', 'País + uploaded_by en línea (migs 175/176/170). No uniformar: rendimiento.'),
  ('dataentry', 'ci_sessions',          'owner', 'Sesión de CI del propio hub (user_email).'),
  ('dataentry', 'ci_active_sessions',   'owner', 'Latido de sesión en curso del propio hub.'),
  ('rawdata',   'pricing_observations', 'owner', 'Edición/borrado inline: país + dueño de la fila.'),
  ('upload',    'pricing_observations', 'owner', 'Carga manual: país + dueño.'),

  -- Presets de filtros: los escriben las tres pantallas que filtran.
  ('dashboard', 'user_filter_presets', 'owner', 'Preset del propio usuario (auth.uid()).'),
  ('market',    'user_filter_presets', 'owner', 'Idem — la misma pantalla de filtros.'),
  ('coverage',  'user_filter_presets', 'owner', 'Idem.')

ON CONFLICT (section, table_name) DO UPDATE
  SET gate = EXCLUDED.gate,
      note = EXCLUDED.note;

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- 1) El mapa cubre TODO lo que la app escribe (camina el grafo de imports):
--      npm run check:section-grants      → "Sin drift"
--
-- 2) Las filas 'admin'/'owner' NO conceden nada. Un rol con sections=['access']
--    sigue sin poder escribir `roles` — ahora con la fila presente en el mapa,
--    que es el caso que antes NO se probaba porque la fila no existía:
--      npm run simulate:permissions      → aserciones 5 y 13
--
-- 3) El gate quedó restringido a los tres valores:
--    SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--     WHERE conrelid='public.section_write_grants'::regclass AND contype='c';
--
-- 4) can_write_table() sigue con search_path fijado y sin EXECUTE para anon:
--    SELECT proconfig FROM pg_proc WHERE proname='can_write_table';
--    SELECT has_function_privilege('anon','can_write_table(text)','EXECUTE');  → f
--
-- 5) Sin drift de políticas (esta migración no toca ninguna, debe seguir en 0):
--      npm run check:rls-drift           → 0 filas
