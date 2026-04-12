import { useState, useEffect, useCallback } from 'react'
import { sb }         from '../lib/supabase'
import { useAuth }    from '../lib/auth'
import { COUNTRIES }  from '../lib/constants'
import { ALL_SECTIONS, SECTION_LABELS } from '../hooks/useAccessControl'
import '../styles/access-management.css'

// ── Users tab ──────────────────────────────────────────────────────────────
function UsersTab({ roles }) {
  const { session } = useAuth()
  const currentEmail = session?.user?.email || ''

  const [users,   setUsers]   = useState([])
  const [loading, setLoading] = useState(false)
  const [msg,     setMsg]     = useState(null)

  // New user form
  const [showForm,   setShowForm]   = useState(false)
  const [firstName,  setFirstName]  = useState('')
  const [lastName,   setLastName]   = useState('')
  const [email,      setEmail]      = useState('')
  const [password,   setPassword]   = useState('')
  const [roleId,     setRoleId]     = useState('')
  const [saving,     setSaving]     = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await sb
      .from('user_profiles')
      .select('*, roles(id, name, label)')
      .order('created_at', { ascending: false })
    setUsers(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function handleToggleActive(user) {
    await sb.from('user_profiles').update({ is_active: !user.is_active }).eq('id', user.id)
    load()
  }

  async function handleChangeRole(userId, newRoleId) {
    const { error } = await sb.from('user_profiles')
      .update({ role_id: newRoleId ? parseInt(newRoleId) : null })
      .eq('id', userId)
    if (error) {
      setMsg({ type: 'err', text: `Error al actualizar rol: ${error.message}` })
    } else {
      setMsg({ type: 'ok', text: '✓ Rol actualizado.' })
      setTimeout(() => setMsg(null), 3000)
    }
    load()
  }

  async function handleInvite(e) {
    e.preventDefault()
    if (!email.trim() || !password.trim()) return
    setSaving(true); setMsg(null)

    const { data, error } = await sb.functions.invoke('create-user', {
      body: {
        email:      email.trim().toLowerCase(),
        password:   password.trim(),
        first_name: firstName.trim(),
        last_name:  lastName.trim(),
        role_id:    roleId || null,
        invited_by: currentEmail,
      },
    })

    setSaving(false)
    if (error || data?.error) {
      setMsg({ type: 'err', text: `Error: ${data?.error || error?.message}` })
    } else {
      setMsg({ type: 'ok', text: `✓ Usuario ${email} creado con acceso al sistema.` })
      setFirstName(''); setLastName(''); setEmail(''); setPassword(''); setRoleId('')
      setShowForm(false)
      load()
    }
  }

  async function handleDelete(id) {
    if (!confirm('¿Eliminar este usuario?')) return
    await sb.from('user_profiles').delete().eq('id', id)
    load()
  }

  return (
    <div className="am-tab-content">
      <div className="am-toolbar">
        <button className="am-btn am-btn--primary" onClick={() => setShowForm(f => !f)}>
          {showForm ? '✕ Cancelar' : '+ Registrar usuario'}
        </button>
      </div>

      {showForm && (
        <form className="am-form" onSubmit={handleInvite}>
          <h3 className="am-form__title">Nuevo usuario</h3>
          <div className="am-form__row">
            <label>
              <span>Nombre</span>
              <input value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="Nombre" />
            </label>
            <label>
              <span>Apellido</span>
              <input value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Apellido" />
            </label>
          </div>
          <div className="am-form__row">
            <label>
              <span>Email *</span>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="usuario@empresa.com" />
            </label>
            <label>
              <span>Contraseña inicial *</span>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} required placeholder="Mínimo 6 caracteres" minLength={6} />
            </label>
          </div>
          <div className="am-form__row">
            <label>
              <span>Puesto / Rol</span>
              <select value={roleId} onChange={e => setRoleId(e.target.value)}>
                <option value="">— Sin rol —</option>
                {roles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </label>
          </div>
          <div className="am-form__actions">
            <button type="submit" className="am-btn am-btn--primary" disabled={saving}>
              {saving ? 'Guardando…' : '💾 Registrar'}
            </button>
          </div>
        </form>
      )}

      {msg && <div className={`am-msg am-msg--${msg.type}`}>{msg.text}</div>}

      {loading ? (
        <div className="am-empty">Cargando…</div>
      ) : users.length === 0 ? (
        <div className="am-empty">Sin usuarios registrados.</div>
      ) : (
        <table className="am-table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Email</th>
              <th>Puesto</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} className={!u.is_active ? 'am-row--inactive' : ''}>
                <td>{u.first_name} {u.last_name}</td>
                <td className="am-td-email">{u.email}</td>
                <td>
                  <select
                    className="am-select"
                    value={u.role_id || ''}
                    onChange={e => handleChangeRole(u.id, e.target.value)}
                  >
                    <option value="">— Sin rol —</option>
                    {roles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                </td>
                <td>
                  <span className={`am-badge am-badge--${u.is_active ? 'active' : 'inactive'}`}>
                    {u.is_active ? 'Activo' : 'Inactivo'}
                  </span>
                </td>
                <td className="am-td-actions">
                  <button
                    className={`am-btn am-btn--sm ${u.is_active ? 'am-btn--warn' : 'am-btn--ok'}`}
                    onClick={() => handleToggleActive(u)}
                  >
                    {u.is_active ? 'Desactivar' : 'Activar'}
                  </button>
                  <button className="am-btn am-btn--sm am-btn--danger" onClick={() => handleDelete(u.id)}>
                    Eliminar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Roles tab ──────────────────────────────────────────────────────────────
function RolesTab() {
  const [roles,   setRoles]   = useState([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(null) // role id being edited
  const [draftPerms, setDraftPerms] = useState({ sections: [], countries: [] })
  const [saving,  setSaving]  = useState(false)
  const [msg,     setMsg]     = useState(null)

  // New role form
  const [showNew,    setShowNew]    = useState(false)
  const [newName,    setNewName]    = useState('')
  const [newLabel,   setNewLabel]   = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await sb.from('roles').select('*').order('id')
    setRoles(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function startEdit(role) {
    setEditing(role.id)
    setDraftPerms({
      sections:  role.permissions?.sections  || [],
      countries: role.permissions?.countries || [],
    })
  }

  function toggleSection(sec) {
    setDraftPerms(prev => {
      const has = prev.sections.includes(sec)
      const next = has ? prev.sections.filter(s => s !== sec) : [...prev.sections, sec]
      return { ...prev, sections: next }
    })
  }

  function toggleAll(field) {
    setDraftPerms(prev => {
      if (prev[field].includes('all')) return { ...prev, [field]: [] }
      return { ...prev, [field]: ['all'] }
    })
  }

  function toggleCountry(c) {
    setDraftPerms(prev => {
      const has = prev.countries.includes(c)
      const next = has ? prev.countries.filter(x => x !== c) : [...prev.countries, c]
      return { ...prev, countries: next }
    })
  }

  async function saveRole(id) {
    setSaving(true); setMsg(null)
    const { error } = await sb.from('roles')
      .update({ permissions: draftPerms })
      .eq('id', id)
    setSaving(false)
    if (error) {
      setMsg({ type: 'err', text: `Error: ${error.message}` })
    } else {
      setMsg({ type: 'ok', text: '✓ Rol actualizado.' })
      setEditing(null)
      load()
    }
  }

  async function createRole(e) {
    e.preventDefault()
    if (!newName.trim() || !newLabel.trim()) return
    setSaving(true)
    const { error } = await sb.from('roles').insert({
      name:        newName.trim().toLowerCase().replace(/\s+/g, '_'),
      label:       newLabel.trim(),
      permissions: { sections: ['dashboard'], countries: ['all'] },
    })
    setSaving(false)
    if (!error) {
      setShowNew(false); setNewName(''); setNewLabel('')
      load()
    }
  }

  async function deleteRole(id) {
    if (!confirm('¿Eliminar este rol? Los usuarios asignados perderán su rol.')) return
    await sb.from('roles').delete().eq('id', id)
    load()
  }

  return (
    <div className="am-tab-content">
      <div className="am-toolbar">
        <button className="am-btn am-btn--primary" onClick={() => setShowNew(f => !f)}>
          {showNew ? '✕ Cancelar' : '+ Crear rol'}
        </button>
      </div>

      {showNew && (
        <form className="am-form" onSubmit={createRole}>
          <h3 className="am-form__title">Nuevo rol</h3>
          <div className="am-form__row">
            <label><span>Nombre interno</span>
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="analyst" required />
            </label>
            <label><span>Etiqueta visible</span>
              <input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Analista" required />
            </label>
          </div>
          <div className="am-form__actions">
            <button type="submit" className="am-btn am-btn--primary" disabled={saving}>Crear</button>
          </div>
        </form>
      )}

      {msg && <div className={`am-msg am-msg--${msg.type}`}>{msg.text}</div>}

      {loading ? (
        <div className="am-empty">Cargando…</div>
      ) : (
        <div className="am-roles-list">
          {roles.map(role => (
            <div key={role.id} className="am-role-card">
              <div className="am-role-card__header">
                <div>
                  <span className="am-role-card__name">{role.label}</span>
                  <span className="am-role-card__slug"> ({role.name})</span>
                </div>
                <div className="am-role-card__actions">
                  {editing === role.id ? (
                    <>
                      <button className="am-btn am-btn--sm am-btn--primary" onClick={() => saveRole(role.id)} disabled={saving}>
                        {saving ? '…' : '💾 Guardar'}
                      </button>
                      <button className="am-btn am-btn--sm" onClick={() => setEditing(null)}>Cancelar</button>
                    </>
                  ) : (
                    <>
                      <button className="am-btn am-btn--sm" onClick={() => startEdit(role)}>✏️ Editar permisos</button>
                      <button className="am-btn am-btn--sm am-btn--danger" onClick={() => deleteRole(role.id)}>Eliminar</button>
                    </>
                  )}
                </div>
              </div>

              {editing === role.id ? (
                <div className="am-role-card__editor">
                  <div className="am-perm-group">
                    <div className="am-perm-group__title">
                      Secciones
                      <button className="am-btn am-btn--xs" onClick={() => toggleAll('sections')}>
                        {draftPerms.sections.includes('all') ? 'Quitar Todo' : 'Seleccionar Todo'}
                      </button>
                    </div>
                    <div className="am-perm-checks">
                      {ALL_SECTIONS.map(sec => (
                        <label key={sec} className="am-check">
                          <input
                            type="checkbox"
                            checked={draftPerms.sections.includes('all') || draftPerms.sections.includes(sec)}
                            onChange={() => {
                              if (draftPerms.sections.includes('all')) {
                                setDraftPerms(p => ({ ...p, sections: ALL_SECTIONS.filter(s => s !== sec) }))
                              } else {
                                toggleSection(sec)
                              }
                            }}
                          />
                          {SECTION_LABELS[sec] || sec}
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="am-perm-group">
                    <div className="am-perm-group__title">
                      Países
                      <button className="am-btn am-btn--xs" onClick={() => toggleAll('countries')}>
                        {draftPerms.countries.includes('all') ? 'Quitar Todo' : 'Seleccionar Todo'}
                      </button>
                    </div>
                    <div className="am-perm-checks">
                      {COUNTRIES.map(c => (
                        <label key={c} className="am-check">
                          <input
                            type="checkbox"
                            checked={draftPerms.countries.includes('all') || draftPerms.countries.includes(c)}
                            onChange={() => {
                              if (draftPerms.countries.includes('all')) {
                                setDraftPerms(p => ({ ...p, countries: COUNTRIES.filter(x => x !== c) }))
                              } else {
                                toggleCountry(c)
                              }
                            }}
                          />
                          {c}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="am-role-card__summary">
                  <span className="am-role-card__perm-label">Secciones:</span>
                  <span className="am-role-card__perm-val">
                    {role.permissions?.sections?.includes('all')
                      ? 'Todas'
                      : (role.permissions?.sections || []).map(s => SECTION_LABELS[s] || s).join(', ') || '—'}
                  </span>
                  <span className="am-role-card__perm-label">Países:</span>
                  <span className="am-role-card__perm-val">
                    {role.permissions?.countries?.includes('all')
                      ? 'Todos'
                      : (role.permissions?.countries || []).join(', ') || '—'}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────
export default function AccessManagement() {
  const [activeTab, setActiveTab] = useState('users')
  const [roles, setRoles] = useState([])

  useEffect(() => {
    sb.from('roles').select('*').order('id').then(({ data }) => setRoles(data || []))
  }, [])

  return (
    <div className="am-page">
      <h1 className="am-page__title">Gestión de Accesos</h1>
      <p className="am-page__desc">
        Administra los usuarios con acceso al sistema y define los permisos por sección y país para cada rol.
      </p>

      <div className="am-tabs">
        <button
          className={`am-tab-btn${activeTab === 'users' ? ' active' : ''}`}
          onClick={() => setActiveTab('users')}
        >
          👥 Usuarios
        </button>
        <button
          className={`am-tab-btn${activeTab === 'roles' ? ' active' : ''}`}
          onClick={() => setActiveTab('roles')}
        >
          🎭 Puestos / Roles
        </button>
      </div>

      {activeTab === 'users' && <UsersTab roles={roles} />}
      {activeTab === 'roles' && <RolesTab />}
    </div>
  )
}
