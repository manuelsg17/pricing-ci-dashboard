-- ════════════════════════════════════════════════════════════════════════
-- Migración 74 — Drop legacy apply_indrive_bot_prices(text, text)
--
-- CONTEXTO:
--   pg_proc todavía contiene la versión vieja de mig 23 con firma
--   (p_city, p_category) — pre-multicountry. La versión correcta es
--   (p_country, p_city, p_category) creada en mig 65 y reparchada
--   en mig 73 con el guard idempotente.
--
--   Aunque PostgREST rutea por nombre de parámetros y debería elegir
--   la firma de 3 args cuando el frontend pasa p_country, mantener las
--   dos overloads es ruido — y en casos edge puede causar resoluciones
--   ambiguas.
--
-- ACCIÓN:
--   DROP de la firma vieja. La de 3 args queda como única.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

DROP FUNCTION IF EXISTS apply_indrive_bot_prices(text, text);

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   SELECT proname, pg_get_function_arguments(oid)
--   FROM pg_proc WHERE proname = 'apply_indrive_bot_prices';
--   -> Debería devolver UNA sola fila:
--      apply_indrive_bot_prices | p_country text, p_city text DEFAULT NULL,
--                                 p_category text DEFAULT NULL
-- ════════════════════════════════════════════════════════════════════════
