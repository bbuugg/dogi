/**
 * 提示词注册表：`ctx.prompt` 的实体。**这是插件往系统提示词里插话的唯一入口。**
 *
 * 一个 section = 一段提示词，带 id（同名视为同一段，后写覆盖）与 priority。
 * 渲染顺序 = priority 升序、同序按注册先后 —— 所以内置的基础提示词用 priority 0
 * 注册在最前，插件想插在后面用更大的 priority。
 *
 * `render()` 用空行（`\n\n`）连接各段，空文本段直接跳过（便于插件「先注册、运行期
 * 再决定填不填内容」）。
 */
import { Service } from '../service'
import type { Context } from '../context'
import type { Dispose } from '../types'

export interface PromptSection {
  id: string
  text: string
  priority: number
  source: string
}

export interface PromptSectionOptions {
  priority?: number
  source?: string
}

export class PromptService extends Service {
  private readonly _byId = new Map<string, PromptSection>()
  /** 首次出现的 id 顺序（决定同 priority 时的先后） */
  private readonly _order: string[] = []

  constructor(ctx: Context) {
    super(ctx)
  }

  get name(): string {
    return 'prompt'
  }

  /** 写入 / 覆盖一段提示词；返回 disposer（仅当这段还在时移除） */
  section(id: string, text: string, opts: PromptSectionOptions = {}): Dispose {
    const existed = this._byId.has(id)
    const sec: PromptSection = {
      id,
      text,
      priority: opts.priority ?? 0,
      source: opts.source ?? 'unknown'
    }
    this._byId.set(id, sec)
    if (!existed) this._order.push(id)
    return this.bind(() => {
      if (this._byId.get(id) === sec) {
        this._byId.delete(id)
        const i = this._order.indexOf(id)
        if (i >= 0) this._order.splice(i, 1)
      }
    })
  }

  remove(id: string): void {
    this._byId.delete(id)
    const i = this._order.indexOf(id)
    if (i >= 0) this._order.splice(i, 1)
  }

  /** 按渲染顺序列出非空段 */
  list(): PromptSection[] {
    const pos = new Map(this._order.map((id, i) => [id, i]))
    return [...this._byId.values()]
      .filter((s) => s.text.trim().length > 0)
      .sort((a, b) => a.priority - b.priority || (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0))
  }

  /** 拼接成最终提示词正文（缺省空行分隔） */
  render(separator = '\n\n'): string {
    return this.list()
      .map((s) => s.text)
      .join(separator)
  }
}