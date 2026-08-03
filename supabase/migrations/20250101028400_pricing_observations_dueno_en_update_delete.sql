-- ════════════════════════════════════════════════════════════════════════
-- 203_pricing_observations_dueno_en_update_delete.sql — cerrar la escotilla
-- `uploaded_by IS NULL` en UPDATE y DELETE.
--
-- ⚠️  NO APLICADA. Requiere autorización explícita del user (CLAUDE.md §3).
--
-- EL AGUJERO, reproducido con un rol `{"sections":[],"countries":["Peru"]}` —
-- o sea un usuario SIN NINGUNA SECCIÓN, solo con el país:
--
--   UPDATE pricing_observations SET price_without_discount = 1
--    WHERE country='Peru' AND uploaded_by IS NULL;            → PASÓ
--   DELETE FROM pricing_observations
--    WHERE country='Peru' AND uploaded_by IS NULL;            → PASÓ
--   SELECT count(*) … WHERE uploaded_by IS NULL;              → 0
--
-- En producción son ~150.000 filas: todo lo del bot y todo el histórico legacy
-- de esa ciudad. Alcanzable por PostgREST directo y también desde la UI —
-- `useRawDataMutations.js` borra y edita por `id` sin predicado de dueño, y la
-- ruta `rawdata` no es adminOnly.
--
-- La mig 202 cerró el INSERT y razonó explícitamente sobre esta escotilla, pero
-- la dejó abierta en los otros dos comandos. Es el mismo descuido que la 202
-- vino a corregir, un comando más allá.
--
-- ── POR QUÉ NO SE USA can_write_table() ────────────────────────────────
-- Sería lo natural viniendo del modelo genérico de las migs 187/192, pero el
-- mapa dice otra cosa:
--
--   section_write_grants: pricing_observations · dataentry · gate='owner'
--                         pricing_observations · rawdata   · gate='owner'
--                         pricing_observations · upload    · gate='owner'
--
-- `gate='owner'` significa "la política filtra por dueño", y `can_write_table()`
-- solo mira las filas con `gate='section'`. O sea que devolvería false para
-- todos y rompería la tabla entera. El mapa ya declara cuál es el criterio
-- correcto acá: el DUEÑO. Lo que faltaba era que la política lo cumpliera.
--
-- ── QUIÉN TIENE QUE PODER SEGUIR TOCANDO LAS FILAS SIN DUEÑO ───────────
-- `uploaded_by IS NULL` no es basura: es como entran el bot y la carga masiva.
-- `src/pages/Upload.jsx:338` borra exactamente ese conjunto antes de reinsertar
-- (`.is('uploaded_by', null)`), y ese borrado ACOTADO es deliberado — la mig
-- 139 lo puso así para no llevarse puesto el trabajo manual de los hubs.
--
-- Entonces el permiso correcto sobre las filas sin dueño es la sección que hace
-- carga masiva, no "cualquiera con el país":
--
--   admin                          → todo, como siempre
--   dueño de la fila               → sus propias filas
--   sección `upload` + país        → las filas sin dueño (bot y legacy)
--   cualquier otro                 → nada
--
-- Con eso el hub sin secciones deja de poder borrar 150.000 filas, Upload sigue
-- funcionando igual, y el hub sigue corrigiendo lo suyo.
--
-- El bot no se ve afectado: corre con `service_role`, que bypasea RLS.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- `DROP POLICY IF EXISTS` explícito (CLAUDE.md §3): las permisivas se combinan
-- con OR y una vieja sobreviviente ganaría en silencio.
DROP POLICY IF EXISTS pricing_observations_update ON public.pricing_observations;
CREATE POLICY pricing_observations_update
  ON public.pricing_observations
  FOR UPDATE TO authenticated
  USING (
    can_access_country(country)
    AND (
      (select is_admin())
      OR uploaded_by = (select auth.email())
      OR (uploaded_by IS NULL AND can_access_section('upload'))
    )
  )
  WITH CHECK (
    can_access_country(country)
    AND (
      (select is_admin())
      OR uploaded_by = (select auth.email())
      OR (uploaded_by IS NULL AND can_access_section('upload'))
    )
  );

DROP POLICY IF EXISTS pricing_observations_delete ON public.pricing_observations;
CREATE POLICY pricing_observations_delete
  ON public.pricing_observations
  FOR DELETE TO authenticated
  USING (
    can_access_country(country)
    AND (
      (select is_admin())
      OR uploaded_by = (select auth.email())
      OR (uploaded_by IS NULL AND can_access_section('upload'))
    )
  );

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- Con un rol {"sections":[],"countries":["Peru"]} y SET LOCAL ROLE authenticated:
--   1) UPDATE de una fila con uploaded_by NULL          → violates RLS
--   2) DELETE de las filas con uploaded_by NULL         → 0 filas borradas
--   3) UPDATE de una fila propia                        → pasa
--
-- Con un rol {"sections":["upload"],"countries":["Peru"]}:
--   4) DELETE de las filas sin dueño de SU país         → pasa (Upload sigue vivo)
--   5) …de otro país                                    → 0 filas
--
-- Y el flujo del hub intacto:
--   6) save_ci_batch borra e inserta lo suyo            → deleted=N, inserted=N
--
-- Ojo: 2 y 5 devuelven "0 filas borradas" en vez de error, porque un DELETE que
-- no matchea ninguna fila por RLS no es un error de Postgres. Es el
-- comportamiento correcto y hay que probarlo contando filas, no esperando una
-- excepción.
