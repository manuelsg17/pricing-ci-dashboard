-- ════════════════════════════════════════════════════════════════════════
-- 187_section_write_grants.sql — permisos de escritura genéricos.
--
-- Diseño completo: PERMISOS_DESIGN.md. Este archivo implementa los pasos 2 y
-- 3 de su "Orden sugerido" (la infraestructura); la 188 reemplaza las
-- políticas y la 189 cierra las lecturas cross-país.
--
-- EL PROBLEMA
-- La app y la base deciden permisos con criterios distintos:
--   · la app pregunta "¿el rol tiene esta sección?" (roles.permissions.sections)
--   · la base pregunta "¿es admin?" (can_edit() = is_admin())
-- Mientras las secciones se concedan solo a admins nadie lo nota. Al delegar
-- una a un rol operativo, la pantalla se abre y la escritura rebota con
-- "new row violates row-level security policy": el usuario ve un error técnico
-- donde debería ver la pantalla funcionando o ningún acceso.
--
-- Casos REALES ya ocurridos: hub_expert + distances (parcheado a mano en la
-- mig 181) y ms&e + earnings (2 usuarios bloqueados, sin parchear hasta hoy).
--
-- POR QUÉ NO SE PARCHEA CASO POR CASO
-- Cada parche codifica en SQL la foto de roles de HOY. Crear un rol, o darle o
-- quitarle una sección, obligaría a escribir otra migración — el permiso
-- viviría en dos lugares que se desincronizan, que es el bug original pero más
-- disperso. El objetivo es que `roles.permissions` sea la ÚNICA fuente de
-- verdad y que cambiar permisos sea editar esa fila desde la pantalla de
-- Accesos, nunca escribir SQL.
--
-- CÓMO FUNCIONA
--   section_write_grants  declara qué tabla escribe cada sección
--   can_write_table(t)    responde "¿el rol de este usuario escribe esa tabla?"
--                         sin nombrar NINGÚN rol ni sección concreta
--
-- DECISIONES DE PRODUCTO tomadas acá (2026-08-01). Todas son REVERSIBLES con
-- un INSERT o DELETE en section_write_grants — no hace falta migración, que es
-- justamente el punto del diseño:
--
--   · `earnings` ESCRIBE. Hay 2 usuarios del rol ms&e bloqueados hoy con la
--     pantalla visible; el criterio de aceptación del diseño es "si la UI la
--     muestra, sus escrituras funcionan". Si se decide que earnings sea solo
--     lectura, se borran esas 3 filas y hay que sacar los editores de la UI.
--   · `config` ESCRIBE sus ~15 tablas. Hoy ningún rol no-admin tiene config,
--     así que esto no cambia nada en la práctica; se incluye para que el día
--     que se delegue funcione sin tocar SQL.
--   · `access` NO entra, a propósito y por seguridad. Escribe `user_profiles`
--     y `roles`: un rol no-admin con esa sección podría concederse a sí mismo
--     cualquier permiso. Es escalación de privilegios, no un permiso más. Se
--     mantiene solo-admin vía is_admin(), y la 188 además marca la pantalla
--     como adminOnly en la app para no dejar el estado intermedio malo.
--   · `dataentry` y `rawdata` NO entran: sus tablas ya se gatean por país +
--     dueño, que es el criterio correcto ahí ("es tuyo", no "qué sección
--     tenés"). pricing_observations además NO se toca por rendimiento (ver
--     abajo).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Tabla de mapeo ────────────────────────────────────────────────────
-- Es el contrato explícito entre la app y la BD, y el único lugar a tocar
-- cuando una pantalla nueva empieza a escribir una tabla nueva. Modelarlo
-- como (sección, tabla) y no como una columna en cada política permite que
-- una misma tabla se edite desde DOS pantallas — ya pasa hoy: las comisiones
-- se editan desde Config y desde Ingresos.
CREATE TABLE IF NOT EXISTS public.section_write_grants (
  section    text NOT NULL,
  table_name text NOT NULL,
  note       text,
  PRIMARY KEY (section, table_name)
);

COMMENT ON TABLE public.section_write_grants IS
  'Qué tabla puede escribir cada sección de la app (mig 187). Es el contrato '
  'entre roles.permissions.sections y las políticas RLS. Agregar una fila '
  'concede escritura sin necesidad de una migración nueva.';

-- Solo admin la administra, y todos la leen: can_write_table() es SECURITY
-- DEFINER así que no depende de este SELECT, pero la pantalla de Accesos
-- necesita mostrarla.
ALTER TABLE public.section_write_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS section_write_grants_select ON public.section_write_grants;
CREATE POLICY section_write_grants_select ON public.section_write_grants
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS section_write_grants_write ON public.section_write_grants;
CREATE POLICY section_write_grants_write ON public.section_write_grants
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

REVOKE ALL ON public.section_write_grants FROM anon;
GRANT SELECT ON public.section_write_grants TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.section_write_grants TO authenticated;

-- ── Seed ──────────────────────────────────────────────────────────────
-- Derivado del mapa de la auditoría 2026-07-31 (PERMISOS_DESIGN.md).
INSERT INTO public.section_write_grants (section, table_name, note) VALUES
  ('distances', 'distance_references', 'Rutas de referencia. Caso real: hub_expert bloqueado, mig 181.'),

  ('earnings',  'earnings_scenarios',     'Decisión 2026-08-01: earnings escribe.'),
  ('earnings',  'competitor_commissions', 'Caso real: rol ms&e bloqueado.'),
  ('earnings',  'competitor_bonuses',     'Caso real: rol ms&e bloqueado.'),

  ('events',    'market_events', 'Hoy solo admin; queda listo por si se delega.'),

  ('upload',    'bot_sync_watermark', 'Marca de agua del sync del bot.'),
  ('upload',    'upload_batches',     'Historial de cargas.'),

  -- Config: ~15 tablas. Ningún rol no-admin la tiene hoy.
  ('config', 'distance_thresholds',    NULL),
  ('config', 'bracket_weights',        NULL),
  ('config', 'semaforo_config',        NULL),
  ('config', 'price_validation_rules', NULL),
  ('config', 'rush_hour_windows',      NULL),
  ('config', 'ci_timeslots',           'Global, sin columna country.'),
  ('config', 'competitor_commissions', 'También editable desde Ingresos.'),
  ('config', 'competitor_bonuses',     'También editable desde Ingresos.'),
  ('config', 'yango_gmv_tiers',        NULL),
  ('config', 'indrive_config',         NULL),
  ('config', 'competitive_bands',      NULL),
  ('config', 'bot_rules',              NULL),
  ('config', 'airport_markers',        NULL),
  ('config', 'country_config',         'Se gatea por country_key, no country.'),
  ('config', 'catalog_extras',         NULL)
ON CONFLICT (section, table_name) DO NOTHING;

-- ── can_write_table() ─────────────────────────────────────────────────
-- No nombra ningún rol ni sección: se adapta sola a cualquier configuración
-- de roles.permissions. SECURITY DEFINER porque tiene que leer user_profiles
-- y roles, que el usuario común no necesariamente puede leer enteras.
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
      AND (
        r.permissions->'sections' ? g.section OR
        r.permissions->'sections' ? 'all'
      )
  );
$$;

COMMENT ON FUNCTION public.can_write_table(text) IS
  '¿El rol del usuario actual puede escribir esta tabla? (mig 187). Genérica: '
  'no nombra roles ni secciones, resuelve contra section_write_grants y '
  'roles.permissions. Admin siempre puede.';

REVOKE ALL ON FUNCTION public.can_write_table(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_write_table(text) TO authenticated;

-- Índice para el JOIN de la función: se evalúa por consulta (no por fila,
-- porque auth.email() va envuelto en (select ...)), pero es barato tenerlo.
CREATE INDEX IF NOT EXISTS idx_section_write_grants_table
  ON public.section_write_grants(table_name);

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- 1) La función es genérica — probar SIN tocar SQL que un rol nuevo gana y
--    pierde permisos solo editando roles.permissions:
--      (ver el bloque de simulación ejecutado en el cutover de esta migración)
--
-- 2) search_path fijado:
--    SELECT proname, proconfig FROM pg_proc WHERE proname='can_write_table';
--
-- 3) anon sin EXECUTE:
--    SELECT has_function_privilege('anon','can_write_table(text)','EXECUTE');  → f
--
-- 4) `access` NO está en el mapa (escalación de privilegios):
--    SELECT count(*) FROM section_write_grants WHERE section='access';  → 0
--
-- NOTA DE RENDIMIENTO: `pricing_observations` NO se migra a este patrón. Las
-- migs 175/176 la reescribieron a propósito para calcular los países
-- permitidos una vez por consulta en vez de por fila (SELECT 16,5s → 39-60ms
-- sobre 1,6M+ filas). Meterla acá reintroduciría el costo por fila. Si algún
-- día se quiere unificar, medir primero.
