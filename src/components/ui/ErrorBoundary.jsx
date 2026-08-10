import { Component } from 'react'
import { Button } from './shadcn/button'
import { translate } from '../../lib/i18n'
import { reportError } from '../../lib/errorLog'
import { esErrorDeChunk } from '../../lib/lazyConReintento'

// Class component: no puede usar el hook useI18n(). Lee el idioma actual
// de localStorage (misma key que LanguageContext.jsx) directo, con
// fallback a 'es'.
function currentLang() {
  try {
    return localStorage.getItem('lang') || 'es'
  } catch {
    return 'es'
  }
}

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }

  static getDerivedStateFromError(error) {
    return { error, info: null }
  }

  componentDidCatch(error, info) {
    this.setState({ error, info })
    if (typeof window !== 'undefined' && window.console) {
      console.error('[ErrorBoundary]', error, info)
    }
    // Sin esto el error moría en la consola del hub y nadie se enteraba
    // nunca (mig 185). No se hace await: el reporte no debe demorar el
    // render de la pantalla de error.
    reportError({ source: 'boundary', error, componentStack: info?.componentStack })
  }

  handleReload = () => {
    if (typeof window !== 'undefined') window.location.reload()
  }

  handleReset = () => {
    this.setState({ error: null, info: null })
  }

  render() {
    if (!this.state.error) return this.props.children

    const isProd = import.meta.env.MODE === 'production'
    const lang = currentLang()
    const t = (key, vars) => translate(lang, key, vars)

    // "Se te quedó vieja la pestaña" NO es "se rompió la app", y tratarlos
    // igual sale caro de los dos lados: al hub le decimos que algo falló
    // cuando no falló nada suyo, y la acción que lo arregla (recargar) queda
    // como el botón secundario de un cartel que invita a pedir ayuda.
    //
    // Se llega acá solo cuando el reintento automático de lazyConReintento ya
    // se rindió (una recarga por ruta). Por eso esta pantalla NO recarga sola:
    // sería la segunda recarga automática seguida, o sea un loop. Dice qué
    // pasó, y deja el gesto en manos del hub.
    const porChunk = esErrorDeChunk(this.state.error)

    return (
      <div
        role="alert"
        style={{
          minHeight: '60vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}
      >
        <div
          style={{
            maxWidth: 560,
            width: '100%',
            background: '#fff',
            border: '1px solid #fecaca',
            borderRadius: 12,
            padding: 24,
            boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
          }}
        >
          <div style={{ fontSize: 36, lineHeight: 1, marginBottom: 8 }}>{porChunk ? '⟳' : '⚠'}</div>
          <h2
            style={{
              fontSize: 18,
              color: porChunk ? '#1e40af' : '#991b1b',
              margin: 0,
              marginBottom: 8,
            }}
          >
            {t(porChunk ? 'common.error_boundary.stale_title' : 'common.error_boundary.title')}
          </h2>
          <p style={{ fontSize: 13, color: '#444', margin: 0, marginBottom: 12 }}>
            {t(porChunk ? 'common.error_boundary.stale_message' : 'common.error_boundary.message')}
          </p>
          {!isProd && this.state.error?.message && (
            <pre
              style={{
                fontSize: 11,
                background: '#fef2f2',
                color: '#7f1d1d',
                padding: 10,
                borderRadius: 6,
                overflowX: 'auto',
                whiteSpace: 'pre-wrap',
                border: '1px solid #fecaca',
                maxHeight: 180,
                marginBottom: 12,
              }}
            >
              {String(this.state.error.message || this.state.error)}
            </pre>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            {/* "Reintentar" solo re-renderiza el mismo árbol. Contra un chunk
                que ya no está en el servidor no puede hacer nada, y ofrecerlo
                manda al hub a apretar dos veces para llegar al único botón que
                sirve. */}
            {!porChunk && (
              <Button variant="outline" onClick={this.handleReset} className="border-slate-300">
                {t('app.retry')}
              </Button>
            )}
            <Button onClick={this.handleReload} className="font-semibold">
              {t('app.reload_page')}
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
