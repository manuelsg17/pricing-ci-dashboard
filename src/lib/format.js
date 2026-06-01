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

// ── Currency-aware (Intl.NumberFormat) ────────────────────────────────────
// Mapping de símbolos legacy del proyecto a códigos ISO 4217 (los que
// Intl.NumberFormat acepta). 'S/' (Peru) y 'COP$' (Colombia) son cosméticos
// que aparecían en algunos archivos; los normalizamos.
const CURRENCY_CODE_FIX = {
  'S/':   'PEN',
  'S/.':  'PEN',
  'COP$': 'COP',
  'NPR.': 'NPR',
}

// Algunas monedas no llevan decimales por convención (COP, NPR, etc.).
// Intl.NumberFormat ya respeta esto por defecto pero lo dejamos explícito.
const NO_DECIMALS_CURRENCIES = new Set(['COP', 'CLP', 'PYG', 'VES', 'IDR', 'KRW', 'JPY', 'NPR', 'ZMW'])

/**
 * Formatea un precio respetando moneda y locale del país. Usa Intl.NumberFormat
 * para que COP en es-CO se muestre "$60.000" (sin decimales, punto como
 * separador de miles) en lugar del legacy "COP 60,000.00".
 *
 * NO reemplaza formatCurrency() — los callers existentes (DrillDownModal)
 * siguen funcionando. Para currency-aware, importar esta función y pasar
 * { currency: country_config.currency, locale: country_config.locale }.
 *
 * @example
 *   formatCurrencyIntl(60000, { currency: 'COP', locale: 'es-CO' }) // "$ 60.000"
 *   formatCurrencyIntl(15.50, { currency: 'PEN', locale: 'es-PE' }) // "S/ 15.50"
 *   formatCurrencyIntl(null,  { currency: 'COP', locale: 'es-CO' }) // "—"
 */
export function formatCurrencyIntl(value, { currency, locale = 'es-PE', display = 'narrowSymbol' } = {}) {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  if (!isFinite(n)) return '—'
  const code = CURRENCY_CODE_FIX[currency] ?? currency ?? 'USD'
  const noDec = NO_DECIMALS_CURRENCIES.has(code)
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      currencyDisplay: display,
      minimumFractionDigits: noDec ? 0 : 2,
      maximumFractionDigits: noDec ? 0 : 2,
    }).format(n)
  } catch {
    // Si el código de moneda es inválido (Intl tira RangeError), fallback al legacy
    return formatCurrency(n, code)
  }
}
