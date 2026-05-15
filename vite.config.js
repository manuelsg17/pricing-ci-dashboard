import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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
        source: JSON.stringify({
          version:   BUILD_VERSION,
          builtAt:   new Date().toISOString(),
        }, null, 2),
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), buildVersionPlugin()],
  base: '/pricing-ci-dashboard/',
  define: {
    // Expone la versión a runtime via __BUILD_VERSION__ (más simple que
    // import.meta.env.VITE_*, que requeriría leerla con cuidado).
    __BUILD_VERSION__: JSON.stringify(BUILD_VERSION),
  },
  build: {
    // Split heavy libs into vendor chunks. Reduces the size of the
    // initial main bundle so the dashboard renders faster, and lets the
    // browser cache vendor code across deploys.
    rollupOptions: {
      output: {
        // Nota: NO splitear react/react-dom en su propio chunk.
        // En aplicaciones con muchas pages lazy-loaded, splitearlo puede
        // producir errores "Invalid hook call" si Rollup termina creando
        // dos copias de React en chunks distintos. Mantener react en el
        // chunk principal (entry) es el patrón más seguro.
        manualChunks: {
          'vendor-recharts': ['recharts'],
          'vendor-pdf':      ['jspdf', 'jspdf-autotable'],
          'vendor-xlsx':     ['xlsx'],
          'vendor-canvas':   ['html2canvas'],
          'vendor-supabase': ['@supabase/supabase-js'],
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
})
