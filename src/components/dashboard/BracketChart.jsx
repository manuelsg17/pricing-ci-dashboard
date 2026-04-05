import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts'
import { COMPETITOR_COLORS } from '../../lib/constants'

const IMPACT_COLORS = { alto: '#dc2626', medio: '#d97706', bajo: '#64748b' }

const EVENT_TYPE_LABELS = {
  huelga: 'Huelga', lluvia: 'Lluvia', feriado: 'Feriado',
  promo_competidor: 'Promo', regulacion: 'Regulación', otro: 'Evento',
}

// Custom label rendered on the reference line
function EventLabel({ viewBox, event }) {
  const { x, y } = viewBox
  return (
    <g>
      <rect x={x - 1} y={y} width={2} height={140} fill={IMPACT_COLORS[event.impact] || '#f97316'} opacity={0.7} />
      <text
        x={x + 4}
        y={y + 12}
        fill={IMPACT_COLORS[event.impact] || '#f97316'}
        fontSize={9}
        fontWeight={700}
      >
        {EVENT_TYPE_LABELS[event.event_type] || '●'}
      </text>
    </g>
  )
}

export default function BracketChart({ title, data, competitors, mode = 'price', events = [] }) {
  if (!data || data.length === 0) {
    return (
      <div className="chart-card">
        <div className="chart-card__title">{title}</div>
        <div style={{ fontSize: 11, color: '#aaa', textAlign: 'center', padding: '20px 0' }}>
          Sin datos
        </div>
      </div>
    )
  }

  // Map event dates to period keys that appear in the data
  const periodKeys = new Set(data.map(d => d.period))

  return (
    <div className="chart-card">
      <div className="chart-card__title">{title}</div>
      <ResponsiveContainer width="100%" height={160}>
        <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="period"
            tick={{ fontSize: 9 }}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 9 }}
            width={32}
            tickFormatter={v => v !== null ? Number(v).toFixed(1) : ''}
          />
          <Tooltip
            contentStyle={{ fontSize: 11 }}
            formatter={(v) => v !== null ? Number(v).toFixed(2) : 'N/A'}
          />
          {/* Event markers: only show if the date appears as a period key */}
          {events.map(evt => {
            if (!periodKeys.has(evt.event_date)) return null
            return (
              <ReferenceLine
                key={evt.id}
                x={evt.event_date}
                stroke={IMPACT_COLORS[evt.impact] || '#f97316'}
                strokeDasharray="4 2"
                strokeWidth={1.5}
                label={<EventLabel event={evt} />}
              />
            )
          })}
          {competitors.map(comp => (
            <Line
              key={comp}
              type="monotone"
              dataKey={comp}
              stroke={COMPETITOR_COLORS[comp] || '#999'}
              strokeWidth={comp.startsWith('Yango') ? 2.5 : 1.5}
              dot={{ r: 2 }}
              connectNulls={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
