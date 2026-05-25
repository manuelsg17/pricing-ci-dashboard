-- ════════════════════════════════════════════════════════════════════════
-- Migración 82 — Zone como source-of-truth en airport_markers
--
-- CONTEXTO:
--   Mig 78 introdujo airport_markers con detección basada en keywords
--   sobre point_a/point_b. Funciona pero es frágil: si el geocoder
--   devuelve "Av. Faucett 123" en vez de "Jorge Chávez", no matchea.
--
--   El bot del usuario YA tiene un campo `zone` que puede etiquetar
--   explícitamente "AeroportFrom" / "AeroportTo". Si lo usamos como
--   source-of-truth primario eliminamos toda la adivinanza.
--
-- DISEÑO:
--   Agregamos dos columnas a airport_markers:
--     - zone_from_value: valor exacto que el bot emite cuando el
--                        aeropuerto es el origen del viaje.
--     - zone_to_value:   valor exacto cuando el aeropuerto es destino.
--
--   El script Python prueba en este orden:
--     1. raw.zone == zone_from_value  → city_from
--     2. raw.zone == zone_to_value    → city_to
--     3. Sin match en zone           → fallback a keywords (lógica de mig 78)
--
--   Si los campos quedan NULL, el bot Python ignora el chequeo de zone
--   y va directo a keywords. Backward compat total.
--
-- SEED:
--   Pre-cargamos 'AeroportFrom' / 'AeroportTo' para los 3 markers de Peru,
--   asumiendo que el usuario los configurará en su bot con esos valores.
--   Si usa otros valores, los puede editar en /config → Aeropuertos.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.airport_markers
  ADD COLUMN IF NOT EXISTS zone_from_value text,
  ADD COLUMN IF NOT EXISTS zone_to_value   text;

COMMENT ON COLUMN public.airport_markers.zone_from_value IS
  'Valor exacto en raw.zone que indica viaje desde el aeropuerto. Match exacto, case-sensitive. NULL = ignora (usa keywords).';
COMMENT ON COLUMN public.airport_markers.zone_to_value IS
  'Valor exacto en raw.zone que indica viaje hacia el aeropuerto. NULL = ignora.';

-- Seed Peru (pre-llenamos con convención sugerida; usuario puede editar)
UPDATE public.airport_markers
SET zone_from_value = COALESCE(zone_from_value, 'AeroportFrom'),
    zone_to_value   = COALESCE(zone_to_value,   'AeroportTo')
WHERE country = 'Peru';

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   SELECT base_city, zone_from_value, zone_to_value
--   FROM airport_markers WHERE country='Peru';
--   → 3 filas con 'AeroportFrom' / 'AeroportTo'.
-- ════════════════════════════════════════════════════════════════════════
