## B92 同一个字段，模型写有上限、用户手写没上限（批 8 补 30）

**症状**：卡片编辑框里可以往「外貌」里粘任意长的文字，保存也成功 —— 但那一段会**进每一次出图提示词**
（`appearance`/`outfit` 走 `characterPhrase`，地点/道具字段走 `storyCardPhrase`）。一个几万字的 `appearance`
足以把整条出图链撑爆（成本 + 上游拒绝），而用户以为自己只是"写得详细一点"。

**根因**：卡片有**两条写入路径**，各自一套规则 ——
模型抽取走 `normalizeCard`（内部 `clip` 截到 `FIELD_MAX`），用户手改走 `PUT /api/story/cards/:id`，
把提交的 `patch` **原样落库**（只有 `name`/`summary`/`aliases` 取了归一化后的值）。
实测：PUT 一个 5000 字的 `appearance` **存回 5000 字**，`FIELD_MAX.appearance` 是 200。
**两条路各自看都正常**，只有对比才看得出来。

**修法**：`clip` 导出成 `story.clipField`，手改路径过**同一把尺子**（一份实现，不是各写一个 `slice`）；
截断了哪些字段**如实上报**（`truncated`），界面点名说出来。

**最容易修坏的地方（本轮的真正风险）**：手改路径之所以原样写 `...patch`，是因为它要支持**清空** ——
`normalizeCard` 用 `if (val) card[f] = val` **丢掉空值**，而 `store.update` 是**合并**语义（键不在 patch 里就保留旧值）。
所以"改成写归一化结果"会立刻引入更严重的回归：**用户再也清不掉任何字段**。
正确做法是**只截断、不丢空**（空串照写）；apitest 专门钉了这条回归防线。

**顺手拆掉一个"第四份真相"**：`STORY_CARD_EDITABLE` 原本是**手抄的字段清单**，必须与 `CARD_FIELDS` 逐字一致 ——
漏一个字段的后果是"界面上能填、保存后静默丢失"，而且只在那一个字段上悄悄发生。现在从 `CARD_FIELDS` **推导**。

**预防与验收成对**：`FIELD_MAX` 镜像到前端（`STORY_CARD_FIELD_MAX`，uitest 同构钉）做编辑框 `maxlength`
—— **输入时就挡住**（预防），后端截断是**验收**（数据不变式不依赖谁来写）。

**过程教训（三条，都写进了 plan §6.30）**：
① **"同一个东西有几条写入路径"要和"有几份真相"一样认真对待** —— 字段表分叉查过了、**写入路径**分叉没有，
而后果更重：不是显示不一致，是**数据不变式只在一条路上成立**；
② **修"太宽松"之前，先找出它为什么宽松** —— 原样写 `patch` 不是疏忽，是为了能清空；直接"修正"会把一个静默超长
换成"清不掉字段"，**更糟**；
③ **同一个事实的两份拷贝，能推导就别手抄** —— 手抄清单不会立刻出错，它会在**某一次加字段**时出错，而且没有声音。

**正对照**：IJ（去掉那把尺子）= apitest 4 红；IK（前端上限表漂一格）= uitest 1 红；IL（白名单漏一个字段）= selftest 1 红。

---

## B91 六个字段"系统认识、却从没向模型要过"（批 8 补 29）

**症状**：地点卡的「时间」「地域」、道具卡的「外观特征」这些字段在卡片工作台上一直空着。
用户只会觉得"这模型抽得不全"，**没有任何报错、也没有任何提示** —— 因为界面确实有这一栏。

**根因**：系统里有**两套字段表**。`lib/story.js` 的 `CARD_FIELDS` 是**归一化**的真相（哪些字段存在、
怎么显示、怎么排序），提示词的 JSON schema 是**向模型要什么**的真相。两者从来没有对过差集，于是分叉了：
`character.gender`/`age`、`location.region`/`time_of_day`、`prop.features`、`timeline.order_note`
**六个字段从没被任何提示词要过**。

**为什么这条比"少抽个字段"严重**：`region`/`time_of_day`/`features` 三个**就在 `STORY_INJECT_FIELDS` 里**
—— `finalPrompt` 会把它们拼进画面描述、前端 `storyCardPhrase` 还在"实际发出"预览里逐字复算。
也就是**代码里早就承诺了"这几个字段会进图"**，而模型从来不知道要抽 → 这几个位置**永远是空的**。
同一个"场景不一致"的病，补 17（地点/道具卡参考图）治的是"存下来没用上"，这一条是它的**上游**：连存都没存。
更刺眼的是 selftest 早就在用 `临江/夜晚/木质结构` 断言注入链能带这些字段（机制没问题）
—— **断言覆盖了机制，却没覆盖"数据能不能到达机制"**。

**修法**：① 分块抽取提示词补上这 6 个字段，并说明"原文有就照原文写、没有就留空，不要为了填满而编造"；
`novel_extract` 版本升 v3、v2 指纹登记进 `TEMPLATE_SUPERSEDED`。② 加**棘轮**把两个真相钉在一起：
每个 `CARD_FIELDS` 字段都必须被**分块抽取或全局归并**要过（信息卡的主线三件套只在归并里产出，故两个提示词取并集）；
反向也要管 —— 提示词要了系统不认识的字段，等于让模型白花钱、还会被算进 `dropped` 覆盖率。

**顺带修掉一颗定时红**：apitest 里"本次改过的提示词版本已 bump 到 2"把版本号写死了，
这一轮升到 v3 立刻红。改成钉**不变量**：版本是整数且 ≥2，**且上一版官方指纹确实登记进了历史表**
（后者才是老库能升级的真正原因），不再钉具体数字。

**补 28 机制的第一次实战（真机验证）**：用**线上库真实存在的 v2 正文**造了两种老库形状 ——
① 补 28 之前装的（行上没有 `builtin_digest`）→ 靠历史指纹表认出"还是官方那版"；
② 补 28 之后装的（`builtin_digest` 自证）→ 靠自证。**两种都实测升到 v3**，
外加"用户改过的"原样保留并在横幅里点名。

**过程教训（三条，都写进了 plan §6.29）**：
① **"机制存在"不等于"数据能到达机制"** —— 凡是两端各有一套字段表的地方，都要有一条**对差集**的棘轮，
差集是静默的、两边各自都"看起来对"；
② **钉要钉不变量、别钉快照** —— 版本号/条数这类每轮都会变的值写进断言就是埋一颗定时红；
③ **造"旧版本"fixture 必须用真的旧内容** —— 第一版 fixture 直接拿 `DEFAULT_TEMPLATES` 造"老库"，
造出来的库**本来就是新的**（判成 `same`，本来就不需要更新），于是"升级没生效"是假象；
第二版用占位文本配旧指纹还是错，因为 `superseded` 判据比的是 `dig(content)` 而不是行上的 `builtin_digest`。
**用现成默认值糊弄 = 测空气，而且它看起来是绿的。**

---

## B90 提示词到不了老用户手里 / `involved` 只被显示、从没被核对（批 8 补 28）

**发现**：两件事凑在一起，都属于"界面看着挺完整、链路上其实没接线"。

① **内置提示词改了对老用户完全无效**。`seedTemplates` 只写"库里没有的 key"，
于是**改代码里的提示词对已经装过的人没有任何影响，而且没有任何提示** ——
用户永远在用第一版提示词。本项目每一轮都在改提示词（它是抽取质量最大的杠杆），
这个洞会一直吞掉改进。实测用户的 `data/db.json`：16 个内置模板，`builtin_version` 全是 `undefined`。

② **`involved`（涉及人物）花模型调用抽出来，只被显示、从没被读取**。它出现在 `cardLine`/`beatLine`
的"涉及：…"里，却没有任何逻辑核对过这些名字是否存在；`STORY_INJECT_FIELDS` 里也没有 `plot`，
`auditCards` 直接跳过剧情卡字段。后果：剧情里有这个人、却没有他的卡与档案，
剧本会写到他、分镜里他会出场，而**外貌注入/角色绑定/参考图全都落不到他身上** ——
同一个角色在不同镜头里换脸，链路上没有任何报错。

**修法**：① 启动时做一次**同步**：内置模板记 `builtin_version` + **内容指纹**，
只更新"能证明还是我们发的那一版"的（行上 `builtin_digest` 自证，或内容指纹在 `TEMPLATE_SUPERSEDED`
历史表里 —— 后者专为"本机制上线之前装的库"准备）；**证明不了就当成用户改过、原样保留**，
并在启动横幅如实报出"更新了几个 / 保留了哪几个"。判定抽成纯函数 `planTemplateSync`（六条路径 selftest 逐条钉）。
② 新增 `auditPlotCast` 并进一致性体检（`cast_issues` + `issues`）：已知名字 = 人物卡 ∪ 角色库，
按名字聚合、带近似候选与「去处理」出口；同时给两个抽取提示词定死写法（只写本名、顿号分隔、不写泛称）——
**预防与验收成对**。

**过程中真踩到的坑（值得记）**：

1. **会写用户数据的启动副作用，最初写在了端口绑定之前** —— 于是端口被占、走 X4 分支退出的
   "影子实例"也会写一遍库。而 `persist` 是**整库快照全量写**：影子实例写进去的更新会被
   正在跑的实例下一次快照**覆盖掉**，两边都不报错。X4 防的正是"两个实例互踩、静默丢数据"。
   已移进 `listening` 回调（与 `poller.resume()` 同一条纪律），真机验证同 HOME 同端口的第二个实例
   跑完后 `db.json` **逐字节未变**。**教训：这类 bug 不报错、只静默丢数据，而且方向恰好相反 ——
   看起来"多跑一次更保险"，实际是"多跑一次 = 覆盖别人的成果"。**
2. **对照"崩掉"不等于"红得干净"**：对照 IA/ID 第一次都让 selftest 以 `TypeError` 中止
   （断言里直接写 `issues[0].x` / `keep[0].reason`，被测行为一关掉就取字段炸）。
   崩掉虽也证明"钉是敏感的"，但它中止整轮、看不出**哪几条**钉在管这件事。
   已改成取不到给 `{}`，同样的对照现在给出干净清单（IA 14 条、ID 3 条）。
   **写断言时取字段前先兜底，让失败以"断言不成立"的形式呈现。**

**紧接着发现的"下一轮才炸"陷阱（补记指纹）**：真机重启后看到 2 个模板被更新、
**其余 14 个的 `builtin_digest` 仍是 `undefined`** —— 本机制上线前的库没有指纹，而内容恰好等于默认的行
会被判成 `same`（无需更新），于是**永远拿不到指纹**。将来真改了这些提示词时，"证明不了还是官方版"
就会把它们判成 `edited` 而**永不更新**，除非恰好记得手工补 `TEMPLATE_SUPERSEDED`。
修法：内容已等于官方默认的行**顺手补记指纹**（`stamped`，只补字段不动 content）。
**反向红线**：绝不给 `edited`/`custom` 补记 —— 那等于把用户改过的内容登记成"官方内容"，
下次同步就理直气壮地覆盖它，**把"静默不更新"变成"静默丢数据"**（对照 IG 钉死：2 红）。
**教训："这次不炸"不等于"以后不炸"** —— 迁移类机制都要问"这一轮跑完之后，数据处在能自证的状态吗"。

**顺带修正**：apitest 里那条"总数 = 卡片侧 + 镜头侧 + 参考图缺口侧"的断言**漏了画风/漂移两组**
（当时它们恰好是 0 所以是绿的）—— 已补全为"各分组之和"，加了 `cast` 组之后更该如此。

# Agnes 漫剧工坊 · 问题清单与修复记录

> 逐轮完整证据在此；跨轮总账与最终状态见 [audit-summary.md](./audit-summary.md)。

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

**B7 安全/a11y 排查轮（第 7 轮）**：
- **存储型 XSS 全量排查（S-XSS ✅ 干净实证）**：静态扫 93 处 innerHTML 模板（启发式 8 疑似全部证伪——要么已 esc、要么进 LLM 载荷非 DOM）；金标准改真机注入：browser-test 新增探针组——12 个恶意向量（项目名/画风/分镜六字段/脚本标题正文/素材名备注/模板名）灌库后遍历 6 页 + 点开素材弹窗，断言 onerror 零执行且字面量原样回显（esc 五件套 &<>"' 转义完好、数据不丢）。静态假阳 + 运行时证据 = 双向闭环，+5 用例（38→43）。
- 排查中自纠探针质量三连：素材名实际只渲染进 modal（点开才算覆盖）；回显证据要从 innerText 扩到 title/download 属性位；无 Key 环境 /api/agnes/image 不落资产改走 /api/images 直建通道——防"空跑假绿"。
- **a11y 图标名审计**（ui-audit 新维度）：全页面无文本无标签图标钮 = 0（title/aria-label 覆盖完好）。
- 基线不变：128 / 206 / 452 / **43** 全绿。

**B8 性能容量基线轮（第 8 轮）**：
- browser-test 新增「容量性能基线」组（43→48）：一次 merge 导入 300 分镜 + 60 素材 + 1 项目，实测——300 行接口查询 <800ms 且分页完整；**分镜页单集 30 镜首绘 42ms、素材页 60 卡 43ms、JS 堆 2MB**（headless 无 GPU 口径）。
- 结构性结论：分镜 UI 按集分页天然限制单视图行数——300 镜/剧不存在"全表一屏"渲染压力，此为本工具的容量护城河（写进验收断言：首绘 <3s 的门槛实际余量 70 倍）。
- 探针自纠两枚（教训入案）：行选择器必须对照真实 DOM（`#table tbody tr`，tr 无 data-id）——首跑 15s 超时是探针错而非产品慢；页内 while 循环预算必须 < CDP 20s 硬超时。
- 导入一致性顺路复审：sanitizeImportedRow 管住路径注入；merge 按 id 去重使引用重映射自洽；replace 整表原子清洗（H4 两遍法在案）。无新洞。
- 基线：128 / 206 / 452 / **48** 全绿。

**B9 全链路 E2E 轮（第 9 轮）**：
- browser-test 新增「全链路 E2E」组（48→54）：测试进程内起 mock 上游（图/视频/查询/下载四端点）注入 settings，然后**只用真实 UI 点击**走完：分镜行「生成图片」→资产关联→行「生成视频」（自动判定 i2v）→跳转任务页→**poller 轮询→SSE 免刷新徽章推进→自动下载落盘**→回分镜页回显「有视频」。四套测试各自验证过的接缝（UI 事件↔routes↔jobs↔poller↔SSE↔store）首次一次穿通。
- **🐛 实测抓出真产品缺陷并修复**：poller R7 首片回写只补 linked_video_id、**从不推进镜头 status** → `video_ready` 状态在真实流程中永不可达（词表/删除回退/徽章全在引用一个没人写入的态）。修复：justCompleted 闸门同步写 status（done 人工态不覆盖）；apitest +1 行级钉。
- 探针自纠一枚：等待"完成"被状态筛选下拉的 option 文本假通过——真机断言必须行级限定（.task-row 内文），沿用第 8 轮"防假绿"军规。
- 基线：**128 / 207 / 452 / 54** 全绿。

**B10 批量队列 E2E 轮（第 10 轮）**：
- browser-test 新增「批量队列 E2E」组（54→60）：延迟 mock（每张 300ms）+ 16 镜全选提交，真机穿通——**BKEY 即写→换页再换回进度条续上（E7 找回首次真实 UI 证据）→16/16 完成→逐行 linked_image_id+image_ready 回写→BKEY 完结即清**；二次提交点「取消」→条上"已取消"→job 冻结（done 不再涨、mock 命中数差分零）。jobs 队列/R6 防重/cancel 语义整缝贯穿。
- 无新缺陷（第 9 轮 E2E 抓到的 video_ready 死态未再复现，批量出图走 fetchInternal 复用单发关联天然正确）。
- 探针军规再+2：cdp.eval 包装器按"是否含分号"决定表达式/语句体——`return X` 不带分号会被括号包成非法表达式；/api/batch/:id 直返裸 job 无 {ok,data} 信封（与 req() 前端封装口径不同，断言取值要按裸对象）。
- 基线：128 / 207 / 452 / **60** 全绿。

**B11 创作链 E2E 轮（第 11 轮）**：
- browser-test 新增「创作链 E2E」组（60→66）：chat 双分支 mock（分镜导演→JSON 镜头数组 / 提示词工程师→英文短语）+ 出图 mock，真机穿通产品最核心一步创作流——**粘贴脚本→拆镜入库（数组字段顿号拍平、缺字段中景/负面兜底）→批量补提示词（只补缺不覆写）→批量出图→表内徽章/单元全量回显**。
- **B4 画风分层从"单测口径"升级为"云端边界实证"**：mock 抓到发往云 API 的 3 条 prompt 全部自动带上 `watercolor illustration`（水彩项目、提示词库无画风词、注入恰一次去重）——整条分层链在真实进程边界上成立。
- 产品零缺陷；探针自纠三连（全属期望值错）：① 拆镜 JSON 已给 1/3 镜提示词→"每镜都回显 e2e11"期望错；② 分镜表本无缩略 img（图片在素材页）→`tbody img`永假；③ 中段 UI waitFor 撞 batchPrompts 收尾 load() 渲染窗口→回显断言移到 job 完结后的确定点。军规：断言前先对"该 mock 数据下唯一正确值"做手工推演。
- 基线：128 / 207 / 452 / **66** 全绿。

**B12 巡检轮·一（第 12 轮）**：
- browser-test +3 用例（66→69），补齐最后两个未穿面：
  - **脚本页生成-保存链 E2E**：模板字段→变量替换→LLM→结果卡→`#r-save` 入库→`#saved` 列表回显全链（并实测确认"generate 有前端 state.settings 的 Key 门——绕过 UI 直改设置必须 reload 才吸收"这一真实行为，测试注释入案）。
  - **F5 深链复原（boot 竞态）**：`Page.reload` 后 hash 参数保留、项目不错位、直落分镜表——验证 boot 时"先载项目再挂页面"的序列在真环境成立。
- 自纠竞态两枚（上轮侥幸绿的定时炸弹）：异步收尾断言（表内回显/已保存列表）不得即时求值，一律包 waitFor——本轮改后 69/0 三跑连稳。
- 产品侧结论：无新缺陷。基线：128 / 207 / 452 / **69**。

**B13 巡检轮·二（第 13 轮）**：文档陈旧度横查 + 周期门禁。README 无计数主张 ✓；issues.md 为历史快照不改写 ✓；
docs/research/ui-optimization-plan.md 唯一陈旧值 uitest 410→452 修正。ui-audit 复跑 0 发现（连续第 N 绿）；
run-all 全绿 128/207/452/69。图谱时效：9-12 轮对 poller.js（函数体行改）/browser-test（脚本无导出面）
均无结构漂移，锚点结论仍可靠，无需增量。产品零发现，维持收敛。

**B14 巡检轮·三（第 14 轮）**：SSE 连接生命周期审计。
- 代码面：`/api/events`（server.js 本体）close 钩子双清理（clearInterval ping + clients.delete），emit 写失败兜底摘除——**无泄漏**。
- 行为面：apitest 新增**多客户端广播钉**（207→210）——双并发连接 + 提交视频触发轮询，两连接均收到 `event: video`（真实双标签页场景成立）。
- 顺手确认：batch-refresh 只捞 completed-缺-url 资产（非全量），不会给广播添噪声。
- 基线：128 / **210** / 452 / 69。产品零缺陷，收敛维持。

**B15 巡检轮·四（第 15 轮）**：请求体闸门审计。
- 现状核实：API 体唯一有效上限 **120MB**（readBody 调用点显式值；40MB 默认形参是死参数——记录在案不 cosmetics 改），poller 日志数组封顶 200 ✓。
- **B6 契约首次行为化**（apitest 210→212）：分块灌 121MB，裸 http 客户端**读到** `413 {"ok":false,"error":"请求体过大"}`（而非连接重置——当年就是重置导致前端把"文件过大"误报成网络错误），断流后服务照常应答下一请求。
- 踩坑一枚：首探针 41MB 打在 120 限下收到的是业务 400——**测闸门必须先实证真实限值**（grep 调用点），不能信函数默认参。
- 基线：128 / **212** / 452 / 69。产品零新缺陷（守卫在位，只是没钉）。

**B16 巡检轮·五（第 16 轮）**：存储面复审 + **覆盖回退修复**。
- 存储面复审：persist 为 promise 链序列化原子写（无交错损坏风险）；素材文件名全系统生成（`img_ts_rand`），用户 name 不落文件系统，safeName 双保险（basename+字符剥离+`..`防御），URL encodeURIComponent ✓。
- **发现真覆盖回退**：早期 UX 修复轮的弹窗键盘断言（初始焦点/ESC/锁滚动/Tab 不逃出）活在已退役的 `build/ux-audit.mjs`，工具迁移时**断言未迁就丢了**——ui.js 里六个键盘行为（含 ESC 只关最上层、⌃↵提交、onDismiss 补信号、MutationObserver 兜底解锁）此后长期零行为覆盖。
- 修复：browser-test 新增「弹窗键盘行为」组（69→74），CDP `Input.dispatchKeyEvent` 真按键驱动：自动聚焦进表单+锁滚动 / 焦点逸出后 Tab 回捕 / Tab×15 不逃出 / ESC 关闭+解锁 / Ctrl+Enter 主按钮提交路径。首发 74/0。
- 教训入案：**退役测试工具时必须清点其断言去向**，删工具≠覆盖还在。
- 基线：128 / 212 / 452 / **74**。

**B17 巡检轮·六（第 17 轮）**：ux-audit 退役清单追查第二弹——「ellipsis 截断无 title 提示」断言确认也是未搬家的孤儿。
- 补进 ui-audit：所有 `.cell-ellipsis`/truncate/text-overflow 元素中**实际被裁且自身与祖先链都无 title** 的记为发现（`closest('[title]')` 语义与浏览器 tooltip 继承一致）。
- 自证扩展：`trunc=N noHint=M` 进自证行——实测分镜页 20 个截断元素全部带提示、0 违例（**非空跑**，且复证当年那批"截断补 title"修复至今有效）。
- 本维度作为报告型守卫留在 ui-audit（按需跑），不进 run-all 门禁（与既有定位一致）。
- 基线不变：128 / 212 / 452 / 74。产品零缺陷。

**B18 巡检轮·七（第 18 轮）**：E2E 版图合龙（browser-test 74→78，二跑连稳）。
- **设置页写入回环**：任务参数区数值字段 UI→PUT→落库（实测 GET 回读为字符串、断言取 Number 口径）、开关 role=switch 点击翻转落库、重进页面控件与库值同步（读回显示）——十个页面模块自此**全部至少一条真实写链穿通**。
- **成片回显收尾**（第 9 轮 E2E 组延长）：下载完成后素材页 `?tab=video` 以 `/assets/videos/` **本地文件**做播放源（非远端 URL）+ 静态服务 2xx 可读——自动下载的价值闭环首次被看到。
- 探针自纠两枚：素材页默认 image 签（视频要带 tab 参数）；设置值字符串落库口径。
- 基线：128 / 212 / 452 / **78**。

**B19 巡检轮·八（第 20 轮）**：灾备路径审计——发现并修复真产品洞。
- **洞（数据丢失级）**：`readJson` 在 db.json 损坏时能回退 `.bak`，但**恢复后第一次 persist 会把当时仍是坏的 main 复制进 `.bak`**——最后一份好备份被坏数据覆盖，降级链自毁；用户手改坏 JSON（本地工具高频操作）后一旦再有任何坏写，整库无可恢复证据。且坏原文直接丢弃，无取证口。
- **修复（lib/store.js）**：① `readJson` 增加报告位（broken/recovered 分流，ENOENT 与真损坏用 existsSync 区分，首启不误触发）；② 新增 `rescueFile`：init 检测到 main 坏时**先归档 `*.corrupt-<ts>` 留证**，再把恢复态双写回 main+bak（自愈：恢复即链条复位）；③ db/settings 两路径同治。
- **钉（selftest 128→135，「坏文件降级链」组 7 断言）**：单坏→回退 bak、自愈双写、坏原文归档、双坏→空库不炸、settings 坏降级、主库归位盘内存一致。
- 过程教训两枚：① 测试组插在**汇总打印之后**=不计分不门禁的假绿——已挪到收尾块前；② 「主库归位」断言预设了数据存在，而前序导入导出组的 replace 语义合法清空过库——按盘上实况校验，勿预设他组遗留态（跨 home 写队列残留需 `await store.persist()` 排干，此坑同案入）。
- 基线：selftest **135** / apitest 212 / uitest 452 / browser-test 78，run-all 全绿。

**B20 巡检轮·九（第 21 轮）**：设置健壮性面复审零发现——E8 钳制（唯一写入口 + 7 键区间 + 非法回落）与消费端三兜底（poller Math.max、jobs 并发上限 8、agnes timeout ||默认）均早有钉；models.json 走只读默认降级属正确设计（缓存可重取），不扩 rescueFile 面。顺带同步 audit-summary 至 135 基线并补 19-21 轮总账。

**B21 巡检轮·十（第 22 轮）**：排序面审计。API 层本就三级数值排序（episode→sort_order→shot_number），"字符串镜号乱序"假设证伪；但发现**插队自愈行为零钉**——无 sort_order 的行靠 `Number()-Number()` 产 NaN、经 `||` 短路恰好退化到镜号序（正确但微妙）。补契约钉（apitest 212→213）：乱序插入 2,30,1,10 → 返回 1,2,10,30。防未来把 `||` 链改成减法链时悄悄破掉这条兜底。产品零缺陷。

**B22 巡检轮·十一（第 23 轮）**：文档时效专项——三处不实自纠。① README 下载链硬钉 v1.0.1（版本硬编码必腐）→ 去版本化指向 Releases；② 版本口径核实：**1.0.2 早已 bump 到位**（P3 案兑现，双保险注释在案）——"发版 bump"决策项实为"直接发布"；③ 最刺眼：审计总报告写"发版随 CHANGELOG bump"，而**仓库根本不存在 CHANGELOG 文件**——本报告自己犯了它抓的 P 系列杜撰病，已改为如实表述（release notes 可用 issues/summary 充当）。教训：审计产物本身也要过时效审计，报告不豁免。

**B23 巡检轮·十二（第 24 轮）**：README 承诺兑现审计——X4 端口撞车防护真机三场景实证。
- 场景1 同端口+同目录 → **exit0 复用并提示**（影子双写防线在 exe 双击两次场景有效）✅；场景2 同端口+不同目录 → 漂移 +1 ✅；场景3 异端口+同目录 → 起第二实例——README 已如实标注"尽力而为、非文件锁强制"，**承诺与行为一致**，属已声明边界非缺陷。
- 首轮 shell 手工试验被引号/后台进程搅浑出假阳性"未复用"——重写受控 node 脚本 `tools/port-check.mjs` 后真相：产品全对。**教训：多进程行为验证必须进受控脚本，bash 手搓易把探针 bug 记成产品 bug**。脚本入 tools/（按需跑、非门禁）。
- 产品零缺陷。基线不变 135/213/452/78。

**B24 巡检轮·十三（第 25-44 轮，/understand 增量更新）**：图谱时效维护 + 管线踩坑三枚。
- **触发**：锚点 `609559` 之后新增 2 文件（tools/port-check.mjs、docs/audit-summary.md）+ store.js 新符号，按 AGENTS 规约图谱"45 文件全覆盖"已失真，执行增量更新。
- **踩坑1（脚本与技能文档矛盾）**：技能指引要求把裁剪后的旧图写成 `batch-existing.json` 再合并，但 `merge-batch-graphs.py` 的收集正则是 `batch-(\d+)(?:-part-(\d+))?\.json`——**该文件名必被静默丢弃**（首跑 138 旧节点/413 边全灭，只剩 124 新节点）。规避：改名 `batch-100.json` 占位数字后重合并（216KB/196 节点）。
- **踩坑2（测试路径启发式不匹配）**：合并脚本 `is_test_path()` 只认 `*.test.mjs`/`*.spec.mjs` 中缀，本项目测试在 `tools/selftest.mjs` 等——**7 条 tested_by 边每次都会被误删**，必须依赖 Phase 3 评审器恢复（本轮 edgesRestored=7，最终 605 边）。结论：**本项目图谱增量流程中 Phase 3 评审不可跳过**。
- **踩坑3（scan-result 陈旧）**：incremental 复用旧 scan-result 会漏掉新增文件（45 vs 47）。本轮以确定性补丁补 2 条记录（路径/语言/行数/类别 + 空 importMap，端口检查脚本无项目内导入）而非重跑 157k token 的扫描器，并在报告中如实标注。
- **终态**：锚点 `609559` → **`ef8834d`**，**47 文件 / 196 节点 / 605 边 / 9 层 / 15 步导览**，最终图内联校验 **0 问题**（仅 2 条预期孤立节点告警，与 AGENTS 声明一致）。新增：file:tools/port-check.mjs、document:docs/audit-summary.md；层归属增量：test 6→7、documentation 11→12；新边类型 related 7 条。
- **质检证据**：47/47 扫描文件=文件级节点（零缺零多）；0 悬空边；边权重 100% 合规（含 contains 1.0/calls 0.8/documents 0.5）；8/8 节点摘要时效抽查命中当前事实（135/213/78 计数、灾备链、port-check 三场景、截断提示、413/SSE 钉）；分层 9 层 id/名称与旧图完全一致，47 节点无重无漏；导览 15 步零悬空且新文件编入叙事（第 13/15 步）。
- **遗留小瑕（如实记）**：Phase 5 导览输入用的是评审**前**的 598 边集（缺 7 条 tested_by），因我预置输入早于评审恢复；导览叙事经 documents 边覆盖测试链，未受影响，不重跑。另技能 Phase 6 的校验目标写的是 assembled-graph.json，而 layers/tour 实际只在最终图内——按最终图校验才得 0 问题（首跑误报 47 条"未入层"）。
- **流程结论（供下次增量复用）**：① 旧图裁剪件必须命名 `batch-<数字>.json`；② Phase 3 评审不可跳过（tested_by 每次必被误删）；③ scan-result 需先补新增文件；④ Phase 5 输入应在评审**后**生成；⑤ 校验对象是最终图而非 assembled 中间态。

**B25 巡检轮·十四（第 45 轮）**：上游错误映射面审计——发现 T3 负例**断言强度不足**。
- 现状：mock 早已强制 Bearer 校验（T3 修过"mock 不读头"的假绿），但负例只钉 `ok===false`——**未钉 `errorType` 类型化**。而 UI 正是靠 `invalid_api_key` 区分"Key 无效（去设置页改）"与"生成失败（重试）"两种文案；类型一旦丢失，用户只看到笼统失败。
- 同时发现两条未钉的**用户可见承诺**：① 设置页「测试连接」按钮的错 Key 路径（真实 UX 入口，走 chat/只读 /models 探测）；② 「文本生成失败也留任务记录」（任务页历史完整性的承诺，仅代码注释在案）。
- 补钉 5 条（apitest 213→218）：错 Key → `errorType==='invalid_api_key'` + 文案非空含上游原因 + **任务页新增一条 failed 记录且 error_message 含鉴权原因**（before/after 计数自证）+ 连通性测试错 Key → ok:false 且同样类型化。
- 另：本轮起权威全量门禁 `run-all` 全绿（135/213/452/78 → 补钉后 135/**218**/452/78），距上次全量门禁 25 轮，属周期性复跑。
- 产品零缺陷（映射逻辑本就正确，仅缺类型化契约钉）。

**B26 巡检轮·十五（第 46 轮）**：M8 承诺无行为钉 + 一条"为错因通过"的旧钉。
- **主发现**：browser-test 全文**零** busy/disabled 断言——M8「断连不得永久锁死按钮」当年只做了预防性加固（`setBusy` 配对 `finally`），**没有任何测试能捕获"finally 被挪进 try"这类回归**（一挪，任何上游失败都会让按钮永久锁死）。
- **补钉 7 条（browser-test 78→85）**：慢失败 mock（1.2s 后 500，给 busy 态确定性观测窗口）→ 断言 ①点击后进入提交态 ②失败后自动解锁（无残留 `data-busy`/`disabled`）③title 复原（未卡"请耐心等待"）④失败对用户可见（`.toast.err`）⑤解锁后可重试（二次点击再次置 busy）⑥失败未污染数据（镜头仍在且无图）⑦探针镜头建立。**产品行为本就正确**（`finally` 全在），缺的是回归网。
- **连带自纠（旧钉为错因通过）**：apitest 第 387 行分镜排序钉写的是 `episode_number=1`，而 handler 只读 `episode`——该参数被**静默忽略**（返回全部集数），因测试项目恰好只有 1 集而"通过"。已改为 `episode=1` 并加注，钉才真正约束目标集。
- **新增长期事实（AGENTS 注意事项 5）**：**API 响应不做统一信封**——`server.js:350` 把 handler 返回值原样发出，`GET /api/storyboards` 是裸数组、`POST` 是裸 `{inserted}`，只有部分 handler 自返 `{ok,data}`。本次探针首跑即因误写 `rec.data.some` 而炸，属高频 Agent 陷阱，故入档。
- **踩坑复现（已入档的老坑）**：`cdp.eval` 体含 `;` 走语句模式，**必须显式 `return`**——本轮两个选择器字符串漏 return，导致 busy 断言假阴性 + 后续断言被异常打断。

**B27 巡检轮·十六（第 47 轮）**：**测试基建守卫失效**（假绿）+ 两页真机覆盖空洞。
- **主发现（基建缺陷，非产品）**：browser-test 的未捕获异常钩子 `window.__uiErrors` 是用**一次性 `cdp.eval`** 安装的，而套件里有大量 `Page.reload`——首次 reload 后钩子即消失，末尾 `window.__uiErrors || []` 的 `|| []` 兜底让「无 window error / 无未处理 Promise 拒绝」两条断言**在此前整个套件生命周期内一直是空跑假绿**。即：产品层面的 JS 异常卫生**从未被真正验证过**。
- **修复**：改用 `Page.addScriptToEvaluateOnNewDocument`（跨 reload/导航存活，需 `Page.enable`，已在）+ 末尾**自证钩子存活**（`Array.isArray(window.__uiErrors)`）+ **正向对照**（末尾故意 `throw new Error('__hook_probe__')`，必须被捕获才算检测器有效）。三重保障后，全流程（含所有 reload 与全部 UI 交互）实测 **0 未捕获异常 / 0 未处理拒绝**——产品的异常卫生从"无法验证"变为"已验证"。
- **副发现（覆盖空洞）**：browser-test 历史上只走 7 条路由，`#/images`（图片生成）与 `#/videos`（视频生成）**从未被真机访问**（uitest 只覆盖其渲染函数，无真机挂载）。补 9 页挂载矩阵（锚点就绪 + `#view` 内容非空 + 全程无异常）并对两页补强控件断言（模型下拉有项/模式/刷新）。
- **计数**：browser-test 85 → **99**（+14：钩子存活 1 + 正向对照 1 + 矩阵 10 + 两页控件 2）。
- **产品零缺陷**：本轮两处发现都在测试基建与覆盖网，产品行为正确（这也正是钩子转活后仍全绿所证明的）。

**B28 巡检轮·十七（第 48 轮）**：审计测试自身 + 非门禁工具复验 + 总报告时效修订。
- **测试自身审计（静态扫描）**：全仓四套门禁**无恒真断言**、**无自比断言**、**无零断言分组**（逐 group 统计 ok/eq 计数，0 个空分组）、唯一的动态循环（apitest 视频清理）非断言用途。结论：断言网结构健全——此前两轮的问题都在"断言强度/守卫存活"，不在"有无断言"。
- **非门禁工具复验**（自第 17/24 轮后未跑）：ui-audit 与 port-check 实跑均正常退出（结果见该轮运行记录）。
- **总报告时效修订**：`docs/audit-summary.md` 标题仍写"第 1–21 轮"、基线仍写 212/78、规模仍写 45 文件/194 节点/578 边、push 计数 52——**本报告自身已陈旧 27 轮**（B22 立下的"审计产物也要过时效审计"纪律再次生效）。已修订为 1–48 轮 / 135·218·452·99 / 47 文件 / 196 节点·605 边 / 58 提交，并补齐第 22–48 轮台账。

**B29 巡检轮·十七续（第 48 轮）**：port-check 检查器**自身无牙**（"检查但不失败"）。
- **发现**：`tools/port-check.mjs` 场景3 只做字符串匹配（子进程输出含 `数据目录`），未命中就打印 `probe fail`，而脚本**无论如何都 `process.exit(0)`**——三条场景全是 `console.log` 无判定，且场景3 的谓词从未被验证过。即"看起来在验证端口守卫，实际上永远不会报错"。属与 B27（死钩子假绿）同类的**基建假绿**。
- **重写（5 断言 / 真证据 / 违例非零）**：①首实例起在 5701 且 `data_home===H` ②同端口同目录复用 **exit=0** 且输出含复用提示 ③复用进程不产生第二监听（5701 仍服务）④同端口异目录 → 探测 5702 **真实监听**且其 `data_home===H2`（不再靠字符串）⑤异端口同目录 → 5705 影子实例起成且与首实例**同一数据目录**（README 已知边界，实测确认）。任一违例 → 汇总行 + `exit 1`。
- **正向对照（证明能失败）**：先用占位进程占据 5702，再跑 → 场景2 如期 **FAIL**（`data_home=undefined`）且 **exit=1**，汇总行点名违例场景；随后 5/5 全过 exit=0。检查器不再是橡皮图章。
- **产品零缺陷**：端口守卫行为本就正确（复用/漂移/影子实例三态与 README 口径一致），坏的是验证它的工具。

**B30 巡检轮·十八（第 49 轮）**：**验证"验证器本身能否失败"**（元审计，正向对照法）。
- **门禁编排器 run-all**：静态看逻辑正确（`status!==0 → failed++ → exit 1`），但按纪律做**实证对照**——临时向 selftest 注入一条必失败断言后跑真门禁，结果 `===== 总结：1 个测试失败 =====` 且 **exit=1**；还原后 selftest 135/0、`git diff` 零残留。**门禁不是橡皮图章**。
- **手工图谱校验器 build-graph-data**：临时向 `docs/knowledge-graph/knowledge-graph.json` 注入一条悬空边（`from: node:__nope__`）→ 工具 **exit=1** 且点名 `悬空 from: node:__nope__`；还原后 exit=0 且工作区零 diff。AGENTS 注意事项 4 承诺的"引用完整性校验，失败即非零退出"**属实**。
- **四套件退出码核查**：selftest/apitest/uitest 用 `process.exit(fail ? 1 : 0)`；browser-test 用 `process.exitCode = fail ? 1 : 0`（同样正确，且失败清单会在 `__RESULT__` 后逐条打印）。四者均能传播失败。
- **文档缺口修复**：README「测试」节只列四套件 + run-all，**未提** ui-audit 与 port-check（AGENTS 有、README 无）——已补两条命令与用途说明（含"违例退出码 1"）。
- 产品零缺陷；本轮全部为元审计与文档完整性。

**B31 巡检轮·十九（第 50 轮）**：R6「防连点」承诺**零测试覆盖**——已行为化。
- **发现**：全仓仅两处防连点守卫（`pages/projects.js:153` 新建/编辑项目、`pages/settings.js:424` 导入），均为 R6 修复，但 `tools/` 下**无任何断言**触及（grep 防连点/双击/inflight 只命中 build 脚本里无关的"双击即用"文案）。回归一旦丢掉 `inflight` 或把置位挪到 `await` 之后，**双击「新建项目」就会产生重复项目**，用户可见且无人可捕。
- **补钉（browser-test 99→102）**：①双击创建 → 同名项目恰好 1 个 ②探针清理后项目数复原 ③**灵敏度对照**——两次点击**不重叠**（等第一次落库后再点）应确实产生 2 个，证明①的"只 1 个"来自防连点，而非名字校验/接口去重等巧合。
- **自纠（对照首跑即暴露我自己测试的 bug）**：对照首次运行报 `同名=3`——因为①的首批项目在对照前**未清理**，1+2 叠加。已把首批清理移到对照之前，对照期望恢复为 2 并通过。教训：对照不仅要证明"能失败"，还必须**隔离被测对象**，否则计数被残留污染。
- 产品零缺陷（守卫行为正确：同步置 `inflight` + `setBusy` 禁用双保险）。

**B32 巡检轮·二十（第 51 轮）**：**🐛 产品缺陷——快速连切页面泄漏 SSE 监听器**（自 B19 以来首个产品 bug）。
- **机制**：`public/js/app.js` 的 `render()` 是 async 且**未串行化**，`cleanup` 是模块级单变量。用户快速连点两个导航项时，先发起的页面 mount 可能**后** resolve，其 `cleanup = c` 会**覆写**后发起页面的清理函数——后发起页面的 `onEvent` 订阅与去抖定时器从此无人回收，此后**每次 SSE 事件都多跑一个陈旧处理器**（陈旧处理器还会对着已脱离 DOM 的容器调用 `loadRecent()` 等，产生无谓请求）。
- **复现（确定性）**：把 videos 页首个 `/api/videos` 请求延迟 350ms → 使其 mount 晚于 dashboard 的 resolve；竞态后向应用 EventSource 合成一条 `video` 事件 → 被取代的 videos 监听器仍被抓取（`fetches=1`）。
- **修复**：`render()` 增加渲染序号守卫 `renderSeq`——只有"最新一次渲染"有资格登记 `cleanup`，被取代的渲染**立即自清**并跳过 `scrollTo`；异常分支同样按序号判定，避免陈旧渲染把错误写到新页面上。
- **补钉 4 条（browser-test 102→106）**：①竞态后停留在后发起页面 ②已捕获应用 EventSource 并可合成事件 ③**被取代页监听器未泄漏**（合成事件不触发其抓取）④**内置灵敏度对照**——活跃 videos 页收到同一事件**必须**抓取（证明事件与计数信号有效，非空跑）。
- **正向对照（证明探针能抓 bug）**：临时移除序号守卫 → 探针如期 **FAIL（`fetches=1`）**；还原后 106/0 全绿。**这是本轮"缺陷真实存在"的硬证据**。
- **严重度**：低（本地优先应用，表现为快速切页后每次任务事件多一次无谓请求 + 监听器累积；无数据损坏、无崩溃）。但属真实回归面，且修复零风险（纯守卫）。

**B33 巡检轮·二十一（第 52 轮）**：数据完整性承诺「保存失败必须让用户看见」**零测试覆盖**——已端到端钉住。
- **背景**：`lib/store.js` 早有 `onWriteError` 钩子（注释自陈"上一版 API 照回成功但从未持久"），`server.js:115` 接管后转成 `poller.pushLog({level:'error'})`，最终经 `GET /api/logs` 抵达 UI。**这条链路此前无任何断言**——一旦钩子被摘掉或 pushLog 改签名，磁盘满/只读时用户仍会看到"已保存"，重启后数据消失，而门禁全绿。
- **补钉 4 条（apitest 218→222）**：①`chmod HOME 0o555` 制造真实写失败 → 轮询 `/api/logs` 必须出现 `level='error'` 且含「保存失败」的条目（用户可见）②**非空跑自证**：断言探针确实制造了写失败（否则上面的绿无意义）③`chmod` 恢复后可写、设置真的落库 ④恢复后无新增失败日志。finally 中恢复权限，避免污染后续。
- **顺带排除（同轮静态核查，均无问题）**：①`writeJsonAtomic` 临时文件为 `${file}.${pid}.tmp` 且**全同步实现**——单线程内不可能交错，PID 隔离跨进程，无并发损坏面（注释亦记录了历史"fsync 假修复"已被 `fsyncMisses` 计数 + selftest 断言钉死）②分镜编辑走**弹窗**（独立 DOM 子树），批量任务结束后的 `load()` 重渲染不会冲掉用户未保存输入③写失败处理器本身用 try/catch 包裹，日志链路坏掉也不会拖垮写队列。
- 产品零缺陷（链路本就正确，缺的是契约钉）。

**B34 巡检轮·二十二（第 53 轮）**：**承诺清单 × 覆盖 系统化对照**——安全边界 X1/X3 无钉、数据丢失级守卫 X4 只在非门禁里。
- **方法**：正则抽出源码注释里的全部修复编号（B/R/E/T/H/M/P/X/D/F + 子号），与 `tools/*.mjs` 全文比对。71 个编号中 54 个未在测试中出现（**注意**：`consts.js` 的 `M*` 多为设计令牌/调色板假阳性，勿再追）。编号缺失≠未覆盖，故对安全类逐条人工核行为。
- **发现①（X1 无钉）**：`server.js:273 hostOk()` 的 Host 白名单是 **DNS rebinding 挡板**——没有它，恶意域名把 A 记录指向 127.0.0.1 后，那个网页就能以"同源"身份静默读走 `/api/bootstrap`、`/api/export` 等全部本机数据。补 4 钉（**双向**：恶意 Host 403 / userinfo 形态 403 / FQDN 尾点 `localhost.` 放行 / 本机 `127.0.0.1:port` 放行——后两条防止白名单被"一刀切"实现收窄而误杀正常访问）。
- **发现②（X3 无钉）**：非法转义 `%zz` 与空字节路径必须 400 且**不许炸监听器**（该 catch 同时兜住 async 同步段抛出）。补 3 钉：`%zz`→400、`/%00`→400、**之后 `/api/health` 仍 200**（存活自证）。
- **发现③（X4 只在非门禁）**：`EADDRINUSE` 时"同数据目录则拒绝起第二实例"是**数据丢失级**守卫（persist 为整库快照全量写，两实例互踩静默丢数据，"exe 双击两次即中招"），此前仅由**非门禁**的 `port-check` 场景1 覆盖——回归不会让 `run-all` 变红。补 3 钉提升进门禁：第二实例 exit 0 + 输出含"已在运行" + **原实例仍健康**（未被抢端口）。
- **计数**：apitest 222 → **232**（+10）。门禁 135/232/452/106 全绿。产品零缺陷（三处防护本就正确，缺的是契约钉）。

**B35 巡检轮·二十三（第 54 轮）**：承诺清单续查——**H5 安全白名单**与 **R4 帧数公式**双双零覆盖。
- **发现①（H5 零覆盖·安全）**：`PUT /api/videos/:id` 的 `video_url` 只收 http(s) 或空，防 `javascript:`/`data:` 进 `<video src>` 与"打开链接"按钮——**此前无任何断言**（全仓测试连 `javascript:` 字样都没有）。补 6 钉：`javascript:alert(1)`→落空串、`data:video/mp4;base64,…`→落空串、`HTTP://`（大写）放行、`https://` 放行、空串放行（允许清空）、探针视频建成功。
- **发现②（R4 零覆盖·云端硬契约）**：`consts.js:secondsToFrames()` 把分镜时长折算成 Agnes 的 `num_frames`，**云端要求帧数必须 = 8n+1 且 ≤441**——违反即整单被拒。此前测试只把 121/241 当**透传值**断言，公式本身零覆盖。补 10 钉（**页面内 `import('/js/consts.js')` 测真机下发的产物**）：默认 5s→121、0/负数/非数字→121、1s→81（下限）、10s→241、60s→441（上限）、30fps/5s→153、**0..70s 全扫描 71 个值全部满足 8n+1**、s≥1 单调不减（证明"时长"列真影响产出而非被写死）。
- **假阳性排雷（已入档）**：`secondsToFrames(0)=121 > secondsToFrames(1)=81`，因为 0/非法值走"默认 5s"分支——**天真的全局单调性断言会误报**；正确写法是 s≥1 单调 + 非法值单列断言。
- **发现③（B8 补钉）**：API 路由参数非法转义（`/api/projects/%zz`、`/api/videos/%zz/refresh`）必须按"不匹配"→404，不许 URIError→500。补 2 钉（此前只钉了静态路径的 `%zz`）。
- **经核不再补（附理由）**：R1（onDismiss 防 Promise 永挂）——ESC/遮罩关闭已在 browser-test 钉住，且当前各调用方"取消"后无可见后续动作，悬挂 Promise 与 resolve(false) 不可区分，钉不出有效信号；E2/E5（批量条互斥、播放中不 surprise 重绘）留待专项；P1/B7（6h TTL、listening 只注册一次）低价值。
- **计数**：apitest 232 → **240**（+8），browser-test 106 → **116**（+10）。门禁 135/240/452/116 全绿。产品零缺陷（两处契约本就正确）。

**B36 巡检轮·二十四（第 55 轮）**：E5「播放中不 surprise 重绘」从待办转为**已钉**（含正向对照）。
- **承诺**：`tasks.js` 的 SSE 刷新若正在播视频会打断观看，故 `scheduleRender()` 设计为"有 `#list video` 在播就挂起，800ms 轮询等播完补渲染，60s 兜底"。此前零覆盖。
- **探针设计（哨兵法）**：向 `#list` 注入受控 `<video>`（用 `Object.defineProperty` 以**自有属性遮蔽**原型上的 `paused`/`ended` 真值，从而无需真实媒体文件即可模拟"正在播放"）+ 一个哨兵节点；`render()` 重写 `#list` 会抹掉哨兵，于是"是否重绘"变成一个**可直接观测**的布尔量。
- **三阶段 4 钉**：①播放中收到合成 SSE 事件 → 哨兵仍在（**不重绘**，E5 核心承诺）②播放停止 → 800ms 内哨兵被抹（挂起**不是永久冻结**，补渲染真的会来）③**灵敏度对照**：空闲时同一事件 400ms 内哨兵即被抹（证明哨兵确实能探测到 render，阶段①的"仍在"不是探测器失灵造成的假绿）④探针注入自证。
- **正向对照（硬证据）**：把 `scheduleRender()` 改成永远立即 `render()` → 阶段①如期 **FAIL**；还原后 120/0 全绿。
- **未钉（诚实标注）**：60s 兜底分支需要真等 60s，不可门禁化——其存在性已由代码审读确认，若日后回归为"永不补渲染"，阶段②（800ms 路径）会先报警。
- **计数**：browser-test 116 → **120**。门禁 135/240/452/120 全绿。产品零缺陷（E5 实现本就正确）。

**B37 巡检轮·二十五（第 56 轮）**：E2「批量条互斥」从待办转为**已钉**（含正向对照）——**待办专项清单至此清空**（仅剩需用户拍板的 1.6 内联样式长尾）。
- **承诺**：`storyboards.js` 的 `#batch-bar` 是**单槽位** UI——「批量补提示词」按镜逐条占用它（每条约 5〜20s，慢时数十秒），期间若有批量任务 SSE 事件到达，`renderBatchBar()` 会把补提示词的进度文案冲掉，用户看到的进度会"跳戏"。故 `offBatch` 首行 `if (promptBusy) return;`，并在补提示词收尾时自行补渲染最新 `job`。
- **探针设计**：自带**慢 mock**（chat/completions 延迟 900ms）稳定制造 `promptBusy` 窗口；探针项目 2 镜均缺 `image_prompt` → 窗口 ≈1.8s；期间注入合成 batch 事件（payload `{type:'images',done:42,total:42,ok:42}`），其被错误渲染时 bar 会显示可辨识的「批量生成图片：42 / 42」。
- **5 钉**：①**前置自证**——补提示词确实占用了 bar（`生成图片提示词` 在文案里）②已合成批量事件 ③**进行中事件未覆盖 bar**（E2 核心：既无「批量生成图片」也无「42 / 42」）④且 bar 仍显示补提示词进度 ⑤**灵敏度对照**——补提示词结束后同一事件**必须**正常渲染批量条（证明守卫是"作用域内"的，不是永久屏蔽事件，也证明事件注入有效）。
- **正向对照（硬证据）**：摘掉 `if (promptBusy) return;` → ③④如期 **FAIL**，bar 实测变成「批量生成图片：42 / 42\n成功 42\n取消」；还原后 125/0 全绿。
- **计数**：browser-test 120 → **125**。门禁 135/240/452/125 全绿。产品零缺陷（E2 实现本就正确）。
- **收束判断**：第 51–56 轮共发现 **1 个真实产品缺陷（B32 路由竞态泄漏）** + 一批"实现正确但契约无钉"的覆盖缺口（B33–B37）；早期高危面（数据自毁 B19、XSS、CSRF、端口影子实例、写失败上报、安全边界 X1/X3/X4）现已全部有钉。待办专项已清空，下一轮转入**收敛复核**：按维度重跑既有审计面，确认无新问题后结项。

**B38 巡检轮·二十六（第 57 轮）**：收敛复核——UI 度量零发现；**port-check 诊断质量缺陷已修**（附一次真实自伤复盘）。
- **收敛信号①（UI 维度）**：`node tools/ui-audit.mjs` 真机 4 视口 × 9 页 → **共 0 条度量发现**（不溢出、无微字号、对比度全过 WCAG AA），自证 `scanned=364 contrastSamples=21 chips=0 trunc=20 noHint=0`。
- **收敛信号②**：全仓 `TODO/FIXME/XXX/HACK` **零命中**；门禁四套全绿。
- **发现（诊断质量缺陷·真实自伤）**：复核时 `port-check` 报 **4/5，场景2「漂移到 5702」FAIL**。排查发现根因是**我自己在第 50 轮做正向对照时遗留的 mock**（`node -e ...listen(5702)`，PPID 1，存活数小时）：场景2 的前提是"5702 空闲"，被无关进程应答时 `data_home=undefined`，工具却把结论写成"场景2 漂移失败"——**把环境问题误诊成产品回归**。这类误导性结论会让人白查半天。
- **修复**：①**环境预检**——开跑前探测 5701/5702/5705，任一被占用则打印"环境冲突"并 **exit 2**，明确写"这不是产品违例，本次结论不可用"，与"违例 exit 1"彻底分开 ②场景2 失败时区分成因（`healthDrift` 非空但 data_home 不符且自身输出无 5702 → 标注"疑被无关进程占用 → 环境冲突"）③**新增收尾自检断言**「收尾无残留监听（工具自身不泄漏端口）」——正是咬到我的那个失效模式。
- **验证**：连跑两次均 **6/6 exit 0**（幂等、无自泄漏）；占用 5702 → **exit 2** + 环境冲突提示；临时破坏漂移逻辑 → 场景2 **FAIL exit 1**（`data_home=null`，无环境冲突注记）→ 证明三种结局可区分、且改动没把工具变成"永不失败"。
- **方法论复盘（我的操作失误，已入档）**：①正向对照占端口后**必须**收尾，否则污染后续所有验证 ②`kill $!` 在 `bash -c` 包装下拿到的是子 shell 而非真正的 node（`$!`=97568，真身 97569 被孤儿化）——**收尾必须按监听 PID 反查核验**，不能靠 `$!` 假定 ③`lsof -p PID -iTCP` 是 **OR** 关系，要 AND 必须加 `-a`（我一度据此误判"六个进程都监听 5175"）。
- **环境陈留（非本项目产物，供参考）**：另发现 5 个历史残留 `node server.js` 分别占 5568/5578/5588/5597/5191（HOME 为 `/var/folders/.../tmp.*` 与 `/tmp/e2ehome`，非四套测试套件产物），以及 5175/5178 各一个实例（5178 为当前应用）。建议按需清理，避免端口漂移干扰。

**B39 巡检轮·二十七（第 58 轮）**：**API 端点覆盖清单**（57 路由逐一核对）——三个被 UI 真实使用却零服务端覆盖的端点已补钉。
- **方法**：正则抽 `lib/routes.js` 全部 `on('METHOD', path)`，把 `:param` 换成通配后与四套测试文本比对。**首版正则把 `:id` 直接删掉导致 `//` 假阳性**（误报 8 个），改通配后真实未覆盖 4 个，再逐个查 UI 调用方判定价值。
- **发现①（批量取消语义零覆盖）**：`POST /api/batch/:id/cancel` 是批量条「取消」按钮（storyboards.js:90）的后端，此前无任何断言。补 5 钉，其中**"真能停住"用确定性方式验证**：给 mock 加**测试专用出图延迟控制**（`/__mock?slowimg=250`）稳定制造"运行中"窗口 → 从 `GET /api/batch` 捕获 running 任务 id → 取消 → 断言**终态 `cancelled` 且 `done < total`**（不是只置个标记）。
  - **正向对照**：把 `jobs.cancel()` 改成"只 return true 不置标记" → 两条核心钉如期 **FAIL**（实测 `done=6/6, status=done`）；还原后全绿。
- **发现②（任务 CRUD 零覆盖）**：`PUT /api/tasks/:id`（任务页收藏，tasks.js:247）与 `DELETE /api/tasks/:id`（删除，tasks.js:330）零覆盖。补 8 钉，含**局部补丁语义**（只改提供的字段，未提供的 `notes` 不被清空——这是 PUT 最容易写错的地方）、404 分支、删除后确实消失、重复删除 404。
- **发现③（保存到本地零覆盖）**：`POST /api/videos/:id/download`（assets.js:209「保存到本地」/ tasks.js:275）零覆盖。补 6 钉：404 / 无地址 400 / 同主下载成功 / **真实字节数 11B** / `local_file` 写回 / **文件确实落盘** / 持久化后刷新仍在。
  - 注：该端点内部的**跨主不带 Key 安全守卫早已被 T5b 覆盖**（`denyHitsWithKey === 0`），本轮补的是端点自身契约。
- **踩坑留痕（第 3 次被"响应无统一信封"咬）**：`POST /api/videos` 返回 `{ok, asset}`（id 在 `data.asset.id`），而 `GET /api/videos` 是裸数组——我按顶层 `.id` 取值导致 404 连片，且 `JSON.stringify(undefined).slice()` 又崩了一次（`JSON.stringify(undefined)` 返回 `undefined` 而非字符串）。两条均已写入 AGENTS 注意事项 5。
- **计数**：apitest 240 → **261**（+21）。门禁 135/261/452/125 全绿。产品零缺陷。

**B40 巡检轮·二十八（第 59 轮）**：前端导出面清单 → **抓到一条"从未执行过"的死测试**（B27 同类）+ 补 R5 冒泡契约。
- **方法**：抽 `public/js` 全部导出符号（60 个）与 `api.js` 方法（52 个）比对测试文本。**排雷**：`api.js` 方法名未被引用属正常（测试直打端点，路由清单已覆盖该维度）；consts.js 的常量数组（PROJECT_TYPES/PLATFORMS/…）是数据而非逻辑，钉内容属过拟合——真正值得看的是**纯函数**与 **ui.js 的两段式守卫**。
- **🐛 发现（死测试·纯假绿）**：browser-test 里原有的「两段式就地确认」块点的是 `[data-sec="template"]`，而设置页分节 id 实际是 **`templates`（复数）**；因为写了可选链 `?.click()`，**选择器落空时静默什么都不做**，页面停在上一分节 → `[data-del]` 永远找不到 → `if (delSel) {…} else ok('两段式：无模板可点跳过', true)` **每次都走 else**。结论：**那两条 twoClick 断言（首点 armed / 3s 回弹）从写下的第一天起就从未执行过**，而门禁一直是绿的。三个反模式叠加：错选择器 + 可选链掩盖 + 条件跳过式绿。
- **加固**：①经 API 确定性建探针模板（不再依赖"碰巧有模板"）②**重载页面**（设置页在模板创建前已挂载，列表是旧的——首版就栽在此，超时才发现）③去掉 `else 跳过` 分支，显式 `waitFor` 断言按钮存在 ④**按 id 精确定位** `[data-del="<id>"]`——页面上还有内置模板，取第一个 `[data-del]` 会删错对象（第二版栽在此）⑤补上缺的另一半：**窗口内第二击必须真的执行删除**（否则守卫会退化成"永远删不掉"），并断言首点未删除。
- **新增 R5 冒泡契约（4 钉）**：素材卡内图标按钮（收藏/复制/生成视频/删除）都写了 `e.stopPropagation()`，注释自陈"钮与父卡都被选择器命中，冒泡会叠出第二层弹窗"——此前零覆盖。补：①卡内按钮点击**不得**叠出预览弹窗 ②**灵敏度对照**：点卡片本身**必须**能开弹窗（证明弹窗探测器有效，①的 0 不是探测器失灵）③探针图片建成功。
  - **正向对照（硬证据）**：摘掉 `[data-fav]` 的 `e.stopPropagation()` → 实测**叠出 5 层弹窗**（modals=5），R5 钉如期 FAIL；还原后全绿。
- **计数**：browser-test 125 → **132**。门禁 135/261/452/132 全绿。产品零缺陷（R5 守卫本就正确，缺的是钉；真正的问题是**测试自己**）。

**B41 巡检轮·二十九（第 60 轮）**：反模式全库清扫 + 把 B40 教训变成**门禁内的防回归守卫**。
- **反模式清扫（四套测试全量）**：①死选择器：`data-*` 属性名 12 个、`#id` 30 个——**全部存在于源码** ②条件跳过式假绿（`else ok('跳过', true)`）——**仅剩 B40 已修的那处注释** ③恒真断言：`ok(..., true)` 共 12 处，逐条核对**全部是"前置 `waitFor` 已在超时时抛错"的合理记分**（含 uitest 的 `if (!failures.some(...))`，重复名会 `fail++`）④危险可选链：24 处 `?.`，逐条核对——多数后接 `===`/`>` 比较（元素缺失时为 false，安全）；唯一形态可疑的 L311 `(…||{}).click?.()` 后紧跟 `waitFor('.modal')`，空过会**超时大声失败**，安全。**结论：B40 是唯一实例，该维度已收敛。**
- **新增门禁守卫（uitest 第 N 组「测试选择器一致性」，6 钉）**：把"测试里写的选择器必须在源码中真实存在"变成硬检查——解析 settings.js 的 SECTIONS id、校验测试用到的每个 `[data-sec]` 值、校验字面量 `[data-x="v"]` 与 `#id` 选择器。
  - **正向对照**：把 browser-test 真实代码行的 `[data-sec="task"]` 改成 B40 同型错值 `template` → uitest 精确报出 2 条失败并 exit 1；还原后全绿。
- **踩坑留痕（检查器自己的假阳性）**：首版 3 条失败**全是误报**——①扫描语料包含检查器自身源码，命中了注释里举的 B40 例子文本 ②`#p-picker` 是**动态 id**（页面传 `projectPicker(…, {id:'p-picker'})`，源码写 `id="${id}"`，静态搜 `id="p-picker"` 必然搜不到）。修法：**剥注释**（`//` 仅在非 `:` 之后才算注释，避免砍断 `http://`）+ 对动态值给出明确解析规则（`#id` 允许命中实参字面量 `'p-picker'`）。**注意**：`[data-sec]` 必须保持严格成员校验，不可放宽为"字面量出现在源码"——`'template'` 恰好是设置页的图标名，放宽后 B40 就再也检不出来了。
  - 教训：**会喊狼来了的检查器比没有更糟**（B38 同款）。
- **计数**：uitest 452 → **458**。门禁 135/261/458/132 全绿。产品零缺陷。

**B42 巡检轮·三十（第 61 轮）**：新维度「样式类名一致性 + 导出复用一致性」→ **抓到 2 个真实体验缺陷**。
- **方法（类名一致性）**：抽 JS/HTML 用到的类名与 app.css 定义比对。**首版抽取器有 bug**：`classList.toggle('on', b.getAttribute('data-tab') === tab)` 里的 `'data-tab'` 被当成类名（正则取括号内所有字符串字面量）→ 只取**第一个参数**后修正，误报的 `data-sec`/`data-tab` 消失。真实未定义类名 **1 个**。
- **🐛 缺陷①（保存回执谎报大小）**：`tasks.js` 手工算 `(bytes / 1024 / 1024).toFixed(1)} MB`，而 `consts.js` 早就有 `fmtBytes()`（B/KB/MB 分档）。**小于 1MB 的文件一律显示「0.0 MB」**——实测 51200B → 旧式 `0.0 MB`、`fmtBytes` `50.0 KB`；读起来像"什么都没存下来"。已改用 `fmtBytes`。
- **🐛 缺陷②（下载绕过既有工具）**：`images.js` 手工 `createElement('a')` + `click()`，**未 append 到 body**；而 `consts.js` 的 `downloadUrl()` 正是 append+remove 的写法（游离节点在部分浏览器/版本不触发下载）。已改走 `downloadUrl`。
  - 诚实标注：Firefox 对游离 `<a>` 的具体行为**本轮未实测**（本机只有 Chrome/CDP，web_search 余额不足不可用）；结论以"项目已有工具却被绕过"这一**内部不一致**为据，浏览器差异列为待实测。
- **新增守卫（uitest「复用一致性」组，4 钉）**：①页面不得手工换算字节（须走 fmtBytes）②页面不得手工建 `<a>` 下载（须走 downloadUrl）③自证两个工具仍导出 ④灵敏度对照（检测式能命中旧写法）。**正向对照**：把两种旧写法各植回一处 → uitest 精确报 2 条失败并**点名 tasks.js / images.js**；还原后全绿。
- **新增钉（browser-test「字节格式化契约」，7 钉）**：页内 `import('/js/consts.js')` 实测真机产物——11B / 1024→1.0 KB / 51200→50.0 KB / 1MB / 5MB / 非法输入不产出 NaN + **灵敏度对照**（旧手工式在 51200B 上确实谎报 0.0 MB）。
- **自查踩坑留痕**：改 tasks.js 时我把注释插进了语句中间，导致 `load()` 被注释掉（保存后页面不刷新）——**自己引入的回归**，靠随后 `node --check` + 逐行复看发现并修正。教训：编辑后必须复看**改动行本身**，不能只看替换是否成功。
- **死代码清单（已查证，判定"不值得动"，留档）**：CSS 侧 7 条无引用规则 `breathing`/`btn-ghost`/`preset-chips`/`dot`/`pulse`/`g4`/`hoverable`——注意 `btn-ghost` 全仓 87 处引用**全在竞品产物里**（`docs/research/`、`reference/manjugongfang-vibex/` 反混淆包），我们自己的渲染面 0 引用。JS 侧 6 个未使用导出 `uid`/`fmtBytes`(已转用)/`downloadUrl`(已转用)/`dataOf`/`selectField`/`inputField`/`textareaField`。**判定不动**：删 CSS 收益仅数百字节、`dot`/`pulse` 与 `@keyframes`、`g4` 与媒体查询共享选择器行，且静态抽取器看不见运行时拼接的类名（B38 同款：测量工具有盲区时不要据其下结论）；死导出留作后续页面复用候选。
- **计数**：uitest 458 → **464**，browser-test 132 → **139**。门禁 135/261/464/139 全绿。

**B43 巡检轮·三十一（第 62 轮）**：新维度「已有工具被绕过」+「静态 XSS 汇点审计」→ 前者全净，后者零发现但补齐了**最后一层未覆盖的 XSS 面**。
- **绕过已有工具（四类全净）**：页面里无原生 `fetch(`（全走 api.js）✓ 无原生 `alert/confirm/prompt`（全走 ui.js）✓ `new EventSource` 全仓仅 `app.js:187` 一处（页面全走 `onEvent`，这正是 B32 监听器泄漏的前提）✓ 手写 HTML 转义仅 `consts.js` 的 `esc()` ✓。
- **静态 XSS 审计（零发现）**：扫全部页面模板插值，收窄到"取值型未转义插值"90 处并逐类判读——结论全部安全：①布尔/数字/常量映射（`st.cls`/`s.id`/`job.done`/`p.shot_number`）②**JS 字符串上下文**而非 HTML（`storyboards.js:327-328` 的 `s.action`/`s.dialogue` 是拼给 LLM 的提示词、`assets.js:228` 是拼 URL）③经共享汇点转义。
- **共享汇点审计（4 个全 esc）**：`toast`（`esc(message)`）、`errBox`（`esc(text)`+`esc(hint)`）、`options`（`esc(v)`+`esc(l)`）、`modal` 标题（`esc(o.title)`）。`modal` 的 `body`/`footer` 是**按设计的原始 HTML**（调用方负责转义）。
- **🐛 补上最后一层未覆盖的面（7 钉）**：此前 XSS 组只覆盖"页面数据渲染"，**汇点自身没有直接钉**。新增「转义汇点契约」组：页内 `import('/js/ui.js')` 直接调四个汇点喂 `<img src=x onerror=…>`——①toast 零执行且原文可见 ②errBox 输出含 `&lt;img` 且无裸 `<img` ③options 的 value/label 均转义 ④modal 标题零执行且原文可见 ⑤**灵敏度对照**（未转义写法确实触发，证明"零执行"不是探测器失灵）。
  - **正向对照（硬证据）**：摘掉 `toast` 与 `errBox` 的 `esc()` → **4 条钉失败**，其中「toast 不执行注入（零脚本）」失败即**注入真的执行了（真实 XSS）**；还原后全绿。
- **探针自查**：首版 modal 那条钉复用了未清零的共享计数器，导致对照实验时被上一条的残留连带失败——已改为各钉独立清零，保证诊断精确到具体汇点。
- **计数**：browser-test 139 → **146**。门禁 135/261/464/146 全绿。

**B44 巡检轮·三十二（第 63 轮）**：新维度「无障碍可达名」→ **抓到全站系统性缺陷并修复**。
- **🐛 缺陷（系统性·全站表单 label 未关联）**：全仓 `<label>` **73 个无一有 `for`**，也不包裹控件；页面全是手写 `<div class="field"><label>X</label><控件 id=Y>`。后果：①屏幕阅读器读不出字段名（只报"编辑框/组合框"）②**点标签不会聚焦控件**（标准预期失效，对开关这类小目标是实打实的体验损失）。根因值得记一笔：`helpers.js` 里带 `for` 的 `selectField`/`inputField`/`textareaField` **恰好无人使用**（B42 的死导出清单），页面各写各的。
  - **修法**：机械补 `for`（脚本逐条报告，64 处：`<label>TEXT</label>` 紧邻控件取其 id）+ 为 5 个无 id 控件加 `aria-label`（`scripts.js` 动态变量域 ×2、`storyboards.js` 行复选框、`videos.js` 多图 URL/角色）+ 为 3 个"label 与控件之间隔了 `.row`"的开关补 `for` + `script-in`/`search` 只有 placeholder 故补 `aria-label`。`ui.js` 确认框复选框本就**由 label 包裹**→已有可达名（静态扫描误报，真机判定为准）。
- **新增「表单可达名契约」4 钉（browser-test）**：①遍历 9 页 + **设置页全部 6 个分节**（一次只渲染一节，首版只扫当前节 → 漏掉绝大多数控件，实测未命名控件 16 个）②点 `label[for]` 应聚焦关联控件（for 的实用价值）③**灵敏度对照**：无 `for` 的等价标记点击不聚焦（证明上条非"点什么都会聚焦"）④自证非空跑（控件总数 > 20）。
  - **效果**：未命名控件 **16 → 0**；ui-audit 复测「无任何发现：不溢出、无微字号、对比度全过 WCAG AA」。
- **踩坑留痕（`cdp.eval` 求值陷阱）**：`return !!document.querySelector('.page')` 这种**无分号的显式 return** 会被自动包成 `return (return …)` → SyntaxError，而 `waitFor` 吞异常 → 表现为**静默超时**（值为 undefined），排查了一轮。已写入 AGENTS 注意事项 6。
- **踩坑留痕（守卫误报·第三次）**：B41 的"测试选择器一致性"守卫把我在测试里**动态创建**的 `#__lbl` 判为死选择器——**守卫是对的**（严格按设计），故**改测试而非放宽守卫**：改用 `d.querySelector('label')` 结构化查询。原则：守卫的严格性不要为个案让步。
- **计数**：browser-test 146 → **150**。门禁 135/261/464/150 全绿。

**B45 巡检轮·三十三（第 64 轮）**：继续无障碍维度——**键盘可达性**（B44 的另一半）。
- **静态盘点**：CSS 焦点环本就很完整（`.btn/.icon-btn/.mini-btn/.chip/.tabs>button/.segmented>button/.nav-item/.quick-item/.switch/a` 均有 `:focus-visible`）✓；但全仓**无 `tabindex`/`role="button"`** → 卡片类可点 `div` 全是**鼠标专用**。
- **逐个判读（关键：不能一律加 `role="button"`）**：
  - `projects.js` 卡片 → 卡内已有完整按钮行（进入分镜/编辑/复制/导出/删除）→ 键盘用户已可用，**不加**（加了反而形成"按钮里嵌按钮"的 ARIA 违规）✓
  - `images.js`/`assets.js` 图片/视频卡 → 卡内已有 `[data-zoom]`/播放钮 → 同理不改 ✓
  - `dashboard.js` 最近项目卡（`.proj-card[data-pid]`）→ **内部无任何按钮** → 整卡可键盘操作 ✓（新增共享助手 `clickableCard`：`tabIndex=0` + `role=button` + Enter/Space 触发）
  - `assets.js` 文本卡（`[data-sid]`）→ 卡内有删除钮，且**查看全文原先只能点卡片**（键盘不可达、鼠标也难发现）→ 新增显式「**查看全文**」按钮（`data-view`，带 `aria-label`），并把开预览逻辑抽成 `openScript(id)` 复用
- **配套（易漏的一环）**：新可聚焦元素必须**看得见焦点**——CSS 焦点环清单里补 `.proj-card:focus-visible, [role="button"]:focus-visible`。否则"能聚焦但看不见"本身就是新的无障碍缺陷。
- **新增「键盘可达契约」8 钉（browser-test）**：①可点卡片 `tabIndex=0` ②有 `role=button` ③**按 Enter 真的进入项目**（不是只加属性）④**灵敏度对照**：无关按键 `a` 不得触发跳转 ⑤文本卡有显式「查看全文」按钮 ⑥**含按钮的卡片必须没有 `role=button`**（防按钮嵌套）⑦点该按钮确实开弹窗 ⑧探针脚本已建（自证非空跑）。
  - **正向对照（硬证据）**：把工作台卡片退回"只挂 onclick" → 3 条钉如期失败（tabIndex / role / Enter 进入，hash 停在 `#/dashboard`）；还原后全绿。
- **踩坑留痕**：本组首版又踩了 `cdp.eval` 无分号显式 `return` 的坑（`return location.hash`）——**刚写进 AGENTS 注意事项 6 又犯一次**，说明该陷阱极易复现，已统一改为裸表达式；另首版漏了素材页**文本素材在独立 tab 下**（默认是图片 tab），补 `[data-tab="text"]` 点击后才拿到 `[data-view]`。
- **计数**：browser-test 150 → **158**，uitest 464 → **465**（选择器守卫自动纳入新增的 `[data-tab="text"]`）。门禁 135/261/465/158 全绿；ui-audit 复测「不溢出、无微字号、对比度全过 WCAG AA」。

**B46 巡检轮·三十四（第 65 轮）**：无障碍收尾——**弹窗焦点管理**。
- **盘点结果（大部分已达标，值得记下来）**：`ui.js` 的 `modal()` 已有 ①焦点陷阱（Tab/Shift+Tab 在弹窗内循环，且焦点逸出体外会被拉回）②Esc 只关最上层 ③⌘/Ctrl+Enter 提交主按钮 ④打开时自动聚焦（表单优先，其次非危险按钮，再其次关闭钮）⑤`MutationObserver` 收尾（解绑键盘、无弹窗时解锁滚动、`onDismiss` 信号）⑥遮罩点击/× 的脏守卫。browser-test 原有 5 条钉覆盖了 ①④⑤ 与 Esc/Ctrl+Enter。
- **🐛 缺口（APG 要求项）**：**关闭弹窗后不归还焦点** → 键盘用户关掉弹窗后焦点掉到 `<body>`，下次 Tab 从页首重新开始（丢失上下文）。已补：`modal()` 打开时记住 `opener`，收尾时**仅当焦点确实已丢失（掉到 body）且 opener 仍在文档中**才 `opener.focus()`——避免抢走调用方主动设置的焦点，也避免触发者已被移除时报错。
- **新增 2 钉（browser-test，接在既有弹窗焦点组末尾）**：①**关闭后焦点归还触发者**（真实 CDP 键盘 Esc 路径，断言 `document.activeElement === 触发按钮`）②**灵敏度对照**：触发者在弹窗打开期间被移除 → 不抛错、焦点不落在游离节点、也不落在被移除元素上。
  - **正向对照（硬证据）**：撤掉归还代码 → 钉失败并给出精确诊断「BODY/」（焦点确实掉到 body）；还原后全绿。
- **探针自查两处**：①首版用了设置页的 `[data-edit]` 选择器去项目页找按钮（项目页是 `[data-act="edit"]`）→ 超时；②对照断言写成"页面上不存在 `[data-act=edit]`"，但项目页有**多张卡**，删一张后仍能命中 → 改为针对**被移除的那个元素**（`window.__removedOpener`）判定，诊断才精确。
- **计数**：browser-test 158 → **160**。门禁 135/261/465/160 全绿。

**B47 巡检轮·三十五（第 66 轮）**：无障碍收尾——**动态反馈宣告**与**图像替代文本**。
- **✓ 已达标项**：`<html lang="zh-CN">` ✓；列表/网格图均为 `alt=""`（装饰性，语义由卡片文字承担）✓。
- **🐛 缺陷一（反馈层对屏幕阅读器完全静默）**：全仓**无任何 `aria-live`/`role=status`/`role=alert`** → toast（"已删除""保存失败""已复制"）是纯视觉反馈，AT 用户**毫无感知**。修：`#toasts` 容器改 `role="status" aria-live="polite" aria-atomic="false"`（polite 状态区），单条 toast 由 `toast()` 统一加 `role`（**错误提为 `alert` 强宣告**）+ `aria-atomic="true"`（整条原子播报）。
- **🐛 缺陷二（4 处 `<img>` 完全无 `alt`）**：弹窗预览图（`assets.js` 图片预览、`images.js` 大图）、`tasks.js` 源图缩略图、`videos.js` 视频预览图——连 `alt=""` 都没有，屏幕阅读器会去读 URL/文件名（本地路径或 data URL，噪音极大），属 WCAG 1.1.1 失败。修：4 处补 `alt=""`（预览语义由弹窗标题承担）。
- **新增 9 钉**：
  - browser-test「宣告与图像替代文本契约」6 钉：①容器是 live region（role/aria-live 双查）②真机触发成功+错误两条 toast，断言**内容确实进了 live region** 且成功=status ③错误=alert 且 `aria-atomic=true` ④逐页清点 `img` 无 alt 数 ⑤自证非空跑（img 总数 > 0）⑥灵敏度对照（动态造无 alt 图必须被检出）⑦**弹窗预览图也带 alt**（条件渲染路径，自建 fixture 并清理）
  - uitest「图像替代文本（源级守卫）」3 钉：所有 `<img>` 字面量必须带 `alt` + 自证非空跑 + 灵敏度对照
- **⚠️ 本轮最有价值的教训：正向对照暴露了我自己测试的漏洞**。首版只做了浏览器逐页扫描；撤掉 `videos.js` 预览图的 `alt` 后**扫描仍然通过**——因为该图**只在选中视频时才渲染**，默认态扫不到（对照本该失败却没失败）。补法有两层：**源级静态守卫**（覆盖一切条件渲染路径，实测能精确抓到该处并报出文件+片段）+ **弹窗路径行为钉**。教训：DOM 扫描类断言必须问"哪些元素只在特定交互后才存在"，否则给出的是**虚假保障**。
- **探针自查**：①首版去 `#/images` 找 `[data-zoom]` 超时——前面的组已清理图片 fixture，页面处于空态 → 改为**自建 fixture**（顺带加"探针图片已建"自证钉）②`uitest` 的 group 锚点无缩进，首版带了两空格导致断言失败（未产生半成品写入）。
- **计数**：uitest 465 → **468**，browser-test 160 → **168**。门禁 135/261/468/168 全绿；ui-audit 复测零发现。

**B48 巡检轮·三十六（第 67 轮）**：无障碍——**地标/标题/当前页指示**，以及**扩大我自己的扫描范围后又抓到一处漏网**。
- **✓ 已达标项**：每页有 `<h1 class="page-title">`（`helpers.js` 的 `page()` 统一产出）、弹窗用 `<h3>`、仪表盘用 `<h2>`，标题层级合理；`<nav class="nav">` 地标存在；`<main>` 存在；单一 nav 无需 `aria-label`。
- **🐛 缺陷一（当前页对 AT 不可见）**：导航当前页只有视觉 `.active`，**无 `aria-current`** → 屏幕阅读器用户无法知道"我在哪一页"。修：`app.js` 导航模板给当前项加 `aria-current="page"`（只加在当前项上）。
- **🐛 缺陷二（B44 的覆盖漏洞，本轮扩大范围后暴露）**：B44 的浏览器可达名扫描**只查了 `.page` 下的表单控件，从未查 `button`**，于是设置页模板分节的 **31 个 icon-only 按钮**（每模板 2 个 × 16 个内置模板，`data-edit`/`data-del`）一直无可达名——**B44 的静态扫描当时已列出这两行，但因为我只修了浏览器报告的那批，它们被漏掉了**。修：两处补 `aria-label="编辑/删除模板 ${esc(t.name)}"`（**带模板名**，否则 16 个同名按钮无法区分）+ `title` 供鼠标悬停提示。
  - 修法本身也值得记：同名重复按钮的可达名必须**带上区分信息**（模板名），否则屏幕阅读器听到 16 遍"编辑模板"仍无法选择。
- **扫描范围修正（关键动作）**：把可达名扫描的选择器从 `.page input, .page select, .page textarea, .page [role=switch]` 扩为**整篇文档的 `input, select, textarea, [role=switch], button, a[href]`**（含侧栏/页头，此前完全未覆盖）。扩大后**其余页面按钮全部有名**（反向确认此前工作有效），只有模板分节失败。
- **新增/调整钉**：①`aria-current` 钉（断言有且仅有一个、且与视觉 `.active` 一致、且指向当前路由）②可达名扫描范围扩大（同一组内 2 处）。**钉的失败形态也打磨过**：首版用 `waitFor` 等 `aria-current`，缺失时退化成"超时异常"（信息差），改为 `sleep` + 直接断言，失败时直接给出 JSON 明细。
- **正向对照（合并跑）**：同时撤掉 `aria-current` 与一处模板 `aria-label` → **恰好 2 钉失败**（可达名扫描列出成片无名 icon-btn、`aria-current` 钉报出明细）；还原后全绿。
- **计数**：browser-test 168 → **169**。门禁 135/261/468/169 全绿；ui-audit 复测零发现。

**B49 巡检轮·三十七（第 68 轮）**：应用 B48 的教训做**元检查**——我自己还有哪些"扫描范围漏洞"？最明显的一处：**可达名扫描在无弹窗时运行，弹窗内的表单从未被扫过**。
- **先测量、后落钉（本轮方法论）**：
  1. **一次性全量测量**：逐页点击所有"安全"按钮（跳过高危/删除/导出/批量/生成类，用选择器 + 文案双过滤），凡弹出弹窗就扫描其中控件的可达名。首版把整个循环塞进单次 `cdp.eval`，**超时**（CDP 单次 20s 上限）→ 改为 **Node 侧逐个按钮驱动**（每次 eval 很短）。
  2. **测量结果：9 页共点击 544 个按钮，打开 65 个弹窗，无名控件 = 0** ✓ —— B44 的 `for` 补丁把弹窗标记一并覆盖了，此处**无新缺陷**（这是"确认干净"的结论，不是没查）。
  3. 测量完成后**换成有界常驻钉**并删除一次性测量（否则套件时长被永久拉长；套件本就 3-4 分钟）。
- **新增「弹窗内可达名契约」4 钉**：新建项目表单 / 编辑项目表单 / 新建模板表单（三个真实**表单**弹窗，其余是确认/预览弹窗）各断言"控件数 > 3 且无名数 = 0"（自证非空跑）+ **灵敏度对照**（往弹窗注入一个无名 `input`，扫描必须检出恰好 1 个）。
  - **正向对照（硬证据）**：撤掉弹窗内 `f-name` 的 `for` → **恰好 2 钉失败**，诊断精确到 `{"n":12,"bad":["f-name"]}`；还原后全绿。
- **顺带确认**：`closeAll` 关闭弹窗时用"先点 `[data-close]`，再强制移除残留 mask"两步——脏守卫可能再叠一层确认框；强制 `remove()` 会触发 `MutationObserver` 收尾（键盘解绑/滚动解锁/`onDismiss`），故不会漏清理。
- **计数**：browser-test 169 → **173**。门禁 135/261/468/173 全绿；ui-audit 复测零发现。
- **遗留判断**：弹窗内控件在**默认态**下已全有名字；表单中**条件出现**的控件（如选了某类型才出现的字段）仍未逐一覆盖——但静态 `for` 守卫（B44 的 64 处机械补丁 + uitest 选择器一致性）已覆盖源级，风险低，暂记为已知边界。

**B50 巡检轮·三十八（第 69 轮）**：a11y 收官 + 新维度「防连点/数据完整性」的核查与**自我纠错**。
- **✓ a11y 收官确认**：**减弱动效已完整实现**——`@media (prefers-reduced-motion: reduce)` 三处：①全局 `*, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important }`（覆盖全部 18 个 animation / 19 个 transition）②级联延迟 `animation-delay: 0ms` ③侧栏宽度过渡 `transition: none`。**无缺口**。至此 a11y 维度（可达名 / 键盘可达 / 弹窗焦点 / live region / alt / 对比度 / lang / 标题地标 / aria-current / 减动效）**全部核查完毕**。
- **防连点核查（数据完整性维度）**：逐页审计异步点击处理器，结论是**成体系且一致**——`projects.js` 有 `inflight` + `setBusy`；`scripts.js` 有 `generating` 与 `saveBtn.dataset.busy`；`images.js`/`assets.js` 用 `setBusy`；删除类一律 `twoClick`。**无新缺陷**。
- **⚠️ 本轮真正的收获是两次自我纠错**：
  1. **对照不敏感**：我先加了一组"3 次连点只创建 1 条"的新钉，然后做正向对照（撤掉 `inflight`）——**钉没失败**。查明原因：该处有**两层冗余防护**（`inflight` 标志 + `setBusy` 把按钮置 `disabled`，而**禁用按钮不派发 click**），只撤一层当然无观测差异。撤掉**整层防护**（两者同时撤）后钉才失败（实际=3）。**教训：正向对照必须撤掉"整条防护链"，撤一层可能被冗余层掩盖，从而给出假的"对照通过"**。
  2. **重复留痕**：撤两层后失败信息里冒出一条**既有钉**（`双击创建只产生 1 个项目（R6 防连点）`，第 39 轮所加）——它本就带灵敏度对照（"非重叠两次点击应产生 2 个"）与清理校验，**我的新组是重复劳动**。故**删除我新增的组**，保留既有那条（避免同一承诺两处维护）。
- **🐛 顺带修掉一处测试文件自身缺陷**：`tools/browser-test.mjs` 里有一行**重复的 `group(...)` 语句**（同一行写了两遍，我此前编辑的残留）→ 该组标题会打印两次。已删除重复语句（组数不变，输出恢复正常）。另用 `awk` 扫描全文连续重复行，仅命中我的灵敏度对照里**故意**的两条相同 POST ✓ 无其它残留。
- **计数**：browser-test 保持 **173**（新增组已删除、缺陷已修，净变化 0）；门禁 135/261/468/173 全绿。

---

## 三、竞品源码研读轮（第 70 轮起）

> 起点：用户提供 `/Users/apple/Project/Git/Webeye-Video/docs/AI创作资料/08-AI创作项目源码/` 下 5 个 Vibex 导出的
> React+TS 源码包。逐包研读报告见 `docs/research/08-src-01..05-*.md`，综合对照与分批升级路线见
> `docs/research/08-src-00-synthesis.md`（含 R1–R30 借鉴项总表与 10 条「明确不借鉴」边界）。

**B51 研读轮·一（第 70 轮）**：**先读后改**——5 包逐条研读 + 综合路线，并落地「批 1：付费防护 + 请求健壮性 + 错误可读性」。

- **研读产出（只读，未改竞品源码）**：5 份逐包报告（各 440–553 行，全部结论带 `文件:行号` 证据）+ 1 份综合对照。
  关键校正：`ui-our-baseline.md`（锚定旧 commit `5150829`）至少 5 条结论已过期（videos 页 SSE 订阅、`empty()` 的 CTA 插槽、
  `confirm()` 的取消守卫、toast live region、modal ARIA 仍成立），施工口径一律以当前代码为准。
- **批 1 落地（R1–R7）**：
  1. **付费确认**（R1）：新增共享件 `ui.js costConfirm()`（复用既有 `confirm` 的 checkbox 能力 + 带过期的偏好），
     接入 **6 个真实花钱入口**：`storyboards.js` 批量出图/批量出视频/行内出图/行内出视频、`videos.js` 提交、`images.js` 生成。
     旧状态是"删东西要确认、花钱不用"——唯一 `confirm()` 只用于删除类。
  2. **带过期偏好**（R7）：`consts.js` 新增 `readUntil/rememberUntil/endOfToday`，免提醒存**到期时间戳**而非布尔
     （布尔形态要么写清理任务、要么第二天永久静默）。
  3. **前端请求超时**（R2）：`api.js` 的 `req()` 接入 `AbortSignal.timeout` + 四级超时表（quick/normal/gen/submit）。
     生成类必须比后端超时更宽（视频提交含 429 退避重试最长约 4.5 分钟），否则"前端先放弃、后端还在跑"会诱导用户重复提交 = 重复计费。
  4. **错误可读性**（R3）：`consts.js` 新增 `ERROR_HINTS`（覆盖后端全部 14 个 `errorType`）+ `formatError`，
     在 `api.js` 统一拼装。纪律照抄竞品用事故换来的反模式注释：**只补充、绝不替换后端原文**。
     此前 `errorType` 虽已由 `api.js:25` 透传但**页面层 0 消费者**，字段是死的。
  5. **弹窗 ARIA 三角**（R4）：`modal()` 补 `role="dialog"` + `aria-modal="true"` + `aria-labelledby`（标题 id 随机生成）；
     关闭按钮补 `aria-label`。我们早有 ESC/焦点陷阱/焦点归还/脏守卫，竞品反而只有这三个属性、其余全缺。
  6. **`setBusy` 时间预期可传**（R5）：新增第 4 参 `hint`；视频提交/生成、图片生成、行内出视频各自传入准确耗时，
     不再一律显示"20〜60 秒"。
  7. **图片失败兜底**（R6）：新增 `ui.js imgWithFallback()`，替换 `dashboard.js`/`tasks.js`/`videos.js` 的
     `onerror="this.style.display='none'"`（隐藏会让卡片塌陷、栅格错位，用户分不清"没生成"与"加载失败"）与 `assets.js` 的无 onerror `<img>`；
     `app.css` 新增 `.img-fallback`。
- **顺带抓到的真缺陷（不是测试问题）**：`DELETE /api/projects/:id?cascade=1` 的 query 形式**被静默忽略**——
  handler 只读 `body.cascade`，调用方（脚本/测试清理）以为级联删干净，实际留下一堆孤儿分镜/素材。
  已修为 body/query 两种形式都认，并补 4 条 apitest 钉（`removed ≥ 2` + 分镜/素材确实清空）。
- **新增回归钉**：
  - uitest「付费确认与请求健壮性（源级棘轮）」17 钉：付费入口数不得减少、`costConfirm` 必须走 `confirm`+checkbox+带过期偏好、
    页面不得散装自造"会产生真实费用"文案、`req` 必须带 `AbortSignal.timeout`、生成类必须显式放宽超时、
    超时文案不得谎报失败、`formatError` 必须保留原文、modal ARIA 三角、页面不得再用 `display:none` 隐藏坏图 + 灵敏度对照。
  - browser-test「付费确认契约」10 钉：批量入口弹窗 → 取消不提交（无 BKEY）→ 行内弹窗 → 取消后镜头仍无图且按钮未锁死 →
    确认后**真的走到提交**（本组未配 Key，必然以错误收尾，正好当"确实提交过"的证据）→ 票据写入 → **再点不再弹**（当天免打扰）。
  - browser-test「设置页 API Key 收回明文契约」4 钉（补上一轮未提交的 WIP：去掉整页 `render()` 后必须显式收回明文态）。
  - **修掉一条虚假保障**：browser-test 的"确实扫到了图片（自证非空跑）"原先依赖一个**坏链**图片（`/assets/none.png`）
    留在库里才成立——换成 `imgWithFallback` 后坏图被替换成占位块，该钉立刻变 0 而失败。改为**自建可加载 fixture**（data URL）后扫描。
    教训同 B47：DOM 扫描类断言必须自备 fixture，不能依赖"恰好有别的组留下的坏数据"。
- **计数**：selftest 135 / apitest 261 → **265** / uitest 468 → **498** / browser-test 173 → **191**。门禁全绿；ui-audit 复测零发现。
- **待办（显式记录，避免遗忘）**：`.understand-anything` 图谱锚点已落后（本批**新增了导出符号**：`readUntil/rememberUntil/endOfToday/ERROR_HINTS/formatError/costConfirm/imgWithFallback`）
  → 需在批 2/3 稳定后跑一次 `/understand` 增量更新，并同步 `docs/knowledge-graph`（若手工图受影响）。

**B52 研读轮·二（第 71 轮）**：**批 2（上）：空态指路**（R8）。
- **问题**：5 个竞品的空态**一律带主色按钮**（"还没有作品 → 立即创建"），我们 13 处空态里只有 1 处有出口，
  其余只报"没有东西"——用户得自己找路（最典型：分镜页空态提示"去故事脚本页"却只是个链接文案，图片/视频页空态让用户
  "去左侧写提示词"但左侧提示词框在长页面下方）。
- **改法（扩展共享件而非逐页散改）**：`ui.js` 的 `empty()` 第 4 参 action 支持两种形态——
  `{label, go:'#/x'}` 渲染 hash 链接（跨页），`{label, act:'x'}` 渲染按钮并由调用方绑定 `[data-act="x"]`（本页动作）。
  13 处空态全部补齐：项目页 → 直接打开新建弹窗；分镜页/脚本页 → 跳项目管理或故事脚本页；
  图片页/视频页 → 一键滚到提示词框并聚焦（`#t2i-prompt` / `#f-prompt`）；脚本页"暂无保存记录" → 滚到并聚焦 `#gen`。
- **回归钉**：uitest 新增「空态指路」棘轮 4 钉 + browser-test 新增「空态指路契约」6 钉
  （用**全新空项目**制造确定性空态，不依赖"恰好别的组没留数据"；点 CTA 后断言 `document.activeElement.id` 真的是提示词框）。
- **⚠️ 钉的强度教训（本轮最有价值）**：棘轮首版写的是"带 CTA 的空态 ≥ 8"——正向对照（撤掉视频页那处 CTA）**没有失败**
  （9 → 8，仍满足阈值）。**阈值型断言给的是虚假保障**：只要阈值留了余量，撤掉一两处就照样通过。
  改为不变量"`withAction === total`（所有空态都必须给下一步）"后，同样撤一处立刻失败并精确报出 `12/13`。
  这与 B50 的"撤一层防护被冗余层掩盖"是同一类错误：**断言必须敏感到能观测到单点回归**。
- **计数**：uitest 498 → **502**，browser-test 191 → **198**。门禁 135/265/502/198 全绿。

**B53 研读轮·三（第 72 轮）**：**批 2（下）：加载态与信息效率**（R9 R10 R11 R12 R13）。
- **R9 骨架屏**：首屏 8 处「小转圈 + 整片空白」换成形状匹配的骨架屏（新增 `ui.js skeleton(kind,n)` 四形态
  asset/card/row/form + `app.css .sk-*` 微光动画；减动效由既有 `prefers-reduced-motion` 全局规则压掉）。
  价值不在"更好看"，而在**布局不跳变**：spinner 只说明"在加载"，不说明"要加载出什么"。
- **R10 失败追踪码**：此前 5xx 响应只有一句错误文案，用户截图报错后无法与日志对齐。现在
  服务端对 **5xx** 生成短码（`e` + 时间基 36 + 随机），同时写进「运行日志」；`api.js` 把码拼进错误文案
  （几十处 `toast.err(r.error)` 无需改造即带上），`errBox` 第三行展示码并说明"可在运行日志中按码搜索"。
  **4xx 故意不发码**（输入问题，发码只会让界面变吵且无助于排查）。顺带修：`server.js` 的 catch 此前把
  `e.errorType` 丢掉，前端 `ERROR_HINTS` 对路由层抛出的错误永远不生效——现一并透传。
- **R11 派生视图状态进 URL**：`syncViewParams` 早已存在但只写"标签页"这类主状态。补三处派生状态：
  素材页 `fav=1`（URL 优先于本地记忆，分享链接要能还原对方筛选）、任务页搜索词 `q`（并回填输入框）、
  图片页生成模式 `mode`（深链要按 URL 初始化分段控件与两个表单盒的显隐，否则深链会同时显示两个模式）。
- **R12 轮询预算语义（僵尸任务不得自动复活）**：旧实现 `counts` 是内存 Map 且 `watch()` **无条件归零**——
  一个查满预算的任务只要被 `resume()`（每次服务重启）或批量刷新摸到一次，就重新获得满额预算，无限轮询。
  改为**累计次数落库**（`poll_attempts`）＋预算起点落库（`poll_started_at`），`stop()` 只停表不清预算；
  `watch()` 默认拒绝重启，只有**用户主动动作**（重新获取/绑定任务 ID/批量刷新）才 `reset`。
  **顺带修掉一处静默停摆**：拒绝重启若只留日志，界面会永远显示"轮询中"而实际没人轮询——现在同步推成
  `poll_timeout` 终态并给出恢复手段。
- **R13 间隔递增 + 分级预算**：间隔随次数线性放大至 4 倍封顶（远端长排队时密查纯浪费配额）；
  预算按任务规格分档（10s/18s 档为 3 倍预算），另加**墙钟上限**（轻 10 分钟/重 30 分钟）——
  否则"递增间隔 × 大次数"会把超时推到几小时后。判据只用请求里真实存在的字段（`num_frames`），
  **不猜模型名**（换模型后猜名字的分档会静默失效）；分辨率不参与分档（当前三档耗时差异不显著）。
  前端徽章升级为「第 n/预算 次查询 · 每 Ns」。
- **🐛 本轮踩到并已修的真缺陷**：`scripts.js` 用了 `${skeleton(...)}` 却没加进 `import` 列表 →
  ReferenceError → **整页白屏**。原有静态守卫只检查"导入的符号是否存在"，不检查"用到的符号是否导入"，
  于是 uitest 全绿、只有真机挂载矩阵才抓到。已补反向守卫「页面调用共享函数前必须导入」（含自证与灵敏度对照，
  实测能精确报出 `scripts.js 用了 skeleton() 但未从 ../ui.js 导入`）。
- **⚠️ 过程事故（记下来防再犯）**：探测 5xx 路径时把隔离环境变量写成了 `AGNES_HOME`（正确名是
  `AGNES_STUDIO_HOME`），于是临时服务**直接操作了真实 `data/`**（含真实 API Key），并写入了真实
  `settings.json`。已按 `.bak` 还原（差异仅多一个等于默认值的 `video_poll_interval`，无数据损失）。
  教训：**起任何临时服务前先确认隔离变量生效**（正确姿势是启动后校验 `/api/health` 的 `data_home` 等于临时目录，
  apitest 早就有这条自检）。已把该自检意识写进本节，并坚持"先校验隔离、再发请求"。
- **回归钉**：selftest +2 组（间隔递增/封顶/非法值兜底、分级预算、预算耗尽两条路、僵尸拒绝重启并推终态、
  用户重置可复活）；apitest +2 组（轮询预算端到端：落库/文案/时间戳/用户重置可救回；失败追踪码：
  上游返回非 JSON → 502 带码 → 码进日志，4xx 不发码）；uitest +2 组（骨架屏与 URL 还原棘轮、
  共享符号必须先导入）；browser-test +1 组（追踪码展示 + 骨架屏产出占位块 + 未知 kind 退化对照）。
- **计数**：selftest 135 → **159**，apitest 270 → **274**，uitest 502 → **527**，browser-test 198 → **203**。门禁全绿；ui-audit 零发现。

**B54 研读轮·四（第 73 轮）**：**批 3（上）：角色库 R14**（结构化档案 + 参考图 + 外貌锁定 + 分镜绑定）。
- **为什么值得做**：分镜里的"人物"过去是一格自由文本（`storyboards.characters`），每个镜头各写各的，
  结果是同一个角色在十个镜头里长十张脸。角色档案把"长相/服装"抽成可复用的一份，分镜只引用 id，
  注入提示词时由系统统一拼接（R15 的落点）。
- **数据层**：新增 `characters` 集合（`lib/store.js COLLECTIONS`）。**不改写老字段**：
  `characters`（自由文本）与 `character_ids`（结构化绑定）并存 —— 硬把文本改成 id 会让历史分镜
  与"粘贴脚本一次落库"的通路全部丢信息。`storyboardRow`/`PUT /api/storyboards/:id` 均支持
  `character_ids`（数组走独立分支，不能落到 `str()` —— 否则变成 `[object Object]` 这类垃圾）。
- **字段取舍**：`appearance`/`outfit` 独立成列（注入时只取这两段），`personality`/`notes` 留在档案里
  给编剧看、不进提示词；`is_locked` = 外貌锁定（锁定后单镜头提示词不得覆盖长相）；`reference_image_ids`
  指向 `image_assets`（本地优先下**不让用户填公网 URL** —— 外链在本地部署里必然抓不到）。
- **API**：`GET/POST/PUT/DELETE /api/characters`（4 端点）+ **引用守卫删除**（沿用 3.5 删图的做法：
  删角色先遍历分镜解绑并回报 `unlinked`，否则留下"永远指不到实体"的悬空 id）+ 项目级联删除纳入
  `characters` + `bootstrap` 随包下发（分镜页/图片页都要用，避免每页重复请求）。
- **UI**：新增「角色库」页（导航第 5 位，紧跟分镜制作——分镜是角色的使用现场）；卡片显示参考图封面/
  首字占位、定位与锁定徽标、外貌与服装（带 title 悬停全文）、参考图多选（缩略图网格 + 选中描边）；
  搜索词进 URL（R11 同款）；空态两处都给一键出口；删除走就地两段确认。分镜侧：编辑弹窗新增角色芯片多选，
  行内展示绑定角色名（含"失效 N"提示悬空引用），自由文本保留。
- **🐛 本轮踩到的真缺陷**：`characterFields()` 里给缺省 `name: ''` 的写法让 **PUT 部分更新**（只改外貌）
  被判成"改名成空"而 400 —— 这是"为 POST 准备默认值"污染了"PUT 是部分更新"的语义。已删除该缺省逻辑
  （POST 的默认值由 insert 的默认对象负责），并在注释里写清为什么不能加。
- **回归钉**：apitest +1 组（14 断言：必填校验、参考图 id 去重去空、项目过滤、空名拒绝、绑定去重、
  非数组绑定清空、引用守卫解绑 + 悬空清理、bootstrap 下发、级联删除带走角色）；uitest +1 组（导航与图标、
  四端点、外貌/服装独立字段、参考图不填 URL、上限与后端一致、搜索进 URL、两种空态出口、分镜侧绑定与
  失效提示）；browser-test +1 组（真机建档 → 外貌锁定落库 → 卡片渲染 → 参考图封面真加载 → 分镜行芯片可见
  → 删除解绑 → 卡片消失 → 探针清理）；ui-audit 页面数 9→10 且**审计里预置两个角色**（空态下卡片样式
  根本没被渲染出来，等于没量）。另外把新页纳入 1.6 字号棘轮（否则新页是裸字号/微字号的免检区），
  并把「全量导出含 8 张表」改成与 `COLLECTIONS` 同源（加集合不再需要手改数字）。
- **计数**：selftest 159（不变），apitest 274 → **293**，uitest 527 → **575**，browser-test 203 → **215**。门禁全绿；ui-audit 零发现。
- **下一轮**：批 3（下）R15 —— 角色档案在使用点注入提示词（后端 `styleOf()` 同款范式 + 前端 `consts` 镜像 + 导出列），
  让"锁定外貌"真正生效。

**B55 研读轮·五（第 74 轮）**：**批 3（下）：角色档案注入提示词 R15**（批 3 完成）。
- **范式复用而非另造**：与画风分层注入（B4.1）完全同构 —— 入库只存"镜头内容"，角色与画风都在
  **使用点**拼。新增 `finalPrompt(base, {projectId, characterIds, storyboardId})` 统一收口，
  四个使用点（出图 / 文生视频 / CSV 两列 / MD 两列）**恰好 6 处**调用，`storyboardRow` 写入点绝不注入
  （uitest 有括号配平取函数体的硬检查，切片猜长度会假绿/假红）。
- **角色来源**：显式 `character_ids` 优先，否则从 `storyboard_id` 反查该镜头的绑定 —— 调用方（含
  批量路径）不必记得传，`/api/batch/images`、`/api/batch/videos` 因为走 `fetchInternal` 复用同一入口，
  自动获得注入能力。
- **锁定语义（本轮定下的口径）**：`is_locked` = **无条件注入**（同一段长相文本逐字出现在每个镜头，
  这才是一致性的来源）；未锁定 = 提示词里已提到角色名就跳过（用户自己写了长相，尊重用户，不叠两套
  描述）。另有一层与锁定无关的去重：同样的描述已在提示词里出现就不再追加（否则长提示词自我重复、白烧配额）。
  只取 `appearance + outfit` 注入；`personality/notes` 是给编剧看的，进提示词只会稀释画面描述。
  没填外貌的档案不产出 `林岚：` 这种空壳。
- **视频口径与画风完全一致**：只给纯文生视频注入；图生/多帧模式下长相与画风都由参考图携带，
  文字描述与参考图打架时模型给出更差的画面。导出里明确写出这条口径（**导出不许骗人**）。
- **前后端镜像**：`public/js/consts.js` 的 `characterPhrase` 与 `lib/routes.js` 的**逐字同构**（去空白后
  文本比对钉），前端据此在分镜表里显示 `+角色` 徽标与"生成时实际发出"的完整最终词（B4.2 计算态的延续）。
- **🐛 本轮踩到并已修的两个真缺陷**：
  ① **预览会骗人**：分镜页的角色取自 bootstrap 快照，而注入是后端按库中最新数据做的 —— 在别处新建
     角色后，预览显示"没注入"而后端实际注入了。已加 `loadCharacters(projectId)` 并在分镜页 `load()`
     里与分镜并行拉取对齐（合并而非整体替换，不抹掉别的项目的角色）。
  ② **ui-audit 有五条死采样**：`.note.muted` `.muted` `.seg-btn` `.sub` `.prompt-cell` 在源码里**根本
     不存在**，那几条对比度采样从写下的那天起就是 0 个元素，报表照样全绿。已改为真实选择器
     （`.page-desc` / `.hint-sm` / `.hint-xs` / `.segmented > button`）并给提示词单元格补上 `.prompt-cell`；
     修复后对比度采样数 21 → **25**（证明真的多量了 4 处）。并补「采样选择器必须真实存在」硬检查
     （整词匹配，避免 "sub" 命中 submit 这类子串 —— 首版检查器正是栽在这）。
- **回归钉**：selftest +1 组（纯函数 13 断言：锁定/未锁定/去重/空壳/空提示词无前导逗号/多角色顺序 +
  朴素实现对照）；apitest +1 组（16 断言：出图注入外貌服装、顺序固定、锁定照注入、未锁定跳过、
  同描述去重、无绑定不注入、显式 ids 可注入、t2v 注入/i2v 不注入、落库即最终词、CSV 表头与绑定角色列、
  MD 口径说明）；uitest 新增/改写 5 条（使用点恰好 6 处、写入点不注入、前后端同构、预览对齐角色档案）；
  browser-test +1 组（真机分镜行 `+角色` 徽标 + tooltip 角色名 + 预览最终词与后端同文）。
- **正向对照**：临时停掉注入后 apitest 精确失败 **8 条**（其余"断言不注入"的钉保持通过，符合预期）。
- **计数**：selftest 159 → **172**，apitest 293 → **309**，uitest 575 → **585**，browser-test 215 → **218**。
  门禁全绿；ui-audit 零发现。**批 3（角色一致性）到此完成**。
- **下一轮**：批 4 —— 剧本链路两段式（R16 抽取→就地确认→生成 / R17 中间产物可编辑 / R18 长文本计数与超限透明化）。

**B56 研读轮·六（第 75 轮）**：**角色库页布局塌陷与封面非方形（R15 收尾的真机几何复查）**。
R15 功能门禁全绿后，做了一次"代替肉眼"的真机几何复查（当前模型读不了截图，改为用 CDP 量
`getBoundingClientRect`），一量就发现新页有两个**四套断言 + ui-audit 全都漏掉**的视觉缺陷：
- **① 整页塌成一列巨卡**：`characters.js` 写的是 `<div id="grid">`，**漏了 `class="grid"`** →
  `display:block`，三张卡各 1120px 宽、1254px 高，一屏塞不下一张卡；空状态的 `grid-column:1/-1`
  也是空转。四套测试全绿的原因很扎心：**它们只断言"元素存在"**，而元素确实都在；ui-audit 也查不出——
  它查溢出/微字号/对比度，塌陷布局这三点全合规。教训：**只查"存在"的检查永远抓不到布局塌陷，必须断言几何**。
- **② 封面不是正方形**：`.char-thumb` 有 `aspect-ratio:1/1`，但 `img { height:100% }` 是**流内**元素，
  反把方框撑成 1118×1135（实测差 17px）。改绝对定位（`position:absolute; inset:0`）后尺寸只由
  aspect-ratio 决定。CSS 里已写明原因，防止后人改回 `height:100%`。
- **回归钉（均已做正向对照）**：uitest 新增「带 `id="grid"` 的容器必须同时带 `class="grid"`」——
  通用棘轮，管住这一整类"id 有、class 漏"的静默塌陷（还原缺陷后精确报出 `characters.js: <div id="grid">`）；
  browser-test 新增两条**几何**断言：网格必须真多列（`display:grid`、≥2 轨、卡宽 <420px）+ 每个封面
  必须正方形（±2px）。还原两个缺陷后 browser-test 精确失败 2 条（`{"display":"block","cols":0,"cardW":[1112]}`、
  `[[1110,1127]]`）。
- **顺带修掉一条真竞态**：browser-test「创建后弹窗关闭」用立即读 `.modal` 判定，而"接口可读回"只证明
  服务端写完了，客户端的 `closeModal()` 在同一轮异步里后跑 → 偶发假红（本轮真的红了一次）。改成有界
  `waitFor`：断言"会关"而不是"此刻已关"。连跑两次 browser-test 稳定 220/0。
- **计数**：uitest 585 → **587**，browser-test 218 → **220**。门禁全绿；ui-audit 零发现
  （新网格布局在 4 视口下无溢出、无微字号、对比度全过）。

**已知覆盖缺口（第 75 轮记录，留给批 6 / R24 UI 打磨轮）**：`ui-audit` 只按 URL 逐页度量，
**从不打开弹窗** —— 所以全部弹窗（角色表单是其中最长的：10 个字段 + 参考图九宫格）都没有
溢出/对比度/微字号的自动度量。本轮已用 CDP 在 900×600 与 768×560 手工复查过角色表单：
弹窗高 528/493px（均在 88vh 内）、无横向溢出、无字段越界、参考图网格自适应 8→7 列、保存按钮可滚到，
结论是干净的；但"手工查过一次"不等于"以后不会再坏"。批 6 做 UI 打磨时，应给 ui-audit 加一个
"打开指定弹窗再度量"的动作钩子，把弹窗纳入常规度量范围。

**B57 研读轮·七（第 76 轮）**：**批 4：剧本链路两段式（R16 / R17 / R18）**。
- **R16 抽取 → 就地确认 → 生成**：链路顺序（故事构思→剧情梗概→分集大纲→单集脚本→分镜脚本）
  在 `consts.js` 里显式声明为**单一事实来源** `SCRIPT_STEPS`（不靠数组顺序——后人按字母排序会让
  链路静默错位）。结果区新增「带入下一步：<下一步名>」：把**已确认的上游产物**写进下游模板的
  第一个长文本变量，自动切页签并高亮该字段，配「上游已带入 N 字 → 字段 X」提示条 + 撤销带入。
  **生成前门禁**：长文本变量空着 → 单按钮告知并**拦住**（没有素材的生成必然跑偏、还照样扣配额）；
  只是缺短变量或超长 → 列出具体字段与字数要用户明确确认。判据全在纯函数里（`textstats.js`），
  页面只负责呈现与中止。
- **R17 中间产物就地可编辑**：结果区「原文」视图变 textarea，「格式化」视图保持**只读**（就地改
  格式化后的 JSON 极易改坏结构）。编辑落在**唯一事实来源** `result` 上，所以复制/保存/导入分镜/
  带入下一步全都跟着变；实时回填"JSON 可否解析 + 镜头数 + 字数"，改坏了立刻知道而不是等点导入才报错。
  「已改动」徽标 + 「撤销改动」（回到模型原样，不用重新烧配额）。**顺手修掉一个既有体验缺陷**：
  切页签原本会清空结果（模型产出只能靠手动保存留住），现改为**每页签各自保留**——两段式里的
  "确认"必须有个能回去的对象。
- **R18 长文本计数 + 软上限 + 透明化**：逐字段实时字数 + 整条提示词合计（与发送共用同一份
  `buildMessages`，杜绝"显示的字数"和"发出的字数"两套算法）；超 6000 字变琥珀色并提示上限，
  生成前要确认；分镜页粘贴框同样处理。**立场：软上限只提醒 + 确认，绝不静默截断**（截断是最隐蔽的
  骗人——用户以为整段喂进去了，实际被砍一半）。uitest 加了"不得对用户输入 slice 截断"的棘轮。
- **顺带修掉一个真实模板缺陷**：`plot_summary` 的主输入 `{{故事想法}}` 原本被当成短变量渲染成
  **单行 input**（贴一大段想法/原文的入口），长文本判定已补上 `想法|创意|设定|点子`。
- **🐛 又揪出一个测试隔离缺陷**：browser-test 的 XSS 分组造了个毒模板探针 `正文 {{变量}} 型` 却
  **从不删除**；它没写 `template_type` → 落库被填成默认类型 `story_concept` → 之后所有读模板的分组
  都会把「故事构思」页签渲染成这个只含一个变量的毒模板（批 4 分组第一次跑就因此假红：
  门禁报"缺字段：变量"）。已补收尾删除 + "毒模板已清理"断言，并给批 4 分组加了"渲染的必须是真种子
  模板"的自证。**教训：探针数据不只是项目——任何被后续分组按类型取用的全局集合都要收尾**。
- **修掉一条真竞态**：apitest 的 413 契约探针猛灌 121MB 且**不停手**，服务端"先送 413 再断流"后
  继续写入会在已关闭 socket 上抛 ECONNRESET，把已回来的 413 挤掉 → 偶发假红（本轮真的红了一次）。
  改为**收到响应即停写** + 每 8MB 让出事件循环（真实浏览器就是这么做的）。连跑 3 次稳定；
  正向对照：把服务端改回"只重置不送 413"，探针立刻报 ECONNRESET 失败。
- **回归钉**：uitest +1 组（33 条：**动态 import `textstats.js` 测纯函数边界**——5999/6000/6001、
  emoji 按码点算 1 字、空白不算填了、门禁 blocked/confirm/null 三分支，外加 R16/R17/R18 源级棘轮）；
  browser-test +1 组（20 条真机：门禁拦住且只给一个"知道了"、载入→编辑→已改动→撤销、带入下一步后
  页签/高亮/提示条/步骤指示器/字数、超限确认弹窗取消后未发起生成）。uitest 顺带补了 `eq` 断言助手
  （失败时打出期望/实际，只看 "false" 判断不出是差一格还是完全错了）。
- **正向对照**：拆掉门禁 → uitest 精确失败 1 条、browser-test 精确失败 2 条。
- **计数**：uitest 587 → **637**，browser-test 220 → **240**。门禁全绿；ui-audit 零发现。
- **下一轮**：批 5 —— R19 运镜词典（38 运镜 + 景别）/ R20 平台→画幅预设 / R21 变体池。

**B58 研读轮·八（第 77 轮）**：**批 5：提示词资产化（R19 / R20 / R21）**。
- **R19 运镜字典（8 组 38 条）**：`consts.js` 新增 `CAMERA_MOVES`（`{group, zh, en}`）+ 分组视图
  `CAMERA_MOVE_GROUPS`；分镜编辑弹窗加**原生 optgroup 选择器**（38 条按组归类，键盘可达、零新 CSS、
  360px 不溢出）；行内加运镜徽标；`camera_move` 进 PUT 白名单。
- **R19 的关键判断：运镜与画风/角色的注入口径不同**。画风与长相对图生/多帧视频**不注入**（参考图
  自己带着）；但**运镜必须对所有视频模式注入**——参考图携带的是"长什么样"，携带不了"镜头怎么动"，
  而图生视频最需要的运动指令恰恰是运镜。这条差异写进了代码注释与导出说明，并用 apitest 钉住
  （t2v 与 i2v 都注入）。
- **R19 的第二层判断：静帧 ≠ 视频**。「甩镜/延时/一镜到底/滑动变焦」描述的是**时间上的运动**，
  静态图里没有对应物——拼进图片提示词只会让模型画出莫名其妙的运动模糊。所以给每条运镜加了
  `still` 标记（机位/视角类 10 条），**图片侧只放行静帧成立的运镜，视频侧全量**。这不是洁癖：
  "预览说会注入、实际图片没注入"就是骗人，"实际注入了但图里不可能有"就是浪费算力。
  前后端各一份实现，用 uitest 的"静帧集合同构"钉死；浏览器测试里做灵敏度对照（换成甩镜后图片列的
  `+运镜` 必须消失、视频列保留、悬停预览里不得出现 whip pan）。
- **R19 顺手修掉一处"同一件事两套英文"**：图片页的运镜 chips 原来自己写了一套（`slow push in`），
  运镜字典是另一套（`slow push in toward the subject`）——从 chips 点一下和从运镜字段选一下会得到
  不同文本，模型表现也就跟着飘。现在 chips 的运镜组**从 CAMERA_MOVES 生成**，不再另写。
- **R19 白名单而非自由文本**：落库的 `camera_move` 只认字典里的中文标签（前端送未知值一律落空），
  这样"任何文本都可能被拼进提示词"的口子不存在；同时**落库保持中文可读**（本地版用户会翻 data/*.json），
  英文短语在使用点由后端镜像表解析。镜像表 38 条与前端**逐对同构**（uitest 比对 zh=en 全表，
  不是只比数量——改一个词就会被抓住）。
- **R20 平台 → 画幅**：`PLATFORMS` 从 9 个纯字符串升级为 `{value,label,aspect,hint}` 表，
  `value` **刻意保持旧字符串**（存量项目的 `target_platform` 不失效，`options()` 的 R8 兜底也还在）。
  只做"推荐"不做"锁定"：**只在用户主动改平台时**顺手改一次画幅并 toast 告知；之后手动选的画幅不会被
  静默覆盖；`自定义/横版视频` 这类"看情况"的平台返回 null，不硬塞。
- **R21 场景变体池（取模轮换）**：同一条提示词再生成时自动追加一条"换机位/时段/构图/景别"的短语，
  否则连点生成只会得到一串几乎一样的图。**首次（n≤0）不注入**——第一张必须忠实于用户写的词，
  只有"再来一张"才引入变化；变体措辞刻意避开叙事内容（只改机位/时段/天气这类不改变故事的信息）。
  分镜页按行计数（`variationSeen`），图片页按提示词计数（换提示词即归零），失败不记账（重试仍按同一张算）。
- **计数**：selftest 172 → **185**，apitest 309 → **324**，uitest 637 → **668**，browser-test 240 → **254**。
  门禁全绿；ui-audit 4 视口 × 10 页零发现；真机几何复查（1440/390 两档 × 分镜弹窗与项目弹窗）
  无溢出、提示字号 11.5px 高于地坪。
- **正向对照（5 条，全部精确命中）**：拆静帧闸门 → CSV 列口径钉失败；拆白名单 → PUT 白名单钉失败；
  首次也注入变体 → selftest 两条失败；拆平台联动 → browser-test 三条失败；改一个英文短语制造前后端
  漂移 → uitest 同构钉失败。还原后全绿。
- **下一轮**：批 6 —— R22 分镜行三状态点 / R23 提示词就地编辑 / R24 长列表 `content-visibility` +
  焦点环 + CJK 基线，并把 ui-audit 的**弹窗动作钩子**补上（这是 B56 记下的已知覆盖缺口：ui-audit
  从不打开弹窗，弹窗内的溢出与对比度至今是盲区）。

**B59 研读轮·九（第 78 轮）**：**批 6：分镜工作台体验与视觉细节（R22 / R23 / R24）**。
- **R22 逐项状态：先改后端，再谈界面**。竞品的分镜卡上有三个阶段徽标（图/视频/音频），我们只有一个
  `status` 单值——它是"最后一道关"的结论，看不出"提示词齐了但图没出"与"图出了但视频没提交"的区别，
  而那恰恰是"要不要点这个按钮"的依据。查证后确认 `lib/jobs.js` 的任务项**只在完成时 push**，
  没有阶段字段，于是先动后端：`run()` 改为**按下标预填、原地改状态**（`pending|running|ok|fail`）。
  这不是重构洁癖，是修两个真问题：① 并发 3 时"完成一条 push 一条"的顺序 ≠ 镜头顺序，界面按数组
  顺序画进度链会**错位**；② 只有完成态，"哪一条正在跑"永远看不见。selftest 用"故意让第 0 项最慢"
  钉住顺序不变式（正向对照下旧写法输出 `1,2,0`，钉红）。
- **R22 三个点而不是"阶段链"**：本产品一条镜头要过的是**三道关**——提示词 / 分镜图 / 视频。我们**没有
  TTS**，硬凑一个音频点只会是永远灰着的装饰，所以按报告建议不显示音频点。竞品把"阶段"落在流水线上，
  我们的批量任务本身是单阶段的（一次全是图或全是视频），于是把"阶段"落在**逐项**上：进度条上方加一条
  逐项状态链（上限 60 项，再多会糊成一片，那种情况百分比条足够）。链上每项 hover 出镜头号与失败原因。
- **R22 刷新后仍对得上**：任务项带 `label`（`镜头 #3`）与不透明的 `key`（分镜 id）并由 `jobs.run` 原样
  回传——否则刷新页面后进度链就成了"第 N 项"，用户没法把失败项对回具体那一镜。取消时把未轮到的项收成
  `cancelled`：不收的话界面永远挂着一排"待处理"，看起来像任务卡死，而实际是用户自己取消的。
- **R23 提示词就地编辑，三条刻意取舍**：① **保存后不 `load()`**——整表重渲染会冲掉其它行的编辑态与
  选中态，还有与在途请求的竞态，只改 `rows` 里那一项再就地换回文本；② **值没变不发请求**——否则点一下
  单元格再点别处就白写一次盘；③ **Esc 取消 / ⌘+Enter 立即保存**——长文本编辑里鼠标离开是常态，必须有
  "不改了"的出口。另外空提示词的"待生成"从死文本变成入口（以前填一条提示词必须开 15 字段的宽弹窗）。
- **R23 的测试自省**：第一版"没被重渲染"的证据是"其它行的勾选还在"——正向对照（在保存后加 `load()`）
  下**照样通过**：因为选中态存在 `selected` 这个 Set 里，整表重建后仍会勾上，拿它当证据是**假敏感**。
  改成 **DOM 身份**断言（给当前 tbody 首行打戳，重渲染会换掉元素）后，对照立刻钉红。
- **R24 焦点环：两份规则并存 = 改一处不生效**。`app.css` 里有两处 `:focus-visible`（`:815` 与 `:987`），
  后者覆盖前者——合并为**全站唯一一处**定义，并升级为**双层**环（内层底色隔开 + 外层金色）：单层半透明
  金在浅色卡片/金色徽标上会糊成一片（"看得见但找不到"）。保留 1px `outline` 兜底（Windows 高对比模式下
  `box-shadow` 常被忽略，只有 outline 还活着）。
- **R24 长列表节流**：`.content-auto`（`content-visibility:auto` + `contain-intrinsic-size: auto 240px`）
  挂到素材卡与任务行。`contain-intrinsic-size` 刻意贴着真实高度写——写小了滚动条会随滚动跳变，比不节流
  还难受。**先挂素材页与任务页**，没敢一次铺开。
- **R24 中英混排基线**：`.cjk-latin`（`font-size-adjust: 0.56` + `vertical-align: -0.15em`）挂在
  "120帧 24fps"这类等宽英文数字夹在中文里的位置。旧 Safari 会静默忽略 `font-size-adjust`，属可接受降级。
- **R24 补上 ui-audit 的弹窗动作钩子（B56 记下的覆盖缺口）**：审计此前只量页面本身，而弹窗是全站最密的
  交互面（15 字段的分镜弹窗、模板编辑器、素材大图），其溢出/微字号/对比度/小目标**至今是盲区**。
  现在页清单带第三项"弹窗动作"，开弹窗后连同弹窗一起度量，并单独检查弹窗自身的横向溢出与越界元素。
  **关键设计：钩子有自检**——声明了动作却没开出弹窗会**报成一条发现**，否则钩子会随界面改名慢慢烂掉而
  报表依然"零发现"（正向对照：把 `[data-edit]` 改成不存在的名字 → 4 个视口各报一条）。顺带补了审计种子：
  素材页与任务页此前是**空态**受检（空态下卡片样式根本没被量到，与"角色卡必须有内容"同一个坑），
  现在用 `/api/import` 塞一条图片与一条已完成视频。**弹窗度量数 0 → 28 次/轮**。
- **探针污染自省**：新分组改了首行的提示词与图片关联，把后面的"批 5 运镜契约"分组搞红了。已按
  "谁污染谁治理"补上复原（分组结束把 `image_prompt`/`video_prompt`/`linked_image_id` 写回原值）并加断言。
- **顺手修掉两处测试基础设施的假敏感**：① 属性选择器棘轮要求 `[data-prompt="image_prompt"]` 的字面量值
  出现在源码里，而源码写的是 `data-prompt="${field}"`（动态值）——放行动态值，但仍要求**属性名存在**，
  并补灵敏度对照；② 浏览器测试新造的 `#chain-probe` 触发了"#id 必须在源码里"的棘轮，改为渲染进真实的
  `#batch-bar` 挂载点（顺带验证渲染器能挂进页面那个容器）。
- **计数**：selftest 185 → **195**，apitest 324 → **336**，uitest 668 → **696**，browser-test 254 → **278**。
  门禁全绿；ui-audit 4 视口 × 10 页（其中 28 次带弹窗度量）零发现。
- **正向对照（6 条，全部精确命中）**：`jobs.run` 换回"完成时 push" → selftest 7 条钉红（含顺序 `1,2,0`）；
  保存后加 `load()` → "不整表重渲染"钉红；焦点环换回单层 → browser-test 钉红；把弹窗钩子选择器改坏 →
  ui-audit 每视口报一条；拆 `cancelled` 收尾 → selftest/browser-test 钉红；`key`/`label` 不回传 →
  apitest 两条钉红。还原后全绿。
- **下一轮**：批 7 收尾——R25 幂等键 / R26 上传压缩与时长校验 / R27 成本留痕 / R28 错误出口 /
  R29 `with_counts` / R30 `// 变更须知` 纪律（其中 R25/R27 已部分落在批 1 的 `costConfirm`，需先核对口径）。

**B89 研读轮·三十九（第 108 轮）**：**"进程跑的是旧代码"防护（批 8 补 27）**。
用户报"原著解析各种能力抛错、接口不存在（如 `/api/story/plan`）"。**接口一个都不缺** —— 查下来是服务进程跑了 3 天。

- **根因**：进程 06:49 启动，那批 `/api/story/*` 端点 16:38 才加进去。前端静态文件每次从磁盘读
  （`no-store`）、**后端只在启动那一刻读一次** → 页面是新功能、接口是旧的。
- **最误导人的报错**：`接口不存在: POST /api/story/plan` 看起来像"这功能根本没做"，而不像"你该重启了"。
- **补救动作被堵住**：再敲一次 `node server.js` 走 X4 分支（同目录第二实例拒绝启动），
  只说"工作台已在运行"然后退出 —— 用户唯一的自救动作被这条正确的防护变成了死路。
- **修法**：启动时留代码指纹（按**内容**算，不按 mtime）；`/api/health` 报 `code_stale`/`stale_files`；
  404 补一句"服务端代码在启动后被改过…请重启服务"；端口被旧代码实例占着时点名并给出 `kill <PID>`；
  页面顶部横幅（读服务端结论）。SEA/exe 形态显式短路（代码在二进制里，跑着不可能变）。
- **教训**：对照 HD 本该变红却 **0 红** —— 断言 `/renderStaleBar\(h\)/` 匹配到了**函数定义**
  而不是**调用**。与补 25 的教训同源，紧接着又踩一次：**绿必须靠注入破坏证明过**。
- **计数**：selftest 730 → **738**，apitest 869 → **893**，uitest 1069 → **1078**，browser-test 497（不变）。

**B88 研读轮·三十八（第 107 轮）**：**让"已改"真的有用（批 8 补 25，假承诺修复）**。
卡片上的"已改"chip 一直写着"重新解析不会覆盖它"，而 `edited` **只被记录、只被显示，从没被合并逻辑读过**。

- **假承诺**：合并规则是"更详细的描述取胜" → 用户改短的值会被模型的长描述冲掉。
  `retry-chunks` 的注释里也写着"永远不会把用户改好的卡片冲掉"——同样不成立。
- **静默回环**：体检一键修复删掉撞名别名时标 `edited`，而追加解析的别名是**并集** →
  那个撞名问题自己长回来，用户看不出来。**"删掉的东西被并回来"比"覆盖"更隐蔽**。
- **修法**：`edited` 真正生效 —— 人工值优先（模型只能补空字段），记账字段（order/mentions/evidence）听新结果；
  追加解析与重新归并两条路共用 `respectEdited` 一份实现；**保住了几张、是哪几张如实上报**。
- **教训（写测试必记）**：端到端那条外貌钉原本用"黑衣"（2 字），mock 返回的"白衣"也是 2 字，
  "更长者取胜"不触发 → **把保护关掉它照样绿**（对照 FE 抓出来的）。
  断言可能"因错误的原因通过"：测试值要落在能真正触发规则的那一侧。
- **计数**：selftest 718 → **730**，apitest 859 → **869**，uitest 1066 → **1069**，browser-test 497（不变）。

**B87 研读轮·三十七（第 106 轮）**：**多文件上传（批 8 补 24）**。
很多作者**一章一个文件**，一次只能选一个就要点 30 次、还得自己保证顺序。

- **顺序是一等公民**：顺序错了原文就乱，而"乱了"只有用户能判断 —— 页面列出"按这个顺序拼起来了：1. 第1章.txt（2.1 千字）…"。
- **"排得动"的判据不能太窄**：只报"一个数字都没有"不够 —— "第1章 + 序章"里序章该在最前还是最后同样排不出来（对照 EB）。
- **不引 `localeCompare`**：顺序依赖运行环境 locale 就会"同批文件在不同机器上顺序不同"，本地永远是对的、极难发现。
- **一个文件读不了就整体不落**（半份原文比没有更糟），并点名是哪个文件。
- **章号按数值排**：按字符串比会把"第 10 章"排到"第 2 章"前面（对照 EA）；页面只取 `files[0]` 会退回单文件（对照 EC）。
- **计数**：selftest 702 → **718**，apitest 859（不变），uitest 1061 → **1066**，browser-test 495 → **497**。

**B86 研读轮·三十六（第 105 轮）**：**Word 文档读取（批 8 补 23）**。
目标里写的是"粘贴或**上传**故事/小说"，而上传此前只收 `.txt`/`.md`——作者手上绝大多数是 `.docx`。

- **边界跟着事实改**：原边界"docx/pdf 是另一个数量级的依赖"**对 PDF 成立、对 docx 不成立**——
  docx 就是个 zip，浏览器原生有 `DecompressionStream('deflate-raw')`，零依赖就能读。
  反转边界时**断言跟着改而不是删掉**（uitest 的"docx 明确拒绝"→"接受 docx + pdf 仍拒绝且理由准确"）。
- **zip 三个坑**：① 局部头扩展域长度与中央目录**可以不一样**（拿错读出垃圾，对照 DC）；
  ② **ZIP64 明确拒绝**（按 32 位读会"成功"返回乱码，比报错难查，对照 DA）；③ 存储/deflate 两种压缩都要覆盖。
- **实体解码顺序**：`&amp;` 必须最后解，否则 `&amp;lt;` 被二次解码（对照 DB）。
- **真机契约**：用 CDP 把一份真 `.docx` 塞进 file input，验"浏览器里真的解出来了"（对照 DD：不分发就红）。
- **计数**：selftest 682 → **702**，apitest 859（不变），uitest 1055 → **1061**，browser-test 489 → **495**。

**B85 研读轮·三十五（第 104 轮）**：**章节复核（批 8 补 22）**。
补 21 把出处翻译成了"第几章"，但章节目录只给一个张数——"第二章 3 张卡"判断不了抽得对不对。
门禁 selftest 677→682 / apitest 854→859 / uitest 1047→1055 / browser-test 484→489。

- **只有张数等于没有信息**：点开一章就地列出这一章抽到的卡片，每张一键跳到原文依据（复用补 20 的 `openSource`，只有一份实现）。
- **张数与 id 列表同源**：服务端只给 `card_ids`，张数由列表长度得出；对照 CB 证明分开算会分叉（"1 张卡"却列出 0 张）。
- **章的原文开头从章标题在块内的位置截**：块 3000 字一装，一章常从块中间开始，拿块开头当章开头会
  "点开第二章看到第一章的文字"（写探针时真踩到）。`assignChapters` 因此暴露 `starts`，与 `chars`/`spans` 同一份 `bounds`。
- **"开关"与"给我看"是两种意图**：主列表点自己是开关；从章节面板点过来是"给我看"（`force`），
  把已展开的依据关掉会莫名其妙（对照 CC）。
- **不把"不知道"说成"没有"**：卡片列表未加载时章节面板会写"这一章没有抽到卡片"——这是假信息，先补加载。
- **计数**：selftest 677 → **682**，apitest 854 → **859**，uitest 1047 → **1055**，browser-test 484 → **489**。

**B84 研读轮·三十四（第 103 轮）**：**章节识别与章节级溯源（批 8 补 21）**。
卡片出处此前只有"第 34 段"——段号是切块算法的副产物，作者想的是"第 12 章"。
门禁 selftest 654→677 / apitest 838→854 / uitest 1035→1047 / browser-test 475→484。

- **标题只认整行**：正文里回指章节是常态，子串匹配会把正文行当标题；目录页用"挨太近"滤掉并如实上报。
- **映射不用偏移量**：块由段落拼成、与原文未必逐字对齐，偏移一漂就整章对错；改用标题字符串定位。
- **"避免重复计数"是个陷阱**：改成"只记主导章"后，标记在第二章的段被报在第一章 —— **假定位比不定位更糟**。
  结论：定位问题（凡涉及的章都报）与贴出处（唯一）是两个问题，用两套口径。
- **出处移到卡片本体**：藏在编辑表单里等于没有；且章节映射必须在渲染**之前**取到（否则先写段号再改写）。
- **不动切块算法**：章节只是给已有的块贴标签，补 18 的补抽对齐性不受影响。
- **计数**：selftest 654 → **677**，apitest 838 → **854**，uitest 1035 → **1047**，browser-test 475 → **484**。

**B83 研读轮·三十三（第 102 轮）**：**卡片溯源（批 8 补 20）**。
卡片上只有"证据段 3"这样的段号，用户想核对"这张卡说得对吗"就得自己回原文里数段 —— 成本高到没人会做，
于是要么盲信（错卡一路传到剧本/分镜），要么重读整本。门禁 selftest 640→654 / apitest 823→838 /
uitest 1026→1035 / browser-test 468→475。

- **服务端只切分、不拼 HTML**：命中的词来自模型输出，服务端拼标签就是把模型输出注进页面。
  `markTerms` 返回 `{t, hit}` 纯文本，前端逐个转义后再包 `<mark>`（对照 BR：不转义 → uitest 3 红）。
- **截断要如实说**：只截命中附近，但必须说明"前后还有内容"，不能让用户以为是完整段落（对照 BQ）。
- **测不出来的"防御"就是负债**：原本按词长排序（注释写着"否则会切碎"），对照证明改成短词优先**结果不变** ——
  真正吃劲的是区间合并。留着会让下一个人以为它在起作用，故**删掉**，钉子改成"结果与词序无关"。
- **溯源有自己的前提**：`source_id` 是来源事实不可改写、删原著级联删卡片（否则留下孤儿卡，溯源自己先断），两条都钉住。
- **计数**：selftest 640 → **654**，apitest 823 → **838**，uitest 1026 → **1035**，browser-test 468 → **475**。

**B82 研读轮·三十二（第 101 轮）**：**参考图缺口体检（批 8 补 19）**。
补 13/补 17 把参考图接进了出图调用，但"接上了"不等于"有人挂"：一个场景在 20 个镜头里反复出现、
一张参考图都没挂 → 20 张图长得都不一样，而**每张图单独看都是"成功"**。
门禁 selftest 624→640 / apitest 810→823 / uitest 1020→1026 / browser-test 459→468。

- **体检的第一要务是不制造噪音**：只报重复出现的（≥2 镜头）、只报真会进图的类型（对照 BM）。
- **"挂了但用不上"比"没挂"更危险**：挂的是本地文件，上游抓不到，用户以为已经做完了（于是不会再看）。
- **判定靠注入的解析器**：卡片存的是图片 **id**，纯函数拿 id 当 URL 判会把配好的卡片全误报成"用不上"——
  假警报比不检查更糟（对照 BN，这个错误本轮真犯过）。
- **体检不能只有结论没有出口**：挑图是人的判断（`fixable: false`），但问题项带 `go` 去处 + 面板「去处理」+ 高亮目标。
- **本轮最贵的一课**：给原著页加定位时把新代码插进了 `if (sourceId) … else …` 中间，`else` 挂到了
  `focusCardId` 上 → **每次正常打开原著页**都会用"还没有选中原著"盖掉卡片。语法检查过、三套文本断言全绿，
  只有真机浏览器测试抓到（AGENTS.md 注意事项 9 的又一次实证）。
- **计数**：selftest 624 → **640**，apitest 810 → **823**，uitest 1020 → **1026**，browser-test 459 → **468**。

**B81 研读轮·三十一（第 100 轮）**：**抽取覆盖体检与补抽（批 8 补 18）**。
分块抽取跑几十段，模型对每段的回答有三种含义完全不同的结局，此前被压成同一个"失败"：
「模型明确说这段没信息」（过场/景物，**正常**）、「模型返回了条目却被我们丢掉」（类别不认识/名字为空，**真丢数据**）、
「调用失败」。前两者在界面上长得一模一样，于是"部分失败 N 段"常年挂着 —— 用户学会无视它，
真丢的那次也一起被无视。门禁 selftest 604→624 / apitest 786→810 / uitest 1008→1020 / browser-test 451→459。

- **"失败"混装两件事，就等于没有信息**：后果不是漏报，而是**告警疲劳**（对照 BI/BJ）。
  判据用纯事实：`raw_count`（模型给了几条）vs `card_count`（我们接住几条），四分类不猜（`classifyChunk`）。
- **只说"丢了几条"用户没法动手修**：要报出模型给的**原始类别**（`raw_kinds`），
  用户才知道是"类别不在六类里"还是"名字为空"。
- **报告必须带出口**：面板列"哪几段该补抽"的同时给补抽按钮，解析完还**自动把面板打开** ——
  顺带修掉原来那句"可在卡片列表重试"的**假承诺**（卡片列表里根本没有重试入口）。
- **重新切块是补抽的隐形地雷**：必须按解析时那套分块参数重切，否则"补抽第 5 段"会把**另一段原文**
  当成第 5 段重抽，而用户看到的是"补抽成功"。所以 `chunk_opts` **留档**，切不回原样就**拒绝动手**。
  这个坑是写探针时真踩到的（探针用默认参数，块号全错），不是假想。
- **只补不删要用 id 证明**："删了重建"也能凑出一样的张数，但 id 一变绑定就悬空（对照 BL）。
- **老数据不替模型回答**：没有逐块记录时标 `unknown` 并列进候选（不是 `empty` 也不是 `failed`）——
  与过期体检的 `unknown` 同一条纪律：宁可说不知道，也不猜。
- **计数**：selftest 604 → **624**，apitest 786 → **810**，uitest 1008 → **1020**，browser-test 451 → **459**。

**B80 研读轮·三十（第 99 轮）**：**地点卡/道具卡参考图进出图输入（批 8 补 17）**。
批 8 补 13 修的是"角色参考图存下来了却从不进调用"；本轮是**同一类**问题再犯一次 ——
地点卡/道具卡连"存"的地方都没有，只有一行文字描述，于是**同一个客厅每张图长得都不一样**，且没有任何报错。
现在地点卡/道具卡可就地挂参考图（多选缩略图），出图时自动带上。门禁 selftest 592→604 / apitest 770→786 / uitest 1000→1008 / browser-test 442→451。

- **"存下来 ≠ 用上了"这个坑会反复出现**：每加一个"可视化载体"字段，都要问一句"**谁在读它？**"。
- **用户挂的数据不能被归并冲掉**：`store.update` 是 `Object.assign` 合并，**键不在 patch 里就保留**；
  `normalizeCard` 一旦在字段缺失时吐一个 `[]`，重新解析/追加解析就会把用户挂的图静默清空 ——
  所以它**故意不产出**这个字段（对照 BG 钉死的是"形状"而不是"值"）。
- **多个来源抢同一个上限时，顺序就是产品决策**：总上限 4 张，**脸比景更难靠文字说准**，所以角色优先；
  被挤掉的必须如实计数（对照 BH）。花钱前的预检也必须覆盖所有来源，否则那句"带了几张"是假的。
- **对照 BF 是假绿，如实记下**：不按 `CARD_IMAGE_KINDS` 过滤时 0 红 —— 因为 `resolveStoryCards` 已只返回
  可注入的 kind，这层是**纵深防御**，防的是"注入表以后扩容"（如给 `world` 加上字段）时场景图静默混进来。
  今天不可证伪，但不删：它挡的是一个**以后很可能发生**的改动。
- **一句话的注释也可能骗过文本棘轮**：`normalizeCard` 里解释"为什么不产出这个字段"的注释必然写出字段名，
  于是被自己的钉子判红。凡按文本匹配的棘轮都要**先剥注释再判**（本轮第二次踩到，已成统一做法）。
- **顺带发现**：原著页只在 URL 带 `source_id` 时才载卡片列表（只给 `project_id` 会停在空态）——
  这不是 bug（页面本来就要"选中一份原著"），但写测试时必须带上，否则等的是永远不出现的元素。
- **计数**：selftest 592 → **604**，apitest 770 → **786**，uitest 1000 → **1008**，browser-test 442 → **451**。

**B79 研读轮·二十九（第 98 轮）**：**全链路进度体检 + 413 竞态真修（批 8 补 16）**。
这条链有七段（原著 → 卡片 → 分集骨架 → 剧本 → 分镜 → 图 → 视频），每段各自在**不同页面**上，
用户想知道"我现在卡在哪一步、下一步该点哪儿"必须自己拼；更糟的是**半成品状态没有任何提示** ——
解析完卡片没分集、3 集骨架只写了 2 集剧本、20 个镜头只出了 5 张图，这些都不是错误，但都需要有人说话。
`GET /api/story/pipeline` 一次给全（**纯本地统计、一次模型都不调**，与体检/分集/过期判定同一条纪律），
工作台画成一条链并给一个**直达下一步**的按钮。门禁 selftest 577→592 / apitest 753→770 / uitest 993→1000 / browser-test 435→442。

- **`blocked` 与 `todo` 必须分开**：前者"前置还没做，点进去也做不了"，后者"轮到你了"。混成一个"待办"，
  用户会照着点却发现按钮是灰的。**报状态就要报到能照着做的粒度**。**对照 BA**：selftest 3 红。
- **"做了一半"是独立状态**：只看"有没有"不看"够不够"，3 集骨架只写 1 集也会报 done，
  下一步还会一路指到最后一环。**对照 BB**：selftest 2 红。
- **分母的口径要和用户的心里口径一致**：同一集重生成会存多条剧本，按**条数**算分母就虚高，
  "3 集骨架只有 2 集剧本"被显示成已完成 —— 必须按**集**去重。**对照 BC**：apitest 1 红。
- **每段的分母是下一段的实际需求**：出图段的 need 是**镜头数**。把"有分镜"当成"有图"，
  那一段就永远打勾，用户以为图都出好了。**对照 BD**：apitest 2 红。
- **顺带真修了 413 的一个竞态**（原 B6 的遗留）：`res.on('finish', () => req.destroy())` 发的是 **RST**，
  客户端内核会把还没被应用读走的接收缓冲一并丢掉 —— 已经送出去的 413 响应体也可能被冲掉，
  客户端只看到 `ECONNRESET`，前端又把"文件过大"误报成网络错误（门禁偶发红就是它）。
  改成：请求没收完时先 `req.resume()` **排干**在途数据，让连接以正常 FIN 收尾，同时留 5s 上限
  （不停手的客户端才断流，DoS 边界不变）。**对照探针**（12 连打）：旧代码 `{"ok":6,"err:EPIPE":6}`，
  新代码 `{"ok":12}` —— 竞态真实存在，且已消除。
- **一个测试棘轮把注释当代码**：uitest 的"页面调用共享函数前必须导入"是文本匹配，
  我在注释里写了一句 `on()` 就把它骗红了。已改成**先剥注释再判**（`//` 前不能是 `:`，
  否则 `http://…` 会被当成注释起点），并做了灵敏度对照（真删一个 import 仍然报红）。
- **计数**：selftest 577 → **592**，apitest 753 → **770**，uitest 993 → **1000**，browser-test 435 → **442**。

**B78 研读轮·二十八（第 97 轮）**：**逐集生成分镜用上过期体检（批 8 补 15）**。
批 8 补 12 做出了"剧本/分镜过期判定"，但**只有故事脚本页用了它**；分镜页的「逐集生成分镜」仍按老判据走 ——
默认勾着"已有分镜的集跳过"，而**源剧本改过的集恰恰有分镜**，于是它被**永远跳过**：剧本改了、分镜还是旧的，
用户越点越放心。**防护本身变成了陷阱**。本轮把体检接进分镜页：过期集**不跳过**，弹窗点名"哪几集剧本内容改过"，
并给一个默认勾上的"过期分镜先清空再重生成"（只影响列出的那几集，不勾就在旧分镜后面追加）。
门禁 selftest 577 / apitest 753 / uitest 989→993 / browser-test 428→435，全绿。

- **"防护变成陷阱"是最容易漏的一类 bug**：跳过机制本身是对的（防重跑翻倍），错在判据只看"有没有分镜"，
  没看"那份分镜还算不算数"。**判据要与时俱进**：判"该不该跳过"时，顺手问一句"它现在还成立吗"。
  **对照 AX**（过期集也跳过）：browser-test 3 红。
- **清空必须按项目 + 集限定**：服务端 `DELETE /api/storyboards` 强制两个参数都给（只给 episode 会跨项目删）。
  前端复用同一条纪律，不自己拼删除条件。**对照 AY**（不清空，直接追加）：browser-test 3 红 —— 表现为
  同一集变成两份分镜（`["过期验收镜头","旧镜头"]`）。
- **弹窗要在花钱之前说清"为什么要重跑这几集"**：不说的话用户看到一个默认范围会以为是随机选的。
  **对照 AZ**（不收集过期集）：browser-test 5 红（弹窗一个字不提、默认也不勾）。
- **"删了又生成"要如实上报**：清空 1 个、生成 1 个，汇总里若只说"完成 1 集 / 1 个镜头"，用户看不出
  发生过替换。逐集行标「已替换过期分镜」、汇总里报「替换 N 个过期镜头」。
- **计数**：selftest **577**，apitest **753**，uitest 989 → **993**，browser-test 428 → **435**。

**B77 研读轮·二十七（第 96 轮）**：**负面提示词真正进出图提示词（批 8 补 14）**。
分镜行一直带 `negative_prompt`（默认 `low quality, blurry, distorted face`），**视频用了它、图片链却完全没读** ——
用户在分镜表里看得见这行字、出图时它却被静默丢掉，两张同一镜头的图质量差异无处解释。
本轮把措辞收敛成**一份实现** `story.negativePhrase`（图片链 / 视频 2.5 系 / 前端"实际发出"预览三处同源），
图片链从**分镜行**取负面词并入正向提示词发出；**不单发 `negative_prompt` 字段** —— 网关对未知字段硬拒
（实测报过 `negative_prompt is not an allowed request field`，单发会让整条出图链 400）。
门禁 selftest 571→577 / apitest 740→753 / uitest 983→989 / browser-test 425→428，全绿。

- **同一份数据，两条路读法不同就是 bug**：`negative_prompt` 有字段、有界面、有默认值，视频链路读它、
  图片链路不读。凡是"同一份行数据被多个链路消费"，都要问一句**每个消费方都读了吗**。
  **对照 AS**（图片链不读负面词）：apitest 9 红。
- **显式 → 行**这个取值口径要与运镜/角色/卡片完全一致（前端只带 `storyboard_id` 也要生效）。
  **对照 AT**（只认显式传的）：apitest 6 红；**对照 AW**（行上的覆盖显式的）：apitest 6 红。
- **绝不单发网关不认的字段**：并入正向提示词是**用弱一点的效果换"不打断出图"**，理由写在注释里。
  本轮顺带补上一个**测试基础设施的洞**：mock 网关原本对未知字段照单全收，于是"单发了网关不认的字段"
  这类错误在测试里永远看不见 —— **对照 AU 第一次跑出 0 红**（假的绿）。给 mock 加上与真实网关一致的
  未知字段硬拒后，AU 立刻让整轮崩在图片生成那一步。
- **空值判定要严**：`''`/空白/`undefined` 一律视为没填，否则会发出一个空尾巴"避免出现："。
  **对照 AV**（不 trim 不判空）：apitest 5 红（连带画风那几条也红 —— 空尾巴污染了所有组合断言）。
- **组合断言的隔离**：负面词并入后，所有"内容→卡片→角色→运镜→画风"的组合钉子都会多出同一个后缀。
  加了一个 `negless()` 助手**只剥这一个已知后缀**，出现别的尾巴就原样返回让断言红出来 ——
  放宽判据可以，但不能变成"顺手洗白"。
- **计数**：selftest 571 → **577**，apitest 740 → **753**，uitest 983 → **989**，browser-test 425 → **428**。

**B76 研读轮·二十六（第 95 轮）**：**角色参考图真正进出图输入（批 8 补 13）**。
`characters.reference_image_ids` 是"同一张脸"的**最强约束**（本地优先下，文字描述再多也描述不出一张具体的脸），
角色库页也拿它当封面显示 —— 但在这之前它**从来没进过出图调用**：用户传了参考图、勾了角色，出图仍是一张全新的脸，
而且**没有任何报错**。本轮把它接进使用点：出图时自动取绑定角色的参考图作为上游 `image` 输入，
只有公网 URL 才算数（本地 `/assets/…` Agnes 抓不到，与图生视频同一判定），用不上几张**如实上报**。
门禁 selftest 571 / apitest 727→740 / uitest 977→983 / browser-test 423→425，全绿。

- **"存下来"不等于"用上了"**：字段有、界面显示、类型也对 —— 唯一缺的是"没人读它"。这类缺口最安静，
  因为每一处单独看都正常。**对照 AQ**（不自动带上角色参考图）：apitest 5 红。
- **用不上必须说**：参考图是本地文件时 Agnes 抓不到。静默忽略等于让用户以为参考图生效了 ——
  出图后如实报"用了几张、是谁的"，本地文件单独警告，批量入口在**花钱之前**就预检告知。
  **对照 AO**（不过滤本地文件）：apitest 3 红。
- **上限是双向的**：参考图不是越多越好（多了互相打架、也拖慢生成），`characterRefImages` 与最终数组都夹在 4 张；
  更重要的是 `used` 必须等于**实际发出**的张数 —— 只有一处夹、另一处如实数，界面就会报出一个上游根本没收到的大数字。
  **对照 AP**（去掉 collect 侧上限）：apitest 1 红（正是"used 与实际发出一致"这条钉）。
- **溯源要记实际发出的输入**：`generation_tasks` 原来记 `body.image`，自动带上的参考图就查不到了 ——
  出问题时要能回答"这张图到底喂了什么进去"。**对照 AR**（只记显式传的）：apitest 1 红。
- **不写进提示词**：与画风/长相/运镜同一条纪律 —— 参考图在使用点注入，入库的 `image_prompt` 仍只存镜头内容
  （钉子里直接断言 `generation_prompt` 不含 `example.com`）。
- **计数**：selftest 571，apitest 727 → **740**，uitest 977 → **983**，browser-test 423 → **425**。

**B75 研读轮·二十五（第 94 轮）**：**剧本/分镜的过期体检（批 8 补 12）**。
生成剧本与分镜都要**花钱**，而它们的输入会变：原著**追加解析**补全剧情卡、重切分集让拍表重新分组、
人工改了剧本正文。输入变了、产物没重生成，用户手里就是"一份看起来好好的、其实跟原著对不上的剧本"——
**这类不一致没有任何报错**。本轮把它变成可发现、且**默认动作据此收窄**：
① 剧本记下生成时的**输入指纹**（本集拍表 + 前情提要，服务端算，前端只搬运），分镜记下**来源剧本 id + 其正文指纹**
（服务端按入库那一刻的正文算，前端不参与哈希）；② `GET /api/story/staleness` **纯本地**逐集判定
（缺 / 一致 / 该重生成 / 无法判断）；③ 故事脚本页「过期体检」按钮 + 逐集生成的**默认范围改成"缺剧本或已过期"的集**。
门禁 selftest 545→571 / apitest 708→727 / uitest 969→977 / browser-test 416→423，全绿。

- **"不知道"不能当成"没过期"**：本轮之前生成的剧本、手工粘贴的剧本都没有指纹 —— 如实报 `unknown`、
  **单独计数、且不计入"该重生成"**（当成一致会让用户以为没问题；当成过期会让他白花钱重跑一遍）。
  **对照 AN**（无指纹当一致）：selftest 2 红 + apitest 2 红。
- **前情必须进指纹**：前情是从**更早的集**推出来的。只对本集拍表取指纹的话，前面几集改了、这一集拍表没动，
  指纹不变，可模型看到的上下文已经变了。**对照 AM**（前情不进指纹）：selftest 1 红。
- **精确性也是质量**：原著**往后追加**新章节时，第 1 集的拍表和前情都没变 → **不该报过期**。
  动不动就喊重生成，用户就会去重生成一堆没必要的集（真花钱）。这条写成了钉子。
- **指纹只留一份实现**：`episodeInputDigest` 由 `/api/story/episode-brief` 直接返回，前端原样存进剧本；
  分镜的 `script_digest` 由服务端按入库那一刻的正文算 —— 前端复算哈希迟早跟服务端漂移，
  而这里的判据是"内容变没变"，算错了就直接漏报/误报。
- **幕次收口优先于拍数**：`per_episode=2/3/4` 会收在同一处（"不拆幕"的既定语义），
  想真的改变第 1 集的拍表得跨过幕边界（`per_episode=6`）。写 apitest 时先按 2 写，结果"重切后没过期"——
  不是 bug，是没读懂切分语义。
- **顺带修掉一个真错**：`epNo()` 读的是分集对象的 `.index`，而**行**上是 `episode_number` ——
  传错就是 `NaN`，`NaN < 1` 让所有行被静默跳过（体检报"一集都没有"）。两种数据形状在同一个文件里，
  这个坑写一次就会踩一次。
- **计数**：selftest 545 → **571**，apitest 708 → **727**，uitest 969 → **977**，browser-test 416 → **423**。

**B74 研读轮·二十四（第 93 轮）**：**人物卡 ↔ 资产库漂移体检与同步（批 8 补 11）**。
人物卡是"原著里读到的这个人"，资产库里的角色是"出图时**真正注入**的那份长相"——两者本来是同一份数据的两面
（`cardToCharacter` 复制过去、留 `story_card_id` 指回来），但复制之后各走各的：原著**追加解析**补全了人物卡的
外貌/别名/身份，资产库里那份还是导入时的旧样子。于是**分镜按角色出图用的是旧长相，界面上却显示新描述**——
这类不一致**没有任何报错**，只会让同一张脸越画越不像。本轮把它变成可发现、可一键收敛：
① `story.auditCharacterDrift(cards, chars)` 纯函数体检（并进 `/api/story/audit` 的 `drift_issues`，也并进面板
真正渲染的 `issues`）；② `POST /api/story/audit/fix` 新增 `sync_character`，把人物卡的**外貌/服饰/别名**同步到
资产库那份角色上，**不碰** role/gender/age/personality。门禁 selftest 536→545 / apitest 686→708 /
uitest 964→969 / browser-test 409→416，全绿。

- **判据只看"会注入提示词的字段"**：`characterPhrase` 用 name/outfit/appearance，绑定靠 name/alias ——
  所以漂移只算外貌/服饰/别名三项。把 role/gender/personality 也算进来，**每张卡都会报**，用户会直接无视这个面板
  （**对照 AL** 把这些字段也报出来：selftest 6 红）。
- **"只补空"与"覆盖已有"是两件事**：库里是空 → `info`（纯补全，不覆盖任何内容）；库里非空且不同 → `warn`
  并把"资产库值 → 人物卡值"**逐条摆出来**。真正要判断"哪份对"的是人，机器只负责发现与搬运
  （**对照 AJ** 改成只补空不覆盖：apitest 2 红，报出外貌仍是"白衣"、漂移不消失）。
- **同步不覆盖人的编辑**：只写外貌/服饰/别名，role/personality 一律不动 —— 那些是用户可能特意在资产库里改过的
  （**对照 AK** 顺手把定位/性格也覆盖：apitest 2 红，期望"反派/暴躁易怒"实际"主角/冷静"）。
- **别名的分隔符是历史遗留**：顿号/逗号/斜杠都认（`cardToCharacter` 写的是顿号，手工编辑可能是逗号）。
- **同步留痕**：`notes` 里追加"与人物卡同步（外貌/服饰）"，用户回头看"这份长相怎么来的"时有据可查。
- **顺带的教训**：注入对照必须**先断言锚点唯一**。第一次注入对照 AK 时用了 `const patch = {};` 这个在
  `routes.js` 里出现 **11 次**的字符串，`replace(..., 1)` 改的是**第一处**（另一个端点的），结果 apitest 在
  完全无关的地方 `TypeError` 崩掉——看起来像"改动引发了别的故障"，其实是自己注入错了地方。
- **计数**：selftest 536 → **545**，apitest 686 → **708**，uitest 964 → **969**，browser-test 409 → **416**。

**B73 研读轮·二十三（第 92 轮）**：**追加解析 + 归并 id 稳定（批 8 补 10）**。长篇连载是"越写越长"的，
原来的做法只有"整本重解析"——等于为前面几十万字反复付费，而且已有卡片会被**删了重建**（id 全变 →
分镜绑定、界面上正在看的卡、体检报告里的 target_id 全部指向不存在的卡）。本轮做两件事：
① `POST /api/story/append` 只对**新增章节**分块调用模型，块号接着已有的往后排，同名卡只补字段/并别名/
累计出现次数，已有卡**一张不删、id 不变**；② 归并落库从"先删光 origin=bible 再重建"改成
`applyBibleCards` **按 kind+名字就地 upsert**（保留替换语义：这次结果里没有的旧卡才删，order 听新结果）。
门禁 selftest 522→536 / apitest 669→686 / uitest 955→964 / browser-test 402→409，全绿。

- **"只为新增付费"的判据有两条**：① 追加的模型调用次数 = 新增段数 + 归并 1 次（不含已有章节）；
  ② **发给模型的 user message 里没有第一卷的内容**（browser-test 直接断言请求体）。
- **块号必须接着排**：新卡的 `evidence/chunk_index` 落在新增区间内 —— 否则"这条是从哪段读出来的"骗人。
  断言用的是**库里读回来的卡**，不是返回体里自己算的 `chunk_offset`（那证明不了这件事）。
- **归并 id 稳定是这一轮真正的发现**：写"已有卡 id 不变"的钉子时才发现，**归并本身每次都在换 id** ——
  分镜绑定、体检的 target_id、界面上正在看的卡全都指向了被删掉的旧卡。这不是新引入的 bug，是一直在的。
  **对照 AI**（改回删了重建）：apitest 1 红，报出的正是 id 从 `…i04ytlpk` 变成 `…iq054x1y7`。
- **钉子必须崩溃安全**：`byName(...)` 找不到就返回 undefined，`undefined.order` 会把**整份自检崩掉**，
  后面几十条钉子一起不跑（对照 AH 第一次跑就是这样，只看到一条 TypeError，看不到失败范围）。
  改成返回 `{}` 后，对照 AH 报出**7 条**红 —— 失败范围才可见。**对照 AH**（已有卡不进合并）：selftest 7 红。
- **`mergeAppend` 直接给出 `touched`/`fresh` 两份名单**：调用方不必再按块号"猜"哪些卡被改动了
  （按块号是近似，按 kind+名字的 key 才是准的）。
- **计数**：selftest 522 → **536**，apitest 669 → **686**，uitest 955 → **964**，browser-test 402 → **409**。

**B72 研读轮·二十二（第 91 轮）**：**逐集生成分镜（批 8 补 9）**。补 8 把剧本按集存好了（`episode_number`），
这一轮顺着它把分镜也按集做完 —— 至此"原著 → 卡片 → 分集骨架 → 逐集剧本 → 逐集分镜"全链路自动化，
中间不需要人工把文本搬来搬去。三条纪律与逐集生成剧本一致：**先确认调用次数**、**失败只丢这一集**、**可取消**；
另加一条**已经有分镜的集默认跳过**（重跑一次就把同一集的分镜翻倍，是灾难性的）。
顺带把"一段脚本 → 某一集分镜"抽成共用内核 `shotsFromText(text, ep)`：单集生成与逐集生成**共用一份**提示词与
字段映射 —— 各写一份迟早会出现"单集生成 13 个字段、批量生成少两个"这种静默漂移。
门禁 selftest 522 / apitest 669 / uitest 948→955 / browser-test 395→402，全绿。

- **跳过判据必须按整部剧统计**：页面的 `rows` 只有**当前这一集**，拿它判断"其它集有没有分镜"永远得到"没有"——
  重跑就会把那些集翻倍，正好是这条功能要防的事。改成开工前拉一次全项目分镜按集计数。
  **对照 AF**（换回只看当前集）：browser-test 2 红，且报出真因（`成功 1`、`calls: 2`、镜头从 3 变 6）。
- **共用内核的代价与收益**：改 `episode_number: ep` 一行，**两条路一起变**——既有「LLM 拆镜 3 镜入库」组
  （第 77 集）立刻红。这正是想要的：一处字段映射错了，两处都藏不住。**对照 AG** 即此。
- **`notice` 没导入被棘轮当场抓住**：新写的空态提示用了 `notice()`，`uitest` 的"页面调用共享函数前必须导入"
  直接红（这类错只会表现为"点了按钮没反应"）。棘轮是有效的，别绕过它。
- **进度条与汇总 toast 是两处**：逐集结果（✓/–/✗ 第 N 集）在 `#batch-bar`，汇总（完成几集/几个镜头）在 toast。
  断言"报数了"要两处都读，只读一处会写成假钉。
- **计数**：selftest 522，apitest 669，uitest 948 → **955**，browser-test 395 → **402**。

**B71 研读轮·二十一（第 90 轮）**：**前情提要 + 逐集生成（批 8 补 8）**。分集骨架（补 4）只解决了"切几集"，
但每集剧本还是**一次一次手点**，而且每集单独生成时模型看不见前面几集 —— 人物口气、伏笔、走向各写各的，
这是长篇最常见的"越写越不像同一部戏"。本轮把两件事一起做掉：① `GET /api/story/episode-brief` 按集返回
**本集拍表 + 前情提要**（前情从本地分集骨架算，**一次模型都不调**；超预算从**最早**的一端丢，因为越近的集越相关，
丢掉的集如实上报）；② 故事脚本页新增「分集」卡：载入第 N 集大纲、勾选带前情、**逐集生成**（先确认集数范围与
调用次数 → 一集一次调用 → 生成完立刻按集落库 → 中途失败只记这一集继续走 → 可取消）。剧本记录从此带 `episode_number`。
门禁 selftest 499→522 / apitest 645→669 / uitest 936→948 / browser-test 382→394，全绿；ui-audit 零发现。

- **"连续性"唯一能证明的地方是请求体**：browser-test 直接断言**发出去的 user message** 里有「【前情提要】」与
  「第 2 集」的拍表 —— 界面上有个"已载入"的提示不等于真的发出去了（与名册那条同一套判据）。
- **`episode_number` 落库**：`POST/PUT /api/scripts` 收这个字段（坏值落回 0 = 全剧/未指定，不写 NaN 进数据），
  已保存列表按它标「第 N 集」。逐集生成才有"一集一条"可回看的基础。
- **测试造卡只能走真解析**：本项目**没有**建卡端点（卡片由解析产出），所以这一组用 `__LONGARC__` 标记
  （mock 上游会吐八拍两幕）真跑一次 `analyze` 再断言 —— 与分集骨架那组同一条路。
- **本轮踩到两个"只有真机才看得见"的坑**（都已补棘轮）：
  ① **`api.js` 是共享模块，插错一行整个壳层白屏**：我往 `storyEpisodes` 的函数体里插了一行，
  `uitest`（文本断言）与 `selftest` 全绿，**browser-test 第一条就红**（工作台渲染超时、pass=0）。
  已加"api.js 能 import"的棘轮 —— 但那只挡语法坏，挡不住下面这类。
  ② **`qs is not defined`**：api.js 里**没有** `qs` 助手（一贯用 `URLSearchParams`），我照别的文件的样子写了 `qs(q)`，
  语法合法、静态检查全过、只在运行时抛 —— 页面表现为"点了按钮没反应"，靠 `window.__uiRejects` 才定位到。
- **弹窗取值必须在弹窗还活着的时候**：`modal().then()` 在**关闭后**才 resolve，这时 DOM 已被摘掉，
  再 `querySelector('#b-from')` 只会拿到 `null` → 用户填的范围被静默丢掉、退回全量生成。改用 `onMount(root, close)`
  取值后再 settle。browser-test 专门钉了"只生成用户选的那一集"。
- **新建的项目要先重新加载页面**：壳层的 `state.projects` 是开机时那一份，用 API 现建的项目不在里面，
  路由会判"链接指向的项目不存在"并**切到别的项目**——后面所有断言都在另一个项目上跑（本轮就这么白跑了两轮调试）。
  同一条纪律的另一面：分集骨架是服务端刚变的，同页同参再设一次 hash 不会重新初始化（AGENTS.md 注意事项 8）。
- **计数**：selftest 499 → **522**，apitest 645 → **669**，uitest 936 → **948**，browser-test 382 → **394**。

**B70 研读轮·二十（第 89 轮）**：**画风写死检测 + 提示词生成的注入边界（批 8 补 7）**。上一轮把"长相不进提示词"
写进了分镜生成的系统提示，但这条边界还有两处漏：① 补图片/视频提示词那条链（**另一条 LLM 链**，跑在分镜之后、
会覆盖提示词）压根没提长相；② 画风也一样 —— 项目画风是**使用点统一注入**的，提示词里一旦写死画风词
（模型自己写的、或用户从别处粘来的），图片模型就同时收到两套风格，**改了项目画风图不会变，界面上没有任何提示**。
本轮把两处补上：体检新增 `shot_style_baked`（按**词**聚合、两档：与当前画风冲突 = 要处理 / 一致但写死了 = 可优化），
一键修复把那个词从提示词里删掉（只删词，画面描述一字不动）；补提示词那条链同时禁写死画风、长相、中文人名，
且"人物"在「出场人物」空着时用**已绑角色名**兜底。门禁 selftest 470→499 / apitest 628→645 / uitest 930→936 /
browser-test 374→382，全绿；ui-audit 4 视口 × 12 页零发现。

- **"名字进提示词"为什么也要禁**：`characterPhrase` 的既定语义是"未锁定 = 提示词里已提到角色名就跳过注入"。
  于是模型好心把中文名写进英文提示词，反而让这个镜头**丢掉外貌注入**（同一张脸换脸）。这条有检测兜底
  （`shot_char_unlocked`，批 8 补 5 就做了），但预防要在生成时就写清楚。
- **词表与画风表同源**：`lib/story.js` 的 `STYLE_WORDS` 收的是 `ART_STYLE_MAP` 的**值**（整条短语优先命中，
  删得干净）+ 通用媒介词（anime/manga/水彩/…）。selftest 有一条**跨文件棘轮**：逐条遍历 `ART_STYLE_MAP` 的值，
  任何一个词表认不出来就红 —— 画风表以后加新风格，词表不改就立刻报警。
- **只收媒介/画风词，不收画面质量词**：`cinematic`、`ultra detailed`、`8k` 是镜头内容的一部分，
  报出来只会刷屏（用户点两次就不看了）。这条有 selftest 反向钉。
- **重叠命中只留最长的一条**：`black and white manga, screentone shading` 不该同时报出 `manga`；
  但**位置不同**的两次出现要各报一条（`a manga panel, … manga` 两条）。两条都有钉。
- **正向对照 AB**（删词修复变成空操作）：selftest 4 红（整条 / 半条 / 中文词 / 逗号收拾）。
- **正向对照 AC（本轮最有价值的一条）**：把画风问题从合并后的 `issues` 里摘掉（只留在 `style_issues`）——
  第一版 apitest **全绿**。原因是我的断言全部写在 `style_issues` / `style_counts` 这些**分组字段**上，
  而界面渲染的是 `issues`：分组字段有、`issues` 里没有 → 面板上一条都不显示，测试却毫无反应。
  补上"并进 issues"的等式钉之后，对照 AC 报 `{"issues":1,"card":0,"shot":1,"style":1}`。
  **教训**：断言要落在**界面真正消费的那个字段**上；分组字段是给人看的诊断信息，不是契约。
  顺带发现这条钉**位置**也有讲究 —— 放在"确实存在画风问题"之前时 `style_issues` 是空的，等式恒成立、钉不住东西。
- **测试自身的两个坑（都在本轮踩到并修掉）**：
  ① **同页同参再设一次 hash 不会触发路由**：页面停在 `#/storyboards?project=X&episode=7`，新建镜头后再设一次
  同样的 hash，路由不动作、页面继续用旧的 `rows`（新镜头不在表里），后面点"批量补图片提示词"只会得到
  "没有需要补充的镜头"。改成 `Page.reload` 才是真的重来。已写进 `AGENTS.md` 注意事项。
  ② **静态按钮先于数据出现**：`#gen-img-prompts` 是静态 HTML，`rows` 还没加载完就点，等于空转。
  等待条件要等**行**（数据）而不是等按钮。
- **计数**：selftest 470 → **499**，apitest 628 → **645**，uitest 930 → **936**，browser-test 374 → **382**。

**B69 研读轮·十九（第 88 轮）**：**角色名册注入 + 模型自造名字的检测（批 8 补 6）**。上一轮把"镜头提到谁"变成了
结构化绑定，但**模型根本不知道项目里已经有哪些角色** —— 同一部剧里"女主/苏婉儿/婉儿/少女"混着写，
落到绑定上就是谁也匹配不上、谁都没有外貌注入（同一张脸在几十个镜头里各长一样，且不报错）。
本轮从**源头**对齐名字：生成剧本/分镜时把项目角色名册（本名 + 别名，一行长相）写进请求体，
并明确要求"用本名、不要自己另起名字、**长相不要写进 image_prompt/video_prompt**"（长相由使用点统一注入，
写两遍等于两套描述在打架）；检测侧补上 `shot_char_unknown`（「出场人物」里角色库中找不到的名字 = 这个镜头
一定没有外貌注入），既是兜底也是**名册的验收环**。门禁 selftest 443→470 / apitest 623→628 / uitest 920→930 /
browser-test 367→374，全绿；ui-audit 4 视口 × 12 页零发现。

- **为什么是"名册进提示词"而不是"生成后再纠名字"**：名字是在**最上游**被写下来的（剧本 → 分镜 → 出场人物），
  到了绑定这一步只能补救、不能纠正。名册进请求体是唯一能在源头对齐的做法，代价只有几百字符的提示词。
- **长相进提示词是负优化**（这条边界值得写下来）：让模型把"银发红瞳"写进 `image_prompt` 看起来更"详细"，
  实际是**同一段描述写了两遍** —— 使用点的 `characterPhrase` 还会再注入一次，两份不一致时出图就换脸；
  而且名字一旦出现在提示词里，未锁定的角色会被 `characterPhrase` 直接跳过（既有语义）。所以名册**只给名字**，
  长相只作为"把握人物形象"的参考，并明确禁止写进提示词。
- **验收环**：预防（名册）与检测（`shot_char_unknown`）成对。名册生效之后这一项应当一直是空的；
  apitest 里有一条"把角色建出来 → 这一项消失、同一个镜头变成「提到却没绑」"的钉子，证明体检会随数据变化，
  不是永远报同样的话。
- **泛称停用词表**：`出场人物` 里常有"两人/众人/路人/群演/旁白"这类词，全报出来会刷屏（用户点两次就不看了），
  所以有一个**短**停用词表把它们排除；`女主/男主/少女` 这类**代称不进停用词表** —— 它们恰恰是最该报的
  （十有八九就是某个已有角色的另一种叫法，报出来才知道这些镜头丢了外貌注入）。
- **正向对照 Y**（把名册拼接摘掉）：browser-test 2 红（"请求体里真的带了名册" null + "照本名写→自动绑定命中"
  `{"chars":"未知名册","ids":[]}`）。**这一轮顺手修掉了测试自身的一个脆弱点**：原来等待条件是"页面出现本名"，
  于是名册失效时先超时、真正该红的断言没机会报；改成等"分镜行出现"（与被测事实解耦）之后，
  对照 Y 报的就是那两条精确断言。还原后 374/0 全绿。
- **正向对照 AA**（停用词表失效）：selftest 4 红（分隔符口径 / 泛称不进候选 / 聚合结果 / 泛称不报）+ apitest 1 红。
- **计数**：selftest 443 → **470**，apitest 623 → **628**，uitest 920 → **930**，browser-test 367 → **374**。

**B68 研读轮·十八（第 87 轮）**：**镜头绑定自动匹配 + 镜头侧体检（批 8 补 5）**。分镜表是**模型生成的**，
它只会把"谁出场"写成自由文本（`characters`），`character_ids` / `story_card_ids` 这类结构化绑定是空的 ——
于是每个镜头都要人挨个点一遍，不点就**静默失去**外貌与场景注入（同一张脸在不同镜头里漂移，且没有任何报错）。
本轮把"名字/别名是否出现在镜头文本里"这件**可判定**的事自动化：`POST /api/storyboards/auto-bind`（干跑/落库/只吃高置信），
生成分镜后自动跑一次，分镜页另给「自动匹配绑定」按钮（先看会绑什么再决定）；体检从"卡片库"扩到"卡片库 ↔ 分镜绑定"
（`shot_char_unbound` / `shot_card_unbound` / `shot_char_unlocked`），原著页同一份报告里就能看到并按目标一键修复。
门禁 selftest 409→443 / apitest 574→623 / uitest 906→920 / browser-test 355→367，全绿；ui-audit 4 视口 × 12 页零发现。

- **两档置信度：自动化只吃高置信那档**。"可判定"不等于"永远对"——中文名字会撞普通词（"小雨"既可以是角色也可以是天气）。
  所以匹配结果分两档：名字出现在模型自己写的「出场人物」字段里 = **强**（它明确说了谁出场，可以自动落库）；
  只在画面描述/台词/旁白里出现过 = **弱**（可能撞词，默认只报给人看）。生成后的自动绑定用 `strong_only=true`，
  界面上那个按钮则把两档都列在确认弹窗里（弱的那档标"提示词推断"），人扫一眼再决定。
  名字长度 < 2 的一律不进匹配池 —— 宁可漏也不要错绑。
- **正向对照 V**（把弱匹配当成强匹配）：selftest 4 红（弱匹配口径 / weak 计数 / 强优先）+ apitest 3 红
  （"不猜"那条 + 默认模式的弱匹配计数）。还原后全绿。
- **只并集不覆盖**：自动匹配跑在"人可能已经手工绑过"的数据上，覆盖会**静默抹掉人工绑定**。
  正向对照 W（改成覆盖）：apitest 1 红（"已经手工绑过的绑定没被抹掉"），其余全绿。
- **短名被长名罩住**：文本写的是"林晚秋"，不该同时绑上"林晚"——两行名字各自独立匹配，单看一行发现不了这件事。
  实现上先收集所有出现位置，再丢掉"同位置上有更长命中"的那些（`longestAt` + `pickHit`）；同时保留
  "两个名字都真的出现时都要绑"（`林晚秋和林晚都来了` 两个都绑）。这两条都有 selftest 钉。
- **最隐蔽的一条：绑了却不会生效**。`characterPhrase` 的既定语义是"未锁定 = 提示词里已提到角色名就跳过"
  （尊重用户自己写的长相，不叠两套描述）。于是"绑了角色 + 提示词里写了角色名 + 角色没锁定" = **这个镜头不会注入外貌**，
  而界面上一切正常（徽标在、绑定在）。体检专门把这条报出来（`shot_char_unlocked`，判据与注入时用的字段一致：
  `image_prompt`/`video_prompt`，不是画面描述 —— 否则会误报英文提示词那些其实正常的镜头），
  修复动作就是"锁定该角色"（文档里写明的唯一出口），并说明"锁了就是每个镜头都逐字注入"。
- **按目标聚合而不是按镜头逐条报**：一个角色漏绑往往是十几个镜头一起漏，逐镜头报会在面板里刷一屏同样的话
  （用户点两次就再也不看了）。聚成"角色「林晚」有 12 个镜头提到但没绑定"，一次修复把 12 个镜头一起绑上，
  并带上镜头号明细供确认弹窗展示。
- **问题码 ≠ 修复动作码（浏览器契约测试抓到的真 bug）**：体检项的 `code` 是问题码（`shot_char_unbound`），
  修复动作是另一个码（`bind_shot_target`）。第一版界面把 `it.code` 当修复码发给后端 —— 按钮点下去必然 400，
  而 uitest 的源码级钉（钉的是文案表与请求体字段）**全是绿的**。是 browser-test 的"点了要有反应"契约抓出来的。
  现在 `fixable` 保持布尔（与卡片侧同口径，界面按它算"可一键修复"数），动作码另放 `fix_code`，并补了源码级钉。
- **按目标修复而不是"能匹配的都绑上"**：一次点击只做一个明确动作（只绑 `target_id` 这一个角色到 `shot_ids` 这些镜头），
  否则用户刚点的是"修林晚"，结果顺手绑上了顾寒，看预览时会莫名其妙。
- **计数**：selftest 409 → **443**，apitest 574 → **623**，uitest 906 → **920**，browser-test 355 → **367**。

**B67 研读轮·十七（第 86 轮）**：**剧情卡 → 分集大纲骨架（批 8 补 4）**。原著解析已经把长篇拆成了六类卡片，
其中**剧情卡带幕次（起/承/转/合）与拍级字段（冲突/转折/结果/涉及人物）**，时间线卡带时间点 —— 但这条结构信息
此前只被当成"一段可复制的文本"整包塞进剧本变量。本轮把它用起来：`GET /api/story/episodes` 把剧情卡按**原文出现顺序**
排成拍子、按幕次收口**切成集**，生成一份可直接改的分集大纲骨架（含全剧设定 + 全剧时间线 + 每集拍表 + 切分说明），
原著页卡片工作台加「分集大纲」面板（可反复调"每集至少几拍"），并新增 `outline=<每拍数>` 这条带入剧本的载荷。
门禁 selftest 363→409 / apitest 545→574 / uitest 893→906 / browser-test 344→355，全绿；ui-audit 4 视口 × 12 页零发现。

- **切集这件事刻意不交给模型**：这是本轮最重要的设计决定。"哪几拍算一集"是**可判定**的（拍数下限 + 幕次收口），
  不是创作判断。交给模型有三个具体坏处：① 同一份卡片两次切出不同集数，用户就没法拿它当骨架改；
  ② 分集要反复调（每集 4 拍还是 6 拍），**每次调都花钱的工具用户不会用**；③ 模型会顺手"补"出卡片里没有的剧情。
  所以切分是纯本地纯函数，真正需要 AI 的那一步（把这些拍**写成剧本**）照旧在故事脚本页走生成，带计费闸门。
  这条承诺用两层钉锁死：apitest 数 `storyChatCalls`（等一拍再数）、uitest 抠 handler 函数体断言不含模型调用。
- **切分规则可复现、可解释**（`lib/story.js` 的 `planEpisodes`）：① 拍序 = 剧情卡的 `order`（首次出现在原文的位置），
  **不改写原文顺序**；② `perEpisode` 是**下限**，攒够下限后优先在"合"或"下一拍是起"处收口（**不拆幕**）；
  ③ 硬上限 = 下限 ×2，单幕过长时必须强行切开，否则分集等于没分（`forced_cuts` 如实上报）；
  ④ 一张卡都没标幕次时退化为纯计数切分（`basis='count'`）并写明原因。
  UI 上把输入框标成「每集**至少** N 拍」而不是「每集 N 拍」—— 因为按幕收口会给出 5、7 这种"多于下限"的结果，
  标成"每集 N 拍"就是骗人。面板上写明"幕次覆盖 8/8"与"切分优先落在合/起处"，让结果可解释而不是玄学。
- **正向对照 R**（把幕次收口改成 `false`）：selftest 3 红（"收在幕边界上 4,4"、"每集不低于下限"、"没有硬切"）
  + apitest 3 红（含"拍序按原文出现顺序"—— 取消收口后硬切把两幕混进同一集，顺序钉一起红）。还原后全绿。
- **"不花钱"必须有正向对照，不能只写注释**：本轮 apitest 的对照是 R（纯函数层），
  而"端点不调模型"这条本身由 uitest 的 handler 函数体钉 + apitest 的调用计数钉双重覆盖（同批 8 补 3 的纪律）。
- **带入剧本复用同一条链路而不是新开一条**：`scripts.js` 的 `applyBible` 原本只认 `bible=<来源>&kinds=<类别>`，
  现在多认一个 `outline=<每拍数>`：走 `api.storyEpisodes` 取骨架文本，落位仍用同一个 `pickBibleVar`
  （传 `['plot']` → 命中 `BIBLE_VAR_KINDS` 里的「本集大纲 / 剧情梗概」）。这样"可见可撤销的上游提示条""落位失败要明说"
  这些既有纪律自动继承，不用在新入口重写一遍。**正向对照 T**：带入时不传 `outline` → browser-test 精确 3 红
  （"骨架落到本集大纲"、"落进去的是拍级骨架"、"带切分说明"），证明这条链是真端到端。
- **`icon('list')` 差点又静默变图标**：`consts.js` 的 `icon()` 对不认识的图标名**回落到 info 图标**（不报错、不白屏）。
  本轮写 `icon('list')`（不存在）时正好没跑 uitest，随后自查才发现。uitest 里**早就有**"图标 X 已定义"这条棘轮
  （对照 S：改成 `gridx` → 1 红），我一度又写了一条逐文件比对的重复棘轮，发现重复后删掉并留注释说明 ——
  **同一件事不要钉两遍**（重复钉只增加维护成本，不增加覆盖）。
- **ui-audit 的第二个内联面板**：分集骨架面板与体检面板在同一页，钩子新增 `box` 选项指定"看哪个容器有没有字"，
  否则两个面板会互相替对方"证明有产出"。种子补了 4 张剧情卡（四拍切成一集，能顺带量到拍行与幕次标签），
  4 视口 × 12 页 0 条发现。**正向对照 U**：把 `box` 指向不存在的容器 → 4 视口各报一条"内联动作无产出"。
- **`docs/research/09-story-bible-plan.md` 路线图**：8 补 4 由"信息卡/剧情卡在剧本侧自动注入"细化为**分集大纲骨架**并完成；
  知识图谱重建顺延为 8 补 5（按批分轮，代价与做法见 `AGENTS.md`）。
- **计数**：selftest 363 → **409**，apitest 545 → **574**，uitest 893 → **906**，browser-test 344 → **355**。

**B66 研读轮·十六（第 85 轮）**：**卡片一致性体检（批 8 补 3）**。原著解析能产出六类卡片，但"卡片库本身健不健康"
此前**没有任何检查手段**：同一角色从两份原著里各抽一张、别名撞到别人的名字、地点卡一个可注入字段都没有、
人物卡还没进资产库……这些都会安静地毁掉下游一致性（重复注入、张冠李戴、"绑了卡却什么也没变"）。
本轮加一条**纯本地**的体检链：`GET /api/story/audit` 出报告 + `POST /api/story/audit/fix` 一键收敛，
原著页卡片工作台加「一致性体检」入口与报告面板。门禁 selftest 318→363 / apitest 509→545 / uitest 874→890 /
browser-test 332→344，全绿；ui-audit 4 视口 × 11 页零发现。

- **为什么刻意不调模型**：体检的每一条都是**可判定的事实**（同名、缺字段、别名撞名、没入库），不是主观判断。
  交给模型只会带来"同一份数据两次体检结论不同"，用户就再也不敢信这份报告；而且**花钱才能查一致性的工具，
  用户会不敢点**。这条承诺用两层钉锁死：apitest 在体检前后数 `storyChatCalls`（等一拍再数，避免只证明"没有同步调用"），
  uitest 用 `bodyAt` 抠出两个 handler 的函数体断言里面**不出现任何模型调用**。
- **需要人拍板的一律不替用户决定**：同名卡合并时"更详细的描述取胜"会丢掉另一种说法，所以报告**如实列出冲突字段的
  两个值**（`conflicts`），前端在确认弹窗里再提示一次"有 N 个字段存在不同说法，合并后只保留更详细的那个"。
- **一键修复只做三件机械且可解释的事**：合并同名卡 / 删掉撞名别名 / 人物卡入资产库。缺字段（没有外貌、没有幕次、
  没有时间点）**不**算可修复 —— 那需要人补内容，`counts.fixable` 也不把它们算进去（有钉）。
- **合并最危险的地方是引用**：分镜的 `story_card_ids` 指向被删的卡，合并不改指的话镜头会**静默失去场景/道具注入**
  （界面显示"已绑定"，出图却没带设定）。所以合并时同步把绑定改指到存活卡并去重，`repointed_shots` 如实上报。
  正向对照 P：删掉改指那段循环 → apitest 精确 2 红（"改指存活卡" + "改指镜头数"），其余全绿。
- **体检范围是项目级而不是当前来源**：同名卡最常见的形态就是"同一个角色从两份原著里各抽一张"，只看当前这份
  永远看不见它；修复也是项目级的，报告范围与修复范围必须一致（面板里写明"范围是整个项目"）。
- **本轮最值钱的发现：一个从批 8 下就坏着的按钮**。`ui.js` 的 `dataOf` 是**字面**取属性（`data-` + name），
  而卡片删除按钮渲染的是 `data-del-card`、处理器读的却是 `'delCard'` → `getAttribute('data-delCard')` 恒为 `null`，
  于是**点两次也删不掉，还不报错**（只弹一条 404 的 toast）。体检的修复按钮第一版又犯了同一个错（`'auditFix'`/`'fixIdx'`）。
  已修 3 处，并在 uitest 加**通用棘轮**：逐页比对"每个 `dataOf` 读的名字都被渲染过"（全仓扫一遍只有 novel.js 有 3 处，
  其余页面干净）。补上真机契约：第一击进待确认态、第二击真删掉、后端列表条数 -1。
- **两处测试自身的假绿/假红（都是"读到了过期结论"）**：
  ① 重跑体检前不收起旧报告，`waitFor` 会**立刻**匹配到上一次的面板文本 → 读到过期结论（第一版就此假绿）；
  ② 合并后的等待条件用宽泛的 `/有 2 张/`，而项目里还有**另一组**同名卡（两个来源的人物卡）→ 永远等不到（超时）。
  两处都改成盯**具体那一组**并先收起旧面板。
- **另一处盲钉**：`GET /api/story/cards/:id` 这个端点**根本不存在**（本项目只有列表与 PUT/DELETE），
  第一版用它查"别名删没删"，拿到的一直是 404 响应体 —— `!(undefined||[]).includes(...)` 恒真、"被合并的卡真删了"
  断言 `status===404` 恒真。已全部改走列表 `find`，并在注释里写明这个坑（AGENTS.md 的"响应形状"注意事项同族）。
- **ui-audit 补上"内联面板动作"**：此前只有"开弹窗"一种钩子，而体检报告是**内联面板**，它的布局（变长标题 +
  徽标 + 修复按钮三列）在 4 个视口下是盲区。钩子现支持 `{requireModal:false}`：不等弹窗，但要求"面板里真的有字"，
  否则报一条"内联动作无产出"（**对照 Q**：把入口选择器改坏 → 4 视口各报一条）。种子同时塞三张卡，让面板落在
  "要处理 + 可优化 + 可修复 + 不可修复"四种行都有的真实密度上。4 视口 × 11 页仍 0 条度量发现。
- **计数**：selftest 318 → **363**，apitest 509 → **545**，uitest 874 → **893**，browser-test 332 → **344**。

**B65 研读轮·十五（第 84 轮）**：**原著卡片 → 分镜提示词注入（批 8 补 2）**。把六类卡片里"画面上看得见"的两类
（**地点卡 / 道具卡**）接进分镜的使用点注入链：分镜行可绑卡，出图/出视频时统一拼进提示词，
**跨镜头场景与道具不再各写各的**。门禁 selftest 302→318 / apitest 482→509 / uitest 860→874 / browser-test 321→332，全绿。

- **为什么只注入两类**：人物卡走角色库那条路（有参考图、有 `is_locked` 锁定语义、要和分镜行绑定），
  信息卡/剧情卡/时间线是给编剧看的**全局**设定 —— 逐镜注入只会稀释画面描述、白烧配额。
  这条边界用两条钉锁死：`Object.keys(STORY_CARD_INJECT_FIELDS).join(',') === 'location,prop'`
  （新增类别必须显式决策，不许默认注入）+ 逐类别的"不在注入范围"断言。
- **注入链顺序固定**：内容 → **原著场景道具** → 角色 → 运镜 → 画风 → 变体。与 `finalPrompt` 既有分层一致，
  前端 `storyCardPhrase` 是**逐字同构**的镜像（uitest 去空白比对），所以分镜页 tooltip 里的"实际发出"不是估算。
- **绑定 id 而不是复制文本**：卡片描述改了，所有绑定它的镜头下次出图自动带上新描述 —— 这才是一致性的来源。
  apitest 有专门一条钉：改卡片 atmosphere 后再出图，提示词里必须是新描述。
- **写入时就按白名单过滤**（`injectableCardIds`，与 `camera_move` 同一纪律）：绑一张人物卡不该
  "存下来、界面显示已绑定、出图却永远不生效"。注入点仍会再过滤一次（卡片可能事后被删或改了类别），两层都要有。
- **导出不骗人**：CSV 新增「绑定原著卡片」列、最终词含注入；MD 口径改成"原著场景道具、出场角色、运镜与画风"，
  并说明 i2v **仍会注入原著场景道具**（参考图带的是画面，带不了文字设定）。
- **实测抓到的 3 个问题**：
  ① **测试原文太短**：`max_chars=200` 时全文只有 270 字，尾块合并把整篇并成 1 块，而 mock 只在第 2 段吐道具卡 ——
     "道具注入"整条**没被跑到**却全绿（与 B62 的同类坑一模一样，同一个作者又踩了一次：切块参数的组合效应）。
  ② **改字符串改错了地方**：用脚本替换 `const name = String(c.name || '')` 时命中了 `characterPhrase` 而不是
     `storyCardPhrase`，把**既有**的角色注入同构钉弄红 —— 恰好证明那三条同构钉是真敏感的（有机正向对照）。
  ③ **注释破坏同构**：`storyCardLook` 函数体里写了注释，去空白比对不等 → 把注释移到函数外。
     同构钉按"去空白逐字"比，函数体内不能有注释，这一点已写进代码注释里免得下次再踩。
- **ui-audit 抓到 1 个真布局缺陷**：批 8 补加的「复制回注 / 带入剧本」两个按钮让卡片工作台工具栏
  在 900px 与 1024px **横向溢出**（`#nov-import w=106`）。改用 `.row.wrap` 换行后 0 条度量发现；
  并加钉锁住修法（ui-audit 不是门禁，没人跑就没人拦）。
- **正向对照 3 组**：去掉 `+场景` 徽标 → browser-test 1 红（红的正是那一条）；
  `finalPrompt` 不再注入 → apitest 8 红（selftest 仍绿 —— 纯函数钉与接线钉的分工就该如此）；
  写入不按类别过滤 → apitest 1 红。

**B64 研读轮·十四（第 83 轮）**：**原著 → 剧本一键带入（批 8 补）**。把"复制回注文本 → 切到故事脚本 →
找到字段 → 粘贴"四步压成一步：原著解析页点「带入剧本」→ 跳 `#/scripts?tab=episode_script&bible=<source_id>&kinds=...`
→ 故事脚本页把卡片文本落进**合适的模板变量**并显示既有的"已带入"提示条（可见、可撤销）。
门禁 selftest 302 / apitest 482 / uitest 845→**860** / browser-test 314→**321**，全绿。

- **落位规则（`pickBibleVar`，纯函数，7 条钉直接断言）**：① 变量名匹配且当前为空 → ② 名字匹配（覆盖）→
  ③ 第一个空着的长文本框（兜底，提示条会说明"没有专门的原著字段"）→ ④ 都没有则返回 `null`，
  **调用方必须明确告知用户没落位**，不许静默丢掉已取出的卡片文本。变量名归一化吃掉"卡/设定/信息/列表"后缀，
  所以 `{{人物卡}}`、`{{人物设定}}`、`{{人物}}` 等价；`{{本集大纲}}`/`{{剧情梗概}}` 归到 plot+world。
- **为什么按变量名匹配而不是按位置**：模板是**用户可编辑的资产**（设置页能改名改内容），位置会变、名字相对稳定；
  按位置落位会在用户调整模板后静默落错字段。
- **参数走 hash 而不是共享内存**：可刷新、可分享、可回退——app.js 的路由本来就读这些参数；
  消费后立刻 `syncViewParams({bible:'',kinds:''})` 抹掉，避免刷新时重复带入覆盖用户后来的修改。
- **顺手修掉一处真缺陷**：`renderUpstream` 的「撤销带入」原本是 `fields.set(field, '')` —— **一律清空**。
  页内带入（上一步产物刚写进去）时这没问题，但跨页带入可能覆盖用户**已经写好的**字段，清空等于把他的内容删了。
  已改为还原成带入前的值（`upstream.prev`），并加钉。
- **另一处死代码**：novel.js 注册了 `[data-copy]` 处理器却**没有任何按钮渲染它**（批 8 下漏了工具栏按钮）。
  已补上「复制回注」按钮，并把"处理器有、按钮没有"这类漏渲染加进 uitest 断言（`!data-copy` 且 `id="nov-copy"` 存在）。
- **正向对照 2 组**：① 落位函数永远返回 `null` → uitest 2 红（**browser-test 0 红**，因为兜底路径仍会把文本落进
  同一个字段——这恰好说明两条路径都是合法行为，行为层钉测的是"落没落进变量"，路径区分交给纯函数钉）；
  ② 带入不真的写进字段 → browser-test 1 红，且红的正是"带入后模板变量里就是卡片文本"这一条。
- **端到端行为契约**（browser-test 新增一组，自带 mock 上游）：真解析出一份卡片 → 深链 `#/novel?...&source_id=`
  显示卡片 → 点「带入剧本」→ 落到 `#/scripts` 且 `#fields textarea` 里就是卡片文本 → 提示条说明来源与落点 →
  URL 里的 `bible=` 已被抹掉 → 撤销带入后字段还原为空。收尾还原 settings 并删掉探针原著，不污染后续组。

**B63 研读轮·十三（第 82 轮）**：**原著解析页（批 8 下）**。新增 `public/js/pages/novel.js`（原著解析工作台）、
`public/js/storyfile.js`（本地文件读取 + 文本规范化纯函数层）、`consts.js` 的六类卡片表、`api.js` 的 11 个 story 方法、
导航项「原著解析」（紧跟故事脚本），并在 `tools/browser-test.mjs` 补一组**行为级**付费闸门契约。
门禁 selftest 302 / apitest 482 / uitest 731→**845** / browser-test 296→**314**，全绿。

- **页面做成了独立页而不是故事脚本页的第 6 个页签**：`scripts.js` 的整个结构是"一个页签 = 一个模板 → 填变量 → 生成"，
  而解析工作台是"长文输入 + 六类卡片分组 + 就地编辑 + 反向驱动"，交互模型根本不同。
  塞进 `SCRIPT_TYPES` 需要在 `tplOf/renderFields/syncCounters/stepNo/generate/carryToNext` 等近十处特判，
  属于典型的高耦合改造；独立页则对 `scripts.js` **零改动**（731 条既有钉全不受影响）。
- **干跑 → 确认 → 解析**三步（沿用批 7 的计费安全纪律）：`先算一算` 走 `/api/story/plan`（纯本地切块，
  **一次模型都不调**）给出"分 N 段 / 调用模型 N+1 次 / 覆盖 X/Y 字"；`开始解析` 再弹 `costConfirm`。
  没干跑过就直接点解析时会先补一次干跑——不许拿旧数字给新原文背书（改原文即作废上次结论）。
- **原文落库 + 载回输入框**：对着 04 号包"全包零持久化、刷新即丢 1 万字"的缺陷做的。
  解析记录列表显示"字数 / 段数 / 卡片数 / 时间 / 状态"，`载入原文` 一键回到输入框改完重解析。
- **卡片工作台**：六类分组带计数、就地编辑（名字/摘要 + 各类业务字段 + 别名）、就地两击删除、
  人物卡一键入资产库、任意类别一键复制回注文本（渲染由服务端 `cardsToPrompt` 出，前端不重复实现）。
- **文件读取不做服务器上传**：`.txt/.md` 用 `file.text()` 在浏览器本地读，`checkStoryFile` 只收这三种扩展名、
  拒空文件、拒 >20MB，Word/PDF 明确回"请先另存为 txt"。
- **三个真问题（都是本轮实测抓到的，已修）**：
  ① **页面白屏且零报错**：`novel.js` 一开始写成 `export default async function novel(params)` 并自建容器
     （`document.createElement('div')` + `className='page'`），而 router 是 `nav.page(page, params)` ——
     首参是**已挂进文档的容器**，自建的那个永远不在 DOM 里。表现是"切过去白屏、控制台一句错都没有"，
     浏览器测试只报"等待超时"。**已加 uitest 棘轮**：页面首参必须是 `container`，且不得自建 `.page` 容器。
  ② **`ui.js` 的 `on()` 只传事件对象**（`addEventListener` 直通），我按 `(e, el)` 写了一批委托处理器，
     `el` 恒为 `undefined` —— 一点就 `Cannot read properties of undefined`。已全改为 `e.currentTarget`。
  ③ **跨组污染**：为验证"第一次必弹费用确认"，我的浏览器测试组清掉了当天免打扰票据却**没有还回去**，
     导致后面的 E2E 组点出图被弹窗拦住、超时变红。已在组尾把票据写回（并留注释说明为什么必须还）。
- **正向对照 4 组**（改坏 → 变红 → 还原 → 复绿）：前端类别表多一类（uitest 1 红）、
  api.js 端点路径拼错（uitest 3 红）、空态漏 CTA（uitest 1 红，这条在开发中**真实**拦下过我 3 个空态）、
  **绕过 `costConfirm`**（uitest **0 红**、browser-test 4 红）。最后一条最有价值：
  `const go = true || await costConfirm(...)` 这种绕过，源码级棘轮（只查"有没有调用"）**抓不到**，
  只有行为层"点了必须弹窗"才抓得到 —— 这也是本项目"源级棘轮 + 真机行为契约"两层都要有的实证。
- 另：正向对照还发现 `/api/story/plan` 的计费钉原本是**假钉**（详见 B62）与"测试原文太短导致跨块合并未被跑到"，
  两处都已在 B62 记录。

**B62 研读轮·十二（第 81 轮）**：**原著解析内核（批 8 上）**。新增 `lib/story.js` 纯函数层 + `story_sources` /
`story_cards` 两张表 + `novel_extract`/`story_bible` 两个提示词模板 + `/api/story/*` 十二个端点。
门禁 selftest 209→**302** / apitest 368→**482**（uitest 731、browser-test 296 未动），全绿。

- **为什么做**：目标是"故事脚本页粘贴/上传小说 → 彻底解析 → 反向推动剧本/资产/分镜"。
  五个参考包**没有一个**实现了地点卡/道具卡/剧情卡：04 号包只抽 `characters[{name,identity}]` + `mainPlot`
  两个字段、只调一次模型、原文**截断到 1 万字**，且全包零草稿持久化（刷新即全丢）。
  批 8 把这条链往前推一整步：六类卡片、分块 map + 全局 reduce、覆盖字数如实上报、原文落库。
- **两条硬不变量（都有等式钉）**：① `covered_chars === total_chars` 当且仅当未截断 ——
  为此每个块**自带尾随分隔符**，装块时不再插 `\n`（第一版插了，跨块丢掉的换行让等式失效，
  被 selftest 当场抓住）；② 超 `max_chunks` 时 `truncated=true` 且 `covered < total`，前端据此警告。
- **机械判断一律不给模型**：切块、卡片规范化（类型/字段白名单 + 长度上限）、跨块去重合并、
  回注渲染全部在 `lib/story.js`。让模型去重的话，同一份输入两次运行会得到不同卡片集，
  用户改过的卡会在下次解析后复活 —— 这属于"必须可复现"的判断。
- **正向对照 6 组全过**（改坏 → 变红 → 还原 → 复绿）：块不带分隔符（selftest 2 红）、
  合并不再取更长描述（1 红）、归并改成叠加（apitest 4 红）、人物卡入资产库不再幂等（4 红）、
  坏块拖垮整篇（5 红）、干跑偷偷调模型（1 红）。
- **对照过程中抓到两个真问题（都已修）**：
  ① **计费钉本来是假钉**：`/api/story/plan` 是同步 handler，**不可能** `await` 调模型，
  所以"调用后立刻数上游调用次数"只能证明"没有同步调用"——而那是它做不到的事，等于什么都没证明。
  加上 `sleep(400)` 之后，对照 F（把 plan 改成忘了 await 的偷偷调用）才真的能抓到（计数 6→7）。
  **教训：一条钉要能通过"把它要防的事真的做出来"来验证，否则只是心理安慰。**
  ② **测试原文太短导致最关键的契约没被跑到**：原文只有 236 字，`minChars=400` 的尾块合并把整篇并成
  **1 块**，于是"跨块去重合并"（`mentions>=2` / `evidence.length>=2`）两条钉静默失败，
  而"人物卡 2 张""地点卡 1 张"这些**在单块下也成立**的钉照常全绿 —— 差点带着一个没被验证的核心契约提交。
  加长到 834 字（五幕 × 三段）后真正切出 4 块。**教训：测试数据必须大到能触发被测路径，
  "数量对得上"不等于"路径跑到了"。**
- **边界（明确不做）**：不做服务器端文件上传（`.txt`/`.md` 在浏览器 `FileReader` 读成文本即可，
  多一条上传通路 = 多一个外部可写入入口，与 X2 纪律冲突）；不做 `.docx`/`.pdf` 解析（数量级不同的依赖，
  与零 npm 依赖冲突）；不做向量检索/RAG（需 embedding 服务与向量库，与本地优先冲突）；
  **不自动导入资产库**（人物卡 → 角色是用户的显式动作，自动建角色会在重解析后制造重复且无撤销入口）。
- 设计与竞品对照见 `docs/research/09-story-bible-plan.md`；前端「原著解析」页签与
  uitest/browser-test 契约钉列为批 8 下。

**B61 研读轮·十一（第 80 轮）**：**知识图谱重建（唯一挂账的技术债，已清）**。锚点 `ef8834d` → `d268a0d`，
覆盖 **47 → 55 个文件**（新增 `public/js/textstats.js`、`public/js/pages/characters.js`、`tools/port-check.mjs`
与 `docs/research/08-src-0{0..5}` 六篇研读文档），图谱从 **196 节点 / 605 边** 长到 **278 节点 / 1076 边**，
9 层 15 步导览全部重跑，全部文本中文。

- **扫描边界显式化**：往 `.understandignore` 补了「工具自身生成物」排除项（`knowledge-graph.json` /
  `fingerprints.json` / `meta.json` / `intermediate/` / `tmp/` / `.trash-*`）。这些是**被分析对象的产物**，
  光 `knowledge-graph.json` 就 7794 行、`fingerprints.json` 3000 行——送进 LLM 分析纯属浪费且会污染图谱。
  同时保留 `.understandignore` 与 `config.json`（它们是配置事实，且曾是图谱里仅有的两个孤立节点）。
- **本仓库的图谱有两条"工具盲区"，必须人工补**（已写进 `AGENTS.md` 注意事项与更新流程）：
  ① **`tested_by` 会被合并脚本全部丢掉**：`merge-batch-graphs.py` 的 `is_test_path()` 对 JS 只认 stem 以
  `.test`/`.spec` 结尾，而本项目测试在 `tools/` 下叫 `selftest/apitest/uitest/browser-test` → 19 条候选
  全被判成"生产↔生产"丢弃，且路径约定补链一条也补不出来（测试节点集合为空）。本轮按**源码证据**
  逐对复核后补回 **22 条**（证据 = 测试脚本正文里出现被测算文件的完整相对路径或唯一 basename；
  `uitest.mjs` 用 `readdirSync('public/js/pages')` 动态列举并逐文件断言，故 10 个页面文件都算被覆盖），
  是旧图 7 条的**超集**（旧 7 条 7/7 都在）。踩过的坑：第一版复核脚本把边界字符类写成 `[^\w./-]`，
  于是 `public/css/app.css`、`./consts.js` 这类路径形态全部匹配不到，误剔了 10 对——边界只该排除
  `\w` 与 `-`。另一个坑：**补边之后又跑了一次合并脚本**，22 条被覆盖清零，只能重补（已写进注意事项）。
  ② **CJS 依赖不在 `imports` 边里**：`server.js`/`lib/*.js`/`tools/selftest.mjs` 用 `require()`（SEA 兼容），
  70 条 `imports` 边**全部**落在 `public/js` 内部；后端真实依赖靠子代理读源补成 `depends_on`/`calls`。
  分层时也因此踩到"顶层目录分组无区分度"（public/lib/tools 之间的 inter-group 依赖为 0），
  架构子代理改用文件摘要 + `imports + depends_on` 合并依赖矩阵才分出正确的 9 层。
- **审查阶段真抓到一个缺节点**：`lib/store.js:onWriteError` 真实存在（定义 `:91`、导出 `:519`、
  `server.js:115` 调用，是 B4 写盘失败上报的钩子），但分析子代理漏产该节点，导致
  `server.js → onWriteError` 的 calls 边成悬挂被丢。审查子代理补回节点 + contains/exports/calls 三条边
  （277/1051 → 278/1076，其中 1051→1073 是本轮补的 22 条 tested_by）。同类漏产还有 `lib/store.js` 的
  另外 8 个顶层函数（`failWrite`/`rescueFile`/`home`/`assetsDir`/`imagesDir`/`exportsDir`/`persistSettings`/
  `assertColl`），但它们**没有任何边引用**、不产生悬挂，属"符号覆盖粒度"取舍，未补（记为已知边界）。
- **校验结果（全过）**：55/55 文件级节点有且只有一个层归属、0 重复；`imports` 70 条与确定性 importMap
  逐条一致（双向差集为空）；0 悬挂边、0 重复节点、0 孤立节点（上一版记为"仅有的两个孤立节点"的
  `.understandignore`/`config.json` 现在各有 `related` 互链与来自 `AGENTS.md` 的 `documents` 边）；
  `tour` 15 步 0 悬挂；竞品源码包路径未泄漏进图（5 个 Vibex 包只以 `docs/research/08-src-0*.md` 文档形式存在）。
  语义边抽检通过率 >95%，无捏造。
- **流程改进（已写进 `AGENTS.md`）**：批 7 这类"20 个孤儿文件挤成一批"的 misc 批（CJS 文件没有
  `imports` 边 → 全被当孤儿合并）要按体积手工拆成 `batch-<N>-part-<k>.json` 分派，否则单个子代理读不完
  `lib/routes.js` + 四个上千行测试脚本；分派前要先生成好各批的 `tmp/ua-file-extract-results-<批号>.json`。
- **同步文档**：`AGENTS.md` 的快照锚点、节点/边/层计数表、层文件数表、注意事项 2/3 与更新流程第 5 条全部
  按新图改写；`docs/knowledge-graph/`（手工讲解图 73 节点）本轮**未改动**，无需重跑 `build-graph-data.mjs`。

**B60 研读轮·十（第 79 轮）**：**批 7 收尾：计费安全与数据效率（R25–R30）**。
- **R25 提交幂等（本批最值钱的一条）**：视频是**提交即计费、不可撤销**的，而原来只有"页面布尔锁 +
  按钮禁用"两道客户端防线——客户端超时（api.js 给到 600s）或连接中断时，服务端很可能已经接单，
  用户再点一次就是两份账单。B2 已经堵了"自动重试"那条口子，这次堵的是**人工重提**。
  服务端按 `client_token` 查 10 分钟窗口内的既有记录，命中直接返回原 asset 并标 `deduped: true`，
  **不再向上游下单**（apitest 用"上游请求计数"证明这一点——只看响应形状证明不了没花钱）。
  窗口 10 分钟是取舍：短了挡不住"看到超时提示、去喝杯水回来再点"，长了会把"我就是想再要一条一样的"
  误判成重复。
- **R25 的两个关键判断**：① **只对"可能已经花钱"的记录去重**——`submit_failed`（确认没提交成功）
  必须放行，否则一次失败会把用户永久锁在"复现那条失败记录"里；`submit_timeout_unknown` 恰恰最需要
  去重（结果未知 = 可能已计费）。② **token 的复用规则是前端的事**：每次新生成 = 服务端查重形同虚设，
  永远复用 = "再来一条"被吞掉。落地为共享工具 `makeTokenStore()`：**参数指纹没变的重试复用、参数一变
  立刻换新、提交成功作废**。批量视频按镜头 id 分 scope，每镜一个键。
- **R26 只做时长校验，上传通路明确不立项**：研读结论已写明——Agnes 抓不到 `127.0.0.1`，本地版做上传
  通路等于做一个必然不通的功能（这正是 `videos.js` 早已拦截本地路径的原因）。所以只取"前置时长校验"，
  而且我们这里的真实缺陷比竞品更具体：`secondsToFrames` 会把时长**量化到 8n+1 帧并夹进 [81,441]**，
  用户填 30 秒、实际提交 18.38 秒，**全程没有任何地方告诉他**，他按 30 秒的预期去等成片。
  现在：① 分镜弹窗时长输入框带 min/max/step + **实时显示实际提交秒数**（超限时用琥珀色说清上限）；
  ② 批量提交前先弹出偏差清单（在付费确认**之前**），让用户自己决定改还是继续；③ 服务端钳制结果经
  `clamps` 如实回报，不再静默夹参数（"钳制不许静默"写进了变更须知）。
- **R27 费用留痕：null ≠ 0**。上游是否返回费用字段**未确认**，所以做的是"有就存、没有就 null"：
  `extractCost()` 只扫顶层与 `usage`/`data` 两层（深层随便一个 `amount` 都可能是别的含义），
  点数优先于金额，`null` = 未知、`0` = 上游明确说免费，**绝不互相顶替**——竞品正因为
  `estimatedPrice=0` 的语义模糊不得不写降级文案，我们不去继承这个歧义。界面只在有值时显示"消耗 N 点"。
  另一条纪律：**费用字段不进 PUT 白名单**（它是上游回报的事实，不该由界面改写，否则"我的账目"可以
  随便被改成 0）；测试走 `/api/import` 备份恢复通路灌数据。
- **R28 补的是"出口"，不是分类**：分类层（`ERROR_HINTS` + `formatError` 只补充不替换）在更早的批次
  已经做完了，本批补的是**不同错误给不同下一步**——`errBox` 此前只有"重试加载"一个出口，而
  `no_api_key` 重试一万次也还是没 Key。新增 `ERR_OUTLETS` 表（Key 类 → 设置页 API 分节；模型类 →
  模型配置；审核类 → 换个措辞再试），视频诊断面板复用**同一张表**（不另写一份）；未识别类型保持原样
  （只有重试），不猜。原文与追踪码一律保留。
- **R29 服务端计数**：项目页原来为了显示三个整数要**额外并发拉三个全量列表**再在客户端聚合——
  传输量随素材总数线性增长（每条还带着长提示词、URL、原始响应）。现在 `?with_counts=1` 由服务端聚合。
  两条纪律：**可选参数**（不带参数时响应逐字节不变，老脚本/直接调用者不受影响）+ 前端**保留退回三拉
  的兼容分支**（服务端没给 counts 时只是慢，不能因此不显示计数）。
- **R30 变更须知**：把每批的风险结论固化成单行 `// 变更须知：…`（8 处高风险接缝：去重语义、静默钳制、
  null/0、逐项状态预填、token 复用规则、出口只补充、计数兼容分支、时长量化），并加**断言兜底**
  （uitest 逐条检查关键词 + 数量下限）——比竞品"纯散文注释"多一层：注释被删会被门禁抓住。
- **测试自省（这轮抓到两个假绿/假红的坑）**：
  ① **"保存后不重渲染"的证据不能是勾选状态**（批 6 已记）之外，本批又踩到**"等元素出现 ≠ 内容已渲染"**：
     任务页先渲染一排空 `.task-row`（skeleton），只等元素出现会读到空 `innerText` → R27 断言偶发失败
     （第一次跑出 `rowCount:31` 但前 3 行文本全空）。改为等**内容**出现，并把行文本打进失败信息，
     连续 3 次 browser-test 全绿（296/296/296）。
  ② **清理的正确含义是"还原成原样"**：付费确认的"当天免打扰"键，第一版在分组收尾直接 `removeItem`，
     结果后面「失败恢复契约」分组靠这个键跳过付费确认弹窗，键没了就永远等不到 busy 态——3 条断言全红。
     改成先存原值再还原。同一轮还发现 fetch 打桩没留底、`window.fetch` 没还原导致后续分组走假网络。
- **计数**：selftest 195 → **209**，apitest 336 → **368**，uitest 696 → **731**，browser-test 278 → **296**。
  门禁全绿；ui-audit 4 视口 × 10 页（28 次弹窗度量）零发现；port-check 6/6；真机几何复查确认
  时长提示（11.5px、超限/合法两种文案、390px 下折行不溢出）、费用徽标、错误出口按钮（125×32）可见可读。
- **正向对照（6 条，全部精确命中）**：幂等查重永不命中 → apitest 3 条钉红（含"上游请求数 2→3"）；
  钳制静默 + 费用兜 0 → apitest 2 条 + selftest 3 条钉红；token 每次新生成 → browser-test 2 条钉红；
  项目页退回三拉 → browser-test"不再拉全量"钉红（列出被多拉的 `/api/storyboards`、`/api/images`）；
  拆掉时长前置拦截 → browser-test 钉红；删一处变更须知 / 拆 no_api_key 出口 → uitest 各钉红。还原后全绿。
- **下一轮（收尾）**：`.understand-anything/` 工具知识图谱重建（锚点 `ef8834d`，落后约 50 个文件与多轮
  新导出符号：`textstats.js`、`characters.js`、`port-check.mjs`、`makeTokenStore`、`extractCost`、
  `errorOutlet`、`effectiveVideoSeconds`、`VIDEO_DURATION_RANGE` 等）——这是唯一还挂着的技术债，
  按既定决定放在批 7 之后的专门一轮做，不再顺延。

**待办（技术债）：当前无挂账项。** 曾经唯一的一笔——`.understand-anything/` 工具知识图谱落后 45 个文件——
已于 B61（第 80 轮）清偿：锚点更新到 `d268a0d`，覆盖 55 个文件 / 278 节点 / 1076 边，校验全过。
后续每轮改动若新增/删除文件或增删导出符号，按 `AGENTS.md`「更新流程」跑一次 `/understand` 增量更新
（并记得注意事项 2 的 `tested_by` 手工补回），不要让它重新积压成挂账项。
