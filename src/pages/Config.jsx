import { useState, useMemo } from 'react'
import { useConfig }         from '../hooks/useConfig'
import ThresholdsTable       from '../components/config/ThresholdsTable'
import WeightsTable          from '../components/config/WeightsTable'
import SemaforoEditor        from '../components/config/SemaforoEditor'
import PriceRulesTable       from '../components/config/PriceRulesTable'
import RushHourConfig        from '../components/config/RushHourConfig'
import CITimeslotsConfig     from '../components/config/CITimeslotsConfig'
import CommissionsConfig     from '../components/config/CommissionsConfig'
import BonusesConfig         from '../components/config/BonusesConfig'
import InDriveConfig         from '../components/config/InDriveConfig'
import CountriesConfig       from '../components/config/CountriesConfig'
import BotRulesTable         from '../components/config/BotRulesTable'
import SnapshotsManager      from '../components/config/SnapshotsManager'
import AuditLogViewer        from '../components/config/AuditLogViewer'
import { useI18n }           from '../context/LanguageContext'
import { useCountry }         from '../context/CountryContext'
import { useAccessControl }   from '../hooks/useAccessControl'
import '../styles/config.css'

export default function Config() {
  const { country } = useCountry()
  const [activeTab, setActiveTab] = useState('thresholds')
  const { t } = useI18n()
  const { isAdmin } = useAccessControl()

  const TABS = useMemo(() => {
    const base = [
      { id: 'thresholds',  label: t('config.distances') },
      { id: 'weights',     label: t('config.weights') },
      { id: 'semaforo',    label: t('config.semaforo') },
      { id: 'pricerules',  label: t('config.price_limits') },
      { id: 'rushhour',    label: t('config.rush_hour') },
      { id: 'timeslots',   label: t('config.timeslots') },
      { id: 'commissions', label: t('config.commissions') },
      { id: 'bonuses',     label: t('config.bonuses') },
      { id: 'indrive',     label: t('config.indrive') },
      { id: 'botrules',    label: t('config.botrules') },
      { id: 'snapshots',   label: t('config.snapshots') },
      { id: 'countries',   label: t('config.countries') },
    ]
    // Audit log solo aparece para admins. La RPC también filtra por
    // is_admin() en DB, pero ocultarlo mejora la UX.
    if (isAdmin) {
      base.push({ id: 'audit', label: '📋 ' + t('audit.title') })
    }
    return base
  }, [t, isAdmin])

  const {
    thresholds, weights, semaforo,
    loading, saving, error,
    saveThresholds, saveWeights, saveSemaforo,
  } = useConfig(country)

  if (loading) {
    return <div className="config-page"><div className="state-box">{t('config.loading')}</div></div>
  }

  if (error) {
    return <div className="config-page"><div className="state-box state-box--error">{t('app.error')}: {error}</div></div>
  }

  return (
    <div className="config-page">
      <h1>{t('config.title')}</h1>

      <div className="config-tabs">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`config-tab${activeTab === tab.id ? ' active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'thresholds' && (
        <ThresholdsTable
          thresholds={thresholds}
          onSave={saveThresholds}
          saving={saving}
          country={country}
        />
      )}

      {activeTab === 'weights' && (
        <WeightsTable
          weights={weights}
          onSave={saveWeights}
          saving={saving}
          country={country}
        />
      )}

      {activeTab === 'semaforo' && (
        <SemaforoEditor
          semaforo={semaforo}
          onSave={saveSemaforo}
          saving={saving}
          country={country}
        />
      )}

      {activeTab === 'pricerules' && <PriceRulesTable country={country} />}
      {activeTab === 'rushhour'    && <RushHourConfig country={country} />}
      {activeTab === 'timeslots'   && <CITimeslotsConfig country={country} />}
      {activeTab === 'commissions' && <CommissionsConfig country={country} />}
      {activeTab === 'bonuses'     && <BonusesConfig country={country} />}
      {activeTab === 'indrive'     && <InDriveConfig country={country} />}
      {activeTab === 'botrules'    && <BotRulesTable country={country} />}
      {activeTab === 'snapshots'   && <SnapshotsManager country={country} />}
      {activeTab === 'countries'   && <CountriesConfig />}
      {activeTab === 'audit'       && isAdmin && <AuditLogViewer />}
    </div>
  )
}
