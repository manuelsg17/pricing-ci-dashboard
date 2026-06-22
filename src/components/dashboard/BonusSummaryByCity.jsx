import { useMemo } from 'react'
import { useCompetitorBonuses } from '../../hooks/useCompetitorBonuses'
import { describeBonus } from '../../lib/competitorBonus'
import { COMPETITOR_COLORS } from '../../lib/constants'
import CollapsibleSection from '../market/CollapsibleSection'

// Resumen READ-ONLY de los bonos mapeados para la ciudad seleccionada.
// Misma fuente que Config → Bonos (competitor_bonuses vía useCompetitorBonuses)
// + el bono Yango por % de GMV (yango_gmv_tiers, recibido por prop). No escribe.
const SEGMENT_LABEL = {
  active: 'Activo',
  new: 'Nuevo',
  reactivated: 'Reactivado',
  all: '',
}
const VARIANT_LABEL = {
  unbranded: 'Sin brandeo',
  branded: 'Con brandeo',
  vip: 'VIP (Premier)',
}

const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 12 }
const thS = {
  textAlign: 'left',
  padding: '6px 10px',
  borderBottom: '1px solid var(--color-border)',
  color: 'var(--color-muted)',
  fontWeight: 600,
  whiteSpace: 'nowrap',
}
const tdS = {
  padding: '6px 10px',
  borderBottom: '1px solid var(--color-border-soft, #eef2f7)',
  verticalAlign: 'top',
}

// Chips de contexto (segmento / recurrencia / ventana / zona) de un bono.
function metaOf(b) {
  const parts = []
  const seg = SEGMENT_LABEL[b.segment || 'all']
  if (seg) parts.push(seg)
  if (b.recurring === false) parts.push('gancho 1 vez')
  const win = [b.day_window, [b.time_from, b.time_to].filter(Boolean).join('–')]
    .filter(Boolean)
    .join(' ')
  if (win) parts.push(win)
  if (b.zone) parts.push(b.zone)
  return parts.join(' · ')
}

export default function BonusSummaryByCity({
  country,
  dbCity,
  currency = 'S/',
  yangoGmvTiers = [],
}) {
  const { allRows, loading } = useCompetitorBonuses(dbCity, country)

  // Bonos de competidores activos que aplican a la ciudad activa
  // (city = ciudad seleccionada, o city = null = "todas las ciudades").
  const compRows = useMemo(() => {
    const rows = (allRows || []).filter(
      (r) => r.is_active !== false && (r.city === dbCity || !r.city)
    )
    const byComp = {}
    for (const r of rows) {
      ;(byComp[r.competitor_name] ||= []).push(r)
    }
    return Object.entries(byComp)
  }, [allRows, dbCity])

  // Bono Yango % GMV para la ciudad activa, una línea por variante presente.
  const yangoRows = useMemo(() => {
    const out = []
    for (const variant of ['unbranded', 'branded', 'vip']) {
      const tiers = (yangoGmvTiers || [])
        .filter((t) => t.city === dbCity && t.variant === variant)
        .sort((a, b) => Number(a.min_trips) - Number(b.min_trips))
      if (!tiers.length) continue
      const text = tiers
        .map(
          (t) =>
            `≥${t.min_trips}→${t.pct}%${Number(t.cap) > 0 ? ` (tope ${currency} ${t.cap})` : ''}`
        )
        .join(' · ')
      out.push({ variant, text })
    }
    return out
  }, [yangoGmvTiers, dbCity, currency])

  const empty = !loading && compRows.length === 0 && yangoRows.length === 0

  return (
    <CollapsibleSection
      id="bonos-mapeados"
      title={`Bonos mapeados — ${dbCity}`}
      subtitle="Lo que está cargado hoy en Config → Bonos para esta ciudad (solo lectura)."
      defaultOpen={true}
    >
      {loading ? (
        <div style={{ fontSize: 12, color: 'var(--color-muted)' }}>Cargando bonos…</div>
      ) : empty ? (
        <div style={{ fontSize: 12, color: 'var(--color-muted)' }}>
          Sin bonos mapeados para {dbCity}.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thS}>Competidor</th>
                <th style={thS}>Bono / incentivo</th>
                <th style={thS}>Aplica</th>
              </tr>
            </thead>
            <tbody>
              {/* Yango — bono % GMV por variante */}
              {yangoRows.map((y) => (
                <tr key={`yango-${y.variant}`}>
                  <td style={{ ...tdS, fontWeight: 600, whiteSpace: 'nowrap' }}>
                    <span style={{ color: COMPETITOR_COLORS['Yango'] || '#E53935' }}>●</span> Yango
                  </td>
                  <td style={tdS}>
                    <span style={{ color: 'var(--color-muted)' }}>% GMV: </span>
                    {y.text}
                  </td>
                  <td style={{ ...tdS, color: 'var(--color-muted)' }}>
                    {VARIANT_LABEL[y.variant]}
                  </td>
                </tr>
              ))}

              {/* Competidores — un renglón por bono mapeado */}
              {compRows.map(([comp, bonuses]) =>
                bonuses.map((b, i) => (
                  <tr key={`${comp}-${b.id}`}>
                    <td style={{ ...tdS, fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {i === 0 ? (
                        <>
                          <span style={{ color: COMPETITOR_COLORS[comp] || '#64748b' }}>●</span>{' '}
                          {comp}
                        </>
                      ) : (
                        ''
                      )}
                    </td>
                    <td style={tdS}>
                      {describeBonus(b, currency)}
                      {b.description ? (
                        <span style={{ color: 'var(--color-muted)' }}> — {b.description}</span>
                      ) : null}
                      {!b.city && (
                        <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--color-muted)' }}>
                          (todas las ciudades)
                        </span>
                      )}
                    </td>
                    <td style={{ ...tdS, color: 'var(--color-muted)' }}>{metaOf(b) || '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-muted)' }}>
            Se edita en <strong>Config → Bonos</strong>. El bono de Yango por % de GMV se ajusta en
            la sub-pestaña <strong>Bono Yango (% GMV)</strong>.
          </div>
        </div>
      )}
    </CollapsibleSection>
  )
}
