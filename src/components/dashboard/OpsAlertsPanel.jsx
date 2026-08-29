import { AlertTriangle, AlertCircle, Check, Info } from 'lucide-react'
import { Button } from '../ui/shadcn/button'
import { useI18n } from '../../context/LanguageContext'
import { useOpsAlerts } from '../../hooks/useOpsAlerts'

// severity viene de un sistema que NO controlamos (el watchdog del scraper),
// así que un valor inesperado NO debe romper el panel ni pintarse como si
// fuera grave: cae a un estilo neutro. Ver mig 227 (la tabla no tiene CHECK
// sobre severity a propósito, para que el sync no falle si aparece un nivel
// nuevo).
const SEVERITY_STYLES = {
  problem: {
    border: '#fca5a5',
    borderLeft: '#dc2626',
    bg: '#fef2f2',
    fg: '#991b1b',
    Icon: AlertCircle,
  },
  warning: {
    border: '#fde68a',
    borderLeft: '#f59e0b',
    bg: '#fffbeb',
    fg: '#92400e',
    Icon: AlertTriangle,
  },
}
const NEUTRAL_STYLE = {
  border: '#e2e8f0',
  borderLeft: '#94a3b8',
  bg: '#f8fafc',
  fg: '#475569',
  Icon: Info,
}

function formatWhen(iso, locale) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(locale, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function OpsAlertsPanel() {
  const { t, locale } = useI18n()
  const { alerts, problemCount, loading, error, resolveAlert, resolvingId } = useOpsAlerts()

  // Panel silencioso cuando no hay nada que atender: sin alertas abiertas no
  // ocupa espacio arriba del dashboard. Los errores SÍ se muestran — un panel
  // que falla en silencio es indistinguible de "todo bien", que es
  // exactamente el modo de falla que este panel viene a evitar.
  if (!loading && !error && alerts.length === 0) return null

  return (
    <section className="ops-alerts" aria-label={t('dashboard.ops_alerts.title')}>
      <header className="ops-alerts__header">
        <span className="ops-alerts__title">
          <AlertCircle size={14} />
          {t('dashboard.ops_alerts.title')}
        </span>
        {/* Contador de 'problem' destacado: es la señal que debe saltar a la
            vista. Se muestra SOLO si hay problems abiertos — un panel con
            puros warnings no debe pintar un número rojo de alarma. */}
        {problemCount > 0 && (
          <span className="ops-alerts__badge-problem">
            {t('dashboard.ops_alerts.kpi_problems', { n: problemCount, count: problemCount })}
          </span>
        )}
        {alerts.length > 0 && (
          <span className="ops-alerts__count">
            {t('dashboard.ops_alerts.open_count', { n: alerts.length, count: alerts.length })}
          </span>
        )}
      </header>

      {error && <div className="ops-alerts__error">{error}</div>}

      {loading && alerts.length === 0 && (
        <div className="ops-alerts__empty">{t('app.loading')}</div>
      )}

      <ul className="ops-alerts__list">
        {alerts.map((a) => {
          const style = SEVERITY_STYLES[a.severity] || NEUTRAL_STYLE
          const { Icon } = style
          const isResolving = resolvingId === a.id
          return (
            <li
              key={a.id}
              className="ops-alerts__item"
              style={{
                background: style.bg,
                border: `1px solid ${style.border}`,
                borderLeft: `3px solid ${style.borderLeft}`,
              }}
            >
              <Icon size={15} style={{ color: style.fg, flexShrink: 0 }} aria-hidden="true" />
              <div className="ops-alerts__body">
                <div className="ops-alerts__message" style={{ color: style.fg }}>
                  {a.message || '—'}
                </div>
                <div className="ops-alerts__meta">
                  {formatWhen(a.created_at_utc, locale)}
                  {a.source ? ` · ${a.source}` : ''}
                  {` · ${a.severity}`}
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isResolving}
                onClick={() => resolveAlert(a.id)}
                className="ops-alerts__resolve"
              >
                <Check size={13} />
                {isResolving
                  ? t('dashboard.ops_alerts.resolving')
                  : t('dashboard.ops_alerts.resolve')}
              </Button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
