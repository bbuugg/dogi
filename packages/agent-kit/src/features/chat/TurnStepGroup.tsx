/**
 * 一轮对话的「过程折叠条」：把这轮里的思考、工具调用（以及整轮结束后前面那几段正文）
 * 收进一个可展开的分组，默认只露一行抬头，点击展开 / 收起。
 *
 * 抬头文案由调用方算（见 `lib/turn-step.ts` 的一组纯函数），与思考条的触发行同一形态：
 * **左边一格名字 + 右边一格内容预览**（预览为 `undefined` 时只占一格）。
 * - 左：**整轮没结束**报「最后做的那一件事」——工具的 `intent`（没有就工具名）、思考在跑时
 *   是「思考中…」、落地后是「思考过程」；**整轮结束**才报「已工作 1 分 12 秒」
 *   （拿不到耗时退回「思考 ×1 · 工具调用 ×3」）；
 * - 右：这一步**做的到底是什么**——思考的最后一行，或命令 / 路径 / 搜索词。
 *   **只在收起时显示**：展开后内容就在下面，抬头再复读一遍是纯重复。
 *
 * 样式与思考条的触发行（ReasoningTrigger 的「思考了 N 秒」）同一口径：**纯文字行** ——
 * 无边框 / 底色、text-muted-foreground 常规字重、箭头贴在文字右侧，
 * 左缘与思考行对齐（消息 parts 流的最左端）。
 *
 * 名字左边**最多一个图形**（并排就是左边堆了两个图形，用户报过），四档互斥：
 * - **进行中 + 收起** → 三根跳动的竖条（`WorkBars`）：这时「在不在跑」更急，而且竖条
 *   是**位置标记**（眼睛扫一列时不用读字就知道哪一组在动）；
 * - **进行中 + 展开** → 同样是三根竖条（`WorkBars`）：抬头这时是「正在工作…」一句话，
 *   左边不换形状，免得同一列在折叠 / 展开之间换两种动效；
 * - **本轮还在跑、但在等模型下一步** → 一颗类型图标（`kind`：工具 → 扳手、思考 → 脑，与
 *   工具卡 `ToolHeader` / 思考条 `ReasoningTrigger` 同一套）：这时抬头是「做什么」，那行字
 *   说不出「这一步是工具还是思考」，只有这颗图标能一眼分辨；
 * - **本轮已结束**（抬头是「已工作 1 分 12 秒」）→ **什么都不放**：那是一句总结，
 *   不是「下一步是什么」，前面挂颗扳手 / 脑反而在暗示「还有一步工具要跑」（用户要求）。
 *
 * 进行中 + 收起时名字本身还会走扫光（`ShimmerLabel`）：那是「模型还在往外吐字」的粒度信号。
 *
 * **进行中 + 展开**时扫光撤掉（竖条留着），名字直接换成「正在工作…」：细节就在下面
 * 一行不落地流着，抬头不需要再演示「还在跑」。折叠回去立刻恢复原样；一组落地后（不论开合）
 * 也退回纯文字 —— 历史消息里不会留一排还在跳的组，也不会留一排状态图标。
 * 这句「正在工作」挂的是 `live` 而不是 `active`（差在「工具出结果 → 模型生成下一次调用」
 * 那几秒），否则这行字会在两种文案之间反复横跳。
 *
 * ⚠️ 必须受控 open：Radix Collapsible 的 defaultOpen 只在**挂载时**取一次初值，而
 * 一轮结束时 loadMessages() 会用服务端权威消息覆盖本地流式那份（消息 id 变化 → 子树
 * 重挂载）。受控写法与 PartView 的 ReasoningView / ToolCallCard 保持一致，
 * 展开 / 收起时同样要 holdScroll() 暂停自动贴底，否则视图会被拽走。
 */
import { useState, type ReactNode } from 'react'
import { Brain, ChevronRight, Wrench } from 'lucide-react'
import { ShimmerLabel } from '@fizz/agent-kit/shared/ai-elements/shimmer-label'
import { WorkBars } from '@fizz/agent-kit/shared/ai-elements/work-bars'
import { ReasoningPreview } from '@fizz/agent-kit/shared/ai-elements/reasoning'
import { useConversationOptional } from '@fizz/agent-kit/shared/ai-elements/conversation'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@fizz/ui/collapsible'
import { REVEAL_ON_HOVER_ARROW } from '@fizz/agent-kit/shared/lib/hover-reveal-arrow'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { cn } from '@fizz/agent-kit/shared/lib/utils'

export function TurnStepGroup({
  label,
  preview,
  active = false,
  live = false,
  kind,
  children
}: {
  /** 抬头左格（最后做的那件事 / 已工作多久 / 计数摘要），由 `lib/turn-step.ts` 算好传进来 */
  label: string
  /**
   * 这一段**最后一步是什么类型**，只决定名字左边那颗图标：
   * `tool` → 扳手（与工具卡 `ToolHeader` 同一颗），`reasoning` → 脑（与思考条
   * `ReasoningTrigger` 同一颗）。不传就不渲染图标。
   *
   * 为什么要有：未结束时左格写的是「最后做的那一件事」（`跑一下单测` / `思考中…`），
   * 那是一行纯文字 —— 单条工具卡有扳手、单条思考有脑，唯独折进组里之后就什么都不剩，
   * 一列收起的抬头全长得一样。图标把这层「这一步是工具还是思考」补回来。
   */
  kind?: 'tool' | 'reasoning'
  /**
   * 抬头右格的内容预览（思考最后一行 / 命令 / 路径）。`undefined` = 只显示名字。
   * 展开状态下同样不显示（内容已经在下面展开，见 `showPreview`）。
   *
   * `lineKey` 只对思考有意义（换行下标，靠它判「滚一格」）；工具的明细给 -1。
   */
  preview?: { text: string; lineKey: number }
  /**
   * 这一段过程还在跑。
   *
   * **收起时**：名字前挂三根跳动的竖条（`WorkBars`）+ 抬头扫光（`ShimmerLabel`），
   * 并让右格预览跟最新字走；**展开时**：这两样都撤掉，名字换成「正在工作」。
   * 落地后全部收回，历史消息里不留还在跳的图标。
   */
  active?: boolean
  /**
   * 这一段**还是本轮的最后一段可见内容**（本轮没结束、且这组的尾 part 就是最后一个 part）。
   *
   * 只服务展开态的「正在工作」那句文案，是比 `active` **更宽**的判据：`active` 还要求尾
   * part 自己真的在跑（`isStepInFlight`），于是工具刚出结果、模型正在生成下一次调用的
   * 那几秒它会翻成 false。文案要是挂在 `active` 上，展开的抬头就会在「正在工作」和
   * 「执行命令」之间来回闪 —— 用户看到的就是这行字抽风。
   */
  live?: boolean
  children: ReactNode
}) {
  const tr = useT()
  const [open, setOpen] = useState(false)
  // 消息区的滚动上下文（可能不在 Conversation 里，拿不到就退化成空操作）
  const conversation = useConversationOptional()

  /*
   * 右格内容预览只给**收起**状态看。
   *
   * 展开后这一步的正文 / 思考全文 / 命令输出就在下面一行不落，抬头再复读一遍最后一行
   * 是纯重复，而且眼睛刚落到正文就被抬头那行字拽回去。展开 = 用户要看细节，
   * 抬头这时只留名字 + 箭头。
   */
  const showPreview = !!preview && !open

  /*
   * 展开 + 进行中：抬头直接报「正在工作…」，左侧仍是那三根竖条（`WorkBars`）。
   *
   * 扫光是**收起态**的东西：眼睛扫一列收起的抬头时，靠「哪一组还在扫光」定位哪一组还在跑。
   * 可一旦展开，细节（思考全文 / 命令输出）就在下面一行不落地流着 —— 抬头还有一道光在扫，
   * 纯属噪音。用户要的只是「这组在干活」，那就只留这句话；竖条不撤，左边不换形状
   * （也和这一步是工具还是思考无关）。
   *
   * ⚠️ 判据是 `live` 而**不是** `active`：`active` 在「工具出了结果、模型还在生成下一次
   * 调用」的那几秒会翻 false，挂在它上面的话，这行字会在「正在工作」和
   * 「执行命令 / 跑一下单测」之间反复横跳（用户报过这个）。`live` 只看「这组还是本轮最后
   * 一段」，整段过程从头到尾稳定为真。
   *
   * 折叠回去（`!open`）立刻恢复原样：竖条 + 扫光 + 预览，和以前完全一致；
   * 整轮落地后也照旧是「已工作 1 分 12 秒」那种纯文字。
   */
  const working = live && open
  const ticking = active && !open
  // 展开态那句固定「正在工作…」（省略号是文案的一部分，不是动画）：配上左边还在跳的竖条，
  // 读起来就是「还在往外说」
  const labelText = working ? tr('正在工作…') : label

  /*
   * 名字左边那颗**类型图标**（扳手 / 脑），和竖条 / 气泡**抢同一个位置**，永远只有一个：
   *
   * - 进行中 + 收起 → 竖条（`ticking`）：这时「在不在跑」比「这一步是什么类型」更急，
   *   而且扫光已经在动，左侧再塞一颗静态图标就是**并排两个图形**（用户报过）；
   * - 进行中 + 展开 → 打字气泡（`working`，由调用处直接给 `TypingBubble`）；
   * - 本轮还在跑、等模型下一步 → 类型图标（这时抬头是「做什么」，需要它区分工具 / 思考）；
   * - 本轮已结束 → 什么都不放（抬头是「已工作 N 秒」，一颗扳手 / 脑挂在那里像还欠一步工具）。
   *
   * ⚠️ 只挂在 `ticking` / `working` 上会闪：`active` 在「工具出结果 → 模型生成下一次调用」
   * 那几秒会翻 false，图标就会灭了再亮。所以那两档之外**一律按 `live` 判**，不看 `active` ——
   * `live` 整段过程稳定为真，翻 false 只可能是一轮真结束了，而那正是该把图标收掉的时刻。
   */
  const kindIcon =
    kind === 'tool' ? (
      <Wrench className="size-4 shrink-0" />
    ) : kind === 'reasoning' ? (
      <Brain className="size-4 shrink-0" />
    ) : null

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        conversation?.holdScroll()
        setOpen(next)
      }}
      className="w-full"
    >
      {/* 触发行照抄 ReasoningTrigger 的口径（同样是「图标 + 一行摘要」）：`flex w-fit`
          让箭头贴着摘要文字、不铺满整行；hover 整行提亮。
          ⚠️ 必须是 `flex` 而不是 `inline-flex`：行内级盒子会被父级 line-height 撑出
          一个更高的行盒（多出来的留白掉在下方），这条摘要就会比工具条偏上、
          与下一条的间距也偏松 —— 详见 reasoning.tsx 的 ReasoningTrigger。 */}
      <CollapsibleTrigger className="group group/row flex w-fit max-w-full items-center gap-2 rounded-md text-left text-muted-foreground text-sm transition-colors hover:text-foreground">
        {/* 左格最多**一个**图形，四档互斥（用条件而不是 hidden，不留空槽把名字推歪）：
            - 进行中 + 收起 → 三根跳动的竖条（位置标记，一眼看出这组在动）；
            - 进行中 + 展开 → 同样是三根竖条（`WorkBars`）：抬头这时是「正在工作…」，
              左边不换形状，免得同一列在折叠 / 展开之间换两种动效；
            - 本轮还在跑、等模型下一步 → 类型图标（扳手 / 脑）；
            - 本轮已结束（「已工作 N 秒」）→ 留空 —— 那是一句总结，不是「下一步做什么」 */}
        {ticking ? <WorkBars /> : working ? <WorkBars /> : live ? kindIcon : null}
        {/* 预览在时名字不被压缩（`min-w-0` 留给预览那一格，它自己截断 / 横向滚动），
            与 ReasoningTrigger 里那对 span 同一处理；展开后预览让位，名字恢复可压缩 */}
        <span className={cn('min-w-0 truncate', showPreview && 'shrink-0')}>
          {/* 扫光同理只给「进行中 + 收起」：展开时抬头是「正在工作」这句话，扫一道光反而
              让人去读那行字，而要看的东西就在下面 */}
          {ticking ? <ShimmerLabel active>{labelText}</ShimmerLabel> : labelText}
        </span>
        {showPreview ? (
          active ? (
            /*
             * 还在跑：与思考条同款预览 —— 横向跟最新字、换行滚动一格
             * （实现与坑见 `ReasoningPreview`）。思考在长、命令在吐输出时，
             * 这一行始终贴着最新的内容走。
             */
            <ReasoningPreview text={preview.text} lineKey={preview.lineKey} />
          ) : (
            /*
             * 已落地：静态一行、从**开头**截断（命令 / 路径的开头比结尾有用，
             * 而横滚到底只能看见尾巴）。全文仍在卡片里，展开即可。
             */
            <span className="min-w-0 flex-1 truncate">{preview.text}</span>
          )
        ) : null}
        {/* 箭头平时隐形、悬停整行才浮出来（规则见 `REVEAL_ON_HOVER_ARROW`）；触屏常显 */}
        <ChevronRight
          className={cn(REVEAL_ON_HOVER_ARROW, 'size-4 shrink-0 group-data-[state=open]:rotate-90')}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <div className="flex flex-col gap-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
