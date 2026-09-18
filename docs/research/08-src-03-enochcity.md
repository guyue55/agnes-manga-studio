# 研读报告：以诺城AI漫剧平台（Vibex 导出源码包 `ai-remix-6f5c2140`）

> **研读对象**：`/Users/apple/Project/Git/Webeye-Video/docs/AI创作资料/08-AI创作项目源码/ai-remix-6f5c2140-以诺城AI漫剧平台/`（**只读**，未改动其中任何文件）
> **对照项目（下文简称「我们」）**：`/Users/apple/Project/Git/agnes-manga-studio/`（本地优先、零 npm 依赖 Node 原生后端 + `public/` vanilla JS ESM 前端，无构建）
> **口径**：全部结论来自逐文件读码 + grep 统计，标注 `相对路径:行号`。文中路径若不写前缀，均相对上述源码包根目录；「我们」的证据写全 `public/...` / `lib/...`。不确定的一律标「未确认」。
> **导出包性质提示**：`vibex-local/export-manifest.json` 记录 `"includes_pb_data": false`，且 `removed_sensitive_files` 移除了 `templates/pb_hooks`。因此**平台注入的 `llm.pb.js` / `aigc.pb.js` 真实运行副本不在包内**，只有脚手架模板副本 `templates/scaffold/templates/pb_hooks/*.js`（模板变量 `{{LLM_ALLOWED_MODELS}}` / `{{AIGC_ALLOWED_MODELS}}` 未渲染）。本文凡引用这两个文件处均已显式标注为「模板」。

---

## 1. 一句话定位与技术栈

**一句话定位**：一个「门户首页 + 留言板 + 公开作品库 + 作品管理后台 + 接口连通性自测」五页的 AI 漫剧平台**展示型官网**——营销首页把用户导流到外部站点 `http://enochcityai.hongfudesign.com`（`src/components/home/HeroSection.tsx:3`），站内真正有数据读写的只有留言板（`messages`）与作品库（`works`）两张 PocketBase 表。

| 项 | 事实 | 证据 |
|---|---|---|
| 路由数 | 5 条业务路由 + 1 条通配重定向（`*` → `/board`），共 6 个 `<Route>` | `src/App.tsx:24-31` |
| 页面数 | 5 个页面目录：Home / Board / Works / AdminWorks / ApiTest，各含 `index.tsx` + `XxxPage.tsx`（+ 3 个 `use*.ts`） | `src/pages/*/`（14 个文件） |
| ts/tsx 文件数 | `src/` 共 **69** 个（56 `.tsx` + 13 `.ts`），其中 `components/` 44、`pages/` 14；`src/` 合计 **5806 行** | `find src -name "*.ts" -o -name "*.tsx" \| wc -l` |
| 状态管理 | **无第三方 store**（无 redux/zustand/jotai）。全局仅有 `sonner` 的 `<Toaster>`；页面状态一律「自定义 hook + `useState`/`useEffect`」，页面组件通过 `p: ReturnType<typeof useXxx>` 接收整个 view-model | `src/App.tsx:12-23`；`src/pages/Works/index.tsx:5-6`；`src/pages/Board/BoardPage.tsx:9` |
| UI 库 | shadcn/ui 风格自持组件（Radix Primitives + `class-variance-authority` + `clsx` + `tailwind-merge`），`src/components/ui/` 共 **14** 个原子组件；图标 `lucide-react`；动效 `tailwindcss-animate` | `src/components/ui/`（alert-dialog/badge/button/card/dialog/input/label/scroll-area/select/skeleton/switch/tabs/textarea/tooltip）；`package.json` dependencies |
| 后端接入方式 | **PocketBase**（`pocketbase@^0.27.0` SDK）。浏览器侧不直连 PB，而是走同源子路径代理 `getPocketBaseUrl()` → `<vibex-prefix>/__pb`，本地 dev 回退 `/__pb` | `src/lib/pb.ts:7-17,26`；`vibex-local/vite.local.config.ts:16-21`（`/__pb` → `127.0.0.1:7000`） |
| 后端业务逻辑 | 用 **PocketBase JSVM（Goja）hook** 写在 `pocketbase/pb_hooks/*.pb.js` 里，`routerAdd` 注册自研 REST 路由（非 PB 默认 `/api/collections/*`） | `pocketbase/pb_hooks/works.pb.js:65`、`messages.pb.js:57`、`heibao.pb.js:4` |
| AI 能力接入 | 走平台注入的 `/api/llm/*`（RunningHub LLM 中转）与 `/api/aigc/*`（RunningHub AIGC 标准模型中转）；前端有完整 lib（`llm.ts` / `aigc.ts`），但**本 app 页面几乎未调用** | `src/lib/llm.ts:53-58`、`src/lib/aigc.ts:254-262`；`grep -rn "callLlm\|callAigc" src/` 仅命中 lib 自身与注释 |
| 鉴权 | RunningHub SSO。老域靠父域 cookie；沙箱域 `*.apps.vibex.cn` 靠 localStorage 里的 `X-Vibex-Scoped-Token`（静默 iframe 兑换 + popup 兜底） | `src/lib/rhLogin.ts:18-69,88-92`；`src/lib/pb.ts:31-37` |
| 构建 | Vite 8 + `@vitejs/plugin-react` 6 + React 19.2 + TypeScript ~6.0 + Tailwind 3.4 + PostCSS/autoprefixer | `package.json` scripts/devDependencies；`vite.config.ts:75-92` |
| 依赖体量 | `dependencies` **48** 项（含 `recharts`、`embla-carousel-react`、`react-hook-form`、`zod`、`cmdk`、`vaul`、`next-themes`、`miniprogram-ci` 等大量本 app 未使用的包） | `package.json` |

---

## 2. 信息架构与页面流

### 2.1 路由表

| 路径 | 组件 | 入口文件 | 数据来源 | 备注 |
|---|---|---|---|---|
| `/` | `HomeRoute` → `HomePage` | `src/pages/Home/index.tsx:3-5` | **无接口**（Showcase/Stats 全硬编码） | 门户型营销页 |
| `/board` | `BoardRoute` → `BoardPage` | `src/pages/Board/index.tsx` | `GET/POST /api/messages` | 留言板 |
| `/api-test` | `ApiTestRoute` → `ApiTestPage` | `src/pages/ApiTest/index.tsx` | `POST /__pb/api/proxy/heibao/create_project` | 连通性自测 |
| `/works` | `WorksRoute` → `WorksPage` | `src/pages/Works/index.tsx` | `GET /api/works?published=true` | 公开作品库 |
| `/admin/works` | `AdminWorksRoute` → `AdminWorksPage` | `src/pages/AdminWorks/index.tsx` | `GET/POST/PATCH/DELETE /api/works` | 管理后台（需登录） |
| `*` | `<Navigate to="/board" replace />` | `src/App.tsx:30` | — | **404 静默落留言板**（不是首页） |

**基线注意**：`main.tsx:16` 用 `<BrowserRouter basename={getBasename()}>`，`getBasename()` 从 URL 里提取 `/app-preview/app-<32hex>` 或 `/p/app-<32hex>` 前缀（`src/lib/pb.ts:7-11,22-24`）。站内 `<Link>` 因此不会掉到域名根。**我们的对照**：纯 hash 路由 + 无 basename 需求（`public/js/app.js:45-64`），此机制对我们完全无意义。

### 2.2 各页骨架与 happy path（含原文文案）

**① Home 门户（`src/pages/Home/HomePage.tsx:14-42`）**
骨架：3 层 `pointer-events-none` 固定装饰层（顶部渐变 + 两个 `blur-3xl` 光斑）→ `HomeNav` → `<main>` 依次 `HeroSection → StatsSection → FeaturesSection → ProcessSection → ShowcaseSection → CtaSection` → `FooterSection`。Happy path：进入即 `useReveal()` 启动滚动入场（`HomePage.tsx:12`）→ 阅读 hero「**从 一句话 到 一部漫剧**」（`HeroSection.tsx:22-26`，两处 `gradient-text` 渐变高亮）→ 点主 CTA「**免费开始创作**」（`HeroSection.tsx:41`）→ **新窗口跳外链** `http://enochcityai.hongfudesign.com`（`HeroSection.tsx:35-38`）。页内锚点：`HomeNav` 的 `功能介绍 #features / 创作流程 #process / 作品展示 #showcase / 作品库 → /works`（`HomeNav.tsx:9-14`）用 `handleAnchor` 做平滑滚动（`:30-35`）；`HeroSection` 自身带 `id="top"`（`HeroSection.tsx:7`）但无导航项指向它。次要 CTA「**立即创作**」出现两处（`HomeNav.tsx:136-143` 移动端菜单、`:64-93` 桌面端），微文案「无需信用卡 · 免费体验」（`HeroSection.tsx:44`）。

**② Board 留言板（`src/pages/Board/BoardPage.tsx:30-105`）**
骨架：Hero（`font-mono` pill 写 `board` + h1「**留言板**」+ 副标题「在这里留下一句话,会被保存下来」+ 右上「刷新」）→ `MessageForm` → 列表区（标题「全部留言 · N」）→ footer「© {年} message.board」。
三态：`isLoading` → `<LoadingState />`；`error && 列表空` → 红框「加载失败: {errMsg}」+「重试」按钮（`BoardPage.tsx:86-99`）；否则 `MessageList`（空则 `EmptyState`）。
Happy path：在 textarea 输入（placeholder「说点什么…… (Ctrl/⌘ + Enter 快速提交)」，`MessageForm.tsx:33`）→ `Ctrl/⌘+Enter` 或点「**提交**」→ `POST /api/messages` → **乐观插入到列表头部**（`useBoard.ts:88`）→ 清空草稿。表单细节：`maxLength={500}` + 实时字数「{n}/500」（`MessageForm.tsx:35,38-40`）；提交中按钮变 `<Loader2 animate-spin/> 提交中…`（`MessageForm.tsx:46-50`）；错误行 `role="alert"`（`MessageForm.tsx:60`）。`canSubmit = draft.trim().length > 0 && jobStatus !== "submitting"`（`useBoard.ts:97`）。

**③ Works 公开作品库（`src/pages/Works/WorksPage.tsx`）**
骨架：`WorksNav` → `WorksHero` → 标题区（h2「**全部作品**」+「精选上架漫剧,持续更新中」+ 右侧计数 pill「**共 N 部**」，`WorksPage.tsx:19-29`）→ `WorksGrid` → footer「© 以诺城AI · 用 AI 讲好每一段故事」（`WorksPage.tsx:33-35`）。注意：`WorksHero` **完全不读接口**——零 props、零 fetch 的静态块，只有「作品库」pill + h1「漫剧 / 作品合集」（渐变字）+「看看用 AI 创作出来的漫剧长什么样——每一张封面都藏着一段故事」（`WorksHero.tsx:1-29`）；全站唯一的「N 部」计数来自 `WorksPage.tsx:28` 的 `{p.works.length}`。
Happy path：进入 → 自动拉 `published=true` 列表 → 骨架屏 6 张 → 渲染 9:16 封面卡。**卡片刻意不可点**：`WorkCard` 是纯 `<article>`，无 `<Link>`、无 `onClick`、无详情路由（`WorkCard.tsx:8-38`）——作品库只做「展示橱窗」。四态：loading → `WorksSkeleton count={6}`；error → 红框「加载失败,请刷新重试」+ 具体 `errorMsg`（`WorksGrid.tsx:22-29`）；success 且空 → 虚线框「**还没有上架作品**」/「去后台上传第一部吧」+ CTA「前往管理 → `/admin/works`」（`WorksGrid.tsx:31-47`）；success 有数据 → 网格（`grid-cols-2 lg:grid-cols-3 xl:grid-cols-4`，`WorksGrid.tsx:49-55`）。

**④ AdminWorks 作品管理（`src/pages/AdminWorks/AdminWorksPage.tsx`）**
骨架：径向渐变背景 → `AdminWorksNav` → `!isAuthed ? <LoginGate/> : <管理区>`。未登录：`LoginGate`（`admin-works/LoginGate.tsx:4-27`）= 锁形图标 + 径向光斑 + h2「**请先登录管理作品**」+「登录后即可上传、编辑、上架你的漫剧作品」+ 挂 `RhAccountMenu`。已登录：pill「管理后台」+ h1「**作品管理**」+「上传、编辑、上架你的漫剧作品」（`AdminWorksPage.tsx:48-56`）；右上「**刷新**」（图标随 `jobStatus==="loading"` 转）与「**新增作品**」（`:59-77`）；下方 `WorksAdminTable`。
Happy path（新增）：点「新增作品」→ `openCreate` 用 `EMPTY_DRAFT`（`published: true`，`useAdminWorks.ts:28-34`）→ `WorkFormDialog` → 填 title/description/genre/cover_url/published → 选封面文件触发 `onUpload` → `saveWork` → `POST /api/works` → 成功 `setWorks(prev => [created, ...prev])` + toast「**作品已添加**」（`useAdminWorks.ts:144-145`）。编辑：`openEdit(work)` 回填（`AdminWorksPage.tsx:22-32`）→ `PATCH /api/works/{id}` → 就地替换 + toast「**作品已更新**」（`useAdminWorks.ts:131-132`）。上架/下架：行内按钮 → `togglePublish(id, !published)` → `PATCH {published}` → toast「**已上架**」/「**已下架**」（`:175`）。删除：`setDeleteTarget(work)` → `ConfirmDeleteDialog` → `DELETE /api/works/{id}` → 本地过滤移除 + toast「**已删除**」（`:192-193`）。

**⑤ ApiTest 接口测试（`src/pages/ApiTest/ApiTestPage.tsx`）**
骨架：`bg-gradient-to-br from-background via-background to-secondary/30` + 两个 `blur-3xl` 光斑 → `ApiTestNav` → `max-w-3xl` 单列（`ApiTestPage.tsx:18`）→ Hero（`font-mono` pill 写 `connectivity check` + h1「**接口测试**」+「点一下按钮,测试到黑豹后端的连通性」）→ `RequestPreview`（展示固定 body）→ 操作卡（说明「点击下方按钮,服务端将向黑豹后端发送固定的创建项目请求」+ `TestButton`）→ `ResultPanel` → footer「前端 → 我们后端 → 外部 API → 返回 → 渲染」（`ApiTestPage.tsx:62`）。Happy path：点「**测试连接黑豹后端**」（`TestButton.tsx:22`；loading 时变「请求中…」，`:16-20`）→ `POST /__pb/api/proxy/heibao/create_project`（body 为 `{}`，`useApiTest.ts:43-47`）→ 服务端代发上游并**固定写死**请求体 → 面板展示 `{ok, status, data}` 或错误四段式。
`RequestPreview` 展示「POST」+ 路径「`/api/proxy/heibao/create_project`」+ 右上角 pill「**固定请求体**」，下方是 `JSON.stringify(body, null, 2)` 的 `<pre>`（**无行号**）（`RequestPreview.tsx:5-27`）。内容即 `FIXED_REQUEST_BODY`（`useApiTest.ts:22-27`：`project_name: "妙搭测试"`、`genre: "古风喜剧"`、`total_episodes: 1`、`episode_duration: 120`）。

### 2.3 站内导航网络

- `HomeNav`：`NAV_LINKS` 四项 = `功能介绍 #features / 创作流程 #process / 作品展示 #showcase / 作品库 → /works`（`HomeNav.tsx:9-14`），外链常量 `CTA_HREF` 在 `:16`；sticky 顶栏滚动过 12px 变色（`HomeNav.tsx:23-28,37-41`）；桌面 nav 在 `:56-94`，移动抽屉在 `:106-145`（末尾是「立即创作」外链 `:136-143`）；锚点平滑滚动由 `handleAnchor` 处理（`HomeNav.tsx:30-35`）。
- `WorksNav`：`首页 / 作品库 / 立即创作(外链)`，桌面 nav `:17-36`，右侧 `cta-primary` 外链按钮 `:38-45`，移动端「作品库」`:47-52`；**当前项有 `aria-current="page"`**（`WorksNav.tsx:24`）。
- `AdminWorksNav`：`首页 / 作品库 / 作品管理`，当前项仅用 `border-b-2 border-primary` 下划线、**未加 `aria-current`**（`AdminWorksNav.tsx:25-30`）+ `RhAccountMenu`（`:33-35`）。
- `BoardNav`：品牌「留言板」（`font-mono` + 圆点）+ `RhAccountMenu`，无站内链接（`BoardNav.tsx:4-18`）。
- `ApiTestNav`：品牌「接口测试」+ 站内 `首页 → /`、`留言板 → /board`（`ApiTestNav.tsx:13-26`）+ `RhAccountMenu`（`:28`）。
- **可达性缺口（观察）**：`/api-test` 在**所有其它导航中都没有入口**（只有 `ApiTestNav` 自己链接出去），是孤岛页；`/board` 可从 `ApiTestNav` 的「留言板」到达，且是 `*` 通配的落点（`App.tsx:30`）。推测 `ApiTest` 是生成期调试页残留，**未确认**是否有意保留。

---

## 3. 作品发布与公开作品库

### 3.1 作品数据模型（前端 + 后端字段一致）

```ts
// src/pages/Works/useWorks.ts:4-13 与 src/pages/AdminWorks/useAdminWorks.ts:6-15（两处重复定义）
interface WorkItem {
  id: string; title: string; description: string;
  genre: string; cover_url: string; published: boolean;
  created: string; updated: string;
}
```
后端 collection 定义（`pocketbase/pb_hooks/works.pb.js:30-34` 增量升级 / `45-54` 全新建）：
`title: text required max=100`、`description: text required max=500`、`genre: text required max=30`、`cover_url: text required max=500`、`published: bool required`、`created/updated: autodate`。**没有** `author` / `user` / `sort` / `views` / `tags` 字段——即**无作者归属、无排序权重、无浏览量**。所有 rule 均 `null`（`works.pb.js:45`），意味着 PB 默认 collection 级权限全关，鉴权**只由自研 routerAdd 里的 `e.auth` 手写判断**承担。

### 3.2 封面

- `cover_url` 是**纯文本 URL**，不是 PB file 字段。管理页从 AIGC 上传拿 URL：`uploadCover(file)` → `uploadAigcMedia(file, "image")` → 兼容取 `res.download_url || res.downloadUrl`，空则抛「上传失败,未返回 URL」（`useAdminWorks.ts:85-98`）。上传期间 `jobStatus="uploading"`。
- 公开库侧只做**渲染容错**：`WorkCard` 有 `imgError` state，`onError` 后改渲染渐变底 + `<Film/>` 占位块（`WorkCard.tsx:6,11-23`）；`WorksAdminTable` 的缩略图则是 `onError` 里 `style.display = "none"` 直接隐藏，**下面永远铺着一层同位置占位**（`WorksAdminTable.tsx:33-46`）。
- 卡片视觉：`aspect-[9/16]`（竖屏）+ `object-cover` + hover `scale-105`（500ms）+ 底部 `bg-gradient-to-t from-background` 压暗 + 分类 badge + `line-clamp-1` 标题 + `line-clamp-2` 简介（`WorkCard.tsx:10,21,24,28-36`）。

### 3.3 上架状态与列表筛选交互

- 上架即 `published` 布尔；公开库查询**硬编码** `published=true`：`` `${WORKS_URL()}?page=1&perPage=50&sort=-created&published=true` ``（`useWorks.ts:30`）。
- **列表无任何筛选/排序/搜索 UI**——`WorksPage` 只有计数 pill（`WorksPage.tsx:26-29`），没有分类筛选、没有分页控件、没有「加载更多」。`genre` 在公开库只用于卡片 badge（`WorkCard.tsx:29`，且 `work.genre || "漫剧"` 兜底）。
- `perPage` 写死：公开库 50（`useWorks.ts:30`），管理页 200（`useAdminWorks.ts:56`）。**无分页**：若作品 > 50，公开库会静默丢数据且无提示。
- 首页 Showcase 与作品库**互不相通**：`ShowcaseSection` 是 3 条硬编码数据（`ShowcaseSection.tsx:13-38`，含「林则徐买鱼丸记 / 古风喜剧 🐟」「未命名·仙途 / 玄幻仙侠 ⚔️」「都市夜未眠 / 都市情感 🌃」），封面是纯 CSS 类 `cover-ancient` / `cover-xianxia` / `cover-city`，**不读 `works` 接口**。这是首页数据与作品库最容易不同步的地方。

### 3.4 管理页（审核/编辑/下架）实现细节

- **列表**：`WorksAdminTable` 是「卡片列表」而非真表格——`grid-cols-1 md:grid-cols-2 xl:grid-cols-3`，每卡 `h-28 w-20` 缩略图 + 标题 + 上架 Badge + 简介 + 操作行（`WorksAdminTable.tsx:27-98`）。空态：「**还没有作品**」/「点右上角「+ 新增作品」添加你的第一部漫剧」（`WorksAdminTable.tsx:20-21`）。
- **上架 Badge 双态**：`published` → `已上架`（`bg-primary/10 text-primary`）；否则 `已下架`（灰系）（`WorksAdminTable.tsx:53-62`）。
- **三个动作**：`onEdit`（Pencil）/ `onToggle`（`Eye`↔`EyeOff`，标题随态变「下架」/「上架」）/ `onDelete`（Trash2，`variant="ghost"` + 红字）（`WorksAdminTable.tsx:67-94`）。
- **表单弹窗** `WorkFormDialog`（共 214 行）：标题/简介/类型三个受控输入（title `maxLength 100`、genre `maxLength 30`、description `maxLength 500`）+ 一个隐藏的 `type="file"` 封面选择（点击预览区触发 `fileInputRef.current?.click()`）+ 一个 `Switch` 控制「上架」；`DialogContent` 在 `:84`，`<form>` 在 `:94`（`:94-211`）；封面校验 `MAX_MB = 5`（`:28`）→ `file.size > MAX_MB * 1024 * 1024` 报「**图片不能超过 5MB**」、`!file.type.startsWith("image/")` 报「**请选择图片文件 (jpg/png/webp)**」，错误走本地 `uploadError` state 行内显示（`:40,54-74`）；成功后 `setDraft(d => ({...d, cover_url: url}))` 并清空 input value（`:67-73`）。保存期间按钮禁用 + 转圈（`busy`/`uploading` 两个 prop，`AdminWorksPage.tsx:94-95`）。
- **删除二次确认** `ConfirmDeleteDialog`：Radix `AlertDialog`，标题「**确定删除吗?**」+ 描述「即将删除《**{displayName || "该作品"}**》,此操作不可撤销。」+ 动作「取消」/「确认删除」（`destructive` 色）（`ConfirmDeleteDialog.tsx:19-45`，文案在 `29-32`）——**把待删对象名带进确认文案**，是我们值得抄的一条（见 §9-3）。
- **权限保护是「前端条件渲染 + 后端兜底」双层，但两层身份不是同一个（重要发现）**：前端门禁用 `pb.authStore.isValid`（`useAdminWorks.ts:42,46-48`）+ `RhAccountMenu`（RunningHub 登录）→ 二者语义不同；写请求头用 `Authorization: pb.authStore.token`（`useAdminWorks.ts:57-59,123-127,138,166-170,189`）；后端校验 `if (!e.auth || !e.auth.id) return 403 auth_required`（`works.pb.js:150-152` 创建、`172-174` 更新、`196-198` 删除）——`e.auth` 是 **PocketBase** 的 auth。但全仓 grep `pb.collection|authWithPassword|authStore.save` **零命中**（只有读 `authStore.token/isValid`），即前端**从未登录过 PocketBase**。结论：按包内代码，管理页登录态恒为 false → `LoginGate` 常驻、列表永不加载、写请求恒 403。**未确认**的是 VibeX 平台是否在运行时注入 PB 登录态（`src/_rh_inspect.ts` 已被导出流程替换成空 stub，无法验证）。

---

## 4. 后端 API 契约

### 4.1 前端调用的全部自有后端端点（真实存在副本在 `pocketbase/pb_hooks/`）

| 方法 + 路径 | 请求形状 | 成功响应 | 鉴权 | 出处 |
|---|---|---|---|---|
| `GET /api/messages?page&perPage&sort` | query；`perPage` 上限 200（超出被钳） | `{items:[publicExport], page, perPage, totalItems}` | 无 | `messages.pb.js:57-98`（钳制 `79`） |
| `GET /api/messages/{id}` | — | `publicExport()` 裸对象；404 `{error:"not_found"}` | 无 | `messages.pb.js:100-112` |
| `POST /api/messages` | `{content:string}`（缺省填 `""`） | `publicExport()` 裸对象 | 无 | `messages.pb.js:114-142` |
| `PATCH /api/messages/{id}` | body 里出现的字段才更新 | `publicExport()` | 无 | `messages.pb.js:144-159` |
| `DELETE /api/messages/{id}` | — | `{ok:true}` | 无 | `messages.pb.js:161-174` |
| `GET /api/works?page&perPage&sort&published` | query；`published` 有值时才拼 filter（`works.pb.js:95-99`：`filterParts.push("published = {:published}")` + `params.published = String(query.published)`） | `{items:[publicExport], page, perPage, totalItems}` | 无（公开读） | `works.pb.js:65-114` |
| `GET /api/works/{id}` | — | `rec.publicExport()`；404 `{error:"not_found"}` | 无 | `works.pb.js:115-127` |
| `POST /api/works` | `{title,description,genre,cover_url,published}` | `rec.publicExport()` | **需 `e.auth`** → 403 `{error:"auth_required", message:"登录后才能创建作品", fingerprint}` | `works.pb.js:129-169`（鉴权 `150-152`） |
| `PATCH /api/works/{id}` | 同上，只更新 body 里出现的字段（`if ("published" in body)`，`works.pb.js:185`） | `rec.publicExport()` | **需 `e.auth`** → 403「登录后才能更新作品」 | `works.pb.js:170-193`（鉴权 `172-174`） |
| `DELETE /api/works/{id}` | — | `{ok:true}` | **需 `e.auth`** → 403「登录后才能删除作品」 | `works.pb.js:194-210`（鉴权 `196-198`） |
| `POST /api/proxy/heibao/create_project` | body **被服务端忽略**，请求体写死 | 上游 2xx：`{ok:true, status, data}`（`data` 为解析后的 JSON 或**截断 500 字的字符串**） | 无 | `heibao.pb.js:4-86`（写死体 `9-14`；字符串兜底 `55`） |
| `POST /__rh_admin_sso` | header `X-Rh-Admin-Sso` | `{token, record}`（PB superuser 15 分钟静态 token） | header 必须等于容器注入的 `VIBEX_TASK_INDEX_TOKEN`，否则 403 `{code:"FORBIDDEN"}`（fail-closed） | `templates/scaffold/templates/pb_hooks/_rh_admin_sso.pb.js:14-45` |

### 4.2 平台注入端点（**模板副本**，真实运行版不在包内；路径前缀均为 `templates/scaffold/templates/pb_hooks/`）

- `GET /api/llm/models` → `{ok:true, models:[LlmModelInfo]}`，默认 `max_tokens 8192` / `timeout_s 600`（`llm.pb.js:61-81`，默认值 `71-72`）。
- `POST /api/llm/chat`：`{model, messages, page?, max_tokens?, temperature?, request_id}`；API Key 优先取请求头 `x-rh-api-key`，否则环境变量 `RH_LLM_API_KEY`/`RH_API_KEY`（`llm.pb.js:83-258`，取 Key `84-87`）。
- `POST /api/llm/poll`：`{request_id}` → `{ok, status, text, error, model}`；未命中 `{ok:false, status:"not_found"}`（`llm.pb.js:259-281`）。
- `POST /api/aigc/upload`：multipart（`fileType` + `file`）→ `{download_url, …}`（`aigc.pb.js:356-423`）。
- `POST /api/aigc/submit`：`{model, <primary_input 字段>, <scalar_params>, <media_params>}`（`aigc.pb.js:424-647`；primary_input 解析 `496+`、scalar 循环 `~560`）。
- `POST /api/aigc/jobs/{jobId}/poll`（`aigc.pb.js:767-884`）；另有 `GET /api/aigc/models` / `POST /api/aigc/price-preview` / `POST /api/aigc/history[/…]`（`aigc.pb.js:333,648,885,1072,1139`）。

`llm_jobs` 表结构（`llm.pb.js:38-55`）：`request_id / model_name / page / status / result_text(max 80000) / error_message(max 4000)`，且 `CREATE UNIQUE INDEX idx_llm_jobs_request_id`（`51`）——**用 request_id 做请求级幂等/结果缓存**。

### 4.3 ApiTest 页的测试逻辑

1. **单飞守卫**：`inflightRef.current` 为真直接 return，防连点（`useApiTest.ts:33-37,80`）。
2. **固定请求**：前端 body 传 `{}`（`useApiTest.ts:46`），真正的业务参数由服务端写死（`heibao.pb.js:9-14`）——即这一页**不测参数契约，只测链路连通**。
3. **不信任 JSON**：先 `res.text()`，再手动 `JSON.parse`；解析失败 → `{ok:false, error:"network_error", message:"响应不是合法 JSON: …", body: text.slice(0,500)}`（`useApiTest.ts:48-63`）。
4. **空响应也算失败**：`text` 为空 → `{ok:false, error:"network_error", message:"响应为空"}`（`useApiTest.ts:51-55`）。
5. **状态机**：`idle | loading | success | error`，`setJobStatus(parsed.ok ? "success" : "error")`（`useApiTest.ts:65`）；fetch 自身抛错时构造 `fingerprint: "frontend-" + Date.now()`（`76`）。
6. `ResultPanel` 四态渲染（`ResultPanel.tsx:10-91`）：`idle` → 虚线框「还没发请求,点上面按钮开始」（`18-24`）；`loading` → `<Loader2 animate-spin/>` +「正在请求黑豹后端…」（`26-31`）；`success` → 主色条「请求成功(HTTP {status})」+ `max-h-[400px]` 可滚 `<pre>` 格式化 JSON（`33-45`）；`error` → 四段：**错误类型**（`responseData.error`，`font-mono`）、**错误消息**（`errorMsg || responseData.message`）、**追踪 ID**（`responseData.fingerprint`，有值才渲染，`font-mono text-xs`）、**响应体**（`responseData.body`，`max-h-[200px]` 可滚）（`47-88`）。右上角还有 `StatusBadge` 四态标签「待发送 / 请求中 / 成功 / 失败」（`ResultPanel.tsx:93-105`）。

### 4.4 错误处理与鉴权约定

- **统一错误体**：`{error: "<snake_case_code>", message: "<中文人话>", fingerprint: "<前 80 字符原始错误>"}`（`works.pb.js:111,190,208`；`messages.pb.js:96,110,140,157,172`）。`fingerprint` 是**跨前后端可对齐的追踪码**，ApiTest 页把它当「追踪 ID」展示（`ResultPanel.tsx:66-75`）。
- **代理层 fail-soft**：上游网络异常/非 2xx 时，`heibao.pb.js` 一律 **HTTP 200 + `{ok:false, error:"upstream_error"|"network_error", …}`**（`25-33,69-84`）——把「传输层失败」和「业务层失败」压成同一层，前端只需看 `ok`。代价：HTTP 语义丢失。
- **412 语义**：AIGC/LLM 侧「需要重新登录」统一用 HTTP 412（`llm.ts:85-87`；`aigc.ts:403-405` 上传处 `throw Object.assign(new Error("login_required"), { status: 412 })`、`:500` poll、`:634` submit、`:754,778` AI 应用），前端据此置 `needsLogin: true`。
- **`e.auth` 是唯一服务端鉴权手段**，无 role 概念、无 owner 校验（任何已登录用户都能改任何作品）——`works.pb.js` 只判「有没有登录」，不判「是不是你的」。
- **Goja 兼容注释密集**：`heibao.pb.js:38-48` 手写 `[]byte → UTF-8` 解码（`decodeURIComponent(escape(...))`）以兼容 PB JSVM 返回字节数组的形态——说明该运行时对二进制/编码支持有限。这类坑对我们无意义（我们是真 Node）。

---

## 5. 数据模型（全部 TS 类型清单）

### 5.1 业务实体

| 类型 | 字段 | 出处 |
|---|---|---|
| `WorkItem` | `id, title, description, genre, cover_url, published, created, updated` | `src/pages/Works/useWorks.ts:4-13` |
| `WorkItem`（**重复定义**） | 同上，逐字段一致 | `src/pages/AdminWorks/useAdminWorks.ts:6-15` |
| `DraftItem` | `id?, title, description, genre, cover_url, published` | `useAdminWorks.ts:19-26` |
| `EMPTY_DRAFT` | `{title:"", description:"", genre:"", cover_url:"", published:true}` | `useAdminWorks.ts:28-34` |
| `MessageRecord` | `id, content, created, updated, relativeTime`（`relativeTime` 为客户端派生） | `src/pages/Board/useBoard.ts:6-13` |
| `ListEnvelope` | `items: Omit<MessageRecord,"relativeTime">[], page, perPage, totalItems` | `useBoard.ts:15-20` |

### 5.2 状态枚举与结果类型

`ListStatus` = `"idle"|"loading"|"success"|"error"`（`useWorks.ts:15`）；管理页 `JobStatus` = `"idle"|"loading"|"saving"|"uploading"|"error"`（`useAdminWorks.ts:17`）；ApiTest `JobStatus` = `"idle"|"loading"|"success"|"error"`（`useApiTest.ts:3`）。结果类型：`ProxySuccessResult` `{ok:true, status:number, data:unknown}`（`useApiTest.ts:5-9`）、`ProxyErrorResult` `{ok:false, error, message, status?, body?, fingerprint?}`（`:11-18`）、`ProxyResult` 为二者联合（`:20`）；`UseApiTestReturn` / `UseCostConfirmResult` 均为 `ReturnType<typeof useXxx>`（`useApiTest.ts:93`、`src/hooks/useCostConfirm.ts:80`）。

### 5.3 lib 层类型

`LlmContentPart` `{type:"text",text} | {type:"image_url",image_url:{url}}`（`llm.ts:4-6`）；`LlmMessage` `{role:"system"|"user"|"assistant", content: string | LlmContentPart[]}`（`:8-11`）；`LlmCallOptions` `{messages, page?, max_tokens?, temperature?, signal?, request_id?}`（`:13-20`）；`LlmCallResult` `{ok, status:"success"|"failed"|"running"|"pending"|"not_found", text, error?, model?, usage?, needsLogin?}`（`:22-30`）；`LlmModelInfo` `{model, rh_model_id, max_tokens, timeout_s, supports_temperature}`（`:32-38`）；`RhJwtPayload` `{sub?, user_name?, username?, nickName?, mobile?, exp?}`（`rhLogin.ts:1-8`）；`RhAccountInfo` 与 `ScopedUser` 同形独立定义 `{userId, displayName, avatar?, totalCoin?, walletBalance?}`（`rhLogin.ts:10-16` 与 `:94-100`）；AIGC 系列 `AigcUploadResponse`/`AigcUploadFileType`/`AigcSubmitResponse`/`AigcJobStatus`/`AiAppUploadResponse`/`AigcFailure` 等定义在 `src/lib/aigc.ts:1-230` 区间。

### 5.4 本地存储用法

| 键 | 用途 | 出处 |
|---|---|---|
| `vibex-scoped-token` / `-expires` / `-user` | 沙箱域 scoped token 及其过期时间、用户快照 | `rhLogin.ts:57-59` |
| `vibex-sandbox-app-id` | 沙箱 app id 缓存 | `rhLogin.ts:60` |
| `vibex-sandbox-token` / `-expires` / `-app` / `-user` | SSO 回跳 URL fragment 交接键（与 console 侧约定，**勿单独改一侧**） | `rhLogin.ts:62-65` |
| `vibex-sandbox-logged-out` | 用户主动登出标记，置位期间禁止静默兑换（否则「无法退出登录」） | `rhLogin.ts:69-86` |
| `vibex_cost_confirmed_today:<appId>` | 今日已确认计费的 `{expiresAt}`（`appId` 从 URL 正则 `/app-[0-9a-f]{32}/` 提取，取不到则 `"local"`；过期时刻为当天 `23:59:59.999`） | `src/lib/costConfirm.ts:12-39`（键名 `:16-18`，过期 `:20-24`） |
| `sessionStorage` 若干 | app id / 邀请码等平台上下文 | `rhLogin.ts`（多处 try/catch 包裹） |

**无 IndexedDB、无 Service Worker、无持久化查询缓存**；业务数据 100% 在 PocketBase。所有 localStorage 访问都套 `try/catch`（隐私模式下不炸），这是值得学的小细节。

---

## 6. 提示词工程

### 6.1 结论：前端 **0 条明文 prompt 模板**

`grep -rn "prompt" src/` 的全部命中都是**注释与错误文案**（`src/components/rh/CostConfirmDialog.tsx:1-3`、`src/hooks/useCostConfirm.ts:28` 提到「不要 fall back 到 `window.prompt`」）。没有 system prompt 字符串、没有 few-shot、没有模板插值函数、没有 `PRESET_TERMS` 之类的预设词库。**提示词在本 app 中完全不存在于前端**——它由使用方在调用时构造（而本 app 页面实际也没调用 LLM/AIGC）。

### 6.2 透传协议（前端唯一与 prompt 相关的代码）

- 消息体：`LlmMessage[]`，`role` 三选一，`content` 支持**纯文本或 `image_url` 多模态分片**（`llm.ts:4-11`）。
- 审计标签：`page`（页面 slug）随每次调用上报，用于后端 `llm_jobs.page` 归因（`llm.ts:107`；`aigc.ts:178` 注释「推荐传页面 slug, 用于审计」）。
- **参数纪律**：`temperature` 仅在「显式传入 **且** 模型名不匹配 `/gpt-?5/i`」时才进 payload（`llm.ts:111-113`）；`llm.pb.js:27-28` 注释同源说明「GPT-5.5 等模型不支持该参数」。`max_tokens` 用于控制慢模型延迟（`llm.pb.js:23`）。
- AIGC 侧：`body.model` + 主输入字段名由后端 `cfg.primary_input` 决定（`aigc.pb.js:195,496`），标量参数走 `cfg.scalar_params || cfg.params` 循环，按 `type` 做 `bool`/`number`/`string` 强转并落 `default`（`aigc.pb.js:560+`）；输入超长统一截断 8000 字符。

### 6.3 结构化输出协议：**不存在**

前端**没有** JSON Schema、`response_format`、`json_object`、也没有任何解析器（无 `extractJson` 类函数）。`LlmCallResult.text` 是原样字符串（`llm.ts:96`）。**对照我们**：`public/js/consts.js:384 extractJson` / `413 extractJsonArray`（```围栏 → 全文 parse → 截第一对括号 → repairJson 重试```）+ `public/js/consts.js:193 PRESET_TERMS` + `lib/routes.js:22 ART_STYLE_MAP` 分层画风注入 —— **这一项我们明显更成熟，是他们该抄我们，不是反过来。**

### 6.4 模型与参数

- 模型清单由后端 allowlist 决定，前端只消费：`GET /api/llm/models` → `{models:[LlmModelInfo]}`（`llm.ts:185-194`；模板 `llm.pb.js:61-81`）。
- 默认参数：`max_tokens 8192`、`timeout_s 600`（`llm.pb.js:71-72`）。
- 前端超时预算：`CHAT_ABORT_MS = 25000`、`POLL_INTERVAL_MS = 3000`、`POLL_ATTEMPTS = 200`（≈10 分钟）（`llm.ts:40-42`）。
- AIGC 轮询预算：`defaultDeadline = _isLongRunningModel(model) ? 30*60_000 : 8*60_000`，间隔从 `2500ms` 起、每轮 `Math.min(interval + 500, 5000)` 递增（`aigc.ts:466,473,480`）。**这是本项目里最值得抄的一段轮询策略**（见 §9-6）。
- 提交重试：`for (let attempt = 0; attempt < 3; attempt++)`，仅对可重试错误 `setTimeout(res, 1500)` 退避，4xx/412 立即返回（`aigc.ts:584,606,623`）。

---

## 7. 视觉与设计系统

### 7.1 色板（HSL 三元组 CSS 变量，Tailwind 消费 `hsl(var(--x))`）

定义在 `src/index.css:42-116`（`:root`）与 `:root,.dark` 同值重复（`118-167`）：`--background: 259 40% 14%`（深紫夜空底，`:68`）、`--card: 258 40% 10%`（比背景**更深**的卡面，`:72`）、`--primary: 247 44% 56%`（紫蓝主色，`:79`）、`--destructive: 0 72% 51%`（`:83`）、`--radius-sm/md/lg/pill: 6/8/12/9999px`（`:94-97`）、`--elev-raised: 0 10px 15px -3px rgba(0,0,0,.1)`（唯一抬升阴影，`:100`）、`--elev-ring: 0 0 0 1px var(--border)`（描边式「阴影」，`:101`）、`--text-xs: 12px`（字阶基准，`:109`）、`--font-display: "Dammit Sans", "PingFang SC", …`（`:112`）、`--font-body: "Rubik", …`（`:113`）、`--font-mono: Monaco, …, ui-monospace`（`:114`，用于 pill / 计数 / 追踪 ID）。
**阴影实际只有两档**：`tailwind.config.js:19` 把 `sm/DEFAULT/md/lg/xl` **全部映射到同一个 `var(--elev-raised)`**，`none` → `--elev-flat`。因此页面里写的 `shadow-sm`/`shadow-md`/`shadow-lg`/`shadow-xl` 视觉等价——这是「用 Tailwind 类名伪装层级」的取巧写法，读码时容易误判层级差异。

### 7.2 暗色主题的真相

`color-scheme: light dark`（`index.css:43`）看似支持双主题，但 `:root`（`42-116`）与 `:root,.dark`（`118-167`）**逐 token 同值**（对比 `68↔119`、`72↔123`、`83↔134`、`94↔145`…）。结论：**只有暗色一套**，light 从未定义；`next-themes` 虽在依赖里但无调用点。这是「为了可扩展性付了重复维护成本却没换来能力」的典型反例。

### 7.3 字体与中英混排

`.cjk-latin`（`index.css:58-64,171-172`）：把纯英文/数字片段包进 `<span class="cjk-latin">`，用 `font-size-adjust: 0.56` + `vertical-align: var(--cjk-latin-shift, -0.15em)` 让英文与中文基线和字高对齐。注释明说是 `design_picker` 烧进 `:root` 的默认值（`-0.15em`）。**这是中文排版里少见的认真处理**，但代价是每处混排都要手写 span，可维护性差。

### 7.4 自定义落地页样式（`index.css:175-301`）

| 类 | 视觉 | 行 |
|---|---|---|
| `.cta-primary` / `.gradient-text` | 紫→粉对角渐变 + `box-shadow` 光晕（hover 提亮）；`background-clip:text` 渐变字 | `179-188` / `189-201` |
| `.hero-glow--center/--side` | 大尺寸径向模糊光斑，`hero-pulse 8s ease-in-out infinite` 呼吸 | `202-224` |
| `.reveal` / `.reveal.is-visible` | 初始 `opacity:0 + translateY(24px)`，加 `.is-visible` 后 `0.7s` 过渡入场 | `255-263` |
| `.cover-ancient/.cover-xianxia/.cover-city` + `-icon-*` | 纯 CSS 多层 radial/linear 渐变封面（无图片依赖） | `266-286` |
| `.process-line::after` | 桌面端 6 步之间画连接线，最后一项 `display:none` 收尾 | `290-299` |

### 7.5 动效

`tailwindcss-animate` 的 `animate-in fade-in slide-in-from-bottom-N duration-N` 被大量使用（`BoardPage.tsx:31`、`AdminWorksPage.tsx:47`、`ApiTestPage.tsx:18`、`MessageCard.tsx:12` 配 `animationDelay: Math.min(index*40, 300)ms` 做列表错峰入场）。配合 `hover:-translate-y-1` + `transition-all duration-300` 形成统一的「卡片浮起」语言。

### 7.6 组件视觉特征

- **Button**：6 variant（default/destructive/outline/secondary/ghost/link）× 4 size（default `h-10` / sm `h-9` / lg `h-11` / icon `h-10 w-10`），统一 `focus-visible:ring-2 ring-offset-2` + `disabled:opacity-50`（`ui/button.tsx:7-34`）。用 CVA 声明，`asChild` 走 Radix `Slot`。
- **Badge**：4 variant，`rounded-full` 胶囊（`ui/badge.tsx:6-24`）。
- **Card**：`rounded-lg border bg-card shadow-sm` + 5 个插槽组件（`ui/card.tsx:5-79`）。注意：作品卡**没用** Card 组件，而是手写 `rounded-2xl`——说明原子组件与页面实现存在圆角档位不一致（`lg=12px` vs `2xl=16px`）。
- **Skeleton**：`animate-pulse rounded-md bg-muted`（`ui/skeleton.tsx:3-13`）。
- **空态**：虚线边 `border-dashed` + 圆形软底图标（`h-14 w-14 rounded-full bg-primary/10`）+ 主标题 + 副说明 + 主色 CTA（`WorksGrid.tsx:31-47`、`WorksAdminTable.tsx:14-24`）。
- **加载态**：`LoadingState` 用 3 条骨架卡（`board/LoadingState.tsx:3-25`）；列表页用 `WorksSkeleton` 6 张 9:16 骨架。
- **登录门禁**：`h-20 w-20 rounded-2xl border border-primary/30` + 背后 `blur-3xl` 光斑 + `LockKeyhole` 图标（`LoginGate.tsx:6-25`）。

### 7.7 门户型首页的排版与信息层级

严格的三段式「吸引 → 说服 → 转化」，且**每段都有固定节奏**（依次为 `HomePage.tsx:30-41`）：① **装饰层**（固定、`pointer-events-none`、`aria-hidden`，`HomePage.tsx:17-28`）建立氛围但不干扰交互；② **Hero**——`eyebrow pill`（`Sparkles` 图标 +「AI 漫剧创作平台」，`tracking-widest` 小字）→ `h1` 4 档响应式字阶 `text-4xl sm:text-5xl md:text-6xl lg:text-7xl` + `leading-[1.1]` + 两处 `gradient-text` → 副标题 `max-w-2xl` 居中 → CTA +「无需信用卡 · 免费体验」微文案（`HeroSection.tsx:16-45`）；③ **数字说服** `StatsSection` 4 卡（`6 大流程环节 / 16 种风格模板 / 9:16 竖屏短剧 / AI 全链路自动化`），hover 才出现角上光斑 + `transitionDelay: i*80ms` 错峰（`StatsSection.tsx:1-32`）；④ **能力说服** `FeaturesSection` 2×2，`gradient-surface` 图标底 +「核心能力」小标 +「一句话的输入，一条龙的输出」（`FeaturesSection.tsx:38-78`）；⑤ **流程可视化** `ProcessSection` 桌面 6 列（`md:grid-cols-6`）+ `STEP 0N` 编号 + 连线，移动端降级纵向时间轴（`ProcessSection.tsx:38-63`）；⑥ **案例** `ShowcaseSection` 3 张 9:16 纯 CSS 封面（`ShowcaseSection.tsx:13-38`）；⑦ **转化** `CtaSection` + `FooterSection`（品牌 + slogan「从一句话到一部漫剧」+ 三个锚点链接 + 底部「© 2025 福州以诺城文化科技有限公司 · 闽 ICP 备 XXXXXXXX 号」，`FooterSection.tsx:15-53`，备案行 `:49`）。
统一排版纪律：`max-w-7xl px-5 sm:px-8` 容器、`py-20 md:py-28` 段落节奏、每个 section 都是「小标（`text-xs uppercase tracking-widest text-primary`）→ h2（`font-display text-3xl sm:text-4xl md:text-5xl`）→ 说明（`text-muted-foreground`）」三件套。

---

## 8. 工程实现技巧

### 8.1 请求层

- **无统一 fetch 封装**：每个 hook 自己 `fetch`（`useWorks.ts:31`、`useAdminWorks.ts:56,121,134,164,187`、`useApiTest.ts:43`）；只有 `useBoard.ts:32-45` 抽了个局部 `fetchJson<T>`。**无重试、无退避、无全局超时、无统一错误映射**——与我们的 `public/js/api.js:6-28` 统一 `req()` 相比是退步，不是可学项。
- **超时/取消**：只有 `llm.ts` 有 `AbortController` + `window.setTimeout(() => ctrl.abort(), CHAT_ABORT_MS=25000)`，并把外部 `opts.signal` 桥接到内部 controller（`llm.ts:115-117`）。AIGC 提交重试与轮询也接受 `signal`。
- **卸载防护**：`useWorks` 用 `let alive = true` + cleanup 置 false，`if (!alive) return` 后才 `setState`（`useWorks.ts:25,34,38,44-46`）；`useBoard` 用 `useRef(getPocketBaseUrl())` 固化 baseUrl 避免重渲染漂移（`useBoard.ts:54`）。

### 8.2 任务轮询

- **LLM 两段式**：先同步等 `/chat`（25s 预算），超时即转 `/poll`，3s × 200 次（≈10 分钟）（`llm.ts:40-42,169-181`）。注释明确「`/chat` 必须继续跑完并写 `llm_jobs`」（`llm.pb.js:22`）——即**同步接口与轮询接口共用一次后端执行**，不是两次调用。
- **快速失败**：`/poll` 返回 404 时累加 `notFoundCount`，`>= 3` 立即判 `failed/not_found`，不无限轮询（`llm.ts:88-90,176-177`）；同时用一次性探测把「老代际后端」记住（`legacyLlmRoutes`，`llm.ts:51-58,128-143`）。
- **AIGC 轮询**：间隔递增 2500→5000ms 封顶，deadline 按模型是否长任务分 8min/30min（`aigc.ts:466-480`）。**服务端**做轮询的我们（`lib/poller.js:45-51` 固定 `intervalMs()`，默认 8s、`maxPolls` 默认 60）反而更简单——见 §9-6。

### 8.3 错误处理与文案映射

- `AIGC_ERROR_MESSAGES_ZH`：8 类 `errorKind` → 中文基线文案（`aigc.ts:144-153`：`submit`「提交生成任务失败 (网络或服务器繁忙), 请稍后重试」/ `poll` / `timeout` / `aborted`「已取消」/ `login_required`「RunningHub 登录态已过期, 请重新登录」/ `insufficient_balance`「RunningHub 账户余额不足, 请充值后重试」/ `content_audit`「内容审核未通过」/ `task_failed`）。
- `formatAigcFailureMessage`（`aigc.ts:164-171`）：**「基线文案 + 原始错误」拼接**（`return \`${base}: ${raw}\``），跳过条件只有两条——`raw` 命中内部占位符集合 `AIGC_ERROR_PLACEHOLDER_VALUES`（`aigc.ts:157`：`aborted` / `submit failed` / `poll timeout` / `task_failed`）或 `raw === base`。`:159-163` 的注释明确反对「自己写一份 `errorKind` 白名单去挑着拼」，理由是白名单漏掉的分支（最常见 `task_failed`）会把上游真实报错吞掉。
- 代理层把传输失败压成 HTTP 200 + `ok:false`（`heibao.pb.js:25-33,69-84`），前端只看 `ok`。
- 所有后端 handler 都 `try/catch` 兜底返回 500 + `{error, message, fingerprint}`，且 `$app.logger()` 记日志（包在 `try{}catch(_){}` 里防日志本身炸，`works.pb.js:60`）。

### 8.4 并发控制

- ApiTest 单飞：`inflightRef`（`useApiTest.ts:33-37`）。
- 多文件上传：`files.slice(0, opts.maxCount)` 截断 + 逐个 `await` 并 `setTimeout(i * 300)` 错峰 + **单个失败跳过不中断整批**（`aigc.ts:939,948`）。
- 管理页 `isBusy = jobStatus === "saving" || jobStatus === "uploading"` 统一禁用刷新/新增（`useAdminWorks.ts:206`）。

### 8.5 缓存与幂等

`llm_jobs` 表用 `request_id` 唯一索引（`llm.pb.js:51`）+ 客户端 `uuid()` 生成（`crypto.randomUUID` 优先，降级 `"req-" + Date.now().toString(16) + "-" + random`，`llm.ts:60-65`）。注释称「客户端提前放弃等待并转 /poll」（`llm.pb.js:22`），即**同一 request_id 的重复提交可被后端识别**。这是本项目里最有价值的后端工程技巧之一。

### 8.6 表单校验

三层：① 输入约束（`maxLength={500}`、`required`、`maxLength 100/30/500`）；② 提交前二次 trim + 必填（`if (!payload.title || !payload.description || !payload.genre || !payload.cover_url)` → toast「请填写完整所有必填字段」，`useAdminWorks.ts:115-119`）；③ 文件约束 `MAX_MB=5` + `image/` 白名单（`WorkFormDialog.tsx:54-64`）。**无 zod/react-hook-form 实际使用**（依赖装了但表单是手写受控组件）。

### 8.7 a11y

- Radix 组件（Dialog/AlertDialog/Select/Switch/Tooltip/ScrollArea）自带 `role`/`aria-*`/焦点陷阱。
- 手写弹窗显式补 `role="dialog" aria-modal="true"`（`rh/CostConfirmDialog.tsx:28-30`），标题「确认运行」+ 文案「将调用 RunningHub AI，可能消耗 RH 币或钱包余额。」（`:40-45`）。
- `RhAccountMenu`：`aria-haspopup="menu"` / `aria-expanded`（`RhAccountMenu.tsx:110-111`），Escape 与外部 `mousedown` 关闭（`:55-71`），菜单容器 `role="menu"`（`:138`）、退出项 `role="menuitem"`（`:170`）。
- `HomeNav` 移动端菜单有 `aria-expanded` / `aria-controls`，锚点用 `handleAnchor` 阻止默认跳转（`HomeNav.tsx:100-135`）。
- **缺口**：`WorkCard` 是纯 `article`，hover 有视觉反馈但**键盘不可达、不可聚焦**（`WorkCard.tsx:8-9` 无 `tabIndex`/`role`）；`WorksGrid` 空态 CTA 有 `<Link>` 尚可；`Board`/`ApiTest` 的 pill 用 `font-mono text-xs` 装饰性文案，无 `aria-hidden`。

### 8.8 权限/管理页保护

前端**条件渲染**（`AdminWorksPage.tsx:42-44`），不是路由守卫——`/admin/works` 本身可直达，未登录只是看到 `LoginGate`。后端 `e.auth` 是真正防线（`works.pb.js:150-152`）。另有平台级 `POST /__rh_admin_sso`（`_rh_admin_sso.pb.js:14-45`）用容器内 secret 换 15 分钟 superuser token，**fail-closed**：secret 缺失/不匹配一律 403，secret 从不下发浏览器。

### 8.9 开发期与发布期技巧（本项目特色）

- **`rhSourcePlugin`**（`vite.config.ts:20-73`）：`enforce: 'pre'` + `apply: 'serve'` 的独立 Vite 插件，用 `@babel/parser` + `@babel/traverse` + `magic-string` 给**每个 JSX opening element** 注入 `data-rh-src="<相对路径>:<行>:<列>"`，供在线可视化编辑器反查源码位置。两个细节很讲究：跳过已有 `data-rh-src` 的元素；插入点必须落在 `typeArguments`/`typeParameters` 之后，否则 `<Foo<T> />` 会被插成 `<Foo data-rh-src="…"<T> />` 导致解析失败（`vite.config.ts:52-59`）。dev-only，生产 build 被 tree-shake。
- **「只刷前端 lib、不动后端 hook」的发布契约**：`llm.ts:44-58` 与 `aigc.ts:245-262` 都实现**一次性的路由代际探测**——先打扁平路由，404 才降级到按模型路由/老上传路由，结果记在模块级 `let legacyXxx: boolean | null`（同一后端只有一种代际，探测一次零开销）。`aigc.ts:370-401` 更用**参数类型多态**区分新老契约（第二参不在 `fileType` 白名单 → 判定为老契约的 `filename`，返回纯 URL 字符串），注释记录了真实事故：某 app 刷新后当天产生 190 个 `content[N].image_url is invalid` 错误。
- **迁移期兼容**：`works.pb.js:10-62` 的 `onBootstrap` 做「有则补字段、无则建表」的幂等升级；`GET` handler 里还内联 `ensureCollLocal()`（`66-83`）就地建表——**同一段建表逻辑出现 3 次**（bootstrap / list / create），是 Goja 自包含约束下的重复代价。

---

## 9. 可借鉴点 → 我们的具体落点

> 每条格式：**他们的做法（证据）→ 我们现状（证据，均已实读当前工作树）→ 建议（文件/模块，改动量，风险）**。注意 `docs/research/ui-our-baseline.md` 锚定的是旧 commit `5150829`，当前 `public/` 已明显演进（例如 `empty()` 已有 action 槽、dashboard 已有 `errBox`+重试、`aria-current` 已加），故下文现状**一律以当前代码为准**，未沿用基线文档的旧结论。

### 9-1 图片加载失败降级为「品牌占位块」而非隐藏
- **他们**：`WorkCard.tsx:6,11-23` 用 `imgError` state，失败后渲染 `bg-gradient-to-br from-primary/30 via-background to-card` + `<Film strokeWidth={1.5}/>` 占位块，尺寸不变、布局不跳。
- **我们现状**：多处用内联 `onerror="this.style.display='none'"` 直接隐藏元素——`public/js/pages/dashboard.js:131`（最近生成图片）、`public/js/pages/tasks.js:179`（任务行缩略图）；`public/js/pages/assets.js:88-90` 走 `icon-btn` 但 `<img>` 无 onerror。
- **建议**：在 `public/js/ui.js` 新增 `imgWithFallback(url, {icon, alt, cls})` helper，统一输出 `<img … onerror="…">` + 兜底占位 DOM；替换上述 3 处。**改动量 S**，风险低（纯渲染层）。落点：`public/js/ui.js`、`public/js/pages/dashboard.js`、`tasks.js`、`assets.js`。

### 9-2 竖屏 9:16 作品卡栅格（作品库/素材库展示变体）
- **他们**：`WorkCard.tsx:10` 明确 `aspect-[9/16]` + `object-cover` + hover `scale-105`；`WorksGrid.tsx:50` 栅格 `grid-cols-2 lg:grid-cols-3 xl:grid-cols-4`。
- **我们现状**：`public/css/app.css:602` `.asset-grid { grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)) }` + `:610` `.asset-card { aspect-ratio: 4 / 3 }`；`public/js/consts.js:68 ASPECTS` 支持 `9:16 / 16:9 / 1:1 / 3:4 / 4:3` 五种画幅，项目本身带 `aspect_ratio` 字段（`data/db.json` projects 样本含 `aspect_ratio`）。
- **建议**：`app.css` 增 `.asset-grid--portrait` + `.asset-card--portrait { aspect-ratio: 9/16 }`，在 `public/js/pages/assets.js` 与 `dashboard.js` 最近生成区按项目 `aspect_ratio` 切换。**改动量 S–M**，风险中（4:3 是既有视觉基线，需产品确认是否改默认，建议只加变体不动默认）。落点：`public/css/app.css`、`public/js/pages/assets.js`、`dashboard.js`。

### 9-3 删除确认文案带对象名
- **他们**：`ConfirmDeleteDialog.tsx:29-32` —「确定删除吗?」「即将删除《**{displayName || "该作品"}**》,此操作不可撤销。」`AdminWorksPage.tsx:100-102` 把 `deleteTarget?.title` 传进去。
- **我们现状**：已部分达成——`public/js/pages/projects.js:97` 的 confirm 文案含项目名。但需**核查覆盖面**：`public/js/ui.js:191 confirm(o)` 是通用件，各页调用文案是否都带名未逐一确认（未确认项）。
- **建议**：以 `confirm()` 为唯一入口做一次调用点普查，把不带对象名的危险操作补上名称；若普遍缺失，在 `ui.js` 的 `confirm` 里加 `subject` 可选参数并在标题/正文模板中统一插值。**改动量 S**，风险低。落点：`public/js/ui.js` + 各 `public/js/pages/*.js` 调用点。

### 9-4 剩余 6 处空态缺 CTA（把「指路」升级为「一键直达」）
- **他们**：`WorksGrid.tsx:31-47` 空态 = 虚线框 + 圆底图标 +「还没有上架作品」+「去后台上传第一部吧」+ 主色按钮「前往管理」→ `/admin/works`。
- **我们现状**：`public/js/ui.js:276` 的 `empty(title, desc, iconName, action)` **已支持** action 槽，且 6 处已用（`assets.js:81,102,128`、`dashboard.js:92,127`、`storyboards.js:144`、`tasks.js:141`）。**仍为纯文案无 action 的 6 处**：`projects.js:31`、`scripts.js:332`、`scripts.js:339`、`storyboards.js:120`、`images.js:215`、`videos.js:387`。
- **建议**：逐处补 `{label, go}`——`projects.js:31` → 直接触发「新建项目」弹窗（已有 `openForm(null)`）或 `#/projects?new=1`；`images.js:215` → 聚焦左侧提示词框；`videos.js:387` → 跳 `#/images`；`scripts.js:339` → 跳 `#/scripts` 生成区；`storyboards.js:120` → 保留但补「去项目管理」。**改动量 S**（每处 1 行），风险低。落点：上述 5 个页面文件。

### 9-5 骨架屏替代全站 spinner
- **他们**：`ui/skeleton.tsx:3-13`（`animate-pulse rounded-md bg-muted`）+ `board/LoadingState.tsx:3-25`（3 条骨架卡）+ `works/WorksSkeleton.tsx`（6 张 9:16 骨架，`WorksGrid.tsx:14-20` 挂载）。
- **我们现状**：全站 **0 骨架屏**（`grep -rn "skeleton" public/` 零命中）；`public/js/ui.js:281 spinner(text)` 是唯一加载态；`app.js:178-186` 的 boot 期（health → bootstrap → render）`#view` 纯空白无任何 loading（基线 §0.1 已记为缺口）。
- **建议**：`ui.js` 新增 `skeletonCards(n, {portrait})` 与 `skeletonRows(n)`（纯 CSS，复用 `app.css:482 @keyframes pulse` 或新增 `shimmer`）；优先用于 `dashboard.js`（stats 6 格 + 最近项目 + 最近生成，现为 `spinner()`，`dashboard.js:24,37,40`）、`projects.js:20`、`assets.js` 三 tab。另给 `app.js` boot 期加一个 `.boot-skeleton`。**改动量 M**，风险低。落点：`public/js/ui.js`、`public/css/app.css`、`dashboard.js`、`projects.js`、`assets.js`、`app.js`。

### 9-6 轮询间隔递增 + 按任务类型分级 deadline
- **他们**：`aigc.ts:466` `defaultDeadline = _isLongRunningModel(model) ? 30*60_000 : 8*60_000`；`:473,480` `let interval = opts.pollIntervalMs ?? 2500` → `interval = Math.min(interval + 500, 5000)`。
- **我们现状**：`lib/poller.js:45-51` `intervalMs()` 固定读设置（默认 8s，最小 2s），`maxPolls()` 固定默认 60 → 预算 ≈ 8 分钟，**无递增、无按模型分级**；`lib/poller.js:90` 已把 `poll_attempts` / `poll_interval_s` 随 SSE 下发，`public/js/pages/tasks.js` 已有「第 n 次查询」展示位。
- **建议**：`lib/poller.js` 把 `intervalMs()` 改为 `intervalMs(attempt)`，前 5 次用设置值，之后每次 `+50%` 封顶 `4×`；`maxPolls()` 按 `video_assets.model_name` 是否长任务模型分档（与 `lib/agnes.js` 的模型清单联动）。因前端已消费 `poll_interval_s`，**无需改前端**。**改动量 M**，风险中（改轮询节奏会影响 `tools/apitest.mjs` / `selftest.mjs` 中对 `poll_interval_s` 的断言，需同步跑 `node tools/run-all.mjs`）。落点：`lib/poller.js`。

### 9-7 错误响应带 `fingerprint` 追踪码并在 UI 展示
- **他们**：后端所有 handler 返回 `fingerprint: msg.substring(0, 80)`（`works.pb.js:111,190,208`；`messages.pb.js` 5 处）；`ResultPanel.tsx:66-75` 用 `font-mono` + 可选中 `<code>` 展示「追踪 ID」，`useApiTest.ts:76` 前端自造 `fingerprint: "frontend-" + Date.now()`。
- **我们现状**：`public/js/api.js:22` 只取 `data?.error` 作为 `error` 字符串，**丢弃 status 之外的响应体字段**；`public/js/ui.js:287 errBox(text, hint)` 只有两行文案，无追踪码。后端 `lib/routes.js` 是否已带 `trace`/`fingerprint` 字段**未确认**（需 grep `lib/routes.js` 的错误分支）。
- **建议**：① `lib/routes.js` 的顶层错误捕获统一附加 `trace: <短随机 id>` 并 `console.error` 同一 id；② `public/js/api.js` 的失败分支把 `data.trace`/`data.fingerprint` 透传到返回对象；③ `ui.js errBox` 增加可选第三行「追踪码 XXXX（排查时可提供给开发者）」。**改动量 S–M**，风险低。落点：`lib/routes.js`、`public/js/api.js`、`public/js/ui.js`。

### 9-8 前端请求超时与取消（`AbortSignal`）
- **他们**：`llm.ts:115-117` `AbortController` + `window.setTimeout(() => ctrl.abort(), 25000)`，并把 `opts.signal` 桥接进来。
- **我们现状**：`public/js/api.js:6-28` 的 `req()` **完全没有 timeout、没有 signal**（`grep -rn "AbortSignal\|signal" public/js` 零命中）；服务端侧有超时（`lib/agnes.js` 的 `AbortSignal.timeout(25000)`），但**前端请求若悬挂，`public/js/ui.js:317 setBusy` 的秒表会一直转**（`setBusy` 的 title 固定「模型生成通常需要 20〜60 秒」，`ui.js:325`）。
- **建议**：`api.js req()` 增加 `{ timeoutMs = 30000, signal }`，用 `AbortSignal.timeout(timeoutMs)`（Node 20+/现代浏览器均支持）+ `AbortSignal.any([...])` 合并外部 signal；超时错误文案统一为「请求超时（30s 未返回），本地服务可能正忙」。**改动量 S**，风险低（唯一注意点：生成类接口本就需要长等待，故生成调用点应显式传更长/不传 timeout——`api.genImage`/`genText`/`batchImages`/`batchVideos` 需逐个确认调用点）。落点：`public/js/api.js` + 生成类调用点（`public/js/pages/images.js`、`scripts.js`、`storyboards.js`、`videos.js`）。

### 9-9 错误文案「基线 + 原始原因」拼接（不做关键字白名单）
- **他们**：`aigc.ts:144-153` 8 类 `errorKind` → 中文基线；`aigc.ts:157-171` `formatAigcFailureMessage` 一律拼接原始错误，注释明确反对按关键字挑着拼。
- **我们现状**：`public/js/api.js:24-26` 直接回显后端 `data.error` 字符串，**前端无错误码→中文基线映射表**；不过 `public/js/pages/videos.js:310` 附近已有优秀的诊断面板三态文案（`storyboards.js:275` 也有「模型共返回 N 字符（见下方原文）」这类高质量兜底），说明我们的文案能力在页面层而不在 api 层。
- **建议**：在 `public/js/consts.js` 增 `ERROR_BASE_TEXT`（键为后端 `errorType`：`no_api_key` / `proxy_timeout` / `network_error` / `rate_limited` / `schema_error` …，值中文基线），`api.js` 失败分支输出 `{ error: base + '：' + raw }`（`base` 缺失时只用 `raw`）。**改动量 M**，风险低。落点：`public/js/consts.js`、`public/js/api.js`。

### 9-10 上传类操作的前置校验（大小 + 类型 + 行内错误）
- **他们**：`WorkFormDialog.tsx:28,54-74` `MAX_MB = 5` + `!file.type.startsWith("image/")` → 行内错误「图片不能超过 5MB」/「请选择图片文件 (jpg/png/webp)」；`aigc.ts:939` `files.slice(0, opts.maxCount)` 截断 + `:948` `i * 300ms` 错峰 + 单失败跳过。
- **我们现状**：**唯一的上传入口**是设置页备份导入 `public/js/pages/settings.js:474`（`<input type="file" id="imp-file" accept=".json">`），**无大小上限校验、无 MIME 校验**（仅 `accept` 提示，可绕过）；导入是 replace 语义，属高危操作。全站**无图片/视频文件上传能力**（`grep FormData|FileReader|readAsDataURL` 仅命中 settings 的 json 导入）。
- **建议（分两步）**：① 立即可做——`settings.js` 导入前校验 `file.size <= 20MB` 与 `file.name.endsWith('.json')`，不通过则 `toast.err` 且不读文件；同时给「导入并替换」加 `confirm()` 二次确认（若尚无）。**改动量 S**，风险低。② 中期——若要支持「封面/参考图本地上传」，需在 `server.js` 新增 `POST /api/assets/upload` 并**手写 multipart/form-data 解析**（零依赖，约 80–120 行 boundary 解析）或改用 `application/octet-stream` + 自定义 header 传文件名（更省事、更符合我们零依赖约束）。**改动量 L**，风险高（multipart 解析是真实工程量，且要防路径穿越——`server.js:247-259` 已有 `/assets/` 静态服务与 MIME 表可复用）。落点：`settings.js`（①）、`server.js` + `lib/routes.js` + `public/js/ui.js`（②）。

### 9-11 后端聚合计数，避免前端拉全量列表
- **他们**：作品列表直接返回 `{items, page, perPage, totalItems}`（`works.pb.js:64-147`），管理页靠 `perPage=200` 一次拿全。
- **我们现状**：`public/js/pages/projects.js:35` 为了在项目卡上显示「分镜/图片/视频」三个计数，**额外并发拉取 3 个全量列表**（`api.storyboards()` / `api.images()` / `api.videos()`），再用 `countBy()` 客户端聚合（`projects.js:36-43`）；数据量大时这是 O(全部素材) 的网络与内存开销。
- **建议**：`lib/routes.js` 的 `GET /api/projects` 增加可选 `?with_counts=1`，服务端在返回前遍历 `store` 的 3 个集合算出 `storyboard_count / image_count / video_count` 挂到每个 project 上；前端 `projects.js` 改读字段。**改动量 M**，风险中（**改响应形状**——按 `AGENTS.md` 注意事项 5，我们的 API 不做统一信封且形状漂移是历史事故源，故必须走「新增可选参数 + 保留原字段」的向后兼容路径，并补 `tools/apitest.mjs` 断言）。落点：`lib/routes.js`、`public/js/api.js`、`public/js/pages/projects.js`、`tools/apitest.mjs`。

### 9-12 列表卡片「错峰入场」已有，缺的是滚动触发（IntersectionObserver）
- **他们**：`useReveal.ts` 用 `IntersectionObserver` 给 `.reveal` 元素加 `.is-visible`，配 `StatsSection.tsx:17` / `FeaturesSection.tsx:58` 的 `style={{transitionDelay: `${i*80|100}ms`}}` 做「进入视口才出现 + 错峰」。
- **我们现状**：已有**纯 CSS 的静态错峰入场**——`public/css/app.css:959-960` `@keyframes revealIn` + `.grid > *:nth-child(-n+8) { animation: revealIn 320ms … both }`（只覆盖前 8 个子元素、页面加载即播，不等滚动）；`grep -rn "IntersectionObserver" public/` **零命中**；`app.css:842 .breathing` 定义后 0 引用（死类）；已有 `@media (prefers-reduced-motion: reduce)` 三处兜底（`app.css:788,973,988`）。
- **建议**：`public/js/ui.js` 新增 `revealOnScroll(root)`（`IntersectionObserver` + `threshold 0.1` + `once`），在 `app.js render()` 成功后调用；`app.css` 的 `.grid > *:nth-child(-n+8)` 规则改为 `.reveal-ready .grid > *` 全量错峰（用 `--i` 变量传延迟，替代 nth-child 硬编码 8 个上限），并在 `prefers-reduced-motion` 下直接跳过 observer。顺带删掉死类 `.breathing`。**改动量 S–M**，风险低。落点：`public/js/ui.js`、`public/js/app.js`、`public/css/app.css`。

---

## 10. 不值得借鉴 / 边界（与我们的约束冲突，为什么放弃）

| 他们的做法 | 证据 | 为什么不学 |
|---|---|---|
| **PocketBase + Goja `pb_hooks` 作为后端** | `pocketbase/pb_hooks/*.pb.js`；`aigc.pb.js:1` 头注释「self-contained」；`heibao.pb.js:38-48` 手写 `[]byte→UTF-8` | 我们是**零 npm 依赖 Node 原生 + `data/*.json`**（`AGENTS.md` 项目速览、`lib/store.js:1-16`）。引入 PB = 引入一个 Go 二进制 + JSVM 运行时 + 一套 collection 抽象，直接摧毁「单文件 SEA exe + 双击即用」的分发形态。而且 Goja 的单线程/编码限制（`aigc.pb.js` 注释警告「Goja 单线程逐字符解码会锁死 PB → 502/524」）在真 Node 里根本不存在——我们没必要自找。 |
| **VibeX 平台耦合层**：`__pb` 子路径代理、`/app-preview/app-<32hex>` basename 推导、legacy 路由代际探测、`rh_vc_deploy` / `legacyLlmRoutes` 标记、发布刷新契约 | `src/lib/pb.ts:7-24`；`llm.ts:44-58`；`aigc.ts:245-262,370-401` | 这些代码存在的唯一理由是「平台只换前端 lib、不动已装的后端 hook」。我们是**前后端同仓同版本发布**（`server.js` + `public/` 一起进 exe），不存在代际漂移，整套探测/降级/多态参数分支是纯负担（`aigc.ts:370-401` 那段注释还记录了一次 190 个线上错误的事故）。 |
| **RunningHub 账号体系与计费确认**：`RhAccountMenu`（余额弹窗、充值/会员外链、退出登录）、`useCostConfirm` + `CostConfirmDialog`、412→重新登录、`vibex_cost_confirmed_today:<appId>` 按自然日缓存 | `rh/RhAccountMenu.tsx:89-177`；`hooks/useCostConfirm.ts:32-78`；`lib/costConfirm.ts:12-39`；`llm.ts:85-87` | 我们**没有用户系统**（`lib/store.js:5-7` 注释明说「没有用户系统 → 所有 user_id 字段消失」），用户用的是自己的 API Key（`data/settings.json` 里的 `agnes_api_key`），**没有平台代扣费**。整套「运行前确认本次消耗」的对话框在我们的模型下没有对象——用户看的是 Agnes 自己的配额，不是我们的钱包。 |
| **沙箱域双契约 SSO**（699 行的 `rhLogin.ts`，全文件规模）：隐藏 iframe 静默兑换、popup 兜底、URL fragment 交接、`storage` 事件跨标签同步、`vibex-sandbox-logged-out` 防「退不出去」 | `src/lib/rhLogin.ts:18-100`（契约说明与 token 键）、`:668`（`RH_MENU_LINKS`）、`:680-693`（`openRhWindow`） | 单机本地应用运行在 `127.0.0.1:5178`，**无跨域、无跨站 cookie 分区、无控制台 origin**。整个文件对我们价值为 0。唯一可迁移的是它的**工程纪律**（所有 localStorage 访问包 try/catch、登出状态机显式建模），但那两条我们已在别处做到。 |
| **48 个 npm 依赖 + shadcn/Radix 14 组件 + Tailwind 构建链** | `package.json` dependencies（含 `recharts`/`embla-carousel`/`cmdk`/`vaul`/`next-themes`/`miniprogram-ci` 等**本 app 未使用**的包）；`vite.config.ts` | 我们**无构建步骤、零 npm 依赖**（`AGENTS.md`）。`public/js/consts.js:9-50` 手写内联 SVG 图标集就是为「断网也能正常显示」；`public/css/app.css` 是手写设计系统。引入 Tailwind 会把「改一行即生效」变成「改一行要等构建」，与本地优先/可离线/SEA 打包全部冲突。 |
| **React 每页 3–5 个 `useState` + `useEffect` 状态机** | `useWorks.ts:19-47`；`useAdminWorks.ts:38-83`；`useApiTest.ts:29-82` | 我们的页面是 `export default async function page(container, params)` + 闭包局部变量 + 返回 `cleanup` 函数（`public/js/app.js:91-93`），且有 B32 渲染序号守卫防「被取代的渲染」覆写 cleanup（`app.js:70-74,92-98`）。React 的 hooks 依赖数组/闭包陷阱（他们自己就写了 `alive` 标志、`inflightRef`、`baseUrl` ref 三种补丁，`useWorks.ts:25`、`useApiTest.ts:33`、`useBoard.ts:54`）在我们模型里不存在。**架构方向不同，不迁移。** |
| **`published=true` / `perPage=50` / `perPage=200` 硬编码查询，无分页控件** | `useWorks.ts:30`；`useAdminWorks.ts:56`；`WorksPage.tsx` 无分页 UI | 这是**反例**：>50 部作品时公开库静默丢数据且无任何提示。我们的 `public/js/api.js` 虽然也是全量拉（`api.projects()` 等），但至少有 `data/*.json` 本地 IO 的成本上限；若我们要做「作品库」类功能，必须带分页或「加载更多」，不能照抄。 |
| **管理页依赖 `pb.authStore` 但全仓无 PB 登录调用** | `useAdminWorks.ts:42,57-59,123-127,166-170,189` vs `grep pb.collection\|authWithPassword` 零命中；后端 `works.pb.js:150-152` 校验 `e.auth` | **反例 / 身份裂缝**：前端门禁看 RH 登录、写请求发 PB token、后端校验 PB auth——三者不是同一身份。按包内代码，管理页登录态恒 false。我们不学这种「用 A 的登录态去换 B 的凭证」的写法。 |
| **全站 9:16 竖屏假设**（Showcase 封面、WorkCard `aspect-[9/16]`、Stats 卡写死「9:16 竖屏短剧」） | `WorkCard.tsx:10`；`StatsSection.tsx:4`；`ShowcaseSection.tsx` | 我们**原生支持 5 种画幅**（`public/js/consts.js:68 ASPECTS`），项目数据带 `aspect_ratio` 字段，且已有横版/方形场景。把 9:16 写死进组件会直接砍掉我们一半能力。 |
| **`:root` 与 `.dark` 两份逐 token 同值的主题变量 + 装了 `next-themes` 却无调用** | `index.css:42-116` vs `118-167`（`68↔119`、`72↔123`、`83↔134`、`94↔145`…）；`grep next-themes src/` 零命中 | 我们 `public/css/app.css:10-57` 是单套暗色 token（`color-scheme: dark`，`app.css:11`），**不假装支持双主题**。要支持亮色时再加 `[data-theme=light]` 覆盖块，而不是先复制 100 行同值变量。 |
| **首页 Showcase 硬编码 3 条作品，与真实作品库不连通** | `ShowcaseSection.tsx:13-38`（`林则徐买鱼丸记`/`未命名·仙途`/`都市夜未眠`，纯 CSS 封面类）vs `useWorks.ts` 走 `/api/works` | **反例**：首页「案例展示」与「作品库」是两份真相，运营一改数据就不同步。我们若做作品库，首页展示区必须**读同一个数据源**（哪怕只取前 3 条 + 空态兜底）。 |
| **门户首页 CTA 全部指向外部域名 + 平台备案占位** | `HeroSection.tsx:3` `CTA_HREF = "http://enochcityai.hongfudesign.com"`（`HomeNav.tsx:16` / `WorksNav.tsx:29,39` 同源复用）；`FooterSection.tsx:49`「© 2025 福州以诺城文化科技有限公司 · 闽 ICP 备 XXXXXXXX 号」 | 我们是**离线可用的本地工作台**（`public/js/pages/dashboard.js:22` 明确承诺「断网不影响编辑」）。把主 CTA 指向外部站点在本地版语境下是断链风险，且与「数据不出本机」的定位冲突；备案/法务占位与本地私有工具无关。 |

---

## 附录 A：本次研读的复现命令

```bash
SRC="/Users/apple/Project/Git/Webeye-Video/docs/AI创作资料/08-AI创作项目源码/ai-remix-6f5c2140-以诺城AI漫剧平台"; cd "$SRC"
find . -type f -not -path "*/node_modules/*" -not -path "*/.git/*" | wc -l   # 139
find src -name "*.ts" -o -name "*.tsx" | wc -l                                # 69
find src -name "*.ts" -o -name "*.tsx" | xargs wc -l | tail -1                # 5806
node -e "const p=require('./package.json');console.log(Object.keys(p.dependencies).length)"  # 48
grep -n "<Route" src/App.tsx
grep -n "routerAdd" pocketbase/pb_hooks/*.js                                  # 自有端点（真实副本）
grep -n "routerAdd" templates/scaffold/templates/pb_hooks/*.js                # 平台端点（模板副本）
grep -rn "callLlm\|callAigc" src/                                             # 页面是否真调用过 AI
grep -rn "prompt\|response_format\|json_object\|extractJson" src/             # 明文 prompt / 结构化输出协议
grep -rn "authStore\|pb.collection\|authWithPassword" src/                    # 是否存在 PB 登录
grep -n -- "--radius-\|--elev-\|--font-\|--background:\|--primary:" src/index.css
grep -n "boxShadow" tailwind.config.js

cd /Users/apple/Project/Git/agnes-manga-studio   # 「我们」侧对照
grep -rn "skeleton" public/                        # 空 → 0 骨架屏
grep -rn "IntersectionObserver" public/            # 空 → 无滚动触发
grep -rn "AbortSignal\|signal" public/js           # 空 → 前端无超时/取消
grep -rn "empty(" public/js/pages/*.js             # 空态调用点与是否带 action
grep -n "asset-grid\|aspect-ratio" public/css/app.css
grep -n "^export function empty\|^export function errBox\|^export function setBusy" public/js/ui.js
grep -n "intervalMs\|maxPolls" lib/poller.js
```

## 附录 B：未确认清单（不编造，留待后续核对）

1. **VibeX 平台是否在运行时为 app 注入 PocketBase 登录态**。包内 `src/_rh_inspect.ts` 已被导出流程替换为 `export {}` 空 stub（`export-manifest.json` 的 `removed_sensitive_files` 也列了它），无法验证。这直接决定 §3.4 的「管理页身份裂缝」是真实缺陷还是导出残缺。
2. **`templates/scaffold/templates/pb_hooks/*.js` 中 `{{LLM_ALLOWED_MODELS}}` / `{{AIGC_ALLOWED_MODELS}}` 的渲染结果**（即本 app 实际可用的模型清单与参数）。模板未渲染，`pocketbase/pb_hooks/` 里也没有 llm/aigc 副本，故 §6.4 的模型与参数只能引用模板默认值。
3. **`lib/routes.js` 的错误分支是否已带 `trace`/`fingerprint` 字段**（§9-7 建议① 的前置条件）；**`public/js/ui.js:191 confirm()` 各调用点是否都带了对象名**（§9-3 的普查范围）。
4. **`public/js/api.js` 生成类调用点（`genImage`/`genText`/`batchImages`/`batchVideos`）的单次耗时分布**——决定 §9-8 加超时后应设多长，以及是否需要对生成类接口豁免超时。
5. **`GET /api/works` 的 `published` filter 用字符串比较是否可靠**：`works.pb.js:97` 传的是 `String(query.published)`（即 `"true"`），而字段是 `bool` 类型；导出包内无 `pb_data` 无法实测该 filter 是否按预期命中。前端确实传了 `published=true`（`useWorks.ts:30`）。

*（完 —— 本文件为纯研读报告，未改动源码包内任何文件，也未改动本仓库除本文件外的任何文件。）*
