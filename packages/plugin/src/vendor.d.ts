/**
 * `js-yaml` 不随包提供类型声明，仓库里也没有 `@types/js-yaml`。
 * 此处只声明我们真正用到的那两个函数，够用即止，避免为了四个字符的补全去装一份 types。
 */
declare module 'js-yaml' {
  export function load(input: string, options?: unknown): unknown
  export function dump(input: unknown, options?: unknown): string
}