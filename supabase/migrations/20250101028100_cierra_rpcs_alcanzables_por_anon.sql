-- ════════════════════════════════════════════════════════════════════════
-- 200_cierra_rpcs_alcanzables_por_anon.sql — tres RPCs SECURITY DEFINER que
-- un ANÓNIMO puede ejecutar por HTTP, sin login y sin chequeo de país.
--
-- ⚠️  ESTA MIGRACIÓN NO ESTÁ APLICADA. Requiere autorización explícita del
--     user para ESA aplicación puntual (CLAUDE.md §3).
--
-- CÓMO SE ENCONTRÓ
-- Barrido sistemático, no lectura a ojo: todas las funciones `prosecdef` con
-- EXECUTE para `anon` cuyo cuerpo NO menciona ningún guard
-- (require_country_access / can_access_country / can_access_section /
-- is_admin / can_edit / can_write_table / auth.uid / auth.email).
--
--   SELECT p.proname
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname='public' AND p.prosecdef
--      AND has_function_privilege('anon', p.oid, 'EXECUTE')
--      AND pg_get_functiondef(p.oid) !~* 'require_country_access|can_access_country|…';
--
-- Dieron 11. Ocho son funciones de trigger (`RETURNS trigger`): PostgREST no
-- las expone y devuelve PGRST202 — verificado, no son alcanzables. Las otras
-- tres sí, y se probaron por HTTP real contra Supabase local con la anon key.
--
-- POR QUÉ EL MODELO GENÉRICO NO LAS CUBRIÓ
-- Las migs 187-193 hicieron genéricos los permisos, y `check:section-grants`
-- verifica que todo lo que la app LLAMA sea alcanzable. Estas tres se cayeron
-- del barrido justamente por lo contrario: dos casi no se llaman y una no se
-- llama nunca, así que ninguna herramienta las miraba. El hueco de la
-- herramienta es tan importante como el de las funciones — ver al pie.
--
-- ── 1 · get_dashboard_data_weekly_with_freeze — P0, se BORRA ────────────
-- Es la peor. SECURITY DEFINER, sin ningún guard, y lee `v_bracket_weekly_avg`
-- —los promedios semanales por competidor— con privilegios del dueño, así que
-- se saltea la RLS y los grants de las tablas agregadas.
--
-- Probado por HTTP contra local con la anon key:
--     POST /rest/v1/rpc/get_dashboard_data_weekly_with_freeze  → HTTP 200
--     96 filas: {"competition_name":"Didi","avg_price":33.35,…}
-- Su hermana con guard, mismo payload: HTTP 401 access_denied.
--
-- Tamaño real de lo expuesto en PRODUCCIÓN, solo para Perú:
--     72.741 filas · 15 competidores · 10 ciudades · 56 semanas
--     desde 2025-07-01 hasta hoy
-- Es el histórico completo de inteligencia competitiva, y la anon key viaja
-- en el bundle del cliente: cualquiera que abra el sitio la tiene.
--
-- SE BORRA en vez de arreglarse porque es CÓDIGO MUERTO: no la llama el
-- frontend actual ni la llamó nunca. Verificado con
--     git log --all -S get_dashboard_data_weekly_with_freeze -- src/
-- que no devuelve un solo commit. Nació en la mig 43 y la 158 le puso el
-- search_path, pero el gate por país nunca llegó.
--
-- Borrar es mejor que gatear: elimina la superficie en vez de custodiarla, y
-- no puede romper ningún cliente porque ninguno la invoca. Si preferís
-- conservarla, la alternativa conservadora está al pie de este archivo.
--
-- ── 2 · validate_country_setup — P1, se GATEA POR SECCIÓN ──────────────
-- La llama el frontend, así que NO se puede borrar: se le agrega el guard.
--
-- ⚠️ CORRECCIÓN A UNA VERSIÓN ANTERIOR DE ESTE ARCHIVO.
-- Este comentario decía: "se llama desde la pantalla de Config con el país
-- activo del usuario, así que el guard nunca se dispara en el uso normal".
-- ERA FALSO, y el fix que justificaba —`require_country_access`— rompía el
-- flujo real.
--
-- El único call site es `src/components/config/CountryWizard.jsx` y pasa
-- `draft.country_key`: el país que se ACABA DE CREAR, que por definición
-- todavía no está en `roles.permissions.countries` de nadie. Con
-- `require_country_access` el paso final del wizard rebota siempre para
-- cualquiera que no sea admin (el admin pasa porque `can_access_country`
-- cortocircuita en `is_admin()`).
--
-- Y rebotaba EN SILENCIO: el call site hace `const { data: vData } = await
-- sb.rpc(...)` sin mirar `error`, así que el panel de validación queda vacío y
-- el wizard dice que salió bien. Exactamente el fallo mudo que CLAUDE.md §3
-- nombra.
--
-- El gate correcto es POR SECCIÓN, que es además lo que CLAUDE.md §3 pide
-- textualmente: "una RPC SECURITY DEFINER llamada desde una pantalla NO debe
-- exigir is_admin() salvo que la pantalla entera sea adminOnly; va por
-- can_access_section('<sección>')". `/config` no es adminOnly.
--
-- El chequeo de país se OMITE a propósito, y esta vez con motivo: la función
-- existe para validar el setup de un país que se está creando. Exigir acceso
-- previo a ese país es una contradicción con su propósito. Quien puede
-- configurar países ya puede leer y escribir `country_config`; que además vea
-- el diagnóstico de uno no agrega ningún privilegio.
--
-- Sin login devuelve el diagnóstico operativo del país. Salida real de un
-- anónimo contra local:
--     bot_rules           | ok      | 15 reglas activas
--     bracket_weights     | ok      | 72 pesos con category=all …
--     distance_thresholds | ok      | 126 umbrales configurados
--     price_validation    | ok      | 5 reglas de outlier configuradas
--     watermark           | warning | sin watermark — …
--     observations        | ok      | 96 filas en pricing_observations
--
-- No son precios, pero sí la forma de la operación: cuántas reglas de bot hay,
-- cuántos umbrales, y el VOLUMEN de observaciones por país. Es reconocimiento
-- gratis, y `p_country` no se valida contra nada.
--
-- ── 3 · list_catalog_extras — P3, se GATEA por higiene ─────────────────
-- Mismo patrón, impacto hoy nulo: `catalog_extras` tiene 0 filas en
-- producción, así que no hay nada que filtrar. Se cierra igual, porque el día
-- que alguien la puebla el agujero se abre solo y nadie se va a acordar.
--
-- Su WHERE ya es `country IS NULL OR country = p_country`, o sea que mezcla
-- catálogo global (country NULL) con el del país pedido. El gate se agrega en
-- el mismo WHERE y no cambia la cardinalidad: si el usuario no tiene el país,
-- solo ve las filas globales.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1 · Borrar la RPC muerta que filtra los precios ─────────────────────
DROP FUNCTION IF EXISTS public.get_dashboard_data_weekly_with_freeze(
  text, text, text, text, boolean, integer, integer, integer, integer, text, text[], boolean
);

-- ── 2 · validate_country_setup: guard + fuera anon ──────────────────────
-- Firma IDÉNTICA a la de producción → `CREATE OR REPLACE` reemplaza de verdad
-- y NO crea un overload (CLAUDE.md §3: un overload deja a PostgREST sin poder
-- elegir, PGRST203, y rompe la pantalla en silencio).
CREATE OR REPLACE FUNCTION public.validate_country_setup(p_country text)
 RETURNS TABLE(check_name text, status text, detail text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_bot_rules           int;
  v_bracket_weights_all int;
  v_bracket_weights_cat int;
  v_distance_thresh     int;
  v_price_val_rules     int;
  v_watermark           timestamptz;
  v_pricing_obs         int;
BEGIN
  -- LO ÚNICO QUE CAMBIA. Es SECURITY DEFINER y bypasea RLS: sin esto,
  -- `p_country` era texto libre que cualquier ANÓNIMO podía consultar.
  --
  -- Por SECCIÓN y no por país: la llama el CountryWizard con un país recién
  -- creado, que todavía no está en los permisos de nadie (ver la cabecera).
  IF NOT can_access_section('config') THEN
    RAISE EXCEPTION 'access_denied: validar la configuración de un país requiere la sección Configuración'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT count(*) INTO v_bot_rules           FROM bot_rules             WHERE country = p_country AND active;
  SELECT count(*) INTO v_bracket_weights_all FROM bracket_weights       WHERE country = p_country AND category = 'all';
  SELECT count(*) INTO v_bracket_weights_cat FROM bracket_weights       WHERE country = p_country AND category != 'all';
  SELECT count(*) INTO v_distance_thresh     FROM distance_thresholds   WHERE country = p_country;
  SELECT count(*) INTO v_price_val_rules     FROM price_validation_rules WHERE country = p_country;
  SELECT last_synced_at INTO v_watermark     FROM bot_sync_watermark    WHERE country = p_country;
  SELECT count(*) INTO v_pricing_obs         FROM pricing_observations  WHERE country = p_country;

  RETURN QUERY VALUES
    ('bot_rules',           CASE WHEN v_bot_rules         >= 4 THEN 'ok' WHEN v_bot_rules         > 0 THEN 'warning' ELSE 'error' END,
                            format('%s reglas activas', v_bot_rules)),
    ('bracket_weights',     CASE WHEN v_bracket_weights_all >= 6 THEN 'ok' WHEN v_bracket_weights_all > 0 THEN 'warning' ELSE 'error' END,
                            format('%s pesos con category=all (mínimo 6) + %s pesos por categoría',
                                   v_bracket_weights_all, v_bracket_weights_cat)),
    ('distance_thresholds', CASE WHEN v_distance_thresh   > 0  THEN 'ok' ELSE 'error' END,
                            format('%s umbrales de distancia configurados', v_distance_thresh)),
    ('price_validation',    CASE WHEN v_price_val_rules   > 0  THEN 'ok' ELSE 'warning' END,
                            format('%s reglas de outlier configuradas', v_price_val_rules)),
    ('watermark',           CASE WHEN v_watermark         IS NOT NULL THEN 'ok' ELSE 'warning' END,
                            COALESCE(v_watermark::text, 'sin watermark — primera corrida procesará todo el histórico')),
    ('observations',        CASE WHEN v_pricing_obs       > 0  THEN 'ok' ELSE 'warning' END,
                            format('%s filas en pricing_observations', v_pricing_obs));
END;
$function$;

REVOKE ALL ON FUNCTION public.validate_country_setup(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.validate_country_setup(text) TO authenticated;

-- ── 3 · list_catalog_extras: filtro por país + fuera anon ───────────────
-- Sigue en LANGUAGE sql a propósito. Convertirla a plpgsql obligaría a aliasar
-- cada columna: `country`, `kind` y `value` chocan con los nombres del
-- RETURNS TABLE y darían 42702 — el error exacto que rompió
-- get_discount_stats desde la mig 166 hasta la 190.
CREATE OR REPLACE FUNCTION public.list_catalog_extras(p_country text DEFAULT NULL::text)
 RETURNS TABLE(kind text, value text, country text, color text, bot_apps text[], aliases text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '5s'
AS $function$
  SELECT kind, value, country, color, bot_apps, aliases
  FROM catalog_extras
  -- El catálogo GLOBAL (country NULL) es legítimamente compartido entre
  -- países y se sigue viendo. Lo que se cierra es leer el catálogo de un país
  -- ajeno pasándolo por parámetro.
  WHERE country IS NULL
     OR (country = p_country AND can_access_country(country))
  ORDER BY kind, value;
$function$;

REVOKE ALL ON FUNCTION public.list_catalog_extras(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_catalog_extras(text) TO authenticated;

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- 1) El barrido tiene que quedar SIN funciones alcanzables por anon y sin
--    guard, salvo las de trigger (que PostgREST no expone):
--
--    SELECT p.proname, pg_get_function_result(p.oid) AS retorna
--      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--     WHERE n.nspname = 'public'
--       AND p.prosecdef
--       AND has_function_privilege('anon', p.oid, 'EXECUTE')
--       AND pg_get_functiondef(p.oid) !~* 'require_country_access|can_access_country|can_access_section|is_admin|can_edit|can_write_table|auth.uid|auth.email'
--     ORDER BY 1;
--    → solo filas con retorna = 'trigger'
--
-- 2) La RPC borrada ya no existe (y PostgREST devuelve PGRST202):
--    SELECT count(*) FROM pg_proc WHERE proname = 'get_dashboard_data_weekly_with_freeze';  → 0
--
-- 3) Por HTTP, con la anon key, las tres tienen que rebotar. Y con un JWT de
--    un hub de Perú, `validate_country_setup('Colombia')` también.
--
-- 4) Sin overloads nuevos (PGRST203):
--    SELECT proname, count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--     WHERE n.nspname='public' AND proname IN ('validate_country_setup','list_catalog_extras')
--     GROUP BY 1 HAVING count(*) > 1;   → 0 filas
--
-- 5) La app sigue funcionando: `validate_country_setup` se llama desde la
--    pantalla de Config con el país activo del usuario, así que el guard nunca
--    se dispara en el uso normal. Verificar en navegador contra local.
--
-- ── ALTERNATIVA CONSERVADORA para el punto 1 ──────────────────────────
-- Si preferís NO borrar `get_dashboard_data_weekly_with_freeze` (por ejemplo
-- porque un cliente externo la use sin que figure en este repo), reemplazá el
-- DROP de arriba por esto — mismo efecto de cierre, conservando la función:
--
--   REVOKE ALL ON FUNCTION public.get_dashboard_data_weekly_with_freeze(
--     text,text,text,text,boolean,integer,integer,integer,integer,text,text[],boolean
--   ) FROM PUBLIC, anon;
--   GRANT EXECUTE ON FUNCTION public.get_dashboard_data_weekly_with_freeze(
--     text,text,text,text,boolean,integer,integer,integer,integer,text,text[],boolean
--   ) TO authenticated;
--
-- OJO: eso cierra el acceso anónimo pero NO el cruce de países entre usuarios
-- autenticados. Para eso hay que agregarle el filtro por país en los dos
-- brazos del UNION, con el mismo criterio que `list_catalog_extras` de arriba.
--
-- ── EL HUECO DE LA HERRAMIENTA, que importa más que estas 3 funciones ──
-- `check:section-grants` cruza el grafo de imports de cada pantalla contra el
-- mapa y contra pg_proc: verifica que lo que la app LLAMA sea alcanzable. Por
-- diseño no puede ver una RPC que la app NO llama, que es exactamente donde
-- estaban estas tres.
--
-- Falta el chequeo simétrico: "toda función SECURITY DEFINER alcanzable por
-- anon debe tener un guard, o ser de trigger". Es la query del punto 1 de la
-- verificación, y debería correr en el checklist §7 al lado de
-- `check:rls-drift`. Sin eso, la próxima RPC que nazca sin gate vuelve a
-- quedar invisible hasta que alguien la busque a mano.
