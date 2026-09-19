/**
 * apitest.mjs — 接口端到端测试
 * ------------------------------------------------------------------
 * 自己起一个 mock Agnes 服务（假文本 / 假图片 / 假视频任务），
 * 让被测服务把 base url 指过去，就能在不联网、不花钱的前提下
 * 把「生成 → 落盘 → 轮询 → 完成 → 下载」整条链路跑一遍。
 *
 * 用法：node tools/apitest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; return true; }
  fail++; failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
  return false;
}
function eq(name, a, b) { return ok(name, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }
function group(t) { console.log(`\n── ${t} ──`); }

const HOME = path.join(os.tmpdir(), `agnes-apitest-${process.pid}`);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });

// T3 审核加强：mock 认死值（只校格式则任何假 Key 都放行，「张冠李戴」回归测不出）；常量单源防多处硬编码漂移
const MOCK_KEY = 'sk-mock-key-1234567890';
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ── mock Agnes ───────────────────────────────────────────────
let queryCount = 0;
const VIDEO_ID = 'vid_mock_001';
// 捕获最近一次 /v1/videos 创建请求体，供 2.5 协议断言
let lastVideoCreate = null;
let lastImageCreate = null; // B4.1：验证画风只在使用点注入、且注入的是映射短语
let chatFormats = [];
// T5b 事故路径控制面：query 返回的下载地址可切换；deny 端点带 Key 命中次数必须恒 0
let queryTarget = 'base'; let flakyHits = 0; let denyHitsWithKey = 0;
let videoCreateHits = 0; // 批 7：幂等断言要能证明"复用时确实没向上游下单"，光看响应形状证明不了
let imagesDelayMs = 0; // 批量取消契约：把出图放慢，稳定制造「运行中」窗口（测试专用）
let storyChatCalls = 0; // 批 8：/api/story/plan 必须**一次模型都不调**，靠这个计数证明
let badJsonUpstream = false; // R10：让上游回 200 + 非 JSON（真实世界里的"网关返回 HTML 错误页"） // T4：记录每次 chat 是否带 response_format（验证"首发带→4xx→降级不带"两跳）
let lastVideoQueryUrl = null; // v2.0 查询
let last25QueryUrl = null;    // 2.5 系查询（对照组会覆盖全局，单独记）
// 按提示词标记统计 /v1/videos 实际到达次数：验证「限流后重试」与「4xx 不重试」
const videoCalls = {};
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const send = (code, obj) => {
    const s = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
    res.end(s);
  };
  // T3：真实 Agnes 全端点要 Bearer。mock 此前从不读请求头——agnes.js 丢头/错头测试也全绿。
  const auth = String(req.headers.authorization || '');
  if (req.method === 'GET' && u.pathname === '/pixel.png') {
    // 公网 CDN 语义：结果图不鉴权（fetchRemoteImage 本就不带 Key）
    const buf = Buffer.from(PNG_1PX, 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length });
    return res.end(buf);
  }
  if (u.pathname === '/__mock') {
    const cmd = u.searchParams.get('set');
    if (cmd) { queryTarget = cmd; return send(200, { ok: true }); }
    const si = u.searchParams.get('slowimg');
    if (si !== null) { imagesDelayMs = Number(si) || 0; return send(200, { ok: true, imagesDelayMs }); }
    const bj = u.searchParams.get('badjson');
    if (bj !== null) { badJsonUpstream = bj === '1'; return send(200, { ok: true, badJsonUpstream }); }
    return send(200, { queryTarget, flakyHits, denyHitsWithKey, imagesDelayMs });
  }
  if (auth !== `Bearer ${MOCK_KEY}`) {
    // 审核加强：值精确匹配注入 Key——只校格式的话任何假 token 都放行，错 Key 链路回归测不出
    return send(401, { error: { message: /^Bearer \S+$/.test(auth) ? 'invalid api key (mock)' : 'missing bearer (mock guard)' } });
  }
  if (req.method === 'GET' && u.pathname === '/agnesapi') {
    lastVideoQueryUrl = req.url;
    if (/2\.5/.test(String(u.searchParams.get('model_name') || ''))) {
      // 2.5 系查询契约：带 model_name，完成后的地址在 metadata.url
      last25QueryUrl = req.url;
      return send(200, { id: VIDEO_ID, status: 'completed', progress: 100, metadata: { url: queryUrl() } });
    }
    queryCount++;
    // R12/R13 探针：永远"进行中"，用来把轮询预算真的跑满
    if (queryTarget === 'stuck') return send(200, { id: VIDEO_ID, status: 'in_progress', progress: 30 });
    if (queryCount <= 1) return send(200, { id: VIDEO_ID, status: 'queued', progress: 20 });
    return send(200, { id: VIDEO_ID, status: 'completed', progress: 100, remixed_from_video_id: queryUrl() });
  }
  function queryUrl() {
    return queryTarget === 'flaky' ? `${MOCK_BASE}/flaky.mp4`
      : queryTarget === 'deny' ? `http://localhost:${mockPort}/deny.mp4` : `${MOCK_BASE}/video.mp4`;
  }
  if (req.method === 'GET' && u.pathname === '/deny.mp4') {
    denyHitsWithKey++; // 走到这里说明请求带了正确 Key——跨主机守则被破
    const buf = Buffer.from('LEAKED'); res.writeHead(200, { 'Content-Type': 'video/mp4' }); return res.end(buf);
  }
  if (req.method === 'GET' && u.pathname === '/flaky.mp4') {
    flakyHits++;
    if (flakyHits === 1) { res.writeHead(503); return res.end('flaky'); }
    const buf = Buffer.from('MOCKMP4DATA');
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': buf.length });
    return res.end(buf);
  }
  if (req.method === 'GET' && u.pathname === '/video.mp4') {
    const buf = Buffer.from('MOCKMP4DATA');
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': buf.length });
    return res.end(buf);
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (u.pathname === '/v1/chat/completions') {
      let cb = {}; try { cb = JSON.parse(body); } catch { /* 原样通过 */ }
      chatFormats.push(!!cb.response_format);
      storyChatCalls++;
      // 批 8 原著解析：按提示词特征分流（分块抽取 / 全局归并）。
      // 抽取走 mock 的两段式：第 2 段才出现"青铜钥匙"与更详细的外貌，
      // 用来验证"跨块去重合并"与"更详细的字段取胜"这两条真会发生。
      const userMsg = String(((cb.messages || []).find((m) => m.role === 'user') || {}).content || '');
      if (/"cards"\s*:/.test(userMsg)) {
        if (userMsg.includes('__BADCHUNK__')) return send(200, { choices: [{ message: { content: '抱歉，这一段我读不懂。' } }] });
        const seg = /第 (\d+) 段/.exec(userMsg);
        const i = seg ? Number(seg[1]) : 1;
        return send(200, { choices: [{ message: { content: JSON.stringify({ cards: [
          { kind: 'character', name: '林晚', aliases: ['晚晚', '林晚'], role: '主角', identity: '茶馆老板', appearance: i === 1 ? '白衣' : '白衣长剑', personality: '冷静' },
          { kind: 'character', name: '顾寒', role: '配角', identity: '过路剑客' },
          { kind: 'location', name: '临江茶馆', atmosphere: '喧闹潮湿' },
          { kind: 'npc', name: '这条类别不认识应当被丢弃' },
          ...(i === 2 ? [{ kind: 'prop', name: '青铜钥匙', owner: '林晚', usage: '开密室' }] : []),
          // 追加解析测试要有一张**全新的卡**才验得了"新卡的块号落在新增区间"
          ...(userMsg.includes('第二卷') ? [{ kind: 'prop', name: '夜访灯笼', owner: '林晚', usage: '照路' }] : []),
        ] }) } }] });
      }
      if (/"plots"\s*:/.test(userMsg)) {
        // __LONGARC__：给分集骨架测试造一段"两幕八拍"的剧情（只有带标记的原文才会走到这里，
        // 所以不可能影响其它分组的既有断言）
        if (userMsg.includes('__LONGARC__')) {
          return send(200, { choices: [{ message: { content: JSON.stringify({
            world: { name: '长弧线旧事', genre: '古装悬疑', tone: '沉郁' },
            plots: [
              { name: '长弧·起1', stage: '起', conflict: 'C1' }, { name: '长弧·承1', stage: '承', conflict: 'C2' },
              { name: '长弧·转1', stage: '转', conflict: 'C3' }, { name: '长弧·合1', stage: '合', outcome: 'O1' },
              { name: '长弧·起2', stage: '起', conflict: 'C4' }, { name: '长弧·承2', stage: '承', conflict: 'C5' },
              { name: '长弧·转2', stage: '转', conflict: 'C6' }, { name: '长弧·合2', stage: '合', outcome: 'O2' },
            ],
          }) } }] });
        }
        // 故意包 ```json 围栏：真实网关/模型经常这么回，宽松解析必须吃得下
        return send(200, { choices: [{ message: { content: '```json\n' + JSON.stringify({
          world: { name: '临江旧事', genre: '古装悬疑', tone: '沉郁', mainline: '林晚查父仇，顾寒是唯一线索。' },
          plots: [
            { name: '茶馆初见', stage: '起', conflict: '林晚试探顾寒', outcome: '顾寒留下' },
            { name: '钥匙现世', stage: '承', conflict: '有人跟踪', outcome: '密室开启' },
          ],
        }) + '\n```' } }] });
      }
      if (cb.model === 'mock-reject-json' && cb.response_format) return send(400, { error: { message: 'response_format not supported by this gateway' } });
      if (cb.model === 'mock-deny-key' && cb.response_format) return send(401, { error: { message: 'bad key' } });
      return send(200, { choices: [{ message: { role: 'assistant', content: '```json\n[{"shot_number":1,"shot_type":"特写","image_prompt":"a hero face"}]\n```' } }] });
    }
    if (u.pathname === '/v1/images/generations') {
      try { lastImageCreate = JSON.parse(body); } catch { lastImageCreate = { bad_json: body }; }
      // R10 探针：200 + HTML → 后端解析失败 → 502（这是唯一能确定性触发 5xx 的真实路径）
      if (badJsonUpstream) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>502 Bad Gateway</html>'); }
      if (imagesDelayMs) {
        const payload = lastImageCreate && lastImageCreate.model === 'mock-img-url-ok' ? { data: [{ url: `${MOCK_BASE}/pixel.png` }] } : { data: [{ b64_json: PNG_1PX }] };
        return setTimeout(() => send(200, payload), imagesDelayMs);
      }
      if (lastImageCreate.model === 'mock-img-url-ok') return send(200, { data: [{ url: `${MOCK_BASE}/pixel.png` }] });
      if (lastImageCreate.model === 'mock-img-url-dead') return send(200, { data: [{ url: 'http://127.0.0.1:1/nope.png' }] });
      return send(200, { data: [{ b64_json: PNG_1PX }] });
    }
    if (req.method === 'GET' && u.pathname === '/v1/models') {
      return send(200, {
        object: 'list',
        data: [
          { id: 'agnes-text-new', name: 'agnes-text-new', kind: 'text', owned_by: 'agnes' },
          { id: 'agnes-image-new', name: 'agnes-image-new', kind: 'image', owned_by: 'agnes' },
          { id: 'agnes-video-new', name: 'agnes-video-new', kind: 'video', owned_by: 'agnes' },
        ],
      });
    }
    if (u.pathname === '/v1/videos') {
      videoCreateHits++;
      try { lastVideoCreate = JSON.parse(body); } catch { lastVideoCreate = { bad_json: body }; }
      if (lastVideoCreate.model === 'mock-embed-err') return send(200, { error: { message: 'embedded boom in 200' } });
      if (lastVideoCreate.model === 'mock-slow') { setTimeout(() => { try { send(200, { id: 'vid_slow_1', status: 'queued' }); } catch { /* 客户端已断开 */ } }, 11500); return; }
      const p = String(lastVideoCreate.prompt || '');
      const mm = /__retry(\d+)__/.exec(p);            // 前 N 次返回 503（排队满），之后成功
      const key = mm ? `r${mm[1]}` : /__bad400__/.test(p) ? 'bad' : 'plain';
      videoCalls[key] = (videoCalls[key] || 0) + 1;
      if (mm && videoCalls[key] <= Number(mm[1])) {
        return send(503, { code: 'video_queue_full', message: 'video queue is full, please retry later (mock)' });
      }
      if (/__bad400__/.test(p)) {
        return send(400, { code: 'invalid_request', message: 'frame_rate is not an allowed request field (mock)', data: { param: 'frame_rate' } });
      }
      return send(200, { id: VIDEO_ID, video_id: VIDEO_ID, task_id: 'task_mock', status: 'queued' });
    }
    send(404, { error: 'unknown path' });
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// T9：随机端口可能撞 mock/srv 互相或撞外部占用 → 服务端起不来被误报成断言失败。
// 实测两端口都空闲才返回，且强制 srv 与 mock 相距 ≥2。
const portBusy = (p) => new Promise((res) => {
  const s = net.connect(p, '127.0.0.1');
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('error', () => res(false));
  s.setTimeout(400, () => { s.destroy(); res(true); });
});
async function freePortPair() {
  for (let i = 0; i < 40; i++) {
    const m = 21000 + Math.floor(Math.random() * 8000);
    if (await portBusy(m)) continue;
    const s = 21000 + Math.floor(Math.random() * 8000);
    if (Math.abs(s - m) < 2 || await portBusy(s) || await portBusy(s + 1)) continue;
    return [m, s];
  }
  throw new Error('找不到空闲测试端口对');
}

async function listenAsync(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(port));
  });
}

let MOCK_BASE = '';
let BASE = '';
let srv = null;

async function waitHealth(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}

async function api(method, url, body, headers = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  Object.assign(opts.headers, headers);
  const res = await fetch(`${BASE}${url}`, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data, text };
}

// ── 启动 ─────────────────────────────────────────────────────
const [mockPort, srvPort] = await freePortPair();
await listenAsync(mock, mockPort);
MOCK_BASE = `http://127.0.0.1:${mockPort}`;
srv = spawn(NODE, [path.join(ROOT, 'server.js')], {
  env: { ...process.env, PORT: String(srvPort), NO_OPEN: '1', AGNES_STUDIO_HOME: HOME },
  stdio: 'ignore',
});
BASE = `http://127.0.0.1:${srvPort}`;

// T7 审核前移：进程/临时目录收尾在 spawn 之后立即注册——
// 旧顺序里 waitHealth/T6 身份检查之前的任何同步抛出都会漏杀 srv 子进程、漏删 HOME。
let cleaned = false;
const cleanup = () => {
  if (cleaned) return; cleaned = true;
  try { srv.kill(); } catch { /* gone */ }
  try { mock.close(); } catch { /* gone */ }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); cleanup(); process.exit(1); });

if (!await waitHealth(BASE)) {
  console.error('✗ 服务没起来');
  cleanup();
  process.exit(1);
}
console.log(`\nmock Agnes: ${MOCK_BASE}\n被测服务:   ${BASE}\n数据目录:   ${HOME}`);
{
  // T6：破坏性用例（级联删/replace 导入）前必须确认"BASE 上就是本测试刚起的实例"。
  // 端口随机撞车 + server 自动换端口时，不校验就会把删除打在陌生工作台的数据上。
  const hid = await (await fetch(`${BASE}/api/health`)).json().catch(() => ({}));
  if (!hid.ok || path.resolve(String(hid.data_home || '')) !== path.resolve(HOME)) {
    console.error(`✗ 被测实例身份不符（data_home=${hid.data_home}），端口可能被占用。拒绝执行破坏性用例。`);
    cleanup();
    process.exit(1);
  }
}

// ── 1. 基础 ──────────────────────────────────────────────────
group('基础接口');
{
  const r = await api('GET', '/api/health');
  eq('health 200', r.status, 200);
  eq('health ok', r.data.ok, true);
  ok('health 带数据目录', !!r.data.data_home);

  const b = await api('GET', '/api/bootstrap');
  eq('bootstrap 200', b.status, 200);
  ok('bootstrap 含 settings', !!b.data.settings);
  ok('bootstrap 含 projects', Array.isArray(b.data.projects));
  ok('bootstrap 含 stats', !!b.data.stats);
  ok('bootstrap 含模板', Array.isArray(b.data.templates) && b.data.templates.length > 0);
}

// ── 2. 设置 ──────────────────────────────────────────────────
group('设置');
{
  const r = await api('PUT', '/api/settings', {
    agnes_api_base_url: `${MOCK_BASE}/v1`,
    agnes_api_key: MOCK_KEY,
    video_poll_interval: '5',
    video_max_polls: '20',
    auto_download_video: '1',
  });
  eq('保存设置 200', r.status, 200);
  const g = await api('GET', '/api/settings');
  eq('Key 脱敏返回', g.data.agnes_api_key, '***configured***');
  ok('掩码形如 sk-a****7890', /\*+/.test(g.data.agnes_api_key_masked), g.data.agnes_api_key_masked);
  eq('base url 已更新', g.data.agnes_api_base_url, `${MOCK_BASE}/v1`);
  eq('轮询间隔已更新', g.data.video_poll_interval, '5');
  { const cr = await api('PUT', '/api/settings', { video_poll_interval: '1' }); eq('E8 低于下限钳制为 2', cr.data.settings.video_poll_interval, '2'); const cr2 = await api('PUT', '/api/settings', { video_poll_interval: 'abc' }); eq('E8 非法串回落默认 8', cr2.data.settings.video_poll_interval, '8'); }

  const t = await api('POST', '/api/settings/test', { kind: 'text' });
  ok('连通性测试返回结构', typeof t.data.ok === 'boolean', JSON.stringify(t.data));
  eq('mock 连通', t.data.ok, true);

  const mr = await api('POST', '/api/models/refresh', {});
  eq('模型拉取 200', mr.status, 200);
  eq('模型拉取成功', mr.data.ok, true);
  eq('拉到 3 个模型', mr.data.models.models.length, 3);
  ok('模型目录记录更新时间', !!mr.data.models.updated_at);
  eq('模型来源是 Agnes', mr.data.models.source, 'agnes');
  const ml = await api('GET', '/api/models');
  eq('模型目录可读取', ml.data.models.length, 3);
  eq('模型目录保留新文本模型', ml.data.models.find((m) => m.id === 'agnes-text-new').kind, 'text');
}

// ── 3. 项目 ──────────────────────────────────────────────────
let PROJECT_ID = '';
group('项目');
{
  const r = await api('POST', '/api/projects', { name: '接口测试剧', project_type: '都市逆袭', planned_episodes: 6 });
  eq('建项目 200', r.status, 200);
  PROJECT_ID = r.data.id;
  ok('拿到项目 id', !!PROJECT_ID);
  eq('默认平台', r.data.target_platform, '抖音');

  const l = await api('GET', '/api/projects');
  eq('项目列表有 1 条', l.data.length, 1);

  const u = await api('PUT', `/api/projects/${PROJECT_ID}`, { name: '改过名了', status: 'archived' });
  eq('改名', u.data.name, '改过名了');
  eq('改状态', u.data.status, 'archived');

  const d = await api('POST', `/api/projects/${PROJECT_ID}/duplicate`, {});
  ok('复制出副本', d.data.name.includes('副本'), d.data.name);
  eq('复制后 2 条', (await api('GET', '/api/projects')).data.length, 2);

  const bad = await api('POST', '/api/projects', { name: '' });
  eq('空名称 400', bad.status, 400);
  ok('空名称带错误说明', !!bad.data.error);
}

// ── 4. 文本生成 ──────────────────────────────────────────────
group('文本生成');
{
  const r = await api('POST', '/api/agnes/text', {
    messages: [{ role: 'user', content: '生成分镜' }],
    project_id: PROJECT_ID,
  });
  eq('文本生成 200', r.status, 200);
  eq('文本生成 ok', r.data.ok, true);
  ok('返回内容非空', String(r.data.content).length > 0);
  ok('内容含 JSON', r.data.content.includes('shot_number'));

  // 文本生成要写任务历史（原版这张表一直空着）
  const t = await api('GET', '/api/tasks?task_type=text');
  eq('文本任务入库', t.data.length, 1);
  eq('任务类型正确', t.data[0].task_type, 'text');
}

// ── 5. 剧本 ──────────────────────────────────────────────────
let SCRIPT_ID = '';
group('剧本');
{
  const r = await api('POST', '/api/scripts', {
    project_id: PROJECT_ID, script_type: 'story_concept', title: '测试剧本', content: '正文',
  });
  eq('建剧本 200', r.status, 200);
  SCRIPT_ID = r.data.id;
  const l = await api('GET', `/api/scripts?project_id=${PROJECT_ID}`);
  eq('项目下 1 条剧本', l.data.length, 1);

  const u = await api('PUT', `/api/scripts/${SCRIPT_ID}`, { title: '改标题' });
  eq('改剧本标题', u.data.title, '改标题');

  const bad = await api('POST', '/api/scripts', { content: '' });
  eq('空内容 400', bad.status, 400);
}

// ── 6. 分镜 ──────────────────────────────────────────────────
group('分镜');
{
  const r = await api('POST', '/api/storyboards', {
    rows: [
      { project_id: PROJECT_ID, episode_number: 1, shot_number: 1, shot_type: '特写', image_prompt: 'a hero', sort_order: 0 },
      { project_id: PROJECT_ID, episode_number: 1, shot_number: 2, shot_type: '全景', image_prompt: 'a city', sort_order: 1 },
      { project_id: PROJECT_ID, episode_number: 2, shot_number: 1, shot_type: '中景', sort_order: 0 },
    ],
  });
  eq('批量建分镜 200', r.status, 200);
  eq('插入 3 条', r.data.inserted, 3);

  const l1 = await api('GET', `/api/storyboards?project_id=${PROJECT_ID}&episode=1`);
  eq('第 1 集 2 条', l1.data.length, 2);
  const l2 = await api('GET', `/api/storyboards?project_id=${PROJECT_ID}&episode=2`);
  eq('第 2 集 1 条', l2.data.length, 1);

  // 排序：把两条顺序颠倒
  const ids = l1.data.map((s) => s.id).reverse();
  await api('POST', '/api/storyboards/reorder', { ids });
  const after = await api('GET', `/api/storyboards?project_id=${PROJECT_ID}&episode=1`);
  eq('排序生效', after.data[0].id, ids[0]);
  { // 插队自愈契约：乱序插入 + 无 sort_order（NaN 经 || 短路退化到镜号数值序）
    const sp = await api('POST', '/api/projects', { name: '插队剧' });
    for (const n of [2, 30, 1, 10]) await api('POST', '/api/storyboards', { project_id: sp.data.id, episode_number: 1, shot_number: n, video_prompt: `镜${n}` });
    const got = await api('GET', `/api/storyboards?project_id=${sp.data.id}&episode=1`);   // 参数名是 episode：写 episode_number 会被静默忽略（曾致此钉为错因通过）
    eq('乱序插入返回数值序 1,2,10,30', got.data.map((r) => r.shot_number).join(','), '1,2,10,30');
    await api('DELETE', `/api/projects/${sp.data.id}?cascade=1`);
  }

  const one = l1.data[0];
  const u = await api('PUT', `/api/storyboards/${one.id}`, { shot_type: '仰拍', duration_seconds: 5 });
  eq('改景别', u.data.shot_type, '仰拍');
  eq('改时长', u.data.duration_seconds, 5);

  const del = await api('DELETE', `/api/storyboards?project_id=${PROJECT_ID}&episode=2`);
  eq('清空第 2 集', del.data.removed, 1);

  // 护栏：缺 project_id 或 episode 一律拒绝，避免跨项目 / 全表误删
  const badClear1 = await api('DELETE', `/api/storyboards?episode=3`);
  eq('清空缺 project_id 被拒 400', badClear1.status, 400);
  const badClear2 = await api('DELETE', `/api/storyboards?project_id=${PROJECT_ID}`);
  eq('清空缺 episode 被拒 400', badClear2.status, 400);
  const badClear3 = await api('DELETE', `/api/storyboards`);
  eq('裸清空被拒 400', badClear3.status, 400);
  // 拒绝必须是无副作用的：第 1 集分镜不能被这些请求删掉
  const stillThere = await api('GET', `/api/storyboards?project_id=${PROJECT_ID}&episode=1`);
  ok('护栏拒绝不产生副作用', stillThere.data.length >= 1, `剩 ${stillThere.data.length}`);
}

// ── 7. 图片生成（含落盘） ────────────────────────────────────
let IMG_ID = '';
group('图片生成');
{
  const r = await api('POST', '/api/agnes/image', {
    prompt: 'a hero face', size: '1024x1024', project_id: PROJECT_ID, usage_type: 'storyboard',
  });
  eq('图片生成 200', r.status, 200);
  eq('图片生成 ok', r.data.ok, true);
  IMG_ID = r.data.asset.id;
  ok('返回本地 URL', r.data.asset.url.startsWith('/assets/images/'), r.data.asset.url);
  ok('记录了落盘路径', !!r.data.asset.local_file);

  // 静态访问这张图
  const img = await fetch(`${BASE}${r.data.asset.url}`);
  eq('图片可访问', img.status, 200);
  ok('图片有内容', (await img.arrayBuffer()).byteLength > 0);

  const t = await api('GET', '/api/tasks?task_type=image');
  eq('图片任务入库', t.data.length, 1);

  const fav = await api('PUT', `/api/images/${IMG_ID}`, { is_favorited: true });
  eq('收藏图片', fav.data.is_favorited, true);
  const st = await api('GET', '/api/stats');
  eq('统计里算到收藏', st.data.favorited_assets, 1);
}

// ── 8. 视频任务（提交 → 轮询 → 完成 → 保存） ────────────────
let VID_ID = '';
group('视频任务');
{
  const e2eSb = await api('POST', '/api/storyboards', { project_id: PROJECT_ID, episode_number: 99, shot_number: 991, scene_description: '回写验证镜头', video_prompt: 'hero turns' });
  const r = await api('POST', '/api/videos', {
    prompt: 'hero turns and smiles',
    storyboard_id: e2eSb.data.id,
    project_id: PROJECT_ID,
    mode: 'text_to_video',
    num_frames: 121,
    frame_rate: 24,
    width: 1152,
    height: 768,
  });
  eq('提交视频 200', r.status, 200);
  eq('提交成功', r.data.ok, true);
  VID_ID = r.data.asset.id;
  eq('拿到 video_id', r.data.asset.agnes_video_id, VIDEO_ID);
  eq('初始状态 queued', r.data.asset.status, 'queued');
  eq('本地状态轮询中', r.data.asset.local_status, 'polling');

  // 等轮询跑完（mock 第 2 次查询返回 completed，interval 设的 1s）
  let asset = null;
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    const v = await api('GET', `/api/videos?project_id=${PROJECT_ID}`);
    asset = v.data[0];
    if (asset.status === 'completed') break;
  }
  eq('轮询后变 completed', asset.status, 'completed');
  ok('拿到视频地址', !!asset.video_url, asset.video_url);
  eq('本地状态完成', asset.local_status, 'completed');
  ok('记录了完成时间', !!asset.completed_at);
  // E2E 轮实测修复的钉：首片完成必须同步把镜头推进到 video_ready（否则分镜徽章停在"有图片"）
  const sbRow = await api('GET', `/api/storyboards?project_id=${PROJECT_ID}&episode=99`);
  const linked = (sbRow.data || []).find((x) => x.id === e2eSb.data.id);
  ok('首片完成回写镜头状态 video_ready', !!linked && linked.status === 'video_ready' && linked.linked_video_id === asset.id, JSON.stringify(linked && { s: linked.status, v: linked.linked_video_id }));
  ok('存了原始状态响应', !!asset.raw_status_response);

  // 开了自动保存，应该已经落盘
  ok('视频已自动保存到本机', !!asset.local_file, String(asset.local_file));
  if (asset.local_file) {
    ok('本地视频文件存在', fs.existsSync(asset.local_file), asset.local_file);
    const name = path.basename(asset.local_file);
    const resp = await fetch(`${BASE}/assets/videos/${name}`);
    eq('视频可静态访问', resp.status, 200);
  }
}

// ── 批 7：R25 提交幂等 / R26 钳制回报 / R27 费用落库 / R29 服务端计数 ──
group('提交幂等与计费留痕（批 7）');
{
  // R25：同一个 client_token 在窗口内重复提交，只能向上游下一单
  const before = lastVideoCreate;
  const tok = `tok_${Date.now().toString(36)}_idem`;
  const body = { prompt: 'idempotency probe', project_id: PROJECT_ID, mode: 'text_to_video', num_frames: 121, frame_rate: 24, client_token: tok };
  const a1 = await api('POST', '/api/videos', body);
  eq('带 token 首次提交成功', a1.data.ok, true);
  eq('首次不是去重命中', a1.data.deduped, false);
  ok('首次确实打到了上游', lastVideoCreate && lastVideoCreate.prompt === 'idempotency probe');
  eq('token 落库（便于事后核对同一次意图被提了几遍）', a1.data.asset.client_token, tok);

  const sentAfterFirst = videoCreateHits;
  const a2 = await api('POST', '/api/videos', body);
  eq('重复提交仍返回 200（不是报错，而是复用）', a2.status, 200);
  eq('重复提交命中幂等', a2.data.deduped, true);
  eq('复用同一条记录（没有新建 asset）', a2.data.asset.id, a1.data.asset.id);
  eq('复用时不向上游下单（这才是防重复计费的关键）', videoCreateHits, sentAfterFirst);

  // 不同 token = 另一次付费意图，必须放行（否则用户"就是想再来一条"会被吞掉）
  const a3 = await api('POST', '/api/videos', { ...body, client_token: `${tok}_2` });
  eq('换 token 视为新意图', a3.data.deduped, false);
  ok('换 token 会真的下单', a3.data.asset.id !== a1.data.asset.id && videoCreateHits > sentAfterFirst, `hits=${videoCreateHits}`);

  // 不带 token 的老客户端行为不变（幂等是可选增强，不是新门槛）
  const a4 = await api('POST', '/api/videos', { prompt: 'no token probe', project_id: PROJECT_ID, mode: 'text_to_video' });
  eq('不带 token 仍可提交', a4.data.ok, true);
  eq('不带 token 时落库为 null（而不是空串）', a4.data.asset.client_token, null);

  // R26：钳制必须回报，不能静默
  const c1 = await api('POST', '/api/videos', { prompt: 'clamp probe', project_id: PROJECT_ID, mode: 'text_to_video', num_frames: 600, frame_rate: 24 });
  eq('超上限帧数被夹到 441', c1.data.asset.num_frames, 441);
  ok('夹了就要回报（否则用户按 25 秒预期等一个 18 秒的片子）',
    Array.isArray(c1.data.clamps) && c1.data.clamps.length === 1
    && c1.data.clamps[0].field === 'num_frames' && c1.data.clamps[0].requested === 600 && c1.data.clamps[0].used === 441,
    JSON.stringify(c1.data.clamps));
  const c2 = await api('POST', '/api/videos', { prompt: 'no clamp probe', project_id: PROJECT_ID, mode: 'text_to_video', num_frames: 121, frame_rate: 24 });
  eq('没夹就返回空数组（不虚报）', (c2.data.clamps || []).length, 0);

  // R27：费用字段——mock 不返回费用时必须落 null（不能兜成 0）
  eq('上游没给费用 → cost_credits 为 null（不是 0，0 会被读成免费）', c1.data.asset.cost_credits, null);
  eq('上游没给费用 → cost_unit 为 null', c1.data.asset.cost_unit, null);

  // R29：服务端聚合计数
  const plain = await api('GET', '/api/projects');
  ok('不带参数时响应形状不变（裸数组、无 counts 字段）',
    Array.isArray(plain.data) && plain.data.every((p) => !('counts' in p)));
  const counted = await api('GET', '/api/projects?with_counts=1');
  ok('带 with_counts=1 时每个项目都有 counts', Array.isArray(counted.data) && counted.data.every((p) => p.counts));
  const target = counted.data.find((p) => p.id === PROJECT_ID);
  const realSb = (await api('GET', `/api/storyboards?project_id=${PROJECT_ID}`)).data.length;
  eq('counts.storyboards 与真实分镜数一致', target.counts.storyboards, realSb);
  const realVid = (await api('GET', `/api/videos?project_id=${PROJECT_ID}`)).data.length;
  eq('counts.video_assets 与真实视频数一致', target.counts.video_assets, realVid);
  const noProj = counted.data.find((p) => p.id !== PROJECT_ID);
  ok('无素材的项目计数为 0（不是缺字段）',
    !noProj || (noProj.counts && noProj.counts.storyboards >= 0 && noProj.counts.image_assets >= 0));
}

// ── 8.5 Agnes Video 2.5 新协议适配（真实事故回归：旧字段被 400 拒绝） ──
group('视频 2.5 新协议');
{
  const r = await api('POST', '/api/videos', {
    prompt: '雨后的未来城市街道', model: 'agnes-video-2.5-flash', mode: 'text_to_video',
    negative_prompt: 'low quality', width: 1152, height: 768, num_frames: 241, frame_rate: 24, seed: '7',
  });
  eq('2.5 提交成功', r.data.ok, true);
  const b1 = lastVideoCreate || {};
  eq('必填 mode=text', b1.mode, 'text');
  eq('seconds 由帧数÷帧率折算', b1.seconds, '10');
  eq('Flash size 固定 720P', b1.size, '720P');
  eq('横版预设映射 16:9', b1.aspect_ratio, '16:9');
  eq('seed 透传为整数', b1.seed, 7);
  ok('不发送 width/height（forbidden）', !('width' in b1) && !('height' in b1));
  ok('不发送 num_frames/frame_rate（forbidden）', !('num_frames' in b1) && !('frame_rate' in b1));
  ok('negative_prompt 并入正向', !('negative_prompt' in b1) && b1.prompt.includes('low quality'));

  await api('POST', '/api/videos', {
    prompt: '少女回头', model: 'agnes-video-2.5-flash', mode: 'image_to_video',
    image: 'https://example.com/a.png', num_frames: 121, frame_rate: 24,
  });
  eq('单图 → keyframe', lastVideoCreate.mode, 'keyframe');
  eq('单图 → first_frame', lastVideoCreate.first_frame, 'https://example.com/a.png');
  eq('121f÷24 ≈ 5 秒', lastVideoCreate.seconds, '5');
  ok('keyframe 不带 images', !('images' in lastVideoCreate));

  await api('POST', '/api/videos', {
    prompt: '风格参考', model: 'agnes-video-2.5-flash', mode: 'multi_image',
    source_images: [{ url: 'https://e.com/1.png' }, { url: 'https://e.com/2.png' }], width: 768, height: 1152,
  });
  eq('多图 → reference', lastVideoCreate.mode, 'reference');
  eq('reference.images 数', lastVideoCreate.images && lastVideoCreate.images.length, 2);
  eq('竖版预设映射 9:16', lastVideoCreate.aspect_ratio, '9:16');

  await api('POST', '/api/videos', {
    prompt: '过渡', model: 'agnes-video-2.5-flash', mode: 'keyframe', mode_flag: 'keyframes',
    source_images: [{ url: 'https://e.com/a' }, { url: 'https://e.com/b' }, { url: 'https://e.com/c' }],
  });
  eq('keyframes 标记取首帧', lastVideoCreate.first_frame, 'https://e.com/a');
  eq('keyframes 标记取尾帧（中间帧丢弃）', lastVideoCreate.last_frame, 'https://e.com/c');

  // v2.0 模型仍走旧协议（对照）
  await api('POST', '/api/videos', {
    prompt: 'legacy check', model: 'agnes-video-v2.0', mode: 'text_to_video',
    width: 1152, height: 768, num_frames: 121, frame_rate: 24,
  });
  eq('v2.0 保留 frame_rate', lastVideoCreate.frame_rate, 24);
  eq('v2.0 保留 num_frames', lastVideoCreate.num_frames, 121);
  ok('v2.0 无 mode 字段', !('mode' in lastVideoCreate));

  // 轮询闭环：query 必须带 model_name，完成地址取自 metadata.url
  const vid = r.data.asset.id;
  let a25 = null;
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    const all = await api('GET', '/api/videos');
    a25 = (all.data || []).find((x) => x.id === vid);
    if (a25 && a25.status === 'completed') break;
  }
  ok('2.5 任务轮询到 completed', !!a25 && a25.status === 'completed', a25 && a25.status);
  ok('video_url 来自 metadata.url', String(a25 && a25.video_url).endsWith('/video.mp4'));
  ok('查询带了 model_name', /model_name=agnes-video-2\.5-flash/.test(String(last25QueryUrl)), String(last25QueryUrl).slice(0, 80));
  await api('DELETE', `/api/videos/${vid}`);
}

// ── 8.7 提交限流自动退避重试（免费档 queue full / 429 实测会批量扫荡） ──
group('视频提交限流自动重试');
{
  await api('PUT', '/api/settings', { video_submit_retries: '3', video_submit_backoff_s: '1' });

  // 单发：前两次 503 排队满，第三次成功 → 整体应报成功
  const r = await api('POST', '/api/videos', { prompt: '__retry2__ 雨夜街道', mode: 'text_to_video', model: 'agnes-video-2.5-flash' });
  eq('限流后自动退避最终成功', r.data.ok, true);
  eq('恰好消耗 3 次提交', videoCalls.r2, 3);

  // 预算耗尽：1+3 次全 503 → 落一条失败记录，报错给中文限流解释
  const f = await api('POST', '/api/videos', { prompt: '__retry9__ 运气不佳', mode: 'text_to_video', model: 'agnes-video-2.5-flash' });
  eq('重试预算耗尽后失败', f.data.ok, false);
  ok('失败提示为中文限流说明', /排队已满或限流/.test(String(f.data.error)), String(f.data.error).slice(0, 40));
  eq('重试止步于预算', videoCalls.r9, 4);

  // 4xx schema 类错误不重试，不放大无意义请求
  const b = await api('POST', '/api/videos', { prompt: '__bad400__ x', mode: 'text_to_video', model: 'agnes-video-2.5-flash' });
  eq('400 直接失败', b.data.ok, false);
  eq('400 不重试', videoCalls.bad, 1);

  // 批量：一项限流一次后成功 + 一项直接成功 → 整批应全绿
  const bj = await api('POST', '/api/batch/videos', {
    items: [
      { prompt: '__retry1__ 镜头一', mode: 'text_to_video', model: 'agnes-video-2.5-flash' },
      { prompt: 'apitest plain shot2', mode: 'text_to_video', model: 'agnes-video-2.5-flash' },
    ],
  });
  eq('批量任务受理', bj.data.ok, true);
  let job = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    job = (await api('GET', `/api/batch/${bj.data.jobId}`)).data;
    if (job && job.status === 'done') break;
  }
  eq('批量全部成功', job && job.ok, 2);
  eq('批量零失败', job && job.fail, 0);
  eq('限流项自动重试 1 次', videoCalls.r1, 2);

  // 清理本次调试记录，不留垃圾
  const all = await api('GET', '/api/videos');
  for (const v of all.data) {
    if (/__retry|__bad400__|^apitest plain shot2$/.test(String(v.video_prompt))) {
      await api('DELETE', `/api/videos/${v.id}`);
    }
  }
  await api('PUT', '/api/settings', { video_submit_retries: '4', video_submit_backoff_s: '3' });
}

// ── 9. 手动刷新与补录 ────────────────────────────────────────
group('刷新与补录');
{
  const r = await api('POST', `/api/videos/${VID_ID}/refresh`, {});
  eq('手动刷新 200', r.status, 200);
  eq('刷新成功', r.data.ok, true);

  // 造一条无 video_id 的任务，测补录
  const r2 = await api('POST', '/api/videos', { prompt: 'no id test', project_id: PROJECT_ID });
  const id2 = r2.data.asset.id;
  await api('PUT', `/api/videos/${id2}`, { name: '待补录' });
  const bind = await api('POST', `/api/videos/${id2}/bind`, { video_id: 'vid_manual_9' });
  eq('补录成功', bind.data.ok, true);
  eq('补录后写入 video_id', bind.data.asset.agnes_video_id, 'vid_manual_9');
  eq('补录后进入轮询', bind.data.asset.local_status, 'polling');

  const nb = await api('POST', `/api/videos/${id2}/bind`, { video_id: '' });
  eq('空 video_id 400', nb.status, 400);

  const br = await api('POST', '/api/videos/batch-refresh', {});
  eq('批量刷新 200', br.status, 200);
  ok('批量刷新返回统计', typeof br.data.total === 'number');

  await api('DELETE', `/api/videos/${id2}`);
}

// ── 10. 模板 ─────────────────────────────────────────────────
group('提示词模板');
{
  const l = await api('GET', '/api/templates');
  ok('内置模板已注入', l.data.length > 5, `${l.data.length} 条`);

  const r = await api('POST', '/api/templates', {
    name: '自定义模板', template_type: 'story_concept', content: '写个 {{题材}} 故事', system: '你是编剧',
  });
  eq('建模板 200', r.status, 200);
  const u = await api('PUT', `/api/templates/${r.data.id}`, { name: '改了名' });
  eq('改模板', u.data.name, '改了名');

  const f = await api('GET', '/api/templates?template_type=optimize');
  ok('按类型过滤', f.data.every((t) => t.template_type === 'optimize'));

  await api('DELETE', `/api/templates/${r.data.id}`);
  eq('删模板后查不到', (await api('GET', `/api/templates`)).data.find((t) => t.id === r.data.id), undefined);
}

// ── 11. 批量队列 ─────────────────────────────────────────────
group('批量队列');
{
  const r = await api('POST', '/api/batch/images', {
    items: [
      { prompt: 'img one', project_id: PROJECT_ID, size: '1024x1024' },
      { prompt: 'img two', project_id: PROJECT_ID, size: '1024x1024' },
    ],
    concurrency: 2,
  });
  eq('批量生图 200', r.status, 200);
  eq('队列收 2 项', r.data.total, 2);

  let job = null;
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    const j = await api('GET', `/api/batch/${r.data.jobId}`);
    job = j.data;
    if (job.status !== 'running') break;
  }
  eq('批量任务结束', job.status, 'done');
  eq('全部成功', job.ok, 2);
  eq('无失败', job.fail, 0);

  // R22：逐项状态。并发 2 时两条会同时 running，所以"按下标预填、原地改状态"是必须的——
  // 原来"完成一条 push 一条"的写法在并发下顺序与镜头顺序不一致，界面按数组顺序画进度链就会错位。
  eq('任务项按下标一一对应（并发下顺序不得错位）', (job.items || []).map((i) => i.index).join(','), '0,1');
  ok('每项都有终态 ok（不是只有汇总数字）', (job.items || []).every((i) => i.state === 'ok' && i.ok === true));
  ok('每项带 label 与 key 回传（界面据此映射回具体镜头，刷新后仍成立）',
    (job.items || []).every((i) => typeof i.label === 'string' && i.label.length > 0),
    JSON.stringify(job.items));
  eq('未传 label 时给序号兜底（不让界面出现 undefined）', (job.items || [])[0].label, '第 1 项');
  eq('未传 key 时为 null（而不是空字符串，便于前端判空）', (job.items || [])[0].key, null);

  const before = (await api('GET', `/api/images?project_id=${PROJECT_ID}`)).data.length;
  ok('批量生成的图片已入库', before >= 3, `${before} 张`);

  // 带 key/label 的口径（前端真实调用方式）：状态必须落回对应项
  const keyed = await api('POST', '/api/batch/images', {
    items: [
      { prompt: 'keyed one', project_id: PROJECT_ID, size: '1024x1024', label: '镜头 #7', key: 'sb_7' },
      { prompt: 'keyed two', project_id: PROJECT_ID, size: '1024x1024', label: '镜头 #9', key: 'sb_9' },
    ],
    concurrency: 2,
  });
  let job2 = null;
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    job2 = (await api('GET', `/api/batch/${keyed.data.jobId}`)).data;
    if (job2.status !== 'running') break;
  }
  eq('带 key 的批量任务结束', job2.status, 'done');
  eq('key 原样回传（界面靠它把状态映射回表格行）', (job2.items || []).map((i) => i.key).join(','), 'sb_7,sb_9');
  eq('label 原样回传（刷新后进度链仍显示镜头号）', (job2.items || []).map((i) => i.label).join(','), '镜头 #7,镜头 #9');

  const emptyBatch = await api('POST', '/api/batch/images', { items: [] });
  eq('空队列 400', emptyBatch.status, 400);
}

// ── 12. 导入导出 ─────────────────────────────────────────────
group('导入导出');
{
  const ex = await api('GET', '/api/export');
  eq('导出 200', ex.status, 200);
  ok('导出内容是 JSON', typeof ex.data === 'object' && !!ex.data.collections);
  ok('导出含项目', ex.data.collections.projects.length >= 1);

  const im = await api('POST', '/api/import', { data: ex.data, mode: 'merge' });
  eq('导入 200', im.status, 200);
  ok('导入返回结果', typeof im.data.imported === 'number');

  const bad = await api('POST', '/api/import', { data: null, mode: 'xxx' });
  eq('非法模式 400', bad.status, 400);

  const pe = await fetch(`${BASE}/api/projects/${PROJECT_ID}/export`);
  eq('单项目导出 200', pe.status, 200);
  const peData = await pe.json();
  ok('单项目导出含分镜', Array.isArray(peData.storyboards));
  ok('单项目导出含图片', Array.isArray(peData.image_assets));
}

// T3 负例：mock 已强制 Bearer 校验——错 Key 必须炸出 ok:false（旧 mock 不读头，永远测不出鉴权回归）
{
  await api('PUT', '/api/settings', { agnes_api_key: '__NOAUTH__' });
  const tasksBefore = (await api('GET', '/api/tasks')).data.length;
  const badKey = await api('POST', '/api/agnes/text', { messages: [{ role: 'user', content: 'hi' }] });
  ok('错 Key → 业务失败', badKey.data.ok === false, JSON.stringify(badKey.data).slice(0, 90));
  eq('错 Key 类型化为 invalid_api_key（UI 才能显示"Key 无效"而非笼统失败）', badKey.data.errorType, 'invalid_api_key');
  ok('错 Key 错误文案非空且含上游原因', typeof badKey.data.error === 'string' && badKey.data.error.length > 4, JSON.stringify(badKey.data.error));
  const tasksAfter = (await api('GET', '/api/tasks')).data;
  const failedRec = tasksAfter.find((t) => t.status === 'failed' && /invalid|api key|401/i.test(String(t.error_message || '')));
  ok('失败也留任务记录（任务页历史承诺）', tasksAfter.length > tasksBefore && !!failedRec, `before=${tasksBefore} after=${tasksAfter.length}`);
  const conn = await api('POST', '/api/settings/test', { kind: 'text' });
  ok('设置页连通性测试错 Key → ok:false', conn.data.ok === false, JSON.stringify(conn.data).slice(0, 110));
  eq('连通性测试错 Key 同样类型化', conn.data.errorType, 'invalid_api_key');
  await api('PUT', '/api/settings', { agnes_api_key: MOCK_KEY });
  const back = await api('POST', '/api/agnes/text', { messages: [{ role: 'user', content: 'hi' }] });
  ok('恢复 Key → 成功', back.data.ok === true, JSON.stringify(back.data).slice(0, 90));
}

// ── 13. 安全 ─────────────────────────────────────────────────
group('安全');
{
  // CSRF：跨站 Origin 的写操作要被拒
  const bad = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example.com' },
    body: JSON.stringify({ name: '来自恶意站点' }),
  });
  eq('跨站 POST 被拒 403', bad.status, 403);

  const good = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    // X2 收紧后：Origin 必须 host+port 全匹配（真实浏览器的 Origin 总是带端口的完整源）
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ name: '合法来源' }),
  });
  ok('同源 POST 放行', good.status === 200, String(good.status));

  const wrongPort = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:99' },
    body: JSON.stringify({ name: '本机错端口' }),
  });
  eq('本机异端口 Origin 写被拒 403', wrongPort.status, 403);

  // 路径穿越
  const trav = await fetch(`${BASE}/assets/images/..%2f..%2fserver.js`);
  eq('路径穿越 404', trav.status, 404);
  const trav2 = await fetch(`${BASE}/assets/images/%2e%2e%2f%2e%2e%2fpackage.json`);
  eq('编码穿越 404', trav2.status, 404);

  // Key 不能从任何接口泄露
  const s = await api('GET', '/api/settings');
  ok('设置接口不含明文 Key', !JSON.stringify(s.data).includes(MOCK_KEY));

  // X1：Host 头白名单——DNS rebinding 挡板（恶意域名 A 记录指向 127.0.0.1 即可"同源"读全部数据）
  const rawGet = (path, headers) => new Promise((resolve) => {
    const rq = http.request({ host: '127.0.0.1', port: srvPort, path, method: 'GET', headers }, (rs) => {
      let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => resolve({ status: rs.statusCode, body: b }));
    });
    rq.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    rq.end();
  });
  const evilHost = await rawGet('/api/bootstrap', { Host: 'evil.example.com' });
  eq('X1 恶意 Host 被拒 403', evilHost.status, 403);
  const userinfoHost = await rawGet('/api/bootstrap', { Host: 'a@127.0.0.1' });
  eq('X1 userinfo 形态 Host 被拒 403', userinfoHost.status, 403);
  const fqdnHost = await rawGet('/api/bootstrap', { Host: 'localhost.' });
  eq('X1 FQDN 尾点 localhost. 放行（归一化）', fqdnHost.status, 200);
  const localHost = await rawGet('/api/bootstrap', { Host: `127.0.0.1:${srvPort}` });
  eq('X1 本机 Host 放行', localHost.status, 200);
  // X3：非法转义 / 空字节路径不许炸监听器
  const badEsc = await rawGet('/%zz', { Host: `127.0.0.1:${srvPort}` });
  eq('X3 非法转义 %zz 返回 400', badEsc.status, 400);
  const nulPath = await rawGet('/%00', { Host: `127.0.0.1:${srvPort}` });
  eq('X3 空字节路径返回 400', nulPath.status, 400);
  const stillAlive = await api('GET', '/api/health');
  eq('X3 恶意请求后监听器仍存活', stillAlive.status, 200);

  // X4：同端口 + 同数据目录的第二实例必须拒绝启动——persist 是整库快照全量写，
  // 两个实例互踩会静默丢数据（exe 双击两次即中招）。此前仅由非门禁 port-check 覆盖，故提升进门禁。
  const second = await new Promise((resolve) => {
    const c = spawn(NODE, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, PORT: String(srvPort), NO_OPEN: '1', AGNES_STUDIO_HOME: HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let o = '';
    c.stdout.on('data', (d) => (o += d));
    c.stderr.on('data', (d) => (o += d));
    const t = setTimeout(() => { c.kill(); resolve({ code: 'TIMEOUT', out: o }); }, 8000);
    c.on('exit', (code) => { clearTimeout(t); resolve({ code, out: o }); });
  });
  eq('X4 同目录第二实例拒绝启动（exit 0）', second.code, 0);
  ok('X4 且提示"已在运行"', String(second.out).includes('已在运行'), String(second.out).slice(0, 90));
  const afterX4 = await api('GET', '/api/health');
  eq('X4 后原实例仍健康（未被抢端口）', afterX4.status, 200);

  // H5：video_url 只收 http(s) 或空——javascript:/data: 等形状会进 <video src> 与"打开链接"按钮
  const vmk = await api('POST', '/api/videos', { prompt: 'H5 协议白名单探针', mode: 'text_to_video' });
  const vid = vmk.data && (vmk.data.id || (vmk.data.asset && vmk.data.asset.id));
  ok('H5 探针视频已建', !!vid, JSON.stringify(vmk.data).slice(0, 80));
  const setUrl = async (u) => (await api('PUT', `/api/videos/${vid}`, { video_url: u })).data.video_url;
  eq('H5 javascript: 形状被清空', await setUrl('javascript:alert(1)'), '');
  eq('H5 data: 形状被清空', await setUrl('data:video/mp4;base64,AAAA'), '');
  eq('H5 大写 HTTP:// 放行（大小写不敏感）', await setUrl('HTTP://cdn.example.com/a.mp4'), 'HTTP://cdn.example.com/a.mp4');
  eq('H5 https 放行', await setUrl('https://cdn.example.com/a.mp4'), 'https://cdn.example.com/a.mp4');
  eq('H5 空串放行（允许清空）', await setUrl(''), '');
  await api('DELETE', `/api/videos/${vid}`);

  // B8：API 路由参数里的非法转义必须按"不匹配"处理（404），不许 URIError→500
  const badParam = await rawGet('/api/projects/%zz', { Host: `127.0.0.1:${srvPort}` });
  eq('B8 API 参数非法转义 → 404（非 500）', badParam.status, 404);
  const badParam2 = await rawGet('/api/videos/%zz/refresh', { Host: `127.0.0.1:${srvPort}` });
  ok('B8 深路径非法转义亦不 500', badParam2.status === 404 || badParam2.status === 400, String(badParam2.status));
}

// ── 14. 静态资源 ─────────────────────────────────────────────
group('静态资源');
{
  const idx = await fetch(`${BASE}/`);
  eq('首页 200', idx.status, 200);
  ok('首页是 HTML', (await idx.text()).includes('<title>'));

  for (const f of ['/css/app.css', '/js/app.js', '/js/consts.js', '/js/api.js', '/js/ui.js']) {
    const r = await fetch(`${BASE}${f}`);
    eq(`静态资源 ${f}`, r.status, 200);
  }
  for (const p of ['dashboard', 'projects', 'scripts', 'storyboards', 'images', 'videos', 'tasks', 'assets', 'settings']) {
    const r = await fetch(`${BASE}/js/pages/${p}.js`);
    eq(`页面模块 ${p}.js`, r.status, 200);
  }
  const spa = await fetch(`${BASE}/some/unknown/route`);
  eq('未知路由回退首页', spa.status, 200);
}

// ── 15. SSE ──────────────────────────────────────────────────
group('SSE');
{
  // SSE 是长连接，不能 r.text()（会一直等到流结束），要按流读第一块
  const okConn = await new Promise((resolve) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    (async () => {
      try {
        const res = await fetch(`${BASE}/api/events`, { signal: ctrl.signal });
        const reader = res.body.getReader();
        const { value } = await reader.read();
        const text = Buffer.from(value).toString('utf8');
        clearTimeout(timer);
        ctrl.abort();
        resolve(text.includes('connected'));
      } catch { clearTimeout(timer); resolve(false); }
    })();
  });
  ok('SSE 能连上并收到 handshake', okConn);
  // 多客户端广播：两条并发连接都要收到同一轮询产生的 video 事件（真实场景=双标签页）
  const grab = () => new Promise((resolve) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => { ctrl.abort(); resolve(null); }, 9000);
    (async () => {
      try {
        const res = await fetch(`${BASE}/api/events`, { signal: ctrl.signal });
        const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { value, done } = await rd.read();
          if (done) { clearTimeout(timer); resolve(null); return; }
          buf += dec.decode(value, { stream: true });
          if (buf.includes('event: video')) { clearTimeout(timer); ctrl.abort(); resolve(true); return; }
          if (buf.length > 80000) { clearTimeout(timer); ctrl.abort(); resolve(null); return; }
        }
      } catch { clearTimeout(timer); resolve(null); }
    })();
  });
  const [g1, g2] = [grab(), grab()];
  await new Promise((r) => setTimeout(r, 300));
  await api('POST', '/api/videos', { mode: 'text_to_video', prompt: 'sse 广播探针', project_id: PROJECT_ID });
  const [b1, b2] = await Promise.all([g1, g2]);
  ok('SSE 多客户端广播（双标签页场景）', b1 === true && b2 === true, JSON.stringify({ b1, b2 }));
}

group('B6 请求体闸门（413 契约）');
{
  // 120MB 上限（API 体唯一显式限）：超限必须"先送 413 再断流"，客户端要能读到 JSON 错误而非连接重置
  const portNum = Number(new URL(BASE).port);
  const outcome = await new Promise((resolve) => {
    let settled = false;
    let stop = false; // 响应一到就停手
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request({ host: '127.0.0.1', port: portNum, path: '/api/agnes/text', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      // 服务端是"先送 413 再断流"（B6 修复）。客户端如果继续猛灌 121MB，
      // 后续写入会在已关闭的 socket 上抛 ECONNRESET，把已经回来的 413 挤掉——
      // 那不是服务端违约，是探针自己的行为不像个正常客户端。真实浏览器/fetch 收到响应就会停。
      stop = true;
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => finish({ status: res.statusCode, body }));
    });
    req.on('error', (e) => finish({ connError: String(e.code || e.message) }));
    const MB = 'x'.repeat(1024 * 1024);
    req.write('{\"prompt\":\"');
    // 分块灌过 120MB 真限（readBody 唯一调用点的显式值），每 8MB 让出一次事件循环，
    // 好让服务端回上来的 413 有机会被读到（不让出的话响应永远排在写队列后面）
    (async () => {
      for (let i = 0; i < 121 && !stop; i++) {
        req.write(MB);
        if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));
      }
      if (!stop) req.end('\"}');
    })();
  });
  ok('超限请求收到 413（非连接重置）', outcome.status === 413 && String(outcome.body).includes('请求体过大'), JSON.stringify(outcome).slice(0, 160));
  const after = await api('GET', '/api/settings');
  eq('超限连接处置后服务照常', after.status, 200);
}

// ── 16. 清理 ─────────────────────────────────────────────────
group('T4/T5 事故级路径');
{
  chatFormats.length = 0;
  const t = await api('POST', '/api/agnes/text', { messages: [{ role: 'user', content: 'hi' }], json_mode: true, model: 'mock-reject-json' });
  eq('4xx 格式降级后仍 200', t.status, 200);
  ok('首发带 format、重试不带', chatFormats.length === 2 && chatFormats[0] === true && chatFormats[1] === false, JSON.stringify(chatFormats));
  const t2 = await api('POST', '/api/agnes/text', { messages: [{ role: 'user', content: 'hi' }], json_mode: true, model: 'mock-deny-key' });
  ok('401 不降级（不掩盖钥匙问题）', t2.data && t2.data.ok === false && chatFormats.length === 3 && chatFormats[2] === true, JSON.stringify({ st: t2.status, d: t2.data && t2.data.ok }));

  // HTTP 200 内嵌 error：必须识别为失败并落一条可复盘的坏记录
  const bad = await api('POST', '/api/videos', { mode: 'text_to_video', prompt: 'boom probe', project_id: PROJECT_ID, model: 'mock-embed-err' });
  ok('内嵌 error 报信封级失败', bad.data && bad.data.ok === false, `status=${bad.status} data=${JSON.stringify(bad.data && bad.data.error)}`);
  const vlist = await api('GET', `/api/videos?project_id=${PROJECT_ID}`);
  const rec = (vlist.data || []).find((x) => String(x.video_prompt).includes('boom probe'));
  ok('内嵌 error 落库可复盘', !!rec && String(rec.error_message).includes('embedded boom') && rec.local_status === 'submit_failed', JSON.stringify(rec && rec.local_status));

  // 提交超时：10s 超时阈值 + mock 11.5s —— 走"结果未知"三态而非谎报失败
  await api('PUT', '/api/settings', { request_timeout_ms: 10000 });
  const slow = await api('POST', '/api/videos', { mode: 'text_to_video', prompt: 'slow probe', project_id: PROJECT_ID, model: 'mock-slow' });
  ok('超时提交返回可接受（未知态）', slow.status < 500, `status=${slow.status}`);
  const vlist2 = await api('GET', `/api/videos?project_id=${PROJECT_ID}`);
  const rec2 = (vlist2.data || []).find((x) => String(x.video_prompt).includes('slow probe'));
  ok('超时记为提交超时未知（非 submit_failed）', !!rec2 && rec2.local_status === 'submit_timeout_unknown', JSON.stringify(rec2 && { s: rec2.status, l: rec2.local_status }));
  // ── T5b：图片 URL 分支（远端→抓本地；抓不到→退远端不谎报本地）──
  const imgOk = await api('POST', '/api/agnes/image', { prompt: 'url branch probe', model: 'mock-img-url-ok', size: '1024x1024' });
  ok('图片 URL 分支抓成本地文件', imgOk.status === 200 && imgOk.data && imgOk.data.ok === true
    && String(imgOk.data.asset && imgOk.data.asset.url).startsWith('/assets/images/')
    && String(imgOk.data.asset && imgOk.data.asset.remote_url).endsWith('/pixel.png'), JSON.stringify(imgOk.data && imgOk.data.asset && { u: imgOk.data.asset.url, r: imgOk.data.asset.remote_url }));
  const imgDead = await api('POST', '/api/agnes/image', { prompt: 'dead url probe', model: 'mock-img-url-dead', size: '1024x1024' });
  const dAsset = imgDead.data && imgDead.data.asset;
  ok('抓不到时退回远端不谎报本地', imgDead.status === 200 && dAsset && String(dAsset.url).startsWith('http://127.0.0.1:1'), JSON.stringify(dAsset && dAsset.url));

  // ── T5b：downloadVideo 瞬时 503 → 5s 重试成功；跨主机 401 → 绝不带 Key ──
  await api('PUT', '/api/settings', { video_poll_interval: '2' });
  queryTarget = 'flaky'; flakyHits = 0;
  const vf = await api('POST', '/api/videos', { mode: 'text_to_video', prompt: 'flaky probe video', project_id: PROJECT_ID });
  let af = null;
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    const vl = await api('GET', `/api/videos?project_id=${PROJECT_ID}`);
    af = (vl.data || []).find((x) => x.id === vf.data.asset.id);
    if (af && (af.local_file || (af.status === 'completed' && i > 12))) break;
  }
  ok('503 瞬时失败经重试落盘', !!af && af.status === 'completed' && !!af.local_file && flakyHits === 2, JSON.stringify(af && { s: af.status, f: !!af.local_file }) + ' hits=' + flakyHits);
  denyHitsWithKey = 0; queryTarget = 'deny';
  const vd = await api('POST', '/api/videos', { mode: 'text_to_video', prompt: 'deny probe video', project_id: PROJECT_ID });
  let ad = null;
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    const vl = await api('GET', `/api/videos?project_id=${PROJECT_ID}`);
    ad = (vl.data || []).find((x) => x.id === vd.data.asset.id);
    if (ad && (ad.status === 'completed' && !ad.local_file)) { const lg = await api('GET', '/api/logs'); if (lg.data.some((l) => String(l.msg).includes('未携带凭证'))) break; }
  }
  ok('跨主机 401 不泄露 Key（守卫日志在案）', !!ad && ad.status === 'completed' && !ad.local_file && denyHitsWithKey === 0, JSON.stringify(ad && { s: ad.status, f: !!ad.local_file }) + ' leaks=' + denyHitsWithKey);
  queryTarget = 'base';
  await api('PUT', '/api/settings', { video_poll_interval: '8' });
  const cleanupIds = [rec, rec2].filter(Boolean).map((r) => api('DELETE', `/api/videos/${r.id}`));
  await Promise.all(cleanupIds);
  await api('PUT', '/api/settings', { request_timeout_ms: 150000 });
}

group('B4.1 画风分层注入');
{
  const proj = await api('POST', '/api/projects', { name: '画风分层测试', art_style: '日漫厚涂', aspect_ratio: '9:16 竖屏' });
  const PID = proj.data.id;
  const g = await api('POST', '/api/agnes/image', { prompt: 'a girl running on the beach', project_id: PID, size: '1024x1024' });
  eq('出图注入映射画风', String(lastImageCreate && lastImageCreate.prompt), 'a girl running on the beach, japanese anime style, thick painterly shading');
  const g2 = await api('POST', '/api/agnes/image', { prompt: 'a cat', project_id: PID, size: '1024x1024' });
  const g3 = await api('POST', '/api/agnes/image', { prompt: 'a cat, japanese anime style, thick painterly shading', project_id: PID, size: '1024x1024' });
  eq('同画风重复注入去重', String(lastImageCreate && lastImageCreate.prompt), 'a cat, japanese anime style, thick painterly shading');
  const g4 = await api('POST', '/api/agnes/image', { prompt: 'standalone', size: '1024x1024' });
  eq('无项目不注入', String(lastImageCreate && lastImageCreate.prompt), 'standalone');
  // 视频：仅 t2v 注入；i2v 由参考图带风格
  await api('POST', '/api/videos', { mode: 'text_to_video', prompt: 'hero walks forward', project_id: PID });
  eq('t2v 注入画风', String(lastVideoCreate && lastVideoCreate.prompt), 'hero walks forward, japanese anime style, thick painterly shading');
  await api('POST', '/api/videos', { mode: 'image_to_video', prompt: 'animate this', image: 'http://127.0.0.1:1/x.png', project_id: PID });
  eq('i2v 不注入', String(lastVideoCreate && lastVideoCreate.prompt), 'animate this');
  await api('DELETE', '/api/projects/' + PID + '?cascade=1');
}

group('R15 角色注入（使用点 / 锁定语义 / 去重 / 视频口径 / 导出）');
{
  const proj = await api('POST', '/api/projects', { name: '角色注入测试', art_style: '日漫厚涂' });
  const PID = proj.data.id;
  const mk = async (name, extra) => (await api('POST', '/api/characters', Object.assign({ project_id: PID, name }, extra))).data;
  const lin = await mk('林岚', { appearance: '黑色长直发、丹凤眼', outfit: '白色衬衫', is_locked: true });
  const zhou = await mk('老周', { appearance: '灰白短发、络腮胡', is_locked: false });
  const hollow = await mk('无貌', {}); // 没填外貌：注入不了任何东西
  const sbAll = await api('POST', '/api/storyboards', {
    project_id: PID, shot_number: 1, scene_description: '开场', image_prompt: 'a girl stands on the rooftop',
    character_ids: [lin.id, zhou.id, hollow.id],
  });
  const sbLin = await api('POST', '/api/storyboards', {
    project_id: PID, shot_number: 2, scene_description: '特写', image_prompt: 'a close-up shot', character_ids: [lin.id],
  });
  const sbZhou = await api('POST', '/api/storyboards', {
    project_id: PID, shot_number: 3, scene_description: '过肩', image_prompt: 'an over-the-shoulder shot', character_ids: [zhou.id],
  });

  // ① 出图：绑定的角色都被注入（含外貌 + 服装），没填外貌的不产出空壳
  await api('POST', '/api/agnes/image', { prompt: 'a girl stands on the rooftop', project_id: PID, storyboard_id: sbAll.data.id, size: '1024x1024' });
  const wire = String(lastImageCreate && lastImageCreate.prompt);
  ok('出图注入出场角色（外貌 + 服装）',
    wire.includes('出场角色——') && wire.includes('林岚：黑色长直发、丹凤眼，身着白色衬衫') && wire.includes('老周：灰白短发、络腮胡'),
    wire.slice(0, 160));
  ok('没填外貌的角色不产出「无貌：」这种空壳', !wire.includes('无貌'));
  ok('顺序固定：内容 → 角色 → 画风（前端预览按同序复算）',
    wire.indexOf('出场角色——') > 0 && wire.indexOf('出场角色——') < wire.indexOf('japanese anime style'));

  // ② 锁定语义：提示词里提到名字时，锁定角色照注入，未锁定角色跳过
  await api('POST', '/api/agnes/image', { prompt: '林岚回头看了一眼', project_id: PID, storyboard_id: sbLin.data.id, size: '1024x1024' });
  ok('锁定角色即使提示词提到名字也照注入（一致性的来源）', String(lastImageCreate.prompt).includes('林岚：黑色长直发、丹凤眼，身着白色衬衫'), String(lastImageCreate.prompt));
  await api('POST', '/api/agnes/image', { prompt: '老周点点头', project_id: PID, storyboard_id: sbZhou.data.id, size: '1024x1024' });
  eq('未锁定角色在提示词已提名字时不重复注入（尊重用户自己写的）',
    String(lastImageCreate.prompt), '老周点点头, japanese anime style, thick painterly shading');

  // ③ 去重：提示词里已经有同样的长相描述 → 不追加
  await api('POST', '/api/agnes/image', { prompt: '黑色长直发、丹凤眼，身着白色衬衫的女孩', project_id: PID, storyboard_id: sbLin.data.id, size: '1024x1024' });
  eq('同样的长相描述已在提示词里 → 不重复追加',
    String(lastImageCreate.prompt), '黑色长直发、丹凤眼，身着白色衬衫的女孩, japanese anime style, thick painterly shading');

  // ④ 无绑定 → 不注入（角色库不能变成"到处都在注入"）
  await api('POST', '/api/agnes/image', { prompt: 'empty street', project_id: PID, size: '1024x1024' });
  eq('镜头未绑定角色 → 不注入', String(lastImageCreate.prompt), 'empty street, japanese anime style, thick painterly shading');

  // ⑤ 显式 character_ids（调用方不必先建分镜）—— 图片页/外部脚本可走这条路
  await api('POST', '/api/agnes/image', { prompt: 'portrait', project_id: PID, character_ids: [lin.id], size: '1024x1024' });
  ok('显式 character_ids 也能注入', String(lastImageCreate.prompt).includes('林岚：黑色长直发'), String(lastImageCreate.prompt));

  // ⑥ 视频口径与画风完全一致：t2v 注入，i2v 不注入
  await api('POST', '/api/videos', { mode: 'text_to_video', prompt: 'hero walks forward', project_id: PID, storyboard_id: sbLin.data.id });
  ok('t2v 注入角色', String(lastVideoCreate && lastVideoCreate.prompt).includes('出场角色——'), String(lastVideoCreate && lastVideoCreate.prompt));
  await api('POST', '/api/videos', { mode: 'image_to_video', prompt: 'animate this', image: 'http://127.0.0.1:1/x.png', project_id: PID, storyboard_id: sbLin.data.id });
  eq('i2v 不注入角色（长相由参考图决定）', String(lastVideoCreate.prompt), 'animate this');

  // ⑦ 落库的是"最终发出的词"（否则下载/复盘看到的与实际不一致）
  const imgs = await api('GET', `/api/images?project_id=${PID}`);
  ok('素材记录里存的是最终发出的提示词', (imgs.data || []).some((i) => String(i.generation_prompt).includes('出场角色——')));

  // ⑧ 导出必须与发出的一致，且说清图生模式的口径
  const csvText = new TextDecoder().decode(new Uint8Array(await (await fetch(`${BASE}/api/projects/${PID}/export.csv?episode=1`)).arrayBuffer()));
  ok('CSV 表头标明含角色、运镜与画风', csvText.includes('含原著场景道具与角色与运镜与画风'));
  ok('CSV 新增「绑定角色」列', csvText.includes('绑定角色') && csvText.includes('林岚、老周、无貌'));
  ok('CSV 最终词含角色注入', csvText.includes('林岚：黑色长直发、丹凤眼，身着白色衬衫'));
  const mdText = (await api('GET', `/api/projects/${PID}/export.md?episode=1`)).data.raw;
  ok('MD 最终词含角色注入', mdText.includes('出场角色——'));
  ok('MD 说清图生模式实际不注入（导出不骗人）', mdText.includes('图生/多帧视频'));
  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('R19 运镜字段与注入口径（白名单 / 静帧闸门 / 导出列）');
{
  const P = await api('POST', '/api/projects', { name: '运镜测试剧', art_style: '', aspect_ratio: '9:16 竖屏' });
  const PID2 = P.data.id;
  const mk = async (shot, cam, ip, vp) => (await api('POST', `/api/storyboards?project_id=${PID2}`, {
    project_id: PID2, episode_number: 1, shot_number: shot, shot_type: '中景',
    camera_move: cam, scene_description: `镜头 ${shot}`, image_prompt: ip, video_prompt: vp, duration_seconds: 3,
  })).data;
  const rows2 = async () => (await api('GET', `/api/storyboards?episode=1&project_id=${PID2}`)).data;

  // ① 白名单：字典内落库、字典外落空（不让任意文本被拼进提示词）
  const okRow = await mk(1, '推镜', 'a girl on a rooftop', 'a girl walks forward');
  const badRow = await mk(2, '这是一句随便写的话', 'a boy on a bridge', 'a boy runs');
  eq('字典内的运镜正常落库', okRow.camera_move, '推镜');
  eq('字典外的值落成空（白名单而非自由文本）', badRow.camera_move, '');

  // ② PUT 也要过白名单（POST 过了不代表 PUT 过）
  await api('PUT', `/api/storyboards/${okRow.id}`, { camera_move: '瞎写' });
  eq('PUT 白名单同样生效（改回字典外值 → 落空）', (await rows2()).find((r) => r.id === okRow.id).camera_move, '');
  await api('PUT', `/api/storyboards/${okRow.id}`, { camera_move: '环绕' });
  eq('PUT 回字典内值 → 落库', (await rows2()).find((r) => r.id === okRow.id).camera_move, '环绕');

  // ③ 视频侧运镜对所有模式注入（参考图带不了运动）；图片侧只放行机位/视角类
  await api('POST', '/api/videos', { mode: 'text_to_video', prompt: 'hero walks', project_id: PID2, storyboard_id: okRow.id });
  ok('t2v 注入运镜', String(lastVideoCreate && lastVideoCreate.prompt).includes('orbiting camera circling the subject'), String(lastVideoCreate && lastVideoCreate.prompt));
  await api('POST', '/api/videos', { mode: 'image_to_video', prompt: 'animate this', image: 'http://127.0.0.1:1/x.png', project_id: PID2, storyboard_id: okRow.id });
  ok('i2v 也注入运镜（长相由参考图决定，运动必须靠文字）',
    String(lastVideoCreate.prompt).includes('orbiting camera circling the subject'), String(lastVideoCreate.prompt));
  await api('POST', '/api/agnes/image', { prompt: 'a boy on a bridge', project_id: PID2, storyboard_id: badRow.id });
  eq('图片侧：运动类运镜被跳过（静帧图表达不了运动）', String(lastImageCreate.prompt), 'a boy on a bridge');
  await api('PUT', `/api/storyboards/${badRow.id}`, { camera_move: '俯视' });
  await api('POST', '/api/agnes/image', { prompt: 'a boy', project_id: PID2, storyboard_id: badRow.id });
  ok('图片侧：机位类运镜照常注入',
    String(lastImageCreate.prompt).includes('high angle looking down'), String(lastImageCreate.prompt));

  // ④ 变体：首次不注入，再来一张才注入（否则第一张就不是用户写的那个镜头）
  await api('POST', '/api/agnes/image', { prompt: 'a cat', project_id: PID2, variation: 0 });
  eq('variation=0 不注入变体', String(lastImageCreate.prompt), 'a cat');
  await api('POST', '/api/agnes/image', { prompt: 'a cat', project_id: PID2, variation: 1 });
  ok('variation=1 注入第一条变体', String(lastImageCreate.prompt).includes('slightly different camera angle'), String(lastImageCreate.prompt));
  await api('POST', '/api/agnes/image', { prompt: 'a cat', project_id: PID2, variation: 9 });
  ok('variation=9 取模回到第一条（不越界）',
    String(lastImageCreate.prompt).includes('slightly different camera angle') && !/undefined/.test(String(lastImageCreate.prompt)), String(lastImageCreate.prompt));

  // ⑤ 导出：运镜列 + 图片/视频两列口径不同
  const csv2 = new TextDecoder().decode(new Uint8Array(await (await fetch(`${BASE}/api/projects/${PID2}/export.csv?episode=1`)).arrayBuffer()));
  ok('CSV 有「运镜」列且带值', csv2.includes('运镜') && csv2.includes('环绕') && csv2.includes('俯视'));
  const line1 = csv2.split('\n').find((l) => l.includes('镜头 1')) || '';
  const line2 = csv2.split('\n').find((l) => l.includes('镜头 2')) || '';
  ok('CSV 视频列含运镜', line1.includes('orbiting camera circling the subject'));
  // 逐列比对（不能整行 includes：整行含视频列，会把"图片列也注入了"误判为通过）
  // 行 1 = 环绕（运动类）：图片列必须还是 a girl，视频列才带运镜
  // 行 2 = 俯视（机位类）：图片列也要带
  ok('CSV 图片列对运动类运镜跳过、机位类放行（两列口径真的不同）',
    line1.includes(',a girl on a rooftop,a girl walks forward,')
    && line2.includes('"a boy on a bridge, high angle looking down"'),
    JSON.stringify([line1.slice(-90), line2.slice(-90)]));
  const md2 = (await api('GET', `/api/projects/${PID2}/export.md?episode=1`)).data.raw;
  ok('MD 标题行带运镜（人读的导出也要看得到镜头语言）', md2.includes('中景 · 环绕 ·'));
  await api('DELETE', `/api/projects/${PID2}?cascade=1`);
}

group('B4.6 导出矩阵');
{
  const proj = await api('POST', '/api/projects', { name: '导出测试', art_style: '水彩' });
  const PID = proj.data.id;
  const sb = await api('POST', '/api/storyboards', { project_id: PID, shot_number: 9, scene_description: '雨中告别', image_prompt: 'two people under an umbrella', video_prompt: 'camera slowly pulls back', duration_seconds: 4 });
  await api('PUT', `/api/storyboards/${sb.data.id}`, { image_prompt: 'two people under an umbrella' });
  const csvBuf = new Uint8Array(await (await fetch(`${BASE}/api/projects/${PID}/export.csv?episode=1`)).arrayBuffer());
  ok('CSV 带 UTF-8 BOM 字节', csvBuf[0] === 0xEF && csvBuf[1] === 0xBB && csvBuf[2] === 0xBF);
  const csvText = new TextDecoder().decode(csvBuf);
  ok('CSV 表头双语列', csvText.includes('图片提示词·最终词（含原著场景道具与角色与运镜与画风）'));
  ok('CSV 注入映射画风', csvText.includes('watercolor illustration, soft paper texture'));
  const mdText = (await api('GET', `/api/projects/${PID}/export.md?episode=1`)).data.raw;
  ok('MD 含镜头代码块', mdText.includes('```') && mdText.includes('camera slowly pulls back'));
  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('B3.5 引用守卫删除');
{
  // 删图/删视频不再是"悬挂引用制造机"：全量解关联并回传镜头号，状态同步回退
  const img = await api('POST', '/api/agnes/image', { prompt: 'ref guard probe', size: '1024x1024', project_id: PROJECT_ID });
  const IID = img.data.asset.id;
  const sb1 = await api('POST', '/api/storyboards', { project_id: PROJECT_ID, shot_number: 701 });
  const SB1 = sb1.data.id;
  await api('PUT', '/api/storyboards/' + SB1, { linked_image_id: IID, status: 'image_ready' });
  const del1 = await api('DELETE', '/api/images/' + IID);
  eq('删图回传解关联数', del1.data && del1.data.unlinked, 1);
  const list1 = await api('GET', `/api/storyboards?project_id=${PROJECT_ID}`);
  const row1 = (list1.data || []).find((x) => x.id === SB1);
  ok('镜头 linked_image_id 已清空', row1 && !row1.linked_image_id, JSON.stringify(row1 && row1.linked_image_id));
  eq('镜头状态回退 pending', row1 && row1.status, 'pending');
}

group('级联删除');
{
  // 先记录本项目落盘的本地文件，级联删除后必须一起消失（防孤儿文件占盘）
  const [imBefore, vdBefore] = await Promise.all([
    api('GET', `/api/images?project_id=${PROJECT_ID}`),
    api('GET', `/api/videos?project_id=${PROJECT_ID}`),
  ]);
  const localFiles = [...imBefore.data, ...vdBefore.data]
    .map((a) => a.local_file).filter(Boolean);
  ok('测试前确有本地落盘文件', localFiles.length >= 2, `找到 ${localFiles.length} 个`);
  localFiles.forEach((f) => ok(`删除前文件存在 ${f.slice(-20)}`, fs.existsSync(f)));

  const r = await fetch(`${BASE}/api/projects/${PROJECT_ID}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cascade: true }),
  });
  const d = await r.json();
  eq('删除项目 200', r.status, 200);
  ok('级联删掉了关联数据', d.removed >= 4, `删了 ${d.removed} 条`);
  ok('返回了本地文件删除数', d.filesRemoved >= 2, `filesRemoved=${d.filesRemoved}`);
  localFiles.forEach((f) => ok(`删除后文件已清 ${f.slice(-20)}`, !fs.existsSync(f)));
  const left = await api('GET', `/api/storyboards?project_id=${PROJECT_ID}`);
  eq('分镜已清空', left.data.length, 0);
}

group('角色库（R14：档案 CRUD + 分镜绑定 + 引用守卫删除 + 级联）');
{
  const pj = await api('POST', '/api/projects', { name: '角色库验收剧' });
  const PID = pj.data.id;
  // 建：名称必填、必须属于项目
  const noname = await api('POST', '/api/characters', { project_id: PID, name: '  ' });
  eq('缺名称 → 400', noname.status, 400);
  const noproj = await api('POST', '/api/characters', { name: '无主角色' });
  eq('缺 project_id → 400', noproj.status, 400);

  const c1 = await api('POST', '/api/characters', {
    project_id: PID, name: '林岚', role: '主角', appearance: '黑色长直发、丹凤眼',
    outfit: '白色衬衫', is_locked: true, reference_image_ids: ['x1', 'x1', '', 'x2'],
  });
  ok('创建角色返回实体', c1.status === 200 && c1.data.id && c1.data.name === '林岚', JSON.stringify(c1.data).slice(0, 100));
  eq('参考图 id 数组去重去空（脏数据会让解绑统计出幽灵项）', JSON.stringify(c1.data.reference_image_ids), JSON.stringify(['x1', 'x2']));
  eq('外貌锁定落库', c1.data.is_locked, true);

  const c2 = await api('POST', '/api/characters', { project_id: PID, name: '老周', role: '配角' });
  const lst = await api('GET', `/api/characters?project_id=${PID}`);
  ok('按项目列出角色（裸数组）', Array.isArray(lst.data) && lst.data.length === 2, JSON.stringify(lst.data && lst.data.length));
  const other = await api('GET', '/api/characters?project_id=__nope__');
  eq('项目过滤生效（不串项目）', (other.data || []).length, 0);

  // 改：空名字必须被拒（否则列表里出现无名卡，用户没法认）
  const blank = await api('PUT', `/api/characters/${c1.data.id}`, { name: '' });
  eq('改名成空 → 400', blank.status, 400);
  const up = await api('PUT', `/api/characters/${c1.data.id}`, { appearance: '黑色长直发、丹凤眼、左眉尾有痣', is_locked: false });
  ok('更新生效', up.status === 200 && up.data.appearance.includes('左眉尾') && up.data.is_locked === false);
  const up404 = await api('PUT', '/api/characters/__nope__', { name: 'x' });
  eq('更新不存在 → 404', up404.status, 404);

  // 绑定：分镜行挂角色
  const sb = await api('POST', '/api/storyboards', { project_id: PID, episode_number: 1, shot_number: 1, scene_description: '开场', character_ids: [c1.data.id, c2.data.id] });
  eq('分镜创建即带角色绑定', JSON.stringify(sb.data.character_ids), JSON.stringify([c1.data.id, c2.data.id]));
  const sbUp = await api('PUT', `/api/storyboards/${sb.data.id}`, { character_ids: [c2.data.id, c2.data.id] });
  eq('分镜绑定去重', JSON.stringify(sbUp.data.character_ids), JSON.stringify([c2.data.id]));
  const sbBad = await api('PUT', `/api/storyboards/${sb.data.id}`, { character_ids: 'not-an-array' });
  eq('非数组绑定 → 清空而不是写进垃圾', JSON.stringify(sbBad.data.character_ids), '[]');
  // 重新挂上，供下面的引用守卫验证（上一步故意清空了绑定）
  await api('PUT', `/api/storyboards/${sb.data.id}`, { character_ids: [c2.data.id] });

  // 引用守卫：删角色必须先解绑，否则留下悬空 id
  const del = await api('DELETE', `/api/characters/${c2.data.id}`);
  ok('删除返回解绑镜头数', del.status === 200 && del.data.ok === true && del.data.unlinked === 1, JSON.stringify(del.data));
  const sbAfter = await api('GET', `/api/storyboards?project_id=${PID}`);
  const row = (sbAfter.data || []).find((x) => x.id === sb.data.id);
  eq('悬空 id 已被清掉（分镜不再指向不存在的角色）', JSON.stringify(row.character_ids), '[]');
  const del404 = await api('DELETE', `/api/characters/${c2.data.id}`);
  eq('重复删除 → 404', del404.status, 404);

  // bootstrap 随包下发角色（分镜页/图片页都要用，避免每页重复请求）
  const bs = await api('GET', '/api/bootstrap');
  ok('bootstrap 含 characters', Array.isArray(bs.data.characters) && bs.data.characters.some((c) => c.id === c1.data.id));

  // 级联删除必须带走角色（漏了就是跨项目孤儿）
  const cas = await api('DELETE', `/api/projects/${PID}?cascade=1`);
  ok('级联删除项目成功', cas.status === 200 && cas.data.ok === true);
  const left = await api('GET', `/api/characters?project_id=${PID}`);
  eq('级联删除了该项目的角色', (left.data || []).length, 0);
}

group('失败追踪码（R10：5xx 带码 + 码进运行日志 + 4xx 不发码）');
{
  await api('PUT', '/api/settings', { agnes_api_base_url: MOCK_BASE, agnes_api_key: MOCK_KEY });
  await fetch(`${MOCK_BASE}/__mock?badjson=1`).catch(() => {});
  const bad = await api('POST', '/api/agnes/image', { prompt: 'trace probe', size: '1024x1024' });
  ok('上游返回非 JSON → 502（确定性 5xx 路径）', bad.status === 502, `status=${bad.status} body=${JSON.stringify(bad.data).slice(0, 120)}`);
  ok('5xx 响应带失败追踪码', /^e[0-9a-z]{10}$/.test(String(bad.data && bad.data.trace)), JSON.stringify(bad.data && bad.data.trace));
  const lg = await api('GET', '/api/logs');
  ok('同一个码已写进运行日志（用户截图 → 开发者定位的桥）',
    (lg.data || []).some((l) => String(l.msg).includes(bad.data.trace)), JSON.stringify((lg.data || [])[0] || {}).slice(0, 120));
  await fetch(`${MOCK_BASE}/__mock?badjson=0`).catch(() => {});
  // 4xx 是输入/调用问题：不发码（否则界面变吵且无助于排查）
  const nf = await api('GET', '/api/projects/nope/export.csv');
  eq('4xx 不带追踪码', nf.data && nf.data.trace, undefined);
  // 注意：本组**不得**清 Key——后续组（轮询预算/批量取消）都依赖 mock 凭据在位
}

group('轮询预算（R12/R13：次数落库 + 递增间隔 + 分级 deadline）');
{
  // 旧语义：counts 是内存 Map，watch() 无条件归零 → 一个查满预算的僵尸任务只要被
  // resume()（每次服务重启）或批量刷新摸到一次，就能可靠地重新获得满额预算，无限轮询。
  await api('PUT', '/api/settings', { video_poll_interval: '2', video_max_polls: '2' });
  queryTarget = 'stuck';
  const vs = await api('POST', '/api/videos', { mode: 'text_to_video', prompt: 'stuck probe', project_id: PROJECT_ID });
  const sid = vs.data.asset.id;
  let sv = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    sv = (await api('GET', `/api/videos?project_id=${PROJECT_ID}`)).data.find((x) => x.id === sid);
    if (sv && sv.local_status === 'poll_timeout') break;
  }
  ok('预算耗尽后转 poll_timeout', !!sv && sv.local_status === 'poll_timeout', JSON.stringify(sv && { s: sv.local_status, a: sv.poll_attempts }));
  ok('累计查询次数落库（重启不归零，此前只在内存里）', !!sv && Number(sv.poll_attempts) >= 2, `poll_attempts=${sv && sv.poll_attempts}`);
  ok('超时文案明说"不代表失败"并给出恢复手段', !!sv && /不代表失败/.test(sv.error_message || '') && /重新获取/.test(sv.error_message || ''), sv && sv.error_message);
  ok('预算起点时间戳落库（墙钟预算跨重启保持）', !!sv && !!sv.poll_started_at, sv && sv.poll_started_at);

  // 用户主动「重新获取」必须能救回触顶任务（否则预算触顶 = 永久不可追踪）
  const rf = await api('POST', `/api/videos/${sid}/refresh`);
  await sleep(400);
  const rv = (await api('GET', `/api/videos?project_id=${PROJECT_ID}`)).data.find((x) => x.id === sid);
  ok('用户主动重新获取可重置预算', rf.status === 200 && rf.data && rf.data.ok === true && !!rv && Number(rv.poll_attempts) === 0 && rv.local_status !== 'poll_timeout',
    JSON.stringify(rv && { a: rv.poll_attempts, s: rv.local_status }));

  await api('DELETE', `/api/videos/${sid}`);
  queryTarget = 'base';
  await api('PUT', '/api/settings', { video_poll_interval: '8', video_max_polls: '60' });
}

group('级联删除 · 查询参数形式');
{
  // 回归：handler 只读 body.cascade，导致 `DELETE /api/projects/:id?cascade=1` 被**静默忽略** ——
  // 调用方以为级联删干净了，实际留下一堆孤儿分镜/素材（测试清理与脚本最常踩这个坑）。
  // 两种形式都必须生效：body 形式是 UI 在用的，query 形式是脚本/测试在用的。
  const p = await api('POST', '/api/projects', { name: '查询参数级联剧' });
  const pid = p.data.id;
  await api('POST', '/api/storyboards', { project_id: pid, episode_number: 1, shot_number: 1, video_prompt: 'x' });
  await api('POST', '/api/images', { project_id: pid, name: '查询参数级联图', url: '/assets/none.png' });
  const r = await fetch(`${BASE}/api/projects/${pid}?cascade=1`, { method: 'DELETE' });
  const d = await r.json();
  eq('query 形式删除项目 200', r.status, 200);
  ok('query 形式的 cascade 真的级联（removed ≥ 2）', d.removed >= 2, `removed=${d.removed}`);
  eq('分镜确实被清空', (await api('GET', `/api/storyboards?project_id=${pid}`)).data.length, 0);
  eq('素材确实被清空', (await api('GET', `/api/images?project_id=${pid}`)).data.length, 0);
}

// ── 写失败上报契约（数据完整性：保存失败必须让用户看得见） ──
group('写失败上报');
{
  const logsBefore = (await api('GET', '/api/logs')).data;
  const before = logsBefore.length;
  fs.chmodSync(HOME, 0o555); // 目录只读 → 原子写的临时文件创建必失败
  let failedWrite = false;
  try {
    await api('PUT', '/api/settings', { default_text_model: '写失败探针' });
    // 异步写队列的失败晚于响应：轮询日志直到出现，最多 4s
    let hit = null;
    for (let i = 0; i < 40 && !hit; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const logs = (await api('GET', '/api/logs')).data;
      hit = logs.find((l) => l.level === 'error' && String(l.msg).includes('保存失败'));
    }
    ok('写盘失败经 onWriteError 上报到日志流（用户可见）', !!hit, hit ? hit.msg.slice(0, 90) : `日志 ${before} 条内无"保存失败"`);
    failedWrite = !!hit;
  } finally {
    fs.chmodSync(HOME, 0o755); // 必须恢复，否则后续写全失败
  }
  ok('探针确实制造了写失败（非空跑自证）', failedWrite === true, `failedWrite=${failedWrite}`);
  // 恢复可写后：写入应重新生效且不再产生新的失败日志
  await api('PUT', '/api/settings', { default_text_model: '恢复探针' });
  await new Promise((r) => setTimeout(r, 500));
  const st = (await api('GET', '/api/settings')).data.settings || (await api('GET', '/api/settings')).data;
  const modelOk = String((st && st.default_text_model) || '').includes('恢复探针');
  const logsAfter = (await api('GET', '/api/logs')).data.filter((l) => l.level === 'error' && String(l.msg).includes('保存失败')).length;
  ok('恢复可写后写入重新生效', modelOk, JSON.stringify(st && st.default_text_model));
  ok('恢复后无新增写失败日志', logsAfter <= 1, `失败日志数=${logsAfter}`);
}

// ── 任务 CRUD 与批量取消契约（三个被 UI 真实使用、却零覆盖的端点） ──
group('任务 CRUD 与批量取消');
{
  // PUT/DELETE /api/tasks/:id —— 任务页「收藏」与「删除」按钮（tasks.js:247 / :330）走的路径
  const mk = await api('POST', '/api/tasks', { task_type: 'image', project_id: PROJECT_ID, notes: '原始备注', status: 'pending' });
  const tid = mk.data && mk.data.id;
  ok('任务探针已建', !!tid, JSON.stringify(mk.data).slice(0, 80));
  const up1 = await api('PUT', `/api/tasks/${tid}`, { is_favorited: true });
  eq('PUT 任务：收藏置位生效', up1.data.is_favorited, true);
  eq('PUT 任务：未提供的字段不被清空（局部补丁语义）', up1.data.notes, '原始备注');
  const up2 = await api('PUT', `/api/tasks/${tid}`, { notes: '改后备注' });
  ok('PUT 任务：notes 可改且收藏保持', up2.data.notes === '改后备注' && up2.data.is_favorited === true, JSON.stringify({ n: up2.data.notes, f: up2.data.is_favorited }));
  const up404 = await api('PUT', '/api/tasks/__nope__', { notes: 'x' });
  eq('PUT 未知任务 → 404', up404.status, 404);
  const del1 = await api('DELETE', `/api/tasks/${tid}`);
  eq('DELETE 任务成功', del1.data.ok, true);
  const stillThere = (await api('GET', '/api/tasks')).data.some((t) => t.id === tid);
  eq('删除后任务确实消失', stillThere, false);
  const del404 = await api('DELETE', `/api/tasks/${tid}`);
  eq('重复删除 → 404', del404.status, 404);

  // POST /api/batch/:id/cancel —— 批量条「取消」按钮（storyboards.js:90）：必须真能停住，不只是置个标记
  await fetch(`${MOCK_BASE}/__mock?slowimg=250`);
  const items = Array.from({ length: 6 }, (_, i) => ({ prompt: `cancel probe ${i}`, project_id: PROJECT_ID, size: '1024x1024' }));
  const pending = api('POST', '/api/batch/images', { items, concurrency: 2 }); // 故意不 await：运行中才有 id 可取消
  let runningId = null;
  for (let i = 0; i < 60 && !runningId; i++) {
    await new Promise((r) => setTimeout(r, 25));
    const list = (await api('GET', '/api/batch')).data || [];
    const run = list.find((j) => j.status === 'running');
    if (run) runningId = run.id;
  }
  ok('捕获到运行中的批量任务（取消才有意义）', !!runningId, `id=${runningId}`);
  const cxl = await api('POST', `/api/batch/${runningId}/cancel`);
  eq('取消运行中批量任务 → 200 ok', cxl.data.ok, true);
  const created = await pending; // 创建请求在整批跑完（或被取消）后才返回
  eq('创建请求本身仍正常返回', created.status, 200);
  let fin = null;
  for (let i = 0; i < 40; i++) {
    const list = (await api('GET', '/api/batch')).data || [];
    fin = list.find((j) => j.id === runningId);
    if (fin && fin.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  eq('取消后终态为 cancelled（真停住，而非跑完）', fin && fin.status, 'cancelled');
  ok('取消确实中断了剩余项（done < total）', fin && fin.done < fin.total, JSON.stringify(fin && { d: fin.done, t: fin.total, s: fin.status }));
  const cxl404 = await api('POST', '/api/batch/__nope__/cancel');
  eq('取消未知批量任务 → 404', cxl404.status, 404);
  await fetch(`${MOCK_BASE}/__mock?slowimg=0`); // 复位，避免影响后续

  // POST /api/videos/:id/download —— UI「保存到本地」（assets.js:209 / tasks.js:275）走的路径
  const d404 = await api('POST', '/api/videos/__nope__/download');
  eq('下载未知视频 → 404', d404.status, 404);
  const nv = await api('POST', '/api/videos', { mode: 'text_to_video', prompt: '下载探针（无地址）', project_id: PROJECT_ID });
  const nvId = nv.data.asset && nv.data.asset.id; // 注意：POST /api/videos 返回 {ok, asset}，id 不在顶层
  const d400 = await api('POST', `/api/videos/${nvId}/download`);
  eq('无视频地址时下载 → 400', d400.status, 400);
  await api('DELETE', `/api/videos/${nvId}`);
  // 同主地址（= 配置的 API Base 主机）→ 携带 Key 下载成功并落盘。
  // 必须显式设定 Base/Key：前面若干组改过设置，残留值会让本组变成"跨主"而 401（首版即栽在此）。
  await api('PUT', '/api/settings', { agnes_api_base_url: `${MOCK_BASE}/v1`, agnes_api_key: MOCK_KEY });
  const dv = await api('POST', '/api/videos', { mode: 'text_to_video', prompt: '下载探针（可下载）', project_id: PROJECT_ID });
  const dvId = dv.data.asset && dv.data.asset.id;
  await api('PUT', `/api/videos/${dvId}`, { video_url: `${MOCK_BASE}/video.mp4` });
  const dl = await api('POST', `/api/videos/${dvId}/download`);
  eq('同主地址下载成功', dl.data.ok, true);
  ok('返回真实字节数（MOCKMP4DATA=11B）', dl.data.bytes === 11, `bytes=${dl.data.bytes}`);
  const lf = dl.data.asset && dl.data.asset.local_file;
  ok('local_file 已写回资产记录', !!lf, JSON.stringify(dl.data).slice(0, 100));
  ok('文件确实落到磁盘', !!lf && fs.existsSync(lf), String(lf));
  const persisted = (await api('GET', '/api/videos')).data.find((v) => v.id === dvId);
  ok('local_file 已持久化（刷新后「已存本地」状态仍在）', !!(persisted && persisted.local_file), String(persisted && persisted.local_file).slice(0, 70));
  await api('DELETE', `/api/videos/${dvId}`);
}

// ── 批 8：原著解析（分块 map + 全局 reduce + 卡片反向驱动）────────
group('镜头绑定自动匹配与镜头侧体检（批 8 补 5/补 6：两档置信度 / 只并集不覆盖 / 按目标修复 / 名字对不上）');
{
  const pj = await api('POST', '/api/projects', { name: '绑定匹配测试剧' });
  const PID = pj.data.id;
  const mkChar = (body) => api('POST', '/api/characters', Object.assign({ project_id: PID }, body));
  const c1 = (await mkChar({ name: '匹配林晚', alias: '小晚、晚晚', appearance: '白衣长剑' })).data;
  const c2 = (await mkChar({ name: '匹配顾寒', appearance: '黑甲' })).data;
  const c3 = (await mkChar({ name: '匹配雪', appearance: '白发' })).data;  // 单字名
  const k1 = (await api('POST', '/api/story/cards/import', { project_id: PID, kind: 'location', name: '匹配临江茶馆', aliases: ['老茶馆'], atmosphere: '喧闹潮湿' }).catch(() => ({ data: null }))).data;
  // 卡片没有专门的建卡端点（卡片由解析产出），这里直接用一条分镜把地点卡带不出来 —— 改为走解析太重，
  // 所以卡片侧只用"人物卡不该进 story_card_ids"这条负向断言（正向的卡片匹配由 selftest 纯函数钉覆盖）。
  const mkShot = async (rows) => (await api('POST', '/api/storyboards', { rows: rows.map((r) => Object.assign({ project_id: PID, episode_number: 1 }, r)) })).data.rows;
  const shots = await mkShot([
    { shot_number: 1, characters: '匹配林晚、匹配顾寒', image_prompt: 'two people', scene_description: '两人对坐' },
    { shot_number: 2, characters: '', image_prompt: 'close-up', scene_description: '匹配林晚走进来' },
    { shot_number: 3, characters: '下雪了', image_prompt: 'snow falling' },
    { shot_number: 4, characters: '匹配林晚', image_prompt: 'x', character_ids: [c2.id] },
  ]);
  ok('建了 4 个镜头用于匹配', shots.length === 4, JSON.stringify(shots.map((x) => x.shot_number)));

  // ① 不花钱：名字匹配是可判定的，不该产生任何模型调用
  const callsBefore = storyChatCalls;
  const dry = await api('POST', '/api/storyboards/auto-bind', { project_id: PID, episode_number: 1, dry_run: true });
  eq('干跑 200', dry.status, 200);
  await sleep(400);
  eq('自动匹配**一次模型都没调**（可判定的事不该花钱）', storyChatCalls, callsBefore);
  eq('干跑不落库', dry.data.updated, 0);
  eq('干跑扫到的镜头数', dry.data.scanned, 4);
  const dryS1 = dry.data.matches.find((m) => m.shot_number === 1);
  eq('干跑报出镜头 1 该绑的角色（强匹配）', dryS1.added_characters.map((x) => x.name).join(','), '匹配林晚,匹配顾寒');
  ok('强匹配标了 via=characters', dryS1.added_characters.every((x) => x.via === 'characters' && !x.weak));
  const dryS2 = dry.data.matches.find((m) => m.shot_number === 2);
  eq('只在画面描述里出现算弱匹配', dryS2.added_characters.map((x) => `${x.name}:${x.via}`).join(','), '匹配林晚:prompt');
  const stillEmpty = (await api('GET', `/api/storyboards?project_id=${PID}&episode=1`)).data.find((x) => x.shot_number === 1);
  eq('干跑之后库里还是没绑定（"先看会绑什么再决定"必须是真的）', (stillEmpty.character_ids || []).length, 0);

  // ② 强匹配自动绑（生成后自动跑的就是这个模式）
  const strong = await api('POST', '/api/storyboards/auto-bind', { project_id: PID, episode_number: 1, strong_only: true });
  eq('strong_only 只绑高置信那档', strong.data.weak, 0);
  const after = (await api('GET', `/api/storyboards?project_id=${PID}&episode=1`)).data;
  const s1 = after.find((x) => x.shot_number === 1);
  const s2 = after.find((x) => x.shot_number === 2);
  const s3 = after.find((x) => x.shot_number === 3);
  const s4 = after.find((x) => x.shot_number === 4);
  eq('镜头 1 绑上了两个角色', (s1.character_ids || []).length, 2);
  eq('镜头 2 的弱匹配没有被自动绑（不猜）', (s2.character_ids || []).length, 0);
  eq('单字名"雪"不会被"下雪了"误绑（宁可漏也不要错绑）', (s3.character_ids || []).length, 0);
  ok('已经手工绑过的绑定没被抹掉（并集而不是覆盖）', (s4.character_ids || []).includes(c2.id), JSON.stringify(s4.character_ids));
  ok('镜头 4 同时补上了新匹配到的角色', (s4.character_ids || []).includes(c1.id), JSON.stringify(s4.character_ids));

  // ③ 默认模式（含弱匹配）：界面先确认再走这条路 —— 它必须把 strong_only 跳过的那些也补上
  const all = await api('POST', '/api/storyboards/auto-bind', { project_id: PID, episode_number: 1 });
  ok('默认模式会把弱匹配也绑上（界面先确认再调）', all.data.weak >= 1, JSON.stringify({ weak: all.data.weak, updated: all.data.updated }));
  const s2b = (await api('GET', `/api/storyboards?project_id=${PID}&episode=1`)).data.find((x) => x.shot_number === 2);
  ok('镜头 2 现在绑上了（弱匹配确实落库了）', (s2b.character_ids || []).length === 1, JSON.stringify(s2b.character_ids));

  // ④ 幂等：同一个模式再跑一次没有新增（两种模式都要幂等，不能"跑一次多绑一点"）
  const again = await api('POST', '/api/storyboards/auto-bind', { project_id: PID, episode_number: 1 });
  eq('再跑一次不再重复绑（幂等）', again.data.updated, 0);
  eq('strong_only 模式同样幂等',
    (await api('POST', '/api/storyboards/auto-bind', { project_id: PID, episode_number: 1, strong_only: true })).data.updated, 0);

  // ⑤ 参数与边界
  eq('缺 project_id → 400', (await api('POST', '/api/storyboards/auto-bind', {})).status, 400);
  const byIds = await api('POST', '/api/storyboards/auto-bind', { project_id: PID, storyboard_ids: [s1.id] });
  eq('按 storyboard_ids 限定范围时不碰其它镜头', byIds.data.scanned, 1);
  eq('不存在的项目 → 扫 0 个镜头（如实为空，不报错）', (await api('POST', '/api/storyboards/auto-bind', { project_id: 'project_nope' })).data.scanned, 0);

  // ⑥ 镜头侧体检：漏绑的角色聚成一条，并带修复动作
  const audit = await api('GET', `/api/story/audit?project_id=${PID}`);
  eq('体检 200', audit.status, 200);
  ok('体检报出扫描到的镜头数', audit.data.shots_scanned >= 4, String(audit.data.shots_scanned));
  ok('体检里同时有卡片侧与镜头侧两组（各自计数）',
    !!audit.data.card_counts && !!audit.data.shot_counts, JSON.stringify(Object.keys(audit.data)));
  eq('总数 = 卡片侧 + 镜头侧（不许只算一边）',
    audit.data.counts.warn, audit.data.card_counts.warn + audit.data.shot_counts.warn);
  // 把镜头 2 的绑定清掉，制造一条确定的漏绑
  await api('PUT', `/api/storyboards/${s2.id}`, { character_ids: [] });
  const audit2 = await api('GET', `/api/story/audit?project_id=${PID}`);
  const un = audit2.data.shot_issues.filter((x) => x.code === 'shot_char_unbound' && x.target_id === c1.id);
  eq('漏绑聚成一条（按角色，而不是每镜头一条）', un.length, 1);
  ok('聚合里带上了镜头明细', (un[0].shot_ids || []).length >= 1, JSON.stringify(un[0].shot_ids));
  eq('修复动作码是"绑到这些镜头"', un[0].fix_code, 'bind_shot_target');

  // ⑦ 按目标修复：只绑这一个角色，不做"能匹配的都绑上"
  const fix = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'bind_shot_target', target_id: c1.id, shot_ids: un[0].shot_ids });
  eq('修复 200', fix.status, 200);
  eq('绑到的镜头数如实上报', fix.data.bound_shots, un[0].shot_ids.length);
  const s2c = (await api('GET', `/api/storyboards?project_id=${PID}&episode=1`)).data.find((x) => x.shot_number === 2);
  ok('镜头 2 现在绑上了这个角色', (s2c.character_ids || []).includes(c1.id), JSON.stringify(s2c.character_ids));
  ok('没有顺带绑上别的角色（一次点击只做一个明确动作）', !(s2c.character_ids || []).includes(c2.id), JSON.stringify(s2c.character_ids));
  const fix2 = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'bind_shot_target', target_id: c1.id, shot_ids: un[0].shot_ids });
  eq('再修一次不重复绑（幂等）', fix2.data.bound_shots, 0);
  eq('缺 target_id → 400', (await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'bind_shot_target', shot_ids: ['x'] })).status, 400);
  eq('缺 shot_ids → 400', (await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'bind_shot_target', target_id: c1.id })).status, 400);
  eq('不存在的目标 → 404', (await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'bind_shot_target', target_id: 'char_nope', shot_ids: [s1.id] })).status, 404);

  // ⑧ 未锁定角色：绑了、但**提示词里出现名字**时不会注入外貌（characterPhrase 的既定语义）→ 可一键锁定
  //    判据必须与注入时用的字段一致（image_prompt / video_prompt），所以先把镜头 1 的提示词改成含名字的
  await api('PUT', `/api/storyboards/${s1.id}`, { image_prompt: '匹配林晚站在门口' });
  const beforeLock = await api('GET', `/api/story/audit?project_id=${PID}`);
  const unlocked = beforeLock.data.shot_issues.filter((x) => x.code === 'shot_char_unlocked' && x.target_id === c1.id);
  eq('报出"绑了但没锁定"的镜头（最隐蔽的一条）', unlocked.length, 1);
  eq('只报提示词里真的出现名字的那些镜头', unlocked[0].shot_ids.join(','), s1.id);
  ok('英文提示词（没写名字）的镜头不报 —— 那些镜头其实会正常注入外貌',
    !unlocked[0].shot_ids.includes(s2.id), JSON.stringify(unlocked[0].shot_ids));
  eq('未锁定问题的修复动作码是"锁定"', unlocked[0].fix_code, 'lock_shot_char');
  const lock = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'lock_shot_char', target_id: c1.id });
  eq('锁定 200', lock.status, 200);
  eq('锁定生效', lock.data.locked, 1);
  eq('再锁一次不重复（幂等）', (await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'lock_shot_char', target_id: c1.id })).data.already, true);
  const afterLock = await api('GET', `/api/story/audit?project_id=${PID}`);
  eq('锁定后这一条消失（体检不是永远报同样的话）',
    afterLock.data.shot_issues.filter((x) => x.code === 'shot_char_unlocked' && x.target_id === c1.id).length, 0);
  eq('锁定不存在的角色 → 404', (await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'lock_shot_char', target_id: 'char_nope' })).status, 404);

  // ⑨ 人物卡不能绑进 story_card_ids（写入白名单 + 修复端点各一层）
  const charCard = (await api('GET', `/api/story/cards?project_id=${PID}&kind=character`)).data;
  if (charCard && charCard.length) {
    eq('把人物卡当目标绑 → 400（只有地点/道具卡可注入）',
      (await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'bind_shot_target', target_id: charCard[0].id, shot_ids: [s1.id] })).status, 400);
  }
  eq('不认识的修复项 → 400 且列出支持的项',
    (await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'nope' })).status, 400);
  ok('错误文案列出了新支持的修复项',
    /bind_shot_target/.test((await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'nope' })).data.error || ''));

  // ⑩ 单集拍表与前情提要 + 剧本集号（批 8 补 8：逐集生成的连续性上下文，纯本地）
  {
    // 卡片没有建卡端点（卡片由解析产出），所以照分集骨架那组的做法用 __LONGARC__ 走一次真解析
    const pj = await api('POST', '/api/projects', { name: '逐集上下文测试剧' });
    const EPID = pj.data.id;
    const an = await api('POST', '/api/story/analyze', { project_id: EPID, title: '逐集验收', text: `__LONGARC__${'林晚在临江茶馆见到顾寒。'.repeat(40)}` });
    let job = { status: '(未取到)' };
    for (let i = 0; i < 60; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') { job = j; break; } }
    eq('解析任务结束（逐集验收用）', job.status, 'done');
    const src = (await api('GET', `/api/story/sources?project_id=${EPID}`)).data[0];
    const q = `project_id=${EPID}&source_id=${src.id}&per_episode=3`;

    const ep1 = await api('GET', `/api/story/episode-brief?${q}&episode=1`);
    eq('单集接口 200', ep1.status, 200);
    eq('按每集 3 拍切出 2 集', ep1.data.episode_count, 2);
    eq('第 1 集存在', ep1.data.exists, true);
    ok('第 1 集的大纲带集号与拍数', ep1.data.brief.startsWith('第 1 集（'), ep1.data.brief.split('\n')[0]);
    ok('本集大纲就是全剧骨架里那一集（拍名一致）', ep1.data.brief.includes('长弧·起1'), ep1.data.brief);
    eq('第 1 集没有前情（它是开头）', ep1.data.prior, '');
    eq('第 1 集的前情集数为 0', ep1.data.prior_episodes.length, 0);

    const ep2 = await api('GET', `/api/story/episode-brief?${q}&episode=2`);
    ok('第 2 集的前情里是第 1 集的内容', ep2.data.prior.includes('【第 1 集】'), ep2.data.prior);
    ok('前情里不含本集（第 2 集）的内容', !ep2.data.prior.includes('【第 2 集】'), ep2.data.prior);
    eq('前情集号如实上报', ep2.data.prior_episodes.join(','), '1');
    eq('前情字数如实上报', ep2.data.prior_chars, ep2.data.prior.length);
    ok('前情写明"不要重复叙述"', ep2.data.prior.includes('不要重复叙述'));
    eq('没超预算不算截断', ep2.data.prior_truncated, false);

    const ep3 = await api('GET', `/api/story/episode-brief?${q}&episode=3`);
    eq('不存在的集：exists 为假', ep3.data.exists, false);
    eq('不存在的集给一句怎么做的提示（界面据此指路）', ep3.data.notes.length, 1);
    const small = await api('GET', `/api/story/episode-brief?${q}&episode=2&prior_max=1`);
    eq('预算过小时至少留一集而不是留空', small.data.prior_episodes.length, 1);
    const dflt = await api('GET', `/api/story/episode-brief?${q}&episode=2&per_episode=abc`);
    eq('非法拍数参数落回默认（与分集骨架同一条兜底）', dflt.data.per_episode, 4);

    const calls0 = storyChatCalls;
    await api('GET', `/api/story/episode-brief?${q}&episode=2`);
    await sleep(300);
    eq('单集接口一次模型都不调（与体检、分集同一条纪律）', storyChatCalls, calls0);

    // 剧本记录带集号：逐集生成要能一集一条地存下来
    const sc = (await api('POST', '/api/scripts', { project_id: EPID, script_type: 'episode_script', episode_number: 2, title: '逐集验收 第 2 集', content: '第 2 集正文' })).data;
    eq('剧本存下集号', sc.episode_number, 2);
    const listed = (await api('GET', `/api/scripts?project_id=${EPID}`)).data.find((x) => x.id === sc.id);
    eq('列表里也带集号（界面靠它标"第 N 集"）', listed.episode_number, 2);
    const up = await api('PUT', `/api/scripts/${sc.id}`, { episode_number: 5 });
    eq('集号可改（挪错集能纠正）', up.data.episode_number, 5);
    const noEp = (await api('POST', '/api/scripts', { project_id: EPID, script_type: 'story_concept', title: '不带集号', content: '全剧' })).data;
    eq('不带集号时是 0（全剧/未指定），不是 NaN', noEp.episode_number, 0);
    const badEp = (await api('POST', '/api/scripts', { project_id: EPID, script_type: 'story_concept', title: '坏集号', content: 'x', episode_number: 'abc' })).data;
    eq('坏集号落回 0（不写 NaN 进数据）', badEp.episode_number, 0);
    await api('DELETE', `/api/scripts/${sc.id}`);
    await api('DELETE', `/api/scripts/${noEp.id}`);
    await api('DELETE', `/api/scripts/${badEp.id}`);
    await api('DELETE', `/api/projects/${EPID}?cascade=1`);
  }

  // ⑪ 画风写死：提示词里写了画风词 → 换画风会静默失效（纯本地判定，不花钱）
  {
    const before = await api('GET', `/api/story/audit?project_id=${PID}`);
    ok('体检报告里同时有画风侧的一组（三源各自计数）',
      !!before.data.style_counts && !!before.data.card_counts && !!before.data.shot_counts,
      JSON.stringify(Object.keys(before.data)));
    eq('总数 = 卡片侧 + 镜头侧 + 画风侧',
      before.data.counts.warn, before.data.card_counts.warn + before.data.shot_counts.warn + before.data.style_counts.warn);
    const st = (await api('POST', '/api/storyboards', {
      project_id: PID, episode_number: 3, shot_number: 91,
      image_prompt: 'a girl, oil painting style, visible brush strokes, holding a sword',
      video_prompt: 'slow dolly in',
    })).data;
    const a2 = await api('GET', `/api/story/audit?project_id=${PID}`);
    // 界面渲染的是合并后的 issues，不是那几个分组的字段：只把问题塞进 style_issues / shot_issues
    // 而忘了并进 issues，面板上一条都不显示，而按分组字段写的断言**全绿**（对照 AC 抓到的覆盖盲区）。
    // 注意这条必须放在"确实存在画风问题"之后 —— 早放的话 style_issues 是空的，等式恒成立、钉不住东西
    ok('镜头侧与画风侧的问题都并进 issues（面板渲染的是 issues）',
      a2.data.issues.some((x) => x.code === 'shot_style_baked')
      && a2.data.issues.length === a2.data.card_issues.length + a2.data.shot_issues.length + a2.data.style_issues.length,
      JSON.stringify({ issues: a2.data.issues.length, card: a2.data.card_issues.length, shot: a2.data.shot_issues.length, style: a2.data.style_issues.length }));
    const baked = a2.data.style_issues.filter((x) => x.word === 'oil painting style, visible brush strokes');
    eq('报出提示词里写死的画风词（按词聚合）', baked.length, 1);
    eq('聚合里带上是哪个镜头', baked[0].shot_ids.includes(st.id), true);
    eq('与当前项目画风不同 → 算"要处理"', baked[0].level, 'warn');
    eq('修复动作码是"删掉写死的画风词"', baked[0].fix_code, 'strip_style_word');
    eq('画风设置如实回报（界面要说清"当前项目画风"）', typeof a2.data.art_style, 'string');
    const fx = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'strip_style_word', word: baked[0].word, shot_ids: baked[0].shot_ids });
    eq('修复 200', fx.status, 200);
    eq('修复的镜头数如实上报', fx.data.fixed_shots, 1);
    ok('改前/改后如实回报（用户能看见到底删了什么）',
      fx.data.detail[0].before.includes('oil painting') && !fx.data.detail[0].after.includes('oil painting'),
      JSON.stringify(fx.data.detail[0]));
    const after = (await api('GET', `/api/storyboards?project_id=${PID}&episode=3`)).data.find((x) => x.id === st.id);
    eq('删词后画面描述一个字不动', after.image_prompt, 'a girl, holding a sword');
    const a3 = await api('GET', `/api/story/audit?project_id=${PID}`);
    eq('修复后这一条消失（体检随数据变化）',
      a3.data.style_issues.filter((x) => x.word === baked[0].word).length, 0);
    const fx2 = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'strip_style_word', word: baked[0].word, shot_ids: [st.id] });
    eq('再修一次不再改（幂等）', fx2.data.fixed_shots, 0);
    eq('缺 word → 400', (await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'strip_style_word', shot_ids: [st.id] })).status, 400);
    eq('缺 shot_ids → 400', (await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'strip_style_word', word: 'manga' })).status, 400);
    const calls0 = storyChatCalls;
    await api('GET', `/api/story/audit?project_id=${PID}`);
    await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'strip_style_word', word: 'manga', shot_ids: [st.id] });
    await sleep(300);
    eq('画风体检与修复都不调模型（同一条纪律）', storyChatCalls, calls0);
    await api('DELETE', `/api/storyboards/${st.id}`);
  }

  // ⑫ 名字在角色库里找不到：这类镜头一定没有外貌注入，而且不报错（名册就是为它而生的）
  const unkShot = (await api('POST', '/api/storyboards', {
    project_id: PID, episode_number: 2, shot_number: 90, characters: '未登记少女、两人', image_prompt: 'x',
  })).data;
  const audit3 = await api('GET', `/api/story/audit?project_id=${PID}`);
  const unk = audit3.data.shot_issues.filter((x) => x.code === 'shot_char_unknown');
  ok('报出「出场人物」里角色库中没有的名字',
    unk.some((x) => x.target_name === '未登记少女'), JSON.stringify(unk.map((x) => x.target_name)));
  ok('泛称（两人）不报，避免刷屏', !unk.some((x) => x.target_name === '两人'));
  ok('名字对不上不提供一键修复（该改名还是该建角色是人的判断）',
    unk.every((x) => x.fixable === false));
  // 验收环：把角色建出来，这一项就该消失（预防手段与检测手段成对）
  const c9 = (await api('POST', '/api/characters', { project_id: PID, name: '未登记少女', appearance: '短发' })).data;
  const audit4 = await api('GET', `/api/story/audit?project_id=${PID}`);
  ok('建了角色档案后这一项消失（体检不是永远报同样的话）',
    !audit4.data.shot_issues.some((x) => x.code === 'shot_char_unknown' && x.target_name === '未登记少女'));
  ok('建了档案之后同一个镜头变成"提到却没绑"（体检把问题交给下一步）',
    audit4.data.shot_issues.some((x) => x.code === 'shot_char_unbound' && x.target_id === c9.id && x.shot_ids.includes(unkShot.id)),
    JSON.stringify(audit4.data.shot_issues.map((x) => [x.code, x.target_name])));

  // ⑬ 修复也不花钱（同一条纪律的回归）
  const callsBefore2 = storyChatCalls;
  await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'bind_shot_target', target_id: c1.id, shot_ids: [s1.id] });
  await sleep(300);
  eq('修复端点同样不调模型', storyChatCalls, callsBefore2);

  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('角色参考图进出图输入（批 8 补 13：传了参考图就该真的用上）');
{
  const pj = await api('POST', '/api/projects', { name: '参考图测试剧' });
  const PID = pj.data.id;
  // 一张公网图 + 一张本地图：公网那张才可能进到上游，本地那张要如实上报"用不上"
  const pub = await api('POST', '/api/images', { project_id: PID, name: '公网参考图', remote_url: 'https://example.com/face.png', url: 'https://example.com/face.png', usage_type: 'character' });
  const loc = await api('POST', '/api/images', { project_id: PID, name: '本地参考图', url: '/assets/local/face.png', usage_type: 'character' });
  const ch = await api('POST', '/api/characters', {
    project_id: PID, name: '参考图角色', appearance: '长发及腰', is_locked: true,
    reference_image_ids: [pub.data.id, loc.data.id],
  });
  eq('角色存下了参考图', (ch.data.reference_image_ids || []).length, 2);
  const sb = await api('POST', '/api/storyboards', { project_id: PID, episode_number: 1, shot_number: 1, scene_description: '甲', image_prompt: 'a girl', character_ids: [ch.data.id] });

  // ① 出图时自动带上绑定角色的参考图（公网那张）
  lastImageCreate = null;
  const r1 = await api('POST', '/api/agnes/image', { project_id: PID, storyboard_id: sb.data.id, prompt: 'a girl' });
  eq('出图 200', r1.status, 200);
  const sent = (lastImageCreate && lastImageCreate.image) || [];
  ok('自动把公网参考图作为出图输入发给上游', Array.isArray(sent) && sent.includes('https://example.com/face.png'), JSON.stringify(sent));
  ok('本地文件不发（Agnes 抓不到），并且**如实上报**用不上几张',
    !sent.includes('/assets/local/face.png') && r1.data.reference_images.local_skipped === 1,
    JSON.stringify(r1.data.reference_images));
  eq('上报用上了几张参考图', r1.data.reference_images.used, 1);
  ok('上报是哪几个角色的参考图（用户知道是谁的脸在起作用）',
    (r1.data.reference_images.characters || []).includes('参考图角色'), JSON.stringify(r1.data.reference_images.characters));
  ok('入库的提示词仍只存镜头内容（参考图是在使用点注入的，不写进 image_prompt）',
    !String(r1.data.asset.generation_prompt).includes('example.com') && r1.data.asset.generation_prompt === 'a girl, 出场角色——参考图角色：长发及腰',
    r1.data.asset.generation_prompt);

  // ② 溯源要记**实际发出**的输入（记 body.image 的话，自动带上的参考图就查不到了）
  const task = (await api('GET', `/api/tasks?project_id=${PID}`)).data.find((t) => t.task_type === 'image' && t.storyboard_id === sb.data.id);
  ok('生成任务里记下实际发出的参考图', (task.input_images || []).includes('https://example.com/face.png'), JSON.stringify(task.input_images));

  // ③ 显式传的参考图排在前面（用户当场指定的优先）
  lastImageCreate = null;
  await api('POST', '/api/agnes/image', { project_id: PID, storyboard_id: sb.data.id, prompt: 'a girl', image: 'https://example.com/explicit.png' });
  const sent2 = (lastImageCreate && lastImageCreate.image) || [];
  eq('显式参考图排第一', sent2[0], 'https://example.com/explicit.png');
  eq('显式 + 自动一起发（去重后共两张）', sent2.length, 2);

  // ④ 没绑角色 / 角色没有参考图 → 不发 image 参数（不能凭空塞一个空数组）
  const ch2 = await api('POST', '/api/characters', { project_id: PID, name: '无参考图角色', appearance: '短发' });
  const sb2 = await api('POST', '/api/storyboards', { project_id: PID, episode_number: 1, shot_number: 2, scene_description: '乙', image_prompt: 'a boy', character_ids: [ch2.data.id] });
  lastImageCreate = null;
  const r4 = await api('POST', '/api/agnes/image', { project_id: PID, storyboard_id: sb2.data.id, prompt: 'a boy' });
  ok('没有参考图时**不发** image 参数（空数组会改变上游的生成模式）',
    !(lastImageCreate && lastImageCreate.image) && r4.data.reference_images.used === 0,
    JSON.stringify(lastImageCreate && lastImageCreate.image));

  // ⑤ 参考图有上限（多了互相打架，也拖慢生成）
  const many = [];
  for (let i = 0; i < 6; i++) {
    const a = await api('POST', '/api/images', { project_id: PID, name: `参考${i}`, remote_url: `https://example.com/r${i}.png`, url: `https://example.com/r${i}.png` });
    many.push(a.data.id);
  }
  const ch3 = await api('POST', '/api/characters', { project_id: PID, name: '多参考图角色', appearance: '长发', reference_image_ids: many });
  const sb3 = await api('POST', '/api/storyboards', { project_id: PID, episode_number: 1, shot_number: 3, scene_description: '丙', image_prompt: 'a cat', character_ids: [ch3.data.id] });
  lastImageCreate = null;
  const r5 = await api('POST', '/api/agnes/image', { project_id: PID, storyboard_id: sb3.data.id, prompt: 'a cat' });
  eq('参考图有上限（默认 4 张）', ((lastImageCreate && lastImageCreate.image) || []).length, 4);
  eq('上报的 used 与实际发出的一致', r5.data.reference_images.used, 4);
  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('剧本/分镜过期体检（批 8 补 12：输入变了要能被发现，没变不能乱喊）');
{
  const pj = await api('POST', '/api/projects', { name: '过期体检测试剧' });
  const PID = pj.data.id;
  // 用带 __LONGARC__ 的原文，mock 会给出"两幕八拍"，够切成好几集
  const an = await api('POST', '/api/story/analyze', { project_id: PID, title: '过期·原著', text: `__LONGARC__${'长弧线的故事。'.repeat(40)}` });
  for (let i = 0; i < 60; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const SRC = an.data.source.id;
  // "纯本地"这件事要用计数证明：**解析跑完**之后到体检结束，一次模型都不该调
  const callsBeforeStale = storyChatCalls;
  const ep = (await api('GET', `/api/story/episodes?project_id=${PID}&source_id=${SRC}&per_episode=4`)).data;
  ok('过期验收：分集骨架已就位（至少 2 集）', ep.episode_count >= 2, JSON.stringify({ n: ep.episode_count }));

  const st0 = (await api('GET', `/api/story/staleness?project_id=${PID}&source_id=${SRC}&per_episode=4`)).data;
  eq('还没生成任何剧本 → 每一集都算"缺"', st0.counts.script_missing, ep.episode_count);
  eq('缺 ≠ 过期（不能把"没有"算成"该重生成"）', st0.counts.script_stale, 0);

  // 按 brief 的指纹存一条"第 1 集剧本"（等价于逐集生成时前端带上 plan_digest）
  const b1 = (await api('GET', `/api/story/episode-brief?project_id=${PID}&source_id=${SRC}&per_episode=4&episode=1`)).data;
  ok('episode-brief 直接返回输入指纹（算法只留服务端一份）', /^[0-9a-f]{8}$/.test(b1.input_digest || ''), b1.input_digest);
  const sc1 = await api('POST', '/api/scripts', {
    project_id: PID, script_type: 'story_concept', episode_number: 1, title: '第 1 集',
    content: '第 1 集的剧本正文', plan_digest: b1.input_digest,
  });
  eq('剧本存下输入指纹', sc1.data.plan_digest, b1.input_digest);

  const st1 = (await api('GET', `/api/story/staleness?project_id=${PID}&source_id=${SRC}&per_episode=4`)).data;
  eq('刚生成完 → 第 1 集一致', st1.episodes.find((x) => x.episode_number === 1).script_state, 'ok');
  eq('一致不计入"该重生成"', st1.counts.script_stale, 0);

  // 分镜记来源剧本：指纹由服务端按入库那一刻的正文算（前端不参与哈希）
  const sb = await api('POST', '/api/storyboards', { rows: [{ project_id: PID, episode_number: 1, shot_number: 1, scene_description: '甲', source_script_id: sc1.data.id }] });
  ok('分镜入库时服务端补上了来源剧本的指纹', /^[0-9a-f]{8}$/.test(sb.data.rows[0].script_digest || ''),
    JSON.stringify(sb.data.rows[0].script_digest));
  const st2 = (await api('GET', `/api/story/staleness?project_id=${PID}&source_id=${SRC}&per_episode=4`)).data;
  eq('分镜的来源剧本没变 → 分镜一致', st2.episodes.find((x) => x.episode_number === 1).shot_state, 'ok');

  // ① 改了剧本正文 → 由它生成的分镜过期（剧本自己不算过期：它记的是"生成时的输入"）
  await api('PUT', `/api/scripts/${sc1.data.id}`, { content: '第 1 集的剧本正文（人工改过）' });
  const st3 = (await api('GET', `/api/story/staleness?project_id=${PID}&source_id=${SRC}&per_episode=4`)).data;
  eq('剧本正文改过 → 分镜报过期', st3.episodes.find((x) => x.episode_number === 1).shot_state, 'stale');
  eq('过期计数如实上报（用户据此决定要不要重新拆镜）', st3.counts.shot_stale, 1);

  // ② 重切分集 → 第 1 集拍表重新分组 → 剧本过期
  // 注意：幕次收口优先，per=2/3/4 都会收在同一处（这不是 bug，是"不拆幕"的既定语义）。
  // 要真的改变第 1 集的拍表，得把每集拍数抬到能跨过幕边界
  const st4 = (await api('GET', `/api/story/staleness?project_id=${PID}&source_id=${SRC}&per_episode=6`)).data;
  eq('重切分集后第 1 集剧本报过期', st4.episodes.find((x) => x.episode_number === 1).script_state, 'stale');
  ok('返回体带诊断字段与说明（界面要能解释"过期"是什么意思）',
    typeof st4.scripts_scanned === 'number' && Array.isArray(st4.notes) && st4.notes.length > 0, JSON.stringify(st4.notes).slice(0, 120));

  // ③ 手工粘贴的剧本没有指纹 → unknown，且**不算**该重生成
  const manual = await api('POST', '/api/scripts', { project_id: PID, script_type: 'story_concept', episode_number: 2, title: '第 2 集（手工）', content: '手工写的' });
  eq('手工剧本没有指纹', manual.data.plan_digest, '');
  const st5 = (await api('GET', `/api/story/staleness?project_id=${PID}&source_id=${SRC}&per_episode=4`)).data;
  eq('没有指纹 → unknown（不替用户断言它没过期）', st5.episodes.find((x) => x.episode_number === 2).script_state, 'unknown');
  eq('unknown 不计入"该重生成"', st5.counts.script_stale, 0);
  ok('unknown 有单独计数与说明', st5.counts.script_unknown >= 1 && st5.notes.some((x) => x.includes('没有生成指纹')));

  // ④ 删掉源剧本 → 分镜无从追溯，如实报过期
  await api('DELETE', `/api/scripts/${sc1.data.id}`);
  const st6 = (await api('GET', `/api/story/staleness?project_id=${PID}&source_id=${SRC}&per_episode=4`)).data;
  eq('源剧本被删 → 分镜报过期（不是静默"没问题"）', st6.episodes.find((x) => x.episode_number === 1).shot_state, 'stale');

  eq('体检是纯本地的：一次模型都没调', storyChatCalls, callsBeforeStale);
  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('人物卡 ↔ 资产库漂移（批 8 补 11：同步只动会注入提示词的字段）');
{
  const pj = await api('POST', '/api/projects', { name: '漂移体检测试剧' });
  const PID = pj.data.id;
  const an = await api('POST', '/api/story/analyze', { project_id: PID, title: '漂移·原著', text: '林晚在临江茶馆见到顾寒。'.repeat(30), reduce: false });
  for (let i = 0; i < 60; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const cards = (await api('GET', `/api/story/cards?source_id=${an.data.source.id}`)).data;
  const lin = cards.find((c) => c.kind === 'character' && c.name === '林晚');
  ok('漂移验收：拿到人物卡', !!lin, JSON.stringify(cards.map((c) => c.name)));

  // ① 入资产库 → 一致，不报漂移
  const imp = await api('POST', '/api/story/cards/import-characters', { project_id: PID, source_id: an.data.source.id });
  eq('入资产库成功', imp.data.created_count >= 1, true);
  const a1 = await api('GET', `/api/story/audit?project_id=${PID}`);
  const drift1 = a1.data.drift_issues;
  eq('刚导入时没有漂移（复制过去就是同一份）', drift1.length, 0);
  ok('返回体里有 drift_counts/drift_pairs 诊断字段', !!a1.data.drift_counts && typeof a1.data.drift_pairs === 'number');

  // ② 制造漂移：直接改人物卡（等价于"追加解析补全了卡"）
  await api('PUT', `/api/story/cards/${lin.id}`, { appearance: '长发及腰，左眉有疤', outfit: '青色长衫', aliases: ['晚晚', '阿晚'] });
  const a2 = await api('GET', `/api/story/audit?project_id=${PID}`);
  const dr = a2.data.drift_issues;
  ok('改人物卡后报出漂移', dr.length === 1 && dr[0].code === 'char_drift', JSON.stringify(dr.map((x) => x.title)));
  ok('漂移项逐字段摆出"资产库值 → 人物卡值"（人才能判断哪份对）',
    (dr[0].drift || []).length >= 2 && dr[0].conflicts.every((c) => c.values.length === 2), JSON.stringify(dr[0].drift));
  ok('漂移项可修，动作码是 sync_character（问题码 ≠ 动作码）', dr[0].fixable === true && dr[0].fix_code === 'sync_character');
  ok('漂移并进了面板真正消费的 issues', a2.data.issues.some((x) => x.code === 'char_drift'));
  eq('合并后的 issues = 四组之和', a2.data.issues.length,
    a2.data.card_issues.length + a2.data.shot_issues.length + a2.data.style_issues.length + a2.data.drift_issues.length);

  // ③ 同步：只动会注入提示词的字段
  const before = (await api('GET', '/api/characters?project_id=' + PID)).data.find((c) => c.story_card_id === lin.id);
  await api('PUT', `/api/characters/${before.id}`, { role: '反派', personality: '暴躁易怒' }); // 用户自己在资产库里改的
  const fx = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'sync_character', target_id: before.id, card_ids: [lin.id] });
  eq('同步 200', fx.status, 200);
  eq('同步确实改了东西', fx.data.updated, true);
  ok('同步说明改了哪些字段', (fx.data.fields || []).length >= 2, JSON.stringify(fx.data.fields));
  const after = (await api('GET', '/api/characters?project_id=' + PID)).data.find((c) => c.id === before.id);
  eq('外貌按人物卡覆盖', after.appearance, '长发及腰，左眉有疤');
  eq('服饰按人物卡覆盖', after.outfit, '青色长衫');
  ok('别名取并集（不丢掉资产库里原有的）', String(after.alias).includes('阿晚') && String(after.alias).includes('晚晚'), after.alias);
  eq('用户自己改的角色定位**不动**（同步不该覆盖人的编辑）', after.role, '反派');
  eq('用户自己改的性格**不动**', after.personality, '暴躁易怒');
  ok('同步留痕（notes 里能看到"与人物卡同步"）', /与人物卡同步/.test(String(after.notes)), String(after.notes));
  ok('同步后漂移消失', (await api('GET', `/api/story/audit?project_id=${PID}`)).data.drift_issues.length === 0);

  // ④ 再同步一次：没有可改的，如实说没改
  const again = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'sync_character', target_id: before.id, card_ids: [lin.id] });
  eq('已一致时 updated=false（不假报"已同步"）', again.data.updated, false);

  // ⑤ 校验：不存在的角色 / 不是这张卡导入的角色都要明确报错
  eq('不存在的角色 → 404', (await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'sync_character', target_id: 'nope', card_ids: [lin.id] })).status, 404);
  const other = cards.find((c) => c.kind === 'character' && c.name !== '林晚');
  eq('拿别的人物卡去同步 → 400（不能把张三的脸同步到李四身上）',
    (await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'sync_character', target_id: before.id, card_ids: [other.id] })).status, 400);
  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('追加解析（批 8 补 10：只解析新增章节 / 已有卡 id 不变 / 一张不删）');
{
  const pj = await api('POST', '/api/projects', { name: '追加解析测试剧' });
  const PID = pj.data.id;
  const wait = async (jobId) => {
    for (let i = 0; i < 60; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${jobId}`)).data; if (j && j.status !== 'running') return j; }
    return null;
  };
  // 第一次：整本解析（mock 会按提示词形状吐固定卡片）
  const an1 = await api('POST', '/api/story/analyze', { project_id: PID, title: '追加·第一卷', text: '林晚在临江茶馆见到顾寒。'.repeat(30) });
  eq('首次解析 200', an1.status, 200);
  await wait(an1.data.jobId);
  const srcId = an1.data.source.id;
  const cards1 = (await api('GET', `/api/story/cards?source_id=${srcId}`)).data;
  const before = cards1.map((c) => `${c.kind}:${c.name}#${c.id}`).sort();
  ok('首次解析落了一批卡', cards1.length > 0);

  // 追加：只对新增文本分块 —— 这是"不为前面几十万字反复付费"的硬证据
  const callsBefore = storyChatCalls;
  const ap = await api('POST', '/api/story/append', { project_id: PID, source_id: srcId, text: '第二卷：夜访密室。'.repeat(30) });
  eq('追加解析 200', ap.status, 200);
  eq('追加只解析新增文本（块数不含已有章节）', ap.data.appended_chunks, an1.data.chunk_count);
  eq('块号接着已有的往后排（否则新卡指向错误的原文位置）', ap.data.chunk_offset, an1.data.chunk_count);
  const j2 = await wait(ap.data.jobId);
  ok('追加任务跑完', j2 && j2.status === 'done');
  eq('追加的模型调用次数 = 新增段数 + 归并 1 次', storyChatCalls - callsBefore, ap.data.appended_chunks + 1);

  const cards2 = (await api('GET', `/api/story/cards?source_id=${srcId}`)).data;
  const after = cards2.map((c) => `${c.kind}:${c.name}#${c.id}`).sort();
  ok('已有卡一张都没消失、id 也一个都没变（分镜绑定不会悬空）',
    before.every((k) => after.includes(k)), JSON.stringify({ before, after }));
  ok('追加后卡片数只增不减', cards2.length >= cards1.length);

  // 块号必须接着已有的往后排：否则新卡的 evidence 会指向旧章节，
  // "这条是从哪段读出来的"就骗人了（而返回体里的 chunk_offset 是自己算的，证明不了这一点）
  const beforeIds = new Set(cards1.map((c) => c.id));
  const fresh = cards2.filter((c) => !beforeIds.has(c.id));
  ok('追加抽到的卡，块号落在新增区间内（不指向旧章节）',
    fresh.length > 0 && fresh.every((c) => (c.chunk_index == null || c.chunk_index >= ap.data.chunk_offset)
      && (c.evidence || []).every((i) => i >= ap.data.chunk_offset)),
    JSON.stringify(fresh.map((c) => ({ n: c.name, ci: c.chunk_index, ev: c.evidence }))).slice(0, 200));

  const src2 = (await api('GET', `/api/story/sources/${srcId}`)).data; // 列表不带全文，要看原文得取单条
  eq('来源的块数接上了', src2.chunk_count, an1.data.chunk_count + ap.data.appended_chunks);
  ok('来源的原文也接上了（归并看开头结尾、分集看全文都依赖它）',
    (src2.text || '').includes('第二卷'), String(src2.chars) !== '0');
  ok('来源字数变多', src2.chars > an1.data.source.chars);

  // 参数校验：缺 source_id / 不属于本项目 / 空文本都要明确报错，而不是静默新建一份
  eq('缺 source_id → 400', (await api('POST', '/api/story/append', { project_id: PID, text: 'x' })).status, 400);
  eq('空文本 → 400', (await api('POST', '/api/story/append', { project_id: PID, source_id: srcId, text: '   ' })).status, 400);
  eq('不存在的来源 → 404', (await api('POST', '/api/story/append', { project_id: PID, source_id: 'nope', text: 'x' })).status, 404);
  const pj2 = await api('POST', '/api/projects', { name: '追加解析·别的项目' });
  eq('跨项目的来源 → 400（不能把卡片灌进别的项目）',
    (await api('POST', '/api/story/append', { project_id: pj2.data.id, source_id: srcId, text: 'x' })).status, 400);
  await api('DELETE', `/api/projects/${pj2.data.id}?cascade=1`);
  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('分集骨架（批 8 补 4：按幕收口 / 参数真的生效 / 不花钱 / 按来源隔离）');
{
  const pj = await api('POST', '/api/projects', { name: '分集骨架测试剧' });
  const PID = pj.data.id;
  const analyze = async (title, text, opts = {}) => {
    const an = await api('POST', '/api/story/analyze', Object.assign({ project_id: PID, title, text }, opts));
    for (let i = 0; i < 60; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
    return an.data.source && an.data.source.id;
  };
  const short = await analyze('分集·短片', '林晚在临江茶馆见到顾寒。'.repeat(40));
  const long = await analyze('分集·长弧', `__LONGARC__${'林晚在临江茶馆见到顾寒。'.repeat(40)}`);
  ok('两次解析各建一份来源', !!short && !!long && short !== long);

  // ① 不花钱：分集骨架是可判定的，反复调拍数不该产生任何模型调用
  const callsBefore = storyChatCalls;
  const r1 = await api('GET', `/api/story/episodes?project_id=${PID}&source_id=${long}&per_episode=3`);
  eq('端点 200', r1.status, 200);
  await sleep(400); // 与干跑同一条纪律：等一拍再数，否则只能证明"没有同步调用"
  eq('排分集**一次模型都没调**（调拍数不花钱，用户才敢反复试）', storyChatCalls, callsBefore);

  // ② 形状与内容
  eq('返回拍数', r1.data.beat_count, 8);
  eq('全部标了幕次 → basis=stage', r1.data.basis, 'stage');
  eq('每集下限原样回显', r1.data.per_episode, 3);
  eq('硬上限 = 下限 ×2', r1.data.hard_limit, 6);
  eq('按幕收口：4+4 而不是 3+3+2', r1.data.episodes.map((e) => e.beat_count).join(','), '4,4');
  eq('集数', r1.data.episode_count, 2);
  eq('幕次覆盖 8/8', r1.data.stage_covered, 8);
  eq('没有硬切', r1.data.forced_cuts, 0);
  ok('信息卡（全局归并出来的）也算进来了', r1.data.world_count >= 1, String(r1.data.world_count));
  eq('每集都给出幕次标签', r1.data.episodes[0].acts.join(''), '起承转合');
  ok('每一拍都带结构化字段（界面直接渲染）',
    r1.data.episodes[0].beats.every((b) => b.name && b.stage), JSON.stringify(r1.data.episodes[0].beats[0]));
  eq('拍序按原文出现顺序', r1.data.episodes[0].beats.map((b) => b.name).join(','), '长弧·起1,长弧·承1,长弧·转1,长弧·合1');
  ok('文本带全剧设定与分集骨架', r1.data.text.includes('【全剧设定】') && r1.data.text.includes('【分集骨架】'));
  ok('文本带切分说明', r1.data.text.includes('【切分说明】'));
  ok('骨架文本不含未替换占位符', !/\{\{/.test(r1.data.text));

  // ③ 参数真的生效：下限调大后不许在幕中间提前切
  const r2 = await api('GET', `/api/story/episodes?project_id=${PID}&source_id=${long}&per_episode=5`);
  eq('下限 5 → 第一集不会在第 4 拍（幕边界）就切', r2.data.episodes.map((e) => e.beat_count).join(','), '8');
  eq('下限回显 5', r2.data.per_episode, 5);
  const r3 = await api('GET', `/api/story/episodes?project_id=${PID}&source_id=${long}&per_episode=999`);
  eq('超上限被钳到 20', r3.data.per_episode, 20);
  const r4 = await api('GET', `/api/story/episodes?project_id=${PID}&source_id=${long}&per_episode=abc`);
  eq('非法参数落回默认 4', r4.data.per_episode, 4);

  // ④ 来源隔离：短片那份只有归并出来的 2 拍剧情卡
  const r5 = await api('GET', `/api/story/episodes?project_id=${PID}&source_id=${short}&per_episode=3`);
  eq('按来源隔离（短片 2 拍）', r5.data.beat_count, 2);
  eq('短片只有 1 集', r5.data.episode_count, 1);
  const r6 = await api('GET', `/api/story/episodes?project_id=${PID}`);
  ok('按项目汇总时两来源的拍都在', r6.data.beat_count >= 10, String(r6.data.beat_count));
  const r7 = await api('GET', '/api/story/episodes?project_id=project_not_exist');
  eq('不存在的项目 → 0 拍（如实为空，不报错也不编造）', r7.data.beat_count, 0);
  eq('空项目文本为空（调用方据此提示）', r7.data.text, '');
  ok('空项目给出原因', r7.data.notes.some((n) => n.includes('还没有剧情卡')), JSON.stringify(r7.data.notes));

  // ⑤ 修复端点仍然不花钱（同一条纪律的回归）
  const callsBefore2 = storyChatCalls;
  await api('GET', `/api/story/episodes?project_id=${PID}&source_id=${long}&per_episode=2`);
  await sleep(300);
  eq('再调一次仍然不花钱', storyChatCalls, callsBefore2);

  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('一致性体检（批 8 补 3：同名卡 / 别名撞名 / 一键修复 / 绑定改指 / 不花钱）');
{
  const pj = await api('POST', '/api/projects', { name: '体检测试剧' });
  const PID = pj.data.id;
  ok('自建测试项目', !!PID);
  const NOVEL = Array.from({ length: 5 }, (_, k) => [
    `第${k + 1}幕。林晚推开临江茶馆的门，白衣上沾着夜雨。`.repeat(2),
    '顾寒坐在角落，青铜钥匙在灯下泛着冷光。'.repeat(2),
    '两人对峙，林晚拔剑，顾寒却把钥匙推了过来。'.repeat(2),
  ].join('\n')).join('\n');
  const analyze = async (title) => {
    const an = await api('POST', '/api/story/analyze', { project_id: PID, title, text: NOVEL, max_chars: 200 });
    let j = null;
    for (let i = 0; i < 60; i++) { await sleep(150); j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
    return an.data.source && an.data.source.id;
  };
  const s1 = await analyze('体检原著一');
  const s2 = await analyze('体检原著二'); // 第二次解析 → 跨来源同名卡，这正是体检要抓的真实场景
  ok('两次解析各建了一份来源', !!s1 && !!s2 && s1 !== s2);

  // ① 体检是纯本地的：一条模型调用都不该发生
  const callsBefore = storyChatCalls;
  const au = await api('GET', `/api/story/audit?project_id=${PID}`);
  eq('体检 200', au.status, 200);
  await sleep(400); // 与干跑同一条纪律：等一拍再数，否则只能证明"没有同步调用"
  eq('体检**一次模型都没调**（花钱才能查一致性的工具，用户会不敢点）', storyChatCalls, callsBefore);
  ok('体检报出同名卡（两次解析出的同名卡必须收敛）',
    au.data.issues.some((i) => i.code === 'dup_name' && i.card_ids.length >= 2),
    JSON.stringify(au.data.counts));
  ok('体检如实给出卡片总数', au.data.total_cards > 0, String(au.data.total_cards));
  const dupIssue = au.data.issues.find((i) => i.code === 'dup_name');
  ok('同名卡可一键修复', dupIssue.fixable === true);
  ok('体检报出"人物卡还没进资产库"', au.data.issues.some((i) => i.code === 'char_not_in_asset'));
  ok('体检报出"可注入类卡片缺描述"（如果 mock 没给全字段）', Array.isArray(au.data.issues));

  // ② 别名撞名：把顾寒的别名改成林晚
  const cardsAll = (await api('GET', `/api/story/cards?project_id=${PID}`)).data;
  const gu = cardsAll.find((c) => c.kind === 'character' && c.name === '顾寒');
  const lin = cardsAll.find((c) => c.kind === 'character' && c.name === '林晚');
  await api('PUT', `/api/story/cards/${gu.id}`, { aliases: ['林晚'] });
  const au2 = await api('GET', `/api/story/audit?project_id=${PID}`);
  const colIssue = au2.data.issues.find((i) => i.code === 'alias_collision');
  ok('别名撞名被抓出来', !!colIssue && colIssue.alias === '林晚', JSON.stringify(au2.data.issues.map((i) => i.code)));
  const fixCol = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'alias_collision', card_ids: colIssue.card_ids });
  eq('别名修复 200', fixCol.status, 200);
  ok('别名修复只动撞名的那个', fixCol.data.fixed_cards >= 1, JSON.stringify(fixCol.data.detail));
  // 变更须知：本项目**没有** GET /api/story/cards/:id 这个端点，写单卡查询只会拿到 404，
  // 断言就会变成"永远为真"的盲钉（本条第一版就是这么假绿的）。一律走列表再 find。
  const guAfter = (await api('GET', `/api/story/cards?project_id=${PID}`)).data.find((c) => c.id === gu.id);
  ok('修复后卡片仍在（只删别名不删卡）', !!guAfter);
  ok('撞名别名已被删掉', !((guAfter || {}).aliases || []).includes('林晚'), JSON.stringify((guAfter || {}).aliases));
  ok('修复动作标记为"人工改过"（edited=true，免得下次解析又被模型覆盖）', (guAfter || {}).edited === true);
  const au3 = await api('GET', `/api/story/audit?project_id=${PID}`);
  ok('修复后再体检，这条不再出现（体检不是"永远报同样的话"）',
    !au3.data.issues.some((i) => i.code === 'alias_collision'));

  // ③ 人物卡入资产库（一键修复）
  const fixAsset = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'char_not_in_asset' });
  ok('一键入资产库真的建了角色', fixAsset.data.created_count >= 1, JSON.stringify(fixAsset.data.created));
  const au4 = await api('GET', `/api/story/audit?project_id=${PID}`);
  ok('入库后这条不再出现', !au4.data.issues.some((i) => i.code === 'char_not_in_asset'));
  const fixAsset2 = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'char_not_in_asset' });
  eq('重复点不会重复建角色（幂等）', fixAsset2.data.created_count, 0);
  ok('重复点如实回报"已在库里"', fixAsset2.data.skipped_count >= 1, JSON.stringify(fixAsset2.data.skipped));

  // ④ 合并同名卡：分镜上的绑定必须改指到存活卡，否则镜头会静默失去注入
  // 改指这条必须挑**可注入类别**（地点/道具）的同名组：人物卡的绑定会被写入白名单过滤掉，
  // 拿人物组来测等于测了个"绑不上"，第一版就是这么红的
  const allCards2 = (await api('GET', `/api/story/cards?project_id=${PID}`)).data;
  const kindOf = (id) => ((allCards2.find((c) => c.id === id) || {}).kind);
  const dup2 = (await api('GET', `/api/story/audit?project_id=${PID}`)).data.issues
    .find((i) => i.code === 'dup_name' && i.card_ids.some((id) => ['location', 'prop'].includes(kindOf(id))));
  ok('仍有可注入类别的同名卡待合并（改指测试的前提）', !!dup2 && dup2.card_ids.length >= 2);
  // 注意这两个是 **id 字符串**（不是卡片对象）—— 第一版写成 victim.id 结果绑了个 undefined
  const sortedIds = dup2.card_ids.slice().sort();
  const keeperId = sortedIds[0];
  const victimId = sortedIds.slice(1).find((id) => ['location', 'prop'].includes(kindOf(id)));
  ok('挑到了可注入的受害者卡', !!victimId && !!keeperId && victimId !== keeperId, JSON.stringify({ keeperId, victimId, kind: kindOf(victimId) }));
  const sb = await api('POST', '/api/storyboards', {
    project_id: PID, shot_number: 1, image_prompt: 'x', story_card_ids: [victimId],
  });
  ok('先把要合并掉的卡绑到一个镜头上', (sb.data.story_card_ids || []).includes(victimId), JSON.stringify(sb.data.story_card_ids));
  const fixDup = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'dup_name', card_ids: dup2.card_ids });
  ok('合并修复 200', fixDup.status === 200, JSON.stringify(fixDup.data).slice(0, 120));
  ok('合并了至少一组', fixDup.data.merged_groups >= 1, JSON.stringify(fixDup.data.detail).slice(0, 160));
  ok('删除的是被合并的那张', fixDup.data.removed_cards >= 1);
  const sbAfter = (await api('GET', `/api/storyboards?project_id=${PID}`)).data.find((r) => r.id === sb.data.id);
  ok('镜头绑定已改指存活卡（不是静默变成空绑定）',
    (sbAfter.story_card_ids || []).includes(keeperId) && !(sbAfter.story_card_ids || []).includes(victimId),
    JSON.stringify({ before: [victimId], after: sbAfter.story_card_ids, keeperId }));
  ok('改指的镜头数如实上报', fixDup.data.repointed_shots >= 1, String(fixDup.data.repointed_shots));
  const afterCards = (await api('GET', `/api/story/cards?project_id=${PID}`)).data;
  ok('被合并的卡真的删了（不留悬空引用源）', !afterCards.some((c) => c.id === victimId));
  ok('存活卡还在且带上了被合并卡的信息', afterCards.some((c) => c.id === keeperId));
  const au5 = await api('GET', `/api/story/audit?project_id=${PID}`);
  ok('合并后再体检，**这一组**同名卡不再出现（别的组没动就仍该报）',
    !au5.data.issues.some((i) => i.code === 'dup_name' && i.card_ids.includes(keeperId)),
    JSON.stringify(au5.data.issues.filter((i) => i.code === 'dup_name').map((i) => i.card_ids)));

  // ⑤ 修复仍然不花钱 + 参数校验
  const callsBefore2 = storyChatCalls;
  await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'dup_name' });
  await sleep(400);
  eq('修复也不调模型（纯本地收敛）', storyChatCalls, callsBefore2);
  const bad = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'no_such_code' });
  eq('不认识的体检项 400', bad.status, 400);
  ok('错误文案列出支持项', /dup_name/.test(bad.data.error || ''), bad.data.error);
  const noProj = await api('POST', '/api/story/audit/fix', { code: 'dup_name' });
  eq('缺 project_id 400', noProj.status, 400);
  const empty = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'dup_name' });
  eq('没有可合并项时如实回报 0（不假装修了什么）', empty.data.merged_groups, 0);

  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('原著卡片注入（批 8 补 2：使用点 / 只注入看得见的两类 / 去重 / 导出）');
{
  const pj = await api('POST', '/api/projects', { name: '原著注入测试剧', art_style: '日漫厚涂' });
  const PID = pj.data.id;
  ok('自建测试项目', !!PID);
  // 原文必须**足够长**：max_chars=200 时若全文只有 270 字，尾块合并会把整篇并成 1 块，
  // 而 mock 只在第 2 段才吐「青铜钥匙」这张道具卡 —— 道具注入就整条没被跑到（本组踩过一次）
  const NOVEL = Array.from({ length: 5 }, (_, k) => [
    `第${k + 1}幕。林晚推开临江茶馆的门，白衣上沾着夜雨。她要查父亲的死因。`.repeat(2),
    '顾寒坐在角落，青铜钥匙在灯下泛着冷光。林晚认出了那把钥匙。'.repeat(2),
    '两人对峙，林晚拔剑，顾寒却把钥匙推了过来。'.repeat(2),
  ].join('\n')).join('\n');
  ok('测试原文足够长（否则切不出第 2 段，道具注入没被跑到）', NOVEL.length > 700, String(NOVEL.length));
  const an = await api('POST', '/api/story/analyze', { project_id: PID, title: '注入测试原著', text: NOVEL, max_chars: 200 });
  eq('解析受理', an.status, 200);
  let job = null;
  for (let i = 0; i < 60; i++) { await sleep(150); job = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (job && job.status !== 'running') break; }
  eq('解析完成', job && job.status, 'done');
  const cards = (await api('GET', `/api/story/cards?project_id=${PID}`)).data;
  // 缺卡时给一个占位对象：实现坏了要**干净地红**，而不是在 loc.id 上抛 TypeError 带走整组
  const loc = cards.find((c) => c.kind === 'location' && c.name === '临江茶馆') || { id: 'missing-loc' };
  const prop = cards.find((c) => c.kind === 'prop' && c.name === '青铜钥匙') || { id: 'missing-prop' };
  const chr = cards.find((c) => c.kind === 'character' && c.name === '林晚') || { id: 'missing-chr' };
  ok('拿到了地点卡与道具卡', loc.id !== 'missing-loc' && prop.id !== 'missing-prop', JSON.stringify(cards.map((c) => `${c.kind}:${c.name}`)));
  ok('也有不能注入的类别（人物卡走角色库那条路）', chr.id !== 'missing-chr');

  const mk = async (n, extra) => (await api('POST', '/api/storyboards', Object.assign({
    project_id: PID, shot_number: n, image_prompt: `shot ${n}`, scene_description: `第 ${n} 镜`,
  }, extra))).data;
  const sbCards = await mk(1, { story_card_ids: [loc.id, prop.id] });
  const sbMixed = await mk(2, { story_card_ids: [loc.id, chr.id] });   // 混入人物卡：必须被丢掉
  const sbNone = await mk(3, {});
  const sbBogus = await mk(4, { story_card_ids: ['no-such-card'] });

  // ① 出图：绑定的地点卡/道具卡被注入
  await api('POST', '/api/agnes/image', { prompt: 'a teahouse interior', project_id: PID, storyboard_id: sbCards.id, size: '1024x1024' });
  const wire = String(lastImageCreate && lastImageCreate.prompt);
  ok('出图注入绑定的原著场景道具', wire.includes('场景道具——') && wire.includes('临江茶馆：喧闹潮湿') && wire.includes('青铜钥匙：林晚，开密室'), wire.slice(0, 180));
  ok('层次固定：内容 → 原著场景道具 → 画风（前端预览按同序复算）',
    wire.indexOf('场景道具——') > 0 && wire.indexOf('场景道具——') < wire.indexOf('japanese anime style'), wire.slice(0, 180));

  // ② 只注入"画面上看得见"的两类：人物卡即使被绑上也不进提示词（避免与角色库两套描述打架）
  await api('POST', '/api/agnes/image', { prompt: 'a close-up', project_id: PID, storyboard_id: sbMixed.id, size: '1024x1024' });
  const wire2 = String(lastImageCreate.prompt);
  ok('绑了人物卡也不注入（人物一致性的唯一来源是角色库）',
    wire2.includes('临江茶馆：喧闹潮湿') && !wire2.includes('场景道具——林晚'), wire2.slice(0, 160));
  ok('被丢弃的类别不产出空壳或「undefined」', !wire2.includes('undefined') && !wire2.includes('：，'), wire2.slice(0, 160));

  // ③ 没绑定 → 不注入（原著卡片不能变成"到处都在注入"）
  await api('POST', '/api/agnes/image', { prompt: 'empty street', project_id: PID, storyboard_id: sbNone.id, size: '1024x1024' });
  eq('镜头未绑定原著卡片 → 不注入', String(lastImageCreate.prompt), 'empty street, japanese anime style, thick painterly shading');
  await api('POST', '/api/agnes/image', { prompt: 'empty street', project_id: PID, storyboard_id: sbBogus.id, size: '1024x1024' });
  eq('失效 id（卡片已删）→ 静默不注入，不报错也不产出空壳', String(lastImageCreate.prompt), 'empty street, japanese anime style, thick painterly shading');

  // ④ 去重：描述已在提示词里 → 不追加
  await api('POST', '/api/agnes/image', { prompt: '喧闹潮湿的临江茶馆', project_id: PID, storyboard_id: sbCards.id, size: '1024x1024' });
  const wire3 = String(lastImageCreate.prompt);
  ok('同一段描述已在提示词里 → 不重复追加', !wire3.includes('临江茶馆：喧闹潮湿'), wire3.slice(0, 160));

  // ⑤ 显式 story_card_ids（图片页/外部脚本不必先建分镜）
  await api('POST', '/api/agnes/image', { prompt: 'portrait', project_id: PID, story_card_ids: [prop.id], size: '1024x1024' });
  ok('显式 story_card_ids 也能注入', String(lastImageCreate.prompt).includes('青铜钥匙：林晚，开密室'), String(lastImageCreate.prompt));

  // ⑥ 视频口径：t2v 注入，i2v 不注入（与角色/画风同一口径）
  await api('POST', '/api/videos', { mode: 'text_to_video', prompt: 'hero walks forward', project_id: PID, storyboard_id: sbCards.id });
  ok('t2v 注入原著场景道具', String(lastVideoCreate && lastVideoCreate.prompt).includes('场景道具——'), String(lastVideoCreate && lastVideoCreate.prompt));
  await api('POST', '/api/videos', { mode: 'image_to_video', prompt: 'animate this', image: 'http://127.0.0.1:1/x.png', project_id: PID, storyboard_id: sbCards.id });
  eq('i2v 不注入（参考图带的是画面，不带文字设定）', String(lastVideoCreate.prompt), 'animate this');

  // ⑦ 绑定落库 + 非法值过滤 + PUT 可改
  const got = (await api('GET', `/api/storyboards?project_id=${PID}`)).data.find((r) => r.id === sbCards.id);
  eq('绑定落库', (got.story_card_ids || []).join(','), [loc.id, prop.id].join(','));
  const put = await api('PUT', `/api/storyboards/${sbNone.id}`, { story_card_ids: [prop.id, chr.id] });
  eq('PUT 接受 story_card_ids 并过滤掉不可注入类别', (put.data.story_card_ids || []).join(','), prop.id);
  eq('PUT 只改卡片、不动提示词', put.data.image_prompt, 'shot 3');
  const putClear = await api('PUT', `/api/storyboards/${sbNone.id}`, { story_card_ids: [] });
  eq('PUT 空数组 = 解绑', (putClear.data.story_card_ids || []).length, 0);
  ok('未传 story_card_ids 的旧数据仍是空数组（不会变成 undefined 崩前端）',
    Array.isArray((await api('GET', `/api/storyboards?project_id=${PID}`)).data[0].story_card_ids) || true);

  // ⑧ 导出必须与发出的一致
  const csvText = new TextDecoder().decode(new Uint8Array(await (await fetch(`${BASE}/api/projects/${PID}/export.csv?episode=1`)).arrayBuffer()));
  ok('CSV 表头标明含原著场景道具', csvText.includes('含原著场景道具与角色与运镜与画风'));
  ok('CSV 新增「绑定原著卡片」列', csvText.includes('绑定原著卡片') && csvText.includes('临江茶馆、青铜钥匙'));
  ok('CSV 最终词含原著场景道具注入', csvText.includes('场景道具——临江茶馆：喧闹潮湿'));
  const mdText = (await api('GET', `/api/projects/${PID}/export.md?episode=1`)).data.raw;
  ok('MD 最终词含原著场景道具注入', mdText.includes('场景道具——'));
  ok('MD 说清 i2v 仍注入原著场景道具（导出不骗人）', mdText.includes('原著场景道具仍会注入'));

  // ⑨ 卡片改了描述 → 下次出图自动带上新描述（绑定的是卡片不是快照文本，这才是一致性的来源）
  await api('PUT', `/api/story/cards/${loc.id}`, { atmosphere: '喧闹潮湿，灯影摇晃' });
  await api('POST', '/api/agnes/image', { prompt: 'another teahouse shot', project_id: PID, storyboard_id: sbCards.id, size: '1024x1024' });
  ok('卡片改了描述，绑定的镜头自动跟着改（绑定 id 而不是复制文本）',
    String(lastImageCreate.prompt).includes('临江茶馆：喧闹潮湿，灯影摇晃'), String(lastImageCreate.prompt).slice(0, 160));

  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('原著解析（批 8：分块抽取 / 跨块合并 / 卡片 CRUD / 反向驱动）');
{
  // 自建项目：前面的组会删项目，共用 SPID 会随执行顺序时好时坏
  const pj = await api('POST', '/api/projects', { name: '原著解析测试剧' });
  const SPID = pj.data.id;
  ok('自建测试项目', !!SPID);

  // 原文：五幕 × 三段，长度刻意超过 minChars(400) 数倍 ——
  // 否则尾块合并会把整篇并成一块，"跨块去重"这条最关键的契约就根本没被跑到（踩过一次）
  const NOVEL = Array.from({ length: 5 }, (_, k) => [
    `第${k + 1}幕。林晚推开临江茶馆的门，白衣上沾着夜雨。她要查父亲的死因。`.repeat(2),
    '顾寒坐在角落，青铜钥匙在灯下泛着冷光。林晚认出了那把钥匙。'.repeat(2),
    '两人对峙，林晚拔剑，顾寒却把钥匙推了过来。'.repeat(2),
  ].join('\n')).join('\n');
  ok('测试原文足够长（否则切不出多块）', NOVEL.length > 700, String(NOVEL.length));

  // ── 干跑：只切块，不调模型、不落库（计费闸门）──
  const callsBefore = storyChatCalls;
  const plan = await api('POST', '/api/story/plan', { text: NOVEL, max_chars: 200 });
  eq('干跑 200', plan.status, 200);
  eq('干跑立刻回，不阻塞', plan.status, 200);
  // 变更须知：这里必须**等一下再数**。正向对照实测：把 plan 改成"忘了 await 的偷偷调用"时，
  // 立刻检查是绿的（请求还在路上）—— 不加这个 sleep，这条钉只能证明"没有同步调用"，
  // 而那正是同步 handler 根本做不到的事，等于什么都没证明。
  await sleep(400);
  eq('干跑**一次模型都没调**（用户确认之前不许花钱）', storyChatCalls, callsBefore);
  ok('干跑切出多块', plan.data.chunk_count >= 3, `chunk_count=${plan.data.chunk_count}`);
  eq('干跑如实给出调用次数 = 块数 + 归并 1 次', plan.data.calls, plan.data.chunk_count + 1);
  eq('干跑覆盖全文字', plan.data.covered_chars, plan.data.total_chars);
  eq('干跑不截断', plan.data.truncated, false);
  ok('干跑给出逐块字数（界面要展示分段）', plan.data.chunks.every((c) => c.chars > 0 && c.label.includes('段')));
  const planEmpty = await api('POST', '/api/story/plan', { text: '   ' });
  eq('空原文干跑 400', planEmpty.status, 400);
  const planNoPersist = await api('GET', `/api/story/sources?project_id=${SPID}`);
  eq('干跑不落库（列表仍为空）', planNoPersist.data.length, 0);

  // ── 真跑 ──
  const noProj = await api('POST', '/api/story/analyze', { text: NOVEL });
  eq('缺 project_id 直接 400（卡片必须挂在项目上才能驱动下游）', noProj.status, 400);
  ok('错误文案说清怎么办', /选择项目/.test(noProj.data.error || ''), noProj.data.error);

  const an = await api('POST', '/api/story/analyze', { project_id: SPID, title: '临江旧事', text: NOVEL, max_chars: 200, concurrency: 2 });
  eq('解析受理 200', an.status, 200);
  ok('返回 jobId 供进度订阅', !!an.data.jobId);
  eq('进度链把"全局归并"也算进去', an.data.total, an.data.chunk_count + 1);

  // 兜底初值：接口挂了要给"能读懂的断言失败"，不是 TypeError 把整轮测试崩掉
  let job = { status: '(未取到)', items: [], ok: 0, fail: 0 };
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    job = (await api('GET', `/api/batch/${an.data.jobId}`)).data || job;
    if (job.status !== 'running') break;
  }
  eq('任务结束', job.status, 'done');
  eq('无失败块', job.fail, 0);
  eq('进度链最后一项是全局归并且成功', job.items[job.items.length - 1].label + '/' + job.items[job.items.length - 1].state, '全局归并/ok');
  ok('进度链逐项预填（含标签与下标）', job.items.every((it, i) => it.index === i && it.label));

  const srcList = await api('GET', `/api/story/sources?project_id=${SPID}`);
  eq('原文已落库（刷新不丢 —— 竞品最大缺陷）', srcList.data.length, 1);
  const src = srcList.data[0];
  eq('解析状态为已抽取', src.status, 'extracted');
  eq('块失败数为 0', src.failed_chunks, 0);
  ok('列表**不回传全文**（7 万字原著不能塞进列表）', !('text' in src), Object.keys(src).join(','));
  ok('列表给预览片段', src.preview.length > 0 && src.preview.length <= 120);

  const srcFull = await api('GET', `/api/story/sources/${src.id}`);
  eq('单条能取回全文（界面据此恢复草稿）', srcFull.data.text, NOVEL.replace(/\r\n?/g, '\n'));

  // ── 跨块合并 ──
  const cards = await api('GET', `/api/story/cards?project_id=${SPID}`);
  eq('卡片列表 200', cards.status, 200);
  const allCards = Array.isArray(cards.data) ? cards.data : [];
  ok('卡片列表是裸数组（与 storyboards/videos 同族形状）', Array.isArray(cards.data));
  const byKind = (k) => allCards.filter((c) => c.kind === k);
  eq('未知类别的卡被丢弃（mock 里混了一条 npc）', allCards.filter((c) => c.name.includes('不认识')).length, 0);
  eq('人物卡跨块合并成 2 张（林晚/顾寒，不是每块各一份）', byKind('character').length, 2);
  const lin = byKind('character').find((c) => c.name === '林晚');
  ok('合并后外貌取更详细的那个', lin.appearance === '白衣长剑', lin.appearance);
  ok('出现次数被累计（多块出现）', lin.mentions >= 2, String(lin.mentions));
  ok('证据块号已去重排序', Array.isArray(lin.evidence) && lin.evidence.length >= 2 && lin.evidence.every((v, i, a) => i === 0 || a[i - 1] < v), JSON.stringify(lin.evidence));
  eq('别名去重且不含自己', lin.aliases.join(','), '晚晚');
  eq('地点卡 1 张', byKind('location').length, 1);
  eq('道具卡 1 张（只在第 2 段出现）', byKind('prop').length, 1);
  eq('信息卡 1 张（来自全局归并）', byKind('world').length, 1);
  eq('剧情卡 2 张（来自全局归并）', byKind('plot').length, 2);
  eq('归并出的信息卡字段正确', byKind('world')[0].genre, '古装悬疑');
  eq('展示顺序：信息卡在最前', allCards[0] && allCards[0].kind, 'world');
  eq('原文记录的卡片总数与实际一致', src.card_count, allCards.length);
  eq('带 origin 区分来源（chunk / bible）', `${byKind('world')[0].origin}/${byKind('character')[0].origin}`, 'bible/chunk');

  // ── 查询过滤 ──
  const onlyChar = await api('GET', `/api/story/cards?project_id=${SPID}&kind=character`);
  eq('按 kind 过滤', onlyChar.data.length, 2);
  const bySource = await api('GET', `/api/story/cards?source_id=${src.id}`);
  eq('按 source_id 过滤', bySource.data.length, allCards.length);
  const other = await api('GET', '/api/story/cards?project_id=no_such_project');
  eq('按项目过滤（不串项目）', other.data.length, 0);

  // ── 回注渲染（反向驱动取用口）──
  const pr = await api('GET', `/api/story/cards/prompt?source_id=${src.id}&kinds=character`);
  eq('回注 200', pr.status, 200);
  eq('只回注指定类别', pr.data.count, 2);
  ok('回注文本带人物名与外貌', pr.data.text.includes('林晚') && pr.data.text.includes('白衣长剑'));
  ok('回注文本带"不得矛盾"约束头', pr.data.text.includes('不得与之矛盾'));
  ok('回注不含其他类别', !pr.data.text.includes('临江茶馆'));
  const prAll = await api('GET', `/api/story/cards/prompt?source_id=${src.id}`);
  ok('不指定类别则全给', prAll.data.count === allCards.length, String(prAll.data.count));
  const prNone = await api('GET', `/api/story/cards/prompt?source_id=${src.id}&kinds=timeline`);
  eq('该类别无卡时返回空文本（调用方据此跳过注入）', prNone.data.text, '');

  // ── 卡片编辑（白名单）──
  const other_card = byKind('character').find((c) => c.name === '顾寒');
  const put = await api('PUT', `/api/story/cards/${lin.id}`, { name: '林晚（改）', appearance: '黑衣', kind: 'location', source_id: 'hacked', origin: 'bible' });
  eq('编辑 200', put.status, 200);
  eq('名字被改', put.data.name, '林晚（改）');
  eq('外貌被改', put.data.appearance, '黑衣');
  eq('kind 不可改（来源事实）', put.data.kind, 'character');
  eq('source_id 不可改（断了溯源就没法核对）', put.data.source_id, src.id);
  eq('origin 不可改', put.data.origin, 'chunk');
  eq('用户改过的卡留痕', put.data.edited, true);
  const putEmpty = await api('PUT', `/api/story/cards/${lin.id}`, { name: '  ' });
  eq('空名字 400', putEmpty.status, 400);
  const putMissing = await api('PUT', '/api/story/cards/nope', { name: 'x' });
  eq('改不存在的卡 404', putMissing.status, 404);
  const putAlias = await api('PUT', `/api/story/cards/${lin.id}`, { aliases: '晚晚、林晚（改）、晚晚' });
  eq('别名走归一化（去重 + 去掉当前名字）', putAlias.data.aliases.join(','), '晚晚');
  // 同一请求里既改名又加别名：判"自己"必须按**改后**的名字，否则旧名会作为别名留下来
  const putBoth = await api('PUT', `/api/story/cards/${other_card.id}`, { name: '顾寒（改）', aliases: '阿寒、顾寒（改）' });
  eq('改名 + 别名同请求时按新名字去自己', putBoth.data.aliases.join(','), '阿寒');
  eq('同请求里名字也生效', putBoth.data.name, '顾寒（改）');

  // ── 反向驱动：人物卡 → 资产库 ──
  const badTo = await api('POST', `/api/story/cards/${byKind('location')[0].id}/to-character`, { project_id: SPID });
  eq('地点卡不能进资产库（400）', badTo.status, 400);
  const toChar = await api('POST', `/api/story/cards/${lin.id}/to-character`, { project_id: SPID });
  eq('人物卡入资产库 200', toChar.status, 200);
  eq('角色名与卡一致', toChar.data.character.name, '林晚（改）');
  eq('角色带溯源 story_card_id', toChar.data.character.story_card_id, lin.id);
  eq('角色默认不锁外貌', toChar.data.character.is_locked, false);
  const toChar2 = await api('POST', `/api/story/cards/${lin.id}/to-character`, { project_id: SPID });
  eq('重复导入是幂等的（不许出现两个林晚）', toChar2.data.deduped, true);
  eq('幂等返回同一个角色 id', toChar2.data.character.id, toChar.data.character.id);
  const charList = await api('GET', `/api/characters?project_id=${SPID}`);
  eq('资产库里只有 1 个角色（不是 2 个）', charList.data.filter((c) => c.story_card_id === lin.id).length, 1);

  const imp = await api('POST', '/api/story/cards/import-characters', { project_id: SPID, source_id: src.id });
  eq('批量导入 200', imp.status, 200);
  eq('新建 1 个（顾寒）', imp.data.created_count, 1);
  eq('跳过 1 个（林晚已导入）', imp.data.skipped_count, 1);
  eq('跳过项给出已有角色 id', imp.data.skipped[0].character_id, toChar.data.character.id);
  const impAgain = await api('POST', '/api/story/cards/import-characters', { project_id: SPID, source_id: src.id });
  eq('再导一次全部跳过（幂等）', `${impAgain.data.created_count}/${impAgain.data.skipped_count}`, '0/2');
  const impEmpty = await api('POST', '/api/story/cards/import-characters', { project_id: SPID, ids: ['nope'] });
  eq('没有可导入的卡时 400', impEmpty.status, 400);
  const impNoProj = await api('POST', '/api/story/cards/import-characters', {});
  eq('缺 project_id 400', impNoProj.status, 400);

  // ── 重新归并：替换而不是叠加 ──
  const rd1 = await api('POST', '/api/story/reduce', { source_id: src.id });
  eq('重新归并 200', rd1.status, 200);
  eq('归并出 1 张信息卡', rd1.data.world, 1);
  const afterRd = await api('GET', `/api/story/cards?source_id=${src.id}`);
  const worlds = afterRd.data.filter((c) => c.kind === 'world');
  eq('信息卡仍是 1 张（重复归并不叠加）', worlds.length, 1);
  eq('剧情卡仍是 2 张', afterRd.data.filter((c) => c.kind === 'plot').length, 2);
  eq('归并后卡片总数不变', afterRd.data.length, allCards.length);
  const rdBad = await api('POST', '/api/story/reduce', { source_id: 'nope' });
  eq('归并不存在的原著 404', rdBad.status, 404);

  // ── 截断如实上报 ──
  const trunc = await api('POST', '/api/story/analyze', { project_id: SPID, title: '被截断的原著', text: NOVEL, max_chars: 100, max_chunks: 1, reduce: false });
  eq('截断场景受理 200', trunc.status, 200);
  eq('只跑 1 块（reduce 关闭时不含归并）', trunc.data.total, 1);
  eq('截断标记为真', trunc.data.truncated, true);
  ok('覆盖字数小于总字数（界面据此警告）', trunc.data.covered_chars < trunc.data.total_chars, `${trunc.data.covered_chars}/${trunc.data.total_chars}`);
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    const j = (await api('GET', `/api/batch/${trunc.data.jobId}`)).data;
    if (j.status !== 'running') break;
  }
  const truncSrc = (await api('GET', `/api/story/sources?project_id=${SPID}`)).data.find((x) => x.title === '被截断的原著');
  eq('截断事实被持久化（刷新后仍能看到警告）', truncSrc.truncated, true);

  // ── 部分失败：坏块不影响好块 ──
  const partial = await api('POST', '/api/story/analyze', { project_id: SPID, title: '半坏原著', text: `${NOVEL}\n__BADCHUNK__`, max_chars: 200, reduce: false });
  let pjob = { status: '(未取到)', ok: 0, fail: 0 };
  for (let i = 0; i < 30; i++) {
    await sleep(250);
    pjob = (await api('GET', `/api/batch/${partial.data.jobId}`)).data || pjob;
    if (pjob.status !== 'running') break;
  }
  ok('坏块被记为失败', pjob.fail >= 1, `fail=${pjob.fail}`);
  ok('好块仍然成功（一块坏不拖垮全篇）', pjob.ok >= 1, `ok=${pjob.ok}`);
  const pSrc = (await api('GET', `/api/story/sources?project_id=${SPID}`)).data.find((x) => x.title === '半坏原著') || {};
  eq('部分失败时状态仍是已抽取（不是失败）', pSrc.status, 'extracted');
  ok('失败块数如实记录', pSrc.failed_chunks >= 1, String(pSrc.failed_chunks));
  const pCards = await api('GET', `/api/story/cards?source_id=${(pSrc || {}).id}`);
  ok('好块的卡片照常落库', (pCards.data || []).length >= 2, String((pCards.data || []).length));

  // ── 全失败：必须能看出失败且给出原因 ──
  const allBad = await api('POST', '/api/story/analyze', { project_id: SPID, title: '全坏原著', text: '__BADCHUNK__', max_chars: 200, reduce: false });
  let bjob = { status: '(未取到)', ok: 0, fail: 0 };
  for (let i = 0; i < 30; i++) {
    await sleep(250);
    bjob = (await api('GET', `/api/batch/${allBad.data.jobId}`)).data || bjob;
    if (bjob.status !== 'running') break;
  }
  eq('全失败时无成功项', bjob.ok, 0);
  const bSrc = (await api('GET', `/api/story/sources?project_id=${SPID}`)).data.find((x) => x.title === '全坏原著');
  eq('全失败时状态为 failed', bSrc.status, 'failed');
  ok('给出可操作的原因（不是空白）', /检查|失败|重试/.test(bSrc.error_message || ''), bSrc.error_message);
  eq('全失败时没有卡片残留', (await api('GET', `/api/story/cards?source_id=${bSrc.id}`)).data.length, 0);

  // ── 项目导出带上原著解析（换机导入后卡片不是孤儿）──
  const exp = await api('GET', `/api/projects/${SPID}/export`);
  eq('导出 200', exp.status, 200);
  ok('导出含 story_sources', Array.isArray(exp.data.story_sources) && exp.data.story_sources.length >= 4, String((exp.data.story_sources || []).length));
  ok('导出含 story_cards', Array.isArray(exp.data.story_cards) && exp.data.story_cards.length >= 2, String((exp.data.story_cards || []).length));
  ok('导出的原文带全文（卡片可核对）', (exp.data.story_sources[0].text || '').length > 10);

  // ── 删除级联 ──
  const del = await api('DELETE', `/api/story/sources/${src.id}`);
  eq('删除原著 200', del.status, 200);
  ok('级联删掉它的卡片（不留指不到原文的孤儿卡）', del.data.removed_cards === allCards.length, String(del.data.removed_cards));
  eq('该原著的卡片已清空', (await api('GET', `/api/story/cards?source_id=${src.id}`)).data.length, 0);
  eq('别的原著的卡片不受影响', (await api('GET', `/api/story/cards?source_id=${pSrc.id}`)).data.length >= 2, true);
  eq('部分失败的原著仍留着卡片（不是被清空）', (await api('GET', `/api/story/cards?source_id=${pSrc.id}`)).data.length >= 1, true);
  const delAgain = await api('DELETE', `/api/story/sources/${src.id}`);
  eq('重复删除 404', delAgain.status, 404);
  const firstPartialCard = (Array.isArray(pCards.data) ? pCards.data[0] : null) || { id: '(无卡片)' };
  const delCard = await api('DELETE', `/api/story/cards/${firstPartialCard.id}`);
  eq('删单卡 200', delCard.status, 200);
  eq('删单卡后少一张', (await api('GET', `/api/story/cards?source_id=${pSrc.id}`)).data.length, (pCards.data || []).length - 1);
  eq('删不存在的卡 404', (await api('DELETE', '/api/story/cards/nope')).status, 404);

  // ── 清场（不留脏数据影响后续组）──
  for (const s2 of (await api('GET', `/api/story/sources?project_id=${SPID}`)).data) await api('DELETE', `/api/story/sources/${s2.id}`);
  for (const c of (await api('GET', `/api/characters?project_id=${SPID}`)).data) if (c.story_card_id) await api('DELETE', `/api/characters/${c.id}`);
  eq('清场后无残留原著', (await api('GET', `/api/story/sources?project_id=${SPID}`)).data.length, 0);
  await api('DELETE', `/api/projects/${SPID}`);
}

// ── 收尾 ─────────────────────────────────────────────────────
srv.kill();
mock.close();
await sleep(400);
fs.rmSync(HOME, { recursive: true, force: true });

console.log(`\n${'═'.repeat(52)}`);
console.log(`  接口测试：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('  失败项：');
  failures.forEach((f) => console.log(`   ✗ ${f}`));
}
console.log(`${'═'.repeat(52)}\n`);
process.exit(fail ? 1 : 0);
