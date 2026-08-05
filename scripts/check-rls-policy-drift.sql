-- check-rls-policy-drift.sql

-- Sin esto psql imprime el ERROR del RAISE de abajo y SALE 0 igual: el
-- chequeo no podría fallar nunca. Es la mitad que hace que sirva en CI.
\set ON_ERROR_STOP on
--
-- Encuentra tablas donde 2+ RLS policies aplican al mismo comando
-- (SELECT/INSERT/UPDATE/DELETE) — el patrón exacto detrás del incidente
-- de mig 60-66 (country_config tuvo una policy de escritura abierta
-- corriendo en paralelo con la restrictiva correcta; RLS combina
-- policies permisivas con OR, así que la abierta ganaba en silencio) y
-- del drift real encontrado en mig 130 (bot_rules/bot_sync_log/
-- bot_sync_watermark con una policy vieja "Authenticated read X"
-- (qual=true) sin dar de baja al agregar la nueva con scope de país).
--
-- Un resultado con filas NO es automáticamente un bug — puede haber
-- casos legítimos de policies múltiples — pero es exactamente la forma
-- que toma este tipo de drift, así que cada fila que devuelva merece
-- revisión manual antes de asumir que es intencional.
--
-- Uso: correr contra local o producción (ver README → workflow local).
--
-- ── CORRECCIÓN 2026-08-02 ─────────────────────────────────────────────
-- La versión anterior agrupaba por (tablename, cmd) tal como los devuelve
-- pg_policies. Una política `FOR ALL` figura con cmd='ALL' y NUNCA agrupa con
-- una de comando puntual — así que el chequeo era ciego justo a la forma de
-- drift que vino a cazar: una `FOR ALL USING(true)` conviviendo con las
-- correctas por comando devolvía CERO filas.
--
-- Verificado con una mutación en local: creando
--   CREATE POLICY country_config_legacy_open ON country_config
--     FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- el detector viejo no reportaba nada mientras un usuario de Colombia pasaba
-- de ver 1 país a ver los 6. Con el arreglo, la fila aparece en los 4 comandos.
--
-- Ahora `ALL` se expande a los cuatro comandos ANTES de agrupar.
WITH expandidas AS (
  SELECT p.tablename,
         CASE WHEN p.cmd = 'ALL' THEN c.cmd ELSE p.cmd END AS cmd,
         p.policyname,
         p.qual,
         (p.cmd = 'ALL') AS es_for_all
  FROM pg_policies p
  CROSS JOIN LATERAL (
    SELECT unnest(CASE WHEN p.cmd = 'ALL'
                       THEN ARRAY['SELECT','INSERT','UPDATE','DELETE']
                       ELSE ARRAY[p.cmd] END) AS cmd
  ) c
  WHERE p.schemaname = 'public'
)
SELECT
  tablename,
  cmd,
  count(*)                                  AS policy_count,
  array_agg(policyname ORDER BY policyname)  AS policies,
  bool_or(es_for_all)                        AS incluye_una_for_all,
  array_agg(qual ORDER BY policyname)        AS quals
FROM expandidas
GROUP BY tablename, cmd
HAVING count(*) > 1
ORDER BY tablename, cmd;

-- ── EL CHEQUEO TIENE QUE PODER FALLAR ─────────────────────────────────
-- Agregado 2026-08-05, al meter este script al pipeline de deploy.
--
-- Hasta acá era un SELECT y nada más: psql sale 0 aunque devuelva filas, así
-- que como paso de CI habría pasado SIEMPRE — incluso con una política vieja y
-- laxa conviviendo con la nueva, que es exactamente el drift de las migs
-- 60-66, 130 y 164-165. Un guard que no puede fallar da confianza y no
-- protege.
--
-- ── POR QUÉ HAY UNA LISTA DE EXCEPCIONES, Y POR QUÉ ES ESTRECHA ───────
-- La cabecera ya dice que 2+ políticas NO es automáticamente un bug. Hoy hay
-- exactamente UN caso intencional y está auditado:
--
--   `section_write_grants` · SELECT · {section_write_grants_select,
--    section_write_grants_write}
--   El cliente NECESITA leer ese mapa (useSectionWriteGrants.js lo muestra en
--   la pantalla de Accesos), así que la política de lectura es `true`. La otra
--   es `FOR ALL TO ... USING (is_admin())`, que solo agrega escritura — al
--   expandirse a los 4 comandos aparece también en SELECT y por eso el
--   detector la ve. La lectura ya era pública: el par no afloja nada.
--
-- La excepción se ancla al conjunto EXACTO de nombres de política. Si mañana
-- alguien agrega una tercera política a esa tabla, el array deja de coincidir
-- y el chequeo falla — que es lo que se quiere. No se exceptúa "la tabla", se
-- exceptúa "esta combinación revisada".
DO $$
DECLARE
  v_n     int;
  v_lista text;
BEGIN
  WITH expandidas AS (
    SELECT p.tablename,
           CASE WHEN p.cmd = 'ALL' THEN c.cmd ELSE p.cmd END AS cmd,
           p.policyname
    FROM pg_policies p
    CROSS JOIN LATERAL (
      SELECT unnest(CASE WHEN p.cmd = 'ALL'
                         THEN ARRAY['SELECT','INSERT','UPDATE','DELETE']
                         ELSE ARRAY[p.cmd] END) AS cmd
    ) c
    WHERE p.schemaname = 'public'
  ), drift AS (
    SELECT tablename, cmd, array_agg(policyname::text ORDER BY policyname) AS policies
    FROM expandidas
    GROUP BY tablename, cmd
    HAVING count(*) > 1
  )
  SELECT count(*), string_agg(tablename || '/' || cmd || ' ' || policies::text, E'\n      ')
    INTO v_n, v_lista
  FROM drift
  WHERE NOT (
    tablename = 'section_write_grants'
    AND cmd = 'SELECT'
    AND policies = ARRAY['section_write_grants_select','section_write_grants_write']
  );

  IF v_n > 0 THEN
    RAISE EXCEPTION E'\n  ✗ DRIFT DE POLÍTICAS: % caso(s) NO auditado(s):\n      %\n    Dos políticas permisivas se combinan con OR: la más laxa gana EN SILENCIO.\n    Revisar cada una y, si es intencional, documentarla en la lista de\n    excepciones de este archivo — nunca dejarla pasar sin mirarla.',
      v_n, v_lista;
  END IF;
  RAISE NOTICE '  ✓ sin drift de políticas (solo el caso intencional auditado)';
END $$;
