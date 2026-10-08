import {
  CONFIRM_TIMEOUT_OPTIONS,
  DEFAULT_CONFIRM_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_STEPS,
  DEFAULT_MODEL_TIMEOUT_MS,
  DEFAULT_SUB_AGENT_MAX_STEPS,
  MODEL_TIMEOUT_OPTIONS,
  NO_RETRY
} from '@shared/ai-timeouts'
import { useAppStore } from '@/stores/app-store'
import { InputNumber, Select, Switch } from 'antd'

/** 下拉宽度与终端设置里的一致，两个设置项看上去才是同一套 */
const SELECT_WIDTH = 224

/**
 * 「运行」：AI 的运行参数与能力开关。
 *
 * 为什么超时、步数、重试、子 Agent 挤在同一页：它们回答的是同一个问题 ——
 * 「这一轮到底能跑多远、跑多久、跑得多贵」。分开放反而要用户在几个页之间来回对照。
 *
 * 各超时项性质不同，别互相看齐：
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
  const maxSteps = aiSettings.maxSteps ?? DEFAULT_MAX_STEPS
  const maxRetries = aiSettings.maxRetries ?? DEFAULT_MAX_RETRIES
  const subAgents = aiSettings.subAgents === true

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

      <div className="rounded-md">
        <div className="text-sm font-medium">工具调用最大步数</div>
        <p className="mt-1 mb-3 text-xs leading-4 text-muted-foreground">
          AI SDK 单轮对话内允许连续调用工具（执行命令 / 读写文件等）的最大次数。达到上限后
          即使还有未完成的工具调用也会停止本轮。默认 500，复杂任务需要多步编排时可调大。
        </p>
        <InputNumber
          aria-label="工具调用最大步数"
          min={1}
          max={10000}
          value={maxSteps}
          onChange={(v) => void saveAiSettings({ maxSteps: v ?? DEFAULT_MAX_STEPS })}
          style={{ width: SELECT_WIDTH }}
        />
      </div>

      <div className="rounded-md">
        <div className="text-sm font-medium">请求失败重试次数</div>
        <p className="mt-1 mb-3 text-xs leading-4 text-muted-foreground">
          模型请求因网络中断、限流或服务端错误失败后自动重试的次数（只重试请求本身；
          已经把工具跑起来的那一次不会再自动重试，避免重复执行命令 / 写文件）。
          填 0 表示不重试；默认 2 次。重试时对话流里会显示「第 N 次重试」。
        </p>
        <InputNumber
          aria-label="请求失败重试次数"
          min={NO_RETRY}
          max={100}
          value={maxRetries}
          onChange={(v) => void saveAiSettings({ maxRetries: v ?? DEFAULT_MAX_RETRIES })}
          style={{ width: SELECT_WIDTH }}
        />
      </div>

      <div className="rounded-md">
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm font-medium">子 Agent（delegate）</div>
          <Switch
            aria-label="子 Agent"
            checked={subAgents}
            onChange={(v) => void saveAiSettings({ subAgents: v })}
          />
        </div>
        <p className="mt-1 text-xs leading-4 text-muted-foreground">
          开启后工作区 Agent 多出一个 <code>delegate</code> 工具，可以把「翻代码找路」
          （explorer）和「挑改动里的毛病」（reviewer）外包给一个临时的子 Agent，
          只把它最后的报告拿回来。子 Agent **只能读**（看目录 / 读文件 / 搜索 / git），
          改不了文件也执行不了命令。
          <br />
          默认关闭。关闭时这个工具**根本不出现在工具表里**，模型看不到也就不会去用。
          开启的代价是 token：子 Agent 会独立读一遍相关文件（最多 {DEFAULT_SUB_AGENT_MAX_STEPS}{' '}
          步），那些读取过程不会进入你的对话上下文 —— 这正是它省上下文的地方，
          也是它多花钱的地方。
        </p>
      </div>
    </div>
  )
}
