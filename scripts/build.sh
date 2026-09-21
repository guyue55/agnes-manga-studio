#!/usr/bin/env bash
# scripts/build.sh — 重新生成"派生产物"（本项目**没有编译步骤**，别期待 tsc/webpack 那一套）
#
# 为什么没有编译：前端是 public/ 下的 vanilla ESM、后端是原生 Node —— 改一行即生效
# （前端静态文件每次请求都从磁盘读，后端要重启才换代码，所以后端改完请用 scripts/restart.sh）。
#
# 真正需要"重新生成"的只有一处：
#   docs/knowledge-graph/graph.data.js  ←  手写图谱 JSON（docs/knowledge-graph/knowledge-graph.json）
#   改过那个 JSON 就必须重跑 tools/build-graph-data.mjs（它顺带校验引用完整性与孤立节点，失败即非零退出）。
#
# 不在本机跑 exe 打包（tools/build-exe.mjs）：它要 Windows/SEA 环境与 postject 依赖，
# 在 macOS 上跑只会失败或拉运行时，属于另一件事（见该脚本头部说明）。
#
# 用法：scripts/build.sh [-h]
# 退出码：0 = 通过（含"没有需要重新生成的东西"）  1 = 校验/生成失败
set -uo pipefail
. "$(dirname "$0")/lib.sh"

usage() {
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}
[ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] && usage

need_node
cd "$ROOT" || die "进不了仓库目录：$ROOT"

GRAPH_JSON="docs/knowledge-graph/knowledge-graph.json"
GRAPH_DATA="docs/knowledge-graph/graph.data.js"
[ -f "$GRAPH_JSON" ] || die "找不到手写图谱：$GRAPH_JSON"

before=''
[ -f "$GRAPH_DATA" ] && before=$(node -e "process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))" "$GRAPH_DATA")

say "重新生成 ${GRAPH_DATA}（源：${GRAPH_JSON}）"
if ! node tools/build-graph-data.mjs; then
  die "生成/校验失败（tools/build-graph-data.mjs 非零退出）—— 手写图谱里有引用不完整或孤立节点，先修 JSON"
fi

after=$(node -e "process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))" "$GRAPH_DATA")
if [ "$before" = "$after" ]; then
  say "✓ 通过：产物与源一致（内容没有变化）"
else
  say "✓ 通过：产物已更新（内容变了，记得和源 JSON 一起提交）"
fi

say ""
say "提醒：本项目无编译步骤 —— 前端改完刷新即可；**后端（server.js / lib/）改完必须重启**："
say "      scripts/restart.sh"
