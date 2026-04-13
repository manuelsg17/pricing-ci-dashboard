import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { LanguageProvider } from './context/LanguageContext'
import { CountryProvider }  from './context/CountryContext'
import './styles/global.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <LanguageProvider>
      <CountryProvider>
        <App />
      </CountryProvider>
    </LanguageProvider>
  </React.StrictMode>
)
