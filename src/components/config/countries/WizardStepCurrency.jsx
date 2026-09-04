import { CURRENCY_PRESETS } from '../../../lib/constants'
import WizardField from './WizardField'
import { stepHeadingStyle } from './wizardStyles'

// Paso 2: moneda, locale y escala (outlier / max_price).
export default function WizardStepCurrency({ t, draft, update, setCurrency }) {
  return (
    <div>
      <h3 style={stepHeadingStyle}>{t('config.country_wizard.currency_heading')}</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <WizardField label={t('config.country_wizard.currency_field_label')} required>
          <input
            list="wizard-curr-list"
            value={draft.currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            placeholder="USD"
            title={t('config.country_wizard.currency_title_hint')}
          />
          <datalist id="wizard-curr-list">
            {Object.keys(CURRENCY_PRESETS).map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </WizardField>
        <WizardField label={t('config.country_wizard.locale_label')}>
          <input value={draft.locale} onChange={(e) => update('locale', e.target.value)} />
        </WizardField>
        <WizardField label={t('config.country_wizard.outlier_threshold_label')}>
          <input
            type="number"
            value={draft.outlier_threshold}
            onChange={(e) => update('outlier_threshold', e.target.value)}
          />
        </WizardField>
        <WizardField label={t('config.country_wizard.max_price_label')}>
          <input
            type="number"
            value={draft.max_price}
            onChange={(e) => update('max_price', e.target.value)}
          />
        </WizardField>
      </div>
      <p style={{ fontSize: 11, color: '#64748b', marginTop: 10 }}>
        {t('config.country_wizard.currency_defaults_note')}
      </p>
    </div>
  )
}
