/**
 * `git_read`：给 Agent 的**只读 git 视图**（移植自 fishwork 的 `packages/tools/src/git-read.ts`）。
 *
 * 为什么单独做一个窄工具，而不是让模型用 `execute_command` 跑 git：
 * - `execute_command` 既能读也能写；「只读模式 + execute_command」是个假承诺
 *   （`git checkout .` / `git reset --hard` 都能毁东西）；
 * - 白名单式的窄接口把危险面压到「四条只读命令」，且天然免疫 `-i` / `-p` 这类
 *   会挂死的交互参数；
 * - 输出统一走产物机制（见 output-artifact.ts），一条大 `git diff` 不会把上下文炸掉。
 *
 * ⚠️ 刻意**不给** checkout / add / commit / reset / push / stash：写仓库的活留给
 * `execute_command`（那里有 `guardWrite` 的确认闸）。真要做写操作窄工具时，也要照审批的
 * 规矩来，不能因为「只是 git 命令」就绕过 guardWrite。
 */
import { relative } from 'node:path'
import { z } from 'zod'
import type { AiToolDef } from './tool-registry'
import { gitRoot, runGitRead } from '../git'
import { resolveInside } from './agent-core/workspace'
import { OutputArtifactWriter } from './output-artifact'

/**
 * git ref（提交 / 分支 / tag）的允许形状。
 *
 * 第一条「不能以 `-` 开头」是防 flag 注入：ref 会原样进 `git diff <ref>`，
 * 放开的话 `--upload-pack=curl …` 这种就能变成一个参数塞进去。
 * 允许 `^` / `~` / `/`（`HEAD~2`、`origin/main`、`v1.0^2`）。空格直接拒 ——
 * 命令走参数数组、不存在 shell 拼接，但空格里塞别的东西对只读视图没有正当用途。
 */
const REF_RE = /^[A-Za-z0-9._/^~{}()[\]@,-]+$/

/** log 的最大条数：模型真的很少需要更多，且每条都要占上下文 */
const MAX_LOG_ENTRIES = 50
/** 只读输出的内联上限：超出即落产物，模型用 read_tool_output 续读 */
const GIT_OUT_INLINE_MAX = 12_000

type GitReadAction = 'status' | 'diff' | 'log' | 'show'

/** 按动作组 git 参数（不含 pathspec） */
function buildArgs(
  action: GitReadAction,
  ref: string | undefined,
  stat: boolean,
  limit: number,
  pathspec: string[]
): string[] | null {
  switch (action) {
    case 'status':
      // ⚠️ --porcelain=v2：v1 在「刚 init、还没有任何提交」时首行给的是
      // `## No commits yet on master`，按 `## ` 头解析会把那句话当成分支名
      // （GitPanel 踩过这个坑，见 AGENTS 4.30）。--branch 顺带给当前分支 / ahead-behind。
      return ['status', '--porcelain=v2', '--branch', ...pathspec]
    case 'diff':
      return [
        'diff',
        '--no-color',
        ...(stat ? ['--stat'] : []),
        ...(ref ? [ref] : []),
        // 未暂存改动是默认视图；给了 ref 就是「这个 ref 与工作区的差异」
        ...pathspec
      ]
    case 'log':
      return [
        'log',
        `-${limit}`,
        '--no-color',
        '--format=%h %ad %an %s',
        '--date=short',
        ...(ref ? [ref] : []),
        ...pathspec
      ]
    case 'show':
      if (!ref) return null
      return [
        'show',
        '--no-color',
        '--format=commit %H%nAuthor: %an%nDate: %ad%n%n    %s',
        '--date=short',
        ref,
        ...pathspec
      ]
  }
}

/** 「合法但没内容」的解释：否则模型看到空串会以为工具坏了，然后反复重试 */
function explainEmpty(action: GitReadAction): string {
  switch (action) {
    case 'status':
      return '（工作区是干净的：没有未提交的改动）'
    case 'diff':
      return '（没有差异：指定范围内工作区与 HEAD 一致）'
    case 'log':
      return '（这个范围没有提交记录）'
    case 'show':
      return '（这个提交没有可显示的内容 —— 可能是个空提交）'
  }
}

export function buildGitReadDef(): AiToolDef {
  return {
    name: 'git_read',
    scope: 'workspace',
    description:
      '只读地查看当前工作区的 git 仓库：当前改动（status）、改动内容（diff）、提交历史（log）、某个提交的内容（show）。' +
      '适合「改了什么」「最近谁动过这里」「这个提交干了什么」这类问题。' +
      '只能看，不能改仓库 —— 提交 / 回滚 / 切分支请用 execute_command（那边有确认）。' +
      '输出过长时只返回开头与结尾，并按结果里给的产物 id 用 read_tool_output 续读。',
    inputSchema: z.object({
      action: z
        .enum(['status', 'diff', 'log', 'show'])
        .describe('status=当前改动清单；diff=改动内容；log=提交历史；show=某个提交的内容'),
      ref: z
        .string()
        .optional()
        .describe('提交 / 分支 / tag，如 HEAD、HEAD~1、main、abc1234。diff 表示与谁比，show 表示看哪个提交'),
      path: z.string().optional().describe('只看某个文件 / 目录（相对工作区根）'),
      stat: z.boolean().optional().describe('diff/show 只要「改了哪些文件 + 增删行数」，不要完整内容'),
      limit: z.number().optional().describe(`log 的条数，默认 20，最大 ${MAX_LOG_ENTRIES}`)
    }),
    execute: async (rawInput, call, ctx) => {
      const {
        action,
        ref,
        path,
        stat = false,
        limit = 20
      } = rawInput as {
        action: GitReadAction
        ref?: string
        path?: string
        stat?: boolean
        limit?: number
      }
      if (!ctx.workspace?.path) throw new Error('工具调用缺少工作区绑定')
      const root = ctx.workspace.path

      // 1. 边界：先确认工作区在不在 git 仓库里，不在就直说，别让后面的报错难懂
      const repo = await gitRoot(root)
      if (!repo) {
        return '当前目录不是一个 git 仓库（也读不到 .git）。如果是未初始化的项目，请让用户先 git init。'
      }

      // 2. ref 校验（防 flag 注入）
      if (ref !== undefined && ref !== '' && (ref.startsWith('-') || /\s/.test(ref) || !REF_RE.test(ref))) {
        return `ref 不合法：${ref}\n（允许提交 / 分支 / tag，如 HEAD、HEAD~1、main、abc1234；不能以 - 开头、不能带空格）`
      }

      // 3. path 校验：越界直接拒，与其它文件工具同一道闸
      let gitPath: string | undefined
      if (path) {
        const abs = resolveInside(root, path)
        // 工作区可能是仓库的子目录：把绝对路径换算成相对 repo root 的形式
        gitPath = relative(repo, abs).replace(/\\/g, '/') || '.'
        if (gitPath.startsWith('..')) {
          return `path 超出了 git 仓库范围：${path}（工作区在此仓库的子目录之外）`
        }
      }

      // 4. 组参数：`--` 之后的都当路径，不会被误认成 ref
      const pathspec = gitPath && gitPath !== '.' ? ['--', gitPath] : []
      const cappedLimit = Math.min(Math.max(1, Math.trunc(limit)), MAX_LOG_ENTRIES)
      const args = buildArgs(action, ref, stat, cappedLimit, pathspec)
      if (args === null) return `${action} 需要 ref 参数（哪个提交？）`

      const run = await runGitRead(root, args)
      // git 失败（非仓库 / 坏 ref / 仓库损坏）也把 stderr 原样带回，别抛错打断整轮
      if (run.code !== 0) {
        return (
          `git ${action} 失败：${run.stderr.trim() || '（git 没有给出原因）'}` +
          `\n（${ref ? `ref=${ref} ` : ''}${path ? `path=${path}` : ''}）`
        )
      }
      const body = run.stdout.trim()
      // status / log 在「干净仓库 / 空历史」下合法地没输出，给一句人话而不是空串。
      // 长输出走产物机制：内联「开头 + 结尾 + 产物 id」，模型按 id 续读完整内容。
      const writer = new OutputArtifactWriter({
        conversationId: ctx.conversationId,
        toolCallId: call.toolCallId,
        inlineMax: GIT_OUT_INLINE_MAX,
        headChars: 4000
      })
      writer.append(body || explainEmpty(action))
      const result = await writer.finish()
      return result.text
    }
  }
}
