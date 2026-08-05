import { useMemo } from 'react'
import { useI18n } from '../../context/LanguageContext'
import { TASK_STATUSES, UNASSIGNED } from '../../lib/projectTasks'

// Barra de filtros común a Hoy, Mis tareas, Kanban y Gantt (§4).
//
// Una sola barra para las cuatro vistas, no una por vista: el filtro que
// aplicaste en el Kanban sigue puesto al pasar al Gantt. Si cada vista tuviera
// el suyo habría que rearmarlo en cada salto, que es la fricción que hace que
// nadie los use.
//
// El contador de "mostrando N de M" no es decorativo: es la regla de CLAUDE.md
// §5 contra el truncado silencioso. Un filtro activo que uno se olvidó de
// sacar hace que la pantalla diga "no hay nada" cuando en realidad hay 40
// tareas escondidas — y eso, en una reunión, se lee como "el equipo no hizo
// nada".

const STATUS_KEYS = {
  todo: 'projects.status.todo',
  doing: 'projects.status.doing',
  blocked: 'projects.status.blocked',
  done: 'projects.status.done',
}

export default function FiltersBar({
  filters,
  setFilter,
  clearFilters,
  activos,
  projects,
  tasks,
  cities,
  showOwner = true,
  shown,
  total,
}) {
  const { t } = useI18n()

  // Los responsables salen de las tareas que existen, no del padrón de
  // usuarios: filtrar por alguien que no tiene ninguna tarea solo puede dar
  // una lista vacía, y ofrecerlo es prometer algo que no hay.
  const owners = useMemo(() => {
    const set = new Set(tasks.map((x) => x.owner_email || UNASSIGNED))
    return [...set].sort()
  }, [tasks])

  return (
    <div className="pfilters">
      <label>
        {t('projects.filter_project')}
        <select value={filters.projectId} onChange={(e) => setFilter('projectId', e.target.value)}>
          <option value="">{t('projects.filter_all')}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      {showOwner && (
        <label>
          {t('projects.owner')}
          <select value={filters.owner} onChange={(e) => setFilter('owner', e.target.value)}>
            <option value="">{t('projects.filter_all')}</option>
            {owners.map((o) => (
              <option key={o} value={o}>
                {o === UNASSIGNED ? t('projects.unassigned') : o}
              </option>
            ))}
          </select>
        </label>
      )}

      <label>
        {t('projects.filter_city')}
        <select value={filters.city} onChange={(e) => setFilter('city', e.target.value)}>
          <option value="">{t('projects.filter_all')}</option>
          {cities.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      <label>
        {t('projects.filter_status')}
        <select value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
          <option value="">{t('projects.filter_all')}</option>
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(STATUS_KEYS[s])}
            </option>
          ))}
        </select>
      </label>

      {activos > 0 && (
        <>
          <span className="pfilters__count">{t('projects.showing', { shown, total })}</span>
          <button type="button" className="pfilters__clear" onClick={clearFilters}>
            {t('projects.filter_clear')}
          </button>
        </>
      )}
    </div>
  )
}
