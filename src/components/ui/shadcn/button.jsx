// shadcn/ui — Button. Adaptado a JS (versión oficial es TS).
// Variantes: default (primary Yango), destructive, outline, secondary, ghost, link.
// Sizes: default, sm, lg, icon.
// Uso: <Button variant="outline" size="sm">Texto</Button>
/* eslint-disable react-refresh/only-export-components -- patrón estándar de
   shadcn/ui: el componente y su función de variantes (buttonVariants) viven
   juntos a propósito. */
import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva } from 'class-variance-authority'
import { cn } from '../../../lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ' +
    'appearance-none border-0 transition-colors focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-offset-2 focus-visible:ring-yango disabled:pointer-events-none disabled:opacity-50 ' +
    '[&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-yango text-white hover:bg-yango/90 shadow-sm',
        destructive: 'bg-destructive text-white hover:bg-destructive/90 shadow-sm',
        outline: 'border border-solid border-border bg-panel hover:bg-accent hover:text-foreground',
        secondary: 'bg-secondary text-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-foreground',
        link: 'text-yango underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-6',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
)

const Button = React.forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button'
  return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
})
Button.displayName = 'Button'

export { Button, buttonVariants }
