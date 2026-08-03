/**
 * Helpers de fecha compartidos — fuente única de verdad.
 * Reemplaza implementaciones locales duplicadas en múltiples páginas/hooks.
 */

/**
 * Devuelve el año e ISO week number de una fecha.
 * Acepta Date o string ISO (YYYY-MM-DD). Los strings se parsean con
 * hora fija 12:00 para evitar desplazamientos por zona horaria.
 *
 * @param {Date|string} dateInput
 * @returns {{ year: number, week: number }}
 */
export function getISOYearWeek(dateInput = new Date()) {
  const d = typeof dateInput === 'string' ? new Date(dateInput + 'T12:00:00') : new Date(dateInput)
  const day = d.getDay() || 7
  d.setDate(d.getDate() + 4 - day)
  const jan1 = new Date(d.getFullYear(), 0, 1)
  const week = Math.ceil(((d - jan1) / 86400000 + 1) / 7)
  return { year: d.getFullYear(), week }
}

/**
 * Devuelve el LUNES de la semana ISO (year, week) — medianoche local.
 * Inverso de getISOYearWeek. Espejo de la lógica de getWeekDateRange
 * (DrillDownModal): la semana ISO 1 es la que contiene el 4-ene.
 *
 * @param {number} year  ISO year
 * @param {number} week  ISO week (1..53)
 * @returns {Date}       lunes de esa semana
 */
export function isoWeekMonday(year, week) {
  const jan4 = new Date(year, 0, 4)
  const dow = jan4.getDay() || 7 // dom=0 → 7
  const monday = new Date(jan4)
  monday.setDate(jan4.getDate() - (dow - 1) + (week - 1) * 7)
  return monday
}

/**
 * Devuelve el lunes de la semana N semanas atrás (medianoche local).
 *
 * @param {number} n
 * @returns {Date}
 */
export function getMondayWeeksAgo(n) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  const day = d.getDay() || 7 // dom=0 → 7
  d.setDate(d.getDate() - (day - 1)) // lunes de esta semana
  d.setDate(d.getDate() - n * 7) // N semanas atrás
  return d
}

/**
 * Formatea una fecha como string YYYY-MM-DD.
 *
 * @param {Date} d
 * @returns {string}
 */
export function toISODate(d) {
  // Componentes LOCALES, no `toISOString()`.
  //
  // Todas las Date que llegan acá se construyen en hora local — `new Date(y, m, d)`,
  // `getMondayWeeksAgo`, `Date.now() - n días`— y representan una fecha de
  // CALENDARIO, no un instante. `toISOString()` las pasa a UTC primero: en
  // cualquier huso al ESTE de Greenwich, la medianoche local es el día ANTERIOR
  // en UTC, así que la fecha salía corrida un día.
  //
  // No es hipotético: `country_config` tiene países en UTC+2 y UTC+5:45, y hay
  // locale ruso activo. El rango entero del dashboard se movía un día para esos
  // usuarios, y el drill-down dejaba de explicar la celda que lo abrió — sin
  // error y sin aviso, que es la peor forma.
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}
