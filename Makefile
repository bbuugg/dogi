# =============================================================================
# Fizz · web 构建入口
#
# 这里**只是把 package.json 里的 npm 脚本收成短命令**，构建逻辑一律留在 npm 脚本 /
# vite 配置里（唯一真源）。要改构建流程，去动那些文件，别往这里塞逻辑 ——
# 否则同一条链路会有两份定义，早晚对不上。
#
#   make            等同 make help
#   make web        只构建前端产物 → apps/web/dist
#   make build      服务端 + web（生产部署形态：server 同源托管 web）
#   make up         docker compose 起容器（容器内自己跑 build:server + build:web）
#
# 关于「web」到底指什么：本项目的 web 是 apps/web 的静态产物（apps/web/dist），
# 由 server 同源托管。所以「能跑起来的 web」= build:web 的前端 + build:server 的服务端，
# `make build` 一次做齐这两步。
#
# ⚠️ 配方要同时兼容 sh 与 cmd.exe（PATH 里没有 sh.exe 时 make 走 cmd.exe，Windows 上常见）：
#    · 只写 `npm run …` / `node -e …`，不写 rm、mkdir、管道、* 通配这类平台相关语法；
#    · echo 的文本不要带 ( ) & | % 这些 cmd 会当语法的字符，也别加引号 ——
#      cmd 的 echo 会把引号一起打出来；
#    · 空行走 `echo.`（cmd 需要那个点才输出空行；sh 下会多打一个点，可接受）。
#
# ⚠️ 桌面端的构建不在这里（那是另一条链路）：见 `npm run build:desktop`。
# =============================================================================

NPM    ?= npm
DOCKER ?= docker
# docker 镜像名：compose 里默认也是 fizz-server:latest
IMAGE  ?= fizz-server:latest

WEB_DIST    := apps/web/dist
SERVER_DIST := apps/server/dist

.DEFAULT_GOAL := help
.PHONY: help install web server build dev-web dev-stack preview typecheck \
        image up down logs ps clean-web clean

# -----------------------------------------------------------------------------
# 帮助
# -----------------------------------------------------------------------------
help:
	@echo Fizz web 构建入口
	@echo.
	@echo   make install    安装依赖
	@echo   make web        构建前端产物, 输出到 apps/web/dist
	@echo   make server     构建服务端, 输出到 apps/server/dist
	@echo   make build      先 server 后 web, 生产部署形态
	@echo   make dev-web    前端开发服务, 端口 5173, /api 代理到本地 7801
	@echo   make dev-stack  构建 server 加 web 并启动 server, 另开终端跑 dev-web
	@echo   make preview    预览已构建的前端产物, 端口 5179
	@echo   make typecheck  全量 TypeScript 类型检查
	@echo.
	@echo   make image      docker build -t fizz-server:latest
	@echo   make up         docker compose up -d --build
	@echo   make down       docker compose down
	@echo   make logs       docker compose logs -f
	@echo   make ps         docker compose ps
	@echo.
	@echo   make clean-web  删除 apps/web/dist
	@echo   make clean      删除 web 与 server 的构建产物
	@echo.
	@echo 变量: NPM=$(NPM)  DOCKER=$(DOCKER)  IMAGE=$(IMAGE)

# -----------------------------------------------------------------------------
# 依赖
# -----------------------------------------------------------------------------
# 用 install 而不是 ci：ci 会先删掉整个 node_modules 再装，局部改动后重装代价太大。
# 需要严格按 lock 复现时自己敲 `npm ci`。
install:
	$(NPM) install

# -----------------------------------------------------------------------------
# 构建
# -----------------------------------------------------------------------------
# build:web = copy:monaco + vite build -c apps/web/vite.config.ts
#   → apps/web/dist（静态文件，由 server 同源托管；含 monaco 资源）
#   ⚠️ dist 不清空（保住 public 拷来的 monaco），过期哈希由 vite 插件在构建开始时清
web:
	$(NPM) run build:web

# build:server = vite build -c apps/server/vite.config.ts
#   → apps/server/dist/index.js（单文件 ESM，第三方依赖保持 external，运行时靠 node_modules）
server:
	$(NPM) run build:server

# 生产部署形态：server 直接托管 apps/web/dist，同源 → 不需要配 CORS
build: server web

typecheck:
	$(NPM) run typecheck

# -----------------------------------------------------------------------------
# 开发
# -----------------------------------------------------------------------------
# 前端 dev server（5173），/api 已代理到 http://127.0.0.1:7801（含 WebSocket）
# 需要另一个终端先把 server 跑起来：make dev-stack
dev-web:
	$(NPM) run dev:web

# 构建 server + web 并前台启动 server
dev-stack:
	$(NPM) run dev:stack

# 预览构建产物（先构建再起 vite preview，端口 5179）
preview: web
	$(NPM) run preview -w @fizz/web

# -----------------------------------------------------------------------------
# 容器
# -----------------------------------------------------------------------------
# 镜像内自己跑 build:server + build:web，所以本地不必先 make build
image:
	$(DOCKER) build -t $(IMAGE) .

up:
	$(DOCKER) compose up -d --build

down:
	$(DOCKER) compose down

logs:
	$(DOCKER) compose logs -f

ps:
	$(DOCKER) compose ps

# -----------------------------------------------------------------------------
# 清理
# -----------------------------------------------------------------------------
# 用 node 删目录，不写 rm（cmd.exe 下没有 rm）—— node 本来就是这个项目的运行前提
clean-web:
	@node -e "require('node:fs').rmSync('$(WEB_DIST)', { recursive: true, force: true })"
	@echo removed $(WEB_DIST)

clean: clean-web
	@node -e "require('node:fs').rmSync('$(SERVER_DIST)', { recursive: true, force: true })"
	@echo removed $(SERVER_DIST)
