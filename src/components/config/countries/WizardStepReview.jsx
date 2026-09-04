import { weightsSumOk } from './wizardConstants'
import { stepHeadingStyle } from './wizardStyles'

// Paso 8: resumen antes de crear + resultado de validate_country_setup
// después de crear.
//
// i18n (§6 de CLAUDE.md): los defaults que siembra la RPC create_country_setup
// (mig 240) — ventanas de hora pico 'Mañana'/'Tarde', notas del semáforo,
// nombres de franjas — son DATOS persistidos en tablas de configuración, así
// que el valor guardado queda en español como cualquier otro valor
// configurable (excepción documentada, igual que brackets y turnos de
// Config). Lo que el usuario VE acá antes de guardar sí pasa por t().
export default function WizardStepReview({ t, draft, totalWeight, validation }) {
  return (
    <div>
      <h3 style={stepHeadingStyle}>{t('config.country_wizard.review_heading')}</h3>
      <ul style={{ fontSize: 12, color: '#475569', lineHeight: 1.8 }}>
        <li>
          <strong>{t('config.country_wizard.review_identity_label')}</strong> {draft.country_key} (
          {draft.label}
          {draft.iso2 ? `, ${draft.iso2}` : ''})
        </li>
        <li>
          <strong>{t('config.country_wizard.review_currency_label')}</strong> {draft.currency} (
          {draft.locale}, outlier=
          {draft.outlier_threshold}, maxPrice={draft.max_price})
        </li>
        <li>
          <strong>{t('config.country_wizard.review_cities_label')}</strong> {draft.cities.length} (
          {draft.cities.map((c) => c.dbName).join(', ') || '—'})
        </li>
        <li>
          <strong>{t('config.country_wizard.review_categories_label')}</strong>{' '}
          {draft.cities.reduce((s, c) => s + c.categories.length, 0)}
        </li>
        <li>
          <strong>{t('config.country_wizard.review_weights_label')}</strong>{' '}
          {totalWeight.toFixed(2)}%{' '}
          {weightsSumOk(totalWeight)
            ? '✓'
            : `⚠ ${t('config.country_wizard.review_weights_warning')}`}
        </li>
        <li>
          <strong>{t('config.country_wizard.review_botrules_label')}</strong>{' '}
          {draft.botRules.length}
        </li>
        <li>
          <strong>{t('config.country_wizard.review_status_label')}</strong> <code>draft</code> (
          {t('config.country_wizard.review_status_note')})
        </li>
        <li>
          <strong>{t('config.country_wizard.review_seeds_label')}</strong>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>{t('config.country_wizard.review_seed_thresholds')}</li>
            <li>{t('config.country_wizard.review_seed_outlier')}</li>
            <li>{t('config.country_wizard.review_seed_semaforo')}</li>
            <li>
              {t('config.country_wizard.review_seed_rush', {
                morning: t('config.country_wizard.seed_rush_morning'),
                afternoon: t('config.country_wizard.seed_rush_afternoon'),
              })}
            </li>
          </ul>
          <span style={{ fontSize: 11, color: '#64748b' }}>
            {t('config.country_wizard.review_seeds_note')}
          </span>
        </li>
      </ul>

      {validation && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            background: '#fff',
            borderRadius: 6,
            border: '1px solid #e2e8f0',
          }}
        >
          <strong style={{ fontSize: 12 }}>{t('config.country_wizard.validation_heading')}</strong>
          <table className="config-table" style={{ marginTop: 6, fontSize: 11 }}>
            <tbody>
              {validation.map((v) => (
                <tr key={v.check_name}>
                  <td>
                    <span
                      style={{
                        padding: '2px 6px',
                        borderRadius: 4,
                        fontSize: 10,
                        fontWeight: 600,
                        background:
                          v.status === 'ok'
                            ? '#d1fae5'
                            : v.status === 'warning'
                              ? '#fef3c7'
                              : '#fee2e2',
                        color:
                          v.status === 'ok'
                            ? '#065f46'
                            : v.status === 'warning'
                              ? '#78350f'
                              : '#991b1b',
                      }}
                    >
                      {v.status}
                    </span>
                  </td>
                  <td>
                    <strong>{v.check_name}</strong>
                  </td>
                  <td>{v.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: 11, color: '#64748b', marginTop: 8 }}>
            ℹ {t('config.country_wizard.validation_footer_note')}
          </p>
        </div>
      )}
    </div>
  )
}
