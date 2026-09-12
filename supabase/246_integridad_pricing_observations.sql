-- ════════════════════════════════════════════════════════════════════════
-- Migración 246 — Reglas de integridad en pricing_observations
--                 + normalización del "sin oferta" histórico
--                 + limpieza de recommended_price corrupto
--
-- POR QUÉ:
--   Auditoría 2026-09-11: `pricing_observations` (2,48 M filas) no tenía NI
--   UN SOLO CHECK constraint. Todas las reglas del negocio vivían en el
--   formulario, así que cualquier camino de escritura que no fuera la UI
--   podía meter cualquier cosa — y de hecho lo hizo: 179 filas de Perú con
--   "precios" de 45.936 a 46.278 soles, que son NÚMEROS DE SERIE DE FECHA DE
--   EXCEL entrados por la columna equivocada en una carga masiva mal mapeada
--   (feb-mar 2026, todas InDrive, todas sin dueño). La mediana real de Perú
--   es 13,4. Un CHECK las habría rechazado en el momento exacto en que
--   alguien intentó escribirlas.
--
-- LO QUE LA AUDITORÍA CREYÓ ENCONTRAR Y NO ERA:
--   El primer conteo dio "1.202 filas con precio <= 0, corruptas". Falso.
--   1.164 eran InDrive y 1.116 de ésas TENÍAN CONTRAOFERTAS guardadas: en
--   InDrive un precio base en cero es legítimo, significa "no mostró tarifa
--   fija, solo contraofertas". Borrarlas habría destruido datos reales.
--   Lo mismo con el conjunto más grande: 21.028 filas "sin precio y sin
--   marca" NO están corruptas — son "sin oferta" en el formato viejo,
--   anterior a que la mig 20260721200240 introdujera la columna `no_data`.
--   El corte es perfecto y es la prueba:
--
--     antes del 2026-07-21 → 26 marcadas · 21.028 sin marcar
--     desde el 2026-07-21  → 9.914 marcadas · 0 sin marcar
--
--   O sea: NO HAY NADA QUE BORRAR. Hay un formato viejo que normalizar.
--
-- QUÉ HACE (idempotente):
--   1. Backfill: las 21.028 "sin oferta" viejas pasan a `no_data = true`.
--      No se borra ni una fila — se las traduce al formato actual.
--   2. Limpia el `recommended_price` corrupto de las 179 filas de Excel.
--      NO borra la fila: su `price_without_discount` (0-22) es sano y el
--      dashboard lo usa vía v_effective_price. Solo se vacía el campo malo.
--   3. Agrega tres CHECK.
--
-- SOBRE LA REGLA DE PRECIOS COHERENTES (la #3):
--   Se descartó la forma obvia —un techo por país— porque los rangos
--   legítimos difieren por órdenes de magnitud (Colombia llega a 263.200 en
--   COP; el valor CORRUPTO de Perú es 46.278) y porque hardcodear países en
--   un CHECK obliga a una migración cada vez que se onboardea uno nuevo.
--   En su lugar se compara la fila CONTRA SÍ MISMA: recommended_price no
--   puede ser 50 veces price_without_discount. Verificado contra los 2,48 M
--   de filas de producción: caza las 178 filas malas de Perú y da CERO
--   falsos positivos en Perú, Colombia, Nepal, Bolivia y Guatemala. Es
--   independiente de la moneda, así que no se pudre al agregar países.
--
--   Hueco conocido y aceptado: 1 de las 179 filas de Excel tiene
--   price_without_discount = 0, así que la regla del factor no la alcanza
--   (no hay contra qué comparar). El paso 2 sí la limpia. Para cerrarlo del
--   todo haría falta un techo por moneda, que es justo lo que se descartó.
--
-- SEGURIDAD: no toca RLS, grants, ni funciones. Solo datos y constraints.
--
-- IMPACTO EN LOS AGREGADOS: los agregados promedian precios, y estas 21.028
--   filas no tienen ninguno (entraban como NULL y ya quedaban fuera de los
--   promedios). Marcarlas no debería mover ningún número del dashboard, pero
--   las métricas de cobertura/representatividad sí las cuentan, así que
--   DESPUÉS de aplicar hay que correr refresh_ci_aggregates(4000) y
--   comparar. Ver bloque de verificación al pie.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Paso 1 — "sin oferta" del formato viejo → marca explícita ────────────
UPDATE pricing_observations
SET no_data = true
WHERE no_data = false
  AND data_source = 'manual'
  AND observed_date < DATE '2026-07-21'
  AND COALESCE(price_without_discount, 0) <= 0
  AND COALESCE(recommended_price, 0) <= 0
  AND COALESCE(price_with_discount, 0) <= 0
  AND bid_1 IS NULL AND bid_2 IS NULL AND bid_3 IS NULL
  AND bid_4 IS NULL AND bid_5 IS NULL AND minimal_bid IS NULL;

-- ── Paso 2 — vaciar el recommended_price que en realidad era una fecha ───
-- El rango 40.000-60.000 son seriales de Excel de 2025-2026. Acotado a Perú
-- a propósito: en COP esos valores son precios perfectamente normales.
UPDATE pricing_observations
SET recommended_price = NULL
WHERE country = 'Peru'
  AND recommended_price BETWEEN 40000 AND 60000;

-- ── Paso 3 — los tres CHECK ─────────────────────────────────────────────

-- 3a. El bracket solo puede ser uno de los seis. Hoy hay 0 violaciones
--     (6 valores + NULL), así que entra VALID directo.
--
--     OJO — lo que esta regla NO hace, verificado probándola en local:
--     insertar `distance_bracket = 'kilometrico'` NO da error. El trigger
--     BEFORE INSERT `trg_normalize_pricing_observations` recalcula el
--     bracket antes de que el CHECK lo mire y, al no haber `distance_km`
--     del que derivarlo, lo deja en NULL. Un bracket inventado no se
--     rechaza: se degrada en silencio a vacío. Eso explica las 5.949 filas
--     con bracket NULL que ya hay en producción.
--     Este CHECK queda igual como segunda línea de defensa (cubre un COPY
--     con triggers deshabilitados, o el día que alguien toque el trigger),
--     pero el agujero de fondo —normalizar en vez de rechazar— es una
--     decisión de diseño del trigger y cambiarla es otro trabajo: hoy el
--     bot manda valores raros y empezar a rechazarlos le rompería la
--     ingesta. Documentado, no arreglado acá a propósito.
ALTER TABLE public.pricing_observations
  DROP CONSTRAINT IF EXISTS ck_po_bracket_valido;
ALTER TABLE public.pricing_observations
  ADD CONSTRAINT ck_po_bracket_valido CHECK (
    distance_bracket IS NULL
    OR distance_bracket IN ('very_short','short','median','average','long','very_long')
  );

-- 3b. Toda fila o trae algún precio utilizable, o está marcada "sin oferta".
--     NOT VALID: el paso 1 deja 0 violaciones, pero validar recorre 2,48 M
--     filas con ACCESS EXCLUSIVE sobre las 19 particiones. Se valida aparte,
--     fuera de la transacción, con un lock que no bloquea escrituras.
ALTER TABLE public.pricing_observations
  DROP CONSTRAINT IF EXISTS ck_po_precio_o_sin_oferta;
ALTER TABLE public.pricing_observations
  ADD CONSTRAINT ck_po_precio_o_sin_oferta CHECK (
    no_data
    OR COALESCE(price_without_discount, 0) > 0
    OR COALESCE(recommended_price, 0) > 0
    OR COALESCE(price_with_discount, 0) > 0
    OR bid_1 IS NOT NULL OR bid_2 IS NOT NULL OR bid_3 IS NOT NULL
    OR bid_4 IS NOT NULL OR bid_5 IS NOT NULL OR minimal_bid IS NOT NULL
  ) NOT VALID;

-- 3c. Los dos precios de una misma fila no pueden diferir por un factor
--     absurdo. Ver el razonamiento largo en la cabecera.
ALTER TABLE public.pricing_observations
  DROP CONSTRAINT IF EXISTS ck_po_precios_coherentes;
ALTER TABLE public.pricing_observations
  ADD CONSTRAINT ck_po_precios_coherentes CHECK (
    recommended_price IS NULL
    OR price_without_discount IS NULL
    OR price_without_discount <= 0
    OR recommended_price <= price_without_discount * 50
  ) NOT VALID;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN — correr DESPUÉS de aplicar
--
--   -- 1. No debe quedar ninguna fila sin precio y sin marca:
--   SELECT count(*) FROM pricing_observations
--    WHERE no_data = false
--      AND COALESCE(price_without_discount,0) <= 0
--      AND COALESCE(recommended_price,0) <= 0
--      AND COALESCE(price_with_discount,0) <= 0
--      AND bid_1 IS NULL AND bid_2 IS NULL AND bid_3 IS NULL
--      AND bid_4 IS NULL AND bid_5 IS NULL AND minimal_bid IS NULL;
--   -- esperado: 0
--
--   -- 2. No debe quedar ningún serial de Excel:
--   SELECT count(*) FROM pricing_observations
--    WHERE country='Peru' AND recommended_price BETWEEN 40000 AND 60000;
--   -- esperado: 0
--
--   -- 3. Validar las dos constraints diferidas (NO bloquea escrituras):
--   ALTER TABLE public.pricing_observations VALIDATE CONSTRAINT ck_po_precio_o_sin_oferta;
--   ALTER TABLE public.pricing_observations VALIDATE CONSTRAINT ck_po_precios_coherentes;
--
--   -- 4. Refrescar agregados y comparar que el dashboard no se movió:
--   SELECT refresh_ci_aggregates(4000);
-- ════════════════════════════════════════════════════════════════════════
