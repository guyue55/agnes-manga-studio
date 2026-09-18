# 竞品源码研读 08-01：Vibex「电影风格库 / 导演剧照工作台」

> 被研读对象（只读，未做任何修改）：`/Users/apple/Project/Git/Webeye-Video/docs/AI创作资料/08-AI创作项目源码/remix-16560341-电影风格库导演剧照工作台/`
> 对照项目（下文简称「我们」）：`/Users/apple/Project/Git/agnes-manga-studio/`
> 读码口径：所有结论均给出 `相对路径:行号`；行号取自本次读取的工作树快照。我们侧的行号已与当前 HEAD 核对（近期 a11y/防连点批次已落地，本文按**实况**而非 `docs/research/ui-our-baseline.md` 的旧口径写）。
> 目标读者：后续做「风格库 / 卡片墙 / 成本确认 / 提示词工程」升级的开发者。

---

## 1. 一句话定位与技术栈

**一句话**：一个「画廊式风格展示 + 一键同风格二创」的单页付费演示应用——50 部电影剧照的卡片墙作为诱饵，用户对任意一帧点「生成同风格」，应用**并行**发起一次 LLM 风格解读（给人看的中文散文）与一次文生图（给机器吃的英文提示词），两条链路各自独立计费确认，结果落在同一块结果面板里。

| 项 | 事实 → 证据 |
|---|---|
| 路由 / 页面 | **2 条路由**（`/` 与 `*`，都渲染同一 `HomeRoute`，无 404 态）→ `src/App.tsx:6-9`；**1 个真实页面**（Home）+ 1 个 hook 装配壳 → `src/pages/Home/index.tsx:4-7` |
| ts/tsx 文件数 | `src/` **36 个**，其中 **10 个是零引用死代码**（`ui/*`）；`templates/scaffold/src/` 另有 22 个是平台脚手架副本 → `find src -name "*.ts*" \| wc -l`；`grep -rln "@/components/ui" src/` 为空 |
| 状态管理 | **无 store 库**（无 redux/zustand/jotai）。全部状态集中在单个 `useHome()` hook（388 行），返回**约 60 个字段**（含整个 `costConfirm` 展开）；页面用 `HomePage(p: ReturnType<typeof useHome>)` 接收整个 vm 并 `{...p}` 透传 → `useHome.ts:369-387`、`HomePage.tsx:84` |
| UI 库 | shadcn/ui 配置在册（`components.json`，baseColor=slate、cssVariables=true）+ Radix 24 包 + lucide-react，**但业务代码 0 处 import `@/components/ui/*`**，全部界面是手写 Tailwind class 字符串 → `components.json:1-22`、`package.json:14-30`、`grep -rn "components/ui" src/` 无命中 |
| 后端接入 | PocketBase，经 **VibeX 子路径代理 `/__pb`**（`matchVibexPrefix()` 从 `location.pathname` 抽 `/app-preview/app-<32hex>`）。前端**不直连**任何第三方 API：图片走 `POST /api/aigc/*`、LLM 走 `POST /api/llm/*`，由 app 内已装的 `pb_hooks/aigc.pb.js`(1227 行) 与 `llm.pb.js`(281 行) 实现 → `pb.ts:7-17,26` |
| 鉴权 | 双通道：PB SDK `pb.authStore.token` → `Authorization`；B1 沙箱域额外带 `X-Vibex-Scoped-Token`（挂在 `pb.beforeSend` 上，业务代码无感）→ `llm.ts:67-71`、`pb.ts:31-37`、`rhLogin.ts:140` |
| 构建 | Vite 8 + React 19.2 + TypeScript ~6.0 + react-router-dom 7（`basename={getBasename()}` 适配子路径部署）；dev 端口 8000 `strictPort` → `package.json:43-56`、`main.tsx:15`、`vite.config.ts:82-87` |
| 声明依赖 vs 实际依赖 | `dependencies` 声明 **40 个**，从 `src/` 可达的只有 **5 个**：`react`/`react-dom`/`react-router-dom`/`pocketbase`/`lucide-react`（其余 6 个 radix 包 + clsx + tailwind-merge + CVA 只被死代码 `ui/*` 引用）。`recharts`/`react-hook-form`/`zod`/`sonner`/`embla-carousel-react`/`date-fns`/`vaul`/`cmdk`/`next-themes` 等 **0 引用** → `grep -rhoE 'from "[^".][^"]*"' src/ \| sort \| uniq -c` |
| 平台契约 | 源码包是 VibeX 导出快照，带 `vibex-local/export-manifest.json`（app_id `app-afbdae1e5db04224a6fc858516560341`）与 roundtrip 技能；`src/_rh_inspect.ts` 已被替换为 3 行 stub（在线可视化编辑器运行时不下发）→ `vibex-local/export-manifest.json:1-13`、`src/_rh_inspect.ts:1-3` |

## 2. 信息架构与页面流

### 2.1 路由表与页面骨架

| 路由 → 组件 → 说明 |
|---|
| `/` → `HomeRoute` → 唯一真实页面 |
| `*` → `HomeRoute` → 未知路径**也渲染首页**（无 404 态），且地址栏保留坏路径（`src/App.tsx:8`） |

页面骨架（自上而下，全在同一条纵向滚动流里，**无 tab / 无二级路由 / 无弹窗式详情**）：

```
<div min-h-screen bg-background>
  ├─ 装饰层：absolute inset-x-0 top-0 h-96 bg-gradient-to-b from-primary/15   (HomePage.tsx:23-26)
  ├─ SiteHeader（sticky top-0 z-50 bg-background/85 backdrop-blur）           (SiteHeader.tsx:10)
  │    └─ 品牌块 + 国家导航（hidden lg:flex，按国家 scrollTo）+ RhAccountMenu
  ├─ [条件] RunningHub 登录态过期横幅                                          (HomePage.tsx:31-43)
  ├─ HeroIntro（grid lg:grid-cols-5：左 3 文案 / 右 2 三张倾斜剧照堆叠）        (HeroIntro.tsx:14-66)
  └─ main.max-w-6xl
       ├─ StyleFilterBar（全部 + 25 个 styleLabel chip）                        (StyleFilterBar.tsx)
       ├─ CountrySection × 5（id=`country-<id>`，grid sm:grid-cols-2）          (CountrySection.tsx:13,24)
       │    └─ DirectorCard × 5
       ├─ DirectorProfile（id=`director-archive`，grid lg:grid-cols-5：左档案 / 右作品）(DirectorProfile.tsx:13-14)
       │    └─ WorkCard × 2（md:grid-cols-2）
       └─ StyleResultPanel（id=`style-result`，grid lg:grid-cols-5：左解读 / 右新剧照）(StyleResultPanel.tsx:36,41)
  ├─ SiteFooter
  └─ CostConfirmDialog（fixed inset-0 z-[100]，非 portal）

```

跳转全部用 `scrollToId()` 平滑滚动到固定锚点，锚点只有三个：`country-<id>`、`director-archive`、`style-result`（`HomePage.tsx:12-14,18,29,44,58`）。**没有 URL 状态**——筛选、选中导演、生成结果刷新即全丢（对比我们已有 `syncViewParams`，见 §7.10）。

### 2.2 happy path 逐步流程（含用户看到的原文）

1. **落地**。Hero 眉标是硬编码统计文案 `Cinematic Style Archive · 5 国 / 25 位导演 / 50 部代表作`（`HeroIntro.tsx:20`）；核对数据 5 国 × 5 导演 × 2 作品 = 25/50，**文案与数据一致**（`grep -c 'styleLabel: "'` = 25；`stillUrl:` 命中 51 次，其中 1 次是接口字段声明 `filmLibrary.ts:9`，实际作品 50）。主标题 `每一帧剧照，都是导演的签名`，主按钮 `开始浏览影库`，旁边小字 `「生成同风格」按次计费，生成前会与你确认`（`HeroIntro.tsx:22-37`）——价格承诺在首屏就给，早于任何计费动作。
2. **筛选（可选）**。StyleFilterBar 左端 mono 标签 `Style`，第一个 chip 是 `全部`，随后 25 个风格标签（如 `霓虹夜色`/`色彩史诗`/`冷峻对称`/`新浪潮`/`日常流淌`）。**再点一次当前标签 = 取消筛选**（`useHome.ts:321-323`）；筛选后只保留含该风格导演的国家分区，空分区不渲染（`useHome.ts:357-362`）。
3. **进入国家分区**。分区头是「英文名（mono uppercase primary）+ 中文名（text-3xl bold）+ 一条 `flex-1` 横线 + 右侧计数 `5 位导演 · 10 部代表作`」（`CountrySection.tsx:11,16-22`）。
4. **点导演卡**。DirectorCard 整块是 `<button aria-pressed={active}>`，选中态加 `ring-2 ring-primary`，同时 `handleSelectDirector` + 平滑滚到 `#director-archive`（`DirectorCard.tsx:12-17`、`HomePage.tsx:56-59`）。
5. **导演档案**。眉标 `Director File · 导演档案`，中文名 text-4xl，风格 tagline 用 `border-l-2 border-primary pl-4` 竖线引用块，引导语 `下面是这位导演的代表作。翻开剧照与内容简介，遇到心动的那一帧，点「生成同风格」试试。`；右栏标题 `代表作陈列`（`DirectorProfile.tsx:16-31`）。
6. **点「生成同风格」**。按钮文案 `生成同风格`（Sparkles 图标）；先经成本确认（第 7 步），通过后变 `同风格生成中…`（Loader2 spin），且**只有当前 active 卡可点**（`disabled = busy && !active`，`WorkCard.tsx:12,30-49`）。
7. **成本确认弹窗**：标题 `确认运行`，正文 `将调用 RunningHub AI，可能消耗 RH 币或钱包余额。{价格文案}。`，勾选框 `今天内不再提醒（仅对当前项目有效）`，按钮 `取消`/`确认运行`（`CostConfirmDialog.tsx:23,42-69`）。价格文案来自 §6.4。
8. **并行双请求**。`runSameStyle()` 同时发 LLM `callLlmWithFallback('gpt-5.5', {messages:[{role:'user', content: composeStyleQuery(...)}], page:'home'})`（`useHome.ts:243-246`）与 AIGC `callAigcAndPoll('nano-banana-pro', {resolution, aspectRatio, prompt: imagePrompt})`（`:247-251`），用 `Promise.allSettled` 收口，**任一失败不拖累另一条**（`:252`），并把最终提示词回填 `setPrompt(imagePrompt)`（`:238`）。
9. **结果面板**。左栏 `风格解读`：running 是 4 条 `animate-pulse` 骨架 + `正在撰写风格解读…`；done 是 `animate-in fade-in duration-700` 淡入正文；error 是红色文案 + `重试`；idle 是 `这次生成没有附带风格解读。`（`StyleResultPanel.tsx:44-77`）。右栏 `同风格新剧照`，标题右侧价格徽标三态，running 占位文案 `新剧照生成中，通常需要 30–90 秒…`，error 占位同尺寸（防跳动）带 `重试`（`StyleResultPanel.tsx:83-115`）。
10. **再生成**。成功后出现 `再生成一张`（RefreshCw），点击走 `handleRegenerate(true)` → `variationRef.current += 1` → 取模切到下一个场景变体（`useHome.ts:237,307-314`、`filmLibrary.ts:835-837`）。底部标注 `原片：《花样年华》 2000`（`StyleResultPanel.tsx:123`）。
11. **登录失效支路**：任一请求返回 `needsLogin`/`errorKind==='login_required'` 时置 `needsRhLogin`，顶部渲染横幅 `RunningHub 登录态已过期，请重新登录后再继续生成。` + `重新登录`（`HomePage.tsx:31-43`、`useHome.ts:167,209,260`）。

**注意（死代码）**：`runGenerate()`/`handleGenerate()`/`prompt`/`resolution`/`aspectRatio` 这条「自由提示词生成」链路在 `useHome` 里完整存在（`useHome.ts:177-222`），但 **HomePage 及任何子组件都没有入口**——没有 textarea、没有分辨率/比例控件，`p.handleGenerate` 与 `p.prompt` 在视图中 0 引用（`grep -rn "handleGenerate\|p.prompt\|setResolution" src/pages/Home/HomePage.tsx src/components/home/*.tsx` 仅命中 `onGenerateSameStyle`）。即：**用户无法自定义提示词**，`prompt` state 只是被 `runSameStyle` 单向写入的展示变量。

## 3. 数据模型

### 3.1 影库数据（纯硬编码，无请求、无持久化）

`src/lib/filmLibrary.ts` 一个文件即全部内容源（853 行：1-30 行是类型与 CDN 前缀，32-818 行是数据，820-853 是派生函数）。

| 类型 | 字段 → 含义 | 证据 |
|---|---|---|
| `FilmWork` | `id`（slug，同时是 `findWorkById` 的键）· `title`/`year` · `synopsis`（2-3 句中文简介约 50-80 字，供卡片正文）· `stillUrl`（绝对 URL，拼自 `IMG_BASE` + UUID.jpg）· **`stylePrompt`（风格本体：英文视觉描述，图片提示词的核心载荷，见 §4.3）** | `filmLibrary.ts:4-11,30,50-54,845-853` |
| `Director` | `id`/`name`/`nameEn` · `countryId` · `styleLabel`（中文 4 字分类如 `霓虹夜色`，**仅用于筛选条、不进提示词**）· `styleTag`（约 20 字 tagline，展示在卡片胶囊与档案引用块）· `works`（`FilmWork[]`，恒为 2 部） | `filmLibrary.ts:13-21,43-45`、`useHome.ts:360` |
| `CountrySection` | `id`/`name`/`nameEn`/`directors`；`id` 同时用作滚动锚点 `country-<id>` | `filmLibrary.ts:23-28`、`CountrySection.tsx:13` |

派生：`STYLE_LABELS` = 按数据出现顺序去重的 `styleLabel` 数组（`filmLibrary.ts:821-823`），实测 22 个不同标签（25 位导演中 3 组重名：`新浪潮`×2、`色彩史诗`×2、`日常流淌`×2）；`SCENE_VARIANTS` = 6 条英文场景短语（`:826-833`）；`findWorkById(workId)` 三层嵌套线性遍历，返回 `{work, director}` 或 `null`（`:845-853`）。

**数据规模**：5 国（中国/美国/日本/法国/韩国）× 5 导演 × 2 作品 = 50 条 `FilmWork`，每条带一段独立英文 `stylePrompt`。这是本包最大的资产——**手写 50 条风格描述**，而不是让模型即兴发挥。

### 3.2 请求/响应类型（`src/lib/llm.ts` 与 `src/lib/aigc.ts`）

**LLM 侧**（`llm.ts`）：`LlmContentPart`（`{type:'text',text}` \| `{type:'image_url',image_url:{url}}`——声明了多模态但全包 0 处构造，`:4-6`）· `LlmMessage`（`:8-11`）· `LlmCallOptions`（`messages`/`page`（审计用页面 slug）/`max_tokens`/`temperature`/`signal`/`request_id`，`:13-20`）· `LlmCallResult`（`ok`/`status: success\|failed\|running\|pending\|not_found`/`text`/`error`/`model`/`usage`/`needsLogin`，`:22-30`）· `LlmModelInfo`（`model`/`rh_model_id`/`max_tokens`/`timeout_s`/`supports_temperature`，`:32-38`）。

**AIGC 侧**（`aigc.ts`）：`AigcOutput`（`url`+`type: image\|video\|audio\|3d\|file`，`:13-16`）· `AigcSubmitResponse`（`:18-27`）· `AigcPollResponse`（`status: RUNNING\|QUEUED\|SUCCESS\|FAILED\|CANCEL`，`:39-48`）· `AigcUsage`（4 个**全 `string \| null`** 的金额字段，注释明确「不要 parseFloat 再格式化」以避浮点误差，`:53-58`）· `AigcPricePreview`（`:62-70`）· **参数契约三件套** `AigcScalarParam`（`name`/`type`/`required?`/`enum?`/`default?`，`:74-80`）、`AigcMediaParam`（`+multiple?`/`max_num?`/`accept?`/`max_size?`，`:84-92`）、`AigcModelInfo`（`model`/`endpoint`/`output_type`/`primary_input?`/`scalar_params?`/`media_params?`，`:94-101`）· `AigcSuccess`\|`AigcFailure`\|`AigcResult` 判别联合，失败态 `errorKind` 是 **8 值稳定英文枚举**（`submit\|poll\|timeout\|aborted\|login_required\|insufficient_balance\|content_audit\|task_failed`，`:103-142`）· `AigcHistoryItem`（14 个业务字段 + 4 个扣费快照，`:225-246`）· `AigcHistoryQuery`（支持 `status`/`favorite`/`category`/`minRating`/`sort`）与 `AigcHistoryPatch`（只放开 `rating\|favorite\|category\|note`，`:248-259`）· AI 应用形态 `AiAppOutput`/`AiAppRunResponse`（`version:"rh-ai-app.v1"`、`state: queued\|running\|succeeded\|failed\|partial`、`error:{code,message,retryable,taskId?}`）/`AiAppPollOpts`（`:383-404,769-775`）· 上传响应 `download_url`+`downloadUrl` **双字段并存**以兼容两代后端（`:406-418`）。

**其它**：`RhJwtPayload`/`RhAccountInfo`（含 `displayName`/`avatar`/`walletBalance?`，`rhLogin.ts:1-29`）；本包 UI 核心状态机 `UploadStatus = idle\|uploading\|done\|error` 与 `JobPhase = idle\|running\|done\|error`（`useHome.ts:39-40`）。

### 3.3 本地存储用法

| 存储 | 键 → 内容 | 证据 |
|---|---|---|
| `localStorage` | `vibex_cost_confirmed_today:<appId>` → `{expiresAt: <今日 23:59:59.999 毫秒戳>}`，读取时校验 `expiresAt > Date.now()`，过期自动失效 | `costConfirm.ts:16-38` |
| `localStorage` | （PB SDK 自管）authStore 持久化 | `pb.ts:26` |
| 无 | 影库数据、筛选态、选中导演、生成结果**全部不落 localStorage**，刷新即重置为 `COUNTRY_SECTIONS[0].directors[0]` | `useHome.ts:80-82` |
| 服务端 PB `llm_jobs` | `request_id`(唯一索引)/`model_name`/`page`/`status`/`result_text`(max 80000)/`error_message`(max 4000) | `llm.pb.js:38-55,99-107` |
| 服务端 PB `aigc_tasks` | `AigcHistoryItem` 字段镜像 + 4 个扣费快照 | `aigc.ts:225-246`、`aigc.pb.js:335,982,1169` |

历史记录**服务端按 RH 用户过滤**（`aigc.ts:224` 注释）；页面挂载时 `loadAigcHistory(MODEL, {page:1, perPage:20})` 拉最近 20 条，把最近一张成功结果恢复到主展示区，避免刷新后空白（`useHome.ts:118-133,907-912`）。

## 4. 提示词工程（本包重点）

### 4.1 图片提示词模板：三段式拼接（`composeImagePrompt`）

原文模板（`filmLibrary.ts:838`，全文仅此一行）：

```
Cinematic film still in the exact visual style of {work.stylePrompt}. New scene: {scene}. Maintain identical color palette, lighting, composition language and film texture. Cinematic framing, no text, no watermark.

```

| 片段 → 意图 |
|---|
| `Cinematic film still in the exact visual style of` → 定媒介 + 强绑定，`exact` 是刻意的强约束词：先声明"这是一张电影剧照"再谈风格 |
| `{work.stylePrompt}` → 风格载荷（§4.3），把 50 条手写英文描述**直接内联，不做二次压缩/摘要**——避免 LLM 转写丢信息 |
| `New scene: {scene}` → 场景变体，与风格解耦：风格固定、场景每次换，这是"再生成一张"能出不同画面的机制 |
| `Maintain identical color palette, lighting, composition language and film texture.` → **四条不变式**，把"风格一致"拆成可检查的四个维度（色彩/光照/构图语言/胶片质感），既是给模型的 checklist 也是给人的解释 |
| `Cinematic framing, no text, no watermark.` → 负向约束前置。**本包没有任何 negative_prompt 机制**（`grep -rni "negative" src/` 零命中），负向约束被写成正向句尾的祈使句 |

### 4.2 场景变体池（`SCENE_VARIANTS`）

6 条英文场景，全部是**低信息量、高可塑性**的镜头描述（`filmLibrary.ts:826-833`）：

```
"a quiet interior scene lit by a single window" / "a night street scene with passing strangers"
"a close-up of hands and a small object on a table" / "an empty landscape at dawn before anyone arrives"
"two figures seen from far away through a doorway" / "a scene reflected in rain-streaked glass"
```

设计意图：变体**只描述"拍什么"，不描述"怎么拍"**（除 close-up 外不含技术词、不含色彩词），把色彩/光比/质感的决定权全部留给 `stylePrompt`，保证 6 次变体都是同一导演的签名。取模做了负数安全（`filmLibrary.ts:836`：`((variation % len) + len) % len`）。

### 4.3 风格本体：50 条手写英文 `stylePrompt`

这是本包最值得研究的资产。样例（`filmLibrary.ts:53-54`、`63-64`）：

```
"a 1960s Hong Kong romantic drama: saturated warm reds and golds, elegant qipao silhouettes, soft lamplight glow, narrow intimate corridors, longing restrained intimacy, 35mm film grain"
"a 1990s neon-soaked urban romance: fluorescent greens and reds of late-night Hong Kong streets, step-printed motion blur, handheld intimacy, lonely city dwellers, saturated night colors, grainy film texture"
```

**统一句式**：`a <年代/类型> <genre>: <色彩>, <主体/服饰>, <光>, <空间>, <情绪/关系>, <胶片质感>`。四要素固定出现顺序 = 色彩 → 光 → 构图/空间 → 质感，情绪词夹在中间。全部小写、逗号分隔短语、无完整句、无否定词。

设计意图：**把"导演风格"下移到"具体影片的视觉可复现描述"**。同一导演两部片风格不同（王家卫《花样年华》= 暖红金 + 旗袍 + 柔灯，《重庆森林》= 荧光绿红 + 步印拖影 + 手持），因此 `stylePrompt` 挂在 `FilmWork` 而不是 `Director` 上。`styleLabel`（如 `霓虹夜色`）与 `styleTag` 只承担**人看的分类与导购**职能，绝不进提示词——避免"标签词污染"（中文抽象词对图像模型无信息量）。另需注意：`styleFilter` 只参与 `visibleSections` 的 `useMemo` 过滤与卡片 `active` 判定，**不进入任何提示词构造**（`useHome.ts:357-362`），所以"筛出来的导演，点进去的作品未必都是这个风格"——这是产品层可商榷处。

### 4.4 风格解读模板：`composeStyleQuery`（唯一的 LLM prompt）

原文（`filmLibrary.ts:842`，全文仅此一行，中文）：

```
你是一位资深影评人。请为电影《{title}》（{year} 年，导演{directorName}）写一段 150 到 220 字的视觉风格解读：聚焦色彩、构图、光影、镜头运动与情绪氛围，可以提及它如何服务于故事，但不要复述剧情。直接输出这一段文字，不要标题、不要分点、不要引号。
```

| 设计点 → 意图 |
|---|
| 角色设定 `你是一位资深影评人` → 用职业身份锚定语域（评论体，而非说明书体） |
| 字数硬约束 `150 到 220 字` → 上下界都给，适配卡片左栏固定高度，避免"写长一点"导致布局崩 |
| 维度清单 `色彩、构图、光影、镜头运动、情绪氛围` → 与 `stylePrompt` 的四要素**刻意同构**，让人读到的解释与机器吃到的风格可对应 |
| 允许与禁止 `可以提及它如何服务于故事，但不要复述剧情` → 明确划出"可谈/禁谈"，防模型滑向剧情梗概（50 部片名极易触发剧情复述） |
| 输出格式 `直接输出这一段文字，不要标题、不要分点、不要引号` → 三重否定把输出锁成纯散文，**前端不做任何后处理**，直接 `setStyleText(r.text)`（`useHome.ts:257`） |
| **无 system message**：`messages: [{ role: 'user', content: composeStyleQuery(...) }]` 只有一条 user（`useHome.ts:244`）→ 模板自包含，角色设定写进 user 里，省一次 system 段 |

**双通道解耦**是本节最重要的一条设计：同一个 `FilmWork` 派生**两条独立提示词**——中文散文（给人）与英文短语（给机器），由两个不同模型、两条独立计费链路、并行执行（`useHome.ts:243-252`）。用户看到"风格解读"的瞬间，得到的是"为什么这张图长这样"的解释，而不是一段技术提示词。

### 4.5 结构化输出协议

本包的 LLM 侧**没有 JSON schema 约定**：风格解读是纯文本，无 `response_format`、无 schema、无字段校验（`llm.pb.js:191-196` 的 payload 只有 `model`/`messages`/`max_tokens`/`stream:false`，以及条件性的 `temperature`）。

结构化协议体现在**图片模型的参数契约**上，由后端 `ALLOWED_MODELS` 常量承载并透出：

```
{"nano-banana-pro":{"endpoint":"rhart-image-n-pro/text-to-image","output_type":"image",
 "primary_input":{"name":"prompt","required":true},
 "scalar_params":[{"name":"resolution","type":"string","default":"1k","enum":["1k","2k","4k"]},
  {"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9","21:9"]}],
 "media_params":[]}}

```

证据：`aigc.pb.js:32`（`/submit`）、`:341`（models）、`:632`（submit handler）、`:687`（price-preview）、`:875`（poll）——**同一份常量在文件里被复制了 6 次**（每处 `routerAdd` 各自重新声明，Goja 环境下的自包含写法），这是可维护性债务。

契约的三条硬规则写在 `aigc.ts` 的类型注释里（对后续开发者有强约束力）：
- `enum 存在时必须渲染成 select/segmented 控件且用 default 预选; required=true 的参数不允许隐藏或写死常量`（`aigc.ts:72-73`）
- `multiple=true 必须用 uploadAigcMediaFiles 支持多图/多文件上传 (上限 max_num), 不能只做单图`（`aigc.ts:82-83`）
- 响应包络双形态：标准模型用 `AigcSubmitResponse`/`AigcPollResponse`；AI 应用用 `rh-ai-app.v1` 包络（`aigc.ts:29-30,393-404`）

### 4.6 温度 / 模型 / 参数

| 参数 | 取值 → 证据 |
|---|---|
| 图片模型 | `const MODEL = 'nano-banana-pro'`（模块级常量，无 UI 可切换）→ `useHome.ts:26` |
| LLM 模型 | `const LLM_MODEL = 'gpt-5.5'` → `useHome.ts:27` |
| `temperature` | **前端完全不传**。`llm.ts:111` 明确对 `/gpt-?5/i` 模型剥离该参数；后端 `supports_temperature:false` 时也不透传 → `llm.ts:111-113`、`llm.pb.js:30,197-199` |
| `max_tokens` | 前端不传 → 后端取 `cfg.max_tokens = 8192`，且 `<16` 时兜底为 8192 → `llm.pb.js:30,187-188` |
| 超时/poll 预算 | LLM 后端 `timeout_s = 600`，前端主动放弃等待 **25s** 后转 poll；poll 间隔 3000ms × 200 次 = **600s**，与后端 `timeout_s` 精确对齐 → `llm.pb.js:30,189-190`、`llm.ts:40-42,116,169-170` |
| 图片 `resolution` / `aspectRatio` | 前端默认 `'1k'` / `'16:9'` → `useHome.ts:46-47` |
| AIGC poll 节奏 | 间隔 2500ms，每次 +500ms 封顶 5000ms；页面层又显式传 `pollIntervalMs: 3500` 覆盖默认 → `aigc.ts:533-540`、`useHome.ts:36,194-197` |
| AIGC deadline | 页面层传 `POLL_TIMEOUT_MS = 3600000`（1 小时），覆盖内部 8min/30min 的模型自适应默认 → `useHome.ts:37,196`、`aigc.ts:526` |

**值得注意的默认值错位**：后端 `ALLOWED_MODELS` 的 `aspectRatio` default 是 `"3:4"`（`aigc.pb.js:32`），而前端 state 默认 `'16:9'` 且**总是显式传参**，后端 default 实际永不生效（`useHome.ts:188-190`）。这类"契约里有 default、调用方永远覆盖"的漂移，是契约型后端常见陷阱。

### 4.7 素材与参考图的引用语法

**本包是纯文生图，零参考图能力**，由三处共同证明：① `media_params: []`（空数组）——模型契约声明无媒体输入（`aigc.pb.js:32`）；② `runSameStyle` 的 runBody 只有 `{resolution, aspectRatio, prompt}`（`useHome.ts:186-190,247-251`）；③ `LlmContentPart` 虽声明了 `{type:'image_url', image_url:{url}}` 多模态分片（`llm.ts:4-6`），但**全包 0 处构造该分片**——能力声明了却未使用。

素材引用只有一种形式：**硬编码的绝对 CDN URL**。`IMG_BASE = "https://rh-images.xiaoyaoyou.com/<32hex>/output"`（`filmLibrary.ts:30`）拼 UUID 文件名；Hero 区额外硬编码 3 个作品 id 作为展示位（`HERO_WORK_IDS = ["wkww-ymys","kubrick-2001","miyazaki-chihiro"]`，`HeroIntro.tsx:7`），经 `findWorkById` 反查后按 index 1/2/0 的顺序分层叠放（`HeroIntro.tsx:42-62`，最上面那张 `heroShots[0]` 反而最后渲染以覆盖在最上层）。**本地无素材库**——图片不落盘、不复用、不管理。

## 5. 视觉与设计系统

### 5.1 Tailwind 配置：把 token 烧进 theme

`tailwind.config.js` 有三层值得注意的做法：

1. **颜色全部走 CSS 变量**，不含任何字面色值（`tailwind.config.js:21-74`）：`border`/`input`/`ring`/`background`/`foreground` + `primary|secondary|destructive|muted|accent|popover|card` 各自带 `DEFAULT` 与 `-foreground`，外加 `chart.1-5` 与 `sidebar.*`（后两组本包 0 使用，是 shadcn 默认模板残留）。
2. **`__DS_BURN_START__ / __DS_BURN_END__` 标记段**（`tailwind.config.js:16-20`）把 `spacing`、`fontSize`、`boxShadow` 也从 token 表重写：

   | theme 键 | 映射到 → 效果 |
   |---|---|
   | `spacing.1/2/3/4/5/6/8/12` | `var(--space-1..12)` = 4/8/12/16/20/24/32/48px → 只覆盖 8 档，`gap-14`/`p-10` 仍走 Tailwind 原生刻度，**两套间距体系并存** |
   | `fontSize.xs..4xl` | `[var(--text-*), var(--leading-*)]` 二元组 → 字号与行高成对绑定，`leading-tight: 0.98` 让大标题紧贴 |
   | `boxShadow.none/sm/DEFAULT/md/lg/xl/focus` | `--elev-flat/--elev-ring/--elev-raised/.../--focus-ring` → **`md`/`lg`/`xl` 全部折叠成同一个 `--elev-raised`**，全站卡片只有一种阴影语言 |
**缺陷**：`keyframes`/`animation` 里 `accordion-down/up` **完整重复定义了两遍**（`tailwind.config.js:81-96` 与 `:97-112`；`:114-119` 同样重复），是生成器多次写入的残留。

### 5.2 CSS 变量与暗色主题

- `src/index.css` 的 `:root`（41-94 行）与 `.dark`（96-149 行）**逐行内容完全相同**（`--background: 0 0% 4%`、`--primary: 0 100% 43%`、`--foreground: 40 100% 97%`、`--muted-foreground: 37 12% 61%`、`--border: 22 18% 17%`），即"暗色即默认、没有亮色主题"；`darkMode: ["class"]` 配置在册（`tailwind.config.js:5`）却**无主题切换 UI**，`next-themes` 在依赖里但 0 引用。首帧防闪：`html,body,#root` 先写死 `#08090a`，再用 `@media (prefers-color-scheme: light)` 兜底白色（`index.css:5-19`），注释解释为"React 挂载和父页面主题消息到达前保持正确首帧"。
- 焦点环 `--focus-ring: 0 0 0 4px rgba(220,0,0,0.30)`（`index.css:77`）与 `--primary` 同色相，但**只有 `RhAccountMenu` 与登录横幅用了 `focus-visible:shadow-[var(--focus-ring)]`**（`RhAccountMenu.tsx:98,112`、`HomePage.tsx:37`），其余用 `focus-visible:ring-2 ring-primary`——**两套焦点语言并存**。
- 字号 token 是"海报级"的：`--text-2xl:40px / 3xl:62px / 4xl:88px`，而 `--text-xl:26px → --text-2xl:40px` 之间断层（缺 20/24/28/32/36），`--leading-tight: 0.98`（`index.css:80-89`）——这套刻度决定了页面是"杂志跨页"而非"后台表格"。中英混排工具 `.cjk-latin`（`index.css:35-38,154`）**全包 0 处使用**；字体栈三档（display/sans 同值 + mono）都显式带 `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC"`（`index.css:90-92`）。

### 5.3 卡片墙的排版决策（本包最值得抄的部分）

| 决策 → 实现与效果 |
|---|
| **统一 16:9 图位** → `aspect-video` 出现在 DirectorCard/WorkCard/StyleResultPanel 三处（`DirectorCard.tsx:19`、`WorkCard.tsx:15`、`StyleResultPanel.tsx:89,104,117`）：卡片高度可预测、网格不跳动，加载/错误/空态全用同尺寸占位块，**布局零抖动** |
| **文字压图靠渐变而非卡底** → `absolute inset-0 bg-gradient-to-t from-background via-background/30 to-transparent`（`DirectorCard.tsx:27-30`）：剧照是视觉主体，遮罩只保证底部文字可读；`from-background`（非纯黑）让遮罩与页面底色同源，无"贴了一块黑条"的割裂感 |
| **左下角三段式信息层级** → 英文名 `font-mono text-xs uppercase tracking-widest text-muted-foreground` → 中文名 `mt-1 text-2xl font-bold` → tagline 胶囊 `mt-2 inline-flex rounded-full border border-primary/50 bg-primary/10 px-3 py-1 text-xs text-primary`（`DirectorCard.tsx:31-38`）：mono+uppercase+tracking-widest 制造"档案标签"质感，中文名用 2xl 建立主次，胶囊用 primary/10 低饱和底 + primary/50 描边呼应主色而不刺眼 |
| **整卡可点 + 键盘可达** → 根元素是真 `<button>`（非 div+onclick）+ `aria-pressed={active}`（`DirectorCard.tsx:12-14`）：天然可 Tab/Enter，`aria-pressed` 让屏幕阅读器知道"已选中" |
| **两套卡片语义** → DirectorCard = 图主导（图 + 遮罩 + 压字）；WorkCard = 内容主导（图 + `p-5` 内容区 + `min-h-14` 标题行 + `mt-auto` 按钮贴底）：卡片墙（浏览/选择）用图主导，作品卡（阅读/触发）用内容主导，**同页两种卡、职责不混** |
| **悬停微动效** → DirectorCard `hover:-translate-y-1` + 图 `group-hover:scale-105 transition-transform duration-500`（`DirectorCard.tsx:15,23`）；WorkCard 无位移只有 `hover:opacity-90`（`WorkCard.tsx:36`）：位移只给"可跳转"的卡，"可提交"的卡用透明度，避免误导为跳转 |
| **入场动效** → Hero `animate-in fade-in slide-in-from-bottom-4 duration-700`（`HeroIntro.tsx:18`）、结果文字与结果图同样 700ms 淡入（`StyleResultPanel.tsx:58,100`）：只给"首次出现的内容"用长淡入，`animate-in` 来自 `tailwindcss-animate` |
| **加载态骨架代替 spinner** → RhAccountMenu ready 前渲染 `h-9 w-24 animate-pulse rounded-full bg-muted`（`RhAccountMenu.tsx:89-91`）；风格解读用 4 条 `h-3 animate-pulse rounded-full bg-muted`、宽度 100%/5-6/100%/2-3（`StyleResultPanel.tsx:46-55`）：宽度参差模拟真实段落，比居中转圈更少跳动；账号头像位用固定尺寸骨架避免 header 抖动 |
| **装饰层一律 `aria-hidden`** → 渐变层/光斑/分隔线/hero 图堆叠全部 `aria-hidden`（`HomePage.tsx:25`、`HeroIntro.tsx:15,16,40`、`CountrySection.tsx:19`、`DirectorCard.tsx:29`）：纯装饰不进可达树 |
| **图片懒加载 + 描述性 alt** → `loading="lazy"`（`DirectorCard.tsx:24`、`WorkCard.tsx:20`）；alt 是 `《花样年华》风格剧照` / `${director.name}的代表作《${cover.title}》风格剧照`：alt 带片名而非"图片" |
| **容器与分区节奏** → 统一 `mx-auto max-w-6xl px-4 sm:px-6`（1152px 上限）；分区统一 `border-t border-border py-14/py-16` + `scroll-mt-24`（`CountrySection.tsx:13`、`DirectorProfile.tsx:13`、`StyleResultPanel.tsx:36`、`StyleFilterBar.tsx:9`）：`scroll-mt-24` 精确抵消 sticky header 高度，锚点跳转不被遮挡 |
| **红黑高级感** → `--background: 0 0% 4%`（近纯黑）+ `--primary: 0 100% 43%`（纯正红）+ `--foreground: 40 100% 97%`（暖白）+ 右上角 `bg-primary/20 blur-3xl` 光斑（`HeroIntro.tsx:16`）+ 顶部 `from-primary/15` 渐隐（`HomePage.tsx:24`）：黑幕 + 红主色 + 暖白文字，比我们当前的黑金更贴"电影"语境 |

## 6. 工程实现技巧

### 6.1 请求层：超时 → 降级为轮询

LLM 链路的核心设计是**"同步等待 25s 就主动放弃，改走 poll"**（`llm.ts:40,115-117`）：`AbortController` + `window.setTimeout(() => ctrl.abort(), 25000)`，`opts.signal` 的 abort 会级联到内部 controller。注释交代原因（`llm.pb.js:21-23`）：`/chat` 仍是同步 `$http.send`，但客户端提前放弃等待转 `/poll`，**后端 handler 必须继续跑完并写 `llm_jobs`**——慢模型的长输出不能靠调低 `timeout_s` 解决，要用 `max_tokens` 控延迟。

AIGC 提交侧是**有限重试**（`aigc.ts:633-682`）：

| 情况 → 处理 | 证据 |
|---|---|
| 5xx / 网络层抛错 → 等 1500ms 重试，**最多 3 次** | `aigc.ts:656-681` |
| 412（登录态过期）/ 其它 4xx → **立即 break 不重试**（"重试也救不回来"） | `aigc.ts:650-654` |
| 2xx → break 进 poll；abort → 立刻返回 `errorKind:'aborted'` | `aigc.ts:666-673` |

### 6.2 轮询：单一共享循环 + 递增间隔 + 模型自适应 deadline

- `pollAigcToResult()` 是**唯一**的 poll 循环，被"提交后立即轮询"(`callAigcAndPoll`) 与"恢复已有任务"(`resumeAigcJob`) 共用；注释明确"两者的轮询/超时/错误映射语义必须完全一致，不要各写一份容易漂移"（`aigc.ts:511-516`）。
- 间隔递增：`interval = Math.min(interval + 500, 5000)`，从 2500ms 起（`aigc.ts:533,540`）。
- deadline 自适应：按模型名识别长跑任务（`seedance`/`sparkvideo`/`happyhorse`/`video`/`audio`/`music`/`3d`/`mesh` 等 13 个关键词），命中则 30 分钟、否则 8 分钟（`aigc.ts:262-279,526`）。
- **恢复语义**：`resumeAigcJob` 的 deadline 是"从这次 resume 调用开始再等这么久"，而不是"从提交时刻算起还剩多久"——注释明确"对一个已经跑了很久的任务重新 resume 也不会立刻超时"（`aigc.ts:749-753`）。
- 网络抖动 catch 后 `continue`（不消耗失败预算），5xx/其它 4xx 也当瞬时继续轮询（`aigc.ts:551-557,568`）。
- **404 快速失败**：两种代际路由都 404 = 后端根本没这个 poll 路由，立即返回 `poll route not found (HTTP 404)`，不空转到 deadline（`aigc.ts:564-567`）。

### 6.3 断点恢复（页面级）

`loadHistory()` 在挂载时做三件事（`useHome.ts:118-144`）：① 拉最近 20 条历史；② 把最近一张 `status==='success' && resultUrl` 的记录恢复到主展示区（含回填 `prompt`）；③ **把 `status==='running'` 的孤儿任务逐个 `resumePollingJob(jobId)` 续跑**——注释解释"RH 那边任务其实早就跑完了，只是没人来 poll 把结果写回 aigc_tasks"（`aigc.ts:737-739`）。`resumePollingJob` 用 `resumingJobIds: string[]` 记录正在恢复的任务（`useHome.ts:64,146-147,172`）；`activeGenRef` 用来防止"恢复的历史结果"覆盖"用户当前正在生成的结果"（`useHome.ts:129,162`）。

### 6.4 成本/价格预估与扣费确认流（本包最完整的一套）

四层结构：

1. **价格预估**：`previewAigcPrice(MODEL, {resolution, aspectRatio, prompt})` → `POST /api/aigc/price-preview`，后端把 `/openapi/v2/<endpoint>` 换成 `/openapi/v2/price-preview/<endpoint>` 转发，**任何失败都返回 `{ok:false}`，不抛错、不 412**（`aigc.pb.js:684-819`、`aigc.ts:1042-1059`）。
2. **500ms 防抖**：参数变化立刻进 `priceLoading=true`，debounce 500ms 后请求，`finally` 复位（`useHome.ts:100-116`）。
3. **三态徽标**：`priceLoading ? '预估中' : (priceText || '按实际扣费')`（`StyleResultPanel.tsx:85`）。`useHome.ts:67-68` 有一条明确的工程注释：**禁止 View 用 `priceText || '费用预估中'`**——"失败/空价会被误当成一直在加载"。`formatAigcPricePreview` 处理 RH 只回 `estimatedPrice` 不回 `priceText` 的情况，返回 `约 N CNY`；返回 `null` 时降级为"按实际扣费"，**绝不能用"预估中"当失败兜底**（`aigc.ts:1022-1035`）。
4. **确认弹窗 + 当天免提醒**：`useCostConfirm()` 把待执行动作存在 `pendingActionRef`，弹窗确认后才执行（`useCostConfirm.ts:37,43-62`）；勾选后写 `localStorage['vibex_cost_confirmed_today:<appId>'] = {expiresAt: 今日23:59:59.999}`（`costConfirm.ts:37-38`）。**当天已确认则直接执行 action**，注释解释这仍算"用户触发"，因为首次确认本身来自显式点击，且抑制范围限定"本 app + 今天"（`useCostConfirm.ts:40-42`）。

合约性约束（写在源码注释里，是平台的审计契约）：**禁止加全局"不再提醒"键，禁止退回 `window.confirm`/`alert`/`prompt`**（`useCostConfirm.ts:27-28`）。`CostConfirmDialog` 的 props 类型是 `Pick<UseCostConfirmResult, ...>`，所以页面必须 `{...cc}` 展开而不能手写 prop 名（`CostConfirmDialog.tsx:9-14`、`useCostConfirm.ts:19-22` 注释说明"手写会静默传 undefined，弹窗永不打开"）。**真实扣费明细**：`AigcUsage.thirdPartyConsumeMoney` 是实付金额，注释要求"直接拼 ¥ + 字段，不要 parseFloat 再格式化"（`aigc.ts:50-52`），并作为快照落库到 `aigc_tasks`（`aigc.pb.js:918-919`）。

### 6.5 双代际后端兼容（探测式降级）

三个模块级**三态**变量（`null`=未探测 / `true`=老代际 / `false`=新代际），404 时改打旧路由重试一次并记住结果，重试仍 404 则复位：

| 变量 → 新旧路由 | 证据 |
|---|---|
| `legacyLlmRoutes` → `/api/llm/chat` ↔ `/api/llm/<model>/chat` | `llm.ts:44-58,128-143` |
| `legacyAigcRoutes` → `/api/aigc/submit` ↔ `/api/aigc/<model>/submit` | `aigc.ts:289-313` |
| `legacyAigcUploadRoute` → `/api/aigc/upload` ↔ `/api/aigc/media/upload` | `aigc.ts:420-425,457-462` |

注释交代动机（`aigc.ts:420-424`）：发布刷新只换前端 lib、不动 app 已装的 pb_hooks，所以老后端上新路由会 404——**真实事故**在案："app-bcbdf4c8 老 hook + 刷新后新 lib，上传全 404"。更细一层是**同名函数的契约多态**：`uploadAigcMedia(file, fileType?)` 新契约返回对象、老契约 `(file, filename)` 返回 URL 字符串，实现用**运行时类型嗅探**——第二参不在 `AIGC_UPLOAD_FILE_TYPES` 白名单里就判为老契约（`aigc.ts:430-481`）；注释解释"打包器不做类型检查，这种同名不同契约的漂移不会在构建期暴露，只能运行时多态"（`:432-435`），并附事故"刷新后当天 190 个 `content[N].image_url is invalid`"。

### 6.6 错误处理与错误码文案映射

- **8 值稳定枚举 → 中文表**：`AIGC_ERROR_MESSAGES_ZH: Record<AigcFailure['errorKind'], string>`（`aigc.ts:146-155`），页面按 `errorKind` 分支，不解析文案。
- **安全格式化**：`formatAigcFailureMessage()` 对**所有** errorKind 都把上游真实原因拼在中文文案后，除非它是内部占位串（`AIGC_ERROR_PLACEHOLDER_VALUES` 6 个）或与本地化文案相同；`login_required` 例外，只展示引导文案不拼技术码（`aigc.ts:208-222`）。注释明确反对"白名单挑着拼"："白名单漏掉的分支（最常见就是 task_failed）会把 RunningHub 的真实报错吞掉，只剩一句通用文案，用户看不出实际失败原因（比如 '音频时长过短'）"。
- **登录信号多源识别**：`isLoginRequiredSignal(status, ...parts)` 判 `status===412||401`，再在**把任意类型参数 stringify 后拼成的 haystack** 里找 6 个特征串：`sandbox_token_required`/`sandbox_api_key_missing`/`rh_login_required`/`login_required`/`登录态已过期`/`请先登录`（`aigc.ts:168-196`）。注释说明两个来源："发布沙箱未登录 → control 401 `{detail:{code:"SANDBOX_TOKEN_REQUIRED"}}`；RH key/登录态失效 → hook 412 `rh_login_required`。两者都要引导登录，不能落成'网络繁忙'"。
- **业务错误分类**：`classifySubmitBusinessError()` 把上游 `errorCode`/`error`/`message`/`detail.code` 归到 `insufficient_balance`（含中文 `余额`/`点数`/`积分` 与错误码 `605`）、`content_audit`（正则 `content security audit|内容安全审查|内容审查|审核未通过|content moderation`）、`submit`（`aigc.ts:315-350`）；poll 终态失败时同样跑内容审核正则（`:585-597`），注释解释"重试同 prompt 救不回来，必须用 content_audit 让前端显示'换个表达试试'"。
- **页面层映射**：`LLM_ERROR_ZH` 5 条（`useHome.ts:29-35`），默认兜底 `'风格解读生成失败，请重试'`（`:261`）。

### 6.7 并发控制 / 缓存 / 表单校验 / a11y

- **并发**：多文件上传用 `setTimeout(i * 300)` **错峰**，避免同时打满上传端点；单个失败被跳过而非整批失败；`opts.maxCount` 超出直接截断（`aigc.ts:997-1020`）。
- **请求级幂等缓存**：`llm_jobs` 表 `request_id` 建**唯一索引**（`llm.pb.js:51`）；`/chat` 进来先 `findOrCreateJob`，若记录已是 `success`/`failed` 则直接返回缓存文本（`cached: true`）（`llm.pb.js:174-182`）。前端 `uuid()` 优先用 `crypto.randomUUID`，超时后拿同一个 id 去 poll（`llm.ts:60-65,103,171`）。
- **表单校验**：本包几乎没有表单——唯一输入控件是 CostConfirmDialog 的 checkbox，校验退化为一行 `canGenerate = prompt.trim().length > 0 && !isGenerating`（`useHome.ts:353`），`runGenerate` 里再兜一次（`:178`）。
- **a11y 现状**（比我们当前水平低，仅列可对照项）：✅ `CostConfirmDialog` 有 `role="dialog" aria-modal="true"` + 遮罩点击取消 + 内容区 `stopPropagation`（`CostConfirmDialog.tsx:28-36`）；✅ `DirectorCard` 用真 `<button aria-pressed>`；✅ 装饰层 `aria-hidden`、图片描述性 alt。❌ **无 ESC 关闭弹窗、无焦点陷阱、无关闭后焦点归还**（对比我们已落地 `ui.js:97-127` 的 focusables 陷阱 + `opener.focus()`）；❌ 无 toast `aria-live`（对比我们 `index.html:18` 已加 `role="status" aria-live="polite"`）；❌ `RhAccountMenu` 手写 Escape 与外点关闭（`RhAccountMenu.tsx:55-71`），但菜单项无 `aria-current`/无 roving tabindex；❌ 按钮禁用态只有 `disabled` + `opacity-50`，无 `aria-disabled` 语义。

### 6.8 其他工程细节

| 技巧 → 实现 | 证据 |
|---|---|
| 跨域结果下载 → 直接用 `a.href + a.download` 对跨域 URL 无效（浏览器忽略 download），必须先 `fetch` 拿 blob 再 `URL.createObjectURL`；失败兜底 `window.open` | `aigc.ts:1092-1117` |
| 子路径部署 basename → `getBasename()` 返回 `/app-preview/app-<32hex>` 交给 `<BrowserRouter basename>`，避免站内 `navigate('/x')` 掉到域名根 | `pb.ts:19-24`、`main.tsx:15` |
| 二进制上传跳过 base64 → 注释明确"不要再用 `fileToDataUrl` 把几十 MB 视频转 base64 塞 JSON：Goja 单线程逐字符解码会锁死 PB → 502/524" | `aigc.ts:483-487` |
| 工程反模式 → `templates/scaffold/src/` 是 `src/` 的**完整副本**（22 个 tsx），改 `src` 不会同步 scaffold | `find templates/scaffold/src -name "*.ts*" \| wc -l` = 22 |

## 7. 可借鉴点 → 我们的具体落点

以下 10 条按"性价比"排序，每条给「他们的做法（证据）→ 我们现状（本次读码实证，含当前 HEAD 行号）→ 具体改造建议（落点文件 / 改动量 / 风险）」。改动量分级：**S** ≤ 半天、**M** 1-3 天、**L** 3 天以上。

### 7.1 付费动作前的「成本确认 + 当天免提醒」——**最高性价比**

- **他们**：`useCostConfirm()` + `CostConfirmDialog`，`pendingActionRef` 存待执行动作、确认后才跑，勾选后写 `localStorage['vibex_cost_confirmed_today:<appId>']={expiresAt: 今日24点}`（`useCostConfirm.ts:37-62`、`costConfirm.ts:16-38`）；弹窗正文明确写"可能消耗 RH 币或钱包余额"（`CostConfirmDialog.tsx:42-45`）。
- **我们现状**：**无任何提交前成本确认**。`grep -rn "price\|cost\|预估\|计费\|扣费" public/js lib server.js` 只命中防重复扣费的注释与 `storyboards.js:405` 的 `concurrency: 1`（注释"视频默认串行提交，避免重复扣费"），无 UI 层确认。真正花钱的四处入口直接提交：批量出图 `storyboards.js:353-371`、批量出视频 `storyboards.js:380-409`、单发出视频 `videos.js:304-312`、单张图片生成 `images.js:180-194`。唯一的 `confirm()` 用于**删除**（`images.js:247`、`storyboards.js:454` 清空本集），即"删东西要确认，花钱不用"。
- **建议**：`ui.js` 的 `confirm()` **已经支持 `checkbox` 选项并返回 `{confirmed, checked}`**（`ui.js:191-227`，唯一调用方 `projects.js:101` 用它做"连带删除"）。所以只需：① 在 `ui.js` 新增 `costConfirm(o)` 薄封装（内部调 `confirm`，文案固定为"将调用 Agnes 生成 N 张图/条视频，产生真实费用"+ checkbox"今天内不再确认"）；② 落点 `public/js/pages/storyboards.js:353`（batchImages，`:366` 传 `concurrency:3`）、`:380`（batchVideos，`:405` 传 `concurrency:1`）、`public/js/pages/videos.js:304-308`（提交钮）、`public/js/pages/images.js:180`（生成图片）；③ 免提醒键仿 `assets.js:15` 的 `agnes.assets.favOnly` 既有模式，用 `agnes.cost.skipUntil`（存时间戳而非布尔，当天 24 点过期）。
- **改动量 S**（约 40 行，全复用现成 `confirm`）。**风险**：低。唯一争议是"每次生成都弹一次烦"，用默认勾选 + 当天免提醒消解。注意别做成"删东西也弹两次"。
- **配套项：偏好持久化用带过期时间戳而非布尔**：免提醒状态用**带 `expiresAt` 的时间戳**而非布尔（他们 `costConfirm.ts:20-24,37-38`，读时校验 `expiresAt > Date.now()`，过期自动失效、无需清理任务）。我们 `public/js/pages/assets.js:15,39-41` 已有 `agnes.assets.favOnly` 的**布尔**持久化，**无任何带过期的偏好**。建议把 `rememberUntil(key, ms)` / `readUntil(key)` 两行工具放进 `public/js/consts.js`（与 `esc`/`uid`/`fmtTime` 同区），首用者即本条的免提醒，次用者可给 `tasks.js:47` 的状态过滤器记住上次选择。**改动量 S**，风险极低。



### 7.2 错误码 → 稳定枚举 → 中文表，并**总是拼接上游原文**

- **他们**：`AigcFailure.errorKind` 是 8 值稳定英文枚举（`aigc.ts:129-137`），中文表 `Record<errorKind, string>`（`aigc.ts:146-155`）；`formatAigcFailureMessage` 对**所有** kind 都把上游原文拼在中文后（仅跳过内部占位串），注释明确反对"白名单挑着拼会吞掉真实报错"（`aigc.ts:208-222`）。
- **我们现状**：后端**已经**产出结构化 `errorType`（`lib/agnes.js:49`、`:60` `no_api_key`、`:115` `proxy_timeout`/`network_error`、`:145` `invalid_api_key`/`agnes_error`、`:314` `no_video_id`、`:452` `download_unauthorized_host`、`:454` `download_failed`），`api.js:25` **也把它透传到前端** `errorType`——但 `grep -rn "errorType" public/js/` 显示**页面层 0 个消费者**，字段是死的。前端一律 `toast.err(r.error)` 直接显示后端原始字符串（如 `images.js:194`、`storyboards.js:370`、`videos.js:308` 的失败分支），错误类型无法驱动不同 UI（重试钮 / 去设置页配 Key / 提示换措辞）。
- **建议**：① `public/js/consts.js` 新增 `ERROR_HINTS = { no_api_key: {label:'未配置 API Key', action:{go:'#/settings', label:'去设置'}}, proxy_timeout: {retry:true}, ... }`；② `public/js/ui.js` 新增 `errBox(r)`（基线 §0.3 已提到 dashboard 用 `errBox`，可扩展为带 action 的版本）在 4-6 个高频失败点替换裸 `toast.err`：`images.js:194`、`storyboards.js:370`（批量出图）与 `:408`（批量出视频）、`scripts.js:168`、`videos.js:315`。③ 后端在 `lib/agnes.js` 抛错处把上游 message 一并保留（已有，`e.message`）——前端展示时按"中文短句 + `：` + 原文"格式拼，避免只剩"网络异常"。
- **改动量 M**（新增映射表 + 3-6 处调用点替换）。**风险**：中低——需要逐处确认 `r.error` 原文里没有重复中文（我们后端 message 已是中文，拼接前要判重，直接照抄他们的 `raw !== base` 判断即可）。

### 7.3 「风格库 = 手写风格描述 + 数据驱动筛选」的产品资产化

- **他们**：50 部作品的 `stylePrompt` 全部**手写**，统一句式 `<年代/类型 genre>: <色彩>, <主体/服饰>, <光>, <空间>, <情绪>, <胶片质感>`（`filmLibrary.ts:53-54,63-64`）；`styleLabel`/`styleTag` 只做筛选与导购、绝不进提示词（`useHome.ts:360`）；`STYLE_LABELS` 由数据去重派生而非手写常量（`filmLibrary.ts:821-823`）。
- **我们现状**：**无风格库、无导演/作品数据**。最接近的是两个散件：① `public/js/consts.js:221-232` 的 `ART_STYLE_MAP` 10 条画风映射（`'日漫厚涂' → 'japanese anime style, thick painterly shading'`），由 `artStylePhrase()` 追加到提示词尾部（`consts.js:233-240`），后端 `lib/routes.js:22-40` 有一份**必须同表**的镜像（注释 `consts.js:219` 说明 uitest 有文本比对钉）；② `public/js/consts.js:193-218` 的 `PRESET_TERMS` 18 条预设词（运镜/光线/质感 3 类，中文 label + 英文短语，注释说是"竞品 113 条库的精简子集"）。
- **建议**：把 `ART_STYLE_MAP` 从"10 条字符串映射"升级为**带描述的风格库数据结构**（`{id, label, tagline, stylePrompt, examples[]}`），落点 `public/js/consts.js:221`，并让 `public/js/pages/settings.js:239-280` 的模板表旁边新增"风格库"分节复用同一数据；后端 `lib/routes.js:22` 的镜像改为从 `lib/seed.js` 读（`seed.js:184-190` 已有 `existing` 去重插入模式）。**关键取舍**：只搬"数据结构 + 筛选交互"，不搬 50 部具体电影数据（版权与体量都不合适），我们用自己的"题材×画风"二维网格。
- **改动量 L**（新数据结构 + 前端分节 + 后端镜像改造 + uitest 钉同步）。**风险**：中——`ART_STYLE_MAP` 有前后端同表钉（`consts.js:219`、`lib/routes.js:1095-1096` 导出），改造必须同步 `tools/uitest.mjs` 的比对断言，否则门禁红。

### 7.4 「同风格再生成」的场景变体池（variation 取模轮换）

- **他们**：`SCENE_VARIANTS` 6 条**只描述"拍什么"不含风格词**的英文场景（`filmLibrary.ts:826-833`），`composeImagePrompt(work, variation)` 取模轮换且做了负数安全（`:835-837`）；`再生成一张` 只在成功后出现（`canGenerateMore`，`useHome.ts:367`、`StyleResultPanel.tsx:125`）。
- **我们现状**：**无场景变体概念**。分镜提示词由模板一次性生成（`storyboards.js:323-329` 的 `sys`/`user` 提示词对，`api.genText` 在 `:329`），或手动在 `editShot(shot)` 弹窗（`storyboards.js:463`）里改（`:487` 负面提示词 textarea、`:508` 保存）。"再生成一张"等价物是**重跑同一条 prompt**（`:353` 批量出图 / `:411` 单发出图），结果近似但无系统性变化。
- **建议**：`public/js/consts.js` 新增 `SCENE_VARIANTS` 6 条；在 `storyboards.js:463` 的 `editShot` 弹窗加"换一个镜头变体"按钮，点击把变体追加进 `image_prompt` 并记 `variation` 计数；批量出图时按行 index 取模分配变体，让一次批量的 N 张图彼此不同（当前同一 prompt 批量出 N 张会大量近似重复，正是 `:353` 的实际痛点）。**改动量 M**。**风险**：中——变体词若与用户手写 prompt 冲突会降低质量，建议做成可选开关而非默认注入。

### 7.5 任务断点恢复的**"deadline 从本次恢复起算"**语义

- **他们**：`resumeAigcJob` 的 deadline 是"从这次 resume 调用开始再等这么久"，不是"从任务提交时刻算起还剩多久"，注释明确"对一个已经跑了很久的任务重新 resume 也不会立刻超时"（`aigc.ts:749-753`）。
- **我们现状**：服务端轮询 `lib/poller.js` 的预算机制是**次数上限** `maxPolls()`（默认 60 次，`poller.js:49-52`），计数存在内存 `counts` Map（`poller.js:20`）。`watch()` **每次都会 `counts.set(assetId, 0)` 重置计数**（`poller.js:164`），而 `resume()` 在服务重启时对每个活跃任务调 `watch(v.id, true)`（`poller.js:169-173`）——即**重启一次 = 预算重置一次**，一个长期不出片的僵尸任务可以靠反复重启无限轮询；反之 `tasks.js:250-256` 的「重新获取结果」走 `api.refreshVideo(id)` → `poller.pollOnce` 单次查询，不重置预算，行为不一致。
- **建议**：把 `counts` 的语义从"本次会话轮询次数"改为"该任务累计轮询次数 + 最后轮询时间戳"，落点 `lib/poller.js:20,104-114,159-166`；`watch()` 不再无条件清零，改为只在"从未轮询过"时初始化；`/api/videos/:id/refresh`（`lib/routes.js` 的 refresh handler）显式重置一次并记日志。这样"重启"与"手动重取"对预算的影响变得显式可控。
- **改动量 S**（约 15 行）。**风险**：中低——`counts` 是纯内存态，改动不影响 `data/*.json` 落库；但需跑 `tools/apitest.mjs` 确认 `poll_timeout` 相关断言（`consts.js:162,183` 的状态词）不被打乱。

### 7.6 轮询节奏可视化（我们已领先，仅补时长预期）

- **他们**：结果面板只有固定文案 `新剧照生成中，通常需要 30–90 秒…`（`StyleResultPanel.tsx:92`），**无进度证据**。
- **我们现状**：**已实现且更强**——`lib/poller.js:89-90` 推 `poll_attempts`/`poll_interval_s`，`public/js/pages/tasks.js:157` 渲染 `第 N 次查询 · 每 Ns`。
- **可补一小步**：他们的固定文案给了**时长预期**，我们只有次数与间隔，用户仍需自己换算。建议在 `tasks.js:157` 追加"约需 N 分钟"（`poll_interval_s × 预期次数`）。**改动量 S**，风险低。

### 7.7 前端请求超时/取消（我们的 `api.js` 完全没有）

- **他们**：`llm.ts:115-117` 用 `AbortController` + 25s 超时主动放弃并降级；`aigc.ts` 全链路支持 `opts.signal`，abort 返回结构化 `errorKind:'aborted'` 而非抛异常（`aigc.ts:536-538,552-555`）。
- **我们现状**：`public/js/api.js` 全文 99 行，`req()` 只用裸 `fetch(url, opts)`，**无 `AbortController`、无 `AbortSignal.timeout`**（`grep -rn "AbortController\|AbortSignal" public/js/` 零命中）。这意味着：`api.genText`（`api.js:90`，后端超时 120s，`lib/agnes.js:163`）、`api.genImage`（120s）、`api.batchVideos` 期间用户**无法取消**，`setBusy` 秒表会一直转（`images.js:180-191` 的 `finally` 只在 promise settle 后才解锁）；页面卸载也不会中止请求，`app.js:76` 的 `cleanup()` 无法取消在途请求。
- **建议**：给 `api.js:6-28` 的 `req()` 加第 4 个可选参数 `{timeoutMs, signal}`，默认 `timeoutMs` 取一个较宽的值（如 180000，需 > 后端最长 150s，`lib/agnes.js:302`），并在超时/abort 时返回 `{ok:false, errorType:'client_timeout'}`（复用 §7.2 的映射表）。页面侧只需在长任务（`images.js:180`、`storyboards.js:353`、`videos.js:304`）把 `setBusy` 的按钮改成"取消"，调用 `ctrl.abort()`。
- **改动量 M**。**风险**：**高**——客户端 abort 不等于服务端停止，Agnes 可能已接单计费（这正是 `lib/agnes.js:74-77` 的 `possiblySent` 机制在防的事）。因此必须把"取消"文案写成"停止等待（后台可能仍在生成）"，并在后端把该任务标 `submit_timeout_unknown` 而非 `failed`。**建议只做超时不做取消**（改动量降为 S，风险降为低）。

### 7.8 三态加载徽标 / 禁止用"加载中"当失败兜底

- **他们**：`priceLoading ? '预估中' : (priceText || '按实际扣费')`，并有注释**禁止** `priceText || '费用预估中'`（`useHome.ts:67-68`、`StyleResultPanel.tsx:85`）；`formatAigcPricePreview` 返回 `null` 表示"拿不到价"，与"还在加载"严格区分（`aigc.ts:1022-1035`）。
- **我们现状**：多处用同一个变量同时表示"加载中"和"空/失败"（如 `dashboard.js` 统计区失败时 spinner 永转）；`public/js/ui.js:281-283` 的 `spinner(text)` 是唯一加载态组件，**无骨架屏**（`grep -rn "skeleton\|骨架" public/js public/css` 零命中）。
- **建议**：① 引入**显式三态**约定（`loading`/`value`/`failed`），先在 `images.js:83` 的 `#gallery` 与 `dashboard.js` 统计区落地：失败渲染 `errBox` + 重试钮，而不是继续 spinner；② 给 `public/css/app.css` 新增 `.skeleton` 类（`background: var(--card); animation: pulse 1.4s infinite`，复用已有 `@keyframes pulse`，`app.css:482`），在 `images.js:83` 与 `assets.js` 网格加载期渲染 N 个 `.asset-card` 形状骨架——**照抄他们"骨架用固定 aspect-ratio 占位、布局零抖动"的做法**（`StyleResultPanel.tsx:46-55`、`RhAccountMenu.tsx:89-91`）。**改动量 M**，风险低（骨架数量需按容器宽度估算，避免 3 列布局塞 6 个骨架导致换行抖动）。

### 7.9 单页"锚点流"结构替代多页跳转（用于风格库这类重展示页）

- **他们**：整站只有 1 个页面 + 3 个滚动锚点（`country-<id>`/`director-archive`/`style-result`），用 `scrollIntoView({behavior:'smooth', block:'start'})`（`HomePage.tsx:12-14`）+ `scroll-mt-24` 抵消 sticky header（`CountrySection.tsx:13` 等 4 处）。选导演、出结果、点国家导航**全部在页内平滑滚动**，用户从不离开"浏览上下文"。
- **我们现状**：9 个独立页面 + hash 路由（`public/js/app.js:8-16` 的 9 个 import、`:45-50` 的 `parseHash`），跨页跳转用 `navigate()`（`:61-64`）。风格展示相关能力分散在 4 个页面：`assets.js`（图片网格墙）、`images.js`（生成表单+已生成网格）、`storyboards.js`（分镜表）、`projects.js`（项目卡），想看"某个画风下的所有作品"要跨 2-3 页拼。
- **建议**：**不要**把 9 页合并成 1 页（与我们的专业工具定位冲突）。只吸收两点：① 给 `public/css/app.css` 的 `.page`/卡片标题区加 `scroll-margin-top`——当前无 sticky header 所以暂不需要，但**若后续引入 sticky 页头，锚点跳转必须同步加 `scroll-mt`**，否则目标被遮挡；② 真正值得落的是**深链**：让 `#/assets?style=<id>` 可直接打开筛好的视图，这正是我们已有但**未接线**的 `syncViewParams`（见 §7.10）。**改动量 S**（CSS 一行）或 **M**（深链），风险低。

### 7.10 视图状态写回 URL（我们的函数已写好但 0 调用）

- **他们**：无 URL 状态（这是他们的**缺点**，刷新即丢筛选与选中导演，`useHome.ts:80-82` 初始值写死）。
- **我们现状**：`public/js/app.js:52-59` 已实现 `syncViewParams(patch)`，用 `history.replaceState` 静默同步、不触发 hashchange；注释明确"刷新与分享链接可还原"。但 `grep -rn "syncViewParams" public/js/` 显示**只有 5 个页面 import 了它**（`tasks.js:13`、`scripts.js`、`storyboards.js`、`settings.js`、`assets.js`），`dashboard.js`/`images.js`/`videos.js`/`projects.js` **完全未接**；更关键的是**没有任何一处把派生视图状态写进去**（assets 的 `favOnly`、tasks 的 `status` 过滤器都是同类）。
- **建议**：这是一条**反向借鉴**（他们的缺失正好验证我们方向对）。具体补：① `assets.js:39-41` 的 `favOnly` 切换时调 `syncViewParams({fav: favOnly ? '1' : null})`，mount 时从 `params.fav` 读初值（当前只从 localStorage 读，`assets.js:15`）；② `tasks.js:47` 状态过滤器与 `:53` 搜索框同步进 hash；③ `images.js:35` 的 `mode`（文生图/图生图 segmented）同步进 hash——目前切换只改内存。**改动量 S**（每处 2-3 行，函数已存在）。**风险**：低——`replaceState` 不触发重挂载；注意别在 `params` 里塞长文本。

## 8. 不值得借鉴 / 边界

以下做法与我们的约束（**零 npm 依赖、本地优先、vanilla JS ESM、无构建步骤**）直接冲突，明确放弃：

| # | 他们的做法（证据） → 为什么放弃 |
|---|---|
| 1 | **40 个 npm 依赖、shadcn/ui + Radix 24 包**（`package.json:14-56`），需 Vite 构建 + `tsc -b` → 我们是 `node server.js` + 浏览器直接加载 ESM，**无构建、无 node_modules**；引入任何 npm 包都会破坏 SEA 单文件 exe 与"双击即用"。我们的 `public/js/ui.js`（253 行）已覆盖 modal/confirm/prompt/empty/spinner/toast 六件套，**手写 60 行胜过 24 个 Radix 包** |
| 2 | **Tailwind + PostCSS 构建期 class 提取**（`tailwind.config.js`、`postcss.config.js`）→ Tailwind 产物是构建期生成的 CSS，无构建则不可用。我们的 `public/css/app.css`（902 行手写 + CSS 变量 token）已实现同类语义（`--gold-*`/`--text-*`/`--radius-*`），且**运行时可被测试直接读取**（`tools/ui-audit.mjs` 靠它做对比度与截断度量）。放弃 Tailwind 不是妥协，是我们能做**自动化设计度量**的前提 |
| 3 | **`__DS_BURN__` 生成器把 spacing/fontSize/boxShadow 重写进 theme**（`tailwind.config.js:16-20`）→ 我们已因"14 档半像素字阶、28 个间距 px 值"吃过碎片化的苦（基线 §10.1/§10.2）。竞品这套"重写部分键"**只覆盖 8 档 spacing**，剩下仍走原生刻度，等于把碎片化藏进配置层，比我们的显式字面量更难审计。**不学**；反而应把 `--radius-*`/`--gold-*` 收得更紧 |
| 4 | **前端直连 PocketBase + `pb_hooks` 里的 JS（Goja）后端**（`pb.ts:26`、`pb_hooks/*.pb.js` 共 1508 行）→ 我们的后端是 Node 原生 `lib/*.js`，有真实的 `AbortSignal.timeout`/`fs`/子进程能力；Goja 单线程的坑（他们自己注释：base64 逐字符解码锁死 PB → 502/524，`aigc.ts:483-487`）我们天然没有。**不引入 PB** |
| 5 | **平台耦合三件套：服务端托管 RH 登录态取 Key**（`llm.pb.js:84-87`）、**Vite plugin 注入 `data-rh-src` 做在线可视化编辑**（`vite.config.ts:18-73`，需 @babel/parser + magic-string）、**`templates/scaffold/` 完整复制 `src/`**（22 个 tsx）→ 我们的 Key 存本机 `data/settings.json` 且**从不回传前端**（`agnes.js:165`，`lib/routes.js` settings handler 只回 `has_api_key` 布尔）；可视化编辑需 babel AST 改写，与"无构建"根本冲突；双份源码必然漂移。我们若需模板，应像 `lib/seed.js:184-190` 那样**单一数据源 + 运行时去重插入** |
| 6 | **同一常量在文件内复制 6 次**（`aigc.pb.js` 的 `ALLOWED_MODELS` 出现在 `:32/:341/:632/:687/:875/:1027`）→ Goja 自包含约束下的妥协，代价是"加一个模型要改 6 处"。我们的 `lib/routes.js:22` 的 `ART_STYLE_MAP` + `:1095-1096` 导出给前端镜像已经更好；**不学复制**，反而应把镜像改成后端单一来源 + `GET /api/bootstrap` 下发 |
| 7 | **重复定义与死配置**：`keyframes/animation` 重复两遍（`tailwind.config.js:81-112`）、`:root` 与 `.dark` 逐行重复（`index.css:41-94` vs `96-149`）、`chart.*`/`sidebar.*` 主题键 0 使用、`next-themes` 装了不用 → 生成器残留是维护负担。我们的 `app.css` 手写单一来源，**保持** |
| 8 | **`*` 路由回落首页、无 404 态**（`App.tsx:8`）→ 我们也有同样问题（基线 G-8 "未知路由静默回落 dashboard"），但**不该学它连地址栏都不修**；若要做，应修 G-8 而不是复制它 |
| 9 | **`prompt`/`resolution`/`aspectRatio`/`runGenerate` 整条链路存在但 UI 无入口**（`useHome.ts:177-222`，视图中 0 引用）→ 死代码 + 死状态。我们的基线已记录多起"导出后 0 引用"（`helpers.js:55-70` 三个表单构造器、`ui.js:266-274` 的 `on()`/`dataOf()`，本次复核仍为 0 引用）。**不学**；若我们新增风格库，必须**先接 UI 再留状态** |

**另有两条"他们做得对但我们暂不跟进"**（非冲突，是优先级）：

- **50 条手写英文 `stylePrompt` 的资产投入**（`filmLibrary.ts:32-818`，占该文件 92%）：质量确实高，但需影视领域人工撰写 + 版权敏感性审查（片名/剧照），短期不是我们的瓶颈。我们应先把自己的 `ART_STYLE_MAP` 10 条做深（§7.3）。

## 附：本报告可复现的核对命令

```bash
# 竞品侧（被研读包根目录）
find src -name "*.ts" -o -name "*.tsx" | wc -l            # 36
grep -rn "components/ui" src/                              # 空 → ui/* 10 个文件全死
grep -rhoE 'from "[^".][^"]*"' src/ | sort | uniq -c | sort -rn   # 实际依赖面仅 5 个
grep -c 'styleLabel: "' src/lib/filmLibrary.ts             # 25 位导演
grep -c 'stillUrl: ' src/lib/filmLibrary.ts                # 51（含接口字段声明，作品实为 50）
grep -rni "negative" src/                                  # 空 → 无负面提示词
# 我们侧（agnes-manga-studio 根目录）
grep -rn "AbortController\|AbortSignal" public/js/          # 空 → 前端无超时/取消
grep -rn "errorType" public/js/                             # 仅 api.js:25 透传，0 消费者
grep -rn "syncViewParams" public/js/                        # 5 页已接，4 页未接
grep -rn "skeleton\|骨架" public/js public/css              # 空 → 无骨架屏
grep -rn "price\|cost\|预估\|计费\|扣费" public/js lib server.js  # 无成本确认 UI
grep -n "negative" public/js/pages/storyboards.js lib/agnes.js       # 视频有、图片链路丢弃
```

*（完 —— 本报告为只读研读，未修改被研读源码包的任何文件，也未改动 agnes-manga-studio 的其它文件。文中「我们」侧的行号取自本次读码时的工作区快照；该仓库存在其它并行会话的在途改动，若行号漂移请按同行给出的符号名/字符串重新定位。）*
