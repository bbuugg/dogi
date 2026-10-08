/**
 * **单条命令的停止表**（对齐 fishwork 的 per-command stop）。
 *
 * 为什么需要它：一轮 Agent 对话里模型可能连跑好几条 `execute_command`，其中一条是
 * 卡住的长任务（`npm run dev`、`tail -f`、没有返回的构建）。用户此刻只有「停止整轮」
 * 一个把手 —— 那会把这一轮里还没跑的步骤、以及已经想好的后续一起掐掉。
 * 这里给每条命令登记一个杀手，界面上工具卡单独给一颗「停止」，只杀这一条命令树。
 *
 * ⚠️ 与「整轮停止」（`agent:abort` → 中止 signal）是两条路，别混：
 * - 整轮停止：abort signal 触发 → 所有工具一起收尾、这一轮结束；
 * - 单条停止：只 kill 这一个子进程，工具照常返回「已被用户停止」的结果，**模型继续往下跑**
 *   （它会看到命令被停了，据此决定要不要换方案）。
 *
 * key 用 `toolCallId`：一次工具调用唯一，且渲染端在工具卡上本来就拿着它。
 */
class CommandStopRegistry {
  private killers = new Map<string, () => void>()

  /** 登记一条正在跑的命令（toolCallId → 杀进程树的函数） */
  register(toolCallId: string, kill: () => void): void {
    this.killers.set(toolCallId, kill)
  }

  /** 命令收尾时摘掉登记（成功 / 失败 / 中止都要摘，否则表会一直长） */
  unregister(toolCallId: string): void {
    this.killers.delete(toolCallId)
  }

  /** 停一条命令；返回 false 表示这条已经跑完 / 不存在（渲染端据此决定要不要提示） */
  stop(toolCallId: string): boolean {
    const kill = this.killers.get(toolCallId)
    if (!kill) return false
    kill()
    return true
  }

  /** 中止整轮时兜底清空（防止极端情况下残留） */
  clear(): void {
    this.killers.clear()
  }
}

export const commandStopRegistry = new CommandStopRegistry()
