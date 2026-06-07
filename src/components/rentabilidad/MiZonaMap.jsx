import { useMemo, useState } from 'react'
import { LIMA_ZONES } from '../../lib/limaZones'

// Mapa esquemático (SVG, sin dependencias) de las 13 zonas de Lima para Mi Zona.
// Proyecta los polígonos lat/lng (de Lima_map.html) a coordenadas SVG con una
// proyección equirectangular corregida por cos(lat) — Lima es chica, así que la
// distorsión es despreciable. Click para prender/apagar una zona.

const W = 460 // ancho lógico del viewBox
const PAD = 8

// Proyección + paths se calculan una sola vez (datos estáticos).
function buildGeometry() {
  let minLat = Infinity,
    maxLat = -Infinity,
    minLng = Infinity,
    maxLng = -Infinity
  for (const z of LIMA_ZONES)
    for (const [lat, lng] of z.polygon) {
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
    }
  const meanLat = (minLat + maxLat) / 2
  const cos = Math.cos((meanLat * Math.PI) / 180)
  const lngSpan = (maxLng - minLng) * cos || 1
  const latSpan = maxLat - minLat || 1
  const scale = (W - PAD * 2) / lngSpan
  const H = latSpan * scale + PAD * 2
  const project = ([lat, lng]) => [
    PAD + (lng - minLng) * cos * scale,
    PAD + (maxLat - lat) * scale, // flip Y (lat sube → y baja)
  ]
  const paths = LIMA_ZONES.map((z, i) => ({
    id: z.id,
    i,
    d:
      'M' +
      z.polygon
        .map((p) =>
          project(p)
            .map((n) => n.toFixed(1))
            .join(',')
        )
        .join(' L') +
      'Z',
    c: project(z.centroid),
  }))
  return { paths, H }
}

const { paths: PATHS, H } = buildGeometry()

export default function MiZonaMap({ selected = [], onToggle }) {
  const [hover, setHover] = useState(null)
  const sel = useMemo(() => new Set(selected), [selected])

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{
        width: '100%',
        maxWidth: W,
        height: 'auto',
        border: '1px solid var(--color-border, #e2e8f0)',
        borderRadius: 8,
        background: '#f8fafc',
      }}
    >
      {PATHS.map((p) => {
        const on = sel.has(p.id)
        const hot = hover === p.id
        return (
          <g
            key={p.id}
            onClick={() => onToggle?.(p.id)}
            onMouseEnter={() => setHover(p.id)}
            onMouseLeave={() => setHover((h) => (h === p.id ? null : h))}
            style={{ cursor: 'pointer' }}
          >
            <path
              d={p.d}
              fill={
                on
                  ? 'rgba(229,57,53,0.55)'
                  : hot
                    ? 'rgba(229,57,53,0.18)'
                    : 'rgba(148,163,184,0.18)'
              }
              stroke={on ? '#E53935' : hot ? '#E53935' : '#94a3b8'}
              strokeWidth={on ? 1.6 : hot ? 1.2 : 0.8}
            />
            <text
              x={p.c[0]}
              y={p.c[1]}
              fontSize="11"
              textAnchor="middle"
              dominantBaseline="central"
              fill={on ? '#fff' : '#475569'}
              style={{ pointerEvents: 'none', fontWeight: on ? 700 : 500 }}
            >
              {p.i}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
