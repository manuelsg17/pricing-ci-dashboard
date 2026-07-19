import { Component } from 'react'
import { Button } from './shadcn/button'
import { translate } from '../../lib/i18n'

// Class component: no puede usar el hook useI18n(). Lee el idioma actual
// de localStorage (misma key que LanguageContext.jsx) directo, con
// fallback a 'es' — consistente con cómo el resto de la app persiste el
// idioma elegido.
function currentLang() {
  try {
    return localStorage.getItem('lang') || 'es'
  } catch {
    return 'es'
  }
}

// ErrorBoundary compacto para usar inline alrededor de secciones individuales
// del dashboard. Si una sola sección crashea (ej: recharts con data inesperada),
// el resto del dashboard sigue visible y usable.
export default class SectionErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    if (typeof window !== 'undefined' && window.console) {
      console.error(`[SectionErrorBoundary:${this.props.label || 'unknown'}]`, error, info)
    }
  }

  handleReset = () => {
    this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children

    const isProd = import.meta.env.MODE === 'production'
    const lang = currentLang()
    const t = (key, vars) => translate(lang, key, vars)

    return (
      <div
        style={{
          background: '#fff7ed',
          border: '1px solid #fdba74',
          borderRadius: 8,
          padding: '12px 16px',
          margin: '8px 0',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
        role="alert"
      >
        <span style={{ fontSize: 20, flexShrink: 0 }}>⚠</span>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#9a3412', marginBottom: 2 }}>
            {this.props.label
              ? t('common.section_error.title_named', { label: this.props.label })
              : t('common.section_error.title_generic')}
          </div>
          <div style={{ fontSize: 11, color: '#7c2d12' }}>{t('common.section_error.message')}</div>
          {!isProd && this.state.error?.message && (
            <pre
              style={{
                fontSize: 10,
                color: '#7c2d12',
                background: '#fef3c7',
                padding: 6,
                borderRadius: 4,
                marginTop: 6,
                maxHeight: 80,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
              }}
            >
              {String(this.state.error.message)}
            </pre>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={this.handleReset}
          className="h-auto rounded-[4px] border-amber-700 bg-white px-2.5 py-1 text-[11px] font-semibold text-orange-800 hover:bg-amber-50"
        >
          {t('app.retry')}
        </Button>
      </div>
    )
  }
}
