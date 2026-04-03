import { useState } from 'react'
import { useConfig }         from '../hooks/useConfig'
import ThresholdsTable       from '../components/config/ThresholdsTable'
import WeightsTable          from '../components/config/WeightsTable'
import SemaforoEditor        from '../components/config/SemaforoEditor'
import '../styles/config.css'

const TABS = [
  { id: 'thresholds', label: 'Distancias' },
  { id: 'weights',    label: 'Pesos' },
  { id: 'semaforo',   label: 'Semáforo' },
]

export default function Config() {
  const [activeTab, setActiveTab] = useState('thresholds')
  const {
    thresholds, weights, semaforo,
    loading, saving, error,
    saveThresholds, saveWeights, saveSemaforo,
  } = useConfig()

  if (loading) {
    return <div className="config-page"><div className="state-box">Cargando configuración…</div></div>
  }

  if (error) {
    return <div className="config-page"><div className="state-box state-box--error">Error: {error}</div></div>
  }

  return (
    <div className="config-page">
      <h1>Configuración</h1>

      <div className="config-tabs">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`config-tab${activeTab === t.id ? ' active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'thresholds' && (
        <ThresholdsTable
          thresholds={thresholds}
          onSave={saveThresholds}
          saving={saving}
        />
      )}

      {activeTab === 'weights' && (
        <WeightsTable
          weights={weights}
          onSave={saveWeights}
          saving={saving}
        />
      )}

      {activeTab === 'semaforo' && (
        <SemaforoEditor
          semaforo={semaforo}
          onSave={saveSemaforo}
          saving={saving}
        />
      )}
    </div>
  )
}
