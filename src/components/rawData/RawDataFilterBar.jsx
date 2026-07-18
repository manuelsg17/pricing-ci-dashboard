import { BRACKETS, BRACKET_LABELS } from '../../lib/constants'
import { Button } from '../ui/shadcn/button'

const BRACKET_OPTIONS = [
  { value: '', label: 'Todos' },
  ...BRACKETS.map((b) => ({ value: b, label: BRACKET_LABELS[b] })),
]

const SURGE_OPTIONS = [
  { value: '', label: 'Todos' },
  { value: 'true', label: 'Sí (surge)' },
  { value: 'false', label: 'No surge' },
]

export default function RawDataFilterBar({
  config,
  dateFrom,
  setDateFrom,
  dateTo,
  setDateTo,
  dbCategory,
  setDbCategory,
  categories,
  competition,
  setCompetition,
  competitors,
  surge,
  setSurge,
  bracket,
  setBracket,
  dataSource,
  setDataSource,
  searchA,
  setSearchA,
  searchB,
  setSearchB,
  outlierOnly,
  setOutlierOnly,
  outlierThreshold,
  resetFilters,
}) {
  return (
    <div className="raw-data__filters">
      <div className="raw-data__filter-group">
        <label>Desde</label>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
      </div>
      <div className="raw-data__filter-group">
        <label>Hasta</label>
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
      </div>
      <div className="raw-data__filter-group">
        <label>Categoría</label>
        <select value={dbCategory} onChange={(e) => setDbCategory(e.target.value)}>
          <option value="">Todos</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="raw-data__filter-group">
        <label>Competidor ({competitors.length})</label>
        <select value={competition} onChange={(e) => setCompetition(e.target.value)}>
          <option value="">Todos</option>
          {competitors.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="raw-data__filter-group">
        <label>Surge</label>
        <select value={surge} onChange={(e) => setSurge(e.target.value)}>
          {SURGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="raw-data__filter-group">
        <label>Bracket</label>
        <select value={bracket} onChange={(e) => setBracket(e.target.value)}>
          {BRACKET_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="raw-data__filter-group">
        <label>Fuente</label>
        <select value={dataSource} onChange={(e) => setDataSource(e.target.value)}>
          <option value="">Todos</option>
          <option value="manual">Hubs (manual)</option>
          <option value="bot">Bot</option>
        </select>
      </div>
      <div className="raw-data__filter-group">
        <label>Punto A</label>
        <input
          type="text"
          value={searchA}
          onChange={(e) => setSearchA(e.target.value)}
          placeholder="Buscar…"
        />
      </div>
      <div className="raw-data__filter-group">
        <label>Punto B</label>
        <input
          type="text"
          value={searchB}
          onChange={(e) => setSearchB(e.target.value)}
          placeholder="Buscar…"
        />
      </div>
      <div className="raw-data__filter-group">
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={outlierOnly}
            onChange={(e) => setOutlierOnly(e.target.checked)}
          />
          <span style={{ color: outlierOnly ? '#dc2626' : undefined }}>
            ⚠ Outliers (&gt;{config.currency} {outlierThreshold})
          </span>
        </label>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 self-end border-border bg-background text-muted hover:border-yango hover:bg-background hover:text-yango"
        onClick={resetFilters}
        title="Limpiar filtros"
      >
        ✕ Limpiar
      </Button>
    </div>
  )
}
