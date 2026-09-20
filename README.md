# Agnes 漫剧工坊 · 本地版

一个本地优先、零云端数据库依赖的 AI 漫剧制作工作台。

它把故事构思、剧情梗概、分集大纲、单集脚本、分镜、图片生成、视频生成、任务轮询和素材管理串成一条本地创作链路。API Key、项目数据和生成记录保存在本机，前端不会直接接触 API Key。

> 本项目使用 [MIT License](./LICENSE) 发布。

## 功能

- 项目管理：类型、平台、画风、比例、集数和资料导出
- 故事脚本：故事构思、剧情梗概、分集大纲、单集脚本、分镜脚本
- 脚本优化：强化开头、冲突、爽点、反转、钩子、镜头感和精简
- 分镜制作：生成、编辑、排序、批量生成图片/视频提示词
- 图片生成：文生图、图生图，本地素材落盘
- 视频生成：文生视频、图生视频、多图参考、关键帧动画
- 任务中心：服务端后台轮询、SSE 实时状态、超时任务补录 video_id
- 素材库：图片、视频、文本、收藏、预览、下载
- 动态模型目录：从 Agnes 的 OpenAI 兼容 `GET /v1/models` 拉取模型，不需要为新模型改代码
- 数据管理：项目导出、全量 JSON 备份和导入
- 单文件 Windows exe：接收方无需安装 Node.js

## 快速开始

### Windows 单文件版

从 [Releases](https://github.com/liobububu/agnes-manga-studio/releases) 下载最新版 `AgnesMangaStudio-vX.Y.Z.exe`（以 Releases 页为准），双击启动。程序会自动打开本地浏览器页面。

> GitHub Release 附件名不支持中文字符，故文件名使用 ASCII。下载后可重命名为 `Agnes漫剧工坊.exe`，不影响使用。

首次使用：

1. 打开「设置 → Agnes API」
2. 填写 Agnes API Base URL 和 API Key
3. 点击「拉取模型目录」同步当前可用模型
4. 在「设置 → 模型配置」选择默认文本、图片和视频模型
5. 新建项目，按脚本 → 分镜 → 图片 → 视频的流程创作

### 源码运行

要求 Node.js 20.6 或更高版本。

```bash
node server.js
```

服务默认监听 `http://127.0.0.1:5178`。也可以指定端口和数据目录：

```bash
PORT=5178 AGNES_STUDIO_HOME=./data node server.js
```

**改了后端代码（`server.js` / `lib/*.js`）要重启服务才生效。**
重启还会**顺带更新内置提示词**（提示词是抽取质量的关键，改进了就得能到你手上）——
只更新你没改过的那些；**你编辑过的内置模板一律原样保留**，启动横幅会说明"更新了几个 / 保留了哪几个"。 前端静态文件是每次刷新都从磁盘读的，
后端只在启动那一刻读一次 —— 所以不重启的话，页面显示的是新功能、接口还是旧的，会报接口不存在。
工作台会自己把这件事说出来：页面顶部会出现横幅、接口报错里也会点名。

## 数据与安全

- 源码运行时默认数据目录为项目下的 `data/`
- 单文件 exe 默认使用系统用户目录（Windows 为 `%LOCALAPPDATA%\AgnesStudio`）；在 exe 同旁放一个名为 `portable` 的空标记文件即切换为同级 `data/`（便携模式）
- `settings.json`、`db.json`、`models.json` 和生成素材不会提交到 Git
- API Key 只由本地服务读取，前端接口只返回脱敏信息；视频下载到本机时凭证只发往与 API Base 同主的地址
- 本地服务只监听 `127.0.0.1`
- 写操作校验 Origin（host+port 精确匹配），所有请求校验 Host 白名单（挡 DNS rebinding），素材路径与导入的 `local_file` 均限制在素材根目录内
- 数据落盘为原子写（临时文件 + fsync + rename），并保留上一份 `.bak`
- 端口撞车时会探测占用者是否为相同数据目录的本应用：是则直接复用现有服务、不再起影子实例（尽力而为的防双写，非文件锁强制）

## 动态模型目录

程序通过本地服务请求：

```text
GET {API_BASE_URL}/v1/models
```

兼容以下响应格式：

```json
{ "data": [{ "id": "model-name" }] }
```

```json
{ "models": [{ "id": "model-name" }] }
```

```json
[{ "id": "model-name" }]
```

模型目录缓存到本地 `models.json`。缓存 TTL 为 24 小时；服务启动时和常驻期间（每 6 小时看一眼）都会检查，过期才真正打远端接口；也可以在「设置 → 模型配置」中手动刷新或调整缓存策略。拉取失败时会保留上一次成功的目录和旧模型回退项。

## 测试

```bash
node tools/selftest.mjs
node tools/apitest.mjs
node tools/uitest.mjs
node tools/browser-test.mjs
node tools/run-all.mjs
```

接口测试会自动启动本地 mock Agnes 服务，不会消耗真实 API 配额。

按需运行的辅助验证（不进门禁）：

```bash
node tools/ui-audit.mjs     # 真机视觉度量报表：4 视口 × 9 页的溢出/微字号/对比度/截断无提示
node tools/port-check.mjs   # 端口撞车防护三场景 6 断言实测（复用 / 漂移 / 影子实例 + 收尾无残留自检）
                            #   退出码：0 全过 / 1 真实违例 / 2 环境冲突（端口被无关进程占用，结论不可用）
```

## 打包 Windows exe

```bash
node tools/build-exe.mjs
```

打包使用 Node.js SEA 和 `postject`。产物位于 `dist/Agnes漫剧工坊.exe`。

## 目录结构

```text
server.js             本地 HTTP 服务与静态资源服务
lib/store.js          JSON 数据层与模型缓存
lib/agnes.js          Agnes API 客户端
lib/poller.js         视频后台轮询与 SSE
lib/routes.js         REST API 路由
lib/jobs.js           批量任务队列
lib/seed.js           默认提示词模板
public/               原生 HTML/CSS/JS 前端
tools/                测试与 exe 打包脚本
docs/knowledge-graph/ 项目知识图谱（JSON 数据 + 交互式 viewer）
```

## 说明

本软件是 Agnes API 的独立本地客户端，不代表 Agnes 官方产品。使用 Agnes API 时请遵守其服务条款、模型许可和内容安全要求。生成内容的版权、合规和平台发布责任由使用者自行承担。
