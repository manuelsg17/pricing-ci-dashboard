import { useState } from 'react'
import { countRawData, fetchAllRawData } from './useRawData'
import { exportRawDataXlsx } from '../lib/rawDataExport'
import { useI18n } from '../context/LanguageContext'

// Extraído de RawData.jsx (Fase 1.2) — agrupa el flujo de export a .xlsx
// (conteo fresco + confirmación por volumen + fetch paginado con progreso).

// Por encima de esto, se pide confirmación antes de exportar (el fetch
// paginado + armado del xlsx puede tardar). Por encima del threshold "grande"
// se agrega una advertencia más fuerte — ciudades sin filtrar pueden tener
// cientos de miles de filas (ej. Bogotá/Lima).
const EXPORT_CONFIRM_THRESHOLD = 5000
const EXPORT_LARGE_WARNING_THRESHOLD = 50000

export function useRawDataExport({ filters, dbCity, dbCategory, toast, confirm }) {
  const { t } = useI18n()
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState(null) // { loaded, total }

  const handleExport = async () => {
    if (exporting) return
    setExporting(true)
    try {
      // snapshotIso: mismo instante para el conteo y para el fetch completo,
      // así el número del diálogo de confirmación coincide con lo que
      // realmente se exporta aunque entre data nueva (sync del bot) durante
      // los varios minutos que puede tardar un export grande.
      const snapshotIso = new Date().toISOString()
      // Conteo fresco (no el `total` del hook paginado, que puede estar
      // stale un instante si el usuario acaba de cambiar un filtro).
      const freshTotal = await countRawData(filters, { snapshotIso })
      if (freshTotal === 0) {
        toast.err(t('rawdata.export_no_rows'))
        return
      }
      if (freshTotal > EXPORT_CONFIRM_THRESHOLD) {
        const ok = await confirm({
          title: t('rawdata.export_confirm_title'),
          message:
            freshTotal > EXPORT_LARGE_WARNING_THRESHOLD
              ? t('rawdata.export_confirm_message_large', { n: freshTotal.toLocaleString() })
              : t('rawdata.export_confirm_message_normal', { n: freshTotal.toLocaleString() }),
          confirmText: t('rawdata.export_confirm_btn'),
        })
        if (!ok) return
      }
      setExportProgress({ loaded: 0, total: freshTotal })
      const allRows = await fetchAllRawData(filters, {
        snapshotIso,
        onProgress: (loaded, totalCount) => setExportProgress({ loaded, total: totalCount }),
      })
      exportRawDataXlsx({ rows: allRows, dbCity, dbCategory })
      toast.ok(t('rawdata.export_success', { n: allRows.length.toLocaleString() }))
    } catch (e) {
      toast.err(t('rawdata.export_error', { msg: e.message }))
    } finally {
      setExporting(false)
      setExportProgress(null)
    }
  }

  return { exporting, exportProgress, handleExport }
}
