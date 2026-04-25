import { useState, useRef, useEffect } from 'react'
import { getCountryIso } from '../../lib/constants'
import { useI18n } from '../../context/LanguageContext'

// Custom dropdown que usa banderas SVG de flagcdn.com — así no dependemos
// de que el sistema operativo renderice los emojis de bandera (Windows sin
// fuente emoji muestra "PE" en vez de 🇵🇪).
export default function CountrySelector({ country, setCountry, allowedCountries, disabled }) {
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

  const currentIso = getCountryIso(country)
  const currentLabel = t(`country.${country}`) || country

  return (
    <div
      ref={ref}
      className="country-selector"
      style={{ position: 'relative', display: 'inline-block' }}
    >
      <button
        type="button"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        className="country-selector__trigger"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 10px',
          background: '#fff',
          border: '1px solid #d1d5db',
          borderRadius: 6,
          cursor: disabled ? 'default' : 'pointer',
          fontSize: 13,
          fontWeight: 500,
          color: '#1f2937',
          minWidth: 130,
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <FlagImg iso={currentIso} alt={country} />
        <span style={{ flex: 1, textAlign: 'left' }}>{currentLabel}</span>
        {!disabled && <span style={{ fontSize: 10, color: '#6b7280' }}>▼</span>}
      </button>

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
          {allowedCountries.map(c => {
            const iso = getCountryIso(c)
            const label = t(`country.${c}`) || c
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
                onMouseEnter={e => {
                  if (!isActive) e.currentTarget.style.background = '#f9fafb'
                }}
                onMouseLeave={e => {
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
      <span style={{
        display: 'inline-block',
        width: 22,
        fontSize: 9,
        fontWeight: 700,
        padding: '1px 3px',
        background: '#e5e7eb',
        borderRadius: 2,
        textAlign: 'center',
        color: '#374151',
      }}>
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
