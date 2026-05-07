import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/pricing-ci-dashboard/',
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
