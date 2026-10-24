/**
 * @fizz/git：git 工具层，TS 源码直接导出（与 contracts / git 同一模式）。
 *
 * 两块内容：
 * - `git-panel.ts` —— 基于 simple-git 的访问层，git 路由（status / diff / branches / log / action）共用；
 * - `worktree.ts` —— 零依赖（只用 node 内置）的 worktree 辅助，服务端建删 worktree、任务提交用。
 *   它必须保持零依赖：容器 / 独立 runner（打进镜像单跑）要能单独引它，不能拖进包里其它依赖。
 */
export * from './types'
export * from './git-panel'

/*
 * worktree.ts 里也有个 `git()`（execFile 零依赖版，`(args, options)` 签名），与 git-panel.ts
 * 的 `git()`（simple-git 版，`(cwd, args)` 签名）同名不同签 —— 对两个模块同时 `export *`
 * 撞名会被 TS 静默丢弃，所以这里点名转出、只跳过 `git` 本身；要 execFile 版就从
 * 源文件 `./worktree` 直接引。
 */
export {
  gitOrThrow,
  WORKTREE_CONFIG,
  WORKTREES_DIR,
  worktreePathFor,
  isGitRepo,
  resolveRepoRoot,
  currentBranch,
  listBranches,
  refExists,
  hasCommits,
  addWorktree,
  clearRelativeWorktreesExtension,
  removeWorktree,
  listWorktrees,
  hasChanges,
  COMMIT_IDENTITY,
  commitAll,
  pushBranch,
  gitDirPath,
  ensureWorktreesIgnored,
  type GitRunResult,
  type GitRunOptions,
  type GitLogLevel
} from './worktree'

/*
 * clone.ts —— 「添加项目 → 从 Git 导入」的克隆助手，与 worktree.ts 同一条零依赖
 * 路线（只用 node 内置 + PATH 里的 git），从 `./clone` 点名转出。
 */
export {
  cloneRepo,
  repoNameFromUrl,
  assertSafeRepoUrl,
  maskRepoUrl,
  CloneCanceledError,
  isCloneCanceled
} from './clone'
