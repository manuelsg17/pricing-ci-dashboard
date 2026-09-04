import { CATALOG_COMPETITORS } from '../../../lib/catalogs'
import { Button } from '../../ui/shadcn/button'
import { stepHeadingTightStyle, emptyHintStyle } from './wizardStyles'

// Paso 5: competidores por (ciudad, categoría), como chips toggle.
export default function WizardStepCompetitors({ t, draft, toggleCompetitor }) {
  return (
    <div>
      <h3 style={stepHeadingTightStyle}>{t('config.country_wizard.competitors_heading')}</h3>
      {draft.cities.length === 0 ? (
        <em style={emptyHintStyle}>{t('config.country_wizard.no_cities_competitors')}</em>
      ) : (
        draft.cities.map((c, ci) => (
          <div key={ci} style={{ marginBottom: 12 }}>
            <strong style={{ fontSize: 12 }}>{c.uiName || c.dbName}</strong>
            {c.categories.map((cat, cti) => (
              <div
                key={cti}
                style={{
                  marginLeft: 12,
                  padding: 6,
                  marginTop: 4,
                  background: '#fff',
                  borderRadius: 4,
                  border: '1px solid #e2e8f0',
                }}
              >
                <div style={{ fontSize: 11, color: '#475569' }}>{cat.name}</div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                  {CATALOG_COMPETITORS.map((comp) => {
                    const active = cat.competitors.includes(comp.value)
                    return (
                      <Button
                        key={comp.value}
                        type="button"
                        variant="outline"
                        className="h-auto rounded-full border px-2 py-0.5 text-[10px] font-normal"
                        style={
                          active
                            ? {
                                background: comp.color,
                                color: '#fff',
                                borderColor: comp.color,
                              }
                            : { color: '#475569', borderColor: '#cbd5e1' }
                        }
                        onClick={() => toggleCompetitor(ci, cti, comp.value)}
                      >
                        {comp.value}
                      </Button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  )
}
