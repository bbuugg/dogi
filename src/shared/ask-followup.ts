/**
 * `ask_followup_question` 工具的共享约定（主进程与渲染进程都要用）。
 *
 * 这是「AI 在回合中途向用户收集结构化选择题答案」的工具：一次可以问一道或多道
 * （每道 single 单选 / multiSelect 多选，选项 2-4 个）。模型拿到答案后继续往下跑。
 */

/** 工具名：模型用它向用户提问（对应工具定义里的 `name`） */
export const ASK_FOLLOWUP_TOOL = 'ask_followup_question'

/** 提问最长等待时间：超时按「未作答」处理，工具继续往下跑而不是永远挂着 */
export const ASK_FOLLOWUP_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 追加到系统提示词末尾的提示：工具光存在没用，模型得知道「什么时候该问、怎么问」。
 * 少了这一句，绝大多数模型会自己猜着往下做，工具一次都不会被调用。
 */
export const ASK_FOLLOWUP_HINT = [
  '',
  '需要用户做决定或补充信息时，用 ask_followup_question 工具向他提问：一次可以问一道或多道结构化选择题，',
  '每道题 single 单选 / multiSelect 多选，选项 2-4 个（可以是纯文本，也可以带说明对象）。',
  '用户不作答（跳过）时按最合理的方式继续，不要反复追问同一个问题。'
].join('\n')
