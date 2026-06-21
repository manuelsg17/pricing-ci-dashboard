import { SlidersHorizontal, RotateCcw, X } from 'lucide-react'

export default function WhatIfSimulator({ pct, setPct, onClose, compareVs = 'Yango' }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        marginBottom: 10,
        background: '#fff7ed',
        border: '1px solid #f59e0b',
        borderLeft: '3px solid #f59e0b',
        borderRadius: 10,
        flexWrap: 'wrap',
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontWeight: 700,
          fontSize: 13,
          color: '#92400e',
          flexShrink: 0,
        }}
      >
        <SlidersHorizontal size={15} /> Modo simulación
      </span>
      <span style={{ fontSize: 12, color: '#78350f', flexShrink: 0 }}>
        Ajustar <strong>{compareVs}</strong> en
      </span>
      <input
        type="range"
        min={-15}
        max={15}
        step={0.5}
        value={pct}
        onChange={(e) => setPct(Number(e.target.value))}
        style={{ flex: 1, minWidth: 200, maxWidth: 400, accentColor: '#f59e0b' }}
      />
      <span
        style={{
          fontWeight: 700,
          fontSize: 14,
          color: '#92400e',
          fontVariantNumeric: 'tabular-nums',
          minWidth: 80,
          textAlign: 'right',
        }}
      >
        {pct >= 0 ? '+' : ''}
        {pct.toFixed(1)}%
      </span>
      <button
        onClick={() => setPct(0)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 10px',
          fontSize: 11,
          fontWeight: 600,
          border: '1px solid #b45309',
          background: '#fff',
          color: '#92400e',
          borderRadius: 6,
          cursor: 'pointer',
        }}
        title="Reset a 0%"
      >
        <RotateCcw size={12} /> Reset
      </button>
      <button
        onClick={onClose}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 10px',
          fontSize: 11,
          fontWeight: 600,
          border: '1px solid #b45309',
          background: '#92400e',
          color: '#fff',
          borderRadius: 6,
          cursor: 'pointer',
        }}
        title="Cerrar simulación y volver a data real"
      >
        <X size={12} /> Cerrar
      </button>
      <span style={{ fontSize: 10, color: '#78350f', flexBasis: '100%', marginTop: 2 }}>
        ⚠ Las matrices, KPIs y charts muestran números simulados — los datos reales no se modifican.
      </span>
    </div>
  )
}
