import { useEffect, useState } from 'react'
import { frentesSinGuardar } from '../../lib/frentesPendientes'
import { frontLabel } from '../../lib/sessionFronts'

/**
 * Aviso: "tenés trabajo sin guardar en frentes que no estás mirando".
 *
 * POR QUÉ ES UN COMPONENTE APARTE Y NO UN BLOQUE DENTRO DE DataEntry
 * Los contadores de edición viajan en REFS para no re-renderizar la grilla en
 * cada tecleo (CLAUDE.md §5, fix P0/P1 de las 108-324 celdas). Leerlos exige
 * un tick propio — y si ese tick viviera en DataEntry, la grilla entera se
 * reconciliaría una vez por segundo, que es justo el costo que aquellos fixes
 * eliminaron. Acá el tick solo re-renderiza este cartel.
 *
 * Muestra SOLO los otros frentes: el actual ya está nombrado en el botón de
 * guardar, y repetirlo acá haría que el cartel apareciera siempre y se
 * volviera invisible por costumbre.
 */
export default function FrentesSinGuardar({
  fronts,
  llenoPorFrente,
  editSeqRef,
  savedSeqRef,
  bucketKey,
  onIrAFrente,
  t,
}) {
  const [, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const pendientes = frentesSinGuardar({
    fronts,
    llenoPorFrente,
    editSeq: editSeqRef?.current,
    savedSeq: savedSeqRef?.current,
  }).filter((f) => f.bucket !== bucketKey)

  if (!pendientes.length) return null

  return (
    <div className="de-unsaved-fronts">
      <span className="de-unsaved-fronts__title">{t('dataentry.unsaved_fronts_title')}</span>
      <span className="de-unsaved-fronts__list">
        {pendientes.map((f) => (
          <button
            key={f.bucket}
            type="button"
            className="de-unsaved-fronts__chip"
            onClick={() => onIrAFrente?.(f.bucket)}
            title={t('dataentry.unsaved_fronts_go')}
          >
            {t('dataentry.unsaved_fronts_item', { front: frontLabel(f.bucket), n: f.lleno })}
          </button>
        ))}
      </span>
      <span className="de-unsaved-fronts__hint">{t('dataentry.unsaved_fronts_hint')}</span>
    </div>
  )
}
