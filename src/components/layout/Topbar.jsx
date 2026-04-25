import { useState, useRef, useEffect } from 'react'
import { COUNTRIES, getCountryIso } from '../../lib/constants'
import { useCountry } from '../../context/CountryContext'
import { useI18n } from '../../context/LanguageContext'
import CountrySelector from './CountrySelector'
import '../../styles/topbar.css'

const getNav = (t) => [
  { id: 'dashboard', label: t('nav.dashboard'), direct: true },
  {
    id: 'analisis', label: t('nav.analisis'), icon: '📈',
    children: [
      { id: 'earnings', label: t('nav.earnings') },
      { id: 'report',   label: t('nav.report')   },
    ],
  },
  {
    id: 'datos', label: t('nav.datos'), icon: '🗄️',
    children: [
      { id: 'dataentry',  label: t('nav.dataentry')  },
      { id: 'upload',     label: t('nav.upload')  },
      { id: 'rawdata',    label: t('nav.rawdata')      },
      { id: 'botvshubs',  label: t('nav.botvshubs')  },
    ],
  },
  {
    id: 'config-group', label: t('nav.config_group'), icon: '⚙️',
    children: [
      { id: 'events',    label: t('nav.events')         },
      { id: 'distances', label: t('nav.distances') },
      { id: 'config',    label: t('nav.config')  },
      { id: 'access',    label: t('nav.access')         },
    ],
  },
]


function DropdownMenu({ item, activeTab, onTabChange, visibleChildren }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  const children = visibleChildren || item.children
  const isActive = children.some(c => c.id === activeTab)

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
          {children.map(child => (
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

export default function Topbar({ activeTab, onTabChange, userEmail, onLogout, canAccess = () => true, allowedCountries = COUNTRIES }) {
  const { lang, setLang, languages, t } = useI18n()
  const { country, setCountry } = useCountry()

  const navItems = getNav(t)

  return (
    <nav className="topbar">
      <div className="topbar__brand">
        <div className="topbar__brand-icon">Y</div>
        <div className="topbar__brand-text">
          <span className="topbar__brand-title">{t('brand.title')}</span>
          <span className="topbar__brand-sub" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <img
              src={`https://flagcdn.com/w20/${getCountryIso(country)}.png`}
              alt=""
              style={{ width: 14, height: 'auto', borderRadius: 1 }}
            />
            {t(`country.${country}`) || country}
          </span>
        </div>
      </div>

      <div className="topbar__tabs">
        {navItems.map(item => {
          if (item.direct) {
            if (!canAccess(item.id)) return null
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
          const visibleChildren = item.children.filter(c => canAccess(c.id))
          if (visibleChildren.length === 0) return null
          return (
            <DropdownMenu
              key={item.id}
              item={item}
              activeTab={activeTab}
              onTabChange={onTabChange}
              visibleChildren={visibleChildren}
            />
          )
        })}
      </div>

      <div className="topbar__right">
        {/* Country selector — custom dropdown con banderas SVG */}
        <CountrySelector
          country={country}
          setCountry={setCountry}
          allowedCountries={allowedCountries}
          disabled={allowedCountries.length <= 1}
        />

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
        <button className="topbar__logout" onClick={onLogout}>{t('app.logout')}</button>
      </div>
    </nav>
  )
}
