#!/usr/bin/env bash
# scripts/start.sh — 启动工作台（后台常驻，日志落 data/run/server.log）
#
# 用法：scripts/start.sh [-h]
#   环境变量：PORT=5178  OPEN=1（顺带打开浏览器；默认不打开）  AGNES_STUDIO_HOME=<数据目录>
# 退出码：0 = 已在运行（含"本来就跑着，没重复启动"）  1 = 启动失败
set -uo pipefail
. "$(dirname "$0")/lib.sh"

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}
[ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] && usage

need_node; need_curl
mkdir -p "$RUN_DIR" || die "建不了运行目录：$RUN_DIR"

# ── 已经在跑就别起第二个（X4 防护：同数据目录两个实例会互相覆盖整库快照） ──────
if running=$(find_running); then
  set -- $running; rpid=$1; rport=$2
  say "✓ 已在运行（没有重复启动）"
  describe_running "$rpid" "$rport"
  say "  要重启请用：scripts/restart.sh"
  exit 0
fi

rotate_log

if [ "${OPEN:-0}" = "1" ]; then unset NO_OPEN; else export NO_OPEN=1; fi
say "启动：node ${APP_ENTRY}（请求端口 ${PORT_BASE}）"
cd "$ROOT" || die "进不了仓库目录：$ROOT"
nohup node "$APP_ENTRY" >>"$LOG_FILE" 2>&1 &
pid=$!
printf '%s\n' "$pid" > "$PID_FILE"      # 先记 pid；端口探明后再补

if ! port=$(wait_ready "$pid"); then
  # 三种结局分开说，别混成一个"启动失败"：
  if running=$(find_running); then
    set -- $running; opid=$1; oport=$2
    say "✓ 已在运行（没有重复启动）"
    say "  （我拉起的进程已退出：同一数据目录已有实例，server.js 拒绝起第二个 —— 这是有意的防护）"
    describe_running "$opid" "$oport"
    rm -f "$PID_FILE"
    exit 0
  fi
  warn "启动失败：等了 ${HEALTH_TIMEOUT}s，$HOST:$PORT_BASE 起 $PORT_TRIES 个端口上都没有我们的实例应答"
  if pid_alive "$pid"; then
    warn "进程 $pid 还活着但不应答，已结束它（避免留一个半死的实例）"
    kill "$pid" 2>/dev/null || true
  fi
  say "  日志末尾："
  tail -n 15 "$LOG_FILE" 2>/dev/null | sed 's/^/    /'
  rm -f "$PID_FILE"
  exit 1
fi

printf '%s %s\n' "$pid" "$port" > "$PID_FILE"
if [ "$port" != "$PORT_BASE" ]; then
  warn "端口 $PORT_BASE 被别的程序占着，实际起在 ${port}（server.js 会自动 +1 重试，最多 $PORT_TRIES 次）"
fi
say "✓ 已启动"
describe_running "$pid" "$port"
