import { useMemo, useState } from 'react'
import { useI18n } from '../../context/LanguageContext'
import {
  TASK_STATUSES,
  UNASSIGNED,
  sortTasks,
  isAtRisk,
  isStalled,
  blockedDays,
  BLOCKED_ESCALATE_DAYS,
} from '../../lib/projectTasks'
import { setTaskStatus } from '../../hooks/useProjects'
import EmptyState from '../ui/EmptyState'

// Kanban — la vista de "qué sigue".
//
// Arrastre con HTML5 nativo, sin librería: es el mismo criterio que ya se usó
// para reordenar secciones del Dashboard (§11), y una librería de drag trae su
// propio sistema de estilos que pelea con Tailwind + shadcn.
//
// DOS COSAS QUE NO SON DECORATIVAS
//
// 1. Solo se puede arrastrar lo que uno puede cambiar. Las RPCs exigen ser
//    dueño o admin, así que una tarjeta ajena arrastrable prometería algo que
//    el servidor va a rechazar. Es el mismo error que ya se corrigió en la
//    pestaña "Equipo", donde el hub veía 4 botones de estado que siempre
//    rebotaban.
//
// 2. Soltar en "Trabada" NO mueve la tarjeta: primero pide el motivo. La mig
//    184 rechaza `set_task_status('blocked')` sin comentario, y con razón —
//    una tarea trabada sin motivo no le sirve a nadie (§3.2). Si moviéramos
//    primero y preguntáramos después, la pantalla mostraría un estado que la
//    base no tiene.

const STATUS_KEYS = {
  todo: 'projects.status.todo',
  doing: 'projects.status.doing',
  blocked: 'projects.status.blocked',
  done: 'projects.status.done',
}

const SIN_GRUPO = '__todo__'

export default function KanbanView({ data, userEmail, isAdmin, riskThreshold, onChanged }) {
  const { t } = useI18n()
  const { tasks, projects, projectNameById, today } = data

  const [groupBy, setGroupBy] = useState('none')
  const [arrastrada, setArrastrada] = useState(null)
  const [encima, setEncima] = useState(null) // `${grupo}:${estado}`
  const [pidiendoMotivo, setPidiendoMotivo] = useState(null)
  const [motivo, setMotivo] = useState('')
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

  const puedeMover = (task) => isAdmin || (!!userEmail && task.owner_email === userEmail)

  // Carriles: uno solo si no se agrupa, o uno por proyecto / por persona.
  const carriles = useMemo(() => {
    if (groupBy === 'none') return [{ key: SIN_GRUPO, label: null, tasks }]

    const map = new Map()
    for (const task of tasks) {
      const key = groupBy === 'project' ? task.project_id : task.owner_email || UNASSIGNED
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(task)
    }
    return [...map.entries()]
      .map(([key, list]) => ({
        key,
        label:
          groupBy === 'project'
            ? projectNameById[key] || key
            : key === UNASSIGNED
              ? t('projects.unassigned')
              : key,
        tasks: list,
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [tasks, groupBy, projectNameById, t])

  async function mover(task, estado, comentario) {
    setBusy(true)
    setErr(null)
    const { error } = await setTaskStatus(task.id, estado, comentario || null)
    setBusy(false)
    if (error) {
      setErr(error.message)
      return false
    }
    onChanged?.()
    return true
  }

  /**
   * Qué se soltó.
   *
   * La fuente de verdad es `dataTransfer`, no el estado del componente: el
   * estado de React se actualiza de forma asíncrona, así que si el navegador
   * emite `dragstart` y `drop` dentro del mismo tick —lo que pasa con eventos
   * sintéticos, y podría pasar con un gesto muy rápido— `arrastrada` todavía
   * sería null y el drop se perdería en silencio. El estado queda solo para el
   * resaltado visual.
   */
  function loQueSeSoltó(e) {
    const id = e.dataTransfer?.getData('text/plain')
    if (id) {
      const encontrada = tasks.find((x) => x.id === id)
      if (encontrada) return encontrada
    }
    return arrastrada
  }

  function onDrop(e, estado) {
    const task = loQueSeSoltó(e)
    setArrastrada(null)
    setEncima(null)
    if (!task || task.status === estado || !puedeMover(task)) return
    if (estado === 'blocked') {
      // Se pide el motivo ANTES de mover: ver la cabecera del archivo.
      setPidiendoMotivo(task)
      setMotivo('')
      return
    }
    mover(task, estado)
  }

  async function confirmarTrabada(e) {
    e.preventDefault()
    const texto = motivo.trim()
    if (!texto) return
    const ok = await mover(pidiendoMotivo, 'blocked', texto)
    if (ok) setPidiendoMotivo(null)
  }

  if (tasks.length === 0) {
    return (
      <EmptyState
        icon="📋"
        title={t('projects.empty_today_title')}
        message={t('projects.empty_today_msg')}
      />
    )
  }

  return (
    <div className="pkanban">
      <div className="pkanban__bar">
        <label>
          {t('projects.kanban_group_by')}
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
            <option value="none">{t('projects.kanban_group_none')}</option>
            <option value="project">{t('projects.filter_project')}</option>
            <option value="owner">{t('projects.owner')}</option>
          </select>
        </label>
        {projects.length === 0 && (
          <span className="pkanban__hint">{t('projects.no_projects')}</span>
        )}
      </div>

      {err && <div className="pview__err">{err}</div>}

      {pidiendoMotivo && (
        <form className="pkanban__reason" onSubmit={confirmarTrabada}>
          <span>{t('projects.kanban_reason_for', { title: pidiendoMotivo.title })}</span>
          <input
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder={t('projects.reason_placeholder')}
            aria-label={t('projects.reason_placeholder')}
            autoFocus
            disabled={busy}
          />
          <button type="submit" disabled={busy || !motivo.trim()}>
            {t('projects.status.blocked')}
          </button>
          <button type="button" onClick={() => setPidiendoMotivo(null)} disabled={busy}>
            {t('app.cancel')}
          </button>
        </form>
      )}

      {carriles.map((carril) => (
        <section key={carril.key} className="pkanban__lane">
          {carril.label && <h3 className="pkanban__lane-title">{carril.label}</h3>}
          <div className="pkanban__cols">
            {TASK_STATUSES.map((estado) => {
              const lista = sortTasks(
                carril.tasks.filter((x) => x.status === estado),
                projectNameById
              )
              const zona = `${carril.key}:${estado}`
              return (
                <div
                  key={estado}
                  className={`pcol pcol--${estado}${encima === zona ? ' is-over' : ''}`}
                  onDragOver={(e) => {
                    // Sin preventDefault el navegador no considera la zona
                    // válida y el drop nunca llega.
                    e.preventDefault()
                    setEncima(zona)
                  }}
                  onDragLeave={() => setEncima((z) => (z === zona ? null : z))}
                  onDrop={(e) => onDrop(e, estado)}
                >
                  <h4 className="pcol__title">
                    {t(STATUS_KEYS[estado])} <span className="pcol__count">{lista.length}</span>
                  </h4>
                  {lista.map((task) => (
                    <Card
                      key={task.id}
                      task={task}
                      today={today}
                      riskThreshold={riskThreshold}
                      projectName={groupBy === 'project' ? null : projectNameById[task.project_id]}
                      showOwner={groupBy !== 'owner'}
                      movible={puedeMover(task)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', task.id)
                        e.dataTransfer.effectAllowed = 'move'
                        setArrastrada(task)
                      }}
                      onDragEnd={() => {
                        setArrastrada(null)
                        setEncima(null)
                      }}
                    />
                  ))}
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

function Card({
  task,
  today,
  riskThreshold,
  projectName,
  showOwner,
  movible,
  onDragStart,
  onDragEnd,
}) {
  const { t } = useI18n()
  const vencida = task.due_date && task.due_date < today && task.status !== 'done'
  const enRiesgo = isAtRisk(task, today, riskThreshold)
  const trabadaHace = blockedDays(task, today)
  const estancada = isStalled(task, today)

  return (
    <article
      className={`pcard${vencida ? ' is-overdue' : ''}${movible ? '' : ' is-locked'}`}
      draggable={movible}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      title={movible ? undefined : t('projects.kanban_locked')}
    >
      <div className="pcard__title">{task.title}</div>
      <div className="pcard__meta">
        {projectName && <span className="pcard__chip">{projectName}</span>}
        {task.city && <span className="pcard__chip">{task.city}</span>}
        {showOwner && (
          <span className="pcard__owner">
            {task.owner_email ? task.owner_email.split('@')[0] : t('projects.unassigned')}
          </span>
        )}
      </div>
      <div className="pcard__foot">
        {task.due_date ? (
          <span className={`pcard__due${vencida ? ' is-overdue' : enRiesgo ? ' is-risk' : ''}`}>
            {task.due_date}
          </span>
        ) : (
          <span className="pcard__due">{t('projects.no_due_date')}</span>
        )}
        {trabadaHace !== null && (
          <span className={`pcard__flag${trabadaHace >= BLOCKED_ESCALATE_DAYS ? ' is-hot' : ''}`}>
            {t('projects.blocked_for', { n: trabadaHace })}
          </span>
        )}
        {estancada && <span className="pcard__flag is-warn">{t('projects.badge_stalled')}</span>}
      </div>
    </article>
  )
}
