import React from 'react'
import type { ComponentType } from 'react'
import type { PluginHttpRequest, PluginHttpResponse } from '@shared/plugin'
import { cn } from '@/lib/utils'
import MonacoEditor from '@/components/MonacoEditor'
import * as Icons from 'lucide-react'
import * as antd from 'antd'

/** 插件向宿主注册的一个视图（侧边栏入口 + 主区域渲染组件） */
export interface PluginViewInstance {
  pluginId: string
  /** 视图 id（同一插件内唯一） */
  viewId: string
  name: string
  icon?: string
  Component: ComponentType
}

/** 插件渲染端入口 activate(api) 的返回值 */
interface PluginRegistration {
  name?: string
  views?: PluginViewInstance[]
}

/** 宿主暴露给插件渲染端的 API（通过 activate 入参注入，无需插件自带依赖） */
export interface RendererHostApi {
  id: string
  /** 直接注入 React 实例，使插件的 hooks 与主应用同一实例 */
  react: typeof React
  /** React.createElement 别名，便于无 JSX 编写 */
  h: typeof React.createElement
  storage: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
  }
  /** 发起 HTTP 请求（需插件声明 http 权限） */
  http: (req: PluginHttpRequest) => Promise<PluginHttpResponse>
  /** 调用插件自有主进程 handler（需插件在 main 入口 registerHandler） */
  invoke: (name: string, ...args: unknown[]) => Promise<unknown>
  /** 注册一个命令面板命令（可选） */
  registerCommand: (cmd: { id: string; title: string; run: () => void }) => void
  /** 注入 antd 全量模块：插件用 api.antd.Button / Modal / message 等，无需自带依赖 */
  antd: typeof antd
  /** 类名合并工具（clsx + tailwind-merge） */
  cn: typeof cn
  /** 注入的 lucide 图标集合，按名取用：api.icons.Play */
  icons: typeof Icons
  /** 注入 Monaco 编辑器组件（已配置本地化加载）：api.MonacoEditor */
  MonacoEditor: typeof MonacoEditor
}

function buildRendererHostApi(manifest: {
  id: string
}): RendererHostApi {
  const id = manifest.id
  return {
    id,
    react: React,
    h: React.createElement,
    storage: {
      get: (key) => window.api.plugins.storageGet(id, key),
      set: (key, value) => window.api.plugins.storageSet(id, key, value)
    },
    http: (req) => window.api.plugins.http(id, req),
    invoke: (name, ...args) => window.api.plugins.invoke(id, name, ...args),
    registerCommand: (cmd) => {
      // 命令面板接入：延迟到 store 可用时注册（避免循环依赖）
      import('@/stores/app-store').then(({ useAppStore }) => {
        useAppStore.getState().registerPluginCommand?.(id, cmd)
      })
    },
    // 注入 antd 全量模块与图标/工具，插件通过 api.antd / api.cn / api.icons 取用，无需自带依赖
    antd,
    cn,
    icons: Icons,
    // 注入 Monaco 编辑器组件
    MonacoEditor
  }
}

/**
 * 运行时加载所有插件：拉取 manifest 与渲染端源码，经 blob import 执行，
 * 调用 activate 收集视图。任一插件失败不影响其它插件。
 */
export async function loadPlugins(): Promise<PluginViewInstance[]> {
  const manifests = await window.api.plugins.list()
  const views: PluginViewInstance[] = []
  for (const manifest of manifests) {
    // 跳过无渲染端入口或被禁用的插件
    if (!manifest.renderer || manifest.enabled === false) continue
    try {
      const code = await window.api.plugins.rendererCode(manifest.id)
      if (!code) continue
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
      try {
        const mod = (await import(/* @vite-ignore */ url)) as {
          activate?: (api: RendererHostApi) => PluginRegistration | Promise<PluginRegistration>
          default?: { activate?: (api: RendererHostApi) => PluginRegistration | Promise<PluginRegistration> }
        }
        const activate = mod.activate ?? mod.default?.activate
        if (typeof activate !== 'function') continue
        const reg = await activate(buildRendererHostApi(manifest))
        for (const [i, v] of (reg.views ?? []).entries()) {
          // 视图必须带稳定 viewId（侧边栏 key / 路由均依赖它）；
          // 插件未提供时按 插件id:序号 兜底，保证唯一且非空。
          const viewId = v.viewId || `${manifest.id}:${i}`
          views.push({ ...v, viewId, pluginId: manifest.id })
        }
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch (e) {
      console.error(`[plugins] 渲染端加载失败：${manifest.id}`, e)
    }
  }
  return views
}
