import { useMemo } from 'react'
import { useRushValleyStats } from '../../hooks/useMarketStats'
import { COMPETITOR_COLORS } from '../../lib/constants'
import { normalizeCompetitorName } from '../../lib/normalize'
import { useI18n } from '../../context/LanguageContext'

export default function RushVsValley({ filters, currency = '' }) {
  const { t } = useI18n()
  const { rawRows, loading } = useRushValleyStats(filters)

  // RPC ya agregó: { competition_name, rush_avg, rush_n, valley_avg, valley_n }
  const rows = useMemo(() => {
    const out = (rawRows || []).filter(Boolean).map((r) => {
      const valleyAvg = r.valley_avg != null ? Number(r.valley_avg) : null
      const rushAvg = r.rush_avg != null ? Number(r.rush_avg) : null
      const diffPct = valleyAvg && rushAvg ? ((rushAvg - valleyAvg) / valleyAvg) * 100 : null
      const comp =
        normalizeCompetitorName(r.competition_name, { city: filters.dbCity }) || r.competition_name
      return {
        comp,
        valleyAvg,
        rushAvg,
        diffPct,
        valleyN: Number(r.valley_n || 0),
        rushN: Number(r.rush_n || 0),
      }
    })
    return out.sort((a, b) => (b.diffPct || 0) - (a.diffPct || 0))
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
        {t('market.rush_valley.no_data')}
      </div>
    )
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
        <thead>
          <tr style={{ background: '#f8fafc' }}>
            <th style={th}>{t('dashboard.table.competitor')}</th>
            <th style={th}>{t('market.rush_valley.col_valley', { currency })}</th>
            <th style={th}>{t('market.rush_valley.col_n_valley')}</th>
            <th style={th}>{t('market.rush_valley.col_rush', { currency })}</th>
            <th style={th}>{t('market.rush_valley.col_n_rush')}</th>
            <th style={th}>{t('market.rush_valley.col_diff')}</th>
            <th style={{ ...th, textAlign: 'left' }}>{t('market.rush_valley.col_surge')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const tag =
              r.diffPct == null
                ? null
                : r.diffPct < 5
                  ? { text: t('market.rush_valley.tag_soft'), color: '#15803d' }
                  : r.diffPct < 12
                    ? { text: t('market.rush_valley.tag_moderate'), color: '#65a30d' }
                    : r.diffPct < 20
                      ? { text: t('market.rush_valley.tag_strong'), color: '#a16207' }
                      : { text: t('market.rush_valley.tag_aggressive'), color: '#b91c1c' }
            return (
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
                </td>
                <td style={td}>{r.valleyAvg != null ? r.valleyAvg.toFixed(2) : '—'}</td>
                <td style={tdMuted}>{r.valleyN.toLocaleString()}</td>
                <td style={td}>{r.rushAvg != null ? r.rushAvg.toFixed(2) : '—'}</td>
                <td style={tdMuted}>{r.rushN.toLocaleString()}</td>
                <td
                  style={{
                    ...td,
                    fontWeight: 700,
                    color: r.diffPct > 0 ? '#b91c1c' : r.diffPct < 0 ? '#15803d' : 'inherit',
                  }}
                >
                  {r.diffPct == null ? '—' : `${r.diffPct >= 0 ? '+' : ''}${r.diffPct.toFixed(1)}%`}
                </td>
                <td style={{ ...td, textAlign: 'left', color: tag?.color, fontWeight: 600 }}>
                  {tag?.text || '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
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
