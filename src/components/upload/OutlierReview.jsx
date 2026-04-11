import { useState } from 'react'

/**
 * OutlierReview — muestra filas con precios sospechosos antes del insert.
 * El usuario puede corregir el precio o marcar la fila como "excluir".
 *
 * Props:
 *   suspects: [{ idx, row, field, value, threshold }]
 *   onConfirm(corrections): corrections = { [idx]: { price, exclude } }
 *   onCancel()
 */
export default function OutlierReview({ suspects, onConfirm, onCancel }) {
  // Estado local: { [idx]: { price: string, exclude: bool } }
  const [edits, setEdits] = useState(() => {
    const init = {}
    suspects.forEach(s => {
      init[s.idx] = { price: String(s.value ?? ''), exclude: false }
    })
    return init
  })

  function setPrice(idx, val) {
    setEdits(prev => ({ ...prev, [idx]: { ...prev[idx], price: val } }))
  }
  function toggleExclude(idx) {
    setEdits(prev => ({ ...prev, [idx]: { ...prev[idx], exclude: !prev[idx].exclude } }))
  }

  const toInclude  = suspects.filter(s => !edits[s.idx]?.exclude).length
  const toExclude  = suspects.filter(s =>  edits[s.idx]?.exclude).length

  return (
    <div className="outlier-review">
      <div className="outlier-review__header">
        <div className="outlier-review__icon">⚠️</div>
        <div>
          <div className="outlier-review__title">Precios sospechosos detectados</div>
          <div className="outlier-review__sub">
            {suspects.length} {suspects.length === 1 ? 'fila supera' : 'filas superan'} el límite configurado.
            Corrige el valor o marca "Excluir" para no insertarla.
          </div>
        </div>
      </div>

      <div className="outlier-review__table-wrap">
        <table className="outlier-review__table">
          <thead>
            <tr>
              <th>Ciudad</th>
              <th>Categoría</th>
              <th>Competidor</th>
              <th>Fecha</th>
              <th>Bracket</th>
              <th>Precio actual</th>
              <th>Límite</th>
              <th>Precio corregido</th>
              <th>Excluir</th>
            </tr>
          </thead>
          <tbody>
            {suspects.map(s => {
              const edit = edits[s.idx]
              return (
                <tr key={s.idx} className={edit.exclude ? 'outlier-row--excluded' : ''}>
                  <td>{s.row.city}</td>
                  <td>{s.row.category}</td>
                  <td>{s.row.competition_name}</td>
                  <td>{s.row.observed_date}</td>
                  <td>{s.row.distance_bracket || '—'}</td>
                  <td className="outlier-value">{s.value}</td>
                  <td className="outlier-threshold">≤ {s.threshold}</td>
                  <td>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      className="outlier-input"
                      value={edit.price}
                      onChange={e => setPrice(s.idx, e.target.value)}
                      disabled={edit.exclude}
                      placeholder="Corregir…"
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={edit.exclude}
                      onChange={() => toggleExclude(s.idx)}
                      className="outlier-checkbox"
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="outlier-review__footer">
        <div className="outlier-review__summary">
          Se insertarán <strong>{toInclude}</strong> filas corregidas ·
          Se excluirán <strong>{toExclude}</strong> filas
        </div>
        <div className="outlier-review__actions">
          <button className="btn-clear" onClick={onCancel}>Cancelar</button>
          <button
            className="btn-ingest"
            onClick={() => onConfirm(edits)}
          >
            Confirmar y continuar →
          </button>
        </div>
      </div>
    </div>
  )
}
