// ============================================================
// i18n — Translations (ES / EN / RU)
// Usage: import { useI18n } from '../context/LanguageContext'
//        const { t } = useI18n()
//        t('dashboard.loading')  → "Cargando datos…" / "Loading data…" / "Загрузка…"
// ============================================================

export const LANGUAGES = [
  { code: 'es', label: 'Español', flag: '🇪🇸' },
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'ru', label: 'Русский', flag: '🇷🇺' },
]

import es from './i18n/es.js'

// Solo el español viaja en el bundle inicial (es el fallback de toda clave).
// Los demás idiomas se cargan con `loadLanguage()` la primera vez que se
// necesitan; hasta entonces `translate` devuelve el fallback en español.
const DICTS = { es }
const LOADERS = {
  en: () => import('./i18n/en.js'),
  ru: () => import('./i18n/ru.js'),
}

export function isLanguageLoaded(code) {
  return !!DICTS[code]
}

export async function loadLanguage(code) {
  if (DICTS[code]) return DICTS[code]
  const loader = LOADERS[code]
  if (!loader) return DICTS.es
  const mod = await loader()
  DICTS[code] = mod.default
  return DICTS[code]
}

// Diccionarios cargados hasta el momento (los tests de paridad importan los
// tres archivos directamente, no este objeto).
export const TRANSLATIONS = DICTS

// Fallback: if a key is missing in the selected language, return Spanish.
//
// vars (opcional) soporta dos cosas para que un string dinámico no
// necesite un caso especial por callsite:
//   - Interpolación:   t('key', { name: 'Ana' })   → reemplaza {name} en el string
//   - Pluralización:   t('key', { count: n })       → si TRANSLATIONS[lang][key]
//     es un objeto { one, other, ... } (form ICU-lite; ver PLURAL_RULES),
//     se elige la forma correcta vía Intl.PluralRules(lang).select(count)
//     antes de interpolar. `count` también queda disponible como {count}
//     para el string elegido.
function pluralForm(lang, count) {
  try {
    return new Intl.PluralRules(lang).select(count)
  } catch {
    return count === 1 ? 'one' : 'other'
  }
}

export function translate(lang, key, vars) {
  let entry = DICTS[lang]?.[key] ?? DICTS.es?.[key] ?? key

  if (entry && typeof entry === 'object') {
    // Todos los call-sites del repo pasan {n: X} para pluralizar, nunca
    // {count: X} — sin este fallback, `count` siempre caía a 0 y la
    // pluralización quedaba fija en 'other' sin importar el valor real
    // (ej. "1 borradores" en vez de "1 borrador"). Detectado en revisión
    // adversarial 2026-07-23.
    const count = vars?.count ?? vars?.n ?? 0
    const rule = pluralForm(lang, count)
    entry = entry[rule] ?? entry.other ?? Object.values(entry)[0] ?? key
  }

  if (typeof entry === 'string' && vars) {
    for (const [k, v] of Object.entries(vars)) {
      entry = entry.replaceAll(`{${k}}`, v)
    }
  }

  return entry
}
