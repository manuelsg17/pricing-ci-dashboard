// ============================================================
// MOTOR ÚNICO DE BONOS DE COMPETIDOR
// ============================================================
// Fuente única usada por Rentabilidad (bonusFor) y DriverEarnings (calcCell).
// Reemplaza la lógica duplicada que SUMABA todos los bonos 'viajes' cuyo umbral se
// cumplía → una escalera cargada como N filas se sobreestimaba (bug del design doc §2).
//
// Reglas por mecanismo (todo en CASH SEMANAL; el per-viaje se divide ÷viajes afuera):
// - tiered (escalera): reward del peldaño MÁS ALTO alcanzado (NO suma), topeado en cap_amount.
// - gmv_tiered (% GMV, Yango): elegís una meta de N viajes → te devuelven pct% del GMV
//   (ANTES de comisión) de los primeros N viajes, topeado en cap S/ por peldaño. Si el
//   driver supera varias metas, se asume que eligió la que más paga.
// - flat: +bonus_amount si viajes/horas ≥ threshold.
// - guarantee (piso): si viajes ≥ N, max(0, garantía − neto de esos N viajes).
// - surge: min(cap, mult% × fare × viajes × share).
// - streak: min(Σ premio_día × ventanas, topes) según streak_spec + días logrados.
// - comm_credit: cash semanal directo.
// - comm_discount: NO es cash → baja la comisión efectiva (ver effectiveCommission).
//
// Filtros: categoría, segmento (activo/nuevo/reactivado/all), recurrente vs one-off,
// y grupos de alternativas (group_key: solo la fila is_chosen cuenta).

function num(x, d = 0) {
  const n = Number(x)
  return Number.isFinite(n) ? n : d
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x))
}

// Escalera: reward acumulado del peldaño más alto con threshold ≤ viajes, topeado.
export function tieredReward(tiers, trips, cap) {
  let best = 0
  for (const t of tiers || []) {
    if (trips >= num(t.threshold)) best = Math.max(best, num(t.reward))
  }
  // cap 0 (o vacío) = SIN tope (no anular el bono).
  return cap != null && num(cap) > 0 ? Math.min(best, num(cap)) : best
}

// % GMV con metas (Yango): tiers = [{threshold: N viajes meta, pct: % GMV, cap: tope S/}].
// El % aplica SOLO sobre el GMV bruto (fare × N, sin descontar comisión) de los primeros
// N viajes de la meta — aunque el driver haga más. Entre las metas alcanzadas (threshold
// ≤ viajes) se toma la de mayor pago, porque el driver la elige antes de la semana.
export function gmvTieredReward(tiers, trips, fare) {
  let best = 0
  for (const t of tiers || []) {
    const n = num(t.threshold)
    if (n <= 0 || trips < n) continue
    let v = (num(t.pct) / 100) * fare * n
    if (t.cap != null && num(t.cap) > 0) v = Math.min(v, num(t.cap))
    best = Math.max(best, v)
  }
  return best
}

function streakCash(spec, days) {
  if (!spec || !days) return 0
  const perDay = Array.isArray(spec.per_day_reward) ? spec.per_day_reward : []
  const windows = num(spec.windows_per_day, 1)
  let perWindow = 0
  for (let d = 0; d < days && d < perDay.length; d++) perWindow += num(perDay[d])
  if (spec.cap_per_window != null && num(spec.cap_per_window) > 0)
    perWindow = Math.min(perWindow, num(spec.cap_per_window))
  let total = perWindow * windows
  if (spec.cap_total != null && num(spec.cap_total) > 0)
    total = Math.min(total, num(spec.cap_total))
  return total
}

// Cash semanal de UNA fila de bono (0 si el mecanismo no aporta cash, ej. comm_discount).
export function rowWeeklyCash(b, ctx) {
  const trips = num(ctx.trips)
  const fare = num(ctx.fare)
  const c = num(ctx.commPct) / 100 // comisión del competidor (fracción)
  switch (b.mechanism || 'flat') {
    case 'tiered':
      return tieredReward(b.tiers, trips, b.cap_amount)
    case 'gmv_tiered':
      return gmvTieredReward(b.tiers, trips, fare)
    case 'guarantee': {
      const nGar = num(b.threshold)
      if (nGar <= 0 || trips < nGar) return 0
      return Math.max(0, num(b.bonus_amount) - fare * nGar * (1 - c))
    }
    case 'surge': {
      // share es una FRACCIÓN 0..1 — clamp defensivo por si quedó guardado
      // un % (ej. 25 en vez de 0.25), que multiplicaría el cash ×25.
      const share = clamp01(b.share_in_window != null ? num(b.share_in_window) : num(ctx.sharePeak))
      const raw = (num(b.mult_pct) / 100) * fare * trips * share
      const cap = num(b.cap_amount) // cap 0 (o vacío) = SIN tope
      return b.cap_amount != null && cap > 0 ? Math.min(raw, cap) : raw
    }
    case 'streak':
      return streakCash(b.streak_spec, num(ctx.streakDays))
    case 'comm_credit':
      return num(b.bonus_amount)
    case 'comm_discount':
      return 0 // se modela como menor comisión efectiva (effectiveCommission)
    case 'flat':
    default:
      if (b.bonus_type === 'viajes' && trips >= num(b.threshold)) return num(b.bonus_amount)
      if (b.bonus_type === 'horas' && num(ctx.hours) >= num(b.threshold)) return num(b.bonus_amount)
      return 0
  }
}

function segmentApplies(b, seg) {
  if (!seg || seg === 'all') return true
  return !b.segment || b.segment === 'all' || b.segment === seg
}

// Vigencia (mig 237): ¿la fila rige en `asOf`? `asOf` es una fecha ISO
// 'YYYY-MM-DD' o un rango { from, to } (ambos ISO, inclusive) — Rentabilidad
// pasa la SEMANA completa, así un bono que arranca el jueves cuenta para esa
// semana (revisión adversarial 2026-09-03: con solo el lunes no aparecía hasta
// la semana siguiente). Sin asOf → no se filtra (filas viejas, tests).
// Comparación de strings ISO: válida porque el formato es de ancho fijo.
export function isValidOn(b, asOf) {
  if (!asOf) return true
  const from = typeof asOf === 'string' ? asOf : asOf.from
  const to = typeof asOf === 'string' ? asOf : asOf.to
  if (b.valid_from && to && String(b.valid_from) > to) return false
  if (b.valid_to && from && String(b.valid_to) < from) return false
  return true
}

function rowPasses(b, ctx) {
  if (b.is_active === false) return false
  if (!isValidOn(b, ctx.asOf)) return false
  if (b.category && b.category !== ctx.dbCategory) return false
  if (!segmentApplies(b, ctx.segment)) return false
  if (b.group_key && b.is_chosen === false) return false // alternativa no elegida (Uber quests)
  return true
}

// Resuelve el cash semanal de TODOS los bonos de un competidor para un contexto.
// Devuelve { total (recurrente), oneOff (gancho one-off), applied:[filas con valor] }.
export function resolveBonusWeekly(rows, ctx = {}) {
  let total = 0
  let oneOff = 0
  const applied = []
  for (const b of rows || []) {
    if (!rowPasses(b, ctx)) continue
    const v = rowWeeklyCash(b, ctx)
    if (!v) continue
    if (b.recurring === false) oneOff += v
    else {
      total += v
      applied.push({ ...b, _value: v })
    }
  }
  return { total, oneOff, applied }
}

// Descripción legible de un bono según su mecanismo (resúmenes, PDF, snapshot).
export function describeBonus(b, currency = 'S/') {
  const cap =
    b.cap_amount != null && Number(b.cap_amount) > 0 ? ` (tope ${currency} ${b.cap_amount})` : ''
  switch (b.mechanism || 'flat') {
    case 'tiered': {
      const t = (b.tiers || [])
        .slice()
        .sort((a, c) => Number(a.threshold) - Number(c.threshold))
        .map((x) => `≥${x.threshold}→${currency} ${x.reward}`)
        .join(' · ')
      return `Escalera: ${t || '—'}${cap}`
    }
    case 'gmv_tiered': {
      const t = (b.tiers || [])
        .slice()
        .sort((a, c) => Number(a.threshold) - Number(c.threshold))
        .map(
          (x) =>
            `meta ${x.threshold} viajes→${x.pct}% GMV${
              x.cap != null && Number(x.cap) > 0 ? ` (tope ${currency} ${x.cap})` : ''
            }`
        )
        .join(' · ')
      return `% GMV: ${t || '—'} — sobre el GMV bruto de los primeros N viajes de la meta`
    }
    case 'guarantee':
      return `Garantía: piso ${currency} ${b.bonus_amount} si ≥${b.threshold} viajes`
    case 'comm_credit':
      return `Monedas: ${currency} ${b.bonus_amount}/sem`
    case 'surge':
      return `Surge: +${b.mult_pct}% sobre fare${cap}`
    case 'streak':
      return 'Racha (días consecutivos)'
    case 'comm_discount':
      return `Desc. comisión a ${b.comm_pct}% en ventana`
    case 'flat':
    default:
      return b.bonus_type === 'horas'
        ? `≥ ${b.threshold} h/sem → +${currency} ${b.bonus_amount}`
        : `≥ ${b.threshold} viajes → +${currency} ${b.bonus_amount}`
  }
}

// Comisión EFECTIVA del competidor tras descuentos por ventana (InDrive 1%).
// commBase en %, share = fracción de viajes en la ventana (0..1). Se cablea en F2.
export function effectiveCommission(commBase, rows, sharePeak, ctx = {}) {
  let comm = num(commBase)
  for (const b of rows || []) {
    if (b.mechanism !== 'comm_discount' || !rowPasses(b, ctx)) continue
    const reduced = num(b.comm_pct, comm)
    // share clamp 0..1 — un % guardado por error (25) daría comisión negativa
    const share = clamp01(b.share_in_window != null ? num(b.share_in_window) : num(sharePeak))
    comm = comm - (num(commBase) - reduced) * share
  }
  return comm
}
