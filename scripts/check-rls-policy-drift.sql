-- check-rls-policy-drift.sql
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
