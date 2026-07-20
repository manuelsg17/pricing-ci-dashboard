import { BRACKET_LABELS, getCompetitors } from '../../lib/constants'
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
    for (const comp of getCompetitors(uiCity, uiCat, null, country, dbConfigs)) {
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
export default function BracketRouteGroup({
  bracket,
  group,
  categories,
  timeslots,
  uiCity,
  country,
  dbConfigs,
  catColors,
  getEntry,
  setEntry,
  indriveExtra,
  setIndrive,
  indKey,
  priceKey,
  errorKeys,
  rowState,
  t,
}) {
  const { anchorRef, byCategory } = group
  const presentCats = categories.filter((c) => byCategory[c])
  const missingCats = categories.filter((c) => !byCategory[c])
  const allComps = unionCompetitorOrder(presentCats, uiCity, country, dbConfigs)
  // Ancho fijo (no `1fr`) — con `1fr` las columnas se estiraban para llenar
  // todo el ancho de pantallas anchas, dejando mucho espacio vacío entre
  // competidores. Fijo mantiene las columnas juntas sin importar el ancho
  // del contenedor.
  const rowTemplate = `${CHIP_COL_WIDTH}px repeat(${allComps.length}, 92px)`

  return (
    <div className="de-bracket-group">
      <div className="de-bracket-route-header">
        <span className="de-bracket-label">{BRACKET_LABELS[bracket] || bracket}</span>
        <span className="de-route-line">
          {anchorRef.point_a || '—'} <span className="de-route-arrow">→</span>{' '}
          {anchorRef.point_b || '—'}
        </span>
        {anchorRef.waze_distance != null && (
          <span className="de-route-km">{anchorRef.waze_distance} km</span>
        )}
      </div>

      {missingCats.length > 0 && (
        <div className="de-bracket-missing-note">
          {t('dataentry.missing_cats_note', { cats: missingCats.join(', ') })}
        </div>
      )}

      {timeslots.map((ts) => (
        <div key={ts.label} className="de-timeslot-block">
          <div className="de-timeslot-heading">
            <span className="de-ts-pill">{ts.label}</span>
            <span className="de-ts-time">{ts.start_time?.slice(0, 5)}</span>
          </div>

          <div className="de-cat-rows">
            {presentCats.map((uiCat) => {
              const ref = byCategory[uiCat]
              const colors = catColors[uiCat] || catColors.Corp
              const comps = getCompetitors(uiCity, uiCat, null, country, dbConfigs)
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
                  </div>
                  {allComps.map((comp) => {
                    if (!comps.includes(comp)) {
                      return <div key={comp} className="de-cell de-cell--na" aria-hidden="true" />
                    }
                    const key = priceKey(uiCat, ref.id, ts.label, comp)
                    const hasErr = errorKeys.has(key)
                    if (comp === 'InDrive') {
                      return (
                        <div key={comp} className={`de-cell${hasErr ? ' de-td-error' : ''}`}>
                          <span className="de-cell-label">
                            <CompBadge comp={comp} />
                          </span>
                          <InDriveCell
                            avg={getEntry(uiCat, ref.id, ts.label, 'InDrive')}
                            extra={indriveExtra[indKey(uiCat, ref.id, ts.label)]}
                            onChange={(extra, avg) =>
                              setIndrive(uiCat, ref.id, ts.label, extra, avg)
                            }
                            hasError={hasErr}
                          />
                        </div>
                      )
                    }
                    return (
                      <div key={comp} className={`de-cell${hasErr ? ' de-td-error' : ''}`}>
                        <span className="de-cell-label">
                          <CompBadge comp={comp} />
                        </span>
                        <input
                          type="text"
                          inputMode="decimal"
                          className={`de-price-input${hasErr ? ' de-price-input--error' : ''}`}
                          placeholder="—"
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
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
