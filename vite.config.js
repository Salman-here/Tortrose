import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  define: {
    'import.meta.env.VITE_API_URL': JSON.stringify('/'),
  },
  server: {
    proxy: {
      '/api': {
        target: 'https://genzwinners-backend.vercel.app',
        changeOrigin: true,
        secure: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'Frontend/src'),
    },
  },
})
