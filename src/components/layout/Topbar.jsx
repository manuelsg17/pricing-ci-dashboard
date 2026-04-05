import '../../styles/topbar.css'

const TABS = [
  { id: 'dashboard',  label: '📊 Dashboard' },
  { id: 'dataentry',  label: '✏️ Ingresar CI' },
  { id: 'earnings',   label: '💰 Ganancias' },
  { id: 'report',     label: '📄 Reporte' },
  { id: 'events',     label: '📌 Eventos' },
  { id: 'rawdata',    label: '🗃 Data Raw' },
  { id: 'config',     label: '⚙️ Configuración' },
  { id: 'upload',     label: '📤 Cargar Data' },
  { id: 'distances',  label: '📍 Distancias Ref.' },
]

export default function Topbar({ activeTab, onTabChange, userEmail, onLogout }) {
  return (
    <nav className="topbar">
      <div className="topbar__brand">
        <div className="topbar__brand-icon">Y</div>
        <div className="topbar__brand-text">
          <span className="topbar__brand-title">Pricing CI</span>
          <span className="topbar__brand-sub">Yango Peru</span>
        </div>
      </div>

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

      <div className="topbar__spacer" />
      <span className="topbar__user" title={userEmail}>{userEmail}</span>
      <button className="topbar__logout" onClick={onLogout}>Salir</button>
    </nav>
  )
}
