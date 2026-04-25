// Filtros y normalización compartidos para todos los pipelines de ingesta:
// (1) subida manual de Excel/CSV (Upload.jsx),
// (2) subida del bot (BotUpload.jsx),
// (3) sincronización directa desde la BD del bot (futuro).
//
// El objetivo es tener UNA sola implementación de qué fila se acepta, qué fila
// se descarta y cómo se normaliza, para que el dashboard nunca vea data
// inconsistente independientemente de cómo entró.

// Diccionarios públicos — duplicados de Upload.jsx para que ambos pipelines
// los compartan. Mantén estos como única fuente de verdad para la
// normalización de strings.
export const CATEGORY_NORMALIZE = {
  'Economy/Comfort':  'Economy/Comfort',
  'Comfort+':         'Comfort+',
  'Comfort/Comfort+': 'Comfort+',
  'Comfort+/Premier': 'Premier',
  'Economy':          'Economy/Comfort',
  'Comfort':          'Comfort+',
}

export const COMPETITOR_NORMALIZE = {
  'Indrive':         'InDrive',
  'DiDi':            'Didi',
  'Yango premier':   'Yango',
  'Yango  premier':  'Yango',
  'YangoPremier':    'Yango',
  'YangoComfort+':   'Yango',
}

export const BRACKET_NORMALIZE = {
  'Very short': 'very_short',
  'Very Short': 'very_short',
  'Short':      'short',
  'Median':     'median',
  'Average':    'average',
  'Long':       'long',
  'Very long':  'very_long',
  'Very Long':  'very_long',
}

// ── Helpers ─────────────────────────────────────────────────────────────

function pickPrice(row) {
  if (row.competition_name === 'InDrive') {
    if (row.recommended_price       != null) return row.recommended_price
    if (row.price_without_discount  != null) return row.price_without_discount
    return row.price_with_discount
  }
  if (row.price_without_discount != null) return row.price_without_discount
  if (row.price_with_discount    != null) return row.price_with_discount
  return row.recommended_price
}

function findThreshold(rules, city, category, competitor) {
  if (!rules?.length) return null
  const exact = rules.find(r => r.city === city && r.category === category && r.competition === competitor)
  if (exact) return exact.max_price
  const cityCat = rules.find(r => r.city === city && r.category === category && r.competition === 'all')
  if (cityCat) return cityCat.max_price
  const cityAll = rules.find(r => r.city === city && r.category === 'all' && r.competition === 'all')
  if (cityAll) return cityAll.max_price
  return null
}

// ── Normalización de UNA fila ───────────────────────────────────────────

export function normalizeRow(rawRow) {
  const row = { ...rawRow }
  if (row.category)         row.category         = CATEGORY_NORMALIZE[row.category]         ?? row.category
  if (row.competition_name) row.competition_name = COMPETITOR_NORMALIZE[row.competition_name] ?? row.competition_name
  if (row.distance_bracket) {
    row.distance_bracket = BRACKET_NORMALIZE[row.distance_bracket]
                        ?? String(row.distance_bracket).toLowerCase().replace(/\s+/g, '_')
  }
  return row
}

// ── Filtros booleanos ───────────────────────────────────────────────────

/**
 * Una fila vacía o incompleta no debe entrar nunca al dashboard.
 * Bloqueantes: city, observed_date, competition_name, category.
 * Sin precio efectivo tampoco aporta — se descarta.
 */
export function isCompleteRow(row) {
  if (!row) return false
  if (!row.city)             return false
  if (!row.observed_date)    return false
  if (!row.competition_name) return false
  if (!row.category)         return false
  if (pickPrice(row) == null) return false
  return true
}

/**
 * Detecta si la fila tiene precios irreales (mayor al umbral configurado para
 * city/category/competitor). Devuelve { ok, field, value, threshold }.
 *  - ok=true  → la fila pasa
 *  - ok=false → fila bloqueada por outlier (caller decide: omitir, marcar para revisión, etc.)
 */
export function checkPriceRange(row, rules) {
  const value = pickPrice(row)
  if (value == null) return { ok: false, field: null, value: null, threshold: null, reason: 'no_price' }

  const threshold = findThreshold(rules, row.city, row.category, row.competition_name)
  if (threshold == null) return { ok: true, field: null, value, threshold: null, reason: 'no_rule' }
  if (value > threshold) return { ok: false, field: 'price', value, threshold, reason: 'outlier' }
  return { ok: true, field: 'price', value, threshold, reason: 'in_range' }
}

// ── Pipeline completo ───────────────────────────────────────────────────

/**
 * Aplica todo el saneamiento sobre un batch de filas crudas.
 *
 * @param {Array<object>} rawRows   filas tal cual vienen del CSV/Excel/DB del bot
 * @param {Array<object>} rules     filas de price_validation_rules (puede venir vacío)
 * @param {object}        opts
 * @param {boolean}       opts.dropOutliers  default true — outliers se descartan en silencio.
 *                                            En el flujo manual del Excel el usuario los revisa antes,
 *                                            así que ahí pásalo en false y enruta al panel de revisión.
 * @returns {{ accepted, dropped, stats }}
 *    accepted: Array<row>            filas listas para insertar
 *    dropped:  Array<{ idx, row, reason, detail? }>  filas rechazadas con razón
 *    stats:    { total, ok, missingFields, missingPrice, outliers }
 */
export function sanitizeBatch(rawRows, rules = [], opts = {}) {
  const dropOutliers = opts.dropOutliers !== false
  const accepted = []
  const dropped  = []
  const stats    = { total: rawRows.length, ok: 0, missingFields: 0, missingPrice: 0, outliers: 0 }

  rawRows.forEach((raw, idx) => {
    const row = normalizeRow(raw)

    if (!isCompleteRow(row)) {
      if (pickPrice(row) == null && row.city && row.observed_date && row.competition_name && row.category) {
        stats.missingPrice++
        dropped.push({ idx, row, reason: 'missing_price' })
      } else {
        stats.missingFields++
        dropped.push({ idx, row, reason: 'incomplete' })
      }
      return
    }

    const rangeCheck = checkPriceRange(row, rules)
    if (!rangeCheck.ok && rangeCheck.reason === 'outlier') {
      stats.outliers++
      if (dropOutliers) {
        dropped.push({ idx, row, reason: 'outlier', detail: rangeCheck })
        return
      }
    }

    accepted.push(row)
    stats.ok++
  })

  return { accepted, dropped, stats }
}
