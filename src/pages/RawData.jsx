import { useMemo } from 'react'
import { useCountry } from '../context/CountryContext'
import { useI18n } from '../context/LanguageContext'
import { useAuth } from '../lib/auth'
import { useAccessControl } from '../hooks/useAccessControl'
import { useRawData } from '../hooks/useRawData'
import { useRawDataFilters } from '../hooks/useRawDataFilters'
import { useRawDataMutations } from '../hooks/useRawDataMutations'
import { useRawDataExport } from '../hooks/useRawDataExport'
import { getCityLabel } from '../lib/constants'
import { useToast } from '../components/ui/Toast'
import { useConfirm } from '../components/ui/ConfirmDialog'
import RawDataCityTabs from '../components/rawData/RawDataCityTabs'
import RawDataFilterBar from '../components/rawData/RawDataFilterBar'
import RawDataToolbar from '../components/rawData/RawDataToolbar'
import RawDataTable from '../components/rawData/RawDataTable'
import '../styles/raw-data.css'

// Fase 1.2 — página orquestadora sobre hooks (mismo patrón que
// Config.jsx/Competitividad.jsx): useRawDataFilters agrupa filtros +
// persistencia, useRawData pagina, useRawDataMutations agrupa
// delete/edit/sync, useRawDataExport el flujo de exportar a .xlsx. La
// tabla y la barra de filtros viven en components/rawData/. Extracción
// preservando comportamiento — sin cambios de lógica en este pase.
export default function RawData() {
  const { country, countryConfig: config } = useCountry()
  const { t } = useI18n()
  const toast = useToast()
  const confirm = useConfirm()
  const { session } = useAuth()
  const { isAdmin } = useAccessControl()
  const userEmail = session?.user?.email || ''

  // Seguridad (auditoría 2026-07-26): la RLS de UPDATE/DELETE ya bloquea a
  // un hub tocar filas manuales de OTRO hub — esto es solo la señal visual
  // en la UI, para no dejar que un hub_expert intente editar/borrar y se
  // encuentre con un error genérico de RLS sin explicación. Filas bot o
  // manuales legacy sin dueño (uploaded_by null) siguen editables por
  // cualquiera con acceso al país, igual que hoy.
  const canEditRow = (r) => isAdmin || !r.uploaded_by || r.uploaded_by === userEmail

  const cityTabs = useMemo(
    () => config.dbCities.map((db) => ({ db, label: getCityLabel(db) })),
    [config.dbCities]
  )

  const {
    filters,
    dbCity,
    dbCategory,
    competition,
    surge,
    bracket,
    dateFrom,
    dateTo,
    searchA,
    searchB,
    dataSource,
    outlierOnly,
    setDbCategory,
    setCompetition,
    setSurge,
    setBracket,
    setDateFrom,
    setDateTo,
    setSearchA,
    setSearchB,
    setDataSource,
    setOutlierOnly,
    categories,
    competitors,
    handleCityChange,
    resetFilters,
  } = useRawDataFilters({ country, config })

  const { rows, setRows, total, setTotal, page, loading, error, fetch, pageSize } =
    useRawData(filters)

  const OUTLIER_THRESHOLD = config.outlierThreshold || 100

  const { exporting, exportProgress, handleExport } = useRawDataExport({
    filters,
    dbCity,
    dbCategory,
    toast,
    confirm,
  })

  const {
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
  } = useRawDataMutations({
    setRows,
    setTotal,
    fetch,
    page,
    dbCity,
    country,
    toast,
    confirm,
    exporting,
  })

  return (
    <div className="raw-data">
      <RawDataCityTabs cityTabs={cityTabs} dbCity={dbCity} onCityChange={handleCityChange} />

      <RawDataFilterBar
        config={config}
        dateFrom={dateFrom}
        setDateFrom={setDateFrom}
        dateTo={dateTo}
        setDateTo={setDateTo}
        dbCategory={dbCategory}
        setDbCategory={setDbCategory}
        categories={categories}
        competition={competition}
        setCompetition={setCompetition}
        competitors={competitors}
        surge={surge}
        setSurge={setSurge}
        bracket={bracket}
        setBracket={setBracket}
        dataSource={dataSource}
        setDataSource={setDataSource}
        searchA={searchA}
        setSearchA={setSearchA}
        searchB={searchB}
        setSearchB={setSearchB}
        outlierOnly={outlierOnly}
        setOutlierOnly={setOutlierOnly}
        outlierThreshold={OUTLIER_THRESHOLD}
        resetFilters={resetFilters}
      />

      {error && <div className="raw-data__error">{t('rawdata.error', { error })}</div>}

      <RawDataToolbar
        loading={loading}
        total={total}
        page={page}
        pageSize={pageSize}
        fetch={fetch}
        exporting={exporting}
        exportProgress={exportProgress}
        handleExport={handleExport}
        syncing={syncing}
        syncMsg={syncMsg}
        handleSyncInDrive={handleSyncInDrive}
      />

      <RawDataTable
        rows={rows}
        loading={loading}
        config={config}
        outlierThreshold={OUTLIER_THRESHOLD}
        editingId={editingId}
        editField={editField}
        editValue={editValue}
        setEditValue={setEditValue}
        startEdit={startEdit}
        cancelEdit={cancelEdit}
        handleEditKeyDown={handleEditKeyDown}
        handleDelete={handleDelete}
        exporting={exporting}
        canEditRow={canEditRow}
      />
    </div>
  )
}
