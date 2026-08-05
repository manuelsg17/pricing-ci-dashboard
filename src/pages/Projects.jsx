import { useState, useEffect, useMemo } from 'react'
import { useCountry } from '../context/CountryContext'
import { useI18n } from '../context/LanguageContext'
import { useAccessControl } from '../hooks/useAccessControl'
import { useAuth } from '../lib/auth'
import { useProjectsData } from '../hooks/useProjects'
import { useProjectFilters } from '../hooks/useProjectFilters'
import { applyTaskFilters } from '../lib/projectTasks'
import TodayView from '../components/projects/TodayView'
import MyTasksView from '../components/projects/MyTasksView'
import ProjectsAdmin from '../components/projects/ProjectsAdmin'
import FiltersBar from '../components/projects/FiltersBar'
import { SkeletonDashboard } from '../components/ui/Skeleton'
import '../styles/projects.css'

// Gestión de Datos → Proyectos.
//
// La pantalla por defecto depende de quién entra, y eso NO es un detalle: el
// admin y el hub vienen a preguntarle cosas distintas al sistema (§1).
//   · admin → "Hoy": qué se movió, qué vence, quién está trabado.
//   · hub   → "Mis tareas": qué tengo que hacer.

const RISK_THRESHOLD_DAYS = 2

export default function Projects() {
  const { country, countryConfig } = useCountry()
  const { t } = useI18n()
  const { isAdmin } = useAccessControl()
  const { session } = useAuth()
  const userEmail = session?.user?.email || ''

  const [windowPreset, setWindowPreset] = useState('auto')

  const {
    filters,
    setFilter,
    clearFilters,
    activos,
    view: storedView,
    setView,
  } = useProjectFilters(country)

  const data = useProjectsData({
    country,
    timezone: countryConfig?.timezone,
    windowPreset,
  })

  // Marcar la sección como vista al entrar — alimenta "tareas nuevas". Se hace
  // al desmontar, no al montar: si se marcara al entrar, el propio ingreso
  // borraría el indicador antes de que el hub llegue a verlo.
  useEffect(() => {
    return () => {
      data.markSeen(userEmail)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userEmail])

  const cities = useMemo(() => countryConfig?.dbCities || [], [countryConfig])

  const TABS = useMemo(
    () =>
      isAdmin
        ? [
            { key: 'today', label: t('projects.tab_today') },
            { key: 'mine', label: t('projects.tab_mine') },
            { key: 'admin', label: t('projects.tab_projects') },
          ]
        : [
            { key: 'mine', label: t('projects.tab_mine') },
            { key: 'today', label: t('projects.tab_team') },
          ],
    [isAdmin, t]
  )

  // La pestaña efectiva se calcula en el render en vez de guardarse en estado.
  //
  // `isAdmin` llega ASÍNCRONO (useAccessControl consulta user_profiles): en el
  // primer render siempre es false. La versión anterior arrancaba en "Mis
  // tareas" y corregía con un efecto, lo que obligaba a un flag de "el usuario
  // ya tocó la pestaña" para no moverle la pantalla debajo de los pies.
  //
  // Derivándola no hace falta ninguna de las dos cosas: si el usuario eligió,
  // manda su elección (que además sobrevive un F5, viene de localStorage); si
  // no eligió nunca, el default se acomoda solo cuando el rol resuelve. Y una
  // pestaña guardada que este usuario ya no puede abrir cae al default en vez
  // de dejar la pantalla en blanco.
  const view = TABS.some((x) => x.key === storedView) ? storedView : isAdmin ? 'today' : 'mine'

  // La planilla del admin NO se filtra: el `sort_order` de una tarea nueva
  // sale de la cantidad de tareas del proyecto, y sobre una lista filtrada
  // asignaría órdenes repetidos.
  const tasksFiltradas = useMemo(
    () => applyTaskFilters(data.tasks, filters, data.projectById),
    [data.tasks, filters, data.projectById]
  )

  const dataFiltrada = useMemo(() => ({ ...data, tasks: tasksFiltradas }), [data, tasksFiltradas])

  return (
    <div className="projects">
      <div className="projects__bar">
        <div className="projects__tabs">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={view === tab.key ? 'is-active' : ''}
              onClick={() => setView(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="projects__filters">
          {view === 'today' && (
            <label>
              {t('projects.window')}
              <select value={windowPreset} onChange={(e) => setWindowPreset(e.target.value)}>
                <option value="auto">{t('projects.window_auto')}</option>
                <option value="24h">24h</option>
                <option value="3d">3d</option>
                <option value="7d">7d</option>
              </select>
            </label>
          )}
          {/* Actualización MANUAL a propósito: durante la reunión, una fila que
              se reordena o desaparece mientras estás hablando de ella
              desorienta a todos (§13.2). */}
          <button type="button" className="projects__refresh" onClick={() => data.reload()}>
            ↻ {t('projects.refresh')}
          </button>
        </div>
      </div>

      {/* La planilla del admin queda afuera: filtrarla rompería el sort_order
          de las tareas nuevas. */}
      {view !== 'admin' && (
        <FiltersBar
          filters={filters}
          setFilter={setFilter}
          clearFilters={clearFilters}
          activos={activos}
          projects={data.projects}
          tasks={data.tasks}
          cities={cities}
          // En "Mis tareas" el responsable sos vos por definición: ofrecer el
          // filtro sería ofrecer una forma de vaciar la propia lista.
          showOwner={view !== 'mine'}
          shown={tasksFiltradas.length}
          total={data.tasks.length}
        />
      )}

      {data.error && <div className="pview__err">{data.error}</div>}
      {data.loading && data.tasks.length === 0 && <SkeletonDashboard />}

      {!data.loading && view === 'today' && (
        <TodayView
          data={dataFiltrada}
          riskThreshold={RISK_THRESHOLD_DAYS}
          // En la pestaña "Equipo" un hub VE las tareas de sus compañeros
          // —esa es la feature— pero no puede tocarlas: las RPCs exigen ser
          // dueño o admin. Sin esto veía 4 botones de estado que siempre
          // rebotaban con un error, que es peor que no verlos.
          canEdit={isAdmin}
          onChanged={() => data.reload({ silent: true })}
        />
      )}

      {!data.loading && view === 'mine' && (
        <MyTasksView
          data={dataFiltrada}
          userEmail={userEmail}
          riskThreshold={RISK_THRESHOLD_DAYS}
          onChanged={() => data.reload({ silent: true })}
        />
      )}

      {!data.loading && view === 'admin' && isAdmin && (
        <ProjectsAdmin
          data={data}
          country={country}
          countryLabel={countryConfig?.label}
          userEmail={userEmail}
          cities={cities}
          onChanged={() => data.reload({ silent: true })}
        />
      )}
    </div>
  )
}
