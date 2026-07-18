import { useState, useMemo, useEffect } from 'react'
import { Percent, Plus, Trash2, Save } from 'lucide-react'
import { useCompetitiveBands } from '../../hooks/useCompetitiveBands'
import { useCompetitiveBandAnalysis } from '../../hooks/useCompetitiveBandAnalysis'
import { useConfigContext } from '../../context/ConfigProvider'
import { getCountryConfig, COMPETITOR_COLORS } from '../../lib/constants'
import { Combobox } from '../ui/shadcn/combobox'
import SaveStatusBanner from './SaveStatusBanner'
import { useConfirm } from '../ui/ConfirmDialog'
import { Button } from '../ui/shadcn/button'

const DIRTY_STYLE = {
  background: '#fef3c7',
  borderColor: '#f59e0b',
  fontWeight: 600,
  boxShadow: '0 0 0 2px rgba(245, 158, 11, 0.2)',
}
// Sin boxShadow (ver BotRulesTable/CommissionsConfig): el boxShadow inline
// estático tapa el anillo de :focus-visible de los triggers Combobox.
const DIRTY_TRIGGER_STYLE = {
  background: DIRTY_STYLE.background,
  borderColor: DIRTY_STYLE.borderColor,
  fontWeight: DIRTY_STYLE.fontWeight,
}

// Preview en vivo: mientras el usuario tipea min/max%, muestra qué % de las
// cotizaciones reales caería "dentro de banda" hoy — sin necesidad de
// guardar primero (la RPC recibe min/max como parámetro).
function BandPreviewCell({ country, competitorName, category, minPct, maxPct }) {
  const [debounced, setDebounced] = useState({ minPct, maxPct })
  useEffect(() => {
    const t = setTimeout(() => setDebounced({ minPct, maxPct }), 400)
    return () => clearTimeout(t)
  }, [minPct, maxPct])

  // includeBreakdown=false: el preview solo necesita el resumen, no vale la
  // pena pedir el desglose ciudad×bracket (la RPC más cara de las dos) por
  // cada una de las N filas de la tabla en cada carga de la página.
  const { summary, loading } = useCompetitiveBandAnalysis({
    country,
    competitorName,
    category,
    minPct: debounced.minPct,
    maxPct: debounced.maxPct,
    includeBreakdown: false,
  })

  if (!competitorName || !category) {
    return <span style={{ color: '#9ca3af', fontSize: 11 }}>Elegí competidor y categoría</span>
  }
  if (loading && !summary)
    return <span style={{ color: '#9ca3af', fontSize: 11 }}>Calculando…</span>
  if (!summary || !summary.total_observations) {
    return <span style={{ color: '#9ca3af', fontSize: 11 }}>Sin datos</span>
  }
  const withinPct = Number(summary.within_pct)
  const color = withinPct >= 50 ? '#166534' : withinPct >= 25 ? '#92400e' : '#991b1b'
  return (
    <span
      style={{ fontSize: 12, fontWeight: 700, color }}
      title={`${summary.total_observations} cotizaciones · ${summary.below_pct}% debajo · ${summary.above_pct}% encima`}
    >
      {withinPct}% dentro
    </span>
  )
}

export default function CompetitiveBandsConfig({ country }) {
  const config = getCountryConfig(country)
  const confirm = useConfirm()
  const {
    allRows,
    loading,
    error: loadError,
    saveBand,
    deleteBand,
    addRow,
  } = useCompetitiveBands(country)
  const { refresh: refreshConfig } = useConfigContext()
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)
  const [edits, setEdits] = useState({})

  // Competidores válidos = NUNCA sub-marcas de Yango (constraint en BD).
  const competitorItems = useMemo(
    () =>
      Object.keys(COMPETITOR_COLORS)
        .filter((c) => !c.toLowerCase().startsWith('yango') && !c.includes(' '))
        .sort()
        .map((c) => ({ value: c, label: c, color: COMPETITOR_COLORS[c] })),
    []
  )
  // Categorías del país, deduplicadas, excluyendo Corp (fuera de scope v1).
  const categoryItems = useMemo(() => {
    const cats = new Set()
    Object.values(config.categoriesByCity || {}).forEach((list) => list.forEach((c) => cats.add(c)))
    cats.delete('Corp')
    return Array.from(cats)
      .sort()
      .map((c) => ({ value: c, label: c }))
  }, [config])

  function getField(row, field) {
    return edits[row.id]?.[field] ?? row[field] ?? ''
  }
  function setField(id, field, val) {
    setMsg(null)
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], [field]: val } }))
  }
  const isDirty = (id) => !!edits[id] && Object.keys(edits[id]).length > 0
  const isNew = (row) => String(row.id).startsWith('new_')

  async function handleSave(row) {
    const merged = { ...row, ...edits[row.id] }
    if (!merged.competitor_name || !merged.category) {
      setMsg({ type: 'err', text: 'Elegí competidor y categoría.' })
      return
    }
    if (Number(merged.min_pct) >= Number(merged.max_pct)) {
      setMsg({ type: 'err', text: 'El piso (min%) debe ser menor que el techo (max%).' })
      return
    }
    setSaving(true)
    setMsg(null)
    const errMsg = await saveBand(merged)
    if (!errMsg) {
      setEdits((prev) => {
        const n = { ...prev }
        delete n[row.id]
        return n
      })
      setMsg({
        type: 'ok',
        text: `Guardado: ${merged.competitor_name} / ${merged.category} → banda ${merged.min_pct}% a ${merged.max_pct}%`,
      })
      // Refresh inmediato: no depender solo del round-trip de live-sync
      // (audit_log → realtime → debounce 500ms) para que la propia sesión
      // vea el cambio reflejado al instante en Análisis → Competitividad.
      refreshConfig()
    } else {
      setMsg({ type: 'err', text: 'Error al guardar: ' + errMsg })
    }
    setSaving(false)
  }

  async function handleDelete(row) {
    if (!isNew(row)) {
      const ok = await confirm({
        title: 'Eliminar banda competitiva',
        message: '¿Eliminar esta banda? La página de Competitividad dejará de mostrarla.',
        danger: true,
        confirmText: 'Eliminar',
      })
      if (!ok) return
    }
    const ok = await deleteBand(row.id)
    if (!ok) setMsg({ type: 'err', text: 'No se pudo eliminar.' })
    else {
      if (!isNew(row)) setMsg({ type: 'ok', text: 'Banda eliminada.' })
      refreshConfig()
    }
  }

  if (loading) return <div className="config-loading">Cargando bandas competitivas…</div>

  return (
    <div className="config-section">
      <h2 className="with-icon">
        <Percent size={15} />
        Bandas competitivas
      </h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        Define el rango de Δ% aceptable de Yango vs un competidor, por categoría — aplica a{' '}
        <strong>todas las ciudades y distancias a la vez</strong>. Δ% = (Yango − Rival) / Rival ×
        100: negativo = Yango más barato. Ej: min −15, max −5 = "Yango entre 5% y 15% más barato que
        el rival". El desglose por ciudad/distancia está disponible en Análisis → Competitividad.
      </p>

      {loadError && <div className="state-box state-box--error">Error: {loadError}</div>}
      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      <table className="config-table config-table--modern" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th scope="col">Competidor</th>
            <th scope="col">Categoría</th>
            <th scope="col" title="Piso de Δ%">
              Min %
            </th>
            <th scope="col" title="Techo de Δ%">
              Max %
            </th>
            <th style={{ textAlign: 'left', minWidth: 160 }}>Nota</th>
            <th scope="col">Activa</th>
            <th scope="col" title="Con la banda actual, % de cotizaciones reales dentro de rango">
              Hoy
            </th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          {allRows.map((row) => {
            const dirty = isDirty(row.id) || isNew(row)
            const minPct = Number(getField(row, 'min_pct'))
            const maxPct = Number(getField(row, 'max_pct'))
            return (
              <tr key={row.id} style={dirty ? { background: '#fffbeb' } : undefined}>
                <td style={{ textAlign: 'left', minWidth: 160 }}>
                  <Combobox
                    items={competitorItems}
                    value={getField(row, 'competitor_name') || ''}
                    onValueChange={(v) => setField(row.id, 'competitor_name', v)}
                    placeholder="— Elegir —"
                    searchPlaceholder="Buscar competidor…"
                    emptyText="Sin resultados."
                    triggerClassName="text-xs"
                    style={dirty ? DIRTY_TRIGGER_STYLE : undefined}
                  />
                </td>
                <td style={{ textAlign: 'left', minWidth: 150 }}>
                  <Combobox
                    items={categoryItems}
                    value={getField(row, 'category') || ''}
                    onValueChange={(v) => setField(row.id, 'category', v)}
                    placeholder="— Elegir —"
                    searchPlaceholder="Buscar categoría…"
                    emptyText="Sin resultados."
                    triggerClassName="text-xs"
                    style={dirty ? DIRTY_TRIGGER_STYLE : undefined}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.5"
                    value={getField(row, 'min_pct')}
                    onChange={(e) => setField(row.id, 'min_pct', e.target.value)}
                    style={{ width: 70, textAlign: 'right', ...(dirty ? DIRTY_STYLE : {}) }}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.5"
                    value={getField(row, 'max_pct')}
                    onChange={(e) => setField(row.id, 'max_pct', e.target.value)}
                    style={{ width: 70, textAlign: 'right', ...(dirty ? DIRTY_STYLE : {}) }}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={getField(row, 'note')}
                    onChange={(e) => setField(row.id, 'note', e.target.value)}
                    placeholder="ej: definido con MSI 07-2026"
                    style={{ width: '100%', ...(dirty ? DIRTY_STYLE : {}) }}
                  />
                </td>
                <td style={{ textAlign: 'center' }}>
                  <label
                    className="toggle-switch"
                    title={getField(row, 'is_active') !== false ? 'Activa' : 'Inactiva'}
                  >
                    <input
                      type="checkbox"
                      checked={getField(row, 'is_active') !== false}
                      onChange={(e) => setField(row.id, 'is_active', e.target.checked)}
                    />
                    <span className="toggle-track" />
                  </label>
                </td>
                <td style={{ textAlign: 'center' }}>
                  <BandPreviewCell
                    country={country}
                    competitorName={getField(row, 'competitor_name')}
                    category={getField(row, 'category')}
                    minPct={Number.isFinite(minPct) ? minPct : null}
                    maxPct={Number.isFinite(maxPct) ? maxPct : null}
                  />
                </td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => handleSave(row)}
                    disabled={saving || !dirty}
                    title={!dirty ? 'Sin cambios' : undefined}
                  >
                    <Save size={11} />
                    {isNew(row) ? 'Crear' : 'Guardar'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="border-red-300 text-red-600 hover:bg-red-100"
                    aria-label="Eliminar"
                    title="Eliminar"
                    onClick={() => handleDelete(row)}
                  >
                    <Trash2 size={12} />
                  </Button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2.5 border-dashed border-border text-muted hover:border-yango hover:text-yango"
        onClick={addRow}
      >
        <Plus size={13} />
        Nueva banda
      </Button>
    </div>
  )
}
