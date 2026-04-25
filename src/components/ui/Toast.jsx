import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

const ToastCtx = createContext(null)

export function useToast() {
  const ctx = useContext(ToastCtx)
  if (!ctx) {
    return {
      ok:   (msg) => console.info('[toast.ok]', msg),
      warn: (msg) => console.warn('[toast.warn]', msg),
      err:  (msg) => console.error('[toast.err]', msg),
      info: (msg) => console.info('[toast.info]', msg),
      push: (t)   => console.info('[toast]', t),
    }
  }
  return ctx
}

let _seq = 0

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const timersRef = useRef(new Map())

  const dismiss = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
    const tm = timersRef.current.get(id)
    if (tm) { clearTimeout(tm); timersRef.current.delete(id) }
  }, [])

  const push = useCallback((toast) => {
    const id = ++_seq
    const t = {
      id,
      type: 'info',
      duration: 3500,
      ...toast,
    }
    setToasts(prev => [...prev, t])
    if (t.duration > 0) {
      const tm = setTimeout(() => dismiss(id), t.duration)
      timersRef.current.set(id, tm)
    }
    return id
  }, [dismiss])

  const api = {
    push,
    dismiss,
    ok:   (text, opts) => push({ ...opts, type: 'ok',   text }),
    err:  (text, opts) => push({ ...opts, type: 'err',  text, duration: opts?.duration ?? 6000 }),
    warn: (text, opts) => push({ ...opts, type: 'warn', text, duration: opts?.duration ?? 5000 }),
    info: (text, opts) => push({ ...opts, type: 'info', text }),
  }

  useEffect(() => () => {
    timersRef.current.forEach(t => clearTimeout(t))
    timersRef.current.clear()
  }, [])

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div style={{
        position: 'fixed', top: 16, right: 16, zIndex: 9999,
        display: 'flex', flexDirection: 'column', gap: 8,
        maxWidth: 360, pointerEvents: 'none',
      }}>
        {toasts.map(t => <ToastItem key={t.id} toast={t} onClose={() => dismiss(t.id)} />)}
      </div>
    </ToastCtx.Provider>
  )
}

const SCHEME = {
  ok:   { bg: '#ecfdf5', fg: '#065f46', border: '#10b981', icon: '✓' },
  warn: { bg: '#fffbeb', fg: '#78350f', border: '#f59e0b', icon: '⚠' },
  err:  { bg: '#fef2f2', fg: '#991b1b', border: '#ef4444', icon: '✕' },
  info: { bg: '#eff6ff', fg: '#1e3a8a', border: '#3b82f6', icon: 'ℹ' },
}

function ToastItem({ toast, onClose }) {
  const s = SCHEME[toast.type] || SCHEME.info
  return (
    <div
      role="status"
      style={{
        pointerEvents: 'auto',
        background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
        borderRadius: 8, padding: '10px 12px', fontSize: 13, fontWeight: 500,
        boxShadow: '0 4px 12px rgba(0,0,0,0.10)',
        display: 'flex', alignItems: 'flex-start', gap: 10,
        animation: 'toastIn 180ms ease-out',
      }}
    >
      <span style={{ fontSize: 14, lineHeight: '20px' }}>{s.icon}</span>
      <div style={{ flex: 1, lineHeight: '20px', wordBreak: 'break-word' }}>
        {toast.title && <div style={{ fontWeight: 700, marginBottom: 2 }}>{toast.title}</div>}
        <div>{toast.text}</div>
      </div>
      <button
        onClick={onClose}
        aria-label="Cerrar"
        style={{
          background: 'transparent', border: 'none', color: s.fg,
          cursor: 'pointer', fontSize: 16, lineHeight: '20px', padding: 0,
        }}
      >×</button>
    </div>
  )
}
