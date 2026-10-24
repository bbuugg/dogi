# syntax=docker/dockerfile:1
# =============================================================================
# 容器型项目 · Node.js 运行环境镜像。
#
#   docker build -t fizz/agent-node:latest -f docker/container-project/node.Dockerfile .
#
# 只 `FROM fizz/agent-runtime:latest`（基础镜像自带 Node 24），显式声明 envId。
# ⚠️ 需要基础镜像已存在 —— 宿主 `ensureContainerImage()` 会先确保 `fizz/agent-runtime:latest`。
# =============================================================================

FROM fizz/agent-runtime:latest

ENV FIZZ_CONTAINER_ENV=node
