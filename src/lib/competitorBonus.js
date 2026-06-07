// ============================================================
// MOTOR ÚNICO DE BONOS DE COMPETIDOR
// ============================================================
// Fuente única usada por Rentabilidad (bonusFor) y DriverEarnings (calcCell).
// Reemplaza la lógica duplicada que SUMABA todos los bonos 'viajes' cuyo umbral se
// cumplía → una escalera cargada como N filas se sobreestimaba (bug del design doc §2).
//
// Reglas por mecanismo (todo en CASH SEMANAL; el per-viaje se divide ÷viajes afuera):
// - tiered (escalera): reward del peldaño MÁS ALTO alcanzado (NO suma), topeado en cap_amount.
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

// Escalera: reward acumulado del peldaño más alto con threshold ≤ viajes, topeado.
export function tieredReward(tiers, trips, cap) {
  let best = 0
  for (const t of tiers || []) {
    if (trips >= num(t.threshold)) best = Math.max(best, num(t.reward))
  }
  return cap != null ? Math.min(best, num(cap)) : best
}

function streakCash(spec, days) {
  if (!spec || !days) return 0
  const perDay = Array.isArray(spec.per_day_reward) ? spec.per_day_reward : []
  const windows = num(spec.windows_per_day, 1)
  let perWindow = 0
  for (let d = 0; d < days && d < perDay.length; d++) perWindow += num(perDay[d])
  if (spec.cap_per_window != null) perWindow = Math.min(perWindow, num(spec.cap_per_window))
  let total = perWindow * windows
  if (spec.cap_total != null) total = Math.min(total, num(spec.cap_total))
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
    case 'guarantee': {
      const nGar = num(b.threshold)
      if (nGar <= 0 || trips < nGar) return 0
      return Math.max(0, num(b.bonus_amount) - fare * nGar * (1 - c))
    }
    case 'surge': {
      const share = b.share_in_window != null ? num(b.share_in_window) : num(ctx.sharePeak)
      const raw = (num(b.mult_pct) / 100) * fare * trips * share
      return b.cap_amount != null ? Math.min(raw, num(b.cap_amount)) : raw
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

function rowPasses(b, ctx) {
  if (b.is_active === false) return false
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

// Comisión EFECTIVA del competidor tras descuentos por ventana (InDrive 1%).
// commBase en %, share = fracción de viajes en la ventana (0..1). Se cablea en F2.
export function effectiveCommission(commBase, rows, sharePeak, ctx = {}) {
  let comm = num(commBase)
  for (const b of rows || []) {
    if (b.mechanism !== 'comm_discount' || !rowPasses(b, ctx)) continue
    const reduced = num(b.comm_pct, comm)
    const share = b.share_in_window != null ? num(b.share_in_window) : num(sharePeak)
    comm = comm - (num(commBase) - reduced) * share
  }
  return comm
}
