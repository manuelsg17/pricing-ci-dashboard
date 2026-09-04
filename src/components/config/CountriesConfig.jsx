import CountryWizard from './CountryWizard'
import useCountryDraft from './countries/useCountryDraft'
import CountryList from './countries/CountryList'
import CountryEditor from './countries/CountryEditor'
import CityList from './countries/CityList'
import CityEditor from './countries/CityEditor'

// Pantalla Configuración → Países. Orquestador de tres paneles:
//   1. CountryList   — países (hardcoded + DB), wizard y alta avanzada
//   2. CountryEditor — datos del país + CityList (ciudades)
//   3. CityEditor    — ciudad seleccionada: campos + categorías/competidores
// Todo el estado vive en useCountryDraft; los paneles son presentacionales.
export default function CountriesConfig() {
  const d = useCountryDraft()
  const { t, selectedKey } = d

  if (d.loading) return <div className="config-loading">{t('config.countries_config.loading')}</div>

  // Wizard mode: pantalla completa para no perder al usuario en pasos
  if (d.showWizard) {
    return (
      <CountryWizard onClose={() => d.setShowWizard(false)} onCreated={d.handleWizardCreated} />
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        gap: 0,
        height: 'calc(100vh - 160px)',
        overflow: 'hidden',
        borderTop: '1px solid var(--color-border)',
      }}
    >
      <CountryList
        t={t}
        allKeys={d.allKeys}
        dbRows={d.dbRows}
        draft={d.draft}
        selectedKey={selectedKey}
        isReadOnly={d.isReadOnly}
        onSelect={d.selectCountry}
        onOpenWizard={() => d.setShowWizard(true)}
        onAddNew={d.addNewCountry}
      />

      {/* ── Panel 2: Country settings + City list ─────────────── */}
      <div
        style={{
          width: 290,
          borderRight: '1px solid var(--color-border)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        {!selectedKey ? (
          <div style={{ padding: 20, color: 'var(--color-muted)', fontSize: 13 }}>
            {t('config.countries_config.select_country_placeholder')}
          </div>
        ) : (
          <>
            <CountryEditor
              t={t}
              selectedKey={selectedKey}
              activeRow={d.activeRow}
              readonly={d.readonly}
              savingKey={d.savingKey}
              msg={d.msg}
              activeRuleCount={d.activeRuleCount}
              isDirty={d.isDirty}
              isDbManaged={d.isDbManaged}
              setDraftField={d.setDraftField}
              setCurrency={d.setCurrency}
              onSave={() => d.handleSave(selectedKey)}
              onCancel={() => d.handleCancel(selectedKey)}
              onDelete={() => d.handleDeleteCountry(selectedKey)}
              onMakeEditable={() => d.makeEditable(selectedKey)}
            />
            <CityList
              t={t}
              cities={d.activeCities}
              selectedCityIdx={d.selectedCityIdx}
              readonly={d.readonly}
              onSelectCity={d.setSelectedCityIdx}
              onAddCity={() => d.addCity(selectedKey)}
              onDeleteCity={(idx) => d.deleteCity(selectedKey, idx)}
            />
          </>
        )}
      </div>

      <CityEditor t={t} d={d} />
    </div>
  )
}
