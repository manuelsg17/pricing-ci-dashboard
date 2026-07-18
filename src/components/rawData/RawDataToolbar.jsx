import { Button } from '../ui/shadcn/button'

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
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-gray-300"
          onClick={handleExport}
          disabled={exporting || total === 0}
          title="Descarga todas las filas que matcheen los filtros actuales en un archivo Excel (.xlsx)"
        >
          {exporting
            ? `Exportando… ${exportProgress ? `${exportProgress.loaded.toLocaleString()}/${exportProgress.total.toLocaleString()}` : ''}`
            : '⬇ Exportar (.xlsx)'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-gray-300"
          onClick={handleSyncInDrive}
          disabled={syncing}
          title="Recalcula price_without_discount para datos bot de InDrive usando los % configurados en Config > InDrive"
        >
          {syncing ? 'Sincronizando…' : '⟳ Precios InDrive (bot)'}
        </Button>
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 rounded-sm border-border bg-panel px-2.5 text-foreground hover:border-yango hover:bg-panel hover:text-yango disabled:opacity-40"
            onClick={() => fetch(0)}
            disabled={page === 0 || loading}
          >
            «
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 rounded-sm border-border bg-panel px-2.5 text-foreground hover:border-yango hover:bg-panel hover:text-yango disabled:opacity-40"
            onClick={() => fetch(page - 1)}
            disabled={page === 0 || loading}
          >
            ‹
          </Button>
          <span className="raw-data__page-label">
            Pág. {page + 1} / {totalPages}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 rounded-sm border-border bg-panel px-2.5 text-foreground hover:border-yango hover:bg-panel hover:text-yango disabled:opacity-40"
            onClick={() => fetch(page + 1)}
            disabled={page >= totalPages - 1 || loading}
          >
            ›
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 rounded-sm border-border bg-panel px-2.5 text-foreground hover:border-yango hover:bg-panel hover:text-yango disabled:opacity-40"
            onClick={() => fetch(totalPages - 1)}
            disabled={page >= totalPages - 1 || loading}
          >
            »
          </Button>
        </div>
      )}
    </div>
  )
}
