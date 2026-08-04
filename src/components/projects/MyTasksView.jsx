import { useMemo } from 'react'
import { useI18n } from '../../context/LanguageContext'
import { groupByUrgency } from '../../lib/projectTasks'
import TaskRow from './TaskRow'
import EmptyState from '../ui/EmptyState'

// Vista por defecto del hub. Es donde va a vivir, así que manda la velocidad
// de lectura: agrupada por urgencia y con los dos primeros grupos abiertos.
//
// Una lista plana de 25 tareas es un muro (§15.8). Agrupada, el hub ve 4-6
// filas al entrar, que es lo que le importa.
//
// Ningún grupo se esconde por omisión: "Sin fecha" tiene su propia sección
// aunque esté vacía, porque una tarea sin vencimiento nunca entra en "vence
// hoy" ni en "en riesgo" y desaparecería del radar en silencio (§13.3).

const GROUPS = [
  { key: 'overdue', labelKey: 'projects.group.overdue', tone: 'danger' },
  { key: 'today', labelKey: 'projects.group.today', tone: 'warn' },
  { key: 'week', labelKey: 'projects.group.week' },
  { key: 'later', labelKey: 'projects.group.later' },
  { key: 'none', labelKey: 'projects.group.no_date' },
  { key: 'doneToday', labelKey: 'projects.group.done_today', tone: 'ok' },
]

export default function MyTasksView({ data, userEmail, riskThreshold, onChanged }) {
  const { t } = useI18n()
  const { tasks, projectNameById, lastCommentByTask, today, lastSeen, timezone } = data

  const mine = useMemo(() => tasks.filter((x) => x.owner_email === userEmail), [tasks, userEmail])
  const groups = useMemo(
    () => groupByUrgency(mine, today, projectNameById, timezone),
    [mine, today, projectNameById, timezone]
  )

  // "Tareas nuevas desde tu última visita" (§15.4): hasta que exista Telegram,
  // es lo único que evita que algo asignado quede sin ver durante días.
  const nuevas = useMemo(() => {
    if (!lastSeen) return 0
    return mine.filter((x) => x.created_at > lastSeen && x.status !== 'done').length
  }, [mine, lastSeen])

  if (mine.length === 0) {
    return (
      <EmptyState
        icon="✓"
        title={t('projects.empty_mine_title')}
        message={t('projects.empty_mine_msg')}
      />
    )
  }

  return (
    <div className="pview">
      <div className="pview__summary">
        <strong>
          {t('projects.summary_counts', {
            today: groups.today.length,
            overdue: groups.overdue.length,
            blocked: mine.filter((x) => x.status === 'blocked').length,
          })}
        </strong>
        {nuevas > 0 && <span className="pview__new">{t('projects.new_tasks', { n: nuevas })}</span>}
      </div>

      {GROUPS.map(({ key, labelKey, tone }) => {
        const list = groups[key] || []
        // Las secciones vacías se colapsan a nada salvo "Sin fecha", que se
        // muestra siempre para que no haya tareas invisibles.
        if (list.length === 0 && key !== 'none') return null
        return (
          <section key={key} className={`pgroup${tone ? ` pgroup--${tone}` : ''}`}>
            <h3 className="pgroup__title">
              {t(labelKey)} <span className="pgroup__count">{list.length}</span>
            </h3>
            {list.length === 0 ? (
              <p className="pgroup__empty">{t('projects.group_empty')}</p>
            ) : (
              list.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  projectName={projectNameById[task.project_id]}
                  lastComment={lastCommentByTask[task.id]}
                  today={today}
                  canEdit
                  riskThreshold={riskThreshold}
                  onChanged={onChanged}
                />
              ))
            )}
          </section>
        )
      })}
    </div>
  )
}
