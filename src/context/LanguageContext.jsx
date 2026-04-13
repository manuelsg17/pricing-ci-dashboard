import { createContext, useContext, useState, useCallback } from 'react'
import { translate, LANGUAGES } from '../lib/i18n'

const LOCALE_MAP = { es: 'es-PE', en: 'en-US', ru: 'ru-RU' }

const LanguageContext = createContext(null)

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(
    () => localStorage.getItem('lang') || 'es'
  )

  function setLang(code) {
    setLangState(code)
    localStorage.setItem('lang', code)
  }

  const t = useCallback((key) => translate(lang, key), [lang])

  const locale = LOCALE_MAP[lang] || 'es-PE'

  return (
    <LanguageContext.Provider value={{ lang, setLang, t, locale, languages: LANGUAGES }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useI18n() {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useI18n must be used within LanguageProvider')
  return ctx
}
