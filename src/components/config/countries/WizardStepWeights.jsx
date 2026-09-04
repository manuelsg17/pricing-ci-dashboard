import { BRACKETS } from '../../../lib/constants'
import { weightsSumOk } from './wizardConstants'
import { stepHeadingTightStyle, stepNoteStyle } from './wizardStyles'

// Paso 6: pesos del WA por bracket (city='all', category='all').
export default function WizardStepWeights({ t, draft, totalWeight, updateWeight }) {
  const ok = weightsSumOk(totalWeight)
  return (
    <div>
      <h3 style={stepHeadingTightStyle}>{t('config.country_wizard.weights_heading')}</h3>
      <p style={stepNoteStyle}>{t('config.country_wizard.weights_note')}</p>
      <table className="config-table">
        <thead>
          <tr>
            <th scope="col">{t('config.thresholds.col_bracket')}</th>
            <th scope="col">{t('config.country_wizard.weight_pct_col')}</th>
          </tr>
        </thead>
        <tbody>
          {BRACKETS.map((b) => (
            <tr key={b}>
              <td>{b}</td>
              <td>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={draft.weights[b]}
                  onChange={(e) => updateWeight(b, e.target.value)}
                />
              </td>
            </tr>
          ))}
          <tr style={{ background: ok ? '#f0fdf4' : '#fef2f2' }}>
            <td>
              <strong>{t('config.weights.total_label')}</strong>
            </td>
            <td>
              <strong style={{ color: ok ? '#15803d' : '#b91c1c' }}>
                {totalWeight.toFixed(2)}%
              </strong>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
