import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  // 渲染进程源码根目录（index.html 所在处）
  root: 'src/renderer',
  base: './',
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src/renderer/src'),
      '@shared': resolve(import.meta.dirname, 'src/shared')
    }
  },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    strictPort: true
  },
  build: {
    outDir: resolve(import.meta.dirname, 'out/renderer'),
    emptyOutDir: true,
    // 把体积大且相对稳定的 vendor 拆成独立 chunk：便于浏览器缓存，也让首屏只加载必须的依赖
    // （vendor-antd 为 antd 框架本体，gzip 约 527kB，阈值放开到其实际大小之上）
    chunkSizeWarningLimit: 1700,
    rolldownOptions: {
      output: {
        // rolldown 的 manualChunks 仅支持函数形式：把稳定的重依赖拆成独立 vendor chunk
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
          if (i.includes('monaco')) return 'monaco'
          if (i.includes('/@xterm/')) return 'xterm'
          if (
            i.includes('/node_modules/ai/') ||
            i.includes('/node_modules/@ai-sdk/') ||
            i.includes('/node_modules/@modelcontextprotocol/')
          )
            return 'vendor-ai'
          return undefined
        }
      }
    }
  }
})
