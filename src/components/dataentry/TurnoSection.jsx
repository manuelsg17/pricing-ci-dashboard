import { useState } from 'react'
import { useI18n } from '../../context/LanguageContext'

// Turno (Mañana/Tarde/Noche) como agrupador PRINCIPAL de la grilla: el hub
// completa todos los brackets de un turno antes de pasar al siguiente. Se
// puede colapsar como bloque completo — independiente del colapso por-ruta
// que ya tiene BracketRouteGroup adentro (dos niveles de colapso sin
// relación entre sí).
//
// `brackets` (2026-09, revisión UX): minimapa del turno — un chip por bracket
// con su progreso (rutas completas / total) y su color; tocarlo salta a la
// banda de ese bracket. La cabecera es sticky, así el hub siempre ve en qué
// turno está y cuánto le falta aunque esté en la ruta 30 de 36.
export default function TurnoSection({
  id,
  timeslot,
  filled,
  total,
  hasErrors,
  brackets,
  children,
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(true)
  const done = total > 0 && filled >= total
  return (
    <section id={id} className="de-turno-section de-scroll-target">
      <div className={`de-turno-header${done ? ' de-turno-header--done' : ''}`}>
        <button
          type="button"
          className="de-turno-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="de-turno-chevron" aria-hidden="true">
            {open ? '▼' : '▶'}
          </span>
          <span className="de-turno-label">{timeslot.label}</span>
          <span className="de-turno-time">
            {timeslot.start_time?.slice(0, 5)}–{timeslot.end_time?.slice(0, 5)}
          </span>
          {/* Colapsado + con celdas en error: el hub no puede verlas para
              saber qué falta — avisar en la cabecera misma. */}
          {!open && hasErrors && (
            <span
              className="de-turno-error-badge"
              aria-hidden="true"
              title={t('dataentry.turno_has_partial')}
            >
              ⚠
            </span>
          )}
        </button>
        {open && Array.isArray(brackets) && brackets.length > 0 && (
          <nav className="de-turno-minimap" aria-label={t('dataentry.minimap_label')}>
            {brackets.map((b) => {
              const bDone = b.total > 0 && b.done >= b.total
              return (
                <button
                  key={b.bracket}
                  type="button"
                  className={`de-turno-chip${bDone ? ' de-turno-chip--done' : ''}`}
                  style={{ '--bracket-color': b.color }}
                  title={`${b.label} · ${b.done}/${b.total}`}
                  onClick={() => {
                    const el = document.getElementById(b.id)
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }}
                >
                  <span className="de-turno-chip__dot" aria-hidden="true" />
                  {b.short} {b.done}/{b.total}
                </button>
              )
            })}
          </nav>
        )}
        <span className={`de-turno-progress${done ? ' de-turno-progress--done' : ''}`}>
          {done ? '✓ ' : ''}
          {filled}/{total}
        </span>
      </div>
      {open && <div className="de-turno-body">{children}</div>}
    </section>
  )
}
