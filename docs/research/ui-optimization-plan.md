# UI 优化总纲 · 竞品对照 → 分批实施计划

> 依据：`ui-manjugongfang-hosted.md`（托管版设计系统）、`ui-other-competitors.md`（N2S/MJDirector）、`ui-our-baseline.md`（自家基线）。
> **B5 批次（信息架构与流程主线）见 `ui-ia-flow-spine.md`** —— B1–B4 治的是设计语言/体验缺陷/组件质感，
> B5 治的是"东西都在、但用户不知道现在在哪、下一步点哪儿"。同一份总纲，不另起一份计划。
> 原则：每批独立可回滚、每批后 `run-all` 全绿才提交；标 · 已实施、◐ 进行中、· 待做。
> 批次：B1 设计语言（纯 token/CSS）→ B2 体验缺陷（行为修复，多数无竞品启发也该做）→ B3 交互组件升级 → B4 结构/产品级重构（需重构，逐条判断）。

## B1 设计语言（低风险，纯 CSS）

| # | 项 | 依据 | 内容 | 验收 |
|---|---|---|---|---|
| 1.1 ✔ | 暖金中性字阶 | 托管版 `#f4f1ea/#cfcabf/#9a9a9a` vs 我们冷灰 `#B4B6BE` | text/2/3/4 全部掺金味；标题用 `--text-heading` 暖白 | uitest 类名不破；对比度 ≥4.5 保持 |
| 1.2 ✔ | 金色交互语言 | `--border-hover:#e8c9896b`、`--border-active:#e8c98999` | card/nav/chip/segmented hover 边框变金（现只变背景）；active 金边 60% | 浏览器截图人工比对 |
| 1.3 ✔ | `--gold-glow` 发光 token | 双层：外发光+1px 金描边 | 用于 focus-visible 环、主按钮 hover、选中卡片 | focus 键盘走查 |
| 1.4 ✔ | 状态色柔化 | `#3fb984/#f06161/#e8a23c` 低饱和专业色 | ok/err/warn 换色（与金协调），info 保青 | toast/徽标肉眼比对 |
| 1.5 ✔ | 入场级联 | revealIn 60ms 步进 + `prefers-reduced-motion` 降级 | 网格卡 nth-child 延迟；列表行不级联（防抖长表） | 动效开关下无跳变 |
| 1.6 · | 令牌收敛 | 基线 §13：字号 14 档/间距 28 值/圆角 15 档 | 字号 8 档 token、间距 6 档、圆角 4 档；高频内联 style 归 utility 层（`.row/.col/.muted/.mono` 等） | grep 断言：无新增裸 13.5px 类值 |
| └ 1.6b ✔ | 字号地坪+棘轮 | ui-audit 实测 4 视口×9 页零溢出零对比违例；JS 页 11 处 10/10.5px 抬至 11px 地坪；uitest 双棘轮（地坪禁回退 + 裸字号 ≤44 只减不增）；全量内联 style 迁移仍按批次挂起 |  |
| 1.7 ✔ | 背景氛围层 | 托管版背景图+顶部渐变压暗、MJ 暖纸渐变 | body 加固定径向金色氛围（极低透明度），卡片层级全交给 alpha | 截图比对 |

## B2 体验缺陷（行为，多数基线自证）

| # | 项 | 依据 | 内容 | 验收 |
|---|---|---|---|---|
| 2.1 ✔ | 导入 replace 零确认 | 基线 SE-1 | replace 模式 danger confirm 两段式 | uitest 断言确认钮存在 |
| 2.2 ✔ | 四处 load() 错误分支 | 基线 D-1/A-1（dashboard/assets/tasks/settings） | 失败→red note+重试钮，杜绝永久 spinner/谎报空态 | browser-test 加 1 例 |
| 2.3 ✔ | aspect_ratio 接通 | 基线 T-1：写死 1152×768/1024² | 项目比例→各模式宽高映射，分镜出图/出视频/视频页全接 | apitest 参数落库断言 |
| 2.4 ✔ | R6 残留防双击 | 基线：projects dup/save、scripts 保存、settings 保存/导入 | 统一 setBusy | 代码审查 |
| 2.5 ✔ | 表单脏守卫+⌘↵ | 基线 G 系列 + 托管版 | ui.js modal 加 dirty 比较钩子；模态内 ⌘/Ctrl+Enter 提交 | 浏览器实测 |
| 2.6 ✔ | 全选 indeterminate | 基线：分镜页选择器撒谎 | 半选态 + 双向同步 | 浏览器实测 |
| 2.7 ✔ | 空态带出口 | 基线 Top-10 #10 + 托管版文案纪律 | `empty(text, action?)`；5 高频空态一键直达 | uitest 签名检查 |
| 2.8 ✔ | videos 订阅 SSE | 基线 V-1（提交后状态永不更新） | onEvent('video') + 防抖重挂（避弹窗/播放） | browser-test |
| 2.9 ✔ | 视图状态进 hash | 基线 G-12（F5/回退丢 tab/集数/分节） | scripts?tab、assets?tab、settings?sec、storyboards?ep 统一 navigate 写回 | uitest 断言 |
| 2.10 ✔ | tasks 过滤器候选修正 | 基线：状态词表不匹配静默筛空 | 按 tab 提供对应状态词 | 浏览器实测 |
| 2.11 ✔ | 错误文案带下一步 | 托管版最强项（N2S 错误映射表同） | 高频 10 条 toast/错误文案审改：每句含动作 | 人工审读 |
| 2.12 ✔ | 素材筛选持久化 | 托管版 localStorage filter 记忆 | 素材库 mode/keyword 记忆+恢复 | 浏览器实测 |

## B3 组件升级（中等）

| # | 项 | 依据 | 内容 |
|---|---|---|---|
| 3.1 ✔ | select 质感 | 托管版 GlassSelect（自研下拉） | 保留原生 select 语义（a11y/零依赖），CSS 换箭头+弹层色板（`color-scheme: dark` 已继承，补 option 背景） |
| 3.2 ✔ | 侧栏可折叠 | 托管版 216↔68 图标轨+localStorage | 260↔68 折叠钮，状态持久化 |
| 3.3 ✔ | 任务卡进度语言 | 托管版 Tasks/videoTaskSync | 任务行加"已轮询 n 次/预估"节奏感文案 + 重试带原参数（retry_params 思路，我们已有 edit 重提交可低成本做） |
| 3.4 ✔ | 两段式就地确认 | 托管版 3 秒失效 | 危险钮第一次点击变「再点一次确认」，3s 回弹（替代部分 confirm 弹窗，减少打断层级） |

## B4 结构/产品级（允许重构，逐条判断）

| # | 项 | 依据 | 决策 |
|---|---|---|---|
| 4.1 ✔ | **画风/内容分层注入** | N2S 核心纪律：生成链禁画风词，使用点统一拼接；换画风零重生成 | **做**：image/video prompt 入库不带画风；出图/出视频时后端拼 `project.art_style`；卡片预览显示"最终词"（计算态） |
| 4.2 ✔ | 提示词预览双轨 | N2S 计算态预览+opt_prompt 润色 | 随 4.1：镜头卡展开可见「全局风格+内容」合成结果 |
| 4.3 · | appearance 角色一致性链 | N2S：角色外貌回注分镜/画面词/视频词三处 | 依赖角色资产建模，本批不做（记 backlog：需先有 characters 集合） |
| 4.4 ✗ | 内层滚动容器 | 托管版 max-w 1320 内容内滚 | 决定不做：B3.2 折叠后收益更低，全屏利用更适合本工具 |
| 4.5 ✔ | 批量可离开可回 | 托管版 task_id 持久化；对应我们 E7 | 并入 E7 实施：前端订阅 `/api/batch`（后端已完好） |
| 4.6 ✔ | 导出器矩阵 | N2S 五件套/BOM CSV | 已有 export/import；补「分镜表 CSV(BOM)」与「视频提示词 MD」两个高频件 |
| 4.7 · | 参数面板零硬编码 | MJ 按模型目录元数据渲染 | 待动态模型目录带参数 schema 后再做（现阶段硬编码+钳制够用） |

## B5 信息架构与流程主线（依据 `ui-ia-flow-spine.md`）

| # | 项 | 内容 | 状态 |
|---|---|---|---|
| 5.1 | 项目上下文唯一来源 | 壳层持有 `state.projectId` + 唯一入口 `resolveProjectId`/`rememberProject` + 侧栏那**一个**选择器；规范名 `project`（旧别名 `project_id` 一处迁移） | ✔ |
| 5.2 | 删掉页面级项目选择器 | `projectPicker` → `projectLabel`（只读），换项目统一走侧栏 | ✔ |
| 5.3 | 导航即进度 | 侧栏入口带状态徽标，数取自 `/api/story/pipeline`（**同一份**数据） | ✔ |
| 5.4 | 流程条常驻 | 七段链抽成 `public/js/pipeline.js`，每页可见 + "去下一步" | ✔ |
| 5.5 | 页头"上游产物 + 下一步" | `head({progress})`（`progressOf(入口, 项目)` 从七段链推导），向后兼容 | ✔ |
| 5.11 | 分镜表每行自带"下一步"（与三个产出点同源：`rowSteps` 一份推导） | 行内一行"下一步：补提示词／出分镜图／出视频"；都齐了不硬凑；在跑/失败说清是哪一关 | ✔ |
| 5.6 | 项目级"上次停在哪一段" | 记忆进 `agnes.project.<id>.stage`，项目卡显示"继续创作 · <上次那一段>"（"在不在链上"取自服务端 `steps[].nav`；挂载后才记） | ✔ |

## 不学清单（三份报告一致否决）

- React/shadcn 底座迁移（违背零依赖原则）；原生 `<select>` 换自研下拉的 a11y 税不值
- 3D tilt/鼠标光斑（游戏站手法，创作工具显廉价）
- 登录/钱包/Admin（本地版威胁模型外）
- IndexedDB 素材缓存（我们直接落文件盘，更可靠）
- 底部 5 tab 移动布局（桌面工具，900px 断点已够）
- 「七参数人话文本」存储（我们字段化存储可程序消费，不回退）

## 测试线约束

- uitest 452 条静态断言锚定类名/函数名 → 改类名必须同步改测试（视为主张变更，写进提交说明）
- 每批后跑 `node tools/run-all.mjs`；B1 全 CSS 批后加跑 browser-test 截图人工比对
- 涉及提交参数的批（2.3/4.1）必补 apitest 断言再提交
