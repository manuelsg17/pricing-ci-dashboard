-- ════════════════════════════════════════════════════════════════════════
-- Migración 231 — data_incidents: motivo TRADUCIBLE
--
-- PROBLEMA (reportado por el user 2026-08-30 con captura): el tooltip de las
-- celdas rayadas mostraba `reason`, un texto libre en español guardado en la
-- BD. Con el dashboard en inglés o ruso, ese tooltip seguía en español —
-- rompe la regla de i18n del proyecto (§6: todo string visible pasa por t()).
--
-- FIX: el motivo se guarda como CÓDIGO de un vocabulario cerrado y el
-- frontend lo traduce con t(). El texto libre `reason` NO se borra: queda
-- como nota interna del incidente (registro de qué pasó exactamente), pero
-- deja de ser lo que se muestra.
--
-- POR QUÉ UN CHECK Y NO TEXTO LIBRE: si alguien inventa un código sin clave
-- i18n, el tooltip mostraría el código crudo — justo el bug que esta
-- migración viene a cerrar. El CHECK lo hace imposible: agregar un motivo
-- nuevo obliga a pasar por acá y por i18n.js en el mismo cambio.
--
-- ORDEN DE DESPLIEGUE (patrón expandir→migrar→contraer, §4): esta migración
-- AGREGA la columna y hace el backfill sin tocar `reason`, así que el bundle
-- viejo que todavía lee `reason` sigue funcionando durante la ventana de
-- deploy. Recién el frontend nuevo pasa a leer `reason_code`.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.data_incidents
  ADD COLUMN IF NOT EXISTS reason_code text;

-- Backfill de los 2 incidentes ya cargados (mig 229), por su contenido real.
UPDATE public.data_incidents
   SET reason_code = 'db_save_failure'
 WHERE reason_code IS NULL AND city = 'Lima' AND competitor IS NULL;

UPDATE public.data_incidents
   SET reason_code = 'device_disconnected'
 WHERE reason_code IS NULL AND competitor = 'InDrive';

-- Cualquier otro que hubiera quedado sin código cae al genérico, que también
-- está traducido — nunca se muestra un código crudo.
UPDATE public.data_incidents
   SET reason_code = 'other'
 WHERE reason_code IS NULL;

ALTER TABLE public.data_incidents
  ALTER COLUMN reason_code SET NOT NULL;

ALTER TABLE public.data_incidents
  DROP CONSTRAINT IF EXISTS data_incidents_reason_code_chk;
ALTER TABLE public.data_incidents
  ADD CONSTRAINT data_incidents_reason_code_chk CHECK (reason_code IN (
    'bot_no_capture',       -- el simulador no capturó (falla del scraper)
    'db_save_failure',      -- la data no llegó/no se guardó en la base
    'device_disconnected',  -- teléfono o emulador desconectado
    'app_blocked',          -- la app bloqueó o limitó las consultas
    'other'                 -- otra falla del sistema
  ));

COMMENT ON COLUMN public.data_incidents.reason_code IS
  'Motivo del incidente, de vocabulario cerrado. Es lo que se MUESTRA (traducido con t() en los 3 locales). Agregar un valor exige tocar este CHECK y i18n.js en el mismo cambio.';
COMMENT ON COLUMN public.data_incidents.reason IS
  'Nota interna con el detalle de qué pasó. NO se muestra en la UI (no es traducible) — sirve de registro para quien audite el incidente.';

DO $$
DECLARE v_sin_codigo int;
BEGIN
  SELECT count(*) INTO v_sin_codigo FROM public.data_incidents WHERE reason_code IS NULL;
  IF v_sin_codigo > 0 THEN
    RAISE EXCEPTION 'mig 231 ABORTADA: quedaron % incidentes sin reason_code.', v_sin_codigo;
  END IF;
  RAISE NOTICE 'mig 231 OK — reason_code poblado y acotado por CHECK.';
END $$;

COMMIT;
