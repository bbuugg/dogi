/**
 * 对话 SSE 的写泵：把一条 run 接到一条 HTTP 连接上。
 *
 * POST /api/chat（发起）与 GET /api/chat/stream（刷新后接回）共用 —— 先回放帧日志
 * （恢复现场），再消费本连接的直播队列。放 `app/api/_lib/` 是因为 route 文件只允许
 * 导出 HTTP 方法处理器，`pipeRun` 这种共用函数必须住在库文件里才能被两个路由引用。
 */
import type { ChatStreamFrame } from '@fizz/contracts/agent-api'
import {
  attach,
  type ChatRun,
  type ChatRunSubscriber
} from '@/lib/server/chat-run'
import { createSSEStream } from '@/app/api/_lib/sse'

/**
 * 把一条 run 接到这条 SSE 连接上：先回放帧日志（恢复现场），再消费本连接的直播队列。
 */
export function pipeRun(run: ChatRun): Response {
  return createSSEStream(async (writer, clientGone) => {
    const queue: ChatStreamFrame[] = []
    let wake: (() => void) | null = null
    let closed = false
    const sub: ChatRunSubscriber = {
      push: (frame) => {
        queue.push(frame)
        wake?.()
        wake = null
      },
      close: () => {
        closed = true
        wake?.()
        wake = null
      }
    }

    const replay = attach(run, sub)

    /**
     * 读端断开（连接断了 / desktop 的 IPC 桥 cancel）：唤醒下面那个等待，让循环走到
     * `if (closed) return`，`finally` 里的 `sub.close()` 才把订阅者摘掉。
     *
     * ⚠️ 没有这一条的话循环会永远挂在「等下一帧」上 —— 每次断线重连都往
     * `run.subscribers` 里再挂一个只增不减的订阅者（见 `createSSEStream` 的 `cancel`）。
     * 注意它**不中止这一轮**：run 继续跑完并照常落盘。
     */
    const onClientGone = (): void => {
      closed = true
      wake?.()
      wake = null
    }
    clientGone.addEventListener('abort', onClientGone, { once: true })

    try {
      // 回放
      for (const frame of replay) {
        await writer.write({ event: frame.type, data: JSON.stringify(frame) })
      }
      /**
       * 回放结束的标记帧：**只写这条连接，不进帧日志**（`emit` 才会入日志）。
       * 进了日志就糟了 —— 下次 attach 会把它自己也当回放帧放一遍，客户端再也分不清
       * 「回放」与「直播」的边界。
       *
       * 客户端拿它做一件事：把「正在回放现场」这个状态撤掉。断线重连的回放是
       * 「先清空这一轮的 parts、再从头部逐帧重建」，内容高度先塌后长 —— 这段时间用
       * 平滑滚动跟随，用户看到的就是「消息列表像在重新加载、一直从顶部往下滚」
       * （见 `packages/agent-ui` 的 `ConvSlice.replaying`）。
       */
      await writer.write({
        event: 'replay-end',
        data: JSON.stringify({ type: 'replay-end', requestId: run.requestId })
      })
      // 直播
      for (;;) {
        while (queue.length > 0) {
          const frame = queue.shift()!
          await writer.write({ event: frame.type, data: JSON.stringify(frame) })
          if (frame.type === 'end') {
            sub.close()
            return
          }
        }
        if (closed) return
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    } catch {
      // 客户端已经走了
    } finally {
      clientGone.removeEventListener('abort', onClientGone)
      sub.close()
    }
  })
}
