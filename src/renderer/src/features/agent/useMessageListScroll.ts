import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'

/**
 * 对话流的滚动定位（Agent 页与终端内嵌 AI 助手共用）。
 *
 * 只做两件事：
 * 1. **尾部跟随**：本来就在底部时，新内容进来（含流式增量）继续贴底 ——
 *    刚发出的消息自然落在最下面。
 * 2. **「滚动到底部」按钮**：用户往上翻历史时不抢他的滚动位置，
 *    离底部超过一屏才把按钮露出来。
 *
 * 换会话时状态整个重置，否则会把上一个会话「用户翻到中间」的状态带过来，
 * 一进去就停在半空、还挂着「滚动到底部」按钮。
 */

/**
 * 列表里是否有正在进行的文本选中。
 *
 * **有就绝不能动滚动位置** —— 流式输出时贴底会让 `scrollTop` 每来一个 token 就涨一点，
 * 已经选好的那段被一路顶上去，用户根本选不住（表现是「UI 看着没滚，选中区域飞快往上跑」）。
 * 用 `intersectsNode` 而不是 `contains(anchorNode)`：从列表里一直拖到输入框的跨区选择
 * 也算「在选列表里的东西」。
 */
function hasListSelection(el: HTMLElement): boolean {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false
  for (let i = 0; i < sel.rangeCount; i++) {
    if (sel.getRangeAt(i).intersectsNode(el)) return true
  }
  return false
}

export function useMessageListScroll({
  conversationId,
  messages,
  streaming,
  extra
}: {
  /** 当前会话 id：变了就把滚动状态整个重置 */
  conversationId: string | null
  /** 消息列表变化时重算（触发条件用，不读内容） */
  messages: readonly { id: string; role: string }[]
  /** 流式状态变化也要重算（消息高度在变） */
  streaming: boolean
  /** 额外的重算触发条件（例如面板从最小化展开） */
  extra?: unknown
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 用户当前是否贴着底部：贴着才自动跟随，否则别抢他的位置 */
  const nearBottomRef = useRef(true)
  const prevScrollTopRef = useRef(0)
  /** 是否显示「滚动到底部」按钮（离底部超过一屏才露出来） */
  const [showJump, setShowJump] = useState(false)
  /** 最近一次由代码设置的目标 scrollTop：用来把「自己滚的」和「用户滚的」区分开 */
  const programmaticTopRef = useRef<number | null>(null)
  /** 上一次滚动决策对应的会话 id：换会话要把滚动状态整个重置 */
  const scrollConvRef = useRef<string | null>(null)

  const setScrollTop = useCallback((el: HTMLDivElement, top: number) => {
    programmaticTopRef.current = top
    el.scrollTop = top
    // 读回来的是被钳过的实际值 —— 存原始值的话，下一次真实的 scroll 事件会拿它跟
    // 钳过的 scrollTop 比，误判成「用户往上翻」，把跟随状态清掉
    prevScrollTopRef.current = el.scrollTop
  }, [])

  const scrollList = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // 换了会话：一律重置为「贴底」，新会话直接落在最新一条
    if (scrollConvRef.current !== conversationId) {
      scrollConvRef.current = conversationId
      nearBottomRef.current = true
    }
    if (!nearBottomRef.current) return
    // 用户正在列表里选中文本：一步都别滚。内容还在长，离底会越来越远，
    // 所以按钮状态要跟上（否则他选完想跳回底部，按钮还不出现）
    if (hasListSelection(el)) {
      setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 48)
      return
    }
    setScrollTop(el, el.scrollHeight)
    setShowJump(false)
  }, [setScrollTop, conversationId])

  useLayoutEffect(scrollList, [scrollList, messages, streaming, conversationId, extra])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    // 代码自己滚的（落点正好等于目标值）不算用户操作
    if (
      programmaticTopRef.current !== null &&
      Math.abs(el.scrollTop - programmaticTopRef.current) < 2
    ) {
      programmaticTopRef.current = null
      prevScrollTopRef.current = el.scrollTop
      return
    }
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (el.scrollTop < prevScrollTopRef.current - 2) {
      // 用户主动上翻：暂停自动跟随，别把历史里的位置顶掉
      nearBottomRef.current = false
    } else if (distance < 48) {
      nearBottomRef.current = true
    }
    prevScrollTopRef.current = el.scrollTop
    setShowJump(distance > 48)
  }

  const jumpToBottom = () => {
    const el = scrollRef.current
    if (!el) return
    nearBottomRef.current = true
    setScrollTop(el, el.scrollHeight)
    setShowJump(false)
  }

  return {
    scrollRef: scrollRef as RefObject<HTMLDivElement | null>,
    onScroll,
    showJump,
    jumpToBottom
  }
}
