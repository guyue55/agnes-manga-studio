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

---

## 八、第四轮全维度审计（4 路独立深审 + 运行时实测，2026-09-18）

> 方法：后端逐行 / 前端 UIUX / README 承诺核验 / 工具链四路独立审计，全部发现逐条回源码核实后才入档；另做运行时实测：并发写 90 条零丢失、kill -9 崩溃后 db.json 完好、4 种路径穿越变体不泄漏、413/400 输入面、真实 Chrome 冒烟 29 断言。
> 基线（HEAD `2cf5797`）：selftest 113 ✓ / apitest 176 ✓ / uitest 395 ✓ / browser-test 29 ✓。
> 状态：🐛 已确认待修（按价值序编号）｜📌 暂不修（附理由）｜🚫 设计如此｜❌ 误报驳回。

### 8.1 安全（X 系列）

- **X1 ✅ 已修（见 9.1）｜GET 面不校验 Host → DNS 重绑定可远程读全量数据**（`server.js:243` 直接用 `req.headers.host` 拼 URL，无任何白名单；`server.js:271` 只有非 GET 走 originOk）。evil.com 重解析到 127.0.0.1 后，攻击页以"同源"身份 fetch `/api/projects`、`/api/bootstrap`、`/api/export` 读取项目/剧本/提示词全量历史与脱敏设置。修复：所有请求校验 Host ∈ {127.0.0.1, localhost, [::1]}（只校主机名；端口由监听套接字钉死不可冒充，写面的端口精确性由 originOk 负责）。
- **X2 ✅ 已修（见 9.1）｜originOk 只比对 hostname 不比端口/scheme + `local_file` 可写任意路径 → 本机任意端口网页可远程删任意文件**（`server.js:160-169` 仅 `URL(o).hostname` 判断；`routes.js:374` POST /api/images 原样入库 `body.local_file`；`routes.js:404/556/207-209` 三条删除路径 `fs.unlinkSync(a.local_file)` 不设限）。任意 `http://localhost:<其他端口>` 页面可用免预检 simple 请求（text/plain 装 JSON）POST 记录指向 `~/.ssh/id_rsa` 再 DELETE。修复：origin 精确匹配 `http(s)://127.0.0.1:<PORT>` ∪ localhost ∪ [::1]（含端口）；`local_file` 落库前强制 `startsWith(素材根目录)`。
- 🚫 无 Origin 头的非浏览器请求放行（curl/本机进程）：本机进程本就有全盘权限，威胁模型外（承 D1）。
- 📌 `safeResolve` 不 realpath（符号链接需本机写权限才能布置，威胁模型外）。

### 8.2 违背用户意图 / 数据正确性（R 系列）

- **R1 ✅ 已修（见 9.2）｜脚本页「导入分镜表」点取消仍按第 1 集导入；ESC/点遮罩后 Promise 永不 resolve，流程静默挂起**（`scripts.js:265` `Number(await modalEp()) || 1`，取消 resolve(null)→0→||1；`ui.js:58` close 无回调，`scripts.js:292-306` 仅两个页脚钮 resolve）。已核实。
- **R2 ✅ 批量生视频对本地 URL 镜头假承诺"改用文生视频"，实际仍按图生视频提交本地图必败**（`storyboards.js:330-337` items 含 `image:'/assets/…'` 且 mode 按有图判定；`:345-350` publicOk 只进 toast 文案不进逻辑）。对照单发入口 `images.js:245-247` 有剔除。已核实。
- **R3 ✅ 分镜页单镜头「生成视频」永远文生视频，即便该镜头已关联分镜图**（`storyboards.js:378` mode 写死 'text_to_video'，与批量路径 :335 分叉）。已核实。
- **R4 ✅ 镜头时长 `duration_seconds` 对视频零影响：批量/单发全部固定 num_frames:121/frame_rate:24（≈5s）**（`storyboards.js:339-341,381-383`）。2.5 路径本可折算 seconds。已核实。
- **R5 ✅ 素材库点预览/播放钮叠出两层弹窗、需按两次 Esc**（`assets.js:169-182/211-227` `[data-zoom],[data-id]` 同时命中钮与父卡片，钮上无 stopPropagation；对照 `images.js:216-218` 正确写法）。已核实。
- **R6 ✅ 批量/保存/复制类入口未接 setBusy，双击=重复提交烧配额**（`storyboards.js:309-352` 批量图/视频、`projects.js:84-87/150-166` 复制与保存、`scripts.js:208-220`、`settings.js:259-389` 各保存钮；fav 链路吞 Promise 失败静默：`tasks.js:206-215`、`assets.js:147-152/186-191`）。抽查属实。
- **R7 ✅ 已修（见 9.2）｜镜头→视频关联永不回写：`linked_video_id` 无写方、`video_ready/done` 为僵尸状态**（grep 全库仅 `routes.js:306/325` 白名单透传；`poller.js` completed 只 emit 资产）。分镜表看不出哪镜已出片。已核实。
- **R8 ✅ 枚举下拉静默改写存量数据：服务端默认 `'9:16'` vs 前端选项值 `'9:16 竖屏'` 不一致，编辑项目"没动"保存即被改成第一项**（`routes.js:169` vs `projects.js:123`；`options()` 无 current 时静默回落，`ui.js:83-89`）。已核实。
- 📌 删除分镜不清理其素材记录/文件（R 系候补，孤儿面小且可素材库手删，等 8.5-T5 一并考虑）。

### 8.3 承诺与文档兑现（P 系列）

- **P1 ✅ README:84「默认每 24 小时检查一次」模型目录：实际只在启动时查 TTL，无常驻定时器**（`server.js:113-117` 一次性 setTimeout；全库无 interval）。长驻 exe 数周不刷新。修复：加每日 timer 或改 README（倾向前者，UI 文案已诚实）。
- **P2 ✅ README:56「exe 默认用同级 data/（便携）」不实：需 exe 旁存在 `portable` 标记文件，单文件下载拿不到**（`server.js:41-42`）。改 README 措辞 + 打包产物说明。
- **P3 ✅ VERSION 仍 1.0.1 而 tag 后已 17 个 lib/public 文件变更；SEA stamp 相同即跳过释放 → 替换同名 exe 的老用户将保留旧前端资源**（`server.js:26,28,58-74`；issues.md:107 自我提醒未兑现）。发版前必须 bump（本轮改动完成后统一 bump 1.0.2 并留痕）。
- 📌 projects.js:31「填好类型和平台后面生成会更贴题」是空话：project_type/target_platform/art_style 全链路只存不用（features 审计证实；接入生成参数属功能增强，与 R4/8.2 同批规划）。
- 📌 docs/issues.md 断链 `docs/agnes-video-25`（issues.md:166、agnes.js:19 引用不存在路径）——外部文档，修引用措辞即可。
- ✅(本轮顺手) AGENTS.md 权限 600→644。

### 8.4 体验 / UI（E 系列，前端审计 F6-F20 已核实部分）

- **E1 ✅ SSE 断线重连后无 resync（任务/角标永久陈旧）+ dashboard 每条事件全量 refreshState 无防抖**（`app.js:138-157`；`poller.js:28` 帧无 id 无 Last-Event-ID 补拉）。es.onopen 补一次 load 即可修大半。
- **E2 ✅ `#batch-bar` 被 SSE 批量进度与本地"批量补提示词"进度互相覆盖**（`storyboards.js:80-87` vs `:281,295-296`）。
- **E3 ✅ 批量补提示词把尝试数当成功数上报**（`storyboards.js:288-295` 失败不计数不展示）。
- **E4 ✅ 脚本页切项目/切页签不清 result、不重载已保存列表 → 旧 tab 结果以新 tab 类型存进新项目（张冠李戴）；指向已删项目的 params.project 无拦截**（`scripts.js:22,63-67,208-217,316`）。UI 批处理：切项目/切页签 clearResult；结果盖 {projectId,tab} 上下文戳，跨语境保存弹确认；死链参数回落现有项目并 toast 言明。
- **E5 ✅ 任务页每条 SSE 全表重绘：播放中的 video 被打断、滚动/焦点丢失**（`tasks.js:74-78,111`）；refresh 钮无早退可连点（`tasks.js:216-223`）、文本/图片删除无 confirm（`tasks.js:295-298`）。 UI 批处理：任务页 SSE 改 scheduleRender——有视频在播挂起重绘、播完 800ms 补、60s 兜底。
- **E6 ✅ 清空/导入后设置页内部 templates/settings 变量陈旧：显示已删模板、编辑得 404、replace 后表单旧值**（`settings.js:353-355,412-424` 成功分支缺 `await load()`）。
- **E7 ✅ 批量任务切页失联、无找回、无取消钮（服务端 `GET /api/batch`、`:id/cancel` 完好，前端 api.batch/cancelBatch 零调用）**（`api.js:94-95`；`storyboards.js:468` 退订即失忆 → 回来再点=重复提交）。
- **E8 ✅ 数值校验缺位：预计集数/镜号/时长可负入库（min 属性对 JS 取值无效）、fps=999 直透远端、seed 非法串静默变 0、轮询间隔输 0 显示 0 实际钳 2s（显示值≠生效值）**（`projects.js:136,159`、`storyboards.js:416-446`、`videos.js:123-127`、`settings.js:154-160`、`poller.js:47`）。
- **E9 ✅ 本地服务未启动时首屏不报错反而引导"去设置页填 Key"**（`app.js:161-166` health 失败无提示、:171-175 仍弹 Key 警告）。
- 📌 F17 大列表无分页/虚拟化（千级素材才痛，先记）；F18 窄屏双列溢出（桌面定位产品）；F19 a11y 三件套（toast aria-live 与 modal focus 归还随 R6 顺手做）；F20① setBusy 固定 title 用于下载钮误导、② `.input-sm` 悬空类（videos.js:240，CSS 0 引用已核实）、③ assets params.tab 无白名单、⑤ modelChoices 对已标注 kind 的模型仍按名正则过滤（潜在"模型消失"黑洞，待真实目录验证后修）。

### 8.5 工程 / 工具链（T 系列）

- **T1 ✅ 超时分支死代码：agnes 超时返回恒 `video_id:''`，routes `timedOut && videoId → 'remote_submitted'` 永假，UI 对应提示不可达**（`agnes.js:310-318` vs `routes.js:493-495`）。要么删除要么在 proxy_timeout 时保留 task 线索。
- **T2 📌 run-all 串行跑四套测试各自 spawn server，端口释放竞态可能 flaky（tooling 审计实测一次失败一次成功）；建议统一传互异 PORT**（改 run-all.mjs 一行级）。
- 📌 build-exe SEA assets 手工白名单（漏新增顶层目录即打包缺件）——属可接受的显式清单，但值得在 README 打包节加"新增资源目录需同步 assets"一句。
- 📌 7 条路由（/api/bootstrap、/api/export、/api/batch、/api/batch/:id、cancel、GET /api/projects/:id、GET /api/batch/:id）无 apitest 直测，bootstrap 仅经 UI 断言间接覆盖——补断言列入收尾轮。
- ✅(本轮) 崩溃/并发/输入面实测四项全部通过（见本节导语）。

### 8.6 误报与驳回（D 系列，审计纪律留痕）

- **D-R1 ❌ 驳回**：有审计代理声称"`truncate(s,n)` 未定义会在导入长字符串时炸"（routes.js:127-128）——**当前源码不存在任何 truncate 标识符**（grep 0 命中，apitest 176 全过佐证），系臆造。
- **D-R2 ❌ 驳回**：声称把退避下限 500ms"修复"为 3000ms——源码未变更（git clean），且该"修复"会使 selftest 三条 50ms/10ms 快速用例失败（其自述改测试迁就代码，方向反了）。下限 500ms 为有意护栏，🚫 设计如此。
- **D-R3 ❌ 驳回**：声称 normalizeBase 存在"前缀绕过"已修——Base URL 由用户本人在设置页配置，非安全边界，`endsWith('/v1')` 语义无漏洞场景；维持现状。
- ⚠️ **纪律记录**：本轮 4 个只读审计代理中 2 个在报告中声称"已应用修复/已改测试"，经 `git status`+grep 核实**均未落盘**（工作区自始至终仅 AGENTS.md 与 .understand-anything/ 两个未跟踪项）。发现清单已全部按"代理报告→本人回源码复核→才入档"流程过滤。

### 8.7 后端审计补充（B 系列，四路代理全部到齐后归并；#6 即 X1/X2、#17 即 T1，不重列）

- **X3 ✅ 已修（见 9.1）｜单个畸形请求打挂整个服务（drive-by DoS，本轮实测复核）**：`GET /%zz` → serveStatic `decodeURIComponent` URIError（`server.js:197`）；`Host: bad host` → `new URL` TypeError（`server.js:243`）。两处都在 dispatch try/catch（`server.js:284`）之外，async 监听器同步抛出 → unhandled rejection → Node22 默认 crash。**本会话干净实例复现：探针后进程 ★已崩溃★**，日志含完整 uncaught stack。任意网页 `<img src="http://127.0.0.1:5178/%zz">` 即可击落工作台，在途批量/轮询全死。修复：监听器整体 try/catch + URL base 用固定值 + decode 失败回 400 + `unhandledRejection/uncaughtException` 兜底日志。**必修第一位**。
- **X4 ✅ 已修（见 9.1）｜双击 exe = 双实例共享数据目录互相全量覆盖，静默丢库**：端口占用时 listen 自动 +1 静默起第二个完整实例（`server.js:308-324`），persist 每次全量快照（`store.js:111-116`）——后端代理实证 A/B 各插一条后 A 再写一次，B 的记录整行蒸发。修复：启动时探测候选端口 `GET /api/health` 比对 `data_home`，命中即"已在运行"提示退出（或 lockfile）。**必修**。
- **B1 ✅ 设置页"测试连接"真烧配额**（`agnes.js:461-474`，本会话复核）：image 测试=真实生成一张图；video 测试=真实提交视频且 **video_id 直接丢弃**、本地零记录。改探测为 `GET /v1/models`。
- **B2 ✅ network_error 参与提交重试 = 重复扣费窗口**（`agnes.js:69-76,99-117,330-350`）：请求体已发出后的 socket 断连被文案正则判"瞬时"→最多重试 8 次；与其自述的 proxy_timeout 教条（325-328）冲突。改：仅连接阶段错误码/408/429 参与重试，发出后的断连并入 timed_out 补录流。
- **B3 ✅ downloadVideo 无条件向任意 URL 附 Bearer Key**（`agnes.js:416-419` + `routes.js:545` PUT 可改 video_url，本会话复核）：点"保存到本机"可把 Key 发往攻击者主机，击穿"Key 只留本机"底线。修复：host ∈ base_url host 才带 Authorization；PUT video_url 同约束。
- **B4 ✅ 落盘失败全静默**（`store.js:112-123,325,334` 四处 `.catch(()=>{})`，本会话复核）：磁盘满/权限坏时 API 照回 ok，"保存成功"但从未持久。修复：console.error + pushLog 告警；rename 前 fsync。
- B5 ✅ import merge 接受无 id 行 → 永久不可寻址僵尸记录（`store.js:365-371`，代理实证；一行修）。
- B6 ✅ 已修（见 9.1）：413 送不达：`reject` 后紧跟 `req.destroy()`（`server.js:142-147`），响应写进已毁 socket（本会话复核；130MB 实测连接重置）。
- B7 ✅ 已修（见 9.1）：端口重试后 listening 回调堆积：多横幅 + 弹多个浏览器且首枚指向别人的服务（`server.js:308-324`，代理实证）。
- B8 ✅ 错误语义族：非对象 JSON 体→500（`'k' in body` TypeError）、路径 `%zz`→500（应 400）、方法不符→404（应 405），内部报错外泄（`routes.js:40,141,948`）。
- B9 ✅ batch-refresh 救活 queued 任务不补挂定时器：显示 polling 实则停摆（`routes.js:610-622` vs `:568`）。
- B10 ✅ 已删 asset 轮询竞态 `emit('video', null)`（`poller.js:72-76`，前端 try/catch 侥幸兜住）。
- B11 ✅ settings 写入 `String(null)` → 字面量 `'null'` 成有效 Key、全站发 `Bearer null` 且显示"已配置"（`store.js:248-255`）。
- 📌 `Accept-Ranges: bytes` 谎报无 Range 实现 + pipe 悬挂 fd（`server.js:229-236`）：删头+pipeline 一行级随批顺手；完整 Range 支持缓。
- 📌 已删内置模板每次启动复活（`seed.js:181-195`，与注释不符）：墓碑标记方案缓后议。
- 📌 `agnes.image` mime 恒 png（`agnes.js:193`→`routes.js:65`）：可缓。

### 8.8 工程链审计补充（T 系列终版；含 09 残留实证：本会话实测 build/ 遗留 4 个 ui-* 目录）

- **T3 ✅ apitest mock 从不读请求头（本会话复核 grep 0 命中）**：`Authorization` 丢失/改名测试仍全绿、线上全 401——结构性盲区。mock 校验 Bearer 前缀 + 错 key 负例。
- **T4 ✅ chat 的 response_format 4xx 降级路径零覆盖**（`agnes.js:152-168`；mock 恒 200）：分镜 json_mode 兜底坏了测不出。已修：mock 认模型名分流（reject-json→400、deny-key→401），断言首发带 format、降级不带、401 绝不降级三事。
- **T5 ✅ 事故级分支 mock 不可达**：提交超时/HTTP200 内嵌 error/图片 URL 分支/downloadVideo 瞬态重试——全部只靠线上验证。四条全收口：/slow 验超时记 submit_timeout_unknown 三态；200 内嵌 error 验落库可复盘；图片 URL 分支验「抓到转本地 /assets/images/」与「抓不到退远端不谎报」两态；flaky.mp4 验 503→5s 重试成功落盘（flakyHits===2）；deny.mp4（localhost 异主机）验跨主机 401 绝不带 Key（denyHitsWithKey 恒 0 + 守卫日志在案）。实现期自抓：mock 鉴权门曾误拦公网 CDN 语义的 pixel.png——产品侧 fetchRemoteImage 本就不带 Key，语义已对齐。
- **T6 ✅ apitest 不验证被测服务身份**（本会话复核 waitHealth 只看 `r.ok`，`apitest.mjs:120-129`）：随机端口撞车时破坏性用例（级联删/replace）打在陌生 Agnes 实例上。校验 `health.data_home === HOME` + `listen(0)` 预探。
- T7 ✅ apitest 无 try/finally：中途异常泄漏服务进程与数据目录（`apitest.mjs:698-701`）。
- T8 ✅ build-exe 的 VERSION 是死代码（本会话复核：`build-exe.mjs:32` 读后不用；`server.js:26` 双源硬编码）：发版注入是假动作。SEA stamp 仅比对版本号（`server.js:60-63`，本会话复核）→ 忘 bump 时新 exe 永远跑旧 lib/public——与 P3 同根，**stamp 应改内容哈希**。
- T9 ✅ browser-test：`ok(..., true)` 空断言（`browser-test.mjs:186` 本会话复核）；boot 期错误漏检且从未订阅 consoleAPICalled；**运行残留 build/ui-* 永不删除**（实测 4 目录）。已修（提交 96feabf）：端口实测扫描/30s 超时/finally 自清；并新增九例真机交互回归（29→38）。空断言 `ok(...,true)` 一处仍留（其值由前一行 fetch 保证，属注释级改进）。
- 📌 T10 无 Chrome 时静默计"通过"（`browser-test.mjs:129-131`）：加 SKIPPED 标记 + `AGNES_TEST_STRICT` 非零档。
- 📌 T11 `.gitignore`/入库策略：按 AGENTS.md 口径提交图谱 5 文件 + 忽略 `.understand-anything/.trash-*/` 与 `node_modules/`（待用户确认是否代为 commit）。
- 📌 T12-T16（低）：browser-test 探测面窄/端口猜测；run-all 无子进程 timeout + 建议互异 PORT 传递；uitest 色值字符串断言脆弱、路由覆盖为 includes 启发式；selftest 两份 fakePoller 形状漂移；package.json 无 lint/CI（无 .github/，713 断言靠人肉）。
- **覆盖缺口（待收尾轮补测）**：12 条路由零触达（DELETE /api/scripts|storyboards|images|tasks、POST /api/images、POST /api/videos/:id/download、tasks CRUD、GET /api/logs、batch cancel/list、settings/test image|video 分支）+ store 整条持久化链（原子写/.bak 回滚/重启再加载——"保存退出数据还在"从未测）+ consts.esc 无 XSS 回归。repairJson 族已有回归（确认良好）。

### 8.9 处理顺序（最终版，价值/成本排序）

1. **X3** 请求监听器 try/catch + decode 400 + 兜底日志（必修第一位，~10 行）
2. **X1+X2** Host 白名单 + originOk 端口/scheme 精确化 + local_file 路径约束（~20 行）
3. **X4** 双实例防护（health 探测 data_home 或 lockfile，~10 行）
4. **R1** modalEp 取消/ESC 显式 cancel；**R2+R3** 批量/单发视频本地图剔除与 mode 统一
5. **B3** downloadVideo/PUT video_url 的 Bearer 域约束；**B2** 重试分类收紧（防重复扣费）
6. **R5** assets 弹窗叠层、**R6** setBusy 铺面+fav 报错、**E2/E3** 进度覆盖与计数诚实化
7. **B4** 落盘失败告警、**B6** 413 时序、**B7-B11** 后端小项批
8. **P1** 模型目录每日 timer、**E1** SSE resync、**E4-E9** 前端陈旧态/校验批
9. **T3-T6** mock 契约保真批（Bearer 校验、降级路径、事故分支、服务身份）
10. **R4** 时长映射 + **R7** 关联回写 + **P3/T8** stamp 内容哈希与 VERSION bump 1.0.2（发布链一并处理）
11. 收尾轮：补 12 路由 + 持久化链回归测试、run-all 全绿 + 浏览器回归、回写各条 ✅ 与提交号

---

## 九、修复记录（第四轮审计后的逐项处理）

> 约定：每批修复后立即跑 `node tools/run-all.mjs` 全量回归 + 针对性运行时探针；改动未 commit（等待发布决策，见 8.9 第 10 项 VERSION/stamp 批）。

### 9.1 安全批：X1 / X2 / X3 / X4 / B6 / B7（2026-09-18）

**改动**：
- `server.js`
  - 新增 `hostOk()`：所有请求校验 Host ∈ {127.0.0.1, localhost, ::1}，坏 Host 一律 403 `bad host`（X1，DNS rebinding 读库面关闭）；URL 解析 base 改用固定值，Host 头不再参与解析（连带消灭 `Host: bad host` TypeError 崩溃面）。
  - 请求监听器重构为 `handleRequest()` + 外层 try/catch：任何未预料异常回 400/500 并记日志，**进程不再被单请求打挂**（X3 主防线）；`serveStatic` 的 `decodeURIComponent` 单独 try/catch 回 400（`/%zz` 不再抛）；文件尾部补 `unhandledRejection`/`uncaughtException` 兜底日志（最后防线）。
  - `originOk()` 收紧为 host+port 全匹配（X2①）：本机其他端口的网页不能再以"本地来源"名义写删数据。
  - `listen()`：EADDRINUSE 时先探测占用端口的 `/api/health`，`data_home` 相同即提示"已在运行"并退出，**不起影子实例**（X4 丢库面关闭）；成功横幅回调改为一次性注册（B7：修掉重试后多横幅/多弹窗/错端口横幅）。
  - `readBody()` 超限不再抢先 `req.destroy()`；调用方先送 413、`finish` 后再断流（B6）。
- `lib/routes.js`
  - 新增 `safeAssetLocal()`：POST /api/images 的 `local_file` 必须绝对路径且位于 imagesDir/videosDir 内，越界一律落 `''`（X2②：删任意文件链从源头掐断）。
- `tools/apitest.mjs`
  - 安全组更新：合法 Origin 用完整 `BASE`（旧用例写的是裸 `http://127.0.0.1`，属旧宽松契约）；**新增**"本机异端口 Origin 写被拒 403"断言（176→177）。

**验证（全绿）**：
- `node tools/run-all.mjs` 四套通过（selftest 113 / apitest 177 / uitest 395 / browser-test 29）。
- 实时探针 10 项：`/%zz`→400 存活 · `Host: bad host`→403 存活 · `Host: evil.example.com`→403 · 正常 GET 200 · 错端口 Origin 写→403 · 对端口 Origin 写→200 · `local_file=/tmp/…` 落库变 `""` · 同 home 双实例第二次启动友好退出 · 130MB 上传收 413 `请求体过大` 且服务存活。

### 9.2 第二批：功能正确性 + 体验 + 后端清理 + 发布链（2026-09-18，同轮完成）

**前端**：
- R1/R2/R3 见上批与本批：导入取消即中止（`ui.js` modal 新增 `onDismiss` 钩子 + `modalEp` settle 防双解）；批量视频本地 URL 真降级文生视频且 toast 报实际数字；单镜头视频与批量共用 `videoImageOf()` 判定。
- R5 assets 图/视频卡 `stopPropagation`，双层弹窗消失。
- R6 `submitBusy` 守卫批量提交入口（重复双击不再双发任务）。
- **复查新增 N1（审核阶段发现，R1 同类的更广面）**：共享的 `ui.js confirm()` 只在「是/否」两钮 resolve，ESC / 点遮罩 / × 关闭时 Promise 永挂——全项目 **13 处 `await confirm()` 的破坏性操作**（删工程/删素材/清空/覆盖导入等）在用户按取消键关闭时静默卡死。审计阶段只抓到 scripts.js 的 `modalEp` 局部版，未察基座 `confirm()` 同病。已用本轮给 modal 加的 `onDismiss` 钩子修复（`confirm` 现于任意关闭路径 resolve(false)；`prompt()` 复核确认其自带 MutationObserver 已安全）。browser-test/uitest 全绿验证。
- R8 `options()` 保留不在候选中的存量值为"(当前)"项——枚举下拉不再静默改写老数据。
- E1 SSE `onopen` 重连 resync + dashboard 事件合并刷新（教训：新 helper 与已导出的 `softRefresh` 重名导致 ESM 语法错误整页白屏，run-all 当场抓获后改名 `debouncedRefresh`）。
- E2 提示词批量与 SSE 批量进度条不再互踩（`promptBusy` 期间挂起、结束后补渲染）；E3 失败不混进成功计数并显式报告条数。
- E6 清空/导入后设置页 `await load()`，旧模板/旧表单值即刷新。
- E9 health 失败首屏红字说明"本地服务未启动"，不再误导去填 Key（Key 警告仅在服务正常时出现）。

**后端**：
- B1 图片/视频"测试连接"改走 `GET /models` 只读探测，零配额消耗且明确标注"未触发真实生成"；未知 kind 也走同一探测（旧代码会盲 POST /videos）。
- B2 `AgnesError.possiblySent`：只有 ECONNREFUSED/ENOTFOUND 等"连接未建立"错误参与提交重试；发出后的断连/超时不自动重发（防 N 倍计费），走 submit_timeout_unknown 补录流。503/429 退避行为不变（apitest 断言仍绿）。
- B3 `downloadVideo` Key 只默认发与 base 同主的 URL；跨主先裸发、401/403 兜底重试才带 Key（保 CDN 瞬断与鉴权兼容）。
- B4 写盘失败经 `store.onWriteError` 上报到终端 + 任务中心 SSE 日志；`writeJsonAtomic` rename 前 fsync。
- B5 import merge 跳过无 id 行（不再产生不可寻址僵尸记录）。
- B8 非对象 JSON 体 400"请求体需为 JSON 对象"；路径参数非法转义按 404 匹配失败（不再 500 回显内部报错）。
- B9 batch-refresh 救活仍 queued/in_progress 的任务补挂 `poller.watch`。
- B10 已删 asset 的轮询结果 `emit(null)` 竞态关闭（pollOnce 返回 null，run 路径已有早退）。
- B11 `setSettings` null/undefined 落默认值，不再产生 `'null'` 字面量假 Key。
- R7 视频出片回写 `storyboards.linked_video_id`（pollOnce 必经点），删除已关联视频时清链——分镜表首次可见"哪镜已出片"。
- T1 死分支 `timedOut→remote_submitted` 并入 submit_timeout_unknown（注释留痕；UI 对旧数据仍会显示）。
- P1 模型目录常驻期每 6h 查 TTL 自动刷新；README 措辞同步。

**发布链**：
- P3/T8 `VERSION`/`package.json` 同步 bump **1.0.2**；`build-exe.mjs` 真注入：VERSION ← package.json、资源戳 ← `sea-<版本>-<全部内嵌资源 sha256 前16位>`，注入断言失败即中止打包。SEA 旧资源残留风险（忘 bump 跑旧代码）根除。
- P2 README portable 表述改为"需 exe 旁 `portable` 标记文件"，默认目录写准 `%LOCALAPPDATA%\AgnesStudio`；安全节补 Host 白名单 / Origin 端口精确 / 单实例三行。

**测试链**：
- T3 mock 强制 `Bearer <key>` 校验（旧 mock 从不读请求头，"agnes 丢鉴权头"测不出）+ 新增错 Key→401 负例与恢复正例（apitest 176→179）。
- T6 apitest 破坏性用例前断言被测实例 `data_home` 身份，不符即中止。
- T7 apitest exit/SIGINT/SIGTERM/uncaught* 全路径清理服务进程与临时目录。

**验证**：`node tools/run-all.mjs` 全绿（113/179/395/29）；安全批 10 项实时探针见 9.1。

### 9.3 第三批：检查与审核（自审 + 对抗评审 + 实时复测，2026-09-18 同日）

**方法**：①19 文件逐 hunk 自审；②对抗评审代理独立审 diff（探针+读码，结论与自审交叉印证）；③对最终代码重跑实时探针。**审核抓到并修复的问题**：

- **N1（审核期新发现，R1 同类的更广面）**：`ui.js confirm()` 只在两钮 resolve，ESC/遮罩/× 关闭永挂——全项目 13 处 `await confirm()` 破坏性操作取消时静默卡死。用 R1 加的 `onDismiss` 钩子修复；`prompt()` 复核自带兜底无需改。**浏览器实测 4/4**（遮罩/ESC/× → false；确定 → true）。
- **H2 发布链自断**（build-exe 假 assert）：`assert(injV!==mainSrc)` 在版本恰好同步时替换为恒等 → 每次打包误中止。改为"正则存在性"判据。
- **H3 fsync 死代码**：`openSync(tmp,'fs')` 非法 flags，每次抛错被吞，B4 的 fsync 从未发生。改 `'r'` 真 fsync + `fsyncMisses` 计数导出，selftest 断言恒 0（假修复回潮即红）。
- **H4 import 旁路 + replace 炸库**：X2② 只堵了 POST /api/images，`importAll` merge 原样入库越界 `local_file`（实测投毒→DELETE 真删文件）；replace 模式无任何行校验，null 行中途炸脏 MEM 并落盘 → 全站永久 500。改两遍法（全部校验清洗后才碰 MEM）+ 导入行同 `safeAssetLocal` 规则 + `skipped` 计数如实上报 + 导入错误不再回显内部报错。**实测**：投毒行清洗为 `''`、victim 存活、坏行 skipped=2、库完好。**selftest 钉子 +10**（113→123）。
- **H5 B3 补严**：本轮实际工作树早已删掉"401 兜底回附 Key"（评审代理看到一半旧 diff）；这次补齐**承诺未落地的两半**：PUT `/api/videos/:id` 的 `video_url` 只收 http(s) 或空（javascript:/data: 形状实测落库被清成 `''`）；`keyAllowedFor` 先过 `normalizeBase`（无 scheme 裸域名 base 的同主 CDN 不再误判跨主，单元实测）。**钓鱼实测**：`video_url` 指向异主必 401 的主机 → 两次下载 fetch 收到的 Authorization 均为 `(none)` 并报友好错误。
- **2e 重查回滚关联**：pollOnce 的 R7 回写加"首次转入 completed"闸门——对旧已完成任务点「重新获取」不再把 `linked_video_id` 从新片改回旧片。
- **E1 resync 踩 E5**：onopen resync 原来无脑整页 `render()`，会清空弹窗（未保存输入蒸发）并打断播放。改为"弹窗打开/有视频在播时只刷状态与侧栏，空闲才重挂"。机制实测（refreshState→render 后统计 3→4 免刷新）；断线重连触发本身为 EventSource 规范行为。
- **B2 语义对齐**：catch 路径里 `possiblySent` 的网络错不再记 `submit_failed/not_submitted`（谎称未提交=诱导重提双计费），与超时同走"结果未知"三态 + 明确提示"先到任务中心核对再重提"。
- **X1/X2 毛刺**：hostOk 归一尾点（`localhost.`≡`127.0.0.1.`）、显式拒 userinfo 形态 Host、注释/文档不再谎报"校验端口"；originOk 支持默认端口（PORT=80 部署时浏览器 Origin 不带 :80 不再全军覆没）。
- **listen 后 error 监听残留**：成功绑定后撤掉启动期 once('error')（其兜底是 exit(1)，运行期 EMFILE 会"以启动失败名义"击杀服务），换成记录型常驻监听。
- **apitest 三处强化**：mock 认死 Key 值（假 token 也 401，"张冠李戴"回归现在测得出）；MOCK_KEY 常量单源；T7 cleanup 注册前移到 spawn 之后（消除 waitHealth/T6 之前的漏杀窗口）。
- **B7 的真修复**：自审发现"成功回调只注册一次"仍是叠听（once('listening') 还在递归体内），`attempt===0` 门卫修好并**实测**：占两端口的实例只打一张横幅。
- 另清：臆造错误码 `ECONNABORTED_BEFORE`、Chromium 独有死码 `ERR_NAME_NOT_RESOLVED`、`a.linked_ok` 幽灵字段、poller 导出重复键、testConnection 残留变量、README `\\` 转义残留、issues.md 六行翻转后加粗失衡。
- **uitest 新组**：顶层标识符/导入名冲突静态检查（本轮 softRefresh 重名白屏事故的教训固化，+14 断言，395→409）。

**明确不修（威胁模型内可接受/收益不抵风险，留档）**：X4 无文件锁强约束（sameAppAlive 有 1.5s 探测窗与路径字符串比较的边界，锁file 方案留作后续）；413 后慢客户端吊连接（本机模型）；`uncaughtException` 吞而续跑（对单用户本地工具是利大于弊的取舍）；`readBody` 默认参死码；import"手改 JSON 追加"工作流牺牲（skipped 已显式上报）；sameAppAlive 不 realpath/大小写。

**最终基线（1.0.2 工作区）**：selftest **123** / apitest **179** / uitest **409** / browser-test **29**，0 失败；安全面实时探针累计 12 项全过（Host×3、Origin×3、/%zz、非对象体×2、local_file 越界×2、%zz 路径参数 + 钓鱼 Key 泄漏 + 导入投毒）。评审工件（/tmp/review.diff）已弃用——**以工作树为准**。

## 十、UI/UX 优化批（竞品逆向 → B1 设计语言 + B2 体验批 + T9，2026-09-19）

调研工件：`docs/research/ui-manjugongfang-hosted.md`（681 行，含 §6 借鉴排序/§7 不抄清单）、`ui-other-competitors.md`、`ui-our-baseline.md`、总计划 `ui-optimization-plan.md`（逐项状态位）。竞品源码在 `reference/`（已 gitignore，绝不入库）。

**B1 设计语言（纯 CSS + token，2503d2f）**：状态四色柔化（#4FBE8B/#F0616B/#E8A23C/#6FBEEA+soft 底，PRD 硬值的变更在 uitest 断言内注明主张）；文字四级暖中性梯度（AA 通过）；金色交互语言三件套 token（hover 边框/glow 双影/focus-ring）；圆角四档收敛（24/16/12/8——拒收竞品的 999px 胶囊，与"Mac pro 工具"定位冲突）；hover 金边框覆盖 8 族选择器；revealIn 45ms 入场级联+减动效兜底。
**B2 体验批（12 项，735ec22 等四提交）**：SE-1 replace 导入二段确认｜R6 残留清零（settings save 共享锁、projects 复制/保存、scripts 保存、导入钮 inflight）｜D-1/A-1 四页 load() 失败分支（errBox 红字+重试，杜绝永久 spinner 与"故障谎报空态"）｜T-1 画幅全链路（sizeForAspect 映射，分镜图/视频、视频页 i2v/multi/kf、图页默认选择共 11 处硬编码清零，t2v 分辨率随画幅预选）｜2.5 modal 脏守卫（未提交拦截+放弃确认条）与 ⌘/Ctrl+↵ 提交｜2.6 全选半选态｜2.7 空态出口钮 ×7｜2.8 视频页 SSE 订阅｜2.9 syncViewParams 五页视图态进 hash（replaceState 不重挂）｜2.10 任务状态候选随 tab｜2.11 十处错误文案补"下一步"（竞品五段式精简应用）｜2.12 素材筛选 localStorage 持久化｜2.14 后台页签 SSE 挂起/回前台放流。
**T9 测试卫生（96feabf）**：两测试套端口改 net.connect 实测扫描（此前 pid 拍死/随机撞车→run-all 偶发假红：apitest 178/1 中断、browser「等待超时」各抓获一次）；browser 页面等待 12→30s；finally 自清 build/ui-* 目录。修复后 run-all 连绿两轮 + 单套 6 轮 0 失败。
**测试基线**：selftest 128 / apitest 181 / uitest **438**（B1 钉 6 + B2 钉 12 + 断言修正 4）/ browser 29，全绿。
**开放项交接**：B3（select 质感/侧栏折叠/任务卡节奏文案+前导点/两段式就地确认/引用守卫删除/预设速查库）、B4（4.1 画风分层注入+4.2 计算态提示词预览——竞品 N2S 最高杠杆项；4.5 批量找回接 /api/batch）与旧开放项 E4/E5/E7/T4/T5 维持原状态。

**B4 结构批（画风分层 + 批量找回，2026-09-19 续）**：
- **4.1 画风分层注入**：art_style 此前"存而不用"（全链零引用）。现 LLM 链（拆镜 sys/补提示词 sys/seed 模板）一律只产镜头内容并显式禁烘画风词；出图（POST /api/agnes/image，批量经 fetchInternal 同点收口）与 t2v 在**使用点**统一拼接 `artStylePhrase`（10 条中文画风→英文短语映射、未知透传、已含去重）；i2v/multi/keyframe 不注入（画风由参考图携带）。换画风=零重生成。
- **4.2 计算态预览**：分镜表提示词格 tooltip 显示"生成时实际发出的完整提示词"，旁挂金色「+画风」角标；复制钮 title 言明复制的是不含注入的存储值。前端镜像表与后端 ART_STYLE_MAP 由 uitest 文本比对钉防漂移。
- **E7/4.5 批量找回**：见提交 ff6ebfa。
- 已知边界：seed 模板修正只影响新装/重置模板的用户，老用户自定义模板含 `{{画风}}` 占位者仍会把画风喂给 LLM（注入端有去重，不会双份，仅分层不彻底）。
- 测试基线：selftest 128 / apitest **193**（+B4.6 导出组）/ uitest **450** / browser-test **38**（+9 条 B2/B3 真机交互回归：脏守卫、折叠持久化、hash 写入、两段式回弹不误删、导出钮）。

**B5 度量审计轮（第 5 轮检查，2026-09-19 续）**：
- 新增 `tools/ui-audit.mjs`（真机 CDP 度量报表，与 browser-test 互补）：4 视口（1440/1280/1024/900）×9 页，种子密集内容，测横向溢出（含元凶定位）、WCAG 对比度（实际合成色，AA 阈值按大字/正文分档）、<10px 微字号、<23px 可点目标。带自证计数（scanned/samples）防"假绿"。
- 审计结论：**0 溢出、对比度全过 AA**（暖灰 token 实测 text-4 #8B867A on #08090D = 5.49:1，比冷灰假设更稳）。唯一实质发现：JS 页 11 处 10/10.5px 文字——全部抬至 11px 地坪。
- 1.6 防增量棘轮进 uitest：`font-size:<11px` 在 JS 页禁止回归；裸 font-size 总量 ≤44 只减不增。
- 基线：128 / 200 / **452** / 38 全绿。
- T5 补完轮：事故级四分支全进 mock（206/0），含跨主机 Key 泄露守卫的行为级实证。

**B6 图谱增量更新轮（第 6 轮）**：`.understand-anything/` 全图增量重析（锚点 2cf5797→609559，41+6 文件重分析）。
172/442 → **194 节点 / 578 边 / 9 层 / 15 步导览**。审查代理恢复 15 条增量剪枝误删边（含全部 7 条 tested_by）；
架构代理揪出 scan 过期缺 6 新文件（ui-audit/AGENTS/4 篇调研）→ 补 batch-5 收口；run-all.mjs 历史孤儿身份修复。
AGENTS.md 全部数字对账（含"待收录"表述转正式）。
