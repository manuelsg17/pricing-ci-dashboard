import { useMemo, useRef, useState } from 'react'
import { useI18n } from '../../context/LanguageContext'
import {
  ganttWindow,
  taskBar,
  ganttTicks,
  ganttMonths,
  todayColumn,
  arrastrarBarra,
} from '../../lib/gantt'
import { sortTasks, nombreCorto } from '../../lib/projectTasks'
import { updateTask } from '../../hooks/useProjects'
import { useAccionEnVuelo } from '../../hooks/useAccionEnVuelo'
import EmptyState from '../ui/EmptyState'

// Gantt — el panorama contra el calendario (§4.2).
//
// Con CSS grid y aritmética de fechas, sin librería (§11): una librería de
// Gantt trae su propio sistema de estilos que pelearía con Tailwind + shadcn,
// y lo único que aporta de fondo es lo que está en lib/gantt.js con su test.
//
// TRES COSAS QUE NO SE VEN PERO SOSTIENEN LA PANTALLA
//
// · Nada desaparece en silencio. Una tarea sin fechas no se puede dibujar en
//   una línea de tiempo, y una fuera de la ventana tampoco — pero las dos
//   quedan listadas debajo con su conteo. Es la regla de CLAUDE.md §5: un
//   listado nunca corta sin avisar. En un Gantt el riesgo es peor que en una
//   tabla, porque un diagrama con menos barras sigue pareciendo completo.
//
// · Solo el admin arrastra (§4.2). Un hub no puede cambiar fechas ni por RPC
//   ni por política: la barra arrastrable le prometería algo que la base
//   rechaza.
//
// · Cada arrastre deja comentario de sistema, sin que este archivo haga nada:
//   lo escribe el trigger de la mig 215 al ver cambiar las fechas. Por eso
//   `arrastrarBarra` devuelve null cuando el arrastre no cambia nada — un
//   UPDATE vacío dispararía el trigger igual y ensuciaría la bitácora del hub
//   con un "movió el vencimiento" que no movió nada.

/** Ancho de un día, en px, por zoom. Es la ÚNICA fuente: el CSS lo recibe
 *  como variable y el arrastre lo usa para traducir píxeles a días. Dos
 *  valores distintos harían que la barra caiga en un día y se guarde otro. */
const ANCHO_DIA = { week: 46, month: 26, quarter: 12 }

const ZOOMS = [
  { key: 'week', labelKey: 'projects.gantt_week' },
  { key: 'month', labelKey: 'projects.gantt_month' },
  { key: 'quarter', labelKey: 'projects.gantt_quarter' },
]

export default function GanttView({ data, isAdmin, onChanged }) {
  const { t } = useI18n()
  const { tasks, projects, projectNameById, lastCommentByTask, today } = data

  const [zoom, setZoom] = useState('month')
  const [corrimiento, setCorrimiento] = useState(0)
  const [colapsados, setColapsados] = useState(() => new Set())
  const [arrastre, setArrastre] = useState(null) // { id, modo, dias }
  const [err, setErr] = useState(null)
  // Dos sueltas muy seguidas sobre la misma barra escribirían dos veces.
  const unaVez = useAccionEnVuelo()

  const win = useMemo(() => ganttWindow(today, zoom, corrimiento), [today, zoom, corrimiento])
  const dw = ANCHO_DIA[zoom] || ANCHO_DIA.month
  const ticks = useMemo(() => ganttTicks(win), [win])
  const meses = useMemo(() => ganttMonths(win), [win])
  const colHoy = todayColumn(win, today)

  // Tres cubetas: lo que se dibuja, lo que no entra en la ventana y lo que no
  // tiene fechas. Las tres se muestran — ver la cabecera del archivo.
  const { porProyecto, fuera, sinFecha } = useMemo(() => {
    const mapa = new Map()
    const fuera = []
    const sinFecha = []
    for (const task of sortTasks(tasks, projectNameById)) {
      const bar = taskBar(task, win)
      if (bar === null) {
        sinFecha.push(task)
        continue
      }
      if (!bar.visible) {
        fuera.push(task)
        continue
      }
      if (!mapa.has(task.project_id)) mapa.set(task.project_id, [])
      mapa.get(task.project_id).push({ task, bar })
    }
    const porProyecto = [...mapa.entries()]
      .map(([id, filas]) => ({ id, nombre: projectNameById[id] || id, filas }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre))
    return { porProyecto, fuera, sinFecha }
  }, [tasks, win, projectNameById])

  function alternar(id) {
    setColapsados((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (tasks.length === 0) {
    return (
      <EmptyState
        icon="📅"
        title={t('projects.empty_today_title')}
        message={t('projects.empty_today_msg')}
      />
    )
  }

  return (
    <div className="pgantt">
      <div className="pgantt__toolbar">
        <div className="pgantt__zooms">
          {ZOOMS.map((z) => (
            <button
              key={z.key}
              type="button"
              className={zoom === z.key ? 'is-active' : ''}
              onClick={() => {
                setZoom(z.key)
                // El corrimiento está en PASOS, y el paso cambia con el zoom:
                // conservarlo saltaría a un rango arbitrario al cambiar de
                // vista. Volver a cero deja el foco en hoy, que es de donde
                // uno quiere mirar.
                setCorrimiento(0)
              }}
            >
              {t(z.labelKey)}
            </button>
          ))}
        </div>
        <div className="pgantt__nav">
          <button
            type="button"
            onClick={() => setCorrimiento((c) => c - 1)}
            aria-label={t('projects.gantt_prev')}
            title={t('projects.gantt_prev')}
          >
            ←
          </button>
          <button type="button" onClick={() => setCorrimiento(0)}>
            {t('projects.gantt_today')}
          </button>
          <button
            type="button"
            onClick={() => setCorrimiento((c) => c + 1)}
            aria-label={t('projects.gantt_next')}
            title={t('projects.gantt_next')}
          >
            →
          </button>
        </div>
        <span className="pgantt__range">
          {win.from} → {win.to}
        </span>
        {isAdmin && <span className="pgantt__hint">{t('projects.gantt_drag_hint')}</span>}
      </div>

      {err && <div className="pview__err">{err}</div>}

      <div className="pgantt__scroll">
        <div
          className="pgantt__inner"
          style={{ '--gantt-dw': `${dw}px`, '--gantt-dias': win.dias }}
        >
          {/* Cabecera: meses arriba, días abajo */}
          <div className="pgantt__head">
            <div className="pgantt__label pgantt__label--head" />
            <div className="pgantt__lane pgantt__lane--months">
              {meses.map((m) => (
                <div key={m.key} className="pgantt__month" style={{ gridColumn: `span ${m.span}` }}>
                  {m.key}
                </div>
              ))}
            </div>
          </div>
          <div className="pgantt__head">
            <div className="pgantt__label pgantt__label--head" />
            <div className="pgantt__lane pgantt__lane--days">
              {ticks.map((tick) => (
                <div
                  key={tick.date}
                  className={`pgantt__day${tick.finDeSemana ? ' is-weekend' : ''}${
                    tick.date === today ? ' is-today' : ''
                  }`}
                  title={tick.date}
                >
                  {win.tick === 'day' || tick.marca ? Number(tick.date.slice(8)) : ''}
                </div>
              ))}
            </div>
          </div>

          {porProyecto.map((proj) => (
            <div key={proj.id} className="pgantt__group">
              <div className="pgantt__row pgantt__row--project">
                <button
                  type="button"
                  className="pgantt__label pgantt__toggle"
                  onClick={() => alternar(proj.id)}
                  aria-expanded={!colapsados.has(proj.id)}
                >
                  {colapsados.has(proj.id) ? '▸' : '▾'} {proj.nombre}
                  <span className="pgantt__n">{proj.filas.length}</span>
                </button>
                <div className="pgantt__lane pgantt__lane--fondo">
                  {colHoy && <div className="pgantt__hoy" style={{ gridColumn: colHoy }} />}
                </div>
              </div>

              {!colapsados.has(proj.id) &&
                proj.filas.map(({ task, bar }) => (
                  <Fila
                    key={task.id}
                    task={task}
                    bar={bar}
                    dw={dw}
                    colHoy={colHoy}
                    lastComment={lastCommentByTask[task.id]}
                    arrastrable={isAdmin}
                    arrastre={arrastre?.id === task.id ? arrastre : null}
                    setArrastre={setArrastre}
                    onSoltar={async (modo, dias) => {
                      setArrastre(null)
                      const patch = arrastrarBarra(task, modo, dias)
                      if (!patch) return
                      await unaVez(`fechas:${task.id}`, async () => {
                        const { error } = await updateTask(task.id, patch)
                        if (error) setErr(error.message)
                        else {
                          setErr(null)
                          onChanged?.()
                        }
                      })
                    }}
                  />
                ))}
            </div>
          ))}
        </div>
      </div>

      {/* Lo que la línea de tiempo NO puede mostrar, mostrado igual. */}
      {fuera.length > 0 && (
        <details className="pgantt__aparte">
          <summary>{t('projects.gantt_outside', { n: fuera.length })}</summary>
          <ul>
            {fuera.map((x) => (
              <li key={x.id}>
                {x.title} <span>{projectNameById[x.project_id]}</span>{' '}
                <span>{x.due_date || x.start_date}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <details className="pgantt__aparte" open={sinFecha.length > 0}>
        <summary>{t('projects.gantt_no_dates', { n: sinFecha.length })}</summary>
        {sinFecha.length === 0 ? (
          <p className="pgroup__empty">{t('projects.group_empty')}</p>
        ) : (
          <ul>
            {sinFecha.map((x) => (
              <li key={x.id}>
                {x.title} <span>{projectNameById[x.project_id]}</span>{' '}
                <span>{x.owner_email || t('projects.unassigned')}</span>
              </li>
            ))}
          </ul>
        )}
      </details>

      {projects.length === 0 && <p className="pgroup__empty">{t('projects.no_projects')}</p>}
    </div>
  )
}

function Fila({
  task,
  bar,
  dw,
  colHoy,
  lastComment,
  arrastrable,
  arrastre,
  setArrastre,
  onSoltar,
}) {
  const { t } = useI18n()
  const inicioRef = useRef(null)

  function onPointerDown(e, modo) {
    if (!arrastrable) return
    e.preventDefault()
    e.stopPropagation()
    // setPointerCapture: sin esto, soltar el mouse fuera de la barra —que es
    // lo normal cuando se arrastra rápido— no dispara pointerup y la barra
    // queda pegada al cursor.
    //
    // Envuelto porque puede tirar InvalidPointerId con punteros que el
    // navegador ya no considera activos. Sin captura el arrastre funciona
    // igual mientras el cursor no se salga de la barra: degradar es mejor que
    // que la excepción se lleve puesto el handler entero.
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* sigue sin captura */
    }
    inicioRef.current = { x: e.clientX, modo, dias: 0 }
    setArrastre({ id: task.id, modo, dias: 0 })
  }

  function onPointerMove(e) {
    if (!inicioRef.current) return
    const dias = Math.round((e.clientX - inicioRef.current.x) / dw)
    // El desplazamiento acumulado vive en el REF, no en el estado. Es la
    // misma trampa que en el Kanban: si `pointermove` y `pointerup` caen en el
    // mismo lote de React —un arrastre corto y rápido— el estado todavía no se
    // actualizó cuando `pointerup` lo lee, y el movimiento se pierde EN
    // SILENCIO: la barra vuelve a su lugar y nadie sabe por qué. El estado
    // queda solo para la vista previa, que sí puede llegar un render tarde.
    inicioRef.current.dias = dias
    setArrastre({ id: task.id, modo: inicioRef.current.modo, dias })
  }

  function onPointerUp() {
    const info = inicioRef.current
    inicioRef.current = null
    if (!info) return
    onSoltar(info.modo, info.dias)
  }

  // Vista previa del arrastre: se mueve la barra en pantalla ANTES de escribir,
  // así el admin ve dónde va a caer. Si el arrastre se rechaza (cruzar los
  // extremos), la barra vuelve sola porque el estado se limpia sin escribir.
  const d = arrastre?.dias || 0
  const estilo = { gridColumn: `${bar.offset + 1} / span ${bar.span}` }
  if (d) {
    if (arrastre.modo === 'mover') estilo.transform = `translateX(${d * dw}px)`
    else if (arrastre.modo === 'fin') estilo.width = `calc(100% + ${d * dw}px)`
    else if (arrastre.modo === 'inicio') {
      estilo.transform = `translateX(${d * dw}px)`
      estilo.width = `calc(100% - ${d * dw}px)`
    }
  }

  const tooltip = [
    task.title,
    task.owner_email || t('projects.unassigned'),
    `${bar.desde} → ${bar.hasta}`,
    lastComment?.body,
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <div className="pgantt__row">
      <div className="pgantt__label" title={task.title}>
        <span className="pgantt__task">{task.title}</span>
        {task.owner_email && (
          <span className="pgantt__owner" title={task.owner_email}>
            {nombreCorto(task.owner_email)}
          </span>
        )}
      </div>
      <div className="pgantt__lane pgantt__lane--fondo">
        {colHoy && <div className="pgantt__hoy" style={{ gridColumn: colHoy }} />}
        <div
          className={`pgantt__bar pgantt__bar--${task.status}${bar.hito ? ' is-hito' : ''}${
            bar.recorteIzq ? ' is-cut-l' : ''
          }${bar.recorteDer ? ' is-cut-r' : ''}${arrastrable ? ' is-draggable' : ''}${
            d ? ' is-dragging' : ''
          }`}
          style={estilo}
          title={tooltip}
          onPointerDown={(e) => onPointerDown(e, 'mover')}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            inicioRef.current = null
            setArrastre(null)
          }}
        >
          <span className="pgantt__bar-text">{task.title}</span>
          {arrastrable && !bar.hito && (
            <>
              <span
                className="pgantt__handle pgantt__handle--l"
                onPointerDown={(e) => onPointerDown(e, 'inicio')}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              />
              <span
                className="pgantt__handle pgantt__handle--r"
                onPointerDown={(e) => onPointerDown(e, 'fin')}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
