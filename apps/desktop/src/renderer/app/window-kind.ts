/**
 * 从 `location.search` 判定当前渲染端要画哪个窗口。
 * `?window=` 是主进程用 `loadRenderer` 传的查询参数，**不是路由**。
 */
import { isDesktopSettingsTab, type DesktopSettingsTab } from '../../shared/window'

export type WindowKind =
  | { kind: 'main' }
  /** `initialTab`：首开时先落到哪个设置分组（模型下拉的设置入口带的） */
  | { kind: 'settings'; initialTab?: DesktopSettingsTab }
  | { kind: 'conversation'; initialConversationId?: string }

export function resolveWindowKind(search: string): WindowKind {
  const params = new URLSearchParams(search)
  if (params.get('window') === 'conversation') {
    const id = params.get('conversationId')
    // id 只是「首次打开显示哪条会话」的种子；没有它也照样渲染浮窗（落草稿 / 当前项目）
    return id ? { kind: 'conversation', initialConversationId: id } : { kind: 'conversation' }
  }
  if (params.get('window') === 'settings') {
    // 查询参数不可信（也可能是手改的地址）：认不出来的分组当没带，落回「通用」
    const tab = params.get('tab')
    return isDesktopSettingsTab(tab) ? { kind: 'settings', initialTab: tab } : { kind: 'settings' }
  }
  return { kind: 'main' }
}
