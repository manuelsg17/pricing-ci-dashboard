import { createContext, useContext, useState, useCallback, useMemo } from 'react'
import { translate, LANGUAGES } from '../lib/i18n'

const LOCALE_MAP = { es: 'es-PE', en: 'en-US', ru: 'ru-RU' }

const LanguageContext = createContext(null)

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(() => localStorage.getItem('lang') || 'es')

  const setLang = useCallback((code) => {
    setLangState(code)
    localStorage.setItem('lang', code)
  }, [])

  const t = useCallback((key) => translate(lang, key), [lang])

  const locale = LOCALE_MAP[lang] || 'es-PE'

  const contextValue = useMemo(
    () => ({
      lang,
      setLang,
      t,
      locale,
      languages: LANGUAGES,
    }),
    [lang, setLang, t, locale]
  )

  return <LanguageContext.Provider value={contextValue}>{children}</LanguageContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useI18n() {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useI18n must be used within LanguageProvider')
  return ctx
}
