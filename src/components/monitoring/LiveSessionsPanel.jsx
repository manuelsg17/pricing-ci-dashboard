import { useState } from 'react'
import { formatCityZoneLabel } from '../../lib/monitoring'
import { useI18n } from '../../context/LanguageContext'

// Sesiones EN VIVO ahora mismo — 1 card por hub activo (mig 146, latido cada
// ~25s desde DataEntry.jsx). "En vivo" = latido hace ≤3 min (ver
// lib/monitoring.js classifySession); entre 3 y 15 min se muestra atenuado
// como "reciente pero inactivo" (probablemente cerró sin Terminar) en un
// bloque colapsable aparte, vacío por defecto.
function timeAgoLabel(iso, t) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return t('common.bot_freshness.time_ago_lt1min')
  const m = Math.floor(s / 60)
  if (m < 60) return t('common.bot_freshness.time_ago_min', { n: m })
  const h = Math.floor(m / 60)
  return t('common.bot_freshness.time_ago_hours', { n: h })
}

function SessionCard({ s, t, live }) {
  const pct = s.total_expected > 0 ? Math.round((s.filled_count / s.total_expected) * 100) : 0
  return (
    <div className={`mon-session-card${live ? '' : ' mon-session-card--inactive'}`}>
      <div className="mon-session-card__head">
        <span className={`mon-status-dot${live ? ' mon-status-dot--live' : ''}`} />
        <span className="mon-session-card__status">
          {live ? t('monitoring.status_live') : t('monitoring.status_inactive_badge')}
        </span>
      </div>
      <strong className="mon-session-card__email">{s.user_email}</strong>
      <div className="mon-session-card__city">{formatCityZoneLabel(s.city, s.zone)}</div>
      {/* Fallos de latido reportados por el propio cliente (mig 149) — la
          sesión sigue "en vivo" pero tuvo cortes intermitentes de conexión
          recientes, señal que antes era invisible para el admin. */}
      {s.recent_failures > 0 && (
        <div className="mon-session-card__warn">
          {t('monitoring.recent_failures_badge', { n: s.recent_failures })}
        </div>
      )}
      <div className="mon-session-card__progress">
        <div className="de-progress-pill">
          <span className="de-progress-filled">{s.filled_count}</span>
          <span className="de-progress-sep">/</span>
          <span className="de-progress-total">{s.total_expected}</span>
          <span className="de-progress-label">{pct}%</span>
        </div>
        <span className="mon-session-card__ago">{timeAgoLabel(s.last_seen_at, t)}</span>
      </div>
    </div>
  )
}

export default function LiveSessionsPanel({ live, recentInactive, failed }) {
  const { t } = useI18n()
  const [showInactive, setShowInactive] = useState(false)

  return (
    <div className="mon-panel">
      <div className="mon-panel__head">
        <h2>{t('monitoring.live_title')}</h2>
        <span className="mon-live-count">{live.length}</span>
      </div>
      <div className="mon-panel__subtitle">{t('monitoring.live_subtitle')}</div>

      {failed ? (
        <div className="de-msg de-msg--err">{t('monitoring.failed')}</div>
      ) : live.length === 0 ? (
        <div className="mon-empty">{t('monitoring.live_empty')}</div>
      ) : (
        <div className="mon-session-grid">
          {live.map((s) => (
            <SessionCard key={s.user_email} s={s} t={t} live />
          ))}
        </div>
      )}

      {recentInactive.length > 0 && (
        <div className="mon-recent-inactive">
          <button
            type="button"
            className="mon-recent-inactive__toggle"
            onClick={() => setShowInactive((v) => !v)}
          >
            {showInactive ? '▲' : '▼'}{' '}
            {t('monitoring.status_recent_inactive', { n: recentInactive.length })}
          </button>
          {showInactive && (
            <div className="mon-session-grid">
              {recentInactive.map((s) => (
                <SessionCard key={s.user_email} s={s} t={t} live={false} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
