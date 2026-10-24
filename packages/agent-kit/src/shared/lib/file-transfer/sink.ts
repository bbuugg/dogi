/**
 * 下载落盘：把分片传输收到的字节**边收边写**到用户机器上，三种宿主三套做法。
 *
 * | 宿主 | 落盘方式 | 内存 |
 * |---|---|---|
 * | desktop | 系统保存框 → 每片 `host.fileSaveChunk(path, data, append)` | **无上限**（逐片落盘） |
 * | web / Chromium | `showSaveFilePicker()` → `FileSystemWritableFileStream.write()` | **无上限**（逐片落盘） |
 * | web / Firefox·Safari | 攒 `Uint8Array[]` → `close()` 时 `new Blob(parts)` + `<a download>` | **仍随文件增长** |
 *
 * ⚠️ **第三支没有真正解除内存限制**，只是解除了旧的 100MB 硬线：整份文件仍要驻留内存，
 * 下几个 G 的东西照样会把标签页拖垮。这是刻意的取舍（Firefox / Safari 没有 FSA），
 * 所以 `streaming === false` 时**调用方必须提示用户**「这次没有真流式落盘」——
 * **不静默降级**：用户以为自己在下大文件、实际攒在内存里，崩了才知道就太晚了。
 *
 * 为什么服务端不做落盘：服务端很可能跟浏览器不在同一台机器上（web 部署形态），它看不见
 * 用户的本地磁盘，「下载到某路径」在服务端根本无从谈起。所以字节一律回到渲染端，由这里落。
 *
 * `createSink` 回 `null` = **用户取消了保存位置**（desktop 的保存框 / Chromium 的选择器）。
 * 调用方据此把任务收成 `canceled`，并且**一个分片请求都不发**。
 */
import { getAgentHostOrNull } from '@fizz/agent-client/host'
import { triggerBlobDownload } from '@fizz/agent-client/download-file'

export interface TransferSink {
  /** 写一片（顺序由调用方保证；分片必须串行，见 `engine.ts`） */
  write(chunk: Uint8Array): Promise<void>
  /** 收尾：Blob 支在这里才真正触发下载 */
  close(): Promise<void>
  /** 取消：丢弃已写内容（desktop 支还会删掉半份文件） */
  abort(): Promise<void>
  /** 落盘后的本地绝对路径（desktop 支有；web 两支都没有，浏览器里没有路径概念） */
  localPath: string | null
  /** 是否真流式落盘。`false` = 攒在内存里，调用方要提示用户 */
  streaming: boolean
}

// ---------------------------------------------------------------------------
// File System Access API 的最小形状
//
// ⚠️ 手写而不用 `@types/wicg-file-system-access`：TS 自带的 DOM lib **不含**这套 API
// （`window.showSaveFilePicker` 直接报 TS2339，实测过），而只为一个方法引一个 @types
// 包不划算。这里刻意**不 `declare global`**，改成局部结构 + 一次收窄取值 ——
// 将来 DOM lib 真加上了也不会与它冲突。
// ---------------------------------------------------------------------------

interface FsaWritable {
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

interface FsaSaveTarget {
  createWritable(): Promise<FsaWritable>
}

type SaveFilePicker = (options?: { suggestedName?: string }) => Promise<FsaSaveTarget>

function getSaveFilePicker(): SaveFilePicker | null {
  const impl = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker
  return typeof impl === 'function' ? impl : null
}

export async function createSink(name: string): Promise<TransferSink | null> {
  const host = getAgentHostOrNull()

  // ---------- 1. desktop：系统保存框 + 逐片追加 ----------
  //
  // ⚠️ 三个条件都要判：`platform` 认环境，两条方法认能力。宿主没实现（或将来被摘掉）时
  // **不能**硬走这一支 —— 会变成「点了下载什么都不发生」。判不过就往下落到 web 支。
  if (host?.platform === 'desktop' && host.fileAskSavePath && host.fileSaveChunk) {
    const path = await host.fileAskSavePath(name)
    if (!path) return null // 用户取消：一个请求都不发
    // 第一片截断创建（于是「同名文件直接覆盖」天然成立），其余追加
    let append = false
    return {
      localPath: path,
      streaming: true,
      write: async (chunk) => {
        const written = await host.fileSaveChunk!(path, chunk, append)
        append = true
        // 失败（磁盘满 / 无权限 / 路径被占）当作异常上抛，由引擎收成 failed 并带上原因
        if (written === null) throw new Error(`写盘失败：${path}`)
      },
      close: async () => {
        // 每片都已经被主进程落盘了，收尾无事可做
      },
      abort: async () => {
        // 删掉半份文件：分片协议下它是**真实存在且内容完整**的一堆前缀字节，
        // 留着就是一个「看起来成功」的坏文件（与远端 abort 同一类问题）
        await host.fileRemovePath?.(path)
      }
    }
  }

  // ---------- 2. web / Chromium：真流式落盘 ----------
  const picker = getSaveFilePicker()
  if (picker) {
    let writable: FsaWritable
    try {
      writable = await (await picker({ suggestedName: name })).createWritable()
    } catch (err) {
      /**
       * ⚠️ 用户在选择器里点「取消」抛的是 `AbortError` —— 那是**取消**不是失败，
       * 必须回 `null`。让它冒出去会让引擎把「我不想存了」报成一条红色的失败记录。
       * 其余异常（如 `SecurityError`：非用户手势下调用）才是真失败，照抛。
       */
      if (err instanceof DOMException && err.name === 'AbortError') return null
      throw err
    }
    return {
      localPath: null,
      streaming: true,
      write: (chunk) => writable.write(chunk),
      close: () => writable.close(),
      abort: () => writable.abort()
    }
  }

  // ---------- 3. web / Firefox·Safari：攒起来最后另存为 ----------
  return createBlobSink(name)
}

/**
 * 「攒完再另存为」的落盘方式（不弹任何选择框）。
 *
 * 两个用处：
 * 1. `createSink` 的第三支（Firefox / Safari 没有 FSA）；
 * 2. **文件夹下载**（`SftpPanel` 的 `downloadDir`）：那里是逐文件下载，走 `createSink`
 *    会**每个文件弹一次**保存框 / 文件选择器 —— 50 个文件点 50 次，是明确的坏体验。
 *    所以那条路显式指定这个 sink，保持「浏览器自己往下载目录里放」的老行为。
 *
 * ⚠️ 内存随文件增长（见文件头），`streaming` 恒为 `false`。
 */
export function createBlobSink(name: string): TransferSink {
  const parts: Uint8Array[] = []
  return {
    localPath: null,
    streaming: false,
    write: async (chunk) => {
      parts.push(chunk)
    },
    close: async () => {
      triggerBlobDownload(new Blob(parts as BlobPart[]), name)
    },
    abort: async () => {
      // 攒着的东西直接丢掉，没有别的收尾（字节从没落到磁盘上）
      parts.length = 0
    }
  }
}
