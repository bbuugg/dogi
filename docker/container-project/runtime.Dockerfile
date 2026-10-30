# syntax=docker/dockerfile:1
# =============================================================================
# 容器型项目的**基础镜像**：跑我们自己的内置 agent 运行时（不是 ACP CLI）。
#
#   docker build -t fizz/agent-runtime:latest -f docker/container-project/runtime.Dockerfile .
#
# 这一层装了：Node 24 + git / ripgrep 等常用命令行 + `runtime.mjs`（@fizz 源码打成的
# bundle）+ `agent-host.mjs`（容器内 HTTP 控制面，监听 :8080）+ 内置技能。
# 各运行环境镜像（node / php / golang / vite）都 `FROM fizz/agent-runtime:latest`，
# 只在自己的 Dockerfile 里补该语言的工具链，**不动这一层**。
#
# 与 `docker/agent-flow/Dockerfile`（ACP CLI 那条链路）刻意分开：那条链路一行不改。
# =============================================================================

FROM node:24-slim

# 默认 deb.debian.org 在境内很慢，与仓库其它 Dockerfile 一致换阿里云镜像
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      openssh-client \
      ca-certificates \
      curl \
      ripgrep \
      less \
      procps \
      jq \
      bash \
 && rm -rf /var/lib/apt/lists/*

# ⚠️ 这里**刻意不装 rtk**：容器运行环境不需要它。宿主侧 `plugins/rtk` 里的改写器遇到
#    没装 rtk（ENOENT / EACCES）会降级成原命令，容器里的命令照常执行，不会报错。

# 容器内运行时依赖：`npm ci --omit=dev` 用下面那份 lockfile
# ⚠️ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD：`playwright` 的 postinstall 默认会去下 Chromium
#    （几百 MB，镜像直接翻倍）。浏览器**首次用到时在线下载**（与仓库既有策略一致，
#    见 packages/tools/src/playwright-browsers.ts），所以这里必须跳过。
ENV npm_config_registry=https://registry.npmmirror.com \
    npm_config_audit=false \
    npm_config_fund=false \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app
COPY docker/container-project/runtime/package.json docker/container-project/runtime/package-lock.json ./
# ⚠️ 改这份 `package.json` 的 dependencies 必须**同时重生成 lockfile**，否则镜像构建在这一步
#    直接 exit 1（`npm ci` 只认 lockfile 与 package.json 完全同步，不会自己去补）：
#      cd docker/container-project/runtime && npm install --package-lock-only \
#        --ignore-scripts --registry=https://registry.npmmirror.com
RUN npm ci --omit=dev

# 容器内运行时与 HTTP 控制面（`runtime.mjs` 是入库的构建产物，见根 `npm run build:runtime`）
# `bootstrap.mjs` 是启动入口：先跑工作区里的 `.fizz/container/start.mjs`（失败也不影响），
# 再加载 `agent-host.mjs` —— 见该文件的注释
# `autostart.mjs` 只给「自带自动启动」的镜像用（`FIZZ_CONTAINER_AUTOSTART`，当前只有 Web 栈
# 镜像）：没有启动脚本时由 bootstrap 拉起它，铺模板 + 起 dev server
COPY docker/container-project/runtime/runtime.mjs docker/container-project/runtime/agent-host.mjs docker/container-project/runtime/bootstrap.mjs docker/container-project/runtime/autostart.mjs ./
# 内置技能（仓库根 skills/，带标记文件）—— 容器内路径 `/app/skills`，
# 宿主下发的技能清单里 path 必须以此开头（见容器视角技能清单）
COPY skills /app/skills

# git 全局兜底：safe.directory + 关行尾转换 + 提交身份
# （worktree / 工作区是宿主机 bind mount 进来的，属主 uid 与容器内用户对不上）
RUN git config --system --add safe.directory '*' \
 && git config --system core.autocrlf false \
 && git config --system core.eol lf \
 && git config --system user.name 'Fizz Agent' \
 && git config --system user.email 'agent@fizz.local' \
 && git config --system init.defaultBranch main

RUN mkdir -p /workspace

# FIZZ_CONTAINER_ENV 由各 env 镜像覆写；这里给基础镜像一个明确缺省
ENV PORT=8080 \
    FIZZ_CONTAINER_ENV=node \
    HOME=/root
EXPOSE 8080

WORKDIR /workspace
# 入口是 `bootstrap.mjs`（不是 agent-host）：它负责「先尽力跑工作区的启动脚本，
# 再拉起 agent 控制面」，脚本失败不影响容器启动 —— 见 bootstrap.mjs 的文件头
CMD ["node", "/app/bootstrap.mjs"]
