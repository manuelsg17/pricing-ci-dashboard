import { Badge } from '../ui/shadcn/badge'
import { useI18n } from '../../context/LanguageContext'

function KpiCard({ variant, title, pct, count, total, hint }) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 200,
        padding: '14px 16px',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-border)',
        background: 'var(--color-panel)',
        boxShadow: 'var(--shadow-xs)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--color-muted)',
            textTransform: 'uppercase',
            letterSpacing: 0.4,
          }}
        >
          {title}
        </span>
        <Badge variant={variant}>{pct}%</Badge>
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--color-text)' }}>
        {count.toLocaleString()}
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-muted)' }}>
          {' '}
          / {total.toLocaleString()}
        </span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 4 }}>{hint}</div>
    </div>
  )
}

// 3 tarjetas KPI con semáforo — reusa tokens --sem-green/yellow/red ya
// existentes vía las variantes success/warning/danger del Badge shadcn.
export default function ComplianceKpis({ summary }) {
  const { t } = useI18n()
  if (!summary || !summary.total_observations) return null
  const total = Number(summary.total_observations)

  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
      <KpiCard
        variant="warning"
        title={t('competitiveBands.compliance.below_title')}
        pct={summary.below_pct}
        count={Number(summary.below_count)}
        total={total}
        hint={t('competitiveBands.compliance.below_hint')}
      />
      <KpiCard
        variant="success"
        title={t('competitiveBands.compliance.within_title')}
        pct={summary.within_pct}
        count={Number(summary.within_count)}
        total={total}
        hint={t('competitiveBands.compliance.within_hint')}
      />
      <KpiCard
        variant="danger"
        title={t('competitiveBands.compliance.above_title')}
        pct={summary.above_pct}
        count={Number(summary.above_count)}
        total={total}
        hint={t('competitiveBands.compliance.above_hint')}
      />
    </div>
  )
}
