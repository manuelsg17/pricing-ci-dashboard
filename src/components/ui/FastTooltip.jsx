import { useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'

// Tooltip liviano para usar en celdas repetidas muchas veces (ej. la grilla
// del Dashboard, cientos de celdas "—" en la misma página) — auditoría
// 2026-07-29: el `title` nativo del navegador tarda ~1s en aparecer (fijo,
// no configurable) y el cursor "?" invita a hacer click sin que pase nada,
// lo que generaba la sensación de que estaba roto. A propósito NO usa
// @radix-ui/react-tooltip: montar un Tooltip.Root por celda en una tabla de
// cientos de celdas es peso innecesario — acá cada instancia es solo un
// booleano de estado + un portal condicional.
//
// Portal a document.body (no un absolute normal): las 3 tablas del
// Dashboard tienen scroll horizontal propio (overflow-x: auto) — un tooltip
// posicionado relativo a la celda quedaría cortado por ese overflow.
const SHOW_DELAY_MS = 80

export default function FastTooltip({ content, children }) {
  const [show, setShow] = useState(false)
  const [pos, setPos] = useState(null)
  const ref = useRef(null)
  const timerRef = useRef(null)

  const open = useCallback(() => {
    timerRef.current = setTimeout(() => {
      const rect = ref.current?.getBoundingClientRect()
      if (rect) setPos({ top: rect.top, left: rect.left + rect.width / 2 })
      setShow(true)
    }, SHOW_DELAY_MS)
  }, [])

  const close = useCallback(() => {
    clearTimeout(timerRef.current)
    setShow(false)
  }, [])

  return (
    <span
      ref={ref}
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
      tabIndex={0}
      style={{ cursor: 'help', outline: 'none' }}
    >
      {children}
      {show &&
        pos &&
        createPortal(
          <div
            role="tooltip"
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              transform: 'translate(-50%, calc(-100% - 8px))',
              background: '#1f2937',
              color: '#fff',
              fontSize: 11,
              lineHeight: 1.4,
              padding: '6px 10px',
              borderRadius: 6,
              maxWidth: 240,
              textAlign: 'center',
              boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
              zIndex: 9999,
              pointerEvents: 'none',
            }}
          >
            {content}
          </div>,
          document.body
        )}
    </span>
  )
}
