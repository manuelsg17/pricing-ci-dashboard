import { useEffect, useState } from 'react'
import { sb } from '../../lib/supabase'
import { useConfirm } from '../ui/ConfirmDialog'
import SaveStatusBanner from './SaveStatusBanner'
import { Button } from '../ui/shadcn/button'

// Lista los snapshots (hard copies) creados por freeze_pricing_wa y
// permite eliminarlos. Cada snapshot agrupa todas las filas que se
// congelaron en una sola corrida (mismo label + timestamp truncado).
//
// Eliminar un snapshot hace que los períodos vuelvan a recalcularse
// en vivo desde v_bracket_weekly_avg (con la config actual). Útil
// cuando el operador se arrepiente de un cambio.
export default function SnapshotsManager({ country }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(null)
  const [msg, setMsg] = useState(null)
  const confirm = useConfirm()

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country])

  async function load() {
    setLoading(true)
    setMsg(null)
    const { data, error } = await sb.rpc('list_pricing_wa_snapshots', { p_country: country })
    if (error) {
      setMsg({ type: 'err', text: 'Error al cargar snapshots: ' + error.message })
      setRows([])
    } else {
      setRows(data || [])
    }
    setLoading(false)
  }

  async function handleDelete(snap) {
    const ok = await confirm({
      title: 'Eliminar snapshot',
      message:
        `Vas a eliminar el snapshot "${snap.frozen_label}" ` +
        `(${snap.rows_count.toLocaleString()} filas, ${snap.weeks_count} semanas, ${snap.cities_count} ciudades).\n\n` +
        `Después de eliminar, los períodos congelados volverán a calcularse EN VIVO desde la data actual, ` +
        `usando la configuración actual de pesos y umbrales.\n\nEsta acción NO se puede deshacer.`,
      confirmText: 'Eliminar snapshot',
      cancelText: 'Cancelar',
      danger: true,
    })
    if (!ok) return

    setDeleting(snap.frozen_label)
    setMsg(null)
    const { data, error } = await sb.rpc('unfreeze_pricing_wa', {
      p_country: country,
      p_label: snap.frozen_label,
    })
    if (error) {
      setMsg({ type: 'err', text: 'Error: ' + error.message })
    } else {
      setMsg({
        type: 'ok',
        text: `Snapshot eliminado: ${data?.toLocaleString() ?? '?'} filas removidas.`,
      })
      await load()
    }
    setDeleting(null)
  }

  if (loading) return <div className="config-loading">Cargando snapshots…</div>

  return (
    <div className="config-section">
      <h2>Snapshots (hard copies) — {country}</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        Cada snapshot congela los promedios ponderados de un momento dado. Se crean automáticamente
        al guardar cambios en <strong>Distancias</strong> o <strong>Pesos</strong> (si usás "Guardar
        con snapshot"), o manualmente vía RPC. Eliminar un snapshot devuelve los períodos a cálculo
        en vivo con la config actual.
      </p>

      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      {rows.length === 0 ? (
        <div
          style={{
            padding: 20,
            textAlign: 'center',
            color: '#888',
            background: '#f8fafc',
            borderRadius: 8,
            border: '1px dashed #cbd5e1',
          }}
        >
          Sin snapshots para {country}.
        </div>
      ) : (
        <table className="config-table" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Etiqueta</th>
              <th style={{ textAlign: 'left' }}>Creado</th>
              <th style={{ textAlign: 'right' }}>Filas</th>
              <th style={{ textAlign: 'right' }}>Semanas</th>
              <th style={{ textAlign: 'right' }}>Ciudades</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td style={{ fontSize: 11, maxWidth: 360, wordBreak: 'break-all' }}>
                  {r.frozen_label}
                </td>
                <td style={{ fontSize: 11, color: '#475569' }}>
                  {new Date(r.frozen_at_second).toLocaleString()}
                </td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>
                  {Number(r.rows_count).toLocaleString()}
                </td>
                <td style={{ textAlign: 'right' }}>{Number(r.weeks_count).toLocaleString()}</td>
                <td style={{ textAlign: 'right' }}>{Number(r.cities_count).toLocaleString()}</td>
                <td>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="border-red-300 text-red-600 hover:bg-red-100"
                    onClick={() => handleDelete(r)}
                    disabled={deleting === r.frozen_label}
                    title="Eliminar este snapshot. Los períodos volverán a cálculo en vivo."
                  >
                    {deleting === r.frozen_label ? 'Eliminando…' : '✕ Eliminar'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
