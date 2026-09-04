import { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react'
import { translate, LANGUAGES, loadLanguage, isLanguageLoaded } from '../lib/i18n'

const LOCALE_MAP = { es: 'es-PE', en: 'en-US', ru: 'ru-RU' }

const LanguageContext = createContext(null)

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(() => localStorage.getItem('lang') || 'es')
  // Bumpea cuando termina de cargar un diccionario (en/ru viajan en chunks
  // aparte desde 2026-09-03) para que `t` se recalcule y la UI se re-renderice.
  const [dictVersion, setDictVersion] = useState(0)

  useEffect(() => {
    if (isLanguageLoaded(lang)) return
    let cancelled = false
    loadLanguage(lang).then(() => {
      if (!cancelled) setDictVersion((v) => v + 1)
    })
    return () => {
      cancelled = true
    }
  }, [lang])

  const setLang = useCallback((code) => {
    setLangState(code)
    localStorage.setItem('lang', code)
  }, [])

  const t = useCallback(
    (key, vars) => translate(lang, key, vars),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang, dictVersion]
  )

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
