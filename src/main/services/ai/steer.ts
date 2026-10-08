/**
 * **运行中插话（steer）**：这一轮还在跑时用户又打了一句话，不另起一轮，
 * 而是把它塞进「下一个工具步的边界」，让模型在**同一步里**看到。
 *
 * ## 与「待发送队列」的区别（别混成一套）
 *
 * dogi 原本只有队列：本轮跑完 → 队列里的消息再起**新的一轮**。用户想说
 * 「别改那个文件了，先跑测试」时，这句话要到本轮彻底结束才被看到 —— 而本轮
 * 可能还要再改五个文件。插话解决的就是这个：**本轮内**改变模型的下一步。
 *
 * ## 怎么塞进去（为什么是工具结果，不是别的）
 *
 * 一次 `agent.stream(messages, { maxSteps })` 是**一次请求**，消息数组在请求开始时
 * 就定死了，中途没有官方注入点。唯一可靠、且模型一定会读到的边界是**工具结果** ——
 * 模型每一步都要读上一步的工具结果才能继续。所以：
 *
 *   工具执行完 → 取走这个会话攒下的插话 → 拼在结果文本后面 → 一起回给模型
 *
 * 代价是插话文本会**同时**留在两处：一是渲染端按真实时序落盘的 user 消息，
 * 二是那一条工具结果里。下一轮的历史里因此会看到两遍（几十个 token 的冗余），
 * 换来的是「本轮内立刻生效」+「刷新后用户还看得到自己说过什么」。这是刻意的取舍。
 *
 * ## 收不进去怎么办
 *
 * 插话攒着但本轮已经没有下一个工具步了（模型直接收尾）—— 那它就只是**没赶上**，
 * 渲染端那条 user 消息仍在历史里，下一轮照样会被模型看到。所以「没赶上」不算丢话。
 * 本轮结束时清掉残留，避免它跑到下一次对话里去。
 */
class SteerRegistry {
  /** conversationId → 还没被取走的插话（按用户说话顺序） */
  private pending = new Map<string, string[]>()

  /**
   * 用户在一轮运行中又说了话：攒起来，等下一个工具步边界注入。
   *
   * 为什么按 `conversationId` 而不是 `requestId`：渲染端在 requestId 落地之前
   * （准备阶段那几百毫秒）就已经能点「插话」了 —— 按 requestId 存的话那段时间的
   * 插话会无处可放，正好是用户最想插话的时刻（MCP 启动 / 上下文压缩）。
   */
  push(conversationId: string, text: string): void {
    const trimmed = text.trim()
    if (!conversationId || !trimmed) return
    const list = this.pending.get(conversationId)
    if (list) list.push(trimmed)
    else this.pending.set(conversationId, [trimmed])
  }

  /** 是否攒着没注入的插话（渲染端据此提示「还没被读到」） */
  has(conversationId: string): boolean {
    return (this.pending.get(conversationId)?.length ?? 0) > 0
  }

  /** 工具步边界：取走并清空（取走即清空，同一条插话绝不注入两次） */
  drain(conversationId: string): string[] {
    const list = this.pending.get(conversationId)
    if (!list || list.length === 0) return []
    this.pending.delete(conversationId)
    return list
  }

  /** 本轮结束 / 会话删除：丢掉没赶上的插话（它还在渲染端的历史里，下一轮照样能看到） */
  clear(conversationId: string): void {
    this.pending.delete(conversationId)
  }
}

export const steerRegistry = new SteerRegistry()

/**
 * 把攒下的插话拼到工具结果后面。
 *
 * 只在结果是**字符串**时注入：内置工具的结果都是文本，而结构化结果（对象 / 数组）
 * 拼字符串会把它毁掉 —— 那种情况宁可**不取走**（留到下一个字符串结果的工具步），
 * 也别把工具结果弄坏。整轮都是结构化结果时插话就赶不上，走「下一轮自然看到」的兜底。
 */
export function appendSteer(conversationId: string, result: unknown): unknown {
  if (typeof result !== 'string') return result
  const steers = steerRegistry.drain(conversationId)
  if (steers.length === 0) return result
  const block = steers.map((t) => t).join('\n---\n')
  return (
    `${result}\n\n` +
    `【用户在你执行上一步时插话 —— 请据此调整接下来的做法，不必复述这条提示】\n` +
    block
  )
}
