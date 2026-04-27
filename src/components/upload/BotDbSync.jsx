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
  const [watermark, setWatermark] = useState(null)
  const [logRows, setLogRows]     = useState([])
  const [loadingLog, setLoadingLog] = useState(true)
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

  // Sync via GitHub Actions — dispara el workflow Bot Sync.
  // El sync corre en infraestructura de GitHub (no en Supabase) porque
  // helioho.st es muy lento para queries en vivo desde Supabase.
  async function handleSync() {
    setRunning(true)
    try {
      const { data: { session } } = await sb.auth.getSession()
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
      const anonKey     = import.meta.env.VITE_SUPABASE_ANON_KEY
      const res = await fetch(`${supabaseUrl}/functions/v1/trigger-bot-sync`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'apikey':        anonKey,
          'Authorization': session?.access_token ? `Bearer ${session.access_token}` : `Bearer ${anonKey}`,
        },
        body: JSON.stringify({
          limit:      Number(limit) || 5000,
          probe_only: false,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json?.ok === false) {
        const hint = json?.hint ? ` (${json.hint})` : ''
        throw new Error((json?.error || `HTTP ${res.status}`) + hint)
      }
      toast.ok(
        '⚡ Workflow disparado. La corrida tarda ~30-60s en aparecer en "Últimas corridas". Auto-refresh en 60s.',
        { duration: 8000 }
      )
      // Auto-refresh la tabla de corridas en 60s
      setTimeout(() => reload(), 60_000)
    } catch (e) {
      toast.err(`No se pudo disparar el sync: ${e.message}`, { duration: 12000 })
    } finally {
      setRunning(false)
    }
  }

  // Dispara el workflow en modo probe (lista columnas, no inserta nada).
  // Útil para confirmar que el job de GitHub Actions sigue funcionando
  // sin meter data nueva.
  async function handleProbe() {
    setProbing(true)
    try {
      const { data: { session } } = await sb.auth.getSession()
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
      const anonKey     = import.meta.env.VITE_SUPABASE_ANON_KEY
      const res = await fetch(`${supabaseUrl}/functions/v1/trigger-bot-sync`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'apikey':        anonKey,
          'Authorization': session?.access_token ? `Bearer ${session.access_token}` : `Bearer ${anonKey}`,
        },
        body: JSON.stringify({ limit: 100, probe_only: true }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error || `HTTP ${res.status}`)
      }
      toast.ok('🔍 Probe disparado. Revisa el log del run en GitHub Actions en ~30s.', { duration: 7000 })
    } catch (e) {
      toast.err(`No se pudo disparar el probe: ${e.message}`, { duration: 10000 })
    } finally {
      setProbing(false)
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="config-section">
        <h2>Sincronización directa con la BD del bot</h2>
        <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
          Lee filas nuevas desde <code>quotes_output</code> en la BD del bot y las
          inserta en <code>pricing_observations</code> aplicando los mismos filtros
          (filas vacías, montos fuera de rango) que el upload manual.
        </p>

        <div style={{
          marginBottom: 14, padding: 12, borderRadius: 8,
          background: '#ecfdf5', border: '1px solid #10b981', fontSize: 12, color: '#065f46',
        }}>
          <strong>✓ Modo GitHub Actions activado</strong> — el workflow{' '}
          <code>bot-sync</code> lee filas nuevas desde <code>fudobi.helioho.st</code>,
          aplica los <em>botRules</em> y los <em>price_validation_rules</em>
          configurados en este dashboard, e inserta solo las que pasan los filtros
          en <code>pricing_observations</code>. Corre automáticamente cada{' '}
          <strong>30 minutos</strong>. Click en <strong>⚡ Disparar sync ahora</strong>{' '}
          para forzar una corrida sin esperar.
        </div>

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
            title="Dispara el workflow de GitHub Actions Bot Sync con el límite indicado"
          >
            {running ? 'Disparando…' : '⚡ Disparar sync ahora'}
          </button>
          <button
            onClick={handleProbe}
            disabled={probing}
            style={{
              padding: '6px 12px', borderRadius: 6,
              border: '1px solid #cbd5e1', background: '#fff', cursor: 'pointer',
              fontSize: 12,
            }}
            title="Dispara el workflow en modo probe (lista columnas, no inserta nada). Útil para test."
          >
            {probing ? 'Disparando…' : '🔍 Probe'}
          </button>
          <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
            Límite por corrida
            <input
              type="number" min="1000" max="100000" step="1000"
              value={limit} onChange={e => setLimit(e.target.value)}
              style={{ width: 100 }}
            />
          </label>
        </div>

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
