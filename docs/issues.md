# Agnes 漫剧工坊 · 问题清单与修复记录

> 全维度代码审计（server / lib / public / tools / data）+ 真实 Agnes API 联调中发现的问题。
> 状态标记：✅ 已修复（含提交）｜📌 已知暂不修（附理由）｜🚫 设计如此，非缺陷。
> 每轮审计后更新本文件。验证命令统一为 `node tools/run-all.mjs`（selftest + apitest + uitest + browser-test）。

---

## 一、用户直接报告的问题

### U1. 「生成第 1 集分镜」点了没有加载效果，长时间等待后报"没有返回分镜列表" ✅
- **提交**：`94a5078 fix: 分镜生成 JSON 解析失败与加载态缺失`
- **根因（三层）**：
  1. `agnes-2.0-flash` 在自由输出模式下会吐**语法非法的 JSON**（实测样本：`"narration": " "",` —— 未转义内嵌引号），8.8KB 数据整表报废；
  2. 前端 `extractJson` 只做括号配对 + 一次 `JSON.parse`，坏一处即全失败；
  3. 按钮全程无 loading / 无禁用 / 无秒表，30〜60s 等待期看起来像"没反应"。
- **修复**：
  - `lib/agnes.js`：`chat()` 支持 `response_format:{type:'json_object'}`（约束解码，网关保证输出合法 JSON；实测 20s 返回 8 镜头），不支持的模型 4xx 时自动降级普通请求重试一次；
  - `lib/routes.js`：`/api/agnes/text` 透传 `json_mode`；
  - `public/js/consts.js`：新增 `repairJson`（未转义引号 / 多余引号 / 尾逗号 / 裸换行四类坏输出启发式修复）、`extractJsonArray`（解包 json_object 模式的 `{"shots":[...]}` 包装）；`extractJson` 改为多级兜底；
  - `public/js/ui.js`：新增 `setBusy`（按钮禁用 + 内联 spinner + 秒表，防双击重复扣配额）；
  - `storyboards.js` / `scripts.js`：生成链路全部接入 loading 与 json_mode；解析失败弹窗展示模型原始输出，便于排障。
- **验证**：selftest +12 条坏 JSON 回归用例（含线上真实样本）；真实 API 端到端 20.9s 生成 8 镜头落库成功。

### U2. API Key 配置与模型目录（配置过程发现）✅
- Key 已写入本机 `data/settings.json`（接口只回脱敏值）；`/api/models/refresh` 拉取到 12 个模型。
- 📌 文本模型在目录里 kind 全是 `unknown`（Agnes 未标注），`modelChoices` 的 unknown 兜底逻辑已覆盖，无需改代码。

---

## 二、本轮审计新发现并已修复

### B1. 「清空全部数据」是空操作，却提示"已清空"（高危：数据安全）✅
- **位置**：`lib/store.js` `importAll()` + `settings.js` wipe 流程。
- **根因**：前端 `POST /api/import {collections:{}, mode:'replace'}`；服务端 replace 分支对**备份里缺失的集合直接 `continue`** → 一张表都不会清，接口却返回成功。
- **修复**：replace 语义改为"整表替换：src 缺该集合 → 清空"。
- **验证**：selftest 新增 3 断言（未提供集合被清、空 collections 全库清空、merge 恢复）。

### B2. 删除项目的「连带删除」勾选框永远不生效（UI 谎报行为）✅
- **位置**：`projects.js` 删除分支。
- **根因**：确认框关闭后 `document.getElementById('cascade')` 读 DOM —— 元素已随弹窗销毁，`?.checked` 恒为 `undefined`，**勾了也不会级联**，而且响应 toast 还说"保留素材"，行为与承诺不符。
- **修复**：`ui.js confirm()` 增加 `checkbox:{label,checked}` 配置，勾选状态在点「确定」瞬间捕获并以 `{confirmed,checked}` 返回（无 checkbox 参数时保持 boolean 返回，11 处旧调用点全部兼容）；`projects.js` 改用新 API。

### B3. 级联删除不清理本地素材文件（磁盘孤儿泄漏）✅
- **位置**：`routes.js` `DELETE /api/projects/:id`。
- **根因**：只 `removeWhere` 删记录；单条 `DELETE /api/images/:id`、`/api/videos/:id` 都会 `unlinkSync` 本地文件，级联路径漏了。B2 修复后级联真正会被触发，此问题从"理论"变成"必然踩坑"。
- **修复**：级联时对 `image_assets` / `video_assets` 先取 `local_file` 再删记录，文件同步删除；响应新增 `filesRemoved`，前端 toast 如实展示"连带 N 条数据、M 个本地文件"。
- **验证**：apitest 级联组新增断言：删除前本地文件存在 → 删除后消失、`filesRemoved>=2`（mock 图 + mock 视频各一）。

### M4. 图片页「关联分镜」下拉两处静默失效 ✅
- **位置**：`images.js`。
- **根因**：①下拉仅在**首次渲染时**有项目才输出到 DOM —— 先"未选择项目"进页再切项目，这个功能整个消失；②`picker.onchange` 只调 `load()`，不刷新分镜列表 —— 切项目后下拉里还是旧项目的镜头。
- **修复**：下拉常驻渲染；`loadStoryboards()` 无项目时显示"请先选择项目"并禁用；项目切换与刷新按钮均同时刷新分镜列表与画廊。

### M5. 视频页 multi/keyframe 模式的帧率输入被静默丢弃 ✅
- **位置**：`videos.js`。
- **根因**：表单渲染了 `frame_rate` 输入并绑定 `s.fps`，但 multi/kf 提交 payload 写死 `frame_rate: 24`；且 `S.multi/S.kf` 初始没有 `fps` 字段，输入框初始显示空白。
- **修复**：初始状态补 `fps:24`；payload 使用 `S.multi.fps` / `S.kf.fps`（后端 `num(body.frame_rate,24)` 本来就透传，前端修复即生效）。

### M6. 视频页切项目后表单里的"素材库选择"仍列旧项目的图 ✅
- **位置**：`videos.js` `picker.onchange`。
- **修复**：`loadImages()` 完成后重渲染表单（`submitting` 中不重建，避免打断进行中的提交回调）；刷新按钮同样处理。

### M7. 「批量补充视频地址」无 loading、可重复点击 ✅
- **位置**：`tasks.js` `batchFix()` —— 循环查询远端可能十几秒，按钮毫无反馈。
- **修复**：接入 `setBusy(btn,true,'查询中')` + disabled 防重入。

### T1. browser-test 在本机从未真正跑过（测试覆盖漏洞）✅
- **位置**：`tools/browser-test.mjs` `findBrowser()` 候选只有 Windows 硬编码路径。
- **影响**：真实浏览器冒烟（29 断言，含 console 零错误检查）在 macOS/Linux 上一直被静默跳过，此前多轮前端改动实际只经过静态检查。
- **修复**：补 macOS（Chrome/Edge/Chromium `.app` 路径）与 Linux（`/usr/bin`、`/snap/bin`）候选。修复后本机实测 **29/29 通过**。

### H1. helpers.js 死代码清理 ✅
- `projectStatLine()`（注释说"项目统计"，实现却是 `relTime(id)` 返回时间，纯错误残骸）与 `batchBar()`（全库无调用）删除；`relTime` import 一并清理。`selectField/inputField/textareaField` 虽是未用导出，但实现正确、属通用表单构建器，保留。

### B4. 「清空本集」未选项目时会删光所有项目的同号集（高危：数据丢失）✅
- **位置**：`routes.js` `DELETE /api/storyboards` + `storyboards.js` `clearEpisode()`。
- **根因**：该端点语义是"清空某项目某集"，但过滤条件是 `(project_id ? … : true) && (episode ? … : true)` —— **不带参数 = 清空全部分镜表**，只带 `episode` = 跨项目删同号集。前端页面若处于"未选择项目"状态点清空，就会发出 `?episode=N` 裸请求。
- **修复**：后端强制 `project_id` 与 `episode` 同时必须存在否则 400（校验在删除前，无副作用）；前端 `clearEpisode` 增加未选项目守卫；apitest 新增 5 断言（三种缺参 400 + 拒绝无副作用）。
- **线上验证**：对运行中实例发裸 DELETE 与只带 episode 的 DELETE → 均 400，用户 8 镜头数据完好。

### M8. 断连导致按钮永久锁死（预防性加固，全站生成入口）✅
- **根因**：`api.js req()` 只包住了 `fetch`，`await res.text()` 在连接中途断开时会 throw；`scripts/images/videos/settings` 四处生成/拉取按钮用"先置忙标志、await 后清标志"的裸写法，一次断连即让按钮永久禁用/永久"拉取中"，只能刷新页面救回。
- **修复**：统一 `try/finally` 清锁 —— `scripts.generate`（含 interval 泄漏）、新增缺失的 `generating` 双击守卫与 `optimize` 防重入；`images.generate` / `videos.submit` / `settings` 两个模型拉取按钮改用 `setBusy`（自带 `_origHtml` 还原，顺带消灭 videos 提交后硬编码"重新提交"标签与重复的 `onclick=submit` 绑定）。

---

## 三、已知但暂不修复（边界控制）

| # | 现象 | 不修理由 |
|---|---|---|
| ✅ 已修 | S1 | 素材库页（assets.js）视频标签不订阅 SSE，状态需手动刷新才变 | 第二轮 UX-6 修复：订阅 video 事件增量合并 + 防抖 |
| 📌 S2 | 列表接口默认 limit（storyboards 1000 / images 500 / videos 300），超大库统计卡数（projects.js countBy）会低估 | 单机漫剧场景量级远小于此；改聚合接口需动 store+routes+前端三处 |
| 📌 S3 | 「复制项目」只复制项目行，不带剧本/分镜 | README 与按钮语义均为"复制项目"，非"另存为完整副本"；如需要按用户反馈再加 |
| 📌 S4 | 无 API Key 时模型目录 `source:'fallback'`，`models` 为空数组 | 属降级设计（README 承诺保留旧目录）；首次拉取前为空是正确表现 |
| 📌 S5 | `POST /api/videos/:id/refresh` 手动刷新会跳过 poller 的 completed 短路，直接远端查询 | 行为正确（用户显式要求刷新），poller 短路是给自动轮询省配额的 |
| 🚫 D1 | 本地服务信任无 Origin 的 curl 写请求 | README 明确：只监听 127.0.0.1 的单机工具，Origin 校验防的是**浏览器**跨站，非本机进程 |
| 🚫 D2 | `chat()` 失败降级只重试一次、不限流 | 重试风暴对本地单用户不构成风险；加限流复杂度不划算 |

---

## 四、结构性观察（理解项目用，非缺陷）

- **数据流**：前端 `api.js`（统一 `{ok,data,error}` 包装）→ `routes.js` dispatch（自研路由表匹配）→ `store.js`（内存 + 串行原子写盘 `db.json`，带 `.bak` 回滚）；生成调用统一走 `agnes.js`（诊断三件套 `request_sent/response_status/duration_ms` 贯穿所有错误路径）。
- **异步闭环**：视频创建 → `poller.watch`（服务端计时器，`unref` 不阻止退出）→ 状态变更 `events.emit('video')` → SSE → 前端 `onEvent('video')` 增量更新；重启时 `resume()` 捡回所有在途任务。
- **批量链路**：`jobs.run` 并发上限（图默认 3、视频强制 1 防重复扣费），进度经 `/api/batch/:id` 轮询 + SSE `batch` 事件双通道。
- **SEA 单文件形态**：`server.js` 头部资源释放逻辑依赖 `ASSETS_VERSION`；**改动 `public/` 或 `lib/` 后发版需递增版本号**，否则 exe 用户拿不到新页面（本轮改动未 bump，发版前记得 `VERSION` 1.0.1 → 1.0.2）。
- **测试金字塔**：selftest（纯离线单元，110→113）→ apitest（mock Agnes 集成，127→137）→ uitest（前端静态一致性 390）→ browser-test（真实 Chrome CDP 29，本轮起在 macOS 真正生效）。

## 五、验证记录

| 时间 | 动作 | 结果 |
|---|---|---|
| 2026-09-18 | 分镜生成三连修复（U1/U2） | selftest 110 / apitest 127 / uitest 390 全过；真实 API E2E 8 镜头落库 |
| 2026-09-18 | 第一轮审计修复（B1-B4, M4-M8, T1, H1） | selftest **113** / apitest **141** / uitest **393** / browser-test **29**，全部 0 失败 |
| 2026-09-18 | 运行实例护栏验证 | 裸 / 缺参 `DELETE /api/storyboards` → 400 且零副作用；用户数据完好 |
| 2026-09-18 | 第二轮 UX 修复（UX-1~8） | selftest **113** / apitest **141** / uitest **395** / browser-test **29**，全部 0 失败；运行时审计对比度/截断/焦点断言全过 |

---

## 六、第二轮：UI / 使用体验走查（真实浏览器运行时测量）

**方法**：`build/ux-shots.mjs` 逐页 + 弹窗截图 18 张（`build/ux/`，`before/` 子目录为修复前对比）；`build/ux-audit.mjs` CDP 运行时测量——WCAG 对比度（含半透明背景合成）、ellipsis 无提示、点击目标尺寸、可访问名、弹窗键盘行为、1100/860px 窄视口溢出。当前模型不支持读图，视觉细节以数据断言为准，截图供人工抽查。

### UX-1 弹窗键盘与焦点（高危：误删风险）✅
- **实测原状**：ESC 不关闭；打开"删除项目"确认框时初始焦点 = **红色"删除"按钮**（连按回车直接删项目）；Tab 可逃到背景元素；弹窗打开时背景仍可滚动。
- **修复**（`ui.js modal()`）：ESC 只关最上层弹窗；Tab/Shift+Tab 焦点环；自动聚焦策略（表单类 → 第一个输入框；danger 确认 → 取消钮；普通确认 → 确定钮）；`body.modal-open` 滚动锁与解除收口在 MutationObserver（任意路径关闭都清理，不泄漏监听器）；关闭钮补 `title="关闭（Esc）"`。
- **验证**：ux-audit 5 项断言（初始焦点 BUTTON.btn 取消 / ESC 生效 / 锁滚动 yes / Tab×25 不逃出 / 关闭后解锁 yes）；browser-test 建项目全流程 29/29 仍过。

### UX-2 路由切换残留僵尸弹窗 ✅
- 弹窗挂在 `#modal-root`，程序化导航不会关掉它——旧闭包指向已销毁 DOM，留下会吞点击/吞键盘。`app.js render()` 现统一清空 modal-root 并解锁滚动；confirm 的取消值兜底（被清时 resolve 取消）保证删除流程自动中止。

### UX-3 灰阶文字对比度整体不达标 ✅
- **实测**：27 类小字（版本号、数据路径、时间戳、表头、单元格、kv 标签、hint、空状态副文案等）在合成背景上 ratio 2.1〜4.33，低于 AA 4.5。
- **修复**：`--text-2/3/4` 从 `#A1A1AA/#6E7681/#4A4A52` 提亮至 `#B4B6BE/#8A92A1/#767E8C`（保持四级层级、黑金基调不变）。
- **复测**：仅剩 1 条"文生视频"选中态——**探针误报**（`--gold-grad` 是 background-image，探针按 background-color 合成；实际深字金底约 8:1）。
### UX-4 纯图标按钮零提示 ✅
- 5 个页面的 `#reload`（含素材库）补 `title="刷新"`（此前只有任务页有文字版）；素材库 8 个浮层图标按钮（收藏/查看/播放/删除）补 `title` + `aria-label`（收藏态文案联动）。
### UX-5 表格截断无 tooltip ✅
- 分镜表 `对白`/`出场角色` 列有 ellipsis 无 title → 补全；复测"截断无提示"归零。
### UX-6 素材库状态实时化（撤销上轮缓修 S1）✅
- 订阅 SSE `video` 事件：命中已知条目做字段级合并 + 700ms 防抖重绘（不清屏、不打断悬停），未知任务整表重拉；弹窗打开时跳过本次；离开页面清定时器 + 退订。
### UX-7 「保存到本机」无加载态 ✅
- 任务页/素材库两处下载按钮（视频落盘可能数秒）接入 `setBusy` + disabled 防重复下载；分镜提示词复制钮 22px → 26px 命中区。
### UX-8 prefers-reduced-motion ✅
- 系统开启"减弱动态效果"时全局收敛动画/过渡时长。

### 本轮缓修
| # | 现象 | 理由 |
|---|---|---|
| 📌 S7 | 图片生成失败时 `#status` 文案不区分配额/网络错误 | 后端 errorType 已回传，前端细分提示属锦上添花 |

### UX-9 收尾追加（同轮）✅
- **`保存` 类补漏**：任务页/素材库「保存到本机」下载按钮 busy 化（见 UX-7）；`.switch` 升级原生 `button role="switch"`（3 处：模型自动刷新 / 视频自动下载 / 图生图保持构图），CSS 补 `appearance:none;padding:0;font:inherit` 保持几何（实测 42×24、滑钮 left 2px→20px 与 div 版一致），`aria-checked` 与 class 同步；键盘 Enter/Space 原生可用（`build/sw-check.mjs` 实测 focusable=true / toggle=true / ariaSync=true）。原第三节 S6 关闭。
- **Toast 可点击关闭**：错误 toast 挂 6 秒期间挡右上角且不可干预 → `dismiss()`（点击/超时共用、`dataset.gone` 防重入、clearTimeout）+ `title="点击关闭"`；顺手清掉 `${icon ? '' : ''}` 无效表达式。
- **终验**：selftest 113 / apitest 141 / uitest 395 / browser-test 29 / ux-audit 全断言通过（仅剩 1 条已证实的渐变背景探针误报）。

---

## 七、第三轮：Agnes Video 2.5 / 2.5 Flash 新协议适配（真实线上事故）

### 现象
用户把默认视频模型设为 `agnes-video-2.5-flash`，图片生成正常，**视频生成 100% 失败**。落库错误逐条命中：`width/height is a forbidden field`、`num_frames is a forbidden field`、`frame_rate/negative_prompt is not an allowed request field`。

### 根因
Agnes Video 2.5 系改用 **OpenAI-Videos 兼容新协议**（官方文档 `docs/agnes-video-25`），与 v2.0 请求体完全不兼容：

| 维度 | v2.0（旧） | 2.5 系（新） |
|---|---|---|
| 模式 | 靠有无 image 隐式区分 | 必填 `mode`：`text` / `keyframe` / `reference` |
| 时长 | `num_frames` + `frame_rate` | `seconds`（字符串 `"4"`–`"12"`） |
| 分辨率 | `width` × `height` 像素 | `size` 档位（Flash 固定 `720P`）+ `aspect_ratio` 画幅 |
| 媒体 | 顶层 `image` / image 数组 | `first_frame`/`last_frame`（keyframe）、`images`/`audios`（reference） |
| 负向提示词 | `negative_prompt` 字段 | 无该字段（并入 prompt） |
| 结果地址 | `remixed_from_video_id` | 完成响应 `url`（或 `metadata.url`） |

原 `createVideo`/`queryVideo` 只实现了 v2.0 一套 body，把五个 v2.0 字段无条件发给 2.5 → 全部被 400 拒。即便侥幸通过，`extractVideoUrl` 也只认 v2.0 的 `remixed_from_video_id`，拿不到 2.5 的 `url`/`metadata.url`。

### 修复（`lib/agnes.js` 按模型代际分流）
- `V25_MODEL` 正则识别 `agnes-video-2.5*`；命中走 `v25Body()`：
  - `mode` 由入参推导：无图→`text`；`mode_flag=keyframes`→`keyframe`（取首/尾帧，中间帧丢弃）；单图 `image`→`keyframe`+`first_frame`；多图→`reference`+`images`（Flash 截 5 张）。
  - `num_frames/frame_rate` → `v25Seconds()` 折算 `seconds` 并夹进 `"4"`–`"12"`；`width/height` → `v25Size()`（Flash 恒 `720P`）+ `v25Aspect()`（横/竖/方预设映射 16:9 / 9:16 / 1:1 / 21:9）。
  - `negative_prompt` 并进 `prompt`（"…。避免出现：X"）。
- `queryVideo(videoId, modelName)`：2.5 查询必须带 `model_name`；`poller.pollOnce` 传 `asset.model_name`。
- `extractVideoUrl`：优先 `metadata.url`，再回落 `url`/`remixed_from_video_id`。
- `downloadVideo`：对 401/403/404/5xx **重试一次**（实测 2.5 任务刚 completed 时结果文件在 CDN 上会瞬时 401）。
- 前端 `videos.js`：选中 2.5 模型时，在分段器下方显示金色说明条，讲清折算规则；页头文案去掉"2.0"字样。

### 验证
- **单测/集成**：apitest 新增「视频 2.5 新协议」组（mock 捕获请求体 + 2.5 查询分支），断言 mode/seconds/size/aspect_ratio 正确、旧字段不发送、负向并入、四模式媒体映射、查询带 model_name、completed 后 `video_url` 落 `url`，并对照 v2.0 仍走旧 body。**apitest 141 → 165 全过**。
- **真实 API 端到端**：经本地服务连发（命中免费用户 `video_queue_full`/`rate limit` 属正常限流，非 schema 错误），第 5 次成功创建 `task_…` → 轮询 `queued→in_progress(progress 10→90)→completed`，拿到真实 `video_url`；`保存到本机` 首次因 CDN 瞬时 401 失败、重试后落盘 3.8MB MP4（`file` 校验为 `ISO Media MP4`）。
- 全量：selftest 113 / apitest 165（+24 条 2.5 协议回归与 v2.0 对照）/ uitest 395 / browser-test 29，0 失败。

### V2 批量生成视频"秒完但全失败"（第七节修后遗留，2026-09-18 已修 ✅）
- **现象**：2.5 协议修好后，分镜「批量生视频」进度条几秒走完，全部标失败。
- **根因**：落库报错已不再是字段问题，而是免费档**瞬时拒绝**——同一秒内 2×`video queue is full`(503) + 4×`rate limit for free users`(429)。批量串行提交、逐条**立即判死**，免费档高峰期 8 条基本全灭；且失败提示是英文原文，用户以为又坏了。
- **修复（`lib/agnes.js` / `routes.js` / `store.js`）**：
  - `isTransientError()`：408/429/≥500 按状态判；无 HTTP 状态时按文案（queue full / rate limit / too many / 超时 / 网络异常）。**4xx（schema、鉴权、配额）绝不高频重试**。
  - `createVideo` 拆为 `submitVideoOnce` + 重试包装：瞬时拒绝指数退避（`video_submit_backoff_s` 3s 起、倍增封顶 60s），预算 `video_submit_retries` 默认 **8 次/条 ≈ 最长 4.5 分钟**；单发与批量共用。
  - **`proxy_timeout` 不参与重试**（可能已收单，重复提交=重复扣费），仍走原 timed_out 补录流程。
  - 失败记录与提示中文化：「Agnes 免费通道排队已满或限流，不是参数问题（已自动重试 N 次）…」，返回体带 `retryable`；批量 `items` 支持整批覆盖 `submit_retries`。
  - 中途重试不重复落库（预算耗尽才写一条 failed），避免任务页被瞬时 503 刷屏。
- **验证**：
  - apitest 新增「视频提交限流自动重试」组 11 断言：503×2→第 3 次成功（恰好 3 次调用）、预算耗尽止步（1+3 次）、**400 不重试（仅 1 次）**、批量限流 1 次后整批全绿、中文提示命中。mock 用提示词标记 `__retryN__`/`__bad400__` 精确计数。
  - **真实限流实测**：连发批量 2 条正撞排队高峰，每条自动退避 4 次（当时默认）约 45s 后才认败，中文报错正确呈现——机制有效，仅免费档容量所限。
  - 全量：selftest 113 / apitest 176 / uitest 395 / browser-test 29，0 失败。
- **顺带说明**：批量重试期间进度条停在 done=x/N 属预期（单项最长数分钟在等排队）；想要更快认败可把 `video_submit_retries` 调小（设置接口可写）。
