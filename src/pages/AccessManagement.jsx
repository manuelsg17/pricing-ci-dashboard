import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { useCountry } from '../context/CountryContext'
import {
  useRoles,
  useInvalidateRoles,
  updateRolePermissions,
  createRole as createRoleRow,
  deleteRole as deleteRoleRow,
} from '../hooks/useRoles'
import {
  useUserProfiles,
  setUserProfileActive,
  setUserProfileRole,
  deleteUserProfile,
  createUserAccount,
} from '../hooks/useUserProfiles'
import { useSectionWriteGrants, tablesGrantedBy } from '../hooks/useSectionWriteGrants'
import { ALL_SECTIONS, getSectionLabel } from '../hooks/useAccessControl'
import { useI18n } from '../context/LanguageContext'
import { COUNTRIES } from '../lib/constants'
import { toSnakeCase } from '../lib/normalize'
import { useToast } from '../components/ui/Toast'
import { useConfirm } from '../components/ui/ConfirmDialog'
import EmptyState from '../components/ui/EmptyState'
import { SkeletonTable } from '../components/ui/Skeleton'
import { Button } from '../components/ui/shadcn/button'
import '../styles/access-management.css'

// ── Users tab ──────────────────────────────────────────────────────────────
function UsersTab({ roles }) {
  const { session } = useAuth()
  const currentEmail = session?.user?.email || ''
  const { t } = useI18n()
  const toast = useToast()
  const confirm = useConfirm()

  // Consulta y recarga en useUserProfiles.js
  const { users, loading, load } = useUserProfiles()

  // New user form
  const [showForm, setShowForm] = useState(false)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [roleId, setRoleId] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleToggleActive(user) {
    await setUserProfileActive(user.id, !user.is_active)
    load()
  }

  async function handleChangeRole(userId, newRoleId) {
    const { error } = await setUserProfileRole(userId, newRoleId)
    if (error) toast.err(`Error al actualizar rol: ${error.message}`)
    else toast.ok('Rol actualizado.')
    load()
  }

  async function handleInvite(e) {
    e.preventDefault()
    if (!email.trim() || !password.trim()) return
    setSaving(true)

    try {
      const res = await createUserAccount({
        email: email.trim().toLowerCase(),
        password: password.trim(),
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        role_id: roleId || null,
        invited_by: currentEmail,
      })
      const json = res.json
      setSaving(false)

      if (!res.ok) {
        toast.err(`Error ${res.status}: ${json?.error || JSON.stringify(json)}`)
      } else {
        toast.ok(`Usuario ${email} creado con acceso al sistema.`)
        setFirstName('')
        setLastName('')
        setEmail('')
        setPassword('')
        setRoleId('')
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
      danger: true,
      confirmText: 'Eliminar',
    })
    if (!ok) return
    const { error } = await deleteUserProfile(id)
    if (error) toast.err(`Error al eliminar: ${error.message}`)
    else {
      toast.ok('Usuario eliminado.')
      load()
    }
  }

  return (
    <div className="am-tab-content">
      <div className="am-toolbar">
        <Button onClick={() => setShowForm((f) => !f)}>
          {showForm ? `✕ ${t('app.cancel')}` : t('access.register_user')}
        </Button>
      </div>

      {showForm && (
        <form className="am-form" onSubmit={handleInvite}>
          <h3 className="am-form__title">{t('access.new_user')}</h3>
          <div className="am-form__row">
            <label>
              <span>{t('access.first_name')}</span>
              <input
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder={t('access.first_name')}
              />
            </label>
            <label>
              <span>{t('access.last_name')}</span>
              <input
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder={t('access.last_name')}
              />
            </label>
          </div>
          <div className="am-form__row">
            <label>
              <span>{t('access.email')} *</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="user@company.com"
              />
            </label>
            <label>
              <span>{t('access.password')}</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder={t('access.password_placeholder')}
                minLength={6}
              />
            </label>
          </div>
          <div className="am-form__row">
            <label>
              <span>{t('access.role')}</span>
              <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                <option value="">{t('access.no_role')}</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="am-form__actions">
            <Button type="submit" disabled={saving}>
              {saving ? t('app.loading') : t('access.register')}
            </Button>
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
            {users.map((u) => (
              <tr key={u.id} className={!u.is_active ? 'am-row--inactive' : ''}>
                <td>
                  {u.first_name} {u.last_name}
                </td>
                <td className="am-td-email">{u.email}</td>
                <td>
                  <select
                    className="am-select"
                    value={u.role_id || ''}
                    onChange={(e) => handleChangeRole(u.id, e.target.value)}
                  >
                    <option value="">{t('access.no_role')}</option>
                    {roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <span className={`am-badge am-badge--${u.is_active ? 'active' : 'inactive'}`}>
                    {u.is_active ? t('access.active') : t('access.inactive')}
                  </span>
                </td>
                <td className="am-td-actions">
                  <Button
                    variant="outline"
                    size="sm"
                    className={
                      u.is_active
                        ? 'border-yellow-200 bg-yellow-100 text-yellow-800 hover:bg-yellow-200'
                        : 'border-green-300 bg-green-100 text-green-800 hover:bg-green-200'
                    }
                    onClick={() => handleToggleActive(u)}
                  >
                    {u.is_active ? t('access.deactivate') : t('access.activate')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-red-300 bg-red-100 text-red-800 hover:bg-red-200"
                    onClick={() => handleDelete(u.id)}
                  >
                    {t('app.delete')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Qué escribe cada sección ───────────────────────────────────────────────
// Etiqueta corta al lado de cada checkbox. Antes de esto, elegir secciones era
// a ciegas: el check decía "ve esta pantalla" y nada decía si además concede
// escritura, sobre qué, ni si el permiso lo decide otra cosa. Justo la
// pregunta que hay que responder ANTES de guardar un rol nuevo, no después de
// que un hub reporte que no puede guardar.
function SectionWriteBadge({ buckets }) {
  const { t } = useI18n()
  if (!buckets) return <span className="am-wgrant am-wgrant--none">{t('access.writes_none')}</span>

  // La etiqueta dice lo MEJOR que concede la sección; el tooltip aclara el
  // resto. Varias secciones son mixtas (Proyectos escribe `section_last_seen`
  // por dueño y `project_tasks` solo-admin; Cargar Data igual), así que
  // mostrar un solo grupo y callar los otros sería contar media verdad —
  // justo el tipo de media verdad que hace que alguien delegue creyendo que
  // delegó más de lo que delegó.
  const detalle = [
    buckets.section.length ? `${t('access.writes')}:\n  ${buckets.section.join('\n  ')}` : null,
    buckets.owner.length
      ? `${t('access.writes_owner')} — ${t('access.writes_owner_hint')}\n  ${buckets.owner.join('\n  ')}`
      : null,
    buckets.admin.length
      ? `${t('access.writes_admin')} — ${t('access.writes_admin_hint')}\n  ${buckets.admin.join('\n  ')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n\n')

  if (buckets.section.length > 0) {
    return (
      <span className="am-wgrant am-wgrant--write" title={detalle}>
        {t('access.writes')}: {buckets.section.length}
      </span>
    )
  }
  if (buckets.owner.length > 0) {
    return (
      <span className="am-wgrant am-wgrant--owner" title={detalle}>
        {t('access.writes_owner')}
      </span>
    )
  }
  if (buckets.admin.length > 0) {
    return (
      <span className="am-wgrant am-wgrant--admin" title={detalle}>
        {t('access.writes_admin')}
      </span>
    )
  }
  return <span className="am-wgrant am-wgrant--none">{t('access.writes_none')}</span>
}

// Resumen en vivo de lo que el rol va a poder escribir con las secciones
// tildadas EN ESTE MOMENTO — se recalcula mientras se edita, para que el
// efecto del cambio se vea antes de guardarlo.
function WriteSummary({ sections, bySection, error }) {
  const { t } = useI18n()
  const tables = tablesGrantedBy(sections, bySection)
  return (
    <div className="am-write-summary">
      <div className="am-write-summary__title">{t('access.will_write_title')}</div>
      {error ? (
        <div className="am-write-summary__empty">{t('access.grants_load_error')}</div>
      ) : tables.length === 0 ? (
        <div className="am-write-summary__empty">{t('access.will_write_none')}</div>
      ) : (
        <div className="am-write-summary__tables">
          {tables.map((tbl) => (
            <code key={tbl} className="am-write-summary__table">
              {tbl}
            </code>
          ))}
        </div>
      )}
      <div className="am-write-summary__hint">{t('access.will_write_hint')}</div>
    </div>
  )
}

// ── Roles tab ──────────────────────────────────────────────────────────────
function RolesTab({ availableCountries }) {
  const { t } = useI18n()
  const toast = useToast()
  const confirm = useConfirm()
  const { data: roles = [], isLoading: loading } = useRoles()
  const { bySection: writeGrants, isError: grantsError } = useSectionWriteGrants()
  const invalidateRoles = useInvalidateRoles()
  const [editing, setEditing] = useState(null) // role id being edited
  const [draftPerms, setDraftPerms] = useState({ sections: [], countries: [] })
  const [saving, setSaving] = useState(false)

  // New role form
  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [newLabel, setNewLabel] = useState('')

  function startEdit(role) {
    setEditing(role.id)
    setDraftPerms({
      sections: role.permissions?.sections || [],
      countries: role.permissions?.countries || [],
    })
  }

  function toggleSection(sec) {
    setDraftPerms((prev) => {
      const has = prev.sections.includes(sec)
      const next = has ? prev.sections.filter((s) => s !== sec) : [...prev.sections, sec]
      return { ...prev, sections: next }
    })
  }

  function toggleAll(field) {
    setDraftPerms((prev) => {
      if (prev[field].includes('all')) return { ...prev, [field]: [] }
      return { ...prev, [field]: ['all'] }
    })
  }

  function toggleCountry(c) {
    setDraftPerms((prev) => {
      const has = prev.countries.includes(c)
      const next = has ? prev.countries.filter((x) => x !== c) : [...prev.countries, c]
      return { ...prev, countries: next }
    })
  }

  async function saveRole(id) {
    setSaving(true)
    const { error } = await updateRolePermissions(id, draftPerms)
    setSaving(false)
    if (error) {
      toast.err(`Error al guardar rol: ${error.message}`)
    } else {
      toast.ok('Rol actualizado.')
      setEditing(null)
      invalidateRoles()
    }
  }

  async function createRole(e) {
    e.preventDefault()
    if (!newName.trim() || !newLabel.trim()) return
    setSaving(true)
    const { error } = await createRoleRow({
      name: toSnakeCase(newName),
      label: newLabel.trim(),
      permissions: { sections: ['dashboard'], countries: ['all'] },
    })
    setSaving(false)
    if (error) {
      toast.err(`Error al crear rol: ${error.message}`)
    } else {
      toast.ok(`Rol "${newLabel}" creado.`)
      setShowNew(false)
      setNewName('')
      setNewLabel('')
      invalidateRoles()
    }
  }

  async function deleteRole(id) {
    const ok = await confirm({
      title: 'Eliminar rol',
      message: t('access.confirm_delete_role'),
      danger: true,
      confirmText: 'Eliminar',
    })
    if (!ok) return
    const { error } = await deleteRoleRow(id)
    if (error) toast.err(`Error al eliminar rol: ${error.message}`)
    else {
      toast.ok('Rol eliminado.')
      invalidateRoles()
    }
  }

  return (
    <div className="am-tab-content">
      <div className="am-toolbar">
        <Button onClick={() => setShowNew((f) => !f)}>
          {showNew ? `✕ ${t('app.cancel')}` : t('access.create_role')}
        </Button>
      </div>

      {showNew && (
        <form className="am-form" onSubmit={createRole}>
          <h3 className="am-form__title">{t('access.new_role')}</h3>
          <div className="am-form__row">
            <label>
              <span>{t('access.internal_name')}</span>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="analyst"
                required
              />
            </label>
            <label>
              <span>{t('access.visible_label')}</span>
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Analyst"
                required
              />
            </label>
          </div>
          <div className="am-form__actions">
            <Button type="submit" disabled={saving}>
              {t('access.create')}
            </Button>
          </div>
        </form>
      )}

      {loading ? (
        <SkeletonTable rows={4} cols={3} />
      ) : (
        <div className="am-roles-list">
          {roles.map((role) => (
            <div key={role.id} className="am-role-card">
              <div className="am-role-card__header">
                <div>
                  <span className="am-role-card__name">{role.label}</span>
                  <span className="am-role-card__slug"> ({role.name})</span>
                </div>
                <div className="am-role-card__actions">
                  {editing === role.id ? (
                    <>
                      <Button size="sm" onClick={() => saveRole(role.id)} disabled={saving}>
                        {saving ? '…' : t('app.save')}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setEditing(null)}>
                        {t('app.cancel')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button variant="outline" size="sm" onClick={() => startEdit(role)}>
                        {t('access.edit_perms')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-red-300 bg-red-100 text-red-800 hover:bg-red-200"
                        onClick={() => deleteRole(role.id)}
                      >
                        {t('app.delete')}
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {editing === role.id ? (
                <div className="am-role-card__editor">
                  <div className="am-perm-group">
                    <div className="am-perm-group__title">
                      {t('access.sections')}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-auto px-2 py-0.5 text-[10px]"
                        onClick={() => toggleAll('sections')}
                      >
                        {draftPerms.sections.includes('all')
                          ? t('access.deselect_all')
                          : t('access.select_all')}
                      </Button>
                    </div>
                    <div className="am-perm-checks">
                      {ALL_SECTIONS.map((sec) => (
                        <label key={sec} className="am-check">
                          <input
                            type="checkbox"
                            checked={
                              draftPerms.sections.includes('all') ||
                              draftPerms.sections.includes(sec)
                            }
                            onChange={() => {
                              if (draftPerms.sections.includes('all')) {
                                setDraftPerms((p) => ({
                                  ...p,
                                  sections: ALL_SECTIONS.filter((s) => s !== sec),
                                }))
                              } else {
                                toggleSection(sec)
                              }
                            }}
                          />
                          <span className="am-check__label">{getSectionLabel(t, sec)}</span>
                          <SectionWriteBadge buckets={writeGrants[sec]} />
                        </label>
                      ))}
                    </div>
                    <WriteSummary
                      sections={draftPerms.sections}
                      bySection={writeGrants}
                      error={grantsError}
                    />
                  </div>

                  <div className="am-perm-group">
                    <div className="am-perm-group__title">
                      {t('access.countries')}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-auto px-2 py-0.5 text-[10px]"
                        onClick={() => toggleAll('countries')}
                      >
                        {draftPerms.countries.includes('all')
                          ? t('access.deselect_all')
                          : t('access.select_all')}
                      </Button>
                    </div>
                    <div className="am-perm-checks">
                      {(availableCountries || COUNTRIES).map((c) => (
                        <label key={c} className="am-check">
                          <input
                            type="checkbox"
                            checked={
                              draftPerms.countries.includes('all') ||
                              draftPerms.countries.includes(c)
                            }
                            onChange={() => {
                              if (draftPerms.countries.includes('all')) {
                                setDraftPerms((p) => ({
                                  ...p,
                                  countries: (availableCountries || COUNTRIES).filter(
                                    (x) => x !== c
                                  ),
                                }))
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
                      : (role.permissions?.sections || [])
                          .map((s) => getSectionLabel(t, s))
                          .join(', ') || '—'}
                  </span>
                  <span className="am-role-card__perm-label">{t('access.countries')}:</span>
                  <span className="am-role-card__perm-val">
                    {role.permissions?.countries?.includes('all')
                      ? t('access.all_m')
                      : (role.permissions?.countries || []).join(', ') || '—'}
                  </span>
                  {/* También en la tarjeta cerrada: revisar qué escribe un rol
                      ya creado no debería exigir entrar a editarlo — entrar a
                      editar es justo el momento en que es fácil guardar sin
                      querer un cambio que no se pretendía hacer. */}
                  <span className="am-role-card__perm-label">{t('access.writes')}:</span>
                  <span className="am-role-card__perm-val">
                    {(() => {
                      const tables = tablesGrantedBy(role.permissions?.sections, writeGrants)
                      return tables.length ? tables.join(', ') : t('access.writes_none')
                    })()}
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
  const { data: roles = [] } = useRoles()
  const { t } = useI18n()
  const { availableCountries } = useCountry()

  return (
    <div className="am-page">
      <h1 className="am-page__title">{t('access.title')}</h1>
      <p className="am-page__desc">{t('access.desc')}</p>

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
