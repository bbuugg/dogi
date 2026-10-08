/**
 * `read_tool_output`：按 id + offset 读回工具结果被截断掉的那些内容。
 *
 * 为什么单独一个工具而不是给 `read_terminal_output` 加参数：
 * 产物不止终端侧有 —— `execute_command` 的 stdout / stderr 超长时同样落盘成产物。
 * 两个作用域共用一个读取入口，模型只需要记一个工具。
 *
 * 产物 id 由工具结果文本给出（形如 `{"id":"...","offset":12000,"length":8000}`），
 * 模型照着传即可。id 非法 / 文件不在（重启后清理、超过 24 小时被扫掉）时
 * **返回一句说明而不是抛错** —— 那是可预期的结果，模型该知道「读不到了」并改用别的办法，
 * 抛错会把整轮打断。
 */
import { z } from 'zod'
import { ARTIFACT_READ_MAX, readArtifact } from './output-artifact'
import type { AiToolDef } from './tool-registry'

export function buildReadToolOutputDef(): AiToolDef {
  return {
    name: 'read_tool_output',
    scope: 'both',
    description:
      '读取上一次工具调用（run_in_terminal / execute_command / send_keys / web_fetch）因输出过长而保存下来的完整内容。' +
      '工具结果里会给出形如 {"id":"xxx","offset":12000,"length":8000} 的提示，按它传参即可。' +
      'offset 与 length 都按字符计（不是字节），把 offset 加上本次返回的长度继续读，直到 remaining 为 0。' +
      `单次最多返回 ${ARTIFACT_READ_MAX} 字符。产物只在产生它的那一轮附近有效（跨重启或超过一天会被清理），读不到时改用对应工具重新执行一次。`,
    inputSchema: z.object({
      id: z.string().describe('产物 id，取自上一次工具结果文本里的 id 字段'),
      offset: z.number().optional().describe('起始字符偏移，默认 0'),
      length: z.number().optional().describe('本次读取的字符数，默认 8000')
    }),
    execute: async (rawInput) => {
      const { id, offset, length } = rawInput as {
        id: string
        offset?: number
        length?: number
      }
      let r
      try {
        r = await readArtifact(id, offset ?? 0, length ?? 8000)
      } catch (err) {
        // 预期内的失败（id 不合法 / 文件已被清理），给模型一句能据此改道的话
        return `读取产物失败：${err instanceof Error ? err.message : String(err)}`
      }
      const header =
        `（产物 ${r.id}，本次返回第 ${r.offset}~${r.offset + r.length} 字符；` +
        `全文共 ${r.totalChars} 字符，还有 ${r.remaining} 字符未读` +
        `${r.remaining > 0 ? `，继续读请传 offset=${r.offset + r.length}` : '，已读完'}）`
      return `${header}\n${r.text}`
    }
  }
}