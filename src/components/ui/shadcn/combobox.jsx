// Combobox — composición de Popover + Command + Button. Patrón oficial
// shadcn/ui. Single-select con búsqueda. Para Sprint 2.5 (selector de
// competidor en Head-to-Head view).
//
// USO:
//   <Combobox
//     items={[{ value: 'Cabify', label: 'Cabify' }, ...]}
//     value={selected}
//     onValueChange={setSelected}
//     placeholder="Elegir competidor…"
//   />
import * as React from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { Button } from './button'
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from './command'
import { Popover, PopoverContent, PopoverTrigger } from './popover'

export function Combobox({
  items = [],
  value,
  onValueChange,
  placeholder = 'Seleccionar…',
  searchPlaceholder = 'Buscar…',
  emptyText = 'Sin resultados.',
  className,
  triggerClassName,
}) {
  const [open, setOpen] = React.useState(false)
  const selected = items.find((it) => it.value === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn('w-full justify-between font-normal', triggerClassName)}
        >
          {selected ? selected.label : placeholder}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className={cn('w-[--radix-popover-trigger-width] p-0', className)} align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {items.map((item) => (
                <CommandItem
                  key={item.value}
                  value={item.value}
                  onSelect={(v) => {
                    onValueChange?.(v === value ? '' : v)
                    setOpen(false)
                  }}
                >
                  <Check className={cn('mr-2 h-4 w-4', value === item.value ? 'opacity-100' : 'opacity-0')} />
                  {item.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
