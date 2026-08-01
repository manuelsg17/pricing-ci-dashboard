import { useState, useEffect, useRef } from 'react'
import { useI18n } from '../../context/LanguageContext'
import { Button } from '../ui/shadcn/button'
import EmptyState from '../ui/EmptyState'
import { validateTaskDates } from '../../lib/projectTasks'
import {
  createProject,
  createTask,
  updateTask,
  deleteTask,
  taskActivityCount,
  archiveProject,
  fetchAssignableUsers,
} from '../../hooks/useProjects'

// Vista de administración: crear proyectos y cargar sus tareas.
//
// El alta de tareas es INLINE tipo planilla, no un modal por tarea. La
// simulación mostró que cargar 15 tareas con modal eran ~60 clics (§3.1).
// Acá: escribís, Tab, Tab, Enter — y aparece la fila siguiente lista.
//
// El selector de owner solo lista gente con acceso al país del proyecto. Sin
// eso se crea un agujero negro: la tarea figura asignada y esa persona nunca
// la ve porque RLS se la oculta (§15.2).

export default function ProjectsAdmin({
  data,
  country,
  countryLabel,
  userEmail,
  cities,
  onChanged,
}) {
  const { t } = useI18n()
  const { projects, tasks, today } = data
  const [openId, setOpenId] = useState(null)
  const [creating, setCreating] = useState(false)
  const [owners, setOwners] = useState([])
  const [err, setErr] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetchAssignableUsers(country).then(({ data: u }) => {
      if (!cancelled) setOwners(u || [])
    })
    return () => {
      cancelled = true
    }
  }, [country])

  async function onCreateProject(e) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const selected = f.getAll('cities')
    const payload = {
      country,
      name: (f.get('name') || '').trim(),
      description: (f.get('description') || '').trim() || null,
      start_date: f.get('start_date') || null,
      end_date: f.get('end_date') || null,
      cities: selected, // [] = todas las ciudades del país
      created_by: userEmail,
    }
    if (!payload.name) return
    const { data: p, error } = await createProject(payload)
    if (error) {
      setErr(error.message)
      return
    }
    setCreating(false)
    setOpenId(p.id)
    onChanged?.()
  }

  async function onArchive(id) {
    // Archivar, nunca borrar: el cascade se llevaría todo el historial de
    // comentarios de los hubs sin aviso (§13.10).
    if (!window.confirm(t('projects.confirm_archive'))) return
    const { error } = await archiveProject(id)
    if (error) setErr(error.message)
    else onChanged?.()
  }

  return (
    <div className="pview">
      {err && <div className="pview__err">{err}</div>}

      <div className="pview__toolbar">
        <Button size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? t('app.cancel') : t('projects.new_project')}
        </Button>
      </div>

      {creating && (
        <form className="pform" onSubmit={onCreateProject}>
          {/* El país se muestra grande y NO se edita: crear un proyecto en el
              país equivocado significa que sus hubs nunca lo van a ver, y el
              error sería silencioso (§17.7). */}
          <div className="pform__country">
            {t('projects.will_belong_to')} <strong>{countryLabel || country}</strong>
          </div>
          <label>
            {t('projects.field_name')}
            <input name="name" required autoFocus maxLength={120} />
          </label>
          <label>
            {t('projects.field_desc')}
            <input name="description" maxLength={400} />
          </label>
          <div className="pform__row">
            <label>
              {t('projects.field_start')}
              <input type="date" name="start_date" />
            </label>
            <label>
              {t('projects.field_end')}
              <input type="date" name="end_date" />
            </label>
          </div>
          <fieldset className="pform__cities">
            <legend>{t('projects.field_cities')}</legend>
            <p className="pform__hint">{t('projects.cities_hint')}</p>
            {cities.map((c) => (
              <label key={c} className="pform__chk">
                <input type="checkbox" name="cities" value={c} /> {c}
              </label>
            ))}
          </fieldset>
          <Button type="submit" size="sm">
            {t('projects.create')}
          </Button>
        </form>
      )}

      {projects.length === 0 && !creating && (
        <EmptyState
          icon="📁"
          title={t('projects.empty_admin_title')}
          message={t('projects.empty_admin_msg')}
        />
      )}

      {projects.map((p) => {
        const own = tasks.filter((x) => x.project_id === p.id)
        const done = own.filter((x) => x.status === 'done').length
        return (
          <section key={p.id} className="pproj">
            <header className="pproj__head">
              <button
                type="button"
                className="pproj__toggle"
                onClick={() => setOpenId(openId === p.id ? null : p.id)}
                aria-expanded={openId === p.id}
              >
                {openId === p.id ? '▾' : '▸'} {p.name}
              </button>
              <span className="pproj__meta">
                {t('projects.progress', { done, total: own.length })}
                {p.cities?.length > 0 && ` · ${p.cities.join(', ')}`}
                {p.end_date && ` · ${t('projects.due_on')} ${p.end_date}`}
              </span>
              <button type="button" className="pproj__archive" onClick={() => onArchive(p.id)}>
                {t('projects.archive')}
              </button>
            </header>

            {openId === p.id && (
              <TaskEditor
                project={p}
                tasks={own}
                owners={owners}
                cities={cities}
                today={today}
                userEmail={userEmail}
                onChanged={onChanged}
              />
            )}
          </section>
        )
      })}
    </div>
  )
}

/** Planilla de tareas de un proyecto: editar en línea y agregar al final. */
function TaskEditor({ project, tasks, owners, cities, today, userEmail, onChanged }) {
  const { t } = useI18n()
  const [draft, setDraft] = useState({ title: '', owner_email: '', due_date: '', city: '' })
  const [err, setErr] = useState(null)
  const [warn, setWarn] = useState(null)
  const titleRef = useRef(null)

  async function addTask(e) {
    e?.preventDefault()
    const title = draft.title.trim()
    if (!title) return
    const check = validateTaskDates(null, draft.due_date || null, today)
    if (!check.valid) {
      setErr(t('projects.err_dates'))
      return
    }
    setWarn(check.warning === 'born_overdue' ? t('projects.warn_born_overdue') : null)
    const { error } = await createTask({
      project_id: project.id,
      title,
      owner_email: draft.owner_email || null,
      due_date: draft.due_date || null,
      city: draft.city || null,
      sort_order: tasks.length,
      created_by: userEmail,
    })
    if (error) {
      setErr(error.message)
      return
    }
    setErr(null)
    setDraft({ title: '', owner_email: draft.owner_email, due_date: '', city: draft.city })
    titleRef.current?.focus()
    onChanged?.()
  }

  async function onDelete(task) {
    // Sin actividad se borra directo: el alta inline genera filas por accidente
    // y pedir confirmación ahí sería una molestia sin nada que proteger (§17.9).
    const n = await taskActivityCount(task.id)
    if (n > 0 && !window.confirm(t('projects.confirm_delete_task', { n }))) return
    const { error } = await deleteTask(task.id)
    if (error) setErr(error.message)
    else onChanged?.()
  }

  async function patch(task, field, value) {
    const { error } = await updateTask(task.id, { [field]: value || null })
    if (error) setErr(error.message)
    else onChanged?.()
  }

  return (
    <div className="ptable">
      {err && <div className="pview__err">{err}</div>}
      {warn && <div className="pview__warn">{warn}</div>}

      <div className="ptable__head">
        <span>{t('projects.col_title')}</span>
        <span>{t('projects.col_owner')}</span>
        <span>{t('projects.col_due')}</span>
        <span>{t('projects.col_city')}</span>
        <span />
      </div>

      {tasks.map((task) => (
        <div key={task.id} className="ptable__row">
          <input
            defaultValue={task.title}
            onBlur={(e) =>
              e.target.value.trim() &&
              e.target.value !== task.title &&
              patch(task, 'title', e.target.value.trim())
            }
            aria-label={t('projects.col_title')}
          />
          <select
            value={task.owner_email || ''}
            onChange={(e) => patch(task, 'owner_email', e.target.value)}
            aria-label={t('projects.col_owner')}
          >
            <option value="">{t('projects.unassigned')}</option>
            {owners.map((o) => (
              <option key={o.email} value={o.email}>
                {o.email}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={task.due_date || ''}
            onChange={(e) => patch(task, 'due_date', e.target.value)}
            aria-label={t('projects.col_due')}
          />
          <select
            value={task.city || ''}
            onChange={(e) => patch(task, 'city', e.target.value)}
            aria-label={t('projects.col_city')}
          >
            <option value="">{t('projects.all_cities')}</option>
            {cities.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button type="button" className="ptable__del" onClick={() => onDelete(task)}>
            ✕
          </button>
        </div>
      ))}

      {/* Fila de alta: Enter crea y deja el cursor listo para la siguiente. */}
      <form className="ptable__row ptable__row--new" onSubmit={addTask}>
        <input
          ref={titleRef}
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          placeholder={t('projects.new_task_placeholder')}
          aria-label={t('projects.col_title')}
        />
        <select
          value={draft.owner_email}
          onChange={(e) => setDraft({ ...draft, owner_email: e.target.value })}
          aria-label={t('projects.col_owner')}
        >
          <option value="">{t('projects.unassigned')}</option>
          {owners.map((o) => (
            <option key={o.email} value={o.email}>
              {o.email}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={draft.due_date}
          onChange={(e) => setDraft({ ...draft, due_date: e.target.value })}
          aria-label={t('projects.col_due')}
        />
        <select
          value={draft.city}
          onChange={(e) => setDraft({ ...draft, city: e.target.value })}
          aria-label={t('projects.col_city')}
        >
          <option value="">{t('projects.all_cities')}</option>
          {cities.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button type="submit" className="ptable__add" title={t('projects.add_task')}>
          +
        </button>
      </form>
    </div>
  )
}
