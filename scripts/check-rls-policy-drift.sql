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
SELECT
  tablename,
  cmd,
  count(*)                             AS policy_count,
  array_agg(policyname ORDER BY policyname) AS policies,
  array_agg(qual ORDER BY policyname)       AS quals
FROM pg_policies
WHERE schemaname = 'public'
GROUP BY tablename, cmd
HAVING count(*) > 1
ORDER BY tablename, cmd;
