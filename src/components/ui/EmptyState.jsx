export default function EmptyState({
  icon = '📭',
  title = 'No hay datos',
  message,
  action,
  compact = false,
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: compact ? '24px 16px' : '48px 24px',
      textAlign: 'center', gap: 10,
      background: '#fafafa', border: '1px dashed #d1d5db', borderRadius: 10,
      color: '#475569',
    }}>
      <div aria-hidden="true" style={{ fontSize: compact ? 28 : 40, lineHeight: 1, opacity: 0.7 }}>
        {icon}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#1f2937' }}>{title}</div>
      {message && (
        <div style={{ fontSize: 12, maxWidth: 380, lineHeight: 1.55 }}>{message}</div>
      )}
      {action && <div style={{ marginTop: 6 }}>{action}</div>}
    </div>
  )
}
