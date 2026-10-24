/**
 * @fizz/shells：本地 shell 探测，TS 源码直接导出（与 contracts / git 等同一模式）。
 *
 * 只做**只读探测**（固定安装位置 + PATH，绝不启动进程），零运行时依赖（只用 node 内置）：
 * - 终端面板的 shell 选择器（`detectShells` / `resolveShell`）；
 * - agent 一次性命令执行的 shell 判定（`commandShellPath` / `gitBashPath`）——
 *   两处必须同一份判定，否则会出现「选择器里有 pwsh、agent 跑命令却用 5.1」的自相矛盾。
 */
export * from './shells'
