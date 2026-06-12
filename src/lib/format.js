// Helpers de formato para mostrar precios y números.
//
// Usamos 'en-US' como locale fijo para que el separador de miles sea
// COMA y el decimal sea PUNTO (60000 → "60,000.00"). Pedido del
// usuario — facilita lectura especialmente para monedas de alta escala
// (COP, NPR) sin depender del locale del browser.

const PRICE_FORMAT = { minimumFractionDigits: 2, maximumFractionDigits: 2 }
const PRICE_FORMAT_NO_DECIMALS = { minimumFractionDigits: 0, maximumFractionDigits: 0 }

/**
 * Formatea un número como precio con separador de miles y 2 decimales.
 * Ej: 60000 → "60,000.00"
 * @param {number|null|undefined} value
 * @param {object} [opts]
 * @param {boolean} [opts.noDecimals]  — true → sin decimales (60000 → "60,000")
 * @returns {string}  número formateado, o '—' si value es null/undefined/NaN
 */
export function formatPrice(value, opts = {}) {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  if (!isFinite(n)) return '—'
  const fmt = opts.noDecimals ? PRICE_FORMAT_NO_DECIMALS : PRICE_FORMAT
  return n.toLocaleString('en-US', fmt)
}

/**
 * Formatea un precio con su moneda. Ej: formatCurrency(60000, 'COP') → "COP 60,000.00"
 */
export function formatCurrency(value, currency = '', opts = {}) {
  const formatted = formatPrice(value, opts)
  if (formatted === '—') return '—'
  return currency ? `${currency} ${formatted}` : formatted
}

/**
 * Formatea un número como conteo entero con separador de miles.
 * Ej: 12345 → "12,345"
 */
export function formatCount(value) {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  if (!isFinite(n)) return '—'
  return n.toLocaleString('en-US')
}
