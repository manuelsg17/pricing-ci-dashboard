-- ════════════════════════════════════════════════════════════════════════
-- Migración 36 — Pipeline FDW (Foreign Data Wrapper) hacia fudobi
--
-- ARQUITECTURA:
--   Supabase PG ──postgres_fdw──> fudobi.helioho.st / public.quotes_output
--                                         │
--                                         ▼
--                          sync_bot_quotes(p_country) función SQL
--                                         │
--                          (aplica botRules + price_validation_rules)
--                                         │
--                                         ▼
--                          INSERT en pricing_observations
--
--   Por qué FDW y no Edge Function: libpq (PostgreSQL) acepta certs
--   autofirmados con sslmode=require sin validar hostname; Deno+rustls
--   no lo permite. Esto evita el error NotValidForName.
--
-- INSTRUCCIONES DE EJECUCIÓN:
--   Este archivo tiene 3 PASOS marcados. Ejecútalos UNO POR UNO en el
--   SQL Editor de Supabase, no todo de golpe — el paso 2 requiere que
--   reemplaces __FUDOBI_PASSWORD__ por el password real ANTES de
--   ejecutar.
-- ════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════
-- PASO 1 — Extension + Server (público, sin password)
-- ═══════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS postgres_fdw;

DROP SERVER IF EXISTS bot_db_server CASCADE;

CREATE SERVER bot_db_server
  FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (
    host          'fudobi.helioho.st',
    -- hostaddr fuerza IPv4: helioho.st tiene reglas pg_hba.conf solo para
    -- IPv4. Si no se setea, libpq resuelve DNS y prefiere IPv6 → 'no
    -- pg_hba.conf entry'. La IP la sacas con: nslookup fudobi.helioho.st
    -- (a 2026-04-25 era 65.19.154.90; verifica si cambia).
    hostaddr      '65.19.154.90',
    port          '5432',
    dbname        'fudobi_boheme',
    sslmode       'require',           -- encripta sin validar cert (clave para evitar NotValidForName)
    fetch_size    '1000',
    connect_timeout '15'
  );


-- ═══════════════════════════════════════════════════════════════════════
-- PASO 2 — User mapping con el password real
--   ⚠ REEMPLAZA __FUDOBI_PASSWORD__ POR EL PASSWORD ANTES DE EJECUTAR.
--   No commitees este archivo con el password real.
-- ═══════════════════════════════════════════════════════════════════════

DROP USER MAPPING IF EXISTS FOR postgres        SERVER bot_db_server;
DROP USER MAPPING IF EXISTS FOR service_role    SERVER bot_db_server;
DROP USER MAPPING IF EXISTS FOR authenticated   SERVER bot_db_server;

CREATE USER MAPPING FOR postgres
  SERVER bot_db_server
  OPTIONS (user 'fudobi_admin_boheme', password '__FUDOBI_PASSWORD__');

CREATE USER MAPPING FOR service_role
  SERVER bot_db_server
  OPTIONS (user 'fudobi_admin_boheme', password '__FUDOBI_PASSWORD__');

CREATE USER MAPPING FOR authenticated
  SERVER bot_db_server
  OPTIONS (user 'fudobi_admin_boheme', password '__FUDOBI_PASSWORD__');


-- ═══════════════════════════════════════════════════════════════════════
-- PASO 3 — Importar el esquema de quotes_output como tabla foránea
--   Usa IMPORT FOREIGN SCHEMA para que las columnas se generen
--   automáticamente, así no hay que adivinar nombres/tipos.
-- ═══════════════════════════════════════════════════════════════════════

DROP FOREIGN TABLE IF EXISTS bot_quotes_remote;

IMPORT FOREIGN SCHEMA public LIMIT TO (quotes_output)
  FROM SERVER bot_db_server
  INTO public;

-- Renombrar a algo más explícito
ALTER FOREIGN TABLE quotes_output RENAME TO bot_quotes_remote;

GRANT SELECT ON bot_quotes_remote TO authenticated, service_role;

COMMENT ON FOREIGN TABLE bot_quotes_remote IS
  'Tabla foránea que apunta a fudobi.helioho.st/public.quotes_output via postgres_fdw. NO se almacena data localmente — cada SELECT consulta la BD remota en vivo.';

-- Smoke test (deberías ver al menos 1 fila si el server tiene data)
-- SELECT count(*) FROM bot_quotes_remote;
-- SELECT * FROM bot_quotes_remote LIMIT 3;
