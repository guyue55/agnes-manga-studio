# 源码研读 · 08-04：Vibex「小说章节转漫剧剧本工具」（React+TS+Vite 源码导出包）

> 研究对象（**只读**，未修改任何文件）：
> `/Users/apple/Project/Git/Webeye-Video/docs/AI创作资料/08-AI创作项目源码/ai-remix-7e856295-小说章节转漫剧剧本工具/`
> 对照对象（下称「我们」）：`/Users/apple/Project/Git/agnes-manga-studio/`（本地版，`server.js` + `lib/*.js` + `public/` vanilla ESM，10 页）
> 交叉参考：`docs/research/ui-other-competitors.md`（N2S 托管版）、`docs/research/ui-our-baseline.md`（我们的 UI 基线）
> 证据格式：本包内引用相对包根（如 `src/pages/Home/useHome.ts:6`）；我们仓库引用相对仓库根。
> 行号均为本次逐行读码所得；不确定处显式标注「未确认」。

---

## 0. 先说一个身份校正（影响第 9/10 节的对照口径）

任务描述把本包视作 N2S 的「源码版」。**证据不支持这个等同**，本包是同一平台/同一作者系列里的**另一个 app**：

| 维度 | 本包（源码导出） | N2S（`ui-other-competitors.md` 分析对象） |
|---|---|---|
| app id / 导出名 | `app-adf1237850a54f88856ef2c17e856295`；导出名 `ai漫剧剧本编辑自动将小说章节转换成剧本穿越系统感情背叛 (Remix)`（`vibex-local/export-manifest.json`、`.env.local.example`） | `app-20e3fe7d787f41a682421e999065c06a`；页面 title 即生成提示词原文（未命名）（`reference/novel2storyboard-vibex/MANIFEST.md`） |
| 流程 | **2 段式**：粘贴 → 确认人物主线 → 选风格 → 出剧本（`src/pages/Home/HomePage.tsx:13-15`） | 4 主步 + 2 旁挂：原文→脉络→角色→分镜→资产库→视频词（competitors §1.1） |
| 风格字典 | 5 款（`src/pages/Home/useHome.ts:20-26`） | 12 款（competitors §3） |
| 产出物 | 纯文本剧本（无导出器，`src/components/home/ScriptPanel.tsx:61`） | 五件套导出（TXT/CSV/MD/资产 TXT/JSON） |

**结论**：本包的价值不是「N2S 的内部实现」，而是**同一平台脚手架的源码级样本**——它把 `ui-other-competitors.md` 只能从 minified bundle 里字节 offset 反推的平台层（`runWithCostConfirm`、`callLlmWithFallback`、`rhLogin`、pb_hooks LLM 中转）以**可读 TS + 注释**完整暴露出来。第 6/8 节的平台层结论因此比反混淆得到的更硬；产品层结论则只适用于本包这个 2 段式 app。

---

## 1. 一句话定位与技术栈

**定位**：单页、无项目库、无持久化的「小说章节 → 漫剧剧本」一次性转换器；核心产品主张是**「先抽取确认、再生成」**——把 LLM 的隐式理解变成用户可改的中间产物，再拿确认后的产物去跑长文本生成。

| 项 | 事实 | 证据 |
|---|---|---|
| 路由数 | **1 个真实路由**：`/` 与 `*` 都渲染 `HomeRoute` | `src/App.tsx:6-9` |
| 页面数 | **1 个页面**：`pages/Home/`（`index.tsx` 只做 hook 注入，`HomePage.tsx` 纯展示，`useHome.ts` 全逻辑） | `src/pages/Home/index.tsx:4-6` |
| ts/tsx 文件数 | **32**（`find src -name "*.ts" -o -name "*.tsx" \| wc -l`），共 3,980 行 | 统计命令见文末 |
| 状态管理 | **无状态库**：全部 `useState` + 一个 `PagePhase` 字符串状态机；跨页无状态 | `src/pages/Home/useHome.ts:28,82-92` |
| UI 库 | **shadcn/ui 风格手抄组件**（`components.json` `style:"default"`、`baseColor:"slate"`、`cssVariables:true`）+ Radix 原语 + lucide-react 图标 + Tailwind 3.4；实装组件仅 9 个（button/card/input/textarea/badge/select/dialog/tabs/scroll-area/tooltip） | `components.json:1-24`；`src/components/ui/*`；`package.json` dependencies |
| 路由库 | `react-router-dom@7`（`BrowserRouter basename={getBasename()}`，适配 VibeX 子路径部署） | `src/main.tsx:15`、`src/lib/pb.ts:22-24` |
| 后端接入 | **不是自建后端**：PocketBase + 平台注入的 `pb_hooks/llm.pb.js` 提供 `POST /api/llm/chat`、`POST /api/llm/poll`、`GET /api/llm/models`；前端经 `/__pb` 代理访问 | `pocketbase/pb_hooks/llm.pb.js:4-7,61-83,259`；`src/lib/pb.ts:14-17` |
| 模型 | **只允许 1 个**：`qwen3.7-max`（服务端 allowlist，前端常量同名） | `src/pages/Home/useHome.ts:7`；`pocketbase/pb_hooks/llm.pb.js:30` |
| 鉴权 / 计费 | RunningHub 登录态（沙箱域 scoped token → `X-Vibex-Scoped-Token`），非本项目自有账号；每次付费调用前置 `runWithCostConfirm` 弹窗 + 「今天内不再提醒」localStorage 抑制 | `rhLogin.ts:26-37,140-145`；`useCostConfirm.ts:43-54`；`costConfirm.ts:16-39` |
| 构建 | Vite 8 + TS 6 + `@vitejs/plugin-react`（oxc）；`vite.config.ts` 内联 `rhSourcePlugin` 给每个 JSX 打 `data-rh-src` 供在线可视化编辑 | `vite.config.ts:19-66` |

---

## 2. 信息架构与页面流

### 2.1 单页三段式（同一页面纵向展开，用 phase 控制显隐）

```
HeroIntro(三步骤说明) ─▶ NovelInput(粘贴章节) ─[分析章节]─▶ 费用确认弹窗
   ─▶ ExtractConfirmCard(第二步·确认人物与主线，可增删改) ─▶ StylePicker(第三步·选世界风格)
   ─[生成完整剧本]─▶ 费用确认弹窗 ─▶ ScriptPanel(剧本出炉·在线细改 / 一键复制剧本)
```

- 显隐门（整个 IA 的实现核心，只有 3 行）：`showExtract = phase !== "idle"`；`showStyle = phase === "confirming" || "generating" || "done"`；`showScript = phase === "generating" || "done"`（`src/pages/Home/HomePage.tsx:13-15`）。
- 三段标题原文：「第一步 · 粘贴小说章节」（`NovelInput.tsx:24`）、「第二步 · 确认人物与主线」（`ExtractConfirmCard.tsx:45`）、「第三步 · 选世界风格，生成剧本」（`StylePicker.tsx:21`）。
- 顶部英雄区三步骤卡：「粘贴原文 / 确认人物主线 / 选风格出剧本」（`HeroIntro.tsx:3-7`），角标文案「零基础也能写漫剧」（`HeroIntro.tsx:12-14`），页脚「漫剧编剧室 · 粘贴章节 → 确认人物主线 → 选风格出剧本」（`HomePage.tsx:108-110`）。

### 2.2 关键按钮与文案原文

| 位置 | 文案 | 证据 |
|---|---|---|
| 主 CTA（第一步） | 「分析章节」/ busy 时「正在分析章节…」 | `NovelInput.tsx:52-62` |
| 第一步辅助说明 | 「点「分析章节」后，会先提取人物和主线给你确认，不会直接生成剧本。」 | `NovelInput.tsx:43-45` |
| 第二步说明 / 新增 | 「名字、身份、主线都可以直接改，删掉不想要的、补上漏掉的，确认满意再往下走。」；「加一个人物」（虚线描边胶囊） | `ExtractConfirmCard.tsx:47-49`；`:79-86` |
| 第三步说明 / 主 CTA | 「挑一个你想要的味道，剧本的整体基调会跟着它走。」；「生成完整剧本」/ busy「剧本生成中…」 | `StylePicker.tsx:23`；`:56-66` |
| 结果区标题 / 动作 | 「剧本出炉 · 在线细改」+「直接点进文字里改，改完复制走就能用（N 字）」；「重新生成」「一键复制剧本」/ 成功后「已复制到剪贴板」 | `ScriptPanel.tsx:36-37`；`:41-64` |
| 两处 loading 文案 | 「正在提取人物和主线…」+「章节越长越考验耐心，一般半分钟内就好」；「正在一口气写完整部剧本…」+「剧本比较长，大概要一两分钟，先去倒杯水吧」 | `ExtractConfirmCard.tsx:31-32`；`ScriptPanel.tsx:20-21` |

### 2.3 字数上限与校验（三层）

1. **硬上限常量**：`export const MAX_NOVEL_CHARS = 10000`（`useHome.ts:6`）。
2. **实时计数 + 红字超限提示**：`{charCount} / {MAX_NOVEL_CHARS} 字`，超限时整行变 `text-destructive`（`NovelInput.tsx:26-28`）；并追加「超过 10000 字啦，分析时会按前 10000 字处理，建议先精简一下再分析。」（`:37-41`）。
3. **提交时静默截断（不是拦截）**：`const source = trimmed.length > MAX_NOVEL_CHARS ? trimmed.slice(0, MAX_NOVEL_CHARS) : trimmed`（`useHome.ts:122`，生成剧本时同一逻辑在 `:189` 重复一次）。设计意图：**上限只保护 token 预算，不阻断用户**——与「先给用户看会怎么处理」的透明化取向一致。

### 2.4 校验与错误提示（逐条）

| 触发条件 | 提示原文 | 证据 |
|---|---|---|
| 空文本点分析 | 「请先粘贴一段小说章节再分析」 | `useHome.ts:104-107` |
| 少于 100 字 | 「内容有点短，请粘贴 100 字以上的章节，人物和主线才提取得准」 | `useHome.ts:109-112` |
| 未分析就生成 / 未选风格 | 「请先分析章节，确认人物和主线后再生成剧本」/「请先选择一个世界风格」 | `useHome.ts:174-177`；`:178-182` |
| LLM 失败 | `LLM_ERROR_ZH` 映射：`timeout`→「生成超时（可能服务器繁忙），请稍后重试」；`not_found`→「请求未能到达，请检查网络后重试」；`rh_login_required`→「RunningHub 登录态已过期，请在右上角重新登录后再继续」；`insufficient_balance`→「RunningHub 账户余额不足，请充值后重试」；兜底「生成失败，请重试」 | `useHome.ts:30-39` |
| JSON 解析失败 | 「分析结果没能识别出来，请稍后重试」 | `useHome.ts:141-144` |
| 登录态过期 / 通用错误 | 顶部红色横幅「RunningHub 登录态已过期，重新登录后就能继续」+「重新登录」按钮；通用错误横幅可 ✕ 关闭（`aria-label="关闭提示"`） | `HomePage.tsx:31-47`；`:49-63` |

---

## 3. 「先抽取确认、再生成」两段式交互（本包重点）

### 3.1 人物卡字段设计：**只有两个字段**

```ts
export interface CharacterInfo { name: string; identity: string }   // src/pages/Home/useHome.ts:9-12
```

- `name`：人物名字（Input，`sm:w-36` 定宽）；`identity`：**一句话身份与性格**（Input，`flex-1`），placeholder 原文「一句话身份与性格」（`ExtractConfirmCard.tsx:54-65`）；主线是独立字段 `mainPlot`（Textarea，`min-h-24 resize-y`，`:88-95`）。
- prompt 里的字段约束：`identity` **30 字以内**、`mainPlot` **100 字以内**（`useHome.ts:67`）；数量上限 **8 个**、按出场重要性排序（`:68`），前端硬闸 `.slice(0, 8)`（`:55`）。
- 设计意图（从字段名与 prompt 反推，属推断）：**字段越少，用户改得动**。没有 appearance/personality/scenes 拆分，identity 一句到底——直接牺牲了 N2S「appearance 贯穿三处回注」的一致性链（competitors §3），换来零门槛；本包也不做图像/视频，确实不需要外貌载体。

### 3.2 可在线编辑的交互实现

- **无编辑态切换**：每行人物 = 两个受控 `Input` 直接绑 `onChange`，没有「编辑/保存」按钮（`ExtractConfirmCard.tsx:52-76`）。
- 四个变更入口全是纯函数式 setState：`handleCharacterChange` → `prev.map((c,i)=> i===index ? {...c,[field]:value} : c)`（`useHome.ts:153-155`）；`handleRemoveCharacter` → `prev.filter((_,i)=>i!==index)`（`:157-159`）；`handleAddCharacter` → `[...prev,{name:"",identity:""}]`（`:161-163`）；`handleMainPlotChange`（`:165-167`）。
- 删除钮 a11y：`aria-label={`删除人物 ${role.name || idx + 1}`}`（`ExtractConfirmCard.tsx:71`）。
- 列表 `key={idx}`（`:53`）——用下标做 key，删除中间项会复用 DOM 节点；因全部受控且值来自 state，**视觉结果正确**，属有意的偷懒（未确认是否有意为规避重挂载）。

### 3.3 确认后如何拼进第二次生成

「确认」**没有独立按钮**——它是「选风格 + 点生成完整剧本」隐含完成的。第二次调用的 user 消息是**四段拼接纯文本**（`useHome.ts:199-212`）：

```
世界风格：{style.name}（{style.desc}），整体基调要贴合这个风格。

【已确认的人物】
{name}：{identity 或 "（身份待补充）"}     ← 每行一条，filter 掉 name 为空的

【已确认的主线】
{mainPlot}

【小说原文】
{source（已截断至 10000 字）}

请输出完整漫剧剧本。
```

- 人物行拼接见 `useHome.ts:190-193`——**空 identity 有兜底占位符而不是空字符串**，避免出现裸的「张三：」。
- **小说原文被完整回注**（`:208-209`），不是只喂摘要。这是两段式能成立的关键：抽取步骤只负责「让用户校准理解」，不负责压缩信息。
- `max_tokens: 12000`（`:216`），服务端 allowlist 里该模型上限是 16384（`pocketbase/pb_hooks/llm.pb.js:30`）。

### 3.4 如何避免用户改动丢失

| 机制 | 实现 | 证据 |
|---|---|---|
| **中间态常驻** | `ExtractConfirmCard` 在 `phase ∈ {confirming, generating, done}` 都保持挂载，只有回到 `idle` 才卸载 | `HomePage.tsx:13-14` |
| **生成期间不清空** | `handleGenerate` 只 `setPhase("generating")` + `setCopied(false)`，**不重置** `characters`/`mainPlot`/`styleId` | `useHome.ts:185-187` |
| **失败后回到 confirming** | 失败分支 `setPhase("confirming")`（不是 idle），编辑原地保留、可直接重试 | `useHome.ts:220,225` |
| **重新生成读到的是改后值** | `handleGenerate` 调用时**重新从 state 读** `characters`/`mainPlot`，不缓存闭包快照 | `useHome.ts:190-192` |
| **原文框生成期间禁用但不清空** | `Textarea disabled={busy}` | `NovelInput.tsx:35` |

**但有一处明确的数据丢失路径（无守卫）**：在 `confirming` 状态点回「分析章节」→ `handleAnalyze` 会 `setCharacters([])`、`setMainPlot("")`、`setScriptText("")`、`setStyleId("")`（`useHome.ts:117-121`），**先清空再请求**；若请求失败，手改的人物全部蒸发且无二次确认。

**且全包零草稿持久化**：`grep -rn "localStorage|sessionStorage" src/` 命中的 30 处**全部在 `lib/rhLogin.ts` 与 `lib/costConfirm.ts`**，`useHome.ts` 0 处；`grep -rni "draft|autosave|草稿"` 全包 0 命中。**刷新 = 粘贴的 1 万字 + 手改的人物全丢**。

---

## 4. 镜头提示输出：只有自然语言约定，没有结构化协议

这是本包与我们差距最大、也最容易被误读的一节。

- 剧本生成 system prompt 第 4 条原文：**「关键画面用【画面】给出镜头提示（景别、运镜、特效）；」**（`useHome.ts:77`）；第 1/2/3/5 条定义整体文本结构：剧名 `《》`、按「第N集」分集（每集 3-5 场景、「场景N」编号）、每场景先写 `【场景】地点＋时间＋画面氛围`（对白格式「人物名：（动作或神态）台词」）、每集结尾留悬念（`useHome.ts:74-79`）。
- **前端不做任何解析**：`scriptText` 直接 `setScriptText(r.text.trim())`（`useHome.ts:228`），渲染进一个可编辑 `Textarea`（`ScriptPanel.tsx:67-72`），只额外统计 `scriptText.length`（`ScriptPanel.tsx:37`）。展示方式：无高亮、无分集折叠、无镜头卡，就是一个 `min-h-96` 的 textarea（`:70`），占位符「剧本正文会出现在这里」（`:71`）。
- 全包 `grep -rn "景别|运镜|特效|镜头" src/` **只有 1 处命中**，就是上面那句 prompt。没有 `SHOT_TYPES` 枚举、没有镜头数组、没有字段校验、没有 `extractJsonArray` 这类解析器（对比我们 `public/js/consts.js:384-420`）。
- 输出协议分工：抽取步骤**是** JSON（`{"characters":[...],"mainPlot":"..."}`，`useHome.ts:67`），剧本步骤**不是** JSON（纯文本，`useHome.ts:71-80`）。这是刻意的：**机器要读的用 JSON，人要读/要改的用纯文本**——与 N2S 步骤①脉络「唯一非 JSON 步」的取舍同构（competitors §2 步骤①→②）。

---

## 5. 数据模型

### 5.1 业务类型（本 app 自有）

| 类型 | 字段 | 位置 |
|---|---|---|
| `CharacterInfo` | `name`（人物名字）、`identity`（一句话身份与性格，≤30 字） | `src/pages/Home/useHome.ts:9-12` |
| `WorldStyle` | `id`、`name`、`desc` | `useHome.ts:14-18` |
| `PagePhase` / `WORLD_STYLES`（5 条） | `"idle"\|"extracting"\|"confirming"\|"generating"\|"done"`；`chuanyue` 穿越 / `xitong` 系统 / `beipan` 感情背叛 / `xiuxian` 修仙 / `xuanwu` 玄武（每条一句 desc） | `useHome.ts:28`；`:20-26` |

### 5.2 组件 Props（全部显式 interface，无 `any`）

`NovelInputProps`(`NovelInput.tsx:6-13`)、`ExtractConfirmCardProps`(`ExtractConfirmCard.tsx:7-15`)、`StylePickerProps`(`StylePicker.tsx:5-11`)、`ScriptPanelProps`(`ScriptPanel.tsx:5-12`)、`RhAccountMenuProps`(`RhAccountMenu.tsx:23-27`)、`CostConfirmDialogProps`(`CostConfirmDialog.tsx:9-14`，用 `Pick<UseCostConfirmResult,...>` 与 hook 字段 1:1 对齐)、`ButtonProps`(`button.tsx:36-40`)、`BadgeProps`(`badge.tsx:26-28`)。

### 5.3 LLM 通道类型

| 类型 | 字段 | 位置 |
|---|---|---|
| `LlmContentPart` | `{type:"text",text}` \| `{type:"image_url",image_url:{url}}` | `src/lib/llm.ts:4-6` |
| `LlmMessage` | `role: system\|user\|assistant`；`content: string \| LlmContentPart[]` | `llm.ts:8-11` |
| `LlmCallOptions` | `messages`、`page`、`max_tokens`、`temperature`、`signal`、`request_id` | `llm.ts:13-20` |
| `LlmCallResult` | `ok`、`status: success\|failed\|running\|pending\|not_found`、`text`、`error?`、`model?`、`usage?`、`needsLogin?` | `llm.ts:22-30` |
| `LlmModelInfo` | `model`、`rh_model_id`、`max_tokens`、`timeout_s`、`supports_temperature` | `llm.ts:32-38` |

### 5.4 平台 AIGC / 账号类型（本 app 未调用，随脚手架打包进来）

`aigc.ts:13-142` 一整套：`AigcOutput / AigcSubmitResponse / AigcResponse<T> / AigcPollResponse / AigcUsage / AigcPricePreview / AigcScalarParam / AigcMediaParam / AigcModelInfo / AigcSuccess / AigcFailure / AigcResult`（逐字段带设计注释）；另 `AigcHistoryItem`(`:225`)、`AigcHistoryQuery`(`:248`)、`AigcHistoryPatch`(`:259`)、`AiAppOutput`(`:383`)、`AiAppRunResponse`(`:395`)、`AiAppUploadResponse`(`:406`)、`AigcUploadResponse`(`:411`)、`AiAppPollOpts`(`:769`)；`RhJwtPayload`(`rhLogin.ts:1-8`)、`RhAccountInfo`(`rhLogin.ts:10-16`：`userId/displayName/avatar?/totalCoin?/walletBalance?`)、`UseCostConfirmResult`(`useCostConfirm.ts:80`)。

### 5.5 本地存储用法（全部键位清单）

| 键 | 用途 | 位置 |
|---|---|---|
| `vibex_cost_confirmed_today:{appId}` | 计费确认「今天不再提醒」，值 `{expiresAt}`（当日 23:59:59.999 到期） | `costConfirm.ts:16-24,37-39` |
| `Rh-Accesstoken` / scoped token 三键 / `userInfo`；sessionStorage：app id 缓存、inviteCode | RunningHub 登录态；沙箱域 SSO 与邀请码 | `rhLogin.ts:115-117,177-192,419-421,656-660`；`:151-163,431-438` |

**业务数据零持久化**：人物/主线/风格/剧本全在 `useState`，无 IndexedDB、无云端写入、无导出文件（`ScriptPanel` 只有复制按钮，`ScriptPanel.tsx:48-64`）。

---

## 6. 提示词工程

### 6.1 两段 prompt 全文结构（逐条摘录 + 意图）

**A. 人物抽取 `EXTRACT_SYSTEM_PROMPT`**（`src/pages/Home/useHome.ts:64-69`，5 行数组 `.join("\n")`）

1. 「你是一位资深漫剧编剧助手。用户会给你一段小说章节（10000 字以内）。」——角色设定 + 输入边界前置告知。
2. 「请提取其中的主要人物和主线剧情，严格按 JSON 输出，禁止输出 JSON 以外的任何文字、解释或代码块标记。」——**负向约束与正向要求写在同一句**。
3. `JSON 格式：{"characters":[{"name":"人物名字","identity":"一句话身份与性格，30字以内"}],"mainPlot":"主线剧情摘要，100字以内，讲清这一章发生了什么、主角的目标与冲突"}`——**内联 schema**（不是另给 JSON Schema），且**在示例值里就把字数与内容要求写死**；`mainPlot` 的要求拆成三个子句「发生了什么 / 主角的目标 / 冲突」，这是让 100 字摘要不跑偏的关键。
4. 「要求：characters 最多 8 个，按出场重要性排序；只输出合法 JSON。」——**数量上限 + 排序语义 + 再次强调合法 JSON**。设计意图：**服务端不做 `response_format` 约束**（chat 请求 payload 里没有 `json_mode` 之类字段，`llm.ts:104-110`），所以「不许吐坏 JSON」全靠 prompt 自律 + 前端解析兜底（§8.4）。

**B. 剧本生成 `SCRIPT_SYSTEM_PROMPT`**（`useHome.ts:71-80`，6 条编号要求）

1. 「你是一位专业漫剧编剧，擅长把小说改编成节奏紧凑的漫剧剧本。」+「请基于用户确认的人物与主线，把小说章节改写成一部完整的漫剧剧本」——**明确指认「用户确认的」产物是权威输入**，与 §3.3 的 `【已确认的人物】/【已确认的主线】` 呼应。
2. 6 条要求依次为：剧名用 `《》`；按「第1集」分集、每集 3-5 场景、场景编号；每场景先写 `【场景】` 行（地点＋时间＋画面氛围），对白格式「人物名：（动作或神态）台词」；关键画面用 `【画面】` 给镜头提示（景别/运镜/特效）；「台词要口语化、有钩子，每集结尾留悬念」；「全文用中文，直接输出剧本正文，不要任何解释或前言」。
3. **结构化输出协议 = 中文方括号标记 + 编号约定**（`《》`、`第N集`、`场景N`、`【场景】`、`【画面】`），无 JSON、无 schema、无流式。
4. 设计意图：这是「给人看的产物」的正确协议选择——用排版标记而非 JSON，让用户直接在 textarea 里手改（`ScriptPanel.tsx:67-72`）；代价是下游无法机读（本包也不需要）。

### 6.2 世界风格字典（枚举 + 在使用点拼接）

5 条风格每条 = 名称 + 一句「味道描述」（`useHome.ts:20-26`），例如 `{ id:"chuanyue", name:"穿越", desc:"主角从现代穿越异世界，带着信息差一路逆袭改命" }`。注入方式**不是**关键词字典，而是**自然语言整句塞进 user 消息**：`世界风格：${style.name}（${style.desc}），整体基调要贴合这个风格。`（`useHome.ts:200`）。
与 N2S 的「12 款风格 → 英文注入文案 → `N()` 统一拼接」不同（competitors §3）：本包把风格当作**创作指令**而非**画面词配方**（因为它不出图），所以走自然语言。

### 6.3 模型与参数

| 参数 | 取值 | 证据 |
|---|---|---|
| 模型 | `qwen3.7-max`（前端常量 `MODEL_SHORT`） | `useHome.ts:7` |
| 服务端 allowlist | `{"qwen3.7-max":{"rh_model_id":"qwen/qwen3.7-max","max_tokens":16384,"timeout_s":600,"supports_temperature":true}}` | `llm.pb.js:30` |
| `temperature` | **不传**（`callLlmWithFallback` 未传该字段） | `useHome.ts:123-129,194-217` |
| `max_tokens` | 抽取未传 → 服务端用 `cfg.max_tokens`=16384；剧本显式 `12000` | `llm.ts:107`；`llm.pb.js:187`；`useHome.ts:216` |
| `page` 埋点 / `stream` | `"home"`（两次调用都传）；**`stream: false`**（服务端硬编码，前端无流式） | `useHome.ts:128,215`；`llm.pb.js:195` |
| 请求唯一键 | 前端 `crypto.randomUUID()` 生成 `request_id`，服务端按它去重/缓存 | `llm.ts:60-65,103`；`llm.pb.js:111-123,174-182` |

### 6.4 服务端 LLM 中转（`pb_hooks/llm.pb.js`，平台注入，本包唯一后端）

- **模型 allowlist 在服务端**：不在表里的模型直接 `400 model_not_allowed`（`:161`）；**`llm_jobs` 集合自举**：字段 `request_id/model_name/page/status/result_text(max 80000)/error_message(max 4000)` + `request_id` 唯一索引（`:42-52`）。
- **幂等/缓存**：同 `request_id` 命中已 `success`/`failed` 的记录，直接返回 `{cached:true, text, error}`，**不重复调模型**（`:174-182`）——这是「前端 25s 放弃 → 转轮询」能安全工作的基石。
- **稳定性契约**（文件头注释原文）：「/chat 仍是同步 `$http.send`，但客户端会提前放弃等待并转 /poll；本 handler 必须继续跑完并写 llm_jobs。」（`:21-23`）
- **`temperature` 只在显式传且 `supports_temperature=true` 时透传**，注释点名「GPT-5.5 等模型不支持该参数」（`:26-28,197-199`）；前端也有一道同名守卫 `/gpt-?5/i.test(modelName)`（`llm.ts:111`）——**双端各防一次**。
- **计费上报**：`X-LLM-Include-Billing: true` 让响应带 `billing.charged_amount`，再 `reportLlmIndex()` 上报到 VibeX 收益看板，整段 `try/catch` 静默失败（`:124-146,203-205`）。

---

## 7. 视觉与设计系统

### 7.1 色板（HSL 变量，`:root` 与 `.dark` **两处完全重复**）

| token | 值 | 说明 |
|---|---|---|
| `--background` / `--foreground` | `0 0% 7%` / `0 0% 100%` | 近黑底 + 纯白字 |
| `--card` / `--popover` | `0 0% 9%` | 卡片比背景亮 2% |
| `--secondary` / `--muted` / `--accent` | 全部 `0 0% 12%` | **三 token 同值**（中性层未细分） |
| `--border` / `--input` | `0 0% 30%` | 描边偏亮（暗色下可读性优先） |
| `--primary` / `--ring` | `141 76% 48%` | **霓虹绿**（≈ #1ED760，Spotify 绿） |
| `--primary-foreground` / `--destructive-foreground` / `--destructive` | `0 0% 0%` / `354 84% 70%` | 亮色按钮配黑字；亮红（暗底上不刺眼） |

证据：`src/index.css:41-62`（`:root`）、`:96-117`（`.dark`，逐值相同）。
`color-scheme: dark`（`index.css:42`）——**暗色是唯一主题**，`.dark` 类只是同值副本；另有首帧防闪：`html,body,#root { background-color:#08090a }` + `@media (prefers-color-scheme: light)` 覆盖为白色（`index.css:5-19`）。

### 7.2 圆角 / 间距 / 阴影 / 字号 / 字体（`__DS_BURN__` 令牌区，`index.css:62-93`）

- 圆角：`--radius-lg:8px`、`--radius-md:6px`、`--radius-sm:9999px`（**sm 就是胶囊**）、`--radius-pill:9999px`、`--radius: var(--radius-md)`（`:62,72-75`）。
- 间距：`--space-1/2/3/4/5/6/8/12` = 4/8/12/16/20/24/32/48（`:64-71`），Tailwind `spacing` 被**重写为只认这 8 档**（`tailwind.config.js:18`）。
- 阴影：`--elev-flat:none` / `--elev-ring: 0 0 0 1px var(--border)` / `--elev-raised: rgba(0,0,0,.3) 0px 8px 8px`；Tailwind 里 `shadow-sm` **被重定义为 elev-ring（描边）**，`DEFAULT/md/lg/xl` 全部 = elev-raised（`index.css:76-79`；`tailwind.config.js:19`）。→ **「阴影即描边」**，与 N2S 同一手法（competitors §1.3）。
- 字号：`--text-xs:10 / sm:12 / base:16 / lg:18 / xl:20 / 2xl:24 / 3xl:24 / 4xl:24`（`:80-87`）——**2xl/3xl/4xl 三档同为 24px**（令牌坍缩）；`--leading-body:1.50`、`--leading-tight:1.00`（`:88-89`）。
- 字体：`--font-display: "SpotifyMixUITitle", "PingFang SC", …`、`--font-body: "SpotifyMixUI", …`、`--font-mono: "PingFang SC", …, ui-monospace, …`（`:90-92`）——**mono 栈把 CJK 字体排在最前**（中文等宽场景的务实兜底）。
- focus ring：`--focus-ring: 0 0 0 3px rgba(30,215,96,.4)`（`:77`），组件里以 `focus-visible:ring-2 focus-visible:ring-primary` 或 `focus-visible:shadow-[var(--focus-ring)]` 两种写法消费（`RhAccountMenu.tsx:98,112`）。
- 中英混排补偿：`.cjk-latin { font-size-adjust:.56; vertical-align: var(--cjk-latin-shift,-.15em) }`（`index.css:35-38`）。

### 7.3 组件视觉特征

| 组件 | 特征 | 证据 |
|---|---|---|
| 卡片 | `rounded-2xl border border-border bg-card p-6 shadow-lg sm:p-8`，全站统一（**业务代码不用 `Card` 组件，直接写 div**） | `NovelInput.tsx:18`、`ExtractConfirmCard.tsx:40`、`StylePicker.tsx:16`、`ScriptPanel.tsx:29` |
| 主 CTA | `rounded-full bg-primary px-8/px-10 font-bold shadow-lg shadow-primary/30 hover:scale-105` | `NovelInput.tsx:50`、`StylePicker.tsx:54`、`ScriptPanel.tsx:51` |
| 次按钮 / 幽灵删除 / 虚线新增 | `variant="outline"` + `rounded-full`；`variant="ghost" size="icon"` + `hover:text-destructive`；`variant="outline"` + `border-dashed` | `ScriptPanel.tsx:41-47`；`ExtractConfirmCard.tsx:66-74`；`:79-86` |
| 空态 / loading | **无 `Card` 组件参与**，手写居中小卡：`flex flex-col items-center gap-3 rounded-2xl border p-10/p-12` + `Loader2 animate-spin` | `ExtractConfirmCard.tsx:28-34`、`ScriptPanel.tsx:17-23` |
| 长文本编辑区 | `Textarea` + `min-h-56 resize-y bg-background/60 text-base leading-relaxed`（章节）/ `min-h-96 bg-background/70 text-sm`（剧本）/ `min-h-24`（主线） | `NovelInput.tsx:34`、`ScriptPanel.tsx:70`、`ExtractConfirmCard.tsx:93` |
| 背景装饰 | 3 个 `bg-primary/15\|10\|5` 模糊圆斑 + `bg-gradient-to-br from-background via-secondary to-background`，`fixed inset-0 -z-10 pointer-events-none` | `HomePage.tsx:19-24` |
| 顶栏 / 头像骨架 | `sticky top-0 z-40 border-b bg-background/80 backdrop-blur`；`h-9 w-24 animate-pulse rounded-full bg-muted`（`aria-hidden`） | `TopBar.tsx:6`；`RhAccountMenu.tsx:89-91` |

### 7.4 动效

- **入场统一一套**：`animate-in fade-in slide-in-from-bottom-4 duration-500`（`tailwindcss-animate`），四张主卡逐张入场（`NovelInput.tsx:17`、`ExtractConfirmCard.tsx:39`、`StylePicker.tsx:15`、`ScriptPanel.tsx:28`）；loading 卡只用 `fade-in`（`ExtractConfirmCard.tsx:28`）。
- 微交互：按钮/风格卡 `hover:scale-105`（`StylePicker.tsx:37`、`ScriptPanel.tsx:51`）；头像箭头 `transition-transform ${open?"rotate-180":""}`（`RhAccountMenu.tsx:133`）。
- `tailwind.config.js` 只定义 accordion 的 4 个 keyframes（**且成对重复声明两次**，`:80-119`），业务动效全部来自插件。

---

## 8. 工程实现技巧

### 8.1 请求层：25s 放弃 → 转轮询（本包最值得看的工程点）

- 常量：`CHAT_ABORT_MS = 25000`、`POLL_INTERVAL_MS = 3000`、`POLL_ATTEMPTS = 200`（`src/lib/llm.ts:40-42`）→ 轮询预算约 10 分钟。
- 初次请求：`AbortController` + `window.setTimeout(() => ctrl.abort(), 25000)`，并支持外部 `opts.signal` 联动（`llm.ts:115-117`）。
- 失败即转轮询（`llm.ts:168-182`）：每 3s `POST /api/llm/poll {request_id}`；`success`/`failed` 立即返回；`not_found` 连续 3 次才放弃（`:175-177`）；`running` 则 `notFoundCount` 归零继续；200 次耗尽返回 `error:"timeout"`。
- **老代际路由降级**：扁平路由 `/api/llm/chat` 404 时，记住 `legacyLlmRoutes=true` 并重试按模型路由 `/api/llm/{model}/chat`；两种代际都 404 才快速失败，不进 poll（`llm.ts:44-58,128-143`）。注释明说这是「发布刷新只换前端 lib、不动 app 已装 pb_hooks」的兼容产物（`llm.ts:44-50`）。
- 412（登录态过期）→ `{error:"rh_login_required", needsLogin:true}`，两处（初次 `:145-147`、轮询 `:85-87`）；请求头统一注入 `Content-Type` + `vibexAuthHeaders()` + `pb.authStore.token`（`:67-71`）。**没有指数退避**：轮询是固定 3s（对比我们 `lib/agnes.js:344-356` 的 `min(60000, base*2^attempt)+jitter` 退避）。而 `aigc.ts:538-539` 的 AIGC 轮询**有**渐进加长：`interval = Math.min(interval + 500, 5000)`（`aigc.ts:536-538`）——**同一份脚手架里两套轮询策略并存**。

### 8.2 长文本处理

| 技巧 | 实现 | 证据 |
|---|---|---|
| 前端硬截断 | `trimmed.slice(0, MAX_NOVEL_CHARS)`，两处重复 | `useHome.ts:122,189` |
| 服务端二次截断 + DB 上限 | `jobRec.set("result_text", text.substring(0, 80000))`；字段 `result_text` max 80000、`error_message` max 4000 | `llm.pb.js:227`；`:48-49` |
| 错误摘要指纹 | `fingerprint: msg.substring(0, 80)` 随错误返回（防超长日志进前端） | `llm.pb.js:79,216,222,255` |
| 输出长度控延迟 | 文件头注释：「慢模型输出长度要用 max_tokens 控制延迟」 | `llm.pb.js:23` |
| 计数展示 | 剧本区标题旁实时 `（{scriptText.length} 字）` | `ScriptPanel.tsx:37` |

**无流式**：服务端 `stream: false` 硬编码（`llm.pb.js:195`），前端也拿不到增量；长剧本只能等（`ScriptPanel.tsx:20-21` 用文案兜住等待焦虑）。

### 8.3 并发控制

- 本 app **零并发**：两次调用都是串行 `await`（`useHome.ts:123,194`），无 `Promise.all`、无批量。
- 平台层可参考的纪律：提交重试最多 3 次、间隔 1500ms，且**明确不重试 412/4xx**（注释「重试也救不回来」，`aigc.ts:646-655`），只有 5xx（`:656-663`）与网络层异常（`:671-680`）才重试；轮询阶段网络抖动**当作 RUNNING 继续**（`:552-555`）——长任务轮询的正确姿态。

### 8.4 JSON 解析兜底（对比我们的实现）

`parseExtraction`（`useHome.ts:41-62`）四步：① `trim` → ② 剥 ```json 围栏 → ③ `indexOf("{")`/`lastIndexOf("}")` 截取 → ④ `JSON.parse` + **字段级校验**：`characters` 必须数组、`mainPlot` 必须字符串否则 `return null`（`:52`）；逐条丢掉没名字的条目（`:54`）；`.slice(0,8)`（`:55`）；`characters.length===0 || !mainPlot.trim()` → `null`（`:57`）。解析失败只给「分析结果没能识别出来，请稍后重试」（`:142`），**不暴露原始输出**。
对比我们：`consts.js:384-420` 的 `extractJson` 是 5 步（fence → 直接 parse → `sliceFirstJson` → `repairJson(sliced)` → `repairJson(全文)`），`extractJsonArray` 还兼容 `{shots:[...]}` 包装；`storyboards.js:272-278` 解析失败时**把模型原文亮进 modal**。**这条我们更强，不需要借鉴**（见 §10），唯一可借的是「字段级校验后丢弃脏条目」。

### 8.5 错误处理与文案映射

- `LlmCallResult.status` 是枚举 + `error` 字符串码，页面用 `LLM_ERROR_ZH` 映射成中文（`useHome.ts:30-39`），**未命中回退显示原始 error**。
- `AigcFailure.errorKind` 是 8 值稳定枚举（`submit/poll/timeout/aborted/login_required/insufficient_balance/content_audit/task_failed`，`aigc.ts:114-142`）；`formatAigcFailureMessage`（`:214-222`）的注释纪律值得抄：**不要自己写 errorKind 白名单去挑着拼 `result.error`**，否则 `task_failed` 会把上游真实原因（如「音频时长过短」）吞掉；`login_required` 例外，只给引导文案不拼技术码。
- 登录判定是**多信号汇合**而非只看状态码：412/401 + 正文关键词（`sandbox_token_required`/`rh_login_required`/「登录态已过期」/「请先登录」，`aigc.ts:185-196`）。

### 8.6 表单校验

- 只有「空 / 太短 / 缺风格」三种，全是命令式早退 + `setErrorMsg`，**无表单库**（`package.json` 装了 `react-hook-form` + `zod` + `@hookform/resolvers`，`useHome.ts` 一个都没用——**装了不用**，属「依赖体积换零收益」）。超限不拦截只提示（§2.3）；风格卡未选时 `disabled={busy || !selectedId}`（`StylePicker.tsx:53`）是唯一的原生禁用校验。

### 8.7 a11y（本包做对的部分与缺口）

- 做对：`role="dialog" aria-modal="true"` + 遮罩点击取消 + 内容区 `stopPropagation`（`CostConfirmDialog.tsx:28-37`）；`aria-haspopup="menu" aria-expanded` + `role="menu"/"menuitem"`（`RhAccountMenu.tsx:110-111,138,170,195`）；菜单外点 + Escape 关闭带 cleanup（`:55-71`）；`aria-label="关闭提示"`（`HomePage.tsx:57`）、删除人物 `aria-label`（`ExtractConfirmCard.tsx:71`）、骨架 `aria-hidden`（`RhAccountMenu.tsx:90`）；焦点环 `focus-visible:ring-2` / `shadow-[var(--focus-ring)]` 几乎每个可点元素都写了。**缺口**：`CostConfirmDialog` 无 focus trap、无 Esc、无初始聚焦；错误横幅的关闭钮是裸 `<button>`（`HomePage.tsx:53-60`，未用 `Button`）且横幅**无 `aria-live`**（`HomePage.tsx:49-63`）——分析失败时屏幕阅读器不播报。

---

## 9. 可借鉴点 → 我们的具体落点

> 「我们现状」全部来自本次实地读码（非引用 `ui-our-baseline.md` 的旧结论；与基线冲突处已复核并标注）。

### 9.1 两段式「抽取 → 确认 → 生成」门禁 —— **最值得落地的一条**

- **他们**：`PagePhase` 状态机把「抽取」与「生成」拆成两次 LLM 调用，中间插入一个**用户可改的确认卡**；`ExtractConfirmCard` 在 confirming/generating/done 三态常驻（`HomePage.tsx:13-14`）；第二步 user 消息把「已确认人物/主线」显式回注（`useHome.ts:199-212`）。文案直接把机制说破：「会先提取人物和主线给你确认，不会直接生成剧本」（`NovelInput.tsx:43-45`）。
- **我们现状**：`scripts.js` 的 5 个 tab（故事构思→剧情梗概→分集大纲→单集脚本→分镜脚本，`consts.js:120-126`）是**五次独立生成**，产物渲染进只读 `<pre class="json-out">`（`scripts.js:200`），**没有任何「先抽取实体再确认」的中间态**；`storyboards.js:241-308` 从粘贴的脚本**一次调用直接落库成镜头行**（`api.createStoryboards(rows2)`，`storyboards.js:301`），用户只能在事后开 modal 逐条改（`storyboards.js:463-524`）。全库无人物/角色实体（`grep "character|人物|角色" lib/*.js public/js/pages/*.js` 只命中 `storyboards.characters` 字符串字段，`lib/routes.js:383`）。
- **建议**：给 `episode_script` → `storyboard_script` 之间插入一个「人物/主线确认」中间态。落点：`public/js/pages/scripts.js` 新增 `phase` 变量（`extract | confirming | generating`）+ 一个确认卡渲染函数（复用 `ui.js` 的 card/input 模板与 `modal` 风格）；提示词侧新增一个 `template_type: 'entity_extract'`（走 `lib/seed.js` 的 `DEFAULT_TEMPLATES` + `settings.js` 的模板编辑，`settings.js:369-403` 已支持任意类型）；确认后的实体文本拼进现有 `storyboard_script` 模板变量（`{{人物设定}}` 之类，`scripts.js:84-90` 的 `varsOf` 会自动渲染成输入框）。 **改动量 M**；**风险**：模板变量是「模板定义决定输入框」的机制（`scripts.js:99-113`），新增变量需同步改 seed 模板与已存库模板（老库模板不会自动升级，需在 `lib/seed.js` 里加一次性补丁或在 `settings.js` 提供「补全内置变量」动作）。

### 9.2 中间产物「就地可编辑」，而不是只读展示

- **他们**：人物行是两个受控 `Input` 直接绑 `onChange`（`ExtractConfirmCard.tsx:54-65`），主线是 `Textarea`（`:90-94`）；剧本结果是 `Textarea`（`ScriptPanel.tsx:67-72`），副标题写明「直接点进文字里改，改完复制走就能用」。
- **我们现状**：`scripts.js:200` 结果区是 `<pre class="json-out">`，**只读**（`pre` 无 `contenteditable`，无编辑入口）；`scripts.js` 全文 `grep contenteditable` 0 命中。用户想改一个字段只能「复制→外部编辑→再也回不来」。
- **建议**：在 `scripts.js:195-201` 的结果卡里，把「原文」tab 的 `<pre>` 换成 `<textarea class="textarea mono">`（保留「格式化」tab 的 `<pre>`），并把编辑后的文本作为 `result` 参与 `saveBtn`（`scripts.js:223-230`）与 `importStoryboard`（`scripts.js:277`）。`ScriptPanel.tsx:36-37` 的「（N 字）」计数也可照搬。 **改动量 S**；**风险**：JSON 文本手改易坏，导入分镜前需再过一次 `extractJsonArray`（`consts.js:413`）并给出可读失败提示——这一点我们已有现成模式（`storyboards.js:272-278` 的失败 modal）。

### 9.3 极简实体卡字段（name + 一句话 identity）

- **他们**：`CharacterInfo` 只有 2 个字段，`identity` prompt 限定 30 字（`useHome.ts:9-12,67`）。**我们现状**：无人物实体（§9.1 证据）。
- **建议**：如果做人物表，**先只做 `name` + `identity`（一句话）+ `appearance`（外貌，可选）**，不要一次上 N2S 的 5 字段。落点：`lib/store.js` 的 `COLLECTIONS` 数组新增 `characters`（`store.js:19-29`）+ `lib/seed.js` 无需改 + `lib/routes.js` 新增 4 个 CRUD 端点（照 `prompt_templates` 的写法，`routes.js:802-830` 是最短模板）+ 前端可先挂在 `projects.js` 项目卡内或 `scripts.js` 确认卡里，不新开页面。 **改动量 L**（新增集合会牵动 `store.js`/`routes.js`/`tools/*` 断言/`.understand-anything` 图谱）；**风险**：`store.js` 有 `COLLECTIONS` 白名单校验（`store.js:162`），漏改会直接抛「未知集合」；图谱需跑 `/understand` 增量更新。

### 9.4 长文本「计数 + 软上限 + 超限即截断」的透明化

- **他们**：`10000 / MAX_NOVEL_CHARS 字` 实时计数（`NovelInput.tsx:26-28`）+ 超限红字说明「会按前 10000 字处理」（`:37-41`）+ 提交时 `slice`（`useHome.ts:122`）。
- **我们现状**：**全前端无字数计数、无上限**——`grep -rn "maxlength|maxLength|charCount" public/js/pages/*.js` 0 命中（唯一 `字` 命中是注释与 prompt 文本）；`storyboards.js:34` 的 `#script-in` 无 `maxlength`，`scripts.js:110` 的长变量 textarea 也无计数。
- **建议**：给 `storyboards.js:34` 的脚本输入与 `scripts.js:110` 的长文本变量加实时计数 + 软上限（例如 12000 字），超限时在下方给「将按前 N 字处理」的红字说明，并在 `genFromScript`（`storyboards.js:243`）与 `generate`（`scripts.js:134`）里显式 `slice`。 **改动量 S**；**风险**：上限值必须与 `lib/agnes.js:163-186` 的 `timeoutMs`（默认 120s，`routes.js:841`）和模型上下文窗口对齐，否则「不截断」会变成超时；建议上限先用保守值并写成常量便于调。

### 9.5 极短输入的软校验（带理由）

- **他们**：`<100 字` 直接拦截，且**说明为什么**（「人物和主线才提取得准」，`useHome.ts:109-112`）。
- **我们现状**：`storyboards.js:244` 只校验空文本（`if (!text) { toast.err('请先粘贴脚本内容'); return; }`）；`scripts.js:126-133` 的 `generate()` 只校验模板存在与 API Key，**不校验变量是否填了内容**（模板变量未填会被替换成「（未填写）」静默送进模型，`scripts.js:136`）。
- **建议**：`scripts.js:134-137` 之后加一段：统计仍含 `（未填写）` 的变量名，若超过半数则 `toast.warn('变量基本没填，生成结果会很空——建议至少填「题材/主角身份」')`；`storyboards.js:244` 加 `<100 字` 的 warn。 **改动量 S**；**风险**：无（不拦截，只提示）。

### 9.6 错误码 → 中文文案映射表

- **他们**：`LLM_ERROR_ZH` 4 条 + 兜底（`useHome.ts:30-39`）；平台层 8 值 `errorKind` 枚举 + `formatAigcFailureMessage` 的「必须拼上游真实原因」纪律（`aigc.ts:146-155,214-222`）。
- **我们现状**：`api.js:25` **已经**把 `errorType` 透出（`return { ok:false, error, errorType: data.errorType, data }`），但 `grep -rn "errorType" public/js/` **只有这 1 处命中**——即前端**定义了却零消费**，所有页面一律 `toast.err(r.error)` 直出后端原文（`scripts.js:168`、`storyboards.js:265,303`、`videos.js` 等）。
- **建议**：在 `consts.js` 增加 `TEXT_ERROR_ZH`（键取 `lib/agnes.js` 的 `errorType` 取值：`proxy_timeout`/`network_error`/…，见 `agnes.js:115`）与统一 helper `zhErr(r)`；在 `scripts.js:168`、`storyboards.js:265` 等 `toast.err(r.error)` 处替换为 `toast.err(zhErr(r))`，**保留拼上游原文**（学 `aigc.ts:218-220` 的 `base: raw` 形式）。 **改动量 S**；**风险**：后端文案本身已是中文（`routes.js:876` 返回 `e.message`），需在 helper 里判断「原文与映射文案相同则不重复拼」，否则会出现「生成失败：生成失败」。

### 9.7 加载态给「时间预期」+ 骨架占位（首批只做一处）

- **他们**：「章节越长越考验耐心，一般半分钟内就好」（`ExtractConfirmCard.tsx:32`）、「剧本比较长，大概要一两分钟，先去倒杯水吧」（`ScriptPanel.tsx:21`）、按钮上「正在分析章节…」（`NovelInput.tsx:55`）；账号信息未到时用 `animate-pulse` 圆角块占位（`RhAccountMenu.tsx:89-91`）。
- **我们现状**：`ui.js:281-283` 的 `spinner(text)` 文案由调用方传但普遍写「加载中…」；`ui.js:317-343` 的 `setBusy` 把 `title` **写死**为「模型生成通常需要 20〜60 秒，请耐心等待」（`ui.js:325`），秒表只报已耗秒（`ui.js:330-333` 的 `setInterval`）。`scripts.js:141` 有本页自造的「Agnes 正在生成，通常需 10〜40s…」——**全站唯一带预期的文案**，且是重复实现（`ui-our-baseline` §0.2）。骨架屏：全站 0 个，加载一律 spinner（`ui.js:281-283` 只有 `spinner`，无 skeleton 类）。
- **建议**：① 给 `ui.js` 的 `setBusy(btn, busy, label, hint)` 加第 4 个可选参数 `hint`（覆盖写死的 title）；把 `scripts.js:141-146` 的自造计时器改为调用带 `hint` 的 `setBusy`（消除两套实现）；`storyboards.js:322` 的批量补提示词进度行**已有**「（每条约 5〜20s）」，把它作为推广模板。② 先在 `dashboard.js:24` 的 6 个 stat 卡做骨架（`css/app.css` 加 `.skeleton`），验证后再推 `scripts.js:48` 与 `storyboards.js:61`。 **改动量 S（文案）/ M（骨架）**；**风险**：预期不准会招致不信任，写成区间并在超时后改写文案；`css/app.css` 已有 8 组 keyframes 且时长档位混乱（`ui-our-baseline` §10.5），新增前先复用现成但已死的 `pulse` keyframes。

### 9.8 前端请求超时/取消 + 后端「先落 running 再更新」

- **他们**：25s `AbortController` 超时（`llm.ts:115-117`）+ 服务端 `request_id` 幂等缓存（`llm.pb.js:174-182`）保证「放弃等待不等于丢结果」。
- **我们现状**：**前端零超时零取消**——`api.js:6-28` 的 `req()` 全文无 `AbortController`（与 `ui-our-baseline` G-6 一致，本次复核仍属实）；后端有超时（`agnes.js:96` `AbortSignal.timeout(timeoutMs)`，文本默认 120s，`routes.js:841`）但**文本生成没有进行中记录**：`routes.js:838` 先 `await agnes.chat(...)`，`routes.js:845` 才 `store.insert('generation_tasks', …)`——**请求在途期间任务页看不到任何记录**，前端若断连，这次生成的结果彻底丢失（失败分支同理，`:862`）。
- **建议**：两步。① 前端：`api.js:6` 的 `req(method, url, body, opts)` 加可选 `timeoutMs`（默认 130s，略大于后端 120s），超时返回 `{ok:false, error:'请求超时——任务可能仍在后台生成，请稍后到「镜头任务」页确认', errorType:'client_timeout'}`。② 后端（更重要）：把 `routes.js:833-878` 改成**先 insert 一条 `status:'running'` 的任务记录并拿到 id，再 await，完成/失败后 `store.update` 回写**，这样前端超时后任务页有据可查。 **改动量 M**（前端 S + 后端 S，但需同步改 `tools/apitest.mjs` 里对 `/api/agnes/text` 的断言）；**风险**：②会改变任务表的数据形态（出现 running 态文本任务），`tasks.js` 的状态过滤按 `VIDEO_STATUS` 命名域设计（`ui-our-baseline` §7 K-1 已记录该缺口），可能加剧「静默筛空」——建议同时给 `tasks.js` 的文本 tab 补候选状态。

### 9.9 tab 切换缓存结果，而不是清空

- **他们**：`phase` 回退不重算，`confirming → generating → done` 全程保留中间产物（`HomePage.tsx:13-15`）；改完再前进才重算（`useHome.ts:185-187` 不重置）。**我们现状**：`scripts.js:70` 的 tab 点击处理器里调 `clearResult()`（`:173-177` 把 `result=''` 并清空 `#result-wrap`），**切一次 tab 回来，上一次的生成结果就没了**（`ui-our-baseline` §3 E4 已记录；本次复核：`clearResult` 仍在 `:70` 的 tab 分支里，未修）。
- **建议**：把 `result` 从单值改为 `Map<tab, {text, ctx}>`，`clearResult()` 只在切项目时调用；`renderResult` 从当前 tab 取值。 **改动量 S**；**风险**：多个长剧本同时在内存（每个可能数十 KB，可接受）；`resultCtx` 的语境戳机制（`scripts.js:28,170`）需一起改成按 tab 存，否则跨 tab 保存会串味。

### 9.10 a11y：modal 的 `role`/`aria-modal`（toast 这条我们已经做对了）

> **先纠正一条**：`ui-our-baseline.md` 的 F19 说「toast 无 `aria-live`」，**本次实地复核已不成立**——`public/index.html:18` 的 `#toasts` 容器已带 `role="status" aria-live="polite" aria-atomic="false"`（行内注释还写明「反馈层必须可被屏幕阅读器宣告」），且 `ui.js:16-18` 逐条 toast 再按类型设 `role="alert"`（error）/`role="status"`（其余）+ `aria-atomic="true"`。**toast 这条不需要再改**。

- **他们**：`role="dialog" aria-modal="true"`（`CostConfirmDialog.tsx:29-30`）、`role="menu"/"menuitem"` + `aria-expanded`（`RhAccountMenu.tsx:110-111,138,170`）、菜单外点 + Esc 关闭带 cleanup（`:55-71`）、骨架 `aria-hidden`（`:90`）——**但它的对话框反而更弱**：`CostConfirmDialog` 全文无 focus trap、无 Esc、无初始聚焦。**我们现状**：`ui.js:48-104` 的 `modal()` 已有 **ESC 关闭 + Tab focus 陷阱 + `⌘/Ctrl+↵` 提交 + 焦点归还 opener（`ui.js:51`）+ 脏值守卫**（`ui.js:67-84`，连「有未保存的修改，关闭后将丢失」的橙色条都实现了，可用 `dirtyGuard:false` 关闭）——**这些我们全都有，比它强**。真正缺的只有 **`role="dialog"`/`aria-modal`/`aria-labelledby`**：`grep -n "role=\|aria-" public/js/ui.js` 只命中 `:18`（toast）与 `:172`（注释）。
- **建议**：只补一行——`ui.js:55-63` 的 `.modal` 节点加 `role="dialog" aria-modal="true" aria-labelledby=<id>`，并给 `<h3>`（`ui.js:58`）补该 id。 **改动量 S**；**风险**：无。附带发现：`clickableCard`（`ui.js:175`，Tab 可达 + Enter/Space 触发 + `role="button"`）**全站只在 `dashboard.js:111` 用了 1 处**——`ui-our-baseline` G-5 的「可点卡片键盘不可达」在 projects/assets/images 三页仍在，这是**不用学竞品、自家工具已备好没铺开**的低垂项。

### 9.11 分镜表「提示词列」就地编辑

- **他们**：卡内联编辑无编辑态切换（`ExtractConfirmCard.tsx:52-76`）；剧本长文本直接 textarea（`ScriptPanel.tsx:67-72`）。
- **我们现状**：`storyboards.js:212-222` 的 `promptCell()` 把提示词渲染成 `max-width:180px` 的截断 span + 原生 `title` tooltip，**要改必须点「编辑」开 15 字段 wide modal**（`storyboards.js:463-524`）。`ui-our-baseline` §4 T-6 记录过这个缺口（「无点击展开编辑」）。
- **建议**：给 `promptCell` 增加「点击展开为 inline textarea，blur 时 `api.updateStoryboard(id,{image_prompt})` 保存」的行为，只做图片/视频提示词两列；沿用现成的 `bind()` 事件助手（`storyboards.js:197`）。 **改动量 M**；**风险**：表格行高抖动 + 与 `load()` 全表重渲染（`storyboards.js:117-130`）的竞态——保存后不要 `load()`，只更新 `rows` 里那一项。

### 9.12 「已确认」措辞把内部机制教给用户

- **他们**：user 消息用人话段头 `【已确认的人物】/【已确认的主线】`（`useHome.ts:202-206`）；UI 上写「不会直接生成剧本」（`NovelInput.tsx:44`）。**我们现状**：`storyboards.js:252-258` 的 prompt 是「请将以下脚本内容转换为分镜表」——**没有「已确认的」概念**，提示词里也没表达「用户确认过的输入更权威」这层语义。
- **建议**：做完 9.1 后把回注段头统一为 `【已确认的人物】/【已确认的主线】/【原文】` 三段式，并把同样措辞抄进 `lib/seed.js` 的 `storyboard_script` 模板与 `scripts.js` 的确认卡说明。 **改动量 S**；**风险**：无。

---

## 10. 不值得借鉴 / 边界（与我们的约束冲突）

| # | 他们的做法 | 证据 | 为什么放弃 |
|---|---|---|---|
| 1 | **提示词明文写在前端组件里** | `EXTRACT_SYSTEM_PROMPT`/`SCRIPT_SYSTEM_PROMPT` 是 `useHome.ts` 里的模块级常量（`useHome.ts:64-80`） | 与我们的核心架构直接冲突：我们「提示词入库、设置页可改」（`lib/seed.js:12-104` 的 `DEFAULT_TEMPLATES` + `settings.js:369-403` 的模板编辑弹窗 + `scripts.js:80-124` 按 `{{变量}}` 动态渲染输入框）。`ui-other-competitors.md` §6 已把「前端明文持提示词」列为竞品反面项，本包再次印证。**不改**。 |
| 2 | **PocketBase + `pb_hooks` 作为后端** | `pocketbase/pb_hooks/llm.pb.js`；`vibex-local/README.md`「PocketBase is not bundled in this zip … downloads the matching PocketBase release」 | 我们是零 npm 依赖的 Node 原生（`AGENTS.md` 项目速览）。引入 PB = 引入一个需下载的外部二进制 + JSVM hook 生态，直接违背「零依赖 + 单文件 SEA exe」约束。**不改**。 |
| 3 | **React 19 + Radix 全家桶 + Tailwind 构建链** | `package.json` dependencies 含 25 个 `@radix-ui/*` + `recharts`/`embla`/`vaul`/`cmdk`/`sonner` 等 | 我们前端是 `public/` 下无构建的 vanilla ESM（`AGENTS.md` 前端链路）。任何 npm UI 库都要引入打包器，等于推翻「无构建步骤」这一约束。**不改**。 |
| 4 | **RunningHub 登录态与 scoped token 存 localStorage** | `rhLogin.ts:26-37,174-192`（token + 过期时间 + user 三键） | 我们是本机单用户、无账号体系（数据在 `data/*.json`，无鉴权）。把 token 放 localStorage 是托管平台跨域 SSO 的必要妥协，我们没有这个前提；若将来要接云同步，也不应复制这套双契约（沙箱域 vs 老域）的复杂度。**不改**。 |
| 5 | **付费前置确认弹窗 `runWithCostConfirm`** | `useCostConfirm.ts:43-54`、`CostConfirmDialog.tsx:25-54`、`costConfirm.ts:16-39` | 我们的计费发生在 Agnes 侧（用户自带 API Key，`lib/agnes.js:6` 注释「API Key 只存在本机 settings.json」），没有「RH 币/钱包余额」概念，也没有可展示的单价。硬搬会变成一个每天都弹、点了没信息的纯噪音弹窗。**只借它的「时间预期文案」，不借费用门**（已归入 9.7）。 |
| 6 | **单路由 `path="/"` + `path="*"` 兜底** | `App.tsx:6-9` | 这是「一个页面就是全部产品」形态的必然选择。我们有 10 个页面模块 + hash 路由（`app.js:44-59`）+ 跨页深链（`syncViewParams`，`app.js:53-58`）。把 3 步塞进单页会破坏现有 IA 与深链能力。**不做**。 |
| 7 | **`slice(0, 8)` 静默丢弃第 9 个人物** | `useHome.ts:55`（无任何提示） | 静默截断与我们在 `ui-our-baseline` §13 里反复强调的「不撒谎」原则相悖。若我们做人物表，超限应提示「已保留前 8 个，其余未纳入，可手动添加」。**只借数量上限，不借静默**。 |
| 8 | **零草稿持久化** | `grep -rn "localStorage\|sessionStorage" src/` 30 处全在 `rhLogin.ts`/`costConfirm.ts`；`useHome.ts` 0 处；`grep -rni "draft\|autosave\|草稿"` 全包 0 命中 | 刷新即丢 1 万字粘贴 + 手改人物。我们是**本地优先**产品（数据存本机 `data/*.json`），有 `store.js` 现成持久化基石，没有理由比它更差。**反着做**：长文本输入应做 draft 自动保存（可作为 9.4 的延伸）。 |
| 9 | **重复点「分析章节」无脏值守卫** | `useHome.ts:117-121` 先清空再请求；`NovelInput.tsx:46-63` 按钮在非 busy 时永远可点 | 用户手改的人物会静默蒸发。**注意这条我们是「有工具没用」**：`ui.js:67-84` 的 modal 已经实现了「有未保存的修改，关闭后将丢失 / 继续编辑 / 放弃修改」的脏值守卫条，但 `NovelInput` 那个裸 `<Button>`（`NovelInput.tsx:46-63`）不在 modal 里，用不上。若要修，应在 `useHome.ts:103` 的 `handleAnalyze` 入口加一个「已有 characters/mainPlot 且非空 → 走 `ui.js:191` 的 `confirm({danger})`」的前置确认。**不改其做法**。 |
| 10 | **`key={idx}` 做列表 key** | `ExtractConfirmCard.tsx:53` | 删除中间项时 DOM 复用依赖受控组件兜底，属可用但脆弱。我们的表格用 `esc(s.id)` 做 key（`storyboards.js:165,177` 等），已是对的。**不倒退**。 |
| 11 | **老代际路由 404 探测降级 / `execCommand('copy')` 兜底 / JSON 解析链** | `llm.ts:44-58,128-143`；`useHome.ts:292-305`（无 `isSecureContext` 判断、无 reject）；`useHome.ts:41-62`（4 步，失败只给一句通用文案） | 路由降级是平台「只换前端 lib、不动已装 pb_hooks」的产物，我们无此代际问题。后两项我们更强或已做对：`consts.js:423-438` 的 `copyText` 先判 `navigator.clipboard && window.isSecureContext` 且 resolve/reject 分明；`consts.js:384-420` 是 5 步（含 `repairJson` 与 `{shots:[...]}` 解包）+ `storyboards.js:272-278` 把模型原文亮进 modal。唯一可借的是「字段级校验后丢弃脏条目」（`useHome.ts:52-57`），可在 `extractJsonArray` 之后加一层轻校验。**不倒退**。 |

---

## 11. 附：本次研读的可复现命令

```bash
# 本包（只读）
cd "/Users/apple/Project/Git/Webeye-Video/docs/AI创作资料/08-AI创作项目源码/ai-remix-7e856295-小说章节转漫剧剧本工具"
find src -name "*.ts" -o -name "*.tsx" | wc -l; find src -name "*.ts" -o -name "*.tsx" | xargs wc -l | tail -1  # 32 个文件 / 3980 行
grep -rn "景别\|运镜\|特效\|镜头" src/                           # 仅 1 处：useHome.ts:77
grep -rn "localStorage\|sessionStorage" src/                    # 30 处，全在 rhLogin/costConfirm
grep -rni "draft\|autosave\|草稿" src/                          # 0 命中

# 我们（对照）
cd /Users/apple/Project/Git/agnes-manga-studio
grep -rn "errorType" public/js/                                 # 仅 api.js:25（定义即唯一命中）
grep -rn "maxlength\|maxLength\|charCount\|AbortController" public/js/   # 0 命中
grep -n "role=\|aria-" public/js/ui.js; grep -n "aria-live" public/index.html  # ui.js 仅 :18(toast)/:172(注释)；index.html:18 —— F19 已不成立
grep -rn "clickableCard" public/js/                             # 定义 ui.js:175，使用仅 dashboard.js:111
grep -n "clearResult\|contenteditable" public/js/pages/scripts.js # :70(tab 分支)、:173；contenteditable 0
sed -n '833,878p' lib/routes.js                                 # 文本链路：:838 await 先于 :845 insert
```

*（完 —— 本文件为纯研读，未修改被研读源码包中的任何文件，也未改动本仓库除本文件外的其它文件。）*
