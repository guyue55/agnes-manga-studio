# 源码研读报告 05 —— Vibex「Seedance2.5 导演台」（`seedance2.5-75-remix-42c8350f`）

> 研读对象（**只读，未修改任何文件**）：`/Users/apple/Project/Git/Webeye-Video/docs/AI创作资料/08-AI创作项目源码/seedance2.5-75-remix-42c8350f-Seedance2.5导演台/`
> 对照对象（下称「我们」）：`/Users/apple/Project/Git/agnes-manga-studio/`
> 口径：所有行号均以本次逐行读取的实际文件为准，标注 `相对路径:行号`。凡不确定处显式写「未确认」。本项目基线参考 `docs/research/ui-our-baseline.md`，但**该文至少 3 条结论已过期**（videos 页 SSE 订阅、`empty()` 的 CTA 插槽、`confirm()` 的取消守卫 —— 见 §10 前言与 §10.1/§10.6/§10.13），本文所有「我们现状」均为重新读码确认。

---

## 1. 一句话定位与技术栈

一个把 RunningHub 上 3 个视频引擎（Seedance / Wan 3.0 / MiniMax H3，共 8 个档位）包装成「AI 导演台」的单页工作台：左侧素材轨道、右侧参数与提示词、下方多任务并发队列、右下作品库，外加一个 `/plaza` 作品广场。核心卖点是**结构化导演 Agent**（视觉读素材 → 出 JSON 镜头方案 → 编译成模型可执行提示词）与**费用预估 + 扣费确认**。

| 项 | 事实 | 证据 |
|---|---|---|
| 路由数 | **3 条**（`/`、`/plaza`、`*`→Home） | `src/App.tsx:5-12` |
| 页面数 | **2 个页面**（Home / Plaza），各拆 `index.tsx`(接线) + `XxxPage.tsx`(视图) + `useXxx.ts`(逻辑) | `src/pages/Home/{index,HomePage,useHome}`、`src/pages/Plaza/{index,PlazaPage,usePlaza}` |
| ts/tsx 文件数 | **86**（72 `.tsx` + 14 `.ts`），其中 `src/components/ui/*` 是 shadcn 生成物 47 个 | `find src -name '*.ts' -o -name '*.tsx' \| wc -l` |
| 业务代码规模 | `useHome.ts` 1474 行、`lib/aigc.ts` 1129 行、`lib/rhLogin.ts` 613 行、`usePlaza.ts` 335 行、`useSeedance25Logic.ts` 231 行 | `wc -l` |
| 状态管理 | **无 Redux/Zustand/Jotai**。每页一个自定义 hook 返回「view model」，通过 `ReturnType<typeof useHome>` 类型透传给子组件 | `src/pages/Home/index.tsx:4-6`、`src/components/home/CreationDeck.tsx:5`、`HomePage.tsx:11` |
| UI 库 | **shadcn/ui + Radix**（`style:"default"`, `baseColor:"slate"`, `cssVariables:true`）+ Tailwind 3.4 + `lucide-react` 图标 + `sonner`(toast) + `vaul`(drawer) + `cmdk` | `components.json:1-17`、`package.json` dependencies |
| 后端接入方式 | **PocketBase**（`new PocketBase(getPocketBaseUrl())`，`pb.beforeSend` 注入 `X-Vibex-Scoped-Token`），业务后端是 PB 的 JS hook（`pocketbase/pb_hooks/*.pb.js`），前端只 `fetch` 自定义路由 | `src/lib/pb.ts:26-37`、`src/lib/aigc.ts:935`、`pocketbase/pb_hooks/aigc.pb.js` |
| RunningHub 接入层 | **双层**：前端 `src/lib/aigc.ts`（提交/轮询/价格预估/上传/历史，全部「不 throw，返回结构化结果」）+ 后端 `pocketbase/pb_hooks/aigc.pb.js` 1228 行 / 9 个路由，持有 RH API Key 并透传计费票据头 | `src/lib/aigc.ts:593-727`、`aigc.pb.js:339/362/447/687/823/943/1130/1197` |
| 能力声明 | `vibex-permissions.json`：`usesRHAPI: true`，逐模型声明 `{kind:"aigc", output:"video", route:"/api/aigc/submit", billing:"wallet", trigger:"user_action"}` | `src/vibex-permissions.json` |
| 构建 | Vite 8 + `tsc -b`，`@` 别名指向 `src`，子路径部署靠 `getBasename()` | `package.json` scripts、`src/lib/pb.ts:22-24` |

**⚠️ 首要事实校正**：本包名为「Seedance2.5导演台」，但 `src/pages/Seedance25Logic/useSeedance25Logic.ts` **是孤儿文件** —— 全仓 `grep -rn "useSeedance25Logic"` 只命中它自己的定义处（`useSeedance25Logic.ts:22`），`Home`/`Plaza` 都没有 import 它。真正在跑的是 `useHome.ts`（多任务并发版）。下文 §3 按任务要求逐段拆解该文件，同时标注它与 `useHome.ts` 的差异，避免把死代码当成生产路径。

---

## 2. 信息架构与页面流

### 2.1 Home 编排页骨架

`HomePage.tsx` 是一个 158 行的纯视图，所有状态来自 `useHome()`：

```
div.studio-grid                                  // HomePage.tsx:15  网格底纹 + 径向光晕
├─ StudioHeader                                  // :16  品牌 + 账户菜单 + 余额
├─ needsRhLogin && 红色横幅「登录状态已过期，请重新登录后继续创作。」+「重新登录」  // :18-25
└─ main
   ├─ hero 区                                     // :31-48
   │   ├─ .eyebrow「AI filmmaking workspace」      // :33
   │   ├─ h1「脑海里的画面，现在开拍。」(.text-gradient 渐变)  // :34-36
   │   ├─ p「从一句话、一张图出发，定下镜头、节奏与声音，把想象拍成一段能播放的故事。」 // :37
   │   └─ 三张统计卡「3 创作引擎 / 3 创作模式 / 30s 最长镜头」+ 外链「账单明细」 // :40-46
   ├─ CreationDeck    （导演工作台：MediaRail 左 20rem + DirectorControls 右）  // :50-…
   ├─ VideoStage      （导演监视器：预览 + taskId 复制 + 实际扣费 + 下载）
   ├─ TaskPanel       （制作队列：并发任务卡 + 进度条 + 取消）
   └─ WorkLibrary     （作品库：筛选/评分/标签/备注/分享/删除）
├─ footer「Director Studio · Seedance · Wan · MiniMax」 // :153
├─ CostConfirmDialog                             // :154
└─ PreviewLightbox                               // :155
```

### 2.2 Plaza 模板广场

- 路由 `/plaza`（`src/App.tsx:8`），`PlazaPage.tsx` 组成：`PlazaHeader` + `FeaturedRail`（精选横滑）+ `PlazaToolbar`（搜索/排序/筛选）+ `WorkGrid` + `WorkDetailModal` + `InteractionNotice`（底部居中错误浮条，`InteractionNotice.tsx:7-11`）。
- 数据源是 PB 集合 `video_gallery`（`usePlaza.ts:86-90` `fetch(.../api/video_gallery?is_public=true...)`），**不是**独立的「模板」集合 —— 广场内容 = 用户把作品库条目 `is_public` 打开（`useHome.ts:678-688 toggleShare`，分享时把昵称/头像快照进记录，因为广场看不到别人账号）。
- 排序：`PlazaSort = "newest" | "hottest"`（`usePlaza.ts:25`）；筛选维度：关键词、模型、画幅、时长、标签、只看我的收藏（`usePlaza.ts:66-73`）。
- 模型名到中文短标签有独立映射表 `MODEL_LABEL`（`usePlaza.ts:27-41`，如 `"seedance-2.5": "2.5 文生"`）；标签由 `tagsOf()` 合成：模型标签 + `generate_audio && "带音效"` + `resolution`（`usePlaza.ts:53-58`）。
- 卡片交互：hover/focus 即 `video.play()` 静音预览（`WorkGrid.tsx:13-14, 17`）；`content-auto` 类做 `content-visibility:auto` 长列表节流（`WorkGrid.tsx:17` + `index.css:292-295`）。

### 2.3 结构化提示词编排的 happy path（含关键文案原文）

1. **选模式**：三段 segmented，文案 `参考` / `文字` / `图片`，选中态下方 1px 主色发光条（`DirectorControls.tsx:21, 124`）。
2. **选引擎**：三张大卡 —— `Seedance`「专业导演主力 / 多素材编排、声音与高规格输出 / 最多 50 项素材」、`Wan 3.0`「经济长镜头 / Prompt 直出，也可加入图片或视频参考 / 最长 30 秒」、`MiniMax H3`「官方与开源双路线 / 高画质托管模型，或 768P 开源插件流 / 官方 / 开源」（`videoModels.ts:40-60` 的 `ENGINE_META`；卡片渲染 `DirectorControls.tsx:128-141`）。切引擎会走 `handleSetEngine → handleSetTier`（`useHome.ts:315-317`），把分辨率/时长/画幅**按新模型契约收敛**而不是清空（`useHome.ts:300-313`）。
3. **选档位**：`ENGINE_MODELS[engine]` 多于一档时出「版本与档位」（`DirectorControls.tsx:144-152`），Seedance 四档 `2.5 / 2.0 Pro / 2.0 Fast / Mini`。
4. **喂素材**：`MediaRail`。参考模式是多图/多视频统一网格 + 独立音频区，超限静默丢弃（`useHome.ts:831-850`）；图片模式是 A/B 双帧槽（`MediaRail.tsx:258-264`，文案「用首尾帧锁定镜头起点与终点」）；文字模式显示「无需上传素材，在右侧描述镜头、动作与氛围即可」（`MediaRail.tsx:267`）。
5. **写提示词**：`参考`/`图片` 模式渲染 `AtMentionTextarea`，placeholder「输入 @ 引用胶片轨道中的素材，并描述镜头变化……」（`DirectorControls.tsx:164`）；`文字` 模式是普通 textarea（`:162`）。右上角实时 `{prompt.length}/2000`，>1800 变琥珀色（`:159`）。
6. **请导演**（可选，两条入口）：`找灵感` → 打开 Sheet 的 `library` 标签；`让导演帮我` → `chat` 标签（`DirectorControls.tsx:173-174`）。Sheet 是 `lazy()` 懒加载（`:11`）+ `Suspense`（`:185`）。
7. **让 Agent 直接润色**（更轻的路径）：`让Agent帮你写提示词` → `optimizePrompt()`（`DirectorControls.tsx:178`、`useHome.ts:1259-1330`）；润色后出现 `恢复原文`（`:179`）。
8. **设参数**：画幅（带形状示意方块，`DirectorControls.tsx:24, 204`）、分辨率 `CompactSelect`、时长（`DurationControl`，含「智能时长」开关 + 自定义秒数回退，`:26-63`）；折叠在「高级参数」下的码率模式 / 生成配音与音效 / AIGC 内容标识 / 真人素材模式（`:213-221`）。
9. **看价格 → 确认 → 生成**：费用预估卡显示折扣徽标「Seedance 7.5 折」+ 划线原价 + 折后价（`:236-240`），说明文案「Seedance 专享 7.5 折，实际扣费以账单为准」（`:229`）；点「生成视频」（`:251`，右侧 `⌘ ENTER` 提示）→ 走 `executeGenerate`（`useHome.ts:1205-1243`）→ 每个 job 就地包 `costConfirm.runWithCostConfirm`（`useHome.ts:1024, 1062, 1123`）。
10. **监视 + 队列**：`VideoStage` 空态「等待第一个镜头」/ 生成态「镜头正在渲染 / 可以继续创建，新任务会进入并发队列」（`VideoStage.tsx:36, 41`）；`TaskPanel` 空态「队列当前为空 / 提交后可继续创建下一条镜头」（`TaskPanel.tsx:14`）。
11. **落盘 + 复用**：成功后 `saveToGallery`（`useHome.ts:576-621`）并 `loadHistory`；作品库卡片可「复用参数」（`VideoStage.tsx:54`）或从广场 `?remix=<id>` 深链回填（`useHome.ts:771-787`）。

---

## 3. `useSeedance25Logic` 生成逻辑逐段拆解

> 文件：`src/pages/Seedance25Logic/useSeedance25Logic.ts`（231 行）。**未被任何组件引用**（§1 校正）。它是一份「单任务、单模型」的极简实现，可当作理解 `useHome.ts` 的骨架。

### 3.1 常量与状态机骨架

- `const MODEL = 'seedance-2.5'`（`:16`）、`POLL_INTERVAL_MS = 6000`（`:17`）、`POLL_TIMEOUT_MS = 3600000`（1 小时，`:18`）。
- 参数默认值（`:26-31`）：`resolution='720p'`、`duration='5'`、`ratio='adaptive'`、`generateAudio='True'`（**字符串**，直传上游 bool 契约）、`bitrateMode='standard'`、`prompt=''`。
- 生成态（`:34-42`）：`isGenerating` / `jobDisplayStatus`（字符串枚举 `queued→running→succeeded|failed|timeout`）/ `resultUrl` / `resultType` / `resultOutputs` / `resultTaskId` / `resultUsage` / `errorMsg` / `needsRhLogin`。
- 历史态（`:45-47`）：`genHistory` / `historyLoading` / `resumingJobIds`（正在续跑的任务 id 数组）。
- 价格态（`:52-54`）：`priceText` + `priceLoading` + `priceDebounceRef`。源码注释明确写了三态约定：**`priceLoading?'预估中':(priceText||'按实际扣费')`**，并禁止 View 写 `priceText || '费用预估中'`（`:50-51`）—— 否则「失败/空价」会被误当成「一直在加载」。
- `canGenerate = prompt.trim().length > 0 && !isGenerating`（`:212`）。

### 3.2 完整链路

| 阶段 | 实现 | 证据 |
|---|---|---|
| ① 输入校验 | `runGenerate()` 首行 `if (!prompt.trim()) return`（静默返回，无 toast） | `:139` |
| ② 参数装配 | 手工拼 `{resolution, duration, ratio, generateAudio, bitrateMode, prompt}`（**不**复用 `buildModelScalarPayload`） | `:147-154` |
| ③ 价格预估 | `useEffect` 依赖 6 个参数，清旧 timer → 立刻 `setPriceLoading(true)` → `setTimeout(500)` 后 `previewAigcPrice(MODEL, body)` → `formatAigcPricePreview(r)`；catch 时 `setPriceText(null)`；`finally setPriceLoading(false)` | `:69-85` |
| ④ 扣费确认 | `handleGenerate()`：`if (isGenerating) return` → `costConfirm.runWithCostConfirm(runGenerate, priceText \|\| '按 RunningHub 实际扣费')` | `:182-186` |
| ⑤ 提交 + 轮询 | `callAigcAndPoll(MODEL, runBody, { pollIntervalMs: 6000, deadlineMs: 3600000 })` —— **不自写 while 循环**，注释「Submit + poll via callAigcAndPoll (shared helper; do not hand-roll while poll)」 | `:157-161` |
| ⑥ 成功分支 | 取 `res.outputs` / `res.url`（回退 `outs[0].url`）/ `resultType=outs[0].type` / `resultTaskId` / `resultUsage` → `jobDisplayStatus='succeeded'` → `void loadHistory()`（不 await） | `:163-171` |
| ⑦ 失败分支 | `needsLogin \|\| errorKind==='login_required'` → `setNeedsRhLogin(true)`；`errorMsg = formatAigcFailureMessage(res)`；`jobDisplayStatus = errorKind==='timeout' ? 'timeout' : 'failed'` | `:172-176` |
| ⑧ 收尾 | `finally setIsGenerating(false)` —— **注意 `setJobDisplayStatus` 没有回到 idle**，状态是单向的 | `:177-179` |
| ⑨ 断点恢复 | `loadHistory()` 成功后取最后一条 `status==='success' && resultUrl` 回填主预览与 prompt，并对所有 `status==='running'` 调 `resumePollingJob(jobId)` | `:87-108` |
| ⑩ 续跑 | `resumeAigcJob({jobId, model: MODEL}, {pollIntervalMs, deadlineMs})` → 成功则就地改 `genHistory` 那条记录 + 回填结果；失败同样改记录状态并写中文 errorMessage | `:111-135` |
| ⑪ 历史 CRUD | `handleUpdateHistory` / `handleDeleteHistory`，两者都是 `try{...}catch{/* silent fail */}` | `:188-204` |

### 3.3 依赖与副作用清单

- 依赖：`@/lib/aigc`（`callAigcAndPoll` / `resumeAigcJob` / `formatAigcFailureMessage` / `loadAigcHistory` / `updateAigcHistoryItem` / `deleteAigcHistoryItem` / `previewAigcPrice` / `formatAigcPricePreview`，`:2-11`）、`@/hooks/useCostConfirm`（`:13`）、类型 `RhAccountInfo`（`:14`）。
- 副作用：挂载时 `loadHistory()`（`:63-65`，deps 为 `[]`，但注释说「Load history on mount」—— 未挂 ESLint exhaustive-deps 抑制，属可接受偏差）；价格 effect 的 timer 清理（`:82-84`）。
- **与 `useHome.ts` 的关键差异**：`useHome` 用 `computeExpectedSec(tier, resolution, duration)` 给每个 job 算预计耗时驱动进度条（`useHome.ts:74-86`）；用 `AbortController` 按 jobId 存 `jobControllersRef` 支持取消（`:451, 473-476`）；用 `resumedJobIdsRef` + `jobs.some(j=>j.serverTaskId===it.jobId)` 双重去重防止同一后端任务被「正常流程」和「续跑流程」各 poll 一次（`:964-967`）。`useSeedance25Logic` 这些全无。

---

## 4. 素材职责分配与 @ 提及语法

### 4.1 三类素材各自去哪

| 模式 | 素材 | 装配到请求体的字段 | 证据 |
|---|---|---|---|
| `image`（图生视频） | 首帧（必填）/ 尾帧（可选） | `firstFrameUrl`、`lastFrameUrl`；`slug === "seedance-2-5-image-video"` 时额外 `realPersonMode` 与 `returnLastFrame = Boolean(lastUrl)` | `useHome.ts:1080-1090` |
| `ref`（多模态参考） | 图片 / 视频 / 音频三桶 | `imageUrls[]`、`videoUrls[]`、`audioUrls[]`；`slug.includes("multimodal-video")` 时强制 `conversionSlots = ["all"]`、`returnLastFrame = false` | `useHome.ts:1161-1177` |
| `ref`（H3 开源流） | 同上，但**打平为下标字段** | `image1..imageN` / `video1..videoN` / `audio1..audioN` | `useHome.ts:1169-1172`（提交）、`:387-390`（预估） |

- 上限来自模型定义而非硬编码：`MODEL_DEFINITIONS[tier].refLimits`（`videoModels.ts:30, 74`）。Seedance 2.5 = `{images:30, videos:10, audio:10}`，2.0 Pro = `{9,3,3}`（`videoModels.ts:74, 81`）。
- **职责分配目前只体现在 UI 语义与提示词里**，没有结构化字段。参考模式的"职责"在 `useHome` 里完全不存在；`useSeedance25Logic` 更是连素材输入都没有（`:23-24` 只剩一句注释 `// --- Media inputs ---`）。

### 4.2 `AtMentionTextarea`：候选 / 插入 / 解析 / 回传协议

- **Props**：`{value, onChange, images: MentionImage[], placeholder?, rows?, className?}`（`AtMentionTextarea.tsx:10-17`）。
- **`MentionImage`**：`{id, label /* "图片1"/"视频2"/"音频1" */, preview /* 图片/视频用 objectURL，音频为 "" */, mediaType?: "image"|"video"|"audio"}`（`:3-8`）。
- **候选生成（调用方）**：`DirectorControls.tsx:73-80`。图片/视频按**出现顺序各自独立计数**生成 `图片${++imageIndex}` / `视频${++videoIndex}`；音频先排远端（复刻带回的）再排本地，编号连续：`音频${remoteAudio.length + index + 1}`。图片模式下候选是 `首帧` / `尾帧`（`:81`）。
- **触发解析**：`onChange` 里取 `selectionStart`，向前找最后一个 `@`，若其后到光标之间**不含空白**则视为正在输入 mention token，`setFilter(afterAt.toLowerCase())` + 展开下拉（`:37-58`）。Escape 关闭（`:111`）。
- **插入协议**：从光标前的最后一个 `@` 起，替换为 `` `@${img.label} ` ``（**尾随一个空格**，这是 token 终止符），然后 `setTimeout(0)` 后 `focus()` + `setSelectionRange(newPos,newPos)` 恢复光标（`:60-82`）。
- **过滤**：`images.filter(img => filter === "" || img.label.toLowerCase().includes(filter))`（`:100-102`）—— 因此输入 `@图` 能筛出「图片1/图片2」。
- **下拉外观**：标题写死 **「可能@的东西」**（`:125`），条目为 40px 缩略图（音频是喇叭 SVG、视频是 `<video muted preload="metadata">` + 播放角标、图片是 `<img>`）+ label + 类型中文（`:140-171`）。用 `onMouseDown` + `e.preventDefault()` 抢在 blur 前插入（`:133-135`）。
- **回传协议（重要）**：mention 只是**纯文本**写进 prompt，`onChange` 直接把它当普通字符串回传。**没有** id→URL 的结构化映射回传，也**没有**从 prompt 反解 `@图片N` 到具体素材的函数。素材与编号的对应关系只在提交时按数组顺序隐式成立（`useHome.ts:1135-1147` 的 `resolveItems` 按 `items.slice(0, limit)` 保序上传）。因此**如果用户删掉中间一张图，后面所有 `@图片N` 的语义会整体错位** —— 这是本包一个真实的一致性缺口。

### 4.3 `<Picture N>` 参考图协议

- **本包中不存在**。全仓 `grep -rn "Picture"` 无命中；上游 RH 契约里与参考图编号相关的是 `conversionSlots`（`aigc.pb.js:875` 附近 `enum:["all","image1".."image9","video1".."video3"]`，本包一律传 `["all"]`，`useHome.ts:1164`）。
- 也就是说：**`@图片N` 是纯前端自造语法，服务端不认识**；编号靠"上传数组顺序"与上游隐式对齐，未确认 RunningHub 是否按同一顺序解析 `imageUrls`。这一点在设计上属于**未验证的假设**。

---

## 5. 参数与成本

### 5.1 参数定义与默认值

`MODEL_DEFINITIONS: Record<ModelTier, VideoModelDefinition>`（`videoModels.ts:68-127`），字段见 §6。要点：

| 档位 | 引擎 | slugs(text/image/ref) | 分辨率 | 时长 | 智能时长 | 音频 | 码率 | 真人 | refLimits |
|---|---|---|---|---|---|---|---|---|---|
| `next` (Seedance 2.5) | seedance | `seedance-2.5` / `seedance-2-5-image-video` / `seedance-2-5-multimodal-video-token` | 480p/720p/native1080p/1080p/2k/4k | 4–30 | ✅ | ✅ | ✅ | ✅ | 30/10/10 |
| `standard` (2.0 Pro) | seedance | `seedance-2` / `seedance-2-i2v` / `seedance-2-ref` | +native4k | 4–15 | ❌ | ✅ | ❌ | ❌ | 9/3/3 |
| `fast` (2.0 Fast) | seedance | `seedance2-0-fast-*` | — | 4–15 | ❌ | ✅ | ❌ | ❌ | 9/3/3 |
| `mini` (2.0 Mini) | seedance | `seedance-2-0-mini-*` | — | 4–15 | ❌ | ✅ | ❌ | ❌ | 9/3/3 |
| `wan-standard` / `wan-fast` | wan | `wan-3-0-*` | 480P/720P/1080P | 2–30(`auto`) | ✅ | ✅ | ❌ | ❌ | 10/5/5 |
| `h3` | h3 | `minimax-h3-*` | 2K/768P | 5–15 | ❌ | ❌ | ❌ | ❌ | 9/3/3 |
| `h3-oss` | h3 | `minimax-h3-oss-*` | (无) | 5–15 | ❌ | ❌ | ❌ | ❌ | 打平 image1..9 |

证据：`videoModels.ts:68-127`、`:129-133 ENGINE_MODELS`、`:139-160 modelSupportsMode/getModelSlug/slugToModelMode`。

**UI 默认值**（`useHome.ts:285-292`）：`tier='next'`、`resolution='720p'`、`duration='10'`、`ratio='adaptive'`、`generateAudio=true`、`bitrateMode='standard'`、`realPersonMode=true`、`aigcWatermark=false`、`activeTab='ref'`（`:261`）。注意 `useSeedance25Logic` 的默认时长是 `'5'`（`:27`），两处不一致。

**参数名归一化**（跨引擎差异被三函数吸收）：`toRequestResolution`（`videoModels.ts:162`，如 `native1080p→"1080p"`）、`toRequestDuration`（`:168`，wan 的 `-1→"auto"`）、`toRequestRatio`（`:184`，h3-oss 映射成 `"16:9 (Widescreen)"` 这类长串）。装配集中在 `buildModelScalarPayload`（`useHome.ts:120-145`）：`aspectRatio` 还是 `ratio`、`audio` 还是 `generateAudio` 都按 engine 分流。

### 5.2 价格预估算法（三层降级）

1. **上游真实预估**：`previewAigcPrice(slug, body)` → PB `/api/aigc/price-preview` → RH `POST /openapi/v2/price-preview/<endpoint>`，用**与提交完全相同的 payload 构造**（`aigc.pb.js:684-686` 注释）。任何失败归一成 `{ok:false}`，不 throw（`aigc.ts:998-1015`）。
2. **可信度判定**：`hasReliablePrice = isFreeThisCall || (estimatedPrice > 0) || Boolean(priceText?.trim())`（`useHome.ts:401-403`）。注释明确：Seedance 2.5 可能返回 `estimatedPrice=0` 但**不代表免费**，未知 Token 计费降级为「按实际扣费」（`:399-400`）。
3. **本地兜底价目**：`estimateSeedance20PriceValue`（`useHome.ts:90-101`）内嵌按秒单价表，如 `standard: {480p:0.6, 720p:1.2, 1080p:1.48, 2k:1.62, 4k:1.83, native1080p:3, native4k:3}`、`mini` 全档 `0.3`；无匹配则回退 `MODEL_DEFINITIONS[tier].priceFrom` 渲染成「¥X 起」（`:103-108`，`priceFrom` 见 `videoModels.ts:99/106/113/121`）。

**特例**：
- **自适应画幅代理预估**：Seedance 2.5 + `adaptive` 时上游给不出 token 预估价，于是用 `ratio="16:9"` 重新预估，展示时强制加「约」前缀（`useHome.ts:346-349, 413-415`），并置 `priceApprox=true`。
- **H3 OSS 按秒计费**：上游 `estimatedPrice=0.15` 是**每秒单价**而非总价，前端 `H3_OSS_PRICE_PER_SECOND = 0.15` × 秒数换算成总价，且**展示与扣费确认都必须用总价**（`useHome.ts:110-118, 404-412`）。
- **折扣展示**：`export const PRICE_DISCOUNT = 0.75`（`useHome.ts:148`），UI 渲染「Seedance 7.5 折」徽标 + 划线原价 + `priceValue * 0.75` 折后价（`DirectorControls.tsx:236-240`）。**折扣只影响展示，不影响真实扣费**。

### 5.3 扣费确认交互

- 契约层 `src/lib/costConfirm.ts`：storage key 固定为 `` `vibex_cost_confirmed_today:${appId}` ``（`:16-18`），`appId` 从 `window.location.pathname.match(/app-[0-9a-f]{32}/)` 提取、兜底 `"local"`（`:12-14`）；值 `{expiresAt: 今日 23:59:59.999}`（`:20-24, 37-38`）。
- 状态层 `useCostConfirm()`：`runWithCostConfirm(action, priceText, onCancel?)` —— **当天已确认则直接执行 action**（`:49-52`），否则把 action 挂进 `pendingActionRef` 并开弹窗。取消时调 `onCancel`，而三个 job 都传 `() => removeJob(jobId)`（`useHome.ts:1053, 1114, 1201`），注释写明「取消时不留下幽灵队列」。
- 视图层 `CostConfirmDialog`：`role="dialog"` + `aria-modal="true"`（`CostConfirmDialog.tsx:29-30`），文案「将调用 RunningHub AI，可能消耗 RH 币或钱包余额。」+ 价格句（`:43-44`），checkbox「今天内不再提醒（仅对当前项目有效）」（`:53`），按钮 `取消` / `确认运行`（`:61, 68`）。
- 契约硬约束（源码注释）：**禁止**自造 storage key、**禁止**用 `window.confirm/alert/prompt` 做计费确认（`costConfirm.ts:1-10`、`useCostConfirm.ts:1-31`）。这是 Vibex 发布审查的「用户主动触发证据」（`useHome.ts:1022` 引 `VIBEX-RHAPI-002`）。

### 5.4 任务轮询与断点恢复（刷新后如何恢复）

- **轮询**：`pollAigcToResult`（`aigc.ts:480-572`）。间隔从 `2500ms` 起，每轮 `+500` 封顶 `5000ms`（`:498-499`）；deadline 默认 8 分钟，`_isLongRunningModel()` 命中视频/音频/3D 关键词时自动延长到 30 分钟（`:487-488`）；每次轮询 `POST /api/aigc/jobs/<taskId>/poll`，带 `signal` 可取消；网络异常/5xx **当 RUNNING 继续 poll**（`:522-524, 537`）；412 → `errorKind:'login_required'`；404 → 快速失败（`:539-541`）；终态失败文案命中 `/content security audit|内容安全审查|审核未通过|content moderation/` 时单独归类为 `content_audit`（`:556-563`）。
- **提交重试**：submit 阶段 `for attempt<3`，遇 5xx 或网络错等 `1500ms` 重试；**412 与 4xx 不重试**（重试救不回）；`AbortError` 直接返回 `aborted`（`aigc.ts:605-650`）。注释说明重试针对的是「PB 热重载窗口 1-2 秒」。
- **落盘**：每次 poll 终态由后端写 `aigc_tasks` 集合（`aigc.pb.js:823-940`），落 `consume_money / consume_coins / task_cost_time / third_party_consume_money` 四列（`aigc.pb.js:203-206` 建表、`localExtractUsage` 提取），并 upsert 到 `VIBEX_CONTROL_URL` 的 app-task-index（`localReportTaskIndex`）。
- **刷新后恢复**：`loadHistory()` 并发拉 `ALL_MODEL_SLUGS.map(loadAigcHistory)`（`useHome.ts:524`），然后：
  - 取最新 `status==='success' && resultUrl` 回填主预览（`:536-537`）；
  - 对所有 `status==='running'` 且 `age < RESUME_MAX_AGE_MS`（6 小时，`:519`）的记录调 `resumeRunningJob(it)`（`:540-544`）。6 小时阈值理由写在注释里：更老的 running 大概率是陈旧数据，重跑 8–30 分钟轮询没意义。
  - `resumeRunningJob` 三重防重：`resumedJobIdsRef` 集合（`:965`）、`jobs.some(j=>j.serverTaskId===it.jobId)`（`:966`）、成功后 `saveToGallery` 内部再按 `task_id` 与 `result_url` 双键去重（`:587-592`）+ 两个 `Set` 做并发在途标记（`:593-594`）。
  - 恢复时**参数丢失**：源码注释直白承认「续跑任务丢失了原始分辨率/时长/比例参数（浏览器刷新前的状态），复刻时会退化成仅带回提示词」（`:1005`）。
  - 还有一条**跨设备补录**路径：`reconcileGallery` 比对 history 与 gallery，把漏存的成功记录补写进 gallery（`:623-641`），由 `account.userId` + `historyLoading` 变化触发（`:649-652`）。

### 5.5 @提及与模板广场的数据结构

- @提及：见 §4.2，`MentionImage[]`（`AtMentionTextarea.tsx:3-8`）→ 纯文本注入 prompt，无结构化回传。
- 模板广场：`PlazaWork`（`usePlaza.ts:6-23`）字段 `id/task_id/rh_user_id/result_url/prompt/model_name/resolution/duration/ratio/generate_audio/like_count/favorite_count/creator_name/creator_avatar/created/updated`；「模板」实质 = `is_public` 的 `video_gallery` 行，通过 `?remix=<id>` 深链回到 Home 复用（`useHome.ts:771-787` → `applyRemix` `:712-763`）。

---

## 6. 数据模型（TypeScript 类型清单）

### `src/lib/aigc.ts`
| 类型 | 行 | 关键字段 |
|---|---|---|
| `AigcOutput` | 13 | `url`, `type: "image"\|"video"\|"audio"\|"3d"\|"file"` |
| `AigcSubmitResponse` | 18 | `ok, taskId, rhTaskId?, status?, model?, error?, errorCode?, message?` |
| `AigcResponse<T>` | 31 | 旧 scaffold 兼容包络：`taskId, task_id?, rhTaskId?, results:T[], outputs` |
| `AigcPollResponse` | 39 | `status: "RUNNING"\|"QUEUED"\|"SUCCESS"\|"FAILED"\|"CANCEL"`, `outputs?, usage?` |
| `AigcUsage` | 53 | `consumeMoney, consumeCoins, taskCostTime, thirdPartyConsumeMoney` —— **全部 `string\|null`**，注释要求直接拼 `"¥"+thirdPartyConsumeMoney`，**禁止 parseFloat 再格式化**（避免精度问题） |
| `AigcPricePreview` | 62 | `ok, estimatedPrice?, currency?, priceText?, freeLimit?, isFreeThisCall?, message?` |
| `AigcScalarParam` | 74 | `name, type?: "string"\|"bool"\|"number", required?, enum?, default?` |
| `AigcMediaParam` | 84 | `name, type?: image/video/audio/zip, required?, multiple?, max_num?, accept?, max_size?` |
| `AigcModelInfo` | 94 | `model, endpoint, output_type, primary_input?, scalar_params?, media_params?` |
| `AigcSuccess` / `AigcFailure` / `AigcResult` | 103 / 114 / 142 | `AigcFailure.errorKind` 是 8 值稳定枚举：`submit\|poll\|timeout\|aborted\|login_required\|insufficient_balance\|content_audit\|task_failed` |
| `AigcHistoryItem` | 174 | `jobId, taskId, status, page, prompt, resultUrl, errorMessage, rating, favorite, category, note, created, updated, model` + 4 个 usage 快照字段 |
| `AigcHistoryQuery` | 197 | `page, perPage, status, favorite, category, minRating, sort` |
| `AigcHistoryPatch` | 208 | `Partial<Pick<..., "rating"\|"favorite"\|"category"\|"note">>` |
| `AiAppOutput`/`AiAppRunResponse`/`AiAppUploadResponse` | 323/335/346 | AI 应用（workflow）通道，与本包主路径无关 |
| `AigcUploadResponse`/`AigcUploadOptions` | 351/360 | `downloadUrl`, `{signal?, timeoutMs?}` |

### `src/lib/videoModels.ts`
`GenerateTab`(1) `"text"|"image"|"ref"` · `EngineId`(2) `"seedance"|"wan"|"h3"` · `ModelTier`(3) 8 值 · `Resolution`(4) 8 值 · `Duration`(5) `"-1"|"2".."30"` · `Ratio`(6) 9 值 · `MaterialLimits`(8) `{images,videos,audio}` · `VideoModelDefinition`(14) `{id,engine,label,shortLabel,detail,priceFrom?,slugs,resolutions,durationMin,durationMax,supportsSmartDuration,ratios,supportsAudio,supportsBitrate,supportsRealPerson,refLimits}`。

### `src/pages/Home/useHome.ts`
`BitrateMode`(46) `"standard"|"high"` · `VideoItem = AigcHistoryItem & {localUrl?, modelSlug}`(48) · `GeneratingState`(54) · `JobStatus`(57) `"confirming"|"uploading"|"queued"|"running"|"success"|"failed"` · `ActiveJob`(59) `{id,tab,slug,label,status,errorMsg?,startedAt,expectedSec,serverTaskId?}` · `PriceEstimate`(150) · `RefMediaItem`(157) `{id,type,file:File|null,previewUrl,remoteUrl?}`（`file===null` 表示复刻带回、已在 RH 上无需重传）· `GalleryItem`(167) 21 字段 + 5 个 `input_*_urls` 回填字段 · `GalleryFilter`(197) · `PRESET_TAGS`(199) `["风景","人物","动物","产品","建筑","艺术","其他"]`。

### 其他
- `MentionImage`（`AtMentionTextarea.tsx:3`）
- `DirectorMaterial`(1) / `PreparedVisual`(8) / `PreparedMaterialPack`(15)（`directorVision.ts`）
- `LlmContentPart`(4) / `LlmMessage`(8) / `LlmCallOptions`(13) / `LlmCallResult`(22) / `LlmModelInfo`(33)（`llm.ts`）
- `RhJwtPayload`(1) / `RhAccountInfo`(10)（`rhLogin.ts`）
- `MaterialObservation`(18) / `DirectorMemory`(26) / `DirectorPlan`(33) / `DirectorMessage`(51) / `PersistedDirectorState`(52) / `PanelTab`/`DirectorSkill`/`VisionStatus`(14-16)（`AiDirectorPanel.tsx`）
- `PlazaWork`(6) / `PlazaSort`(25)（`usePlaza.ts`）；`UseCostConfirmResult`（`useCostConfirm.ts:89`）

### 本地存储用法
| 键 / 容器 | 位置 | 用途 |
|---|---|---|
| `localStorage["vibex_cost_confirmed_today:<appId>"]` | `costConfirm.ts:16-38` | 今日扣费确认票据，`{expiresAt}` |
| `sessionStorage["director-v3:<userId>:<tier>:<tab>"]` | `AiDirectorPanel.tsx:178, 196` | 导演会话（messages/plan/memory/observation/fingerprint）按用户×模型×模式隔离 |
| `Map` `packCache` | `directorVision.ts:22` | 素材视觉包 Promise 缓存，key = FNV-1a 短哈希指纹（`:24-35`），失败时自删（`:171`） |
| 模块变量 `legacyLlmRoutes` | `llm.ts:52` | 记住后端 LLM 路由代际，避免每次 404 探测 |
| `WeakMap<File, Promise<string>>` `mediaUploadCacheRef` | `useHome.ts:244-258` | 同一 File 的上传 Promise 复用，防止参数变化重复上传 |

---

## 7. 提示词工程

### 7.1 内置场景模板（`AiDirectorPanel.tsx:89-94`，全文要点摘录）

四条 `inspirations`，每条 `{title, meta, description, brief, skill}`：

| 标题 | meta | description（摘） | brief（摘，即塞进输入框的指令） |
|---|---|---|---|
| 克制的情绪特写 | 单人物 · 慢推镜 · 8–12 秒 | 用停顿、视线和细微表情建立情绪，不依赖夸张动作。 | 「保留人物身份和环境，让人物先凝视画外，短暂停顿后缓慢回头。镜头轻微推近，情绪克制而有余韵。」 |
| 产品英雄镜头 | 商业广告 · 材质表现 · 稳定主体 | 用单一运镜、轮廓光和细节声效突出产品，不让 Logo 与结构变形。 | 「为主体设计高级产品英雄镜头：稳定产品结构与标识，使用克制的环绕或推近，突出材质反射与轮廓光。」 |
| 沉浸式一镜到底 | 空间叙事 · 连贯调度 · 10–20 秒 | 用前景遮挡和主体行动完成自然转场，保持空间关系清楚。 | 「设计一段连贯的一镜到底：镜头跟随主体穿过场景，通过前景遮挡自然过渡，动作和空间关系保持连续。」 |
| 参考视频节奏复刻 | 多模态参考 · 节奏迁移 · 内容重构 | 提取参考视频的运镜和节奏，保留自己的角色、场景与品牌。 | 「参考素材中的镜头节奏、动作速度和转场逻辑，但保留当前人物、场景与视觉身份，重新设计内容。」 |

四条能力（`skills`，`:82-87`）：`从想法到镜头` / `参考素材导演` / `叙事与节奏` / `广告质感`。库标签页的标题文案是**反模板**的：「先选一种拍法 / **它不是套模板。导演会重新看你的素材，再按模型和时长编排。**」（`:267`）。点击灵感卡只做两件事：`setSkill(item.skill)` + `setBrief(item.brief)`（`:249`），**不直接产出 prompt**。

### 7.2 `DIRECTOR_SYSTEM`：结构化 JSON 编排规则（`:96-113`）

设计意图逐条：
- **人格定义**：「你不是文案润色器，而是会先观察素材、确认当前模型约束、设计镜头，再把方案编译成所选模型可执行指令的导演 Agent。」（`:96`）—— 明确「观察→设计→编译」三段，而不是直接写词。
- **反幻觉**（规则 1）：「只把画面中能确认的内容写进 observation.facts；看不清就说不确定，**禁止臆造身份、品牌、地点或剧情**。」（`:99`）
- **记忆优先级**（规则 2）：「用户锁定项、已确认决定和避用项优先级最高。每轮更新 memory，不能忘记用户明确否定过的方案。」（`:100`）
- **主动追问但不停摆**（规则 3）：最多 2 个问题，**但仍给出一版可执行草案**（`:101`）。
- **按模式分流**（规则 4）：文生补全主体/场景/动作/视觉逻辑；图生**少复述外观**、重点编排动作/运镜/光线；参考生**明确每个 @素材 的职责**（`:102`）。
- **克制**（规则 5/6）：一个主体动作 + 一个主运镜；保护人物身份/产品结构/Logo/服装/文字/空间连续性；不堆砌「电影感、8K、杰作」（`:103-104`）。
- **声音耦合**（规则 7）：开声音才安排进入时机；关声音则 prompt 不写配音/音乐/音效（`:105`）。
- **@标签保留**（规则 8）：「保留已有 `@图片/@视频/@音频` 标签，少于 2000 字」（`:106`）—— 这是 @语法与提示词工程的唯一耦合点。
- **自检字段**（规则 9）：`validation` 写仍可能影响生成的风险，没有就返回空数组（`:107`）。
- **输出格式**：只返回 JSON（`:108`），schema 全量内联在 `:111`（`reply/title/observation{summary,facts,opportunities,risks,assignments}/intent/subject/performance/camera/timeline[]/visual/audio/constraints[]/questions[]/memory{locked,decisions,avoid,openQuestions}/validation[]/prompt`）。

### 7.3 模板拼装规则（`runDirector`，`:200-247`）

输入消息是**手写的中文分节模板**（`:217-229`）：

```
【创作上下文】
模型：{label}；引擎能力：{detail}；模式：{modeNames[activeTab]}；分辨率：{resolutions.join("/")}；
时长：{duration==="-1" ? "智能时长（由生成模型根据动作、镜头与素材复杂度决定，不要写死总秒数）" : `${duration}秒`}；
画幅：{h3+image ? "跟随首帧" : ratio}；声音：{supportsAudio ? (generateAudio?"开启":"关闭") : "当前模型不支持生成声音"}
素材：{materialSummary || "暂无外部素材"}
导演能力：{skill.title}（{skill.note}）
当前提示词：{currentPrompt.trim() || "尚未填写"}
用户锁定与会话记忆：{JSON.stringify(memory)}
[上次素材观察（素材未变化，可复用）：{JSON.stringify(observation)}]
[上一版方案：{JSON.stringify(previousPlan)}]
[本轮附图顺序：{visualLabels.join("；")}]
[素材读取说明：{packWarnings.join("；")}]

【用户这次的要求】
{userText}
```

要点：① 把**模型能力/时长语义/声音开关**显式翻译成自然语言约束，让 LLM 自己适配；② `memory` 与 `previousPlan` 用 `JSON.stringify` 原样回灌做多轮一致性；③ 历史只取最近 8 条（`:205` `messages.slice(-8)`）；④ 附图顺序必须显式列出，否则模型无法把图片与 @编号对齐（`:225` + 系统提示末句「附图顺序会在用户消息里列出。视频以多个关键帧提供，把它们理解为同一素材的时间采样。」`:113`）。

### 7.4 输出后处理：解析 + 本地校验

- `parsePlan`（`:138-146`）：`text.indexOf("{")` → `lastIndexOf("}")` 截取再 `JSON.parse`；失败时**不报错**，而是把整段文本当 prompt 兜底（`normalizePlan({reply:"方案已经生成；你可以继续告诉我哪里需要调整。", prompt:text})`）。
- `normalizePlan`（`:127-136`）：每个字段都有默认值（如 `camera` 默认「以稳定构图和单一主运镜呈现。」），`questions` 截前 2 条，`prompt` 截 2000 字。**模型不听话也不会崩**。
- `validatePlan`（`:150-159`）是纯本地规则校验，7 条：prompt < 45 字「最终指令偏短」；> 1850 字「接近 2000 字上限」；参考模式有素材但 prompt 不含 `@`「没有明确引用 @素材」；非智能时长下 `timeline.length > max(2, ceil(seconds/3))`「镜头事件偏多」；camera/performance 为空「动作或运镜仍不够明确」；`generateAudio===false` 但 prompt 命中 `/配音|对白|音乐|音效|环境声/`「声音已关闭，但最终指令仍包含声音安排」。最后 `unique()` 去重。
- 模型选择：`callLlmWithFallback("director-v1", {max_tokens:2600, page:"home-director-v2"})`（`:232`）；润色通道用同一模型但 `max_tokens:900`、`page:"home"`（`useHome.ts:1294-1301`）。`lastFallback` 通过 `result.fallbackUsed || /doubao/i.test(result.model)` 判定，UI 显示「备用导演已接管」（`:243`、`:288`）。

### 7.5 轻量润色通道的 `OPTIMIZE_SYSTEM`（`useHome.ts:1248-1257`）

8 条规则，与导演系统同源但更短：保留核心创意不新增人物/剧情/品牌/对白；图生少写静态外观；优先一个主体动作+一个主运镜；按给定时长安排节奏、智能时长不写死秒数；需要时加身份/产品/Logo/服装/文字/空间连续性保护；声音关闭不写声音指令；输出中文 < 2000 字；**只输出提示词，不要解释、标题、前缀或 Markdown**。

### 7.6 素材视觉理解（`directorVision.ts`）

- 指纹：`materialFingerprint` 用 FNV-1a 32 位哈希对 `id|label|mediaType|preview` 拼接串取 `toString(36)`（`:24-35`），作为"素材是否变化"的判据（`AiDirectorPanel.tsx:208`），也是缓存 key。
- 图片：`drawCompressed(..., maxEdge=1280, quality=0.78)` 压成 JPEG dataURL（`:54-67, 80`）；跨域读不到时**降级为把原始 https URL 交给视觉模型**（`:83-86`）。
- 视频：抽 **2 帧**，位置 `duration*0.22` 与 `duration*0.72`（短于 2 秒则取中点），`maxEdge=960, quality=0.72`，label 形如 `「{素材名} · 关键帧1」`（`:97-124`）。
- 预算控制：`visuals` 上限 **6**，视频最多 **2 个**，超出计入 `omitted` 并 warn「为控制分析速度，本轮省略了 N 项素材」（`:141-161`）。
- 音频：**不转写**，直接 warn「{label} 已纳入编排，但当前未做语音转写」（`:133-135`）。
- 每个失败都转成人类可读 warning 而不是抛错：「{label} 无法提取视觉内容，导演将依据名称和文字要求编排」（`:156`）。
- UI 三态 `visionStatus: idle|viewing|ready|limited`，对应标签「尚未分析 / 正在看片 / 已理解 / 部分可读」（`AiDirectorPanel.tsx:256`）。

---

## 8. 视觉与设计系统

### 8.1 色板与 token（`src/index.css:5-54`）

- **暗色唯一主题**：`:root` 与 `.dark` 共用同一套（`:6-7`），`html { color-scheme: dark }`（`:89`）。shadcn 变量全部用 `H S% L%` 三分量 HSL，便于 Tailwind 拼 `hsl(var(--x))`。
- 主色是**荧光黄绿** `--primary: 72 99% 54%`（≈`#D1FE17`），`--primary-foreground: 72 76% 8%`（近黑，保证亮底黑字对比）。`--background: 222 10% 10%`、`--card: 220 10% 15%`、`--muted-foreground: 216 9% 78%`（偏亮的次要文字，暗底可读性优先）。
- 边框是**半透明白**：`--border: 0 0% 100% / 0.14`、`--input` 同值（`:19-20`）—— 这是"玻璃卡片"观感的根源。
- 间距刻度 `--space-1..12`（4→48px，`:31-38`）；圆角 `--radius-sm/md/lg = 10/16/24px` + `--radius-pill: 9999px`（`:39-42`），`tailwind.config.js:70-74` 再派生 `lg/md/sm = var(--radius) / calc(-2px) / calc(-4px)`。
- 阴影三级：`--elev-flat: none`、`--elev-ring: 0 0 0 1px hsl(var(--border))`、`--elev-raised: inset 0 1px 2px rgb(255 255 255 / .07), 0 4px 24px rgb(0 0 0 / .24)`（`:43-45`）。
- 焦点环：`--focus-ring: 0 0 0 2px hsl(var(--background)), 0 0 0 4px rgb(209 254 23 / .75)`（`:46`）—— **双层环（先底色再主色）**，保证在任何背景上都可见。
- 字号/行高刻度 `--text-xs..4xl`（12→72px）、`--leading-body:1.55`、`--leading-tight:1.05`（`:47-55`）。
- 字体四族：`--font-display`(Inter Display + 中文回退)、`--font-body`(Inter)、`--font-brand`(Space Grotesk)、`--font-mono`(IBM Plex Mono)（`:56-59`）。另有 `--cjk-latin-shift: -0.15em` 配合 `.cjk-latin { font-size-adjust: 0.56; vertical-align: var(--cjk-latin-shift) }`（`:60, 138-141`）做中英混排基线对齐 —— 细节度较高。

### 8.2 组件视觉特征（`index.css:144-305` @layer utilities）

| 类 | 特征 | 行 |
|---|---|---|
| `.text-gradient` | `linear-gradient(120deg, foreground 24%, primary 100%)` + `background-clip:text` | 145-151 |
| `.glow-primary` | 1px 主色描边 + 28px 主色光晕 | 153-155 |
| `.cinematic-bg` | 双径向渐变 + 160° 线性渐变，`background-attachment: fixed` | 157-163 |
| `.studio-grid` | `::before` 固定 48px 网格线（opacity .32 + 向下 mask 淡出），`::after` 两个大半径径向光斑（主色 + 蓝紫） | 165-194 |
| `.panel-glass` | 半透明渐变底 + `backdrop-filter: blur(16px)` + 内高光 + 64px 大阴影 | 196-202 |
| `.hairline-top` | `::before` 顶部 1px 主色渐变发光线（左右透明） | 204-214 |
| `.surface-premium` | 三层：顶部白色渐隐高光 + 145° 深灰渐变 + `inset 0 1px` 高光 / `0 1px 0` 暗线 / `0 24px 80px` 大投影 | 216-225 |
| `.surface-interactive:hover` | `translateY(-2px)` + 主色边框 + 更大投影（220ms `cubic-bezier(.2,.8,.2,1)`） | 227-235 |
| `.eyebrow` | 10px 等宽大写 + `.18em` 字距 + `::before` 一条 1.25rem 发光线 | 237-255 |
| `.button-primary` | `linear-gradient(135deg, #E0FF47, #B4F000)` + `::after` 105° 白光扫过（hover 时 `translateX(-100%→100%)`, 600ms） | 257-277 |
| `.status-pulse` | `::after` 主色描边环 + `status-ping` 2.2s 无限扩散（`scale(.72)→1.75`, opacity `.8→0`） | 279-290, 301-304 |
| `.content-auto` | `content-visibility:auto` + `contain-intrinsic-size:360px` | 292-295 |
| `.mask-fade-x` | 左右 4% 渐隐 mask（横向滚动列表用） | 297-299 |

**动效与可访问性**：`button,a,input,textarea,select` 统一 `transition 180ms cubic-bezier(.2,.8,.2,1)`（`:99-104`）；`:focus-visible { outline:none; box-shadow: var(--focus-ring) }`（`:118-121`）；`::selection` 用主色（`:123-126`）；自定义 10px 滚动条，hover 变主色（`:128-139`）；`@media (prefers-reduced-motion: reduce)` 全局把 animation/transition 压到 `0.01ms`（`:307-316`），并在 ≤640px 把网格 opacity 降到 `.22`、尺寸降到 32px（`:318-322`）。

**进度/时间轴反馈**：`TaskPanel` 每个 job 的进度条按 `elapsed / expectedSec` 估算，`Math.min(96, ...)` 封顶避免"假 100%"（`TaskPanel.tsx:17`），条上有 `shadow-[0_0_12px_rgba(209,254,23,.45)]` 发光（`:22`）；导演方案的 `timeline` 用左侧主色竖线逐条排列（`AiDirectorPanel.tsx:283`）。

---

## 9. 工程实现技巧

1. **请求层：分层重试策略**。submit 3 次 × 1.5s 固定退避，仅对 5xx/网络错（`aigc.ts:605-650`）；poll 间隔 `2500→5000ms` 线性递增（`:498-499`）；LLM 首呼 25s 超时（`llm.ts:41`），失败后转 poll 模式 `3000ms × 200 次`（`:42-43, 179-191`）。而**后端** `lib/agnes.js` 用的是指数退避 + 抖动：`Math.min(60000, baseMs * 2**attempt) + random(0..1500)`（我们的 `lib/agnes.js:341-365`，见 §10）。
2. **取消**：每个 job 独立 `AbortController`，按 jobId 存 ref，`cancelJob` 直接 `abort()` + 移除（`useHome.ts:451, 473-476`）；每个 async 分支在 await 之后都重新校验 `if (!jobControllersRef.current[jobId]) return`（`:1032, 1078, 1093, 1159, 1180`）—— 防止"已取消的任务回来后覆盖 UI"。
3. **幂等与去重**：三处独立机制 —— ① `resumedJobIdsRef` 防同任务重复续跑（`:965`）；② `jobs.some(j=>j.serverTaskId===it.jobId)` 防"正常流程 + 续跑流程"双跑（`:966`）；③ `saveToGallery` 用 `task_id` 与 `result_url.trim()` 双键查 `galleryRef.current` + 两个在途 `Set`（`:587-594`），且 `setGallery` 的 updater 里**再查一次**（`:608`）。
4. **乐观更新 + 回滚**：`updateGalleryItem` 与 `deleteGalleryItem` 先改本地 state 与 `galleryRef`，失败时用 `previous` 快照恢复，并给中文提示「作品信息保存失败，已恢复修改前的状态。」/「删除作品失败，作品已恢复。」（`:654-710`）。
5. **错误文案映射**：`AIGC_ERROR_MESSAGES_ZH` 8 条枚举 → 中文（`aigc.ts:148-157`）；`AIGC_ERROR_PLACEHOLDER_VALUES` 过滤内部占位串，避免「生成失败: task_failed」这种自我重复（`:160-161`）；`formatAigcFailureMessage` 默认把 RH 真实原因拼在中文后面，源码注释明确批评"自己写 errorKind 白名单挑着拼"会把真实报错（如"音频时长过短"）吞掉（`:163-171`）。
6. **上传并发控制**：`uploadAigcMediaFiles` 逐个 `setTimeout(i*300)` 错峰，单个失败被过滤而非整批失败（`aigc.ts:957-976`）。上传前图片统一 `compressImage` 到 maxEdge 1280 / JPEG 0.85，失败回落原文件（`useHome.ts:876-912`）；视频先读 `duration`，> 15s 直接拒绝并给可操作文案「视频时长 N 秒超过限制（最多 15 秒），请先裁剪后再上传」（`:937-951`）。
7. **缓存**：`WeakMap<File, Promise<string>>` 复用上传（`useHome.ts:244-258`，失败时 `delete` 允许重试）；`packCache` 复用素材视觉包（`directorVision.ts:164-172`）；`legacyLlmRoutes` / `legacyLlmRoutes===null` 只探测一次后端路由代际（`llm.ts:52, 137-152`）。
8. **表单校验**：集中在 `executeGenerate`，逐模式给**可操作**的中文错误（不是"参数错误"）：`请输入视频描述` / `请上传首帧图片` / `MiniMax H3 图片生视频需要填写镜头提示词` / `参考生视频需要填写镜头提示词，可使用 @ 精确引用素材`（`useHome.ts:1220, 1226-1227, 1235`）。另有一层"跨字段自动纠偏"：切档位时收敛分辨率/时长/画幅而不是报错（`:300-313`）；`DirectorControls.tsx:106-110` 在时长越界时自动钳制。
9. **a11y**：`CostConfirmDialog` 有 `role="dialog"` + `aria-modal`（`:29-30`）；点赞/收藏按钮有 `aria-label={liked ? "取消点赞" : "点赞"}`（`WorkGrid.tsx:36`）；评分组件 `aria-label` 为 `${value} 星作品` / `设为 N 星`（`WorkLibrary.tsx:39, 41`）；素材删除 `aria-label="移除素材"`（`MediaRail.tsx:55`）；`onFocus` 也触发视频预览（`WorkGrid.tsx:18`），键盘可达。**缺口**：Sheet 与 PreviewLightbox 未见 `aria-label`，`AtMentionTextarea` 下拉**无 `role="listbox"`、无方向键导航**（只有 Escape，`AtMentionTextarea.tsx:110-112`）。
10. **可观测性**：真实扣费 `usage` 全链路透传（RH 终态 → PB `aigc_tasks` 四列 → `AigcHistoryItem` → `VideoStage` 显示「实际扣费 ¥x」，`VideoStage.tsx:49`）；每个 job 记 `startedAt` 并在 `VideoStage`/`TaskPanel` 显示 `Ns` 耗时（`useHome.ts:447, 956-959`）；`VideoStage` 的 taskId 可一键复制（`VideoStage.tsx:11-14, 23-25`）。
11. **契约化工程约束**：把"计费确认"和"LLM 路由代际"这类跨版本约定写成带长注释的单一入口（`costConfirm.ts:1-10`、`useCostConfirm.ts:1-31`、`llm.ts:45-51`），并在注释里写明"新代码不要 X"。

---

## 10. 可借鉴点 → 我们的具体落点

> 每条格式：**他们的做法（证据）→ 我们现状（重新读码确认的证据）→ 具体改造建议（文件/模块，改动量，风险）**。
> **基线校正**：`docs/research/ui-our-baseline.md:51` 记 videos 页「SSE订阅 ○」，但当前 `public/js/pages/videos.js:409-414` **已有** `onEvent('video', ...)` + 700ms 防抖重拉。以下"现状"以代码为准。

### 10.1 价格预估 + 扣费确认（最高价值，我们完全没有）

- **他们**：三层降级预估（上游 `price-preview` → 可信度判定 → 本地单价表兜底，`useHome.ts:397-432`、`aigc.ts:981-1015`）+ 提交前弹窗确认，且确认票据当天可免打扰（`costConfirm.ts:16-38`、`CostConfirmDialog.tsx:27-73`）。**关键设计**：预估失败绝不阻塞生成（`aigc.ts:997` 注释），且 `estimatedPrice=0` 不等于免费（`useHome.ts:399-400`）。
- **我们现状**：**无**。全仓 `grep -rn "价格\|费用\|预估\|price\|cost" public/js lib server.js` 只命中 3 处注释（`lib/routes.js:528/1025`、`lib/agnes.js:337`），无任何预估/确认代码；`videos.js:259-345` 的 `submit()` 校验后直接提交。用户点「创建视频任务」即扣费，事前零提示。
- **建议**：① 后端新增 `POST /api/videos/estimate`（`lib/routes.js`，按 `model_name × resolution × duration` 查一张静态价目表返回 `{ok, priceText}`，我们已有 `state.models` 目录可挂价目），② 前端在 `public/js/pages/videos.js:259` 的 `submit()` 前 `await confirm({...})`，用现成的 `checkbox` 选项实现"今天不再提醒"（`public/js/ui.js:194-198, 203-205` 已支持 `{confirmed, checked}` 返回值），文案「预计 ¥X，实际以 Agnes 账单为准」；③ 票据存 `localStorage['agnes.cost_confirmed_today']`（我们已有 localStorage 用法范式，`public/js/pages/assets.js:13-15`）。
- **量/风险**：**M**。风险：① 价目表会过期，UI 必须标注"预估"；② `confirm()` 本身**取消路径是安全的**（`ui.js:208 onDismiss` + `:219-223` MutationObserver 双保险，都会 resolve 取消值，`done` 标志防二次 resolve），所以计费确认不会"静默永挂" —— 这点比 `ui-our-baseline.md:30` 对 `modal()` 的描述要好，无需先补守卫；③ 真正的风险是**批量提交**（`lib/routes.js:1012` `/api/batch/videos`）也要各自确认，否则批量入口绕过票据。

### 10.2 上游真实扣费落库 + 展示

- **他们**：RH 终态 `usage` 全按**字符串**落库（`aigc.pb.js:203-206`、`aigc.ts:50-58` 明确禁止 `parseFloat` 再格式化），并在结果区显示「实际扣费 ¥x」与耗时（`VideoStage.tsx:48-49`）。
- **我们现状**：`lib/agnes.js:391-430 buildSafeStatusUpdate` 只提取 `video_url/progress/status`，**没有** cost 字段；`lib/routes.js:614-645` 落库的 `video_assets` 也无金额列；任务页 `public/js/pages/tasks.js:198` 只有收藏按钮。
- **建议**：`lib/agnes.js` 的 `buildSafeStatusUpdate` 增补 `cost`（Agnes 若返回则原样字符串透传，否则留空）；`lib/store.js` 的 `video_assets` 集合加 `cost` 字段（`store.js` 是 schema-less JSON，零迁移成本）；`public/js/pages/tasks.js` 的任务行 + `videos.js` 的最近任务行显示金额。
- **量/风险**：**S**（前提：Agnes 查询响应确实带费用字段 —— **未确认**，需先抓一次真实终态响应核对；若不带则本项降级为 P2）。

### 10.3 提交前的"三重防重"幂等

- **他们**：`resumedJobIdsRef` + `jobs.some(serverTaskId===)` + `saveToGallery` 双键去重 + 在途 `Set`（`useHome.ts:587-594, 964-967`），并有源码注释解释每一次去重防的是哪条重复路径。
- **我们现状**：`lib/poller.js:159-166 watch()` 有 `if (timers.has(assetId)) return`（单机防重入，✅ 已有）；但 `lib/routes.js:517-660` 的 `POST /api/videos` **没有请求级幂等键** —— 用户连点两次「创建视频任务」= 两条真实计费任务。现有防线只有前端 `videos.js:260 if (submitting) return`（页面级布尔锁）和 `setBusy` 禁用按钮（`:304`）。
- **建议**：`public/js/pages/videos.js` 提交时生成 `client_token`（`crypto.randomUUID()`）随 payload 发；`lib/routes.js` 的 `POST /api/videos` 在写库前按 `client_token` 查最近 N 分钟内的 `video_assets`，命中则直接返回既有 asset。我们已有 `store.list('video_assets', {filter})` 能力（`lib/store.js:166`）。
- **量/风险**：**M**。风险：`store.list` 是内存数组过滤，任务量大时需加时间窗索引；`client_token` 需加进 `video_assets` 的字段白名单。

### 10.4 素材"职责"结构化 + @ 提及输入框

- **他们**：`MentionImage[]` 候选按类型独立编号（`DirectorControls.tsx:73-81`）、`@` 触发 token 识别（`AtMentionTextarea.tsx:37-58`）、插入时替换到光标前最后一个 `@` 并**补尾随空格**做 token 终止符（`:69`）、下拉带缩略图与类型中文（`:140-171`）。
- **我们现状**：**部分有**。`public/js/consts.js:113 IMAGE_ROLES = ['角色参考','场景参考','风格参考','起始画面','目标画面','道具参考']`，`videos.js:243` 多图模式每张图配一个 `<select data-mr>` 选角色、`:250-251` 绑定回 `S.multi.imgs[i].role` —— **有职责，但无 @ 引用语法**；`videos.js` 的提示词是纯 textarea（`:158/180/203/218`），用户无法在文本里指代"第 2 张图"。全仓 `grep -rn "mention\|提及"` **零命中**。
- **建议**：分两步。① **S**：`videos.js` 的 `renderMi()`（`:236-255`）给每张图加 `@图片N` 标签 chip，点击复制到剪贴板（我们已有 `copyText`，`public/js/consts.js` 导出、`images.js:296` 在用）。② **M**：新增 `public/js/mention.js` 复刻 token 识别 + 下拉，`videos.js` 的 textarea 换成包装元素；候选由 `S.multi.imgs` 映射。
- **量/风险**：② **M**。风险：我们无构建、无 React，需手写 DOM 插入与光标恢复（`selectionStart` + `setSelectionRange`），**必须同时处理 `input`/`keydown`/失焦/点击外部**四类事件，比 React 版更易出边界 bug。另注意他们的实现**有真实缺口**（§4.2：删中间素材会导致编号错位）—— 我们落地时应额外维护 `@图片N → 素材 id` 的显式映射，别照抄。

### 10.5 导演 Agent 的"结构化 JSON + 本地校验"模式

- **他们**：`DIRECTOR_SYSTEM` 强制输出固定 JSON schema（`AiDirectorPanel.tsx:96-113`），前端 `parsePlan` 容错 + `normalizePlan` 逐字段默认值（`:127-146`），再用 `validatePlan` 做 7 条纯本地规则校验（`:150-159`），校验结果在 UI 上显示成「生成前检查」清单（`:289`）。
- **我们现状**：**部分有**。`public/js/pages/scripts.js:3` 头注释写「提示词全部来自「提示词模板」（设置页可改）」，`:158` 用 `json_mode: true` 走约束解码；模板 CRUD 在 `public/js/pages/settings.js:252-282`，`lib/routes.js:793/802/816/827` 有 4 个模板端点（GET/POST/PUT/DELETE）。**但**：脚本生成没有"输出后本地校验 + 风险清单"这一层，也没有"解析失败降级为纯文本"的兜底。
- **建议**：① 在 `public/js/pages/scripts.js` 的生成回调后加一个 `validateScriptDraft()` 纯函数（检查：必填字段非空、镜头数 vs 时长是否匹配、角色名是否与项目角色表一致），把结果渲染成 `note` 组件（我们已有 4 色 note：`public/css/app.css:716-726` 的 `.note` / `.gold` / `.red` / `.orange` / `.green`）。② 在 `lib/agnes.js` 的 `chat()` 调用处包一层 `parseJsonLoose()`（截首个 `{` 到末个 `}`），失败时降级为纯文本 + 警告，而不是抛错。
- **量/风险**：**M**。风险：我们脚本模板是用户可改的，校验规则不能硬编码字段名 —— 需从模板的 `notes` 或新增 `schema` 字段推导，否则改模板就误报。

### 10.6 断点恢复时"参数丢失"的正面处理

- **他们**：承认恢复路径丢参数（`useHome.ts:1005` 注释），于是把恢复出的条目降级为"仅回填提示词"而不是假装完整；另有 `reconcileGallery` 在登录/历史变化时**自动补录**漏存的成功记录（`:623-652`）。
- **我们现状**：`lib/poller.js:169-173 resume()` 在服务启动时把未完成任务捡回来（✅ 这一层我们做得比他们好 —— 轮询在服务端，关浏览器不断）；`public/js/pages/storyboards.js:97-114` 用 `localStorage[BKEY]` 存 `jobId`，服务重启后 404 就 `removeItem` 不骚扰用户（✅ 也有）。**但**：`lib/routes.js:735-745 batch-refresh` 只针对"已完成但缺 video_url"的记录，**没有**"服务重启后把历史成功任务补写进作品/素材库"的机制（我们也没有独立 gallery，成功视频就是 `video_assets` 行，所以这一项我们天然不缺）。
- **建议**：这一条我们**已基本对齐**，仅建议一处：`public/js/pages/storyboards.js:106-109` 目前拿 `saved` jobId 只做恢复；可加"若后端已无此 job 但 `video_assets` 里有同期成功记录，则提示用户去任务页查看"的软引导（复用 `ui.js` 的 `empty()` action 插槽 —— 该插槽**实际已存在**（`ui.js:276-279`，形状 `{go,label}`），无需先补，仅 `ui-our-baseline.md:33` 的记载过期）。
- **量/风险**：**S**（但依赖先补 `empty()` 的 action 插槽，那一步本身 **S**、风险低）。

### 10.7 上传错峰 + 压缩 + 前置时长校验

- **他们**：`uploadAigcMediaFiles` 每文件错峰 300ms、失败项过滤不连坐（`aigc.ts:957-976`）；图片上传前 `compressImage`（1280/0.85）失败回落原文件（`useHome.ts:876-912`）；视频 > 15s 前置拒绝并给可操作文案（`:937-951`）。
- **我们现状**：`public/js/pages/videos.js` 的图生/多图模式**要求用户手填公网 URL**（`:169-170`「参考图片（公网可访问 URL）」、`:198`「参考图片（2-8 张）」+ `:243` 每行一个 URL input），连上传都没有 —— 提示文案「图生视频需要 Agnes 能抓到的公网图片。本地图片请先上传公网图床。」（`:175`）。`public/js/pages/images.js:55-58` 图生图同样要求手填 URL 或选 `remote_url`。也就是说我们**把"上传"这个动作整个推给了用户**。
- **建议**：这是比"错峰"更前置的问题。若接入上传，建议：① 后端加 `POST /api/uploads`（`lib/routes.js`）落盘到 `store.imagesDir()` 并回传本机可访问 URL；② 前端 `videos.js` 的多图行从"URL input"升级为"URL input + 拖拽/选择文件"，复用 `MediaRail` 式的预览缩略图思路；③ 上传前用 `canvas` 压缩（前端 1280/0.85）+ 视频 `loadedmetadata` 读时长前置校验，代码结构可直接照 `useHome.ts:876-951` 的两段函数改写为 vanilla JS。
- **量/风险**：**L**。风险：**Agnes 必须能抓到图** —— 若本机服务只在 `127.0.0.1:5178`，外网 Agnes 抓不到本地 URL，这条路在"本地优先"约束下可能根本走不通（需公网可达或图床）。**建议先只做前端压缩 + 时长校验（S），上传通路另立项评估**。

### 10.8 错误文案"不吞真实原因"

- **他们**：`formatAigcFailureMessage` 默认把上游原始错误拼在本地化文案后，注释直接点名批评"自己写 errorKind 白名单挑着拼"会吞掉真实原因（`aigc.ts:163-171`）；`content_audit` 单独归类以显示"换个表达试试"（`:556-563`）。
- **我们现状**：`public/js/api.js:18-26` 统一收敛成 `{ok, error}`，`error` 优先取 `data.error`（保留后端原文 ✅）；`lib/agnes.js:71-82 isTransientError` 也按文案识别瞬时错。但**前端没有"分类 → 中文文案 + 保留原文"的映射层** —— `videos.js:300-345` 失败时直接 `toast.err(r.error)` 或把 `error` 原样塞进诊断面板（`:363`）。后端 `lib/routes.js` 的错误消息多为中文直写（如 `:691`「本地未保存 video_id…」），**本身质量高**，所以问题不大。
- **建议**：低优先。可在 `public/js/pages/videos.js` 的 `showDiag()` 里对 `error` 做一次关键词分类（`余额/点数/积分` → 引导充值；`内容安全/审核` → 建议换措辞；`超时` → 提示稍后重试并给"前往镜头任务"按钮），把当前 `note red` 单一展示拆成"分类标题 + 原文详情"两行。我们已有 `note` 4 色（`app.css`）与 `icon()` 可用。
- **量/风险**：**S**。风险：关键词表易随 Agnes 文案变化而过期，应写成常量表并加注释。

### 10.9 焦点环"双层"设计

- **他们**：`--focus-ring: 0 0 0 2px hsl(var(--background)), 0 0 0 4px rgb(209 254 23 / .75)`（`index.css:46`）—— 内层底色、外层主色，任何背景下都可见。
- **我们现状**：`public/css/app.css:30 --focus-ring: 0 0 0 3px rgba(245, 213, 138, 0.24)`，是**单层半透明金色**；且存在两层焦点规则：`:779-785` 用 `outline: 2px solid rgba(245,213,138,.6)`，`:951-955`（B1.3）用 `outline: 1px solid rgba(245,213,138,.72) + box-shadow: var(--focus-ring)`。后者覆盖前者。
- **建议**：把 `public/css/app.css:30` 改成双层：`--focus-ring: 0 0 0 2px var(--bg), 0 0 0 4px rgba(245, 213, 138, 0.75)`，并统一 `:779` 与 `:951` 两处规则为一处（保留 outline 兜底给高对比模式，注释说明）。
- **量/风险**：**S**。风险：极低，但需跑一次 `node tools/ui-audit.mjs` 确认对比度报表无回归。

### 10.10 `content-visibility` 长列表节流

- **他们**：`.content-auto { content-visibility: auto; contain-intrinsic-size: 360px }`（`index.css:292-295`），用在作品库/广场卡片（`WorkGrid.tsx:17`、`WorkLibrary.tsx:61`）。
- **我们现状**：**无**。全仓 `grep -rn "content-visibility\|contain-intrinsic" public/css public/js` 零命中。`public/js/pages/assets.js` 与 `tasks.js` 都渲染长列表。
- **建议**：在 `public/css/app.css` 加 `.content-auto` 工具类，挂到 `public/js/pages/assets.js` 的 `.asset-card` 与 `public/js/pages/tasks.js` 的任务行上。注意 `contain-intrinsic-size` 要设成接近真实卡片高度，否则滚动条会跳。
- **量/风险**：**S**。风险：`content-visibility` 会让屏外元素不参与布局，若卡片高度差异大，滚动位置会跳动 —— 建议先在 assets 页单点验证。

### 10.11 中英混排基线对齐

- **他们**：`--cjk-latin-shift: -0.15em` + `.cjk-latin { font-size-adjust: 0.56; vertical-align: var(--cjk-latin-shift) }`（`index.css:60, 138-141`），把等宽英文数字在中文行内的视觉基线拉齐。
- **我们现状**：**无**。`public/css/app.css` 有 `--mono` 字体变量（`:59`）与大量 `.mono-sm`/`.mono` 用法（如 `videos.js:398` `esc(v.num_frames)}帧 · ${esc(v.frame_rate)}fps`），但无 `font-size-adjust` 或 `vertical-align` 校正。
- **建议**：在 `public/css/app.css` 加 `.cjk-latin` 类与变量，挂到 `videos.js` 任务行、`tasks.js` 的 `.mono-sm` 混排文本上。
- **量/风险**：**S**。风险：`font-size-adjust` 在旧 Safari 上不支持（会静默忽略，无副作用），可接受。

### 10.12 `prefers-reduced-motion` 兜底

- **他们**：全局 `*` 把 animation/transition 压到 `0.01ms`（`index.css:307-316`），另有移动端网格降噪（`:318-322`）。
- **我们现状**：**已有**，且分两处：`public/css/app.css:788-790`（全局 `animation-duration/transition-duration: 0.01ms !important`）与 `:973-975`（B1.5 把网格级联 `animation-delay` 归零）、`:988`（侧栏过渡关闭）。
- **建议**：**已对齐，无需改造**。唯一小项：`:788` 与 `:973` 两条 reduce 块可合并，减少维护面。
- **量/风险**：**S**（纯整理，可选）。

### 10.13 空态带 CTA 直达

- **他们**：几乎每个空态都给"下一步去哪"——`TaskPanel` 空态「队列当前为空 / 提交后可继续创建下一条镜头」（`TaskPanel.tsx:14`）、`VideoStage` 空态「等待第一个镜头 / 设置素材与导演参数后，成片会自动出现在这里」（`VideoStage.tsx:41`）、`WorkLibrary` 空态。且 `videos.js` 的提交成功诊断面板直接给「前往镜头任务」按钮（`videos.js:369`）。
- **我们现状**：`public/js/ui.js:276-279` 的 `empty(title, desc, iconName, action)` **已支持第 4 个 action 参数**，但形状是 `{go, label}` 且渲染成 `<a href>`（**不是回调**）—— 与 `ui-our-baseline.md:33` 记的"无 action/CTA 插槽"**不一致，该文已过期**；而 `videos.js:387` 的调用只传 3 个参数：`empty('还没有视频任务', '选一个模式，填提示词提交', 'video')`。
- **建议**：把 `videos.js:387` 改为传 `{go: '#/assets', label: '去素材库复制图片链接'}`，`images.js`/`tasks.js`/`assets.js` 的空态同样补 action。零新增 API。若需要 `navigate()` 回调而非 href，再单独给 `empty()` 加一个 `onClick` 分支（**S**）。
- **量/风险**：**S**。风险：无。

### 10.14 常量化的"错峰/退避"参数集中管理

- **他们**：`POLL_INTERVAL_MS` / `POLL_TIMEOUT_MS` / `H3_OSS_PRICE_PER_SECOND` / `PRICE_DISCOUNT` / `CHAT_ABORT_MS` / `POLL_ATTEMPTS` / `RESUME_MAX_AGE_MS` 全部具名常量 + 注释解释取值理由（`useSeedance25Logic.ts:16-18`、`useHome.ts:112, 148, 519`、`llm.ts:41-43`）。
- **我们现状**：**部分有**。`lib/poller.js:45-52 intervalMs()/maxPolls()` 从 settings 读（✅ 可调，比他们硬编码更好）；`lib/agnes.js:302 request_timeout_ms`、`:344 video_submit_backoff_s` 也从 settings 读（✅）。但 `public/js/pages/videos.js:412 liveTmr = setTimeout(..., 700)` 的 700ms 防抖、`lib/agnes.js:356` 的 `60000` 退避上限与 `random()*1500` 抖动幅度都是魔法数字。
- **建议**：把前端防抖与后端退避上限提成具名常量并加注释。`lib/agnes.js:341-365 createVideo` 的退避实现本身**已优于对方**（指数 + 抖动 vs 他们的固定 1.5s），保留即可。
- **量/风险**：**S**。风险：无。

---

## 11. 不值得借鉴 / 边界

1. **整套技术栈不可迁移**。React 19 + Vite 8 + TypeScript 6 + 86 个 ts/tsx + 47 个 shadcn 组件 + 40+ npm 依赖（`package.json`）与我们「零 npm 依赖、Node 原生后端、vanilla JS ESM、无构建」的硬约束正面冲突。**能借的只有设计决策与交互模式，不是代码**。任何"把 `useHome.ts` 搬过来"的想法都不可行 —— 1474 行 React hook 的等价 vanilla 实现会是另一种结构（我们 `videos.js` 用模块内闭包变量 `S`/`mode` 做状态，`videos.js:24-38`，这已是我们自己的正确范式）。
2. **Tailwind + CSS-in-class 的类名体系不适用**。他们的视觉全靠在 JSX 里堆长 utility class（如 `DirectorControls.tsx:133` 单行 400+ 字符），我们 `public/css/app.css` 是手写语义类（`.card`/`.btn`/`.segmented`/`.note`）。**只借 token 值（色板/圆角/焦点环）与具体 CSS 片段，不引入 utility 框架**。
3. **PocketBase 后端与 `pb_hooks` 不适用**。他们是 PB 集合 + JS hook + `$app`/`$http` 全局，我们是 `server.js` + `lib/routes.js` 手写路由 + `data/*.json`。`aigc.pb.js` 的 1228 行**不能复用**，但它证明了两件可借的事：① API Key 只存服务端（我们 `lib/agnes.js:1-20` 头注释已同样声明 ✅）；② 计费票据头需要透传（`aigc.pb.js:449-462`）—— 我们直连 Agnes 无此概念。
4. **登录/账号体系（`rhLogin.ts` 613 行）不适用**。RunningHub SSO、JWT 解码、`X-Vibex-Scoped-Token`、邀请码、充值窗口（`rhLogin.ts:365-612`）全部是 Vibex 平台能力，我们本地优先、无账号体系。**但"登录态过期 → 横幅 + 一键重登"这个交互模式**（`HomePage.tsx:18-25`）值得用于我们的 API Key 失效场景 —— 我们已有 `/api/settings/test`（`lib/routes.js`）可复用为探测入口。
5. **作品广场 / 点赞收藏分享不适用**。`video_gallery` + `plaza_likes.pb.js` + `plaza_favorites.pb.js` 是**多用户社交**能力，与我们单机本地优先矛盾。我们的 `video_assets` + `is_favorited`（`public/js/pages/tasks.js:198`、`assets.js:88`）已覆盖"收藏"这一子集。
6. **Canvas 视觉抽取（`directorVision.ts`）性价比存疑**。抽视频帧 + 压图 + 上传视觉模型，每轮消耗 token 且最多 6 图（`:141-161`）；音频明确不转写（`:133-135`）。我们要做类似能力，更符合本地优先的路子是**用 Agnes 的多模态文本模型直接吃本机文件**，而不是走"浏览器 Canvas → dataURL → 上传"。**不建议照搬 dataURL 上传路径**（体积大、且我们的图片本来就已在本地磁盘）。
7. **`useSeedance25Logic.ts` 这类孤儿文件本身就是反面教材**。231 行、含完整状态机与注释，但**零引用**（§1 校正）。任何我们仓库里的"未来可能用到"的模块都该删掉而不是留着 —— 它会让后续研读者（包括 AI Agent）把死代码当生产路径。建议我们在 `AGENTS.md` 的"已知边界"里加一条：新增页面模块必须同时接进 `public/js/app.js` 路由表，否则不予合入。
8. **`AtMentionTextarea` 的 `@图片N` 隐式编号协议**。§4.2/§4.3 已证：编号靠数组顺序隐式对齐、删中间素材即错位、服务端不认识该语法、`<Picture N>` 在本包中根本不存在。**我们若要做 @ 引用，必须维护显式的 `token → 素材 id` 映射表并在增删素材时重写 prompt**，而不是照抄"按出现顺序数数"。
9. **硬编码折扣展示**。`PRICE_DISCOUNT = 0.75` 是纯展示层常量（`useHome.ts:148`），与真实扣费无关联（`DirectorControls.tsx:229` 文案也自认"实际扣费以账单为准"）。这种"UI 上算一个价、后端扣另一个价"的做法**在用户信任层面是负债**，我们不应引入 —— 若做预估，只显示单一数字 + "以账单为准"。
10. **`estimatedPrice=0` 的语义模糊**。他们不得不为"0 到底是免费还是未知"写专门的判定（`useHome.ts:399-403`）并准备降级文案。我们若做预估，应在自己的接口契约里就把 `null`（未知）与 `0`（免费）分开，别继承这个歧义。

---

## 附：本报告关键统计可复现命令

```bash
SRC="/Users/apple/Project/Git/Webeye-Video/docs/AI创作资料/08-AI创作项目源码/seedance2.5-75-remix-42c8350f-Seedance2.5导演台"
cd "$SRC"
find src -name '*.ts' -o -name '*.tsx' | wc -l        # 86
grep -c '<Route' src/App.tsx                          # 3
grep -n 'routerAdd(' pocketbase/pb_hooks/aigc.pb.js   # 9 个后端路由
grep -rn "useSeedance25Logic" src                     # 仅命中定义处 → 孤儿文件
grep -rn "Picture" .                                  # 0 命中 → <Picture N> 不在本包
grep -rn "vibex_cost_confirmed_today\|director-v3:" src   # 两处本地存储键

cd /Users/apple/Project/Git/agnes-manga-studio
grep -rn "价格\|费用\|预估\|price\|cost" public/js lib server.js   # 仅 3 处注释 → 我们无价格能力
grep -rn "mention\|提及" public/js lib                              # 0 命中 → 我们无 @ 提及
grep -n "onEvent('video'" public/js/pages/videos.js                 # :409 已有 SSE（基线文档已过期）
grep -n "empty(title" public/js/ui.js                               # :276 已有 action 插槽（基线文档已过期）
```

*（完 —— 本报告为纯研读，未修改源码包中任何文件；对本仓库仅新增本文件。）*
