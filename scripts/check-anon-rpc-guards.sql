-- ════════════════════════════════════════════════════════════════════════
-- check-anon-rpc-guards.sql — ninguna RPC ejecutable sin login puede devolver
-- datos.
--
--   npm run check:anon-rpcs
--
-- POR QUÉ EXISTE
-- `check:section-grants` cruza el grafo de imports de cada pantalla contra el
-- mapa de permisos: verifica que todo lo que la app LLAMA sea alcanzable. Es
-- el chequeo correcto para el bug que vino a matar (una pantalla que se abre y
-- guarda en silencio contra una base que no la deja).
--
-- Por diseño NO puede ver una RPC que la app NO llama — y ahí estaban tres
-- funciones SECURITY DEFINER ejecutables por `anon` sin ningún chequeo,
-- encontradas el 2026-08-02 y probadas por HTTP con la anon key:
--
--   · get_dashboard_data_weekly_with_freeze → HTTP 200. Los promedios
--     semanales por competidor. En producción, solo para Perú: 72.741 filas,
--     15 competidores, 10 ciudades, 56 semanas. Código muerto desde la mig 43.
--   · validate_country_setup → HTTP 200. Diagnóstico operativo del país.
--   · list_catalog_extras → HTTP 200. El catálogo, sin filtro de país.
--
-- La anon key viaja en el bundle del cliente: es pública por diseño. O sea que
-- "alcanzable por anon" significa "alcanzable por cualquiera que abra el sitio".
--
-- DOS NIVELES, a propósito
-- Un chequeo que grita por las 30 funciones con grant a anon se ignora a la
-- semana. Uno que solo mira el grant no distingue lo explotable de la deuda.
-- Entonces:
--
--   NIVEL 1 · BLOQUEANTE — DEFINER + anon + el cuerpo NO nombra ningún guard.
--     Devuelve datos a cualquiera. Tiene que ser 0.
--
--   NIVEL 2 · DEUDA — DEFINER + anon pero CON guard interno que rechaza.
--     No es explotable, pero el grant sobra: CLAUDE.md §3 dice que RLS y GRANT
--     son controles complementarios, no alternativos, y el permiso se evalúa
--     ANTES que la política. Se informa el conteo, no falla.
--
-- Las funciones `RETURNS trigger` quedan fuera de los dos niveles: PostgREST no
-- las expone (verificado — responde PGRST202, no es una suposición).
--
-- LÍMITE CONOCIDO DE LA HEURÍSTICA
-- El nivel 1 mira el TEXTO del cuerpo. Una función cuyo guard FILTRA en el
-- WHERE en vez de RECHAZAR con RAISE cuenta como "con guard" y cae al nivel 2,
-- aunque a un anónimo le devuelva las filas globales. Es deliberado: preferimos
-- un chequeo sin falsos positivos que uno que nadie corra. El nivel 2 existe
-- justamente para que esos casos no queden invisibles.
-- ════════════════════════════════════════════════════════════════════════

\pset pager off

-- Sin esto psql imprime el ERROR del RAISE de abajo y SALE 0 igual: el
-- chequeo no podría fallar nunca. Es la mitad que hace que sirva en CI.
\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION pg_temp.tiene_guard(p_oid oid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT pg_get_functiondef(p_oid) ~* 'require_country_access|can_access_country|can_access_section|is_admin|can_edit|can_write_table|auth\.uid|auth\.email';
$$;

\echo ''
\echo '════ NIVEL 1 · BLOQUEANTE — RPCs que le devuelven datos a un anónimo ════'

SELECT p.proname                                AS "RPC",
       pg_get_function_identity_arguments(p.oid) AS "argumentos",
       p.proconfig IS NULL                       AS "además sin search_path"
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef
  AND has_function_privilege('anon', p.oid, 'EXECUTE')
  AND pg_get_function_result(p.oid) <> 'trigger'
  AND NOT pg_temp.tiene_guard(p.oid)
ORDER BY p.proname;

\echo '(vacío = pasa. Cada fila es una RPC ejecutable por cualquiera sin login.)'
\echo ''
\echo '════ NIVEL 2 · DEUDA — grants a anon que sobran (backstopeados por el guard) ════'

SELECT count(*) AS "funciones con grant innecesario a anon"
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef
  AND has_function_privilege('anon', p.oid, 'EXECUTE')
  AND pg_get_function_result(p.oid) <> 'trigger'
  AND pg_temp.tiene_guard(p.oid);

\echo 'No es explotable —el guard interno rechaza— pero deny by default pide sacarlo.'
\echo 'Para listarlas y generar el REVOKE, ver el comentario al pie de este archivo.'
\echo ''

-- ── EL CHEQUEO TIENE QUE PODER FALLAR ─────────────────────────────────
-- Agregado 2026-08-05, al meter este script al pipeline de deploy.
--
-- Hasta acá el archivo SELECTeaba y listo: psql sale 0 aunque el nivel 1
-- devuelva filas. O sea que como paso de CI habría pasado SIEMPRE, incluso con
-- una RPC entregándole datos a cualquiera sin login. Un guard que no puede
-- fallar es peor que no tenerlo, porque además da confianza.
--
-- El nivel 1 ya estaba declarado BLOQUEANTE en la cabecera ("tiene que ser 0");
-- esto lo hace cierto. El nivel 2 sigue informándose sin fallar, como dice ahí.
DO $$
DECLARE
  v_n     int;
  v_lista text;
BEGIN
  SELECT count(*), string_agg(p.proname, ', ' ORDER BY p.proname)
    INTO v_n, v_lista
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege('anon', p.oid, 'EXECUTE')
    AND pg_get_function_result(p.oid) <> 'trigger'
    AND NOT pg_temp.tiene_guard(p.oid);

  IF v_n > 0 THEN
    RAISE EXCEPTION E'\n  ✗ NIVEL 1: % RPC(s) le devuelven datos a un anónimo sin login: %\n    Ver "CÓMO ARREGLAR UN HALLAZGO DE NIVEL 1" al pie de este archivo.',
      v_n, v_lista;
  END IF;
  RAISE NOTICE '  ✓ nivel 1 en 0 — ninguna RPC le contesta a un anónimo';
END $$;

-- ── CÓMO ARREGLAR UN HALLAZGO DE NIVEL 1 ──────────────────────────────
--   1. ¿La llama alguien?  git log --all -S '<nombre>' -- src/
--      Si no devuelve nada → borrarla. Elimina la superficie en vez de
--      custodiarla, y no puede romper ningún cliente.
--   2. Si la app la llama → agregarle el guard y cerrar el grant:
--        REVOKE ALL ON FUNCTION public.<f>(<args>) FROM PUBLIC, anon;
--        GRANT EXECUTE ON FUNCTION public.<f>(<args>) TO authenticated;
--
-- ── PARA SALDAR EL NIVEL 2 (genera el REVOKE de todas de una) ──────────
--   SELECT format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon;',
--                 p.proname, pg_get_function_identity_arguments(p.oid))
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.prosecdef
--      AND has_function_privilege('anon', p.oid, 'EXECUTE')
--      AND pg_get_function_result(p.oid) <> 'trigger'
--    ORDER BY 1;
--   Revisar la lista ANTES de correrla: si alguna función tiene que seguir
--   siendo pública, dejarla afuera y documentar por qué.
