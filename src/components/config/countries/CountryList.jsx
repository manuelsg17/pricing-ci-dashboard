import { Button } from '../../ui/shadcn/button'
import { panelHeadingStyle } from './countriesStyles'

// Panel 1: lista de países (hardcoded + DB) con botones de wizard y alta
// avanzada.
export default function CountryList({
  t,
  allKeys,
  dbRows,
  draft,
  selectedKey,
  isReadOnly,
  onSelect,
  onOpenWizard,
  onAddNew,
}) {
  return (
    <div
      style={{
        width: 210,
        borderRight: '1px solid var(--color-border)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          padding: '10px 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <span style={panelHeadingStyle}>{t('config.countries_config.panel_title')}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <Button
            variant="outline"
            size="sm"
            className="h-6 rounded-[4px] border-blue-600 bg-blue-100 px-2 text-[10px] font-semibold text-blue-900 hover:bg-blue-200"
            onClick={onOpenWizard}
            title={t('config.countries_config.wizard_btn_title')}
          >
            ✨ {t('config.countries_config.wizard_btn')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 rounded-sm border-dashed bg-transparent px-2.5 font-semibold text-muted hover:border-yango hover:bg-transparent hover:text-yango"
            onClick={onAddNew}
            title={t('config.countries_config.advanced_add_title')}
          >
            +
          </Button>
        </div>
      </div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {allKeys.map((key) => {
          const dbRow = dbRows.find((r) => r.country_key === key)
          const label = draft[key]?.label ?? dbRow?.label ?? key
          const isActive = selectedKey === key
          const ro = isReadOnly(key)
          return (
            <div
              key={key}
              onClick={() => onSelect(key)}
              style={{
                padding: '8px 12px',
                cursor: 'pointer',
                fontSize: 13,
                background: isActive ? 'rgba(229,57,53,0.07)' : 'transparent',
                borderLeft: isActive ? '3px solid #e53935' : '3px solid transparent',
                color: ro ? 'var(--color-muted)' : 'var(--color-text)',
                fontStyle: ro ? 'italic' : 'normal',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 6,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {label}
              </span>
              {ro && (
                <span
                  title={t('config.countries_config.readonly_lock_title')}
                  style={{ fontSize: 9, flexShrink: 0 }}
                >
                  🔒
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
