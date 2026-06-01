// ════════════════════════════════════════════════════════════════════════
// utils.js — helpers para shadcn/ui y composición de classes.
//
// `cn()` es el estándar de shadcn — combina clsx (composición condicional)
// + tailwind-merge (merge inteligente que resuelve conflictos: si pasás
// "p-2 p-4", queda "p-4"). Sin esto, dos clases del mismo grupo de
// Tailwind se duplican en el className y la última gana de forma
// impredecible cuando la fuente cambia.
//
// EJEMPLO:
//   cn('bg-primary p-2', isActive && 'p-4', className)
//   → si isActive=true → 'bg-primary p-4'
//   → className puede sobreescribir cualquier cosa anterior
// ════════════════════════════════════════════════════════════════════════
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}
