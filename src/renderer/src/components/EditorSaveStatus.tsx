import { CheckCircle2, Loader2 } from 'lucide-react'
import { STATUS_ITEM_CLASS } from '@/components/StatusBar'
import { useAppStore } from '@/stores/app-store'

/** 键前缀 → 中文名（只用于 title 提示） */
const SUBJECT: Record<string, string> = { script: '脚本', note: '笔记' }

/**
 * 状态栏里的「编辑页保存状态」（渲染在 StatusBar 内，由 App.tsx 注入）。
 *
 * 编辑页（脚本 / 笔记）把 saving / dirty 投影到 store（`ui.editorSaveStatus[editorSaveKey(...)]`），
 * 这里只负责展示 —— 页面只管写、状态栏只管读，两边不互相依赖。
 * 按实体取值，所以同时打开多个脚本 / 笔记标签时，显示的是当前激活那个的状态。
 */
export function EditorSaveStatus({ statusKey }: { statusKey: string }) {
  const state = useAppStore((s) => s.ui.editorSaveStatus[statusKey] ?? 'saved')
  const subject = SUBJECT[statusKey.split(':')[0]] ?? ''

  return (
    <div className={STATUS_ITEM_CLASS} title={`${subject}保存状态`}>
      {state === 'saving' ? (
        <>
          <Loader2 className="size-3.5 animate-spin" />
          保存中…
        </>
      ) : state === 'dirty' ? (
        <>
          <span className="size-1.5 rounded-full bg-amber-500" />
          未保存
        </>
      ) : (
        <>
          <CheckCircle2 className="size-3.5 text-emerald-500" />
          已保存
        </>
      )}
    </div>
  )
}
