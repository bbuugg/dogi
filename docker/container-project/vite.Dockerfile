# syntax=docker/dockerfile:1
# =============================================================================
# 容器型项目 · Web 栈镜像（Node 24 + Vite / React / Tailwind）。
#
#   docker build -t fizz/agent-vite:latest -f docker/container-project/vite.Dockerfile .
#
# 与 `node.Dockerfile` 的差别不是语言版本，而是**开箱即用**：
# - 内置一份 Vite + React + TS + Tailwind v4 模板（`docker/container-project/starter`），
#   并在**构建时**装好依赖 —— 空工作区首次启动直接铺开就能跑，不依赖外网、不用等 npm install；
# - 设 `FIZZ_CONTAINER_AUTOSTART=dev`：容器启动时若工作区没有 `.fizz/container/start.mjs`，
#   `bootstrap.mjs` 会拉起 `/app/autostart.mjs`（铺模板 → 装依赖 → `npm run dev`）。
#   任何一步失败只写 `[fizz-start]` 日志，**不影响容器与 Agent 启动**。
#
# ⚠️ 需要基础镜像已存在 —— 宿主 `ensureContainerImage()` 会先确保
#    `fizz/agent-runtime:latest`（它已含 Node 24 / npm / git 与 npmmirror registry）。
# =============================================================================

FROM fizz/agent-runtime:latest

ENV FIZZ_CONTAINER_ENV=vite \
    FIZZ_CONTAINER_AUTOSTART=dev \
    FIZZ_STARTER=/opt/fizz/starter

# 模板烘进镜像：starter 没有入库 lockfile（`npm install --package-lock-only` 在受限网络下
# 装不了 wasm 可选依赖），所以这里用 `npm install`；它同时会在模板里生成 lockfile，
# 一起被拷进用户工作区，之后用户自己 `npm ci` 就稳定了。
COPY docker/container-project/starter /opt/fizz/starter
RUN cd /opt/fizz/starter \
 && npm install --no-audit --no-fund \
 && npm cache clean --force

# 这两个文件基础镜像里也有，这里**再 COPY 一遍覆盖掉**：升级路径上很多人手上还是旧
# `fizz/agent-runtime:latest`（旧 base 里根本没有 `autostart.mjs`，`bootstrap.mjs` 也不认识
# 「自动启动」），只重建环境镜像的话就会变成「容器起来了、模板没铺、页面空白」。
# 带上自己这版启动器 = 这个镜像不依赖 base 是否重建成最新。
COPY docker/container-project/runtime/bootstrap.mjs docker/container-project/runtime/autostart.mjs /app/

WORKDIR /workspace
