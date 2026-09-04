import SaveStatusBanner from './SaveStatusBanner'
import { Button } from '../ui/shadcn/button'
import useCountryWizard from './countries/useCountryWizard'
import WizardStepIdentity from './countries/WizardStepIdentity'
import WizardStepCurrency from './countries/WizardStepCurrency'
import WizardStepCities from './countries/WizardStepCities'
import WizardStepCategories from './countries/WizardStepCategories'
import WizardStepCompetitors from './countries/WizardStepCompetitors'
import WizardStepWeights from './countries/WizardStepWeights'
import WizardStepBotRules from './countries/WizardStepBotRules'
import WizardStepReview from './countries/WizardStepReview'

// Orquestador del wizard de alta de país: stepper + cuerpo del paso + footer.
// El estado y las acciones viven en useCountryWizard; cada paso es un
// componente propio bajo ./countries. La creación en base es UNA sola RPC
// transaccional (create_country_setup, mig 240).
export default function CountryWizard({ onClose, onCreated }) {
  const w = useCountryWizard({ onClose, onCreated })
  const { t, steps, step, setStep, activeStep, stepErrors, canAdvance, saving, validation } = w

  return (
    <div className="config-section">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <h2>{t('config.country_wizard.title')}</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={w.handleCancel}
          className="rounded-[4px] border-slate-300"
        >
          ✕ {t('config.country_wizard.close_btn')}
        </Button>
      </div>

      {/* Stepper */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
        {steps.map((s, i) => (
          <Button
            key={s.id}
            type="button"
            variant="outline"
            size="sm"
            className={
              'h-auto rounded-full px-2.5 py-1.5 text-[11px] font-normal ' +
              (i === step
                ? 'border-[1.5px] border-blue-600 bg-blue-100 font-semibold text-blue-900 hover:bg-blue-100'
                : i < step
                  ? 'border-green-200 bg-green-50 text-green-700 hover:bg-green-50'
                  : 'cursor-default text-slate-400 hover:bg-transparent')
            }
            onClick={() => i < step && setStep(i)}
            disabled={i > step}
          >
            {i < step && '✓ '}
            {t(s.labelKey)}
            {!s.required && i >= step && ` *${t('config.country_wizard.optional_suffix')}*`}
          </Button>
        ))}
      </div>

      <SaveStatusBanner status={w.msg} onDismiss={() => w.setMsg(null)} />

      {/* Cuerpo del paso */}
      <div
        style={{ padding: 16, background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}
      >
        {activeStep.id === 'identity' && (
          <WizardStepIdentity t={t} draft={w.draft} update={w.update} />
        )}
        {activeStep.id === 'currency' && (
          <WizardStepCurrency t={t} draft={w.draft} update={w.update} setCurrency={w.setCurrency} />
        )}
        {activeStep.id === 'cities' && (
          <WizardStepCities
            t={t}
            draft={w.draft}
            addCity={w.addCity}
            updateCity={w.updateCity}
            removeCity={w.removeCity}
          />
        )}
        {activeStep.id === 'categories' && (
          <WizardStepCategories
            t={t}
            draft={w.draft}
            addCategoryToCity={w.addCategoryToCity}
            removeCategoryFromCity={w.removeCategoryFromCity}
          />
        )}
        {activeStep.id === 'competitors' && (
          <WizardStepCompetitors t={t} draft={w.draft} toggleCompetitor={w.toggleCompetitor} />
        )}
        {activeStep.id === 'weights' && (
          <WizardStepWeights
            t={t}
            draft={w.draft}
            totalWeight={w.totalWeight}
            updateWeight={w.updateWeight}
          />
        )}
        {activeStep.id === 'botrules' && (
          <WizardStepBotRules
            t={t}
            draft={w.draft}
            updateBotRule={w.updateBotRule}
            removeBotRule={w.removeBotRule}
            addBotRule={w.addBotRule}
          />
        )}
        {activeStep.id === 'review' && (
          <WizardStepReview
            t={t}
            draft={w.draft}
            totalWeight={w.totalWeight}
            validation={validation}
          />
        )}
      </div>

      {/* Footer navegación */}
      <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'space-between' }}>
        <Button
          variant="outline"
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0}
          className="rounded-[4px] border-slate-300"
        >
          ← {t('config.country_wizard.prev_btn')}
        </Button>

        {stepErrors.length > 0 && (
          <div
            style={{ fontSize: 11, color: '#b91c1c', flex: 1, textAlign: 'center', padding: '8px' }}
          >
            {stepErrors.map((e) => (
              <div key={e}>⚠ {e}</div>
            ))}
          </div>
        )}

        {step < steps.length - 1 ? (
          <Button onClick={() => setStep((s) => s + 1)} disabled={!canAdvance}>
            {t('config.country_wizard.next_btn')} →
          </Button>
        ) : (
          // Bug previo: `validation` siendo `[]` se evaluaba truthy y dejaba
          // el botón disabled tras un save exitoso. Ahora chequeamos !== null
          // explícito para identificar "creado". Si saving o canAdvance, también
          // disabled — el resto del tiempo, habilitado.
          <Button onClick={w.handleFinish} disabled={saving || !canAdvance || validation !== null}>
            {saving
              ? t('config.country_wizard.creating_btn')
              : validation !== null
                ? `✓ ${t('config.country_wizard.created_btn')}`
                : t('config.country_wizard.create_country_btn')}
          </Button>
        )}
      </div>
    </div>
  )
}
