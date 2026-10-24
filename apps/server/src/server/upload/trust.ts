/**
 * 「已签发附件 URL」表：附件引用归属校验的依据之一（另一条是内置适配器的 `owns()`）。
 *
 * ## 为什么需要它
 *
 * 附件 URL 是**直传**给模型的（`model-messages.ts` 里图片走 `ImagePart.image`、其余走
 * `FilePart.data`，服务端既不下载也不校验内容）。所以客户端递上来的附件引用必须证明
 * 「这条 URL 是我们自己发出去的」—— 否则任何人都能把任意外部地址注进历史，让模型去取它。
 * 内置存储靠 `LocalUploadAdapter.owns()` 的正则认账；**插件上传源交回来的是第三方 URL**
 * （如 `https://storage.to/xxxx`），正则认不出来，只能靠这张「签发记录」。
 *
 * ## 为什么必须落盘
 *
 * 校验发生在**每次发消息**时（`startTurn` 的 `validateUploadFiles`），而历史里的附件引用
 * 会跟着「编辑重发 / 插话收尾起新一轮」一起被重新提交。服务端一重启，内存表空了 —— 没有
 * 持久化的话，那些老会话会突然发不出去（400 附件不合法），等于把用户的历史弄坏。
 *
 * ## 判定是**同步**的
 *
 * `validateUploadFiles` 是同步函数（被 `startTurn` 在查会话之前调用，契约上就是同步的），
 * 所以这里在模块加载时就把文件读进内存，之后只查内存。落盘是后台去抖写的：
 * 一次上传记一条，慢一点没关系（真丢了也只影响重启后的老引用，且下次上传会补回来）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDataDir } from '@fizz/workspace'

/** 一条签发记录：这条 URL 是谁、什么时候、以什么类型发出去的 */
export interface IssuedUploadRef {
  mediaType: string
  ts: number
}

/**
 * 最多记多少条。超了按**最旧优先**丢弃 —— 只影响「很久以前上传的附件在服务端重启后是否
 * 还能重发」，不影响正在用的会话（那些引用刚签发过、必在表里）。
 */
const MAX_ENTRIES = 5000

/** 落盘去抖：连续上传（多选文件）只写一次文件 */
const SAVE_DEBOUNCE_MS = 300

const issued = new Map<string, IssuedUploadRef>()
let loadTask: Promise<void> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saving: Promise<void> | null = null

function issuedFile(): string {
  return join(resolveDataDir(), 'uploads-issued.json')
}

/**
 * 读一次盘（幂等；并发调用共享同一次读取）。模块加载时会 fire-and-forget 调一次，
 * 上传路由也会 await 它 —— 保证「先把历史读回来，再判一条新记录」。
 */
export function initUploadTrust(): Promise<void> {
  if (!loadTask) {
    loadTask = (async () => {
      try {
        const raw = JSON.parse(await readFile(issuedFile(), 'utf8')) as {
          urls?: Array<{ url?: unknown; mediaType?: unknown; ts?: unknown }>
        }
        for (const item of raw?.urls ?? []) {
          if (typeof item?.url !== 'string' || !item.url) continue
          issued.set(item.url, {
            mediaType: typeof item.mediaType === 'string' ? item.mediaType : '',
            ts: typeof item.ts === 'number' ? item.ts : 0
          })
        }
      } catch (err) {
        // 文件不存在是正常的（从没上传过）；其余情况（手改坏了 / 权限）也不该让服务起不来
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('[upload] 读取已签发附件记录失败（从空表开始）：', err)
        }
      }
    })()
  }
  return loadTask
}

/** 这条 URL 是否由本服务签发过（同步，见文件头「判定是同步的」） */
export function issuedUploadRef(url: string): IssuedUploadRef | undefined {
  return url ? issued.get(url) : undefined
}

/** 记一条签发（上传成功后由路由调用）。会安排一次去抖落盘 */
export function recordIssuedUpload(url: string, mediaType: string): void {
  if (!url) return
  issued.set(url, { mediaType, ts: Date.now() })
  if (issued.size > MAX_ENTRIES) {
    // Map 保持插入顺序：砍掉最前面（最旧）的那些
    const keep = [...issued.entries()].slice(issued.size - MAX_ENTRIES)
    issued.clear()
    for (const [key, value] of keep) issued.set(key, value)
  }
  scheduleSave()
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void flush()
  }, SAVE_DEBOUNCE_MS)
}

/**
 * 落盘：先写临时文件再 `rename`（原子替换），避免写一半被读到半截 JSON。
 * 同一时刻只允许一次写（`saving` 串行化），失败只记日志 —— 这是**幂等可重建**的缓存，
 * 不值得为它抛错打断上传。
 */
async function flush(): Promise<void> {
  if (saving) {
    await saving.catch(() => {})
  }
  const snapshot = [...issued.entries()].map(([url, ref]) => ({ url, ...ref }))
  saving = (async () => {
    const file = issuedFile()
    const tmp = `${file}.tmp`
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(tmp, JSON.stringify({ urls: snapshot }), 'utf8')
      await rename(tmp, file)
    } catch (err) {
      console.warn('[upload] 写入已签发附件记录失败（不影响本次上传）：', err)
    }
  })()
  await saving.catch(() => {})
  saving = null
}

// 读到内存才有得查，而这是**安全边界**的输入：模块一被加载就立刻读，别等第一次校验
// （fire-and-forget；失败只记日志，见 initUploadTrust 的 catch）
void initUploadTrust()
