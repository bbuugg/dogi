import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * 容器内运行时（`runtime.mjs`）的构建：**vite 库构建**，产出与入口同目录的
 * `runtime.mjs`（入库，随镜像 COPY 进 `/app`）。
 *
 * 两个必须记住的坑（与仓库其它 vite 配置同源）：
 *
 * 1. **`@fizz/*` 必须内联，非 `@fizz` 裸导入必须 external。**
 *    `@fizz/*` 是「源码即入口」的 workspace 包（node_modules 里是软链，解析出来是**绝对路径**），
 *    所以 external 判定必须把**盘符绝对路径**也算作「本地源码」（`!/^[A-Za-z]:[\\/]/`）——
 *    这条与 `apps/desktop/vite.main.mts` 一字不差地同源。少了它，`@fizz/agent` 会被解析成
 *    `D:/…/packages/agent/src/index.ts` 后被留成 external，容器里没有那个路径 → 起不来。
 *
 * 2. ⚠️ **绝不要加 `ssr: true`**。SSR 构建会把 node_modules 依赖**自行**标成 external，
 *    且那个判定与 `rollupOptions.external` 是**并集**，用 `ssr.noExternal` 也压不住
 *    workspace 软链包（实测：仍然留成 `D:/…/src/index.ts` 的绝对路径导入）。桌面主进程那份
 *    node 构建同样不用 `ssr: true`，照着它写就对了。
 *
 * 3. **`outDir` 必须用绝对路径**：vite 的 `outDir` 相对 **vite root**（= 执行命令时的 CWD =
 *    仓库根）解析，写相对路径会把产物倒进根目录的 `dist/`。
 *
 * 产物里的第三方裸导入由 `scripts/check-runtime-deps.mjs` 在构建期逐个比对
 * `docker/container-project/runtime/package.json` 的 dependencies（见根 `build:runtime`）。
 */
export default defineConfig({
  build: {
    // 与入口同目录（产物入库）
    outDir: resolve(import.meta.dirname, '.'),
    emptyOutDir: false,
    // 产物要能读（容器里排障直接看它），且不做压缩以免打乱裸导入扫描
    minify: false,
    target: 'node22',
    lib: {
      entry: resolve(import.meta.dirname, 'entry.ts'),
      formats: ['es'],
      fileName: () => 'runtime.mjs'
    },
    rollupOptions: {
      output: { entryFileNames: 'runtime.mjs' },
      external: (id) =>
        !id.startsWith('.') &&
        !id.startsWith('/') &&
        !id.startsWith('@fizz') &&
        // 盘符绝对路径 = workspace 包的源码，必须内联（见文件头说明）
        !/^[A-Za-z]:[\\/]/.test(id)
    }
  }
})
