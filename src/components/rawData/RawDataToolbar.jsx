export default function RawDataToolbar({
  loading,
  total,
  page,
  pageSize,
  fetch,
  exporting,
  exportProgress,
  handleExport,
  syncing,
  syncMsg,
  handleSyncInDrive,
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="raw-data__info">
      <div className="raw-data__count">
        {loading ? (
          'Cargando…'
        ) : (
          <>
            <strong>{total.toLocaleString()}</strong> filas encontradas
            {total > 0 && (
              <>
                {' '}
                · Mostrando {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)}
              </>
            )}
          </>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={handleExport}
          disabled={exporting || total === 0}
          style={{
            padding: '4px 10px',
            fontSize: 12,
            border: '1px solid #d1d5db',
            borderRadius: 4,
            background: exporting ? '#f3f4f6' : '#fff',
            cursor: exporting || total === 0 ? 'default' : 'pointer',
          }}
          title="Descarga todas las filas que matcheen los filtros actuales en un archivo Excel (.xlsx)"
        >
          {exporting
            ? `Exportando… ${exportProgress ? `${exportProgress.loaded.toLocaleString()}/${exportProgress.total.toLocaleString()}` : ''}`
            : '⬇ Exportar (.xlsx)'}
        </button>
        <button
          onClick={handleSyncInDrive}
          disabled={syncing}
          style={{
            padding: '4px 10px',
            fontSize: 12,
            border: '1px solid #d1d5db',
            borderRadius: 4,
            background: syncing ? '#f3f4f6' : '#fff',
            cursor: syncing ? 'default' : 'pointer',
          }}
          title="Recalcula price_without_discount para datos bot de InDrive usando los % configurados en Config > InDrive"
        >
          {syncing ? 'Sincronizando…' : '⟳ Precios InDrive (bot)'}
        </button>
        {syncMsg && (
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: syncMsg.type === 'ok' ? '#166534' : '#991b1b',
            }}
          >
            {syncMsg.text}
          </span>
        )}
      </div>

      {total > pageSize && (
        <div className="raw-data__pagination">
          <button
            className="raw-data__page-btn"
            onClick={() => fetch(0)}
            disabled={page === 0 || loading}
          >
            «
          </button>
          <button
            className="raw-data__page-btn"
            onClick={() => fetch(page - 1)}
            disabled={page === 0 || loading}
          >
            ‹
          </button>
          <span className="raw-data__page-label">
            Pág. {page + 1} / {totalPages}
          </span>
          <button
            className="raw-data__page-btn"
            onClick={() => fetch(page + 1)}
            disabled={page >= totalPages - 1 || loading}
          >
            ›
          </button>
          <button
            className="raw-data__page-btn"
            onClick={() => fetch(totalPages - 1)}
            disabled={page >= totalPages - 1 || loading}
          >
            »
          </button>
        </div>
      )}
    </div>
  )
}
