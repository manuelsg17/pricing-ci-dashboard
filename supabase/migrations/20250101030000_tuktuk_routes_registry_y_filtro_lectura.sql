-- ════════════════════════════════════════════════════════════════════════
-- Migración 219 — Registro de rutas TukTuk + filtro en la capa de LECTURA
--
-- CONTEXTO (2026-08-27):
--   Una ruta con tag de zona TukTuk está DISEÑADA para mototaxi (distancias
--   intra-distrito, configuración propia). Cuando el simulador cotiza esa
--   misma ruta como Economy/Comfort, Comfort+, Premier o XL, el precio que
--   devuelve NO representa un viaje de taxi real — contamina el promedio.
--
--   El gate de TukTuk existente (mig 113) es UNIDIRECCIONAL: solo descarta
--   filas que ya vienen como category='TukTuk' sin main_category+zone. El
--   caso inverso (ruta diseñada para TukTuk, cotizada como categoría de
--   taxi) pasa sin ningún control. Peor: el INSERT de mig 113 hace
--       CASE WHEN category='TukTuk' THEN zone ELSE NULL END
--   → borra la zona en las filas de taxi, dejándolas indistinguibles de una
--   ruta de taxi legítima. Por eso el 100% de las filas contaminadas tienen
--   zone IS NULL y no se pueden filtrar por zona.
--
--   Medición real en producción (2026-08-27), Lima, data_source='bot':
--     hasta 13-jul  →  0.0 % de la data de taxi contaminada
--     20-jul        →  2.4 %      27-jul →  24.0 %
--     03-ago        → 31.8 %      10-ago →  33.4 %
--     17-ago        → 67.0 %      24-ago →  79.3 %  (y creciendo)
--   El salto coincide con la activación de las zonas SJL/Carabayllo/
--   Ventanilla (24-jul). Cada zona TukTuk nueva multiplica la contaminación.
--
-- POR QUÉ EL FILTRO VA EN LECTURA Y NO EN UN TRIGGER DE ESCRITURA:
--   Un trigger BEFORE INSERT en pricing_observations cubriría todos los
--   caminos de entrada, pero vive en el camino de guardado de los hubs
--   (Ingresar CI, lotes de 200) y del upsert masivo del bot. La clase de bug
--   más cara y repetida de este proyecto es trabajo de hub que falla al
--   guardar en silencio. Y el trigger NO aporta corrección: filtrando en
--   v_effective_price el análisis ya queda limpio aunque la fila sucia entre.
--   Decisión explícita del user (2026-08-27): descartar en lectura, no
--   arriesgar el camino de escritura del simulador.
--
-- POR QUÉ UNA TABLA FÍSICA Y NO UNA SUBQUERY SOBRE pricing_observations:
--   1) Rendimiento: un anti-join contra un DISTINCT sobre una tabla
--      particionada de 1.6M+ filas, dentro de la vista que TODO el análisis
--      atraviesa y que refresh_ci_aggregates() recorre 3 veces por corrida.
--      pg_cron ya fue el 100% del Disk IO una vez (mig 162).
--   2) Semántica estable: con subquery, el conjunto de rutas cambiaría solo
--      con el tiempo (una ruta se vuelve "TukTuk" retroactivamente al
--      aparecer su primera observación) → los números del dashboard podrían
--      moverse sin que nadie tocara nada. Con tabla, el criterio es un dato
--      explícito, auditable y editable.
--
-- SEGURIDAD:
--   · RLS habilitada en el MISMO cambio que crea la tabla (deny by default).
--   · SELECT abierto a 'authenticated' — JUSTIFICACIÓN de catálogo compartido
--     exigida por CLAUDE.md §3: son direcciones de calle usadas para simular
--     precios, no contienen dato de usuario ni información por país. Además
--     es OBLIGATORIO que todo usuario autenticado pueda leerlas: como
--     v_effective_price es security_invoker=true, el NOT EXISTS se evalúa con
--     los permisos de QUIEN CONSULTA. Si RLS ocultara filas de tuktuk_routes
--     a un usuario, el NOT EXISTS daría TRUE y la fila contaminada NO se
--     filtraría para él — el filtro fallaría en silencio.
--   · Escritura solo admin (can_edit()) — es un catálogo administrativo.
--   · Sin grants para 'anon'.
--
-- ROLLBACK: CREATE OR REPLACE VIEW v_effective_price sin el WHERE final
--   (la definición previa está íntegra en este archivo, ver comentario al
--   pie), y DROP TABLE public.tuktuk_routes.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1) Registro explícito de rutas TukTuk
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tuktuk_routes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  country    text        NOT NULL DEFAULT 'Peru',
  city       text        NOT NULL DEFAULT 'Lima',
  point_a    text        NOT NULL,
  point_b    text        NOT NULL,
  zone       text        NOT NULL,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tuktuk_routes_par_unico UNIQUE (point_a, point_b)
);

COMMENT ON TABLE public.tuktuk_routes IS
  'Rutas diseñadas EXCLUSIVAMENTE para TukTuk (mig 219). Toda observación de '
  'una categoría de taxi sobre estas rutas se excluye del análisis en '
  'v_effective_price: las distancias/configuración son de mototaxi y el '
  'precio de taxi ahí no representa un viaje real. Para dar de alta una zona '
  'TukTuk nueva, re-ejecutar el INSERT de siembra de esta migración '
  '(es ON CONFLICT DO NOTHING, idempotente).';

-- El índice del UNIQUE (point_a, point_b) es exactamente el que usa el
-- anti-join de v_effective_price — no hace falta uno adicional.

-- Siembra desde lo ya observado. Se hace por SELECT y no con 352 filas
-- hardcodeadas para que sea idempotente y se adapte al entorno (en local,
-- sin datos, deja la tabla vacía y la vista se comporta como antes).
-- Verificado en prod 2026-08-27: 352 rutas distintas, 0 rutas en más de una
-- zona (por eso UNIQUE(point_a, point_b) es seguro), 0 filas TukTuk sin ruta,
-- TukTuk existe solo en Lima/Peru.
INSERT INTO public.tuktuk_routes (country, city, point_a, point_b, zone, notes)
SELECT DISTINCT ON (po.point_a, po.point_b)
       COALESCE(po.country, 'Peru'),
       COALESCE(po.city, 'Lima'),
       po.point_a,
       po.point_b,
       po.zone,
       'siembra mig 219 desde pricing_observations'
FROM public.pricing_observations po
WHERE po.category = 'TukTuk'
  AND po.zone IS NOT NULL
  AND po.zone <> ''
  AND po.point_a IS NOT NULL
  AND po.point_b IS NOT NULL
ORDER BY po.point_a, po.point_b, po.observed_date DESC
ON CONFLICT (point_a, point_b) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- 2) Seguridad: RLS + grants mínimos (deny by default)
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.tuktuk_routes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tuktuk_routes_select ON public.tuktuk_routes;
CREATE POLICY tuktuk_routes_select ON public.tuktuk_routes
  FOR SELECT TO authenticated
  USING (true);   -- catálogo compartido — justificación en la cabecera

DROP POLICY IF EXISTS tuktuk_routes_insert ON public.tuktuk_routes;
CREATE POLICY tuktuk_routes_insert ON public.tuktuk_routes
  FOR INSERT TO authenticated
  WITH CHECK (can_edit());

DROP POLICY IF EXISTS tuktuk_routes_update ON public.tuktuk_routes;
CREATE POLICY tuktuk_routes_update ON public.tuktuk_routes
  FOR UPDATE TO authenticated
  USING (can_edit()) WITH CHECK (can_edit());

DROP POLICY IF EXISTS tuktuk_routes_delete ON public.tuktuk_routes;
CREATE POLICY tuktuk_routes_delete ON public.tuktuk_routes
  FOR DELETE TO authenticated
  USING (can_edit());

REVOKE ALL ON public.tuktuk_routes FROM anon;
GRANT SELECT ON public.tuktuk_routes TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.tuktuk_routes TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 3) Filtro en la capa de lectura
--    Definición IDÉNTICA a la vigente (mig previa) + el WHERE final.
--    Mantiene security_invoker=true (verificado en prod antes del cambio).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_effective_price
WITH (security_invoker = true) AS
SELECT
  po.id,
  po.country,
  po.city,
  po.year,
  po.week,
  po.observed_date,
  po.observed_time,
  po.time_of_day,
  po.category,
  po.zone,
  po.competition_name,
  po.distance_km,
  po.distance_bracket,
  po.surge,
  po.rush_hour,
  po.timeslot,
  po.data_source,
  po.upload_batch_id,
  CASE
    WHEN po.competition_name = 'InDrive'::text
     AND (COALESCE(po.bid_1, 0::numeric) + COALESCE(po.bid_2, 0::numeric)
        + COALESCE(po.bid_3, 0::numeric) + COALESCE(po.bid_4, 0::numeric)
        + COALESCE(po.bid_5, 0::numeric)) > 0::numeric
    THEN (COALESCE(NULLIF(po.bid_1, 0::numeric), 0::numeric)
        + COALESCE(NULLIF(po.bid_2, 0::numeric), 0::numeric)
        + COALESCE(NULLIF(po.bid_3, 0::numeric), 0::numeric)
        + COALESCE(NULLIF(po.bid_4, 0::numeric), 0::numeric)
        + COALESCE(NULLIF(po.bid_5, 0::numeric), 0::numeric))
        / NULLIF(
            CASE WHEN COALESCE(po.bid_1, 0::numeric) > 0::numeric THEN 1 ELSE 0 END +
            CASE WHEN COALESCE(po.bid_2, 0::numeric) > 0::numeric THEN 1 ELSE 0 END +
            CASE WHEN COALESCE(po.bid_3, 0::numeric) > 0::numeric THEN 1 ELSE 0 END +
            CASE WHEN COALESCE(po.bid_4, 0::numeric) > 0::numeric THEN 1 ELSE 0 END +
            CASE WHEN COALESCE(po.bid_5, 0::numeric) > 0::numeric THEN 1 ELSE 0 END, 0)::numeric
    ELSE COALESCE(po.price_without_discount, po.recommended_price)
  END AS effective_price
FROM public.pricing_observations po
-- ★ mig 219 — una ruta de TukTuk es SOLO para TukTuk.
--   Se conserva toda la data TukTuk; se descarta la de cualquier otra
--   categoría sobre esas mismas rutas.
--   Fail-open deliberado: si point_a/point_b fuese NULL no se puede probar
--   que sea ruta TukTuk y la fila se conserva (verificado en prod: 0% de las
--   filas de taxi de Lima desde 24-jul tienen ruta nula, así que hoy el
--   filtro es 100% efectivo; el fail-open protege contra descartar data
--   buena si el bot dejara de mandar la ruta).
WHERE po.category = 'TukTuk'
   OR NOT EXISTS (
        SELECT 1
        FROM public.tuktuk_routes tr
        WHERE tr.point_a = po.point_a
          AND tr.point_b = po.point_b
      );

COMMENT ON VIEW public.v_effective_price IS
  'Precio efectivo por observación (InDrive: promedio de bids reales si hay; '
  'resto: price_without_discount). mig 219: excluye observaciones de '
  'categorías de taxi sobre rutas registradas en tuktuk_routes.';

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- ROLLBACK (definición previa de la vista, sin el WHERE de mig 219):
--   CREATE OR REPLACE VIEW public.v_effective_price
--   WITH (security_invoker = true) AS
--   SELECT id, country, city, year, week, observed_date, observed_time,
--          time_of_day, category, zone, competition_name, distance_km,
--          distance_bracket, surge, rush_hour, timeslot, data_source,
--          upload_batch_id, <mismo CASE de effective_price>
--   FROM pricing_observations;
--   DROP TABLE public.tuktuk_routes;
-- ════════════════════════════════════════════════════════════════════════
