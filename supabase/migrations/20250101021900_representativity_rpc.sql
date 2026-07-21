-- ════════════════════════════════════════════════════════════════════════
-- Migración 138 — RPC get_representativity para el panel de representatividad
--
-- CONTEXTO 2026-07-21:
--   Panel nuevo en la ventana principal del dashboard que muestra, para la
--   SEMANA ISO EN CURSO, cuántas muestras tiene cada celda
--   (ciudad × categoría × competidor × bracket) separando lo que genera el BOT
--   de lo que generan las APPS (carga manual de los hubs). Sirve para saber si
--   el número que ve MS&E es representativo y dónde reforzar.
--
--   Umbrales (definidos con la variabilidad real de Perú, CV≈0.17 estándar /
--   0.19 InDrive, a ±10% piso / ±5% óptimo — ver lib/representativity.js):
--     · estándar: piso 10 / óptimo 40 muestras por celda por semana
--     · InDrive:  piso 14 / óptimo 55
--   Una celda es representativa si el TOTAL (bot + apps) llega al piso; el panel
--   además muestra de qué fuente depende. Umbrales y colores los aplica el
--   frontend (fácil de ajustar sin migrar).
--
-- ⚠ TIMEZONE (fix de la revisión adversarial): la semana ISO objetivo la
--   calcula el FRONTEND en la zona local del analista (getISOYearWeek()) y la
--   pasa como p_year/p_week — igual que el resto de las RPCs del dashboard, que
--   reciben la semana ya calculada en el cliente. Así se evita el sesgo de
--   usar current_date del servidor (UTC en Supabase) contra observed_date, que
--   es hora local Perú (UTC-5): sin esto, la tarde/noche del domingo en Perú
--   (ya lunes en UTC) apuntaría a la semana nueva casi vacía. Si p_year/p_week
--   no vienen (ej. llamada directa por SQL), se cae a hora America/Lima.
--
--   SECURITY DEFINER + require_country_access (mismo patrón que
--   get_indrive_summary): el analista solo ve países a los que tiene acceso.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_representativity(
  p_country text,
  p_year    int DEFAULT NULL,
  p_week    int DEFAULT NULL
)
 RETURNS TABLE(
   city             text,
   category         text,
   competition_name text,
   distance_bracket text,
   bot_n            bigint,
   manual_n         bigint
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- Fallback a hora local Perú si el cliente no pasó la semana (no UTC).
  v_year int := COALESCE(p_year, EXTRACT(isoyear FROM (now() AT TIME ZONE 'America/Lima')::date)::int);
  v_week int := COALESCE(p_week, EXTRACT(week    FROM (now() AT TIME ZONE 'America/Lima')::date)::int);
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  SELECT
    v.city,
    v.category,
    v.competition_name,
    v.distance_bracket,
    COALESCE(SUM(v.observation_count) FILTER (WHERE v.data_source = 'bot'), 0)::bigint    AS bot_n,
    COALESCE(SUM(v.observation_count) FILTER (WHERE v.data_source = 'manual'), 0)::bigint AS manual_n
  FROM v_bracket_weekly_avg_mv v
  WHERE v.country = p_country
    AND v.year = v_year
    AND v.week = v_week
  GROUP BY v.city, v.category, v.competition_name, v.distance_bracket;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_representativity(text, int, int) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   -- semana en curso (fallback Lima):
--   SELECT * FROM get_representativity('Peru') ORDER BY bot_n+manual_n LIMIT 20;
--   -- semana explícita (como la llama el frontend):
--   SELECT * FROM get_representativity('Peru', 2026, 30) ORDER BY bot_n+manual_n LIMIT 20;
-- ════════════════════════════════════════════════════════════════════════
