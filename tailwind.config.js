/**
 * Tailwind CSS config (Sprint 2.1)
 *
 * DECISIÓN: preflight DESHABILITADO. Tailwind por default resetea estilos
 * default del browser (margins en headings, appearance de buttons, etc.).
 * Como el proyecto YA tiene 100+ componentes con CSS específico que
 * depende de esos defaults, habilitar preflight causaría regressions
 * visuales masivas. Sin preflight, las utility classes (bg-*, text-*,
 * p-*, etc.) siguen funcionando perfecto para componentes nuevos.
 *
 * Los tokens de color mapean a CSS variables ya definidas en global.css
 * para que `bg-yango`, `text-sem-green-fg`, etc. siempre vayan en sync
 * con los tokens existentes.
 */

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  // No prefix — usamos clases nativas (bg-blue-500, etc.)
  prefix: '',
  // Mode: 'class' permite toggle manual de dark. Si en el futuro
  // se agrega dark mode (deferred), basta agregar 'dark' class al <html>.
  darkMode: ['class'],
  corePlugins: {
    // CRÍTICO: NO resetear estilos default. Ver header del archivo.
    preflight: false,
  },
  theme: {
    container: {
      center: true,
      padding: '1rem',
    },
    extend: {
      colors: {
        // Brand
        yango: {
          DEFAULT: 'var(--color-yango, #E53935)',
          fg:      'var(--color-yango-fg, #ffffff)',
        },
        // Semaforo (tokens en global.css)
        'sem-green':  { bg: 'var(--sem-green-bg)',  fg: 'var(--sem-green-fg)'  },
        'sem-yellow': { bg: 'var(--sem-yellow-bg)', fg: 'var(--sem-yellow-fg)' },
        'sem-red':    { bg: 'var(--sem-red-bg)',    fg: 'var(--sem-red-fg)'    },
        // App neutrals (mapean a global.css)
        muted:    'var(--color-muted, #6b7280)',
        border:   'var(--color-border, #e2e8f0)',
        panel:    'var(--color-panel,  #ffffff)',
        // shadcn-style aliases (para que primitivas shadcn sean drop-in)
        background: 'var(--color-bg, #f8fafc)',
        foreground: 'var(--color-text, #0f172a)',
        primary: {
          DEFAULT:    'var(--color-yango, #E53935)',
          foreground: '#ffffff',
        },
        secondary: {
          DEFAULT:    'var(--color-panel, #f1f5f9)',
          foreground: 'var(--color-text, #0f172a)',
        },
        destructive: {
          DEFAULT:    'var(--sem-red-fg, #5a1f1f)',
          foreground: '#ffffff',
        },
        accent: {
          DEFAULT:    'var(--color-bg-soft, #f1f5f9)',
          foreground: 'var(--color-text, #0f172a)',
        },
      },
      fontFamily: {
        sans: ['var(--font-main)', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        // Escala tipográfica derivada del audit Sprint 1 (defer #6).
        // Permite migración gradual: text-xs/sm/base/lg/xl funcionan
        // como tokens consistentes. Componentes legacy siguen con sus
        // sizes hardcoded hasta que se migren.
        xs:   ['12px', { lineHeight: '1.4' }],
        sm:   ['13px', { lineHeight: '1.5' }],
        base: ['14px', { lineHeight: '1.5' }],
        lg:   ['16px', { lineHeight: '1.5' }],
        xl:   ['18px', { lineHeight: '1.4' }],
        '2xl': ['22px', { lineHeight: '1.3' }],
        '3xl': ['28px', { lineHeight: '1.3' }],
      },
      borderRadius: {
        sm:   'var(--radius-sm, 4px)',
        DEFAULT: 'var(--radius-md, 8px)',
        md:   'var(--radius-md, 8px)',
        lg:   'var(--radius-lg, 12px)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.05))',
        DEFAULT: 'var(--shadow-md, 0 4px 12px rgba(0,0,0,0.10), 0 2px 4px rgba(0,0,0,0.06))',
      },
    },
  },
  plugins: [],
}
