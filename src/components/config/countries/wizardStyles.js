// Estilos inline compartidos por los pasos del wizard. Sin CSS nuevo a
// propósito: el wizard ya se veía así y el refactor no cambia comportamiento.

export const stepHeadingStyle = { margin: '0 0 12px', fontSize: 14 }
export const stepHeadingTightStyle = { margin: '0 0 6px', fontSize: 14 }
export const stepNoteStyle = { fontSize: 11, color: '#64748b', marginBottom: 10 }
export const emptyHintStyle = { color: '#888' }

export const cardStyle = {
  marginBottom: 12,
  padding: 10,
  background: '#fff',
  borderRadius: 6,
  border: '1px solid #e2e8f0',
}

export const categoryTagStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 6px',
  fontSize: 11,
  borderRadius: 10,
  background: '#dbeafe',
  color: '#1e3a8a',
  border: '1px solid #93c5fd',
}

export const dashedAddButtonClass =
  'border-dashed bg-transparent font-semibold text-muted hover:border-yango hover:bg-transparent hover:text-yango'

export const removeButtonClass =
  'rounded-[4px] border-red-300 bg-red-50 px-2 text-[11px] text-red-800 hover:bg-red-100'
