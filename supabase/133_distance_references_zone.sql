-- ════════════════════════════════════════════════════════════════════════
-- TukTuk opera por zona/distrito más que por ruta punto a punto exacta.
-- Se agrega un campo "Zona" opcional a distance_references para poder
-- anotar en qué zona opera cada fila — hoy solo lo usa la categoría TukTuk
-- en Distancias de Referencia, las demás categorías lo dejan vacío.
-- No participa de la cascada de replicación (TukTuk ya está excluido de
-- eso en src/lib/distanceRefsReplication.js).
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE distance_references ADD COLUMN IF NOT EXISTS zone text;

COMMENT ON COLUMN distance_references.zone IS
  'Zona/distrito donde opera la ruta. Hoy solo se usa para category=TukTuk (ver DistanceRefs.jsx).';
