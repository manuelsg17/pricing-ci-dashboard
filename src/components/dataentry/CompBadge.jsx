import { COMPETITOR_COLORS } from '../../lib/constants'

export default function CompBadge({ comp }) {
  const color = COMPETITOR_COLORS[comp]
  if (!color) return <span className="de-comp-name">{comp}</span>
  return (
    <span
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
      {comp}
    </span>
  )
}
