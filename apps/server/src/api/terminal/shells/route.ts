/**
 * 终端探测：这台机器上可用的 shell 清单，供终端面板的「选择终端」下拉渲染。
 * 不缓存：探测只是几十次 statSync（微秒级），缓存住会让「刚装好的 pwsh 重启面板还是看不到」。
 */
import { detectShells } from '@fizz/shells'
import type { ShellDetectResult } from '@fizz/shells'

export async function GET() {
  const result: ShellDetectResult = detectShells()
  return Response.json(result)
}
