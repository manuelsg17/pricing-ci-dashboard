import { BRACKETS, BRACKET_LABELS } from '../../lib/constants'
import BracketChart from './BracketChart'

export default function BracketCharts({ chartData, competitors }) {
  return (
    <div className="charts-grid">
      {BRACKETS.map(b => (
        <BracketChart
          key={b}
          title={BRACKET_LABELS[b]}
          data={chartData[b] || []}
          competitors={competitors}
        />
      ))}
    </div>
  )
}
