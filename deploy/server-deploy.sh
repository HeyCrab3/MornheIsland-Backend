#!/usr/bin/env bash
#
# MornheIsland 后端发布脚本（在服务器上跑）。
#
# 为什么要有这个脚本，而不是直接 sftp 覆盖：
#   服务器上有三样**只存在于服务器、没有进 git** 的东西：
#     · config.ts              —— 数据库连接串（含口令）、JWT/Session 密钥、SSO 凭据、QWeather key
#     · certs/                 —— gRPC 用的泛域名证书与私钥
#     · grpc/.server-keys.json —— 集控握手的服务器 PGP 私钥
#   前两样丢了服务起不来；第三样一旦被覆盖/清空，
#   **所有已绑定的客户端会永久拒绝重连**（客户端把首次握手拿到的公钥钉死了），
#   只能一台台手动清 ClassIsland 配置重连。这不是"重传一下"能修好的问题。
#   所以：这三样必须显式排除在同步之外，并在同步后二次确认它们还在。
#
# 用法：
#   rsync -a --exclude node_modules --exclude log ./ user@host:~/mornheisland-release/
#   ssh user@host 'bash ~/mornheisland-release/deploy/server-deploy.sh'
#
# 可覆盖的变量（环境变量）：
#   APP_DIR      线上程序目录，默认 /opt/mornheisland-backend
#   SRC_DIR      新代码所在目录，默认 $HOME/mornheisland-release
#   RESTART_CMD  重启命令，默认 'pm2 restart mornheisland-backend'
#   HEALTH_URL   健康检查地址，默认 http://127.0.0.1:7000/
#   BACKUP_DIR   备份目录，默认 $APP_DIR/../backups
#   DELETE       1 = 同步时删除服务器上多余的旧文件（默认 1）

set -euo pipefail

APP_DIR=${APP_DIR:-/opt/mornheisland-backend}
SRC_DIR=${SRC_DIR:-$HOME/mornheisland-release}
RESTART_CMD=${RESTART_CMD:-pm2 restart mornheisland-backend}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:7000/}
BACKUP_DIR=${BACKUP_DIR:-$(dirname "$APP_DIR")/backups}
DELETE=${DELETE:-1}

TS=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="$BACKUP_DIR/backend-$TS.tgz"

# 受保护路径：同步时排除、同步后必须仍然存在
PROTECTED=("config.ts" "certs" "grpc/.server-keys.json")

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m[STOP] %s\033[0m\n' "$*" >&2; exit 1; }

# ── 0. 前置检查：目录搞错了就立刻停，别在半路开始删东西 ──
log "前置检查"
[ -f "$APP_DIR/server.ts" ] || die "$APP_DIR 里没有 server.ts，APP_DIR 可能填错了"
[ -f "$SRC_DIR/server.ts" ] || die "$SRC_DIR 里没有 server.ts，SRC_DIR 可能填错了"
[ -d "$APP_DIR/node_modules" ] || die "$APP_DIR/node_modules 不存在，先装依赖再发布"
for p in "${PROTECTED[@]}"; do
  [ -e "$APP_DIR/$p" ] || die "$APP_DIR/$p 不存在 —— 现在停下比你重启后追这个文件便宜得多"
done
command -v rsync >/dev/null || die "服务器上没有 rsync"

echo "APP_DIR      = $APP_DIR"
echo "SRC_DIR      = $SRC_DIR"
echo "RESTART_CMD  = $RESTART_CMD"
echo "HEALTH_URL   = $HEALTH_URL"
echo "备份到        = $BACKUP_FILE"

# ── 1. 备份（含 config.ts / certs / server-keys，仅备代码与配置，不含 node_modules 和日志）──
log "备份当前版本"
mkdir -p "$BACKUP_DIR"
tar czf "$BACKUP_FILE" \
  -C "$APP_DIR" \
  --exclude=node_modules --exclude=log \
  . || die "备份失败，已中止（此时线上还没被改动）"
echo "备份大小：$(du -h "$BACKUP_FILE" | cut -f1)"

# ── 2. 同步代码（排除受保护文件）──
log "同步代码"
# -c 按**内容校验**，不能只靠默认的「大小 + mtime」：
# 实测踩过 —— 文件大小相同且 mtime 落在同一秒时，rsync 判定"没变"直接跳过，
# 结果脚本一路绿灯、线上还是旧代码。源码目录如果是 tar/git archive 解出来的
# （mtime 被保留），这种情况很容易发生。
RSYNC_ARGS=(-a -c)
[ "$DELETE" = "1" ] && RSYNC_ARGS+=(--delete)
for p in "${PROTECTED[@]}"; do RSYNC_ARGS+=(--exclude="$p"); done
RSYNC_ARGS+=(--exclude=node_modules --exclude=log --exclude=.git)

rsync "${RSYNC_ARGS[@]}" "$SRC_DIR"/ "$APP_DIR"/

# ── 3. 二次确认受保护文件还在（排除规则写错的兜底）──
log "确认受保护文件未被触碰"
for p in "${PROTECTED[@]}"; do
  [ -e "$APP_DIR/$p" ] || die "$APP_DIR/$p 在同步后消失了！立刻回滚：tar xzf $BACKUP_FILE -C $APP_DIR"
done
echo "config.ts / certs / grpc/.server-keys.json 均完好"

# ── 4. 重启 ──
log "重启服务：$RESTART_CMD"
eval "$RESTART_CMD" || echo "[warn] 重启命令返回非零，继续做健康检查"

# ── 5. 健康检查（失败自动回滚）──
log "健康检查 $HEALTH_URL"
ok=0
for i in $(seq 1 30); do
  sleep 1
  code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$HEALTH_URL" || true)
  if [ "$code" = "200" ] || [ "$code" = "401" ] || [ "$code" = "404" ]; then
    ok=1
    echo "第 ${i}s 有响应（HTTP $code）"
    break
  fi
done

if [ "$ok" != "1" ]; then
  log "健康检查失败，自动回滚"
  tar xzf "$BACKUP_FILE" -C "$APP_DIR" || echo "[fatal] 回滚解包失败，手工处理：$BACKUP_FILE"
  eval "$RESTART_CMD" || true
  echo
  echo "最近日志（如果用了 pm2）："
  pm2 logs mornheisland-backend --lines 40 --nostream 2>/dev/null || true
  die "发布失败，已回滚到 $TS 之前的版本"
fi

# ── 6. 新端点抽查（确认新代码真的生效，而不是旧进程还在跑）──
log "抽查新增端点"
probe() {
  local path="$1"; local expect="$2"
  local body
  body=$(curl -s -m 5 "http://127.0.0.1:7000$path" || true)
  case "$body" in
    *"$expect"*) echo "  ok   $path" ;;
    *) echo "  ??   $path -> ${body:0:120}" ;;
  esac
}
# 公开端点：伪造 token 应返回"这个二维码已失效"
probe "/v1/public/notify/00000000000000000000000000000000" "这个二维码已失效"
# 需登录端点：应返回 code 401（express-jwt 的 UnauthorizedError 是 HTTP 200 + code 401）
probe "/v1/console/ci/health/resources" "401"
probe "/v1/console/ci/schools" "401"

log "发布完成"
echo "回滚方式：tar xzf $BACKUP_FILE -C $APP_DIR && $RESTART_CMD"
