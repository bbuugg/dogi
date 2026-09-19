/**
 * 构建所有 webview 模式插件的构建脚本。
 *
 * 扫描 plugins 目录下含有 package.json 且 vite.config.ts 的插件，
 * 在其目录内执行 npm install && npm run build，将产物输出到插件 dist/。
 * 任一插件失败不影响其他插件（仅打印错误）。
 */
import { readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const PLUGINS_DIR = resolve(import.meta.dirname, '..', 'plugins')

async function buildPluginPlugins() {
  let entries
  try {
    entries = (await readdir(PLUGINS_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch (e) {
    console.error('[build-plugins] 无法读取 plugins 目录', e)
    process.exit(1)
  }

  for (const name of entries) {
    const dir = join(PLUGINS_DIR, name)
    const pkgPath = join(dir, 'package.json')
    const viteConfigPath = join(dir, 'vite.config.ts')
    // 只有同时拥有 package.json 和 vite.config.ts 的插件才需要构建
    if (!existsSync(pkgPath) || !existsSync(viteConfigPath)) {
      console.log(`[build-plugins] 跳过 ${name}（无 package.json/vite.config.ts）`)
      continue
    }

    console.log(`[build-plugins] 构建插件：${name}`)
    try {
      // 安装依赖（如果 node_modules 不存在）
      const nodeModulesPath = join(dir, 'node_modules')
      if (!existsSync(nodeModulesPath)) {
        console.log(`[build-plugins]   安装依赖...`)
        execFileSync('npm', ['install', '--no-fund', '--no-audit'], {
          cwd: dir,
          stdio: 'inherit',
          shell: true
        })
      }
      // 构建
      execFileSync('npm', ['run', 'build'], {
        cwd: dir,
        stdio: 'inherit',
        shell: true
      })
      console.log(`[build-plugins]   ✓ ${name} 构建成功`)
    } catch (e) {
      console.error(`[build-plugins]   ✗ ${name} 构建失败`, e)
    }
  }
}

await buildPluginPlugins()
