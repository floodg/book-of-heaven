import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const supabaseApi = 'http://127.0.0.1:54331'
const supabaseProxy = {
  target: supabaseApi,
  changeOrigin: true,
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react/jsx-runtime'],
  },
  server: {
    allowedHosts: ['dallyingly-cisternal-loida.ngrok-free.dev'],
    proxy: {
      '/auth': supabaseProxy,
      '/rest': supabaseProxy,
      '/functions': supabaseProxy,
      '/realtime': { ...supabaseProxy, ws: true },
      '/storage': supabaseProxy,
    },
  },
})