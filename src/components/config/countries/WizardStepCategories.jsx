import { CATALOG_CATEGORIES } from '../../../lib/catalogs'
import { Button } from '../../ui/shadcn/button'
import {
  stepHeadingTightStyle,
  stepNoteStyle,
  emptyHintStyle,
  cardStyle,
  categoryTagStyle,
} from './wizardStyles'

// Paso 4: categorías por ciudad, elegidas del catálogo canónico.
export default function WizardStepCategories({
  t,
  draft,
  addCategoryToCity,
  removeCategoryFromCity,
}) {
  return (
    <div>
      <h3 style={stepHeadingTightStyle}>{t('config.country_wizard.categories_heading')}</h3>
      <p style={stepNoteStyle}>{t('config.country_wizard.categories_note')}</p>
      {draft.cities.length === 0 ? (
        <em style={emptyHintStyle}>{t('config.country_wizard.no_cities_categories')}</em>
      ) : (
        draft.cities.map((c, ci) => (
          <div key={ci} style={cardStyle}>
            <strong style={{ fontSize: 12 }}>
              {c.uiName || c.dbName || t('config.country_wizard.unnamed_city')}
            </strong>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
              {c.categories.map((cat, cti) => (
                <span key={cti} style={categoryTagStyle}>
                  {cat.name}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-[14px] w-[14px] rounded-full p-0 text-[10px] text-[#1e3a8a] hover:bg-blue-200"
                    onClick={() => removeCategoryFromCity(ci, cti)}
                  >
                    ✕
                  </Button>
                </span>
              ))}
            </div>
            <select
              onChange={(e) => {
                if (e.target.value) {
                  addCategoryToCity(ci, e.target.value)
                  e.target.value = ''
                }
              }}
              style={{ marginTop: 6 }}
              value=""
            >
              <option value="">{t('config.country_wizard.add_category_option')}</option>
              {CATALOG_CATEGORIES.map((cc) => (
                <option key={cc.value} value={cc.value}>
                  {cc.label}
                </option>
              ))}
            </select>
          </div>
        ))
      )}
    </div>
  )
}
