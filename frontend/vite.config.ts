import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backendUrl = env.VITE_BACKEND_URL || 'http://127.0.0.1:8000'

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    server: {
      port: 5173,
      proxy: {
        // Forward backend calls to FastAPI during non-mock local dev.
        '/api': { target: backendUrl, changeOrigin: true },
        '/auth': { target: backendUrl, changeOrigin: true },
        '/health': { target: backendUrl, changeOrigin: true },
        '/metrics': { target: backendUrl, changeOrigin: true },
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
  }
})
