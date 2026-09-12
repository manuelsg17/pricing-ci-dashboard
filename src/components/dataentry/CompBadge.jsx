import { COMPETITOR_COLORS } from '../../lib/constants'
import { getCompetitorShortLabel, getCompetitorFullLabel } from '../../lib/catalogs'
import { useI18n } from '../../context/LanguageContext'

// Nombre corto en pantalla (pedido user 2026-09-07, subcategorías de Cargo:
// "que los nombres no sean tan largos") con el nombre completo en el título
// del span para quien necesite confirmar cuál es cuál.
export default function CompBadge({ comp }) {
  const { t } = useI18n()
  const color = COMPETITOR_COLORS[comp]
  const label = getCompetitorShortLabel(t, comp)
  if (!color) return <span className="de-comp-name">{label}</span>
  return (
    <span
      title={getCompetitorFullLabel(t, comp) || (label !== comp ? comp : undefined)}
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
