'use client'

/**
 * 「让用户选一个目录」——**桌面端弹系统目录框，web 用内置的服务端目录浏览器**。
 *
 * ## 为什么要按平台分
 *
 * 这两件事**不是同一个东西**，仓库里其实早就把取舍写在 `AgentHost.pickLocalDirectory`
 * 上了：
 *
 * > 实现了 = 这个宿主跑在有本机文件系统的地方（desktop → 系统目录选择框）；
 * > 不实现 = 只能选**服务端**目录（web → 内置目录浏览器打 `/api/fs/dirs`）。
 * > 工作区登记的都是「跑 Agent 的那台机器」上的路径，所以这个区分是本质的。
 *
 * 只是那个接口一直**没有调用方**，于是所有入口都退到了 `ServerDirPicker`。后果是桌面端
 * 用户点「选择目录…」，看到的是一个自己实现的弹窗，在列**服务端**的目录 —— 而后端就跑在
 * 他本进程里（`backendManager.start()`）。绕了一大圈，还比系统框少了「记住上次位置」。
 *
 * ## 用法
 *
 * ```tsx
 * const { pick, node } = useDirectoryPicker(app, '选中的目录会登记为笔记目录。')
 * // node 放进自己的树里（Radix 会 portal 到 body，位置其实无所谓）
 * const dir = await pick()   // 取消 → null
 * ```
 *
 * `ServerDirPicker` 本体**一行没改**，只是被这层包了一下：web 端仍然需要它
 *（包括它的「在当前目录下新建文件夹」，那个走服务端的 `POST /api/fs/mkdir`，
 * 浏览器自己建不了）。
 *
 * ## 三端原生目录框都有「新建文件夹」
 *
 * 切到系统框并**不会**丢掉建目录的能力：Windows 的 `IFileOpenDialog`（`FOS_PICKFOLDERS`）、
 * GTK 的目录选择器、macOS（`properties: ['createDirectory']`）都自带。所以这条不是取舍。
 */
import { useCallback, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { getAgentHostOrNull } from '@fizz/agent-client/host'
import { ServerDirPicker } from '@fizz/agent-kit/shared/components/ServerDirPicker'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

export interface DirectoryPicker {
  /** 让用户选一个目录；用户取消（或关掉弹窗）返回 `null` */
  pick: () => Promise<string | null>
  /** 内置目录浏览器的节点；桌面端下是 `null`（走系统框，不需要界面） */
  node: ReactNode
}

export function useDirectoryPicker(app: AgentApp, description?: string): DirectoryPicker {
  const [open, setOpen] = useState(false)
  /** 「内置浏览器那一遍」等在这里的回调 —— `pick()` 返回的 Promise 靠它 settle */
  const resolveRef = useRef<((path: string | null) => void) | null>(null)

  /*
   * `getAgentHostOrNull()` 返回的是模块级单例（`setAgentHost` 只在启动时调一次），
   * 所以它**可以**进依赖；不像 `app` 那样每次渲染都是新对象。
   */
  const host = getAgentHostOrNull()
  const canPickLocal = typeof host?.pickLocalDirectory === 'function'

  const pick = useCallback(async (): Promise<string | null> => {
    // 桌面端：系统目录框，一次 await 拿到结果（取消就是 null）
    if (host?.pickLocalDirectory) return host.pickLocalDirectory()
    // web：把内置浏览器打开，等用户点「选择此目录」或取消
    return new Promise<string | null>((resolve) => {
      resolveRef.current = resolve
      setOpen(true)
    })
  }, [host])

  const settle = useCallback((path: string | null): void => {
    const resolve = resolveRef.current
    resolveRef.current = null
    resolve?.(path)
  }, [])

  /*
   * 桌面端返回 `null`（不渲染任何东西）。**不能**把这个判断放在调用方 ——
   * 那样每个调用点都要写一遍平台判断，漏一处就退回到「桌面端看服务端目录」。
   */
  const node: ReactElement | null = canPickLocal ? null : (
    <ServerDirPicker
      app={app}
      open={open}
      description={description}
      onOpenChange={(next) => {
        setOpen(next)
        // 关掉（取消按钮 / 点遮罩 / Esc）一律算「没选」—— 不 settle 的话 `pick()` 永远挂着
        if (!next) settle(null)
      }}
      onPick={(path) => settle(path)}
    />
  )

  return { pick, node }
}
