/**
 * 插件界面清单的小 store（模块级 + `useSyncExternalStore`）。
 *
 * 为什么不进 zustand：这份数据只服务「图标栏 / 侧栏 / 标签条」这几处，而且**换项目要重拉**
 * （项目级插件也能提供界面）。放进全局 store 就得为它加一个 slice、一份刷新时序，
 * 而它根本不需要与对话 / 连接那些状态互相感知 —— 本地模块级 store 更合适，
 * 与 `activity-state` / `panel-store` 同一取舍。
 *
 * 拉不到清单**静默**：没有插件界面是很常见的状态，不该弹一个错误打扰用户。
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { PluginSurfaceView } from '@fizz/contracts/agent-api'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

let surfaces: PluginSurfaceView[] = []
const listeners = new Set<() => void>()

/** 正在飞的那一批（同一个 workspaceId 的重复请求共用一次，别打两遍） */
let inflight: Promise<void> | null = null
let inflightKey: string | null = null

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): PluginSurfaceView[] {
  return surfaces
}

export function getPluginSurfaces(): PluginSurfaceView[] {
  return surfaces
}

/** 拉一次清单（同一目标已在飞就复用；换项目会另起一次） */
export function loadPluginSurfaces(app: AgentApp | null, workspaceId?: string): Promise<void> {
  const api = app?.api
  if (!api) return Promise.resolve()
  const key = workspaceId ?? ''
  if (inflight && inflightKey === key) return inflight
  inflightKey = key
  inflight = api
    .listPluginSurfaces(workspaceId)
    .then((result) => {
      surfaces = result?.surfaces ?? []
      emit()
    })
    .catch(() => {
      /* 清单拿不到 = 没有插件界面（或服务端还没就绪）：静默，界面上就是没有那些项 */
    })
    .finally(() => {
      inflight = null
      inflightKey = null
    })
  return inflight
}

/** 强制重拉（插件文件改完 / 刚启用一个插件时用） */
export function refreshPluginSurfaces(app: AgentApp | null, workspaceId?: string): void {
  inflight = null
  inflightKey = null
  void loadPluginSurfaces(app, workspaceId)
}

/**
 * 取清单（首次渲染是空的，拉回来后自动更新）。
 *
 * ⚠️ **依赖里只能放 `app.api`，绝不能放 `app` 对象本身** —— 这是本文件最容易踩的坑：
 * `useAgentApp()` 每次调用都**新建一个字面量对象**（`agentAppFrom` 里 `return { … }`，
 * 没有 memo），而 `AppProvider` 订阅的是**整个 store**（`useAgentStore()` 不带选择器）
 * —— 于是流式期间每来一个 token、store 一变，Provider 就重渲染一次，`app` 就是**新引用**。
 * 把 `app` 放进 deps，effect 就每帧重跑一次，`loadPluginSurfaces` 每帧发一次
 * `GET /api/plugins/surfaces`：控制台里刷屏的 `GET /api/plugins/surfaces → 200 2ms`
 * 以及它顺带触发的插件配置告警，都是这么来的（用户实测反馈「一轮还没结束就一直在刷」）。
 * `api` 本身是稳定的（`s.getApi()` 有缓存），拿它当依赖既准确又不会抖。
 *
 * `workspaceId` 是原始字符串，按值比较，没问题。
 */
export function usePluginSurfaces(app: AgentApp | null, workspaceId?: string): PluginSurfaceView[] {
  /*
   * 先把 app 收成它里面**稳定**的那一小块再当依赖。
   *
   * 不用 `[app?.api]` 直接写进依赖数组：`app` 为 null 时那是 `undefined`，
   * 而 eslint 的 exhaustive-deps 认的是「表达式里用到的 `app`」—— 写成变量更直白，
   * 也避免将来有人「顺手」把依赖改回 `app`。
   */
  const api = app?.api
  useEffect(() => {
    void loadPluginSurfaces(api ? app : null, workspaceId)
  }, [api, workspaceId])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
