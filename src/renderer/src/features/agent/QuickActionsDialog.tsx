/**
 * 工作区快捷功能的管理弹窗：列表（增删改 + 上下移）+ 单个的编辑表单。
 *
 * 数据来自 `<工作区>/.dogi/workspace.json`（store 里的 workspaceConfigs 缓存），
 * 每次改动都**整体重写**这份配置 —— 文件是给用户手改的，格式要一直保持可读的 JSON。
 */
import { useEffect, useState } from 'react'
import { Button, Input, Modal, Popconfirm, Select, Tooltip, message } from 'antd'
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react'
import { useAppStore } from '@/stores/app-store'
import { MessageCopyButton } from '@/features/agent/MessageCopyButton'
import {
  QUICK_ACTION_ICONS,
  QUICK_ACTION_KIND_LABELS,
  QUICK_ACTION_TARGET_HINTS
} from '@/features/agent/quick-action'
import {
  QUICK_ACTION_KINDS,
  WORKSPACE_CONFIG_VERSION,
  newQuickActionId,
  normalizeQuickAction,
  validateQuickAction,
  type QuickAction,
  type QuickActionKind
} from '@shared/workspace-config'

/** 新建一条时的初始草稿：默认做成「打开链接」，那是用得最多的一类 */
function emptyDraft(): QuickAction {
  return { id: newQuickActionId(), kind: 'link', label: '', target: '' }
}

/** 列表行：图标 + 名称 + 目标，行尾是排序与增删按钮 */
function ActionRow({
  action,
  index,
  total,
  busy,
  onEdit,
  onMove,
  onDelete
}: {
  action: QuickAction
  index: number
  total: number
  busy: boolean
  onEdit: () => void
  onMove: (delta: -1 | 1) => void
  onDelete: () => void
}) {
  const Icon = QUICK_ACTION_ICONS[action.kind]
  const rowAction = 'rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10'
  return (
    <div className="group flex items-center gap-2 rounded-md border border-border/70 px-2 py-1.5">
      <Icon className="size-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{action.label}</div>
        <div className="truncate text-xs text-muted-foreground" title={action.target}>
          {QUICK_ACTION_KIND_LABELS[action.kind]} · {action.target}
        </div>
      </div>
      <Tooltip title="上移">
        <button
          type="button"
          aria-label="上移"
          disabled={busy || index === 0}
          onClick={() => onMove(-1)}
          className={`${rowAction} disabled:opacity-30`}
        >
          <ArrowUp className="size-3.5" />
        </button>
      </Tooltip>
      <Tooltip title="下移">
        <button
          type="button"
          aria-label="下移"
          disabled={busy || index === total - 1}
          onClick={() => onMove(1)}
          className={`${rowAction} disabled:opacity-30`}
        >
          <ArrowDown className="size-3.5" />
        </button>
      </Tooltip>
      <Tooltip title="编辑">
        <button type="button" aria-label="编辑快捷功能" disabled={busy} onClick={onEdit} className={rowAction}>
          <Pencil className="size-3.5" />
        </button>
      </Tooltip>
      <Popconfirm
        title="删除这个快捷功能？"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onConfirm={onDelete}
      >
        <button
          type="button"
          aria-label="删除快捷功能"
          disabled={busy}
          className={`${rowAction} hover:bg-destructive/10 hover:text-destructive`}
        >
          <Trash2 className="size-3.5" />
        </button>
      </Popconfirm>
    </div>
  )
}

export function QuickActionsDialog({
  workspaceId,
  open,
  onClose
}: {
  workspaceId: string
  open: boolean
  onClose: () => void
}) {
  const snapshot = useAppStore((s) => s.workspaceConfigs[workspaceId])
  const loadWorkspaceConfig = useAppStore((s) => s.loadWorkspaceConfig)
  const saveWorkspaceConfig = useAppStore((s) => s.saveWorkspaceConfig)
  const actions = snapshot?.config.quickActions ?? []

  /** 正在编辑 / 新建的那条（null = 不在编辑态） */
  const [draft, setDraft] = useState<QuickAction | null>(null)
  const [busy, setBusy] = useState(false)

  // 弹窗可能被从别处打开（缓存还没读过）时补一次加载
  useEffect(() => {
    if (open) void loadWorkspaceConfig(workspaceId)
  }, [open, workspaceId, loadWorkspaceConfig])

  /** 整体写回配置；成功返回 true */
  const persist = async (next: QuickAction[]): Promise<boolean> => {
    setBusy(true)
    try {
      await saveWorkspaceConfig(workspaceId, {
        version: snapshot?.config.version ?? WORKSPACE_CONFIG_VERSION,
        quickActions: next
      })
      return true
    } catch (err) {
      message.error(`保存失败：${err instanceof Error ? err.message : String(err)}`)
      return false
    } finally {
      setBusy(false)
    }
  }

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta
    if (target < 0 || target >= actions.length) return
    const next = [...actions]
    ;[next[index], next[target]] = [next[target], next[index]]
    void persist(next)
  }

  const submitDraft = async () => {
    if (!draft) return
    const invalid = validateQuickAction(draft)
    if (invalid) {
      message.warning(invalid)
      return
    }
    const action = normalizeQuickAction(draft)
    if (!action) {
      message.warning('请填写完整的快捷功能信息')
      return
    }
    const exists = actions.some((a) => a.id === action.id)
    const next = exists ? actions.map((a) => (a.id === action.id ? action : a)) : [...actions, action]
    if (await persist(next)) setDraft(null)
  }

  const DraftIcon = draft ? QUICK_ACTION_ICONS[draft.kind] : null

  return (
    <>
      <Modal
        open={open}
        onCancel={onClose}
        title="工作区快捷功能"
        centered
        width={560}
        footer={
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-muted-foreground" title={snapshot?.filePath}>
              {snapshot ? `配置位置：${snapshot.filePath}` : '配置文件读取中…'}
              {snapshot && <MessageCopyButton text={snapshot.filePath} title="复制配置路径" />}
            </span>
            <Button onClick={onClose}>关闭</Button>
          </div>
        }
      >
        <div className="flex flex-col gap-2">
          {actions.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              还没有快捷功能。
              <br />
              添加后它们会出现在工作区页顶部的快捷条上，点一下即可执行。
            </div>
          ) : (
            actions.map((action, index) => (
              <ActionRow
                key={action.id}
                action={action}
                index={index}
                total={actions.length}
                busy={busy}
                onEdit={() => setDraft({ ...action })}
                onMove={(delta) => move(index, delta)}
                onDelete={() => void persist(actions.filter((a) => a.id !== action.id))}
              />
            ))
          )}
          <Button
            block
            type="dashed"
            icon={<Plus className="size-3.5" />}
            disabled={busy}
            onClick={() => setDraft(emptyDraft())}
          >
            添加快捷功能
          </Button>
        </div>
      </Modal>

      {/* 编辑单条：嵌套弹窗，列表仍留在下层，改完能立刻看到顺序与内容 */}
      <Modal
        open={draft !== null}
        onCancel={() => setDraft(null)}
        title={actions.some((a) => a.id === draft?.id) ? '编辑快捷功能' : '添加快捷功能'}
        okText="保存"
        cancelText="取消"
        centered
        width={480}
        destroyOnHidden
        okButtonProps={{ loading: busy }}
        onOk={() => void submitDraft()}
      >
        {draft && (
          <div className="flex flex-col gap-3">
            <div>
              <div className="mb-1 text-xs text-muted-foreground">类型</div>
              <Select<QuickActionKind>
                className="w-full"
                value={draft.kind}
                options={QUICK_ACTION_KINDS.map((kind) => {
                  const Icon = QUICK_ACTION_ICONS[kind]
                  return {
                    value: kind,
                    label: QUICK_ACTION_KIND_LABELS[kind],
                    icon: <Icon className="size-3.5" />
                  }
                })}
                onChange={(kind) => setDraft({ ...draft, kind })}
              />
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">名称</div>
              <Input
                autoFocus
                placeholder="按钮上的文字，例如「项目看板」"
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                onPressEnter={() => void submitDraft()}
              />
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">
                {draft.kind === 'command' ? '命令' : draft.kind === 'link' ? '链接' : '路径'}
              </div>
              <Input.TextArea
                rows={draft.kind === 'command' ? 2 : 1}
                placeholder={QUICK_ACTION_TARGET_HINTS[draft.kind]}
                value={draft.target}
                onChange={(e) => setDraft({ ...draft, target: e.target.value })}
              />
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">说明（可选）</div>
              <Input
                placeholder="鼠标悬停在按钮上时的提示"
                value={draft.description ?? ''}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {DraftIcon && <DraftIcon className="size-3.5" />}
              {draft.kind === 'command'
                ? '命令会在工作区目录的内嵌终端里执行（会打开终端）。'
                : draft.kind === 'path'
                  ? '相对路径按工作区根目录解析，用系统默认程序打开。'
                  : '用系统默认浏览器打开该链接。'}
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}
