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
        manualChunks: {
          'vendor-react':    ['react', 'react-dom'],
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
