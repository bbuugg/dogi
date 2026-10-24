import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * 必须**打进产物**（而不是留成 external）的第三方依赖。
 *
 * 判据：CJS 包 + 具名导入。产物是 ESM，external 的包由 Node 原生加载，走
 * `cjs-module-lexer` 探测具名导出 —— 探测不出来就直接
 * `SyntaxError: Named export 'x' not found`（`cron-parser` 实测如此，server 端已踩过）。
 * 与 `apps/server/vite.config.ts` 共用同一份清单，别只改一边。
 */
const BUNDLED_DEPS = ['cron-parser', 'luxon']

/**
 * desktop 主进程构建：ESM（Electron 28+ 原生支持）。
 *
 * 本地模块（相对路径 / 盘符绝对路径 / @fizz workspace 包）参与打包，
 * 其余 bare import（electron / node 内置 / 第三方）保持 external。
 * `@fizz/agent-host` 的子路径必须逐条列在 `@fizz/agent-host` 之前（前缀匹配）。
 *
 * ⚠️ external 的 bare 依赖（hono / ai / @mastra/core / @modelcontextprotocol/sdk /
 * @ai-sdk/* / zod / @agentclientprotocol/sdk / @hono/node-server /
 * simple-git / ws …）**必须在 apps/desktop/package.json 的
 * dependencies 里声明**：electron-builder 只把生产依赖放进 asar，devDependencies 不带。
 * 漏一个的后果不是「某个工具不能用」，而是**整个进程内后端装载失败**
 * （`Cannot find package 'xxx'`）→ 界面上每个请求都报错。加新 import 时先确认它在哪一侧。
 *
 * ⚠️ **懒加载（await import）的第三方依赖同样要在这里声明**，症状与上面不同：后端能起来，
 * 只有用到那个工具的瞬间才报错，而且 `packages/tools/src/web-fetch.ts` 把它 catch 成了
 * 「turndown 未安装」这种人话错误 —— 上线后排查半天看不出是打包漏依赖。
 * 典型例子：`turndown`（web_fetch 静态抓取要用的 HTML→Markdown 转换器）由
 * `packages/tools` 声明并动态 import，桌面端打包时必须镜像一份到这里。
 * 判据很简单：**只要 out/main 的产物里还留着 `import "裸包名"`（哪怕是懒加载），
 * 这个包名就得出现在下面的 dependencies 里**。
 *
 * ⚠️ 尤其容易漏的是**由 workspace 包间接引入的依赖**：你在 `packages/xxx` 里加一行 import，
 * 打包产物里就多一个裸包名，但 `apps/desktop` 的依赖清单没人会想起来同步 ——
 * `jiti`（`@fizz/plugin/loader` 用它直跑 TS 插件）与 `js-yaml`（它解析 `plugins.yml`）
 * 就是这样漏过一轮，桌面版启动即 `Cannot find package 'jiti'`。
 * 改完 `packages/**` 的第三方 import 后，照着上面那条判据扫一遍 `apps/desktop/out/main/*.js`
 * （或在 `apps/desktop/package.json` 的 dependencies 里搜一遍包名）再提交。
 */
export default defineConfig({
  root: import.meta.dirname,
  // lib 构建：public/（monaco-editor 等渲染端静态资源）不参与，拷进去只会拖慢构建
  publicDir: false,
  resolve: {
    alias: {
      '@fizz/i18n': resolve(import.meta.dirname, '../../packages/i18n/src/index.ts'),
      '@fizz/contracts/types': resolve(import.meta.dirname, '../../packages/contracts/src/types.ts'),
      '@fizz/contracts/workspace-config': resolve(
        import.meta.dirname,
        '../../packages/contracts/src/workspace-config.ts'
      ),
      '@fizz/contracts/agent-api': resolve(
        import.meta.dirname,
        '../../packages/contracts/src/agent-api.ts'
      ),
      '@fizz/contracts/agent-flow': resolve(
        import.meta.dirname,
        '../../packages/contracts/src/agent-flow.ts'
      ),
      // ⚠️ `./workspace`（路径安全，Node 专用）必须列在根入口**之前**：
      // 否则 alias 前缀匹配会把它拼成 `…/src/index.ts/workspace`（UNLOADABLE_DEPENDENCY）
      '@fizz/contracts/workspace': resolve(
        import.meta.dirname,
        '../../packages/contracts/src/workspace.ts'
      ),
      '@fizz/contracts': resolve(import.meta.dirname, '../../packages/contracts/src/index.ts'),
      /*
       * 进程内后端直接打包 `apps/server/src/app.ts`（不依赖它的 dist 产物）。
       * 而 server 的业务代码（`api/**`、`server/**`）是从 Next 版整棵搬过来的，
       * 内部仍写根目录那套 `@/…` 路径 —— 所以这里的 alias 必须与
       * `apps/server/vite.config.ts` 完全一致，且 `@/lib/server` 要排在 `@/lib` 之前。
       */
      '@/lib/server': resolve(import.meta.dirname, '../../apps/server/src/server'),
      '@/lib': resolve(import.meta.dirname, '../../apps/server/src/lib'),
      '@/app/api': resolve(import.meta.dirname, '../../apps/server/src/api'),
      '@fizz/agent-host/env': resolve(import.meta.dirname, '../../packages/agent-host/src/env.ts'),
      '@fizz/agent-host/manager': resolve(
        import.meta.dirname,
        '../../packages/agent-host/src/manager.ts'
      ),
      '@fizz/agent-host/transport-ipc': resolve(
        import.meta.dirname,
        '../../packages/agent-host/src/transport-ipc.ts'
      ),
      '@fizz/agent-host/preload': resolve(
        import.meta.dirname,
        '../../packages/agent-host/src/preload.ts'
      ),
      '@fizz/agent-host/channels': resolve(
        import.meta.dirname,
        '../../packages/agent-host/src/channels.ts'
      ),
      '@fizz/agent-host': resolve(import.meta.dirname, '../../packages/agent-host/src/index.ts'),
      // ⚠️ `server/ws`（WS 分流器）必须列在 `server`（app.ts）之前：进程内后端要靠它挂 WS
      '@fizz/server/ws': resolve(import.meta.dirname, '../../apps/server/src/server/ws.ts'),
      // 公网预览入口：远程访问那个监听按 Host 分派给容器（与独立部署同一套）
      '@fizz/server/container-projects/public-gateway': resolve(
        import.meta.dirname,
        '../../apps/server/src/server/container-projects/public-gateway.ts'
      ),
      // 「对外监听」登记（公网域名能不能用的判据）也在这里
      '@fizz/server/container-projects/lifecycle': resolve(
        import.meta.dirname,
        '../../apps/server/src/server/container-projects/lifecycle.ts'
      ),
      '@fizz/server': resolve(import.meta.dirname, '../../apps/server/src/app.ts')
    }
  },
  build: {
    // 绝对路径：从仓库根执行 `vite build -c apps/desktop/vite.main.mts` 时，
    // 相对 outDir 会按 config root 解析 —— 那会覆盖根应用的 out/
    outDir: resolve(import.meta.dirname, 'out/main'),
    emptyOutDir: true,
    minify: false,
    target: 'node24',
    lib: {
      entry: resolve(import.meta.dirname, 'src/main/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js'
    },
    rollupOptions: {
      external: (id) =>
        // 例外：这些要内联（见 BUNDLED_DEPS 的说明）
        !BUNDLED_DEPS.some((dep) => id === dep || id.startsWith(`${dep}/`)) &&
        !id.startsWith('.') &&
        !id.startsWith('/') &&
        !id.startsWith('@/') &&
        !id.startsWith('@fizz') &&
        !/^[A-Za-z]:[\\/]/.test(id)
    }
  }
})
