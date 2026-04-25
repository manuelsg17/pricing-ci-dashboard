import { useState, useEffect, useCallback } from 'react'
import { sb } from '../../lib/supabase'
import { useCountry } from '../../context/CountryContext'
import { useToast } from '../ui/Toast'
import EmptyState from '../ui/EmptyState'
import { SkeletonTable } from '../ui/Skeleton'

export default function BotDbSync() {
  const { country } = useCountry()
  const toast = useToast()
  const [running, setRunning]     = useState(false)
  const [probing, setProbing]     = useState(false)
  const [probeData, setProbeData] = useState(null)   // { columns, sample }
  const [watermark, setWatermark] = useState(null)
  const [logRows, setLogRows]     = useState([])
  const [loadingLog, setLoadingLog] = useState(true)
  const [from, setFrom] = useState('')
  const [to, setTo]     = useState('')
  const [limit, setLimit] = useState(5000)

  const reload = useCallback(async () => {
    setLoadingLog(true)
    const [{ data: wm }, { data: log }] = await Promise.all([
      sb.from('bot_sync_watermark').select('*').eq('country', country).maybeSingle(),
      sb.from('bot_sync_log').select('*').eq('country', country).order('started_at', { ascending: false }).limit(20),
    ])
    setWatermark(wm || null)
    setLogRows(log || [])
    setLoadingLog(false)
  }, [country])

  useEffect(() => { reload() }, [reload])

  async function callFn(payload) {
    const { data: { session } } = await sb.auth.getSession()
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
    const anonKey     = import.meta.env.VITE_SUPABASE_ANON_KEY
    const res = await fetch(`${supabaseUrl}/functions/v1/sync-bot-quotes`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        anonKey,
        'Authorization': session?.access_token ? `Bearer ${session.access_token}` : `Bearer ${anonKey}`,
      },
      body: JSON.stringify(payload),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
    return json
  }

  async function handleProbe() {
    setProbing(true); setProbeData(null)
    try {
      const out = await callFn({ action: 'probe' })
      setProbeData({ columns: out.columns || [], sample: out.sample || [] })
      toast.ok(`Esquema descubierto: ${out.columns?.length || 0} columnas, ${out.sample?.length || 0} filas de muestra.`)
    } catch (e) {
      toast.err(`Error al sondear: ${e.message}`)
    } finally {
      setProbing(false)
    }
  }

  async function handlePing() {
    setProbing(true)
    try {
      const out = await callFn({ action: 'ping' })
      const env = out.env || {}
      const msg = `Función OK · secrets: ${Object.entries(env).filter(([k]) => k.endsWith('_set')).map(([k,v]) => `${k.replace('_set','')}:${v?'✓':'✗'}`).join(' · ')} · SSL=${env.BOT_PG_SSLMODE}`
      toast.ok(msg, { duration: 8000 })
    } catch (e) {
      toast.err(`Función no responde: ${e.message}. Verifica que esté deployada y revisa los Logs en Supabase Dashboard.`, { duration: 10000 })
    } finally {
      setProbing(false)
    }
  }

  async function handleSync(opts = {}) {
    setRunning(true)
    try {
      const payload = { action: 'sync', country, limit: Number(limit) || 5000, ...opts }
      const out = await callFn(payload)
      const s = out.stats || {}
      toast.ok(
        `Sync OK · ${s.read} leídas · ${s.inserted} insertadas · ${s.dropped} descartadas · ${s.outliers} outliers`,
        { duration: 7000 }
      )
      reload()
    } catch (e) {
      toast.err(`Error de sync: ${e.message}`, { duration: 8000 })
      reload()
    } finally {
      setRunning(false)
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="config-section">
        <h2>Sincronización directa con la BD del bot</h2>
        <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
          Lee filas nuevas desde <code>quotes_output</code> en la BD del bot y las
          inserta en <code>pricing_observations</code> aplicando los mismos filtros
          (filas vacías, montos fuera de rango) que el upload manual. La conexión
          se hace vía Edge Function — las credenciales viven solo como secrets en
          Supabase, nunca en el código.
        </p>

        <div style={{
          display: 'flex', gap: 12, alignItems: 'center',
          background: '#f8fafc', padding: 12, borderRadius: 8,
          border: '1px solid #e2e8f0', marginBottom: 16, flexWrap: 'wrap',
        }}>
          <div style={{ fontSize: 12 }}>
            <strong>País:</strong> {country}
          </div>
          <div style={{ fontSize: 12, color: '#475569' }}>
            <strong>Última sync:</strong>{' '}
            {watermark?.last_synced_at
              ? new Date(watermark.last_synced_at).toLocaleString()
              : '— nunca —'}
          </div>
        </div>

        {/* Acciones principales */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          <button
            className="btn-save"
            onClick={() => handleSync()}
            disabled={running}
            title="Lee desde el último watermark hasta ahora"
          >
            {running ? 'Sincronizando…' : '⟳ Sync incremental'}
          </button>
          <button
            onClick={handleProbe}
            disabled={probing}
            style={{
              padding: '6px 12px', borderRadius: 6,
              border: '1px solid #cbd5e1', background: '#fff', cursor: 'pointer',
              fontSize: 12,
            }}
          >
            {probing ? 'Sondeando…' : '🔍 Sondear esquema (probe)'}
          </button>
          <button
            onClick={handlePing}
            disabled={probing}
            style={{
              padding: '6px 12px', borderRadius: 6,
              border: '1px solid #cbd5e1', background: '#fff', cursor: 'pointer',
              fontSize: 12,
            }}
            title="Test de conectividad — verifica que la función responde y los secrets están seteados, sin tocar la BD del bot"
          >
            📡 Ping
          </button>
        </div>

        {/* Backfill manual */}
        <details style={{ marginBottom: 16 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
            Backfill manual (rango de fechas)
          </summary>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 8, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 2 }}>
              Desde
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
            </label>
            <label style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 2 }}>
              Hasta
              <input type="date" value={to} onChange={e => setTo(e.target.value)} />
            </label>
            <label style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 2 }}>
              Límite
              <input
                type="number" min="100" max="50000" step="500"
                value={limit} onChange={e => setLimit(e.target.value)}
                style={{ width: 100 }}
              />
            </label>
            <button
              onClick={() => from && to ? handleSync({ from, to, limit: Number(limit) }) : toast.warn('Indica fecha desde y hasta')}
              disabled={running || !from || !to}
              style={{
                padding: '6px 12px', borderRadius: 6,
                border: '1px solid #f59e0b', background: '#fef3c7', color: '#78350f',
                cursor: running ? 'default' : 'pointer', fontSize: 12, fontWeight: 600,
              }}
            >
              Backfill
            </button>
          </div>
          <p style={{ fontSize: 11, color: '#888', marginTop: 6 }}>
            ⚠ El backfill ignora el watermark. Si el rango se solapa con data ya ingestada, puede generar duplicados.
          </p>
        </details>

        {/* Probe results */}
        {probeData && (
          <div style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 14, marginBottom: 6 }}>
              Esquema de <code>quotes_output</code> ({probeData.columns.length} columnas)
            </h3>
            <div style={{
              background: '#0f172a', color: '#e2e8f0', padding: 10, borderRadius: 6,
              fontSize: 11, fontFamily: 'monospace', overflowX: 'auto', maxHeight: 220,
            }}>
              {probeData.columns.map(c => (
                <div key={c.column_name}>
                  <span style={{ color: '#7dd3fc' }}>{c.column_name}</span>{' '}
                  <span style={{ color: '#94a3b8' }}>{c.data_type}</span>
                </div>
              ))}
            </div>
            {probeData.sample.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: 'pointer', fontSize: 12 }}>Filas de muestra ({probeData.sample.length})</summary>
                <pre style={{
                  background: '#fafafa', border: '1px solid #e5e7eb', borderRadius: 6,
                  padding: 10, fontSize: 10, maxHeight: 280, overflow: 'auto',
                }}>
                  {JSON.stringify(probeData.sample, null, 2)}
                </pre>
              </details>
            )}
          </div>
        )}

        {/* Log de corridas */}
        <h3 style={{ fontSize: 14, marginBottom: 6 }}>Últimas corridas</h3>
        {loadingLog ? (
          <SkeletonTable rows={4} cols={6} />
        ) : logRows.length === 0 ? (
          <EmptyState icon="📜" title="Sin corridas todavía" message="Haz clic en Sync incremental para ingestar las primeras filas." compact />
        ) : (
          <table className="config-table" style={{ marginTop: 4 }}>
            <thead>
              <tr>
                <th>Inicio</th>
                <th>Estado</th>
                <th style={{ textAlign: 'right' }}>Leídas</th>
                <th style={{ textAlign: 'right' }}>Insertadas</th>
                <th style={{ textAlign: 'right' }}>Descartadas</th>
                <th style={{ textAlign: 'right' }}>Outliers</th>
                <th style={{ textAlign: 'left' }}>Error</th>
              </tr>
            </thead>
            <tbody>
              {logRows.map(r => (
                <tr key={r.id}>
                  <td style={{ fontSize: 11 }}>{new Date(r.started_at).toLocaleString()}</td>
                  <td>
                    <span style={{
                      padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
                      background: r.status === 'ok' ? '#d1fae5' : r.status === 'error' ? '#fee2e2' : '#e0e7ff',
                      color:      r.status === 'ok' ? '#065f46' : r.status === 'error' ? '#991b1b' : '#3730a3',
                    }}>
                      {r.status}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>{r.read_count?.toLocaleString() ?? '—'}</td>
                  <td style={{ textAlign: 'right', color: '#065f46' }}>{r.inserted_count?.toLocaleString() ?? '—'}</td>
                  <td style={{ textAlign: 'right', color: '#92400e' }}>{r.dropped_count?.toLocaleString() ?? '—'}</td>
                  <td style={{ textAlign: 'right', color: '#991b1b' }}>{r.outlier_count?.toLocaleString() ?? '—'}</td>
                  <td style={{ fontSize: 10, color: '#991b1b', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}
                      title={r.error_msg || ''}>
                    {r.error_msg || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
