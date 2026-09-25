/**
 * 技能发现（Agent Skills 约定：一个目录 + 目录里的 `SKILL.md`）。
 *
 * 为什么自己做一层：AI SDK 的原生技能只有官方 Anthropic / OpenAI 才有，而且形态是
 * 「把技能包上传到厂商 → 在托管沙箱里跑」（Anthropic 要 code execution + beta 头，
 * OpenAI 走 container/shell 工具）。本项目大量用 openai-compatible 兼容网关（chat
 * completions），那条路上没有任何原生技能支持；而且用户要的是「自动发现本地技能」。
 *
 * 所以这里按 Anthropic Agent Skills 的**文件约定**自行发现，`SKILL.md` 的
 * frontmatter（name / description）就是给模型看的「技能目录」：
 * 系统提示词里只列名称与描述（省 token），模型判断相关时再用 `read_skill` 工具
 * 把 SKILL.md 正文读进来 —— 即渐进式披露，不依赖任何 provider 特性。
 *
 * 磁盘是唯一真源：这里只扫描，不落库；用户的选择（启停 / 额外目录）记在
 * electron-store 的 `skillSettings` 里（见 storage.ts）。
 */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { WORKSPACE_CONFIG_DIR } from '@shared/workspace-config'
import type {
  SkillInfo,
  SkillListResult,
  SkillRootInfo,
  SkillSettings,
  SkillSource
} from '@shared/types'
import { storage } from '../storage'

/** 技能清单文件名（Agent Skills 约定，大小写敏感） */
export const SKILL_FILE = 'SKILL.md'
/** SKILL.md 的读取上限（超出就当不是技能清单，避免把大文件读进内存） */
const MAX_SKILL_DOC_BYTES = 512 * 1024
/** 描述截断长度（进提示词的东西要克制，正文才是给模型细读的） */
const MAX_DESCRIPTION = 400
/** 单个来源下最多发现多少个技能（防御性上限） */
const MAX_SKILLS_PER_ROOT = 200

interface SkillRoot {
  source: SkillSource
  dir: string
}

/** 用户级技能目录（不存在时由本模块创建，方便用户直接往里放技能） */
export function userSkillsDir(): string {
  return join(homedir(), '.dogi', 'skills')
}

/**
 * 跨智能体共享的技能目录 `~/.agents/skills`。
 *
 * 这是 skills CLI（vercel-labs）以及一批 agent（codex / cursor / claude-code / opencode /
 * trae…）共用的安装位置，技能同样是「目录 + SKILL.md」。**只读不建**：这个目录属于
 * 那套工具链，我们不去凭空创建它。
 */
export function agentsSkillsDir(): string {
  return join(homedir(), '.agents', 'skills')
}

/** 工作区级技能目录（跟项目走，位于隐藏配置目录内） */
export function workspaceSkillsDir(workspacePath: string): string {
  return join(workspacePath, WORKSPACE_CONFIG_DIR, 'skills')
}

/**
 * 技能根目录列表，顺序即优先级：
 * 工作区 > 用户级 > agents 共享目录 > Claude 兼容目录 > 用户手动添加的目录。
 */
function skillRoots(workspacePath?: string): SkillRoot[] {
  const roots: SkillRoot[] = []
  if (workspacePath) roots.push({ source: 'workspace', dir: workspaceSkillsDir(workspacePath) })
  roots.push({ source: 'user', dir: userSkillsDir() })
  roots.push({ source: 'agents', dir: agentsSkillsDir() })
  roots.push({ source: 'claude', dir: join(homedir(), '.claude', 'skills') })
  for (const dir of storage.getSkillSettings().extraDirs) roots.push({ source: 'custom', dir })
  return roots
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory()
  } catch {
    return false
  }
}

function stripQuotes(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1).trim()
  }
  return v
}

/**
 * 解析 SKILL.md：`---` 包裹的 frontmatter（取 name / description）+ 正文。
 *
 * 只认单行 `key: value`（够用；多行 YAML 块交给模型读正文去理解）。
 * 没有 frontmatter 也不算错 —— 名称退回目录名，描述退回正文首段。
 */
export function parseSkillDoc(text: string): { name?: string; description?: string; body: string } {
  // BOM 会让开头的 `---` 匹配不上，先去掉
  const src = text.replace(/^\uFEFF/, '')
  const lines = src.split('\n')
  if (lines[0]?.trim() !== '---') return { body: src }

  const end = lines.findIndex((l, i) => i > 0 && (l.trim() === '---' || l.trim() === '...'))
  if (end === -1) return { body: src }

  const meta: Record<string, string> = {}
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (m && m[1]) meta[m[1].toLowerCase()] = stripQuotes(m[2])
  }
  return {
    name: meta.name || undefined,
    description: meta.description || undefined,
    body: lines.slice(end + 1).join('\n').trim()
  }
}

/** 正文里第一段有意义的文字（拿它当没有 frontmatter 时的描述） */
function firstParagraph(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('```')) continue
    return line.replace(/^[-*+]\s+/, '').trim()
  }
  return ''
}

function truncate(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}

/** 读取一个技能目录；目录里没有可用的 SKILL.md 时返回 null（当它不是技能） */
async function readSkillDir(
  dir: string,
  source: SkillSource,
  root: string
): Promise<SkillInfo | null> {
  const file = join(dir, SKILL_FILE)
  let text: string
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > MAX_SKILL_DOC_BYTES) return null
    text = await fs.readFile(file, 'utf8')
  } catch {
    return null
  }

  const { name, description, body } = parseSkillDoc(text)
  const fallback = firstParagraph(body)
  return {
    id: normalizePath(file),
    name: (name || basename(dir)).trim(),
    description: truncate(description || fallback || '（该技能没有写描述）', MAX_DESCRIPTION),
    dir: resolve(dir),
    file: resolve(file),
    source,
    root: resolve(root)
  }
}

/** 路径规范化：统一分隔符 + Windows 下大小写不敏感（去重靠它） */
function normalizePath(path: string): string {
  const abs = resolve(path)
  return sep === '\\' ? abs.toLowerCase() : abs
}

/**
 * 扫描一个技能根目录，把发现的技能推进 out。
 *
 * 支持两种摆放方式：根目录下每个子目录一个技能（常见形态），
 * 或者根目录本身就是某个技能（用户直接把某个技能目录加进来）。
 */
async function scanRoot(root: SkillRoot, seen: Set<string>, out: SkillInfo[]): Promise<void> {
  const push = (skill: SkillInfo | null): void => {
    if (!skill) return
    const key = normalizePath(skill.dir)
    if (seen.has(key)) return
    seen.add(key)
    out.push(skill)
  }

  // 根目录本身就可能是技能（把某个技能目录直接加了进来）。
  // 这里**不做前置判断**：readSkillDir 自己会 stat SKILL.md，没有就返回 null ——
  // 之前写成 `isDir(join(root, 'SKILL.md'))` 是永假的（SKILL.md 是文件不是目录），
  // 这条分支从来没生效过。
  push(await readSkillDir(root.dir, root.source, root.dir))

  const entries = await fs
    .readdir(root.dir, { withFileTypes: true })
    .catch(() => null as null)
  if (!entries) return
  const before = out.length
  for (const ent of entries) {
    if (out.length - before >= MAX_SKILLS_PER_ROOT) break
    // 隐藏目录不是技能（.git / .system 之类），点号开头的技能目录很少见，统一跳过
    if (ent.name.startsWith('.')) continue
    const dir = join(root.dir, ent.name)
    // ⚠️ 软链接与 Windows 目录联接（junction）的 `Dirent.isDirectory()` 恒为 false，
    // 而「别人用 skills CLI 装的技能」常常就是这么挂进来的（本机实测：`~/.agents/skills/superpowers`
    // 就是个 junction）。所以非目录时要补一次 stat（跟随链接；断链会抛错 → isDir 返回 false，跳过）。
    if (!ent.isDirectory() && !(await isDir(dir))) continue
    push(await readSkillDir(dir, root.source, root.dir))
  }
}

/** 扫描全部根目录：返回技能列表 + 各根目录的扫描情况 */
export async function discoverSkills(
  workspacePath?: string
): Promise<{ skills: SkillInfo[]; roots: SkillRootInfo[] }> {
  // 用户级目录不存在就先建出来：设置页的「打开技能目录」需要一个真实存在的目标，
  // 用户也才有地方放技能（这是本应用自己的目录，创建它是预期行为）
  await fs.mkdir(userSkillsDir(), { recursive: true }).catch(() => undefined)

  const seen = new Set<string>()
  const skills: SkillInfo[] = []
  const roots: SkillRootInfo[] = []
  for (const root of skillRoots(workspacePath)) {
    const exists = await isDir(root.dir)
    const before = skills.length
    if (exists) await scanRoot(root, seen, skills)
    roots.push({ source: root.source, dir: root.dir, exists, count: skills.length - before })
  }
  return { skills, roots }
}

/** 技能列表 + 各根目录 + 用户设置（设置页一次拿全） */
export async function listSkills(workspacePath?: string): Promise<SkillListResult> {
  const { skills, roots } = await discoverSkills(workspacePath)
  return { skills, roots, settings: storage.getSkillSettings() }
}

/** 过滤掉被用户停用的技能（磁盘上找不到的 disabled 项不报错，忽略即可） */
export function filterEnabled(skills: SkillInfo[], settings: SkillSettings): SkillInfo[] {
  if (settings.disabled.length === 0) return skills
  const disabled = new Set(settings.disabled)
  return skills.filter((s) => !disabled.has(s.id))
}

/** 供 Agent 使用：当前工作区下、未被停用的技能 */
export async function skillsForAgent(workspacePath: string): Promise<SkillInfo[]> {
  const { skills } = await discoverSkills(workspacePath)
  return filterEnabled(skills, storage.getSkillSettings())
}
