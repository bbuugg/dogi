/**
 * 提问卡的「补答」判据与文案拼装（纯逻辑，vitest 覆盖）。
 *
 * 背景：那一轮已经结束（应用退出 / 点了停止 / 进程崩了）时，`ask_followup_question`
 * 的答案再也回填不到工具里 —— 前端把这张卡重新渲染成可作答的表单，答案当一条新消息
 * 发出去。这里钉住两条最容易错的边界：
 *
 * 1. **用户自己点「跳过」的不能变成可补答**（他刚说不要了，别把表单弹回来）；
 * 2. 只有带 `interrupted: true`（服务端 abort 时打的标记）或干脆没有结果的才算；
 * 3. 拼出去的那条消息必须带题目，否则模型不知道在回答什么。
 */
import { describe, expect, it } from 'vitest'
import type { AgentMessagePart } from '@fizz/contracts/types'
import {
  formatFollowupAnswer,
  getResumedFollowup,
  isUnansweredFollowup,
  markFollowupResumed
} from './ask-followup'

/** 一张 ask_followup_question 的 tool-call part */
function followupPart(extra: Partial<AgentMessagePart> = {}): AgentMessagePart {
  return {
    type: 'tool-call',
    toolCallId: 'call-1',
    toolName: 'ask_followup_question',
    input: {
      title: '新建项目的配置',
      questions: [
        {
          question: '用哪个框架？',
          header: '框架',
          options: ['React', 'Vue']
        }
      ]
    },
    ...extra
  } as AgentMessagePart
}

describe('isUnansweredFollowup', () => {
  it('没有结果 = 没答（abort 时 tool-result 可能压根没到）', () => {
    expect(isUnansweredFollowup(followupPart())).toBe(true)
  })

  it('用户点「跳过」的结果不带 interrupted，不算可补答', () => {
    expect(
      isUnansweredFollowup(
        followupPart({
          output: { answered: false, note: '用户没有作答（已跳过）' }
        })
      )
    ).toBe(false)
  })

  it('被中断的结果（interrupted: true）算可补答', () => {
    expect(
      isUnansweredFollowup(
        followupPart({
          output: { answered: false, interrupted: true, note: '这一轮被中断了' }
        })
      )
    ).toBe(true)
  })

  it('已经答过的不算', () => {
    expect(
      isUnansweredFollowup(
        followupPart({ output: { answered: true, answers: [{ id: 'q1', question: '', selected: ['React'] }] } })
      )
    ).toBe(false)
  })

  it('工具报错的不算（渲染层另有失败态）', () => {
    expect(isUnansweredFollowup(followupPart({ isError: true }))).toBe(false)
  })

  it('别的工具、或解析不出题目的不算', () => {
    expect(isUnansweredFollowup(followupPart({ toolName: 'read_file' }))).toBe(false)
    expect(isUnansweredFollowup(followupPart({ input: { questions: [] } }))).toBe(false)
  })
})

describe('formatFollowupAnswer', () => {
  it('带标题、选中项与「其他」自由输入', () => {
    const text = formatFollowupAnswer(
      {
        answers: [
          { id: 'q1', question: '用哪个框架？', selected: ['React'] },
          { id: 'q2', question: '需要什么功能？', selected: [], other: '导出 PDF' }
        ]
      },
      '新建项目的配置'
    )
    expect(text).toBe(
      [
        '（补答你之前的提问：新建项目的配置）',
        '- 用哪个框架？ → React',
        '- 需要什么功能？ → 导出 PDF'
      ].join('\n')
    )
  })

  it('没有标题时用通用抬头；一题没选也给出「未选」', () => {
    const text = formatFollowupAnswer({ answers: [{ id: 'q1', question: '继续吗？', selected: [] }] })
    expect(text).toBe(['（补答你之前的提问）', '- 继续吗？ → （未选）'].join('\n'))
  })
})

describe('markFollowupResumed', () => {
  it('记下之后能查回来（渲染层据此收成「已回答」）', () => {
    expect(getResumedFollowup('call-resumed')).toBeUndefined()
    markFollowupResumed('call-resumed', { answers: [{ id: 'q1', question: '继续吗？', selected: ['是'] }] })
    expect(getResumedFollowup('call-resumed')?.answers[0]?.selected).toEqual(['是'])
  })
})
