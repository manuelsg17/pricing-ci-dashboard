import { useState } from 'react'
import { Button } from '../ui/shadcn/button'
import { useI18n } from '../../context/LanguageContext'
import '../../styles/login.css'

export default function LoginScreen({ onLogin }) {
  const { t } = useI18n()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [errMsg, setErrMsg] = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setErrMsg('')
    const error = await onLogin(email, password)
    if (error) setErrMsg(error.message || t('login.default_error'))
    setLoading(false)
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-card__logo">
          <span className="login-card__logo-icon">Y</span>
          Pricing CI
        </div>
        <div className="login-card__subtitle">{t('login.subtitle')}</div>

        <label htmlFor="email">{t('login.email_label')}</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          placeholder={t('login.email_placeholder')}
        />

        <label htmlFor="password">{t('login.password_label')}</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        <Button className="w-full" type="submit" disabled={loading}>
          {loading ? t('login.submit_loading') : t('login.submit')}
        </Button>

        {errMsg && <div className="login-card__error">{errMsg}</div>}
      </form>
    </div>
  )
}
