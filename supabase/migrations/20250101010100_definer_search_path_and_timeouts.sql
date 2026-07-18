-- ════════════════════════════════════════════════════════════════════════
-- Migración 61 — search_path hijacking + statement_timeout en RPCs
--
-- CONTEXTO:
--   PG permite que cada función SECURITY DEFINER use search_path heredado
--   del caller. Un atacante con privilegios CREATE en su schema puede
--   crear funciones/tablas con el mismo nombre que las internas, y al
--   ser llamadas desde una función DEFINER, esas variantes maliciosas se
--   ejecutan con privilegios del owner. CVE clásico de PG.
--
--   FIX: `SET search_path = public, pg_temp` en cada definición.
--
--   Bonus: agregar statement_timeout a RPCs costosas. Un viewer
--   malicioso podría llamar `freeze_pricing_wa` con datasets enormes →
--   DoS al proyecto. 30s es generoso para queries normales.
--
-- DISEÑO:
--   - Usamos `ALTER FUNCTION ... SET search_path` para las funciones
--     ya existentes (no hay que recrearlas — el setter es metadata).
--   - statement_timeout: idem, ALTER FUNCTION SET statement_timeout.
--   - Idempotente: ALTER FUNCTION es upsert de configuración.
--
-- FUNCIONES OBJETIVO:
--   Detectadas con `pg_proc.prosecdef = true` (SECURITY DEFINER) y
--   declaradas en /supabase/*.sql. Lista canónica abajo.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A. Helper: aplica los settings a una función si existe ─────────────
--
-- Usamos DO block porque ALTER FUNCTION falla si la función no existe.
-- regprocedure cast permite identificar la firma exacta. Si la firma
-- evoluciona en una migración futura, esto se vuelve no-op silencioso.

DO $migration$
DECLARE
  fn record;
  -- Tupla (nombre, firma para ALTER, aplicar_timeout)
  targets text[][] := ARRAY[
    -- functions de pricing core
    ['get_distance_bracket(text,text,text,numeric)', 'short'],
    ['get_distance_bracket(text,text,numeric)',      'short'],
    ['trg_assign_computed_fields()',                  'short'],
    ['upsert_pricing_batch(jsonb,text)',              'long'],
    -- snapshots / WA
    ['freeze_pricing_wa(text,text,text,int,int,int,int,text)', 'long'],
    ['list_pricing_wa_snapshots(text)',               'short'],
    ['unfreeze_pricing_wa(text,text)',                'short'],
    -- bot sync
    ['sync_bot_quotes(integer)',                      'long'],
    -- catalog
    ['list_catalog_extras(text)',                     'short'],
    -- recompute
    ['recompute_brackets_for(text,text,text)',        'long'],
    -- access helpers (ya tienen search_path pero idempotente)
    ['is_admin()',                                    'short'],
    ['can_edit()',                                    'short']
  ];
  t text[];
  fnsig text;
  timeout text;
BEGIN
  FOREACH t SLICE 1 IN ARRAY targets LOOP
    fnsig   := t[1];
    timeout := t[2];

    -- ¿Existe la función con esa firma exacta?
    BEGIN
      PERFORM 1 FROM pg_proc
       WHERE oid = (fnsig)::regprocedure;
      -- search_path siempre
      EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', fnsig);

      -- statement_timeout: 5s para short, 60s para long
      IF timeout = 'short' THEN
        EXECUTE format('ALTER FUNCTION %s SET statement_timeout = ''5s''', fnsig);
      ELSE
        EXECUTE format('ALTER FUNCTION %s SET statement_timeout = ''60s''', fnsig);
      END IF;

      RAISE NOTICE 'Hardened: %', fnsig;
    EXCEPTION
      WHEN undefined_function OR undefined_object THEN
        RAISE NOTICE 'Skip (no existe): %', fnsig;
      WHEN OTHERS THEN
        RAISE NOTICE 'Skip (error): % — %', fnsig, SQLERRM;
    END;
  END LOOP;
END
$migration$;


-- ── B. Funciones SECURITY DEFINER sin firma fija (con descubrimiento) ──
--
-- Algunas funciones agregadas en migraciones tempranas pueden tener
-- firmas que no recuerdo exactamente. Iteramos sobre pg_proc para
-- aplicar search_path a TODAS las SECURITY DEFINER del schema public.
-- statement_timeout no se aplica acá (sería ciego). Solo hardening.

DO $migration$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT
      p.oid::regprocedure AS sig,
      p.proname           AS name,
      n.nspname           AS schema
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
      -- Solo si NO tiene search_path ya configurado
      AND NOT EXISTS (
        SELECT 1
        FROM pg_db_role_setting s
        WHERE s.setrole = 0  -- function-level setting check via proconfig
      )
      AND (
        p.proconfig IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM unnest(p.proconfig) c
          WHERE c LIKE 'search_path=%'
        )
      )
  LOOP
    BEGIN
      EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', fn.sig);
      RAISE NOTICE 'Auto-hardened: %', fn.sig;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'Skip auto-harden: % — %', fn.sig, SQLERRM;
    END;
  END LOOP;
END
$migration$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN POST-APLICACIÓN
--
-- 1. Listar funciones DEFINER con su search_path:
--    SELECT p.proname,
--           array_to_string(p.proconfig, ', ') AS cfg
--    FROM pg_proc p
--    JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.prosecdef = true
--    ORDER BY p.proname;
--
-- 2. Todas deberían tener `search_path=public, pg_temp` en cfg.
--
-- 3. RPCs costosas deberían tener `statement_timeout=60s` o `5s`.
-- ════════════════════════════════════════════════════════════════════════
