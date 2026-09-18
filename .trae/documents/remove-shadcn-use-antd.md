# 移除 shadcn/ui，统一改用 antd

## Context

项目已引入 antd 6.6.4，并通过 [AntdProvider.tsx](file:///d:/Workspace/web/owner/shell/src/renderer/src/components/AntdProvider.tsx) 把应用的 CSS 变量映射成 antd token、用 `holderRender` 接管 message/notification/Modal.confirm 的主题与中文语言包。但界面仍大量混用 shadcn/ui（Radix + CVA + Tailwind 语义变量）。

目标：**彻底删除 `src/renderer/src/components/ui/**` 与全部 shadcn 相关依赖**，宿主与运行时插件统一使用 antd。

已确认的三个决策：
1. 插件注入 API 由「shadcn 组件映射」改为**直接注入 antd 模块**（`api.antd`）。
2. 全局通知 sonner **换成 antd message / notification**。
3. api-client 插件（1101 行）**本次一起重写**，否则会直接报错。

## 必须保留的东西（不要删）

- **Tailwind 与语义化 CSS 变量**（`--background / --foreground / --primary / --muted / --muted-foreground / --border / --sidebar* / --radius`）：全项目 Tailwind 类名（`bg-background`、`text-muted-foreground`、`bg-sidebar`…）与 `AntdProvider.readAppTokens()` 都依赖它，删掉会同时打爆主题与 antd 配色。
- **[lib/utils.ts](file:///d:/Workspace/web/owner/shell/src/renderer/src/lib/utils.ts) 的 `cn`**（来自 `cn` 包）：通用 className 合并工具，非 shadcn 专属。
- lucide-react、monaco、xterm、react-dnd、ssh2 等业务依赖。

## 组件映射

| shadcn | antd | 备注 |
| --- | --- | --- |
| `Button` | `Button` | antd 6 已有 `variant`/`color`：`default`→`color="primary" variant="solid"`；`secondary`→`color="default" variant="filled"`；`outline`→`color="default" variant="outlined"`；`ghost`→`variant="text"`；`destructive`→`color="danger" variant="filled"`；`link`→`variant="link"`；`size="sm"`→`size="small"`；图标按钮用 `className="size-7"` 保持原尺寸 |
| `Input` | `Input` | |
| `Textarea` | `Input.TextArea` | 保留 `rows` / `onKeyDown` |
| `Label` | 原生 `<label>` | antd 无 Label 组件，用现有 Tailwind 类 + 保留 `htmlFor` 语义 |
| `Badge` | `Tag` | |
| `Switch` | `Switch` | `onCheckedChange` → `onChange` |
| `Separator` | `Divider` | |
| `ScrollArea` | 原生 `overflow-y-auto` 容器 | antd 无等价物 |
| `Select` | `Select` | `value`/`onValueChange` → `value`/`onChange`，子项改为 `options`；无边框场景用 `variant="borderless"` |
| `Tabs` | `Tabs` | 改为 `items` 写法 |
| `Dialog` | `Modal` | |
| `Drawer` | `Drawer` | |
| `AlertDialog` | `Modal.confirm` | 经 `App.useApp()` 或静态方法 |
| `ContextMenu` | `Dropdown` + `trigger={['contextMenu']}` | [HostsPanel.tsx](file:///d:/Workspace/web/owner/shell/src/renderer/src/components/HostsPanel.tsx#L691-L712) 已有同款现成写法可参考 |
| `DropdownMenu` | `Dropdown` + `menu={{items}}` | |
| `Popover` | `Popover` | 关闭即卸载用 `destroyOnHidden`（antd 6 属性名，已确认存在） |
| `Table` | `Table` | |

## 实施步骤

### 1. 宿主组件替换

**同形替换（低风险）**：`App.tsx`、`CommandPalette.tsx`、`ScriptsPage.tsx`、`PluginsPage.tsx`、`MonacoEditor.tsx`、`RunScriptDialog.tsx`、`SshProfileDialog.tsx`、`SettingsDialog.tsx` 以及 [components/settings/](file:///d:/Workspace/web/owner/shell/src/renderer/src/components/settings) 下全部文件，把 Button/Input/Textarea/Label/Badge/Switch 按上表替换。

**结构差异（重点，需逐个确认交互不变）**：
- `Select` → [AiPanel.tsx](file:///d:/Workspace/web/owner/shell/src/renderer/src/components/AiPanel.tsx#L393-L407)（模型切换，无边框）、[AiPanel.tsx](file:///d:/Workspace/web/owner/shell/src/renderer/src/components/AiPanel.tsx#L511)（权限模式）、[TerminalSettings.tsx](file:///d:/Workspace/web/owner/shell/src/renderer/src/components/settings/TerminalSettings.tsx#L41-L56)、[ModelSettings.tsx](file:///d:/Workspace/web/owner/shell/src/renderer/src/components/settings/ModelSettings.tsx#L158-L172)
- `Popover` → [StatusBar.tsx](file:///d:/Workspace/web/owner/shell/src/renderer/src/components/StatusBar.tsx#L92-L130) 的 `MenuButton`（`placement="topLeft"`）、[MonitorBadge.tsx](file:///d:/Workspace/web/owner/shell/src/renderer/src/components/MonitorBadge.tsx#L217-L276)（`placement="topLeft"`、关闭时卸载、打开/关闭不抢焦点 → 用 `destroyOnHidden` 且 content 内不自动聚焦）
- `ContextMenu` → [PaneLayout.tsx](file:///d:/Workspace/web/owner/shell/src/renderer/src/components/PaneLayout.tsx#L219-L301) 终端标签右键菜单；`onOpenChange` 里「先激活所在组与该标签，拆分才作用于正确组」的行为必须保留

### 2. 通知层

- 删除 `src/renderer/src/components/AppToaster.tsx` 与 `App.tsx` 中的引用。
- 6 处 sonner `toast` 调用改为 antd：`toast.success(x)` → `message.success(x)`；`toast.error(x, { description: y })` → `message.error(\`${x}：${y}\`)`（或需要结构化时用 `notification.error({message, description})`）。
  涉及：[HostsPanel.tsx](file:///d:/Workspace/web/owner/shell/src/renderer/src/components/HostsPanel.tsx)、[ScriptsPage.tsx](file:///d:/Workspace/web/owner/shell/src/renderer/src/components/ScriptsPage.tsx)、[PluginsPage.tsx](file:///d:/Workspace/web/owner/shell/src/renderer/src/components/PluginsPage.tsx)、[RunScriptDialog.tsx](file:///d:/Workspace/web/owner/shell/src/renderer/src/components/RunScriptDialog.tsx)、[SshProfileDialog.tsx](file:///d:/Workspace/web/owner/shell/src/renderer/src/components/SshProfileDialog.tsx)、[ShortcutSettings.tsx](file:///d:/Workspace/web/owner/shell/src/renderer/src/components/settings/ShortcutSettings.tsx)。
- 主题已由 `AntdProvider` 的 `holderRender` 覆盖，无需额外包 `App`。

### 3. 插件 host API

[plugins/host.ts](file:///d:/Workspace/web/owner/shell/src/renderer/src/plugins/host.ts)：
- 删除全部 `@/components/ui/*` 导入与 `ui` 映射对象（含类型定义里的几十个键）。
- 新增 `import * as antd from 'antd'`，`RendererHostApi` 暴露 `antd: typeof antd`。
- 删除 `toast`（sonner），插件改用 `api.antd.message` / `api.antd.notification`。
- 保留 `cn`、`icons`、`MonacoEditor`、`storage`、`http`、`invoke`、`registerCommand`。
- 同步修正文件头注释中「注入 shadcn 组件」的表述。

### 4. api-client 插件重写

[plugins/api-client/renderer.js](file:///d:/Workspace/web/owner/shell/plugins/api-client/renderer.js)（1101 行，`h()` 手写 createElement）：
- `const { Button, Input, Badge, Select, SelectTrigger, ... } = api.ui` → 从 `api.antd` 取 `Button / Input / Select / Tabs / Table / Drawer / Modal / Tag / Space / Tooltip / Divider`。
- `toast(...)` → `api.antd.message`（5 处）。
- Select/Tabs/Table/Drawer/Dialog 组合式写法 → antd 的 `options` / `items` / `columns` / `open` 写法。

**必须原样保留的行为**（这些是之前踩坑修好的，见项目 memory）：
- 响应区按标签独立折叠（`respCollapsed`）、展开恢复拖拽高度、折叠时只留状态行。
- 标签条右侧「导入 cURL / + 新建」在标签溢出时 `sticky right-0` + `bg-background` 遮罩。
- 请求头单元格用原生 `input` + `datalist` 自动补全，扁平无边框。
- `api-client-root` 作用域内注入的 `:-webkit-autofill` 样式（`-webkit-text-fill-color: var(--foreground) !important`）。
- Ctrl/Cmd+Enter 发送、历史用 Drawer、`api.MonacoEditor` 用法。

**新增样式覆盖**：在 `api-client-root` 作用域下压掉 antd Table 的表头背景与行 hover 高亮（项目约束：该插件表格表头不得有背景色变化、行不得有 hover 变色）。

### 5. 删除与依赖清理

- 删除目录 `src/renderer/src/components/ui/`（17 个文件）。
- [index.css](file:///d:/Workspace/web/owner/shell/src/renderer/src/index.css)：
  - 删除 `@import 'tw-animate-css'`（当前重复出现两行）与 `@import "shadcn/tailwind.css"`。
  - 删除 Radix 浮层层级 hack（`[data-radix-popper-content-wrapper]` 与 `div:has(> [data-slot='select-content'])` 那段）。
  - 保留 `@source "../../../plugins/**"`、语义变量、`@theme inline`、`.ssh-tree` 等全部业务样式。
- `package.json` 移除：`@radix-ui/react-dialog`、`@radix-ui/react-dropdown-menu`、`@radix-ui/react-label`、`@radix-ui/react-scroll-area`、`@radix-ui/react-select`、`@radix-ui/react-separator`、`@radix-ui/react-slot`、`@radix-ui/react-switch`、`@radix-ui/react-tabs`、`@radix-ui/react-tooltip`、`radix-ui`、`vaul`、`class-variance-authority`、`sonner`、`shadcn`、`clsx`、`tailwind-merge`、`tw-animate-css`（后三个已确认无直接 import，`cn` 包自带实现）。
- 执行 `npm uninstall` 后确认 `node_modules` 中不再有这些包。

### 6. 验证

1. `npm run typecheck`（node + web 两个 tsconfig）。
2. `npm run build`，确认三份产物构建通过。
3. 先 `taskkill //F //IM electron.exe` 清掉旧实例，再启动并确认窗口正常显示（见 AGENTS.md 第 16 条）。
4. CDP 冒烟（`--remote-debugging-port=9333`）逐项确认：
   - 主题跟随系统 + 主题色切换后 antd 组件与界面配色一致。
   - 侧边栏 SSH 树（无白底）、右键菜单、react-dnd 拖拽排序。
   - 终端标签右键菜单：向上/下/左/右拆分、本组新建、关闭标签、关闭组。
   - 状态栏菜单弹出位置、监控指标气泡（不抢焦点、数据消失自动收起）。
   - AI 面板：模型下拉、权限模式下拉、Enter 发送、工具调用卡片与确认按钮。
   - 设置弹窗各页：终端设置（shell 下拉、配色、各 Switch）、模型设置（表单 + 服务商下拉）、MCP、偏好、快捷键。
   - 脚本页新增/编辑弹窗、插件页启用开关与 Tag。
   - api-client 插件：发送请求、请求头增删与 datalist 补全、请求标签切换、响应区折叠/展开、历史 Drawer、导入 cURL、深色模式输入框文字色。
5. 全局 grep 确认无残留：`@/components/ui/`、`from 'sonner'`、`@radix-ui`、`vaul`、`class-variance-authority`。

## 风险点

- antd 6 的 `Button variant/color`、`Popover destroyOnHidden`、`Select variant` 已在本机 `node_modules/antd` 类型定义中确认存在；其余 API 落地时以实际类型为准。
- `Label` 无 antd 对应物，统一降级为原生 `<label>`，需保证样式与原先一致（`text-xs font-medium` 等）。
- 插件重写是本次最大不确定项，务必按「保留行为清单」逐条比对，避免回归之前修好的折叠/sticky/autofill 细节。
