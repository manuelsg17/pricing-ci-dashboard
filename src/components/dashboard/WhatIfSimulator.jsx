import { SlidersHorizontal, RotateCcw, X, AlertTriangle } from 'lucide-react'
import { Button } from '../ui/shadcn/button'

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
      <Button
        variant="outline"
        size="sm"
        onClick={() => setPct(0)}
        title="Reset a 0%"
        className="h-auto gap-1 rounded-md border-amber-700 bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-50"
      >
        <RotateCcw size={12} /> Reset
      </Button>
      <Button
        size="sm"
        onClick={onClose}
        title="Cerrar simulación y volver a data real"
        className="h-auto gap-1 rounded-md border border-amber-700 bg-amber-800 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-amber-900"
      >
        <X size={12} /> Cerrar
      </Button>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 10,
          color: '#78350f',
          flexBasis: '100%',
          marginTop: 2,
        }}
      >
        <AlertTriangle size={11} /> Las matrices, KPIs y charts muestran números simulados — los
        datos reales no se modifican.
      </span>
    </div>
  )
}
