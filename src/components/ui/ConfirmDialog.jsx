/* eslint-disable react-refresh/only-export-components -- contexto + hook en el
   mismo archivo es el patrón establecido de este proyecto (ver Toast.jsx,
   FilterContext.jsx); separar solo por Fast Refresh no vale la fragmentación. */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Button } from './shadcn/button'
import { useI18n } from '../../context/LanguageContext'

const ConfirmCtx = createContext(null)

export function useConfirm() {
  const ctx = useContext(ConfirmCtx)
  const { t } = useI18n()
  if (!ctx) {
    return (opts) =>
      Promise.resolve(
        window.confirm(opts?.message || opts || t('common.confirm_dialog.default_message'))
      )
  }
  return ctx
}

export function ConfirmProvider({ children }) {
  const { t } = useI18n()
  const [state, setState] = useState(null)
  const resolverRef = useRef(null)

  const confirm = useCallback(
    (opts) => {
      const config = typeof opts === 'string' ? { message: opts } : opts || {}
      return new Promise((resolve) => {
        resolverRef.current = resolve
        setState({
          title: config.title || t('common.confirm_dialog.default_title'),
          message: config.message || t('common.confirm_dialog.default_message'),
          confirmText: config.confirmText || t('app.confirm'),
          cancelText: config.cancelText || t('app.cancel'),
          danger: !!config.danger,
        })
      })
    },
    [t]
  )

  const close = useCallback((result) => {
    setState(null)
    if (resolverRef.current) {
      resolverRef.current(result)
      resolverRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!state) return
    const onKey = (e) => {
      if (e.key === 'Escape') close(false)
      else if (e.key === 'Enter') close(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, close])

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {state && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => close(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10000,
            background: 'rgba(15, 23, 42, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            backdropFilter: 'blur(2px)',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff',
              borderRadius: 12,
              maxWidth: 440,
              width: '100%',
              padding: 22,
              boxShadow: '0 20px 50px rgba(0,0,0,0.25)',
              animation: 'confirmIn 140ms ease-out',
            }}
          >
            <h3
              style={{
                fontSize: 16,
                fontWeight: 700,
                margin: 0,
                marginBottom: 8,
                color: state.danger ? '#991b1b' : '#0f172a',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              {state.danger && <span aria-hidden="true">⚠</span>}
              {state.title}
            </h3>
            <p
              style={{
                fontSize: 13,
                color: '#475569',
                margin: 0,
                marginBottom: 18,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
              }}
            >
              {state.message}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button
                variant="outline"
                onClick={() => close(false)}
                className="border-slate-300 text-slate-800"
              >
                {state.cancelText}
              </Button>
              <Button
                onClick={() => close(true)}
                autoFocus
                className={
                  state.danger ? 'bg-red-600 font-semibold hover:bg-red-600/90' : 'font-semibold'
                }
              >
                {state.confirmText}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  )
}
