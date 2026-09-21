import { useState } from 'react'
import { Button, Input, Modal, message } from 'antd'
import { Folder, FolderOpen, FolderPlus, Pencil, Plus, Trash2 } from 'lucide-react'
import { useAppStore } from '@/stores/app-store'
import { cn } from 'cn'
import type { AgentWorkspace } from '@shared/types'

/** 新建 / 重命名工作区表单 */
interface WorkspaceEdit {
  id?: string
  name: string
  path: string
}

/** 路径取末段作为默认名（去掉结尾分隔符） */
function defaultName(path: string): string {
  const p = path.replace(/[\\/]+$/, '')
  const seg = p.split(/[\\/]/).pop()
  return seg || p
}

/**
 * Agent 侧边栏：工作区列表（选中即作为 Agent 对话的绑定目录）。
 * 支持新建（选目录）/ 重命名 / 删除；选中项在主区域 AgentPage 展示对话。
 */
export function AgentPanel() {
  const workspaces = useAppStore((s) => s.agentWorkspaces)
  const activeId = useAppStore((s) => s.activeAgentWorkspaceId)
  const selectAgentWorkspace = useAppStore((s) => s.selectAgentWorkspace)
  const saveAgentWorkspace = useAppStore((s) => s.saveAgentWorkspace)
  const deleteAgentWorkspace = useAppStore((s) => s.deleteAgentWorkspace)

  const [edit, setEdit] = useState<WorkspaceEdit | null>(null)
  const [pendingDelete, setPendingDelete] = useState<AgentWorkspace | null>(null)
  const [picking, setPicking] = useState(false)

  /** 打开系统目录选择框，回填路径（选了路径才允许保存） */
  const pickDir = async () => {
    if (!edit) return
    if (picking) return
    setPicking(true)
    try {
      const { canceled, filePaths } = await window.api.dialog.open({
        properties: ['openDirectory']
      })
      if (canceled || !filePaths[0]) return
      setEdit((e) => (e ? { ...e, path: filePaths[0] } : e))
    } catch (err) {
      message.error(`选择目录失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setPicking(false)
    }
  }

  const submitEdit = async () => {
    if (!edit) return
    if (!edit.path.trim()) {
      message.warning('请选择工作区目录')
      return
    }
    try {
      await saveAgentWorkspace({
        id: edit.id,
        name: edit.name.trim() || defaultName(edit.path),
        path: edit.path
      })
      setEdit(null)
    } catch (err) {
      message.error(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const confirmDelete = async () => {
    const target = pendingDelete
    if (!target) return
    setPendingDelete(null)
    try {
      await deleteAgentWorkspace(target.id)
      message.success(`已删除工作区「${target.name}」`)
    } catch (err) {
      message.error(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const active = activeId ? workspaces.find((w) => w.id === activeId) : undefined

  return (
    <div className="flex h-full flex-col">
      <div className="mb-1 flex items-center justify-between gap-1 px-3 py-2">
        <span className="text-sm font-medium text-muted-foreground">
          工作区 ({workspaces.length})
        </span>
        <Button
          type="text"
          size="small"
          className="px-0.5 text-muted-foreground"
          title="新建工作区"
          icon={<Plus className="size-3.5" />}
          onClick={() => setEdit({ name: '', path: '' })}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {workspaces.length === 0 ? (
          <div className="mx-2 mt-8 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            还没有工作区。
            <br />
            点击右上角 + 选择一个本地目录，
            <br />
            Agent 将只在该目录内读写文件与执行命令。
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {workspaces.map((w) => {
              const isActive = w.id === activeId
              return (
                <div
                  key={w.id}
                  onClick={() => selectAgentWorkspace(w.id)}
                  className={cn(
                    'group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors',
                    isActive
                      ? 'bg-primary/15 text-foreground'
                      : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
                  )}
                  title={w.path}
                >
                  <Folder
                    className={cn('size-3.5 shrink-0', isActive ? 'text-primary' : 'text-muted-foreground')}
                  />
                  <span className="min-w-0 flex-1 truncate">{w.name}</span>
                  <span className="text-[10px] text-muted-foreground/60">Agent</span>
                  <button
                    type="button"
                    title="重命名"
                    onClick={(e) => {
                      e.stopPropagation()
                      setEdit({ id: w.id, name: w.name, path: w.path })
                    }}
                    className="rounded p-0.5 opacity-0 transition-opacity hover:bg-foreground/10 group-hover:opacity-100"
                  >
                    <Pencil className="size-3" />
                  </button>
                  <button
                    type="button"
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation()
                      setPendingDelete(w)
                    }}
                    className="rounded p-0.5 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 当前选中工作区摘要（无选中时不显示） */}
      {active && (
        <div className="border-t border-border/60 px-3 py-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <FolderOpen className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate" title={active.path}>
              {active.path}
            </span>
          </div>
        </div>
      )}

      {/* 新建 / 重命名工作区 */}
      <Modal
        open={edit !== null}
        onCancel={() => setEdit(null)}
        title={edit?.id ? '重命名工作区' : '新建工作区'}
        okText="保存"
        cancelText="取消"
        centered
        width={440}
        destroyOnHidden
        okButtonProps={{ disabled: !edit?.path.trim() }}
        onOk={() => void submitEdit()}
      >
        <div className="flex flex-col gap-3">
          <div>
            <div className="mb-1 text-xs text-muted-foreground">名称</div>
            <Input
              autoFocus
              placeholder="工作区名称（留空自动取目录名）"
              value={edit?.name ?? ''}
              onChange={(e) => setEdit((v) => (v ? { ...v, name: e.target.value } : v))}
              onPressEnter={() => void submitEdit()}
            />
          </div>
          <div>
            <div className="mb-1 text-xs text-muted-foreground">目录</div>
            <div className="flex gap-1.5">
              <Input
                placeholder="工作区根目录（Agent 只能在此目录内操作）"
                value={edit?.path ?? ''}
                onChange={(e) => setEdit((v) => (v ? { ...v, path: e.target.value } : v))}
              />
              <Button
                icon={<FolderPlus className="size-3.5" />}
                loading={picking}
                onClick={() => void pickDir()}
              >
                选择
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      {/* 删除确认 */}
      <Modal
        open={pendingDelete !== null}
        onCancel={() => setPendingDelete(null)}
        title="删除工作区？"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onOk={() => void confirmDelete()}
        centered
        width={420}
        destroyOnHidden
      >
        <p className="text-sm text-muted-foreground">
          「{pendingDelete?.name}」及其对话记录将被移除（不会删除目录中的文件）。
        </p>
      </Modal>
    </div>
  )
}
