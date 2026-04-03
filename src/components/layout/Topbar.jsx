import '../../styles/topbar.css'

const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'config',    label: 'Configuración' },
  { id: 'upload',    label: 'Cargar Data' },
]

export default function Topbar({ activeTab, onTabChange, userEmail, onLogout }) {
  return (
    <nav className="topbar">
      <span className="topbar__brand">Pricing CI</span>

      <div className="topbar__tabs">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`topbar__tab${activeTab === t.id ? ' topbar__tab--active' : ''}`}
            onClick={() => onTabChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <span className="topbar__user" title={userEmail}>{userEmail}</span>
      <button className="topbar__logout" onClick={onLogout}>Salir</button>
    </nav>
  )
}
