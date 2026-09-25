/**
 * 数据导入 / 导出服务（左下角菜单）：把「主机 / 笔记 / 接口请求」打成 zip，或把 zip 解回库里。
 *
 * 压缩包结构：一个类型一个 JSON 文件（`hosts.json` / `notes.json` / `api.json`），
 * 各自带分组与条目 —— 导入时先写分组再写条目，条目的 `groupId` 才指得到东西。
 *
 * 两条硬规则：
 * 1. **不导出凭据**。主机密码 / 私钥 / 口令是 safeStorage 加密的、**绑定本机与系统账号**，
 *    拷到别的机器根本解不开。所以导出只带连接元数据，导入后需要重新填凭据。
 * 2. **导入按 id 覆盖**（upsert）。同一份数据导回来能真正恢复，而不是产生一堆重复项；
 *    覆盖前会统计「新增 / 更新」条数回报给界面。
 */
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { storage } from '../storage'
import { createZip, readZip } from './zip'
import type {
  ApiGroup,
  ApiRequestEntry,
  NoteEntry,
  NoteGroup,
  SshGroup,
  SshProfile,
  TransferEntry,
  TransferKind,
  TransferPayload
} from '@shared/types'

/** 类型 → 压缩包里的文件名 */
const FILE_OF: Record<TransferKind, string> = {
  hosts: 'hosts.json',
  notes: 'notes.json',
  api: 'api.json'
}

/** 文件名 → 类型（解析压缩包时反查，只认这三个名字，其它文件忽略） */
const KIND_OF: Record<string, TransferKind> = Object.fromEntries(
  Object.entries(FILE_OF).map(([kind, file]) => [file, kind as TransferKind])
)

/** 解析后暂存在主进程的一份导入包（渲染端只拿得到 bundleId 与摘要，不回传整包数据） */
interface Bundle {
  payloads: Array<{ kind: TransferKind; payload: TransferPayload }>
}

// ---------- 导出：把库里的数据整理成「干净」的可移植结构 ----------

/** 只保留可移植的主机字段：凭据与 has* 派生标记一律不带 */
function hostOut(p: SshProfile): SshProfile {
  return {
    id: p.id,
    kind: p.kind ?? 'ssh',
    groupId: p.groupId,
    color: p.color,
    name: p.name,
    host: p.host,
    port: p.port,
    username: p.username,
    authType: p.authType,
    command: p.command,
    args: p.args,
    autoCommand: p.autoCommand,
    keepaliveInterval: p.keepaliveInterval,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt
  }
}

function noteOut(n: NoteEntry): NoteEntry {
  return {
    id: n.id,
    title: n.title,
    content: n.content,
    language: n.language || 'markdown',
    groupId: n.groupId,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt
  }
}

function apiOut(r: ApiRequestEntry): ApiRequestEntry {
  return {
    id: r.id,
    name: r.name,
    method: r.method,
    url: r.url,
    headers: r.headers ?? [],
    body: r.body ?? '',
    protocol: r.protocol ?? 'http',
    subprotocols: r.subprotocols,
    // 不校验是「显式 false」，缺省才代表正常校验 —— 原样带过去，别写死 true
    rejectUnauthorized: r.rejectUnauthorized,
    groupId: r.groupId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }
}

function groupOut(g: { id: string; name: string; createdAt: number }): {
  id: string
  name: string
  createdAt: number
} {
  return { id: g.id, name: g.name, createdAt: g.createdAt }
}

/** 组装某一类数据的导出内容 */
function buildPayload(kind: TransferKind): { payload: TransferPayload; itemCount: number } {
  if (kind === 'hosts') {
    const profiles = storage.listSshProfiles().map(hostOut)
    return {
      payload: {
        version: 1,
        kind,
        exportedAt: Date.now(),
        groups: storage.listSshGroups().map(groupOut),
        items: profiles
      },
      itemCount: profiles.length
    }
  }
  if (kind === 'notes') {
    const notes = storage.listNotes().map(noteOut)
    return {
      payload: {
        version: 1,
        kind,
        exportedAt: Date.now(),
        groups: storage.listNoteGroups().map(groupOut),
        items: notes
      },
      itemCount: notes.length
    }
  }
  const requests = storage.listApiRequests().map(apiOut)
  return {
    payload: {
      version: 1,
      kind,
      exportedAt: Date.now(),
      groups: storage.listApiGroups().map(groupOut),
      items: requests
    },
    itemCount: requests.length
  }
}

// ---------- 导入：校验并写回 ----------

/** 结构校验：不合法就丢给调用方当错误提示，宁可拒绝也不写脏数据 */
function parsePayload(file: string, raw: Buffer): { kind: TransferKind; payload: TransferPayload } {
  const kind = KIND_OF[basename(file)]
  if (!kind) throw new Error(`无法识别的文件：${file}`)
  const json = JSON.parse(raw.toString('utf8')) as Partial<TransferPayload>
  if (!json || typeof json !== 'object') throw new Error(`${file} 不是有效的 JSON`)
  if (json.version !== 1) throw new Error(`${file} 的数据版本不受支持（${String(json.version)}）`)
  if (json.kind !== kind) throw new Error(`${file} 的内容类型与文件名不符`)
  if (!Array.isArray(json.groups) || !Array.isArray(json.items)) {
    throw new Error(`${file} 结构不完整（缺少 groups / items）`)
  }
  return { kind, payload: json as TransferPayload }
}

/** 条目至少要有个 id 和名字，否则跳过（不中断整批导入） */
function pickItem(kind: TransferKind, raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  if (typeof item.id !== 'string' || !item.id) return null
  if (kind === 'notes' && typeof item.content !== 'string') return null
  if (kind === 'api' && typeof item.url !== 'string') return null
  if (kind === 'hosts' && typeof item.name !== 'string') return null
  return item
}

class TransferService {
  /** 已解析但尚未写入的导入包（bundleId → 内容） */
  private bundles = new Map<string, Bundle>()

  /** 导出：把选中的类型打包写到指定 zip 路径，返回各类型的条目数 */
  async exportToFile(filePath: string, kinds: TransferKind[]): Promise<Partial<Record<TransferKind, number>>> {
    const files: Array<{ name: string; data: Buffer }> = []
    const counts: Partial<Record<TransferKind, number>> = {}
    for (const kind of kinds) {
      const { payload, itemCount } = buildPayload(kind)
      files.push({ name: FILE_OF[kind], data: Buffer.from(JSON.stringify(payload, null, 2), 'utf8') })
      counts[kind] = itemCount
    }
    if (files.length === 0) throw new Error('没有选择要导出的数据')
    await writeFile(filePath, createZip(files))
    return counts
  }

  /** 解析导入包：内容留在主进程，只把摘要（bundleId + 各文件条目数）给渲染端 */
  async parseFile(filePath: string): Promise<{ bundleId: string; entries: TransferEntry[] }> {
    const files = readZip(await readFile(filePath))
    const payloads: Array<{ kind: TransferKind; payload: TransferPayload }> = []
    const entries: TransferEntry[] = []
    for (const f of files) {
      if (!KIND_OF[basename(f.name)]) continue // 目录项 / 无关文件一律忽略
      const { kind, payload } = parsePayload(f.name, f.data)
      payloads.push({ kind, payload })
      entries.push({
        kind,
        file: basename(f.name),
        itemCount: Array.isArray(payload.items) ? payload.items.length : 0,
        groupCount: Array.isArray(payload.groups) ? payload.groups.length : 0
      })
    }
    if (entries.length === 0) throw new Error('压缩包里没有可导入的数据（需要 hosts.json / notes.json / api.json）')
    const bundleId = randomUUID()
    this.bundles.set(bundleId, { payloads })
    return { bundleId, entries }
  }

  /** 取解析结果（内部用） */
  private take(bundleId: string): Bundle {
    const bundle = this.bundles.get(bundleId)
    if (!bundle) throw new Error('导入包已失效，请重新选择文件')
    return bundle
  }

  /** 丢弃解析结果（取消 / 完成后调用，避免常驻内存） */
  drop(bundleId: string): void {
    this.bundles.delete(bundleId)
  }

  /**
   * 执行导入：按 id upsert，先分组后条目。
   * 返回各类型「新增 / 更新」的条数（分组不计入）。
   */
  apply(
    bundleId: string,
    kinds: TransferKind[]
  ): {
    added: Partial<Record<TransferKind, number>>
    updated: Partial<Record<TransferKind, number>>
  } {
    const bundle = this.take(bundleId)
    const added: Partial<Record<TransferKind, number>> = {}
    const updated: Partial<Record<TransferKind, number>> = {}
    const wanted = new Set(kinds)

    for (const { kind, payload } of bundle.payloads) {
      if (!wanted.has(kind)) continue
      // 分组先落地：条目里的 groupId 才指得到
      const groupIds = new Set<string>()
      for (const raw of payload.groups) {
        const g = raw as { id?: string; name?: string }
        if (typeof g?.id !== 'string' || !g.id || typeof g.name !== 'string') continue
        groupIds.add(g.id)
        this.saveGroup(kind, { id: g.id, name: g.name })
      }

      const existing = this.existingIds(kind)
      for (const raw of payload.items) {
        const item = pickItem(kind, raw)
        if (!item) continue
        const id = String(item.id)
        // 分组没跟着一起导入（或文件里没有）时清掉悬挂引用：界面会按「未分组」处理
        if (kind !== 'hosts' && typeof item.groupId === 'string' && !groupIds.has(item.groupId)) {
          if (!this.groupExists(kind, item.groupId)) item.groupId = undefined
        }
        this.saveItem(kind, item)
        if (existing.has(id)) updated[kind] = (updated[kind] ?? 0) + 1
        else added[kind] = (added[kind] ?? 0) + 1
      }
    }

    this.drop(bundleId)
    return { added, updated }
  }

  // ---------- 以下按类型分发到 storage 的 upsert ----------

  private saveGroup(kind: TransferKind, input: { id: string; name: string }): void {
    if (kind === 'hosts') storage.saveSshGroup(input)
    else if (kind === 'notes') storage.saveNoteGroup(input)
    else storage.saveApiGroup(input)
  }

  private groupExists(kind: TransferKind, id: string): boolean {
    if (kind === 'notes') return storage.listNoteGroups().some((g: NoteGroup) => g.id === id)
    if (kind === 'api') return storage.listApiGroups().some((g: ApiGroup) => g.id === id)
    return storage.listSshGroups().some((g: SshGroup) => g.id === id)
  }

  private existingIds(kind: TransferKind): Set<string> {
    if (kind === 'hosts') return new Set(storage.listSshProfiles().map((p) => p.id))
    if (kind === 'notes') return new Set(storage.listNotes().map((n) => n.id))
    return new Set(storage.listApiRequests().map((r) => r.id))
  }

  private saveItem(kind: TransferKind, item: Record<string, unknown>): void {
    // 各类型的 upsert 都自己补 createdAt / updatedAt，这里只保证字段是可移植的那几个
    if (kind === 'hosts') storage.saveSshProfile(item as unknown as SshProfile)
    else if (kind === 'notes') storage.saveNote(item as unknown as NoteEntry)
    else storage.saveApiRequest(item as unknown as ApiRequestEntry)
  }
}

export const transferService = new TransferService()
