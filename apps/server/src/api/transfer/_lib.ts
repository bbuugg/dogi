/**
 * 数据导入 / 导出路由的共用部分：把「上传上来的 base64 文件」拆成 payload 列表，
 * 以及把 payload 列表打成一个 zip。
 *
 * 内容一律走 **base64 JSON**，不是二进制流 / `multipart`：desktop 的 IPC 桥 body 只支持
 * 字符串，`FormData` 会被静默丢掉（同 `lib/api.ts` 的 `uploadFile` 那条注释的理由），
 * 两端必须同一条协议。
 *
 * 一个导入包有两种形态，靠**内容**分流而不是扩展名（用户可能改过名）：
 * - **zip**：里面有 `api.json` / `hosts.json` / `scripts.json`（dogi 导出的就是这个形态）；
 * - **裸 JSON**：单个 `TransferPayload`，类型从内容里的 `kind` 读。
 */
import { Buffer } from 'node:buffer'
import { basename } from 'node:path'
import { kindOfFile, parseTransferDocument, parseTransferPayload } from '@fizz/workspace'
import { createZip, looksLikeZip, readZip } from '@/lib/server/lib/zip'
import type {
  TransferEntry,
  TransferFormat,
  TransferKind,
  TransferPayload
} from '@fizz/contracts/types'

/** 认得出哪些 kind（路由入参校验用；顺序即界面里的显示顺序） */
const KINDS: TransferKind[] = ['api', 'hosts', 'scripts']

/** 把路由入参里的 `kinds` 收敛成合法列表（去重、丢掉不认识的） */
export function pickKinds(raw: unknown): TransferKind[] {
  if (!Array.isArray(raw)) return []
  const out: TransferKind[] = []
  for (const item of raw) {
    if (typeof item === 'string' && KINDS.includes(item as TransferKind) && !out.includes(item as TransferKind)) {
      out.push(item as TransferKind)
    }
  }
  return out
}

/** 收敛导出形态：只有显式写 `json` 才是单文件，其余（含缺省）都当 zip */
export function pickFormat(raw: unknown): TransferFormat {
  return raw === 'json' ? 'json' : 'zip'
}

/** 把 base64 解回字节；空内容直接报错（空文件走到后面只会得到一句莫名其妙的「不是 JSON」） */
export function decodeBase64(dataBase64: unknown): Buffer {
  if (typeof dataBase64 !== 'string' || !dataBase64) throw new Error('缺少文件内容')
  const buf = Buffer.from(dataBase64, 'base64')
  if (buf.length === 0) throw new Error('文件内容是空的')
  return buf
}

export interface ParsedBundle {
  format: 'zip' | 'json'
  payloads: TransferPayload[]
  entries: TransferEntry[]
}

/**
 * 拆包：zip 里的每个 `*.json` 都当一份 payload（其余文件忽略），裸 JSON 就当一份。
 *
 * zip 里的条目**按文件名认类型**（导出方写死的名字，对不上就是真的坏了）；
 * 裸 JSON **按内容里的 kind 认**（用户可能把 `api.json` 改名成别的）。
 */
export function parseBundle(buf: Buffer, fileName: string): ParsedBundle {
  if (looksLikeZip(buf)) {
    const payloads: TransferPayload[] = []
    const entries: TransferEntry[] = []
    for (const file of readZip(buf)) {
      /*
       * 归档内的路径可能带目录前缀（`fizz-导出/api.json`），所以只看**文件名**。
       * 压平放在这里而不是 `readZip` 里：那是读 zip 的通用行为，压平会让
       * `a/x.json` 与 `b/x.json` 撞名（见 `readZip` 的注释）。
       */
      const name = basename(file.name)
      /*
       * 认不出名字的文件直接忽略（压缩包里常有 `.DS_Store`、说明文件之类）；
       * 但**名字对得上的必须解析成功** —— 那种情况下文件是真的坏了，
       * 静默跳过只会让用户看到一句莫名其妙的「压缩包里没有可导入的数据」。
       */
      if (!kindOfFile(name)) continue
      const parsed = parseTransferPayload(name, file.data.toString('utf8'))
      payloads.push(parsed.payload)
      entries.push({
        kind: parsed.kind,
        file: name,
        itemCount: parsed.payload.items.length,
        groupCount: parsed.payload.groups.length
      })
    }
    if (entries.length === 0) {
      throw new Error('压缩包里没有可导入的数据（需要 api.json / hosts.json / scripts.json）')
    }
    return { format: 'zip', payloads, entries }
  }

  const parsed = parseTransferDocument(fileName || '导入文件', buf.toString('utf8'))
  return {
    format: 'json',
    payloads: [parsed.payload],
    entries: [
      {
        kind: parsed.kind,
        file: fileName || `${parsed.kind}.json`,
        itemCount: parsed.payload.items.length,
        groupCount: parsed.payload.groups.length
      }
    ]
  }
}

/** 把若干 payload 打成一个 zip（条目名就是各自的文件名，dogi 认这几个名字） */
export function zipPayloads(
  items: Array<{ name: string; payload: TransferPayload }>,
  mtime: Date = new Date()
): Buffer {
  return createZip(
    items.map(({ name, payload }) => ({
      name,
      data: Buffer.from(JSON.stringify(payload, null, 2), 'utf8')
    })),
    mtime
  )
}

/** `fizz-导出-20260113-1550.zip`：带时间戳，连着导几次不会在下载目录里互相覆盖 */
export function stampFileName(ext: string, now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`
  return `fizz-导出-${stamp}.${ext}`
}
