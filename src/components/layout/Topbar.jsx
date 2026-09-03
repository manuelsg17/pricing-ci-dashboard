import { useState, useRef, useEffect } from 'react'
import { COUNTRIES, getCountryIso } from '../../lib/constants'
import { useCountry } from '../../context/CountryContext'
import { useI18n } from '../../context/LanguageContext'
import CountrySelector from './CountrySelector'
import BotFreshnessBadge from '../ui/BotFreshnessBadge'
import ChangePasswordModal from './ChangePasswordModal'
import { ChevronDown, ChevronUp, KeyRound, LogOut } from 'lucide-react'
import '../../styles/topbar.css'

const getNav = (t) => [
  { id: 'dashboard', label: t('nav.dashboard'), direct: true },
  {
    id: 'analisis',
    label: t('nav.analisis'),
    icon: '📈',
    children: [
      { id: 'market', label: t('nav.market') },
      { id: 'competitividad', label: t('nav.competitividad') },
      { id: 'routemonitor', label: t('nav.routemonitor') },
      { id: 'earnings', label: t('nav.earnings') },
      { id: 'rentabilidad', label: t('nav.rentabilidad') },
      { id: 'report', label: t('nav.report') },
    ],
  },
  {
    id: 'datos',
    label: t('nav.datos'),
    icon: '🗄️',
    children: [
      { id: 'dataentry', label: t('nav.dataentry') },
      { id: 'projects', label: t('nav.projects') },
      { id: 'monitoring', label: t('nav.monitoring'), adminOnly: true },
      { id: 'upload', label: t('nav.upload') },
      { id: 'rawdata', label: t('nav.rawdata') },
      { id: 'coverage', label: t('nav.coverage') },
    ],
  },
  {
    id: 'config-group',
    label: t('nav.config_group'),
    icon: '⚙️',
    children: [
      { id: 'events', label: t('nav.events') },
      { id: 'distances', label: t('nav.distances') },
      { id: 'config', label: t('nav.config') },
      { id: 'access', label: t('nav.access') },
    ],
  },
]

function DropdownMenu({ item, activeTab, onTabChange, visibleChildren }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  const children = visibleChildren || item.children
  const isActive = children.some((c) => c.id === activeTab)

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
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {item.label}
        <span
          className="topbar__chevron"
          style={{ marginLeft: 4, display: 'inline-flex', alignItems: 'center' }}
        >
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </span>
      </button>

      {open && (
        <div className="topbar__menu">
          {children.map((child) => (
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

// Menú de cuenta: el email es el disparador de un dropdown con
// "Cambiar contraseña" + "Cerrar sesión". Vive en la Topbar (visible para
// TODOS los roles), no en Configuración — que el rol Analista no puede abrir.
function AccountMenu({ userEmail, onLogout, changePassword, t }) {
  const [open, setOpen] = useState(false)
  const [pwdOpen, setPwdOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="topbar__dropdown" ref={ref}>
      <button
        className={`topbar__account-trigger${open ? ' topbar__account-trigger--open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={userEmail}
      >
        <span className="topbar__account-email">{userEmail}</span>
        <span className="topbar__chevron" style={{ display: 'inline-flex', alignItems: 'center' }}>
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </span>
      </button>

      {open && (
        <div className="topbar__menu topbar__menu--right">
          <button
            className="topbar__menu-item"
            onClick={() => {
              setOpen(false)
              setPwdOpen(true)
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <KeyRound size={14} /> {t('account.change_password')}
            </span>
          </button>
          <button
            className="topbar__menu-item"
            onClick={() => {
              setOpen(false)
              onLogout()
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <LogOut size={14} /> {t('app.logout')}
            </span>
          </button>
        </div>
      )}

      <ChangePasswordModal
        open={pwdOpen}
        onClose={() => setPwdOpen(false)}
        onSubmit={changePassword}
      />
    </div>
  )
}

export default function Topbar({
  activeTab,
  onTabChange,
  userEmail,
  onLogout,
  changePassword,
  canAccess = () => true,
  isAdmin = false,
  allowedCountries = COUNTRIES,
}) {
  // Un ítem de nav visible: los `adminOnly` (ej. Monitoreo) se gatean por isAdmin
  // — no por canAccess ni por permisos de sección (así no se puede "regalar" a
  // otro rol desde la UI de Roles). El resto, por canAccess.
  const canShow = (item) => (item.adminOnly ? isAdmin : canAccess(item.id))
  const { lang, setLang, languages, t } = useI18n()
  const { country, setCountry, countryConfig, dbConfigs } = useCountry()
  // Prioridad: countryConfig.iso2 / nativeLabel (de DB) → COUNTRY_CONFIG
  // hardcoded → fallback al país literal. Esto hace que países creados
  // vía wizard tengan su bandera y label correcto desde el primer render.
  const iso2 = (countryConfig?.iso2 || getCountryIso(country) || '').toLowerCase()
  const label =
    countryConfig?.nativeLabel ||
    (() => {
      const fromI18n = t(`country.${country}`)
      return fromI18n === `country.${country}` ? country : fromI18n
    })()

  const navItems = getNav(t)

  return (
    <nav className="topbar">
      <div className="topbar__brand">
        <div className="topbar__brand-icon">Y</div>
        <div className="topbar__brand-text">
          <span className="topbar__brand-title">{t('brand.title')}</span>
          <span
            className="topbar__brand-sub"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            {iso2 && (
              <img
                src={`https://flagcdn.com/w20/${iso2}.png`}
                alt=""
                style={{ width: 14, height: 'auto', borderRadius: 1 }}
              />
            )}
            {label}
          </span>
        </div>
      </div>

      <div className="topbar__tabs">
        {navItems.map((item) => {
          if (item.direct) {
            if (!canShow(item)) return null
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
          const visibleChildren = item.children.filter((c) => canShow(c))
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
        {/* Bot freshness — pequeño semáforo de última sync. El wrapper con
            clase existe solo para poder ocultarlo por CSS en tablet (641-
            1150px), donde la topbar no entra en una fila de 52px sin
            comprimir; el badge no tiene clase propia (estilos inline). */}
        <span className="topbar__bot-badge">
          <BotFreshnessBadge />
        </span>

        {/* Country selector — custom dropdown con banderas SVG */}
        <CountrySelector
          country={country}
          setCountry={setCountry}
          allowedCountries={allowedCountries}
          disabled={allowedCountries.length <= 1}
          dbConfigs={dbConfigs}
        />

        {/* Language selector */}
        <select
          className="topbar__lang-select"
          value={lang}
          onChange={(e) => setLang(e.target.value)}
          title="Idioma / Language / Язык"
        >
          {languages.map((l) => (
            <option key={l.code} value={l.code}>
              {l.flag} {l.label}
            </option>
          ))}
        </select>

        <AccountMenu
          userEmail={userEmail}
          onLogout={onLogout}
          changePassword={changePassword}
          t={t}
        />
      </div>
    </nav>
  )
}
