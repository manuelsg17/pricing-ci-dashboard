import { useState, useEffect, useCallback, useMemo } from 'react'
import { sb } from '../lib/supabase'

export function useCompetitorBonuses(city, country) {
  const [allRows, setAllRows] = useState([])
  const [loading, setLoading] = useState(true)

  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!country) return
    setLoading(true)
    setError(null)
    const { data, error: e } = await sb
      .from('competitor_bonuses')
      .select('*')
      .eq('country', country)
      .order('competitor_name')
      .order('sort_order')
      .order('id')
    if (e) setError(e.message)
    else if (data) setAllRows(data)
    setLoading(false)
  }, [country])

  useEffect(() => {
    load()
  }, [load])

  // Returns active bonuses relevant to the city (global + city-specific), grouped by competitor
  const bonuses = useMemo(() => {
    const result = {}
    for (const row of allRows) {
      if (!row.is_active) continue
      if (row.city !== null && row.city !== undefined && row.city !== city) continue
      if (!result[row.competitor_name]) result[row.competitor_name] = []
      result[row.competitor_name].push(row)
    }
    return result
  }, [allRows, city])

  const saveBonus = useCallback(
    async (row) => {
      const numOrNull = (v) => (v === '' || v == null ? null : Number(v))
      const payload = {
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
        share_in_window: numOrNull(row.share_in_window),
        cap_amount: numOrNull(row.cap_amount),
        mult_pct: numOrNull(row.mult_pct),
        streak_spec: row.mechanism === 'streak' ? row.streak_spec || null : null,
        day_window: row.day_window || null,
        time_from: row.time_from || null,
        time_to: row.time_to || null,
        zone: row.zone || null,
        updated_at: new Date().toISOString(),
      }
      let err
      if (String(row.id).startsWith('new_')) {
        ;({ error: err } = await sb.from('competitor_bonuses').insert(payload))
      } else {
        ;({ error: err } = await sb.from('competitor_bonuses').update(payload).eq('id', row.id))
      }
      if (!err) await load()
      return !err
    },
    [load, country]
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
        _isNew: true,
      },
    ])
  }, [])

  return { allRows, bonuses, loading, error, saveBonus, deleteBonus, addRow, reload: load }
}
