import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Wails dev server expects the frontend dev server reachable on a known
  // port; build output goes to dist/ which app.go embeds via go:embed.
  build: {
    outDir: 'dist',
  },
})
