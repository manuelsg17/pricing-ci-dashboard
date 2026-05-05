import { useState } from 'react'

export default function CollapsibleSection({ id, title, subtitle, defaultOpen = true, children, action }) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <section id={id} style={{
      background: 'var(--color-panel)',
      border: '1px solid var(--color-border)',
      borderRadius: 10,
      marginBottom: 16,
      boxShadow: 'var(--shadow-sm)',
      overflow: 'hidden',
    }}>
      <header
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '12px 16px',
          cursor: 'pointer',
          background: open ? '#f8fafc' : '#fff',
          borderBottom: open ? '1px solid var(--color-border)' : 'none',
          userSelect: 'none',
        }}
      >
        <span style={{ fontSize: 11, color: 'var(--color-muted)', width: 10 }}>{open ? '▼' : '▶'}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text)' }}>{title}</div>
          {subtitle && (
            <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 2 }}>{subtitle}</div>
          )}
        </div>
        {action && (
          <div onClick={e => e.stopPropagation()}>{action}</div>
        )}
      </header>
      {open && (
        <div style={{ padding: 16 }}>
          {children}
        </div>
      )}
    </section>
  )
}
