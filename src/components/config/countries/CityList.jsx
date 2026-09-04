import { Button } from '../../ui/shadcn/button'
import { panelHeadingStyle } from './countriesStyles'

// Mitad inferior del panel 2: ciudades del país seleccionado.
export default function CityList({
  t,
  cities,
  selectedCityIdx,
  readonly,
  onSelectCity,
  onAddCity,
  onDeleteCity,
}) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div
        style={{
          padding: '8px 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <span style={panelHeadingStyle}>{t('config.countries_config.cities_heading')}</span>
        {!readonly && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 rounded-sm border-dashed bg-transparent px-2.5 font-semibold text-muted hover:border-yango hover:bg-transparent hover:text-yango"
            onClick={onAddCity}
            title={t('config.country_wizard.add_city_btn')}
          >
            +
          </Button>
        )}
      </div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {cities.length === 0 && (
          <div style={{ padding: '12px 14px', color: 'var(--color-muted)', fontSize: 12 }}>
            {t('config.countries_config.no_cities_text')}{' '}
            {!readonly && t('config.countries_config.no_cities_hint')}
          </div>
        )}
        {cities.map((city, idx) => (
          <div
            key={idx}
            onClick={() => onSelectCity(idx)}
            style={{
              padding: '7px 12px',
              cursor: 'pointer',
              fontSize: 13,
              background: selectedCityIdx === idx ? 'rgba(229,57,53,0.07)' : 'transparent',
              borderLeft: selectedCityIdx === idx ? '3px solid #e53935' : '3px solid transparent',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span
              style={{
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {city.uiName || (
                <em style={{ color: 'var(--color-muted)' }}>
                  {t('config.countries_config.unnamed_city')}
                </em>
              )}
            </span>
            {city.isVirtual && (
              <span style={{ fontSize: 9, color: 'var(--color-muted)', flexShrink: 0 }}>
                {t('config.countries_config.virtual_badge')}
              </span>
            )}
            {!readonly && (
              <Button
                variant="outline"
                size="sm"
                className="h-[18px] shrink-0 rounded-sm border-red-300 px-1.5 text-[10px] text-red-600 hover:bg-red-100"
                onClick={(e) => {
                  e.stopPropagation()
                  onDeleteCity(idx)
                }}
                title={t('config.countries_config.delete_city_title')}
              >
                ✕
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
