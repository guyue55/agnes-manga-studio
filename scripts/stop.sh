#!/usr/bin/env bash
# scripts/stop.sh — 停止工作台（先 TERM，超时再 KILL；只动能证明是我们的进程）
#
# 用法：scripts/stop.sh [-h]
#   环境变量：PORT=5178  AGNES_STUDIO_HOME=<数据目录>
# 退出码：0 = 已停止  1 = 拒绝/失败  3 = 本来就没在运行
set -uo pipefail
. "$(dirname "$0")/lib.sh"

usage() {
  sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}
[ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] && usage

need_curl

# ── 找候选：pid 文件**不直接信**（会过期、PID 会被系统复用），要过身份闸门 ──────────
cand=$(read_pidfile)
cand_pid=$(printf '%s' "$cand" | awk '{print $1}')
cand_port=$(printf '%s' "$cand" | awk '{print $2}')

pid=''; port=''
if [ -n "$cand_pid" ] && pid_is_ours "$cand_pid" "${cand_port:-}"; then
  pid=$cand_pid; port=$cand_port
elif running=$(probe_ports); then
  set -- $running; pid=$1; port=$2
elif [ -n "$cand_pid" ] && pid_alive "$cand_pid"; then
  # 最危险的一种：pid 文件里的进程**还活着**，但证明不了是我们的（PID 被复用了）。
  # 拒绝动手，并说清为什么 —— 宁可让用户人工处理，也不能杀掉无关进程。
  die "拒绝结束 PID ${cand_pid}：它活着，但既不是本仓库的 server.js，$HOST:$PORT_BASE 起 $PORT_TRIES 个端口上也没有我们的实例应答。
  （PID 会被系统复用，照着过期的 pid 文件 kill 会误伤无关进程。pid 文件：${PID_FILE}）
  人工核对：ps -o command= -p $cand_pid
  确认它不是本工作台后，删掉过期文件即可：rm -f $PID_FILE"
elif [ -n "$cand_pid" ]; then
  say "本来就没在运行（顺手清掉过期的 pid 文件：${PID_FILE}）"
  rm -f "$PID_FILE"
  exit 3
else
  say "本来就没在运行（$HOST:$PORT_BASE 起 $PORT_TRIES 个端口上都没有我们的实例）"
  exit 3
fi

# ── 动手前再核一次身份（找与 kill 之间进程可能已经退了，PID 可能刚好被复用） ────
if ! pid_is_ours "$pid" "$port"; then
  die "拒绝结束 PID ${pid}：动手前的复核没通过（它已不是我们的实例）"
fi

say "停止：PID ${pid}（端口 ${port}）"
kill "$pid" 2>/dev/null || die "TERM 发不出去（PID ${pid}）"

i=0
while [ "$i" -lt 20 ] && pid_alive "$pid"; do sleep 0.5; i=$((i + 1)); done

killed=0
if pid_alive "$pid"; then
  warn "TERM 后 10s 仍未退出，改用 KILL"
  kill -9 "$pid" 2>/dev/null || true
  sleep 0.5
  pid_alive "$pid" && die "KILL 之后进程仍在（PID ${pid}）—— 请人工处理：ps -o command= -p $pid"
  killed=1
fi

rm -f "$PID_FILE"

# 收尾核对：端口上不该再有我们的实例（"说了停止"与"真的停止"是两件事）
if is_ours "$port"; then
  die "进程 $pid 已退出，但 $HOST:$port 上仍有我们的实例应答 —— 请人工核对：lsof -nP -iTCP:$port -sTCP:LISTEN"
fi

if [ "$killed" = "1" ]; then
  say "✓ 已停止（PID ${pid}，用了 KILL）"
else
  say "✓ 已停止（PID ${pid}）"
fi
