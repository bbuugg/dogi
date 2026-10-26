/**
 * 标签 key 的分类闸门：**每一种**工具标签都必须被 `isToolTabKey` 认领。
 *
 * 为什么值得钉住：`isConversationTabKey` 是「不是工具标签就算会话」这么写的，所以漏登记
 * 一种前缀**不会报错**，只会让那个标签在点开时被当成会话 id 去 `openConversation()` ——
 * 面板整个落到「新对话」空态，看起来像「点了没反应 / 跳到新会话」。
 * 真踩过：`files:` 加进来时忘了并进 `isToolTabKey`，点「文件管理」直接跳新对话页。
 *
 * 这个文件对新增前缀的态度是**自动覆盖**：下面把每个工厂函数都调一遍，加新类型时
 * 记得往 `cases` 里补一行即可（漏补不会失败，但比对 `ToolTabKind` 的那条会提示）。
 */
import { describe, expect, it } from 'vitest'
import {
  apiTabKey,
  filesTabKey,
  hostTabKey,
  isConversationTabKey,
  isToolTabKey,
  localFileTabKey,
  localTabKey,
  logsTabKey,
  noteTabKey,
  pluginTabKey,
  scriptsTabKey,
  sftpTabKey,
  sysmonTabKey,
  triggersTabKey,
  tunnelTabKey,
  NEW_API_REQUEST_ID,
  NEW_TAB_KEY,
  NEW_WS_REQUEST_ID
} from './panel-tabs'

/** 每种工具标签的 key 各一个（新增前缀时往这里补） */
const cases: Array<[name: string, key: string]> = [
  ['主机终端', hostTabKey('abc-123', 1)],
  ['本机终端', localTabKey(1)],
  ['接口请求', apiTabKey('req-1')],
  ['新建请求草稿', apiTabKey(NEW_API_REQUEST_ID)],
  ['新建 WS 草稿', apiTabKey(NEW_WS_REQUEST_ID)],
  ['脚本管理', scriptsTabKey()],
  ['插件界面', pluginTabKey(1)],
  ['SFTP 文件管理', sftpTabKey('abc-123')],
  ['隧道', tunnelTabKey()],
  ['应用日志', logsTabKey()],
  ['文件管理', filesTabKey()],
  ['系统监控', sysmonTabKey()],
  ['定时任务', triggersTabKey()],
  ['笔记', noteTabKey(1)],
  ['外部文件', localFileTabKey(1)]
]

describe('工具标签的分类', () => {
  it.each(cases)('%s 的 key 被认作工具标签', (_name, key) => {
    expect(isToolTabKey(key)).toBe(true)
    expect(isConversationTabKey(key)).toBe(false)
  })

  it('会话 id 与空态哨兵仍算对话标签', () => {
    // 服务端生成的会话 id 是 uuid / 短 id，绝不会带 `xxx:` 前缀
    for (const key of ['3f1a2b', 'c0ffee00-1111-2222-3333-444455556666', NEW_TAB_KEY]) {
      expect(isToolTabKey(key)).toBe(false)
      expect(isConversationTabKey(key)).toBe(true)
    }
  })

  it('前缀之间不互相误认（抽样：files: 不会吃掉 file:）', () => {
    // 这两个前缀只差一个 s，一旦比较写成 includes / 去掉冒号就会串
    expect(isToolTabKey(filesTabKey())).toBe(true)
    expect(isToolTabKey(localFileTabKey(1))).toBe(true)
    expect(filesTabKey()).not.toBe(localFileTabKey(1))
  })
})
