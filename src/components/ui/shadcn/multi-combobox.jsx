// shadcn/ui — MultiCombobox. Variante multi-select de Combobox: Popover +
// Command + chips removibles. Solo permite elegir de `items` (sin texto
// libre) — pensado para reemplazar inputs de texto separados por comas
// donde un typo rompe un matching silencioso aguas abajo (ej: Bot Rules →
// Ciudades).
//
// Si `value` trae un string que NO está en `items` (dato heredado /
// prefill externo), se muestra igual como chip pero en rojo con ⚠ — nunca
// se descarta en silencio, así el usuario ve y puede limpiar valores
// huérfanos en vez de que desaparezcan.
//
// USO:
//   <MultiCombobox
//     items={[{ value: 'Lima', label: 'Lima' }, ...]}
//     value={rule.cities}
//     onValueChange={(next) => updateRule(rule.id, 'cities', next)}
//     allLabel="Todas las ciudades"
//   />
import * as React from 'react'
import { Check, ChevronsUpDown, X } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { buttonVariants } from './button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './command'
import { Popover, PopoverContent, PopoverTrigger } from './popover'

export function MultiCombobox({
  items = [],
  value = [],
  onValueChange,
  placeholder = 'Seleccionar…',
  searchPlaceholder = 'Buscar…',
  emptyText = 'Sin resultados.',
  allLabel,
  className,
  triggerClassName,
  style,
}) {
  const [open, setOpen] = React.useState(false)
  const selectedSet = React.useMemo(() => new Set(value), [value])

  // Cada valor seleccionado se resuelve contra `items`; si no matchea a
  // ninguno (dato huérfano/typo heredado), se conserva visible como chip
  // "unknown" en vez de desaparecer silenciosamente.
  const selectedChips = value.map((v) => {
    const found = items.find((it) => it.value === v)
    return found || { value: v, label: v, unknown: true }
  })

  function toggle(v) {
    if (selectedSet.has(v)) {
      onValueChange?.(value.filter((x) => x !== v))
    } else {
      onValueChange?.([...value, v])
    }
  }
  function remove(v, e) {
    e.stopPropagation()
    e.preventDefault()
    onValueChange?.(value.filter((x) => x !== v))
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          role="combobox"
          aria-expanded={open}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setOpen((v) => !v)
            }
          }}
          style={style}
          className={cn(
            buttonVariants({ variant: 'outline' }),
            'h-auto min-h-9 w-full cursor-pointer flex-wrap justify-between gap-1.5 py-1.5 font-normal',
            triggerClassName
          )}
        >
          <div className="flex flex-1 flex-wrap items-center gap-1">
            {selectedChips.length === 0 ? (
              <span className="text-muted">{allLabel || placeholder}</span>
            ) : (
              selectedChips.map((it) => (
                <span
                  key={it.value}
                  title={
                    it.unknown
                      ? `"${it.label}" no está en la lista de ciudades del país`
                      : undefined
                  }
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                    it.unknown ? 'bg-sem-red-bg text-sem-red-fg' : 'bg-yango/10 text-yango'
                  )}
                >
                  {it.unknown && '⚠ '}
                  {it.label}
                  <button
                    type="button"
                    onClick={(e) => remove(it.value, e)}
                    className="rounded-full p-0.5 hover:bg-black/10"
                    aria-label={`Quitar ${it.label}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))
            )}
          </div>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </div>
      </PopoverTrigger>
      <PopoverContent
        className={cn('w-[--radix-popover-trigger-width] p-0', className)}
        align="start"
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {items.map((item) => (
                <CommandItem
                  key={item.value}
                  value={item.value}
                  onSelect={() => toggle(item.value)}
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4',
                      selectedSet.has(item.value) ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {item.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {value.length > 0 && (
            <div className="border-t border-border p-1">
              <button
                type="button"
                onClick={() => onValueChange?.([])}
                className="w-full rounded-sm px-2 py-1.5 text-left text-xs text-muted hover:bg-accent"
              >
                Limpiar selección ({value.length})
              </button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
