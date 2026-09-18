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
  if (auth !== `Bearer ${MOCK_KEY}`) {
    // 审核加强：值精确匹配注入 Key——只校格式的话任何假 token 都放行，错 Key 链路回归测不出
    return send(401, { error: { message: /^Bearer \S+$/.test(auth) ? 'invalid api key (mock)' : 'missing bearer (mock guard)' } });
  }
  if (req.method === 'GET' && u.pathname === '/agnesapi') {
    lastVideoQueryUrl = req.url;
    if (/2\.5/.test(String(u.searchParams.get('model_name') || ''))) {
      // 2.5 系查询契约：带 model_name，完成后的地址在 metadata.url
      last25QueryUrl = req.url;
      return send(200, { id: VIDEO_ID, status: 'completed', progress: 100, metadata: { url: `${MOCK_BASE}/video.mp4` } });
    }
    queryCount++;
    if (queryCount <= 1) return send(200, { id: VIDEO_ID, status: 'queued', progress: 20 });
    return send(200, { id: VIDEO_ID, status: 'completed', progress: 100, remixed_from_video_id: `${MOCK_BASE}/video.mp4` });
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
      return send(200, { choices: [{ message: { role: 'assistant', content: '```json\n[{"shot_number":1,"shot_type":"特写","image_prompt":"a hero face"}]\n```' } }] });
    }
    if (u.pathname === '/v1/images/generations') {
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
      try { lastVideoCreate = JSON.parse(body); } catch { lastVideoCreate = { bad_json: body }; }
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
  const r = await api('POST', '/api/videos', {
    prompt: 'hero turns and smiles',
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

  const before = (await api('GET', `/api/images?project_id=${PROJECT_ID}`)).data.length;
  ok('批量生成的图片已入库', before >= 3, `${before} 张`);

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
  const badKey = await api('POST', '/api/agnes/text', { messages: [{ role: 'user', content: 'hi' }] });
  ok('错 Key → 业务失败', badKey.data.ok === false, JSON.stringify(badKey.data).slice(0, 90));
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
}

// ── 16. 清理 ─────────────────────────────────────────────────
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
