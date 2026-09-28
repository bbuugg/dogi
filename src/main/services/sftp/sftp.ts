/**
 * 主进程 SFTP 服务：远程文件浏览 / 上传 / 下载 / 管理。
 *
 * 凭据复用 SSH 主机配置（storage.getSshProfile 只在主进程返回解密后的密钥，
 * 渲染端永远拿不到），连接统一走 services/ssh/connect（跳板链 / 主机指纹校验）。
 * 连接由渲染端生成 connId 主动开启（每个「文件管理」标签一个连接），
 * 标签关闭时调 close；远端断开 / 出错时通过 'closed' 事件通知渲染端。
 *
 * 传输进度经 'progress' 事件交由 IPC 层广播；对话框（另存为 / 选择文件）
 * 属于 UI 交互，放在 IPC 层而不是本服务。
 */
import { Client, type SFTPWrapper, type Stats } from 'ssh2'
import { EventEmitter } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir as mkdirLocal, readdir, stat as statLocal } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { storage } from '../storage'
import { connectWithJumps } from '../ssh/connect'
import { hostLogger } from '../log/logger'
import { joinSftpPath, normalizeSftpPath } from '@shared/sftp-path'
import type { SftpEntry } from '@shared/types'

/** 传输被用户主动取消（调用方据此区分「失败」与「取消」，不要把取消当错误提示） */
export class TransferCancelledError extends Error {
  constructor() {
    super('已取消上传')
    this.name = 'TransferCancelledError'
  }
}

export function isTransferCancelled(err: unknown): boolean {
  return err instanceof TransferCancelledError
}

interface SftpConn {
  connId: string
  profileId: string
  title: string
  conn: Client
  sftp: SFTPWrapper
}

/** 回调风格的 SFTP 单步操作统一包成 Promise */
function call<T>(fn: (cb: (err: Error | undefined, result: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((err, result) => (err ? reject(err) : resolve(result)))
  })
}

/** 转发进度事件的载荷（SftpTransferProgress 在 @shared/types） */
export type SftpProgressPayload = {
  connId: string
  transferId: string
  kind: 'upload' | 'download' | 'copy' | 'move'
  name: string
  bytes: number
  total: number
  localPath?: string
  done?: boolean
  canceled?: boolean
  error?: string
}

class SftpService extends EventEmitter {
  private conns = new Map<string, SftpConn>()
  /** transferId 计数器（拼时间戳保证跨重启也不太可能重复） */
  private transferSeq = 0
  /**
   * 进行中的传输（transferId → 取消函数）。
   * 上传走「读流 → SFTP 写流」自建管道而不是 fastPut，就是为了能随时销毁两侧流；
   * 渲染端进度条上的「取消」按 transferId 调 abortTransfer。
   */
  private transfers = new Map<string, () => void>()

  /** 取消一笔进行中的传输；不存在（已结束）时静默忽略 */
  abortTransfer(transferId: string): void {
    this.transfers.get(transferId)?.()
  }

  /** 该 connId 是否已有连接（渲染端重开同一标签时避免重复建连） */
  has(connId: string): boolean {
    return this.conns.has(connId)
  }

  /**
   * 建立到主机的 SFTP 连接。resolve 即代表连接与 SFTP 通道都就绪；
   * 失败抛错（认证失败 / 超时等），由调用方提示。
   */
  async open(connId: string, profileId: string): Promise<void> {
    if (this.conns.has(connId)) return
    const profile = storage.getSshProfile(profileId)
    if (!profile) {
      hostLogger.error('sftp', `连接失败：主机配置不存在（${profileId}）`)
      throw new Error(`主机配置不存在: ${profileId}`)
    }
    if (profile.kind !== 'ssh') {
      hostLogger.error('sftp', `连接失败：本地主机不支持 SFTP 文件管理（${profile.username}@${profile.host}）`)
      throw new Error('本地主机不支持 SFTP 文件管理')
    }

    const title = `${profile.username}@${profile.host}`
    let conn: Client
    let sftp: SFTPWrapper
    try {
      // 统一连接层：跳板链与主机指纹校验都在里面，失败信息已带跳板上下文
      const connected = await connectWithJumps(profile, { purpose: 'sftp' })
      conn = connected.client
      // 连接就绪后只剩「开 SFTP 通道」一步；仍留兜底计时，防极端情况下永不回调
      sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          connected.dispose()
          reject(new Error('SFTP 通道打开超时'))
        }, 20000)
        /** 失败统一收尾：断开连接并 reject（成功路径不经这里） */
        const abort = (err: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          connected.dispose()
          reject(err)
        }
        conn.on('error', (err) => abort(err))
        conn.on('close', () => abort(new Error('连接在建立 SFTP 通道前关闭')))
        conn.sftp((err, s) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (err || !s) {
            connected.dispose()
            reject(err ?? new Error('无法打开 SFTP 通道'))
            return
          }
          resolve(s)
        })
      })
    } catch (err) {
      hostLogger.error(
        'sftp',
        `连接失败（${title}）：${err instanceof Error ? err.message : String(err)}`
      )
      throw err
    }

    const entry: SftpConn = { connId, profileId, title, conn, sftp }
    this.conns.set(connId, entry)
    // 就绪后的断开 / 出错：清掉连接并广播（Promise 阶段挂的 error 监听此时 reject 已是 no-op）
    conn.on('error', () => this.drop(connId))
    conn.on('close', () => this.drop(connId))
    hostLogger.info('sftp', `已连接 ${title}`)
  }

  /** 标题（user@host），供进度提示 / 界面展示 */
  titleOf(connId: string): string {
    return this.conns.get(connId)?.title ?? ''
  }

  private must(connId: string): SftpConn {
    const entry = this.conns.get(connId)
    if (!entry) throw new Error('SFTP 连接已断开，请关闭标签后重新打开')
    return entry
  }

  /** 列目录（文件在前无所谓，排序交给调用方；这里目录优先、按名排序） */
  async list(connId: string, rawPath: string): Promise<SftpEntry[]> {
    const { sftp } = this.must(connId)
    // 归一化：用户手输的 `//data`、`/data/` 都要变成 `/data`，否则路径栏会显示成双斜杠
    const path = normalizeSftpPath(rawPath)
    const raw = await call<Array<{ filename: string; longname: string }>>((cb) =>
      sftp.readdir(path, cb as never)
    )
    const entries = await Promise.all(
      raw.map(async (item) => {
        const full = joinSftpPath(path, item.filename)
        try {
          const st = await call<Stats>((cb) => sftp.lstat(full, cb as never))
          return {
            name: item.filename,
            path: full,
            isDir: st.isDirectory(),
            size: st.isDirectory() ? 0 : Number(st.size) || 0,
            mtime: st.mtime ? new Date(st.mtime).getTime() : 0
          }
        } catch {
          // 个别条目 stat 失败（软链接悬空等）不拖垮整个列表
          return { name: item.filename, path: full, isDir: false, size: 0, mtime: 0 }
        }
      })
    )
    return entries.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
    )
  }

  async mkdir(connId: string, path: string): Promise<void> {
    const { sftp } = this.must(connId)
    await call<void>((cb) => sftp.mkdir(normalizeSftpPath(path), cb as never))
  }

  /**
   * 解析远端路径为标准绝对路径（SFTP realpath）。
   * 用于兜底：win32-openssh 的默认目录不是 `/` 而是形如 `/C:/Users/xxx` 的
   * 盘符风格路径，渲染端初始以 `/` 列表失败时改用它拿准起始目录。
   * 传 `.` 表示由服务端解析默认工作目录；失败原样抛错（由调用方决定是否降级）。
   */
  async realpath(connId: string, rawPath: string): Promise<string> {
    const { sftp } = this.must(connId)
    const path = rawPath.trim() || '.'
    return call<string>((cb) => sftp.realpath(path, cb as never))
  }

  async rename(connId: string, from: string, to: string): Promise<void> {
    const { sftp } = this.must(connId)
    await call<void>((cb) => sftp.rename(normalizeSftpPath(from), normalizeSftpPath(to), cb as never))
  }

  /** 删除文件或目录（目录递归删除，等价 rm -rf） */
  async remove(connId: string, path: string): Promise<void> {
    const { sftp } = this.must(connId)
    await this.removeEntry(sftp, normalizeSftpPath(path))
  }

  private async removeEntry(sftp: SFTPWrapper, path: string): Promise<void> {
    const st = await call<Stats>((cb) => sftp.lstat(path, cb as never))
    if (st.isDirectory()) {
      const list = await call<Array<{ filename: string }>>((cb) => sftp.readdir(path, cb as never))
      for (const item of list) {
        await this.removeEntry(sftp, joinSftpPath(path, item.filename))
      }
      await call<void>((cb) => sftp.rmdir(path, cb as never))
    } else {
      await call<void>((cb) => sftp.unlink(path, cb as never))
    }
  }

  /**
   * 流「读 → 写」通用管道：累加已传字节并推送进度，注册可取消函数。
   * 读/写任意一侧可以是本地流或 SFTP 流（上传 / 下载 / 远端复制都复用它）。
   * resolve 时返回最终已传字节数（供调用方 emit 结束进度）。
   * localPath 只对「有本地参与」的传输（上传 / 下载）有值：每一条进度都带上它，
   * 渲染端 store 每次都是整条覆盖，不能指望只在结束事件里带。
   */
  private pump(
    read: Readable,
    write: Writable,
    transferId: string,
    connId: string,
    name: string,
    kind: 'upload' | 'download' | 'copy' | 'move',
    total: number,
    localPath?: string
  ): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let bytes = 0
      let settled = false
      const emit = (patch: Partial<SftpProgressPayload>): void => {
        this.emit('progress', {
          connId,
          transferId,
          kind,
          name,
          localPath,
          bytes,
          total,
          ...patch
        } satisfies SftpProgressPayload)
      }
      const finish = (err?: Error): void => {
        if (settled) return
        settled = true
        this.transfers.delete(transferId)
        if (err) {
          read.destroy()
          write.destroy()
          reject(err)
          return
        }
        resolve(bytes)
      }
      // 先发一条 0 字节初始进度，让渲染端立刻拿到 transferId 显示「取消」按钮
      this.transfers.set(transferId, () => finish(new TransferCancelledError()))
      emit({ bytes: 0, total })
      read.on('data', (chunk: Buffer | string) => {
        bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
        emit({ bytes, total })
      })
      read.on('error', (err: Error) => finish(err))
      write.on('error', (err: Error) => finish(err))
      write.on('finish', () => finish())
      write.on('close', () => finish())
      read.pipe(write)
    })
  }

  /**
   * 下载单个远端文件到本地路径（localPath 由 IPC 层的另存为对话框决定）。
   * 用「SFTP 读流 → 本地写流」自建管道（不是 fastGet），以便支持取消；
   * 进度经 'progress' 事件推送，lstat 取不到大小时 total 为 0（只展示已传字节）。
   */
  async downloadTo(connId: string, remotePath: string, localPath: string): Promise<void> {
    const { sftp } = this.must(connId)
    const transferId = `dl-${Date.now().toString(36)}-${++this.transferSeq}`
    const name = remotePath.split('/').pop() || remotePath
    const st = await call<Stats>((cb) => sftp.lstat(remotePath, cb as never)).catch(() => null)
    const total = st ? Number(st.size) || 0 : 0
    const read = sftp.createReadStream(remotePath)
    const write = createWriteStream(localPath)
    try {
      const bytes = await this.pump(read, write, transferId, connId, name, 'download', total, localPath)
      this.emit('progress', { connId, transferId, kind: 'download', name, localPath, bytes, total, done: true })
    } catch (e) {
      const canceled = isTransferCancelled(e)
      this.emit('progress', {
        connId,
        transferId,
        kind: 'download',
        name,
        localPath,
        bytes: 0,
        total,
        // 用户手动取消：按「已取消」展示（不显示红色错误、不提供打开文件位置）
        done: canceled,
        canceled: canceled || undefined,
        error: canceled ? undefined : e instanceof Error ? e.message : String(e)
      })
      throw e
    }
  }

  /**
   * 递归下载整个远端目录到本地目录（localDir 由 IPC 层的选择目录对话框决定）。
   * 目录内的每个文件作为一笔独立传输（各自一个 transferId），文件夹本身不计入进度。
   */
  async downloadDir(connId: string, remoteDir: string, localDir: string): Promise<void> {
    this.must(connId)
    const base = remoteDir.split('/').pop() || 'download'
    const target = join(localDir, base)
    await mkdirLocal(target, { recursive: true })
    await this.downloadTree(connId, normalizeSftpPath(remoteDir), target)
  }

  private async downloadTree(connId: string, remoteDir: string, localDir: string): Promise<void> {
    const entries = await this.list(connId, remoteDir)
    for (const entry of entries) {
      const localPath = join(localDir, entry.name)
      if (entry.isDir) {
        await mkdirLocal(localPath, { recursive: true })
        await this.downloadTree(connId, entry.path, localPath)
      } else {
        await this.downloadTo(connId, entry.path, localPath)
      }
    }
  }

  /**
   * 远端复制（ssh2 原生无 copy，自行读源写目标）。目录递归；kind 为 'copy' 时是纯复制，
   * 为 'move' 时是「移动」的复制阶段（复制完由 moveEntry 负责删源）。支持取消。
   */
  async copyEntry(
    connId: string,
    from: string,
    to: string,
    kind: 'copy' | 'move' = 'copy'
  ): Promise<void> {
    const { sftp } = this.must(connId)
    const st = await call<Stats>((cb) => sftp.lstat(normalizeSftpPath(from), cb as never))
    if (st.isDirectory()) {
      await call<void>((cb) => sftp.mkdir(normalizeSftpPath(to), cb as never))
      const list = await this.list(connId, from)
      for (const child of list) {
        await this.copyEntry(connId, child.path, joinSftpPath(to, child.name), kind)
      }
      return
    }
    const name = to.split('/').pop() || to
    const total = Number(st.size) || 0
    const transferId = `${kind === 'move' ? 'mv' : 'cp'}-${Date.now().toString(36)}-${++this.transferSeq}`
    const read = sftp.createReadStream(from)
    const write = sftp.createWriteStream(to)
    try {
      const bytes = await this.pump(read, write, transferId, connId, name, kind, total)
      this.emit('progress', { connId, transferId, kind, name, bytes, total, done: true })
    } catch (e) {
      const canceled = isTransferCancelled(e)
      this.emit('progress', {
        connId,
        transferId,
        kind,
        name,
        bytes: 0,
        total,
        done: canceled,
        canceled: canceled || undefined,
        error: canceled ? undefined : e instanceof Error ? e.message : String(e)
      })
      throw e
    }
  }

  /**
   * 移动（跨目录）：优先用服务端原子 rename（同文件系统，瞬时完成）；
   * 失败（跨文件系统）时回退为「复制 + 删除源」，复制阶段按 copy/move 推送进度。
   */
  async moveEntry(connId: string, from: string, to: string): Promise<void> {
    try {
      await this.rename(connId, from, to)
    } catch {
      await this.copyEntry(connId, from, to, 'move')
      await this.remove(connId, from)
    }
  }

  /**
   * 上传单个本地文件到远端目录（localPath 由 IPC 层的选择文件对话框决定）。
   * 多文件时 IPC 层逐个调用本方法，进度按文件分别推送。
   *
   * 用「本地读流 → SFTP 写流」自建管道（不是 fastPut）：只有这样才拿得到两侧流，
   * 用户点「取消」时能立刻销毁它们，把已写入的远端文件就地截断，而不必等整包传完。
   */
  async uploadFrom(connId: string, localPath: string, remoteDir: string): Promise<void> {
    const { sftp } = this.must(connId)
    const name = localPath.split(/[\\/]/).pop() || localPath
    const remotePath = joinSftpPath(remoteDir, name)
    const transferId = `ul-${Date.now().toString(36)}-${++this.transferSeq}`
    const emit = (patch: Partial<SftpProgressPayload>): void => {
      this.emit('progress', {
        connId,
        transferId,
        kind: 'upload',
        name,
        localPath,
        bytes: 0,
        total: 0,
        ...patch
      } satisfies SftpProgressPayload)
    }
    // 本地文件大小先读出来：进度条要按它算百分比（先发一条 0 字节的初始进度，
    // 让渲染端立刻拿到 transferId 显示「取消」按钮 —— 大文件开始传之前就能取消）
    const total = await statLocal(localPath)
      .then((s) => s.size)
      .catch(() => 0)
    emit({ bytes: 0, total })
    try {
      await new Promise<void>((resolve, reject) => {
        const read = createReadStream(localPath)
        const write = sftp.createWriteStream(remotePath)
        let bytes = 0
        let settled = false
        const finish = (err?: Error): void => {
          if (settled) return
          settled = true
          this.transfers.delete(transferId)
          if (err) {
            read.destroy()
            write.destroy()
            reject(err)
            return
          }
          resolve()
        }
        this.transfers.set(transferId, () => finish(new TransferCancelledError()))
        read.on('data', (chunk: Buffer | string) => {
          bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
          emit({ bytes, total })
        })
        read.on('error', (err: Error) => finish(err))
        write.on('error', (err: Error) => finish(err))
        // finish = 所有分片都已写入远端句柄；close = 句柄已关闭（autoClose 默认 true）。
        // 两个都当完成信号，谁先到算谁（destroy 触发的 close 由 settled 挡住，不会误判成功）
        write.on('finish', () => finish())
        write.on('close', () => finish())
        read.pipe(write)
      })
      emit({ done: true })
    } catch (e) {
      const canceled = isTransferCancelled(e)
      emit({
        done: canceled,
        canceled: canceled || undefined,
        error: canceled ? undefined : e instanceof Error ? e.message : String(e)
      })
      throw e
    }
  }

  /**
   * 递归上传整个本地目录到远端目录（remoteDir/<本地目录名>）。
   * 与 downloadDir 对称：目录本身不计进度，目录内每个文件各算一笔独立传输；
   * 远端同名目录已存在时合并（逐层建目录，存在即跳过）。任一步失败即中止
   * （已传完的文件留在远端），错误由调用方展示。
   */
  async uploadDir(connId: string, localDir: string, remoteDir: string): Promise<void> {
    const { sftp } = this.must(connId)
    const target = joinSftpPath(remoteDir, basename(localDir))
    await this.mkdirRecursive(sftp, target)
    await this.uploadTree(connId, sftp, localDir, target)
  }

  /** 递归遍历本地目录：子目录先建好远端对应目录，文件逐个走 uploadFrom（各自一笔传输） */
  private async uploadTree(
    connId: string,
    sftp: SFTPWrapper,
    localDir: string,
    remoteDir: string
  ): Promise<void> {
    const entries = await readdir(localDir, { withFileTypes: true })
    for (const entry of entries) {
      const localPath = join(localDir, entry.name)
      if (entry.isDirectory()) {
        const remote = joinSftpPath(remoteDir, entry.name)
        await this.mkdirRecursive(sftp, remote)
        await this.uploadTree(connId, sftp, localPath, remote)
      } else {
        await this.uploadFrom(connId, localPath, remoteDir)
      }
    }
  }

  /**
   * 逐层创建远端目录（SFTP 的 mkdir 不递归）。某层已存在时按「lstat 确认是目录」放行，
   * 其余失败（权限等）照常抛出 —— 别把任何错误都当成「已存在」静默吞掉。
   */
  private async mkdirRecursive(sftp: SFTPWrapper, path: string): Promise<void> {
    let current = ''
    for (const part of normalizeSftpPath(path).split('/').filter(Boolean)) {
      current = joinSftpPath(current, part)
      try {
        await call<void>((cb) => sftp.mkdir(current, cb as never))
      } catch (err) {
        const st = await call<Stats>((cb) => sftp.lstat(current, cb as never)).catch(() => null)
        if (!st?.isDirectory()) throw err
      }
    }
  }

  close(connId: string): void {
    const entry = this.conns.get(connId)
    if (!entry) return
    this.conns.delete(connId)
    try {
      entry.conn.end()
    } catch {
      // 忽略
    }
    hostLogger.info('sftp', `已关闭 ${entry.title}`)
  }

  closeAll(): void {
    for (const connId of [...this.conns.keys()]) this.close(connId)
  }

  /** 远端断开 / 出错后的统一清理（close 主动关的已先摘掉，不会走到这） */
  private drop(connId: string): void {
    const entry = this.conns.get(connId)
    if (!entry) return
    this.conns.delete(connId)
    try {
      entry.conn.end()
    } catch {
      // 忽略
    }
    hostLogger.warn('sftp', `连接已断开（${entry.title}）`)
    this.emit('closed', { connId })
  }
}

export const sftpService = new SftpService()
