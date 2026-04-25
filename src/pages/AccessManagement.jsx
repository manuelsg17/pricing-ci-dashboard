import { useState, useEffect, useCallback } from 'react'
import { sb }         from '../lib/supabase'
import { useAuth }    from '../lib/auth'
import { useCountry } from '../context/CountryContext'
import { ALL_SECTIONS, SECTION_LABELS } from '../hooks/useAccessControl'
import { useI18n }    from '../context/LanguageContext'
import { COUNTRIES }  from '../lib/constants'
import { useToast }   from '../components/ui/Toast'
import { useConfirm } from '../components/ui/ConfirmDialog'
import EmptyState     from '../components/ui/EmptyState'
import { SkeletonTable } from '../components/ui/Skeleton'
import '../styles/access-management.css'

// ── Users tab ──────────────────────────────────────────────────────────────
function UsersTab({ roles }) {
  const { session } = useAuth()
  const currentEmail = session?.user?.email || ''
  const { t } = useI18n()
  const toast   = useToast()
  const confirm = useConfirm()

  const [users,   setUsers]   = useState([])
  const [loading, setLoading] = useState(false)

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
    if (error) toast.err(`Error al actualizar rol: ${error.message}`)
    else       toast.ok('Rol actualizado.')
    load()
  }

  async function handleInvite(e) {
    e.preventDefault()
    if (!email.trim() || !password.trim()) return
    setSaving(true)

    try {
      const { data: { session: currentSession } } = await sb.auth.getSession()
      const token = currentSession?.access_token

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
      const anonKey     = import.meta.env.VITE_SUPABASE_ANON_KEY

      const res = await fetch(`${supabaseUrl}/functions/v1/create-user`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'apikey':        anonKey,
          'Authorization': token ? `Bearer ${token}` : `Bearer ${anonKey}`,
        },
        body: JSON.stringify({
          email:      email.trim().toLowerCase(),
          password:   password.trim(),
          first_name: firstName.trim(),
          last_name:  lastName.trim(),
          role_id:    roleId || null,
          invited_by: currentEmail,
        }),
      })

      const json = await res.json().catch(() => ({}))
      setSaving(false)

      if (!res.ok) {
        toast.err(`Error ${res.status}: ${json?.error || JSON.stringify(json)}`)
      } else {
        toast.ok(`Usuario ${email} creado con acceso al sistema.`)
        setFirstName(''); setLastName(''); setEmail(''); setPassword(''); setRoleId('')
        setShowForm(false)
        load()
      }
    } catch (err) {
      setSaving(false)
      toast.err(`Error de red: ${err.message}`)
    }
  }

  async function handleDelete(id) {
    const ok = await confirm({
      title: 'Eliminar usuario',
      message: t('access.confirm_delete_user'),
      danger: true, confirmText: 'Eliminar',
    })
    if (!ok) return
    const { error } = await sb.from('user_profiles').delete().eq('id', id)
    if (error) toast.err(`Error al eliminar: ${error.message}`)
    else { toast.ok('Usuario eliminado.'); load() }
  }

  return (
    <div className="am-tab-content">
      <div className="am-toolbar">
        <button className="am-btn am-btn--primary" onClick={() => setShowForm(f => !f)}>
          {showForm ? `✕ ${t('app.cancel')}` : t('access.register_user')}
        </button>
      </div>

      {showForm && (
        <form className="am-form" onSubmit={handleInvite}>
          <h3 className="am-form__title">{t('access.new_user')}</h3>
          <div className="am-form__row">
            <label>
              <span>{t('access.first_name')}</span>
              <input value={firstName} onChange={e => setFirstName(e.target.value)} placeholder={t('access.first_name')} />
            </label>
            <label>
              <span>{t('access.last_name')}</span>
              <input value={lastName} onChange={e => setLastName(e.target.value)} placeholder={t('access.last_name')} />
            </label>
          </div>
          <div className="am-form__row">
            <label>
              <span>{t('access.email')} *</span>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="user@company.com" />
            </label>
            <label>
              <span>{t('access.password')}</span>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} required placeholder="Min 6 chars" minLength={6} />
            </label>
          </div>
          <div className="am-form__row">
            <label>
              <span>{t('access.role')}</span>
              <select value={roleId} onChange={e => setRoleId(e.target.value)}>
                <option value="">{t('access.no_role')}</option>
                {roles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </label>
          </div>
          <div className="am-form__actions">
            <button type="submit" className="am-btn am-btn--primary" disabled={saving}>
              {saving ? t('app.loading') : t('access.register')}
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <SkeletonTable rows={5} cols={5} />
      ) : users.length === 0 ? (
        <EmptyState icon="👥" title={t('access.no_users')} compact />
      ) : (
        <table className="am-table">
          <thead>
            <tr>
              <th>{t('access.first_name')}</th>
              <th>{t('access.email')}</th>
              <th>{t('access.role')}</th>
              <th>{t('access.status')}</th>
              <th>{t('access.actions')}</th>
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
                    <option value="">{t('access.no_role')}</option>
                    {roles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                </td>
                <td>
                  <span className={`am-badge am-badge--${u.is_active ? 'active' : 'inactive'}`}>
                    {u.is_active ? t('access.active') : t('access.inactive')}
                  </span>
                </td>
                <td className="am-td-actions">
                  <button
                    className={`am-btn am-btn--sm ${u.is_active ? 'am-btn--warn' : 'am-btn--ok'}`}
                    onClick={() => handleToggleActive(u)}
                  >
                    {u.is_active ? t('access.deactivate') : t('access.activate')}
                  </button>
                  <button className="am-btn am-btn--sm am-btn--danger" onClick={() => handleDelete(u.id)}>
                    {t('app.delete')}
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
function RolesTab({ availableCountries }) {
  const { t } = useI18n()
  const toast   = useToast()
  const confirm = useConfirm()
  const [roles,   setRoles]   = useState([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(null) // role id being edited
  const [draftPerms, setDraftPerms] = useState({ sections: [], countries: [] })
  const [saving,  setSaving]  = useState(false)

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
    setSaving(true)
    const { error } = await sb.from('roles')
      .update({ permissions: draftPerms })
      .eq('id', id)
    setSaving(false)
    if (error) {
      toast.err(`Error al guardar rol: ${error.message}`)
    } else {
      toast.ok('Rol actualizado.')
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
    if (error) {
      toast.err(`Error al crear rol: ${error.message}`)
    } else {
      toast.ok(`Rol "${newLabel}" creado.`)
      setShowNew(false); setNewName(''); setNewLabel('')
      load()
    }
  }

  async function deleteRole(id) {
    const ok = await confirm({
      title: 'Eliminar rol',
      message: t('access.confirm_delete_role'),
      danger: true, confirmText: 'Eliminar',
    })
    if (!ok) return
    const { error } = await sb.from('roles').delete().eq('id', id)
    if (error) toast.err(`Error al eliminar rol: ${error.message}`)
    else { toast.ok('Rol eliminado.'); load() }
  }

  return (
    <div className="am-tab-content">
      <div className="am-toolbar">
        <button className="am-btn am-btn--primary" onClick={() => setShowNew(f => !f)}>
          {showNew ? `✕ ${t('app.cancel')}` : t('access.create_role')}
        </button>
      </div>

      {showNew && (
        <form className="am-form" onSubmit={createRole}>
          <h3 className="am-form__title">{t('access.new_role')}</h3>
          <div className="am-form__row">
            <label><span>{t('access.internal_name')}</span>
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="analyst" required />
            </label>
            <label><span>{t('access.visible_label')}</span>
              <input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Analyst" required />
            </label>
          </div>
          <div className="am-form__actions">
            <button type="submit" className="am-btn am-btn--primary" disabled={saving}>{t('access.create')}</button>
          </div>
        </form>
      )}

      {loading ? (
        <SkeletonTable rows={4} cols={3} />
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
                        {saving ? '…' : t('app.save')}
                      </button>
                      <button className="am-btn am-btn--sm" onClick={() => setEditing(null)}>{t('app.cancel')}</button>
                    </>
                  ) : (
                    <>
                      <button className="am-btn am-btn--sm" onClick={() => startEdit(role)}>{t('access.edit_perms')}</button>
                      <button className="am-btn am-btn--sm am-btn--danger" onClick={() => deleteRole(role.id)}>{t('app.delete')}</button>
                    </>
                  )}
                </div>
              </div>

              {editing === role.id ? (
                <div className="am-role-card__editor">
                  <div className="am-perm-group">
                    <div className="am-perm-group__title">
                      {t('access.sections')}
                      <button className="am-btn am-btn--xs" onClick={() => toggleAll('sections')}>
                        {draftPerms.sections.includes('all') ? t('access.deselect_all') : t('access.select_all')}
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
                      {t('access.countries')}
                      <button className="am-btn am-btn--xs" onClick={() => toggleAll('countries')}>
                        {draftPerms.countries.includes('all') ? t('access.deselect_all') : t('access.select_all')}
                      </button>
                    </div>
                    <div className="am-perm-checks">
                      {(availableCountries || COUNTRIES).map(c => (
                        <label key={c} className="am-check">
                          <input
                            type="checkbox"
                            checked={draftPerms.countries.includes('all') || draftPerms.countries.includes(c)}
                            onChange={() => {
                              if (draftPerms.countries.includes('all')) {
                                setDraftPerms(p => ({ ...p, countries: (availableCountries || COUNTRIES).filter(x => x !== c) }))
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
                  <span className="am-role-card__perm-label">{t('access.sections')}:</span>
                  <span className="am-role-card__perm-val">
                    {role.permissions?.sections?.includes('all')
                      ? t('access.all')
                      : (role.permissions?.sections || []).map(s => SECTION_LABELS[s] || s).join(', ') || '—'}
                  </span>
                  <span className="am-role-card__perm-label">{t('access.countries')}:</span>
                  <span className="am-role-card__perm-val">
                    {role.permissions?.countries?.includes('all')
                      ? t('access.all_m')
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
  const { t } = useI18n()
  const { availableCountries } = useCountry()

  useEffect(() => {
    sb.from('roles').select('*').order('id').then(({ data }) => setRoles(data || []))
  }, [])

  return (
    <div className="am-page">
      <h1 className="am-page__title">{t('access.title')}</h1>
      <p className="am-page__desc">
        {t('access.desc')}
      </p>

      <div className="am-tabs">
        <button
          className={`am-tab-btn${activeTab === 'users' ? ' active' : ''}`}
          onClick={() => setActiveTab('users')}
        >
          {t('access.users')}
        </button>
        <button
          className={`am-tab-btn${activeTab === 'roles' ? ' active' : ''}`}
          onClick={() => setActiveTab('roles')}
        >
          {t('access.roles')}
        </button>
      </div>

      {activeTab === 'users' && <UsersTab roles={roles} />}
      {activeTab === 'roles' && <RolesTab availableCountries={availableCountries} />}
    </div>
  )
}
