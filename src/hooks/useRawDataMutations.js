import { useState } from 'react'
import { sb } from '../lib/supabase'
import { useI18n } from '../context/LanguageContext'

// Extraído de RawData.jsx (Fase 1.2) — agrupa las mutaciones de fila
// (borrar, editar celda inline, sincronizar precios InDrive del bot).
// Separado de useRawData (que solo lee/pagina) para que "leer" y "mutar"
// no sigan mezclados en la page.
export function useRawDataMutations({
  setRows,
  setTotal,
  fetch,
  page,
  dbCity,
  country,
  toast,
  confirm,
  exporting,
}) {
  const { t } = useI18n()
  const [editingId, setEditingId] = useState(null)
  const [editField, setEditField] = useState(null)
  const [editValue, setEditValue] = useState('')

  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState(null) // { type: 'ok'|'err', text }

  const handleDelete = async (id) => {
    // Evita que un delete confirm() choque con el de handleExport (el
    // ConfirmProvider solo sostiene un diálogo a la vez — dos llamadas
    // concurrentes pisan el resolver de la primera y esa promesa nunca
    // se resuelve). El botón de basurero ya queda disabled mientras
    // exporting=true, esto es la defensa en profundidad.
    if (exporting) return
    const ok = await confirm({
      title: t('rawdata.delete_confirm_title'),
      message: t('rawdata.delete_confirm_message'),
      danger: true,
      confirmText: t('app.delete'),
    })
    if (!ok) return
    const { error: delErr } = await sb.from('pricing_observations').delete().eq('id', id)
    if (!delErr) {
      setRows((prev) => prev.filter((r) => r.id !== id))
      setTotal((prev) => prev - 1)
      toast.ok(t('rawdata.deleted_toast'))
    } else {
      toast.err(t('rawdata.delete_error', { msg: delErr.message }))
    }
  }

  const startEdit = (id, field, value) => {
    setEditingId(id)
    setEditField(field)
    setEditValue(value === null || value === undefined ? '' : value)
  }

  const cancelEdit = () => setEditingId(null)

  const handleEditKeyDown = async (e, id, field) => {
    if (e.key === 'Escape') {
      setEditingId(null)
    } else if (e.key === 'Enter') {
      const parsed = parseFloat(editValue)
      const finalVal = isNaN(parsed) ? null : parsed
      const { error: updErr } = await sb
        .from('pricing_observations')
        .update({ [field]: finalVal })
        .eq('id', id)

      if (!updErr) {
        // Inmutable: setRows en lugar de mutar el array directamente.
        // La mutación directa no dispara re-render y produce
        // inconsistencias visuales.
        setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: finalVal } : r)))
        toast.ok(t('rawdata.value_updated_toast'))
      } else {
        toast.err(t('rawdata.update_error', { msg: updErr.message }))
      }
      setEditingId(null)
    }
  }

  const handleSyncInDrive = async () => {
    setSyncing(true)
    setSyncMsg(null)
    try {
      const { data, error } = await sb.rpc(
        'apply_indrive_bot_prices',
        dbCity ? { p_city: dbCity, p_country: country } : { p_country: country }
      )
      if (error) throw error
      const count = typeof data === 'number' ? data : 0
      setSyncMsg({ type: 'ok', text: t('rawdata.sync_success', { n: count.toLocaleString() }) })
      fetch(page)
    } catch (e) {
      setSyncMsg({ type: 'err', text: t('rawdata.sync_error', { msg: e.message }) })
    } finally {
      setSyncing(false)
      setTimeout(() => setSyncMsg(null), 5000)
    }
  }

  return {
    editingId,
    editField,
    editValue,
    setEditValue,
    startEdit,
    cancelEdit,
    handleEditKeyDown,
    handleDelete,
    syncing,
    syncMsg,
    handleSyncInDrive,
  }
}
