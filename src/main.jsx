import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { SpeedInsights } from '@vercel/speed-insights/react'
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

// React Query (Fase 2 de la auditoría 2026-07-26): caché compartido para
// fetches de solo lectura duplicados entre páginas (usePricingData,
// distance_references, roles). staleTime de 2min: los datos que cachea no
// cambian segundo a segundo (bot sync corre por hora, CI se guarda por el
// hub) — evita refetch agresivo sin arriesgar datos viejos por mucho tiempo.
// refetchOnWindowFocus:false porque el patrón de "dato fresco" de este
// proyecto ya lo cubre RealtimeSyncProvider (evento config:changed vía
// audit_log), no queremos un refetch sorpresa duplicado al volver a la tab.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2 * 60 * 1000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

// Contraparte de public/404.html (Fase 3, auditoría 2026-07-26): restaura
// la ruta real ANTES de montar BrowserRouter, para que su primer render lea
// la URL correcta en vez de quedarse en `/?/market`. Debe correr acá
// (module script, respeta el CSP script-src 'self' de index.html) y no como
// script inline en el HTML, que el CSP bloquearía. Código sin modificar del
// patrón estándar (rafgraph/spa-github-pages) — el formato de query string
// que arma 404.html (`?/ruta&~and~...`) tiene que coincidir EXACTO con cómo
// se decodifica acá, así que no tocar uno sin el otro.
;(function (l) {
  if (l.search[1] === '/') {
    const decoded = l.search
      .slice(1)
      .split('&')
      .map((s) => s.replace(/~and~/g, '&'))
      .join('?')
    window.history.replaceState(null, '', l.pathname.slice(0, -1) + decoded + l.hash)
  }
})(window.location)

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <LanguageProvider>
        <ToastProvider>
          <ConfirmProvider>
            <QueryClientProvider client={queryClient}>
              <CountryProvider>
                <ConfigProvider>
                  <RealtimeSyncProvider>
                    {/* basename = import.meta.env.BASE_URL, que Vite ya
                        resuelve al `base` de vite.config.js en build time
                        ('/pricing-ci-dashboard/' en GitHub Pages, '/' en
                        Vercel) — una sola fuente de verdad para ambos
                        hostings en vez de hardcodear el path acá también.
                        BrowserRouter (no HashRouter): los filtros YA usan
                        location.hash (useFilters.js, CountryContext.jsx) —
                        HashRouter chocaría con eso. */}
                    <BrowserRouter basename={import.meta.env.BASE_URL}>
                      <App />
                    </BrowserRouter>
                    {/* No-op fuera de Vercel (GitHub Pages incluido) — el
                        paquete detecta el hosting solo y no manda nada si
                        no está corriendo ahí. */}
                    <SpeedInsights />
                  </RealtimeSyncProvider>
                </ConfigProvider>
              </CountryProvider>
            </QueryClientProvider>
          </ConfirmProvider>
        </ToastProvider>
      </LanguageProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
