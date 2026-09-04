// Constantes del wizard de alta de país. Viven aparte de los componentes
// para que cada paso las importe sin arrastrar el orquestador entero.
import { DEFAULT_WEIGHTS_PCT } from '../../../lib/constants'

export const ISO_CODES = [
  'PE',
  'CO',
  'BO',
  'VE',
  'NP',
  'ZM',
  'MX',
  'EC',
  'AR',
  'CL',
  'UY',
  'PY',
  'GT',
  'BR',
  'US',
]

// Pasos del wizard. Solo Identidad y Moneda son obligatorios para
// crear el país; el resto se puede completar después editando.
export const STEPS = [
  { id: 'identity', labelKey: 'config.country_wizard.step1_label', required: true },
  { id: 'currency', labelKey: 'config.country_wizard.step2_label', required: true },
  { id: 'cities', labelKey: 'config.country_wizard.step3_label', required: false },
  { id: 'categories', labelKey: 'config.country_wizard.step4_label', required: false },
  { id: 'competitors', labelKey: 'config.country_wizard.step5_label', required: false },
  { id: 'weights', labelKey: 'config.country_wizard.step6_label', required: false },
  { id: 'botrules', labelKey: 'config.country_wizard.step7_label', required: false },
  { id: 'review', labelKey: 'config.country_wizard.step8_label', required: true },
]

// Draft del país persistido en localStorage para que el usuario pueda
// cerrar y volver. Misma clave que antes del refactor: un draft a medias
// guardado con el bundle viejo se sigue leyendo.
export const WIZARD_DRAFT_KEY = 'wizard.countryDraft.v1'

export function emptyWizardDraft() {
  return {
    country_key: '',
    label: '',
    currency: 'USD',
    locale: 'en-US',
    iso2: '',
    native_label: '',
    outlier_threshold: 100,
    max_price: 1000,
    status: 'draft',
    cities: [],
    botRules: [],
    weights: { ...DEFAULT_WEIGHTS_PCT },
  }
}

// Umbral de tolerancia para "los pesos suman 100". Compartido entre el
// paso de pesos, la revisión y el payload de la RPC.
export function weightsSumOk(total) {
  return Math.abs(total - 100) < 0.5
}
