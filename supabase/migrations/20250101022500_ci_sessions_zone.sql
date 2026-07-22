-- Mig 144: columna `zone` en ci_sessions.
--
-- "Lima TukTuk" pasa a cargarse POR DISTRITO (cada distrito es una sub-pestaña,
-- como Punto A/B del aeropuerto) y cada distrito tiene su propio "Terminar
-- Sesión". Para que el historial de sesiones distinga "Lima TukTuk · Comas" de
-- "Lima TukTuk · SJM" (ambas guardan city='Lima'), la sesión registra el
-- distrito en esta columna. NULL para las sesiones normales
-- (ciudad / aeropuerto / corp), que no tienen zona.
ALTER TABLE ci_sessions ADD COLUMN IF NOT EXISTS zone text;

COMMENT ON COLUMN ci_sessions.zone IS
  'Distrito TukTuk (zone) cuando la sesión es de Lima TukTuk cargada por distrito; NULL en el resto.';
