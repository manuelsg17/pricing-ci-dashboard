import { useState, useEffect, useMemo } from 'react'
import { getCompetitors } from '../lib/constants'
import { normalizeCompetitorName, isYangoBrand as isYango } from '../lib/normalize'

// Extraído de Rentabilidad.jsx (Fase 1.2) — catálogo de competidores a
// mostrar (unión catálogo + data real + comisiones) y la selección
// explícita/automática (chips toggleables) que alimenta gráficos y tablas.
export function useRentabilidadCompetitors({
  catMap,
  uiCity,
  dbCity,
  country,
  dbConfigs,
  pricesByCat,
  commRows,
  setRefTierCat,
}) {
  // ── Competidores a mostrar (catálogo + lo que haya en data/comisiones) ──
  const competitors = useMemo(() => {
    const set = new Set()
    for (const { uiCat } of catMap) {
      for (const c of getCompetitors(uiCity, uiCat, null, country, dbConfigs)) set.add(c)
    }
    for (const comps of Object.values(pricesByCat)) {
      for (const c of Object.keys(comps)) set.add(c)
    }
    for (const r of commRows) {
      if (!r.city || r.city === dbCity)
        set.add(normalizeCompetitorName(r.competitor_name, { city: r.city }) || r.competitor_name)
    }
    return [...set].sort((a, b) =>
      isYango(a) === isYango(b) ? a.localeCompare(b) : isYango(a) ? -1 : 1
    )
  }, [catMap, pricesByCat, commRows, uiCity, dbCity, country, dbConfigs])

  // Solo los que tienen data real en la ciudad seleccionada: el union de arriba
  // arrastra catálogos de otras dbCity (ej. Corp en Lima) que quedan siempre
  // vacíos e inflan leyenda + barras fantasma. Si no hay nada, cae al catálogo
  // completo para que la vista vacía siga mostrando el set esperado.
  const shownCompetitors = useMemo(() => {
    const withData = new Set()
    for (const comps of Object.values(pricesByCat))
      for (const c of Object.keys(comps)) withData.add(c)
    const filtered = competitors.filter((c) => withData.has(c))
    return filtered.length ? filtered : competitors
  }, [competitors, pricesByCat])

  // ── Selección de competidores (multiselect) ────────────────────────────
  // null = automático (Yango + los 3 rivales con más data). Cuando el usuario
  // toca un chip se vuelve una lista explícita. Se resetea a auto al cambiar
  // ciudad/país para recalcular el default del nuevo mercado.
  const [selectedComps, setSelectedComps] = useState(null)
  useEffect(() => {
    setSelectedComps(null)
    setRefTierCat(null)
  }, [uiCity, country, setRefTierCat])

  const compCounts = useMemo(() => {
    const counts = {}
    for (const comps of Object.values(pricesByCat))
      for (const [c, pd] of Object.entries(comps)) counts[c] = (counts[c] || 0) + pd.count
    return counts
  }, [pricesByCat])

  // Por defecto se muestran TODOS los competidores con data (Yango primero,
  // rivales ordenados por volumen) — el analista pidió no tener que activar
  // Cabify/otros cada vez.
  const defaultSelection = useMemo(() => {
    const yangos = shownCompetitors.filter(isYango)
    const others = shownCompetitors
      .filter((c) => !isYango(c))
      .sort((a, b) => (compCounts[b] || 0) - (compCounts[a] || 0))
    return [...yangos, ...others]
  }, [shownCompetitors, compCounts])

  // Lo que realmente se grafica: respeta el orden de shownCompetitors (Yango
  // primero) y descarta lo que ya no tiene data tras un cambio de semana.
  const visibleCompetitors = useMemo(() => {
    const base = selectedComps ?? defaultSelection
    return shownCompetitors.filter((c) => base.includes(c))
  }, [selectedComps, defaultSelection, shownCompetitors])

  function toggleComp(c) {
    setSelectedComps((prev) => {
      const cur = prev ?? defaultSelection
      return cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]
    })
  }

  return { competitors, shownCompetitors, visibleCompetitors, toggleComp }
}
