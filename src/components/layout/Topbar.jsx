import { useState, useRef, useEffect } from 'react'
import { COUNTRIES, COUNTRY_CONFIG } from '../../lib/constants'
import { useI18n } from '../../context/LanguageContext'
import '../../styles/topbar.css'

// Estructura de navegación agrupada
const NAV = [
  { id: 'dashboard', label: '📊 Dashboard', direct: true },
  {
    id: 'analisis', label: 'Análisis', icon: '📈',
    children: [
      { id: 'earnings', label: '💰 Ganancias' },
      { id: 'report',   label: '📄 Reporte'   },
    ],
  },
  {
    id: 'datos', label: 'Gestión de Datos', icon: '🗄️',
    children: [
      { id: 'dataentry',  label: '✏️ Ingresar CI'  },
      { id: 'upload',     label: '📤 Cargar Data'  },
      { id: 'rawdata',    label: '🗃 Data Raw'      },
      { id: 'botvshubs',  label: '📊 Bot vs Hubs'  },
    ],
  },
  {
    id: 'config-group', label: '⚙️ Config.', icon: '⚙️',
    children: [
      { id: 'events',    label: '📌 Eventos'         },
      { id: 'distances', label: '📍 Distancias Ref.' },
      { id: 'config',    label: '⚙️ Configuración'  },
      { id: 'access',    label: '🔐 Accesos'         },
    ],
  },
]

// Returns the group label for a given tab id (or null if direct)
function getGroupOf(tabId) {
  for (const item of NAV) {
    if (item.direct) continue
    if (item.children?.some(c => c.id === tabId)) return item.id
  }
  return null
}

function DropdownMenu({ item, activeTab, onTabChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  const isActive = item.children.some(c => c.id === activeTab)

  // Close on outside click
  useEffect(() => {
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  function handleSelect(id) {
    onTabChange(id)
    setOpen(false)
  }

  return (
    <div className="topbar__dropdown" ref={ref}>
      <button
        className={`topbar__tab topbar__tab--group${isActive ? ' topbar__tab--active' : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        {item.label}
        <span className="topbar__chevron" style={{ marginLeft: 5, fontSize: 9 }}>
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <div className="topbar__menu">
          {item.children.map(child => (
            <button
              key={child.id}
              className={`topbar__menu-item${activeTab === child.id ? ' topbar__menu-item--active' : ''}`}
              onClick={() => handleSelect(child.id)}
            >
              {child.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Topbar({ activeTab, onTabChange, userEmail, onLogout, country = 'Peru', onCountryChange }) {
  const { lang, setLang, languages } = useI18n()

  return (
    <nav className="topbar">
      <div className="topbar__brand">
        <div className="topbar__brand-icon">Y</div>
        <div className="topbar__brand-text">
          <span className="topbar__brand-title">Pricing CI</span>
          <span className="topbar__brand-sub">{COUNTRY_CONFIG[country]?.label || 'Yango'}</span>
        </div>
      </div>

      <div className="topbar__tabs">
        {NAV.map(item => {
          if (item.direct) {
            return (
              <button
                key={item.id}
                className={`topbar__tab${activeTab === item.id ? ' topbar__tab--active' : ''}`}
                onClick={() => onTabChange(item.id)}
              >
                {item.label}
              </button>
            )
          }
          return (
            <DropdownMenu
              key={item.id}
              item={item}
              activeTab={activeTab}
              onTabChange={onTabChange}
            />
          )
        })}
      </div>

      <div className="topbar__right">
        {/* Country selector */}
        <select
          className="topbar__country-select"
          value={country}
          onChange={e => onCountryChange?.(e.target.value)}
          title="Seleccionar país"
        >
          {COUNTRIES.map(c => (
            <option key={c} value={c}>{COUNTRY_CONFIG[c].label}</option>
          ))}
        </select>

        {/* Language selector */}
        <select
          className="topbar__lang-select"
          value={lang}
          onChange={e => setLang(e.target.value)}
          title="Idioma / Language / Язык"
        >
          {languages.map(l => (
            <option key={l.code} value={l.code}>{l.flag} {l.label}</option>
          ))}
        </select>

        <span className="topbar__user" title={userEmail}>{userEmail}</span>
        <button className="topbar__logout" onClick={onLogout}>Salir</button>
      </div>
    </nav>
  )
}
