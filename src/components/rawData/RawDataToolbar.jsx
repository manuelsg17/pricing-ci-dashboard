import { Button } from '../ui/shadcn/button'
import { useI18n } from '../../context/LanguageContext'

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
  const { t } = useI18n()
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="raw-data__info">
      <div className="raw-data__count">
        {loading ? (
          t('app.loading')
        ) : (
          <>
            <strong>{total.toLocaleString()}</strong> {t('rawdata.rows_found_suffix')}
            {total > 0 && (
              <>
                {' '}
                {t('rawdata.showing_range', {
                  from: page * pageSize + 1,
                  to: Math.min((page + 1) * pageSize, total),
                })}
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
          title={t('rawdata.export_button_title')}
        >
          {exporting
            ? t('rawdata.exporting', {
                progress: exportProgress
                  ? `${exportProgress.loaded.toLocaleString()}/${exportProgress.total.toLocaleString()}`
                  : '',
              })
            : t('rawdata.export_xlsx')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-gray-300"
          onClick={handleSyncInDrive}
          disabled={syncing}
          title={t('rawdata.sync_indrive_title')}
        >
          {syncing ? t('rawdata.syncing') : t('rawdata.sync_indrive_btn')}
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
            {t('rawdata.page_label', { page: page + 1, total: totalPages })}
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
