import { useMemo } from 'react'
import { useI18n } from '../../context/LanguageContext'
import { isAtRisk, isStalled, taskUrgency, UNASSIGNED } from '../../lib/projectTasks'
import TaskRow from './TaskRow'
import EmptyState from '../ui/EmptyState'

// La pantalla de la reunión diaria — y la decisión de diseño más importante
// del módulo: NO es el Gantt.
//
// Un Gantt responde "¿cómo viene el proyecto contra el calendario?". Una
// reunión de 15 minutos necesita otra cosa: qué se movió, qué vence, quién
// está trabado. Eso es un digest agrupado por persona.
//
// Muestra SOLO lo que requiere conversación. Lo que está tranquilo no aparece:
// con 5 hubs × 10 tareas, mostrar todo alarga la reunión sin aportar (§3.3).

const BUCKETS = [
  { key: 'blocked', labelKey: 'projects.today.blocked', tone: 'danger' },
  { key: 'due', labelKey: 'projects.today.due', tone: 'warn' },
  { key: 'risk', labelKey: 'projects.today.risk', tone: 'warn' },
  { key: 'stalled', labelKey: 'projects.today.stalled' },
  { key: 'activity', labelKey: 'projects.today.activity', tone: 'ok' },
]

export default function TodayView({ data, riskThreshold, onChanged, canEdit = false }) {
  const { t } = useI18n()
  const { tasks, projectNameById, lastCommentByTask, activeTaskIds, today, window: win } = data

  // Agrupado por persona: cada bloque es un hub, y el recorrido de la reunión
  // va uno por uno.
  const porPersona = useMemo(() => {
    const map = new Map()
    // Ya vienen filtradas por la barra común (FiltersBar): filtrar de nuevo
    // acá sería un segundo criterio que podría divergir del de las otras
    // vistas.
    for (const task of tasks) {
      const who = task.owner_email || UNASSIGNED
      if (!map.has(who)) {
        map.set(who, { who, blocked: [], due: [], risk: [], stalled: [], activity: [] })
      }
      const b = map.get(who)
      const urg = taskUrgency(task, today)

      // Un mismo item cae en UN solo balde, en orden de urgencia — si no, la
      // misma tarea aparecería tres veces y la reunión se vuelve repetitiva.
      if (task.status === 'blocked') b.blocked.push(task)
      else if (urg === 'overdue' || urg === 'today') b.due.push(task)
      else if (isAtRisk(task, today, riskThreshold)) b.risk.push(task)
      else if (isStalled(task, today)) b.stalled.push(task)
      // Incluye las que se marcaron "Lista" en la ventana: cerrar algo ES
      // novedad para la reunión, y es lo primero que uno quiere escuchar.
      else if (activeTaskIds.has(task.id)) b.activity.push(task)
    }
    return [...map.values()].sort((a, b) => {
      // Quien tiene trabadas va primero: es lo que necesita tu intervención.
      const pa = a.blocked.length ? 0 : a.due.length ? 1 : 2
      const pb = b.blocked.length ? 0 : b.due.length ? 1 : 2
      return pa - pb || a.who.localeCompare(b.who)
    })
  }, [tasks, today, riskThreshold, activeTaskIds])

  const total = porPersona.reduce(
    (n, p) =>
      n + p.blocked.length + p.due.length + p.risk.length + p.stalled.length + p.activity.length,
    0
  )

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
    <div className="pview">
      {/* El rango SIEMPRE explícito: nunca hay que adivinar qué se está
          mirando. Es lo que evita repetir el "problema del lunes". */}
      <div className="pview__window">
        {t('projects.window_label', { from: win.fromDate, days: win.days })}
      </div>

      {/* Índice por persona: con muchos hubs, permite saltar directo (§17.8) */}
      {porPersona.length > 1 && (
        <div className="pview__index">
          {porPersona.map((p) => {
            const n =
              p.blocked.length + p.due.length + p.risk.length + p.stalled.length + p.activity.length
            return (
              <a
                key={p.who}
                href={`#hub-${encodeURIComponent(p.who)}`}
                className="pview__index-item"
              >
                {p.who === UNASSIGNED ? t('projects.unassigned') : p.who.split('@')[0]}
                <span className="pview__index-n">{n}</span>
              </a>
            )
          })}
        </div>
      )}

      {total === 0 && <p className="pview__quiet">{t('projects.all_quiet')}</p>}

      {porPersona.map((p) => {
        const n =
          p.blocked.length + p.due.length + p.risk.length + p.stalled.length + p.activity.length
        return (
          <section key={p.who} id={`hub-${encodeURIComponent(p.who)}`} className="phub">
            <h3 className="phub__title">
              {p.who === UNASSIGNED ? t('projects.unassigned') : p.who}
              {n === 0 && <span className="phub__quiet">{t('projects.no_news')}</span>}
            </h3>

            {BUCKETS.map(({ key, labelKey, tone }) => {
              const list = p[key]
              if (!list.length) return null
              return (
                <div key={key} className={`pgroup${tone ? ` pgroup--${tone}` : ''}`}>
                  <h4 className="pgroup__title">
                    {t(labelKey)} <span className="pgroup__count">{list.length}</span>
                  </h4>
                  {list.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      projectName={projectNameById[task.project_id]}
                      lastComment={lastCommentByTask[task.id]}
                      today={today}
                      canEdit={canEdit}
                      riskThreshold={riskThreshold}
                      onChanged={onChanged}
                    />
                  ))}
                </div>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}
