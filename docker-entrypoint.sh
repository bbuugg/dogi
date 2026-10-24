#!/bin/sh
#
# 容器启动入口：按 PUID / PGID 把进程降到指定身份再跑 server。
#
# 目的 —— **内外权限一致**：工作区是从宿主机 bind mount 进来的，容器默认以 root 跑，
# agent 新建的文件在宿主机上就会变成 root 的，你在外面改它得先 sudo chown。
# 把 PUID / PGID 设成宿主机用户的 `id -u` / `id -g`，容器里写出来的东西直接就是你的。
#
#   PUID=1000 PGID=1000 docker compose up -d        # 见 docker-compose.yml / .env.example
#
# 默认 0:0（root）—— 与加这个脚本之前的行为完全一致，不设就没有变化。
#
set -eu

PUID="${PUID:-0}"
PGID="${PGID:-0}"
# HOME 固定：技能目录（~/.fizz/skills）与 git 全局配置的落点不随 uid 漂移，
# compose 里那卷挂的就是这个路径（原来是 /root/.fizz）。
APP_HOME=/home/fizz

# 数据与 HOME 归运行身份所有。
# ⚠️ 不递归 chown /workspace：大仓库上又慢又有风险，宿主侧的属主该由你自己保证
#    （把 PUID/PGID 设成那个目录的属主即可）。
mkdir -p "$APP_HOME"
chown -R "$PUID:$PGID" /data "$APP_HOME"

# 保持 root：行为与以前一致（只是 HOME 换成了上面那个固定值）
if [ "$PUID" = "0" ] && [ "$PGID" = "0" ]; then
  exec env HOME="$APP_HOME" "$@"
fi

# 组 / 用户不存在就建一个。uid 1000 在 node 官方镜像里已经被 `node` 用户占着，
# 那种情况直接复用它（getent 查得到就不建）。
GRP="$(getent group "$PGID" | cut -d: -f1)"
if [ -z "$GRP" ]; then
  GRP=fizz
  groupadd -o -g "$PGID" "$GRP"
fi
if ! getent passwd "$PUID" >/dev/null; then
  useradd -o -u "$PUID" -g "$PGID" -d "$APP_HOME" -s /bin/sh fizz
fi

# gosu 是 exec（不是 fork）：PID 1 就是 node 自己，SIGTERM 能直接收到，docker stop 才能优雅退出。
# HOME 显式传：gosu 不一定会按 passwd 重写它。
exec gosu "$PUID:$PGID" env HOME="$APP_HOME" "$@"
