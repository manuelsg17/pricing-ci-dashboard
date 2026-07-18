import { useState, useEffect, useMemo } from 'react'
import { BRACKETS, BRACKET_LABELS, getCountryConfig } from '../../lib/constants'
import { SIMPLE_AVG_SINCE } from '../../algorithms/weightedAverage'
import { isoWeekMonday } from '../../lib/dateUtils'
import SaveStatusBanner from './SaveStatusBanner'
import { useConfirm } from '../ui/ConfirmDialog'
import { sb } from '../../lib/supabase'
import { Button } from '../ui/shadcn/button'

// Fechas del corte Ponderado→Simple, derivadas de SIMPLE_AVG_SINCE (sin drift).
const WA_WEIGHTED_UNTIL = isoWeekMonday(
  SIMPLE_AVG_SINCE.year,
  SIMPLE_AVG_SINCE.week - 1
).toLocaleDateString('es-PE', { day: 'numeric', month: 'long', year: 'numeric' })
const WA_SIMPLE_FROM = isoWeekMonday(
  SIMPLE_AVG_SINCE.year,
  SIMPLE_AVG_SINCE.week
).toLocaleDateString('es-PE', { day: 'numeric', month: 'long', year: 'numeric' })

export default function WeightsTable({ weights, onSave, saving, country }) {
  const config = getCountryConfig(country)
  const weightCities = useMemo(() => ['all', ...config.dbCities], [config.dbCities])

  // Lista de categorías disponibles para el país. 'all' es default y
  // siempre presente (representa pesos globales del país, retrocompat
  // con pre mig 56).
  const weightCategories = useMemo(() => {
    const cats = new Set(['all'])
    Object.values(config.categoriesByCity || {}).forEach((list) =>
      (list || []).forEach((c) => cats.add(c))
    )
    return Array.from(cats)
  }, [config.categoriesByCity])

  const [activeCity, setActiveCity] = useState(weightCities[1] || 'all')
  const [activeCategory, setActiveCategory] = useState('all')

  // Reseteo si cambia país
  useEffect(() => {
    if (!weightCities.includes(activeCity)) {
      setActiveCity(weightCities[1] || 'all')
    }
    if (!weightCategories.includes(activeCategory)) {
      setActiveCategory('all')
    }
  }, [country, weightCities, weightCategories, activeCity, activeCategory])

  const [local, setLocal] = useState({})
  const [saveMsg, setSaveMsg] = useState(null)

  const getKey = (city, category, bracket) => `${city}|||${category}|||${bracket}`

  // Lee la fila exacta para (city, category). Sin fallback —
  // la cascada se aplica en buildWeightsMap al consumir, no acá.
  const getDbValue = (bracket) => {
    const row = weights.find(
      (w) =>
        w.city === activeCity && (w.category ?? 'all') === activeCategory && w.bracket === bracket
    )
    return row ? (Number(row.weight) * 100).toFixed(2) : ''
  }

  const getValue = (bracket) => {
    const key = getKey(activeCity, activeCategory, bracket)
    if (key in local) return local[key]
    return getDbValue(bracket)
  }

  const isDirty = (bracket) => {
    const key = getKey(activeCity, activeCategory, bracket)
    if (!(key in local)) return false
    return String(local[key] ?? '') !== String(getDbValue(bracket) ?? '')
  }

  const hasUnsavedChanges = BRACKETS.some((b) => isDirty(b))

  const handleChange = (bracket, val) => {
    setSaveMsg(null)
    setLocal((prev) => ({ ...prev, [getKey(activeCity, activeCategory, bracket)]: val }))
  }

  const handleDiscard = () => {
    setSaveMsg(null)
    setLocal((prev) => {
      const next = { ...prev }
      BRACKETS.forEach((b) => delete next[getKey(activeCity, activeCategory, b)])
      return next
    })
  }

  // Suma total de pesos para validación
  const totalPct = useMemo(() => {
    return BRACKETS.reduce((sum, b) => {
      const v = parseFloat(getValue(b)) || 0
      return sum + v
    }, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, weights, activeCity, activeCategory])

  const totalOk = Math.abs(totalPct - 100) < 0.1

  const confirm = useConfirm()

  const doSave = async (withSnapshot) => {
    setSaveMsg(null)

    const ok = await confirm({
      title: withSnapshot ? '⚠ Cambio de pesos — hard copy requerido' : 'Guardar sin snapshot',
      message: withSnapshot
        ? 'Antes de guardar los nuevos pesos se creará un snapshot (hard copy) ' +
          'de los promedios ponderados actuales para todos los períodos históricos. ' +
          'Esos valores quedarán fijos y no cambiarán con los nuevos pesos.\n\n' +
          '¿Confirmar el snapshot y guardar?'
        : 'Vas a guardar SIN crear snapshot. Los promedios históricos se recalcularán ' +
          'en vivo con los nuevos pesos — los valores anteriores YA NO quedarán fijos.\n\n' +
          'Usar solo si el cambio es pequeño o no afecta data histórica significativa.',
      confirmText: withSnapshot ? 'Crear snapshot y guardar' : 'Guardar sin snapshot',
      cancelText: 'Cancelar',
      danger: withSnapshot,
    })
    if (!ok) return

    if (withSnapshot) {
      const { error: snapErr } = await sb.rpc('freeze_pricing_wa', {
        p_country: country,
        p_label: `Pesos cambiados — ${new Date().toISOString()}`,
      })
      if (snapErr) {
        setSaveMsg({ type: 'err', text: `Error al crear snapshot: ${snapErr.message}` })
        return
      }
    }

    const rows = BRACKETS.map((b) => ({
      city: activeCity,
      category: activeCategory,
      bracket: b,
      weight: (parseFloat(getValue(b)) || 0) / 100,
    }))
    try {
      await onSave(rows)
      const snapNote = withSnapshot ? '(snapshot creado)' : '(sin snapshot)'
      const scopeLabel = `${activeCity === 'all' ? 'Global' : activeCity} / ${activeCategory === 'all' ? 'Todas las categorías' : activeCategory}`
      setSaveMsg({ type: 'ok', text: `Pesos guardados para ${scopeLabel} ${snapNote}.` })
      setLocal((prev) => {
        const next = { ...prev }
        BRACKETS.forEach((b) => delete next[getKey(activeCity, activeCategory, b)])
        return next
      })
    } catch (e) {
      setSaveMsg({ type: 'err', text: 'Error al guardar: ' + e.message })
    }
  }

  const handleSave = () => doSave(true)
  const handleSaveNoSnapshot = () => doSave(false)

  return (
    <div className="config-section">
      <h2>Pesos para Promedio Ponderado (%)</h2>
      <p style={{ fontSize: 11, color: '#888', marginBottom: 10 }}>
        Cada (ciudad × categoría) puede tener pesos distintos. La suma ideal es 100%, pero podés
        guardar con cualquier total — el WA re-normaliza usando solo los brackets con data. Lo que
        importa es la proporción entre brackets, no el total absoluto. Categoría{' '}
        <strong>'all'</strong> aplica como fallback si no hay pesos específicos.
      </p>

      <div
        style={{
          marginBottom: 12,
          padding: '10px 14px',
          borderRadius: 6,
          background: '#dbeafe',
          border: '1px solid #93c5fd',
          color: '#1e3a8a',
          fontSize: 12.5,
          lineHeight: 1.5,
        }}
      >
        ℹ Estos pesos aplican al <strong>Promedio Ponderado histórico</strong> — semanas hasta el{' '}
        <strong>{WA_WEIGHTED_UNTIL}</strong>. Desde el <strong>{WA_SIMPLE_FROM}</strong> el
        dashboard usa <strong>Promedio Simple</strong>, que no utiliza pesos.
        {country === 'Peru' && (
          <>
            {' '}
            En Perú, el histórico usa valores fijados; estos campos son de referencia (Colombia sí
            los usa en vivo).
          </>
        )}
      </div>

      <div className="city-tabs" style={{ marginBottom: 6 }}>
        {weightCities.map((c) => (
          <button
            key={c}
            className={`city-tab${activeCity === c ? ' active' : ''}`}
            onClick={() => setActiveCity(c)}
          >
            {c === 'all' ? 'Global (default)' : c}
          </button>
        ))}
      </div>

      <div
        style={{
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          flexWrap: 'wrap',
          marginBottom: 12,
          fontSize: 12,
        }}
      >
        <strong style={{ marginRight: 4 }}>Categoría:</strong>
        {weightCategories.map((c) => (
          <button
            key={c}
            onClick={() => setActiveCategory(c)}
            style={{
              padding: '4px 10px',
              borderRadius: 14,
              fontSize: 11,
              border: activeCategory === c ? '1.5px solid #2563eb' : '1px solid #cbd5e1',
              background: activeCategory === c ? '#dbeafe' : '#fff',
              color: activeCategory === c ? '#1e3a8a' : '#475569',
              fontWeight: activeCategory === c ? 600 : 400,
              cursor: 'pointer',
            }}
          >
            {c === 'all' ? 'Todas (default)' : c}
          </button>
        ))}
      </div>

      {hasUnsavedChanges && (
        <div
          style={{
            marginTop: 8,
            marginBottom: 12,
            padding: '10px 14px',
            borderRadius: 6,
            background: '#fef3c7',
            border: '1px solid #f59e0b',
            color: '#78350f',
            fontSize: 13,
            fontWeight: 500,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <span>
            ⚠ Hay cambios sin guardar en{' '}
            <strong>
              {activeCity === 'all' ? 'Global' : activeCity} /{' '}
              {activeCategory === 'all' ? 'Todas las categorías' : activeCategory}
            </strong>
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="bg-transparent border-[#b45309] text-[#78350f]"
            onClick={handleDiscard}
          >
            Descartar
          </Button>
        </div>
      )}

      <table className="config-table">
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Bracket</th>
            <th scope="col">Peso (%)</th>
          </tr>
        </thead>
        <tbody>
          {BRACKETS.map((b) => {
            const dirty = isDirty(b)
            return (
              <tr key={b}>
                <td>{BRACKET_LABELS[b]}</td>
                <td>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    value={getValue(b)}
                    onChange={(e) => handleChange(b, e.target.value)}
                    style={
                      dirty
                        ? {
                            background: '#fef3c7',
                            borderColor: '#f59e0b',
                            fontWeight: 600,
                            boxShadow: '0 0 0 2px rgba(245, 158, 11, 0.2)',
                          }
                        : undefined
                    }
                    title={dirty ? `BD: ${getDbValue(b) || '0'}% — sin guardar` : undefined}
                  />
                </td>
              </tr>
            )
          })}
          <tr style={{ background: totalOk ? '#f0fdf4' : '#fffbeb' }}>
            <td style={{ fontWeight: 700 }}>Total</td>
            <td>
              <span
                style={{
                  fontWeight: 700,
                  color: totalOk ? '#15803d' : '#b45309',
                }}
              >
                {totalPct.toFixed(2)}%
                {totalOk ? '' : ' (no es 100% — el WA re-normaliza al guardar)'}
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      <div
        className="config-footer"
        style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
      >
        {/* Primario: sin snapshot — el usuario lo usa frecuentemente */}
        <Button
          onClick={handleSaveNoSnapshot}
          disabled={saving || !hasUnsavedChanges}
          title={
            !hasUnsavedChanges
              ? 'No hay cambios para guardar'
              : !totalOk
                ? `Total = ${totalPct.toFixed(1)}% (no es 100%). El WA re-normaliza con los brackets disponibles — guardás de todos modos.`
                : 'Aplica los nuevos pesos sin crear snapshot. Los promedios históricos se recalculan en vivo.'
          }
        >
          {saving ? 'Guardando…' : 'Guardar cambios'}
        </Button>
        {/* Secundario: con snapshot — para cambios que afectan data histórica significativa */}
        <Button
          variant="outline"
          className="border-slate-300 text-slate-600"
          onClick={handleSave}
          disabled={saving || !hasUnsavedChanges}
          title="Crea snapshot (hard copy) antes de guardar. Útil cuando el cambio afecta data histórica significativa que no querés que se recalcule."
        >
          📸 Guardar con snapshot
        </Button>
        <SaveStatusBanner status={saveMsg} onDismiss={() => setSaveMsg(null)} />
      </div>
    </div>
  )
}
