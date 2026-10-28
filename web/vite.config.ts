import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // `changeOrigin: false` keeps the browser's Host, so the server's origin check sees the dev
  // server's origin and host agree. Left to its default, every write in development is refused.
  server: {
    host: '127.0.0.1',
    port: 5174,
    // Moving to 5175 would serve the board on a URL nothing points at, beside whatever holds 5174.
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4100', changeOrigin: false } },
  },
  build: { outDir: '../server/public', emptyOutDir: true },
})
