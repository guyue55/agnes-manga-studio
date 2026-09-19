# AGENTS.md

面向 AI Agent 的项目工作指南。核心内容：如何**自动感知、查询、更新**本仓库的知识图谱。

## 项目速览

Agnes 漫剧工坊 · 本地版（`agnes-studio`）：本地优先、零云端数据库依赖的 AI 漫剧制作工作台。
Node.js ≥ 20.6 **原生模块实现、零 npm 依赖**；入口 `node server.js`（监听 127.0.0.1:5178），前端为 `public/` 下 vanilla JS ESM（无构建步骤），支持 Node SEA 单文件 Windows exe。数据持久化在本机 `data/`（JSON 文件）。

- 后端链路：`server.js` → `lib/routes.js`（全部 /api 端点）→ `lib/agnes.js`（Agnes 云 API 客户端）→ 外部 API；异步任务链 `lib/jobs.js` + `lib/poller.js`（后台轮询 + SSE 推送）；持久化基石 `lib/store.js`；原著解析纯函数层 `lib/story.js`（切块/卡片规范化/跨块去重合并/回注渲染，全部可离线断言）
- 原著解析（批 8）：`docs/research/09-story-bible-plan.md` —— 长篇原文 → 六类卡片（信息卡/人物卡/地点卡/道具卡/剧情卡/时间线），分块 map + 全局 reduce，`/api/story/*` 提供干跑计费闸门、卡片 CRUD、回注渲染与"人物卡入资产库"反向驱动
- 前端链路：`public/index.html` → `public/js/app.js`（壳层/hash 路由）→ `public/js/pages/*`（10 个页面模块）；共享设施 `api.js` / `ui.js` / `consts.js` / `textstats.js`（纯函数：长文本计数与生成门禁判据） / `pages/helpers.js`
- 测试：`tools/` 下四套断言脚本（selftest 302 / apitest 482 / uitest 731 / browser-test 296），`node tools/run-all.mjs` 全量跑；另有 `node tools/ui-audit.mjs`（真机布局/对比度/截断提示度量报表；4 视口 × 10 页，其中 7 页带**弹窗动作钩子**，弹窗内一并度量）与 `node tools/port-check.mjs`（端口撞车防护三场景 6 断言真机验证：含预检环境冲突与收尾无残留自检；exit 0 全过 / 1 违例 / 2 环境冲突），均按需跑、非门禁
- 竞品研读与升级路线：`docs/research/08-src-00-synthesis.md`（5 个 Vibex AI 创作源码包的逐包研读报告 01–05 + R1–R30 借鉴项总表 + 分批升级路线 + 10 条明确不借鉴边界）

---

## 知识图谱（`.understand-anything/`）

由 `/understand` 技能生成的**全项目结构化图谱**，覆盖全部 55 个文件与其中的函数/类级符号。Agent 做任何跨文件改动前，优先查图谱而不是盲目 grep。

### 文件清单

| 路径 | 作用 |
|---|---|
| `.understand-anything/knowledge-graph.json` | 主图谱（本文档描述的对象）。**生成物，勿手改**，重新分析会整体覆盖 |
| `.understand-anything/meta.json` | 上次分析锚点：`gitCommitHash`、`analyzedAt`、`analyzedFiles` |
| `.understand-anything/fingerprints.json` | 每个源文件的结构指纹（内容哈希 + 符号表），是增量更新的判定依据 |
| `.understand-anything/config.json` | 工具配置（`outputLanguage: zh`） |
| `.understand-anything/intermediate/scan-result.json` | 文件清单 + 预解析 importMap（供增量分析复用） |

当前快照：commit `d268a0debde803fa36749bb482e4ff30330df444`（批 7 收尾）— **278 节点 / 1076 边 / 9 层 / 15 步导览**，全部文本为中文。
锚点之后另有两次**纯文档**提交（`AGENTS.md` 与 `docs/issues.md` 的图谱重建记录），按「改行不改结构」不计入失真；`git diff <锚点>..HEAD --name-only` 若只列出这两份文档，无需重建。
扫描范围 = `git ls-files` 减去 `.understandignore` 里的排除项（工具自身的 `knowledge-graph.json` / `fingerprints.json` / `meta.json` / `intermediate/` / `tmp/` / `.trash-*` 一律排除：它们是被分析对象的产物，且体积最大）。

### 图谱 Schema

顶层结构：`{ version, project, nodes, edges, layers, tour }`

**节点**（`nodes[]`，5 种 type）— 通用字段：`id`、`type`、`name`、`filePath`、`summary`（中文摘要）、`tags`（如 `entry-point`、`api-handler`、`tested`）、`complexity`（`simple|moderate|complex`）；函数/类节点另有 `lineRange: [起, 止]`；部分节点有 `languageNotes`（语言要点笔记）。

| type | 数量 | id 约定 |
|---|---|---|
| `file` | 37 | `file:<相对路径>` |
| `function` | 220 | `function:<相对路径>:<函数名>` |
| `class` | 3 | `class:<相对路径>:<类名>` |
| `document` | 15 | `document:<相对路径>`（Markdown） |
| `config` | 3 | `config:<相对路径>`（JSON） |

**边**（`edges[]`）— `{ source, target, type, direction, weight }`，端点引用节点 id。权重约定：`contains` 1.0；`inherits/implements/calls/exports` 0.8–0.9；`imports/deploys` 0.7；`depends_on/configures/triggers` 0.6；其余 0.5。

| type | 数量 | 含义 |
|---|---|---|
| `contains` | 223 | 文件 → 其内部函数/类 |
| `calls` | 325 | 调用关系（含跨文件的函数级调用） |
| `exports` | 143 | 文件 → 对外导出符号（CJS `module.exports` 面为读源人工校正） |
| `imports` | 70 | ESM import 解析结果（**CJS require 不在这里**，见下文注意事项 1） |
| `depends_on` | 59 | 语义依赖（动态 require、`<script src>` 加载、spawn 目标等） |
| `documents` | 194 | 文档 ↔ 被说明的文件 |
| `tested_by` | 22 | 生产文件 → 覆盖它的测试脚本（**需手工补回**，见下文注意事项 2） |
| `configures` | 7 | 配置文件 → 被配置对象 |
| `related` | 32 | 语义相关（文档互链、测试工具间的代码级关联） |
| `deploys` | 1 | `tools/build-exe.mjs` → `server.js`（SEA 打包主脚本） |

**层**（`layers[]`：`{ id, name, description, nodeIds }`，每个文件级节点恰好属于一层）与**导览**（`tour[]`：`{ order, title, description, nodeIds, languageLesson? }`，15 步新手引导，按代码实际结构复述 README 的创作链路故事）。

### 架构层速查（9 层）

| layer id | 名称 | 文件数 |
|---|---|---|
| `layer:frontend-pages` | 前端页面层 | 11（含批 3 新增的 `public/js/pages/characters.js` 角色库页） |
| `layer:frontend-shell` | 前端壳层与共享模块 | 7（含批 4 新增的 `public/js/textstats.js`：长文本计数/软上限/门禁判据的纯函数层） |
| `layer:backend-api` | HTTP 接口与路由层 | 2 |
| `layer:backend-service` | 后端服务层（agnes/jobs/poller） | 3 |
| `layer:data-persistence` | 数据持久化层（store/seed） | 2 |
| `layer:test` | 测试层（tools/ 四套断言测试 + run-all + ui-audit 度量 + port-check 端口防护验证） | 7 |
| `layer:build-tooling` | 构建与代码生成工具（build-exe / build-graph-data） | 2 |
| `layer:documentation` | 文档、竞品研读与静态图谱查看器（docs/、AGENTS.md） | 18（含 `docs/research/08-src-0{0..5}-*.md` 六篇） |
| `layer:config` | 项目配置 | 3 |

层内文件节点合计 55 = 图谱文件级节点总数（校验脚本会强制：每个文件级节点**有且只有一个**归属）。

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
5. **重建时容易踩的坑（本轮实测）**：① 派发 file-analyzer 前必须先生成好各批的 `tmp/ua-file-extract-results-<批号>.json`，否则每个子代理都会自己补跑一遍提取脚本（无害但浪费）；② 合并脚本**不认** `tools/*test*.mjs` 命名，`tested_by` 会全丢，须在合并之后、写最终图之前补回（见注意事项 2），**且补回后不要再跑合并脚本**（会覆盖掉）；③ 批 7 这类"20 个孤儿文件挤在一批"的 misc 批（CJS 文件没有 `imports` 边，全被当孤儿合并）建议按文件体积手工拆成 `batch-<N>-part-<k>.json` 分派，否则单个子代理读不完 `routes.js` + 四个上千行的测试脚本。

---

## ⚠️ 注意事项与已知边界

1. **CJS 依赖不在 `imports` 边里**：`server.js`、`lib/routes.js`、`tools/selftest.mjs` 等用 CommonJS `require()` / `createRequire()`（SEA 兼容），tree-sitter import 解析返回空。它们的真实依赖被捕获为 `depends_on` / `calls` 边（例：`file:server.js → file:lib/routes.js`）。查后端依赖时**务必同时看这两种边**，只看 `imports` 会漏。
2. **`tested_by` 必须手工补回（每轮重建都要做）**：本项目测试脚本在 `tools/` 下叫 `selftest/apitest/uitest/browser-test`（非 `*.test.*` 约定命名），而合并脚本 `merge-batch-graphs.py` 的 `is_test_path()` 对 JS 只认 stem 以 `.test`/`.spec` 结尾 —— 于是**所有** `tested_by` 都被判成"生产↔生产"丢掉，且它的路径约定补链（Pass 2）也一条补不出来。当前图里的 **22 条**是重建后逐对**按源码证据**复核补回的（证据 = 测试脚本正文里出现被测算文件的完整相对路径，或唯一 basename；例如 `tools/uitest.mjs` 用 `readdirSync('public/js/pages')` 动态列举并逐文件断言，故 10 个页面文件都算被它覆盖）。补边脚本逻辑见 `docs/issues.md` 的 B61 条目；补回的边一律 `weight 0.5`、`direction forward`，并给生产节点打 `tested` 标签。
3. **当前无孤立节点（0 个）**：上一版曾把 `.understand-anything/` 的 `.understandignore` 与 `config.json` 记为"仅有的两个孤立节点"，本轮重建后二者各有 `related` 互链边、且各有一条来自 `AGENTS.md` 的 `documents` 边，已不再孤立（`layers` 里 `layer:config` 恰好也是这两个 + `package.json`）。校验脚本会把"无任何边的节点"列为 warning，重建后应为 0。
4. **两套"知识图谱"，不要混淆**：
   - `.understand-anything/knowledge-graph.json` — 本文档描述的**工具生成全图**（278 节点），机器消费、可增量更新；
   - `docs/knowledge-graph/` — **手工维护的架构讲解图**（73 节点，提交入库，供人浏览），配套 `viewer.html` 双击可开。**修改 `docs/knowledge-graph/knowledge-graph.json` 后必须跑 `node tools/build-graph-data.mjs`** 重新生成 `graph.data.js`（该脚本会做引用完整性/孤立节点校验，失败即退出非零）。其边 schema 是 `from`/`to`，与工具图谱的 `source`/`target` 不同。
5. **API 响应不做统一信封**：`server.js` 把 handler 的返回值**原样** `sendJson`（`server.js:350`）——`GET /api/storyboards` 返回**裸数组**，`POST /api/storyboards` 返回裸 `{inserted}`；只有部分 handler 自己返回 `{ok, data}`（如 `/api/health`、`/api/settings/test`）。**同族端点的形状也可能不同**：`GET /api/videos` 是裸数组，而 `POST /api/videos` 是 `{ok, asset, timed_out}`——id 在 `data.asset.id` 而非顶层（第 58 轮写下载契约时即栽在此，404 全因取错字段）。写断言前先确认形状，别默认 `res.data.*`；另注意查询参数名以 handler 读取的为准（分镜列表是 `episode`，写 `episode_number` 会被**静默忽略**）。
6. **`cdp.eval` 的求值规则（写测试必读）**：body **不含 `;`** 时自动包成 `return (body)`；含 `;` 时包成 `(async function(){body})()`。所以写显式 `return X` 的 body **必须带分号**，否则变成 `return (return X)` → SyntaxError；而 `waitFor` 会吞掉该异常，表现为**静默超时**（第 63 轮即栽在此：`return !!document.querySelector('.page')` 无分号，排查了一轮）。裸表达式写法（不带 `return`）最安全。
7. 大版本架构变化（如新增子目录模块、拆分 routes）后，若未及跑 `/understand`，至少手工修订上文层表与本节事实，图谱与文档以代码为准。
