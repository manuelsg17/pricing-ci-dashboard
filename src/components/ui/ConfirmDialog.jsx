import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

const ConfirmCtx = createContext(null)

export function useConfirm() {
  const ctx = useContext(ConfirmCtx)
  if (!ctx) {
    return (opts) => Promise.resolve(window.confirm(opts?.message || opts || '¿Confirmar?'))
  }
  return ctx
}

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null)
  const resolverRef = useRef(null)

  const confirm = useCallback((opts) => {
    const config = typeof opts === 'string' ? { message: opts } : (opts || {})
    return new Promise(resolve => {
      resolverRef.current = resolve
      setState({
        title:       config.title       || 'Confirmar acción',
        message:     config.message     || '¿Estás seguro?',
        confirmText: config.confirmText || 'Confirmar',
        cancelText:  config.cancelText  || 'Cancelar',
        danger:      !!config.danger,
      })
    })
  }, [])

  const close = useCallback((result) => {
    setState(null)
    if (resolverRef.current) {
      resolverRef.current(result)
      resolverRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!state) return
    const onKey = (e) => {
      if (e.key === 'Escape') close(false)
      else if (e.key === 'Enter') close(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, close])

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {state && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => close(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 10000,
            background: 'rgba(15, 23, 42, 0.45)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16, backdropFilter: 'blur(2px)',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 12, maxWidth: 440, width: '100%',
              padding: 22, boxShadow: '0 20px 50px rgba(0,0,0,0.25)',
              animation: 'confirmIn 140ms ease-out',
            }}
          >
            <h3 style={{
              fontSize: 16, fontWeight: 700, margin: 0, marginBottom: 8,
              color: state.danger ? '#991b1b' : '#0f172a',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              {state.danger && <span aria-hidden="true">⚠</span>}
              {state.title}
            </h3>
            <p style={{ fontSize: 13, color: '#475569', margin: 0, marginBottom: 18, lineHeight: 1.5 }}>
              {state.message}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => close(false)}
                style={{
                  padding: '8px 14px', borderRadius: 6,
                  border: '1px solid #cbd5e1', background: '#fff',
                  color: '#1f2937', cursor: 'pointer', fontSize: 13,
                }}
              >
                {state.cancelText}
              </button>
              <button
                onClick={() => close(true)}
                autoFocus
                style={{
                  padding: '8px 14px', borderRadius: 6, border: 'none',
                  background: state.danger ? '#dc2626' : '#E53935',
                  color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                }}
              >
                {state.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  )
}
