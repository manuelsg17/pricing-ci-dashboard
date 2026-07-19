import { Button } from '../ui/shadcn/button'

export default function RawDataCityTabs({ cityTabs, dbCity, onCityChange }) {
  return (
    <div className="raw-data__city-tabs">
      {cityTabs.map((t) => (
        <Button
          key={t.db}
          variant={dbCity === t.db ? 'default' : 'outline'}
          size="sm"
          className="rounded-full"
          onClick={() => onCityChange(t.db)}
        >
          {t.label}
        </Button>
      ))}
    </div>
  )
}
