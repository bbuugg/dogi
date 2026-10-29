/**
 * 断线重接的进程级状态：哪些会话正在接回、哪些在退避睡眠里等唤醒、哪些在做轮次对账。
 *
 * 放 slice 外面是有意的：它们是「同一时刻只能有一条流」的互斥闸门，必须比 store 的构造
 * 生命周期更长、且唯一。
 */

/** ---------------------------------------------------------------------------
 * 断线重接（页面切后台 / 电脑休眠 / 网络切换时那条 SSE 会断）
 * --------------------------------------------------------------------------- */

/**
 * 每个会话「接回中」的标记（`attachRun` 的重接循环持有它）。
 *
 * 只为一件事存在：**防止并发接入**。页面从后台回来时 `visibilitychange` 会主动触发
 * 一次重接，而自动重接的退避睡眠可能还挂着 —— 两条流同时 attach 会把回放帧追加两遍
 * （`handleFrame` 是追加式的，重复就是正文重复）。
 */
export const subscribing = new Set<string>();

/**
 * 正在退避睡眠的重接循环：会话 id → 提前唤醒它（用户点了消息区那条「立即重连」）。
 *
 * 没有它的话，按钮点下去只会撞上 `subscribing` 的去重早退（`attachRun` 直接 return true，
 * 什么都不做），提示条看着像死的。唤醒之后由那个循环自己重试 —— 仍然只有一条流，
 * 不会出现两路回放把正文追加两遍。
 */
export const reconnectNudges = new Map<string, () => void>();

/** 正在做「断线轮次对账」的会话：防并发（页面回前台 + online 会各触发一次） */
export const reconciling = new Set<string>();

/** 第 N 次重接等多久：1s → 2s → 4s…，封顶 8s（后台 tab 的定时器会被浏览器拖慢，够用就好） */
export const reconnectBackoff = (attempt: number): number =>
  Math.min(1000 * 2 ** Math.max(0, attempt - 1), 8000);

/** 睡一会儿（只给断线重接的退避用） */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** 退避睡眠，且允许被「立即重连」提前唤醒（唤醒 = 立刻重试，不等剩下的退避时间） */
export const sleepReconnect = (
  conversationId: string,
  attempt: number,
): Promise<void> =>
  new Promise<void>((resolve) => {
    const wake = (): void => {
      clearTimeout(timer);
      if (reconnectNudges.get(conversationId) === wake)
        reconnectNudges.delete(conversationId);
      resolve();
    };
    const timer = setTimeout(wake, reconnectBackoff(attempt));
    reconnectNudges.set(conversationId, wake);
  });
