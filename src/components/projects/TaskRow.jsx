import { useState } from 'react'
import { useI18n } from '../../context/LanguageContext'
import {
  TASK_STATUSES,
  isAtRisk,
  isStalled,
  blockedDays,
  BLOCKED_ESCALATE_DAYS,
  nombreCorto,
  fechaCorta,
} from '../../lib/projectTasks'
import { setTaskStatus, addTaskComment } from '../../hooks/useProjects'
import { useAccionEnVuelo } from '../../hooks/useAccionEnVuelo'

// Fila de tarea — la usan "Mis tareas" y "Hoy".
//
// Todo el diseño de esta fila sale de una sola conclusión de las simulaciones:
// si actualizar cuesta más de 10 segundos, el hub no lo hace y el tablero
// miente. Por eso:
//   · El estado es un control segmentado: UN clic, sin modal y sin "guardar".
//   · El comentario está SIEMPRE visible en la fila, no dentro de un detalle
//     a dos clics — un hub apurado no entra ahí (§3.2).
//   · "Trabada" exige el motivo en ese mismo campo, y es el único caso donde
//     se fuerza texto: una tarea trabada sin motivo no le sirve a nadie.

const STATUS_KEYS = {
  todo: 'projects.status.todo',
  doing: 'projects.status.doing',
  blocked: 'projects.status.blocked',
  done: 'projects.status.done',
}

export default function TaskRow({
  task,
  projectName,
  lastComment,
  today,
  canEdit,
  riskThreshold = 2,
  showOwner = false,
  locale = 'es',
  onChanged,
}) {
  const { t } = useI18n()
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [askReason, setAskReason] = useState(false)
  // `busy` sirve para deshabilitar los botones visualmente, pero como es
  // estado llega un render tarde: dos clics impacientes lo ven en false los
  // dos. El candado real es este (ver useAccionEnVuelo).
  const unaVez = useAccionEnVuelo()

  const atRisk = isAtRisk(task, today, riskThreshold)
  const stalled = isStalled(task, today)
  const blocked = blockedDays(task, today)
  const overdue = task.due_date && task.due_date < today && task.status !== 'done'

  async function changeStatus(next) {
    if (!canEdit || next === task.status) return
    // Trabar sin motivo se ataja acá para no ir al servidor a que rebote.
    if (next === 'blocked' && !comment.trim()) {
      setAskReason(true)
      setErr(t('projects.err_blocked_needs_reason'))
      return
    }
    await unaVez(`estado:${task.id}`, async () => {
      setBusy(true)
      setErr(null)
      const { error } = await setTaskStatus(task.id, next, comment.trim() || null)
      setBusy(false)
      if (error) {
        setErr(error.message)
        return
      }
      setComment('')
      setAskReason(false)
      onChanged?.()
    })
  }

  async function submitComment(e) {
    e.preventDefault()
    const body = comment.trim()
    if (!canEdit || !body) return
    await unaVez(`comentario:${task.id}`, async () => {
      setBusy(true)
      setErr(null)
      const { error } = await addTaskComment(task.id, body)
      setBusy(false)
      if (error) {
        setErr(error.message)
        return
      }
      setComment('')
      onChanged?.()
    })
  }

  return (
    <div
      className={`ptask${overdue ? ' ptask--overdue' : ''}${task.status === 'done' ? ' ptask--done' : ''}`}
    >
      <div className="ptask__main">
        <div className="ptask__head">
          <span className="ptask__title">{task.title}</span>
          {projectName && <span className="ptask__project">{projectName}</span>}
          {task.city && <span className="ptask__city">{task.city}</span>}
        </div>

        <div className="ptask__meta">
          {task.due_date && (
            <span className={`ptask__due${overdue ? ' is-overdue' : atRisk ? ' is-risk' : ''}`}>
              {overdue
                ? t('projects.badge_overdue')
                : atRisk
                  ? t('projects.badge_at_risk')
                  : t('projects.due_on')}{' '}
              <span title={task.due_date}>{fechaCorta(task.due_date, locale, today)}</span>
            </span>
          )}
          {!task.due_date && <span className="ptask__due">{t('projects.no_due_date')}</span>}
          {showOwner && (
            <span className="ptask__owner" title={task.owner_email || ''}>
              {task.owner_email ? nombreCorto(task.owner_email) : t('projects.unassigned')}
            </span>
          )}
          {/* Trabada hace N días: pasa a rojo intenso a los 3 (§17.4) */}
          {blocked !== null && (
            <span className={`ptask__flag${blocked >= BLOCKED_ESCALATE_DAYS ? ' is-hot' : ''}`}>
              {t('projects.blocked_for', { n: blocked })}
            </span>
          )}
          {/* Estancada: casi siempre significa mal dimensionada, no hub lento */}
          {stalled && <span className="ptask__flag is-warn">{t('projects.badge_stalled')}</span>}
        </div>

        {lastComment && (
          <div className={`ptask__last${lastComment.kind === 'system' ? ' is-system' : ''}`}>
            <span className="ptask__last-author" title={lastComment.author_email || ''}>
              {nombreCorto(lastComment.author_email)}:
            </span>{' '}
            {lastComment.body}
          </div>
        )}

        {canEdit && (
          <form className="ptask__comment" onSubmit={submitComment}>
            <input
              type="text"
              value={comment}
              onChange={(e) => {
                setComment(e.target.value)
                if (e.target.value.trim()) setErr(null)
              }}
              placeholder={
                askReason ? t('projects.reason_placeholder') : t('projects.comment_placeholder')
              }
              disabled={busy}
              aria-label={t('projects.comment_placeholder')}
            />
          </form>
        )}

        {err && <div className="ptask__err">{err}</div>}
      </div>

      <div className="ptask__states" role="group" aria-label={t('projects.status_label')}>
        {TASK_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            className={`ptask__state ptask__state--${s}${task.status === s ? ' is-active' : ''}`}
            onClick={() => changeStatus(s)}
            disabled={!canEdit || busy}
            title={t(STATUS_KEYS[s])}
          >
            {t(STATUS_KEYS[s])}
          </button>
        ))}
      </div>
    </div>
  )
}
