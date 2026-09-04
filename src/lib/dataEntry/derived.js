// Derivados puros de Ingresar CI (sin React): agrupación de pestañas por
// ciudad y resumen de revisiones del historial. Extraídos de DataEntry.jsx
// (2026-09) sin cambiar la lógica.

// Pestañas agrupadas POR CIUDAD. Cada "cluster" es una ciudad base (Lima,
// Trujillo, Arequipa) con sus variantes: Normal, Corp, ✈ Aeropuerto (Punto
// A/B) y TukTuk (por distrito). Los aeropuertos `{Base}_Airport_{A|B}` caen
// bajo su base; Corp (ciudad propia en BD) se muestra bajo Lima porque es el
// corporativo de Lima; una ciudad con la categoría 'TukTuk' gana una pestaña
// TukTuk. Países simples quedan como una pestaña suelta.
export function buildCityClusters(uiCities, categoriesByCity) {
  const CORP_UNDER = { Corp: 'Lima' } // Perú: Corp = corporativo de Lima
  const clusters = []
  const byBase = {}
  const ensure = (base) => {
    if (!byBase[base]) {
      byBase[base] = { base, tabs: [] }
      clusters.push(byBase[base])
    }
    return byBase[base]
  }
  for (const c of uiCities) {
    const am = /^(.+)_Airport_([AB])$/.exec(c)
    if (am) {
      const base = am[1]
      const cl = ensure(base)
      let ap = cl.tabs.find((tb) => tb.type === 'airport')
      if (!ap) {
        ap = { type: 'airport', base, members: [] }
        cl.tabs.push(ap)
      }
      ap.members.push({ uiCity: c, side: am[2] })
      continue
    }
    if (c === 'Corp') {
      // Solo redirige bajo la ciudad mapeada si esa ciudad REALMENTE existe
      // en este país — si no, Corp queda como su propio cluster en vez de
      // crear un cluster "Lima" fantasma con un único tab Corp adentro.
      const target = CORP_UNDER[c] && uiCities.includes(CORP_UNDER[c]) ? CORP_UNDER[c] : c
      ensure(target).tabs.push({ type: 'corp', uiCity: c })
      continue
    }
    ensure(c).tabs.push({ type: 'normal', uiCity: c })
    if ((categoriesByCity[c] || []).includes('TukTuk')) {
      ensure(c).tabs.push({ type: 'tuktuk', baseUiCity: c })
    }
  }
  for (const cl of clusters)
    for (const tb of cl.tabs)
      if (tb.type === 'airport') tb.members.sort((a, b) => a.side.localeCompare(b.side))
  const order = { normal: 0, corp: 1, airport: 2, tuktuk: 3 }
  for (const cl of clusters) cl.tabs.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9))
  return clusters
}

// Rastro de ediciones: `ci_sessions` inserta una fila NUEVA en cada
// Finalizar — nunca sobrescribe — así que reabrir y re-finalizar deja 2+
// filas para la misma ciudad/zona/fecha. Devuelve, para la fila más reciente
// de cada grupo, { count, lastEditor }. Puro cálculo en memoria.
export function computeRevisionInfo(sessionHistory) {
  const groups = {}
  for (const s of sessionHistory) {
    const key = `${s.city}|${s.zone || ''}|${s.observed_date}`
    ;(groups[key] ||= []).push(s)
  }
  const m = {}
  for (const list of Object.values(groups)) {
    if (list.length < 2) continue
    const latest = [...list].sort((a, b) => new Date(b.started_at) - new Date(a.started_at))[0]
    m[latest.id] = { count: list.length, lastEditor: latest.user_email }
  }
  return m
}
