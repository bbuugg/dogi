import {
  CONFIRM_TIMEOUT_OPTIONS,
  DEFAULT_CONFIRM_TIMEOUT_MS,
  DEFAULT_MODEL_TIMEOUT_MS,
  MODEL_TIMEOUT_OPTIONS
} from '@shared/ai-timeouts'
import { useAppStore } from '@/stores/app-store'
import { Select } from 'antd'

/** 下拉宽度与终端设置里的一致，两个设置项看上去才是同一套 */
const SELECT_WIDTH = 224

/**
 * 超时：AI 相关的两类等待上限。
 *
 * 两者性质不同，别互相看齐：
 * - **审批等待**是「停下来等你」，卡住了本来就该等，所以默认不限时；
 * - **模型请求**是「判活」，等太久说明连接已经死了，所以默认 5 分钟。
 *
 * 都是即时生效（主进程在每次等待 / 每次请求时才读配置），改完不用重启；
 * 已经弹出的那张审批卡不受影响 —— 它按弹出时的设置计时。
 */
export function TimeoutSettings() {
  const aiSettings = useAppStore((s) => s.aiSettings)
  const saveAiSettings = useAppStore((s) => s.saveAiSettings)
  const confirmMs = aiSettings.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS
  const modelMs = aiSettings.modelTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS

  return (
    <div className="space-y-5">
      <div className="rounded-md">
        <div className="text-sm font-medium">审批等待超时</div>
        <p className="mt-1 mb-3 text-xs leading-4 text-muted-foreground">
          确认模式下等你点「允许 / 拒绝」的最长时间。超时按取消处理 ——
          卡片自己消失，而工具收到的是「用户拒绝」，所以默认不限时。审批卡本来就是停下来等你，
          挂着不会漏：点停止、切换会话、这一轮结束都会释放它。
        </p>
        <Select
          aria-label="审批等待超时"
          value={confirmMs}
          onChange={(v) => void saveAiSettings({ confirmTimeoutMs: v })}
          style={{ width: SELECT_WIDTH }}
          options={CONFIRM_TIMEOUT_OPTIONS}
        />
      </div>

      <div className="rounded-md">
        <div className="text-sm font-medium">模型请求超时</div>
        <p className="mt-1 mb-3 text-xs leading-4 text-muted-foreground">
          发出请求后等模型吐出第一个内容块的最长时间，用来判断连接是不是已经死了
          （不是这一轮任务的总预算，等你审批的时长不算在里面）。默认 5 分钟，与 Node
          自身对响应头的超时持平；本地慢模型 / 长思考模型被误判时，调大或改成不限时。
        </p>
        <Select
          aria-label="模型请求超时"
          value={modelMs}
          onChange={(v) => void saveAiSettings({ modelTimeoutMs: v })}
          style={{ width: SELECT_WIDTH }}
          options={MODEL_TIMEOUT_OPTIONS}
        />
      </div>
    </div>
  )
}
