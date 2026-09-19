# AGENTS.md

面向 AI Agent 的项目工作指南。核心内容：如何**自动感知、查询、更新**本仓库的知识图谱。

## 项目速览

Agnes 漫剧工坊 · 本地版（`agnes-studio`）：本地优先、零云端数据库依赖的 AI 漫剧制作工作台。
Node.js ≥ 20.6 **原生模块实现、零 npm 依赖**；入口 `node server.js`（监听 127.0.0.1:5178），前端为 `public/` 下 vanilla JS ESM（无构建步骤），支持 Node SEA 单文件 Windows exe。数据持久化在本机 `data/`（JSON 文件）。

- 后端链路：`server.js` → `lib/routes.js`（全部 /api 端点）→ `lib/agnes.js`（Agnes 云 API 客户端）→ 外部 API；异步任务链 `lib/jobs.js` + `lib/poller.js`（后台轮询 + SSE 推送）；持久化基石 `lib/store.js`；原著解析纯函数层 `lib/story.js`（切块/卡片规范化/跨块去重合并/回注渲染，全部可离线断言）
- 原著解析（批 8）：`docs/research/09-story-bible-plan.md` —— 长篇原文 → 六类卡片（信息卡/人物卡/地点卡/道具卡/剧情卡/时间线），分块 map + 全局 reduce，`/api/story/*` 提供干跑计费闸门、卡片 CRUD、回注渲染与"人物卡入资产库"反向驱动
- 一致性体检（批 8 补 3）：`GET /api/story/audit` **纯本地判定**（同名卡 / 别名撞名 / 缺可注入字段 / 人物卡未入资产库 /
  剧情卡无幕次 / 时间线无时间点），**一次模型都不调**所以随时可跑、不花钱；`POST /api/story/audit/fix` 一键收敛三件机械事
  （合并同名卡 / 删撞名别名 / 人物卡入资产库），合并时**同步把分镜绑定改指到存活卡**（否则镜头会静默失去场景/道具注入）；
  需要人拍板的（两处描述哪个对）只如实列出冲突值，不替用户决定。原著页卡片工作台有体检入口与报告面板。
  **体检也覆盖镜头侧**（批 8 补 5）：漏绑（提到了却没绑档案）/ 绑了但角色未锁定（按既定语义不会注入外貌）。
  体检项的 `fixable` 是布尔、**修复动作码另在 `fix_code`**（问题码 ≠ 动作码，界面必须发 `fix_code`）。
  另有 `shot_char_unknown`（批 8 补 6）：「出场人物」里角色库中没有的名字 —— 这类镜头一定没有外貌注入，
  是角色名册的验收环（名册生效后应一直为空）。
  以及 `shot_style_baked`（批 8 补 7）：提示词里**写死的画风词**（词表 `STYLE_WORDS` 与 `ART_STYLE_MAP` 的值同源，
  selftest 有跨文件棘轮）—— 画风是使用点统一注入的，写死会让"改画风"静默失效；一键删词（只删词，画面描述不动）。
  **返回体既有分组字段（`card_issues`/`shot_issues`/`style_issues`）又有合并后的 `issues`，面板渲染的是 `issues`**
  —— 断言要落在界面真正消费的字段上（对照 AC 的教训）。
- 反向驱动（批 8 补）：卡片 → **资产库**（人物卡幂等入 `characters`，拿到参考图与分镜注入能力）、→ **故事脚本模板变量**（原著页「带入剧本」跳 `#/scripts?...&bible=<id>&kinds=...`，`pickBibleVar` 按变量名落位、提示条可见可撤销）、→ **剪贴板**（任意类别一键复制回注文本）
- 镜头绑定自动匹配（批 8 补 5）：`POST /api/storyboards/auto-bind` —— 把模型写在自由文本里的"谁出场/在哪儿"
  变成结构化绑定（`character_ids` / `story_card_ids`），**纯本地匹配、不调模型**。两档置信度：
  名字出现在「出场人物」里=强（可自动绑），只在提示词/画面描述里出现=弱（只报给人看）；名字长度 <2 不匹配。
  生成分镜后自动跑一次（`strong_only`），分镜页「自动匹配绑定」先干跑弹确认再落库；绑定是**并集**（不抹人工绑定）
- 提示词注入边界（批 8 补 6/补 7）：**由系统在使用点注入的东西一律不写进提示词** —— 画风（`artStylePhrase`）、
  人物长相（`characterPhrase`）、中文人名（名字进提示词会让未锁定角色被跳过）。三条禁令同时写在"分镜生成"与
  "补图片/视频提示词"两条 LLM 链里；检测侧分别由 `shot_style_baked` 与 `shot_char_unlocked` 兜底
- 角色名册（批 8 补 6）：生成剧本/分镜时把项目角色名册（`consts.js` 的 `characterRoster`：本名 + 别名 + 一行长相）
  写进**请求体**，并要求"用本名、不要自己另起名字"——模型不知道项目里有哪些角色，否则"女主/少女/本名"混着写，
  绑定全落空、谁都没有外貌注入。**长相不进提示词**（使用点会注入一次，写两遍会打架；且名字出现在提示词里会让
  未锁定角色被 `characterPhrase` 跳过）。检测侧：体检的 `shot_char_unknown`（角色库里找不到的名字，泛称有停用词表）
- 分集大纲骨架（批 8 补 4）：`GET /api/story/episodes` —— 剧情卡按**原文出现顺序**排成拍子，按幕次（起/承/转/合）
  **收口切成集**，产出"全剧设定 + 全剧时间线 + 每集拍表 + 切分说明"。与体检同一条纪律：**纯本地、一次模型都不调**，
  所以"每集至少几拍"可以反复调而不花钱（`perEpisode` 是**下限**，硬上限为下限 ×2，单幕过长会强行切开并如实上报）；
  原著页「分集大纲」面板可重切/复制/带入，带入复用 `applyBible` 的 `outline=<每拍数>` 载荷（落位走 `pickBibleVar` → 本集大纲）
- 逐集生成与前情提要（批 8 补 8）：`GET /api/story/episode-brief` 按集返回**本集拍表 + 前情提要**（纯本地，
  与体检/分集同一条纪律：一次模型都不调，所以反复重生成不花钱）；前情超预算从**最早**的一端丢（越近越相关）
  并如实上报省了哪几集。故事脚本页「分集」卡：载入第 N 集大纲 → 带前情 → **逐集生成**（先确认集数与调用次数 →
  一集一次调用 → 生成完**立刻按集落库** → 中途失败只记这一集继续走 → 可取消）。剧本记录带 `episode_number`
  （坏值落回 0 = 全剧/未指定），已保存列表按它标「第 N 集」
- 逐集生成分镜（批 8 补 9）：至此"原著 → 卡片 → 分集骨架 → 逐集剧本 → **逐集分镜**"全链路闭环，中间不用人工搬文本。
  分镜页「逐集生成分镜」按已保存的分集剧本（`episode_number`）逐集生成：先确认调用次数、失败只丢这一集、可取消、
  **已有分镜的集默认跳过**（跳过判据必须按**整部剧**统计 —— 页面上的 `rows` 只有当前集，拿它判断别的集永远得到
  "没有"，重跑就会把那些集翻倍）。**"一段脚本 → 某一集分镜"只有一个实现** `shotsFromText(text, ep)`：
  单集生成与逐集生成共用同一份提示词与字段映射，改错一处两条路一起红（对照 AG）
- 追加解析与归并 id 稳定（批 8 补 10）：`POST /api/story/append` 只对**新增章节**分块调用模型
  （块号接着已有的往后排，否则新卡的 `evidence` 会指向旧章节），同名卡只补字段/并别名/累计出现次数，
  **已有卡一张不删、id 不变**（删卡会让分镜绑定悬空）—— 长篇连载因此不必为前面几十万字反复付费。
  归并落库用 `applyBibleCards` **按 kind+名字就地 upsert**（不是"删光重建"）：替换语义保留（这次结果里没有的
  旧卡才删、order 听新结果），但 id 稳定 —— 原来每次归并都换一批 id，绑定与界面状态全指向不存在的卡。
  `mergeAppend` 直接给出 `touched`/`fresh` 两份名单，调用方不必按块号"猜"哪些卡被改动了
- 人物卡 ↔ 资产库漂移（批 8 补 11）：人物卡是"原著里读到的这个人"，资产库那份角色是"出图时**真正注入**的长相"，
  复制过去之后各走各的（追加解析补全了卡，库里还是旧样子）—— **界面显示新描述、出图用旧长相，没有任何报错**。
  `story.auditCharacterDrift` 纯函数体检（并进 `/api/story/audit` 的 `drift_issues` 与面板渲染的 `issues`），
  **只看会注入提示词的字段**（外貌/服饰/别名：`characterPhrase` 与名字匹配真正用到的；把 role/personality 算进来
  会让每张卡都报，面板会被无视）；空字段 → `info`（纯补全），非空且不同 → `warn` 并逐条列出"库值 → 卡值"。
  `sync_character` 一键同步：只写外貌/服饰/别名，**绝不碰** role/gender/age/personality（用户可能特意改过），
  并在 `notes` 留痕
- 剧本/分镜过期体检（批 8 补 12）：生成要花钱、输入却会变（追加解析补全剧情卡 / 重切分集 / 人工改正文），
  于是"看起来好好的、其实跟原著对不上"的剧本会静默留下。剧本记生成时的**输入指纹**（本集拍表 + **前情提要**，
  由 `episodeInputDigest` 在服务端算、`/api/story/episode-brief` 直接返回，前端只搬运），分镜记**来源剧本 id +
  其正文指纹**（服务端按入库那一刻的正文算，前端不参与哈希）。`GET /api/story/staleness` **纯本地**逐集判定：
  `ok` / `stale` / `unknown`（没有指纹）—— **`unknown` 既不能当"没问题"也不能当"该重生成"**，单独计数、
  不计入重生成。精确性是省钱的关键：**往后追加章节不该让前面的集报过期**（拍表与前情都没变）。
  故事脚本页「过期体检」按钮 + 逐集生成的**默认范围收窄成"缺剧本或已过期"的集**。
  **分镜页的「逐集生成分镜」也用上了它**（批 8 补 15）：那个弹窗默认跳过"已有分镜的集"，
  而**源剧本改过的集恰恰有分镜** → 会被永远跳过（剧本改了、分镜还是旧的，越点越放心 —— **防护变成陷阱**）。
  现在过期集**不跳过**、弹窗点名"哪几集剧本内容改过"、并默认勾上"过期分镜先清空再重生成"
  （清空走 `DELETE /api/storyboards?project_id=&episode=`，服务端强制两个参数都给，避免跨项目误删），
  汇总里如实报出"替换 N 个过期镜头"（删了又生成必须看得见）
- 全链路进度体检（批 8 补 16）：七段链（原著 → 卡片 → 分集骨架 → 剧本 → 分镜 → 图 → 视频）各自在**不同页面**上，
  用户想知道"卡在哪一步、下一步点哪儿"必须自己拼；半成品状态（解析完卡片没分集 / 3 集骨架只写 2 集 /
  20 个镜头只出 5 张图）都不是错误，但都需要有人说话。`GET /api/story/pipeline` 一次给全
  （**纯本地统计、一次模型都不调**，与体检/分集/过期判定同一条纪律），工作台画成一条链 + **直达下一步**按钮（带项目 id）。
  `blocked`（前置没做，点进去也做不了）与 `todo`（轮到你了）**严格分开** —— 混成一个"待办"，
  用户会照着点却发现按钮是灰的；`partial`（做了一半）也是独立状态（只看"有没有"不看"够不够"会误报 done）。
  分母口径按**集**去重（同一集重生成存多条，按条数算会虚高），出图段的 need 是**镜头数**（不是"有没有分镜"）
- 地点卡/道具卡参考图进出图输入（批 8 补 17）：人物卡有资产库（批 8 补 13 已接进出图），地点/道具卡却只有一行文字
  → **同一个场景每张图都不一样**，且没有任何报错（与补 13 是同一类"存下来 ≠ 用上了"）。
  地点卡/道具卡可就地挂参考图（多选缩略图，`CARD_IMAGE_KINDS = ['location','prop']`，前后端同源有 uitest 同构钉），
  出图时自动带上；顺序固定 **显式 → 角色 → 场景道具**（总上限 4 张时**先保脸** —— 脸比景更难靠文字说准），
  被上限挤掉的（`dropped`）与本地抓不到的（`local_skipped`）都如实上报，批量入口的预检也覆盖两类来源。
  **`normalizeCard` 故意不产出 `reference_image_ids`**：归并落库走 `store.update`（Object.assign 合并），
  键不在 patch 里就保留；一旦在字段缺失时吐一个 `[]`，重新解析/追加解析就会把用户挂的图**静默清空**
  （selftest 钉死的是"形状"而不是"值"，对照 BG）
- **413 超限路径的正确收尾**（批 8 补 16 真修）：`res.on('finish', () => req.destroy())` 发的是 **RST**，
  客户端内核会把还没被应用读走的接收缓冲一并丢掉 —— 已送出的 413 响应体也可能被冲掉，
  客户端只看到 `ECONNRESET`，前端把"文件过大"误报成网络错误。正确做法：请求没收完时先 `req.resume()` **排干**，
  让连接以正常 FIN 收尾，同时留 5s 上限（不停手的客户端才断流，DoS 边界不变）
- 角色参考图进出图输入（批 8 补 13）：`characters.reference_image_ids` 是"同一张脸"的**最强约束**，
  但此前只被角色库页当封面显示、**从来没进过出图调用** —— 用户传了参考图、勾了角色，出图仍是全新的脸，
  且没有任何报错。现在出图时自动取**绑定角色**的参考图作为上游 `image` 输入（`characterRefImages`，
  与画风/长相/运镜同一条"使用点注入"纪律，入库的 `image_prompt` 仍只存镜头内容）；
  **只有公网 http(s) URL 才算数**（本地 `/assets/…` Agnes 抓不到，与图生视频同一判定），
  用不上几张**如实上报**（`reference_images.local_skipped`），批量入口在**花钱之前**预检告知；
  上限 4 张（多了互相打架也拖慢生成），且 `used` 必须等于**实际发出**的张数；
  `generation_tasks` 记的是**实际发出**的输入（记 `body.image` 就查不到自动带上的参考图）
- 负面提示词进出图提示词（批 8 补 14）：分镜行一直带 `negative_prompt`（默认 `low quality, blurry, distorted face`），
  **视频用了它、图片链却完全没读** —— 界面看得见、出图时被静默丢掉。措辞收敛成**一份实现**
  `story.negativePhrase`（图片链 / 视频 2.5 系 `v25Body` / 前端"实际发出"预览三处同源，uitest 有同构钉）；
  图片链从**分镜行**取（显式传的优先，与运镜/角色/卡片同一口径）并入正向提示词发出，
  **绝不单发 `negative_prompt` 字段** —— 网关对未知字段硬拒（实测 `negative_prompt is not an allowed request field`，
  单发会让整条出图链 400）；空/空白/undefined 一律视为没填（否则会发出空尾巴"避免出现："）。
  apitest 的 mock 网关也**同样严格拒未知字段**（此前照单全收，导致"单发不合法字段"这类错误在测试里看不见）
- 使用点注入链（`lib/routes.js` 的 `finalPrompt`）：内容 → **原著场景道具**（地点卡/道具卡）→ 角色 → 运镜 → 画风 → 变体；
  前端的 `storyCardPhrase` / `characterPhrase` 是**逐字同构**的镜像（uitest 去空白比对钉），分镜页的"实际发出"预览靠它算
- 前端链路：`public/index.html` → `public/js/app.js`（壳层/hash 路由）→ `public/js/pages/*`（11 个页面模块，含批 8 新增的 `novel.js` 原著解析工作台）；共享设施 `api.js` / `ui.js` / `consts.js` / `textstats.js`（纯函数：长文本计数与生成门禁判据） / `pages/helpers.js`
- 测试：`tools/` 下四套断言脚本（selftest 604 / apitest 786 / uitest 1008 / browser-test 451），`node tools/run-all.mjs` 全量跑；另有 `node tools/ui-audit.mjs`（真机布局/对比度/截断提示度量报表；4 视口 × 12 页，其中 7 页带**弹窗动作钩子**、2 页带**内联面板动作**，两者都有"声明了动作就必须有产出"的自检，内联钩子用 `box` 指定看哪个容器）与 `node tools/port-check.mjs`（端口撞车防护三场景 6 断言真机验证：含预检环境冲突与收尾无残留自检；exit 0 全过 / 1 违例 / 2 环境冲突），均按需跑、非门禁。
  **页面模块的签名约定**：必须 `export default async function xxx(container, params)` —— 首参是 router 已挂进文档的容器（`app.js` 调 `nav.page(page, params)`）。自己 `createElement` 一个容器再往里写，DOM 不在文档里，表现为**切页白屏且控制台零报错**（批 8 的 `novel.js` 就这么白过一次，uitest 已加棘轮钉死签名形状）
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
⚠️ **批 8 之后图谱已失真，待重建**：锚点之后新增 4 个文件（`lib/story.js`、`public/js/pages/novel.js`、
`public/js/storyfile.js`、`docs/research/09-story-bible-plan.md`）与十余个 `/api/story/*` 端点，
下表的节点/边数与层表数字**仍是锚点时的值**（55 个文件级节点）；对锚点之前就存在的文件，查询结论仍然可靠。
重建前请先跑 `/understand`（增量即可，但它按批次重分析，会顺带重跑分层与导览）。
扫描范围 = `git ls-files` 减去 `.understandignore` 里的排除项（工具自身的 `knowledge-graph.json` / `fingerprints.json` / `meta.json` / `intermediate/` / `tmp/` / `.trash-*` 一律排除：它们是被分析对象的产物，且体积最大）。

**重建的代价与做法（第 85 轮实测，动手前必读）**

- **"增量"在这里约等于全量**：锚点之后的改动文件横跨**全部 7 个批次**（批 1 有 `app.js`/`consts.js` 与两个新页面模块、
  批 2 三个前端文件全动、批 3 `store.js`、批 4 `AGENTS.md`、批 6 两份研读文档、批 7 `routes.js`/`jobs.js`/`seed.js`/四套测试）。
  `compute-batches.mjs --changed-files` 会把 7 批全部选进来 —— 不要指望"跑一下就好"。
- **语义内容是人工撰写的，不是子代理批产的**：上一版（R30/B61）的做法是每个批次写一个生成器脚本
  `tmp/gen-batch-<N>.mjs`：机械边（`contains`/`exports`/`imports`/`depends_on`/`tested_by`）由脚本从
  `extract-structure.mjs` 的产物确定性生成，**语义内容（`summary`/`tags`/`complexity`/`languageNotes`）与 `calls` 边
  是逐条审读源码后手写的**。全图 220 个函数节点都是这么来的 —— 这是重建真正的成本所在，也是它不能"顺手跑一下"的原因。
- **上一版的中间产物还在本机**（`.understand-anything/.trash-<时间戳>/`，**已被 .gitignore 忽略**，随时可能被清掉）：
  `batch-*.json`（输出 schema 样例）、`batches.json`（文件→批次映射）、`tmp/ua-file-extract-results-<n>.json`（机械提取）、
  `tmp/ua-batch-input-<n>.json`（批次输入）、`tmp/gen-batch-<n>.mjs`（**可复用的生成器模板**）、`layers.json` / `tour.json` /
  `assembled-graph.json`。**动手重建前第一件事：先把这些拷到安全位置**，否则等于从零开始。
- **推荐路线**：① 拷走 `.trash-*` 的 `tmp/` 与 `batches.json`；② 按批（一轮一批，别一次全做）拿 `gen-batch-<N>.mjs`
  作模板，只改**新增文件与改动函数**的语义块，重跑生成 `batch-<N>.json`；③ `merge-batch-graphs.py` 合并；
  ④ 合并后**手工补回 `tested_by`**（见注意事项 2，补完不要再跑合并脚本）；⑤ 重跑分层与导览（`layers.json`/`tour.json` 同 schema）；
  ⑥ 用 SKILL.md 里的内联校验脚本（`tmp/ua-inline-validate.cjs`）验完再写 `knowledge-graph.json` + `meta.json` + `fingerprints.json`，
  ⑦ 最后连同代码改动一起提交。

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
| `layer:frontend-pages` | 前端页面层 | 11 → **12**（批 8 新增 `public/js/pages/novel.js` 原著解析工作台） |
| `layer:frontend-shell` | 前端壳层与共享模块 | 7 → **8**（批 8 新增 `public/js/storyfile.js`：文件准入 + 文本规范化纯函数层） |
| `layer:backend-api` | HTTP 接口与路由层 | 2 |
| `layer:backend-service` | 后端服务层（agnes/jobs/poller） | 3 |
| `layer:data-persistence` | 数据持久化层（store/seed） | 2 → **3**（批 8 新增 `lib/story.js`：原著解析纯函数层，与 store/seed 同属"无 IO 的领域内核"） |
| `layer:test` | 测试层（tools/ 四套断言测试 + run-all + ui-audit 度量 + port-check 端口防护验证） | 7 |
| `layer:build-tooling` | 构建与代码生成工具（build-exe / build-graph-data） | 2 |
| `layer:documentation` | 文档、竞品研读与静态图谱查看器（docs/、AGENTS.md） | 18 → **19**（新增 `docs/research/09-story-bible-plan.md`） |
| `layer:config` | 项目配置 | 3 |

层内文件节点合计 55（锚点）→ **59**（批 8 后，待重建确认）= 图谱文件级节点总数（校验脚本会强制：每个文件级节点**有且只有一个**归属）。

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
2. **`tested_by` 必须手工补回（每轮重建都要做）**：本项目测试脚本在 `tools/` 下叫 `selftest/apitest/uitest/browser-test`（非 `*.test.*` 约定命名），而合并脚本 `merge-batch-graphs.py` 的 `is_test_path()` 对 JS 只认 stem 以 `.test`/`.spec` 结尾 —— 于是**所有** `tested_by` 都被判成"生产↔生产"丢掉，且它的路径约定补链（Pass 2）也一条补不出来。当前图里的 **22 条**是重建后逐对**按源码证据**复核补回的（证据 = 测试脚本正文里出现被测算文件的完整相对路径，或唯一 basename；例如 `tools/uitest.mjs` 用 `readdirSync('public/js/pages')` 动态列举并逐文件断言，故**每个**页面文件都算被它覆盖，批 8 之后是 11 个）。补边脚本逻辑见 `docs/issues.md` 的 B61 条目；补回的边一律 `weight 0.5`、`direction forward`，并给生产节点打 `tested` 标签。
3. **当前无孤立节点（0 个）**：上一版曾把 `.understand-anything/` 的 `.understandignore` 与 `config.json` 记为"仅有的两个孤立节点"，本轮重建后二者各有 `related` 互链边、且各有一条来自 `AGENTS.md` 的 `documents` 边，已不再孤立（`layers` 里 `layer:config` 恰好也是这两个 + `package.json`）。校验脚本会把"无任何边的节点"列为 warning，重建后应为 0。
4. **两套"知识图谱"，不要混淆**：
   - `.understand-anything/knowledge-graph.json` — 本文档描述的**工具生成全图**（278 节点），机器消费、可增量更新；
   - `docs/knowledge-graph/` — **手工维护的架构讲解图**（73 节点，提交入库，供人浏览），配套 `viewer.html` 双击可开。**修改 `docs/knowledge-graph/knowledge-graph.json` 后必须跑 `node tools/build-graph-data.mjs`** 重新生成 `graph.data.js`（该脚本会做引用完整性/孤立节点校验，失败即退出非零）。其边 schema 是 `from`/`to`，与工具图谱的 `source`/`target` 不同。
5. **API 响应不做统一信封**：`server.js` 把 handler 的返回值**原样** `sendJson`（`server.js:350`）——`GET /api/storyboards` 返回**裸数组**，`POST /api/storyboards` 返回裸 `{inserted}`；只有部分 handler 自己返回 `{ok, data}`（如 `/api/health`、`/api/settings/test`）。**同族端点的形状也可能不同**：`GET /api/videos` 是裸数组，而 `POST /api/videos` 是 `{ok, asset, timed_out}`——id 在 `data.asset.id` 而非顶层（第 58 轮写下载契约时即栽在此，404 全因取错字段）。写断言前先确认形状，别默认 `res.data.*`；另注意查询参数名以 handler 读取的为准（分镜列表是 `episode`，写 `episode_number` 会被**静默忽略**）。
6. **`cdp.eval` 的求值规则（写测试必读）**：body **不含 `;`** 时自动包成 `return (body)`；含 `;` 时包成 `(async function(){body})()`。所以写显式 `return X` 的 body **必须带分号**，否则变成 `return (return X)` → SyntaxError；而 `waitFor` 会吞掉该异常，表现为**静默超时**（第 63 轮即栽在此：`return !!document.querySelector('.page')` 无分号，排查了一轮）。裸表达式写法（不带 `return`）最安全。
7. **`ui.js` 的 `dataOf` 是字面取属性**（`el.getAttribute('data-' + name)`）：写 `dataOf(el, 'delCard')` 去读
   `data-del-card` 会拿到 `null`，而且**不报错**，表现为"按钮点了没反应"。批 8 下的卡片删除与批 8 补 3 的体检修复
   各踩一次。uitest 已有通用棘轮逐页比对"每个 `dataOf` 读的名字都被渲染过"；新增 `data-*` 交互一律写**连字符原名**。
   同类陷阱：`on(root, sel, type, fn)` 是 `querySelectorAll` 逐个绑定（**不是事件委托**），
   在 `innerHTML` 替换**之前**绑的监听会随旧节点一起消失——先渲染、后 `on`。
8. **测试里"重新导航"必须真的重来**（两类都要小心）：
   ① **同页同参**：页面已停在 `#/storyboards?project=X&episode=7` 时，**再设一次同样的 hash 不会触发路由**
   （浏览器不发 `hashchange`），页面继续用旧数据 —— 要 `cdp.send('Page.reload', {})` 再等**数据行**出现；
   ② **用 API 现建的项目不在壳层 `state.projects` 里**：路由会判"链接指向的项目不存在"并**切到别的项目**，
   于是后面所有断言都在另一个项目上跑（第 90 轮为此白跑了两轮调试）。新建项目后同样要 `Page.reload`。
   同理：静态按钮（如 `#gen-img-prompts`）先于数据渲染，等待条件要等"行/数据"而不是等按钮，
   否则点下去只会得到"没有需要补充的镜头"（第 89/90 轮都踩到）。
9. **共享前端模块（`api.js`/`consts.js`/`ui.js`）改一行要过真机**：`api.js` 被所有页面 import，
   往函数体里插错一行 → 整个壳层**白屏**，而 selftest/uitest（文本断言）全绿、`node --check` 也过；
   引用不存在的助手（如 `api.js` 里并没有 `qs`）更是只在运行时抛，页面表现为"按钮点了没反应"。
   两类都只有 browser-test 抓得到（后者靠 `window.__uiRejects`）。uitest 已加"api.js 能 import"的语法棘轮，
   但它挡不住第二类 —— 结论不变：**共享模块的改动必须过真机**。
10. 大版本架构变化（如新增子目录模块、拆分 routes）后，若未及跑 `/understand`，至少手工修订上文层表与本节事实，图谱与文档以代码为准。
