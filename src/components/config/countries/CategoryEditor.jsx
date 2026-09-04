import { CATALOG_CATEGORIES } from '../../../lib/catalogs'
import { Button } from '../../ui/shadcn/button'
import { Eye, EyeOff, StickyNote } from 'lucide-react'
import CompetitorAdder from './CompetitorAdder'
import { fieldLabelStyle, inputStyle, competitorTagStyle } from './countriesStyles'

// Una tarjeta de categoría dentro de la ciudad: nombre UI / dbName /
// nombre de Yango + chips de competidores (ocultar en CI, nota, quitar).
export default function CategoryEditor({
  t,
  cat,
  catIdx,
  readonly,
  allowCorpTiers,
  editingNoteFor,
  setEditingNoteFor,
  onFieldChange,
  onDelete,
  onAddCompetitor,
  onRemoveCompetitor,
  onToggleCiHidden,
  onSetCompetitorNote,
}) {
  return (
    <div
      style={{
        border: '1px solid var(--color-border-soft)',
        borderRadius: 'var(--radius-sm)',
        padding: '10px 14px',
        marginBottom: 10,
        background: 'var(--color-bg)',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 10,
          flexWrap: 'wrap',
          alignItems: 'flex-end',
          marginBottom: 10,
        }}
      >
        <div style={{ minWidth: 110 }}>
          <label style={fieldLabelStyle}>{t('config.country_wizard.ui_name_label')}</label>
          <input
            style={{ ...inputStyle(readonly), width: 120 }}
            placeholder="Economy"
            list="cat-catalog-list"
            disabled={readonly}
            value={cat.name || ''}
            onChange={(e) => onFieldChange('name', e.target.value)}
            title={t('config.countries_config.cat_datalist_title')}
          />
          <datalist id="cat-catalog-list">
            {CATALOG_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value} />
            ))}
          </datalist>
        </div>
        <div style={{ minWidth: 110 }}>
          <label style={fieldLabelStyle}>{t('config.countries_config.cat_db_name_label')}</label>
          <input
            style={{ ...inputStyle(readonly), width: 120 }}
            placeholder="Economy"
            list="cat-catalog-list"
            disabled={readonly}
            value={cat.dbName || ''}
            onChange={(e) => onFieldChange('dbName', e.target.value)}
          />
        </div>
        <div style={{ minWidth: 130 }}>
          <label style={fieldLabelStyle}>
            {t('config.countries_config.yango_display_name_label')}
          </label>
          <input
            style={{ ...inputStyle(readonly), width: 150 }}
            placeholder="Yango"
            disabled={readonly}
            value={cat.yangoDisplayName || ''}
            onChange={(e) => onFieldChange('yangoDisplayName', e.target.value)}
          />
        </div>
        {!readonly && (
          <Button
            variant="outline"
            size="sm"
            className="mb-px border-red-300 text-red-600 hover:bg-red-100"
            onClick={onDelete}
          >
            ✕ {t('app.delete')}
          </Button>
        )}
      </div>

      <label style={fieldLabelStyle}>{t('config.countries_config.competitors_label')}</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 5 }}>
        {cat.competitors.map((comp) => {
          const hidden = (cat.ciHidden || []).includes(comp)
          const note = cat.competitorNotes?.[comp] || ''
          const noteKey = `${catIdx}|${comp}`
          const editingNote = editingNoteFor === noteKey
          return (
            <span
              key={comp}
              style={{
                ...competitorTagStyle,
                ...(hidden
                  ? {
                      opacity: 0.55,
                      textDecoration: 'line-through',
                      textDecorationColor: 'rgba(183,28,28,0.5)',
                    }
                  : {}),
              }}
              title={
                hidden ? t('config.countries_config.ci_hidden_tag_title', { comp }) : undefined
              }
            >
              {comp}
              {!readonly && (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="ml-1 h-auto w-auto p-0.5 leading-none text-slate-500 hover:bg-transparent hover:text-yango"
                    onClick={() => onToggleCiHidden(comp)}
                    title={
                      hidden
                        ? t('config.countries_config.ci_offer_title', { comp })
                        : t('config.countries_config.ci_hide_title', { comp })
                    }
                  >
                    {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="ml-0.5 h-auto w-auto p-0.5 leading-none text-slate-500 hover:bg-transparent hover:text-yango"
                    onClick={() => setEditingNoteFor(editingNote ? null : noteKey)}
                    title={
                      note
                        ? t('config.countries_config.competitor_note_edit_title', { comp })
                        : t('config.countries_config.competitor_note_add_title', { comp })
                    }
                  >
                    <StickyNote size={12} fill={note ? 'currentColor' : 'none'} />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="ml-0.5 h-auto w-auto p-0.5 text-xs font-bold leading-none text-red-600 hover:bg-transparent"
                    onClick={() => onRemoveCompetitor(comp)}
                    title={t('config.countries_config.remove_competitor_title', { comp })}
                  >
                    ×
                  </Button>
                </>
              )}
              {!hidden && !editingNote && note && (
                <span title={note} style={{ marginLeft: 4, fontSize: 10, cursor: 'default' }}>
                  📝
                </span>
              )}
            </span>
          )
        })}
        {!readonly && (
          <CompetitorAdder
            existing={cat.competitors}
            onAdd={onAddCompetitor}
            allowCorpTiers={allowCorpTiers}
          />
        )}
      </div>
      {editingNoteFor?.startsWith(`${catIdx}|`) &&
        (() => {
          // split con límite 2: si el nombre del competidor tuviera un
          // '|' (no pasa hoy, pero no cuesta nada ser robusto) se
          // conserva entero en la segunda mitad.
          const comp = editingNoteFor.split(/\|(.*)/s)[1]
          return (
            <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
              <label style={{ ...fieldLabelStyle, marginBottom: 0, minWidth: 'auto' }}>
                {t('config.countries_config.competitor_note_label', { comp })}
              </label>
              <input
                autoFocus
                style={{ ...inputStyle(false), flex: 1 }}
                placeholder={t('config.countries_config.competitor_note_placeholder')}
                value={cat.competitorNotes?.[comp] || ''}
                onChange={(e) => onSetCompetitorNote(comp, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Escape') setEditingNoteFor(null)
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setEditingNoteFor(null)}
              >
                {t('app.close')}
              </Button>
            </div>
          )
        })()}
      {(cat.ciHidden || []).length > 0 && (
        <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4, fontStyle: 'italic' }}>
          {t('config.countries_config.ci_hidden_note', {
            list: (cat.ciHidden || []).join(', '),
          })}
        </div>
      )}
    </div>
  )
}
