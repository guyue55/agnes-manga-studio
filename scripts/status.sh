#!/usr/bin/env bash
# scripts/status.sh — 看工作台当前状态（只读，不动任何东西）
#
# 用法：scripts/status.sh [-h]
#   环境变量：PORT=5178  AGNES_STUDIO_HOME=<数据目录>
# 退出码：0 = 在运行  3 = 没在运行（便于脚本里 `if scripts/status.sh; then …`）
set -uo pipefail
. "$(dirname "$0")/lib.sh"

usage() {
  sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}
[ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] && usage

need_curl

if running=$(find_running); then
  set -- $running; pid=$1; port=$2
  say "● 在运行"
  describe_running "$pid" "$port"
  # pid 文件与事实是否一致 —— 不一致就说出来（这是"数字会分叉"的现场）
  pf=$(read_pidfile)
  if [ -z "$pf" ]; then
    say "  备注      pid 文件不存在（可能是手工启动的；脚本照样能停它）"
  elif [ "$pf" != "$running" ]; then
    warn "pid 文件记的是「${pf}」，实际是「${running}」—— 已按实际为准"
  fi
  exit 0
fi

say "○ 没在运行（$HOST:$PORT_BASE 起 $PORT_TRIES 个端口上都没有我们的实例）"
if [ -f "$PID_FILE" ]; then
  say "  注意：存在 pid 文件 ${PID_FILE}（内容：$(read_pidfile)）但进程已不在 —— 过期残留，下次 start/stop 会顺手清掉"
fi
exit 3
