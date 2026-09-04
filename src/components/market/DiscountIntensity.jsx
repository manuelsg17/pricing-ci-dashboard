import { useMemo } from 'react'
import { useDiscountStats } from '../../hooks/useMarketStats'
import { COMPETITOR_COLORS } from '../../lib/constants'
import { normalizeCompetitorName } from '../../lib/normalize'
import { useI18n } from '../../context/LanguageContext'

export default function DiscountIntensity({ filters, currency = '' }) {
  const { t } = useI18n()
  const { rawRows, loading } = useDiscountStats(filters)

  // RPC ya agregó: { competition_name, list_avg, final_avg, with_discount, n_total }
  const rows = useMemo(() => {
    const out = (rawRows || [])
      .filter((r) => r && r.list_avg != null && r.final_avg != null && Number(r.list_avg) > 0)
      .map((r) => {
        const listAvg = Number(r.list_avg)
        const finalAvg = Number(r.final_avg)
        const obs = Number(r.n_total || 0)
        const withDisc = Number(r.with_discount || 0)
        const discountPct = listAvg > 0 ? ((finalAvg - listAvg) / listAvg) * 100 : 0
        const pctWithDisc = obs > 0 ? (withDisc / obs) * 100 : 0
        const comp =
          normalizeCompetitorName(r.competition_name, { city: filters.dbCity }) ||
          r.competition_name
        return { comp, listAvg, finalAvg, discountPct, obs, pctWithDisc }
      })
    return out.sort((a, b) => a.discountPct - b.discountPct)
  }, [rawRows, filters.dbCity])

  if (loading && !rawRows.length) {
    return (
      <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: 12 }}>
        {t('app.loading')}
      </div>
    )
  }
  if (!rows.length) {
    return (
      <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: 12 }}>
        {t('market.discount_intensity.no_comparable')}
      </div>
    )
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
        <thead>
          <tr style={{ background: '#f8fafc' }}>
            <th style={th}>{t('dashboard.table.competitor')}</th>
            <th style={th}>{t('market.discount_intensity.col_list', { currency })}</th>
            <th style={th}>{t('market.discount_intensity.col_final', { currency })}</th>
            <th style={th}>{t('market.discount_intensity.col_avg_discount')}</th>
            <th style={th}>{t('market.discount_intensity.col_pct_with_discount')}</th>
            <th style={th}>{t('market.discount_intensity.col_n_obs')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.comp} style={{ borderBottom: '1px solid var(--color-border-soft)' }}>
              <td style={{ ...td, textAlign: 'left' }}>
                <span
                  style={{
                    background: COMPETITOR_COLORS[r.comp] || '#64748b',
                    color: '#fff',
                    padding: '1px 6px',
                    borderRadius: 3,
                    fontWeight: 700,
                    fontSize: 11,
                  }}
                >
                  {r.comp}
                </span>
                {r.comp === 'InDrive' && (
                  <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--color-muted)' }}>
                    {t('market.discount_intensity.indrive_note')}
                  </span>
                )}
              </td>
              <td style={td}>{r.listAvg.toFixed(2)}</td>
              <td style={td}>{r.finalAvg.toFixed(2)}</td>
              <td
                style={{
                  ...td,
                  fontWeight: 700,
                  color: r.discountPct < -5 ? '#15803d' : r.discountPct < 0 ? '#65a30d' : 'inherit',
                }}
              >
                {r.discountPct >= 0 ? '+' : ''}
                {r.discountPct.toFixed(1)}%
              </td>
              <td style={td}>{r.pctWithDisc.toFixed(0)}%</td>
              <td style={tdMuted}>{r.obs.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 8 }}>
        {t('market.discount_intensity.footer_prefix')} <code>price_with_discount</code>{' '}
        {t('market.discount_intensity.footer_mid')} <code>price_without_discount</code>.{' '}
        {t('market.discount_intensity.footer_indrive')} <code>minimal_bid</code>{' '}
        {t('market.discount_intensity.footer_mid')} <code>recommended_price</code>{' '}
        {t('market.discount_intensity.footer_indrive_suffix')}
      </div>
    </div>
  )
}

const th = {
  padding: '6px 10px',
  textAlign: 'right',
  borderBottom: '2px solid var(--color-border)',
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--color-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.4px',
}
const td = { padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
const tdMuted = { ...td, color: 'var(--color-muted)', fontSize: 11 }
