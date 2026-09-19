import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  base: './',
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src')
    }
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1700,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          const i = id.replace(/\\/g, '/')
          if (!i.includes('/node_modules/')) return undefined
          if (i.includes('/react-dom/') || i.includes('/react/')) return 'vendor-react'
          if (
            i.includes('/@ant-design/') ||
            i.includes('/@rc-component/') ||
            i.includes('/antd/') ||
            /\/rc-[^/]+\//.test(i)
          )
            return 'vendor-antd'
          return undefined
        }
      }
    }
  }
})
