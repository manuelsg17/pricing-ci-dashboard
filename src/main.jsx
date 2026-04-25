import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { LanguageProvider } from './context/LanguageContext'
import { CountryProvider }  from './context/CountryContext'
import { ToastProvider }    from './components/ui/Toast'
import { ConfirmProvider }  from './components/ui/ConfirmDialog'
import ErrorBoundary        from './components/ui/ErrorBoundary'
import './styles/global.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <ConfirmProvider>
          <LanguageProvider>
            <CountryProvider>
              <App />
            </CountryProvider>
          </LanguageProvider>
        </ConfirmProvider>
      </ToastProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
