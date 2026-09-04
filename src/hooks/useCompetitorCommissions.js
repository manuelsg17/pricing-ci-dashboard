import { useState, useEffect, useCallback, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { canonicalCompetitorName } from '../lib/normalize'

export function useCompetitorCommissions(city, country) {
  const [allRows, setAllRows] = useState([])
  const [loading, setLoading] = useState(true)

  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!country) return
    setLoading(true)
    setError(null)
    const { data, error: e } = await sb
      .from('competitor_commissions')
      .select('*')
      .eq('country', country)
      .order('competitor_name')
    if (e) setError(e.message)
    else if (data) setAllRows(data)
    setLoading(false)
  }, [country])

  useEffect(() => {
    load()
  }, [load])

  // Live-sync (audit_log → 'config:changed'): un cambio hecho en otra
  // sesión/pestaña se refleja sin recargar. Antes no escuchaba nada.
  useEffect(() => {
    function onChange(e) {
      if (e?.detail?.table === 'competitor_commissions') load()
    }
    window.addEventListener('config:changed', onChange)
    return () => window.removeEventListener('config:changed', onChange)
  }, [load])

  // Returns commission_pct for a competitor, preferring city-specific over global (city=null).
  // Defense-in-depth: el nombre del competidor en competitor_commissions
  // tiene que matchear el de pricing_observations al hacer commissions[comp].
  // Si en la tabla quedó un nombre legacy ('Yango Comfort' vs 'YangoComfort'),
  // ambos lados (lookup en Rentabilidad y este map) terminan con el mismo
  // canónico y la búsqueda funciona. La BD también lo garantiza (mig 239).
  const commissions = useMemo(() => {
    const result = {}
    for (const row of allRows) {
      const name = canonicalCompetitorName(row.competitor_name) || row.competitor_name
      if (row.city === null || row.city === undefined) {
        if (result[name] === undefined) result[name] = row.commission_pct
      }
    }
    for (const row of allRows) {
      const name = canonicalCompetitorName(row.competitor_name) || row.competitor_name
      if (row.city === city) result[name] = row.commission_pct
    }
    return result
  }, [allRows, city])

  // Devuelve { ok, error, code }: `code` es un identificador estable para
  // que la UI traduzca ('invalid_competitor' | 'invalid_pct') y `error` el
  // mensaje real de Supabase cuando lo hay (antes se descartaba y el
  // usuario veía un genérico "Error al guardar").
  const saveCommission = useCallback(
    async (row) => {
      const pct = Number(row.commission_pct)
      if (!row.competitor_name?.trim())
        return { ok: false, code: 'invalid_competitor', error: null }
      if (!Number.isFinite(pct) || pct < 0 || pct > 100)
        return { ok: false, code: 'invalid_pct', error: null }
      const payload = {
        competitor_name: canonicalCompetitorName(row.competitor_name),
        city: row.city || null,
        country,
        commission_pct: pct,
        updated_at: new Date().toISOString(),
      }
      let err
      if (String(row.id).startsWith('new_')) {
        ;({ error: err } = await sb.from('competitor_commissions').insert(payload))
      } else {
        ;({ error: err } = await sb.from('competitor_commissions').update(payload).eq('id', row.id))
      }
      if (!err) await load()
      return { ok: !err, code: err ? 'db' : null, error: err?.message || null }
    },
    [load, country]
  )

  const deleteCommission = useCallback(
    async (id) => {
      if (String(id).startsWith('new_')) {
        setAllRows((prev) => prev.filter((r) => r.id !== id))
        return true
      }
      const { error } = await sb.from('competitor_commissions').delete().eq('id', id)
      if (!error) await load()
      return !error
    },
    [load]
  )

  const addRow = useCallback(() => {
    // Math.random: dos clics en el mismo milisegundo daban la misma key.
    const tempId = `new_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    setAllRows((prev) => [
      ...prev,
      { id: tempId, competitor_name: '', city: null, commission_pct: 0, _isNew: true },
    ])
  }, [])

  return {
    allRows,
    commissions,
    loading,
    error,
    saveCommission,
    deleteCommission,
    addRow,
    reload: load,
  }
}
