import { useBotCoverageRecent } from '../../hooks/useBotCoverage'
import { useCountry } from '../../context/CountryContext'
import { useI18n } from '../../context/LanguageContext'
import CollapsibleSection from '../market/CollapsibleSection'
import BotCoverageMatrix from '../upload/BotCoverageMatrix'
import { computeCoverageStatus } from '../../lib/botCoverage'

// Tarjeta de frescura de la data del bot para la parte principal del dashboard.
// Muestra un SEMÁFORO de estado siempre visible en la cabecera (verde/amarillo/
// rojo — "notorio") y se expande a la matriz completa ciudad × bracket para que
// cualquiera vea cómo va la actualización. Lee de la RPC bot_coverage_recent
// (mig 134); si la RPC falla o no hay data, no renderiza nada (inerte).

const LEVEL_COLORS = {
  ok: { bg: '#dcfce7', fg: '#166534', dot: '#16a34a' },
  warn: { bg: '#fef9c3', fg: '#854d0e', dot: '#ca8a04' },
  bad: { bg: '#fee2e2', fg: '#991b1b', dot: '#dc2626' },
}

export default function BotCoverageCard() {
  const { country } = useCountry()
  const { t } = useI18n()
  const { rows, failed } = useBotCoverageRecent(country)

  if (failed || !rows || rows.length === 0) return null

  const status = computeCoverageStatus(rows)
  const colors = LEVEL_COLORS[status.level]
  const label =
    status.level === 'bad'
      ? t('dashboard.coverage.status_bad', { n: status.red })
      : status.level === 'warn'
        ? t('dashboard.coverage.status_warn', { n: status.amber })
        : t('dashboard.coverage.status_ok')

  const statusPill = (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        borderRadius: 999,
        background: colors.bg,
        color: colors.fg,
        fontSize: 11,
        fontWeight: 700,
        border: `1px solid ${colors.dot}40`,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: colors.dot,
          boxShadow: `0 0 0 2px ${colors.dot}30`,
        }}
      />
      {label}
    </span>
  )

  return (
    <CollapsibleSection
      id="bot-coverage"
      title={t('dashboard.coverage.title')}
      subtitle={t('botdbsync.coverage_subtitle')}
      defaultOpen={false}
      action={statusPill}
    >
      <BotCoverageMatrix rows={rows} t={t} />
      <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 8, fontStyle: 'italic' }}>
        {t('botdbsync.coverage_legend')}
      </div>
    </CollapsibleSection>
  )
}
