import { useState } from 'react'

const STORAGE_KEY = 'de:legend:collapsed'

export default function InstructionsBanner({ t }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) !== '1'
    } catch {
      return true
    }
  })

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
