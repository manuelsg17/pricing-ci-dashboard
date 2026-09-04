import { useState, useEffect, useCallback, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { isValidOn } from '../lib/competitorBonus'
import { toISODate } from '../lib/dateUtils'

// `asOf` (opcional): fecha ISO 'YYYY-MM-DD' o rango { from, to } inclusive.
// Trae solo los bonos VIGENTES en ese momento/semana (mig 237). Sin asOf trae
// todas las versiones — es lo que usa la pantalla de Config para el historial.
export function useCompetitorBonuses(city, country, asOf = null) {
  const [allRows, setAllRows] = useState([])
  const [loading, setLoading] = useState(true)

  const [error, setError] = useState(null)
  const asOfFrom = asOf ? (typeof asOf === 'string' ? asOf : asOf.from) : null
  const asOfTo = asOf ? (typeof asOf === 'string' ? asOf : asOf.to) : null

  const load = useCallback(async () => {
    if (!country) return
    setLoading(true)
    setError(null)
    let q = sb.from('competitor_bonuses').select('*').eq('country', country)
    // Solape de intervalos: empieza antes del fin de la ventana Y no terminó antes del inicio.
    if (asOfFrom && asOfTo)
      q = q.lte('valid_from', asOfTo).or(`valid_to.is.null,valid_to.gte.${asOfFrom}`)
    const { data, error: e } = await q.order('competitor_name').order('sort_order').order('id')
    if (e) setError(e.message)
    else if (data) setAllRows(data)
    setLoading(false)
  }, [country, asOfFrom, asOfTo])

  useEffect(() => {
    load()
  }, [load])

  // Returns active bonuses relevant to the city (global + city-specific), grouped by competitor
  const bonuses = useMemo(() => {
    const result = {}
    for (const row of allRows) {
      if (!row.is_active) continue
      if (row.city !== null && row.city !== undefined && row.city !== city) continue
      if (!isValidOn(row, asOfFrom ? { from: asOfFrom, to: asOfTo } : null)) continue
      if (!result[row.competitor_name]) result[row.competitor_name] = []
      result[row.competitor_name].push(row)
    }
    return result
  }, [allRows, city, asOfFrom, asOfTo])

  const buildPayload = useCallback(
    (row) => {
      const numOrNull = (v) => (v === '' || v == null ? null : Number(v))
      return {
        competitor_name: row.competitor_name,
        city: row.city || null,
        category: row.category || null, // null = todas las categorías
        country,
        bonus_type: row.bonus_type || 'viajes',
        threshold: Number(row.threshold) || 0,
        bonus_amount: Number(row.bonus_amount) || 0,
        description: row.description || null,
        sort_order: Number(row.sort_order) || 0,
        is_active: row.is_active ?? true,
        // mig 110 — mecanismos
        mechanism: row.mechanism || 'flat',
        tiers:
          row.mechanism === 'tiered' && Array.isArray(row.tiers)
            ? row.tiers
                .filter((t) => t && t.threshold !== '' && t.threshold != null)
                .map((t) => ({ threshold: Number(t.threshold), reward: Number(t.reward) || 0 }))
            : row.mechanism === 'gmv_tiered' && Array.isArray(row.tiers)
              ? row.tiers
                  .filter((t) => t && t.threshold !== '' && t.threshold != null)
                  .map((t) => ({
                    threshold: Number(t.threshold),
                    pct: Number(t.pct) || 0,
                    cap: numOrNull(t.cap),
                  }))
              : null,
        segment: row.segment || 'all',
        recurring: row.recurring ?? true,
        group_key: row.group_key || null,
        is_chosen: row.is_chosen ?? true,
        comm_pct: numOrNull(row.comm_pct),
        // share es fracción 0..1; si tipean un % (ej. 25) lo interpretamos
        // como 25% — es siempre la intención del usuario.
        share_in_window: (() => {
          const s = numOrNull(row.share_in_window)
          if (s == null) return null
          return s > 1 ? Math.min(1, s / 100) : Math.max(0, s)
        })(),
        cap_amount: numOrNull(row.cap_amount),
        mult_pct: numOrNull(row.mult_pct),
        streak_spec: row.mechanism === 'streak' ? row.streak_spec || null : null,
        day_window: row.day_window || null,
        time_from: row.time_from || null,
        time_to: row.time_to || null,
        zone: row.zone || null,
        // mig 237 — vigencia y procedencia. valid_from se valida antes (saveBonus):
        // un campo vaciado por error NO debe convertirse en "hoy" y borrar el histórico.
        valid_from: row.valid_from,
        valid_to: row.valid_to || null,
        source_type: row.source_type || 'captura',
        source_ref: row.source_ref || null,
        reported_week: row.reported_week || null,
        updated_at: new Date().toISOString(),
      }
    },
    [country]
  )

  // Guardado "en el lugar": crea una fila nueva o corrige la versión actual
  // (typo, tope mal cargado). Para un cambio de condiciones que rige desde
  // otra fecha, usar newVersion — así queda el historial.
  const saveBonus = useCallback(
    async (row) => {
      if (!row.valid_from) {
        setError('valid_from')
        return false
      }
      const payload = buildPayload(row)
      let err
      if (String(row.id).startsWith('new_')) {
        ;({ error: err } = await sb.from('competitor_bonuses').insert(payload))
      } else {
        ;({ error: err } = await sb.from('competitor_bonuses').update(payload).eq('id', row.id))
      }
      if (!err) await load()
      return !err
    },
    [load, buildPayload]
  )

  // Versionado atómico (RPC mig 237): cierra la versión vigente el día
  // anterior a `validFrom` e inserta la copia con `changes` (el payload
  // completo de la tarjeta ya editada). Si la tarjeta tenía un "hasta", se
  // respeta como fin de la versión nueva (p_valid_to). Devuelve { ok, error }.
  const newVersion = useCallback(
    async (row, validFrom) => {
      const changes = buildPayload(row)
      delete changes.country
      delete changes.valid_from
      delete changes.valid_to
      delete changes.updated_at
      const { error: e } = await sb.rpc('competitor_bonus_new_version', {
        p_id: row.id,
        p_valid_from: validFrom,
        p_changes: changes,
        p_valid_to: row.valid_to && String(row.valid_to) >= validFrom ? row.valid_to : null,
      })
      if (!e) await load()
      return { ok: !e, error: e?.message || null, code: e?.code || null }
    },
    [load, buildPayload]
  )

  const deleteBonus = useCallback(
    async (id) => {
      if (String(id).startsWith('new_')) {
        setAllRows((prev) => prev.filter((r) => r.id !== id))
        return true
      }
      const { error } = await sb.from('competitor_bonuses').delete().eq('id', id)
      if (!error) await load()
      return !error
    },
    [load]
  )

  const addRow = useCallback(() => {
    const tempId = `new_${Date.now()}`
    setAllRows((prev) => [
      ...prev,
      {
        id: tempId,
        competitor_name: '',
        city: null,
        category: null,
        bonus_type: 'viajes',
        threshold: 0,
        bonus_amount: 0,
        description: '',
        sort_order: 0,
        is_active: true,
        // mig 110 — defaults del modelo nuevo
        mechanism: 'tiered',
        tiers: [{ threshold: '', reward: '' }],
        segment: 'active',
        recurring: true,
        group_key: null,
        is_chosen: true,
        comm_pct: null,
        share_in_window: null,
        cap_amount: null,
        mult_pct: null,
        streak_spec: null,
        day_window: null,
        time_from: null,
        time_to: null,
        zone: null,
        // mig 237 — hoy en hora LOCAL (toISOString es UTC: a las 20:00 en Perú ya es "mañana")
        valid_from: toISODate(new Date()),
        valid_to: null,
        source_type: 'captura',
        source_ref: null,
        reported_week: null,
        _isNew: true,
      },
    ])
  }, [])

  return {
    allRows,
    bonuses,
    loading,
    error,
    saveBonus,
    newVersion,
    deleteBonus,
    addRow,
    reload: load,
  }
}
