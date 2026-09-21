#!/usr/bin/env bash
# scripts/restart.sh — 重启工作台（停 → 起；本来没在跑就直接起）
#
# 用法：scripts/restart.sh [-h]
#   环境变量：PORT=5178  OPEN=1（顺带打开浏览器）  AGNES_STUDIO_HOME=<数据目录>
# 退出码：0 = 重启后已在运行  1 = 失败（此时**服务是停着的**，脚本会明说）
set -uo pipefail
. "$(dirname "$0")/lib.sh"

usage() {
  sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}
[ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] && usage

before=$(find_running || true)
if [ -n "$before" ]; then
  set -- $before
  say "重启：先停 PID ${1}（端口 ${2}）"
  "$SCRIPTS_DIR/stop.sh" || rc=$?
  rc=${rc:-0}
  # 3 = "本来就没在运行"（可能刚好在这一瞬间自己退了）—— 那不是失败，继续往下起
  if [ "$rc" != "0" ] && [ "$rc" != "3" ]; then
    # 停失败就别往下走：硬起第二个实例会踩 X4 防护（同数据目录互踩整库快照）
    die "停止失败（scripts/stop.sh 退出码 ${rc}）—— 已中止重启，当前服务状态未变"
  fi
else
  say "本来就没在运行，直接启动"
fi

"$SCRIPTS_DIR/start.sh" || die "重启失败：服务现在是**停着的**（scripts/start.sh 退出码 $?）"
