/**
 * pi 的「工具调用求批准」扩展。
 *
 * 这个文件是 Fizz 随代码分发的**模板**（`apps/server/src/server/acp-extension.ts` 会把它
 * 拷贝到工作区的 `<项目>/.pi/extensions/confirm-tools.ts`）。放在这里而不是直接写进用户项目，
 * 是为了「目标已存在就跳过」—— 用户改过判据 / 换过问法之后，不会被下次建会话冲掉。
 *
 * pi 自己不对工具调用求批准（官方 docs/security.md），要它问只能靠扩展；
 * `pi-acp` 会把这里的 `ctx.ui.confirm` 桥接成 ACP 的 `session/request_permission`，
 * 也就是 Fizz 里的那张确认卡。
 *
 * ⚠️ 装了不等于会加载：`.pi/extensions` 属于 pi 的「项目信任」保护资源，而 pi-acp 用
 * `pi --mode rpc` 起 pi —— RPC 模式弹不出信任提示，缺省 `defaultProjectTrust: "ask"`
 * 会直接跳过。要真生效需二选一：`~/.pi/agent/settings.json` 设
 * `defaultProjectTrust: "always"`，或对该项目 `/trust` 一次。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const hints = pi.getAllTools().find((t) => t.name === event.toolName)?.annotations;
    const needsApproval =
      hints?.destructiveHint === true ||
      (!hints?.readOnlyHint && ((hints?.destructiveHint ?? true) || (hints?.openWorldHint ?? true)));
    if (needsApproval && !(await ctx.ui.confirm(`允许调用 ${event.toolName}？`, event.toolName))) {
      return { block: true, reason: `${event.toolName} 未获批准` };
    }
  });
}
