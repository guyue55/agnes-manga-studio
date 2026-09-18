# AGENTS.md

面向 AI Agent 的项目工作指南。核心内容：如何**自动感知、查询、更新**本仓库的知识图谱。

## 项目速览

Agnes 漫剧工坊 · 本地版（`agnes-studio`）：本地优先、零云端数据库依赖的 AI 漫剧制作工作台。
Node.js ≥ 20.6 **原生模块实现、零 npm 依赖**；入口 `node server.js`（监听 127.0.0.1:5178），前端为 `public/` 下 vanilla JS ESM（无构建步骤），支持 Node SEA 单文件 Windows exe。数据持久化在本机 `data/`（JSON 文件）。

- 后端链路：`server.js` → `lib/routes.js`（全部 /api 端点）→ `lib/agnes.js`（Agnes 云 API 客户端）→ 外部 API；异步任务链 `lib/jobs.js` + `lib/poller.js`（后台轮询 + SSE 推送）；持久化基石 `lib/store.js`
- 前端链路：`public/index.html` → `public/js/app.js`（壳层/hash 路由）→ `public/js/pages/*`（10 个页面模块）；共享设施 `api.js` / `ui.js` / `consts.js` / `pages/helpers.js`
- 测试：`tools/` 下四套断言脚本（selftest 135 / apitest 213 / uitest 452 / browser-test 78），`node tools/run-all.mjs` 全量跑；另有 `node tools/ui-audit.mjs`（真机布局/对比度/截断提示度量报表）与 `node tools/port-check.mjs`（端口撞车防护三场景真机验证），均按需跑、非门禁

---

## 知识图谱（`.understand-anything/`）

由 `/understand` 技能生成的**全项目结构化图谱**，覆盖全部 47 个文件与其中的函数/类级符号。Agent 做任何跨文件改动前，优先查图谱而不是盲目 grep。

### 文件清单

| 路径 | 作用 |
|---|---|
| `.understand-anything/knowledge-graph.json` | 主图谱（本文档描述的对象）。**生成物，勿手改**，重新分析会整体覆盖 |
| `.understand-anything/meta.json` | 上次分析锚点：`gitCommitHash`、`analyzedAt`、`analyzedFiles` |
| `.understand-anything/fingerprints.json` | 每个源文件的结构指纹（内容哈希 + 符号表），是增量更新的判定依据 |
| `.understand-anything/config.json` | 工具配置（`outputLanguage: zh`） |
| `.understand-anything/intermediate/scan-result.json` | 文件清单 + 预解析 importMap（供增量分析复用） |

当前快照：commit `ef8834d69b94207a0f399847bf580ab5829adc5e` — **196 节点 / 605 边 / 9 层 / 15 步导览**，全部文本为中文。

### 图谱 Schema

顶层结构：`{ version, project, nodes, edges, layers, tour }`

**节点**（`nodes[]`，5 种 type）— 通用字段：`id`、`type`、`name`、`filePath`、`summary`（中文摘要）、`tags`（如 `entry-point`、`api-handler`、`tested`）、`complexity`（`simple|moderate|complex`）；函数/类节点另有 `lineRange: [起, 止]`；部分节点有 `languageNotes`（语言要点笔记）。

| type | 数量 | id 约定 |
|---|---|---|
| `file` | 35 | `file:<相对路径>` |
| `function` | 146 | `function:<相对路径>:<函数名>` |
| `class` | 3 | `class:<相对路径>:<类名>` |
| `document` | 9 | `document:<相对路径>`（Markdown） |
| `config` | 3 | `config:<相对路径>`（JSON） |

**边**（`edges[]`）— `{ source, target, type, direction, weight }`，端点引用节点 id。权重约定：`contains` 1.0；`inherits/implements/calls/exports` 0.8–0.9；`imports/deploys` 0.7；`depends_on/configures/triggers` 0.6；其余 0.5。

| type | 数量 | 含义 |
|---|---|---|
| `contains` | 149 | 文件 → 其内部函数/类 |
| `calls` | 164 | 调用关系（含跨文件的函数级调用） |
| `exports` | 105 | 文件 → 对外导出符号（CJS `module.exports` 面为读源人工校正） |
| `imports` | 61 | ESM import 解析结果（**CJS require 不在这里**，见下文注意事项） |
| `depends_on` | 27 | 语义依赖（动态 require、`<script src>` 加载、spawn 目标等） |
| `documents` | 82 | 文档 ↔ 被说明的文件 |
| `tested_by` | 7 | 生产文件 → 覆盖它的测试脚本 |
| `configures` | 3 | 配置文件 → 被配置对象 |
| `related` | 7 | 语义相关（文档互链、测试工具间的代码级关联） |

**层**（`layers[]`：`{ id, name, description, nodeIds }`，每个文件级节点恰好属于一层）与**导览**（`tour[]`：`{ order, title, description, nodeIds, languageLesson? }`，15 步新手引导，按代码实际结构复述 README 的创作链路故事）。

### 架构层速查（9 层）

| layer id | 名称 | 文件数 |
|---|---|---|
| `layer:frontend-pages` | 前端页面层 | 10 |
| `layer:frontend-shell` | 前端壳层与共享模块 | 6 |
| `layer:backend-api` | HTTP 接口与路由层 | 2 |
| `layer:backend-service` | 后端服务层（agnes/jobs/poller） | 3 |
| `layer:data-persistence` | 数据持久化层（store/seed） | 2 |
| `layer:test` | 测试层（tools/ 四套断言测试 + run-all + ui-audit 度量 + port-check 端口防护验证） | 7 |
| `layer:build-tooling` | 构建工具（build-exe / build-graph-data） | 2 |
| `layer:documentation` | 文档、竞品调研与静态图谱查看器（docs/、AGENTS.md） | 12 |
| `layer:config` | 项目配置 | 3 |

### 常用查询（可直接复制执行）

以下命令均在仓库根目录运行（已实测可用）。

**① 某文件属于哪个层？摘要与标签是什么？**

```bash
node -e "const g=require('./.understand-anything/knowledge-graph.json');const id='file:lib/routes.js';console.log(g.layers.filter(l=>l.nodeIds.includes(id)).map(l=>l.id+' '+l.name).join('\n'));console.log(JSON.stringify(g.nodes.find(n=>n.id===id),null,1))"
```

**② 谁调用了某个函数（入边追踪，找调用方）/ 它又调用了谁（出边）？**

```bash
node -e "
const g=require('./.understand-anything/knowledge-graph.json');
const id='function:lib/store.js:getSettings';   // ← 改成目标节点 id
const inb=g.edges.filter(e=>e.target===id), out=g.edges.filter(e=>e.source===id);
console.log('← 调用方:', inb.map(e=>e.type+' '+e.source));
console.log('→ 依赖面:', out.map(e=>e.type+' '+e.target));
"
```

**③ 改动影响面：从某节点出发，反向传递闭包（谁会间接受影响）**

```bash
node -e "
const g=require('./.understand-anything/knowledge-graph.json');
const seed='file:lib/store.js';                    // ← 改成你将修改的文件
const rel=new Set(['imports','calls','depends_on','contains','tested_by']);
const rev={};for(const e of g.edges)if(rel.has(e.type))(rev[e.target]=rev[e.target]||[]).push(e.source);
const seen=new Set([seed]);let q=[seed];
while(q.length){const cur=q.pop();for(const p of rev[cur]||[])if(!seen.has(p)){seen.add(p);q.push(p);}}
console.log([...seen].filter(x=>x!==seed).join('\n'));
"
```

**④ 某文件包含哪些函数/类符号？**

```bash
node -e "const g=require('./.understand-anything/knowledge-graph.json');console.log(g.edges.filter(e=>e.type==='contains'&&e.source==='file:server.js').map(e=>e.target).join('\n'))"
```

**⑤ 哪些测试覆盖了某文件（及反向）？**

```bash
node -e "const g=require('./.understand-anything/knowledge-graph.json');console.log(g.edges.filter(e=>e.type==='tested_by').map(e=>e.source+' → '+e.target).join('\n'))"
```

**⑥ 按关键词搜索语义（在中文摘要与标签里找）**

```bash
node -e "
const g=require('./.understand-anything/knowledge-graph.json');const kw='SSE';   // ← 关键词
console.log(g.nodes.filter(n=>(n.summary||'').includes(kw)||(n.tags||[]).some(t=>t.toLowerCase().includes(kw.toLowerCase()))).map(n=>n.id+' :: '+(n.summary||'').slice(0,60)).join('\n---\n'));
"
```

**⑦ 走 15 步导览了解全貌**：读 `g.tour`（`order` 排序，含每步 `nodeIds` 与 `languageLesson`）。

### 时效检测

每次使用前，比对图谱锚点与 HEAD：

```bash
node -e "console.log(require('./.understand-anything/meta.json').gitCommitHash)"
git rev-parse HEAD
```

不一致时，看图谱锚点之后变了哪些文件，仅对这些文件保持怀疑（其余节点的图谱信息仍然可靠）：

```bash
git diff --name-only "$(node -p "require('./.understand-anything/meta.json').gitCommitHash")"..HEAD
```

小改动（改行不改结构）通常不影响图谱结论；**新增/删除文件、增删导出符号**时，图谱会明显失真，应更新。

### 更新流程

图谱通过 `understand` 技能（Agent 技能目录中的 `/understand`）重建，不要手工编辑 JSON：

1. **增量更新（推荐）**：直接说"/understand 增量更新"或再跑一次 `/understand`。技能会读取 `meta.json` 的 commit 与 `fingerprints.json`，只重新分析变更文件所在批次，然后重跑分层与导览。
2. **全量重建**：`/understand --full`（换语言、大规模重构后用）。
3. **自动更新钩子**：`/understand --auto-update` 会在 `config.json` 写入 `autoUpdate: true`，提交时自动维护图谱；`--no-auto-update` 关闭。
4. 更新后把 `.understand-anything/`（至少 `knowledge-graph.json` + `meta.json` + `fingerprints.json`）与代码改动一起提交，保证锚点一致。

---

## ⚠️ 注意事项与已知边界

1. **CJS 依赖不在 `imports` 边里**：`server.js`、`lib/routes.js`、`tools/selftest.mjs` 等用 CommonJS `require()` / `createRequire()`（SEA 兼容），tree-sitter import 解析返回空。它们的真实依赖被捕获为 `depends_on` / `calls` 边（例：`file:server.js → file:lib/routes.js`）。查后端依赖时**务必同时看这两种边**，只看 `imports` 会漏。
2. **`tested_by` 语义**：本项目测试脚本在 `tools/`（非 `*.test.*` 约定命名），这 7 条边是审查阶段逐对源码验证后恢复的，可信。
3. **孤立节点（2 个）**：`.understand-anything/` 自身的 `.understandignore` 与 `config.json`。属正常，非图谱缺陷（run-all.mjs 的 spawn 目标依赖边已于增量时补齐）。
4. **两套"知识图谱"，不要混淆**：
   - `.understand-anything/knowledge-graph.json` — 本文档描述的**工具生成全图**（196 节点），机器消费、可增量更新；
   - `docs/knowledge-graph/` — **手工维护的架构讲解图**（73 节点，提交入库，供人浏览），配套 `viewer.html` 双击可开。**修改 `docs/knowledge-graph/knowledge-graph.json` 后必须跑 `node tools/build-graph-data.mjs`** 重新生成 `graph.data.js`（该脚本会做引用完整性/孤立节点校验，失败即退出非零）。其边 schema 是 `from`/`to`，与工具图谱的 `source`/`target` 不同。
5. 大版本架构变化（如新增子目录模块、拆分 routes）后，若未及跑 `/understand`，至少手工修订上文层表与本节事实，图谱与文档以代码为准。
