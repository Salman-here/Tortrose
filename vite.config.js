import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const normalizeApiUrl = (value, fallback) => {
  const raw = String(value || fallback).trim()
  return raw.endsWith('/') ? raw : `${raw}/`
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const fallbackApiUrl = mode === 'production'
    ? 'https://rozare.up.railway.app/'
    : 'http://localhost:5000/'
  const apiUrl = normalizeApiUrl(env.VITE_API_URL || process.env.VITE_API_URL, fallbackApiUrl)

  return {
    plugins: [
      react(),
      tailwindcss(),
    ],
    define: {
      'import.meta.env.VITE_API_URL': JSON.stringify(apiUrl),
    },
    server: {
      proxy: {
        '/api': {
          target: apiUrl,
          changeOrigin: true,
          secure: true,
        },
      },
    },
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        '@': path.resolve(__dirname, 'Frontend/src'),
      },
    },
    optimizeDeps: {
      include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react-toastify'],
    },
  }
})
