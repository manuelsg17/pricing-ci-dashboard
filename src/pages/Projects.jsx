import { useState, useEffect, useMemo } from 'react'
import { useCountry } from '../context/CountryContext'
import { useI18n } from '../context/LanguageContext'
import { useAccessControl } from '../hooks/useAccessControl'
import { useAuth } from '../lib/auth'
import { useProjectsData } from '../hooks/useProjects'
import TodayView from '../components/projects/TodayView'
import MyTasksView from '../components/projects/MyTasksView'
import ProjectsAdmin from '../components/projects/ProjectsAdmin'
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

  // `isAdmin` llega ASÍNCRONO (useAccessControl consulta user_profiles), así
  // que en el primer render siempre es false. Con un initializer de useState
  // el admin quedaba clavado en "Mis tareas" y nunca veía "Hoy" al entrar —
  // detectado corriendo la app de verdad, no en las simulaciones.
  // El efecto corrige la vista cuando el rol resuelve, pero solo si el usuario
  // todavía no eligió pestaña a mano: si no, le estaríamos moviendo la
  // pantalla debajo de los pies.
  const [view, setView] = useState('mine')
  const [viewTouched, setViewTouched] = useState(false)

  useEffect(() => {
    if (!viewTouched && isAdmin) setView('today')
  }, [isAdmin, viewTouched])

  function changeView(next) {
    setViewTouched(true)
    setView(next)
  }
  const [windowPreset, setWindowPreset] = useState('auto')
  const [ownerFilter, setOwnerFilter] = useState('')

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

  const owners = useMemo(() => {
    const set = new Set(data.tasks.map((x) => x.owner_email).filter(Boolean))
    return [...set].sort()
  }, [data.tasks])

  const TABS = isAdmin
    ? [
        { key: 'today', label: t('projects.tab_today') },
        { key: 'mine', label: t('projects.tab_mine') },
        { key: 'admin', label: t('projects.tab_projects') },
      ]
    : [
        { key: 'mine', label: t('projects.tab_mine') },
        { key: 'today', label: t('projects.tab_team') },
      ]

  return (
    <div className="projects">
      <div className="projects__bar">
        <div className="projects__tabs">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={view === tab.key ? 'is-active' : ''}
              onClick={() => changeView(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="projects__filters">
          {view === 'today' && (
            <>
              <label>
                {t('projects.window')}
                <select value={windowPreset} onChange={(e) => setWindowPreset(e.target.value)}>
                  <option value="auto">{t('projects.window_auto')}</option>
                  <option value="24h">24h</option>
                  <option value="3d">3d</option>
                  <option value="7d">7d</option>
                </select>
              </label>
              <label>
                {t('projects.owner')}
                <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}>
                  <option value="">{t('access.all_m')}</option>
                  {owners.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {/* Actualización MANUAL a propósito: durante la reunión, una fila que
              se reordena o desaparece mientras estás hablando de ella
              desorienta a todos (§13.2). */}
          <button type="button" className="projects__refresh" onClick={() => data.reload()}>
            ↻ {t('projects.refresh')}
          </button>
        </div>
      </div>

      {data.error && <div className="pview__err">{data.error}</div>}
      {data.loading && data.tasks.length === 0 && <SkeletonDashboard />}

      {!data.loading && view === 'today' && (
        <TodayView
          data={data}
          riskThreshold={RISK_THRESHOLD_DAYS}
          ownerFilter={ownerFilter}
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
          data={data}
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
