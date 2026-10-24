# syntax=docker/dockerfile:1
# =============================================================================
# 容器型项目 · Next.js 镜像（Node 24 + Next.js / React / Tailwind / lucide）。
#
#   docker build -t fizz/agent-nextjs:latest -f docker/container-project/nextjs.Dockerfile .
#
# 与 `vite.Dockerfile` 同一套玩法，只是换了一个栈：
# - 内置一份 Next.js（App Router）+ TS + Tailwind v4 + lucide-react 模板
#   （`docker/container-project/starter-nextjs`），并在**构建时**装好依赖 ——
#   空工作区首次启动直接铺开就能跑，不依赖外网、不用等 npm install；
# - 设 `FIZZ_CONTAINER_AUTOSTART=dev`：容器启动时若工作区没有 `.fizz/container/start.mjs`，
#   `bootstrap.mjs` 会拉起 `/app/autostart.mjs`（铺模板 → 装依赖 → `npm run dev`）。
#   任何一步失败只写 `[fizz-start]` 日志，**不影响容器与 Agent 启动**；
# - 设 `FIZZ_AUTOSTART_ARGS`：`autostart.mjs` 默认拼的是 **Vite 的参数形状**
#   （`--host 0.0.0.0 --port <p> --strictPort`），`next dev` 既不认 `--strictPort`、
#   host 也写作 `-H/--hostname`。所以这里显式给一份，`{port}` 由启动器替换成实际预览端口。
#
# ⚠️ 需要基础镜像已存在 —— 宿主 `ensureContainerImage()` 会先确保
#    `fizz/agent-runtime:latest`（它已含 Node 24 / npm / git 与 npmmirror registry）。
# =============================================================================

FROM fizz/agent-runtime:latest

ENV FIZZ_CONTAINER_ENV=nextjs \
    FIZZ_CONTAINER_AUTOSTART=dev \
    FIZZ_STARTER=/opt/fizz/starter-nextjs \
    FIZZ_AUTOSTART_ARGS="-H 0.0.0.0 -p {port}" \
    NEXT_TELEMETRY_DISABLED=1

# 模板烘进镜像：starter 没有入库 lockfile（与 vite 模板同一理由，见 vite.Dockerfile），
# 所以这里用 `npm install`；它同时会在模板里生成 lockfile，一起被拷进用户工作区。
#
# 代价：首次启动 `cpSync` 会把 `node_modules` 一起拷进工作区（与 vite 镜像同一套做法，
# 换来的是**离线也能开箱即用**）。Next 的依赖树比 Vite 大不少，Windows 的 bind mount 上
# 冷启动会多花几十秒，属正常现象；之后工作区已有 node_modules 就不会再拷。
COPY docker/container-project/starter-nextjs /opt/fizz/starter-nextjs
RUN cd /opt/fizz/starter-nextjs \
 && npm install --no-audit --no-fund \
 && npm cache clean --force

# 这两个文件基础镜像里也有，这里**再 COPY 一遍覆盖掉**：升级路径上很多人手上还是旧
# `fizz/agent-runtime:latest`（旧 base 里根本没有 `autostart.mjs`，`bootstrap.mjs` 也不认识
# 「自动启动」），只重建环境镜像的话就会变成「容器起来了、模板没铺、页面空白」。
# 带上自己这版启动器 = 这个镜像不依赖 base 是否重建成最新。
COPY docker/container-project/runtime/bootstrap.mjs docker/container-project/runtime/autostart.mjs /app/

WORKDIR /workspace
