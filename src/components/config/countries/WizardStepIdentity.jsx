import WizardField from './WizardField'
import { ISO_CODES } from './wizardConstants'
import { stepHeadingStyle } from './wizardStyles'

// Paso 1: country_key, label, ISO-2 y nombre nativo.
export default function WizardStepIdentity({ t, draft, update }) {
  return (
    <div>
      <h3 style={stepHeadingStyle}>{t('config.country_wizard.identity_heading')}</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <WizardField label={t('config.country_wizard.country_key_label')} required>
          <input
            value={draft.country_key}
            onChange={(e) => update('country_key', e.target.value.replace(/\s+/g, ''))}
            placeholder="Mexico"
          />
        </WizardField>
        <WizardField label={t('config.country_wizard.label_field_label')}>
          <input
            value={draft.label}
            onChange={(e) => update('label', e.target.value)}
            placeholder="México"
          />
        </WizardField>
        <WizardField label={t('config.country_wizard.iso2_label')}>
          <input
            list="wizard-iso-list"
            value={draft.iso2}
            onChange={(e) => update('iso2', e.target.value.toUpperCase().slice(0, 2))}
            placeholder="MX"
          />
          <datalist id="wizard-iso-list">
            {ISO_CODES.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </WizardField>
        <WizardField label={t('config.country_wizard.native_label_label')}>
          <input
            value={draft.native_label}
            onChange={(e) => update('native_label', e.target.value)}
            placeholder="México"
          />
        </WizardField>
      </div>
    </div>
  )
}
