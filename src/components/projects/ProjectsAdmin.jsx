import { useState, useEffect, useRef } from 'react'
import { useI18n } from '../../context/LanguageContext'
import { Button } from '../ui/shadcn/button'
import EmptyState from '../ui/EmptyState'
import { validateTaskDates } from '../../lib/projectTasks'
import { useAccionEnVuelo } from '../../hooks/useAccionEnVuelo'
import {
  createProject,
  createTask,
  updateTask,
  deleteTask,
  reassignTask,
  taskActivityCount,
  archiveProject,
  unarchiveProject,
  fetchArchivedProjects,
  fetchAssignableUsers,
  fetchOwnerGap,
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
  const [sinSeccion, setSinSeccion] = useState(0)
  const [archivados, setArchivados] = useState(null) // null = todavía no se pidió
  const [err, setErr] = useState(null)
  // Sin esto, un doble clic en "Crear proyecto" o en "Archivar" dispara la
  // acción dos veces. Ver useAccionEnVuelo.
  const unaVez = useAccionEnVuelo()

  useEffect(() => {
    let cancelled = false
    fetchAssignableUsers(country).then(({ data: u }) => {
      if (!cancelled) setOwners(u || [])
    })
    // Cuántos quedaron afuera del desplegable por no tener la sección. Sin
    // esto, el admin ve una sola persona para asignar y no tiene forma de
    // saber que le falta un permiso, no que la herramienta esté rota.
    fetchOwnerGap(country).then(({ sinSeccion: n }) => {
      if (!cancelled) setSinSeccion(n || 0)
    })
    return () => {
      cancelled = true
    }
  }, [country])

  async function verArchivados() {
    if (archivados !== null) {
      setArchivados(null) // segundo clic: se cierra
      return
    }
    const { data, error } = await fetchArchivedProjects(country)
    if (error) setErr(error.message)
    else setArchivados(data)
  }

  async function onUnarchive(id) {
    await unaVez(`desarchivar:${id}`, async () => {
      const { error } = await unarchiveProject(id)
      if (error) {
        setErr(error.message)
        return
      }
      setArchivados((prev) => (prev || []).filter((x) => x.id !== id))
      onChanged?.()
    })
  }

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
    await unaVez('crear-proyecto', async () => {
      const { data: p, error } = await createProject(payload)
      if (error) {
        setErr(error.message)
        return
      }
      setCreating(false)
      setOpenId(p.id)
      onChanged?.()
    })
  }

  async function onArchive(id) {
    // Archivar, nunca borrar: el cascade se llevaría todo el historial de
    // comentarios de los hubs sin aviso (§13.10).
    if (!window.confirm(t('projects.confirm_archive'))) return
    await unaVez(`archivar:${id}`, async () => {
      const { error } = await archiveProject(id)
      if (error) setErr(error.message)
      else onChanged?.()
    })
  }

  return (
    <div className="pview">
      {err && <div className="pview__err">{err}</div>}

      <div className="pview__toolbar">
        <Button size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? t('app.cancel') : t('projects.new_project')}
        </Button>
        {/* §13.10 decía que los archivados salen de las vistas "salvo un filtro
            explícito". Ese filtro no existía, así que archivar era un camino de
            una sola dirección y un clic equivocado no tenía vuelta. */}
        <button type="button" className="projects__refresh" onClick={verArchivados}>
          {archivados === null ? t('projects.show_archived') : t('projects.hide_archived')}
        </button>
      </div>

      {/* El aviso aparece SOLO cuando el hueco de permisos te está bloqueando
          de verdad, o sea cuando no tenés a quién asignarle nada más que a vos
          mismo. Medido en producción: hay 23 usuarios activos de Perú sin la
          sección (20 analistas y 3 más) porque NO deben tener tareas — un
          banner permanente nombrándolos sería regañar por una decisión
          deliberada, y a la semana se ignora igual que cualquier alerta que
          siempre está prendida. */}
      {sinSeccion > 0 && owners.length <= 1 && (
        <div className="pview__warn">{t('projects.owner_gap', { n: sinSeccion })}</div>
      )}

      {archivados !== null && (
        <section className="pproj pproj--archived">
          <header className="pproj__head">
            <strong>{t('projects.archived_title')}</strong>
            <span className="pproj__meta">{archivados.length}</span>
          </header>
          {archivados.length === 0 ? (
            <p className="pgroup__empty">{t('projects.archived_none')}</p>
          ) : (
            archivados.map((a) => (
              <div key={a.id} className="pproj__archived-row">
                <span>{a.name}</span>
                <span className="pproj__meta">
                  {a.cities?.length > 0 ? a.cities.join(', ') : t('projects.all_cities')}
                </span>
                <button type="button" className="pproj__archive" onClick={() => onUnarchive(a.id)}>
                  {t('projects.unarchive')}
                </button>
              </div>
            ))
          )}
        </section>
      )}

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

const DRAFT_VACIO = {
  title: '',
  owner_email: '',
  start_date: '',
  due_date: '',
  city: '',
}

/** Planilla de tareas de un proyecto: editar en línea y agregar al final. */
function TaskEditor({ project, tasks, owners, cities, today, userEmail, onChanged }) {
  const { t } = useI18n()
  const unaVez = useAccionEnVuelo()
  const [draft, setDraft] = useState(DRAFT_VACIO)
  const [err, setErr] = useState(null)
  const [warn, setWarn] = useState(null)
  // Esta planilla guarda sola, sin botón: cada campo se manda al salir o al
  // cambiar. Sin una señal de que pasó algo, no hay forma de distinguir
  // "guardado" de "no hizo nada" — y el usuario se queda mirando la pantalla.
  //
  // La señal es DOBLE a propósito, y las dos son necesarias:
  //   · `estado` — una línea fija arriba de la planilla ("los cambios se
  //     guardan solos" → "Guardando…" → "Guardado"). Contesta la pregunta
  //     ANTES de que el usuario la haga; el destello por fila solo la contesta
  //     después, y solo si estaba mirando esa fila.
  //   · `ok` — el destello verde, que dice CUÁL fila se guardó.
  const [ok, setOk] = useState(null) // id de fila que acaba de guardarse
  const [estado, setEstado] = useState('idle') // idle | saving | saved
  const [ocupada, setOcupada] = useState(null) // id de fila en curso
  const titleRef = useRef(null)
  // El destello se apaga solo; si el componente se desmonta antes (cerrar el
  // proyecto, cambiar de pestaña) el timer tiene que morir con él.
  const timerOk = useRef(null)
  useEffect(() => () => clearTimeout(timerOk.current), [])

  function marcarGuardado(id) {
    setOk(id)
    // "Guardado" NO se apaga solo. Medido en local: el destello duraba 2,6
    // segundos, que es exactamente el tiempo que tarda alguien en mirar la
    // fila que acaba de cambiar y volver a levantar la vista — el aviso se
    // perdía justo con el gesto que lo iba a leer. Queda fijo hasta la próxima
    // acción, igual que el "Todos los cambios guardados" de un doc.
    setEstado('saved')
    // El destello de la FILA sí se apaga: dice cuál se guardó, y ese dato
    // vence en cuanto se toca otra.
    clearTimeout(timerOk.current)
    timerOk.current = setTimeout(() => setOk((v) => (v === id ? null : v)), 2200)
  }

  /**
   * Toda escritura de la planilla pasa por acá.
   *
   * El `catch` no es decorativo: sin él, cualquier fallo que no venga como
   * `{ error }` —una caída de red en medio del pedido, por ejemplo— dejaba
   * "Guardando…" encendido para siempre. Es el peor estado posible de los tres,
   * porque promete que algo está pasando cuando ya no pasa nada, y encima tapa
   * el error. Si falla, se dice; el candado lo suelta `unaVez` en su `finally`.
   */
  async function escribir(clave, pedido, alGuardar) {
    await unaVez(clave, async () => {
      setEstado('saving')
      try {
        const { data, error } = await pedido()
        if (error) {
          setErr(error.message)
          setEstado('idle')
          return
        }
        setErr(null)
        alGuardar?.(data)
      } catch (e) {
        setErr(e?.message || String(e))
        setEstado('idle')
      }
    })
  }

  /**
   * Editar el borrador limpia los avisos de la operación anterior.
   *
   * El error de "escribí el nombre" se quedaba fijo en pantalla hasta el
   * siguiente alta exitosa: apretabas "+" sin título, aparecía el cartel rojo,
   * y no había forma de sacarlo — ni escribiendo, ni tocando la X (que borra
   * la tarea de arriba, no el cartel). Reportado usando la app.
   */
  function editar(parche) {
    setDraft((d) => ({ ...d, ...parche }))
    setErr(null)
    setWarn(null)
  }

  // "Descartar" existe porque la fila de alta NO es un modal: no se abre ni se
  // cierra, vive siempre al final de la planilla. Sin un botón que la vacíe, el
  // que empezó a escribir una tarea y se arrepintió tiene que borrar campo por
  // campo para dejarla como estaba.
  const draftSucio = Object.values(draft).some((v) => v !== '')

  async function addTask(e) {
    e?.preventDefault()
    const title = draft.title.trim()
    // Antes salía en silencio: el usuario apretaba "+" y no pasaba
    // absolutamente nada, sin ningún mensaje. Reportado usando la app.
    if (!title) {
      setErr(t('projects.err_title_required'))
      titleRef.current?.focus()
      return
    }
    const check = validateTaskDates(draft.start_date || null, draft.due_date || null, today)
    if (!check.valid) {
      setErr(t('projects.err_dates'))
      return
    }
    setWarn(check.warning === 'born_overdue' ? t('projects.warn_born_overdue') : null)
    // Clave por TÍTULO: dos clics sobre el mismo texto son el accidente que
    // dejaba dos tareas idénticas con el mismo sort_order (reproducido en
    // local). Escribir otro título y darle enter enseguida sigue funcionando.
    await escribir(
      `alta:${title}`,
      () =>
        createTask({
          project_id: project.id,
          title,
          owner_email: draft.owner_email || null,
          // Sin fecha de inicio toda tarea es un hito de un día y el Gantt no
          // dibuja nada: barras de 1 día en vez de duraciones. La columna existe
          // en el modelo desde la mig 183 y la planilla nunca la expuso.
          start_date: draft.start_date || null,
          due_date: draft.due_date || null,
          city: draft.city || null,
          sort_order: tasks.length,
          created_by: userEmail,
        }),
      (creada) => {
        // La tarea recién creada también destella "Guardado". Sin esto el alta
        // era el único cambio de toda la planilla que no confirmaba nada: la
        // fila subía un renglón y quedaba idéntica a la de borrador que la
        // originó.
        if (creada?.id) marcarGuardado(creada.id)
        // Se recuerda el RESPONSABLE, no la ciudad.
        //
        // Cargando varias tareas seguidas el dueño suele repetirse, así que
        // recordarlo ahorra clics de verdad. La ciudad no: "Consolidar informe
        // final" heredó "Arequipa" de la tarea anterior sin que nadie lo pidiera,
        // y la ciudad es justamente lo que usa el filtro. Un dato equivocado que
        // se pone solo es peor que un clic de más.
        setDraft({ ...DRAFT_VACIO, owner_email: draft.owner_email })
        titleRef.current?.focus()
        onChanged?.()
      }
    )
  }

  function descartarDraft() {
    setDraft(DRAFT_VACIO)
    setErr(null)
    setWarn(null)
    titleRef.current?.focus()
  }

  async function onDelete(task) {
    // Sin actividad se borra directo: el alta inline genera filas por accidente
    // y pedir confirmación ahí sería una molestia sin nada que proteger (§17.9).
    //
    // El conteo de actividad son dos consultas ANTES de poder siquiera
    // preguntar, así que la fila se marca ocupada desde el primer clic: sin
    // eso el botón parece no responder y el usuario lo aprieta de nuevo.
    setOcupada(task.id)
    try {
      const n = await taskActivityCount(task.id)
      if (n > 0 && !window.confirm(t('projects.confirm_delete_task', { n }))) return
      await unaVez(`borrar:${task.id}`, async () => {
        const { error } = await deleteTask(task.id)
        if (error) setErr(error.message)
        else onChanged?.()
      })
    } finally {
      setOcupada(null)
    }
  }

  async function patch(task, field, value) {
    await escribir(
      `patch:${task.id}:${field}`,
      () => updateTask(task.id, { [field]: value || null }),
      () => {
        marcarGuardado(task.id)
        onChanged?.()
      }
    )
  }

  /**
   * Reasignar va por la RPC, no por un UPDATE crudo.
   *
   * Esta planilla escribía `owner_email` directo, y con eso se salteaba la
   * validación de destino de la mig 207: si el desplegable quedó viejo —o la
   * persona se dio de baja mientras la pantalla estaba abierta— la tarea
   * terminaba asignada a alguien que RLS no deja verla. Figura asignada, y es
   * un agujero negro (§15.2).
   *
   * El comentario de sistema lo escribe el trigger de la mig 215, así que sale
   * por los dos caminos; la RPC aporta la validación, que el trigger no puede
   * hacer.
   */
  async function changeOwner(task, email) {
    if ((task.owner_email || '') === (email || '')) return
    await escribir(
      `owner:${task.id}`,
      () => reassignTask(task.id, email || null),
      () => {
        marcarGuardado(task.id)
        onChanged?.()
      }
    )
  }

  /**
   * La fecha se guarda al SALIR del campo, no en cada tecla.
   *
   * Un `<input type="date">` dispara onChange mientras se completan los
   * segmentos, así que escribir una fecha a mano generaba varios UPDATE — y
   * desde la mig 215 cada uno deja su comentario de sistema. La bitácora del
   * hub se habría llenado de "movió el vencimiento" intermedios.
   */
  async function patchDate(task, campo, value) {
    if ((task[campo] || '') === (value || '')) return
    const inicio = campo === 'start_date' ? value : task.start_date
    const fin = campo === 'due_date' ? value : task.due_date
    const check = validateTaskDates(inicio || null, fin || null, today)
    if (!check.valid) {
      // Rechazar en el cliente evita que el CHECK de la tabla devuelva un
      // error crudo de Postgres en la cara del usuario.
      setErr(t('projects.err_dates'))
      return
    }
    setErr(null)
    await patch(task, campo, value)
  }

  return (
    <div className="ptable">
      {/* Los avisos se pueden cerrar. El único botón cercano era la ✕ de la
          primera fila, que borra una tarea — cerrar un cartel no puede
          compartir gesto con destruir un dato. */}
      {err && (
        <div className="pview__err pview__err--closable">
          <span>{err}</span>
          <button type="button" onClick={() => setErr(null)} aria-label={t('app.close')}>
            ✕
          </button>
        </div>
      )}
      {warn && (
        <div className="pview__warn pview__warn--closable">
          <span>{warn}</span>
          <button type="button" onClick={() => setWarn(null)} aria-label={t('app.close')}>
            ✕
          </button>
        </div>
      )}

      {/* "¿Dónde está Guardar?" fue la primera pregunta de la primera persona
          que usó esto. La respuesta tiene que estar a la vista antes de que la
          haga, no escondida en un destello de 2 segundos. */}
      <div className={`ptable__save ptable__save--${estado}`} role="status">
        {estado === 'saving'
          ? t('projects.autosave_saving')
          : estado === 'saved'
            ? `✓ ${t('projects.autosave_saved')}`
            : t('projects.autosave_idle')}
      </div>

      <div className="ptable__head">
        <span>{t('projects.col_title')}</span>
        <span>{t('projects.col_owner')}</span>
        <span>{t('projects.col_start')}</span>
        <span>{t('projects.col_due')}</span>
        <span>{t('projects.col_city')}</span>
        <span />
      </div>

      {tasks.map((task) => (
        <div
          key={task.id}
          className={`ptable__row${ok === task.id ? ' is-ok' : ''}${
            ocupada === task.id ? ' is-busy' : ''
          }`}
        >
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
            onChange={(e) => changeOwner(task, e.target.value)}
            aria-label={t('projects.col_owner')}
          >
            <option value="">{t('projects.unassigned')}</option>
            {owners.map((o) => (
              <option key={o.email} value={o.email}>
                {o.email}
              </option>
            ))}
          </select>
          {/* No controlado + onBlur: ver patchDate(). El `key` fuerza el
              remonte cuando el valor cambia del lado del servidor, que es lo
              que un defaultValue solo no hace. */}
          <input
            key={`ini-${task.id}-${task.start_date || ''}`}
            type="date"
            defaultValue={task.start_date || ''}
            onBlur={(e) => patchDate(task, 'start_date', e.target.value)}
            aria-label={t('projects.col_start')}
          />
          <input
            key={`due-${task.id}-${task.due_date || ''}`}
            type="date"
            defaultValue={task.due_date || ''}
            onBlur={(e) => patchDate(task, 'due_date', e.target.value)}
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
          <button
            type="button"
            className="ptable__del"
            onClick={() => onDelete(task)}
            disabled={ocupada === task.id}
            title={t('projects.delete_task')}
            aria-label={t('projects.delete_task')}
          >
            {ocupada === task.id ? '…' : '✕'}
          </button>
        </div>
      ))}

      {/* Alta: una TARJETA aparte, no una fila más de la planilla.
          Antes era una fila idéntica a las de arriba salvo por el fondo y por
          el "+" en el lugar de la ✕, y eso hacía imposible contestar dos
          preguntas básicas: qué está guardado y qué no, y qué hace ese botón.
          Con título propio, borde punteado y las acciones ESCRITAS abajo, la
          diferencia se lee sin tener que probarla. */}
      <form className="ptable__new" onSubmit={addTask}>
        <div className="ptable__new-head">
          <strong>{t('projects.new_task_label')}</strong>
          <span>{t('projects.new_task_hint')}</span>
        </div>

        <div className="ptable__row">
          {/* autoFocus: §3.1 promete que al abrir un proyecto el cursor ya está
              en la primera fila de tarea. Sin esto, después de crear un proyecto
              el foco quedaba en el body y había que ir a buscar el campo con el
              mouse — justo el clic que el alta inline vino a eliminar.
              El `focus()` de addTask cubre la segunda tarea en adelante; esto
              cubre la primera. */}
          <input
            ref={titleRef}
            autoFocus
            value={draft.title}
            onChange={(e) => editar({ title: e.target.value })}
            // Enter explícito, no el submit implícito del navegador.
            //
            // El placeholder PROMETE "presioná Enter", y esa promesa se estaba
            // cumpliendo sola gracias a una regla del navegador (un form con un
            // botón submit envía al apretar Enter en un campo de texto). Es una
            // regla con letra chica —depende de que el evento traiga `code` y
            // `keyCode`, cosa que no siempre pasa— y una promesa escrita en la
            // pantalla no debería depender de eso. El candado por título evita
            // el alta doble si además dispara el submit implícito.
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addTask()
              }
            }}
            placeholder={t('projects.new_task_placeholder')}
            aria-label={t('projects.col_title')}
          />
          <select
            value={draft.owner_email}
            onChange={(e) => editar({ owner_email: e.target.value })}
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
            value={draft.start_date}
            onChange={(e) => editar({ start_date: e.target.value })}
            aria-label={t('projects.col_start')}
          />
          <input
            type="date"
            value={draft.due_date}
            onChange={(e) => editar({ due_date: e.target.value })}
            aria-label={t('projects.col_due')}
          />
          <select
            value={draft.city}
            onChange={(e) => editar({ city: e.target.value })}
            aria-label={t('projects.col_city')}
          >
            <option value="">{t('projects.all_cities')}</option>
            {cities.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          {/* Celda vacía: mantiene las 6 columnas alineadas con las filas ya
              guardadas. Las acciones van abajo, no acá. */}
          <span aria-hidden="true" />
        </div>

        <div className="ptable__new-actions">
          {/* Descartar solo cuando hay algo que descartar: un botón que no
              hace nada visible es ruido. */}
          {draftSucio && (
            <button type="button" className="ptable__discard" onClick={descartarDraft}>
              {t('projects.discard')}
            </button>
          )}
          <button
            type="submit"
            className={`ptable__add${draft.title.trim() ? ' is-ready' : ''}`}
            title={t('projects.add_task')}
          >
            + {t('projects.add')}
          </button>
        </div>
      </form>
    </div>
  )
}
