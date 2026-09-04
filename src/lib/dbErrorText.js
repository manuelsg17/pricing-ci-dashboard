// Traduce un error crudo de Supabase / PostgREST / red a una clave i18n
// `errors.db.*`. Antes los editores de Configuración mostraban
// `error.message` tal cual (nombres de políticas RLS, constraints, SQL) —
// CLAUDE.md §3 pide no filtrar eso al usuario. Lógica pura, sin React:
// se testea en scripts/test-db-error-text.mjs.

const CODE_TO_KIND = {
  23505: 'duplicate',
  23503: 'reference',
  23514: 'check',
  23502: 'not_null',
  42501: 'permission',
  '22P02': 'invalid_format',
  PGRST301: 'session_expired',
  PGRST116: 'not_found',
}

const MESSAGE_PATTERNS = [
  [/jwt.*expired|expired.*jwt/i, 'session_expired'],
  [/failed to fetch|networkerror|fetch failed|load failed/i, 'network'],
  [/timeout|timed out|statement_timeout|57014/i, 'timeout'],
  [/row-level security|permission denied/i, 'permission'],
  [/duplicate key/i, 'duplicate'],
  [/violates foreign key/i, 'reference'],
  [/violates check constraint/i, 'check'],
  [/violates not-null/i, 'not_null'],
  [/invalid input syntax/i, 'invalid_format'],
]

// Clasifica el error en un identificador estable ('duplicate', 'permission',
// 'generic', …). Acepta string, Error, o el objeto { code, message } de
// supabase-js. Devuelve siempre un string.
export function dbErrorKind(error) {
  if (!error) return 'generic'
  const e = typeof error === 'string' ? { message: error } : error
  const code = e?.code != null ? String(e.code) : ''
  if (code && CODE_TO_KIND[code]) return CODE_TO_KIND[code]
  const msg = String(e?.message || (typeof e === 'string' ? e : '') || '')
  for (const [re, kind] of MESSAGE_PATTERNS) {
    if (re.test(msg)) return kind
  }
  // Cualquier otro código PGRSTxxx: la API respondió pero rechazó la
  // consulta (schema cache, función inexistente, etc.).
  if (/^PGRST\d+/i.test(code) || /^PGRST/i.test(msg)) return 'postgrest'
  return 'generic'
}

// Texto para mostrar: t('errors.db.<kind>'). `t` es el de useI18n().
export function dbErrorText(t, error) {
  return t(`errors.db.${dbErrorKind(error)}`)
}
