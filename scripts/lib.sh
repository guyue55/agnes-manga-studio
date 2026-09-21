#!/usr/bin/env bash
# scripts/lib.sh — 工作台进程管理的公共设施（被 start/stop/restart/status 共用）
# ---------------------------------------------------------------------------
# 三条纪律，每条都对应一个"本地长驻服务"真会踩的坑：
#
#   ① **能证明是我们的进程，才动手**。pid 文件会过期、PID 会被系统复用 —— 照着 pid 文件
#      `kill` 有可能杀掉一个毫不相干的进程。核对判据与 server.js 的 `sameAppAlive` **同源**：
#      /api/health 的 `ok=true` 且 `data_home` 就是本仓库的数据目录；命令行里出现本仓库
#      server.js 的**绝对路径**只作为兜底（进程还活着但健康检查不应答时用）。
#      证明不了就**拒绝动手**并说清原因，而不是"赌一把"。
#
#   ② **端口是问出来的，不是假设的**。server.js 在端口被**别的**程序占用时会自动 +1 重试
#      （最多 40 次），所以"我让它监听 5178"不等于"它就在 5178"。谁真的在应答、在哪个端口，
#      一律靠探测，并把结果记进 pid 文件。
#
#   ③ **"进程退出 0"不等于"启动成功"**。同一数据目录已在运行时，server.js 会打印"已在运行"
#      然后 `exit 0`（X4 防护，本身是对的）。所以判断启动成功要看**健康检查里的 pid 是不是
#      我这次拉起来的那个**，而不是看退出码。
#
# 依赖：node（项目硬要求）、curl（读健康体）。两者缺失都在入口处显式报错，不静默降级。

set -u

# 自定位：用 BASH_SOURCE 找**自己这个文件**，而不是调用方的 $0 ——
# 被 `source` 时 $0 是 "bash"，dirname 会算成 "."，ROOT 就跑到仓库外面去了（写脚本时真踩到）。
_SELF=${BASH_SOURCE[0]:-$0}
SCRIPTS_DIR=$(cd "$(dirname "$_SELF")" && pwd)
ROOT=$(cd "$SCRIPTS_DIR/.." && pwd)
APP_ENTRY="$ROOT/server.js"

# 数据目录口径与 server.js 的 APP_HOME 一致（AGNES_STUDIO_HOME 优先，否则 <仓库>/data）
HOME_DIR=${AGNES_STUDIO_HOME:-$ROOT/data}

# 运行期状态（pid/日志）放在**数据目录**下，不放仓库的 build/ 里 —— 判据是同一个：
# "同一份数据 = 同一个实例"（身份核对用的也是 data_home）。于是两份数据目录各有各的
# pid 与日志：用临时数据目录跑测试不会覆盖线上实例的 pid 文件（写脚本时差点踩到）。
RUN_DIR="$HOME_DIR/run"
PID_FILE="$RUN_DIR/server.pid"            # 内容：<pid> <port>
LOG_FILE="$RUN_DIR/server.log"

HOST=127.0.0.1
PORT_BASE=${PORT:-5178}
PORT_TRIES=${PORT_TRIES:-40}              # 与 server.js 的 MAX_TRY 对齐
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-20}      # 等待就绪的秒数
LOG_MAX_BYTES=${LOG_MAX_BYTES:-5242880}   # 5 MiB，超了轮转一次（本地长驻不该让日志无限长）

say()  { printf '%s\n' "$*"; }
warn() { printf '⚠ %s\n' "$*" >&2; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }

need_node() { command -v node >/dev/null 2>&1 || die "找不到 node（本项目要求 Node ≥ 20.6）"; }
need_curl() { command -v curl >/dev/null 2>&1 || die "找不到 curl（脚本用它读 /api/health）"; }

# ── 健康体读取（"问不到"是一种正常结局，不报错、给空串） ────────────────────────
HEALTH_BODY=''
health_load() { # <port>
  HEALTH_BODY=$(curl -s --max-time 2 "http://$HOST:$1/api/health" 2>/dev/null || true)
}
# 下面三个取值器读的是**扁平** JSON（我们自己的 /api/health 就是扁平的）。
# 取不到一律给空串 —— 调用方必须把空串当"不知道"处理，别当"否"。
# 注意用 -E（ERE）：BSD sed 的 BRE **不支持 `\|` 分支**（那是 GNU 扩展），
# 写成 BRE 时 h_bool 会静默返回空串 —— 而空串被当成"否"，于是"在运行"被判成"没在运行"（真踩到）。
h_str()  { printf '%s' "$HEALTH_BODY" | sed -E -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/p" | head -1; }
h_num()  { printf '%s' "$HEALTH_BODY" | sed -E -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p" | head -1; }
h_bool() { printf '%s' "$HEALTH_BODY" | sed -E -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*(true|false).*/\1/p" | head -1; }

home_resolved() { # 数据目录可能还没被创建，解析不了就退回原字符串
  (cd "$HOME_DIR" 2>/dev/null && pwd) || printf '%s' "$HOME_DIR"
}

# 端口上应答的是"我们这份数据的工作台"吗？（判据同 server.js 的 sameAppAlive）
is_ours() { # <port>
  health_load "$1"
  [ "$(h_bool ok)" = "true" ] || return 1
  local home; home=$(h_str data_home)
  [ -n "$home" ] || return 1
  [ "$(cd "$home" 2>/dev/null && pwd)" = "$(home_resolved)" ]
}

pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# 兜底判据：命令行里是本仓库 server.js 的绝对路径（start.sh 一律用绝对路径拉起，就是为了这条能成立）
pid_is_our_entry() { # <pid>
  local cmd; cmd=$(ps -o command= -p "$1" 2>/dev/null || true)
  case "$cmd" in *"$APP_ENTRY"*) return 0 ;; esac
  return 1
}

# 这个 pid 能不能被证明是我们的实例？
pid_is_ours() { # <pid> [port]
  pid_alive "${1:-}" || return 1
  if [ -n "${2:-}" ] && is_ours "$2" && [ "$(h_num pid)" = "$1" ]; then return 0; fi
  pid_is_our_entry "$1"
}

read_pidfile() { # 回显 "<pid> <port>"；文件不在/读不出给空
  [ -f "$PID_FILE" ] || return 0
  local pid='' port=''
  read -r pid port < "$PID_FILE" 2>/dev/null || true
  [ -n "$pid" ] && printf '%s %s\n' "$pid" "${port:-}"
}

probe_ports() { # 回显我们的实例 "<pid> <port>"（找不到返回 1）
  local p
  for p in $(seq "$PORT_BASE" $((PORT_BASE + PORT_TRIES))); do
    if is_ours "$p"; then printf '%s %s\n' "$(h_num pid)" "$p"; return 0; fi
  done
  return 1
}

# 找"正在跑的我们的实例"：先信 pid 文件（但要核对身份），再全端口探测。
find_running() {
  local pf pid port
  pf=$(read_pidfile)
  if [ -n "$pf" ]; then
    set -- $pf; pid=$1; port=${2:-}
    if [ -n "$port" ] && pid_is_ours "$pid" "$port"; then printf '%s %s\n' "$pid" "$port"; return 0; fi
  fi
  probe_ports
}

# 等"我这次拉起的 pid"就绪，回显端口；进程先死或超时都返回 1
wait_ready() { # <pid>
  local pid=$1 i=0 p
  while [ "$i" -lt $((HEALTH_TIMEOUT * 2)) ]; do
    for p in $(seq "$PORT_BASE" $((PORT_BASE + PORT_TRIES))); do
      if is_ours "$p" && [ "$(h_num pid)" = "$pid" ]; then printf '%s\n' "$p"; return 0; fi
    done
    pid_alive "$pid" || return 1
    sleep 0.5
    i=$((i + 1))
  done
  return 1
}

rotate_log() {
  [ -f "$LOG_FILE" ] || return 0
  local size; size=$(wc -c < "$LOG_FILE" 2>/dev/null | tr -d ' ')
  [ -n "$size" ] || return 0
  if [ "$size" -gt "$LOG_MAX_BYTES" ]; then
    mv -f "$LOG_FILE" "$LOG_FILE.1" 2>/dev/null || true
    say "日志超过 $((LOG_MAX_BYTES / 1048576)) MiB，已轮转为 $LOG_FILE.1"
  fi
}

# 打印一个实例的当前状态（start/status 共用，避免两处各写一份字段解读）
describe_running() { # <pid> <port>
  health_load "$2"
  say "  地址      http://$HOST:$2"
  say "  PID       $1"
  say "  版本      $(h_str version)"
  say "  启动于    $(h_str booted_at)"
  say "  代码指纹  $(h_str code_sig)"
  say "  数据目录  $(h_str data_home)"
  say "  日志      $LOG_FILE"
  if [ "$(h_bool code_stale)" = "true" ]; then
    warn "当前进程跑的是**旧代码**（服务端代码在它启动之后被改过）—— 页面上的新接口会报「接口不存在」，请用 scripts/restart.sh 重启"
  fi
}
