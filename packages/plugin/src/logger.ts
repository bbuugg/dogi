/**
 * 极简 Logger：插件日志统一带 `[plugin:<路径>]` 前缀，路径是 Context 名字链路。
 *
 * 刻意不做日志级别过滤 —— 这一层只需要「谁的日志」可辨认，级别与落盘交给上层。
 */
export class Logger {
  constructor(
    private readonly label: string,
    private readonly parent?: Logger
  ) {}

  /** 完整路径，如 `app:turn:builtin-file-tools` */
  private path(): string {
    return this.parent ? `${this.parent.path()}:${this.label}` : this.label
  }

  debug(...args: unknown[]): void {
    console.debug(`[plugin:${this.path()}]`, ...args)
  }

  info(...args: unknown[]): void {
    console.info(`[plugin:${this.path()}]`, ...args)
  }

  warn(...args: unknown[]): void {
    console.warn(`[plugin:${this.path()}]`, ...args)
  }

  error(...args: unknown[]): void {
    console.error(`[plugin:${this.path()}]`, ...args)
  }

  /** 派生子 logger（名字追加一层），如 `ctx.logger.extend('mcp')` */
  extend(label: string): Logger {
    return new Logger(label, this)
  }
}