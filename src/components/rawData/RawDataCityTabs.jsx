export default function RawDataCityTabs({ cityTabs, dbCity, onCityChange }) {
  return (
    <div className="raw-data__city-tabs">
      {cityTabs.map((t) => (
        <button
          key={t.db}
          className={`raw-data__city-tab${dbCity === t.db ? ' raw-data__city-tab--active' : ''}`}
          onClick={() => onCityChange(t.db)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
