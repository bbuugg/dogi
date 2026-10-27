/**
 * 会话输入框草稿的本地存档（localStorage）。
 *
 * ## 为什么按「标签 key」而不是按 `activeConversationId` 存
 *
 * 草稿属于**输入框所在的标签**：真实会话标签的 key 就是会话 id，「新对话」标签的 key
 * 是 `draft:<工作区>`（见 `panel-session.ts` 的 `draftPanelKey`）。拿 `activeConversationId`
 * 当键的话，新对话还没建会话时无处可存；分屏里同一个会话开两个标签时又会互相覆盖。
 *
 * 键直接拼在 localStorage 的 key 上（一个标签一条），刷新后按同一个 key 读回，
 * 不需要维护一份索引或整份 JSON。
 *
 * ## 失败一律静默
 *
 * localStorage 可能被隐私模式禁用、也可能配额满。任何异常都只放弃落盘，内存里的草稿
 * 不受影响 —— 与 `assistant-history.ts` / 其他客户端偏好的口径一致。
 */

const PREFIX = 'fizz.agent.chat.draft.v1:'

/**
 * 单条草稿的字符上限。超过就不落盘并清掉旧值：宁可刷新后没有草稿，也不要把一份
 * 已经过时的旧草稿当成用户刚写的内容恢复出来。
 */
const MAX_CHARS = 256_000

function storageKey(key: string): string {
  return `${PREFIX}${key}`
}

/** 读这个标签的草稿；没有 / 读失败返回 `null`（与「存过但内容为空」区分开） */
export function loadChatDraft(key: string): string | null {
  if (!key) return null
  try {
    return localStorage.getItem(storageKey(key))
  } catch {
    return null
  }
}

/** 写草稿；内容为空 = 删掉这条，不在 localStorage 里留空串 */
export function saveChatDraft(key: string, text: string): void {
  if (!key) return
  try {
    if (!text) {
      localStorage.removeItem(storageKey(key))
      return
    }
    if (text.length > MAX_CHARS) {
      localStorage.removeItem(storageKey(key))
      return
    }
    localStorage.setItem(storageKey(key), text)
  } catch {
    // 配额满 / storage 被禁：只保留内存里的草稿
  }
}

/** 清掉这个标签的草稿（发送成功 / 手动清空时调；`saveChatDraft(key, '')` 的显式版本） */
export function clearChatDraft(key: string): void {
  if (!key) return
  try {
    localStorage.removeItem(storageKey(key))
  } catch {
    // 同上：删不掉也不影响当前会话
  }
}

/**
 * 这一轮的草稿该不该收：把提交时的正文和输入框**当前**的值比一次。
 *
 * ## 两边都要 trim
 *
 * 提交出去的是 trim 过的正文，而输入框里留着的往往还带**尾随空格 / 换行** ——
 * 敲完顺手回车、粘贴的文本自带结尾换行、输入法上屏再补一记空格，都会留下尾巴。
 * 早先这里拿「原文 === trim 后的正文」直接比，于是这些情况一律被判成「用户又改过」，
 * 草稿就**不收**：消息明明发出去了，输入框里却还留着那一份（用户报的「有时候消息
 * 发出去了消息框没清空」）。
 *
 * 真正要守的语义只有一条：**用户在提交之后又敲了实际内容就别抹掉**。只差空白不算。
 */
export function shouldClearChatDraft(current: string, submitted: string): boolean {
  return current.trim() === submitted.trim()
}

