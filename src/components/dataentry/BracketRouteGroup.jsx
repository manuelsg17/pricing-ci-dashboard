import { useState, useRef, useEffect } from 'react'
import { getCiCompetitors, categoryTracksEta, isInDriveVariant } from '../../lib/constants'
import { sanitizeDecimalInput } from '../../lib/format'
import CompBadge from './CompBadge'
import InDriveCell from './InDriveCell'

const CHIP_COL_WIDTH = 150

// Orden canónico de competidores para esta ruta: arranca con la lista de la
// primera categoría presente (normalmente Economy/Comfort, que ya trae el
// orden completo) y agrega al final cualquier competidor de otra categoría
// que no haya aparecido todavía — así todas las filas comparten el mismo
// orden de columnas.
function unionCompetitorOrder(presentCats, uiCity, country, dbConfigs) {
  const order = []
  for (const uiCat of presentCats) {
    for (const comp of getCiCompetitors(uiCity, uiCat, null, country, dbConfigs)) {
      if (!order.includes(comp)) order.push(comp)
    }
  }
  return order
}

// Un bracket + una ruta (Punto A → Punto B) mostrada una sola vez, con todas
// las categorías configuradas para la ciudad llenándose juntas debajo — así
// es como el hub realmente busca el precio (una búsqueda de A→B en el
// celular ya muestra todas las categorías a la vez). Cada fila de categoría
// es un grid con el mismo `grid-template-columns` que las demás filas del
// grupo, para que la columna de cada competidor quede alineada verticalmente
// aunque una categoría tenga menos competidores que otra.
//
// Cada celda de competidor apila, de arriba hacia abajo: badge → ETA (min) →
// precio (SIN descuento, el principal) → precio CON descuento (opcional). La
// cabecera del grupo se puede colapsar/expandir (empieza abierta).
export default function BracketRouteGroup({
  bracket,
  group,
  categories,
  timeslot,
  uiCity,
  country,
  dbConfigs,
  catColors,
  getEntry,
  setEntry,
  getEta,
  setEta,
  getDisc,
  setDisc,
  indriveExtra,
  setIndrive,
  indKey,
  priceKey,
  errorKeys,
  rowState,
  getNa,
  toggleNa,
  markRowNa,
  t,
  // Revisión UX 2026-09: estado de la ruta (full/partial/empty), número de
  // ruta dentro del turno, color del bracket y si el origen se muestra una
  // sola vez arriba (cuando todas las rutas comparten punto A).
  status = 'empty',
  routeIndex = null,
  routeTotal = null,
  bracketColor = null,
  hideOrigin = false,
}) {
  const [open, setOpen] = useState(true)
  // Auto-colapso (revisión UX 2026-09): una ruta completa se pliega sola
  // cuando el foco SALE de la tarjeta (nunca mientras el hub sigue tipeando
  // adentro — por eso va por blur y no por efecto sobre `status`). Si el hub
  // la vuelve a abrir a mano, se respeta hasta que deje de estar completa.
  const rootRef = useRef(null)
  const manualOpenRef = useRef(false)
  useEffect(() => {
    if (status !== 'full') manualOpenRef.current = false
  }, [status])
  function handleBlur(e) {
    if (status !== 'full' || manualOpenRef.current) return
    const next = e.relatedTarget
    if (next && rootRef.current && rootRef.current.contains(next)) return
    setOpen(false)
  }
  function toggleOpen() {
    setOpen((o) => {
      if (!o && status === 'full') manualOpenRef.current = true
      return !o
    })
  }
  const ts = timeslot
  const { anchorRef, byCategory } = group
  // Una categoría con TODOS los competidores marcados "no ofrece"
  // (getCiCompetitors vacío) no se muestra: no hay nada que cargar en ella.
  const presentCats = categories.filter(
    (c) => byCategory[c] && getCiCompetitors(uiCity, c, null, country, dbConfigs).length > 0
  )
  const missingCats = categories.filter((c) => !byCategory[c])
  const allComps = unionCompetitorOrder(presentCats, uiCity, country, dbConfigs)
  // Ancho fijo (no `1fr`) — con `1fr` las columnas se estiraban para llenar
  // todo el ancho de pantallas anchas, dejando mucho espacio vacío entre
  // competidores. Fijo mantiene las columnas juntas sin importar el ancho
  // del contenedor.
  const rowTemplate = `${CHIP_COL_WIDTH}px repeat(${allComps.length}, 108px)`

  const statusIcon = status === 'full' ? '✓' : status === 'partial' ? '●' : '○'
  const statusTitle =
    status === 'full'
      ? t('dataentry.route_done')
      : status === 'partial'
        ? t('dataentry.route_partial')
        : t('dataentry.route_empty')

  return (
    <div
      ref={rootRef}
      className={`de-bracket-group de-bracket-group--${status}${open ? '' : ' de-bracket-group--collapsed'}`}
      style={bracketColor ? { '--bracket-color': bracketColor } : undefined}
      onBlur={handleBlur}
    >
      <button
        type="button"
        className="de-bracket-route-header"
        aria-expanded={open}
        onClick={toggleOpen}
      >
        <span className="de-bracket-chevron" aria-hidden="true">
          {open ? '▼' : '▶'}
        </span>
        <span className={`de-route-status de-route-status--${status}`} title={statusTitle}>
          {statusIcon}
        </span>
        {routeIndex != null && routeTotal != null && (
          <span className="de-route-index">
            {t('dataentry.route_n_of', { i: routeIndex, n: routeTotal })}
          </span>
        )}
        <span className="de-bracket-label">{t(`bracket.${bracket}`) || bracket}</span>
        <span className="de-route-line">
          {!hideOrigin && (
            <>
              {anchorRef.point_a || '—'} <span className="de-route-arrow">→</span>{' '}
            </>
          )}
          {anchorRef.point_b || '—'}
        </span>
        {anchorRef.waze_distance != null && (
          <span className="de-route-km">{anchorRef.waze_distance} km</span>
        )}
      </button>

      {open && (
        <>
          {missingCats.length > 0 && (
            <div className="de-bracket-missing-note">
              {t('dataentry.missing_cats_note', { cats: missingCats.join(', ') })}
            </div>
          )}

          <div className="de-timeslot-block">
            {/* El turno ya es el agrupador padre (TurnoSection, cabecera
                sticky): repetirlo en cada tarjeta era ruido — 36 veces por
                jornada en Delivery/Cargo (revisión UX 2026-09). */}
            <div className="de-cat-rows">
              {presentCats.map((uiCat) => {
                const ref = byCategory[uiCat]
                const colors = catColors[uiCat] || catColors.Corp
                const comps = getCiCompetitors(uiCity, uiCat, null, country, dbConfigs)
                const state = rowState(uiCat, ref, ts)
                const ownRoute =
                  ref.id !== anchorRef.id &&
                  (ref.point_a !== anchorRef.point_a || ref.point_b !== anchorRef.point_b)

                return (
                  <div
                    key={uiCat}
                    className={`de-cat-row${state === 'partial' ? ' de-cat-row--partial' : ''}`}
                    style={{ gridTemplateColumns: rowTemplate }}
                  >
                    <div className="de-cat-row-head">
                      <span
                        className="de-cat-chip"
                        style={{
                          background: colors.bg,
                          borderColor: colors.border,
                          color: colors.text,
                        }}
                      >
                        {uiCat}
                      </span>
                      {ownRoute && (
                        <span
                          className="de-route-note"
                          title={`${ref.point_a || '—'} → ${ref.point_b || '—'}`}
                        >
                          {t('dataentry.own_route_note')}
                        </span>
                      )}
                      <button
                        type="button"
                        className="de-sd-row-btn"
                        onClick={() => markRowNa(uiCat, ref.id, ts.label, comps)}
                        title={t('dataentry.sd_row_title')}
                      >
                        {t('dataentry.sd_row_btn')}
                      </button>
                    </div>
                    {allComps.map((comp) => {
                      if (!comps.includes(comp)) {
                        return <div key={comp} className="de-cell de-cell--na" aria-hidden="true" />
                      }
                      const key = priceKey(uiCat, ref.id, ts.label, comp)
                      const hasErr = errorKeys.has(key)
                      // ETA (min) — arriba del precio, para todos los
                      // competidores (incluido InDrive). Opcional.
                      const etaInput = (
                        <input
                          type="text"
                          inputMode="numeric"
                          className="de-eta-input"
                          placeholder={t('dataentry.eta_placeholder')}
                          title={t('dataentry.eta_title')}
                          value={getEta(uiCat, ref.id, ts.label, comp)}
                          onChange={(e) =>
                            setEta(
                              uiCat,
                              ref.id,
                              ts.label,
                              comp,
                              sanitizeDecimalInput(e.target.value)
                            )
                          }
                        />
                      )
                      // Precio CON descuento — debajo del precio principal
                      // (sin descuento), para todos los competidores. Opcional.
                      const discInput = (
                        <input
                          type="text"
                          inputMode="decimal"
                          className="de-disc-input"
                          placeholder={t('dataentry.disc_placeholder')}
                          title={t('dataentry.disc_title')}
                          value={getDisc(uiCat, ref.id, ts.label, comp)}
                          onChange={(e) =>
                            setDisc(
                              uiCat,
                              ref.id,
                              ts.label,
                              comp,
                              sanitizeDecimalInput(e.target.value)
                            )
                          }
                        />
                      )
                      const isNa = getNa(uiCat, ref.id, ts.label, comp)
                      return (
                        <div
                          key={comp}
                          className={`de-cell${hasErr ? ' de-td-error' : ''}${isNa ? ' de-cell--nodata' : ''}`}
                        >
                          <span className="de-cell-label">
                            <CompBadge comp={comp} />
                            <button
                              type="button"
                              className={`de-sd-toggle${isNa ? ' active' : ''}`}
                              onClick={() => toggleNa(uiCat, ref.id, ts.label, comp)}
                              title={
                                isNa ? t('dataentry.sd_unmark_title') : t('dataentry.sd_mark_title')
                              }
                            >
                              S/D
                            </button>
                          </span>
                          {isNa ? (
                            <div className="de-nodata-badge">{t('dataentry.sd_no_offer')}</div>
                          ) : (
                            <>
                              {categoryTracksEta(uiCat) && etaInput}
                              {isInDriveVariant(comp) ? (
                                <InDriveCell
                                  avg={getEntry(uiCat, ref.id, ts.label, comp)}
                                  extra={indriveExtra[indKey(uiCat, ref.id, ts.label, comp)]}
                                  onChange={(extra, avg) =>
                                    setIndrive(uiCat, ref.id, ts.label, comp, extra, avg)
                                  }
                                  hasError={hasErr}
                                />
                              ) : (
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  className={`de-price-input${hasErr ? ' de-price-input--error' : ''}`}
                                  placeholder={t('dataentry.price_placeholder')}
                                  value={getEntry(uiCat, ref.id, ts.label, comp)}
                                  onChange={(e) =>
                                    setEntry(
                                      uiCat,
                                      ref.id,
                                      ts.label,
                                      comp,
                                      sanitizeDecimalInput(e.target.value)
                                    )
                                  }
                                />
                              )}
                              {discInput}
                            </>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
