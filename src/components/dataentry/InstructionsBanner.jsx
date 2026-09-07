import { useState, useEffect, useRef } from 'react'

export const LEGEND_COLLAPSED_KEY = 'de:legend:collapsed'
const STORAGE_KEY = LEGEND_COLLAPSED_KEY

// `collapseSignal`: pedido user 2026-09-07 ("colapsar instructivo tras la
// primera sesión completada") — un hub que recién arranca ve el instructivo
// entero ocupando la primera pantalla, y quien lo usa a diario lo sigue
// viendo abierto hasta que lo cierra a mano una vez. DataEntry.jsx sube este
// número cada vez que una sesión termina de verdad; acá se escucha el
// CAMBIO (no el valor) porque localStorage ya decide el estado inicial —
// esto es solo para que la MISMA carga de página reaccione al cierre
// recién ocurrido, sin esperar a la próxima vez que se monte el componente.
export default function InstructionsBanner({ t, collapseSignal }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) !== '1'
    } catch {
      return true
    }
  })
  const lastSignalRef = useRef(collapseSignal)
  useEffect(() => {
    if (collapseSignal == null || collapseSignal === lastSignalRef.current) return
    lastSignalRef.current = collapseSignal
    setOpen(false)
    try {
      localStorage.setItem(STORAGE_KEY, '1')
    } catch {
      /* quota / disabled */
    }
  }, [collapseSignal])

  function toggle() {
    setOpen((prev) => {
      const next = !prev
      try {
        localStorage.setItem(STORAGE_KEY, next ? '0' : '1')
      } catch {
        /* quota / disabled */
      }
      return next
    })
  }

  const steps = [
    t('dataentry.legend_step1'),
    t('dataentry.legend_step2'),
    t('dataentry.legend_step3'),
    t('dataentry.legend_step4'),
    t('dataentry.legend_step5'),
    t('dataentry.legend_step6'),
  ]

  return (
    <div className="de-legend">
      <button className="de-legend-toggle" onClick={toggle}>
        {open ? '▲' : '▼'} {t('dataentry.legend_title')}
      </button>
      {open && (
        <ol className="de-legend-steps">
          {steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      )}
    </div>
  )
}
