# syntax=docker/dockerfile:1
# =============================================================================
# 容器型项目的**基础镜像**：跑我们自己的 Mastra agent 运行时（不是 ACP CLI）。
#
#   docker build -t fizz/agent-runtime:latest -f docker/container-project/runtime.Dockerfile .
#
# 这一层装了：Node 24 + git / ripgrep / rtk 等常用命令行 + `runtime.mjs`（@fizz 源码打成的
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
RUN npm ci --omit=dev

# ── rtk（Rust Token Killer）：把 git / 构建类命令的输出压掉 60~90% 再交给模型 ──────
#
# 装的是 **oss 版**（纯 Apache-2.0）。标准版 `rtk` 里那个压缩引擎是 BUSL-1.1，而 BUSL
# 明确排除「把 RTK 或其衍生物作为商业产品或服务提供给第三方」—— 随本产品的镜像分发正好
# 落在这一条里（要的话得向 rtk-ai 买商用授权）。oss 版带**全部命令过滤器**，只是没有引擎：
# `rtk git status / diff / log` 这些照压。
#
# ⚠️ 默认走 ghfast.top 代理：构建机在境内，github.com:443 直连不通（实测 21s 超时）。
#    校验和钉死在这里 —— 代理即使投毒，也只会让构建失败，不会装进别的东西。
#    海外构建机可以覆盖：--build-arg RTK_BASE_URL=https://github.com/rtk-ai/rtk/releases/download
#
# ⚠️ 放在 `npm ci` **之后**：换版本时只重跑这一层，不会把 200MB 的依赖再装一遍。
ARG RTK_VERSION=1.0.1
ARG RTK_BASE_URL=https://ghfast.top/https://github.com/rtk-ai/rtk/releases/download
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) target='x86_64-unknown-linux-musl'; \
             sha='a44e8ffc43981100b4ddf1710399a1649a6c874591aa6d0c0727fe6cbd983c41' ;; \
      arm64) target='aarch64-unknown-linux-gnu'; \
             sha='ee24a43dac9162de55fea8460b5efcd56d401ec28b5117c921bffa8a57bc136e' ;; \
      *) echo "rtk: 不支持的架构 $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --connect-timeout 15 --max-time 300 \
      "$RTK_BASE_URL/v$RTK_VERSION/rtk-oss-$target.tar.gz" -o /tmp/rtk.tar.gz; \
    echo "$sha  /tmp/rtk.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/rtk.tar.gz -C /usr/local/bin rtk; \
    chmod 0755 /usr/local/bin/rtk; \
    rm -f /tmp/rtk.tar.gz; \
    rtk --version

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
