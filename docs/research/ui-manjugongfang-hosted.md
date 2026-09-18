# 竞品 UI 深研：漫剧工坊「托管版」（Vibex React SPA）

> 目的：为本地版（`public/` vanilla JS + 单文件 CSS）的界面与交互优化提供可直接落地的规格与取舍。
> 素材：`reference/manjugongfang-vibex/`（52 chunk 镜像 + `deobf/` wakaru 反混淆阅读树）。
> 方法：CSS 全量精读 + `index-D8muaCbl.js` 壳层逐行读 + 各页面 chunk 的 className/中文文案抽取。**未改动任何生产代码。**

---

## 0. 一页结论（先读这段）

| 维度 | 托管版的事实 | 我们该做的判断 |
|---|---|---|
| 视觉基调 | 暗底 + **单一金色品牌色**（`#e8c989` 一支），全站靠"白色低透明叠加"造层级，不靠多色 | 与我们同方向，**但要学它把"层级"交给 alpha 而不是彩色** |
| 质感手法 | 内容区实际只靠 **`surface-card` + `surface-elevated` + `glass-input`** 三个类撑起来（18/9/17 个文件在用）；`.glass*` 家族是**壳层与 toast 专用**。层级来自"白色低透明 alpha 阶梯"，不是彩色 | 我们不用复制整套玻璃家族，**做 5 个类 + 令牌表就够**（见 §1.6） |
| 布局骨架 | 左栏 216px（可收成 68px 图标轨，状态存 localStorage）+ 顶部**浮动胶囊 header** + 内容 `max-w-[1320px]` **内层滚动** + 移动端底部 5 tab | 我们侧栏是固定 260px 且整页滚动；**滚动容器划分**是最大结构差 |
| 组件库 | Radix（Dialog/Select/Popover/Tabs/Tooltip）+ cva 变体表 + 自研 `GlassSelect`（导出面只有 6 个 props）；品牌质感靠 **5 个全局 CSS 类**而非组件 | 本地版 25 处原生 `<select>`；**下拉与弹层是第一眼差距**，但那 5 个 CSS 类才是更高性价比的入手点 |
| 动效 | 入场级联（GSAP 或纯 CSS 60ms 步进）、conic 金色流光描边、3D tilt + 鼠标光斑、hover 缩放、`prefers-reduced-motion` 全量降级 | 本地已有同曲线 `revealIn`（320ms / `cubic-bezier(.22,1,.36,1)` / 45ms 步进 / ≤8 档，`app.css:950–958`）+ `pageEnter`；**缺的是 hover 微交互与卡片质感分档** |
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

**⚠ 这张表不要照抄成"必做清单"**——按逐 chunk 精确计数，真实用量是：`surface-card` **18 文件** · `glass-input` **17** · `btn-accent-gradient` **17** · `btn-ghost-soft` **16** · `surface-elevated` **9** · `glass-heavy` **5**（就是那 5 处 toast）· `glass-card`/`glass`/`glass-footer` 各 **2 且只在壳层 index chunk**。**页面内容区几乎只用 `surface-card` + `surface-elevated`（浮层）+ `glass-input`**，"玻璃拟态"里的 `.glass*` 家族实际是**壳层专用**。本地版只要实现 `surface-card / surface-elevated / glass-input / btn-accent-gradient / btn-ghost-soft` 这 5 个类，就拿到绝大部分观感。

### 1.7 暗色 / 亮色模式策略（@572–592、@2592–2596、@2624）

- **只有暗色**：`:root{color-scheme:dark}` + `--lightningcss-light:;--lightningcss-dark:initial`（@221–223，lightningcss 的 light-dark 脚手架，**未实际使用**）。
- `@media (prefers-color-scheme:light)` 只做一件事：`html,body,#root{background-color:transparent}`（@2592）——即"系统亮色时不覆盖成黑底，仍露出背景图"。
- `@media (prefers-reduced-motion:reduce)` 是**完整降级表**：关掉 `reveal-in`/`reveal-stagger`、把 `gold-flow-card:before` 停成静态 55% 透明、`tilt-card` transform:none、`mouse-glow` display:none、`parallax` 取消（@572–592）。
- 结论：不要为对齐竞品去做亮色主题。降级方面本地已有 2 块（`app.css:779` 全局 `.01ms` 抹平、`:964` 清 `nth-child` 延迟），但是**一把梭式**；竞品是**逐效果点名降级且保留静态态**（流光停成 .55 静态描边而非删掉），后者更值得对齐。

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
- 表格用最小宽 + 外层横向滚动：**Tasks 表 `min-w-[820px]`**（逐文件核实：920/960 两档只出现在 `Admin-Dse82uZl.js`，那是**导航里没有的管理页**，不算用户面）；`lg:hidden` 的卡片列表与 `hidden lg:block` 的表格**成对出现**——移动看卡、桌面看表。

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

### 3.4 弹窗 / 遮罩层（`dialog-CeL5rpcU.js` L1876–1879）

**重要事实：全站没有 Sheet / Drawer 组件**（无 vaul、无 `slide-in-from-right`；唯一的"抽屉"是移动端**导航**左滑面板，见 §2.2）。详情/编辑一律用居中 Dialog 或**行内展开**。所以"右侧抽屉"不是这个设计系统的必要部分。

| 部位 | 规格 |
|---|---|
| Overlay | `fixed inset-0 z-50 bg-black/55 backdrop-blur-sm` + `animate-in fade-in-0 / animate-out fade-out-0` |
| Content | `fixed left-[50%] top-[50%] z-50 grid max-h-[90dvh] w-[calc(100%-1.5rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto rounded-[24px] surface-elevated p-5 duration-200 sm:p-7` |
| 入场 | `fade-in-0 zoom-in-95 slide-in-from-left-1/2 slide-in-from-top-[48%]`（**from-top 48% 与 translate -50% 只差 2% → 视觉上"轻微上浮 + 放大"**，不是大幅滑入），`duration-200` |
| 关闭钮 | `absolute right-4 top-4 rounded-full opacity-70 hover:opacity-100 focus:ring-2` + X 图标 `h-4 w-4` + `sr-only`"Close"；打开时 `data-[state=open]:bg-white/[0.08]` |
| Header | `text-xs font-medium tracking-wider text-[var(--text-muted)]`（eyebrow）→ `mt-2 text-lg font-medium text-foreground`（标题）→ `mt-3 text-sm leading-relaxed text-muted-foreground`（说明），内容区 `max-w-2xl` |
| Footer 按钮 | 主 `btn-accent-gradient inline-flex h-10 items-center px-4/px-5 text-sm font-medium`；次 `btn-ghost-soft inline-flex h-10 items-center px-4 text-sm`；危险 `inline-flex h-10 items-center rounded-md bg-destructive px-4 text-sm font-medium hover:brightness-110 focus-visible:shadow-[var(--focus-ring)]` |

**尺寸档位（同一 Dialog 用 `className` 覆盖）**：`max-w-lg`(默认) / `max-w-md`(备份恢复、QuickCreate) / `max-w-2xl`(素材编辑、AI 优化对照) / `max-w-3xl`(镜头参考、提示词大屏) / `max-w-5xl`(图片预览，`p-0`) / 全屏编辑 `h-screen max-h-screen w-screen max-w-full rounded-none`。**"抽屉"这件事由 `max-w-*` + `rounded-none` 承担，不需要第二套组件。**

**自研遮罩层（不走 Dialog）**：仅灯箱类用 `fixed inset-0 z-50 flex items-center justify-center bg-black/{55,60,70} backdrop-blur-sm p-6` + `onClick=close` + 内层 `stopPropagation`；三档黑度分别对应 预览(60) / 提示词大屏(60 py-8 px-4) / 其它(55,70)。

**Radix 给的免费能力（vanilla 需自己补）**：`FocusScope trapped+loop`、关闭后 `triggerRef.focus({preventScroll:true})`、其余 body `aria-hidden`、`RemoveScroll` 锁 body 并**补偿滚动条宽度**（`removeScrollBar`，防抖动）、Esc 只关最顶层（layer index === size-1）、右键/`ctrl+左键` 外点**豁免不关闭**。最后一条尤其容易漏。

**其它浮层的 z 阶梯**：header `z-30` → 移动吸底条/浮层 `z-20` → 批量命令栏 `z-40` → toast pill / dialog / 遮罩 `z-50` → **mention 菜单 `z-[70]`**（必须盖过 dialog，因为写稿台可在弹窗内）。


### 3.5 Toast / 内联反馈（两条通道，分工明确）

1. **浮起 pill toast**（仅 4 处：Images/Videos/AssetManager/Library）：
   `glass-heavy fixed bottom-6 right-6 z-50 animate-in fade-in slide-in-from-bottom-4 rounded-lg px-4 py-2.5 text-xs font-medium duration-300` — 小、玻璃、右下、从下 16px 淡入、0.3s。**没有 sonner / react-hot-toast**：每页自己 `setToast` + `setTimeout` 复位，时长 2400ms（Images/Library）/ 2600ms（Assets）。**位置也不统一**（Assets 是 `bottom-6 left-1/2 -translate-x-1/2` 居中）。**缺陷**：`bottom-6`(24px) 与移动底部 tab(56px + safe-area) **重叠**，全站只有 tab bar 写了 `padding-bottom:env(safe-area-inset-bottom)`，toast 没有。
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

- 两种页签，别混为一谈：
  - **Radix Tabs（低频，内容型）**：`data-[state=active]:bg-secondary/25 data-[state=active]:text-foreground data-[state=active]:shadow-sm`（`shadow-sm`→`--elev-ring` 内描边）——激活态是"轻底 + 内描边"，**没有下划线**。
  - **分段器 segmented（高频，筛选型，Assets 三类型页签逐字实读）**：容器 `surface-card flex items-center gap-1 p-1`（**用卡本身当槽**），按钮 `flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition`（**`flex-1` = 等宽分段**），激活 `bg-primary text-primary-foreground shadow-md`，未选 `text-muted-foreground hover:bg-secondary/15`，计数尾标 `rounded-full px-1.5 text-[10px]`。
- Library 的类型 tab（实测 L 逐字）：`全部/图片/视频/文本/资产素材`，选中 `inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground`（**实心金底 + r6，不是胶囊**），未选 `btn-ghost-soft inline-flex h-8 items-center border border-border px-3 text-xs`。切换时 `setType + setPage(1)` —— **换页签必回第 1 页**。同一 `btn-ghost-soft h-8 border` 样式也复用于「上一页/下一页」，**全站分页按钮与未选页签长得一样**。
- 单选型选择（草稿类型、画风预设、素材类型）：**chip 组**`rounded-full border px-2.5 py-1 text-xs transition` + 选中 `border-primary bg-primary/10 text-primary`；分组标题 `text-[10px] font-medium text-[var(--gold-bright)]`（收藏/自定义用金色标）。
- **ReferenceAssetChips**：`inline-flex items-center gap-0.5 rounded-full border border-[var(--border-default)] py-0.5 pl-2 pr-1 text-xs` + 尾部 × 按钮 `hover:text-[var(--danger)]`（**删除才变红，平时中性**），hover 整枚 `hover:border-[var(--brand)]`；空态加一枚 `border-dashed border-primary/40 text-[11px] text-primary hover:bg-primary/10` 的"＋添加"胶囊。

### 3.9 图片/视频卡与灯箱

- 结果卡：`surface-card group relative overflow-hidden`，封面 `block aspect-square w-full overflow-hidden bg-secondary/15`（**先给底色再放图，加载时不塌**），图 `h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]`（**hover 500ms 缓放 3%**）。
- 角标：`absolute right-1.5 top-1.5 z-10 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground shadow`。
- 次级缩略：`h-20 w-32 object-cover transition duration-300 group-hover:scale-[1.04]` + 居中浮层 `absolute inset-0 bg-background/45 opacity-0 transition group-hover:opacity-100`（桌面 hover 出现，移动 `hidden sm:flex` 换成长按/点击预览）。
- 历史/参考行缩略：`h-20 w-32`（128×80）与 `h-7 w-7`（mention 行内）两种尺寸反复出现，可当"缩略图标准档"。
- 卡底工具行：`flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-xs`，动作按钮统一 `inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground`（**图标按钮不画边框，hover 才有底**）+ 危险 `text-destructive hover:bg-destructive/10` + 批量条右端的 `ml-auto rounded bg-destructive px-1.5 py-1 text-[10px] font-medium text-destructive-foreground`（title「再点一次确认删除」）**不是分页，而是两段式确认里已被武装的那颗按钮**；真正的分页是 `btn-ghost-soft h-8 border border-border px-3 text-xs`「上一页 N / M 下一页」。

### 3.10 虚拟滚动？分页？

- **全站零虚拟滚动、零 react-window**。分镜几十条、素材几百条的量级下作者选择整量渲染 + 分页。
- Storyboard：整集全量渲染（`mt-4 space-y-3`），无分页。
- Library：`pageSize=24`，**服务端拉全量后前端 `slice()` 分页**（不是游标分页）；「资产素材」嵌在「全部」页签时 compact 只显 6 张 +「全部展开」。
- Images：24 张/页传统分页；Videos：无分页（客户端过滤全量）。
- Tasks：服务端 `perPage:200` 一次拉完 → 客户端按筛选结果**每页 20 条**；桌面表格 `min-w-[820px]` 横向滚动 + 移动卡片流双形态。
- Projects：无分页 UI，取 `perPage:100`。
- ⭐ **筛选状态持久化**（我们完全没有）：`agnes.filter.image.mode/.keyword`、`agnes.filter.video.mode/.keyword` — 下次进页面记得你上次的筛选；配合 `agnes.composer.collapsed.*`（面板折叠）、`agnes.prompt.h.*`（输入高度）、`agnes.draft.*.prompt/batch/shots.${项目}`（**草稿按项目分键**）构成"记忆层"。

### 3.11 组件清单小结（对本地版的直接映射）

| 他们的组件 | 我们现在的对应物 | 差距 |
|---|---|---|
| `button` cva 6×4 + `btn-accent-gradient`/`btn-ghost-soft` | `.btn`/`.btn-primary`/`.btn-ghost`（`app.css`） | 缺 `icon` 档、缺全圆角一致性和 `[&_svg]:size-4` |
| `GlassSelect`（Radix Select 薄封装） | 原生 `<select>`（**全站 25 处**，散在 8 个页面模块） | 最大的一处观感落差 |
| `Dialog` + 尺寸覆写 | `ui.js/modal()` | 缺 `max-h-[90dvh]` + `rounded-[24px]` + zoom/slide 入场 |
| toast pill + `actionHint` 内联横幅 | 只有 `ui.js/toast()` | 缺"结果性长文案"通道 |
| `glass-input` / MentionTextarea | 原生 input/textarea，固定高 | 缺 focus 金环、缺高度记忆、缺 @ 引用 |
| `StatusBadge` 8 态双表 | 各处散写文字 | 缺统一状态语言 |
| `Skeleton`（同构骨架） | 无 | 缺 |
| `EmptyState`（icon+title+desc+action）+ 卡级错误条 | `ui.js/empty()` + `ui.js/errBox()` | 已有雏形，缺"含页面名的指路出路" |
| 两段式确认 `useTwoClickConfirm` | `ui.js/confirm()` 阻塞弹窗 | 慢一拍且打断心流 |
| 提示词工具栏（@素材/AI 优化/最终提示词/大屏编辑/高度档） | 无 | 一整块能力空缺 |

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

**三页职责**：`/assets`=角色·场景·道具**设定**（左 chips 列表 + 行内编辑表单 + 右参考图栏）；`/asset-manager`=**单项目内**素材运营台（改名/换类型/换参考图/设主图/批量整理/拿去生成）；`/library`=**跨项目**历史产出浏览 + 导出 + 移动。

> ⚠ 校正记录：`/assets` **没有抽屉、没有卡片网格、没有视图切换、没有搜索框**（`inset-y-0 right-0`、`slide-in-from-right`、`z-[60]`、`420px`、`确认入库` 等字符串在全部 chunk 中 **0 命中**；`slide-in-from-right` 仅出现在 Radix Select 内部）。全站**不存在 Sheet/Drawer 组件**，只有居中 Dialog。以下按实测写。

- **Assets 结构**：工具条 → 4 统计卡 → 类型页签 → 双栏 `grid items-start gap-4 lg:grid-cols-[minmax(340px,430px)_minmax(0,1fr)]`。
  - 统计卡 `grid grid-cols-2 gap-3 sm:grid-cols-4`（角色/场景/道具/已出图），图标座 `h-9 w-9 rounded-md bg-primary/10` + `text-lg font-semibold` 数字。
  - 类型页签 segmented：`surface-card flex items-center gap-1 p-1`，激活 `bg-primary text-primary-foreground shadow-md` + 计数 `rounded-full px-1.5 text-[10px]`。
  - **左栏 = 资产 chips 流 + 行内表单**（选中的编辑对象就绑在右栏，不跳页、不开窗）：chip `rounded-full border py-1 pl-3 pr-1.5 text-xs transition`，选中 `border-primary/40 bg-primary/10 text-primary`，名字 `max-w-40 truncate`；有图=✓，无图=小灰点（title「待生成参考图」）。
  - 编辑表单 7 字段：名称/别名/一句话概述/风格档案/详细描述/基础出图提示词/细节出图提示词（`grid gap-3 p-4 sm:grid-cols-2`，长字段跨 2 列；输入 `glass-input h-9 rounded-md px-3 text-xs`；maxLength 200/2000/8000）。⭐ **dirty 提示 `有修改未保存`**（`text-[11px] text-primary`，不弹窗不打断）；⭐ **「生成参考图」= 虚线按钮 `border-dashed border-primary/40 bg-primary/5`**（把"会花额度/会耗时"的动作与实心「保存」在视觉上分开）。
  - **右栏 = 参考图**：主参考图 `aspect-[3/4]`（角色竖构图；加载中同尺寸占位）+ hover「查看大图」`opacity-0 group-hover:opacity-100 backdrop-blur`；历史图 `grid grid-cols-3 gap-2 sm:grid-cols-4` `aspect-square`；⭐ **hover 底部工具条 `translate-y-full group-hover:translate-y-0`**（前移/后移/设主/删除），title 把语义写死「**顺序即引用顺序**」；删除是**格内确认遮罩**（不起全局弹窗）；dropzone `border-dashed rounded-md py-2.5 text-[11px]`。
- ⭐ **提取资产（从文稿）**：工具条 = 项目下拉 `glass-input h-9 w-52` + 集数 `w-20 inputMode=numeric` +「提取资产」(虚线) +「一键补齐参考图」(实心) +「批量导入素材」(隐藏 file input 多选) +「备份」。前置校验把依赖顺序讲清 `这一集还没有分镜或脚本文稿，先去拆镜或写故事，再来提取资产`；结果 `提取完成：角色 X，场景 Y，道具 Z（本机新增/更新 N）`。
- **批量导入按文件名合并**：`导入完成：新建 N 个素材（同名图片会并进同一素材）`——去重语义是"**同名并入**"，不是内容 hash。
- ⭐ **一键补齐只补缺口 + 幂等四计数**：`一键补齐中：需要 a，已成功 b，失败 c，跳过已有 d` / `本集待补 N，成功 R，失败 I，已有 S`；单个 `参考图生成完成：成功 N，已存本机`；无密钥禁用并提示 `请先登录并配置 Agnes 密钥`。
- ⭐ **引用守卫删除**：删资产单击即可，但被引用时拒绝并列出引用方 `仍在使用中：a、b、c 等，先解除引用再删除`。**全站唯一需要两段式确认的是「清除本机数据」**：`再点一次，确认清除全部本机数据` + 警示 `请确认你已导出备份——清除后无法找回。`
- **备份/恢复**：恢复为**合并式**（明说 `现有数据不会被清空`）；导出 toast 带四类计数 `备份已导出：素材 N · 主档 N · 分镜 N · 媒体文件 N`。
- ⭐ **本机存储异常被翻译成人话（5 类，本地版最该抄这块）**：`浏览器本机存储空间已满，请先导出备份并清理旧素材后再试` / `本机数据库需要修复，刷新页面即可自动补齐…` / `本机数据连接中断，请刷新页面重试` / `当前浏览器（可能处于隐私模式）不支持本机保存，数据只在本次打开期间保留` / `本机数据读写失败，请刷新页面重试`；另有迁移未完横幅 `资产迁移本机未完成，暂以旧数据只读展示`。
- toast 位置在此页是**居中** `fixed bottom-6 left-1/2 -translate-x-1/2`（约 2.6s），与其余页右下不一致 → 见 §7。

- **AssetManager 素材管理**：定位一句话讲清能力 `一屏看全当前项目的角色、场景、道具和素材：点开就能改名、换类型、换参考图…还能一键拿去生成。`
  - ⭐ **sticky 工具栏** `sticky top-0 z-20 surface-elevated p-2.5`：项目下拉(w-40) + 类型胶囊 tabs（全部/角色/场景/道具/素材 + 计数 chip `min-w-[1.25rem] rounded-full text-[10px]`）+ 搜索 `rounded-full w-44 focus:w-56 transition-[width]`（**focus 变宽，`transition-[width]` 就是为它准备**）+「新建素材」+「批量整理」。
  - 网格 `grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6`；缩略 `aspect-square rounded-t-3xl`；hover = `-translate-y-0.5 hover:shadow-xl` + 图 `group-hover:scale-[1.04] duration-500` + **渐变遮罩条 `bg-gradient-to-t from-black/85 via-black/45 to-transparent`**（4 动作）；⭐ **移动端遮罩常显** `opacity-100 md:opacity-0 md:group-hover:opacity-100`（触屏没有 hover）。
  - ⭐ **「拿去生成」= 管理→生产的反向消费**：primary pill，title `自动把 @素材名 插入提示词`，实际 `navigate('/videos?reuseAsset=<id>')`，**零复制**；另配「存为素材」把任意临时图 3 秒升级成可 @ 资产 —— 素材闭环是双向门。
  - ⭐ **批量整理 = 勾选框只在批量模式出现 + 底部浮起命令栏 + 原地切确认态**：勾选框 `h-6 w-6 rounded-full border-2 backdrop-blur`（选中 `border-primary bg-primary`）、卡 `ring-2 ring-primary`；命令栏 `fixed inset-x-0 bottom-6 z-40 flex justify-center px-4` 内 `rounded-full px-3 py-2 shadow-xl fade-in slide-in-from-bottom-4 duration-200`：`已选 N 个素材 | 全选当前 | 删除所选 | ×退出`；点删除后**命令栏原地变确认文案** `将删除 N 个素材，仍被分镜或任务引用的会自动跳过，删除后无法恢复。[返回][确认删除]`；结果 `已删除 N 个素材（跳过 M 个引用中）`。
  - **单素材删除 = 引用检查流程**：打开即转圈 `正在检查分镜与任务的引用…` → 列引用方（`分镜 3`、`…等共 K 处引用`，warning 框 `max-h-44 overflow-auto rounded-xl bg-[var(--warning-soft)]`）→ 按钮变「知道了」。教育文案 `素材主档和它的全部参考图会从本机一并删除…提示词里已写的 @素材名 也不会再生效`。
  - 编辑弹窗 `max-w-2xl`，内 `grid sm:grid-cols-[190px_minmax(0,1fr)]`；⭐ **label 即教学** `名称（提示词里 @ 这个名字引用）`；版本网格 `grid-cols-3 sm:grid-cols-5 lg:grid-cols-6`，标题写出取图规则 `参考图版本（N 张；@ 引用按主图 → 追加顺序取图）`；脏检查 `内容没有变化`；页脚 `保存后全站生效：生成页的 @ 引用与参考图都用最新版本`。
  - 骨架屏：**12 个 `aspect-square rounded-3xl` animate-pulse**（全站唯一成规模骨架屏）；筛选空态给「清空筛选条件」按钮，真无数据才给「新建素材」。

- **Library 素材库**：定义文案 `汇总你所有项目里生成的图片、视频和文本素材，以及存为素材的角色、场景、道具，可按项目、类型、关键词筛选。` + 计数徽章 `rounded-full bg-primary/10 px-3 py-1.5 text-xs`「共 N 条」。
  - ⚠ **Library 没有多选、没有勾选框、没有浮现工具条、没有 per-item 收藏**（与 AssetManager 明确分工）。卡片动作**全部常驻**：`移动到…`(`h-7 flex-1 text-[10px]`) + 下载 `h-7 w-7 hover:text-primary` + 删除 `hover:text-[var(--danger)]`。
  - ⭐ **批量 = 以"当前筛选"为范围的打包导出**：title 直接写范围与上限 `把当前筛选下的素材打包成一个 zip 导出到设备（上限 200 条）`，文件名 `agnes-素材包-N条.zip`，按钮切「打包中…」，toast `已打包 N 条素材，zip 已开始导出` / 部分失败 `部分素材内容取不到…请逐条导出`。**不需要先手工多选**——素材库的"批量"应该是这个形状。
  - 筛选 3 维：类型页签（全部/图片/视频/文本/资产素材）+ 项目 GlassSelect `h-9 w-48`「全部项目」+ 关键词 `glass-input h-9 pl-8 pr-3 sm:w-56`（图标 `absolute left-2.5 top-1/2 -translate-y-1/2`，placeholder「按提示词/标题搜索」）。⚠ 无防抖、无日期筛选 → 见 §7。
  - 网格 `grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6`；卡 `surface-card overflow-hidden` + `aspect-square`（`bg-secondary/12` 兜底，视频=播放图标占位）；两行 meta = 项目名 `truncate text-xs` + 类型徽章 `rounded bg-secondary/20 px-1.5 py-0.5 text-[10px]`；⭐ **入场 `useStaggerReveal(tRef,[items,page])`——依赖含 page，翻页会重放入场动画**（把分页当成一次新的"揭示"）。
  - 「资产素材」子页签（读本地 IDB）：嵌在「全部」下时 `compact` 只显 6 张 + `还有 N 个资产素材，全部展开`；缺图卡 hover「补图」→ 直接开 QuickCreate 追加模式；空态把因果链讲全 `在出图 / 出片页把参考图「存为素材」…存好后写提示词时输入 @ 就能引用`。
  - 灯箱（自绘）：`fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-6` + `onClick=close` + 内层 `stopPropagation`；媒体 `max-h-[70vh]`，文本 `whitespace-pre-wrap overflow-auto`；动作 复制全文/导出全文/导出/关闭；⚠ **键盘只有 Escape，无 ←/→ 切换**。
  - 分页 `pageSize=24`，**接口拉全量后前端 `slice()`**；⚠ **本页无骨架屏**（只有一张文字卡 `surface-card p-4 sm:p-6`「正在读取素材…」）。删除用自绘小弹窗 `max-w-sm p-5`「删除该素材？删除后无法恢复。」
  - ⭐ **未登录也有独立空态**：`登录后查看素材库 / 你生成的图片、视频和文本素材都会汇总在这里，登录后可以浏览、删除或移动到其它项目。`
- **QuickCreate 弹窗**（`AssetQuickCreateDialog`，`max-w-md gap-5`）：双态标题「上传素材」/`给「X」补参考图`（补图态隐藏名称+类型，说明 `下面选的图会追加到这个素材上`）；字段 名称(maxLength 60，placeholder `比如：主角小满 / 城南老街`) + 类型 4 胶囊 `rounded-full px-3 py-1.5 text-xs` + dropzone `border-dashed py-5 text-[11px]` `点这里选图片，或把图片拖进来（最多 N 张）`（dragOver `border-primary bg-primary/10`）；预览 `grid-cols-2 sm:grid-cols-4`，首张左上金色「主图」徽章；校验行内红字 + 按钮禁用（`先给素材起个名字`/`先选至少一张参考图`/`这张参考图取不回来了（可能已过期），请在下方重新选图`）；⭐ 无参考图时 gold 教育条 `还没有参考图：没有图的素材不会带图参与生成，只能当文字描述用。`；busy 时**拦截弹窗关闭**；成功 toast `素材已存好，在「资产素材」里能看到，写稿时可以 @ 引用`。
- **素材本地层（IndexedDB）**：`agnes-studio-local` v2，5 个 store `assets/tasks/shots/assetLibrary/assetFiles`；⚠ **无索引、out-of-line key、全量 getAll + 内存过滤**（万级素材会慢，**这是本地版能超越它的地方**）；blob 直存 + `createObjectURL` Map 缓存 + 主动 revoke；备份前 blob→dataUrl；多标签冲突有专文案。版本 = `media_refs` 序号，「设为主图」只改 `primary_file_id`，**顺序即 @ 引用取图顺序**；角色主图若是四视图自动回退取全身正视图。
- **预设库实测 113 条**（README 称 82，偏少）：`style 65`（动漫卡通14·插画艺术11·国风东方11·影视氛围11·写实影像8·复古潮流10）/ `light 28`（自然光9·戏剧布光8·氛围光效9·特殊光感2）/ `camera 20`（镜头运动11·氛围运镜9），12 组。⭐ **单条只有 `{label, prompt}`**——无主体/前后缀切分，`prompt` 原样进提示词（UI 明说「描述短语，会原样进提示词」），另建 `Map<prompt,label>` 反查表回显名字（未命中截 12 字 `我的自定义 · xx…`）。配额：收藏 ≤30/类置顶、自定义 ≤30 插队首、常用参数 ≤8（标签形态 `5秒 · 16:9`），满额有专文案（`自定义预设最多 30 条，请先删掉不用的`）。
- ⭐ **Picture N 参考协议 + 参考资产面板**：@ 解析后按序前置 `<Picture 1> 是角色参考图，只参考人物身份、脸、发型、服装，不复制白色背景。`（场景/道具各有句式）并统一追加 `参考图仅用于保持一致性：…`；硬上限 5 张，超限警告 `最多同时生效 5 张参考图，超出部分不参与生成；调优先级决定保留哪几张。`；面板区分**显式关联与自动识别**（`另有 N 个资产按名字自动识别（未显式关联，改分镜文本或重命名资产可调整）`），每张生效图带 `#N` 序号 + `启用中/已停用` + `优先级 ↑↓`。
- **ReferenceAssetChips** 全文 40 行：`flex flex-wrap gap-1.5` + 前缀「当时参考了：」+ chip `rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px]`，命名 `类型·名称`，title 显 variant；**纯只读快照，无 +N 折叠、无删除、无拖拽**（按 `asset_image_id` 去重的生成当时记录）。
- ⭐ **AI 优化的两条护栏**：① 结果进**左右对照浮层**（原文 vs 优化结果，空原文显示 `（空）`），`点「使用这条」才会替换输入框`；② 送进模型的 meta-prompt 有硬条款 `原文里的 @名字 是素材引用标记，必须逐字保留，不得新增、删除或改写任何 @ 条目`——**AI 改写不得破坏用户的引用语法**。
- **模板 popover**（`w-72`，上限 30）：`保存当前提示词`（名称不填自动取开头）、每条双动作「用这条替换」/`追加到当前内容后面（不覆盖已写的）`、删除两步确认。
- **`@素材` 的完整解析链**：正则 `/@([^\s@，。；、,！!？?「」『』"']+)/g`（token ≤24 字符）→ 精确同名优先 → 最长前缀匹配（≥2 字）→ 命中后剥 `@` 换素材名、图进参考序列（≤5 张、每素材最多取 3 个文件）→ 未命中保留原文并给 warning。



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

## 5. 动效与微交互

### 5.1 两套入场系统（同一曲线语言，成本分层）

| 系统 | 参数 | 触发 | 用在哪 |
|---|---|---|---|
| **纯 CSS** `.reveal-in` | `revealIn .56s cubic-bezier(.22,.61,.36,1) both`；`@keyframes revealIn{ from{opacity:0; transform:translateY(26px) scale(.97)} }` | 元素挂载即播（`both` 回填起始态） | 页头、单卡、Login 卡 |
| **纯 CSS** `.reveal-stagger>*` | 子元素按 `:nth-child(1..8)` 依次 `animation-delay:0/60/120/180/240/300/360/420ms`（**60ms 步进，最多 8 档**，第 9 个起不再延） | 同上，容器挂载即级联 | Home KPI / 快速开始 / 部分网格（全站仅 3 个 chunk 用到） |
| **GSAP** `useStaggerReveal(ref, deps)` | `gsap.fromTo(nodes,{y:56,scale:.96,opacity:0},{y:0,scale:1,opacity:1,duration:.6,ease:'power3.out',stagger:.06,clearProps:'transform,opacity'})`，`revertOnUpdate:true` | `useLayoutEffect`，**deps 变化即重放**（如 `[items,page]` → 翻页重放）；选择器 `[data-reveal-item]`；`matchMedia('(prefers-reduced-motion: no-preference)')` 守卫 | Projects 卡、Library 网格、Assets |

**要点**：
- 两条路线**位移量不同**（CSS 26px / GSAP 56px）、**时长几乎相同**（.56s / .6s）、**缓动等价**（`cubic-bezier(.22,.61,.36,1)` ≈ `power3.out`）→ 视觉一致，成本分层。**我们抄 CSS 那一套就够了**（零依赖）。
- 进场只播一次（挂载即触发），**全站零滚动触发动效**：没有 IntersectionObserver，GSAP 也**没有注册 ScrollTrigger**（全 bundle 仅 1 处命中，是核心里 `Missing plugin? gsap.registerPlugin()` 的告警分支）。
  这符合"工作台"而非"营销页"的定位——**用户是来干活的，不是来看动画的**；我们也不必加。
- `clearProps:'transform,opacity'` 播完清掉内联样式，避免与 hover transform 打架——**用 JS 做级联时必须记得这一步**。

### 5.2 hover / 按压反馈

| 对象 | 反馈 | 时长 |
|---|---|---|
| 卡片（`.glass-card`） | bg `#ffffff14→#ffffff24` + border `→#e8c98959` + `box-shadow:0 8px 28px #00000029` | 默认 `transition-colors`（150ms） |
| `.gold-flow-card` | conic 流光 **9s → 3.5s 提速** + 叠 `--gold-glow` | 关键帧驱动 |
| `.tilt-card` | 跟随指针 3D 倾角 + CSS 自带 `translateY(-4px) scale(1.01)` | `transform .12s ease-out`（JS 写角度）/ `0.26s` 复位 |
| `.mouse-glow` | `radial-gradient(280px circle at var(--mouse-x) var(--mouse-y), #ffffff1a, #e8c9890d 45%, transparent 72%)`，opacity 0→1 | `.3s` |
| 媒体封面 | `scale(1→1.03)`（Library/AssetManager 用 `1.04`）+ 遮罩/按钮条 `opacity` 或 `translate-y` 浮出 | **`duration-500`**（比常规 150ms 慢一档，做成"缓放"感） |
| 文字链 / 次级按钮 | 只换色 `hover:text-foreground` / `hover:bg-white/[0.06]`，**不加边框不位移** | 150ms |
| 图标按钮 | 平时无边框，hover 才有底 | 150ms |
| 主按钮 | `brightness(1.05)` + 阴影加深，**`transform:none`**（金主按钮刻意不位移，靠亮度） | 150ms |
| 侧栏激活项 | `border-[var(--gold-border)] bg-[var(--gold-soft)] text-[var(--gold-bright)]` + `[&_svg]` 同步变金 | — |
| 输入框 | `border-color:var(--gold-border)` + `--focus-ring`（3px `#e8c98938`） | 150ms |
| 搜索框（AssetManager） | `w-44 focus:w-56 transition-[width]`——**只给搜索框开宽度过渡**，其它地方不做尺寸动画 | 150ms |

### 5.3 异步与加载态的动效编排

1. **按钮自己当进度条**：无独立 loading 圈时，主按钮文案切 `生成中…/提交中…/测试中…/打包中…/正在保存…` + 内嵌 `h-4 w-4 animate-spin` + `disabled`。批量时更狠——**进度写进按钮文案**：`停止补词 3/12`、`出图中 3/12`、`提交中 done/total`。
2. **进度条三段式**：`h-1.5 rounded-full bg-secondary/20` 轨道 + `bg-[var(--brand)]`（失败段 `bg-[var(--danger)]`）+ `transition-all duration-500` 平滑推进；右侧配 `text-xs tabular-nums` 百分比（**`tabular-nums` 防数字跳动抖版**）。
3. **呼吸点表示"活着"**：`inline-block h-2 w-2 rounded-full animate-pulse bg-primary`（批量任务标题旁）+ StatusBadge 前导点 `bg-current opacity-70`。
4. **排队倒计时**：`setInterval(…,1000)` 每秒刷新 `75 秒后自动重试`，配「取消自动重试」——**等待被可视化且可退出**。
5. **骨架屏 → 内容**：同构骨架（尺寸逐个对齐真实块）+ `animate-pulse`（2s opacity 呼吸，**无 shimmer**）。
6. **数字滚动 / count-up：全站没有**。KPI 与计数都是直接落字（配 `tabular-nums`）。→ 我们也不要加，这类动效对生产工具是负资产。
7. **Toast 进出**：进 `animate-in fade-in slide-in-from-bottom-4 duration-300`；**没有 animate-out**（`setTimeout` 直接卸载，硬消失）——我们做 vanilla 时补一个 200ms 淡出就比它好。
8. **Dialog 进出对称**：`fade-in-0 zoom-in-95 slide-in-from-top-[48%]` ↔ `fade-out-0 zoom-out-95`，`duration-200`。
9. **路由切换**：无页面转场动画，只有 `<main>` `scrollTo({top:0})` + 我们本地版的 `pageEnter 240ms cubic-bezier(.22,1,.36,1)`（**这条我们已经有了，且曲线与他们的 reveal 同源**）。

### 5.4 `prefers-reduced-motion` 降级表（L572–592，可直接抄成 CSS）

```css
/* 逐字抄自 CSS 的 reduce 块 */
.reveal-in, .reveal-stagger>*  { animation: none; }
.gold-flow-card:before         { opacity: .55; animation: none; }
.gold-flow-card:hover:before   { opacity: .55; }        /* hover 提速一并失效，保持静态 */
.tilt-card                     { transform: none; }
.mouse-glow                    { display: none; }
.parallax-item                 { translate: none; }     /* 注意是 translate，不是 transform */
```
**关键做法：不删除装饰，而是降级成静态态**（流光描边仍在，只是不流动、透明度固定 .55）。⚠ 已知漏洞：Radix 的 `data-[state=open]:animate-in` 系列不在这个降级块里，**下拉/弹窗动画在减动偏好下仍会播放**——我们自绘浮层时记得把动画挂进这个块。

### 5.5 其它微交互清单

- **两段式确认（`useTwoClickConfirm`）**：`[pendingId,setPendingId]` + `setTimeout(()=>set(''),3000)`；三通道反馈 = 文案变「再点一次确认删除」+ 描边红→实心红 + 追加警示行。**不用弹窗，快一拍且不打断心流**；按 id 记态所以同屏多行可各自武装。
- **复制成功 → 按钮文案自变**「正文已复制」+ `setTimeout(…,1600)` 复位；失败「复制失败，请手动选择」。**反馈就地发生在触发点**。
- **⛔ 危险动作的 label 前缀**：「退出并**清除**本机数据」——在按钮文案里把不可逆后果写进去，而不是只靠红色。
- **收藏即时态**：☆→★ `fill-current` + `border-[var(--gold-border)] bg-[var(--gold-soft)] text-[var(--gold-bright)]`，title 在「收藏这个预设（收藏后在下拉最上面）」↔「取消收藏这个预设」之间切换；**无 toast**（状态即时可见就不需要提示）。
- **顶栏密钥灯**：`h-1.5 w-1.5 rounded-full` + `bg-[var(--success)]`/`bg-[var(--warning)]` + 文案「API 已连接 / 未配置密钥」，整枚可点直达 `/settings`；保存失败实时打回黄灯。
- **IM 式 mention 菜单**：↑↓ 循环、Enter/Tab 选中、Esc 关、`onMouseEnter` 同步高亮、**IME composing / `keyCode===229` 守卫**（中文输入法下不劫持回车）；定位 160ms 节流、blur 160ms 延时关、点击插入后 300ms 内 focus 不重开。
- **面板折叠**：chevron `rotate-180`，折叠态持久化；折叠后**浮出胶囊按钮**保留主操作（不因为折叠就把动作藏进必须展开才能点的地方）。

---

## 6. 最值得借鉴点排序（10–15 条）

| # | 借鉴点 | 是什么 | 为什么值得抄 | 成本 | 风险 |
|---|---|---|---|---|---|
| **1** | **统一状态语言 + 异步任务卡片化** | `StatusBadge` 8 态双表（色 + 中文）；把"等待/排队/生成中/超时/需重登"当**用户要看的一等公民**，逐行「继续查询→查询中」单行锁，轮询 `document.hidden` 暂停 | 我们已有 jobs/poller + SSE，缺的是**表达层**；本地版任务更多（离线跑），价值比托管版更大 | 低-中 | 低 |
| **2** | **错误/结果文案语法**（含 9 阶段流水线名 + 错误码全表 + 副作用说明） | 「发生什么 → 下一步做什么 → 时间预期 → 更快路径 → 副作用边界」五段式；「在『镜头解析』这一步失败」「删除后**不会取消已在远端跑的生成**」 | 纯文案工程，**零重构、观感提升最大的一条**；把"模型出错了"变成"可动手修" | **低** | 无 |
| **3** | **两段式确认（`useTwoClickConfirm`）+ 引用守卫删除** | 3s 时间窗、文案+配色+警示行三通道；被引用时先列引用清单再拒绝 | 替代我们现在的 `confirm()` 阻塞弹窗（`ui.js/confirm`）；本地版删除即真删，**更需要"删了会断什么"** | 低 | 低（需防"手滑第二次点击"→ 按 id 记态并加区域外点击复位） |
| **4** | **设计令牌体系落地（三层色 + 金 14 档 alpha + 4 档圆角 + 8 档间距 + 5 级文字 + 4 级阴影）** | §1 全表，含 `--focus-ring`、`--elev-popover`、`::selection` 金、`--cjk-latin-shift`、`font-size-adjust:.56` | 我们只有 ~10 个变量；补齐后所有组件改造都有统一依据，**是其余 14 条的地基** | 低-中（纯 CSS 追加） | 低（改错会全站走样，需一次做完） |
| **5** | **提示词工作台**（@素材 mention + 高度记忆 + 大屏编辑 + 「最终提示词」预览） | 纯 `<textarea>` + 镜像 div 测 caret + body 浮层 + 上下翻转 + IME 守卫；草稿按项目 localStorage；发送前把"实际发出去的完整提示词"展开给人看 | **AI 工具最核心的输入体验**；「最终提示词」直接消灭"模型到底收到了什么"的黑箱焦虑，是**信任类**功能 | 中 | 中（caret 定位细节多，需真机测输入法） |
| **6** | **自绘 Select（替掉全站原生 `<select>`）** | trigger = `.glass-input` + h10 + `[&>span]:line-clamp-1`；面板 = 浮层 `max-h-[288px]` + 选中勾位 `pl-8` + `↑↓/Home/End/Esc` + 首字符跳转（1000ms 缓冲）+ "全部"用哨兵值 | 原生 select 的弹层是操作系统画的，**是我们与竞品观感差距最大的单点**；语义用 `aria-haspopup=listbox` 自建即可 | 中 | 中（键盘与移动端可达性要测） |
| **7** | **结果复用闭环：每张历史卡 = 可回填的模板** | 「复用参数 / 复用提示词 / 存当前为常用参数（≤8，标签 `5秒 · 16:9`）/ 收藏（≤30 置顶）」四级 + 「存为项目默认」+「跟随项目（xxx）」首项 | 漫剧生产是**高度重复的调参过程**；把"调过一次"变成"下次一键"。配合项目默认 = 整部番风格一次锁定 | 中 | 低 |
| **8** | **后台任务体验：可离开 + 可续跑 + 可解释 + 幂等** | 提交即给"1~3 分钟"预期和"可以离开"许可；localStorage 存 task_id+时间戳，<900s 自动接上；720s 软超时改文案不改状态；批量「跳过已有」+「重跑全部失败（n）单个不影响其余」+ 中断后可续 | 我们已有 `lib/jobs.js`+`poller.js`，**缺的正是"接上"和"讲明白"这层**；本地长跑任务更多，收益高于托管版 | 中 | 中（续跑要处理任务已消失的情况，他们用了 404 重试 + 120s 整单重发） |
| **9** | **KPI/统计卡 + 内联横幅双通道反馈** | Home/Tasks 的 `grid-cols-2 sm:3 xl:4` 统计卡（整卡是链接 + hint 写清统计口径 + 仅"需要处理"项语义变色）；结果性长文案走 `actionHint` 内联横幅（Story/Storyboard 各 21/57 处），临时性才走 toast | 首页从"入口列表"升级为"驾驶舱"；toast 不再承担长文案 | 低-中 | 低 |
| **10** | **同构骨架屏 + 空态"三段式带指路"** | 骨架块尺寸逐个对齐真实块（同断点同列数），无 shimmer；空态 = 图标座 + 一句话 + **一条含页面名的出路** + 直达按钮 | 消除切页跳版；把"没数据"变成"下一步该去哪" | 低 | 无 |
| **11** | **玻璃层级三档 + `max-w-[1320px]` 居中工作区 + 圆角矩形顶栏** | `blur16/150% → 24/160%` 三档语义；header `sticky top-0 z-30 mx-3 mt-3 h-14 rounded-[19px]` 悬浮胶囊（不是通栏硬边） | 是"看起来贵"的主要来源；我们目前是纯黑 + 通栏 | 中（含布局微调） | 中（改 header 形态会牵动全站间距） |
| **12** | **记忆层（28 个 `agnes.*` localStorage 键）** | 折叠态 / 筛选 / 草稿 / 输入高度 / 任务续跑 / 常用参数 / 收藏 / 项目默认 / 引导已读 / 侧栏折叠 / 返回路径，全部 try-catch 容错 | **单用户工具的"手感"来自这里**：关掉再打开，一切还在原地 | 低（我们已有 `data/` 落盘，加 localStorage 即可） | 低（键名需统一前缀，避免污染） |
| **13** | **CSS 类即品牌变体（不枚举组件 variant）** | `btn-accent-gradient` / `btn-ghost-soft` / `surface-card` / `surface-elevated` / `glass-input` 全局贴到任意 `<a>/<button>/div`；组件层只留最小 cva 表 | 与 vanilla CSS **天然同构**——我们不需要组件框架也能拿到同样的主题一致性；改一处全站生效 | 低 | 无 |
| **14** | **参数用可视 pill 组，没得选就不做下拉** | 比例 8 档 / 分辨率 4 档 / 时长 9 档全部 `rounded-[10px] border px-2 py-1.5 text-xs`，选中反色；单模型只显金色 pill + title 解释「当前唯一可用，免费」 | 高频调参一眼可选，比下拉少一次点击；"没得选"用只读 pill 表达比禁用下拉诚实 | 低 | 无 |
| **15** | **入场级联 + hover 微交互（纯 CSS 路线）** | `.reveal-in` 560ms `cubic-bezier(.22,.61,.36,1)` + `translateY(26px) scale(.97)`；`.reveal-stagger>*` 60ms 步进 ≤8 档；hover `scale-[1.03] duration-500`；完整 reduced-motion 降级表 | 纯 CSS 零依赖，**和我们已有的 `pageEnter` 同曲线**，接得上；减动偏好降级块可直接抄 | 低 | 无 |

**推荐落地顺序（按"性价比 ÷ 风险"，与上表价值排名不同轴）**：`4 → 13 → 2 → 10 → 15 → 14 → 3 → 9 → 1 → 12 → 7 → 5 → 6 → 8 → 11`。
- 先做 **4 + 13**（令牌表 + 5 个 CSS 类）：这是地基，其余每一条都要踩在它上面，且是纯追加、可回滚。
- 再做 **2 + 10 + 15 + 14**（文案语法、同构骨架与空态、纯 CSS 入场、参数 pill 组）：**零后端改动、一周内全部见效**。
- 然后 **3 + 9 + 1 + 12**（两段式确认、KPI+双通道反馈、状态语言与任务表达、记忆层）：需要新增少量 JS 与状态约定。
- 最后 **7 → 5 → 6 → 8 → 11**（复用闭环、提示词工作台、自绘 Select、任务续跑、玻璃层级与 header 形态）：**要单独排期**，其中 6 和 11 会牵动全站，务必在 4/13 稳定后再动。

---

## 7. 不值得学的（明确不抄清单）

### 7.1 技术栈重量
1. **Radix UI + GSAP + Tailwind 运行时**：Radix Select/Dialog/Popover/Tabs/Tooltip + 内嵌一份 **GSAP 3.15.0 核心 + CSSPlugin**（`useStaggerReveal-DJfEh49G.js` 有 69 处 gsap 引用；`ScrollTrigger`/`Flip` 只是核心里的告警分支与 tick 常量，**并未注册**）+ tailwindcss-animate。我们零依赖 vanilla，**只为一个下拉和一次入场动画引两个库是本末倒置**。CSS 版 reveal-stagger 效果等价；Select 自绘即可（见 §3.3）。
2. **`useStaggerReveal` 的 GSAP 路线**：`revertOnUpdate` + `matchMedia` + `clearProps` 这套只在"翻页重放动画"这种少见场景才划算，我们统一用 CSS `nth-child` 延迟。
3. **PocketBase SDK / 账号体系 / 密钥托管 + `scratch` 临时上传接口**：纯云端产物。我们是本地单机、密钥就在 `data/`，抄过来只会增加攻击面。

### 7.2 平台特化的装饰
4. **顶栏 5 个外部推广快捷链接**（ima 知识库 / 动画大丸家4.0 / 提示词大师 / miniMiniMax H3 导演台 / 漫剧宝藏资源网）：托管版的导流位，**与工具价值无关**。
5. **「v0.1.5 · 本地浏览器存储」等版本页脚 + 新手引导横幅 + 使用引导页**：营销/Onboarding 包装，本地版自说明即可，不必照搬长文案。
6. **conic 流光描边（`.gold-flow-card`）+ tilt + mouse-glow 三件套**：他们自己也**只在 3–4 个 chunk 用**（Home 快速开始、Projects 卡、Login、引导条），工作页一律不用。若我们把它铺到每张卡上，长时间盯屏幕会变成视觉噪声——**只在"值得被点"的少数卡上用最多加一个效果**。
7. **`@property --flow-angle` + 9s conic 动画**：Safari 旧版兼容成本 + 常驻合成层动画（CPU/GPU 持续占用），对一个可能开一整天的本地工具不友好。
8. **登录页两团 `blur-[64px]/blur-3xl` 光斑 + `h-[420px] w-[680px]`**：一次性门面，我们不抄。

### 7.3 设计系统自身的不干净
9. **`--text-muted / --text-tertiary / --text-aux / --text-weak` 四个别名同一个值 `#cfcabf`**；`--status-*` 又复制一遍 `--success/--warning/--danger` → 令牌冗余。我们建自己的表时**一个值一个名**，别抄这个。
10. **`--accent-blue: #2f81f7` / `--accent-cyan: #4dd0e1` 命名残留**：实际使用处是 `--info/--accent-cyan` 混用，语义漂移。
11. **`.glass-light / .glass-strong / .glass-sticky / .glass-nav` 在 ≤767px 降级块里被引用，但基础类根本不存在**（`.glass-panel` 也只有一条 `border-radius:28px`）→ 死选择器。**抄降级块时要逐个核对**。
12. **`@keyframes goldFlow{ to{--flow-angle:360deg; transform:none} }` 里的 `transform:none`** 是无操作噪声；`-webkit-mask-composite:xor` 与 `mask-composite:exclude` 双写。
13. **装饰类的真实使用率极低，别把它们当"系统标配"**（逐 chunk 精确计数）：`parallax-item` **0 次**（纯死代码）· `reveal-in` **仅 1 处**（只有 Login 卡）· `tilt-card` / `mouse-glow` **各 3 个文件**（Login + Home + Projects）· `gold-flow-card` **4 个文件** · `glass-card` / `glass` **各 2 次且只在壳层 index chunk**（页面全用 `surface-card`）· `glass-footer` 2 次 · `scroll-dark` 3 处。**结论：真正扛全场的只有 5 个类** —— `surface-card`(18 文件) + `glass-input`(17) + `btn-accent-gradient`(17) + `btn-ghost-soft`(16) + `surface-elevated`(9)；其余都是登录页/首页的少量装饰。**我们只要把这 5 个类 + 令牌做到位，就能拿到约 90% 的观感，不用复制整套玻璃家族。**

### 7.4 会伤害本地单机体验的
14. **toast 压在移动端底部 tab 上**（`bottom-6` vs tab `h-14`+safe-area，且只有 tab bar 写了 `env(safe-area-inset-bottom)`）：我们若做移动适配必须 `bottom: calc(56px + env(safe-area-inset-bottom))`。
15. **toast 位置不统一**（Assets 居中 / 其余右下）、时长散落在 2400/2600/2000ms、**无 animate-out**（硬消失）。我们统一一处。
16. **Library 搜索无防抖**（每次键入 `setKeyword + setPage(1)` 全量重拉）、**Library 无骨架屏**（只有一张「正在读取素材…」文字卡）。我们本地数据在内存/IDB，加 200ms 防抖 + 骨架只是举手之劳，**这里我们可以直接超过它**。
17. **IndexedDB 无索引、全量 `getAll()` + 内存过滤**，5 个 store 一视同仁。素材上千条后必卡。我们若做本地缓存层，**从第一天就建 `project_id`/`kind` 索引**。
18. **登出/切账号走整页 reload**（`agnes.route.reload`）：本地版是长连接（SSE），整页刷新会断流，不能抄。
19. **桌面表格横向滚动**（Tasks `min-w-[820px]`；Admin 的 920/960 不算用户面）：1280 屏上表格要左右拖。我们优先做"移动卡片流/桌面表格同源双渲染"，但**不要靠加最小宽度撑表**。
20. **超长中文按钮/说明文案**（「收起生成参数，只留标题行」「把当前画风存为项目默认（出图与出片都跟随项目）」「仍在用：a、b、c 等，先解除引用再删除」）：放在 `title` 里很好，**放进按钮可见文案就会撑破布局**。抄"写清楚"的意图，别抄它的落位。
21. **给 8 档比例/9 档时长按钮组**：模型只有 1 个、参数集合固定时才划算。我们若支持多模型多参数，需先做参数能力表再决定控件形态。
22. **`min-w-[820px]` 表格 + 无虚拟滚动 + 无时间分组**的大列表策略：他们数据量小所以没暴露问题。**不要照抄"永远全量渲染"这件事本身**，超过 500 行就该考虑分组或窗口化。

