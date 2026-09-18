# 竞品 UI 深研：漫剧工坊「托管版」（Vibex React SPA）

> 目的：为本地版（`public/` vanilla JS + 单文件 CSS）的界面与交互优化提供可直接落地的规格与取舍。
> 素材：`reference/manjugongfang-vibex/`（52 chunk 镜像 + `deobf/` wakaru 反混淆阅读树）。
> 方法：CSS 全量精读 + `index-D8muaCbl.js` 壳层逐行读 + 各页面 chunk 的 className/中文文案抽取。**未改动任何生产代码。**

---

## 0. 一页结论（先读这段）

| 维度 | 托管版的事实 | 我们该做的判断 |
|---|---|---|
| 视觉基调 | 暗底 + **单一金色品牌色**（`#e8c989` 一支），全站靠"白色低透明叠加"造层级，不靠多色 | 与我们同方向，**但要学它把"层级"交给 alpha 而不是彩色** |
| 质感手法 | 玻璃拟态 4 档（`glass` / `glass-heavy` / `surface-card` / `surface-elevated`）+ 一张固定背景图 + 顶部渐变压暗 | 我们已有 blur，缺的是**分档语义**与**背景层** |
| 布局骨架 | 左栏 216px（可收成 68px 图标轨，状态存 localStorage）+ 顶部**浮动胶囊 header** + 内容 `max-w-[1320px]` **内层滚动** + 移动端底部 5 tab | 我们侧栏是固定 260px 且整页滚动；**滚动容器划分**是最大结构差 |
| 组件库 | Radix（Dialog/Select/Popover/Tabs/Tooltip）+ cva 变体表 + 自研 `GlassSelect` | 我们用原生 `<select>`；**下拉与弹层的质感差是第一眼差距** |
| 动效 | 入场级联（GSAP 或纯 CSS 60ms 步进）、conic 金色流光描边、3D tilt + 鼠标光斑、hover 缩放、`prefers-reduced-motion` 全量降级 | 我们只有 `pageEnter`；**入场级联 + hover 微交互性价比最高** |
| 文案 | 错误必带下一步动作（「隔几分钟再点」「关掉先思考会明显更快」「Ctrl+Shift+R」），破坏性操作用**两段式就地确认 + 3 秒失效** | 这是竞品最强的地方，**且几乎零实现成本** |
| 长任务 | task_id 落 localStorage、轮询 2500ms、404/断网分型退避、720s 软超时、重进页面自动接续 | 我们 SSE 已有基础，**"可离开可回来"的状态持久化**值得抄 |

---

## 1. 设计令牌全表

**说明**：`assets/index--0XZmBEn.css` 是 66,726 字节 / 1 行的压缩产物。为便于定位，下文 `@n` 指**按 `}` 断行重排后的行号**（重排文件 3,313 行）；`≈B` 给原始文件的**字节偏移**，可在压缩文件里直接搜类名命中。行号仅供人工核对，不是生产引用。

### 1.1 色板（`:root`，@220–336 ≈ 3457B）

**品牌金（唯一强调色，同一支金色的四个深度 + alpha 阶梯）**

| Token | 值 | 用途 | 位置 |
|---|---|---|---|
| `--gold` | `#e8c989` | 基础金：状态点、边框、光晕源 | @253 |
| `--gold-bright` | `#f6e2b4` | 文本级高亮（选中导航、数字、`★ 我的收藏`） | @254 |
| `--gold-deep` | `#c9a25e` | conic 流光的最暗端 | @255 |
| `--gold-soft` | `#e8c98924` (14%) | 弱底：选中项背景、封面渐变端 | @256 |
| `--gold-border` | `#e8c98973` (45%) | 选中/hover 边框 | @257 |
| `--gold-glow` | `0 10px 36px #e8c98929, 0 0 0 1px #e8c98947` | 双层发光（外发光 + 1px 金描边） | @258 |
| `--brand` / `--brand-hover` | `#f2ddb0` / `#f6e2b4` | 链接与强调文字 | @275–276 |
| `--brand-soft` | `#e8c98924` | "生成中"徽标底、镜号侧栏底 | @277 |
| `--brand-gradient` | `linear-gradient(135deg,#f6e2b4,#e0b877)` | **主按钮/封面渐变** | @278 |
| `--brand-glow` | `0 6px 24px #e8c98938` | | @279 |
| `--brand-nav-active` / `-border` | `#e8c98929` / `1px solid #e8c98973` | 导航激活 | @280–281 |
| `--accent-blue` / `--accent-cyan` | 都等于 `#e8c989` | **占位残留**：命名是蓝色，值已被金色替换 | @282–284 |

> 观察：作者一度是蓝色主题，改金时把 `--accent-blue/--accent-cyan` 直接改值留名。同时 `--primary` 等 shadcn 变量被保留（HSL 三元组 `38 68% 72%` = 同一个金色），说明**它是 shadcn 底座 + 自定义金色玻璃层**的混合体。金色 alpha 阶梯：`0d/0f/1f/24/29/2e/38/47/4d/52/59/6b/73/99`（5%→60%）——一套完整的"金色透明度标尺"。

**中性 / 表面（全部是白色 alpha 叠加，不给实色）**

| Token | 值 | 语义 |
|---|---|---|
| `--bg-primary` | `#0a0a0a` | 页面底色（body 实际另有背景图，见 §2.1） |
| `--bg-sidebar` / `--bg-header` | `#0c102259` (蓝黑 35%) | 侧栏与顶栏；同一值 → 视觉上"外壳一体" |
| `--bg-card` / `--bg-card-hover` | `#ffffff14` (8%) / `#ffffff1f` (12%) | 卡片常态 / hover |
| `--bg-input` | `#ffffff14` | 输入底 |
| `--bg-elevated` | `#ffffff1f` | 浮层 |
| `--bg-quickstart` | `#ffffff14` | 快速开始卡 |
| `--text-primary` | `#ededed` | 正文/标题主色 |
| `--text-secondary` | `#c2c2c2` | 次级 |
| `--text-tertiary/-muted/-aux/-weak` | `#9a9a9a` | **四个 token 一个值**（冗余，别名层） |
| `--text-heading` | `#f4f1ea`（微暖白） | 大标题：与冷灰正文拉开"纸感" |
| `--text-body` / `--text-sub` | `#cfcabf`（暖灰） | 段落，刻意偏暖配合金色 |
| `--text-label` / `--text-badge` | `#b6b2a8` / `#d9d4c8` | 标签/徽标 |
| `--border-default` | `#ffffff2e` (18%) | 全局默认边框（`* { border-color: var(--border-default) }` @344） |
| `--border-hover` / `--border-active` | `#e8c9896b` / `#e8c98999` | 金：hover / 激活 |
| `--border-divider` | `#ffffff1a` (10%) | 分隔线（侧栏分组、footer） |

**状态色（每支都配 12% 软底 `-soft`）**

| 语义 | 主色 | 软底 | Token |
|---|---|---|---|
| success | `#3fb984` | `#3fb9841f` | @285–286 |
| warning | `#e8a23c` | `#e8a23c1f` | @287–288 |
| danger | `#f06161` | `#f061611f` | @289–290 |
| **任务状态映射** | pending/queued→`#9a9a9a`，running→`#e8c989`，completed→`#3fb984`，failed→`#f06161`，timeout→`#e8a23c` | | @291–296 |

> 关键点：**排队与等待同灰、运行用金色而不是蓝色**——"进行中"和"品牌"同色，让任何页面一眼能看到"正在跑的东西"，且不需要额外强调色。

### 1.2 圆角（@297–300 + 类）

| Token | 值 | 用在哪 |
|---|---|---|
| `--radius` (shadcn) | `.625rem` = 10px | `rounded-lg`；`rounded-md` = `calc(-2px)`=8px；`rounded-sm`=`-4px`=6px |
| `--radius-sm` | 4px | 极小元素 |
| `--radius-md` | 10px | **输入框**（`.glass-input` @389、input/textarea 用 `rounded-[10px]`） |
| `--radius-lg` | **24px** | **所有卡片/弹层**（`.glass` `.glass-card` `.surface-card` `.surface-elevated` 全是 24px） |
| `--radius-xl` | 42px | 超大容器 |
| `--glass-radius` | 24px | 玻璃件专用别名 |
| 特例 | `9999px`（按钮/nav 项/胶囊）、`[19px]`（浮动 header）、`[16px]`（<lg 的吸底条）、`[20px]`（≤767px 时卡片降为 20px） | |

> 规则提炼：**胶囊给控件，24px 给容器，10px 给输入**。三档就够，不要更多。

### 1.3 字体与字号阶梯

| Token | 值 |
|---|---|
| `--font-display` = `--font-body` | `"DM Sans","Inter","MiSans","HarmonyOS Sans","Source Han Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif` @324–325 |
| `--font-mono` | `ui-monospace,"SF Mono","JetBrains Mono",Menlo,Monaco,Consolas,"PingFang SC","Microsoft YaHei",monospace` @326 |
| 网络字体 | 仅 **DM Sans** 一个可变字体（`index.html` 预连 `fonts.googleapis.com` + `css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,400`），`display=swap` |
| `--text-xs / sm / base / lg / xl / 2xl / 3xl / 4xl` | **12 / 13 / 14 / 16 / 18 / 24 / 36 / 48 px** @314–321 |
| `--leading-body` / `--leading-tight` | 1.5 / **1.11** @322–323 |
| `--cjk-latin-shift` | `-.13em` @327（配 `.cjk-latin{font-size-adjust:.56; vertical-align:var(--cjk-latin-shift)}` @2613） |

> 三条可偷的：**① 12/13/14 三档小字**（密集工作台的主力字号），`text-sm`=13 而非 14；**② `leading-tight:1.11` 专供大标题**（`.text-2xl/3xl/4xl` 自动用它）；**③ `font-size-adjust:.56` + 负 vertical-align 修中西文混排基线**——`h1,h2,h3{font-weight:500;letter-spacing:-.02em}` @340：大标题用 500 不用 700，暗色下更"贵"。

### 1.4 间距体系（@301–308）

`--space-1..12` = **4 / 8 / 12 / 16 / 20 / 24 / 32 / 48**（4px 基准，无 6/10 档）。Tailwind 的 `p-*`/`gap-*` 全部被重映射到这些变量（如 `-left-6 → calc(var(--space-6) * -1)` @659）。实际高频组合：卡片 `p-4 sm:p-5`（16→20）、弹层 `p-5 sm:p-7`（20→28）、栅格 `gap-3`（12）/`gap-4`（16）/`gap-5`（20）。

### 1.5 阴影 / 发光（@309–315 + 组件）

| Token | 值 | 用在哪 |
|---|---|---|
| `--elev-flat` / `--elev-raised` | **`none` / `none`** | 关键决策：**投影被刻意清零**（`shadow-sm`→ring、`shadow-md`→none），层级靠 alpha |
| `--elev-ring` | `inset 0 0 0 1px #ffffff24` | 内描边代替投影 |
| `--elev-popover` | `#ffffff0a 0 3px 4.5px, #0000001a 0 10px 8px, #00000029 0 4px 3px` | 三层叠加（一层提亮 + 两层压暗） |
| `--focus-ring` | `0 0 0 3px #e8c98938` | 所有 `:focus-visible` |
| `--elev-glass` / `--elev-glass-inset` | `0 8px 32px #0000002e` / `inset 0 0 0 1px #ffffff1f` | 玻璃件 |
| 卡片 hover | `0 8px 28px #00000029` + `border-color:#e8c98959` | @356–360 |
| 激活卡 | `background:#e8c98929` + `0 0 24px #e8c98924` + 金边 | @361–365 |
| 主按钮 | `0 4px 18px #e8c9892e` → hover `0 8px 28px #e8c98952` | @500–513 |
| `::selection` | `color:#fff7e8; background:#e8c9894d` | @2617 |
| 全局 scrollbar | `scrollbar-color:#ffffff24 transparent` @2621 + `.scroll-dark` webkit 8px 圆角条 @593–606 |

### 1.6 玻璃拟态分档（@347–423 ≈ 6790B）

| 类 | backdrop-filter | 背景 alpha | 边框 | 圆角 | 阴影 | 过渡 |
|---|---|---|---|---|---|---|
| `.glass` | `blur(16px) saturate(150%)` | `#ffffff1a` 10% | `#ffffff2e` | 24 | inset ring | — |
| `.glass-heavy` | `blur(24px) saturate(160%)` | `#ffffff29` 16% | `#ffffff38` | 24 | inset ring | — |
| `.glass-footer` | `blur(16px) saturate(150%)` | `#ffffff14` 8% | `#ffffff1f` | 24 | — | — |
| `.glass-card` | 同 glass | 10% | **透明**（hover 才显金） | 24 | 0 | `bg/border/box-shadow .22s ease-out` |
| `.surface-card` | 同 glass | 10% | 透明 | 24 | 0 | `.22s` |
| `.surface-elevated` | 24/160% | 12% | `#fff3` | 24 | `--elev-popover` | — |
| `.glass-input` | —（不 blur） | `--bg-input` | `#ffffff3d` | 10 | — | `border/shadow/bg .15s` |
| `.btn-ghost-soft` | `blur(8px)` | 0（透明） | `#ffffff3d` | 9999 | — | `.15s` |

**saturate 一起加**（150%/160%）是它"玻璃不发灰"的原因。移动端（≤767px）统一**降档**：blur 8px / saturate 110%、圆角 24→20（@2624–2638）——性能与观感双兜底。

### 1.7 暗色 / 亮色模式策略（@572–592、@2592–2596、@2624）

- **只有暗色**：`:root{color-scheme:dark}` + `--lightningcss-light:;--lightningcss-dark:initial`（@221–223，lightningcss 的 light-dark 脚手架，**未实际使用**）。
- `@media (prefers-color-scheme:light)` 只做一件事：`html,body,#root{background-color:transparent}`（@2592）——即"系统亮色时不覆盖成黑底，仍露出背景图"。
- `@media (prefers-reduced-motion:reduce)` 是**完整降级表**：关掉 `reveal-in`/`reveal-stagger`、把 `gold-flow-card:before` 停成静态 55% 透明、`tilt-card` transform:none、`mouse-glow` display:none、`parallax` 取消（@572–592）。
- 结论：不要为对齐竞品去做亮色主题；**但必须补 `prefers-reduced-motion` 全量降级**（我们有 1 条，不成体系）。

---

## 2. 布局骨架

### 2.1 根结构与背景层

```
html, body, #root { min-height:100% }              @2584
body {
  background-color:#0a0a0a;
  background-image: linear-gradient(#080b1685 0%, #080b169e 55%, #080b16a8 100%),
                    url(bg-dusk.jpg);              ← 一张真实"黄昏"摄影图
  background-position:50%,50%; background-size:auto,cover;
  background-attachment:fixed;                     ← 桌面固定，≤767px 改 scroll
  overflow-x:hidden;
}
#root { position:relative; z-index:1 }             ← 内容永远在背景图之上
```
`@2597–2612 ≈ 47656B`。叠加逻辑：**照片铺满 → 半透明蓝黑渐变（52%→66% 越往下越暗）压住 → 玻璃件浮在上**。这是"黑金"显得高级的真正原因：背景不是纯色，玻璃有可穿透的东西。

### 2.2 三区骨架（`index-D8muaCbl.js` L22578 壳层，已逐行验真）

```
<div flex min-h-screen text-foreground>
 ├ <aside>            桌面左栏：hidden lg:flex，w-[216px] ↔ 折叠 w-[68px]，
 │                    transition-[width] .2s，bg-sidebar + blur20/150，右侧 1px divider
 ├ <div flex min-w-0 flex-1 flex-col>
 │  ├ <header>        sticky top-0 z-30，mx-3 mt-3 h-14 rounded-[19px] 浮动胶囊，
 │  │                 bg-header + backdrop-blur-[20px] saturate-150
 │  ├ <main ref>      class="scroll-dark flex-1 overflow-y-auto"   ← 唯一的滚动容器
 │  │  ├ <div mx-auto w-full max-w-[1320px] px-4 pt-4 pb-[78px] sm:px-6 sm:pt-6 sm:pb-6 lg:px-8 lg:py-8>
 │  │  └ <footer class="glass-footer mx-auto … max-w-[1320px]">   两行小字：品牌 + 隐私承诺
 │  └ <nav>           移动端底部 tab：fixed inset-x-0 bottom-0 z-30 h-14，lg:hidden，
 │                    padding-bottom:env(safe-area-inset-bottom)
 └ 移动抽屉（z-50）：bg-black/55 backdrop-blur-sm 遮罩 + left 260px 面板，Escape 关闭
</div>
```

要点：
1. **内层滚动**（`<main>` 自己 `overflow-y-auto`，body 不滚）。收益：header 天然吸顶、抽屉/弹层不跟着跑、`scrollTo({top:0})` 只在路由变化时对 main 生效（L22557）；代价：页面级 sticky 需要相对 main 定位。
2. **内容宽 1320px**，左右内边距 16/24/32 三档递增；底部预留 `pb-[78px]` 给移动 tab（64px tab + 14px 呼吸）。
3. **浮动胶囊 header**：不贴边（mx-3 mt-3）、自带圆角和边框，"悬浮工具条"感而非"网页通栏"感。header 内：汉堡（`lg:hidden`，h-9 w-9 rounded-full）→ 当前页标题（`text-lg font-medium tracking-tight`，来自路由名表）→ `快捷入口`外链组（lg+ 才显示，胶囊 `h-8 px-2.5 text-xs`）→ 右侧**密钥状态胶囊**（`h-1.5 w-1.5` 圆点：`bg-success`/`bg-warning` + 文字「API 已连接 / 未配置密钥」）→ 账户菜单。
4. **导航三套形态**（同一 `Wn1Component` 复用）：桌面左栏（分组 + 折叠轨）、移动抽屉（多一节"快捷入口"）、移动底部 5 tab（工作台/分镜/出图/出片/素材，`text-[10px]` + 18px 图标，激活 `--gold-bright`）。
5. 左栏导航项：`h-10 rounded-full text-sm` + `gap-3`；激活态 = **金边 + `--gold-soft` 底 + `--gold-bright` 文字 + `[&_svg]:text-[var(--gold-bright)]`**；非激活 hover = `bg-white/[0.04]`。分组标题 `text-xs tracking-wider text-muted`；折叠成轨时组标题变 `h-px w-6` 小横线（L19920–19924）。
6. 折叠状态持久化：localStorage key `agnes.sidebar.rail`（L19905）；折叠按钮 title 写得很人味：「收起菜单（只留图标，给工作区腾地方）」/「展开菜单（显示栏目名称）」。
7. 错误边界（L20129）：崩了渲染一张 `surface-card` 居中卡——标题「这一页出了点问题」+「你的项目和素材不受影响」+ 两按钮「重试这一页」「返回工作台」。

### 2.3 响应式断点策略

Tailwind 默认 640 / 768 / 1024 / 1280；**语义分工**：
- `<640` 单列、卡片 20px 圆角、blur 降档、底部 tab + 抽屉、`pb-[78px]`。
- `sm` 起：项目/统计类栅格 2 列；`md` 起：3 列、表单双列；`lg` 起：左栏出现（移动 nav 隐藏）、参数面板分栏生效、4–6 列。
- **`max-lg:` 反向断点**用于"移动端才需要的那套壳"：吸底操作条 `max-lg:sticky max-lg:bottom-[68px] max-lg:z-20 max-lg:rounded-[16px] max-lg:bg-[var(--bg-elevated)] max-lg:p-2 max-lg:shadow-lg max-lg:backdrop-blur-xl`（@3001–3036）——**同一条操作条在桌面是 sticky 卡、在移动是浮起的胶囊**，这个写法很值得记。
- 面板分栏模板（全在 CSS 里，可直接当规格用）：
  `lg:grid-cols-[minmax(340px,410px)_minmax(0,1fr)]`（出图参数|结果）、`[…430px…]`（出片）、`lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_150px]`（分镜镜号栏|内容|缩略）、`lg:grid-cols-[2fr_3fr]`（Home 双栏）、`lg:grid-cols-[minmax(0,1fr)_280px]`（主内容+右 rail）、`sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]`（写稿台 1:1.6）。
- 栅格列数惯用：`grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6`（Home 6 统计卡）、`grid gap-4 sm:grid-cols-2 lg:grid-cols-4`（4 统计/快速入口）、`grid gap-5 md:grid-cols-2 xl:grid-cols-3`（项目卡）、`grid-cols-2 gap-3 md:grid-cols-3`（图/视频结果）。
- 表格用 `min-w-[820px]/[920px]/[960px]` + 外层横向滚动（Tasks/Admin）；`lg:hidden` 的卡片列表与 `hidden lg:block` 的表格**成对出现**——移动看卡、桌面看表。

---

## 3. 组件清单

### 3.1 按钮体系（`button-BkuGevd-/chunk_o.js` L101–118，cva 表，已逐字读）

**基座（所有按钮共享）**：`inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-normal transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0`

> 三条硬规矩：**① 一律胶囊 `rounded-full`**（没有方按钮）；**② 图标自动 16px + shrink-0 + pointer-events:none**（子选择器 `[&_svg]` 统一处理，业务代码里仍重复写 `h-4 w-4`，属小瑕疵）；**③ disabled = `pointer-events:none` + `opacity:.5`**，注意 `pointer-events:none` 会让 disabled 按钮的 `title` 不显示——他们靠"把禁用原因写在按钮文字里"绕过（见下）。

| variant | 规格 |
|---|---|
| `default` | `bg-primary text-primary-foreground hover:bg-primary/90`（金底 + 深棕字 `#2a1e0b`） |
| `destructive` | `bg-destructive`（`hsl(0 62% 58%)`）`text-destructive-foreground` hover `/90` |
| `outline` | `border border-[var(--border-hover)] bg-transparent text-foreground/85 hover:bg-white/[0.06] hover:text-foreground`（**hover 是白色叠加，不是金色**——次要按钮保持中性） |
| `secondary` | `bg-secondary text-secondary-foreground hover:bg-secondary/80` |
| `ghost` | `hover:bg-white/[0.06] hover:text-foreground`（无底无边） |
| `link` | `underline-offset-4 hover:underline` |

| size | 规格 |
|---|---|
| `default` | `h-10 px-4 py-2`（40px） |
| `sm` | `h-9 px-3` |
| `lg` | `h-11 px-8` |
| `icon` | `h-10 w-10` |

**另有两支脱离 cva 的"语义类"（CSS 里，实际用得最多）**：
- `.btn-accent-gradient`（@10668）：金渐变 `linear-gradient(135deg,#f6e2b4,#e0b877)`、字色 `#2a1e0b`、`box-shadow:0 4px 18px #e8c9892e`、hover `filter:brightness(1.05)` + `transform:none` + 阴影升到 `0 8px 28px #e8c98952`、disabled `opacity:.5;cursor:not-allowed`。**hover 明确写 `transform:none`**——主按钮不飘，只有亮度和光晕变，避免与 tilt 打架。
- `.btn-ghost-soft`（@11060）：`backdrop-filter:blur(8px)` + `border:1px solid #ffffff3d` + 胶囊；hover 三件事一起变：文字 `--gold-bright`、边框 `--gold-border`、底 `#e8c9891f`。
- 页面里最常见的实操组合：`btn-accent-gradient inline-flex h-10 items-center gap-2 px-8 text-sm font-medium`（主）与 `btn-ghost-soft inline-flex h-9 items-center px-4 text-sm`（次），另有 `border-dashed` 变体表示"占位/未开放"。
- **禁用原因进文案**：主 CTA 三态 `请先配置密钥 | 正在拆镜头… | 生成分镜`、`请先配置密钥 | 生成中… | 生成`。用户永远知道"为什么点不了"，不需要 tooltip。

### 3.2 卡片三件套（CSS @6790–8783）

| 类 | 用途 | 规格 |
|---|---|---|
| `.surface-card` | **默认卡**（全站绝大多数容器） | blur16/150 · `#ffffff1a` · `border:1px solid transparent` · r24 · 无阴影 · `transition .22s` → hover `#ffffff24` + `border:#fff3` |
| `.glass-card` | 可点/可选中卡 | 同上，但 hover 上**金边 + 阴影**，且 `[data-active=true]`/`.is-active` = 金边 + `#e8c98929` 底 + `0 0 24px #e8c98924` |
| `.surface-elevated` | 弹层/下拉/浮起条 | blur24/160 · `#ffffff1f` · `border:#fff3` · r24 · `--elev-popover` |

> 设计语法：**边框平时透明、hover 才出现**（`border-color` 从 `transparent`→白/金）= 静止时"只有面没有线"的干净感，交互时才显结构。这一条我们完全没做。
> 组合卡：`gold-flow-card tilt-card surface-card` + 子元素 `.mouse-glow`（三件套叠加，用于"值得被点击"的重要卡：项目卡、快捷入口、引导横幅）。

### 3.3 GlassSelect（重点拆解）

`GlassSelect-O_OQdBC4.js` = **Radix Select 全量 + 一层玻璃封装**（L2930–2960）。它不是自绘下拉，是把 Radix 的 Select 套上我们的 token。

| 部位 | 规格 | 行为 |
|---|---|---|
| Trigger | `flex h-10 w-full items-center justify-between rounded-md glass-input px-3 py-2 text-sm` + `[&>span]:line-clamp-1` + `data-[placeholder]:text-muted-foreground`；实际页面多用覆写 `glass-input h-9 w-full justify-between px-3 text-sm` | 高度 36/40 两档；文字溢出省略 1 行；未选时用 placeholder 着色（不是 value 为空） |
| 箭头 | `h-4 w-4 opacity-50` chevron-down | Radix `ScrollUp/Down` 按钮则是 `flex cursor-default items-center justify-center py-1` + `h-4 w-4` chevron |
| Content | `relative z-50 max-h-[--radix-select-content-available-height] min-w-[8rem] overflow-y-auto overflow-x-hidden rounded-md surface-elevated` + `origin-[--radix-select-content-transform-origin]`；页面覆写 `max-h-72`（288px） | **popper 定位**（默认），可用高度写进 CSS 变量，靠视口自动翻转；`data-[side=bottom]` 时额外 `translate-y-1` 让开 4px |
| 进出场 | `data-[state=open]:animate-in fade-in-0 zoom-in-95`、`data-[state=closed]:animate-out fade-out-0 zoom-out-95` + 按 side 的 `slide-in-from-*-2` | **0.15s**（`.animate-in` 默认），scale 起点 .95，**transform-origin 跟随对齐边**（Radix 变量）——所以从 trigger 那头"长出来"而不是原地缩放 |
| Item | `relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50`；左 gutter `absolute left-2 h-3.5 w-3.5` 放对勾 | **固定 32px 左缩进给勾**（未选中留空位，不错行）；hover 与键盘 focus 共用 `focus:` 态（金色 `--accent`）；`pl-8` 也让 GroupLabel 与 Item 文字天然对齐 |
| GroupLabel | `py-1.5 pl-8 pr-2 text-sm font-semibold` | |
| Separator | `-mx-1 my-1 h-px bg-secondary/20`（**负 margin 让线通到边**） | |

> **`GlassSelect` 的真名不副实之处（= 我们能白捡的一条）**：它内部还留着一整套 Radix 组合件（Trigger/Content/Item/Group/Separator/Viewport），但对外只导出了一个 `RiComponent`，实际调用只有 **value/options/onChange/placeholder/emptyText/id/className** 六个 props（L2946）。空值用一个哨兵 `__glass_all__` 映射成"全部"选项（L2945/2954），options 为空或含 `value:''` 时高亮该项——**"全部"是一个真实 option，而不是 placeholder**，这是对的。选项体 `text-xs`、面板 `max-h-72`、`surface-elevated` 玻璃、原生键盘导航 + portal + 视口翻转。
> **另一处更实用的"GlassSelect"用法**（ShotReferencePanel L337）：Popover 版组合框 = `surface-elevated min-w-[14rem] w-[var(--radix-popover-trigger-width)] p-1` + 顶部搜索 `glass-input h-8 pl-8` + 放大镜 `-translate-y-1/2 text-muted-foreground` + `max-h-72 overflow-y-auto` + 分组（`★ 我的收藏` 金色标题 / 普通组灰标题）+ 空态「没有匹配的预设」+ **底部内联"新建自定义"表单**（`maxLength=16` 名称 + `rows=2 maxLength=200` 描述 + 校验红字 `text-[10px] text-[var(--danger)]`）。即：一个控件同时是选择器 + 搜索器 + 创建器。

**适配到我们 vanilla JS 的做法**：不做 Radix。用 `<button aria-haspopup="listbox">` + 一个 `position:fixed` 的 `<div role="listbox">`（按 trigger rect 定位、`getBoundingClientRect` 判上下翻转、`max-height:min(288px, 视口余量)`），列表项 `padding-left:32px` 预留勾位，键盘 `↑↓/Enter/Esc/Home/End` + 首字符跳转，进出场 `opacity+scale(.95→1)`+`transform-origin` 按翻转方向切。**成本：中。**

### 3.4 弹窗 / 抽屉（`dialog-CeL5rpcU.js` L1876–1879）

| 部位 | 规格 |
|---|---|
| Overlay | `fixed inset-0 z-50 bg-black/55 backdrop-blur-sm` + `animate-in fade-in-0 / animate-out fade-out-0` |
| Content | `fixed left-[50%] top-[50%] z-50 grid max-h-[90dvh] w-[calc(100%-1.5rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto rounded-[24px] surface-elevated p-5 duration-200 sm:p-7` |
| 入场 | `fade-in-0 zoom-in-95 slide-in-from-left-1/2 slide-in-from-top-[48%]`（**from-top 48% 与 translate -50% 只差 2% → 视觉上"轻微上浮 + 放大"**，不是大幅滑入），`duration-200` |
| 关闭钮 | `absolute right-4 top-4 rounded-full opacity-70 hover:opacity-100 focus:ring-2` + X 图标 `h-4 w-4` + `sr-only`"Close"；打开时 `data-[state=open]:bg-white/[0.08]` |
| Header | `text-xs font-medium tracking-wider text-[var(--text-muted)]`（eyebrow）→ `mt-2 text-lg font-medium text-foreground`（标题）→ `mt-3 text-sm leading-relaxed text-muted-foreground`（说明），内容区 `max-w-2xl` |
| Footer 按钮 | 主 `btn-accent-gradient inline-flex h-10 items-center px-4/px-5 text-sm font-medium`；次 `btn-ghost-soft inline-flex h-10 items-center px-4 text-sm`；危险 `inline-flex h-10 items-center rounded-md bg-destructive px-4 text-sm font-medium hover:brightness-110 focus-visible:shadow-[var(--focus-ring)]` |

**其它浮层的 z 阶梯**：header `z-30` → 移动吸底条/浮层 `z-20` → toast pill `z-50` → dialog `z-50` → **mention 菜单 `z-[70]`**（必须盖过 dialog，因为写稿台可在弹窗内）。

### 3.5 Toast / 内联反馈（两条通道，分工明确）

1. **浮起 pill toast**（仅 4 处：Images/Videos/AssetManager/Library）：
   `glass-heavy fixed bottom-6 right-6 z-50 animate-in fade-in slide-in-from-bottom-4 rounded-lg px-4 py-2.5 text-xs font-medium duration-300` — 小、玻璃、右下、从下 16px 淡入、0.3s。**缺陷**：`bottom-6`(24px) 与移动底部 tab(56px + safe-area) **重叠**，全站只有 tab bar 写了 `padding-bottom:env(safe-area-inset-bottom)`，toast 没有。
2. **`actionHint` 内联横幅**（Projects 9 处 / Story 21 处 / Storyboard **57 处**）：state 变量 + `actionKind:'ok'|'err'|'idle'`，渲染在页面顶部固定位置，不自动消失。成功/失败都写在这里，**长文案（带下一步动作）不会被 toast 定时冲掉**。
3. 卡片级错误：`surface-card border-[var(--danger)]/30 bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]`；行内小错误 `rounded-md bg-[var(--danger-soft)] px-3 py-2 text-xs`；警告条 `border-l-2 border-l-[var(--warning)]`（**只加左边 2px 色条**，其余保持卡样式）。
4. 按钮内反馈：复制成功 → **按钮文案自己变**「正文已复制」+ `setTimeout(…,1600)` 复位。

> 结论：**"临时性" 用 toast、"结果性" 用内联横幅**。我们的 `toast()` 目前承担了全部职责，长错误文案体验差。

### 3.6 输入类

| 组件 | 规格 |
|---|---|
| `.glass-input`（CSS @7912） | `background:var(--bg-input)` · 字色 `#f4f1ea` · `border:1px solid #ffffff3d` · **r10** · placeholder `#c8c4baa6`（暖灰 65%）· `transition border/shadow/bg .15s` · `:focus-visible` = `border-color:var(--gold-border)` + `box-shadow:var(--focus-ring)`（3px 金环） |
| Input | `flex h-10 w-full rounded-[10px] glass-input px-3 py-2 text-base md:text-sm` + `file:*` 定制 + `focus-visible:ring-2 ring-ring` + disabled `opacity-50` |
| Textarea | `flex min-h-[80px] w-full rounded-[10px] glass-input px-3 py-2` + `md:text-sm`；业务常用覆写 `min-h-24 / min-h-28 / min-h-80`（**没有 JS 自动增高**，靠固定 `min-h` + `resize`） |
| **MentionTextarea**（16KB 自研） | 见 §4.3/4.4。核心：高度可**拖拽调整并持久化** `agnes.prompt.h.*`，常量 `g=72 / _=640`（min 72px、max 640px），`ResizeObserver` + `Math.round(getBoundingClientRect())` 记录，300ms debounce 写 localStorage。**这是全站唯一"用户可控尺寸"的输入** |
| 字数 | 底栏 `font-mono`「${n} 字」——**mono 显示计数，不抖动** |
| 数字输入 | `type=number min=1`（集数）、单集时长 `placeholder「可选」` |
| 建议值 | 类型/平台/比例用 **`<input list>` + `<datalist>`**（可自由输入 + 有建议），不是 `<select>` 硬约束 |

### 3.7 状态徽标 / 骨架屏 / 空状态 / 进度

- **StatusBadge**（`status-badge-DeREE08w.js`，整读）：`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium` + 前导点 `h-1.5 w-1.5 rounded-full bg-current opacity-70`（**点用 `bg-current`，永远和文字同色**）。8 状态→色/中文双表：`pending/queued`=等待中/排队中（`bg-secondary/15 text-muted-foreground`）、`in_progress/running`=生成中（`--brand-soft` + `text-accent` 金）、`completed`=已完成（绿）、`failed`=失败（红）、`auth_required`=需密钥（红）、`timeout`=超时（黄）。可覆写 label（镜头卡用「图词就绪/待补图词」等 4 枚）。
- **Skeleton**（`skeleton-Cuij6oW_.js`，整读）：`animate-pulse rounded-md bg-secondary/20` + 外部传尺寸。**没有 shimmer，只有 2s opacity .5 呼吸**；关键在于**骨架块尺寸逐个写死以同构真实布局**（Home：`h-10 w-56` / `h-5 w-80` / `h-11 w-32` / `h-24 w-full` / `h-[104px]` / `h-[136px]` / `h-80`）。
- **EmptyState**（`empty-state-JHVe7LkL.js`，整读）：`flex flex-col items-center justify-center gap-3 py-10 sm:py-16 text-center` + 图标座 `h-12 w-12 rounded-full bg-secondary/15 text-muted-foreground`（内 20px 图标）+ 标题 `text-sm font-medium text-foreground` + 可选描述 `text-xs text-muted-foreground` + `action` 插槽。props：`{icon,title,description,action,className}`——**空状态必带一个动作**。
- **进度**：没有全局 progress bar 组件；进行中用 (a) StatusBadge 金色 + (b) 按钮内 `animate-spin` 图标 + (c) 批量操作用 `已完成 n/t` 文字计数。**并发进度用文字而非百分比**——因为服务端本来就不给百分比。

### 3.8 标签页 / 分段器 / chips

- Tabs（Radix）：`data-[state=active]:bg-secondary/25 data-[state=active]:text-foreground data-[state=active]:shadow-sm`（`shadow-sm`→`--elev-ring` 内描边）——**激活态是"轻底 + 内描边"，没有下划线**。
- Library 的类型 tab：`全部/图片/视频/文本`，`inline-flex h-8 items-center rounded-full bg-primary/10 px-3 text-xs font-medium text-primary`（选中）vs `btn-ghost-soft inline-flex h-8 items-center border border-border px-3 text-xs`（未选）。
- 单选型选择（草稿类型、画风预设、素材类型）：**chip 组**`rounded-full border px-2.5 py-1 text-xs transition` + 选中 `border-primary bg-primary/10 text-primary`；分组标题 `text-[10px] font-medium text-[var(--gold-bright)]`（收藏/自定义用金色标）。
- **ReferenceAssetChips**：`inline-flex items-center gap-0.5 rounded-full border border-[var(--border-default)] py-0.5 pl-2 pr-1 text-xs` + 尾部 × 按钮 `hover:text-[var(--danger)]`（**删除才变红，平时中性**），hover 整枚 `hover:border-[var(--brand)]`；空态加一枚 `border-dashed border-primary/40 text-[11px] text-primary hover:bg-primary/10` 的"＋添加"胶囊。

### 3.9 图片/视频卡与灯箱

- 结果卡：`surface-card group relative overflow-hidden`，封面 `block aspect-square w-full overflow-hidden bg-secondary/15`（**先给底色再放图，加载时不塌**），图 `h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]`（**hover 500ms 缓放 3%**）。
- 角标：`absolute right-1.5 top-1.5 z-10 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground shadow`。
- 次级缩略：`h-20 w-32 object-cover transition duration-300 group-hover:scale-[1.04]` + 居中浮层 `absolute inset-0 bg-background/45 opacity-0 transition group-hover:opacity-100`（桌面 hover 出现，移动 `hidden sm:flex` 换成长按/点击预览）。
- 历史/参考行缩略：`h-20 w-32`（128×80）与 `h-7 w-7`（mention 行内）两种尺寸反复出现，可当"缩略图标准档"。
- 卡底工具行：`flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-xs`，动作按钮统一 `inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground`（**图标按钮不画边框，hover 才有底**）+ 危险 `text-destructive hover:bg-destructive/10` + 分页 `ml-auto rounded bg-destructive px-1.5 py-1 text-[10px]`。

### 3.10 虚拟滚动？分页？

- Storyboard：**整集全量渲染，无虚拟滚动、无分页**（`mt-4 space-y-3`）。分镜量级（每集几十条）下 DOM 可承受。
- Library：**真分页**（「上一页 / 下一页」+「共 ${total} 条」）；资产素材区默认折叠，只展开前若干条 +「还有 N 个资产素材，全部展开」。
- Tasks：桌面表格 `min-w-[920px]` 横向滚动 + 移动卡列表；服务端分页 `page/perPage`。
- Projects：无分页 UI，取 `perPage:100`。
- 搜索/筛选状态持久化到 localStorage：`agnes.filter.image.mode/.keyword`、`agnes.filter.video.mode/.keyword`（**下次进页面记得你上次的筛选**）——托管版有这个，值得我们抄。

---

## 4. 页面级 UX 流程

> 标 ⭐ = 「他们做了、我们没做或明显做得弱」。逐页给"信息架构 → 关键交互 → 规格"。

### 4.1 Home 工作台（`Home-DnyXfpCL/chunk_F.js`）

区块顺序（已登录、`accountReady` 后）：**① 问候行** → **②密钥状态条** → ③`dashError` 横幅（可选） → **④ 6 张 KPI 统计卡** → ⑤新手引导条 → ⑥快速开始 4 卡 → ⑦底部双栏 `lg:grid-cols-[2fr_3fr]`：最近项目 + 近期任务。

- **问候行**：时段 5 档「夜深了 / 早上好 / 中午好 / 下午好 / 晚上好」+ 昵称（空则兜底「创作者」）；右侧摘要句 `今天已出 ${n} 张图、${m} 条视频，继续推进你的故事。` / 无产出时 `继续你的漫剧创作，或开始一个新的故事。`；行尾「新建项目」主按钮。
- ⭐ **6 张 KPI 卡**（项目/图片/视频/进行中/待处理/素材）：`grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6`；卡内三段 `13px 标签 → text-2xl font-semibold 数字 → 13px hint`；**整卡是 Link**（点卡直达对应页）；hint 是解释口径而非装饰（「今日成功出图」「近七日有更新」「失败 / 超时任务」「本机保存」）；只有「待处理」`danger:true`，值 >0 时数字变红——**全页唯一语义变色**。图片/视频/待处理/素材四项由本机 `localAssets` 统计 `Promise.all` 覆盖服务端值（服务端数字只做兜底）。
- ⭐ **快速开始 4 卡** = `reveal-stagger` + `gold-flow-card` + `tilt-card` + `.mouse-glow` 的**全特效集中营**（写故事/做分镜/生成图片/生成视频），副标题直接印流程「故事 → 分镜 → 出图 → 成片」；**无密钥时整组降级** `border-dashed + opacity-60` 不可点 + 标题行挂「请先配置 Agnes API Key」下划线链——*能力门禁用视觉降级表达，不弹错误*。
- ⭐ **最近项目是"卡内列表"不是网格**：行 `rounded-lg border bg-secondary/10 px-4 py-3 hover:border-[var(--border-hover)]`；字段 = 项目名 + `[genre,platform,ratio].join(' · ')||'尚未填写风格'` + `「${n} 分钟前更新」` + 右侧「N 集」胶囊；**行下方三个文字链「继续创作 / 看素材 / 看任务」= 把"我上次卡在哪一步"直接摊开**。区块头内联「新建」ghost 按钮。
- ⭐ **近期任务卡有"需要处理"优先态**：`failedTasks>0` 时先出红框「有 ${n} 条需要处理」+ 前 3 条（StatusBadge+模型名），正常才 `slice(0,6)` 列流水；底部「查看全部任务」。
- ⭐ **引导条一次性且会退化**：`guideSeen`（localStorage `agnes.guide.seen`）未看过 → `gold-flow-card` 横幅「新手？看一遍引导，六步出片」+「查看使用引导」+「看过」(eye 图标)；看过之后**不删除，退化成右对齐小字链「使用引导」**（可随时再看，不占地方）。
- ⭐ **骨架屏与真实布局逐块同构**：`h-10 w-56`+`h-5 w-80`（标题）/`h-11 w-32`（按钮）/`h-24 w-full`（引导）/`6×h-[104px]`（KPI，**同断点同列数**）/`4×h-[136px]`（快捷）/`2×h-80`（双栏）。切页不跳版式。
- 未登录：`mx-auto max-w-3xl py-10 sm:py-16` 的 hero（`text-3xl sm:text-4xl md:text-5xl` 大标题 + 免责「本站不提供公共生成额度，也不会代扣费用。」+「使用主站账号登录」）；`accountReady=false` 时 spinner「正在确认登录状态…」。

### 4.2 Projects 项目页（`Projects-BTHbvbVT/chunk_ee.js`）

- 页头：eyebrow「项目管理」+「你的漫剧项目」+ 诚实的能力说明「**没有密钥仍可建项目和浏览，但不能生成。**」+ 右侧「新建项目」`btn-accent-gradient h-10`；下方 4 统计卡 `grid gap-4 sm:grid-cols-2 lg:grid-cols-4`，第 4 卡「生成准备」的值位**放文案「已就绪 / 待配置」而不是数字**。
- 网格：`grid gap-5 md:grid-cols-2 xl:grid-cols-3`；入场 `useStaggerReveal(ref,[items])` + 每卡 `data-reveal-item`。
- 单卡：`gold-flow-card tilt-card surface-card group flex h-full flex-col overflow-hidden` + `useTilt({max:4})` + `.mouse-glow`。**封面 `aspect-video` 不是图片**，而是 `bg-gradient-to-br from-[var(--gold-soft)] via-white/[0.04] to-transparent` + 两团 `blur-2xl/3xl` 光斑，hover `brightness-110`——**没有封面图也能好看**（我们本地版同样没有项目缩略图，这条直接可抄）。四角布局：左上 genre 胶囊 / 右上操作菜单 / 右下「layers + N 集」/ 内容区名→`line-clamp-2` 简介→标签胶囊→相对时间→`mt-auto` 动作行「进入 / 素材 / 任务」。
- ⭐ **操作菜单 hover 才显形但键盘可达**：`opacity-0 group-hover:opacity-100 focus-within:opacity-100`（`focus-within` 是关键的无障碍补丁）；`aria-label="项目操作菜单"`；菜单 `surface-elevated absolute right-0 top-11 z-20 w-40 p-1`，外点 mousedown + Escape 关。
- ⭐ **新建/编辑弹窗字段用 `input+datalist` 而非硬 select**：类型[都市,奇幻,校园,古风,科幻,悬疑]、平台[短视频,漫剧,动画,竖屏剧]、比例[16:9,9:16,1:1,4:3] 默认 16:9、集数 `number min=1`、单集时长「可选」——**有建议但不禁自由输入**。
- ⭐ **画风字段 = 输入框 + 三组 chip 一键填入**（「★ 我的收藏」金字节 / 「我的自定义」/ 内置分组）：chip `rounded-full border px-2.5 py-1 text-xs`，选中 `border-primary bg-primary/10 text-primary`，**再点一次取消**（toggle），`title` 挂完整提示词；placeholder 直接教操作「点下方风格一键填入，或自己描述」；底下解释为什么值得填：「选定画风后，分镜出图与生成视频都会统一使用这个风格，镜头之间画风更一致。」
- ⭐ **复制(duplicate) 的"部分成功"文案**：`已复制为「X」，文稿、分镜与素材都带过去了。` vs 失败态 `项目档案已复制，但本机内容同步失败，副本可能不全；可删除副本后重试。`——**双写操作必须区分"全成/半成"**。busy 时整个菜单被替换成「处理中…」胶囊。
- **删除用 modal（全站唯一一次）**，且描述内嵌影响清单 + 自救路径：`「${name}」删除后不会出现在列表里；同时会一并清除保存在本机的该项目分镜、文稿、素材与成片。如需保留，请先到素材库导出备份。` 按钮「先留着 / 确认删除 / 正在删除…」。
- 无搜索/筛选/排序 UI（固定 `perPage:100, sort:'-updated'`）——**规模小时不做筛选是合理的克制**。

### 4.3 Story 写稿台（`Story-tDMLhRH5.js`）

**单列上下堆叠**（不是左右分栏）：页头 → 密钥卡 → 错误/操作横幅 → 写稿台卡 → 正文卡 → **sticky 底栏** → 「本项目文稿」历史。写稿台内部才不对称双列 `sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]`（输入 1 : 上一稿 1.6）。

- ⭐ **草稿类型 = 带 hint 的 chip 单选组（7 项）**：故事构思(冲突、人物和钩子) / 剧情梗概 / 分集大纲 / 人设 / 世界观 / 单集脚本 / 剧本优化(基于上一稿润色)——**每个选项自带一行说明，选择器自己解释自己**。
- ⭐ **条件校验用文案而不是禁用**：选「剧本优化」但没上一稿 → `优化请先点选历史文稿，或把上一稿贴进输入区。`
- ⭐ **@素材 mention**：`@`+≤24 非空白字符触发；隐藏镜像 div 复制 23 个文本样式属性算 caret 坐标；`fixed z-[70] min-w-[220px] max-w-[280px] rounded-xl shadow-xl`（portal 到 body，**z-70 是为了盖过 dialog**），下方空间 <150px 时**自动上翻**（`maxHeight=min(320,上方余量)`）；头行「引用素材参考图」；素材 >8 且多类型时出 filter chips「全部/角色/场景/道具」；行 = `h-7 w-7` 缩略图（拉不到图显类型首字）+名称+kindLabel 尾标；**无参考图的素材 `opacity-70` + 「缺参考图」但仍可选**；空库 → 「当前项目还没有素材（素材按项目归档）」+「＋ 上传素材」**菜单内闭环建素材**；无匹配 → `没有匹配「${query}」的素材`；`↑↓/Enter/Tab/Esc` 全支持，**`isComposing || keyCode===229` 时不劫持按键（IME 守卫）**；插入 `@名字 ` 尾随空格并把光标放到后面。提交时 `@([^\s@，。；、,！!？?…]+)` + 名字前缀最长匹配 → 参考图（story 上限 4）+ 正文剥离 @。
- **输入框标签即说明书**：「补充说明（支持 @素材 看图写稿）」；placeholder `题材、人物、集数、平台口吻；写 @ 可引用素材参考图，让模型看图写稿。`（模型不支持图输入时**自动降级成不带 @ 的那句**）。旁边常驻「＋ 上传素材」。
- **底栏**：`surface-elevated sticky bottom-0 z-20 max-lg:bottom-[68px] rounded-2xl px-5 py-4 shadow-lg`。左 = 模型 chip（`当前免费/限时免费/经典版`，选中 `bg-primary/10 ring-1 ring-primary`）+ **Thinking 胶囊开关**（仅支持的模型显示；title「开启后模型先思考再下笔，出稿慢一些但结构更稳；默认关」；偏好持久化 `agnes.text.prefs`）。右 = `font-mono`「${n} 字」+ 清空/复制/导出 + 主按钮三态 `请先配置密钥 | 生成中… | 生成`。
- ⭐ **生成历史 = 可点开的卡片，且带"另存/续写"分支**：`md:grid-cols-2`，卡 = 类型胶囊 + mono 模型名 + 标题 + `line-clamp-3` 预览；**整卡一个 `absolute inset-0` 透明按钮**（sr-only「打开 ${title}」）→ 回填正文/提示词/上一稿；当前打开卡 `border-primary bg-primary/5`；就地两段确认删除（3s 复位）。
- ⭐ **「拿这篇去拆分镜」的脏稿守门**：只在 `canGoBoard`（有项目 + 有已存文稿 id + **正文与已存版本严格一致**）时出现该按钮 → `/storyboard?projectId=&scriptId=`。**跨页动作要求内容已落盘**，杜绝"带着没保存的稿子跳页"。
- 复制反馈用**按钮文案自变**「正文已复制」+ `setTimeout(...,1600)` 复位；失败 `复制失败，请手动选择正文`。登录过期横幅 + `API_KEY_REQUIRED` 实时把 `hasKey` 打回 false（顶栏圆点当场变黄）。

### 4.4 Storyboard 分镜页（`Storyboard-C507aRxc/chunk_ve.js`，1681 行）

**没有"分镜表/卡片双视图"切换**——是**折叠卡列表**承载 17 字段分镜表，表格以「导出 csv」的形式存在。

- 折叠卡：左信息栏 `sm:w-40 bg-[var(--brand-soft)] p-4` = **大字镜号 `text-2xl sm:text-3xl font-semibold text-accent`** + grip 拖拽柄 + `aspect-square group-hover:scale-105` 缩略（链去出图页）+「${shot_size||未标景别} / 第 N 集 / 时长」；右侧 scene/action 摘要 `line-clamp-2`（兜底「空白镜头」「暂未填写动作与构图」）+ 台词一行 + 4 枚状态徽标 + 按钮组。**扫一眼靠左侧金色镜号栏，读内容靠右**——同一视觉模式复用于所有行。
- 展开编辑：17 字段 `grid gap-3 md:grid-cols-2`；**短字段 input、长字段（动作/台词/图词/视词）`md:col-span-2` textarea `min-h-20`**；单行「保存本镜」→ `镜头 ${shot_no} 已保存。`
- 逐镜徽标：图词就绪/待补图词、视频词就绪/待补视频词、图片已生成/未生成、视频已生成/未生成（就绪=绿，缺=灰）。
- ⭐⭐ **拆镜提交 = 可离开的后台任务**（本页最大亮点，全部常量已逐一验真）：
  1. 提交前门禁三连：`请先配置 Agnes API Key` / `请先新建或选择一个项目。` / `请先选择或粘贴一集脚本。`；按钮三态。
  2. 提交 → task_id + 时间戳写 localStorage `agnes.shots.task.${pid}` → `已提交后台拆镜，大约 1~3 分钟；可以离开本页，回来会自动接上结果。`（**先给时间预期，再给"可以走"的许可**）。
  3. 轮询 **2500ms**；404 → **3000ms** 后重试一次（窗口 **60000ms**）；`task_missing` 且 <**120000ms** 且非续跑/非自动重试 → 整单自动重发一次；网络异常 → **4000ms** 退避，累计 **15 次**后放弃。
  4. 软超时 **720s** → `拆镜还在后台进行，稍后回到本页会自动接上结果。`（**不报失败，改成"任务还活着"**）；进页面时任务 <**900s** 自动接续 `接上刚才的拆镜任务，正在后台等结果…`。
  5. 成功 → 按 `shot_no` 逐条 upsert + 删除多余旧镜（**替换式落库**）→ `已生成本集 ${n} 条镜头（编号从 1 起，替换旧结果），只保存在本机。` → 自动选中首镜。
  6. ⭐ 失败诊断带 **9 阶段中文流水线名**：请求组装 / 模型调用 / 响应解读 / 内容提取 / 输出清洗 / 镜头解析 / 镜头校验 / 结果保存 / 结果读回 → `拆镜在「镜头解析」这一步失败（上游返回 ${status}）：${msg}（模型输出开头：${前 80 字}…）`；超时类再补一句**可执行建议 + 代价提示**：`隔几分钟再点「生成分镜」通常能成功；若开着「先思考再拆镜」，关掉会明显更快。`；身份对不上 → `请强制刷新页面（Ctrl+Shift+R）后等一两分钟再回来，结果会自动接上。`
- ⭐ **批量补词/批量优化：整集维度两个按钮，不是"全选 checkbox"**：「补齐缺词」（只补缺不覆盖）与「优化已有词」（覆盖），**串行 1 条 await**（不并发，避免打爆队列）；按钮运行中变 **`停止补词 ${done}/${total}`**（进度写进按钮文案，不另开进度条）；可随时中断且**可续跑**：`已停止补词：完成 ${n}/${t}，成功 ${r} 条；再点「补齐缺词」会从剩余的继续。`；登录态过期自动中断并说清续法；完成 `已补齐 ${r} 条提示词，整集可以直接去出图了。`；部分成功 `补词完成：成功 ${r} 条，失败 ${n-r} 条；失败的可在对应镜头里单独再点一次补词。`
- ⭐ **覆盖保护的两段式确认**（全站统一语法）：已有图词时首点只出提示 `该镜头已有图片提示词，再点一次「生成图片词」会覆盖它。`，按钮变 destructive 色「确认覆盖图片词？」（`useTwoClickConfirm`，**3000ms** 自动复位，`pendingFillKey=${id}:${kind}`）；优化版再补一句 `（可先复制留底）`。
- 逐镜补词上下文：项目 `visual_style` + `ratio` + 17 字段（逐行 `镜头编号：…`）+ 该项目素材档案（`角色·${name}：${prompt}`）；**优化指令是一段超长规则文**（外观英文关键词逐字复用 / 抽象情绪改可见元素 / 背景只微动 / 主体不大范围位移 / 直接输出英文不解释）。
- ⭐ **拖拽排序 + 乐观更新 + 失败回滚**：镜号旁 `grip-vertical cursor-grab active:cursor-grabbing`，drop 目标 `ring-2 ring-[var(--gold-border)]`，落位后逐条 PATCH 编号 → `镜头顺序已更新。`；失败**整表还原** → `顺序保存失败，已还原。`
- 其他：`新增空镜头`（shot_no=max+1）/`清空本集 N 个镜头`（两段确认）/`导出文稿`（txt，含「图片已生成：是/否」）/`导出表格`（**csv + BOM**，17 列，`分镜表格已导出，可用 Excel / WPS 打开。`）；页头 4 统计卡（本集镜头/已有提示词/**图+视频齐备**用 `border-[var(--brand)]` 高亮/项目）；⛔ 明示职责边界「**出图和成片不在这一页，拆完再过去。**」+ 页尾三跳「去出图 / 去出片」（自动带 `projectId&episode&mode=storyboard` 或镜头级 `shotId`）/「回故事」；无虚拟滚动、无分页（整集全渲染）。

### 4.5 Images 出图页（`Images-DuZOaAHv.js`，89KB）

- **骨架**：页头（eyebrow mono uppercase「Agnes 漫剧工坊」+ h1「图片生成」+ 一句说明 + 右上「当前 N 张」）→ 项目条（`glass-input h-9 w-56` + 无项目时给「去新建一个」链）→ **模式页签** → `grid items-start gap-5 lg:grid-cols-[minmax(340px,410px)_minmax(0,1fr)]`（左参数 340–410px，右结果）。
- **模式 = 4 张按钮卡（不是下拉）**：`grid grid-cols-2 gap-2 sm:flex sm:flex-wrap`，每卡 `主标题 + 10px hint`（文生图/「提示词生成图片」、图生图/「提示词 + 单张参考图」、多图合成/「提示词 + 多张参考图」、批量生图/「多组提示词逐条生成」），选中 `border-transparent bg-primary text-primary-foreground`。**模式差异一次可读完毕**。
- 参数面板 = 可折叠 `surface-card`（chevron 折叠态持久化 `agnes.composer.collapsed.image`；折叠后只留标题行 + 展开链）。**模型不给选择**，只在标题行右侧放金色 pill「Agnes Image 2.5 Flash」+ title「当前唯一可用的图片模型，免费」——**没得选就别做下拉**。
- ⭐ **比例/分辨率 = 可视按钮组**：分辨率 `1K/2K/3K/4K`（由模型 `size_map` 按像素积 <2.1M/<6.1M/<11.5M 自动归一）；比例 **8 档 pill** `rounded-[10px] border px-2 py-1.5 text-xs font-medium`：1:1、3:4、4:3、16:9、9:16、2:3、3:2、21:9，**选中即反色填充**（`bg-primary text-primary-foreground`）。
- **画风 / 光影 两行**：`w-9 标签 + GlassSelect + ☆收藏 + 「存为项目默认」`；下拉是**带搜索的浮层**（`搜索预设…` + 分组：画风 6 组/光影 4 组 + 置顶「★ 我的收藏」金字节 + 「我的自定义」节 + **底部内联新建自定义表单** +「跟随项目画风（xxx）」首项 +「不带画风/不带光影预设」）。
- ⭐ **常用参数 pill**：收藏过的「分辨率+比例」组合成胶囊（`rounded-full border py-0.5 pl-2 pr-1`，点 label 套用、点 × 删除）+ 虚线「存当前」；toast「已存为常用参数」约 2s 自隐。
- ⭐ **提示词框的工具栏**（label 行小按钮，`text-[11px] text-muted-foreground hover:text-primary`）：`@素材`（title「弹出素材候选，点选即在光标处插入（打不出 @ 符号时点这里）」——**替无法输入 @ 的场景兜底**）/`AI 优化`/`最终提示词`（**发送前 diff 预览**）/`大屏编辑`（弹层 `max-w-3xl`，可切全屏 `min-h-[46vh]/[70vh]`，右下实时「{n} 字」，「这里的修改实时同步到原提示词输入框」）；高度用**三档循环按钮** 紧凑100/标准170/加高300 + `resize-y` 拖拽，记忆键 `agnes.prompt.h.${persistKey}`；**草稿按项目持久化** `agnes.draft.image.prompt.${projectId}`（batch/shots 同构三键）。
- ⭐ **「最终提示词」预览**：把"项目画风+光影+你的描述+@素材注入后的结果"拼成的实际发送体展开给人看，可复制，顶部注明「仅供确认，不会改动上方输入内容」——**把隐藏的服务端拼装变成可见**。
- **参考图区**（文生图隐藏）：`border-dashed py-6` 拖拽盒，拖入 `border-[var(--brand)] bg-[var(--brand-soft)]`；「本地上传」+ URL 输入「或粘贴图片链接」；上限 5（`最多 5 张，先删掉一张再加`）、>50MB 拦截；缩略 `grid grid-cols-3 gap-2` `aspect-square`；⚠ 下方 hint 讲清生命周期「这里的图只作当次生成参考，几小时后自动删除；想反复使用，悬停缩略图点『存为素材』后输入 @ 引用」——**"临时 vs 持久"用一句话划开**。
- 提交行：`参考 N 张 · 存为素材` mono 计数 + 金色 pill「引用素材图已开启」（hover 出「自动注入已启用，关闭后仅文字描述」）+ 主按钮（批模式「批量生成 n 张」）。
- **结果网格**：`grid grid-cols-2 gap-3 md:grid-cols-3`，卡 `surface-card group relative overflow-hidden` + `aspect-square` 图 + `object-cover transition duration-500 group-hover:scale-[1.03]`；右上「当前分镜图」徽章（title「该镜头的当前分镜图，生成视频时作为首帧」）、meta 行 mono 模型名、操作条 预览/导出到设备/**复用提示词**/**复用参数**/在素材库/去生成视频/两步删除。筛选 pills `全部/文生图/图生图/多图合成/批量`（选中 `bg-primary`）+「搜提示词…」（localStorage `agnes.filter.image.*`）；**24 张/页传统分页**（非虚拟滚动、无时间分组）。
- ⭐ **批量管理模式**：「批量管理 → 退出管理」切换后出现 `h-5 w-5` 圆角复选浮层 + 底部胶囊条「已选 n 张（本页 m 张）」「全选本页/清空选择」「删除所选(n) → 再点一次确认删除」。
- ⭐ **批量任务面板**（批模式左栏下方）：呼吸点 `h-2 w-2 animate-pulse bg-primary` +「{done}/{total}」+ `h-1.5 rounded-full bg-secondary/20 > bg-primary transition-all duration-500` + 失败区（`scroll-dark max-h-40`，逐条「失败」+原因+截断 prompt）+ **「重跑失败条目」**；说明「批量逐条提交，结果逐张写入素材库；失败条目可一键重跑」。
- ⭐ **分镜出图模式 `?mode=storyboard`**：镜头行 = 编号方块 `h-10 w-10 rounded-md bg-primary/10` +「镜头 N」+「已出图 2 张/待出图」+ 逐条状态词（排队中/生成中/失败｜原因/完成）+ **行内提示词框** + 缩略 `h-20 w-32 sm:h-28 sm:w-52`；头部「已出图 x/y 条」+「整集批量出图」（按钮实时文案「出图中 3/12」）+ 汇总 `本次需要出图 N，成功 s，失败 l，跳过已有 a；缺提示词 r 条未处理`。**"跳过已有"是可重复执行（幂等）批处理的关键**。
- 历史图片不能设分镜图 → 「该图为早期历史图片，暂不能设为当前分镜图」；mention 未匹配 → 「${e} 未找到对应素材，按普通文本处理」（warning，不阻断）。

### 4.6 Videos 出片页（`Videos-7gBXxEVO.js`，111KB）

- 布局与 Images **同构**（`lg:grid-cols-[minmax(340px,410px)_minmax(0,1fr)]`），4 模式（文生视频/图生视频/首尾帧/参考图），模型 caps 决定可用模式与 `maxRefImages:5`。
- **时长 = 秒数 pill 组**（4~12 共 9 档，选中反色）+ 比例 5 档；三行预设选择（画风/光影/**运镜**）各带「☆收藏」+「存为项目默认（进入本项目自动套用）」；`agnes.video.prefs`、`agnes_style_override_video`（临时覆盖「本次不带画风」）。
- **参考图区随模式变形**：图生视频=单图；首尾帧=「首帧 / 尾帧图（第一张为首帧，第二张为尾帧）」+「按顺序取图，**可拖到前后调整首尾帧**」；参考图=「按顺序，最多 5 张」+「顺序即传入生成服务的参考图顺序」。
- ⭐ **并发 ≤2 + 排队自动重试**：批量说明「每行一组提示词，**最多并发 2 个任务**。提交后任务自动进入进度表，轮询完成后成片进入素材库。」；通道级排队横幅「${模型}的生成通道排队已满，${n} 秒后自动重试」+「取消自动重试」——**75 秒倒计时，`setInterval(…,1000)` 每秒 -1**，归零自动重提（Images 同款）。
- ⭐ **轮询/退避参数**：启动 2000ms → 稳态 **2500ms/轮** → 出错**指数退避 ×2、封顶 8000ms**；全局轮询上限 **900s** → `pollTimedOut` 停轮并在任务卡提示「查询已超时，点右上角『继续查询』恢复。」（**超时不判死，给手动续命入口**）。
- ⭐ **成片自动落盘 + 幂等**：`completed && !asset_saved` → 拉 `result_url`→blob→存 IndexedDB（附 note「视频以链接形式保存，链接可能过期，建议尽快导出」）→ 置 `asset_saved` → toast「视频生成完成，已保存到本机」/「本轮 3 个视频生成完成，已保存到本机」。**用户全程不点保存**。
- **任务进度 aside**（右栏顶部）：行 `rounded-lg border px-3 py-2 hover:border-[var(--border-hover)]` = StatusBadge + 模式名 + mono 模型 + 创建时间 + 进度条（`h-1 bg-[var(--brand)]`，失败段 `bg-[var(--danger)]`）；完成后行内「查看成片」`bg-[var(--brand-soft)] text-accent`；空态虚线框「暂无进行中的任务，提交后进度显示在这里。」
- ⭐ **失败可解释可批量恢复**：行「重跑」（title「按原参数重新提交」）；头部「**重跑全部失败（n）**」title「把失败的任务按原参数逐个重新提交，单个失败不影响其余」；**专错专治**：「原图是本机素材的临时链接已过期，请在分镜出图后重新出片」「参考素材刷新失败，请稍后重试」（重跑前先刷新引用）、「任务记录已过期，请按原参数重跑」。
- **分镜出片模式**：镜头行状态词全序 `已完成 / 排队中 / 提交中 / 生成中 N% / 失败｜{原因} / 待提交 / 提交失败 / 未生成`；⭐ **双缩略对照** = 首帧图 `h-20 w-32 sm:h-28 sm:w-52`（hover 描边 `group-hover:border-primary`，title「这是出片用的首帧（当前分镜图）。同一镜头出过多张图时，点它去图片页指定用哪张」）+ 成片（hover 播放遮罩 + 左上「成片」标）；时长 pill title「出片时长（按分镜定的秒数就近取档）」；汇总 toast 三分法「已提交 c 条镜头出片，进度看下方任务 / l 条提交失败，原因已标在对应镜头 / i 条缺分镜图没提交，可先回去补图或单镜出片」。
- **成片网格**：`aspect-video` 缩略（`<video preload="metadata" muted>`）+ `scale-[1.03] duration-500`；无分页（客户端过滤全量）；⭐ **「连播」大屏审阅**：「按当前列表顺序大屏连播，一条播完自动接下一条」，弹窗内「上一条/下一条」+「连播 开/关」+「已是最后一条」——**漫剧逐镜审片的真实工作流**。

### 4.7 Assets 资产设定（`Assets-qRRIcoW9.js`）／ AssetManager 素材管理 ／ Library 素材库

**三页职责**：`/assets`=角色·场景·道具**设定卡**（可 @ 引用）；`/asset-manager`=生成产物的**落盘与预览抽屉**；`/library`=**按项目浏览**的全量素材库。

- Assets：页头「资产设定」+「管理角色、场景与道具的参考图与设定，生成时会自动带入。」；**三 tab = 角色/场景/道具**（选中 `border-[var(--gold-border)] bg-[var(--gold-soft)] text-[var(--gold-bright)]`，未选 `btn-ghost-soft`）+ 搜索「搜索名称…」+ 视图切换（**网格/列表两套并存**，`aria-label="切换视图"`）；工具条「提取 / 上传素材 / 批量出图」+ 折叠后浮出「提取资产设定（从文稿）」胶囊。
  - 网格：`grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4`，卡 `surface-card group relative overflow-hidden`（**卡本体就是 `<button>`，点卡=开抽屉**）；缩略 `aspect-[3/4]`（角色竖构图），视频 `aspect-video` 居中卡 `max-w-[260px]`；右上收藏 ☆（激活 `text-[var(--gold)]`+描边，常显不 hover-out）；底部蒙层 `opacity-0 group-hover:opacity-100` 内藏**两个均分大按钮「生图 / 生视频」**+ 右下「参考 N」计数 pill；卡底 meta 条：名称 + 「主图 / 缺参考图」+ mono 变体词 + 红点（缺参考图）+ 删除（**两步式，3s**）。
  - ⭐ **「从文稿提取资产设定」**：Dialog 内 文稿/类型/集数 三下拉（集数 `第 ${e} 集 · ${titles.length} 条镜头`）→「开始提取」→ 进度行「提取中，请稍候…」+ 阶段文案（**`extract_progress` 为 0 时显示「正在排队或解析文稿…」而非 0% 假进度**）+ 条 `h-1.5 bg-[var(--brand)]` +「取消提取」（`cancelled` 态）→ 结果**差异预览表**（新增/更新/未变 +「${n} 张（新增 ${m}」）→「确认入库」→ `提取完成：新增 a 项，更新 b 项`。**AI 写入本地数据前先看 diff 再确认**——这是全站最重要的模式。
  - ⭐ **批量出图三态**（`BATCH_ALL=1 / BATCH_MISSING_ONLY=2 / BATCH_SELECTED=3`）+「重跑失败项」+ 完成汇总「批量出图完成：共 n 项，成功 x，失败 y」+ 逐条 `名称 · 变体词 → 状态（失败带原因）`；「已选 n / 本页 m」+ 全选本页 / 清空。
  - **AssetDrawer**（点卡滑出）：`fixed inset-y-0 right-0 z-50 w-[min(420px,100%)] … surface-elevated animate-in slide-in-from-right duration-300` + 遮罩 `bg-black/60 backdrop-blur-sm`；内容 = `aspect-[3/4] max-h-[46vh] object-contain` 主图（点击开 Lightbox）+ **参考图网格 `aspect-square` 内嵌 `<video preload="metadata" muted>`（视频缩略即视频首帧）** + 虚线「+ 添加参考图」+ 名称 inline-edit + 类型 chip + 设定 textarea（placeholder「性格、外形、服装、标志性特征…（支持 @素材 看图写稿）」）+ 变体行（折叠/展开，chip「自定义变体」，新增 `regen_*` 异步落库）。
  - ⭐ **Lightbox = 完整键盘工作台**：`fixed inset-0 z-60 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm`，`img max-h-[78vh] max-w-[92vw] object-contain`，`tabIndex={-1} + autoFocus` 后 `onKeyDown` 处理 **←/→ 切换（带循环）、Esc 关闭、Space 切换视频播放/暂停**（视频 `max-h-[70vh] max-w-[80vw] autoplay loop muted playsInline`）；右上「n / total」mono 计数 + 标题 + 类型 + 名称 + 变体 pill。
- AssetManager：同一组件树，**顶栏多「项目」下拉**；`assetType=characters|scenes|props|library` 四 tab；库缩略 `aspect-square`（含 `kindLabel==='视频'` 播放钮）；`localAssets` 元数据视图；视频「下载」用 `<a href={url} download>` 直连。
- **Library（`/library`）按项目浏览 + 批量导出**：项目筛选 GlassSelect「全部项目/未分组/未命名项目」+「全部 / 资产素材」双 tab + 类型 tab 图片/视频/文本 + 搜索「按提示词/标题搜索」+ 计数「共 ${n} 条」；**分页 30/页**「上一页/下一页」（**不是无限滚动、不是虚拟列表**）。
  - ⭐ **「资产素材」可引用子视图是另一套卡**：`grid grid-cols-2 sm:3 lg:4`，卡 `transition hover:ring-1 hover:ring-primary/40`（**hover 用 ring 不用 border，不抖布局**）；缩略缺失兜底 = 18px 类型首字（角色/场景/道具）；名称 `truncate text-[13px]` +「共 N 张参考图」/「缺参考图」+ 补图按钮 +「主图」角标。
  - 素材卡：`aspect-square` + 右上收藏（**仅 `favEditable` 时给 button，否则 span，避免无意义可点**）+ 类型角标 `rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] text-white backdrop-blur`（**图上信息一律半透明黑 pill + blur，不画彩色遮罩**）；meta 行项目名 + 截断提示词 + mono 时间 + 导出/移动到项目（GlassSelect「移动到：…」）/删除。
  - **文本素材点开**：Dialog `max-w-2xl`，`whitespace-pre-wrap max-h-[52vh] glass-input p-4 text-sm leading-relaxed` + 复制全文/导出 txt（`agnes-文稿-${title}`）。图片/视频点开：`fixed inset-0 z-50 bg-black/60 backdrop-blur-sm p-6` + `onClick=close` + 内层 `stopPropagation` + **`max-h-[70vh] rounded-md` 媒体**。
  - ⭐ **打包导出**：「把当前筛选下的素材打包成一个 zip 导出到设备（上限 200 条）」，按钮文案切「打包中…」+ toast「已导出 ZIP」/「导出失败，请重试」。**批量导出以"当前筛选"为范围**，不需要先手工多选。
  - ⭐ 空态带**因果链 + 出路**（不是"暂无数据"）：「还没有素材 / 去图片或视频页生成一批，就会汇总到这里；想用自己的图？点上方「上传素材」，存好的在「资产素材」页签里，写稿时就能 @ 引用」+「去生成」。
  - 收藏持久化 `agnes.preset.favorites.v1`（**上限 30，超限 toast「收藏已满，请先取消一个再收藏」**）。

### 4.8 Tasks 任务中心（`Tasks-BERQG5aA.js`）

- 页头 eyebrow「TASK CENTER」+ 定位句把范围讲死：「视频生成是异步任务，记录会汇总在这里；**图片与文字都是即时完成，成果直接进素材库**。这里可以看进度、查失败原因、继续查询未完成的视频、删除自己的记录。」
- KPI 四卡 `grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4`：任务总数 / **进行中（hint「等待 / 生成中」`text-accent`）** / 已完成（「成功出结果」绿）/ 失败（「失败 / 超时 / 需重登」红），数字 `mt-2 text-xl font-semibold sm:text-2xl`。
- 筛选条 `surface-card flex flex-wrap items-center gap-4 p-4`：三个 GlassSelect = 类型（只有"视频"是异步）/ 状态（进行中=pending+running、失败=failed+timeout+auth_required）/ 项目（`h-9 w-40`）。**"失败"是个合并桶，hint 把成员写出来**。
- **并发状态展示**：移动 `divide-y lg:hidden` 卡片流 ↔ 桌面 `hidden lg:block overflow-x-auto` 表格 `min-w-[820px]`（同源双渲染）；表头 `text-xs font-medium uppercase tracking-wider`；行 `hover:bg-secondary/10`；**进度 = 行内 `h-1.5 w-20 rounded-full bg-secondary/20 > bg-[var(--brand)]` + `text-xs tabular-nums`「N%」双件**（移动用 `flex-1`）。
- ⭐ **重试/继续入口**：「继续查询」（仅视频且未完成；该行轮询时按钮变「查询中」，`pollingId===task.id` 单行锁）、「查看错误/收起错误」（展开虚线框 `border-dashed bg-background/60 p-3 text-xs`，无详情兜底「无错误详情。」）、「查看产物」（按 type 跳 /images、/videos、/story）、「删除」。
- ⭐ **轮询尊重可见性**：只在有进行中视频任务时开 `setInterval(…, 6000)`，**`document.hidden` 时跳过**；手动"继续查询"用 `Promise.all` 同步全部未完成任务再刷新。
- 分页：服务端 `perPage:200`，**客户端每页 20 条**，底栏「第 N / M 页」+ 上一页/下一页（`totalPages≤1` 隐藏）；时间 `YYYY-MM-DD HH:mm` + `tabular-nums`。删除确认「删除后无法恢复，**且不会取消已经在远端跑的生成。**」——把副作用讲清楚。空态「暂无任务」+ 三引导 CTA「写一集故事 / 去出图 / 去成片」。

### 4.9 Settings（`Settings-DUrV1QzN.js`）

- 结构：页头「API 与模型」+「本页不会发起故事、出图或成片」+「返回工作台」→ 两卡并排 `grid items-stretch gap-5 lg:grid-cols-[2fr_3fr]`（密钥 2fr / 默认模型 3fr）+ 独立「账号标识」卡（`font-mono` ID + 复制，反馈「已复制」1600ms 复位）；两卡入场 `animate-in fade-in slide-in-from-bottom-4 duration-500`。
- ⭐ **密钥四态 + 掩码 + 校验时间**：`未配置`（warning pill + 虚线警告框「尚未配置密钥。未配密钥时不能生成，但已有项目和素材仍可查看。」按钮「测试并保存」）/ `已连接`（success pill + `key_mask` mono + 「上次校验 {zh-CN, hour12:false}」，按钮变「更新密钥」）/ `需重新保存`（「这把密钥在当前环境解不开了…下面重新粘贴一次并保存即可恢复，项目与素材不受影响。」）/ **校验中**（无独立徽标，主按钮切「测试中…」并禁用）。
- **校验前置为保存前提**（verify 成功才落库）；结果行三种 `verifyKind`：err 红框 / ok 绿字「Agnes API Key 已连接」/ idle 灰字；错误码全表见 §4.11。
- 输入 `glass-input pr-10 font-mono text-sm` + **右内嵌 eye 切换明文**，placeholder `sk-…`；「了解更多」折叠说明（加密保存/不保留多把/仅中国站）+ 常驻警示「请使用 **Agnes 中国站（agnes-ai.cn）** 签发的 API Key。国际站的 Key 无法连接本站…填入会一直提示校验失败或连接不上。」
- ⭐ **模型选择：可选项 pill + 不可选项"诚实展示"**：按 文本/图片/视频 三行 pill；**付费未开放项 = 虚线描边 pill `cursor-not-allowed border-dashed opacity-60` + 后缀「· 付费模型｜暂未开放」**——用文案而非隐藏处理供给边界。保存按钮 **dirty 才可点**（未变更时 disabled 且 title「当前选项与已保存的一致」）。
- 危险操作：描边 danger `border-[var(--danger)]/50 bg-[var(--danger-soft)] hover:bg-[var(--danger)]/15` → Dialog「删除密钥？」+「删除后会立刻失去生成能力。已有项目、文本、图片和视频仍可查看，但无法再发起新的故事、出图或成片。」按钮「先留着 / 确认删除」。

### 4.10 Login（`Login-BNGC4uIT.js`）

- 全屏 + 纯装饰背景层（`aria-hidden`）：`bg-gradient-to-b from-background/25 via-transparent to-background/70` + 两团大光斑（`-top-44 h-[420px] w-[680px] rounded-full bg-primary/10 blur-3xl`；底部 `h-[380px] w-[540px] bg-accent/10 blur-[64px]`）。中央卡 `gold-flow-card tilt-card reveal-in w-full max-w-md rounded-3xl bg-[var(--bg-elevated)] p-8 shadow-2xl backdrop-blur-2xl` + `useTilt({max:3})` + `.mouse-glow`。品牌区：pill「AGNES STUDIO」`tracking-widest` → `text-4xl font-bold text-primary` → 副标。
- 单按钮 `h-12 w-full rounded-full bg-primary text-base font-semibold shadow-lg transition-all duration-300 hover:bg-primary/90 hover:shadow-xl` + 箭头 `group-hover:translate-x-1`；三态文案 pending/success/idle + 状态横幅 `animate-in fade-in slide-in-from-bottom-2`。**`setInterval(…,1000)` 轮询登录态，上限 45 次（≈45s）判失败**；成功 `navigate(来源路径 ?? '/')` **回跳发起登录前的页面**（`agnes.returnTo`）。页脚两行「登录沿用主站账号 · 项目与素材按账号隔离」「素材与成片仅保存在你自己的浏览器，不会上传服务器」。**零表单页**。

### 4.11 错误码 → 文案映射全表（`ShotReferencePanel-*` / Settings / studio-context）

| 码 / 条件 | 中文文案（要点） |
|---|---|
| `INVALID_AGNES_API_KEY` | 无效或无权限。请确认复制的是中国站 Key，国际站无法使用 |
| `AGNES_UNREACHABLE` | 暂时无法连接 Agnes 服务（附中国站提醒） |
| `CREDENTIAL_ENCRYPTION_FAILED` / `CREDENTIAL_SAVE_FAILED` | 密钥校验成功，但保存失败，请稍后重试 |
| `USER_DISABLED` | 账号已被禁用，暂时无法保存密钥 |
| `key_required` | 请输入完整密钥后再测试并保存 |
| `rh_login_required` / 401 / 412 | 登录态已过期，请重新登录后再继续 → 跳登录 |
| `MODEL_NOT_AVAILABLE` / 付费未开放 | 「付费模型｜暂未开放」（禁用 pill，不发请求） |
| 队列满（排队闸） | 「${模型}的生成通道排队已满，${n} 秒后自动重试」+「取消自动重试」（75s 倒计时） |
| `task_missing` | 上一次的后台拆镜已经结束，直接重新点「生成分镜」即可 / 整单自动重发一次 |
| 轮询超时（720s/900s） | 拆镜还在后台进行，稍后回到本页会自动接上结果 / 查询已超时，点「继续查询」恢复 |
| 拆镜阶段失败 | 「拆镜在「${9 阶段之一}」这一步失败（上游返回 ${status}）：${msg}（模型输出开头：${80 字}…）」 |
| 本机链接过期 | 原图是本机素材的临时链接已过期，请在分镜出图后重新出片 |
| 带诊断字段 | 追加「技术细节：阶段 {diag_stage} \| 类型 {diag_err_name} \| {diag_err_msg}」 |

**文案语法（可归纳成 5 条）**：① 先说发生什么、再说下一步做什么；② 给"时间预期"（1~3 分钟 / ${n} 秒后重试 / 等一两分钟）；③ 给"更快路径"（关掉先思考会明显更快）；④ 说明副作用边界（删除任务不会取消远端生成 / 素材仍在、只是这次没拿到地址）；⑤ 兜底永远是「请稍后再试」+ 一个可点的重试按钮，不出现技术黑话或 stack。

---
