/**
 * 「创建一个插件」的服务端实现 —— 项目工具 `create_plugin` 的落点。
 *
 * 三件事：
 * 1. 用 `@fizz/tools` 的 `buildPluginSource` 把**结构化参数**套成形状一定合法的插件源码
 *    （工具少写 `execute` 会让会话静默卡死，模板生成从根上避免这种写法）；
 * 2. 写进 `<项目>/.fizz/plugins/<目录>/`（`plugin.json` + `index.ts`，与 `standardPluginRoots`
 *    的项目级根一致）；**目录已存在就拒绝** —— 绝不覆盖磁盘上别人手写的插件；
 * 3. 落盘后**立刻真加载 + apply 一遍**（`discoverPlugins` → `inspectPluginUi`，与「项目插件」
 *    弹窗、运行时挂载走的是同一条链路），没过就把刚写的目录删掉并把原因抛回去 ——
 *    「写了个坏插件、下一轮才发现」不如当场说清。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { discoverPlugins, inspectPluginUi } from '@fizz/plugin/loader'
import type { PluginManifest } from '@fizz/plugin'
import { buildPluginSource, pluginDirName, type PluginCreateInput, type PluginCreateResult } from '@fizz/tools'
import { domain } from './state'

/** 插件文件落在项目里的固定位置（项目级插件根） */
export function workspacePluginDir(workspacePath: string): string {
  return join(workspacePath, '.fizz', 'plugins')
}

export async function createPluginFile(input: PluginCreateInput): Promise<PluginCreateResult> {
  const workspace = domain.getWorkspace(input.workspaceId)
  if (!workspace) throw new Error(`项目不存在：${input.workspaceId}`)
  if (!workspace.path) throw new Error(`项目「${workspace.name}」没有磁盘目录，放不了插件`)

  const source = buildPluginSource(input)
  const root = workspacePluginDir(workspace.path)
  const dirName = pluginDirName(input.toolName)
  const dir = join(root, dirName)
  const file = join(dir, 'index.ts')
  const manifest: PluginManifest = {
    id: dirName,
    name: input.name,
    version: '1.0.0',
    apiVersion: 1,
    entry: 'index.ts',
    description: input.toolDescription
  }

  await mkdir(root, { recursive: true })
  try {
    // 目录已存在就失败：不覆盖已有插件（可能是用户手写的，或被别处改过）
    await mkdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `插件目录已存在：${dir}。换个 toolName，或让用户先删掉那个目录（助手不覆盖已有插件）。`
      )
    }
    throw err
  }

  try {
    await writeFile(join(dir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx'
    })
    await writeFile(file, source, { flag: 'wx' })
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }

  // 体检：先确认它真的会被扫到（manifest / 落点对），再跑一遍 apply（语法错 / 工具形状不对都会现形）
  const descriptors = await discoverPlugins({ workspacePath: workspace.path, home: homedir() })
  const descriptor = descriptors.find((d) => d.id === dirName)
  const { errors } = descriptor
    ? await inspectPluginUi([descriptor])
    : { errors: [`插件没被扫描到（manifest 或落点不对）：${dir}`] }
  if (errors.length) {
    // 坏插件不留：留着的话下一轮对话每轮都会报一次，用户还得自己去删
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    throw new Error(`插件没通过加载体检，已删掉刚写的目录 —— ${errors.join('；')}`)
  }

  return { id: dirName, name: input.name, file, toolName: input.toolName, source }
}
