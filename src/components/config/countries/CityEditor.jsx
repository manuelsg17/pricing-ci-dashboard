import { Button } from '../../ui/shadcn/button'
import CategoryEditor from './CategoryEditor'
import { fieldLabelStyle, inputStyle } from './countriesStyles'

// Panel 3: datos de la ciudad seleccionada + sus categorías/competidores.
export default function CityEditor({ t, d }) {
  const { selectedKey, selectedCityIdx, activeCity, readonly } = d

  if (!activeCity) {
    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', minWidth: 0 }}>
        <div style={{ color: 'var(--color-muted)', fontSize: 13, paddingTop: 20 }}>
          {t('config.countries_config.select_city_placeholder')}
        </div>
      </div>
    )
  }

  const patchCity = (patch) => d.setCity(selectedKey, selectedCityIdx, { ...activeCity, ...patch })

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', minWidth: 0 }}>
      {/* City fields */}
      <div className="config-section" style={{ marginBottom: 14 }}>
        <h2 style={{ marginBottom: 8 }}>{t('config.countries_config.city_data_heading')}</h2>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ minWidth: 130 }}>
            <label style={fieldLabelStyle}>{t('config.countries_config.ui_name_city_label')}</label>
            <input
              style={inputStyle(readonly)}
              disabled={readonly}
              placeholder="Ej: Lima"
              value={activeCity.uiName || ''}
              onChange={(e) => patchCity({ uiName: e.target.value })}
            />
          </div>
          <div style={{ minWidth: 130 }}>
            <label style={fieldLabelStyle}>{t('config.countries_config.db_name_city_label')}</label>
            <input
              style={inputStyle(readonly)}
              disabled={readonly}
              placeholder="Ej: Lima"
              value={activeCity.dbName || ''}
              onChange={(e) => patchCity({ dbName: e.target.value })}
            />
          </div>
          <div style={{ minWidth: 120 }}>
            <label style={fieldLabelStyle}>{t('config.countries_config.bot_key_label')}</label>
            <input
              style={inputStyle(readonly)}
              disabled={readonly}
              placeholder="Ej: lima"
              value={activeCity.botKey || ''}
              onChange={(e) => patchCity({ botKey: e.target.value })}
            />
          </div>
          <label
            style={{
              display: 'flex',
              gap: 6,
              fontSize: 12,
              color: 'var(--color-muted)',
              alignItems: 'center',
              paddingBottom: 6,
              cursor: readonly ? 'default' : 'pointer',
            }}
          >
            <input
              type="checkbox"
              disabled={readonly}
              checked={!!activeCity.isVirtual}
              onChange={(e) => patchCity({ isVirtual: e.target.checked })}
              style={{ accentColor: '#e53935' }}
            />
            {t('config.countries_config.virtual_city_label')}
            <span
              title={t('config.countries_config.virtual_city_tooltip')}
              style={{ cursor: 'help', opacity: 0.6 }}
            >
              ⓘ
            </span>
          </label>
        </div>
      </div>

      {/* Categories + competitors */}
      <div className="config-section">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
          }}
        >
          <h2 style={{ margin: 0 }}>
            {t('config.countries_config.categories_competitors_heading')}
          </h2>
          {!readonly && (
            <Button
              variant="outline"
              className="border-dashed bg-transparent font-semibold text-muted hover:border-yango hover:bg-transparent hover:text-yango"
              onClick={() => d.addCategory(selectedKey, selectedCityIdx)}
            >
              {t('config.countries_config.add_category_btn')}
            </Button>
          )}
        </div>

        {(!activeCity.categories || activeCity.categories.length === 0) && (
          <div style={{ color: 'var(--color-muted)', fontSize: 12, padding: '8px 0' }}>
            {t('config.countries_config.no_categories_text')}{' '}
            {!readonly && t('config.countries_config.no_categories_hint')}
          </div>
        )}

        {activeCity.categories?.map((cat, catIdx) => (
          <CategoryEditor
            key={catIdx}
            t={t}
            cat={cat}
            catIdx={catIdx}
            readonly={readonly}
            allowCorpTiers={selectedKey === 'Peru' && activeCity.dbName === 'Corp'}
            editingNoteFor={d.editingNoteFor}
            setEditingNoteFor={d.setEditingNoteFor}
            onFieldChange={(field, value) =>
              d.setCategoryField(selectedKey, selectedCityIdx, catIdx, field, value)
            }
            onDelete={() => d.deleteCategory(selectedKey, selectedCityIdx, catIdx)}
            onAddCompetitor={(comp) => d.addCompetitor(selectedKey, selectedCityIdx, catIdx, comp)}
            onRemoveCompetitor={(comp) =>
              d.removeCompetitor(selectedKey, selectedCityIdx, catIdx, comp)
            }
            onToggleCiHidden={(comp) =>
              d.toggleCiHidden(selectedKey, selectedCityIdx, catIdx, comp)
            }
            onSetCompetitorNote={(comp, note) =>
              d.setCompetitorNote(selectedKey, selectedCityIdx, catIdx, comp, note)
            }
          />
        ))}
      </div>
    </div>
  )
}
