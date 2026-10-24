/**
 * 分片传输的两个纯函数。
 *
 * **为什么单独开一个文件**：这是本次改造里唯一能脱离 SSH 主机被单测钉住的边界，
 * 而 `sftp.ts` 顶部 import 了 ssh2 与 `@/lib/*` 别名，不适合被
 * `scripts/verify-sftp-chunked.mjs` 用 jiti 直接拉起来。放在这个**零 import** 的
 * 模块里，单测能干净地 import，`sftp.ts` 与路由再从它 import。
 *
 * 这两个函数都是「会静默出错」的那一类：写错了不报错，只是文件内容坏掉
 * （截断 vs 追加）或者下载死循环（eof 判错）。所以它们值得被测。
 */

/**
 * 某个分片该用哪种模式打开远端文件。
 *
 * - `index === 0` → `'w'`：**截断创建**。这是「同名文件直接覆盖」这条既有语义的
 *   **唯一落点** —— 若所有分片都用 `'a'`，上传同名文件会变成「新内容接在旧尾巴上」
 *   而不是覆盖。改这一行等于改契约。
 * - 其余 → `'a'`：追加。
 *
 * ⚠️ 它只表达「第几片该用什么模式」，**保证不了**调用方按顺序发 ——
 * 同一文件的分片请求必须串行（见 `API_ROUTES.sftpUploadChunk` 的说明）。
 */
export function appendFlagsFor(index: number): 'w' | 'a' {
  return index === 0 ? 'w' : 'a'
}

/**
 * 这一片是不是文件末尾。
 *
 * 判据是「**读到的字节数少于请求的**」，不是「读到的为空」：
 * `offset` 恰好落在文件末尾时会读到 0 字节，那也是 eof；而「0 字节且非 eof」
 * 属于异常（正常不会发生），调用方要按失败收场，否则 offset 不前进 = 死循环。
 */
export function isEof(received: number, requested: number): boolean {
  return received < requested
}
