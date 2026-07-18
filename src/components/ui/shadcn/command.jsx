// shadcn/ui — Command (palette + searchable lista) basado en cmdk.
// La base de Combobox: input arriba, lista filtrable abajo, navegación
// con teclado + selección con Enter.
import * as React from 'react'
import { Command as CommandPrimitive } from 'cmdk'
import { Search } from 'lucide-react'
import { cn } from '../../../lib/utils'

const Command = React.forwardRef(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn(
      'flex h-full w-full flex-col overflow-hidden rounded-md bg-panel text-foreground',
      className
    )}
    {...props}
  />
))
Command.displayName = CommandPrimitive.displayName

const CommandInput = React.forwardRef(({ className, ...props }, ref) => (
  // Atributo que cmdk usa internamente para su propio CSS/targeting
  // (boilerplate oficial de shadcn/cmdk, no un typo — renombrarlo a data-*
  // rompería el selector que usa la librería).
  // eslint-disable-next-line react/no-unknown-property
  <div className="flex items-center border-b border-border px-3" cmdk-input-wrapper="">
    <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        'flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none ' +
          'placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  </div>
))
CommandInput.displayName = CommandPrimitive.Input.displayName

const CommandList = React.forwardRef(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn('max-h-[300px] overflow-y-auto overflow-x-hidden', className)}
    {...props}
  />
))
CommandList.displayName = CommandPrimitive.List.displayName

const CommandEmpty = React.forwardRef((props, ref) => (
  <CommandPrimitive.Empty ref={ref} className="py-6 text-center text-sm text-muted" {...props} />
))
CommandEmpty.displayName = CommandPrimitive.Empty.displayName

const CommandGroup = React.forwardRef(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      'overflow-hidden p-1 text-foreground ' +
        '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 ' +
        '[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium ' +
        '[&_[cmdk-group-heading]]:text-muted',
      className
    )}
    {...props}
  />
))
CommandGroup.displayName = CommandPrimitive.Group.displayName

const CommandItem = React.forwardRef(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none ' +
        "data-[disabled=true]:pointer-events-none data-[selected='true']:bg-accent " +
        "data-[selected='true']:text-foreground data-[disabled=true]:opacity-50 " +
        '[&_svg]:size-4 [&_svg]:shrink-0',
      className
    )}
    {...props}
  />
))
CommandItem.displayName = CommandPrimitive.Item.displayName

export { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem }
