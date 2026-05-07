import { Component } from 'react'

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

    return (
      <div style={{
        background: '#fff7ed',
        border: '1px solid #fdba74',
        borderRadius: 8,
        padding: '12px 16px',
        margin: '8px 0',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }} role="alert">
        <span style={{ fontSize: 20, flexShrink: 0 }}>⚠</span>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#9a3412', marginBottom: 2 }}>
            {this.props.label
              ? `Error en sección "${this.props.label}"`
              : 'Error en esta sección'}
          </div>
          <div style={{ fontSize: 11, color: '#7c2d12' }}>
            El resto del dashboard sigue funcionando. Probá cambiar los filtros (ej: vista Semanal) o reintentar.
          </div>
          {!isProd && this.state.error?.message && (
            <pre style={{
              fontSize: 10, color: '#7c2d12', background: '#fef3c7',
              padding: 6, borderRadius: 4, marginTop: 6,
              maxHeight: 80, overflow: 'auto',
              whiteSpace: 'pre-wrap',
            }}>{String(this.state.error.message)}</pre>
          )}
        </div>
        <button
          onClick={this.handleReset}
          style={{
            padding: '4px 10px', fontSize: 11, fontWeight: 600,
            border: '1px solid #b45309', background: '#fff',
            color: '#9a3412', borderRadius: 4, cursor: 'pointer',
          }}
        >
          Reintentar
        </button>
      </div>
    )
  }
}
