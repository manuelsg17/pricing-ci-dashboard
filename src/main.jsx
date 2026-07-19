import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { LanguageProvider } from './context/LanguageContext'
import { CountryProvider } from './context/CountryContext'
import { RealtimeSyncProvider } from './context/RealtimeSyncProvider'
import { ConfigProvider } from './context/ConfigProvider'
import { ToastProvider } from './components/ui/Toast'
import { ConfirmProvider } from './components/ui/ConfirmDialog'
import ErrorBoundary from './components/ui/ErrorBoundary'
// Sprint 2.1: Tailwind ANTES de global.css. tailwind.css agrega utility
// classes; global.css define tokens y overrides — el orden permite a
// global.css ganar en caso de conflicto. Sin preflight (ver tailwind.config.js)
// para no romper estilos de componentes existentes.
import './styles/tailwind.css'
import './styles/global.css'

// Orden de los providers (de afuera hacia adentro):
//   ErrorBoundary → cualquier crash queda atrapado. Usa translate() +
//                   localStorage directo (no el hook) porque está fuera
//                   de LanguageProvider — es la única excepción posible.
//   LanguageProvider → primero de los providers "reales": Toast y Confirm
//                      llaman useI18n() (ToastItem/ConfirmProvider), así
//                      que tienen que estar DENTRO de este, no afuera.
//   ToastProvider → necesario para RealtimeSync (muestra toasts de cambios).
//   ConfirmProvider → diálogos de confirmación.
//   CountryProvider → necesario para que CountryContext escuche eventos
//                     'config:changed' que dispara RealtimeSync.
//   ConfigProvider → cache global de configs read-only (Sprint 2.4).
//                    Dentro de CountryProvider para que el cambio de país
//                    fluya hacia los consumers. Fuera de RealtimeSync
//                    no importa: los eventos 'config:changed' viajan por
//                    window.
//   RealtimeSyncProvider → suscribe a audit_log. Tiene que estar DENTRO
//                          de Toast/I18n/Country pero por arriba de App.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <LanguageProvider>
        <ToastProvider>
          <ConfirmProvider>
            <CountryProvider>
              <ConfigProvider>
                <RealtimeSyncProvider>
                  <App />
                </RealtimeSyncProvider>
              </ConfigProvider>
            </CountryProvider>
          </ConfirmProvider>
        </ToastProvider>
      </LanguageProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
