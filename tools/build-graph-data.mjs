/**
 * build-graph-data.mjs — 把 docs/knowledge-graph/knowledge-graph.json
 * 转成 viewer.html 可用的 graph.data.js（file:// 双击可开的 script 标签格式）。
 *
 * 用法：node tools/build-graph-data.mjs
 * 改了 JSON 就跑一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'docs/knowledge-graph/knowledge-graph.json');
const OUT = path.join(ROOT, 'docs/knowledge-graph/graph.data.js');

const graph = JSON.parse(fs.readFileSync(SRC, 'utf8'));

// 基本体检：引用完整性 + 孤立节点
const ids = new Set(graph.nodes.map((n) => n.id));
const bad = [];
for (const e of graph.edges) {
  if (!ids.has(e.from)) bad.push(`悬空 from: ${e.from}`);
  if (!ids.has(e.to)) bad.push(`悬空 to: ${e.to}`);
}
if (new Set(graph.nodes.map((n) => n.id)).size !== graph.nodes.length) bad.push('存在重复节点 id');
const deg = {};
for (const e of graph.edges) { deg[e.from] = (deg[e.from] || 0) + 1; deg[e.to] = (deg[e.to] || 0) + 1; }
const lonely = graph.nodes.filter((n) => !deg[n.id]).map((n) => n.id);
if (lonely.length) bad.push(`孤立节点: ${lonely.join(', ')}`);
if (bad.length) {
  console.error('✗ 图谱数据有问题：\n  ' + bad.join('\n  '));
  process.exit(1);
}

graph.meta.stats = { nodes: graph.nodes.length, edges: graph.edges.length };
const banner = '/* 由 knowledge-graph.json 生成，勿手改 —— 改 JSON 后跑 node tools/build-graph-data.mjs */\n';
fs.writeFileSync(OUT, banner + 'window.GRAPH = ' + JSON.stringify(graph) + ';\n', 'utf8');
// JSON 侧同步 stats，避免两个文件说法不一
fs.writeFileSync(SRC, JSON.stringify(graph, null, 2) + '\n', 'utf8');
console.log(`✓ ${graph.nodes.length} 节点 / ${graph.edges.length} 边 → ${path.relative(ROOT, OUT)}`);
