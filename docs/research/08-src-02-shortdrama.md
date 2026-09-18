# 源码研读 08-02：Vibex「AI 短剧漫剧一键生成工作台」React+TS+Vite 包

> **研读对象（只读）**：`/Users/apple/Project/Git/Webeye-Video/docs/AI创作资料/08-AI创作项目源码/ai-remix-5fa0f9a0-AI短剧漫剧一键生成工作台/`
> **对照对象（我们）**：`/Users/apple/Project/Git/agnes-manga-studio/`（本地优先 · 零 npm 依赖 Node 原生后端 + `public/` vanilla JS ESM）
> **路径口径**：不带前缀者指源码包内路径（如 `src/pages/Home/useHome.ts:105`）；带 `public/`、`lib/`、`docs/` 前缀者指本仓库。行号取自本次实读；未确认处显式标注。
> **元信息**：`vibex-local/export-manifest.json` → `app_id: app-f6f37f70c4ec4b7887c848b15fa0f9a0`、`name: AI短剧漫剧一键生成多功能工作台 (Remix)`、导出 2026-09-18。

---

## 1. 一句话定位与技术栈

**把「剧本 → 分镜 → 分镜图 → 动态镜头 → TTS 配音 → 成片」串成单页流水线的 RunningHub 云算力前台**，自称「影流 · 智能短剧工作室」（`src/components/home/TopNav.tsx:19-22`、`src/pages/Home/HomePage.tsx:189`）；角色一致性靠「多参考图 + 结构化人物档案 + 图生图」三件套。

| 项 | 事实 | 证据 |
|---|---|---|
| 路由 / 页面 | **2 条路由**（`/` 与 `*` 都指向 HomeRoute）→ 事实上的**单页零导航**；业务页只有 `src/pages/Home/` 1 个（`HomePage.tsx` 196 行 / `useHome.ts` 1193 行 / `index.tsx` 7 行） | `src/App.tsx:6-9` |
| ts/tsx 文件数 | `src/` 下 **74 个**（`components/ui/` 46、`components/home/` 10、`components/rh/` 2）；另有 `templates/scaffold/` 22 个模板副本 | `find src -name "*.ts" -o -name "*.tsx" \| wc -l` |
| 状态管理 | **无状态库**。全部状态在单个 hook `useHome()` 里，返回 **60+ 字段**，由 `HomePage` 解构后 props-drilling 到 8 个子组件 | `useHome.ts:1150-1192`；`HomePage.tsx:74-162` |
| UI 库 | **Radix UI 原语 + shadcn 风格本地组件**（46 文件），业务代码**实际只引用 15 个**（alert/badge/button/card/dialog/input/label/popover/scroll-area/select/slider/switch/tabs/textarea/tooltip） | `grep -rho "components/ui/[a-z-]*" src/pages src/components` 去重 |
| 图标 / 样式 | `lucide-react`；Tailwind 3.4 + `tailwindcss-animate` + PostCSS；`darkMode:["class"]`；Inter / JetBrains Mono（base64 内联） | `package.json:46`、`tailwind.config.js:5`、`src/index.css:1-19` |
| 构建 | Vite 8 + `tsc -b` + React 19.2 + TS ~6.0，`@`→`src` 别名 | `package.json:8,50-52,80` |
| 后端接入 | **PocketBase JS SDK** 走 `__pb` 反代前缀；真后端是 3 个 **Goja（PB hooks）**：`aigc.pb.js` 1227 / `llm.pb.js` 281 / `projects.pb.js` 237 | `src/lib/pb.ts:14-26` |
| 部署形态 | Vibex 子路径（`/app-preview/app-<32hex>/` 或 `/p/app-<32hex>/`），`getBasename()` 供 Router | `src/lib/pb.ts:7-24` |
| 语言标记 | 源码包 `index.html:2` 写死 `lang="en"` 而界面 100% 中文（缺陷）；**我们 `public/index.html:2` 已是 `lang="zh-CN"`** | 实读 |

---

## 2. 信息架构与页面流

### 2.1 路由与骨架

路由只有 `/` 与 `*` 两条，都渲染 `HomeRoute`——**无 404**，未知路径静默回落（`src/App.tsx:6-9`）。对比我们：`public/js/app.js:44-59` 同样是「未知 hash 静默回落 dashboard」（基线 G-8）。

```
TopNav (sticky 毛玻璃)                        src/components/home/TopNav.tsx:11-46
├ HERO（标题 + 副标 + 徽标）                  HomePage.tsx:54-68
├ 登录过期 Alert（条件）                       HomePage.tsx:34-44
├ grid lg:grid-cols-[260px_1fr_380px]         HomePage.tsx:71
│  ├ 左 260px  IpSidebar（IP 人物库）          HomePage.tsx:73-87
│  ├ 中 1fr    ScriptPanel（模式/参数/配音/主 CTA）
│  │           PipelineProgress（5 阶段徽标链）
│  │           AssetLibrary（我的素材库）
│  │           ShotTimeline（分镜时间线 + 确认条）
│  └ 右 380px  PreviewPanel（成片预览/导出）
├ HistoryStrip（历史作品 ≤8）                  HomePage.tsx:183-185
└ footer「影流 · AI 短剧工作室」                HomePage.tsx:188-190
```

全站唯一 `bg-primary` 大按钮在 ScriptPanel 底部（`ScriptPanel.tsx:449-458`），文案随模式切换：`流水线运行中...` / `拆分成镜` / `一键成片`。

### 2.2 三条主路 happy path

模式由 `CreateMode = 'auto'|'theme'|'manual'`（`useHome.ts:29`）驱动，Tabs 文案与提示原文（`ScriptPanel.tsx:76-87` + `MODE_HINTS` `:42-46`）：

| 模式 | Tab 文案 | 提示文案（原文） |
|---|---|---|
| auto | `一键成片` | 「粘贴剧本,智能自动拆镜→出图→动起来→配音→成片,全程自动」 |
| theme | `主题扩写` | 「输入一句话主题,智能先扩写剧本再自动完成后续」 |
| manual | `分镜工作台` | 「剧本拆成镜头后暂停,你可以逐幕调整再继续」 |

**A. 一键成片（auto）**：① 粘贴剧本（`ScriptPanel.tsx:112` 实时字数）+ 选画幅/画质/风格/配音 → ② 点 `一键成片` 调 `runFullPipeline()`（`useHome.ts:1089`），先校验 `prompt.trim()` 与 `getRhAccessToken()`，无登录翻 `needsRhLogin`（`:1090-1091`）→ ③ 成本确认 `costConfirm.runWithCostConfirm(action, priceText)`，兜底文案「预计消耗 RH 币,实际以 RunningHub 扣费为准」（`:1094-1095`）→ ④ `expandScript()` LLM 拆 5–8 幕（`:871`）+ `recalcCost(n)`（`:1099`）→ ⑤ `runImageVideoAudioCompose()`（`:1064`）：`runImageStage`→`runVideoStage`→`runAudioStage`→`composeFinal`，**阶段串行、阶段内并行** → ⑥ `persistProject()` 写 PB `projects` 表（`:665-688`）。
⚠️ `composeFinal()`（`:1051-1062`）只取「第一个成功的镜头视频」当最终成片（`:1053-1055`），**没有真正的多幕拼接**——`PipelineProgress` 的「成片合成」阶段是名义上的。

**B. 主题扩写（theme）**：与 A 完全同链路，唯一差异在 `expandScript()`——`isTheme` 决定 system prompt 说「一句话主题」还是「一段剧本」，user message 用 `主题:${prompt}` 而非 `剧本:\n${prompt}`（`useHome.ts:873,875,885-887`）。**没有独立的「扩写剧本」步骤**，一句话主题直接出分镜数组。

**C. 分镜工作台（manual）**：① 按钮文案变为 `拆分成镜`（`ScriptPanel.tsx:457`）→ ② `expandScript()` 完成后**立即 return**：`if (createMode === 'manual') { setPipelineRunning(false); return }`（`useHome.ts:1098`）→ ③ 逐幕调整：`重绘此幕(注入角色一致性)` / `重新动效` / `换配音` / `挂素材` / 38 种运镜 / 角色绑定 / `加空镜头` / 删除（`ShotTimeline.tsx:61-62,276-302,202-238,240-272`）→ ④ 确认条出现条件 `mode==="manual" && shotsReady && !allDone && !pipelineRunning`（`ShotTimeline.tsx:41`），文案「分镜已就绪 · N 幕」+「检查一下每幕的画面/运镜/配音,满意后点一键成片开始生成」→ ⑤ 点 `确认分镜 · 一键成片` 调 `confirmAndProduce()`（`useHome.ts:1079`）→ 成本确认 → `runImageVideoAudioCompose(shots)`。

---

## 3. 角色一致性工程（本包重点）

### 3.1 人物库数据结构

```ts
// src/pages/Home/useHome.ts:105-118
export interface IpCharacter {
  id: string; displayName: string
  referenceImages: string[]   // 支持多张参考图,增强一致性
  description: string
  // 结构化外观档案,直接注入 prompt,跨幕稳定
  gender: string; ageRange: string; hairStyle: string; outfit: string
  distinctive: string         // 显著外貌特征(疤/纹身/眼镜/胎记等)
  tags: string[]; locked: boolean  // 是否作为主角强制出现在所有镜头
}
```

字段落 UI（`src/components/home/IpSidebar.tsx`）——**注意英文枚举值会原样进 prompt**：

- `displayName`：Input，占位 `如:林夜`（`:84`）。`gender`：Select `male`/`female`/`other`（`:136-138`）；`ageRange`：Select `young child`/`teenager`/`young adult`/`middle-aged`/`elderly`（`:147-151`）。
- `referenceImages`：3 列网格、上限 **6**，标签「参考图 (N/6 · 建议正面/侧面/半身各 1–2 张)」；上传即 `uploadAigcMedia` → `downloadUrl`（`:92,106`；`useHome.ts:697`）。
- `hairStyle` / `outfit` / `distinctive` / `description`：自由文本，占位分别是 `如:黑色短发 / 银白长直发 / 寸头`、`如:黑色风衣、白衬衫 / 红色汉服 / 皮夹克`、`如:左脸刀疤、圆框眼镜、左耳耳钉`、`气质/职业/其他外观细节`（`:159-191`）。
- `locked`：Switch，文案 `主角 · 每幕强制出场` / `设为主角(每幕出现)`（`:257-267`）。

硬约束：**角色上限 3**（`IpSidebar.tsx:52` 徽标 `N/3`、`:56` 才显示新建钮）、**参考图上限 6**（`useHome.ts:697` `.slice(0,6)`）。保存校验：名字非空 + ≥1 参考图，否则 `setErrorMsg('请填写角色名并至少上传 1 张参考图')`（`:712-715`），成功 toast `IP 人物档案已保存`（`:729`）。`tags` 是**派生死字段**（6 字段按 `[,，\s]+` 切分去重截前 8，`:716-717`），全包无消费点。

### 3.2 角色如何注入分镜提示词

**第一层：拆镜（LLM）**。`expandScript()` 把 IP 库序列化进 system prompt（`useHome.ts:874,880-881`）：

```
可用 IP 人物(按 id 引用,不要填名字):[{"id":"...","name":"林夜","profile":"male, young adult, black short hair, wearing black trench coat, ..."}]
characters 数组必须填下面 IP 库的人物 id (如果该镜头出现了对应人物);没有出现任何 IP 人物时填空数组。
```
`profile` 由 `buildCharacterPrompt(c).replace(/"/g,"'")` 生成（`:874`）。

**第二层：生图（模型）**。`runImageStage()` 的 `fullPrompt` 顺序固定（`:949-955`）：

```
[shot.prompt] , [运镜英文 prompt] , [characterPrompts] , [STYLE_PROMPT[vStyle]] , "{vAspect} aspect ratio, ultra detailed, cinematic composition, sharp focus, 8k"
```

`characterPrompts` 模板原文（`:943-946`）：

```
character "<displayName>": <profile>. Keep this character's face, hair, outfit and features IDENTICAL to reference across all shots, maintain perfect character consistency
```

`buildCharacterPrompt()` 拼接顺序与措辞（**`hair`/`wearing` 是硬拼英文**，`useHome.ts:848-858`）：

```
[gender] , [ageRange] , [hairStyle + " hair"] , ["wearing " + outfit] , ["distinctive features: " + distinctive] , [description]
```

### 3.3 出场约束（"强制每幕出现"）的实现

**不在拆镜 prompt 里约束**，而在生图前做**集合的并集**（`useHome.ts:937-940`）：

```ts
const forcedLocked = ipCharacters.filter(c => c.locked).map(c => c.id)
const charIds = Array.from(new Set([...shot.characters, ...forcedLocked]))
const boundChars = ipCharacters.filter(c => charIds.includes(c.id))
const allRefs = boundChars.flatMap(c => c.referenceImages).filter(Boolean)
```

成功后**回写** `updateShot(shot.id, { imageStatus:'success', imageUrl:r.url, imageTaskId:r.taskId, characters: charIds })`（`:970`），所以 UI 上主角缩略头像出现在每一幕（`ShotTimeline.tsx:135-148`）。副作用：删角色解绑全部镜头（`:739`）；镜头级开关 `toggleShotCharacter`（`:742-748`），UI 在 `ShotTimeline.tsx:250`「选择本幕出场角色」。

### 3.4 参考图如何传给模型

- 载体：**公网 URL 数组**，字段名 `imageUrls`（不是 base64、不是 `@` 语法）。
- 路由决策：有参考图 → `MODEL_I2I`（`gpt-image-2-image-to-image-official-stable`），无 → `MODEL`（`gpt-image-2`）（`useHome.ts:959`）。
- 截断：`body.imageUrls = allRefs.slice(0, 4)`，注释「多参考图:最多带 4 张,人物图优先」（`:965-966`）。**后端契约允许 `max_num:10`**（`aigc.pb.js` ALLOWED_MODELS）——前端主动砍到 4；3 角色 × 6 图理论上 18 张，实际只发 4 张。
- 上传通道：`uploadAigcMedia(file,'image')` → `FormData` multipart 直传（`aigc.ts:376-421`）。注释明确：「视频/音频/大图必须走这个……不要再用 `fileToDataUrl` 把几十 MB 视频转 base64 塞 JSON：Goja 单线程逐字符解码会锁死 PB → 502/524」（`aigc.ts:423-427`）。

### 3.5 ⚠️ 一致性的两个真实断点

1. **角色库只在内存**：`const [ipCharacters, setIpCharacters] = useState<IpCharacter[]>([])`（`useHome.ts:474`），**全包无任何持久化**；`persistProject()` 落库字段只有 `title/mode/script/shots/cover/final_video_url/total_cost/aspect_ratio/quality/style/rh_user_id`（`:672-684`），**不含 IP 库**。→ 刷新页面即丢档案与参考图，历史项目重开无法复现一致性。
2. **视频阶段不注入任何一致性信息**：`runVideoStage()` 只传 `{ prompt: shot.prompt, firstFrameUrl: shot.imageUrl, ... }`（`:991-994`）——用的是**未经角色注入的原始 `shot.prompt`**，也无运镜 prompt、无 `STYLE_PROMPT`。一致性完全依赖 `firstFrameUrl` 首帧继承，属隐式保证而非显式工程。

---

## 4. 数据模型

### 4.1 类型清单（`useHome.ts`）

`UploadStatus`(`:28` `idle｜uploading｜done｜error`)、`CreateMode`(`:29`)、`Aspect`(`:30` `16:9｜9:16｜1:1｜4:3｜3:4｜21:9`)、`PlatformPreset`(`:32-39` `id/label/platform/aspect/hint/emoji`)、`QualityPreset`(`:51` `ultra｜cinematic｜hd｜sd｜draft`)、`VisualStyle`(`:52-102` 44 个字面量风格键，写实/国风/动漫/恐怖/科幻/艺术/商业 7 族)、`StageStatus`(`:103` `idle｜queued｜running｜success｜failed`)、`IpCharacter`(`:105-118` 见 §3.1)、`ShotMove`(`:120-136` 38 个运镜字面量)、`ShotSource`(`:182` `ai｜user-image｜user-video｜user-audio`)、`UserAsset`(`:184-190` `id/displayName/type(image\|video\|audio)/url/sizeLabel?`)、`PipelineState`(`:217-224` 5 阶段状态 + `scriptError?`)、`HistoryProject`(`:226-234`)、`BgmTrack`(`:236-243` `id/label/mood/category/url/emoji`)、`EmotionOption`(`:297-305` `id/label/desc/group` + `ttsEmotion`(7 值) + `ttsSpeed`)。

其中 **`Shot`（`:192-215`）** 是本包最核心的业务实体：`id/index/prompt/dialogue/narration/durationSec/characters[]/cameraMove/source/userAssetId?` + **image/video/audio 各 4 字段**（`*Status`/`*Url`/`*TaskId`/`*Error`）——即「每幕 × 三模态」的状态机被摊平成 12 个字段挂在同一个对象上。

### 4.2 类型清单（`aigc.ts` / `llm.ts`）

| 类型 | 定义处 | 要点 |
|---|---|---|
| `AigcOutput` | `aigc.ts:13-16` | `url/type(image\|video\|audio\|3d\|file)` |
| `AigcSubmitResponse` | `:18-27` | `ok/taskId/rhTaskId?/status?/model?/error?/errorCode?/message?` |
| `AigcResponse<T>` | `:31-37` | 老 scaffold 兼容包络（`taskId/task_id?/rhTaskId?/results[]/outputs[]`） |
| `AigcPollResponse` | `:39-48` | `status(RUNNING\|QUEUED\|SUCCESS\|FAILED\|CANCEL)` + `outputs?` + `usage?` |
| `AigcUsage` | `:53-58` | `consumeMoney/consumeCoins/taskCostTime/thirdPartyConsumeMoney`，**全 string**，注释「不要 parseFloat 再格式化」 |
| `AigcPricePreview` | `:62-70` | `ok/estimatedPrice?/currency?/priceText?/freeLimit?/isFreeThisCall?/message?` |
| `AigcScalarParam`/`AigcMediaParam`/`AigcModelInfo` | `:74-101` | 服务端驱动的参数契约：`scalar_params`(enum/required/default) + `media_params`(multiple/max_num/accept/max_size) |
| `AigcSuccess`/`AigcFailure`/`AigcResult` | `:103-142` | `errorKind` 是 **8 值稳定枚举**（见 §7.4） |
| `AigcHistoryItem` | `:174-195` | `jobId/taskId/status/page/prompt/resultUrl/errorMessage/rating/favorite/category/note/created/updated/model` + 4 个 usage 快照 |
| `AigcHistoryQuery`/`AigcHistoryPatch` | `:197-208` | patch 仅 `rating/favorite/category/note` |
| `AiApp*` 四型 | `:323-358` | AI 应用形态：`state: queued\|running\|succeeded\|failed\|partial`、`error{code,message,retryable,taskId?,failedNode?}` |
| `LlmContentPart`/`LlmMessage`/`LlmCallOptions`/`LlmCallResult`/`LlmModelInfo` | `llm.ts:4-38` | 多模态消息（`text`/`image_url`）、`request_id` 断线续查、`supports_temperature` |

### 4.3 本地存储

| key | 用途 | 证据 |
|---|---|---|
| `vibex_cost_confirmed_today:<appId>` | 付费确认当日免打扰，值 `{expiresAt}` | `src/lib/costConfirm.ts:16-38` |
| `vibex-scoped-token` / `-expires` / `-user` / `vibex-sandbox-app-id` / `vibex-sandbox-logged-out` | 沙箱域 scoped token 与静默 SSO 状态 | `src/lib/rhLogin.ts:54-61` |
| `pocketbase_auth`（SDK 自管） | PB authStore | `src/lib/pb.ts:26,39-41` |

**业务数据（角色库/素材库/分镜）全在 React state 里，不落 localStorage/IndexedDB**；持久化只走 PB `projects` 表（`pocketbase/pb_hooks/projects.pb.js:30-40`，按 `rh_user_id` 过滤）。

---

## 5. 提示词工程

### 5.1 拆镜 system prompt（`useHome.ts:875-881` 摘录）

```
你是专业电影分镜师。把用户给出的{一句话主题|一段剧本}拆成 5–8 个分镜。
严格只输出 JSON 数组,无 Markdown、无解释。每幕形如:
{"index":1,"prompt":"英文画面描述,30-60词,电影级,描述人物外貌/服装/特征以保持一致性",
 "dialogue":"中文对白(无则空)","narration":"中文旁白(无则空)",
 "durationSec":5,"characters":["charId1"],"cameraMove":"push-in"}
prompt 必须英文,突出电影镜头感和人物一致性。
cameraMove 必须是下面其中之一(按剧情选最合适的镜头语言,动静结合):
  static/push-in/pull-out/pan-left/pan-right/tilt-up/tilt-down/dolly-zoom/orbit/handheld
characters 数组必须填下面 IP 库的人物 id (如果该镜头出现了对应人物);没有出现任何 IP 人物时填空数组。
可用 IP 人物(按 id 引用,不要填名字):[{...}]
```

设计意图（读码可得）：① **中英分工**——画面描述强制英文（喂图像模型），对白/旁白强制中文（喂 TTS）；② **枚举白名单**——`cameraMove` 只开放 10 值给 LLM，而 UI 可选 38 值（`SHOT_MOVE_LABELS` `:138-180`），即 LLM 只挑常见运镜、用户可手工升级；③ **id 引用而非名字**——避免改名后幻觉。解析兜底 `rawMove in SHOT_MOVE_LABELS ? rawMove : 'static'`（`:906-907`）。

user message（`:885-887`）：theme 用 `主题:${prompt}\n画幅:…,画质:…,风格:…`；其他用 `剧本:\n${prompt}\n画幅:…,画质:…,风格:…,IP人物:${displayName(description);…}`。调用 `callLlmWithFallback('doubao-seed-evolving', { messages, page:'home', max_tokens:4096 })`（`:882-890`），**未传 temperature**（与 `llm.ts:111` 注释「GPT-5.5 等模型不支持该参数」呼应）；服务端契约 `max_tokens:16384, timeout_s:600, supports_temperature:true`（`llm.pb.js:30`）。

### 5.2 结构化输出协议与容错

协议是**裸 JSON 数组**（非 `json_object` 包装）。容错解析（`useHome.ts:897-904`）：去 ``` 围栏 → `indexOf('[')` / `lastIndexOf(']')` 截取 → `JSON.parse`，失败则 `scriptStatus:'failed'` + 「AI 返回格式异常,请重试」。

**对比我们更强**：`public/js/consts.js:310-421` 的 `extractJson` 有 4 级降级（围栏 → 全文 → 括号配对切片 → `repairJson` 启发式修内嵌引号/多余引号/尾逗号/裸换行），`extractJsonArray` 还兼容 `{shots:[...]}` 包装。

字段级清洗（`:905-920`）：`prompt` 截 500 字符；`durationSec` 钳 `Math.min(15,Math.max(4,n||5))`；`characters` 强制数组否则 `[]`；`cameraMove` 白名单兜底。

### 5.3 生图提示词组装

见 §3.2。风格词表 `STYLE_PROMPT`（`:330-381`）**44 条英文长句**，含具体镜头/胶片/导演锚点，例：`cinematic: 'cinematic film still, photorealistic, movie lighting, depth of field, 35mm anamorphic lens, Kodak Portra 400 film grain'`；`chinese-horror: 'chinese horror aesthetic, jiangshi hopping vampire, ghost bride in red wedding dress, … paper talismans, flickering red candles, Rigor Mortis style, cold fog, hanging red lanterns, supernatural dread'`；`wuxia: 'Chinese wuxia martial arts, ink wash painting aesthetic, bamboo forest, flowing silk robes, Hero / Crouching Tiger style, ethereal mist, sword qi'`。运镜词表 `SHOT_MOVE_LABELS`（`:138-180`）**38 条** `{zh,prompt}`，例 `dolly-zoom: { zh:"滑动变焦(希区柯克)", prompt:"dolly zoom / vertigo effect, focal length changes while dollying, uncanny perspective shift" }`。固定尾巴 `${vAspect} aspect ratio, ultra detailed, cinematic composition, sharp focus, 8k`（`:954`）。

**无负面提示词**：`grep negative_prompt src/` = 0 命中。对比我们：`public/js/pages/storyboards.js:297` 默认 `low quality, blurry, distorted face`，`videos.js:26` 有独立 neg 字段。

### 5.4 模型与参数

前端常量（`useHome.ts:20-26`）：`MODEL='gpt-image-2'`、`MODEL_I2I='gpt-image-2-image-to-image-official-stable'`、`MODEL_I2V='seedance2-0-image-to-video'`、`MODEL_TTS='minimax-speech-2-8-hd'`、`LLM_MODEL='doubao-seed-evolving'`、`POLL_INTERVAL_MS=3500`、`POLL_TIMEOUT_MS=3600000`（1 小时）。

服务端契约（`aigc.pb.js` ALLOWED_MODELS，对应 `src/vibex-permissions.json`）：

| 短名 | endpoint | 关键参数 |
|---|---|---|
| `gpt-image-2` | `rhart-image-g-2-official/text-to-image` | `resolution: 1k\|2k\|4k`(默认 2k)、`quality: low\|medium\|high`(默认 medium)、`aspectRatio` 10 值 |
| `gpt-image-2-image-to-image-official-stable` | `…/image-to-image` | 同上 + `imageUrls`（multiple，**max_num 10**，≤50MB，JPG/JPEG/PNG/WEBP） |
| `seedance2-0-image-to-video` | `rhart-video/sparkvideo-2.0/image-to-video` | `resolution`(含 native4k)、`duration` 4–15、`ratio`、`generateAudio`、`realPersonMode`、`conversionSlots`、`returnLastFrame`；`firstFrameUrl`（必填 ≤30MB）、`lastFrameUrl` |
| `minimax-speech-2-8-hd` | `rhart-audio/text-to-audio/speech-2.8-hd` | `voice_id`(默认 `Wise_Woman`)、`speed` 0.5–2、`volume` 0.1–10、`pitch` −12–12、`emotion` 7 值、`enable_base64_output`、`english_normalization` |

前端映射（`:392-410`）：`qualityToRes`（ultra/cinematic→4k, hd→2k, 其余 1k）、`qualityToQual`、`videoRes`（ultra→native4k, cinematic→4k, hd→1080p, sd→720p, draft→480p）、`aspectToRatio`（注释说「gpt-image-2 不支持 4:3/3:4/21:9, 近似映射」但**函数体只是原样返回，映射未实现**，`:385-391`）。

视频提交（`:991-994`）：`{ prompt, firstFrameUrl, resolution: videoRes(vQuality), duration: String(shot.durationSec), ratio, generateAudio:false, page:'home' }`——**`generateAudio` 硬编码 false**（配音走独立 TTS）。

### 5.5 TTS 与情绪映射

文本拼接 `[shot.dialogue, shot.narration].filter(Boolean).join('。')`（`:1027`）。情绪是**双层映射**（`:1029-1036`）：UI 有 17 个情绪（`EMOTION_OPTIONS` `:307-328`，分「基础/戏剧/搞笑抽象」），minimax 只认 7 个，扩展情绪靠 `ttsEmotion + ttsSpeed` 近似：

```ts
const opt = EMOTION_OPTIONS.find(e => e.id === vEmotion)
return { emotion: opt?.ttsEmotion || 'neutral', speed: Math.min(2, Math.max(0.5, vSpeed * (opt?.ttsSpeed||1))) }
```

例：`crazy:{label:"疯癫夸张",ttsEmotion:"surprised",ttsSpeed:1.4}`、`absurd:{…"happy",1.5}`、`sarcastic:{…"disgusted",1.0}`、`deadpan:{…"neutral",0.9}`。提交体 `{ emotion, speed, text, voice_id, enable_base64_output:false, english_normalization:false, page:'home' }`（`:1037-1038`）。音色 20 条按「女·青年/中年/老年/儿童、男·同」8 组（`:271-294`）。

### 5.6 素材引用语法

| 模态 | 语法 | 证据 |
|---|---|---|
| 图片（生图参考） | `body.imageUrls: string[]`（公网 URL，≤4） | `:966` |
| 图片（视频首帧） | `body.firstFrameUrl: string` | `:992` |
| 文本（TTS） | `body.text: string` | `:1037` |
| 上传落 URL | `uploadAigcMedia(file, fileType)` → `{ downloadUrl }` | `aigc.ts:376-421` |

**没有** `@file`/`@image1` 之类提示词内引用语法；素材一律是**旁路字段**，不进 prompt 文本。

---

## 6. 视觉与设计系统

### 6.1 色板与 token（`src/index.css:26-46`）

HSL 三通道：`--background: 226 49% 8%`（近黑深蓝）、`--foreground: 210 40% 98%`、`--card`/`--popover: 223 42% 13%`、`--muted`/`--secondary`/`--accent` **三 token 同值** `225 47% 18%`、`--border`/`--input: 221 34% 24%`、`--primary`/`--ring: 213 94% 68%`（**单一冷蓝** ≈`#60a5fa`）、`--destructive: 351 95% 71%`。

**暗色是唯一主题**：`.dark` 块（`:80-132`）与 `:root`（`:26-78`）**逐行完全相同**——`darkMode:["class"]` 形同虚设，无浅色主题、无切换器。对比我们：`public/css/app.css:10` 一行 `color-scheme: dark` 达成同样效果，且我们是黑金（`--gold:#D6B56D`）而非冷蓝。

| 类别 | token | 值 |
|---|---|---|
| 圆角 | `--radius-lg/md/sm` | `20/12/8px`（`:56-59`；`--radius` 指向 md，`:46`） |
| 阴影 | `--elev-flat`/`--elev-ring`/`--elev-raised` | `none` / `0 0 0 1px var(--border)` / `0 24px 72px rgba(0,0,0,.36)`（`:60-63`） |
| 焦点环 | `--focus-ring` | `0 0 0 4px rgba(96,165,250,0.28)`（`:61`） |
| 间距 | `--space-1/2/3/4/5/6/8/12` | `4/8/12/16/20/24/32/48px`（`:48-55`） |
| 字号 | `--text-xs…4xl` | `12/13/15/17/22/32/48/66px`（`:64-71`） |
| 字体 | `--font-display`/`--font-body` | **同一串**：`Inter, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui`（`:74-75`）；`--font-mono` = `"JetBrains Mono", …` |

**阴影层级被压平**：Tailwind 把 `sm/DEFAULT/md/lg/xl` **全部**映射到 `--elev-raised`（`tailwind.config.js:19`），只有 `shadow-none`/`shadow-focus` 例外 → 业务里 `shadow-sm/lg/md` 视觉无差别；真正区分卡片层次的是**内联** `style={{boxShadow:"var(--elev-raised)"}}` vs `"var(--elev-ring)"`（`ScriptPanel.tsx:89` vs `:261`、`AssetLibrary.tsx:42`、`ShotTimeline.tsx:47`）。另有中英混排 hack `.cjk-latin{font-size-adjust:0.56;vertical-align:-0.15em}`（`index.css:137`），但 `grep cjk-latin src/` = 0 命中，模板遗留死类。

### 6.2 动效

首屏入场 `animate-in fade-in slide-in-from-bottom-4 duration-700`（`HomePage.tsx:54`）；Toast 入场 `slide-in-from-top-4`（`:28`）；加载 `Loader2 + animate-spin`（`PreviewPanel.tsx:105,171`、`PipelineProgress.tsx:25`）；骨架 `animate-pulse` **仅 1 处**（`RhAccountMenu.tsx:90`）；录音脉冲（`VoiceRecorder.tsx:105,132`）；自定义 keyframes 只有 `accordion-down/up` 且**重复定义 2 遍**（`tailwind.config.js:80-119`）。全部来自 `tailwindcss-animate` 插件（`tailwind.config.js:1,122`），**无一条自写 CSS 动画**。

### 6.3 组件视觉特征

- **卡片**：`rounded-xl` + `border-border/60` + `bg-card` + 内联 `boxShadow` 二选一（`elev-raised` 主卡 / `elev-ring` 次级卡）。**主按钮**：`bg-primary text-primary-foreground gap-2 hover:bg-primary/90` + 内联 `elev-raised`（`ScriptPanel.tsx:449-455`、`HomePage.tsx:39`）。
- **徽标 + 小标签**：`Badge variant="outline"` + `font-mono text-xs` 是**签名式用法**，全站密集（`TopNav.tsx:20`、`ScriptPanel.tsx:64`、`ShotTimeline.tsx:53,64`、`PipelineProgress.tsx:46`）；`font-mono text-xs uppercase tracking-widest text-muted-foreground` 用于「参数」「配音」「流水线」「最近作品」等区块角标（`ScriptPanel.tsx:98,264,358`、`PipelineProgress.tsx:38`、`HistoryStrip.tsx:18`）——这是本包最强的「技术感」视觉母题。
- **空态**：`border-dashed border-border/60` 圆角框 + 居中图标 + 两行灰字，**无 CTA 按钮**（`IpSidebar.tsx:204-210`、`AssetLibrary.tsx:83-90`、`HistoryStrip.tsx:20-23`）。**对比我们更强**：`public/js/ui.js:276` 的 `empty()` 已带 `action` 插槽。
- **加载态**：只有 spinner，无骨架屏；`PreviewPanel.tsx:169-174` 的「合成中」是 spinner + 「正在合成,请勿关闭」/「多幕视频拼接中...」。
- **进度反馈**：`PipelineProgress` 是 **5 枚徽标串成的链**（剧本拆解→分镜生图→镜头动效→配音合成→成片合成），非进度条，状态色 5 档（`PipelineProgress.tsx:5-21,40-55`）。对比我们：`public/js/pages/helpers.js:29-47` 的 `renderBatchBar` 是**单条百分比条**，无阶段语义。
- **背景**：`radial-gradient(circle at 80% 6%, rgba(96,165,250,.22), transparent 36%)` 双层蓝晕 + 底色（`HomePage.tsx:20-23`）。

---

## 7. 工程实现技巧

### 7.1 请求层：重试 / 退避 / 超时 / 取消

| 机制 | 实现 | 证据 |
|---|---|---|
| submit 重试 | **固定 3 次、固定间隔 1.5s**（非指数）；`412` 与所有 `4xx` 直接 break 不重试 | `aigc.ts:584-628`（注释：「submit 撞 PB 热重载窗口(1-2 秒)时会拿到 connection refused / 5xx，这时不能直接 return failed（用户体验是"点生成没反应"）」） |
| poll 间隔 | 起始 `opts.pollIntervalMs ?? 2500`，**每次 +500 上限 5000** | `aigc.ts:473,480` |
| poll deadline | `_isLongRunningModel()` 识别 seedance/sparkvideo/video/audio/music/3d/mesh → 30 分钟，否则 8 分钟；页面层显式传 1 小时 | `aigc.ts:211-228,466`；`useHome.ts:26` |
| poll 抖动/404 | 网络异常与 5xx/其它 4xx → `continue`（当作 RUNNING）；404 → **快速失败**（「两种代际路由都 404 = 后端根本没有这个 poll 路由,快速失败,不要空转到 deadline」） | `aigc.ts:491-498,510-514` |
| 取消 | `AbortSignal` 全程透传 → `errorKind:'aborted'` | `aigc.ts:461,476-478,492-495` |
| LLM 首包超时 | `AbortController` + `CHAT_ABORT_MS=25000`，超时后转 **poll 模式**（`POLL_INTERVAL_MS=3000`、`POLL_ATTEMPTS=200`） | `llm.ts:40-42,115-117,169-182` |
| LLM 断线续查 | 前端生成 `request_id`（`crypto.randomUUID()`）随首包发出，超时后用它 poll 取回 | `llm.ts:60-65,103,109` |
| AI 应用连续失败 | `consecutiveFails >= 5` → `error.code='NETWORK'` | `aigc.ts:757-760` |

**对比我们**：`lib/agnes.js:336-360` 有**真指数退避**（`baseMs * 2**attempt + 随机抖动`，上限 60s），且明确区分「瞬时拒绝可重试」与「`proxy_timeout` 可能已被收单 → 绝不重试（重复提交=重复扣费）」（`lib/agnes.js:74-81,336-338`）——**这一项我们更强**。但 `public/js/api.js:6-28` 的前端 `req()` **无超时、无 AbortController**（基线 G-6），是明确缺口。

### 7.2 长任务轮询：**跑在浏览器 tab 里**（我们的架构优势点）

本包**没有服务端 poller**——`pollAigcToResult` 的 `while (Date.now() < deadline)` 循环在浏览器内（`aigc.ts:475-546`）。对策是挂载时**恢复孤儿任务**：`loadHistory()` 拉最近 20 条，`items.filter(it=>it.status==='running').forEach(it=>resumePollingJob(it.jobId))`（`useHome.ts:521-543`）；`resumeAigcJob` 的 deadline 语义被特别注释：「不是"从任务提交时刻算起还剩多久"，而是"从这次 resume 调用开始,最多再等这么久"」（`aigc.ts:689-693`）。代价：**关掉 tab 就没人推进**，UI 无任何提示。

**对比我们更优**：`lib/poller.js`(186) + `lib/jobs.js`(91) 在后端进程轮询、SSE 推前端（`public/js/app.js:185`）；`public/js/pages/settings.js:184` 明确承诺「轮询跑在本地服务里，关掉浏览器也会继续。下次打开程序时，没跑完的任务会自动接着查。」——**绝不能倒退**。

### 7.3 断点恢复

单次生成靠历史里 `status==='running'` 自动 resume（`useHome.ts:534-537`），配 `genHistory` + `resumingJobIds[]` 供 UI 转圈（`:441-443`）；结果恢复取最近一条成功记录回填 `resultUrl/taskId/prompt`（`:527-532`）；项目层 `persistProject()` 写 PB、`loadProjectHistory()` 按 `rh_user_id` 拉（`:645-688`）。**对比我们**：`public/js/pages/storyboards.js:104-114` 用 `localStorage['agnes.batch.last']` 记 jobId，进页续订并 `toast('发现进行中的批量任务，进度已续上','info')`；`assets.js:13-15` 记忆项目/收藏筛选。我们**没有单条任务级 resume**，但有**后端 job 持久**这个更根本的保障。

### 7.4 错误处理与文案映射

`AigcFailure.errorKind` 是 **8 值稳定英文枚举**（`aigc.ts:118-140` 注释逐条说明）：

| errorKind | 中文文案 | 触发 |
|---|---|---|
| `submit` | 提交生成任务失败 (网络或服务器繁忙), 请稍后重试 | 提交网络/5xx |
| `poll` | 查询生成结果失败, 请稍后重试 | 轮询 404 |
| `timeout` | AI 生成超时 (可能服务器繁忙), 请稍后重试 | 超 deadline |
| `aborted` | 已取消 | AbortSignal |
| `login_required` | RunningHub 登录态已过期, 请重新登录 | 412 |
| `insufficient_balance` | RunningHub 账户余额不足, 请充值后重试 | 605 / `rh_insufficient_balance` / 「余额/点数/积分」 |
| `content_audit` | 内容审核未通过 | 正则 `/content security audit\|内容安全审查\|内容审查\|审核未通过\|content moderation/i` |
| `task_failed` | 生成失败, 请稍后重试或换个 prompt | 其他 |

证据：`AIGC_ERROR_MESSAGES_ZH`（`:144-153`）+ `classifySubmitBusinessError`（`:264-290`）+ poll 终态判定（`:531-544`）。`formatAigcFailureMessage()` 的设计意图写得很明确（`:155-171`）：

> 「对**所有** errorKind 都会把 RunningHub 返回的真实原因拼在中文文案后面，除非它是内部占位符或者跟本地化文案完全一样。……不要自己写一份 errorKind 白名单去挑着拼 `result.error`——白名单漏掉的分支（最常见就是 `task_failed`）会把 RunningHub 的真实报错吞掉，只剩一句通用文案，用户看不出实际失败原因（比如 "音频时长过短"）。」

占位符黑名单 `new Set(["aborted","submit failed","poll timeout","task_failed"])`（`:157`）；AI 应用侧镜像实现 `formatAiAppFailureMessage`（`:813-838`）。

**对比我们**：`public/js/api.js:21-27` 只有 `data?.error || 请求失败（HTTP ${status}）` 两级；`lib/agnes.js:113-115` 有 `errorType:'proxy_timeout'|'network_error'` 但只覆盖两类。我们的**单点文案更好**（`tasks.js:186` poll_timeout 三态指引、`storyboards.js:275` 解析失败弹原文、`videos.js:353-358` 三步骤诊断），但**没有统一枚举 + 兜底拼接**。

### 7.5 成本确认

- 契约层 `src/lib/costConfirm.ts`(39 行) 注释：「Canonical billing-confirm primitives — see vibex_billing_contract.yaml……Do not hand-roll a different localStorage key format」；key `vibex_cost_confirmed_today:${appId}`，值 `{expiresAt: 今日 23:59:59.999}`（`costConfirm.ts:16-38`）。
- hook `useCostConfirm()` 返回 `runWithCostConfirm(action, priceText)`，当日已确认则**直接执行**（`hooks/useCostConfirm.ts:43-54`）；弹窗文案「将调用 RunningHub AI，可能消耗 RH 币或钱包余额。{priceText}。」+ checkbox「今天内不再提醒（仅对当前项目有效）」（`CostConfirmDialog.tsx:42-54`）。
- 契约禁止项（注释原文）：「Do not add a global "don't remind me" key, and do not fall back to `window.confirm`/`alert`/`prompt`」（`useCostConfirm.ts:27-28`）。
- 三处调用点：`handleGenerate`（`useHome.ts:614-618`）、`confirmAndProduce`（`:1084-1086`）、`runFullPipeline`（`:1095-1107`）。

**成本预估**硬编码单价（`:861-868`）：`imgUnit = cinematic?3.04:hd?0.76:0.23`、`vidUnit = cinematic?3.0:hd?1.8:0.6`、`audUnit = 0.62`，`total = n * (imgUnit + vidUnit*5 + audUnit)`，文案「预计约 ¥X (N 幕), 实际以 RunningHub 扣费为准」。`vidUnit * 5` 是「每幕 5 秒」的隐式假设，与 `durationSec`（`:914` 允许 4–15s）脱钩——**估算会漂移**。另有服务端 `previewAigcPrice`（`aigc.ts:959-976`）做真实单图价格预览，debounce 500ms（`useHome.ts:502-519`），但**未接入主流水线成本弹窗**。

### 7.6 并发 / 缓存 / 校验 / a11y

- **并发无上限**：三阶段全部 `await Promise.allSettled(shots.map(async shot => {...}))`（`:936,989,1025`）——8 幕 = 8 路同时打上游。唯一错峰在多文件上传：`uploadAigcMediaFiles` 逐个延迟 `i*300ms`、`maxCount` 截断、单个失败静默跳过（`aigc.ts:934-953`）。**对比我们更克制**：`storyboards.js:366` 批量出图 `concurrency:3`、`:405` 批量出视频 `concurrency:1`。
- **缓存：无**。没有 SWR/React Query，没有记忆网络结果的 `useMemo`；唯一 debounce 是价格预览（`:502-519`）与 toast 3s 自动清（`:1131-1135`）。
- **表单校验**（散点手写；`react-hook-form`+`zod` 在依赖里但业务代码 **0 引用**）：角色档案名字+≥1 图（`:712-715`）；主流程 `if(!prompt.trim()) setErrorMsg('请先输入剧本或主题')`（`:1090`）；`if(shots.length===0) setErrorMsg('请先生成分镜')`（`:1081`）；数值钳制 `durationSec∈[4,15]`、`prompt.slice(0,500)`（`:911,914`）、TTS `speed∈[0.5,2]`（`:1035`）；按钮禁用 `disabled={p.pipelineRunning || !p.script.trim()}`（`ScriptPanel.tsx:452`）。
- **a11y 近乎裸奔**：`grep aria-\|role=` 在 `src/components/home/` 与 `src/pages/Home/` **0 命中**；仅两处——`CostConfirmDialog` 的 `role="dialog"`+`aria-modal`（`:29-30`，但遮罩点击即取消、无焦点陷阱、无 ESC）、`RhAccountMenu` 的 `aria-haspopup/expanded/role=menu/menuitem/aria-hidden`（`:90,110-111,138,170,195`）。`IpSidebar.tsx:98-103`、`ShotTimeline.tsx:123-129` 的删除按钮只有图标无 `aria-label`。**我们结构上更强**（`ui.js:48-104` 已有 ESC/Tab 陷阱/自动聚焦/锁滚动）**但语义上更弱**（缺 role/aria-modal，基线 G-4）。

### 7.7 多代际契约兼容（本包最独特的技巧）

因为「发布刷新只换前端 lib、不动 app 已装的 pb_hooks」，同一份前端要兼容两代后端路由，实现是**探测式降级 + 模块级记忆**：

| 标记 | 逻辑 | 证据 |
|---|---|---|
| `legacyAigcRoutes` | 扁平 `/api/aigc/submit` 404 且未定代际 → 改打 `/api/aigc/<model>/submit` 重试一次并记住；再 404 复位 | `aigc.ts:245-262` |
| `legacyAigcUploadRoute` | 同上，`/api/aigc/upload` ↔ `/api/aigc/media/upload` | `:365-402` |
| `legacyLlmRoutes` | 同上，`/api/llm/chat` ↔ `/api/llm/<model>/chat` | `llm.ts:51-58,128-143` |
| `uploadAigcMedia` 双重签名 | 第二参不在 `fileType` 白名单 → 判为老契约 `filename`，返回纯 URL 字符串而非对象 | `aigc.ts:370-421` |

注释记录两起真实事故：「app-bcbdf4c8 老 hook + 刷新后新 lib，上传全 404」、「老页面拿新 lib 会把响应对象塞进 image_url → RH/火山侧 `content[N].image_url is invalid`（刷新后当天 190 个该错误）」（`:362-375`）。另有 `uploadRefImage`/`uploadRefImages`/`persistMediaUrl` 三个**纯为历史调用方保留的兼容导出**（`:1036-1090`）。**我们无多代际部署问题，不应引入。**

---

## 8. 可借鉴点 → 我们的具体落点

> 「现状」均经实读我们仓库确认；无对应能力者写「无」。格式：他们的做法（证据）→ 我们现状（证据）→ 建议（落点）｜改动量｜风险。

**8.1 建「角色库」数据层与页面（我们现在完全没有）**｜**L**｜风险 中
- 他们：`IpCharacter` 结构化档案（`useHome.ts:105-118`）+ 3 列参考图网格上限 6（`IpSidebar.tsx:92-116`）+ 5 个枚举/文本字段（`:130-192`）。
- 我们：**无**。`public/js/consts.js:107` 只有 `IMAGE_USAGES` 里的 `{value:'character',label:'角色图'}` 一个**用途标签**；`IMAGE_ROLES`（`:113`）是视频参考图的角色标签；分镜 `characters` 是**自由文本**（`public/js/pages/storyboards.js:288`），无 id、无档案、无参考图绑定。
- 建议：① `lib/store.js` 的 `MEM`（`:31-33`）新增 `characters: []`，落 `data/characters.json`；② `lib/routes.js` 加 `GET/POST/PUT/DELETE /api/characters`（照抄 `/api/templates` 四件套，`:793-831` 是最接近模板）；③ 新建 `public/js/pages/characters.js`（挂 `public/js/app.js` 路由表 + 侧栏），字段照 `IpCharacter`，参考图复用现有素材库、不新建上传通道；④ `public/js/consts.js` 加 `CHARACTER_GENDERS`/`CHARACTER_AGE_RANGES` 枚举（年龄段用**英文枚举值**，因直接进 prompt）；⑤ `lib/seed.js` 加 2 条示例。
- 风险注记：新增文件/导出符号会让 `.understand-anything` 图谱明显失真，需同步增量更新（AGENTS.md 已明确此边界）。

**8.2 角色档案注入提示词 +「强制每幕出场」**｜**M**｜风险 低-中
- 他们：`buildCharacterPrompt()` 六段拼接（`useHome.ts:848-858`）+ `characterPrompts` 模板「Keep this character's face, hair, outfit and features IDENTICAL to reference across all shots, maintain perfect character consistency」（`:943-946`）+ `locked` 做**集合并集**强制入镜（`:937-940`）+ 成功回写 `shot.characters = charIds`（`:970`）。
- 我们：**部分具备**。`lib/routes.js:881-888` 已有「使用点注入」范式——`styleOf(projectId)` 读 `project.art_style`，`artStylePhrase` 拼进最终提示词，`:534` 对文生视频同样处理；前端 `public/js/consts.js:233-240` 有镜像 `artStylePhrase`（B4.1 注释要求与后端同表，uitest 有文本比对钉）。**但无任何角色维度**。
- 建议：在 `artStylePhrase` **同一注入点**并列加 `characterPhrase(prompt, projectId)`——读新增的 `project.character_ids` → 查 `characters` → 拼 `character "名": profile. Keep … IDENTICAL …`；`POST /api/agnes/image`（`:887`）与 `POST /api/videos`（`:534`，仅 `text_to_video` 分支）各加一行。前端 `consts.js` 加镜像函数，并在 `storyboards.js:214-220` 的 promptCell tooltip 展示完整提示词（**该机制我们已有**，B4.2）。
- 风险注记：需与 8.1 同批落地；`ART_STYLE_MAP` 的 uitest 文本比对钉可能需同步扩展。

**8.3 图生图支持「多张参考图」**｜**M**｜风险 中
- 他们：`body.imageUrls = allRefs.slice(0,4)`（`useHome.ts:966`），契约允许 `max_num:10`；有参考图自动切 `MODEL_I2I`（`:959`）。
- 我们：`public/js/pages/images.js:161-176` 图生图只有**单个** `image: url`，UI 是单行 URL 输入框 + 「保留原构图」开关。多图只在**视频**侧：`videos.js:32` 的 `multi:{imgs:[{url,role},…]}` 与 `:243` 的 `IMAGE_ROLES` 下拉。
- 建议：`images.js` 图生图分支把 `image: url` 改为数组 `images:[{url,role}]`，复用 `videos.js:230-256` 的 `renderMi()` 模式（可直接抄）；`lib/routes.js` 的 `/api/agnes/image`（`:887`）把单图透传改多图。同时让 `IMAGE_ROLES` 真正被用起来（现在只在 videos 页出现）。
- 风险注记：需确认 Agnes 图片接口对多参考图的支持形态（**未确认**；`lib/agnes.js:191` 的 `image()` 签名只收单个 `image`）。

**8.4 镜头语言字典：从 8 个景别扩到「景别 + 运镜」双维度**｜**M**｜风险 低
- 他们：`SHOT_MOVE_LABELS` **38 条** `{zh,prompt}`（`useHome.ts:138-180`），UI 按 7 组分类弹出（`ShotTimeline.tsx:211-236`）。
- 我们：`public/js/consts.js:69` 的 `SHOT_TYPES` 只有 8 个景别；运镜只有 `PRESET_TERMS`（`:193-218`）里 **6 条**点击追加短语，且注释自承「后续可扩至分镜编辑弹窗内」——**尚未接入**。
- 建议：`consts.js` 新增 `CAMERA_MOVES`（38 条 `{zh,en,group}`，直接照搬其中英对照表），在 `storyboards.js` 镜头编辑弹窗（`:455-486`）加分组 chip 选择器写 `camera_move`；`lib/routes.js` 分镜写入白名单同步放行；把 `PRESET_TERMS` 6 条合并去重。

**8.5 付费二次确认 + 当日免打扰**｜**S**｜风险 低
- 他们：`costConfirm.ts` + `useCostConfirm.ts` + `CostConfirmDialog.tsx` 三件套，key `vibex_cost_confirmed_today:<appId>`，当日已确认则放行（`hooks/useCostConfirm.ts:45-48`），三处付费入口全包一层。
- 我们：**无**。`public/js/pages/storyboards.js` 的 `confirm` 只用于删除类（`:454`）；批量出图（`:353-371`）与批量出视频（`:380-409`）**点一下直接烧配额**，只有 `submitBusy` 防双击（`:352`）；`videos.js:257` 起单次提交同理。我们确有「重复扣费」意识（`lib/agnes.js:74-81`「视频提交"重试"同一次网络抖动 = N 条真实计费任务」），但**只防了自动重试，没防误点**。
- 建议：`public/js/ui.js` 在现有 `confirm()`（`:191`，已支持 checkbox 返回值，基线 §0.2 记载）上加 `priceText` 选项；在 `storyboards.js` 的 `batchImages`/`batchVideos`/`genImage`/`genVideo` 四入口前调用；免打扰 key 用 `agnes.cost_confirmed_today` + `{expiresAt}`（照 `costConfirm.ts:20-24` 的 `setHours(23,59,59,999)`）。本地版无真实计费，单价表应做成 `lib/seed.js`/settings 可配置项而非硬编码。

**8.6 统一 `errorKind` 枚举 + 中文映射 + 真实原因兜底拼接**｜**S**｜风险 低
- 他们：8 值稳定枚举（`aigc.ts:129-137`）+ `AIGC_ERROR_MESSAGES_ZH`（`:144-153`）+ `formatAigcFailureMessage` 把上游原文拼在中文后（`:164-171`），并有**明确反模式注释**禁止页面自建白名单。
- 我们：`public/js/api.js:21-27` 只有 `data?.error || 请求失败（HTTP ${status}）`；`lib/agnes.js:113-115` 有 `errorType:'proxy_timeout'|'network_error'` 但页面层未按它分支。我们**文案质量本身更好**（`tasks.js:150-160` 三态橙色 note、`videos.js:353-358` 三步骤诊断、`storyboards.js:275` 弹原文），但缺**统一枚举 + 兜底拼接**。
- 建议：`public/js/consts.js` 加 `ERROR_MESSAGES` 表（键：`network`/`timeout`/`submit_timeout_unknown`/`auth`/`quota`/`content_audit`/`bad_json`/`unknown`）与 `formatError(errorType, rawMessage)`（逻辑照 `aigc.ts:164-171`：原文非空且不等于基础文案则拼 `：${raw}`）；`api.js:21-27` 改调它；复用 `lib/agnes.js` 已有的 `errorType`。`consts.js:162-165` 的 `poll_timeout`/`video_url_missing`/`submit_timeout_unknown` 应各配「不代表失败」说明——我们已做对，只是没和错误枚举打通。

**8.7 前端请求超时与取消**｜**S**｜风险 低
- 他们：`AbortSignal` 全链路透传（`aigc.ts:461,476,489,594`），LLM 首包 25s 硬超时后转 poll（`llm.ts:40,115-117`）。
- 我们：`public/js/api.js:6-28` 的 `req()` **无 `AbortController`、无超时**（基线 G-6 明确「`AbortController` 全库 0」）。后端有超时：`lib/agnes.js:96` `AbortSignal.timeout(timeoutMs)`、`:444` `AbortSignal.timeout(300000)`。→ **后端挂了前端永远转圈**，`setBusy` 秒表停不下来。
- 建议：`api.js` 的 `req()` 加 `signal: AbortSignal.timeout(30000)`（批量端点传更长，如 `batchVideos` 60s），catch 里把 `TimeoutError` 映射成 `{ok:false, error:'本地服务响应超时（30s），可能在重启中'}`；`ui.js:317` 的 `setBusy` 加可选 `timeoutMs`，超时自动解禁 + toast。`AbortSignal.timeout` 需 Node ≥17.3 / 现代浏览器，我们要求 Node ≥20.6（AGENTS.md），无障碍。

**8.8 分镜行「三状态点」+ 阶段链进度**｜**M**｜风险 低-中
- 他们：每幕卡片叠 3 个 `StageDot`（图/视频/音频各自的 success/running/failed/idle，`ShotTimeline.tsx:12-17,130-134`）；`PipelineProgress` 是 5 枚徽标链（`PipelineProgress.tsx:5-11,40-55`）。
- 我们：`storyboards.js:156-157` 只有 `image_prompt`/`video_prompt` 两列，行级 `status` 是单值（`STORYBOARD_STATUS`，`consts.js:242-247`：pending/image_ready/video_ready/done）；批量进度只有单条百分比条（`helpers.js:29-47`）。
- 建议：`storyboards.js` 表格加「产出」列渲染 3 个状态点（有 `linked_image_id` → 图点绿；`lib/store.js` 的 `video_assets` 里按 `storyboard_id` 有 completed → 视频点绿；无 TTS 不显示音频点）；`helpers.js` 的 `renderBatchBar` 加可选 `stages` 参数，在进度条上方渲染阶段徽标链（数据来自 `lib/jobs.js` 的 job 结构，**需确认**是否已含阶段字段）。

**8.9 平台预设一键适配画幅**｜**S**｜风险 低
- 他们：`PLATFORM_PRESETS` 8 条（西瓜 16:9 / 抖音·快手·视频号 9:16 / 腾讯·B站 16:9 / 小红书 3:4 / 方形 1:1），每条带 `emoji+hint`（`useHome.ts:41-50`），UI 一行 chip（`ScriptPanel.tsx:236-256`）；成片后按当前比例反查平台并给**创作者中心直链**（`PreviewPanel.tsx:96,218-239`）。
- 我们：`public/js/consts.js:67` 的 `PLATFORMS` 有 9 个平台名，`:68` 的 `ASPECTS` 有 5 个画幅，但**两者无任何映射关系**，且 `PLATFORMS` 全库 **0 消费点**（grep 仅定义处）。项目 `aspect_ratio` 由用户手选，`sizeForAspect`（`:90-96`）负责映射像素。
- 建议：`consts.js` 把 `PLATFORMS` 升级为 `PLATFORM_PRESETS=[{id,label,aspect,hint,emoji}]`（照抄其 8 条 + 我们的 YouTube Shorts/TikTok），保留旧导出兼容；`public/js/pages/projects.js` 新建/编辑表单（`:126-143` 附近）在 `aspect_ratio` 字段上方加平台 chip，点击写入对应画幅。

**8.10 素材「URL 优先」是对的，但缺「一键取公网链接」**｜**S**｜风险 低
- 他们：`uploadAigcMedia` 用 `FormData` multipart 直传（`aigc.ts:390-396`），素材在业务模型里**只存 URL**（`UserAsset.url`，`useHome.ts:184-190`）；注释记录事故：「不要再用 `fileToDataUrl` 把几十 MB 视频转 base64 塞 JSON：Goja 单线程逐字符解码会锁死 PB → 502/524」（`:423-427`）。
- 我们：**已经是 URL 优先**——`videos.js:244` 参考图是「图片 URL（公网）」文本输入，`:270` 有 `if(!/^https?:\/\//.test(...)) toast.err('参考图必须是 http(s) 公网地址——本地路径模型看不到，可去素材库复制图片链接')`。但**没有「复制公网链接」的入口**，用户得自己找。
- 建议：**反向借鉴**——保持 URL 优先，补上取链接这一步：`public/js/pages/assets.js` 图片卡加「复制公网链接」动作（`remote_url` 存在时）；`videos.js` 的 URL 输入框旁加「从素材库选图」下拉（数据源 `state.images`）。**不要**引入 multipart 上传到本地（无图床，本地路径模型抓不到，正是 `:270` 已正确拦截的场景）。

**8.11 视觉：字号/间距/圆角 token 收敛（只做低风险部分）**｜**M**｜风险 中
- 他们：字号 8 档 token（`index.css:64-71`）、间距 8 档（`:48-55`）、圆角 3 档（`:56-59`），Tailwind 配置**全部引用 token 而非字面量**（`tailwind.config.js:18-20`）。
- 我们：基线 §10 已量化——字号 **14 档半像素阶梯**（10〜13.5px 挤了 8 档）、间距 **28 个不同 px 值**、圆角 **15 档 vs 3 个 token**，JS 内联 `style="` 全前端 **224 处**（tasks 40 / storyboards 40 / videos 35）。
- 建议：`public/css/app.css` 已有 `--radius-card/btn/input`、`--gold*`、`--text*`、`--bg*`；补一层字号/间距 token（`--fs-1..6`、`--sp-1..8`），然后**只做两件低风险事**：① 新增代码一律用 token；② 把基线 §11.2 列的 10 条高频重复内联（`grid-column:1/-1` 12 次、`margin-top:14px` 7 次等）抽成工具类。**不要**做 224 处全量替换。纯视觉改动需跑 `node tools/ui-audit.mjs` 度量回归。

**8.12 a11y：取他们唯一做对的一点，补我们唯一缺的一点**｜**S**｜风险 低
- 他们：只有 `CostConfirmDialog` 做对了 `role="dialog"`+`aria-modal`（`:29-30`），但**无焦点陷阱、ESC 不生效、遮罩点击直接取消**——**并不比我们强**。
- 我们：`public/js/ui.js:48-104` 的 `modal()` **已有** ESC 关最上层、Tab focus 陷阱、自动聚焦、`body.modal-open` 锁滚动（基线 §0.2），但**缺 `role="dialog"`/`aria-modal`/标题关联**（基线 G-4）。
- 建议：`ui.js:48` 的 modal 根节点补 `role="dialog" aria-modal="true" aria-labelledby="<标题id>"`；`toast()`（`:10`）容器补 `aria-live="polite"`（基线 F19 已记）。

---

## 9. 不值得借鉴 / 边界

| 项 | 他们的做法（证据） | 为什么不借鉴 |
|---|---|---|
| **Radix UI + shadcn 组件库** | 46 个 `src/components/ui/*.tsx`，依赖 27 个 `@radix-ui/*`（`package.json:14-39`），实际只引用 15 个 | 与「零 npm 依赖 + 无构建 + vanilla JS ESM」硬冲突；31 个组件 0 引用，本身就是负资产。我们 `public/js/ui.js`(343 行) 已覆盖 modal/confirm/prompt/toast/empty/spinner/setBusy/options 八件套。 |
| **Tailwind + PostCSS + Vite 构建链** | `tailwind.config.js`(123)、`postcss.config.js`、`vite.config.ts`、`tsc -b` | 我们 `public/` 直出、无构建、支持 Node SEA 单文件 exe（AGENTS.md）。引入构建链会摧毁分发形态。 |
| **PocketBase + Goja pb_hooks 后端** | `aigc.pb.js` 1227 行跑在 Goja 单线程里 | 我们有 `server.js` + `lib/*.js` 原生 Node + `data/*.json`。且 Goja 性能陷阱已被他们自己记录（`aigc.ts:423-427` 的 502/524 事故）。 |
| **轮询跑在浏览器 tab 内** | `while` 循环在页面里（`aigc.ts:475-546`），关页即断，靠挂载 resume 补救（`useHome.ts:534-537`） | 我们 `lib/poller.js`+`lib/jobs.js` 在后端进程轮询、SSE 推前端，且 `settings.js:184` 已把「关掉浏览器也会继续」写进产品承诺。**架构优势，绝不能倒退**。 |
| **多代际路由探测降级** | `legacyAigcRoutes`/`legacyAigcUploadRoute`/`legacyLlmRoutes` + `uploadAigcMedia` 双重签名（`aigc.ts:245-421`、`llm.ts:51-58`） | 纯属「发布刷新只换前端 lib」这一平台部署模型的历史包袱（注释记了两起真实事故）。我们单机自部署、前后端同版本发布，无代际漂移，引入只增复杂度。 |
| **硬编码成本单价** | `imgUnit = cinematic?3.04:hd?0.76:0.23`、`vidUnit*5`（`useHome.ts:861-868`） | 单价写死前端，且 `vidUnit*5` 假设「每幕 5 秒」与真实 `durationSec`（4–15s）脱钩。我们应做成 `lib/seed.js`/settings 可配置表并接真实时长。 |
| **无并发上限的 `Promise.allSettled`** | 三阶段各自对全部镜头并发（`useHome.ts:936,989,1025`） | 8 幕 = 8 路同时打上游。我们 `storyboards.js:366,405` 已有 `concurrency:3`/`concurrency:1`，是更好的默认。 |
| **角色库只存内存** | `useState<IpCharacter[]>([])`（`useHome.ts:474`），`persistProject` 不含 IP 库（`:672-684`） | 刷新即丢、历史项目无法复现一致性——是**缺陷**而非设计。落地 8.1 时必须落 `data/characters.json` 并在 `projects` 存 `character_ids`。 |
| **`.dark` 与 `:root` 完全重复** | `index.css:26-78` 与 `:80-132` 逐行相同 | 冗余维护负担。我们 `public/css/app.css:10` 一行 `color-scheme: dark` 更干净。 |
| **`react-hook-form` + `zod` 装了不用** | 依赖在 `package.json:13,53,60`，业务代码 0 引用 | 依赖膨胀典型。我们表单校验虽散点手写，但至少没装无用包。 |
| **`index.html` `lang="en"`** | 源码包 `index.html:2`，界面全中文 | 明确缺陷。我们 `public/index.html:2` 已是 `lang="zh-CN"`，保持即可。 |
| **平台契约文件** | `src/vibex-permissions.json` 62 行声明 `usesRHAPI:true` + 6 条 capability（含 `billing`/`trigger`） | Vibex 发布审计的机器可读契约，与我们部署模型无关。但其中「**每个付费调用点显式声明 `trigger: user_action`**」的思路值得记：等价于 8.5 的「付费入口必须包一层用户确认」。 |

---

## 附：核对清单与未确认项

- **源码包**：`useHome.ts`(1193)、`aigc.ts`(1090)、`ScriptPanel.tsx`(462)、`ShotTimeline.tsx`(314)、`IpSidebar.tsx`(296)、`PreviewPanel.tsx`(256)、`HomePage.tsx`(196)、`AssetLibrary.tsx`(195)、`llm.ts`(194)、`VoiceRecorder.tsx`(164)、`HelpDialog.tsx`(77)、`CostConfirmDialog.tsx`(74)、`HistoryStrip.tsx`(66)、`PipelineProgress.tsx`(58)、`TopNav.tsx`(48)、`useCostConfirm.ts`(80)、`costConfirm.ts`(39)、`pb.ts`(41)、`rhLogin.ts`(613，读前 200 行) **逐行读**；`index.css`(147)、`tailwind.config.js`(123)、`package.json`(84)、`index.html`、`vibex-permissions.json`、`vibex-local/export-manifest.json` 全文读。后端 `pocketbase/pb_hooks/{aigc,llm,projects}.pb.js` **只做定向 grep，未逐行读**——§5.4 模型参数表以 ALLOWED_MODELS 字面量为准，pb_hooks 的 payload 构造细节**未确认**。
- **我们侧**：`AGENTS.md`、`docs/research/ui-our-baseline.md`(346)、`public/js/consts.js`(449)、`api.js`(99)、`public/index.html` 全文读；`public/js/pages/{storyboards,images,videos,ui,app}.js`、`public/css/app.css`、`lib/{routes,agnes,store,seed}.js` **定向读 + grep**。
- **未确认项**：① Agnes 图片接口是否支持多参考图（影响 8.3 可行性）；② `lib/jobs.js` 的 job 结构是否含阶段字段（影响 8.8）。

*（完 —— 本报告为纯研读，未改动源码包与本仓库任何代码文件。）*
