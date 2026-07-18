import { useState } from 'react'
import { KeyRound, X } from 'lucide-react'
import { useI18n } from '../../context/LanguageContext'
import { Button } from '../ui/shadcn/button'
import '../../styles/login.css'

// Modal self-service de cambio de contraseña. Reutiliza los estilos de
// login.css (.login-card) y el patrón de backdrop fijo del resto de la app.
// La lógica segura vive en useAuth().changePassword (re-auth + updateUser);
// acá solo validamos en cliente (largo mínimo + coincidencia) y mostramos
// el resultado. onSubmit(current, next) → null en éxito, o { code, message }.
export default function ChangePasswordModal({ open, onClose, onSubmit }) {
  const { t } = useI18n()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [errMsg, setErrMsg] = useState('')
  const [okMsg, setOkMsg] = useState('')

  if (!open) return null

  const close = () => {
    setCurrent('')
    setNext('')
    setConfirm('')
    setErrMsg('')
    setOkMsg('')
    setLoading(false)
    onClose()
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setErrMsg('')
    setOkMsg('')
    if (next.length < 8) {
      setErrMsg(t('account.min_len'))
      return
    }
    if (next !== confirm) {
      setErrMsg(t('account.mismatch'))
      return
    }
    setLoading(true)
    const err = await onSubmit(current, next)
    setLoading(false)
    if (err) {
      if (err.code === 'wrong_current') setErrMsg(t('account.wrong_current'))
      else setErrMsg(err.message || t('app.error'))
      return
    }
    setOkMsg(t('account.success'))
    setTimeout(close, 1200)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={close}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        background: 'rgba(15,23,42,0.45)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <form
        className="login-card"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        style={{ maxWidth: 380, position: 'relative' }}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={close}
          aria-label={t('app.cancel')}
          className="absolute top-3 right-3 h-auto w-auto p-1 text-muted"
        >
          <X size={18} />
        </Button>

        <div className="login-card__logo" style={{ fontSize: 16, gap: 8 }}>
          <KeyRound size={18} /> {t('account.change_password')}
        </div>

        <label htmlFor="cp-current">{t('account.current')}</label>
        <input
          id="cp-current"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />

        <label htmlFor="cp-new">{t('account.new')}</label>
        <input
          id="cp-new"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />

        <label htmlFor="cp-confirm">{t('account.confirm')}</label>
        <input
          id="cp-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />

        <Button className="w-full" type="submit" disabled={loading || !!okMsg}>
          {loading ? t('account.saving') : t('account.change_password')}
        </Button>

        {errMsg && <div className="login-card__error">{errMsg}</div>}
        {okMsg && (
          <div
            style={{
              padding: '10px 12px',
              background: 'var(--sem-green-bg, #e8f5e9)',
              color: 'var(--sem-green-fg, #1b5e20)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 12,
              fontWeight: 600,
              textAlign: 'center',
            }}
          >
            {okMsg}
          </div>
        )}
      </form>
    </div>
  )
}
