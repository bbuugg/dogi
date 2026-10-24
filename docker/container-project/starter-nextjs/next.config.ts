import type { NextConfig } from 'next'

/**
 * Next 的配置入口。
 *
 * 模板刻意留空：镜像只负责「装好依赖、起得来、能预览」，hostname / 端口这些**不写在这里**
 * —— 它们是容器启动时由 `autostart.mjs` 按 `FIZZ_PREVIEW_PORT` 用命令行参数传进来的
 * （`-H 0.0.0.0 -p <port>`，见 `nextjs.Dockerfile` 的 `FIZZ_AUTOSTART_ARGS`）。
 * 把端口写死在这里，换项目 / 换端口时就会和平台分配的对不上，页面直接空白。
 */
const nextConfig: NextConfig = {}

export default nextConfig
