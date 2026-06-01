import { useState } from 'react'

// Sprint 3.3 a11y: el "header clickeable" ahora es un <button> con
// aria-expanded. Antes era un <header onClick> que NO era keyboard-navegable
// (tab no llegaba ahí, Enter no lo disparaba) → screen readers no anunciaban
// que era controlable, y usuarios con keyboard-only quedaban afuera.
//
// El icono ▼/▶ tiene aria-hidden porque ya está semánticamente expresado
// por aria-expanded sobre el botón.
//
// `action` (si existe) sigue siendo clickeable independiente del toggle —
// e.stopPropagation evita que active el button parent.
export default function CollapsibleSection({ id, title, subtitle, defaultOpen = true, children, action }) {
  const [open, setOpen] = useState(defaultOpen)
  const headerId = id ? `${id}-header` : undefined
  const panelId  = id ? `${id}-panel`  : undefined

  return (
    <section id={id} style={{
      background: 'var(--color-panel)',
      border: '1px solid var(--color-border)',
      borderRadius: 10,
      marginBottom: 16,
      boxShadow: 'var(--shadow-sm)',
      overflow: 'hidden',
    }}>
      <h2 style={{ margin: 0 }}>
        <button
          type="button"
          id={headerId}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(o => !o)}
          style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '12px 16px',
            width: '100%',
            background: open ? '#f8fafc' : '#fff',
            borderBottom: open ? '1px solid var(--color-border)' : 'none',
            border: 'none',
            borderRadius: 0,
            cursor: 'pointer',
            userSelect: 'none',
            font: 'inherit',
            color: 'inherit',
            textAlign: 'left',
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 11, color: 'var(--color-muted)', width: 10 }}>
            {open ? '▼' : '▶'}
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text)' }}>{title}</div>
            {subtitle && (
              <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 2 }}>{subtitle}</div>
            )}
          </div>
          {action && (
            <span onClick={e => e.stopPropagation()} role="presentation">{action}</span>
          )}
        </button>
      </h2>
      {open && (
        <div id={panelId} role="region" aria-labelledby={headerId} style={{ padding: 16 }}>
          {children}
        </div>
      )}
    </section>
  )
}
