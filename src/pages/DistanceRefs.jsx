import { useState, useEffect, useMemo } from 'react'
import { useDistanceRefs } from '../hooks/useDistanceRefs'
import { BRACKETS, BRACKET_LABELS, getCityLabel } from '../lib/constants'
import { useToast } from '../components/ui/Toast'
import { useConfirm } from '../components/ui/ConfirmDialog'
import EmptyState from '../components/ui/EmptyState'
import { SkeletonTable } from '../components/ui/Skeleton'
import { Button } from '../components/ui/shadcn/button'
import '../styles/distance-refs.css'

import { useCountry } from '../context/CountryContext'
import { useI18n } from '../context/LanguageContext'

export default function DistanceRefs() {
  const { country, countryConfig: config } = useCountry()
  const { t } = useI18n()
  const toast = useToast()
  const confirm = useConfirm()

  // Reconstruimos la lista de "solapas" (UI Cities) basadas en la configuración del país
  const uiCities = config.dbCities

  const [dbCity, setDbCity] = useState(config.dbCities[0] || 'Lima')
  const [uiCat, setUiCat] = useState('')

  // Refuerzo: si cambiamos de país, re-centramos a la ciudad 0 de ese país
  useEffect(() => {
    if (!config.dbCities.includes(dbCity)) {
      setDbCity(config.dbCities[0])
    }
  }, [country, config.dbCities, dbCity])

  const categories = useMemo(() => config.categoriesByCity?.[dbCity] || [], [config, dbCity])

  // Inicializar uiCat al cambiar ciudad/país
  useEffect(() => {
    if (categories.length > 0 && !categories.includes(uiCat)) {
      setUiCat(categories[0])
    }
  }, [categories, uiCat])

  const [bulkSaving, setBulkSaving] = useState(false)

  // dbCat usa lookup o el mismo si no está mapeado
  const dbCat = config.uiToDbCategory?.[uiCat] || uiCat
  const { refs, loading, saving, error, saveRef, deleteRef, addRow, addCategoryRows } =
    useDistanceRefs(dbCity, country)

  // Local edits
  const [edits, setEdits] = useState({})
  const getField = (id, field, original) => edits[id]?.[field] ?? original ?? ''
  const setField = (id, field, value) =>
    setEdits((prev) => ({
      ...prev,
      [id]: { ...prev[id], [field]: value },
    }))

  // Refs filtradas por categoría seleccionada (DB level)
  const filteredRefs = refs.filter(
    (r) => r.category === dbCat || (r._isNew && r.category === dbCat)
  )

  // Filas "pending": nuevas o con edits
  const pendingRefs = filteredRefs.filter((r) => r._isNew || edits[r.id])
  const pendingCount = pendingRefs.length

  function handleCityChange(city) {
    setDbCity(city)
    // El setUiCat se manejará por el useEffect cuando cambie `categories`
    setEdits({})
  }

  function handleCatChange(cat) {
    setUiCat(cat)
  }

  const handleSave = async (row) => {
    const merged = { ...row, ...edits[row.id] }
    const payload = {
      id: String(row.id).startsWith('new_') ? undefined : row.id,
      city: dbCity,
      category: dbCat,
      bracket: merged.bracket || '',
      point_a: merged.point_a || '',
      coordinate_a: merged.coordinate_a || '',
      point_b: merged.point_b || '',
      coordinate_b: merged.coordinate_b || '',
      waze_distance:
        merged.waze_distance !== '' && merged.waze_distance != null
          ? Number(merged.waze_distance)
          : null,
    }
    const ok = await saveRef(payload)
    if (ok) {
      setEdits((prev) => {
        const n = { ...prev }
        delete n[row.id]
        return n
      })
      toast.ok(t('distancerefs.saved_toast'))
    } else {
      toast.err(t('distancerefs.save_error_toast'))
    }
  }

  const handleDelete = async (id) => {
    if (String(id).startsWith('new_')) {
      setEdits((prev) => {
        const n = { ...prev }
        delete n[id]
        return n
      })
      return
    }
    const ok = await confirm({
      title: t('distancerefs.delete_confirm_title'),
      message: t('distancerefs.delete_confirm_message'),
      danger: true,
      confirmText: t('app.delete'),
    })
    if (!ok) return
    const success = await deleteRef(id)
    if (success !== false) toast.ok(t('distancerefs.deleted_toast'))
  }

  // Agregar todos los brackets para la categoría seleccionada
  const handleAddCategory = () => {
    addCategoryRows(dbCat, BRACKETS)
  }

  // Guardar todas las filas pendientes de la vista actual
  const handleSaveAll = async () => {
    const toSave = filteredRefs.filter((r) => r._isNew || edits[r.id])
    if (!toSave.length) {
      toast.info(t('distancerefs.no_pending_changes'))
      return
    }
    setBulkSaving(true)
    let saved = 0,
      failed = 0
    for (const row of toSave) {
      const merged = { ...row, ...edits[row.id] }
      const payload = {
        id: String(row.id).startsWith('new_') ? undefined : row.id,
        city: dbCity,
        category: dbCat,
        bracket: merged.bracket || '',
        point_a: merged.point_a || '',
        coordinate_a: merged.coordinate_a || '',
        point_b: merged.point_b || '',
        coordinate_b: merged.coordinate_b || '',
        waze_distance:
          merged.waze_distance !== '' && merged.waze_distance != null
            ? Number(merged.waze_distance)
            : null,
      }
      const ok = await saveRef(payload)
      if (ok) {
        saved++
        setEdits((prev) => {
          const n = { ...prev }
          delete n[row.id]
          return n
        })
      } else failed++
    }
    setBulkSaving(false)
    if (failed === 0) toast.ok(t('distancerefs.save_all_success', { n: saved, count: saved }))
    else toast.warn(t('distancerefs.save_all_partial', { saved, failed }))
  }

  return (
    <div className="drefs-page">
      <h1>{t('distancerefs.title')}</h1>
      <p className="drefs-page__desc">{t('distancerefs.desc')}</p>

      {/* City selector */}
      <div className="drefs-filters">
        <span className="drefs-filters__label">{t('filter.city')}</span>
        <select value={dbCity} onChange={(e) => handleCityChange(e.target.value)}>
          {uiCities.map((c) => (
            <option key={c} value={c}>
              {getCityLabel(c)}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="drefs-error">
          {t('app.error_prefix')}
          {error}
        </div>
      )}

      {/* Category tabs */}
      <div className="drefs-cat-tabs">
        {categories.map((cat) => (
          <button
            key={cat}
            className={`drefs-cat-tab${uiCat === cat ? ' active' : ''}`}
            onClick={() => handleCatChange(cat)}
          >
            {cat}
            {/* badge de cuántas rutas tiene */}
            <span className="drefs-cat-count">
              {refs.filter((r) => r.category === (config.uiToDbCategory?.[cat] || cat)).length}
            </span>
          </button>
        ))}
      </div>

      <div className="drefs-section">
        <div className="drefs-section__header">
          <span className="drefs-section__title">
            {dbCity} — {uiCat} — {filteredRefs.length} {t('distancerefs.routes_suffix')}
            {pendingCount > 0 && (
              <span className="drefs-pending-badge">
                {t('distancerefs.pending_badge', { n: pendingCount, count: pendingCount })}
              </span>
            )}
          </span>
          <div className="drefs-section__actions">
            {pendingCount > 0 && (
              <Button
                size="sm"
                className="bg-green-700 hover:bg-green-800"
                onClick={handleSaveAll}
                disabled={bulkSaving || saving}
              >
                {bulkSaving ? t('account.saving') : t('distancerefs.save_all', { n: pendingCount })}
              </Button>
            )}
            <Button size="sm" onClick={handleAddCategory} disabled={saving || bulkSaving}>
              {t('distancerefs.add_category_full', { cat: uiCat })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-yango text-yango hover:bg-yango hover:text-white"
              onClick={() => {
                addRow()
              }}
              disabled={saving}
            >
              {t('distancerefs.add_single_row')}
            </Button>
          </div>
        </div>

        {loading ? (
          <SkeletonTable rows={6} cols={7} />
        ) : filteredRefs.length === 0 ? (
          <EmptyState
            icon="🛣️"
            title={t('distancerefs.empty_title', { city: dbCity, cat: uiCat })}
            message={t('distancerefs.empty_message', { cat: uiCat })}
          />
        ) : (
          <div className="drefs-table-wrap">
            <table className="drefs-table">
              <thead>
                <tr>
                  <th>{t('rawdata.col_bracket')}</th>
                  <th>{t('dataentry.col_point_a')}</th>
                  <th>{t('distancerefs.col_coord_a')}</th>
                  <th>{t('dataentry.col_point_b')}</th>
                  <th>{t('distancerefs.col_coord_b')}</th>
                  <th>{t('distancerefs.col_dist_waze')}</th>
                  <th>{t('distancerefs.col_actions')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredRefs.map((row) => (
                  <tr
                    key={row.id}
                    className={row._isNew ? 'row-new' : edits[row.id] ? 'row-edited' : ''}
                  >
                    <td>
                      <select
                        value={getField(row.id, 'bracket', row.bracket)}
                        onChange={(e) => setField(row.id, 'bracket', e.target.value)}
                      >
                        <option value="">{t('distancerefs.choose_placeholder')}</option>
                        {BRACKETS.map((b) => (
                          <option key={b} value={b}>
                            {BRACKET_LABELS[b]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        className="wide"
                        placeholder={t('distancerefs.point_a_placeholder')}
                        value={getField(row.id, 'point_a', row.point_a)}
                        onChange={(e) => setField(row.id, 'point_a', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="coord"
                        placeholder="-12.0464, -77.0428"
                        value={getField(row.id, 'coordinate_a', row.coordinate_a)}
                        onChange={(e) => setField(row.id, 'coordinate_a', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="wide"
                        placeholder={t('distancerefs.point_b_placeholder')}
                        value={getField(row.id, 'point_b', row.point_b)}
                        onChange={(e) => setField(row.id, 'point_b', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="coord"
                        placeholder="-12.1050, -77.0365"
                        value={getField(row.id, 'coordinate_b', row.coordinate_b)}
                        onChange={(e) => setField(row.id, 'coordinate_b', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="dist"
                        type="number"
                        step="0.1"
                        min="0"
                        placeholder="0.0"
                        value={getField(row.id, 'waze_distance', row.waze_distance)}
                        onChange={(e) => setField(row.id, 'waze_distance', e.target.value)}
                      />
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <Button size="sm" onClick={() => handleSave(row)} disabled={saving}>
                          {t('app.save')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="border-red-200 text-red-600 hover:border-red-600 hover:bg-red-50"
                          onClick={() => handleDelete(row.id)}
                          disabled={saving}
                        >
                          ✕
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
