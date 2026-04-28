import { Fragment, useEffect, useMemo, useState } from 'react'
import { sb } from '../../lib/supabase'
import { getCountryConfig, BRACKET_LABELS, BRACKETS, COMPETITOR_COLORS } from '../../lib/constants'

// Pretty-print de un par (vehicle_category, observed_vehicle_category) tal
// como el bot lo registra. Si ovc='*' (wildcard) lo omitimos para no llenar
// la leyenda con asteriscos confusos.
function fmtTier(rule) {
  const vc  = (rule.vc  || '—').toString()
  const ovc = (rule.ovc || '').toString()
  if (!ovc || ovc === '*') return vc
  if (vc === ovc) return vc
  return `${vc} → ${ovc}`
}

export default function DashboardLegend({ country, dbCity, dbCategory, currency }) {
  const [open, setOpen] = useState(false)
  const [thresholds, setThresholds] = useState([])
  const [loading, setLoading] = useState(false)
  const config = useMemo(() => getCountryConfig(country), [country])

  // Fetch thresholds del (country, city, category) actual sólo cuando
  // se abre el modal, para no pegarle a Supabase hasta que se necesite.
  useEffect(() => {
    if (!open || !dbCity || !dbCategory) return
    let cancelled = false
    setLoading(true)
    sb.from('distance_thresholds')
      .select('bracket, max_km')
      .eq('country', country)
      .eq('city', dbCity)
      .eq('category', dbCategory)
      .then(({ data }) => {
        if (cancelled) return
        setThresholds(data || [])
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [open, country, dbCity, dbCategory])

  // Categorías de la ciudad de UI actual + las reglas que aplican a cada una.
  // Los nombres "UI" (categoriesByCity) pueden incluir "Aeropuerto" que es
  // un agregado — para el panel mostramos las categorías DB reales.
  const categoryRules = useMemo(() => {
    const rules = config.botRules || []
    const result = {}
    for (const rule of rules) {
      // Si la regla tiene cities y la ciudad actual no está, saltamos.
      if (rule.cities && rule.cities.length && !rule.cities.includes(dbCity)) continue
      const cat = rule.category
      if (!result[cat]) result[cat] = []
      result[cat].push(rule)
    }
    return result
  }, [config, dbCity])

  // Competidores conocidos para esta (city, category) — algunos como
  // Cabify no están en botRules porque se ingresan manualmente. Los
  // marcamos para que el usuario sepa que no vienen del bot.
  const competitorsForCategory = useMemo(() => {
    return config.competitorsByDbCityCategory?.[dbCity]?.[dbCategory] || []
  }, [config, dbCity, dbCategory])

  // Ordenar brackets en el orden canónico very_short → very_long,
  // omitiendo los que no estén en la config (pueden ser distintos por país).
  const orderedThresholds = useMemo(() => {
    const map = {}
    for (const t of thresholds) map[t.bracket] = t.max_km
    return BRACKETS.map(b => ({ bracket: b, max_km: map[b] ?? null }))
                   .filter(t => t.max_km != null || thresholds.some(x => x.bracket === t.bracket))
  }, [thresholds])

  if (!open) {
    return (
      <button
        type="button"
        className="kpi-export-btn"
        onClick={() => setOpen(true)}
        title="Ver leyenda: qué incluye cada categoría y los rangos de distancia"
        style={{ marginLeft: 6 }}
      >
        📖 Leyenda
      </button>
    )
  }

  return (
    <>
      <button
        type="button"
        className="kpi-export-btn"
        onClick={() => setOpen(false)}
        style={{ marginLeft: 6 }}
      >
        📖 Leyenda
      </button>
      <div
        role="dialog"
        aria-modal="true"
        onClick={() => setOpen(false)}
        style={{
          position: 'fixed', inset: 0, zIndex: 10000,
          background: 'rgba(15,23,42,0.45)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
          padding: 16, paddingTop: 64, backdropFilter: 'blur(2px)',
          overflow: 'auto',
        }}
      >
        <div
          onClick={e => e.stopPropagation()}
          style={{
            background: '#fff', borderRadius: 12, maxWidth: 760, width: '100%',
            padding: 22, boxShadow: '0 20px 50px rgba(0,0,0,0.25)',
            fontSize: 13, color: '#0f172a',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
              📖 Leyenda · {dbCity} · {dbCategory}
            </h3>
            <button
              onClick={() => setOpen(false)}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                fontSize: 18, color: '#64748b', padding: 4,
              }}
              aria-label="Cerrar"
            >
              ✕
            </button>
          </div>

          {/* ── Sección 1: Categorías ─────────────────────────── */}
          <section style={{ marginBottom: 18 }}>
            <h4 style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 700, color: '#1f2937' }}>
              Categorías y qué tier mide cada competidor
            </h4>
            <p style={{ margin: '0 0 8px', color: '#64748b', fontSize: 12 }}>
              Cada categoría del dashboard agrupa el tier equivalente de cada
              competidor (basado en cómo el bot observa la respuesta del API).
              Los competidores marcados como <em>manual</em> se ingresan desde
              los hubs porque el bot no los cubre.
            </p>

            {Object.keys(categoryRules).length === 0 ? (
              <div style={{ color: '#64748b', fontSize: 12 }}>
                No hay reglas de bot configuradas para esta combinación.
              </div>
            ) : (
              Object.entries(categoryRules).map(([cat, rules]) => {
                const compsInCat = config.competitorsByDbCityCategory?.[dbCity]?.[cat] || []
                // Agrupar reglas por competition_name
                const byComp = {}
                for (const r of rules) {
                  if (!byComp[r.name]) byComp[r.name] = []
                  byComp[r.name].push(r)
                }
                return (
                  <div key={cat} style={{ marginBottom: 10, padding: 10, border: '1px solid #e2e8f0', borderRadius: 6, background: '#f8fafc' }}>
                    <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>{cat}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: '4px 12px' }}>
                      {compsInCat.map(comp => {
                        const ruleList = byComp[comp]
                        const color = COMPETITOR_COLORS[comp] || '#64748b'
                        return (
                          <Fragment key={`${cat}-${comp}`}>
                            <div>
                              <span style={{
                                background: color, color: '#fff', padding: '2px 8px',
                                borderRadius: 4, fontSize: 11, fontWeight: 700,
                              }}>
                                {comp}
                              </span>
                            </div>
                            <div style={{ fontSize: 12, color: '#334155' }}>
                              {ruleList && ruleList.length
                                ? ruleList.map(r => fmtTier(r)).join(', ')
                                : <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>manual (entra desde hubs)</span>}
                            </div>
                          </Fragment>
                        )
                      })}
                    </div>
                  </div>
                )
              })
            )}
          </section>

          {/* ── Sección 2: Distance brackets ─────────────────── */}
          <section>
            <h4 style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 700, color: '#1f2937' }}>
              Brackets de distancia · {dbCity} / {dbCategory}
            </h4>
            <p style={{ margin: '0 0 8px', color: '#64748b', fontSize: 12 }}>
              Los rangos se configuran en <strong>Config → Distancias</strong>.
              Cada observación cae en un bucket según los km de la ruta.
            </p>

            {loading ? (
              <div style={{ fontSize: 12, color: '#64748b' }}>Cargando…</div>
            ) : orderedThresholds.length === 0 ? (
              <div style={{ fontSize: 12, color: '#64748b' }}>
                No hay umbrales configurados para esta combinación. Revisa
                <strong> Config → Distancias</strong>.
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#f1f5f9' }}>
                    <th style={{ textAlign: 'left',  padding: '6px 8px', borderBottom: '1px solid #cbd5e1' }}>Bracket</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #cbd5e1' }}>Rango (km)</th>
                  </tr>
                </thead>
                <tbody>
                  {orderedThresholds.map((t, i) => {
                    const prev = i > 0 ? orderedThresholds[i - 1].max_km : 0
                    const range = t.max_km == null
                      ? `> ${prev}`
                      : (i === 0 ? `≤ ${t.max_km}` : `${prev} – ${t.max_km}`)
                    return (
                      <tr key={t.bracket}>
                        <td style={{ padding: '6px 8px', borderBottom: '1px solid #e2e8f0' }}>
                          {BRACKET_LABELS[t.bracket] || t.bracket}
                        </td>
                        <td style={{ padding: '6px 8px', borderBottom: '1px solid #e2e8f0', textAlign: 'right', fontFamily: 'monospace' }}>
                          {range}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </>
  )
}
