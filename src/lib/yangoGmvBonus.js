// ============================================================
// BONO YANGO POR % DE GMV (Yango Pro) — tablas estándar (activo)
// ============================================================
// Yango paga al driver un bono = % de su GMV semanal, en escalera por # de
// viajes, topeado en "Gana hasta". Es CASH aditivo (NO comisión) → suma al
// take-home: fares·(1−comisión_total) + yangoGmvBonus.
//
// Dimensiones: ciudad × brandeo (con/sin) × categoría (Premier en Lima = VIP).
// Modelo: bono = mín(%peldaño · GMV_sem, tope_peldaño), GMV_sem = fare·viajes,
// peldaño = el más alto alcanzado por # de viajes.
// Default brandeo = SIN brandeo. Bonos de REACTIVACIÓN = apagados (decisión).
// Fuente: tablas Yango Pro 2026-06 (ver COMPETIDOR_BONOS_DESIGN §8.1).
// Hardcodeado (estas tablas son política, cambian poco). Futuro opcional: tabla
// `yango_gmv` editable.

// Cada peldaño: { t: ≥viajes, pct: % del GMV, cap: tope S/ }. Orden ascendente.
const TABLES = {
  Lima: {
    unbranded: [
      { t: 10, pct: 9, cap: 50 },
      { t: 30, pct: 10, cap: 110 },
      { t: 50, pct: 11, cap: 150 },
      { t: 75, pct: 12, cap: 200 },
      { t: 100, pct: 14, cap: 280 },
      { t: 125, pct: 16, cap: 340 },
      { t: 150, pct: 18, cap: 400 },
    ],
    branded: [
      { t: 30, pct: 13, cap: 145 },
      { t: 50, pct: 14, cap: 220 },
      { t: 75, pct: 15, cap: 260 },
      { t: 100, pct: 16, cap: 320 },
      { t: 125, pct: 18, cap: 390 },
      { t: 150, pct: 20, cap: 480 },
      { t: 190, pct: 22, cap: 640 },
    ],
    // VIP: solo categoría Premier (una sola tabla, sin split de brandeo).
    vip: [
      { t: 2, pct: 40, cap: 64 },
      { t: 4, pct: 43, cap: 135 },
      { t: 6, pct: 46, cap: 205 },
      { t: 8, pct: 49, cap: 300 },
      { t: 10, pct: 52, cap: 395 },
      { t: 15, pct: 56, cap: 640 },
      { t: 20, pct: 60, cap: 900 },
    ],
  },
  Trujillo: {
    unbranded: [
      { t: 10, pct: 9, cap: 23 },
      { t: 35, pct: 10, cap: 46 },
      { t: 65, pct: 11, cap: 80 },
      { t: 95, pct: 12, cap: 110 },
      { t: 125, pct: 14, cap: 160 },
      { t: 155, pct: 16, cap: 205 },
      { t: 190, pct: 18, cap: 300 },
    ],
    branded: [
      { t: 35, pct: 13, cap: 55 },
      { t: 65, pct: 14, cap: 100 },
      { t: 95, pct: 15, cap: 170 },
      { t: 125, pct: 16, cap: 225 },
      { t: 155, pct: 18, cap: 280 },
      { t: 190, pct: 20, cap: 350 },
      { t: 230, pct: 22, cap: 410 },
    ],
  },
  Arequipa: {
    unbranded: [
      { t: 10, pct: 7, cap: 25 },
      { t: 25, pct: 8, cap: 50 },
      { t: 50, pct: 9, cap: 85 },
      { t: 75, pct: 10, cap: 110 },
      { t: 100, pct: 12, cap: 150 },
      { t: 125, pct: 14, cap: 190 },
      { t: 155, pct: 16, cap: 290 },
    ],
    branded: [
      { t: 25, pct: 10, cap: 65 },
      { t: 50, pct: 11, cap: 120 },
      { t: 75, pct: 12, cap: 180 },
      { t: 100, pct: 13, cap: 240 },
      { t: 125, pct: 14, cap: 320 },
      { t: 155, pct: 16, cap: 440 },
      { t: 195, pct: 18, cap: 520 },
    ],
  },
}

// Vigencia (mig 237): ¿la fila rige en `asOf`? Fecha ISO o rango { from, to }
// inclusive (Rentabilidad pasa la semana completa). Sin asOf no filtra.
function validOn(r, asOf) {
  if (!asOf) return true
  const from = typeof asOf === 'string' ? asOf : asOf.from
  const to = typeof asOf === 'string' ? asOf : asOf.to
  if (r.valid_from && to && String(r.valid_from) > to) return false
  if (r.valid_to && from && String(r.valid_to) < from) return false
  return true
}

// Construye la estructura TABLES desde filas de yango_gmv_tiers (mig 116). Si no
// hay filas (config sin cargar / test node), cae al hardcode de arriba. Con
// filas, solo entran las vigentes en `asOf` — una ciudad cuya escalera no rige
// en esa fecha simplemente no aparece (bono 0), sin caer al hardcode.
function tablesFromRows(rows, asOf) {
  if (!Array.isArray(rows) || rows.length === 0) return TABLES
  const out = {}
  for (const r of rows) {
    if (r.is_active === false) continue
    if (!validOn(r, asOf)) continue
    if (!out[r.city]) out[r.city] = {}
    if (!out[r.city][r.variant]) out[r.city][r.variant] = []
    out[r.city][r.variant].push({ t: Number(r.min_trips), pct: Number(r.pct), cap: Number(r.cap) })
  }
  for (const city of Object.keys(out))
    for (const v of Object.keys(out[city])) out[city][v].sort((a, b) => a.t - b.t)
  return out
}

// ¿Hay tabla de bono GMV para esta ciudad? (aeropuertos/Corp → no, por ahora).
export function hasYangoGmvTable(dbCity, rows, asOf) {
  return !!tablesFromRows(rows, asOf)[dbCity]
}

// Devuelve la escalera aplicable según ciudad/categoría/brandeo (vigente en asOf).
function ladderFor(dbCity, dbCategory, branded, rows, asOf) {
  const t = tablesFromRows(rows, asOf)[dbCity]
  if (!t) return null
  if (dbCity === 'Lima' && dbCategory === 'Premier' && t.vip) return t.vip // VIP gana
  return branded ? t.branded : t.unbranded
}

// Detalle del bono GMV: { pct, cap, gmv, bono } o null si no aplica.
export function yangoGmvDetail(dbCity, dbCategory, branded, fare, trips, rows, asOf) {
  const ladder = ladderFor(dbCity, dbCategory, branded, rows, asOf)
  if (!ladder || !fare || !trips || isNaN(fare)) return null
  let step = null
  for (const r of ladder) if (trips >= r.t) step = r // peldaño máximo alcanzado
  if (!step) return null
  const gmv = fare * trips
  return { pct: step.pct, cap: step.cap, gmv, bono: Math.min((step.pct / 100) * gmv, step.cap) }
}

// Bono GMV semanal (S/). 0 si no aplica. `rows` = filas de yango_gmv_tiers
// (de useConfigContext); sin ellas usa las tablas hardcodeadas de fallback.
// `asOf` (ISO) = fecha de referencia para la vigencia (mig 237).
export function yangoGmvBonus(dbCity, dbCategory, branded, fare, trips, rows, asOf) {
  return yangoGmvDetail(dbCity, dbCategory, branded, fare, trips, rows, asOf)?.bono || 0
}
