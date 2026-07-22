import { useState } from 'react'

// Turno (Mañana/Tarde/Noche) como agrupador PRINCIPAL de la grilla: el hub
// completa todos los brackets de un turno antes de pasar al siguiente. Se
// puede colapsar como bloque completo — independiente del colapso por-ruta
// que ya tiene BracketRouteGroup adentro (dos niveles de colapso sin
// relación entre sí).
export default function TurnoSection({ timeslot, filled, total, children }) {
  const [open, setOpen] = useState(true)
  return (
    <section className="de-turno-section">
      <button
        type="button"
        className="de-turno-header"
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
        <span className="de-turno-progress">
          {filled}/{total}
        </span>
      </button>
      {open && <div className="de-turno-body">{children}</div>}
    </section>
  )
}
