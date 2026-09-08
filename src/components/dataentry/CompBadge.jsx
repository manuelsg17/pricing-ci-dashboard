import { COMPETITOR_COLORS } from '../../lib/constants'
import { COMPETITOR_SHORT_LABEL, COMPETITOR_FULL_LABEL } from '../../lib/catalogs'

// Nombre corto en pantalla (pedido user 2026-09-07, subcategorías de Cargo:
// "que los nombres no sean tan largos") con el nombre completo en el título
// del span para quien necesite confirmar cuál es cuál.
export default function CompBadge({ comp }) {
  const color = COMPETITOR_COLORS[comp]
  const label = COMPETITOR_SHORT_LABEL[comp] || comp
  if (!color) return <span className="de-comp-name">{label}</span>
  return (
    <span
      title={COMPETITOR_FULL_LABEL[comp] || (label !== comp ? comp : undefined)}
      style={{
        background: color,
        color: '#fff',
        borderRadius: 4,
        padding: '2px 8px',
        fontWeight: 700,
        fontSize: 10,
        whiteSpace: 'nowrap',
        display: 'inline-block',
      }}
    >
      {label}
    </span>
  )
}
