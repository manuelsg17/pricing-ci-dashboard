export default function IngestProgress({ current, total, done, error }) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0

  return (
    <div>
      <div className="ingest-bar">
        <div className="ingest-bar__fill" style={{ width: `${pct}%` }} />
      </div>
      {error ? (
        <div className="upload-error">{error}</div>
      ) : done ? (
        <div className="upload-ok">✓ {total} filas insertadas correctamente</div>
      ) : (
        <div className="ingest-status">
          Insertando... {current} / {total} filas ({pct}%)
        </div>
      )}
    </div>
  )
}
