# 知识图谱重建：实测代价与做法

> 从 `AGENTS.md` 的「知识图谱」一节抽出（AGENTS.md 有工作区指令体积预算，这一节只在**真要重建图谱**时才用得上，
> 放在主指令里长期占体积不划算）。结论与坑都是**实测**的，不是推测；动手前通读一遍。
>
> 何时需要读：`.understand-anything/meta.json` 的锚点落后 HEAD 且**新增/删除文件或增删导出符号**（改行不改结构
> 通常不影响结论）；或要跑 `/understand` 增量/全量重建。

## 代价与做法（第 85 轮实测）

- **"增量"在这里约等于全量**：锚点之后的改动文件横跨**全部 7 个批次**（批 1 有 `app.js`/`consts.js` 与两个新页面模块、
  批 2 三个前端文件全动、批 3 `store.js`、批 4 `AGENTS.md`、批 6 两份研读文档、批 7 `routes.js`/`jobs.js`/`seed.js`/四套测试）。
  `compute-batches.mjs --changed-files` 会把 7 批全部选进来 —— 不要指望"跑一下就好"。
- **语义内容是人工撰写的，不是子代理批产的**：上一版（R30/B61）是每个批次一个生成器脚本 `tmp/gen-batch-<N>.mjs`：
  机械边（`contains`/`exports`/`imports`/`depends_on`/`tested_by`）由 `extract-structure.mjs` 的产物确定性生成，
  **语义内容（`summary`/`tags`/`complexity`/`languageNotes`）与 `calls` 边逐条审读源码后手写**。全图 220 个函数节点
  都这么来的 —— 这才是重建真正的成本，也是它不能"顺手跑一下"的原因。
- **上一版的中间产物还在本机**（`.understand-anything/.trash-<时间戳>/`，**已被 .gitignore 忽略**，随时可能被清掉）：
  `batch-*.json`（输出 schema 样例）、`batches.json`（文件→批次映射）、`tmp/ua-file-extract-results-<n>.json`（机械提取）、
  `tmp/ua-batch-input-<n>.json`（批次输入）、`tmp/gen-batch-<n>.mjs`（**可复用的生成器模板**）、`layers.json` / `tour.json` /
  `assembled-graph.json`。**动手重建前第一件事：先把这些拷到安全位置**，否则等于从零开始。
- **推荐路线**：① 拷走 `.trash-*` 的 `tmp/` 与 `batches.json`；② 按批（一轮一批，别一次全做）拿 `gen-batch-<N>.mjs`
  作模板，只改**新增文件与改动函数**的语义块；③ `merge-batch-graphs.py` 合并；④ 合并后**手工补回 `tested_by`**
  （见注意事项 2，补完不要再跑合并脚本）；⑤ 重跑分层与导览；⑥ 用 `tmp/ua-inline-validate.cjs` 验完再写三个产物，⑦ 一起提交。
