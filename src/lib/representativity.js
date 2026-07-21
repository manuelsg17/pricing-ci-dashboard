// Helpers puros para el panel de Representatividad de la data (dashboard).
// Separados del componente para no romper react-refresh y para poder testearlos
// sin UI. Los usa RepresentativityCard.jsx sobre la RPC get_representativity
// (mig 138), que devuelve por celda (ciudad × categoría × competidor × bracket)
// el conteo de la SEMANA ISO en curso, separado bot_n / manual_n.

// Umbrales por celda por SEMANA. Derivados de la variabilidad real de Perú
// (CV ≈ 0.17 estándar / 0.19 InDrive) para un margen de error de ±10% (piso) y
// ±5% (óptimo): n = (1.96 · CV / E)^2. Ajustables acá sin tocar la migración
// (el RPC solo devuelve conteos crudos).
export const REP_FLOOR = { standard: 10, indrive: 14 }
export const REP_OPTIMO = { standard: 40, indrive: 55 }

// Salud del semáforo de la tarjeta según el % de celdas representables.
export const HEALTH_OK = 0.95
export const HEALTH_WARN = 0.8

export function isIndrive(comp) {
  return comp === 'InDrive'
}
export function cellFloor(comp) {
  return isIndrive(comp) ? REP_FLOOR.indrive : REP_FLOOR.standard
}
export function cellOptimo(comp) {
  return isIndrive(comp) ? REP_OPTIMO.indrive : REP_OPTIMO.standard
}

// Nivel de una celda según el TOTAL de muestras (bot + apps): una celda es
// representativa si el total llega al piso (el dashboard, en "todas las fuentes",
// promedia bot + manual juntos).
export function levelForTotal(total, comp) {
  const f = cellFloor(comp)
  const o = cellOptimo(comp)
  if (total < f) return 'bad'
  if (total < o) return 'warn'
  return 'ok'
}

// Clasifica una fila del RPC. `source` dice de qué depende la representatividad:
//   'none'   → total < piso (NO representativa: la alerta)
//   'apps'   → apps ≥ piso y bot < piso (las apps la salvan; sin ellas caería)
//   'bot'    → bot ≥ piso y apps < piso (depende del bot; si el bot cae, cae)
//   'both'   → ambas fuentes ≥ piso por sí solas
//   'pooled' → total ≥ piso pero ninguna fuente sola llega (frágil)
export function classifyCell(row) {
  const comp = row.competition_name
  const bot = Number(row.bot_n) || 0
  const man = Number(row.manual_n) || 0
  // Muestras "sin data" (S/D): el hub atendió la celda, no había oferta. NO son
  // muestras de precio (no cuentan para el piso), pero indican que la celda fue
  // atendida — no es un hueco de medición.
  const noData = Number(row.no_data_n) || 0
  const total = bot + man
  const f = cellFloor(comp)
  const level = levelForTotal(total, comp)
  let source = 'none'
  if (total >= f) {
    const botOk = bot >= f
    const appsOk = man >= f
    if (botOk && appsOk) source = 'both'
    else if (appsOk) source = 'apps'
    else if (botOk) source = 'bot'
    else source = 'pooled'
  }
  // "Atendida sin oferta": no llega al piso de precio pero el hub la marcó S/D.
  // No es un hueco (no va a la alerta de faltantes) ni penaliza la salud.
  const attendedNoOffer = level === 'bad' && noData > 0
  return {
    city: row.city,
    category: row.category,
    comp,
    bracket: row.distance_bracket,
    bot,
    man,
    noData,
    total,
    floor: f,
    optimo: cellOptimo(comp),
    level,
    source,
    attendedNoOffer,
  }
}

export function healthLevel(ratio) {
  if (ratio >= HEALTH_OK) return 'ok'
  if (ratio >= HEALTH_WARN) return 'warn'
  return 'bad'
}

// Agrega todas las celdas del RPC en el resumen de la tarjeta.
export function computeRepresentativity(rows) {
  const cells = (rows || []).map(classifyCell)
  let green = 0
  let amber = 0
  let red = 0 // bajo piso Y sin marca S/D → hueco real de medición
  let attendedNoOffer = 0 // atendida, sin oferta (S/D) — ni verde ni faltante
  let botFloor = 0 // celdas donde el bot solo ya llega al piso
  let appsFloor = 0 // celdas donde las apps solas ya llegan al piso
  let appsEssential = 0 // celdas representables SOLO gracias a las apps (bot < piso)
  let pooledOnly = 0 // representables solo sumando ambas (frágil)
  const byCity = {}
  for (const c of cells) {
    if (c.level === 'ok') green++
    else if (c.level === 'warn') amber++
    else if (c.attendedNoOffer) attendedNoOffer++
    else red++
    if (c.bot >= c.floor) botFloor++
    if (c.man >= c.floor) appsFloor++
    if (c.source === 'apps') appsEssential++
    if (c.source === 'pooled') pooledOnly++
    ;(byCity[c.city] ||= []).push(c)
  }
  const totalCells = cells.length
  const covered = green + amber
  // Las celdas "atendidas sin oferta" se excluyen del universo esperado: no se
  // puede tener precio representativo donde no hay oferta, así que no penalizan
  // la salud. Si TODO es sin-oferta, la representatividad es 100% (nada que medir).
  const expected = totalCells - attendedNoOffer
  const coverageRatio = expected > 0 ? covered / expected : 1
  // Alerta de faltantes: solo huecos reales (bajo piso, sin marca S/D).
  const redCells = cells
    .filter((c) => c.level === 'bad' && !c.attendedNoOffer)
    .sort((a, b) => a.total - b.total)
  return {
    totalCells,
    green,
    amber,
    red,
    attendedNoOffer,
    covered,
    coverageRatio,
    coveragePct: Math.round(coverageRatio * 100),
    level: healthLevel(coverageRatio),
    botFloor,
    appsFloor,
    appsEssential,
    pooledOnly,
    noSource: red,
    redCells,
    byCity,
  }
}
