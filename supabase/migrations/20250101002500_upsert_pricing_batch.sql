-- RPC atómica para reemplazar datos de un upload manual.
-- DELETE + INSERT corren en la misma transacción PL/pgSQL → si el INSERT falla,
-- el DELETE se revierte y los datos originales quedan intactos.

CREATE OR REPLACE FUNCTION upsert_pricing_batch(
  p_rows        jsonb,
  p_city_ranges jsonb,   -- [{city, min_date, max_date}]
  p_batch_id    uuid,
  p_filename    text,
  p_row_count   int
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_range jsonb;
BEGIN
  -- Paso 1: Borrar filas existentes del mismo rango fecha+ciudad (atómico con el INSERT)
  FOR v_range IN SELECT * FROM jsonb_array_elements(p_city_ranges) LOOP
    DELETE FROM pricing_observations
    WHERE city         = v_range->>'city'
      AND data_source  = 'manual'
      AND observed_date BETWEEN (v_range->>'min_date')::date
                             AND (v_range->>'max_date')::date;
  END LOOP;

  -- Paso 2: Insertar todas las filas nuevas
  INSERT INTO pricing_observations
  SELECT * FROM jsonb_populate_recordset(null::pricing_observations, p_rows);

  -- Paso 3: Registrar el batch de upload
  INSERT INTO upload_batches (id, filename, row_count, city)
  VALUES (p_batch_id, p_filename, p_row_count, 'multi')
  ON CONFLICT (id) DO NOTHING;

  RETURN p_row_count;
END;
$$;
