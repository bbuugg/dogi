/**
 * 项目约束文档（`AGENTS.md`）。
 *
 * 移植自 fishwork 的 `packages/agent/src/project-doc.ts`。
 *
 * 约定（AGENTS.md 生态，与 Claude Code 的 `CLAUDE.md` 同源）：项目维护者在仓库根目录
 * 放一份 Markdown，写明**这个项目自己的规则** —— 构建命令、验证方式、代码约定、
 * 禁止事项、踩过的坑。它是写给 AI 看的，agent 每轮都该把它当最高优先级的约束。
 *
 * 为什么**全文注入**，而不是「给个路径让模型自己 read_file」：
 * 约束要在模型**动手之前**就生效。等它想起来去读时，第一版改动往往已经写歪了。
 * 渐进式披露（先给清单、正文按需加载）适合「技能」这种按任务触发的东西，
 * 不适合「全程适用的规则」—— 规则必须一直在场。
 *
 * 为什么只读**工作区根目录**、不向上找父目录：
 * 工作区就是用户选定的项目根，语义明确；向上递归会在 monorepo 里把无关的父级文档
 * 一起吸进来，反而稀释了真正的项目约束。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/** 依次尝试的文件名：AGENTS.md 为主，CLAUDE.md 作兼容回落 */
export const PROJECT_DOC_NAMES = ['AGENTS.md', 'CLAUDE.md'] as const

/**
 * 注入提示词的字符上限（超出按章节边界截断）。
 *
 * 取 64K 是个折中：正常的 AGENTS.md 在几千到两三万字符，全文进得去；
 * 而特别长的那份（几万字符）全量注入会让每轮请求都很贵、还可能把长会话顶出
 * 上下文窗口 —— 截断后由模型按需 `read_file` 补全更划算。
 */
const MAX_PROJECT_DOC_CHARS = 64 * 1024

/** 超过这个大小就不读了：防的是被误命名成 AGENTS.md 的巨型文件（正常文档不会有这么大） */
const MAX_READ_BYTES = 4 * 1024 * 1024

/** 工作区根目录里的一份项目约束文档 */
export interface ProjectDoc {
  /** 绝对路径（截断提示里要告诉模型去哪读全文） */
  file: string
  /** 文件名（AGENTS.md / CLAUDE.md） */
  name: string
  /** 正文，可能已截断 */
  text: string
  /** 是否被截断 */
  truncated: boolean
  /** 截断处的章节标题（按 `## ` 边界截断时能拿到） */
  section?: string
  /** 文档总字符数（截断提示里说明「给了多少」） */
  totalChars: number
}

/**
 * 按「二级标题」边界截断：宁可少给一条完整规则，也不要把一条规则切成半句话
 * （半句话比没有更糟 —— 模型会拿它当完整规则执行）。
 *
 * 最后一个 `## ` 位置太靠前（不足上限一半）说明这份文档不是按二级标题分节的，
 * 那就硬截 —— 否则可能只注入一个标题就结束了。
 */
function truncateAtSection(text: string, max: number): { text: string; section?: string } {
  if (text.length <= max) return { text }
  const head = text.slice(0, max)
  const cut = head.lastIndexOf('\n## ')
  if (cut < max / 2) return { text: head }
  const line = head.slice(cut + 1).split('\n', 1)[0] ?? ''
  const section = line.replace(/^#+\s*/, '').trim()
  return { text: head.slice(0, cut), ...(section ? { section } : {}) }
}

/**
 * 读工作区根目录的项目约束文档；没有（或读不了）返回 null。
 *
 * 每轮对话现读一次（与技能扫描同样的做法）：用户改完 AGENTS.md，**下一轮就生效**，
 * 不需要重启也不需要缓存失效逻辑。几十 KB 的读盘代价可以忽略。
 */
export async function readProjectDoc(workspacePath: string): Promise<ProjectDoc | null> {
  if (!workspacePath) return null
  for (const name of PROJECT_DOC_NAMES) {
    const file = join(workspacePath, name)
    let size: number
    try {
      const stat = await fs.stat(file)
      if (!stat.isFile()) continue
      size = stat.size
    } catch {
      // 不存在（ENOENT）/ 没权限：试下一个名字
      continue
    }
    if (size === 0 || size > MAX_READ_BYTES) continue

    let raw: string
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    // BOM 会让模型把开头的 `#` 也当成内容读进去
    const text = raw.replace(/^\uFEFF/, '').trim()
    if (!text) continue

    const { text: body, section } = truncateAtSection(text, MAX_PROJECT_DOC_CHARS)
    return {
      file,
      name,
      text: body,
      truncated: body.length < text.length,
      ...(section ? { section } : {}),
      totalChars: text.length
    }
  }
  return null
}

/**
 * 项目约束文档的提示词段落。
 *
 * 措辞上刻意做三件事：① 说明**优先级高于本提示词里其它通用约定**（否则模型会把它当
 * 参考资料，遇到冲突仍按通用习惯走）；② 要求**动手前先读完**（而不是「需要时参考」）；
 * ③ 声明**不要擅自修改**（它是项目维护者的文档，不是 agent 的产出物）。
 */
export function buildProjectDocSection(doc: ProjectDoc): string {
  const lines = [
    `项目约束文档：\`${doc.name}\`（${doc.file}）`,
    '这是**这个项目的维护者写给 AI 的规则**（构建与验证方式、代码约定、禁止事项、踩过的坑）。',
    '它的优先级高于本提示词里其它一切通用约定 —— 与之冲突时以它为准；动手前先完整读一遍。',
    '除非用户明确要求，不要修改这个文件。',
    '',
    '<project-doc>',
    doc.text,
    '</project-doc>'
  ]
  if (doc.truncated) {
    const percent = Math.round((doc.text.length / doc.totalChars) * 100)
    lines.push(
      `⚠️ 该文档过长（共 ${doc.totalChars} 字符），以上只是前 ${percent}%` +
        (doc.section ? `（截至「${doc.section}」）` : '') +
        `。若这次任务可能涉及后面的章节，先用 read_file 读 ${doc.file} 补全，别凭猜测动手。`
    )
  }
  return lines.join('\n')
}