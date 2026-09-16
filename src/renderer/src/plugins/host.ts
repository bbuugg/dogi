import React from 'react'
import type { ComponentType } from 'react'
import type { PluginHttpRequest, PluginHttpResponse } from '@shared/plugin'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import MonacoEditor from '@/components/MonacoEditor'
import * as Icons from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel } from '@/components/ui/alert-dialog'
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator } from '@/components/ui/context-menu'
import { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption } from '@/components/ui/table'
import { Drawer, DrawerTrigger, DrawerClose, DrawerContent, DrawerHeader, DrawerFooter, DrawerTitle, DrawerDescription } from '@/components/ui/drawer'

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
  /** 注入的 shadcn 组件与工具：插件无需自带依赖即可使用一致 UI（避免裸导入） */
  ui: {
    cn: typeof cn
    Button: typeof Button
    Input: typeof Input
    Textarea: typeof Textarea
    Label: typeof Label
    Badge: typeof Badge
    Switch: typeof Switch
    Separator: typeof Separator
    ScrollArea: typeof ScrollArea
    Select: typeof Select
    SelectTrigger: typeof SelectTrigger
    SelectValue: typeof SelectValue
    SelectContent: typeof SelectContent
    SelectItem: typeof SelectItem
    Tabs: typeof Tabs
    TabsList: typeof TabsList
    TabsTrigger: typeof TabsTrigger
    TabsContent: typeof TabsContent
    Dialog: typeof Dialog
    DialogTrigger: typeof DialogTrigger
    DialogContent: typeof DialogContent
    DialogHeader: typeof DialogHeader
    DialogTitle: typeof DialogTitle
    DialogDescription: typeof DialogDescription
    DialogFooter: typeof DialogFooter
    Popover: typeof Popover
    PopoverTrigger: typeof PopoverTrigger
    PopoverContent: typeof PopoverContent
    DropdownMenu: typeof DropdownMenu
    DropdownMenuTrigger: typeof DropdownMenuTrigger
    DropdownMenuContent: typeof DropdownMenuContent
    DropdownMenuItem: typeof DropdownMenuItem
    DropdownMenuLabel: typeof DropdownMenuLabel
    DropdownMenuSeparator: typeof DropdownMenuSeparator
    AlertDialog: typeof AlertDialog
    AlertDialogTrigger: typeof AlertDialogTrigger
    AlertDialogContent: typeof AlertDialogContent
    AlertDialogHeader: typeof AlertDialogHeader
    AlertDialogTitle: typeof AlertDialogTitle
    AlertDialogDescription: typeof AlertDialogDescription
    AlertDialogFooter: typeof AlertDialogFooter
    AlertDialogAction: typeof AlertDialogAction
    AlertDialogCancel: typeof AlertDialogCancel
    ContextMenu: typeof ContextMenu
    ContextMenuTrigger: typeof ContextMenuTrigger
    ContextMenuContent: typeof ContextMenuContent
    ContextMenuItem: typeof ContextMenuItem
    ContextMenuLabel: typeof ContextMenuLabel
    ContextMenuSeparator: typeof ContextMenuSeparator
    Table: typeof Table
    TableHeader: typeof TableHeader
    TableBody: typeof TableBody
    TableFooter: typeof TableFooter
    TableHead: typeof TableHead
    TableRow: typeof TableRow
    TableCell: typeof TableCell
    TableCaption: typeof TableCaption
    Drawer: typeof Drawer
    DrawerTrigger: typeof DrawerTrigger
    DrawerClose: typeof DrawerClose
    DrawerContent: typeof DrawerContent
    DrawerHeader: typeof DrawerHeader
    DrawerFooter: typeof DrawerFooter
    DrawerTitle: typeof DrawerTitle
    DrawerDescription: typeof DrawerDescription
  }
  /** 注入的 lucide 图标集合，按名取用：api.icons.Play */
  icons: typeof Icons
  /** 全局通知（与主应用同一 Toaster）：api.toast.success('...') */
  toast: typeof toast
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
    // 注入 shadcn 组件与图标，插件通过 api.ui / api.icons 取用，无需自带依赖
    ui: {
      cn,
      Button,
      Input,
      Textarea,
      Label,
      Badge,
      Switch,
      Separator,
      ScrollArea,
      Select,
      SelectTrigger,
      SelectValue,
      SelectContent,
      SelectItem,
      Tabs,
      TabsList,
      TabsTrigger,
      TabsContent,
      Dialog,
      DialogTrigger,
      DialogContent,
      DialogHeader,
      DialogTitle,
      DialogDescription,
      DialogFooter,
      Popover,
      PopoverTrigger,
      PopoverContent,
      DropdownMenu,
      DropdownMenuTrigger,
      DropdownMenuContent,
      DropdownMenuItem,
      DropdownMenuLabel,
      DropdownMenuSeparator,
      AlertDialog,
      AlertDialogTrigger,
      AlertDialogContent,
      AlertDialogHeader,
      AlertDialogTitle,
      AlertDialogDescription,
      AlertDialogFooter,
      AlertDialogAction,
      AlertDialogCancel,
      ContextMenu,
      ContextMenuTrigger,
      ContextMenuContent,
      ContextMenuItem,
      ContextMenuLabel,
      ContextMenuSeparator,
      Table,
      TableHeader,
      TableBody,
      TableFooter,
      TableHead,
      TableRow,
      TableCell,
      TableCaption,
      Drawer,
      DrawerTrigger,
      DrawerClose,
      DrawerContent,
      DrawerHeader,
      DrawerFooter,
      DrawerTitle,
      DrawerDescription
    },
    icons: Icons,
    // 注入全局通知，插件可直接 api.toast.success / error / info ...
    toast,
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
