import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ════════════════════════════════════════════════════════════════════════
// Build version stamping
//
// Cada build genera un identificador único (timestamp). El app lee este
// valor al cargar (via import.meta.env.VITE_BUILD_VERSION) y también
// fetchea /version.json en runtime. Si difieren → hay deploy nuevo →
// mostrar toast "Hay una nueva versión, recargá".
//
// Esto soluciona el caso "yo deployé un fix pero la otra sesión sigue
// viendo el bundle viejo hasta que aprieten F5".
// ════════════════════════════════════════════════════════════════════════
const BUILD_VERSION = `${Date.now()}`

function buildVersionPlugin() {
  return {
    name: 'build-version-emitter',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify(
          {
            version: BUILD_VERSION,
            builtAt: new Date().toISOString(),
          },
          null,
          2
        ),
      })
    },
  }
}

// Vercel sirve el sitio desde la raíz del dominio (no un subpath como
// GitHub Pages, que necesita /pricing-ci-dashboard/ porque es un project
// site en username.github.io/repo-name/). Vercel setea la env var VERCEL=1
// automáticamente en todos sus builds — la usamos para elegir el base
// correcto sin duplicar configuración entre ambos hostings.
const base = process.env.VERCEL ? '/' : '/pricing-ci-dashboard/'

export default defineConfig({
  plugins: [react(), buildVersionPlugin()],
  base,
  // Aliases para imports sin paths relativos largos.
  // Uso opcional: el código existente con '../../lib/foo' sigue funcionando.
  // Patrón nuevo recomendado: '@/lib/foo', '@/hooks/useFoo', etc.
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@/components': path.resolve(__dirname, 'src/components'),
      '@/hooks': path.resolve(__dirname, 'src/hooks'),
      '@/lib': path.resolve(__dirname, 'src/lib'),
      '@/context': path.resolve(__dirname, 'src/context'),
      '@/pages': path.resolve(__dirname, 'src/pages'),
      '@/styles': path.resolve(__dirname, 'src/styles'),
    },
  },
  define: {
    // Expone la versión a runtime via __BUILD_VERSION__ (más simple que
    // import.meta.env.VITE_*, que requeriría leerla con cuidado).
    __BUILD_VERSION__: JSON.stringify(BUILD_VERSION),
  },
  build: {
    // Split heavy libs into vendor chunks. Reduces the size of the
    // initial main bundle so the dashboard renders faster, and lets the
    // browser cache vendor code across deploys.
    //
    // Auditoría de rendimiento 2026-07-26: la forma-objeto de manualChunks
    // (agrupar 'recharts' por nombre de paquete) terminaba arrastrando
    // React ADENTRO de vendor-recharts (Rollup mete ahí cualquier módulo
    // compartido que no haya sido reclamado antes por otro chunk) — el
    // comentario viejo de acá decía "no splitear react" para evitar
    // "Invalid hook call", pero el resultado real era peor: TODA sesión
    // descargaba recharts (548 KB) + jsPDF (422 KB) desde el arranque,
    // aunque nunca visitara una página con gráficos ni exportara un PDF.
    // Confirmado leyendo el bundle real y el modulepreload de index.html.
    //
    // Fix: manualChunks como FUNCIÓN — aísla React en su propio chunk de
    // verdad (por ruta de node_modules, no por nombre de paquete listado),
    // y saca recharts/jspdf del agrupamiento forzado. Como recharts solo
    // lo importan páginas ya lazy() (App.jsx) y jspdf/html2canvas solo se
    // cargan vía `await import(...)` dentro de handlers de exportar
    // (nunca estático), Rollup los deja como chunks async normales,
    // cargados recién cuando el hub entra a esa página o aprieta
    // "Exportar" — no en el arranque de ninguna sesión.
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Código propio pesado que es DATOS, no lógica: cada diccionario en
          // su chunk (en/ru se cargan bajo demanda) y el catálogo de países
          // aparte. Sin esto Rollup los metía en el chunk compartido más
          // temprano (543 kB en el camino crítico, revisión 2026-09-03).
          if (/\/src\/lib\/i18n\/(es|en|ru)\.js$/.test(id)) return `i18n-${RegExp.$1}`
          if (id.endsWith('/src/lib/constants.js')) return 'app-config'
          if (!id.includes('node_modules')) return undefined
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'vendor-react'
          if (id.includes('@supabase/supabase-js')) return 'vendor-supabase'
          if (id.includes('/xlsx/')) return 'vendor-xlsx'
          return undefined
        },
      },
    },
    // 400: que el build vuelva a avisar — el chunk de 543 kB pasaba en silencio con 600.
    chunkSizeWarningLimit: 400,
  },
})
