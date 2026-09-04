import { CATALOG_CATEGORIES, CATALOG_COMPETITORS } from '../../../lib/catalogs'
import { Button } from '../../ui/shadcn/button'
import {
  stepHeadingTightStyle,
  stepNoteStyle,
  dashedAddButtonClass,
  removeButtonClass,
} from './wizardStyles'

// Paso 7: bot rules (app / vc / ovc → competidor + categoría).
export default function WizardStepBotRules({ t, draft, updateBotRule, removeBotRule, addBotRule }) {
  return (
    <div>
      <h3 style={stepHeadingTightStyle}>{t('config.country_wizard.botrules_heading')}</h3>
      <p style={stepNoteStyle}>{t('config.country_wizard.botrules_note')}</p>
      <div style={{ maxHeight: 240, overflowY: 'auto' }}>
        <table className="config-table" style={{ fontSize: 11 }}>
          <thead>
            <tr>
              <th scope="col">app</th>
              <th scope="col">vc</th>
              <th scope="col">ovc</th>
              <th scope="col">{t('config.commissions.col_competitor')}</th>
              <th scope="col">{t('filter.category')}</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {draft.botRules.map((r, i) => (
              <tr key={i}>
                <td>
                  <input
                    value={r.app}
                    onChange={(e) => updateBotRule(i, 'app', e.target.value)}
                    style={{ width: 90 }}
                  />
                </td>
                <td>
                  <input
                    value={r.vc}
                    onChange={(e) => updateBotRule(i, 'vc', e.target.value)}
                    style={{ width: 80 }}
                  />
                </td>
                <td>
                  <input
                    value={r.ovc || '*'}
                    onChange={(e) => updateBotRule(i, 'ovc', e.target.value)}
                    style={{ width: 80 }}
                  />
                </td>
                <td>
                  <select
                    value={r.competition_name}
                    onChange={(e) => updateBotRule(i, 'competition_name', e.target.value)}
                  >
                    {CATALOG_COMPETITORS.map((c) => (
                      <option key={c.value}>{c.value}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    value={r.category}
                    onChange={(e) => updateBotRule(i, 'category', e.target.value)}
                  >
                    {CATALOG_CATEGORIES.map((c) => (
                      <option key={c.value}>{c.value}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => removeBotRule(i)}
                    className={removeButtonClass}
                  >
                    ✕
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button type="button" variant="outline" onClick={addBotRule} className={dashedAddButtonClass}>
        + {t('config.country_wizard.add_rule_btn')}
      </Button>
    </div>
  )
}
