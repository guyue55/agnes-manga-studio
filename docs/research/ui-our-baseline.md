# UI/UX 现状基线盘点 —— Agnes 漫剧工坊 · 本地版（`public/`）

> 盘点时间：2026-09-18（锚定 HEAD `5150829`）。**并行会话说明**：本盘点读取后，工作树内 `projects.js:159`、`storyboards.js:246/459/468` 已被并行修改（E8 部分落地：planned_episodes/shot_number/duration_seconds 加 Math.min/max 钳制；行号未漂移）。本文其余引用仍以读取时工作树为准；E8 行已按实况标注。
> 范围：`public/index.html`(21 行) · `css/app.css`(902) · `js/app.js`(199) · `js/ui.js`(253) · `js/consts.js`(381) · `js/api.js`(99) · `js/pages/`：helpers(66) dashboard(146) projects(177) scripts(366) storyboards(491) images(284) videos(404) tasks(318) assets(247) settings(427)，共 4,781 行。
> 口径：全部结论基于逐行读码 + grep 统计，标注 file:line（相对 `public/`）。已知开放项 E4/E5/E7/E8/R4/F19/F20 只做核对（§6），正文标注的新缺口均为对照 `docs/issues.md` 全文排除后的**新发现**。
> 复现：文内统计命令均在 `public/` 目录执行（§3/§4 附原文）。

---

## 0. 全局壳层

### 0.1 信息架构

| 项 | 事实 | 出处 |
|---|---|---|
| HTML 骨架 | 21 行空壳：`.app > aside#sidebar + main > div#view`，`#toasts`、`#modal-root` 两个全局挂点；其余全部 JS 渲染 | `index.html:11-18` |
| 路由 | 纯 hash 路由 `#/page?params`；未知路由**静默回落 dashboard**，地址栏保留坏 hash，无 404 状态 | `js/app.js:44-59` |
| 页面容器 | 每次 render 新建 `.page`（padding 26/30/60，max-width 1440）+ 240ms pageEnter 动画；`modal-root` 整体清空（UX-2 僵尸弹窗防护） | `app.js:63-71`、`css:191-200` |
| 滚动 | 路由切换无条件 `window.scrollTo(top:0)` | `app.js:81` |
| 侧边栏 | 固定 260px，brand + 9 导航钮（40px 高）+ footer（版本 + 数据目录，path 超 30px 截断隐藏）；`tasks` 项带 running_videos 金色角标；每次 render 整体 `innerHTML` 重挂 | `app.js:84-111`、`css:84-181` |
| 全局数据 | 启动 `health → bootstrap → render → SSE`；SSE `video/batch` 两类事件经 `onEvent` 发布 | `app.js:114-199` |
| 断连处理 | health 失败 → 12s 红色 toast 说明"本地服务未启动"（E9 已修）；SSE onopen resync 避开弹窗/播放（E1 已修） | `app.js:145-196` |
| 启动空窗 | boot 为 `await health → await bootstrap → render`，期间 `#view` 纯空白，无任何 boot-loading/skeleton | `app.js:178-186` |

### 0.2 共享组件清单（`ui.js` + `helpers.js` + `css/app.css`）

| 组件 | 实现处 | 能力 | 缺口 |
|---|---|---|---|
| toast | `ui.js:10-36` | ok/err/warn/info 四型、色条、点击关闭、时长分级 | 无 `aria-live`（已知 F19）；无操作钮/撤销位；无最大堆叠限制 |
| modal | `ui.js:45-104` | ESC 关最上层、Tab focus 陷阱、自动聚焦首个输入/安全钮、`body.modal-open` 锁滚动、`onDismiss`（R1/N1 修复） | 无 `role="dialog"`/`aria-modal`/标题关联；遮罩点击**直接关闭无守卫**（见 0.4） |
| confirm | `ui.js:112-148` | danger 变体、checkbox 返回值、危险钮不获焦 | — |
| prompt | `ui.js:151-183` | Enter 提交、MutationObserver 兜底 resolve | 仅 2 处调用（tasks 绑定 video_id） |
| empty | `ui.js:196-198` | 图标+标题+描述 | **无 action/CTA 插槽**（§5 G-9） |
| spinner/loading | `ui.js:200-202`、`css:806-816` | 全局 spinner + loading-wrap | **全站 0 骨架屏**，加载一律 spinner |
| setBusy | `ui.js:227-253` | 禁用+spinner+秒表计时 | title 固定"模型生成 20〜60 秒"（已知 F20①） |
| options() | `ui.js:205-217` | "(当前)"存量值保留（R8 修复） | — |
| head/projectPicker/batchBar | `pages/helpers.js:6-47` | 统一页头（h1 左、actions 右）、项目下拉、批量进度条 | batchBar 无 ETA（§5 G-10） |
| 表单构造器 3 个 | `helpers.js:50-66` | selectField/inputField/textareaField | **0 个页面 import，纯死代码**；各页逐处手写 `field` 模板 |
| `on()`/`dataOf()` | `ui.js:187-194` | 批量绑事件助手 | **0 处使用**；页面各自造 `bind/bindOne`（storyboards:161、tasks:202、images:216 三份近亲） |
| CSS 组件族 | `app.css` | card/btn×5 档/badge 8 色/table/grid 2-3-4/hero/stat/quick/asset-card/task-row/progress/note 4 色/modal/tabs/segmented/chip/switch/json-out/kv | `btn-ghost`、`.card.hoverable`、`.g4`、`.badge .dot(.pulse)`、`.breathing` 定义后 0 引用（§4.3） |

**组件矩阵**（●=用 ◐=局部 ○=无）：

| 页 | modal | confirm | toast | empty | spinner | setBusy | segmented | tabs | chip | switch | progress | batchBar | SSE订阅 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| dashboard | ○ | ○ | ● | ● | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| projects | ● | ● | ● | ● | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| scripts | ● | ● | ● | ● | ● | ○(手搓) | ● | ● | ● | ○ | ○ | ○ | ○ |
| storyboards | ● | ● | ● | ● | ● | ● | ○ | ○ | ○ | ○ | ● | ● | ● |
| images | ● | ● | ● | ● | ● | ●+手搓 | ● | ○ | ○ | ● | ○ | ○ | ○ |
| videos | ○ | ● | ● | ● | ● | ● | ● | ● | ● | ○ | ○ | ○ | **○** |
| tasks | ● | ● | ● | ● | ● | ● | ○ | ● | ○ | ○ | ● | ○ | ● |
| assets | ● | ● | ● | ● | ● | ● | ○ | ● | ○ | ○ | ○ | ○ | ● |
| settings | ● | ● | ● | ○ | ● | ● | ○ | ○(自造侧栏) | ○ | ● | ○ | ○ | ○ |

自造轮子明细：① scripts 页计时器（`scripts.js:136-142`）与 setBusy 秒表是两套实现；② images 生成同时挂 setBusy **和**自绘状态行（`images.js:161-162`，双指示器）；③ settings 用 `.nav/.nav-item`（侧边栏类）自造分节导航（`settings.js:30-31`）；④ tasks 搜索框样式全 inline 覆盖 `.input`（`tasks.js:51-54`）；⑤ videos 诊断面板整块手写内联样式卡片（`videos.js:335-368`，含 `rgba(52,211,153,…)`, `rgba(248,113,113,…)` 两枚**不在色板 token 里的**色值，`css:831` step-row.error 同）。

### 0.3 状态覆盖矩阵（壳层）

| 状态 | 有无 | 事实 |
|---|---|---|
| 空态 | ✅ `empty()` 统一，无 CTA | `ui.js:196` |
| 加载态 | ⚠️ 仅 spinner；boot 首帧空白 | `app.js:178-186` |
| 错误态 | ⚠️ 页面级 `note red`（`app.js:79`）；bootstrap 失败**完全静默**（`app.js:115-117` 只有 if，无 else） |
| 禁用态 | ✅ CSS 统一 `.btn:disabled opacity .42`、input 0.5 | `css:281,341` |
| 进行中 | ✅ setBusy/SSE/batchBar 三层 | `ui.js:227` |

### 0.4 壳层交互缺口（新发现，均未见于 issues.md）

| # | 缺口 | 证据 |
|---|---|---|
| G-1 | **全局键盘快捷键 0 个**：keydown 只存在于 modal/prompt 内部（ESC/Tab/Enter）；无 ⌘K 导航、无 ⌘↵ 提交表单、无 `r` 刷新、搜索框无 `/` 聚焦 | `grep keydown js/` 仅 `ui.js:83,172` |
| G-2 | 表单类 modal（新建项目/编辑镜头/模板编辑）**Enter 不提交**，必须移手点保存；只有 `prompt()` 绑了 Enter | `ui.js:172-175` vs `projects.js:147-167`、`storyboards.js:455-486`、`settings.js:375-391` |
| G-3 | **遮罩点击/ESC 无脏值守卫**：填了半天的表单误点遮罩即整个消失，无"放弃更改？" | `ui.js:59-61,70-72`（close 即 `mask.remove()`） |
| G-4 | modal 无 `role="dialog"`/`aria-modal`/标题关联；toast 无 `aria-live`；侧栏无 `aria-current` —— 全库 aria 仅 3 处 `role="switch"`+`aria-checked` 和 assets 按钮 `aria-label` | `grep aria` 仅 `settings.js:139,165`、`images.js:66`、`assets.js:77-125` |
| G-5 | 可点击卡片全是 `div onclick`：asset-card×3 页、proj-card×2 页、素材文本卡——**键盘完全不可达**（无 tabindex、非 button），与 focus-visible 体系脱节 | `dashboard.js:87,117`、`projects.js:46`、`images.js:198`、`assets.js:72,93,119` |
| G-6 | `api.js` fetch 无 AbortController/超时/取消：请求悬挂时 setBusy 秒表永远转（finally 等 promise settle），UI 无"取消"入口 | `api.js:6-28`（`AbortController` 全库 0） |
| G-7 | 点击当前页导航项无反应但 sidebar 整体重挂，按钮获焦后焦点丢失（tab 序从头开始） | `app.js:108-110` + renderSidebar 全量 innerHTML |
| G-8 | 未知 hash 静默回落 dashboard，地址栏与高亮态不一致，无提示 | `app.js:58` |
| G-9 | 全站空态"说明型"：只告诉你去哪，不给按钮（如 projects 空态文案"点「新建项目」"指向页头钮，无内联 CTA） | `ui.js:196-198` + 13 处调用点 |
| G-10 | 长任务无预估/ETA：batchBar 只有 done/total 与百分比（`helpers.js:30-47`）；setBusy 只报已耗秒数（`ui.js:240-243`）；无"约剩 N 秒"推算，尽管 done/total+elapsed 已具备推算条件 |
| G-11 | 术语漂移：同一实体四处叫法不一——"故事脚本/已保存脚本/剧本/文本素材"（`scripts.js:57` vs `assets.js:132` vs `assets.js:31`）、"镜头任务/视频任务/任务"（侧栏 vs `videos.js:56` vs `tasks.js:41`）；同一动作"生成视频"在 images 卡片、分镜表行、videos 页三处语义各异（跳转 vs 提交） | 各 line |
| G-12 | 视图状态不写回 hash：页内切 tab/项目/集数/设置分节均只改内存（`scripts.js:65-67`、`storyboards.js:64-65`、`assets.js:35-48`、`settings.js:36-38`），F5/回退即丢；只有跨页跳转写 hash → "回到上页恢复现场"不存在 | §2 各页 |

---

## 1. 工作台 dashboard

**信息架构**（顺序）：页头（标题+`新建项目`primary+刷新）→ hero 装饰卡（无动作）→ 6 stat 卡（auto-fit min150）→ "快速开始" 6 入口（min180 网格）→ 最近项目（≤6，g3）→ 最近生成（图 6+视频 4，asset-grid）。主 CTA：页头右上 `新建项目`（`dashboard.js:17`）。密度：1440×900 下各区块合计约 810px，首屏可见约 2/3；最近项目 g3 一行 3 卡、最近生成一行 5-6 张 190px 卡。

**状态**：加载 ✅ 三处独立 spinner（`:24,37,40`）；空态 ✅ 两条文案通顺（`:84,114`）；**错误态 ❌**——`load()` 四个请求全部只写成功分支（`:68,80,108-111`），任一失败：stats/projects 区**spinner 永转**，images/videos 失败被并入"还没有生成内容"空态（**谎报**）。禁用态 ❌（快速入口永不禁用）。无进行中区：`running_videos` 仅侧栏角标可见，工作台首页看不到"正在跑什么"（新）。

**交互缺口（新）**：D-1 错误分支缺失（上）；D-2 hero 是 96px 纯装饰（`css:507-517`），CTA 与页头重复；D-3 最近生成图片卡点击→assets?tab=image、视频卡→tasks，跳转方向不对称且不可发现（hover 才现 overlay）；D-4 项目卡点击→storyboards 但无任何视觉提示"进入即分镜"。

---

## 2. 项目管理 projects

**信息架构**：页头（`新建项目` primary + 刷新）→ g3 卡片流（无分页容器）。密度：1120px 内容宽 → 3 列 × 卡高约 268px，一屏 6-9 个项目。主 CTA：页头右上。卡内 5 操作钮 btn-xs 一行（进入分镜/编辑/复制/导出/删除）。

**组件**：modal+confirm+toast+empty+spinner 全用；**setBusy 一处不用**。**自造**：项目卡整段模板（`projects.js:45-74`）未走 helpers 表单构造器；统计区（分镜/图片/视频数）为拉三个全量列表客户端 countBy（`:35-43`，已知 S2）。

**状态**：加载 ✅ spinner；错误 ✅ `note red`（`:28`）；空态 ✅ 有（`:31`）；禁用 ❌ 无灰置逻辑；进行中 ⚠️ 残缺——**复制/保存/删除执行中按钮无 busy 无防双击**（`:84-87` dup 直接 await、`:150-166` 创建/保存双击=两个同名项目）。R6 修复只给 storyboards 加了 `submitBusy`（`storyboards.js:313`），projects 是 R6 点名（`docs/issues.md:246`）却未覆盖的残留——**新**。

**交互缺口（新）**：P-1 无搜索/筛选/排序，"进行中/已归档"只能靠卡上 badge 目测，无法切换过滤；P-2 导出走 `window.open` 新标签（`:89`），无 loading 无失败反馈；P-3 删除确认文案里 cascade 后果说明清楚（`:95-99`，文案质量佳），但**归档→恢复无任何专门流程**（只能编辑卡改 status）；P-4 卡片为 div（G-5）；P-5 预计集数无校验属已知 E8。

---

## 3. 故事脚本 scripts

**信息架构**：页头（标题+项目下拉+刷新；**无 primary 动作**）→ 左右双栏 1.55:1（inline grid，`:37`）。左列：5 类型 segmented → "生成输入"卡（动态模板变量字段 → 模型下拉+`生成内容` primary）→ 结果区（生成后才出现）→ "脚本优化"chips 卡。右列：已保存脚本卡流。密度：一屏 ≈ 输入卡全貌 + 结果卡开头；已保存列表每条约 150px（含 110px 预览）4-5 条。主 CTA：左栏卡内底部 `生成内容`（`:48`），字段多时位于首屏折叠线附近。

**组件**：segmented/tabs(结果 格式化|原文)/chip(优化)/modal(集数输入)/empty/spinner/toast 齐全；**不用 setBusy**，自绘 spinner+秒表（`:137-142`，与 setBusy 功能重叠的第二套）。

**状态**：加载 ✅（fields spinner `:44`）；模板缺失态 ✅ 文案指向明确"去设置→提示词模板新建"（`:92`，**但无法一键跳转**，G-4 settings 无 hash 深链，新）；错误 ✅ note red（`:321`）；空态 ✅ 两条（`:114,324`）；进行中 ✅ 状态行+秒表+按钮禁用（`:135-142`）；**优化 chips 进行中无按钮态**——`optimize()` 仅改 `#gen-status` 一行（`:238`），chip 本身可连点（有 `generating` 早退但无视觉反馈，`:235`，新）。

**交互缺口（新）**：S-1 `保存到项目`无防双击（`:208-220`，R6 点名行未修→双击=两条重复记录）；S-2 切 tab 时结果卡仍显示上一 tab 的 result（E4 已知，此处核对其另一半：`saved` 列表同 stale）；S-3 结果卡三个动作钮（复制/保存/导入分镜）btn-xs 排右上角，破坏性"导入分镜表"与普通按钮同权重；S-4 已保存列表无搜索/时间排序/分页，预览硬截 700 字符（`:337`）；S-5 模型下拉放在生成行左侧 190px 定宽（`:47`），与 settings 默认模型联动关系不可见。

---

## 4. 分镜制作 storyboards

**信息架构**（页面最重）：页头（项目下拉+集数下拉+刷新；无 primary）→ "从脚本一键生成分镜表"卡（textarea + 生成 primary-sm + 手动添加 + 批量补提示词×2）→ batch-bar 挂载点 → 批量工具条卡（全选/已选 N/批量出图/批量出视频/清空本集）→ 11 列分镜表。主 CTA：卡内 `生成第 N 集分镜`（`:35`）；批量区三个钮**均无 primary 权重**（`:52-54`）。密度：表行高 ≈43px（td 11×2 + 20 行距），900px 视口约 14 行；**表总最小宽 ≈1,572px**（列宽合计 1,264 + 11×28 单元格 padding，`:114-124`）> 1,120px 内容宽 → **1440 屏必横滚，且 thead 无 sticky、操作列无右粘**。

**组件**：modal（镜头编辑 15 字段 wide）/confirm×2/setBusy（生成类钮）/batchBar/empty/spinner/toast 全链最齐；SSE batch 订阅+cleanup 规范（`:80-88,490`）。自造：`bind()` 事件绑定助手（`:161`）；promptCell 待生成占位（`:178`）。

**状态**：加载 ✅；错误 ✅ note red；空态 ✅ "第 N 集还没有分镜"（`:109`）；模板失败兜底 ✅✅ **全库最佳错误文案**：解析失败弹窗给出字符数+可换模型建议+原文（`:233-239`）、poll 降级提示（`:363-364`）；禁用 ✅ sb-sel（images 页）；进行中 ✅ batchBar+promptBusy 互斥（E2/E3 已修，核对属实）。

**交互缺口（新）**：
- **T-1 输出比例全链路固定横屏**：批量出视频与单发出视频写死 `width:1152,height:768`（`:359-360,405-406`），批量出图写死 `1024x1024`（`:324,381`）；项目 `aspect_ratio` 唯一读取处是卡片 badge（`projects.js:58`），**"9:16 竖屏"项目默认产出 5s 横屏视频**——竖屏漫剧核心场景直接受害（`1152` 在 issues.md 全文 0 命中，非已知项；R4 只管时长）。
- T-2 集数下拉硬编码 1-30（`:62-63`），与 planned_episodes 无联动，第 31 集不可达且无提示。
- T-3 **全选框会撒谎**：行级 checkbox 只更新计数文本，不回写 `#sel-all`（`:154-160` vs `:74-78`）——取消勾选一行后"全选"仍呈选中态；无 indeterminate 半选。
- T-4 批量完成事件触发 `load()` 整表重渲染（`:84-87`）：表格 scrollLeft/scrollTop 归零，正横向看右列提示词的用户被弹回起点（E5 是 tasks 页同类，此处为新点位）。
- T-5 排序只有上移/下移单步按钮（`:170-171`），无拖拽、无按状态/景别筛选；行操作 6 钮全 icon-only 28px。
- T-6 提示词列 max-width:180px inline 截断 + title 原生 tooltip（`:180`），hover ~1s 才出；无点击展开编辑（要开整卡 modal）。
- T-7 已选集合在 load() 后按 id 保留，但切项目/切集清空（`:64-65`）——同集重新生成后 id 全变，选择丢失无提示。

---

## 5. 图片生成 images

**信息架构**：页头（项目下拉+刷新）→ 双栏 `minmax(320px,.85fr) | 2fr`（`:26`）。左卡：模型→segmented(文生图|图生图)→提示词 textarea rows6→尺寸/用途 g2→**`生成图片` primary block 卡底**（`:71`）。右区：`已生成图片` 标题+count badge+asset-grid。密度：右栏 1120px 下 5 列（minmax190,gap14），一屏约 5×3=15 张。

**组件**：segmented/switch(保留原构图)/modal(预览)/confirm/toast/empty/spinner 齐；**setBusy 与自绘状态行叠加**（`:161-162` 双指示器，第一套的 spinner 被第二套的金色状态行重复）。

**状态**：加载 ✅；空态 ✅（`:194`）；错误 ✅（`:181`）；图片 onerror 兜底 ✅ 全库唯一"失败后替换为提示块"（`:200`）；进行中 ✅；禁用 ✅ sb-sel"请先选择项目"（`:110-113`）。**半覆盖**：fav 无 busy 无防双击（`:219-223`，连点发多次 PUT 竞态渲染，R6 只提到 fav 吞错未提连点，新）。

**交互缺口（新）**：I-1 关联分镜下拉不显示集数（`:118`，跨集 `#1/#2` 撞号误选）；I-2 图生图 URL 校验只在提交时 toast，无 blur 即时校验/预览加载失败提示（`onerror` 藏图=静默，`:231` 同 videos）；I-3 画廊无搜索/按用途筛选/日期分组，count 只显总数；I-4 `生成视频`跳 videos 携带 image_url，若仅本地图 toast 警告（`:245-247` 文案好）但**跳转已发生**，用户到达后才知不可用（顺序可商榷）；I-5 预览 modal 内 img 无点击放大/原图链接（`:263`）。

---

## 6. 视频生成 videos

**信息架构**：页头（项目下拉+**模型下拉塞在 head actions**+刷新）→ 双栏 1:1.25。左：4 模式 segmented + 2.5 协议 note（动态插拔 `:85-93`）+ 表单卡（按模式四套模板，每套底部 `primary btn-block` 提交）+ 提交后诊断面板。右：`最近视频任务` ≤8 条 task-row。密度：左表单 i2v 约 420px，右每行 ≈86px。

**组件**：segmented/chip(时长预设)/empty/confirm/toast/setBusy 用；**modal 一次不用**——诊断面板是 append 进表单卡的自造内联卡片（`:335-368`，含两套非 token 色）。**不用 empty() 于 diag**、不用 options 于 res。

**状态**：加载 ✅（recent spinner）；空态 ✅（`:385`）；错误 ⚠️ 双重呈现——`toast.err(r.error)` + 诊断面板（好例：三步骤 step-row + 超时三态指引 `:353-358`，文案质量全库前二）；进行中 ✅ setBusy label "提交中（图生视频可能 1-2 分钟）"（`:302`，**全库唯一给出耗时预估文案的提交钮**）；禁用 ✅。

**交互缺口（新）**：
- V-1 **右侧"最近视频任务"不订阅 SSE**（import 无 onEvent，`:1-13`）：提交后状态永远停在"已提交/排队中"，直至手动点刷新——与本页存在的目的（观察任务）直接矛盾（tasks 页有订阅，E5 反而是它订阅引发的重绘，此处是欠订阅，方向相反的新缺口）。
- V-2 切项目**不清参考图字段**：`picker.onchange` 只重 loadImages+renderForm（`:67-72`），`S.i2v.image`/`S.kf.*`/`S.multi.imgs[].url` 全保留旧项目图 URL → 张冠李戴提交（E4 同型、不同页，新）。
- V-3 recent 行**不可点击**（`:388-398` 纯展示），无详情/播放入口，要去 tasks 找——操作闭环断裂。
- V-4 时长 chip 与 fps/seed 三行参数四模式复制 4 遍（paramsBlock 复用但绑定 `nextElementSibling` 脆耦合，`:138-139`）。
- V-5 t2v 分辨率可选 3 档，其余三模式**写死 1152×768**（`:276,286,295`）——i2v 用户无任何比例控制，且与 T-1 同根。
- V-6 诊断面板渲染后不自动滚动可见（表单长时它在卡底部）。

---

## 7. 镜头任务 tasks

**信息架构**：页头（`批量补充视频地址` btn-sm + 刷新 btn；**主 CTA 色彩权重低**，`:37-38`）→ 过滤行（tabs 全部|视频|图片|文本 + 状态 select + 搜索框）→ task-row 流。密度：每行 145-275px（含 130px 视频预览），一屏 3-5 行；无分页无虚拟（F17 已知，此处不重复计新）。

**组件**：tabs/progress/modal(详情 wide)/confirm(**仅视频删**)/setBusy/prompt/toast/SSE。

**状态**：加载 ✅（首载 spinner）；空态 ✅ "没有符合条件的任务"（`:107`）；错误 ❌ **`load()` 两请求无失败分支**（`:81-84` if(v.ok)/if(t.ok) 无 else → 接口挂了显示成空态，同 D-1，新）；进行中 ✅ busy Set + spinner 替换 icon（`:165`）；三态警示 ✅✅ poll_timeout/url_missing/submit_timeout 各有专属橙色 note + "未确认前请勿重复提交"（`:150-160`，文案优秀，作基线正例）。

**交互缺口（新）**：K-1 **状态过滤器只列 9 个 VIDEO_STATUS**（`:47-50`），而文本/图片任务 status 是 completed/failed/pending 命名域——选"排队中"图片/文本整类消失、选"待处理"（pending）根本无此选项，静默筛空被误读为"没有任务"；K-2 refresh 成功后 `load()` 全表重拉（`:222`）与 E5 部分重叠但独立点位：fav/save/delete 成功也各自全表重拉（`:209,246,293`）；K-3 搜索仅命中 prompt/name 与 `JSON.stringify(input_content)` 全文（`:94-102`），搜 video_id 搜不到（列表根本不显示 video_id）；K-4 无按时间/状态排序，无"只看需要我处理的"（refetch 状态快捷筛选）；K-5 行内 5-6 个 icon-btn 无 primary/危险分层（删除与收藏同尺寸同底色，仅 hover 变红）。

---

## 8. 素材库 assets

**信息架构**：页头（项目下拉(含全部)+`只看收藏`+刷新）→ tabs（图片|视频|文本）→ 内容区（图/视频 asset-grid，文本卡流）。密度：图片 5 列 × ~142px 高一行 ≈15 张/屏；文本卡约 220px 一屏 4 条。主 CTA：**无**——页头三件全是过滤器（`:23-27`），生产动作要靠空态文案指路（`"去「图片生成」…"`）。

**组件**：tabs/empty×3/modal(预览/播放)/confirm×3/setBusy(仅"保存到本机")/SSE(700ms 防抖+弹窗避让，`:236-245` 好例)/statusBadge。

**状态**：加载 ✅；空态 ✅×3 文案对称；错误 ❌ 三接口无 else（`:50-56`，失败→"没有图片素材，去生成"，**谎报**，同 D-1，新）；进行中 ✅ save 钮 busy；禁用 ❌。

**交互缺口（新）**：A-1 **无搜索/排序/批量操作**：连删 20 张图=20 次 hover+20 次 confirm；无多选、无批量删除、无批量下载（storyboards 有 selection 范式却未迁移）；A-2 文本 tab 预览 modal 无复制/编辑/跳转脚本页动作（`:140`）；A-3 收藏过滤器 active 态用 `btn-primary` 类切换（`:39`）语义借位、无 `aria-pressed`；A-4 视频卡 grid 全量 `preload="metadata"`（`:97-99`）：100 条=100 个元数据请求（与 F17 分页不同根，属媒体加载策略缺失，新）；A-5 本地视频路径 `/assets/videos/<basename>` 字符串拼接出现 3 处（`tasks.js:148`、`assets.js:97,219`），命名规则变更需 3 点同改（debt）。

---

## 9. 设置 settings

**信息架构**：自造左侧 190px 分节 nav（复用 `.nav/.nav-item`）+ 右 panel。6 节：API/模型/任务/提示词模板/数据/关于。主 CTA：每节卡内 `保存` primary（`:97,143,169`）。密度：API 节两字段+5 动作钮一屏全见；模板表 4 列无上限行。

**组件**：modal×2(模板/导入)/confirm(删模板、清空)/setBusy(拉模型/测试)/switch×2/empty **不用于模板表**（templates=[] 时表体空白，无空态行——新，`grep empty( settings.js` 0）。

**状态**：加载 ⚠️ panel 同步渲染，`api.settings()` 失败**静默用 `{}`** 渲染出全空表单（`:41-43` if.ok 无 else，用户以为数据丢了，新）；错误 ✅ test-out note red（`:288-290`）；进行中 ✅；禁用 ✅ key input 默认 disabled 的显式编辑态（`:89-91`，好设计：password→点编辑才放开）。

**交互缺口（新）**：
- **SE-1 导入 `replace` 模式无二次确认**：下拉选"替换（清空后导入）"后点`开始导入`直接执行（`:404-417`）——与同节"清空全部数据"要走 confirm+danger 红钮（`:346-352`）形成防护不对称；一次误点=全库被换。
- SE-2 `toggle-key`/拉模型成功后调 `render()` **整面板重渲染**：焦点丢失、滚动位置视长度可能重置（`:257,312`）。
- SE-3 `保存配置`/`开始导入`/模板`保存` 均无防双击（`:259-264,412,377`，R6 残留同 P-1/S-1，双击导入=两次写库）。
- SE-4 分节不进 hash：其他页 4 处文案"去设置页改/新建模板"（`scripts.js:92` 等）无法直达（G-12 的 settings 实例）。
- SE-5 Key 保存后自动拉模型（`:53-57`）成功/失败只有 toast，`#test-out` 不联动显示目录变化。
- SE-6 模板表无内容预览列，`{{变量}}` 写没写对只能开编辑框核对。

---

## 10. 视觉规格事实（全部 grep 自 `css/app.css` 902 行 + JS 模板）

### 10.1 字号档位（**无 token，14 档半像素阶梯**）

`grep -oE "font-size: ?[0-9.]+px" css/app.css | sort | uniq -c | sort -rn`

| px | 10 | 10.5 | 11 | 11.5 | 12 | 12.5 | 13 | 13.5 | 14 | 15 | 16 | 24 | 25 | 26 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CSS 次数 | 1 | 3 | 7 | 8 | 8 | 6 | 4 | 5 | 2 | 3 | 1 | 1 | 1 | 1 |
| JS inline 次数 | 8 | 1 | 7 | 10 | 7 | 7 | 3 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |

- 10〜13.5px 区间挤了 8 档（每 0.5px 一档）；JS 内联 font-size 共 54 处（`grep` 口径），其中 `10px`（tasks 行内 badge，8 处）低于 CSS 最低档。
- 全局基准 14px（`css:58`），但**页面上没有任何一处 14px 正文**（14 仅 .empty .t）。

### 10.2 间距值分布（app.css padding/margin/gap 字面量）

- **28 个不同 px 值**：1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,18,20,22,24,26,28,30,32,40,50,52,60（`grep` 见 §0 方法）。1〜16 每 1px 都有档位，16 以上跳 18/20/22/24/26/28/30/32——**近似连续谱，非标尺**。
- gap 档 13 个：2,3,4,5,6,7,8,9,10,11,12,14,16（`gap:10px` 最多 8 次）。
- padding 组合 40 种字面量（无一相同模式超过 2 次，如 `16px 18px`/`12px 15px`/`11px 14px` 各 2 次——**碎片化的直接证据**）。
- JS 内联 margin-bottom 11 档、margin-top 11 档、gap 8 档（多为 12/14/16 之争，`scripts.js:37` `gap:20px`、`settings.js:29` `gap:22px`、`storyboards.js:31` `margin-bottom:18px`、`dashboard.js:24` `22px` 混用同族值）。

### 10.3 圆角档位（**15 档 vs 3 个 token**）

token 只有 `--radius-card:20 / --radius-btn:14 / --radius-input:14`（`css:37-39`）。app.css 字面量另用 2,4,6,7,8,9,10,11,12,13,14,16,18,24,50%（18 次声明）；JS 内联又用 8/10/14 三档（10 处）。"卡片族"圆角三个值打架：`.card/proj-card` 20（token）、`.task-row` 18（`css:654`）、`.hero/.modal` 24（`css:509,726`）。

### 10.4 z-index 层级表

| 值 | 用途 | 出处 |
|---|---|---|
| 2 | asset-card 角标/状态 flag | `css:640,647` |
| 20 | 固定侧边栏 | `css:96` |
| 100 | modal-mask（含背景 blur） | `css:713` |
| 200 | toasts | `css:773` |

全库仅这 4 档、无 token 化；JS 侧 0 处 z-index（`grep -rn z-index css js`）。**无层规范**：嵌套弹窗（assets 双层 modal，已 R5 修）当时全靠 DOM 顺序而非层级。

### 10.5 尺寸/控件规格事实

- 控件高度 7 档：27(btn-xs)/29(select-xs)/32(btn-sm·icon-btn-sm)/34(select-sm·segmented钮·搜索框)/36(btn-icon)/40(nav-item)/42(btn·input 标准)；icon-btn 28、mini-btn ~21。**点击热区普遍 <40px**（Mac 指针可接受，但与"专业软件"密度定位的 44px 惯例相悖）。
- modal 宽度二元制：560/900（`css:728,734`），无第三档；`max-height:88vh` 内部滚动。
- 图标：47 个内联 SVG（`consts.js:9-57`），icon() 调用 size 参数 9 档（9,10,11,12,13,14,15,16,19），**13(36 次)/14(27 次) 为主**，行内钮 13-14、页头 15-16。
- **动效**：8 组 keyframes（pageEnter/fadeIn/modalIn/toastIn/toastOut/spin/pulse/breathe），其中 pulse、breathe 随死类 0 引用；时长 160/180/200/220/240/500/700/1600/2000ms 混用无档位；缓动只有 `ease` 与 cubic-bezier(0.22,1,0.36,1) 两种。
- 响应式仅 1 断点 `max-width:900px`（`css:894-902`），侧栏收 66px 图标条。

---

## 11. CSS 债务

### 11.1 内联 style 注入密度（JS 模板里的 `style="`）

`grep -c 'style="' js/**.js` —— **全前端 224 处**（组件渲染字符串内，非运行时注入）：

| 文件 | tasks | storyboards | videos | settings | scripts | assets | images | helpers | dashboard | projects | ui.js |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 处数 | 40 | 40 | 35 | 28 | 24 | 19 | 15 | 7 | 7 | 5 | 4 |

密度梯度与页面复杂度正相关：最重的三页（tasks/storyboards/videos）占 51%。CSS 无 utility 层是根因——间距、字号、栅格列全部只能 inline。

### 11.2 高频重复内联声明（同一字符串 ≥3 次）

| 重复串 | 次数 | 语义（应抽的类） |
|---|---|---|
| `background:rgba(255,255,255,0.07);color:var(--text-2)` | 13 | icon-btn 的"表格/行内"变体（基础类只服务图片 overlay，`css:607-620` 契约错位） |
| `grid-column:1/-1` | 12 | 网格通栏 |
| `margin-top:14px` / `:12px` | 7/7 | 块间距 |
| `gap:0 14px` | 6 | g2 表单网格列距 |
| `font-size:10px` | 6 | 超小徽标 |
| `margin-bottom:12px/:14px` | 6/5 | 块间距 |
| `font-size:12px;color:var(--text-3)` | 5 | 次级说明 |
| `flex:1;min-width:0` | 5 | 弹性列收缩 |
| `background:…0.07);color:var(--text-3)` | 4 | icon-btn 弱化变体 |
| `font-family:var(--mono)` | 4 | 等宽（已有 `.mono` 类未用在此处） |

其他逐例：`.progress` 定宽 240px 两处反向 override（`helpers.js:44` max-width:none、`tasks.js:137` 再包 240px 壳）；`.cell-ellipsis` 的 max-width 被 storyboards 5 处 inline 重设（`:133-135,180`）；assets 文本卡 inline `aspect-ratio:auto` 对抗 `.asset-card` 的 4/3（`:119`）。

### 11.3 死代码 / 悬空类

- **CSS 定义、全库 0 引用**（脚本比对 app.css 类名 × js+html 全文）：`.card.hoverable`(css:234)、`.btn-ghost`(306)、`.g4`(491，仅 media 查询顺带)、`.badge .dot`+`.dot.pulse`(454-460，**含一段活 keyframes pulse**)、`.breathing`(819，含 breathe keyframes)。
- **JS 用类、CSS 无定义**：仅 `.input-sm` 1 处（`videos.js:240`）——已知 F20②，核对属实（该行同时靠 inline height:36px 救场）。
- `ui.js on()/dataOf()`、`helpers.js selectField/inputField/textareaField`：导出后 0 引用的 JS 死件（页面各自手写/各造 bind）。
- `!important` 全库 1 处：prefers-reduced-motion 兜底（`css:766`）——干净，无滥用。
- 重复声明样例：`backdrop-filter + -webkit-` 成对 12 行/6 处（sidebar/card/modal-mask/toast/mini-btn/icon-btn）；`rgba(214, 181, 109, …)` 金色透明层 app.css 内 25 处字面量 + JS 内联 2 处（无 `--gold-18/22/28/30/32` 半透明度档位）；`--gold-grad` 与 `--gold-soft` 两 token 肉眼近似（`css:21-22`），**soft 定义后 0 使用**。
- 色板外字面量：`#FF9F0A`(badge.orange)、`#7EB6FF`(badge.blue)、`#C9AC72/#FCA5A5/#FCD34D/#86EFAC`(note 四色)、`rgba(248,113,113,.06)`/`rgba(52,211,153,.07)`（step-row.error/videos diag）——同一"橙/绿/红"语义在 badge/note/step-row/diag 四套组件里各写各的色值。

---

## 12. 已知开放项核对（docs/issues.md 第四轮 🐛 项，现状=代码实况）

| 项 | 声明 | 核对结果（file:line） |
|---|---|---|
| E4 | 脚本页切 tab/项目不清 result、不重载列表 | ✅ 属实：`scripts.js:63-67`（tab 点击不调 loadSaved/不清 result）、`:322` filter 依赖 tab 变量但列表 stale |
| E5 | 任务页 SSE 全表重绘、refresh 连点、文本删无确认 | ✅ 属实：`tasks.js:74-78→111` 每条 unshift+render()、`:216-223` busy 只换图标不 early-return、`:295-298` delt 无 confirm |
| E7 | 批量任务切页失联、无取消 | ✅ 属实：`api.js:94-95` batch()/cancelBatch() 0 调用（grep）；`storyboards.js:490` cleanup 退订即失忆 |
| E8 | 数值校验缺位 | ⚠️ 部分属实+并行修复中：fps/seed/轮询间隔仍裸透（`videos.js:123`、`settings.js:154-160`）；planned_episodes/shot_number/duration_seconds 钳制在盘点后由并行会话落地（`projects.js:159`、`storyboards.js:246,459,468`） |
| R4 | duration_seconds 对视频零影响 | ✅ 属实：固定 num_frames:121/fps24（`storyboards.js:357-358,403-404`）；**并补充同族新发现 T-1：宽高同样固定横屏 1152×768（issues.md 未记）** |
| F19 | a11y 三件套（toast aria-live、modal focus 归还） | ✅ 均仍缺；**扩展面**：dialog role/aria-modal/aria-current/aria-pressed 全 0（G-4），可点卡片非 button（G-5） |
| F20 | ①setBusy title ②input-sm ③tab 白名单 ⑤modelChoices 过滤 | ✅ 四点逐一核实存在（`ui.js:235`、`videos.js:240`、`assets.js:12`、`consts.js:117-121`） |
| R6(✅标修) | 修复仅覆盖 storyboards `submitBusy` | ⚠️ **范围残留**：projects dup/save、scripts 保存、settings 各保存/导入仍无守卫（§2/§3/§9） |
| E1/E2/E3/E6/E9/R1/R2/R3/R5/R7/R8/N1 | 已修 | 抽查代码与注释锚点一致（如 `ui.js:90 onDismiss`、`storyboards.js:334-339 videoImageOf`），基线视其为已兑现 |

---

## 13. Top-10 "不需要竞品启发也该修"（按 影响×(1/成本) 排序）

| # | 改动 | 影响 | 成本（估） | 证据 |
|---|---|---|---|---|
| 1 | 导入 `replace` 加 danger confirm（复用现成 confirm({danger})）| 一次误点=全库替换，数据安全不对称 | ~10 行 | `settings.js:404-417` |
| 2 | 分镜批量/单发视频、出图的宽高/尺寸改为读 `project.aspect_ratio` 映射表 | 竖屏漫剧默认横屏成片，产出物方向性错误 | ~30 行（一张映射+2 调用点；顺带消化 R4 一部分） | `storyboards.js:359-360,405-406,324,381`、`videos.js:276,286,295` |
| 3 | dashboard/assets/settings/tasks 四处 `load()` 补错误分支：失败→`note red`+重试钮，杜绝"永久 spinner"与"谎报空态" | 错误可见性 ×4 页 | 每页 3-5 行 | `dashboard.js:68,80,108-111`、`assets.js:50-56`、`tasks.js:80-85`、`settings.js:41-43` |
| 4 | R6 残留防双击：projects dup/save、scripts 保存、settings 保存/导入接 setBusy 或一行 in-flight flag | 重复项目/重复记录/双写库 | ~20 行（复用 `ui.js:227`） | `projects.js:84-87,150-166`、`scripts.js:208-220`、`settings.js:259,314,324,412` |
| 5 | 表单 modal：脏值守卫（关前比较初始值，dirty 则 confirm）+ ⌘/Ctrl+↵ 提交 | 误点遮罩丢长文本（脚本变量、模板正文 8 行 textarea） | `ui.js` modal 加 1 钩子 + 3 页 onMount 各 2 行 | `ui.js:59-61,70-72`、`projects.js:126-143`、`settings.js:365-373` |
| 6 | 全选框与行选择双向同步 + `indeterminate`（半选）| 分镜页核心批量入口的 UI 撒谎 | ~10 行 | `storyboards.js:74-78,154-160` |
| 7 | 视图状态写回 hash：scripts?tab、storyboards?ep(已有则补齐 select 时写入)、assets?tab、settings?sec | 刷新/回退/跨页"去设置建模板"直达（顺带修 F20③ 的白名单落点） | 每页 2-4 行（navigate 已支持 params） | `scripts.js:65-67`、`storyboards.js:64-65`、`assets.js:42-48`、`settings.js:36-38`、`scripts.js:92` |
| 8 | videos 页 recent 订阅 onEvent('video')（学 assets 的 700ms 防抖+弹窗避让）+ recent 行可点开详情 modal | 本页"提交后无从观察"闭环断裂 | ~15 行（现成模式照搬） | `videos.js:13,379-399` vs `assets.js:236-245` |
| 9 | tasks 状态过滤器按当前 tab 提供候选（视频=VIDEO_STATUS，文本/图片=completed/failed/pending），或统一后端状态词 | 静默筛空被误读为无数据 | ~10 行 | `tasks.js:47-50,99-104` |
| 10 | `empty()` 加 `action` 插槽（一个 btn 参数），接入 13 个空态调用点的高频 5 处（项目空→新建、分镜空→生成、任务空→去 videos、素材空→去图片、脚本空→去脚本）| 空态从"指路文案"变一键直达 | 签名向后兼容 + 每点 1 行 | `ui.js:196-198` + §2-§9 各空态 line |

落选说明：骨架屏、全局快捷键、批量选择态迁移到素材库、表头 sticky 等同样低垂但影响面/争议度更高，列入竞品对照后的优化池更合适（避免在自家基线上先入为主）。

---

## 附：本报告统计口径可复现命令

```bash
cd public
grep -oE "font-size: ?[0-9.]+px" css/app.css | sort | uniq -c | sort -rn      # §3.1
grep -oE "(padding|margin|gap)(-[a-z]+)?: ?[^;]+" css/app.css | grep -oE "[0-9.]+px" | sort -u   # §3.2
grep -oE "border-radius: ?[^;]+" css/app.css | sort | uniq -c                  # §3.3
grep -rnE "z-index" css js                                                      # §3.4
for f in js/*.js js/pages/*.js; do grep -c 'style="' $f; done                   # §4.1
grep -rhoE 'style="[^"]+"' js | sort | uniq -c | sort -rn | awk '$1>=3'         # §4.2
# 死类检测：node 脚本比对 app.css 的 \.([a-z][\w-]*) 与 js+html 全文 token（§4.3）
```

*（完 —— 本文件为纯盘点，未改动任何代码。）*
