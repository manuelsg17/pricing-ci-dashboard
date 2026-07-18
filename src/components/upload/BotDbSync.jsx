import { useState, useEffect, useCallback, useRef } from 'react'
import { sb } from '../../lib/supabase'
import { useCountry } from '../../context/CountryContext'
import { useToast } from '../ui/Toast'
import EmptyState from '../ui/EmptyState'
import { SkeletonTable } from '../ui/Skeleton'
import { useConfirm } from '../ui/ConfirmDialog'
import { Button } from '../ui/shadcn/button'

// Mapa de razones que emite scripts/bot-sync/bot_sync_push.py.
// label  = texto del pill en la tabla (corto, español).
// hint   = tooltip al hover (explica QUÉ pasó).
// action = qué hacer si la fila es buena y querés recuperarla.
const REASON_PILLS = {
  no_rule: {
    label: 'sin regla',
    bg: '#fee2e2',
    fg: '#991b1b',
    hint: 'La combinación (app, vc, ovc, ciudad) no existe en Bot Rules. El sync no sabe cómo categorizarla, así que la tira.',
    action: 'Si es data válida, agregá esta combo en Config → Bot Rules.',
  },
  no_price: {
    label: 'sin precio',
    bg: '#fef3c7',
    fg: '#78350f',
    hint: 'El bot no devolvió ningún precio (ni regular ni con descuento). Suele pasar cuando el competidor no respondió.',
    action: 'Nada que hacer — es ruido del bot, no se puede recuperar.',
  },
  incomplete: {
    label: 'incompleta',
    bg: '#fef3c7',
    fg: '#78350f',
    hint: 'Le falta la ciudad o el nombre de la app — no se puede mapear a una ciudad del dashboard.',
    action: 'Si la ciudad existe pero el bot la escribe distinto, agregala al mapeo de ciudades.',
  },
  no_timestamp: {
    label: 'sin fecha',
    bg: '#fef3c7',
    fg: '#78350f',
    hint: 'La fila no trae timestamp_utc. Sin fecha no se puede insertar.',
    action: 'Caso raro — avisanos si aparece seguido.',
  },
  outlier: {
    label: 'precio fuera de rango',
    bg: '#e0e7ff',
    fg: '#3730a3',
    hint: 'El precio supera el máximo definido en Price Rules para esa ciudad/categoría/competidor. Se asume error del bot.',
    action:
      'Si el precio es real (subió la oferta del mercado), subí el max_price en Config → Price Rules.',
  },
}

function renderReason(reason) {
  const p = REASON_PILLS[reason]
  if (!p) return <span style={{ color: '#94a3b8' }}>—</span>
  return (
    <span
      title={`${p.hint}\n\n👉 ${p.action}`}
      style={{
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        background: p.bg,
        color: p.fg,
        whiteSpace: 'nowrap',
        cursor: 'help',
      }}
    >
      {p.label}
    </span>
  )
}

// Agrupa el array dropped_combos por razón y suma filas. Devuelve
// [{ reason, total, pct, hint, action }] ordenado por total desc.
// Sirve para el summary arriba de la tabla — "tus 900 descartes son 100% sin regla"
// es info accionable; "tabla de 1 fila con jerga" no.
function summarizeReasons(combos) {
  const total = combos.reduce((s, c) => s + (c.n || 0), 0)
  if (total === 0) return { total: 0, byReason: [] }
  const map = {}
  for (const c of combos) {
    const k = c.reason || 'unknown'
    map[k] = (map[k] || 0) + (c.n || 0)
  }
  const byReason = Object.entries(map)
    .map(([reason, n]) => ({
      reason,
      n,
      pct: Math.round((n / total) * 100),
      info: REASON_PILLS[reason] || { label: reason, hint: '', action: '' },
    }))
    .sort((a, b) => b.n - a.n)
  return { total, byReason }
}

export default function BotDbSync() {
  const { country } = useCountry()
  const toast = useToast()
  const confirm = useConfirm()
  const [running, setRunning] = useState(false)
  const [probing, setProbing] = useState(false)
  const [watermark, setWatermark] = useState(null)
  const [logRows, setLogRows] = useState([])
  const [loadingLog, setLoadingLog] = useState(true)
  const [limit, setLimit] = useState(5000)
  // Combos (app, vc, ovc, city) que NO matchearon ninguna regla en la
  // última corrida ok. Permiten click-to-add a bot_rules.
  const [droppedCombos, setDroppedCombos] = useState([])
  // Timer del auto-refresh de 60s post-trigger. Lo guardamos para
  // limpiarlo si el componente unmounta antes (evita setState en unmounted).
  const autoRefreshTimerRef = useRef(null)
  useEffect(
    () => () => {
      if (autoRefreshTimerRef.current) clearTimeout(autoRefreshTimerRef.current)
    },
    []
  )

  const reload = useCallback(async () => {
    setLoadingLog(true)
    const [{ data: wm }, { data: log }] = await Promise.all([
      sb.from('bot_sync_watermark').select('*').eq('country', country).maybeSingle(),
      sb
        .from('bot_sync_log')
        .select('*')
        .eq('country', country)
        .order('started_at', { ascending: false })
        .limit(20),
    ])
    setWatermark(wm || null)
    setLogRows(log || [])
    // dropped_combos del último log ok con notes.dropped_combos no null
    const lastWithCombos = (log || []).find(
      (r) =>
        r.status === 'ok' &&
        Array.isArray(r.notes?.dropped_combos) &&
        r.notes.dropped_combos.length > 0
    )
    setDroppedCombos(lastWithCombos?.notes?.dropped_combos || [])
    setLoadingLog(false)
  }, [country])

  // Re-procesar últimos N días: retrocede el watermark vía RPC segura
  // (mig 53). No borra data. Después dispara un sync.
  async function handleResync() {
    const ok = await confirm({
      title: `Re-sincronizar últimos 30 días — ${country}`,
      message:
        'Retrocede el watermark 30 días para re-pedir filas al bot. NO borra observaciones; las nuevas reglas matchearán filas previamente dropeadas. Tarda ~1-2 min.',
      confirmText: 'Re-sincronizar',
    })
    if (!ok) return
    setRunning(true)
    try {
      const { data, error } = await sb.rpc('reset_bot_watermark', {
        p_country: country,
        p_days_back: 30,
      })
      if (error) throw error
      if (data?.ok === false) {
        toast.err(`No se pudo retroceder watermark: ${data.reason}`)
        return
      }
      toast.ok(
        `Watermark retrocedido a ${new Date(data.new).toLocaleDateString()}. Disparando sync…`,
        { duration: 6000 }
      )
      await handleSync()
    } catch (e) {
      toast.err(`Error: ${e.message}`)
    } finally {
      setRunning(false)
    }
  }

  useEffect(() => {
    reload()
  }, [reload])

  // Sync via GitHub Actions — dispara el workflow Bot Sync.
  // El sync corre en infraestructura de GitHub (no en Supabase) porque
  // helioho.st es muy lento para queries en vivo desde Supabase.
  async function handleSync() {
    setRunning(true)
    try {
      const {
        data: { session },
      } = await sb.auth.getSession()
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
      const res = await fetch(`${supabaseUrl}/functions/v1/trigger-bot-sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey,
          Authorization: session?.access_token
            ? `Bearer ${session.access_token}`
            : `Bearer ${anonKey}`,
        },
        body: JSON.stringify({
          limit: Number(limit) || 5000,
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
      // Auto-refresh la tabla de corridas en 60s — guardamos el id en
      // ref por si el user navega antes de que dispare.
      if (autoRefreshTimerRef.current) clearTimeout(autoRefreshTimerRef.current)
      autoRefreshTimerRef.current = setTimeout(() => reload(), 60_000)
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
      const {
        data: { session },
      } = await sb.auth.getSession()
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
      const res = await fetch(`${supabaseUrl}/functions/v1/trigger-bot-sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey,
          Authorization: session?.access_token
            ? `Bearer ${session.access_token}`
            : `Bearer ${anonKey}`,
        },
        body: JSON.stringify({ limit: 100, probe_only: true }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error || `HTTP ${res.status}`)
      }
      toast.ok('🔍 Probe disparado. Revisa el log del run en GitHub Actions en ~30s.', {
        duration: 7000,
      })
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
          Lee filas nuevas desde <code>quotes_output</code> en la BD del bot y las inserta en{' '}
          <code>pricing_observations</code> aplicando los mismos filtros (filas vacías, montos fuera
          de rango) que el upload manual.
        </p>

        <div
          style={{
            marginBottom: 14,
            padding: 12,
            borderRadius: 8,
            background: '#ecfdf5',
            border: '1px solid #10b981',
            fontSize: 12,
            color: '#065f46',
          }}
        >
          <strong>✓ Modo GitHub Actions activado</strong> — el workflow <code>bot-sync</code> lee
          filas nuevas desde <code>fudobi.helioho.st</code>, aplica los <em>botRules</em> y los{' '}
          <em>price_validation_rules</em>
          configurados en este dashboard, e inserta solo las que pasan los filtros en{' '}
          <code>pricing_observations</code>. Corre automáticamente cada <strong>30 minutos</strong>.
          Click en <strong>⚡ Disparar sync ahora</strong> para forzar una corrida sin esperar.
        </div>

        <div
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            background: '#f8fafc',
            padding: 12,
            borderRadius: 8,
            border: '1px solid #e2e8f0',
            marginBottom: 16,
            flexWrap: 'wrap',
          }}
        >
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
          <Button
            onClick={() => handleSync()}
            disabled={running}
            title="Dispara el workflow de GitHub Actions Bot Sync con el límite indicado"
          >
            {running ? 'Disparando…' : '⚡ Disparar sync ahora'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-slate-300"
            onClick={handleProbe}
            disabled={probing}
            title="Dispara el workflow en modo probe (lista columnas, no inserta nada). Útil para test."
          >
            {probing ? 'Disparando…' : '🔍 Probe'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-amber-500 bg-amber-50 text-amber-900 hover:bg-amber-100 hover:text-amber-900"
            onClick={handleResync}
            disabled={running}
            title="Retrocede el watermark 30d y re-pide filas al bot. Útil después de cambiar bot_rules."
          >
            ↺ Re-sync 30d
          </Button>
          <label
            style={{
              fontSize: 11,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginLeft: 'auto',
            }}
          >
            Límite por corrida
            <input
              type="number"
              min="1000"
              max="100000"
              step="1000"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              style={{ width: 100 }}
            />
          </label>
        </div>

        {/* Dropped combos — filas que el sync NO insertó, con breakdown por razón */}
        {droppedCombos.length > 0 &&
          (() => {
            const { total, byReason } = summarizeReasons(droppedCombos)
            return (
              <div
                style={{
                  marginBottom: 16,
                  padding: 12,
                  borderRadius: 8,
                  background: '#fef3c7',
                  border: '1px solid #f59e0b',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, color: '#78350f', marginBottom: 8 }}>
                  ⚠ El sync descartó {total.toLocaleString()} filas en la última corrida
                </div>

                {/* Breakdown por razón — la info más accionable */}
                <div style={{ fontSize: 11, color: '#78350f', marginBottom: 10 }}>
                  <div style={{ marginBottom: 6, fontWeight: 600 }}>¿Por qué?</div>
                  <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                    {byReason.map((r) => (
                      <li key={r.reason}>
                        <strong>
                          {r.n.toLocaleString()} filas ({r.pct}%)
                        </strong>{' '}
                        — {r.info.label}. <span style={{ color: '#92400e' }}>{r.info.hint}</span>{' '}
                        <em>{r.info.action}</em>
                      </li>
                    ))}
                  </ul>
                </div>

                <div style={{ fontSize: 11, color: '#92400e', marginBottom: 8, fontWeight: 600 }}>
                  Detalle por combinación (top {Math.min(droppedCombos.length, 30)}):
                </div>
                <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                  <table className="config-table" style={{ fontSize: 11 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left' }} title="Por qué la fila fue descartada">
                          razón
                        </th>
                        <th
                          style={{ textAlign: 'left' }}
                          title="Nombre de la app como la reporta el bot (ej. yango_api, indrive_api)"
                        >
                          app (bot)
                        </th>
                        <th
                          style={{ textAlign: 'left' }}
                          title="vehicle_category — categoría que declara el competidor (ej. economy, comfort, premium)"
                        >
                          cat. declarada
                        </th>
                        <th
                          style={{ textAlign: 'left' }}
                          title="observed_vehicle_category — categoría que el bot deduce mirando el vehículo realmente ofrecido. Suele ser más precisa."
                        >
                          cat. observada
                        </th>
                        <th style={{ textAlign: 'left' }}>ciudad</th>
                        <th
                          style={{ textAlign: 'right' }}
                          title="Cantidad de filas con esta combinación descartadas en la última corrida"
                        >
                          filas
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {droppedCombos.slice(0, 30).map((c, i) => (
                        <tr key={i}>
                          <td>{renderReason(c.reason)}</td>
                          <td>
                            <code>{c.app || '∅'}</code>
                          </td>
                          <td>
                            <code>{c.vc || '∅'}</code>
                          </td>
                          <td>
                            <code>{c.ovc || '*'}</code>
                          </td>
                          <td>{c.db_city || '∅'}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600 }}>
                            {c.n?.toLocaleString() || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div style={{ fontSize: 10, color: '#92400e', marginTop: 8, fontStyle: 'italic' }}>
                  Hovereá el pill de la razón para ver qué hacer en cada caso. Después de cambiar
                  reglas, corré <strong>↺ Re-sync 30d</strong> para re-procesar el histórico.
                </div>
              </div>
            )
          })()}

        {/* Log de corridas */}
        <h3 style={{ fontSize: 14, marginBottom: 6 }}>Últimas corridas</h3>
        {loadingLog ? (
          <SkeletonTable rows={4} cols={6} />
        ) : logRows.length === 0 ? (
          <EmptyState
            icon="📜"
            title="Sin corridas todavía"
            message="Haz clic en Sync incremental para ingestar las primeras filas."
            compact
          />
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
              {logRows.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontSize: 11 }}>{new Date(r.started_at).toLocaleString()}</td>
                  <td>
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: 4,
                        fontSize: 11,
                        fontWeight: 600,
                        background:
                          r.status === 'ok'
                            ? '#d1fae5'
                            : r.status === 'error'
                              ? '#fee2e2'
                              : '#e0e7ff',
                        color:
                          r.status === 'ok'
                            ? '#065f46'
                            : r.status === 'error'
                              ? '#991b1b'
                              : '#3730a3',
                      }}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>{r.read_count?.toLocaleString() ?? '—'}</td>
                  <td style={{ textAlign: 'right', color: '#065f46' }}>
                    {r.inserted_count?.toLocaleString() ?? '—'}
                  </td>
                  <td style={{ textAlign: 'right', color: '#92400e' }}>
                    {r.dropped_count?.toLocaleString() ?? '—'}
                  </td>
                  <td style={{ textAlign: 'right', color: '#991b1b' }}>
                    {r.outlier_count?.toLocaleString() ?? '—'}
                  </td>
                  <td
                    style={{
                      fontSize: 10,
                      color: '#991b1b',
                      maxWidth: 280,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                    title={r.error_msg || ''}
                  >
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
