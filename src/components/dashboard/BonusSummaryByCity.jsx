import { useMemo } from 'react'
import { describeBonus } from '../../lib/competitorBonus'
import { COMPETITOR_COLORS } from '../../lib/constants'
import CollapsibleSection from '../market/CollapsibleSection'
import { useI18n } from '../../context/LanguageContext'

// Resumen READ-ONLY de los bonos mapeados para la ciudad seleccionada.
// Misma fuente que Config → Bonos: recibe `bonusRows` (allRows de
// competitor_bonuses) del hook que Rentabilidad ya tiene — sin re-fetch — y el
// bono Yango por % de GMV (yango_gmv_tiers) por prop. No escribe nada.
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
function metaOf(b, t) {
  const parts = []
  const segmentLabel = {
    active: t('dashboard.bonus_summary.segment_active'),
    new: t('dashboard.bonus_summary.segment_new'),
    reactivated: t('dashboard.bonus_summary.segment_reactivated'),
    all: '',
  }
  const seg = segmentLabel[b.segment || 'all']
  if (seg) parts.push(seg)
  if (b.recurring === false) parts.push(t('dashboard.bonus_summary.one_time_hook'))
  const win = [b.day_window, [b.time_from, b.time_to].filter(Boolean).join('–')]
    .filter(Boolean)
    .join(' ')
  if (win) parts.push(win)
  if (b.zone) parts.push(b.zone)
  return parts.join(' · ')
}

export default function BonusSummaryByCity({
  dbCity,
  currency = 'S/',
  yangoGmvTiers = [],
  bonusRows = [],
  loading = false,
}) {
  const { t } = useI18n()
  const variantLabel = {
    unbranded: t('dashboard.bonus_summary.variant_unbranded'),
    branded: t('dashboard.bonus_summary.variant_branded'),
    vip: t('dashboard.bonus_summary.variant_vip'),
  }

  // Bonos de competidores activos que aplican a la ciudad activa
  // (city = ciudad seleccionada, o city = null = "todas las ciudades").
  const compRows = useMemo(() => {
    const rows = (bonusRows || []).filter(
      (r) => r.is_active !== false && (r.city === dbCity || !r.city)
    )
    const byComp = {}
    for (const r of rows) {
      ;(byComp[r.competitor_name] ||= []).push(r)
    }
    return Object.entries(byComp)
  }, [bonusRows, dbCity])

  // Bono Yango % GMV para la ciudad activa, una línea por variante presente.
  const yangoRows = useMemo(() => {
    const out = []
    for (const variant of ['unbranded', 'branded', 'vip']) {
      const tiers = (yangoGmvTiers || [])
        .filter((tier) => tier.city === dbCity && tier.variant === variant)
        .sort((a, b) => Number(a.min_trips) - Number(b.min_trips))
      if (!tiers.length) continue
      const text = tiers
        .map(
          (tier) =>
            `≥${tier.min_trips}→${tier.pct}%${Number(tier.cap) > 0 ? ` (tope ${currency} ${tier.cap})` : ''}`
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
      title={t('dashboard.bonus_summary.title', { city: dbCity })}
      subtitle={t('dashboard.bonus_summary.subtitle')}
      defaultOpen={true}
    >
      {loading ? (
        <div style={{ fontSize: 12, color: 'var(--color-muted)' }}>
          {t('dashboard.bonus_summary.loading')}
        </div>
      ) : empty ? (
        <div style={{ fontSize: 12, color: 'var(--color-muted)' }}>
          {t('dashboard.bonus_summary.empty', { city: dbCity })}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thS}>{t('dashboard.table.competitor')}</th>
                <th style={thS}>{t('dashboard.bonus_summary.col_bonus')}</th>
                <th style={thS}>{t('dashboard.bonus_summary.col_applies')}</th>
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
                    <span style={{ color: 'var(--color-muted)' }}>
                      {t('dashboard.bonus_summary.gmv_label')}{' '}
                    </span>
                    {y.text}
                  </td>
                  <td style={{ ...tdS, color: 'var(--color-muted)' }}>{variantLabel[y.variant]}</td>
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
                          {t('dashboard.bonus_summary.all_cities_tag')}
                        </span>
                      )}
                    </td>
                    <td style={{ ...tdS, color: 'var(--color-muted)' }}>{metaOf(b, t) || '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-muted)' }}>
            {t('dashboard.bonus_summary.footer')}
          </div>
        </div>
      )}
    </CollapsibleSection>
  )
}
