-- ════════════════════════════════════════════════════════════════════════
-- 205_validate_country_setup_gate_completo.sql — el gate por sección solo no
-- alcanzaba: falta el país.
--
-- DE DÓNDE SALE
-- La mig 200 le puso a `validate_country_setup` un gate por SECCIÓN
-- (`can_access_section('config')`) y omitió el de país a propósito, con este
-- argumento escrito: la función existe para validar un país que se está
-- creando, y exigir acceso previo a ese país es una contradicción.
--
-- El panel de escépticos de la tercera revisión lo tumbó, con repro ejecutado
-- contra la mig 200 YA aplicada:
--
--   rol {"sections":["config"],"countries":["Peru"]}
--   is_admin() = f · can_access_country('Colombia') = f · can_access_section('config') = t
--   → validate_country_setup('Colombia') DEVUELVE el diagnóstico de Colombia
--
-- O sea que un usuario de Perú lee cuántas reglas de bot, cuántos umbrales y
-- —lo que más importa— el VOLUMEN de `pricing_observations` de un país al que
-- no tiene acceso. CLAUDE.md §3 es explícito: "un `count` … ya es una fuga".
--
-- ── POR QUÉ EL ARGUMENTO ORIGINAL ERA MALO ─────────────────────────────
-- Era verdadero en el hecho —el CountryWizard pasa un país recién creado que
-- todavía no está en los permisos de nadie— y falso en la conclusión. De que
-- un flujo necesite saltarse el chequeo no se sigue que el chequeo sobre.
--
-- Quién crea países en la práctica: un admin, que pasa `can_access_country`
-- para todo. El caso que queda afuera es un NO admin con sección `config`
-- creando un país nuevo: su paso final de validación va a rebotar hasta que un
-- admin le agregue ese país desde Accesos. Es un paso más en un flujo que se
-- corre un puñado de veces por año, a cambio de cerrar una lectura cruzada
-- entre países que hoy está abierta todo el tiempo.
--
-- Se elige el default seguro y se deja el costo escrito, en vez de dejar la
-- fuga abierta por comodidad de un flujo raro.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

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
  -- LOS DOS EJES, no uno.
  --   · sección: quién puede configurar países
  --   · país:    sobre CUÁL puede hacerlo
  -- La mig 200 puso solo el primero y eso dejaba a un usuario de Perú leyendo
  -- el diagnóstico de Colombia, incluido el conteo de observaciones.
  IF NOT can_access_section('config') THEN
    RAISE EXCEPTION 'access_denied: validar la configuración de un país requiere la sección Configuración'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

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

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- Con un rol {"sections":["config"],"countries":["Peru"]}:
--   validate_country_setup('Peru')     → 6 filas
--   validate_country_setup('Colombia') → access_denied (42501)
-- Con un admin: los dos funcionan.
-- Con anon: sin EXECUTE.
--
-- ⚠️ EL CountryWizard. Su paso 10 llama a esta función con el país recién
-- creado. Para un admin sigue funcionando (can_access_country cortocircuita en
-- is_admin). Para un NO admin con `config`, el panel de validación va a rebotar
-- hasta que un admin le agregue ese país desde Accesos — y como el call site
-- ignora el `error`, va a verse como un panel vacío, no como un fallo. Vale la
-- pena arreglar ese call site para que muestre el motivo.
