import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * 这个项目的预览端口**由平台分配**，容器启动时用 `FIZZ_PREVIEW_PORT` 环境变量传进来
 * （Vite 镜像固定 3000）。宿主只把它映射出去一个回环端口 / 一条固定域名 —— 服务监听别的
 * 端口，用户在「预览」里看到的是一片空白，而且**没有任何报错**。
 *
 * - `host: true` = 绑 `0.0.0.0`：绑 `localhost` 时 docker 的端口转发进不到容器里；
 * - `strictPort: true`：端口被占就**直接失败**并写日志，而不是悄悄换成 3001
 *   （悄悄换端口 = 页面空白且看不出原因，这个坑踩过一次就够）；
 * - `watch.usePolling`：容器里监听的是宿主机 bind mount，inotify 事件在部分宿主上会丢，
 *   改代码后 HMR 不触发。默认关，需要时设 `FIZZ_VITE_POLLING=1` 重启容器。
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: Number(process.env.FIZZ_PREVIEW_PORT ?? 3000),
    strictPort: true,
    watch: process.env.FIZZ_VITE_POLLING === '1' ? { usePolling: true, interval: 300 } : undefined
  }
})
