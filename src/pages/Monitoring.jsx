import { useCountry } from '../context/CountryContext'
import { useI18n } from '../context/LanguageContext'
import { Button } from '../components/ui/shadcn/button'
import { useLiveSessions } from '../hooks/useLiveSessions'
import { useMonitoringData } from '../hooks/useMonitoringData'
import { useWeeklyCoverage } from '../hooks/useWeeklyCoverage'
import { usePriceComplianceAlerts } from '../hooks/usePriceComplianceAlerts'
import RepresentativityCard from '../components/dashboard/RepresentativityCard'
import LiveSessionsPanel from '../components/monitoring/LiveSessionsPanel'
import UnfinishedSessionsPanel from '../components/monitoring/UnfinishedSessionsPanel'
import HubSummaryTable from '../components/monitoring/HubSummaryTable'
import DetailTable from '../components/monitoring/DetailTable'
import CompletedSessionsTable from '../components/monitoring/CompletedSessionsTable'
import WeeklyCoveragePanel from '../components/monitoring/WeeklyCoveragePanel'
import PriceComplianceAlerts from '../components/monitoring/PriceComplianceAlerts'
import ClientErrorsPanel from '../components/monitoring/ClientErrorsPanel'
import TurnoTimesPanel from '../components/monitoring/TurnoTimesPanel'
import '../styles/data-entry.css'
import '../styles/monitoring.css'

// Monitoreo de la carga de hubs — SOLO admin. La seguridad real está en las
// RPCs get_hub_monitoring/get_unfinished_ci_sessions (IF NOT is_admin RAISE)
// y en la RLS de ci_sessions/ci_active_sessions; esta página además se
// renderiza solo si isAdmin (ver App.jsx). Orquestador delgado sobre hooks +
// componentes (mismo patrón que RawData.jsx): useLiveSessions (mig 146,
// latido en vivo) + useMonitoringData (carga histórica por rango de fecha).
export default function Monitoring() {
  const { country } = useCountry()
  const { t } = useI18n()

  const { live, recentInactive, failed: liveFailed } = useLiveSessions(country)
  const {
    from,
    setFrom,
    to,
    setTo,
    loading,
    failed,
    load,
    byHub,
    totalRows,
    detail,
    sessions,
    sessionsTotal,
    unfinished,
  } = useMonitoringData(country)
  const coverage = useWeeklyCoverage(country)
  const priceAlerts = usePriceComplianceAlerts(country)

  return (
    <div className="de-page">
      <div className="de-header">
        <div className="de-header__left">
          <h1>{t('monitoring.title')}</h1>
        </div>
      </div>

      {/* Primero de todo, y solo aparece si hay algo: un error que un hub
          está viendo AHORA gana en prioridad sobre cualquier métrica (mig 185). */}
      <ClientErrorsPanel />

      {/* Cuánto tarda cada corte (mig 195). Va arriba de la representatividad
          porque responde una pregunta de gestión —"¿cuánto le lleva a mi
          equipo?"— y no de calidad del dato. */}
      <TurnoTimesPanel />

      <RepresentativityCard />

      <PriceComplianceAlerts
        alerts={priceAlerts.alerts}
        loading={priceAlerts.loading}
        failed={priceAlerts.failed}
      />

      <LiveSessionsPanel live={live} recentInactive={recentInactive} failed={liveFailed} />

      <WeeklyCoveragePanel
        year={coverage.year}
        week={coverage.week}
        rowKeys={coverage.rowKeys}
        cellByRowBracket={coverage.cellByRowBracket}
        brackets={coverage.brackets}
        loading={coverage.loading}
        failed={coverage.failed}
        onPrevWeek={coverage.goToPrevWeek}
        onNextWeek={coverage.goToNextWeek}
        onCurrentWeek={coverage.goToCurrentWeek}
      />

      <div className="de-session-bar" style={{ alignItems: 'flex-end' }}>
        <div className="de-session-controls">
          <label className="de-ctrl">
            <span>{t('filter.from')}</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="de-ctrl">
            <span>{t('filter.to')}</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <Button size="sm" onClick={load} disabled={loading}>
            {loading ? t('dataentry.searching') : t('dataentry.search')}
          </Button>
        </div>
      </div>

      {failed ? (
        <div className="de-msg de-msg--err">{t('monitoring.failed')}</div>
      ) : (
        <>
          <UnfinishedSessionsPanel rows={unfinished} onClosed={load} />
          <HubSummaryTable byHub={byHub} totalRows={totalRows} />
          <DetailTable detail={detail} />
          <CompletedSessionsTable sessions={sessions} total={sessionsTotal} />
        </>
      )}
    </div>
  )
}
