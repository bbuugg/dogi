# syntax=docker/dockerfile:1
# =============================================================================
# 容器型项目 · Go 运行环境镜像。
#
#   docker build -t fizz/agent-golang:latest -f docker/container-project/golang.Dockerfile .
#
# 在基础镜像（Node + 我们的 agent 运行时）之上补 Go 工具链。
# ⚠️ 需要基础镜像 `fizz/agent-runtime:latest` 已存在（宿主侧会先确保）。
#
# ## 为什么不用 Debian 自带的 `golang-go`
#
# 基础镜像是 Debian slim，`apt install golang-go` 装到的是**发行版冻结的那一版**
# （bookworm 是 1.19、trixie 是 1.24），比当前稳定版落后一大截。而 Go 的工具链版本
# 是硬约束：`go.mod` 里写 `go 1.27` 的模块在 1.19 上会直接拒绝构建，不是「慢一点」。
# 所以和 php.Dockerfile 同一策略：从上游装**当前最新稳定版**（官方 tarball，含校验）。
# =============================================================================

FROM fizz/agent-runtime:latest

# 升级 Go 只改这三行：版本号 + 两种架构的 sha256（抄自 `https://go.dev/dl/?mode=json`
# 的 `files[].sha256`）。**换版本号必须同时换哈希** —— 对不上会在 `sha256sum -c` 处
# 构建失败，这是故意的：宁可构建红一次，也不要静默装上半个包。
ARG GO_VERSION=1.27.2
ARG GO_SHA256_AMD64=ecbadb99091a3f46e31f5f934b068b1864eafa7995211b39eaddf76996045fe5
ARG GO_SHA256_ARM64=94f3e30b8e374bc285e7dadc11e0865726b9bc6e85b841ccceaabc0214c6b7c8

# 下载源：默认走阿里云镜像（构建机在境内，`go.dev:443` 直连不通 —— TLS 握手就被掐，
# curl 退出码 35；与仓库其它 Dockerfile 换阿里云 apt 源同一理由）。后两个是兜底，
# 依次重试，全失败才报错。三者都是**官方 tarball 的镜像**，文件与 sha256 完全一致，
# 所以下面的校验和照样钉死：镜像投毒只会让构建失败，不会静默装进别的东西。
# 海外构建机可以覆盖：--build-arg GO_DL_BASE=https://go.dev/dl
ARG GO_DL_BASE=https://mirrors.aliyun.com/golang

# 架构现取（Apple Silicon 上是 arm64），Go 的 tarball 文件名里用的正是这两个词
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) sha="$GO_SHA256_AMD64" ;; \
      arm64) sha="$GO_SHA256_ARM64" ;; \
      *) echo "不支持的架构：$arch" >&2; exit 1 ;; \
    esac; \
    file="go${GO_VERSION}.linux-${arch}.tar.gz"; \
    fetched=''; \
    for base in "$GO_DL_BASE" https://golang.google.cn/dl https://go.dev/dl; do \
      echo "下载 ${file}：${base}"; \
      if curl -fsSL --connect-timeout 15 --max-time 600 --retry 2 --retry-delay 2 \
            -o /tmp/go.tgz "${base}/${file}"; then fetched="$base"; break; fi; \
      rm -f /tmp/go.tgz; \
    done; \
    if [ -z "$fetched" ]; then \
      echo "go tarball 所有下载源都失败（$GO_DL_BASE / golang.google.cn / go.dev）" >&2; \
      exit 1; \
    fi; \
    echo "已从 ${fetched} 下载，校验 sha256"; \
    echo "${sha}  /tmp/go.tgz" | sha256sum -c -; \
    tar -C /usr/local -xzf /tmp/go.tgz; \
    rm -f /tmp/go.tgz; \
    /usr/local/go/bin/go version

# Go 的构建缓存与模块缓存落到工作区外，避免污染 bind mount 的项目目录；
# PATH 带上 `go install` 装出来的二进制（GOPATH/bin）
ENV PATH=/usr/local/go/bin:/root/go/bin:$PATH \
    FIZZ_CONTAINER_ENV=golang \
    GOPATH=/root/go \
    GOCACHE=/root/.cache/go-build \
    GOFLAGS=-mod=mod
