import { useState } from 'react'
import { useI18n } from '../../context/LanguageContext'

// Turno (Mañana/Tarde/Noche) como agrupador PRINCIPAL de la grilla: el hub
// completa todos los brackets de un turno antes de pasar al siguiente. Se
// puede colapsar como bloque completo — independiente del colapso por-ruta
// que ya tiene BracketRouteGroup adentro (dos niveles de colapso sin
// relación entre sí).
export default function TurnoSection({ timeslot, filled, total, hasErrors, children }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(true)
  const done = total > 0 && filled >= total
  return (
    <section className="de-turno-section">
      <button
        type="button"
        className={`de-turno-header${done ? ' de-turno-header--done' : ''}`}
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
        <span className={`de-turno-progress${done ? ' de-turno-progress--done' : ''}`}>
          {done ? '✓ ' : ''}
          {filled}/{total}
        </span>
      </button>
      {open && <div className="de-turno-body">{children}</div>}
    </section>
  )
}
