import { useState } from 'react'
import { useI18n } from '../../context/LanguageContext'
import { useClientErrors, CLIENT_ERRORS_PAGE_SIZE } from '../../hooks/useClientErrors'

// Panel de errores del cliente (mig 185) — SOLO admin, igual que el resto de
// Monitoreo. La seguridad real está en la RLS de client_errors (SELECT solo
// admin) y en resolve_client_error (RAISE si no es admin); esta página además
// se renderiza solo si isAdmin.
//
// Responde una sola pregunta: ¿algún hub está viendo errores ahora mismo?
// Por eso lista SIN RESOLVER, más reciente primero, y nada más. El detalle
// completo (stack, componente) se despliega a pedido: mostrarlo siempre
// convertiría el panel en un muro ilegible.
//
// El acceso a Supabase vive en useClientErrors.js; acá solo se pinta.

export default function ClientErrorsPanel() {
  const { t } = useI18n()
  const { rows, loading, failed, hasMore, actionErr, load, resolve } = useClientErrors()
  const [openId, setOpenId] = useState(null)

  // El panel desaparece cuando no hay nada: un bloque vacío permanente en
  // Monitoreo es ruido que se aprende a ignorar, y justo el día que aparezca
  // un error nadie lo va a mirar.
  if (!loading && !failed && rows.length === 0) return null

  return (
    <section className="mon-panel mon-panel--errors">
      <div className="mon-panel__head">
        <h2>
          {t('errors.title')} <span className="mon-panel__count">{rows.length}</span>
        </h2>
        <button type="button" className="mon-panel__refresh" onClick={load} disabled={loading}>
          ↻ {t('projects.refresh')}
        </button>
      </div>

      {failed && <div className="de-msg de-msg--err">{t('errors.failed')}</div>}
      {actionErr && <div className="de-msg de-msg--err">{actionErr}</div>}
      {loading && rows.length === 0 && <p className="mon-panel__empty">{t('app.loading')}</p>}

      {rows.map((r) => (
        <article key={r.id} className="cerr">
          <div className="cerr__row">
            <span className={`cerr__src cerr__src--${r.source}`}>
              {t(`errors.src.${r.source}`)}
            </span>
            <span className="cerr__msg" title={r.message}>
              {r.message}
            </span>
            {r.hits > 1 && <span className="cerr__hits">×{r.hits}</span>}
          </div>

          <div className="cerr__meta">
            <span>{r.user_email}</span>
            {r.label && <span>· {r.label}</span>}
            {r.route && <span>· {r.route}</span>}
            {r.country && <span>· {r.country}</span>}
            <span>· {new Date(r.last_seen).toLocaleString()}</span>
            {r.app_mode !== 'production' && <span className="cerr__dev">· {r.app_mode}</span>}
          </div>

          <div className="cerr__actions">
            <button type="button" onClick={() => setOpenId(openId === r.id ? null : r.id)}>
              {openId === r.id ? t('errors.hide_detail') : t('errors.show_detail')}
            </button>
            <button type="button" className="cerr__resolve" onClick={() => resolve(r.id)}>
              {t('errors.resolve')}
            </button>
          </div>

          {openId === r.id && (
            <pre className="cerr__stack">
              {r.stack || t('errors.no_stack')}
              {r.component_stack ? `\n\n--- componente ---\n${r.component_stack}` : ''}
            </pre>
          )}
        </article>
      ))}

      {hasMore && (
        <p className="mon-panel__more">{t('errors.more', { n: CLIENT_ERRORS_PAGE_SIZE })}</p>
      )}
    </section>
  )
}
