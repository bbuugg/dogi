/**
 * 工作区路径安全与忽略规则。
 *
 * 安全约束：Agent 的一切文件操作都必须落在工作区根目录之内 ——
 * resolveInside 统一做「解析 + 越界检查」，任何工具入口都从这里拿绝对路径。
 *
 * 忽略规则：默认跳过构建产物 / 依赖目录 / 编辑器配置等，另读取 .gitignore
 * 追加规则（支持 ! 取反、尾 / 目录限定、首 / 锚定、* 与 ** 通配）。
 */
import { promises as fs } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 列表 / 搜索默认跳过的目录名（任意层级命中即跳过整棵子树） */
export const DEFAULT_IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
  'dist',
  'out',
  'build',
  'release',
  '.trae',
  '.workbuddy-ai',
  '.codeartsdoer',
  '.idea',
  '.vscode',
  '.next',
  '.nuxt',
  'coverage',
  'venv',
  '.venv',
  '__pycache__',
  'target',
  '.mypy_cache',
  '.ruff_cache',
  '.pytest_cache',
  'vendor',
  // Dogi 的工作区配置目录（快捷功能等，见 src/shared/workspace-config.ts）：
  // 它属于本地环境数据、不是项目代码，列表 / 搜索 / 文件树都跳过
  '.dogi'
])

export interface IgnoreRule {
  negate: boolean
  dirOnly: boolean
  anchored: boolean
  segments: string[]
}

/** 把相对工作区的路径解析为绝对路径，越界（.. / 盘符绝对路径）直接抛错 */
export function resolveInside(root: string, p: string): string {
  const abs = resolve(root, p)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越界（不允许访问工作区之外）：${p}`)
  }
  return abs
}

/** 解析 .gitignore 文本为规则列表（行级注释 / 空行忽略） */
export function parseGitignore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of content.split('\n')) {
    let line = raw.trimEnd()
    if (!line || line.startsWith('#')) continue
    let negate = false
    if (line.startsWith('!')) {
      negate = true
      line = line.slice(1)
    }
    let dirOnly = false
    if (line.endsWith('/')) {
      dirOnly = true
      line = line.slice(0, -1)
    }
    let anchored = false
    if (line.startsWith('/')) {
      anchored = true
      line = line.slice(1)
    }
    line = line.trim()
    if (!line) continue
    rules.push({ negate, dirOnly, anchored, segments: line.split('/').filter(Boolean) })
  }
  return rules
}

/** 单个路径段与规则段的通配匹配（* 与 ?，不支持字符类） */
function segMatch(pattern: string, seg: string): boolean {
  if (pattern === '*') return true
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`).test(seg)
}

/** 规则段从 path[start] 开始顺序匹配 */
function matchAt(rule: string[], path: string[], start: number): boolean {
  if (rule.length === 0) return start === path.length
  const r = rule[0]
  if (r === '**') {
    for (let i = start; i <= path.length; i++) {
      if (matchAt(rule.slice(1), path, i)) return true
    }
    return false
  }
  if (start >= path.length) return false
  if (segMatch(r, path[start])) return matchAt(rule.slice(1), path, start + 1)
  return false
}

/** 规则是否命中路径：锚定规则从头匹配，非锚定可在任意位置开始 */
function matchSegments(rule: string[], path: string[], anchored: boolean): boolean {
  if (anchored) return matchAt(rule, path, 0)
  for (let i = 0; i <= path.length; i++) {
    if (matchAt(rule, path, i)) return true
  }
  return false
}

const gitignoreCache = new Map<string, IgnoreRule[]>()

/** 加载工作区的 .gitignore（进程内缓存，避免每次工具调用都读盘） */
export async function loadIgnoreRules(root: string): Promise<IgnoreRule[]> {
  const cached = gitignoreCache.get(root)
  if (cached) return cached
  let rules: IgnoreRule[] = []
  try {
    rules = parseGitignore(await fs.readFile(join(root, '.gitignore'), 'utf8'))
  } catch {
    // 无 .gitignore：保持默认规则
  }
  gitignoreCache.set(root, rules)
  return rules
}

/**
 * 创建忽略判定函数。relPath 用 '/' 分隔（相对工作区根）；
 * 判定时对路径的每个前缀逐段检查（目录命中即整棵子树被忽略），
 * 后匹配的规则胜出（支持 ! 重新纳入）。
 */
export async function createIgnoreChecker(
  root: string
): Promise<(rel: string, isDir: boolean) => boolean> {
  const rules = await loadIgnoreRules(root)
  return (rel, isDir) => {
    const segs = rel.split('/').filter(Boolean)
    if (segs.length === 0) return false
    let ignored = false
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]
      const isDirPart = i < segs.length - 1 || isDir
      if (DEFAULT_IGNORE_DIRS.has(seg) && isDirPart) return true
      const prefix = segs.slice(0, i + 1)
      for (const rule of rules) {
        if (rule.dirOnly && !isDirPart) continue
        if (matchSegments(rule.segments, prefix, rule.anchored)) ignored = !rule.negate
      }
    }
    return ignored
  }
}

/** 规范化相对路径展示（统一 '/' 分隔） */
export function relPathOf(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/')
}
