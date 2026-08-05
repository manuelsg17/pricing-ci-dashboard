import { useMemo } from 'react'
import { useI18n } from '../../context/LanguageContext'

// Panel "Tareas en riesgo" (PROYECTOS_DESIGN.md §7 y §13.7).
//
// Mismo criterio que PriceComplianceAlerts: NO es un panel de estado, es una
// alerta. Si no hay nada que mirar, no ocupa lugar. Pero un FALLO siempre se
// avisa — tratar un error de red como "todo tranquilo" es el bug real que ya
// se corrigió en el panel de precios.
//
// Las secciones están en orden de urgencia de acción, no de gravedad
// abstracta: primero lo que está detenido esperando a alguien, después lo que
// ya se pasó de fecha, y al final lo que va camino a pasarse.

const SECCIONES = [
  {
    key: 'blocked',
    labelKey: 'monitoring.tasks_blocked',
    tono: 'danger',
    diasKey: 'monitoring.tasks_blocked_for',
  },
  {
    key: 'overdue',
    labelKey: 'monitoring.tasks_overdue',
    tono: 'danger',
    diasKey: 'monitoring.tasks_overdue_for',
  },
  {
    key: 'at_risk',
    labelKey: 'monitoring.tasks_at_risk',
    tono: 'warn',
    diasKey: 'monitoring.tasks_due_in',
  },
  {
    key: 'silent',
    labelKey: 'monitoring.tasks_silent',
    tono: 'warn',
    diasKey: 'monitoring.tasks_silent_for',
  },
]

export default function ProjectTasksPanel({ alerts, loading, failed }) {
  const { t } = useI18n()

  const { porTipo, huerfanas } = useMemo(() => {
    const porTipo = { blocked: [], overdue: [], at_risk: [], silent: [] }
    const huerfanas = []
    for (const a of alerts) {
      if (a.kind && porTipo[a.kind]) porTipo[a.kind].push(a)
      // Una tarea puede estar bien y tener el dueño de baja: por eso es una
      // lista aparte y no un quinto `kind` (§13.7).
      if (a.owner_inactive) huerfanas.push(a)
    }
    return { porTipo, huerfanas }
  }, [alerts])

  const total = alerts.length

  if (loading) return null
  if (!failed && total === 0) return null

  return (
    <div className="mon-panel" style={{ borderColor: 'var(--sem-red-fg)' }}>
      <div className="mon-panel__head">
        <h2>{t('monitoring.tasks_title')}</h2>
      </div>
      <div className="mon-panel__subtitle">{t('monitoring.tasks_subtitle')}</div>

      {failed ? (
        <div className="de-msg de-msg--err">{t('monitoring.tasks_failed')}</div>
      ) : (
        <>
          {SECCIONES.map(({ key, labelKey, tono, diasKey }) => {
            const lista = porTipo[key]
            if (!lista.length) return null
            return (
              <div key={key} className={`mon-tasks mon-tasks--${tono}`}>
                <h3>
                  {t(labelKey)} <span>{lista.length}</span>
                </h3>
                <ul>
                  {lista.map((a) => (
                    <li key={a.task_id}>
                      <strong>{a.title}</strong>
                      <span className="mon-tasks__meta">
                        {a.project_name}
                        {a.city ? ` · ${a.city}` : ''} · {a.owner_email || t('projects.unassigned')}{' '}
                        · {t(diasKey, { n: a.dias })}
                      </span>
                      {/* El motivo es lo único que hace accionable una tarea
                          trabada: sin él, "está trabada" no le sirve a nadie. */}
                      {key === 'blocked' && a.motivo && (
                        <span className="mon-tasks__reason">“{a.motivo}”</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}

          {huerfanas.length > 0 && (
            <div className="mon-tasks mon-tasks--warn">
              <h3>
                {t('monitoring.tasks_orphan')} <span>{huerfanas.length}</span>
              </h3>
              {/* No se bloquea la desactivación de un usuario —acoplaría dos
                  sistemas— pero sus tareas se ven en vez de pudrirse (§13.7). */}
              <ul>
                {huerfanas.map((a) => (
                  <li key={`h-${a.task_id}`}>
                    <strong>{a.title}</strong>
                    <span className="mon-tasks__meta">
                      {a.project_name} · {a.owner_email}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}
