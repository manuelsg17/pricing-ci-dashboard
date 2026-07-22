-- Mig 145: ocultar "YangoComfort+" en Corp SOLO en "Ingresar CI".
--
-- Yango sacó del mercado la categoría Comfort+ en corporativo, así que el hub ya
-- no debe cargar ese competidor. Usamos el mismo mecanismo del ojo 👁 (ciHidden)
-- que oculta un competidor en la grilla de carga pero lo MANTIENE en el
-- dashboard/leyendas/histórico — así no se pierde la data histórica de
-- YangoComfort+ Corp, solo se deja de pedir a futuro. Reversible desde
-- Config → Países.
UPDATE country_config
SET cities = (
  SELECT jsonb_agg(
    CASE
      WHEN city->>'dbName' = 'Corp' THEN jsonb_set(
        city,
        '{categories}',
        (
          SELECT jsonb_agg(
            CASE
              WHEN cat->>'name' = 'Corp'
                THEN cat || jsonb_build_object('ciHidden', jsonb_build_array('YangoComfort+'))
              ELSE cat
            END
          )
          FROM jsonb_array_elements(city->'categories') cat
        )
      )
      ELSE city
    END
  )
  FROM jsonb_array_elements(cities) city
)
WHERE country_key = 'Peru';
