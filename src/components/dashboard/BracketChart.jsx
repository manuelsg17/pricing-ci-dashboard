import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts'
import { COMPETITOR_COLORS } from '../../lib/constants'

export default function BracketChart({ title, data, competitors, mode = 'price' }) {
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
