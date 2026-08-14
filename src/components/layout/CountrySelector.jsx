import { useState, useRef, useEffect } from 'react'
import { getCountryIso } from '../../lib/constants'
import { useI18n } from '../../context/LanguageContext'
import { Button } from '../ui/shadcn/button'

// Custom dropdown que usa banderas SVG de flagcdn.com — así no dependemos
// de que el sistema operativo renderice los emojis de bandera (Windows sin
// fuente emoji muestra "PE" en vez de 🇵🇪).
// dbConfigs (opcional): { countryKey → internalConfig } de useCountry(). Un
// país nuevo (creado vía CountryWizard, solo-DB) no tiene entrada en
// COUNTRY_ISO ni en las claves i18n `country.*` — sin dbConfigs este
// componente mostraba la CLAVE cruda ("country.Guatemala") y la bandera
// de Perú (fallback de getCountryIso). El label chico del topbar ya
// resolvía esto leyendo countryConfig.iso2/nativeLabel; este selector no,
// porque nunca recibía la config por DB. Mismo criterio acá: DB primero,
// hardcoded como fallback.
export default function CountrySelector({
  country,
  setCountry,
  allowedCountries,
  disabled,
  dbConfigs = {},
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    function handleOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [open])

  const handleSelect = (c) => {
    setCountry(c)
    setOpen(false)
  }

  const isoFor = (c) => (dbConfigs[c]?.iso2 || getCountryIso(c)).toLowerCase()
  const labelFor = (c) => {
    if (dbConfigs[c]?.nativeLabel) return dbConfigs[c].nativeLabel
    const fromI18n = t(`country.${c}`)
    return fromI18n === `country.${c}` ? c : fromI18n
  }

  const currentIso = isoFor(country)
  const currentLabel = labelFor(country)

  return (
    <div
      ref={ref}
      className="country-selector"
      style={{ position: 'relative', display: 'inline-block' }}
    >
      <Button
        type="button"
        variant="outline"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        className="h-auto min-w-[130px] justify-start gap-2 rounded-md border-[#d1d5db] bg-white px-2.5 py-1 text-[13px] font-medium text-[#1f2937] hover:bg-white"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <FlagImg iso={currentIso} alt={country} />
        <span style={{ flex: 1, textAlign: 'left' }}>{currentLabel}</span>
        {!disabled && <span style={{ fontSize: 10, color: '#6b7280' }}>▼</span>}
      </Button>

      {open && (
        <div
          role="listbox"
          className="country-selector__menu"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            minWidth: '100%',
            background: '#fff',
            border: '1px solid #d1d5db',
            borderRadius: 6,
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
            zIndex: 1000,
            overflow: 'hidden',
          }}
        >
          {allowedCountries.map((c) => {
            const iso = isoFor(c)
            const label = labelFor(c)
            const isActive = c === country
            return (
              <button
                key={c}
                type="button"
                onClick={() => handleSelect(c)}
                role="option"
                aria-selected={isActive}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '6px 10px',
                  background: isActive ? '#fef2f2' : '#fff',
                  color: isActive ? '#991b1b' : '#1f2937',
                  border: 'none',
                  borderBottom: '1px solid #f3f4f6',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: isActive ? 600 : 400,
                  textAlign: 'left',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.background = '#f9fafb'
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.background = '#fff'
                }}
              >
                <FlagImg iso={iso} alt={c} />
                <span>{label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function FlagImg({ iso, alt }) {
  // flagcdn.com entrega SVG de banderas — cross-platform, cacheable.
  // Fallback a un span con el código ISO si la imagen falla.
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <span
        style={{
          display: 'inline-block',
          width: 22,
          fontSize: 9,
          fontWeight: 700,
          padding: '1px 3px',
          background: '#e5e7eb',
          borderRadius: 2,
          textAlign: 'center',
          color: '#374151',
        }}
      >
        {iso.toUpperCase()}
      </span>
    )
  }
  return (
    <img
      src={`https://flagcdn.com/w40/${iso}.png`}
      srcSet={`https://flagcdn.com/w40/${iso}.png 1x, https://flagcdn.com/w80/${iso}.png 2x`}
      alt={alt}
      onError={() => setFailed(true)}
      style={{
        width: 20,
        height: 'auto',
        borderRadius: 2,
        boxShadow: '0 0 0 1px rgba(0,0,0,0.1)',
        display: 'block',
      }}
    />
  )
}
