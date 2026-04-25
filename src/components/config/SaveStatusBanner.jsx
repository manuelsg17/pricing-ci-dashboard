import { useEffect } from 'react'

/**
 * Banner reutilizable para feedback de guardado en el panel Config.
 *
 * Uso:
 *   const [status, setStatus] = useState(null)
 *   // { type: 'ok'|'warn'|'err', text: string } | null
 *
 *   <SaveStatusBanner status={status} onDismiss={() => setStatus(null)} />
 */
export default function SaveStatusBanner({ status, onDismiss, autoHideMs = 4000 }) {
  useEffect(() => {
    if (!status) return
    if (status.type !== 'ok') return   // solo auto-oculta OK; warn/err se quedan
    const id = setTimeout(() => onDismiss?.(), autoHideMs)
    return () => clearTimeout(id)
  }, [status, onDismiss, autoHideMs])

  if (!status) return null

  const scheme = {
    ok:   { bg: '#d1fae5', fg: '#065f46', border: '#10b981', icon: '✓' },
    warn: { bg: '#fef3c7', fg: '#78350f', border: '#f59e0b', icon: '⚠' },
    err:  { bg: '#fee2e2', fg: '#991b1b', border: '#ef4444', icon: '✕' },
  }[status.type] || { bg: '#e5e7eb', fg: '#1f2937', border: '#9ca3af', icon: 'ℹ' }

  return (
    <div
      role="status"
      style={{
        marginTop: 10,
        padding: '10px 14px',
        borderRadius: 6,
        fontSize: 13,
        fontWeight: 500,
        background: scheme.bg,
        color: scheme.fg,
        border: `1px solid ${scheme.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}
    >
      <span>{scheme.icon} {status.text}</span>
      {status.type !== 'ok' && onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Cerrar mensaje"
          style={{
            background: 'transparent',
            border: 'none',
            color: scheme.fg,
            cursor: 'pointer',
            fontSize: 16,
            lineHeight: 1,
            padding: 2,
          }}
        >
          ×
        </button>
      )}
    </div>
  )
}
