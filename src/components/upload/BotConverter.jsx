import { useState, useRef } from 'react'
import * as XLSX from 'xlsx'
import { convertBotToExcel } from '../../lib/botToExcel'
import { useCountry } from '../../context/CountryContext'
import { usePriceRules } from '../../hooks/usePriceRules'
import { Button } from '../ui/shadcn/button'
import { useI18n } from '../../context/LanguageContext'

export default function BotConverter() {
  const { t } = useI18n()
  const [result, setResult] = useState(null) // { files, summary, skipped, ok }
  const [outliers, setOutliers] = useState([]) // filas con precio sobre el límite
  const [loading, setLoading] = useState(false)
  const [fileName, setFileName] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const [showSkip, setShowSkip] = useState(false)
  const inputRef = useRef()

  const { country, countryConfig, dbConfigs } = useCountry()
  const { checkOutliers } = usePriceRules(country)

  async function processFile(file) {
    setLoading(true)
    setResult(null)
    setOutliers([])
    setFileName(file.name)
    setShowSkip(false)

    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array', cellDates: false })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(ws, { defval: null })

      const converted = convertBotToExcel(rows, country, dbConfigs)
      setResult(converted)

      // Chequear precios contra límites configurados
      if (converted.ok?.length) {
        const { suspects } = checkOutliers(converted.ok)
        setOutliers(suspects)
      }
    } catch (err) {
      setResult({ error: err.message })
    } finally {
      setLoading(false)
    }
  }

  function handleFiles(files) {
    const file = Array.from(files).find((f) => /\.(xlsx|xls|csv)$/i.test(f.name))
    if (file) processFile(file)
  }

  const uiCities = countryConfig.dbCities

  function getDownloadName(city) {
    if (city === 'Trujillo') return 'TRU_Pricing_CI_FINAL.xlsx'
    if (city === 'Arequipa') return 'ARQ_Pricing_CI_FINAL.xlsx'
    return `${city}_Pricing_CI_FINAL.xlsx`
  }

  function downloadCity(city) {
    if (!result?.files?.[city]) return
    const blob = new Blob([result.files[city]], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = getDownloadName(city)
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleClear() {
    setResult(null)
    setFileName(null)
    setLoading(false)
    setShowSkip(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="bot-converter">
      <div className="bot-converter__intro">
        <p>{t('botconverter.intro')}</p>
        <p style={{ fontSize: 12, color: '#888' }}>{t('botconverter.competitors_note')}</p>
      </div>

      {/* Drop zone */}
      {!result && !loading && (
        <div
          className={`dropzone${dragOver ? ' dropzone--over' : ''}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            handleFiles(e.dataTransfer.files)
          }}
        >
          <div className="dropzone__icon">📥</div>
          <div className="dropzone__label">
            {t('botconverter.dropzone_label')}
            <br />
            <span style={{ fontSize: 12, color: '#aaa' }}>{t('botconverter.dropzone_sub')}</span>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            style={{ display: 'none' }}
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ padding: '30px 0', textAlign: 'center', color: '#555' }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>⏳</div>
          {t('botconverter.processing', { filename: fileName })}
        </div>
      )}

      {/* Error */}
      {result?.error && (
        <div style={{ color: '#dc2626', padding: 16, background: '#fef2f2', borderRadius: 8 }}>
          {t('botconverter.error', { msg: result.error })}
        </div>
      )}

      {/* Resultado */}
      {result && !result.error && (
        <>
          <div className="bot-converter__header">
            <span style={{ fontWeight: 600, fontSize: 14 }}>📄 {fileName}</span>
            <Button
              variant="outline"
              className="hover:border-yango hover:bg-[var(--color-yango-light)] hover:text-yango"
              onClick={handleClear}
              style={{ marginLeft: 'auto' }}
            >
              {t('filter.reset')}
            </Button>
          </div>

          {/* Resumen por ciudad */}
          <div className="config-section" style={{ marginBottom: 16 }}>
            <h2>{t('botconverter.conversion_summary')}</h2>
            <table className="config-table">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>{t('filter.city')}</th>
                  <th>{t('botconverter.col_valid_rows')}</th>
                  <th>{t('botconverter.col_file')}</th>
                  <th>{t('botconverter.col_download')}</th>
                </tr>
              </thead>
              <tbody>
                {uiCities.map((city) => (
                  <tr key={city}>
                    <td style={{ textAlign: 'left', fontWeight: 600 }}>{city}</td>
                    <td style={{ textAlign: 'right' }}>
                      {(result.summary[city] || 0).toLocaleString()}
                    </td>
                    <td style={{ fontFamily: 'monospace', fontSize: 11, textAlign: 'left' }}>
                      {getDownloadName(city)}
                    </td>
                    <td>
                      {result.files[city] ? (
                        <Button
                          size="sm"
                          className="bg-[#2e7d32] hover:bg-[#1b5e20]"
                          onClick={() => downloadCity(city)}
                        >
                          {t('botconverter.download_btn')}
                        </Button>
                      ) : (
                        <span style={{ color: '#aaa', fontSize: 12 }}>
                          {t('botconverter.no_data')}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                <tr style={{ background: '#f9fbe7', fontWeight: 700 }}>
                  <td style={{ textAlign: 'left' }}>{t('botconverter.total_valid')}</td>
                  <td style={{ textAlign: 'right' }}>{result.summary.total.toLocaleString()}</td>
                  <td></td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Precios sobre el límite configurado */}
          {outliers.length > 0 && (
            <div
              className="config-section"
              style={{ marginBottom: 16, borderLeft: '3px solid #f59e0b', paddingLeft: 12 }}
            >
              <h2 style={{ color: '#92400e', margin: '0 0 6px' }}>
                {t('botconverter.outliers_title', {
                  n: outliers.length,
                  count: outliers.length,
                })}
              </h2>
              <p style={{ fontSize: 12, color: '#78350f', marginBottom: 10 }}>
                {t('botconverter.outliers_note')}
              </p>
              <table className="config-table" style={{ fontSize: 11 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>{t('filter.city')}</th>
                    <th style={{ textAlign: 'left' }}>{t('filter.category')}</th>
                    <th style={{ textAlign: 'left' }}>{t('rawdata.col_competitor')}</th>
                    <th style={{ textAlign: 'left' }}>{t('dataentry.date')}</th>
                    <th style={{ textAlign: 'left' }}>{t('rawdata.col_bracket')}</th>
                    <th>{t('botconverter.col_price')}</th>
                    <th>{t('upload.outlier_col_limit')}</th>
                  </tr>
                </thead>
                <tbody>
                  {outliers.slice(0, 100).map((s, i) => (
                    <tr key={i}>
                      <td style={{ textAlign: 'left' }}>{s.row.city}</td>
                      <td style={{ textAlign: 'left' }}>{s.row.category}</td>
                      <td style={{ textAlign: 'left' }}>{s.row.competition_name}</td>
                      <td style={{ textAlign: 'left' }}>{s.row.observed_date}</td>
                      <td style={{ textAlign: 'left' }}>{s.row.distance_bracket || '—'}</td>
                      <td style={{ color: '#dc2626', fontWeight: 600 }}>{s.value}</td>
                      <td style={{ color: '#555' }}>≤ {s.threshold}</td>
                    </tr>
                  ))}
                  {outliers.length > 100 && (
                    <tr>
                      <td colSpan={7} style={{ color: '#888', fontStyle: 'italic' }}>
                        {t('botconverter.more_rows', { n: outliers.length - 100 })}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Filas omitidas */}
          {result.skipped.length > 0 && (
            <div className="config-section">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                <h2 style={{ margin: 0 }}>
                  {t('botconverter.skipped_rows_title', {
                    n: result.skipped.length.toLocaleString(),
                  })}
                </h2>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-auto rounded px-2 py-0.5 text-[11px] font-normal"
                  onClick={() => setShowSkip((s) => !s)}
                >
                  {showSkip ? t('botconverter.hide') : t('botconverter.view_detail')}
                </Button>
              </div>

              {showSkip && (
                <table className="config-table" style={{ fontSize: 11 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left' }}>{t('botconverter.col_reason')}</th>
                      <th style={{ textAlign: 'left' }}>{t('botupload.col_app')}</th>
                      <th style={{ textAlign: 'left' }}>{t('filter.city')}</th>
                      <th style={{ textAlign: 'left' }}>{t('filter.category')}</th>
                      <th style={{ textAlign: 'left' }}>{t('botupload.col_status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.skipped.slice(0, 200).map((s, i) => (
                      <tr key={i}>
                        <td style={{ textAlign: 'left', color: '#dc2626' }}>{s.reason}</td>
                        <td style={{ textAlign: 'left' }}>{s.row?.app ?? '—'}</td>
                        <td style={{ textAlign: 'left' }}>{s.row?.city ?? '—'}</td>
                        <td style={{ textAlign: 'left' }}>
                          {s.row?.vehicle_category ?? s.row?.category ?? '—'}
                        </td>
                        <td style={{ textAlign: 'left' }}>{s.row?.status ?? '—'}</td>
                      </tr>
                    ))}
                    {result.skipped.length > 200 && (
                      <tr>
                        <td colSpan={5} style={{ color: '#888', fontStyle: 'italic' }}>
                          {t('botconverter.more_rows', {
                            n: (result.skipped.length - 200).toLocaleString(),
                          })}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
