// Mapea errores crudos de Supabase / PostgREST a mensajes humanos para mostrar al usuario.
// Acepta string o Error / objeto { code, message, hint }. Devuelve string siempre.

const CODE_MAP = {
  '42501': 'No tenés permisos para esta acción.',
  '23505': 'Ese registro ya existe (duplicado).',
  '23514': 'Algún valor no cumple las restricciones (revisá rangos).',
  '23503': 'No se puede borrar: otros registros dependen de este.',
  '23502': 'Falta un campo obligatorio.',
  '22P02': 'Formato inválido en alguno de los campos.',
  '42P01': 'La tabla solicitada no existe (¿migración faltante?).',
  '42883': 'La función solicitada no existe (¿migración faltante?).',
  PGRST301: 'Tu sesión expiró. Recargá la página.',
  PGRST116: 'No se encontró el registro solicitado.',
  PGRST204: 'Sin datos para esta consulta.',
}

const MESSAGE_PATTERNS = [
  { match: /JWT expired|jwt.*expired/i, human: 'Tu sesión expiró. Recargá la página.' },
  { match: /Failed to fetch|NetworkError|fetch failed/i, human: 'Sin conexión con el servidor. Verificá tu red.' },
  { match: /row-level security/i, human: 'No tenés permisos para esta acción.' },
  { match: /duplicate key value/i, human: 'Ese registro ya existe (duplicado).' },
  { match: /violates foreign key/i, human: 'No se puede modificar: hay registros relacionados.' },
  { match: /violates not-null/i, human: 'Falta un campo obligatorio.' },
  { match: /does not exist/i, human: 'Recurso no disponible (¿migración faltante?).' },
  { match: /timeout|timed out/i, human: 'La operación tardó demasiado. Probá de nuevo.' },
]

export function humanizeError(err) {
  if (!err) return ''
  const e = typeof err === 'string' ? { message: err } : err

  if (e?.code && CODE_MAP[e.code]) return CODE_MAP[e.code]

  const msg = String(e?.message || e || '')
  for (const { match, human } of MESSAGE_PATTERNS) {
    if (match.test(msg)) return human
  }

  if (!msg) return 'Ocurrió un error inesperado.'
  if (msg.length > 200) return 'Ocurrió un error inesperado. Revisá la consola para más detalle.'
  return msg
}
