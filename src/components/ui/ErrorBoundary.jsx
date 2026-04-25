import { Component } from 'react'

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

    return (
      <div role="alert" style={{
        minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}>
        <div style={{
          maxWidth: 560, width: '100%', background: '#fff',
          border: '1px solid #fecaca', borderRadius: 12, padding: 24,
          boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
        }}>
          <div style={{ fontSize: 36, lineHeight: 1, marginBottom: 8 }}>⚠</div>
          <h2 style={{ fontSize: 18, color: '#991b1b', margin: 0, marginBottom: 8 }}>
            Algo se rompió en esta vista
          </h2>
          <p style={{ fontSize: 13, color: '#444', margin: 0, marginBottom: 12 }}>
            El error fue contenido — el resto del dashboard sigue funcionando. Puedes reintentar la vista o recargar la página.
          </p>
          {!isProd && this.state.error?.message && (
            <pre style={{
              fontSize: 11, background: '#fef2f2', color: '#7f1d1d',
              padding: 10, borderRadius: 6, overflowX: 'auto', whiteSpace: 'pre-wrap',
              border: '1px solid #fecaca', maxHeight: 180, marginBottom: 12,
            }}>
              {String(this.state.error.message || this.state.error)}
            </pre>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={this.handleReset} style={{
              padding: '8px 14px', borderRadius: 6, border: '1px solid #cbd5e1',
              background: '#fff', cursor: 'pointer', fontSize: 13,
            }}>
              Reintentar
            </button>
            <button onClick={this.handleReload} style={{
              padding: '8px 14px', borderRadius: 6, border: 'none',
              background: '#E53935', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600,
            }}>
              Recargar página
            </button>
          </div>
        </div>
      </div>
    )
  }
}
