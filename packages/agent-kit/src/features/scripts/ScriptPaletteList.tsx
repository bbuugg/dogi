"use client";

/**
 * 命令面板「运行脚本」二级视图的列表：**按分组分段**。
 *
 * ## 为什么抽成共享件
 *
 * 命令面板有两份：`@fizz/agent-kit/shell/CommandPalette`（web / desktop，Radix 对话框里）
 * 和 `apps/mobile/src/app/CommandPalette`（手机外壳）。两份文件本来就是同源抄的，脚本这块
 * 内容与分组规则必须一致 —— 再抄一份的结果就是「改一处、漏一处」。
 *
 * ## 为什么分段，而不是「平铺 + 右侧小字标组名」
 *
 * 旧写法是一行一个脚本、右端用灰字标出组名。问题是：脚本一多（同一批主机动辄十几条，
 * 名字还常常都叫「重启 xx」），平铺会让**分组这个结构彻底看不见** —— 分组是用户手工
 * 拖出来的，它本身就是信息；只能逐行去读行尾小字，扫列表时等于没有信息。
 * 脚本清单页（`ScriptsPanel`）本来就是分组呈现，命令面板跟它对齐，同一批数据才不会
 * 出现两种形状。
 *
 * ## 顺序与空分组
 *
 * 与清单页同一口径：**未分组恒首位**，其余按 `scriptGroups` 的排列（`groupId` 指向已不存在
 * 的分组时按未分组处理）。空分组不渲染 —— 清单页要显示它是因为那是拖拽落点，
 * 这里没有拖拽，留一个空标题只是噪声。
 *
 * ## 搜索
 *
 * 过滤仍交给 cmdk：每条的 `value` 里带上**组名**，所以键入组名能把整组筛出来；
 * 组内一条都不匹配时 cmdk 会把整个 `CommandGroup`（连标题）标成 `hidden`，不会留下空标题。
 */
import { FileCode2 } from 'lucide-react'
import { CommandGroup, CommandItem } from '@fizz/ui/command'
import { useT } from '@fizz/agent-kit/shared/lib/language'
import { runScriptFromPalette } from '@fizz/agent-kit/features/scripts/run-script-command'
import {
  scriptSections,
  UNGROUPED_SECTION_ID,
  type ScriptSection
} from '@fizz/agent-kit/features/scripts/script-sections'
import type { AgentApp } from '@fizz/agent-kit/shared/hooks/useAgentApp'

interface ScriptPaletteListProps {
  app: AgentApp
  /**
   * 调用方的「先关面板、再执行」包装（两份命令面板都有同一个 `run` 帮助函数）：
   * 选中项要先关掉对话框，执行才会落到面板后面那块界面上（终端就地执行同理）。
   */
  run: (action: () => void) => () => void
}

export function ScriptPaletteList({ app, run }: ScriptPaletteListProps) {
  const t = useT()
  const sections = scriptSections(app.scripts, app.scriptGroups, t('未分组'))
  /**
   * 只有一段且那一段就是「未分组」时**不写标题**：那是「这个用户还没建过分组」的常态，
   * 顶上挂一句「未分组」纯属噪声（把整个清单归成一类还提醒你它没归类）。
   */
  const headingOf = (section: ScriptSection): string | undefined =>
    sections.length === 1 && section.id === UNGROUPED_SECTION_ID ? undefined : section.heading
  return (
    <>
      {sections.map((section) => (
        <CommandGroup key={section.id} heading={headingOf(section)}>
          {section.items.map((script) => (
            <CommandItem
              key={script.id}
              // 带上组名：键入组名即可把整组筛出来（标题本身不参与 cmdk 的匹配）
              value={`${script.name} ${section.heading}`}
              keywords={['script', '脚本', 'run', '运行', script.name]}
              title={script.description?.trim() || script.name}
              onSelect={run(() => runScriptFromPalette(app, script.id))}
            >
              <FileCode2 />
              <span className="truncate">{script.name}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      ))}
    </>
  )
}
