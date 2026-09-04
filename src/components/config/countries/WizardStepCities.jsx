import { Button } from '../../ui/shadcn/button'
import WizardField from './WizardField'
import {
  stepHeadingTightStyle,
  stepNoteStyle,
  dashedAddButtonClass,
  removeButtonClass,
} from './wizardStyles'

// Paso 3: ciudades (uiName / dbName / botKey).
export default function WizardStepCities({ t, draft, addCity, updateCity, removeCity }) {
  return (
    <div>
      <h3 style={stepHeadingTightStyle}>{t('config.country_wizard.cities_heading')}</h3>
      <p style={stepNoteStyle}>{t('config.country_wizard.cities_note')}</p>
      {draft.cities.map((c, i) => (
        <div
          key={i}
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr auto',
            gap: 8,
            marginBottom: 8,
          }}
        >
          <WizardField label={i === 0 ? t('config.country_wizard.ui_name_label') : ''}>
            <input
              value={c.uiName}
              onChange={(e) => updateCity(i, 'uiName', e.target.value)}
              placeholder="Lima"
            />
          </WizardField>
          <WizardField label={i === 0 ? 'dbName' : ''}>
            <input
              value={c.dbName}
              onChange={(e) => updateCity(i, 'dbName', e.target.value)}
              placeholder="Lima"
            />
          </WizardField>
          <WizardField label={i === 0 ? 'botKey' : ''}>
            <input
              value={c.botKey}
              onChange={(e) => updateCity(i, 'botKey', e.target.value)}
              placeholder="lima"
            />
          </WizardField>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => removeCity(i)}
            className={removeButtonClass}
          >
            ✕
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" onClick={addCity} className={dashedAddButtonClass}>
        + {t('config.country_wizard.add_city_btn')}
      </Button>
    </div>
  )
}
