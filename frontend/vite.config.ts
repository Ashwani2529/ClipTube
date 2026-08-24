import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      // Keeps the API same-origin in dev: no CORS preflights, and file downloads
      // triggered by navigating to /api/download/:id just work.
      '/api': {
        target: 'https://cliptube-ny8q.onrender.com',
        changeOrigin: true,
      },
    },
  },
})
