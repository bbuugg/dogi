import { Check, Settings, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@fizz/ui/dropdown-menu";
import { CHAT_PILL } from "@fizz/agent-kit/features/chat/composer";
import { useAppContext } from "@fizz/agent-kit/shared/hooks/use-app-context";
import type { AgentApp } from "@fizz/agent-kit/shared/hooks/useAgentApp";
import { useIsMobile } from "@fizz/agent-kit/shared/hooks/useIsMobile";
import { useT } from "@fizz/agent-kit/shared/lib/language";
import { t } from "@fizz/i18n";
import { cn, formatContextWindow } from "@fizz/agent-kit/shared/lib/utils";
import {
  DEFAULT_CONTEXT_WINDOW,
  resolveContextWindow,
} from "@fizz/contracts/types";

/** 一份配置下能选的模型 id 清单 */
function catalogOf(config: AgentApp["models"][number]): string[] {
  return (config.models ?? []).map((model) => model.id);
}

/**
 * 下拉触发器上显示什么：当前用的「配置 · 模型」/「Agent · 模型」；没选就是「选择模型」。
 * 与 `onTargetChange` 的编码同源，但这里是给人看的短标签。
 */
function targetLabel(app: AgentApp, withProvider: boolean = true): string {
  const target = app.chatTarget;
  if (!target?.configId) return t("选择模型");
  if (target.backend === "acp") {
    const agent = app.acpAgents.find((a) => a.id === target.configId);
    // agent 被删了（会话里记的还是旧 id）→ 当作没选
    if (!agent) return t("选择模型");
    const model = agent.models?.find((m) => m.value === target.modelId);
    if (withProvider) {
      return model ? `${agent.name} · ${model.name}` : agent.name;
    }
    return model ? `${model.name}` : agent.name;
  }
  const config = app.models.find((m) => m.id === target.configId);
  if (!config) return t("选择模型");
  // 记的模型不在清单里（被删 / 没选）→ 显示「选择模型」，**不回退**到清单第一个
  const catalog = catalogOf(config);
  const modelId =
    target.modelId && catalog.includes(target.modelId) ? target.modelId : "";
  if (!modelId) return t("选择模型");
  return withProvider ? `${config.name} · ${modelId}` : modelId;
}

function onTargetChange(app: AgentApp, value: string): void {
  const first = value.indexOf(":");
  const second = value.indexOf(":", first + 1);
  const backend = value.slice(0, first) as "mastra" | "acp";
  if (second === -1) {
    app.setChatTarget({ backend, configId: value.slice(first + 1) });
    return;
  }
  app.setChatTarget({
    backend,
    configId: value.slice(first + 1, second),
    modelId: value.slice(second + 1),
  });
}

/**
 * 模型 / 后端选择：紧挨发送按钮。
 *
 * 一个下拉装下「这一轮用什么」，标签行尾各有设置齿轮（配置入口永远可达）：
 * - AI 模型：每个模型配置一项，展开是它带的那几个模型；齿轮打开 设置 → AI 模型；
 * - 外部 Agent（ACP）：每个 agent 一项，展开是**设置里挑过的那几个**模型
 *   （一个 agent 常有十几二十个模型，全列出来太吵，白名单见设置 → 外部 Agent）；
 *   齿轮打开 设置 → 外部 Agent。没有任何模型 / agent 时分组也显示（给配置入口）。
 *
 * 会话类型在创建时就锁定，**被锁的整组不显示**（不是置灰）：
 * - acp 会话：只显示绑定的那个 agent 的模型（AI 模型组、其它 agent 一概不出）；
 * - mastra 会话：ACP 组不出；锁了配置的只显示那份配置；
 * - 没有会话（空态）：两组全量可选。
 * 换类型只能新建会话。
 */
export function ModelSelect({ app }: { app: AgentApp }) {
  // 订阅语言：下面 `targetLabel()` / 组名都是渲染期求值的
  useT();
  const isMobile = useIsMobile();
  const { openSettingsTab } = useAppContext();
  // 手机上把「配置 / 外部 Agent → 各自的模型」这层二级菜单拍平：Radix 的 DropdownMenuSub
  // 会往侧边展开，窄屏放不下就溢出视口；手机上改成在主面板内直接铺开（组名当标题、模型项
  // 紧随其后），主面板给高度上限 + 滚动。桌面端维持原有的侧向二级弹层。
  const renderGroup = (key: string, label: string, items: ReactNode) =>
    isMobile ? (
      <DropdownMenuGroup key={key}>
        {/* 拍平后组名和模型项是紧挨着的两行，**必须**在字面上就分得开。
                    原来这里写 `px-2 font-normal`：font-normal 把 DropdownMenuLabel 默认的
                    font-medium 抹掉了，剩下的 px-2 py-1.5 text-sm 与 DropdownMenuItem 逐项相同 ——
                    同字号、同字重、同内边距、同颜色，看上去就是一堆平铺的模型名。
                    改成小号灰字（与上面 renderSectionLabel 的「AI 模型」同一套标题样式）+ 组前一条
                    细线：线把每个配置的块框住，小字说明这行是标题而不是可选项。
                    ⚠️ 不要再加 pt-* / pb-* 试图改内边距：tailwind-merge 会把 DropdownMenuLabel 自带的
                    py-1.5 一起留着，最终哪条生效取决于 Tailwind 生成 CSS 的先后顺序（这里靠 mt-1.5
                    拉开组间距就够了）。模型项本身不动：它是 text-sm + 行尾窗口数字 / 勾，差距已够大。 */}
        <DropdownMenuLabel className="mt-1.5 px-2 text-xs font-medium text-muted-foreground">
          {label}
        </DropdownMenuLabel>
        {items}
      </DropdownMenuGroup>
    ) : (
      <DropdownMenuSub key={key}>
        <DropdownMenuSubTrigger>
          <span className="truncate">{label}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
          {items}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );

  /** 分组标签行：组名 + 行尾设置齿轮（打开设置里对应的分组；配置入口永远可达） */
  const renderSectionLabel = (label: string, tab: "models" | "acp") => (
    <DropdownMenuLabel className="flex items-center justify-between px-2 py-1.5 text-xs font-normal text-muted-foreground">
      <span>{label}</span>
      <button
        type="button"
        title={t("打开设置 → {tab}", { tab: tab === "models" ? t("AI 模型") : t("外部 Agent（ACP）") })}
        aria-label={t("打开设置 → {tab}", { tab: tab === "models" ? t("AI 模型") : t("外部 Agent（ACP）") })}
        onClick={(e) => {
          e.stopPropagation();
          openSettingsTab(tab);
        }}
        className="rounded p-0.5 transition-colors hover:bg-foreground/10 hover:text-foreground"
      >
        <Settings className="size-3.5" />
      </button>
    </DropdownMenuLabel>
  );

  const activeConversation = app.conversations.find(
    (c) => c.id === app.activeConversationId,
  );
  // 类型锁定判定（被锁的**整组不显示**，不是禁用）：
  // - acp 会话：只显示绑定的那个 agent 的模型（AI 模型组、其它 agent 一概不出）
  // - mastra 会话：ACP 组不出；AI 模型全量可选（不锁配置）
  // - 没有会话（空态）：两组全量可选
  const convBackend = activeConversation?.backend;
  const lockedAgent =
    convBackend === "acp"
      ? app.acpAgents.find((a) => a.id === activeConversation?.configId)
      : undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* 手写 button + DropdownMenu（不是 Select，因为要二级菜单）：样式与结构都走
            CHAT_PILL —— 前置图标、箭头大小 / 颜色必须和另外两个 pill 对齐 */}
        <button
          type="button"
          aria-label={t("选择后端")}
          title={
            app.chatTarget?.configId
              ? targetLabel(app)
              : t("这一轮用哪个模型 / 哪个外部 Agent（下一轮生效）")
          }
          className={CHAT_PILL}
        >
          <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
          {/* 选中目标可能是「配置 · 模型」这种长名：截断时靠 title 看全 */}
          <span className="truncate" title={targetLabel(app)}>
            {targetLabel(app, false)}
          </span>
        </button>
      </DropdownMenuTrigger>
      {/* 与两个 Select 同款：向上弹 + 6px 间距（触发器贴着窗口底部）。
          ⚠️ 手机上二级菜单会被拍平，项很多；高度上限**不能写死** `80dvh` —— 那样会盖掉
          Radix 算出的可用高度，列表比触发器上方的空间还高时会被顶出视口上沿。
          取 `min(80dvh, 可用高度)`：80dvh 兜住移动端动态视口（地址栏 / 键盘），可用
          高度兜住触发器以上的真实空间。collisionPadding 让面板与视口边缘留 8px，
          它也会算进那个可用高度里。滚动由 DropdownMenuContent 自带的 overflow-y-auto 负责。 */}
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={6}
        collisionPadding={8}
        className={cn(
          "min-w-56",
          isMobile &&
            "max-h-[min(80dvh,var(--radix-dropdown-menu-content-available-height))]",
        )}
      >
        {lockedAgent ? (
          <>
            {/* ---- acp 会话：只显示绑定的这个 agent 的模型（其它一切不出现） ---- */}
            {renderSectionLabel(`${lockedAgent.name}（ACP）`, "acp")}
            {/* agent 没挑白名单时它只有一个状态：用 agent 自己的默认（agent 侧的
                缺省，不是 Fizz 的设置）；挑了白名单就必须具体选一个 */}
            {!(lockedAgent.models ?? []).length && (
              <DropdownMenuItem
                onSelect={() => onTargetChange(app, `acp:${lockedAgent.id}`)}
              >
                <span className="truncate">{t("跟随 agent 默认")}</span>
                {app.chatTarget?.backend === "acp" &&
                  !app.chatTarget.modelId && (
                    <Check className="ml-auto size-3.5" />
                  )}
              </DropdownMenuItem>
            )}
            {(lockedAgent.models ?? []).map((model) => {
              const active =
                app.chatTarget?.backend === "acp" &&
                app.chatTarget.modelId === model.value;
              return (
                <DropdownMenuItem
                  key={model.value}
                  title={model.description ?? model.name}
                  onSelect={() =>
                    onTargetChange(app, `acp:${lockedAgent.id}:${model.value}`)
                  }
                >
                  <span className="truncate">{model.name}</span>
                  {active && <Check className="ml-auto size-3.5" />}
                </DropdownMenuItem>
              );
            })}
          </>
        ) : (
          <>
            {/* ---- AI 模型：全量可选 ---- */}
            {renderSectionLabel(t("AI 模型"), "models")}
            {app.models.length === 0 ? (
              <DropdownMenuItem
                disabled
                className="text-xs text-muted-foreground"
              >
                {t("还没有模型配置")}
              </DropdownMenuItem>
            ) : (
              app.models.map((config) => {
                const catalog = catalogOf(config);
                // 没有任何模型的配置不可选（服务端会拒绝），下拉里干脆不出现
                if (!catalog.length) return null;
                const items = catalog.map((modelId) => {
                  const active =
                    app.chatTarget?.backend === "mastra" &&
                    app.chatTarget.configId === config.id &&
                    app.chatTarget.modelId === modelId;
                  return (
                    <DropdownMenuItem
                      key={modelId}
                      title={modelId}
                      onSelect={() =>
                        onTargetChange(app, `mastra:${config.id}:${modelId}`)
                      }
                    >
                      <span className="truncate">{modelId}</span>
                      {/* 窗口一并显示：圆环的分母就是它，选之前就能对上预期 */}
                      <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground tabular-nums">
                        {formatContextWindow(
                          resolveContextWindow(
                            config.models,
                            modelId,
                            app.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
                          ),
                        )}
                      </span>
                      {active && <Check className="size-3.5 shrink-0" />}
                    </DropdownMenuItem>
                  );
                });
                return renderGroup(config.id, config.name, items);
              })
            )}
            {/*
                          ---- 外部 Agent（ACP）：**只在空态出现** ----
                          有会话时换不了类型（换类型 = 新建会话），所以 mastra 会话里这组不出。
                          选中即改 `chatTarget`，`setChatTarget` 会顺手探一次这个 agent 的档位
                          （`probeDraftAcp`）—— 模式 / 思考档 pill 没有会话可读，只能先问 agent。
                        */}
            {!activeConversation && (
              <>
                {renderSectionLabel(t("外部 Agent（ACP）"), "acp")}
                {app.acpAgents.length === 0 ? (
                  <DropdownMenuItem
                    disabled
                    className="text-xs text-muted-foreground"
                  >
                    {t("还没有外部 Agent")}
                  </DropdownMenuItem>
                ) : (
                  app.acpAgents.map((agent) => {
                    const models = agent.models ?? [];
                    const items = [
                      <DropdownMenuItem
                        key="__default"
                        onSelect={() => onTargetChange(app, `acp:${agent.id}`)}
                      >
                        <span className="truncate">{t("跟随 agent 默认")}</span>
                        {app.chatTarget?.backend === "acp" &&
                          app.chatTarget.configId === agent.id &&
                          !app.chatTarget.modelId && (
                            <Check className="ml-auto size-3.5" />
                          )}
                      </DropdownMenuItem>,
                      ...models.map((model) => {
                        const active =
                          app.chatTarget?.backend === "acp" &&
                          app.chatTarget.configId === agent.id &&
                          app.chatTarget.modelId === model.value;
                        return (
                          <DropdownMenuItem
                            key={model.value}
                            title={model.description ?? model.name}
                            onSelect={() =>
                              onTargetChange(
                                app,
                                `acp:${agent.id}:${model.value}`,
                              )
                            }
                          >
                            <span className="truncate">{model.name}</span>
                            {active && <Check className="ml-auto size-3.5" />}
                          </DropdownMenuItem>
                        );
                      }),
                    ];
                    // key 加前缀：agent id 与模型配置 id 不同域，可能撞名
                    return renderGroup(`acp:${agent.id}`, agent.name, items);
                  })
                )}
              </>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
