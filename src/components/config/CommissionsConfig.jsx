import { useMemo, useState } from 'react'
import { Percent, Plus, Trash2, Save } from 'lucide-react'
import { useCompetitorCommissions } from '../../hooks/useCompetitorCommissions'
import { getCountryConfig, COMPETITOR_COLORS } from '../../lib/constants'
import { Combobox } from '../ui/shadcn/combobox'
import SaveStatusBanner from './SaveStatusBanner'
import { useConfirm } from '../ui/ConfirmDialog'

const ALL_COMPETITORS = Object.keys(COMPETITOR_COLORS)

const DIRTY_STYLE = {
  background: '#fef3c7',
  borderColor: '#f59e0b',
  fontWeight: 600,
  boxShadow: '0 0 0 2px rgba(245, 158, 11, 0.2)',
}

// Variante sin boxShadow para triggers de Combobox: el boxShadow inline
// estático taparía siempre el anillo de :focus-visible (Tailwind, también
// box-shadow) — con esta variante el fondo/borde amarillo sigue marcando
// "dirty" pero el foco de teclado sigue siendo visible al tabular.
const DIRTY_TRIGGER_STYLE = {
  background: DIRTY_STYLE.background,
  borderColor: DIRTY_STYLE.borderColor,
  fontWeight: DIRTY_STYLE.fontWeight,
}

export default function CommissionsConfig({ country }) {
  const config = getCountryConfig(country)
  const confirm = useConfirm()

  const competitorItems = useMemo(
    () => ALL_COMPETITORS.map((c) => ({ value: c, label: c, color: COMPETITOR_COLORS[c] })),
    []
  )
  // Sentinel no-vacío para "Todas las ciudades": cmdk usa un chequeo de
  // truthiness sobre `value` para su búsqueda/typeahead — un CommandItem con
  // value:'' queda con score de búsqueda fijo en 0 (nunca aparece al filtrar)
  // y no puede marcarse como "resaltado" para navegación por teclado. `null`
  // (el valor real en BD) se traduce a este sentinel solo para el picker.
  const ALL_CITIES_SENTINEL = '__all__'
  const cityItems = useMemo(
    () => [
      { value: ALL_CITIES_SENTINEL, label: 'Todas las ciudades' },
      ...config.dbCities.map((c) => ({ value: c, label: c })),
    ],
    [config]
  )

  const { allRows, loading, saveCommission, deleteCommission, addRow } = useCompetitorCommissions(
    null,
    country
  )
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)
  const [edits, setEdits] = useState({})

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
    setSaving(true)
    setMsg(null)
    const merged = { ...row, ...edits[row.id] }
    const ok = await saveCommission(merged)
    if (ok) {
      setEdits((prev) => {
        const n = { ...prev }
        delete n[row.id]
        return n
      })
      const cityLabel = merged.city || 'Todas las ciudades'
      setMsg({
        type: 'ok',
        text: `Guardado: ${merged.competitor_name} (${cityLabel}) — ${merged.commission_pct}%`,
      })
    } else {
      setMsg({
        type: 'err',
        text: 'Error al guardar. Verifica que el competidor no esté duplicado en la misma ciudad.',
      })
    }
    setSaving(false)
  }

  async function handleDelete(row) {
    if (!String(row.id).startsWith('new_')) {
      const confirmed = await confirm({
        title: 'Eliminar comisión',
        message: '¿Eliminar esta comisión?',
        danger: true,
        confirmText: 'Eliminar',
      })
      if (!confirmed) return
    }
    const ok = await deleteCommission(row.id)
    if (!ok) setMsg({ type: 'err', text: 'No se pudo eliminar.' })
    else if (!String(row.id).startsWith('new_')) setMsg({ type: 'ok', text: 'Comisión eliminada.' })
  }

  if (loading) return <div className="config-loading">Cargando comisiones…</div>

  return (
    <div className="config-section">
      <h2 className="with-icon">
        <Percent size={15} />
        Comisiones por Competidor
      </h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        Define el porcentaje de comisión que cobra cada app al conductor. Puedes tener un valor
        global (Todas las ciudades) o sobrescribirlo por ciudad.
      </p>

      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      <table className="config-table config-table--modern" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th scope="col">Competidor</th>
            <th scope="col">Ciudad</th>
            <th scope="col">Comisión %</th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          {allRows.map((row) => {
            const dirty = isDirty(row.id) || isNew(row)
            const cellStyle = dirty ? DIRTY_STYLE : undefined
            const triggerStyle = dirty ? DIRTY_TRIGGER_STYLE : undefined
            return (
              <tr key={row.id} style={dirty ? { background: '#fffbeb' } : undefined}>
                <td style={{ textAlign: 'left', minWidth: 170 }}>
                  <Combobox
                    items={competitorItems}
                    value={getField(row, 'competitor_name') || ''}
                    onValueChange={(v) => setField(row.id, 'competitor_name', v)}
                    placeholder="— Seleccionar —"
                    searchPlaceholder="Buscar competidor…"
                    emptyText="Sin resultados."
                    triggerClassName="text-xs"
                    style={triggerStyle}
                  />
                </td>
                <td style={{ textAlign: 'left', minWidth: 160 }}>
                  <Combobox
                    items={cityItems}
                    value={getField(row, 'city') || ALL_CITIES_SENTINEL}
                    onValueChange={(v) =>
                      setField(row.id, 'city', v === ALL_CITIES_SENTINEL ? null : v)
                    }
                    searchPlaceholder="Buscar ciudad…"
                    emptyText="Sin resultados."
                    triggerClassName="text-xs"
                    style={triggerStyle}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.5"
                    value={getField(row, 'commission_pct')}
                    onChange={(e) => setField(row.id, 'commission_pct', e.target.value)}
                    style={{ width: 80, textAlign: 'right', ...(cellStyle || {}) }}
                  />
                </td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="btn-save-sm"
                    onClick={() => handleSave(row)}
                    disabled={saving || !dirty}
                    title={!dirty ? 'Sin cambios' : undefined}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    <Save size={11} />
                    {isNew(row) ? 'Crear' : 'Guardar'}
                  </button>
                  <button
                    className="btn-delete-sm"
                    aria-label="Eliminar"
                    title="Eliminar"
                    onClick={() => handleDelete(row)}
                  >
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <button
        className="btn-add-row"
        onClick={addRow}
        style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <Plus size={13} />
        Agregar comisión
      </button>
    </div>
  )
}
