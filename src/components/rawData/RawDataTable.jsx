import { BRACKET_LABELS } from '../../lib/constants'

function fmt(val, decimals = 2) {
  if (val === null || val === undefined || val === '') return '—'
  const n = parseFloat(val)
  return isNaN(n) ? String(val) : n.toFixed(decimals)
}

const isYangoRow = (r) => r.competition_name && r.competition_name.toLowerCase().startsWith('yango')

export default function RawDataTable({
  rows,
  loading,
  config,
  outlierThreshold,
  editingId,
  editField,
  editValue,
  setEditValue,
  startEdit,
  cancelEdit,
  handleEditKeyDown,
  handleDelete,
  exporting,
}) {
  const isOutlierRow = (r) =>
    parseFloat(r.price_without_discount) > outlierThreshold ||
    parseFloat(r.price_with_discount) > outlierThreshold ||
    parseFloat(r.recommended_price) > outlierThreshold ||
    parseFloat(r.minimal_bid) > outlierThreshold

  const renderEditable = (r, field, decimals = 2) => {
    if (editingId === r.id && editField === field) {
      return (
        <input
          autoFocus
          type="number"
          step="any"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => handleEditKeyDown(e, r.id, field)}
          onBlur={cancelEdit}
          style={{ width: '60px', padding: '2px' }}
        />
      )
    }
    return (
      <span
        onDoubleClick={() => startEdit(r.id, field, r[field])}
        style={{ cursor: 'pointer' }}
        title="Doble clic para editar"
      >
        {fmt(r[field], decimals)}
      </span>
    )
  }

  return (
    <div className="raw-data__table-wrap">
      <table className="raw-data__table">
        <thead>
          {/* Column group headers */}
          <tr>
            <th colSpan={2} className="col-year">
              Tiempo
            </th>
            <th colSpan={2} className="col-date">
              Fecha / Hora
            </th>
            <th colSpan={2} className="col-rush">
              Flags
            </th>
            <th colSpan={2} className="col-cat">
              Servicio
            </th>
            <th className="col-source">Fuente</th>
            <th colSpan={3} className="col-bracket">
              Ruta
            </th>
            <th colSpan={2} className="col-point">
              Puntos
            </th>
            <th colSpan={4} className="col-price">
              Precios ({config.currency})
            </th>
            <th colSpan={3} className="col-bid">
              Bids InDrive
            </th>
            <th className="col-eta">ETA</th>
            <th className="col-actions"></th>
          </tr>
          {/* Column labels */}
          <tr>
            <th className="col-year">Año</th>
            <th className="col-week">Sem</th>
            <th className="col-date">Fecha</th>
            <th className="col-time">Hora</th>
            <th className="col-rush">Rush</th>
            <th className="col-surge">Surge</th>
            <th className="col-cat">Categoría</th>
            <th className="col-comp">Competidor</th>
            <th className="col-source">Fuente</th>
            <th className="col-bracket">Bracket</th>
            <th className="col-zone">Zona</th>
            <th className="col-price">Dist (km)</th>
            <th className="col-point">Punto A</th>
            <th className="col-point">Punto B</th>
            <th className="col-price">P. s/desc</th>
            <th className="col-price">P. c/desc</th>
            <th className="col-price">Recomend.</th>
            <th className="col-price">Min. Bid</th>
            <th className="col-bid">Bid 1</th>
            <th className="col-bid">Bid 2</th>
            <th className="col-bid">Bid 3</th>
            <th className="col-eta">ETA (min)</th>
            <th className="col-actions"></th>
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0 && (
            <tr>
              <td colSpan={26} className="raw-data__state">
                Cargando datos…
              </td>
            </tr>
          )}
          {!loading && rows.length === 0 && (
            <tr>
              <td colSpan={26} className="raw-data__state">
                No se encontraron filas con los filtros actuales.
              </td>
            </tr>
          )}
          {rows.map((r, i) => (
            <tr
              key={r.id ?? i}
              className={[
                isYangoRow(r) ? 'raw-data__row--yango' : '',
                isOutlierRow(r) ? 'raw-data__row--outlier' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <td className="col-year">{r.year ?? '—'}</td>
              <td className="col-week">{r.week ?? '—'}</td>
              <td className="col-date">{r.observed_date ?? '—'}</td>
              <td className="col-time">{r.observed_time ? r.observed_time.slice(0, 5) : '—'}</td>
              <td className="col-rush">
                {r.rush_hour === true ? (
                  <span className="badge-rush">Rush</span>
                ) : r.rush_hour === false ? (
                  <span className="badge-no">—</span>
                ) : (
                  '?'
                )}
              </td>
              <td className="col-surge">
                {r.surge === true ? (
                  <span className="badge-surge">Sí</span>
                ) : r.surge === false ? (
                  <span className="badge-no">No</span>
                ) : (
                  <span className="badge-no">—</span>
                )}
              </td>
              <td className="col-cat">{r.category ?? '—'}</td>
              <td
                className="col-comp"
                style={isYangoRow(r) ? { color: 'var(--color-yango)', fontWeight: 600 } : {}}
              >
                {r.competition_name ?? '—'}
              </td>
              <td className="col-source">
                {r.data_source === 'bot' ? (
                  <span className="badge-bot">Bot</span>
                ) : (
                  <span className="badge-hub">Hub</span>
                )}
              </td>
              <td className="col-bracket">
                {r.distance_bracket ? (
                  <span className="bracket-pill">
                    {BRACKET_LABELS[r.distance_bracket] ?? r.distance_bracket}
                  </span>
                ) : (
                  <span className="badge-no">—</span>
                )}
              </td>
              <td className="col-zone">{r.zone ?? '—'}</td>
              <td className="col-price">{fmt(r.distance_km, 1)}</td>
              <td className="col-point" title={r.point_a ?? ''}>
                {r.point_a ?? '—'}
              </td>
              <td className="col-point" title={r.point_b ?? ''}>
                {r.point_b ?? '—'}
              </td>
              <td
                className={`col-price${parseFloat(r.price_without_discount) > outlierThreshold ? ' cell-outlier' : ''}`}
              >
                {renderEditable(r, 'price_without_discount')}
              </td>
              <td
                className={`col-price${parseFloat(r.price_with_discount) > outlierThreshold ? ' cell-outlier' : ''}`}
              >
                {renderEditable(r, 'price_with_discount')}
              </td>
              <td
                className={`col-price${parseFloat(r.recommended_price) > outlierThreshold ? ' cell-outlier' : ''}`}
              >
                {renderEditable(r, 'recommended_price')}
              </td>
              <td
                className={`col-price${parseFloat(r.minimal_bid) > outlierThreshold ? ' cell-outlier' : ''}`}
              >
                {renderEditable(r, 'minimal_bid')}
              </td>
              <td className="col-bid">{renderEditable(r, 'bid_1')}</td>
              <td className="col-bid">{renderEditable(r, 'bid_2')}</td>
              <td className="col-bid">{renderEditable(r, 'bid_3')}</td>
              <td className="col-eta">{fmt(r.eta_min, 1)}</td>
              <td className="col-actions">
                <button
                  className="raw-data__delete-btn"
                  onClick={() => handleDelete(r.id)}
                  disabled={exporting}
                  title={exporting ? 'Esperá a que termine la exportación' : 'Eliminar fila'}
                >
                  🗑
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
