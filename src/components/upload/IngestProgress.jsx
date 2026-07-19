import { useI18n } from '../../context/LanguageContext'

export default function IngestProgress({ current, total, done, error }) {
  const { t } = useI18n()
  const pct = total > 0 ? Math.round((current / total) * 100) : 0

  return (
    <div>
      <div className="ingest-bar">
        <div className="ingest-bar__fill" style={{ width: `${pct}%` }} />
      </div>
      {error ? (
        <div className="upload-error">{error}</div>
      ) : done ? (
        <div className="upload-ok">{t('upload.rows_inserted_ok', { n: total })}</div>
      ) : (
        <div className="ingest-status">
          {t('upload.inserting_progress', { current, total, pct })}
        </div>
      )}
    </div>
  )
}
