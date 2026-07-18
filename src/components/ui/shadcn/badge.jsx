// shadcn/ui — Badge. Píldora pequeña para estados/labels.
// Variantes: default, secondary, destructive, outline, success, warning.
// Las dos últimas las agregué para los semáforos del dashboard.
/* eslint-disable react-refresh/only-export-components -- patrón estándar de
   shadcn/ui: el componente y su función de variantes (badgeVariants) viven
   juntos a propósito. */
import { cva } from 'class-variance-authority'
import { cn } from '../../../lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ' +
    'transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-yango text-white',
        secondary: 'border-transparent bg-secondary text-foreground',
        destructive: 'border-transparent bg-destructive text-white',
        outline: 'border-border text-foreground',
        success: 'border-transparent bg-sem-green-bg text-sem-green-fg',
        warning: 'border-transparent bg-sem-yellow-bg text-sem-yellow-fg',
        danger: 'border-transparent bg-sem-red-bg text-sem-red-fg',
      },
    },
    defaultVariants: { variant: 'default' },
  }
)

function Badge({ className, variant, ...props }) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
