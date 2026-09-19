/**
 * selftest.mjs — 离线自检（不联网、不起服务）
 * 覆盖：数据层 CRUD、设置脱敏、导入导出、状态机、URL 归一化、批量队列、路由分发
 *
 * 用法：node tools/selftest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(path.join(ROOT, 'server.js'));

const store = require('./lib/store.js');
const agnes = require('./lib/agnes.js');
const jobs = require('./lib/jobs.js');
const seed = require('./lib/seed.js');
const createRoutes = require('./lib/routes.js');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) { pass++; return true; }
  fail++;
  failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
  return false;
}
function eq(name, actual, expected) {
  return ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function group(t) { console.log(`\n── ${t} ──`); }

// ── 0. 干净的数据目录 ────────────────────────────────────────
const HOME = path.join(os.tmpdir(), `agnes-selftest-${process.pid}`);
fs.rmSync(HOME, { recursive: true, force: true });
store.init(HOME);

// ── 1. 数据层 ────────────────────────────────────────────────
group('数据层');
{
  const p = store.insert('projects', { name: '测试剧', project_type: '爽文漫剧' });
  ok('插入项目返回 id', !!p.id, JSON.stringify(p));
  ok('插入项目自动带 created_at', !!p.created_at);
  ok('插入项目自动带 updated_at', !!p.updated_at);

  const got = store.get('projects', p.id);
  eq('按 id 取回', got.name, '测试剧');

  const updated = store.update('projects', p.id, { name: '改名了' });
  eq('更新字段', updated.name, '改名了');
  eq('更新后条数不变', store.count('projects'), 1);

  // 分镜批量插入
  const rows = store.insertMany('storyboards', [
    { project_id: p.id, episode_number: 1, shot_number: 1, sort_order: 0 },
    { project_id: p.id, episode_number: 1, shot_number: 2, sort_order: 1 },
    { project_id: p.id, episode_number: 2, shot_number: 1, sort_order: 0 },
  ]);
  eq('批量插入 3 条', rows.length, 3);
  eq('按集数过滤', store.list('storyboards', { filter: (r) => r.episode_number === 1 }).length, 2);
  eq('按项目+集数过滤', store.list('storyboards', {
    filter: (r) => r.project_id === p.id && r.episode_number === 2,
  }).length, 1);

  ok('删除存在', store.remove('projects', p.id));
  eq('删除后条数归零', store.count('projects'), 0);
  ok('删除不存在返回 false', !store.remove('projects', 'nope'));

  // 未知集合要抛错，不能静默建表
  let threw = false;
  try { store.insert('not_a_table', {}); } catch { threw = true; }
  ok('未知集合抛错', threw);
}

// ── 2. 设置与脱敏 ────────────────────────────────────────────
group('设置与脱敏');
{
  eq('默认 base url', store.getSettings().agnes_api_base_url, 'https://apihub.agnes-ai.com/v1');
  eq('默认文本模型', store.getSettings().default_text_model, 'agnes-2.0-flash');

  store.setSettings({ agnes_api_key: 'sk-abcdefgh12345678' });
  eq('原始 key 可取', store.getRawKey(), 'sk-abcdefgh12345678');
  eq('掩码格式', store.getSettingsMasked().agnes_api_key_masked, 'sk-a****5678');
  eq('对外只给占位', store.getSettingsMasked().agnes_api_key, '***configured***');
  ok('脱敏后不含中间片段', !store.getSettingsMasked().agnes_api_key_masked.includes('cdefgh'));

  // 非法字段不能混进来
  store.setSettings({ evil_field: 'x' });
  ok('非白名单字段被忽略', !('evil_field' in store.getSettings()));

  // E8：数字型设置在写入口钳进合法区间，显示值恒等于生效值
  store.setSettings({ video_poll_interval: '0' });
  eq('轮询间隔 0 钳到下限 2', store.getSettings().video_poll_interval, '2');
  store.setSettings({ video_poll_interval: '-5' });
  eq('轮询间隔负数钳 2', store.getSettings().video_poll_interval, '2');
  store.setSettings({ video_poll_interval: 'abc' });
  eq('轮询间隔非法串回落默认 8', store.getSettings().video_poll_interval, '8');
  store.setSettings({ request_timeout_ms: '99999999' });
  eq('超时上限 600000', store.getSettings().request_timeout_ms, '600000');
  store.setSettings({ default_concurrent_tasks: '999' });
  eq('并发上限 8', store.getSettings().default_concurrent_tasks, '8');
  store.setSettings({ video_poll_interval: '8', video_max_polls: '60', default_concurrent_tasks: '3', request_timeout_ms: '150000' });

  // 短 key 不崩
  eq('短 key 掩码', store.maskKey('abc'), 'ab****');
  eq('空 key 掩码', store.maskKey(''), '');
}

// ── 3. 导入导出 ──────────────────────────────────────────────
group('导入导出');
{
  const a = store.insert('projects', { name: '导出测试' });
  store.insert('scripts', { project_id: a.id, title: '剧本', content: '内容' });
  const dump = store.exportProject(a.id);
  ok('项目导出含 project', !!dump.project);
  eq('项目导出带剧本', dump.scripts.length, 1);
  ok('导出带时间戳', !!dump.exported_at);

  const all = store.exportAll();
  // 计数跟着 COLLECTIONS 走，而不是写死数字：加集合时不会"忘了改测试"而假绿
  ok('全量导出含全部集合（与 COLLECTIONS 同源）',
    Object.keys(all.collections).length === store.COLLECTIONS.length && store.COLLECTIONS.includes('characters'),
    Object.keys(all.collections).join(','));

  // 改 id 后合并导入 → 应新增
  const copy = JSON.parse(JSON.stringify(all.collections));
  copy.projects = copy.projects.map((p) => ({ ...p, id: `${p.id}_copy` }));
  const before = store.count('projects');
  const n = store.importAll({ collections: copy }, 'merge');
  ok('合并导入有新增', n.added > 0);
  ok('合并后条数增加', store.count('projects') > before);

  const n2 = store.importAll({ collections: { projects: [{ id: 'only-one', name: '替换测试' }] } }, 'replace');
  ok('替换导入返回条数', n2.added >= 1);
  eq('替换后只剩一条', store.count('projects'), 1);
  // 新语义：replace 时备份里没有的集合也要一起清空（旧写法 continue 跳过 → 「清空全部数据」空转）
  eq('替换会清掉未提供的集合', store.count('scripts'), 0);
  store.importAll({ collections: {} }, 'replace');
  eq('空 collections 替换 = 全库清空', store.count('projects'), 0);
  store.importAll({ collections: copy }, 'merge'); // 恢复给后续组用
  ok('合并恢复后又有数据', store.count('projects') >= 1);

  // ── 审核批 H3/H4 钉子 ────────────────────────────────────
  eq('fsync 真实生效（失败计数为 0）', store.fsyncMisses, 0); // 上一版 flags 写错时 fsync 是死代码
  const bad = store.importAll({
    collections: {
      image_assets: [
        { id: 'img_ok', local_file: `${store.imagesDir()}/keep.png` },
        { id: 'img_evil', local_file: '/tmp/should_survive.txt' },
        { id: 'img_rel', local_file: '../../etc/passwd' },
        null, { name: '无 id 僵尸行' }, 42,
      ],
    },
  }, 'merge');
  eq('导入清洗越界 local_file 置空', store.get('image_assets', 'img_evil').local_file, '');
  eq('导入保留素材根内合法路径', store.get('image_assets', 'img_ok').local_file, path.join(store.imagesDir(), 'keep.png'));
  eq('非法路径行不留残值', store.get('image_assets', 'img_rel').local_file, '');
  eq('坏行数如实上报 skipped', bad.skipped, 3);
  eq('skipped 不混进 added（img 表只进 3 行）', store.list('image_assets').filter((r) => r.id.startsWith('img_')).length, 3);
  store.removeWhere('image_assets', (r) => String(r.id).startsWith('img_'));
  // replace 模式带 null 行：旧实现会把 MEM 写脏并落盘 → 全站永久 500（"一锤死"）
  store.importAll({ collections: { projects: [{ id: 'p_alive', name: '活项目' }] } }, 'replace');
  const nbad = store.importAll({ collections: { projects: [null, { id: 'p_x' }, { name: '无 id' }] } }, 'replace');
  eq('replace 拒绝脏行不炸库（skipped=2）', nbad.skipped, 2);
  ok('replace 后 stats() 仍可用（未写脏）', (() => { try { return typeof store.stats().total_projects === 'number'; } catch { return false; } })());
  eq('replace 只留合法行', store.count('projects'), 1);
  eq('合法行 id 正确', store.get('projects', 'p_x')?.id, 'p_x');
  store.importAll({ collections: copy }, 'merge');
}

// ── 4. 统计 ──────────────────────────────────────────────────
group('统计');
{
  store._resetForTest();
  const p = store.insert('projects', { name: '统计用', status: 'active' });
  store.insert('projects', { name: '归档', status: 'archived' });
  store.insert('storyboards', { project_id: p.id });
  store.insert('video_assets', { status: 'failed', local_status: 'submit_failed' });
  const s = store.stats();
  eq('项目总数', s.total_projects, 2);
  eq('进行中项目', s.active_projects, 1);
  eq('失败任务计数', s.failed_tasks, 1);
  eq('分镜数', s.total_storyboards, 1);
}

// ── 5. Agnes URL 与状态机 ────────────────────────────────────
group('Agnes 工具');
{
  eq('末尾斜杠归一化', agnes.normalizeBase('https://x.com/v1/'), 'https://x.com/v1');
  eq('补协议', agnes.normalizeBase('x.com/v1'), 'https://x.com/v1');
  eq('withV1 不重复', agnes.withV1('https://x.com/v1'), 'https://x.com/v1/chat/completions'.replace('/chat/completions', ''));
  eq('rootBase 去掉 v1', agnes.rootBase('https://x.com/v1'), 'https://x.com');
  eq('rootBase 无 v1 保持', agnes.rootBase('https://x.com'), 'https://x.com');

  // video_url 提取优先级
  eq('优先 remixed_from_video_id',
    agnes.extractVideoUrl({ remixed_from_video_id: 'A', video_url: 'B' }), 'A');
  eq('其次 video_url', agnes.extractVideoUrl({ video_url: 'B', url: 'C' }), 'B');
  eq('都没有给空串', agnes.extractVideoUrl({}), '');

  // 状态机
  let u = agnes.buildSafeStatusUpdate({ status: 'completed', remixed_from_video_id: 'http://v.mp4' });
  eq('completed 有地址 → completed', u.status, 'completed');
  eq('completed 有地址 → 本地完成', u.local_status, 'completed');
  ok('completed 记完成时间', !!u.completed_at);

  u = agnes.buildSafeStatusUpdate({ status: 'completed' });
  eq('completed 无地址 → 地址待取', u.status, 'video_url_missing');
  eq('completed 无地址 → 解析失败', u.local_status, 'result_parse_failed');

  u = agnes.buildSafeStatusUpdate({ status: 'failed', error: '炸了' });
  eq('failed → failed', u.status, 'failed');
  eq('failed 记错误', u.error_message, '炸了');

  u = agnes.buildSafeStatusUpdate({ status: 'in_progress', progress: 42 });
  eq('in_progress → in_progress', u.status, 'in_progress');
  eq('进度被记录', u.progress, 42);

  u = agnes.buildSafeStatusUpdate({ status: 'queued' });
  eq('queued → queued', u.status, 'queued');

  u = agnes.buildSafeStatusUpdate({ nothing: true });
  eq('未知状态不改 status', u.status, undefined);
  ok('未知状态仍存原始响应', !!u.raw_status_response);

  const models = store.normalizeModels({ data: [
    { id: 'new-text', kind: 'text' },
    { id: 'new-image', kind: 'image' },
    { id: 'new-text', kind: 'text' },
    'new-video',
  ] });
  eq('模型目录去重', models.length, 3);
  eq('模型目录保留 kind', models.find((m) => m.id === 'new-image').kind, 'image');
  eq('字符串模型可识别', models.find((m) => m.id === 'new-video').kind, 'video');

  const cache = store.setModels({ models: [{ id: 'cached', kind: 'text' }] }, { source: 'test' });
  eq('模型缓存写入', cache.models.length, 1);
  eq('模型缓存来源', cache.source, 'test');
  ok('模型缓存不过期判断', !store.modelsNeedRefresh());
  store.setModelCacheError('暂时失败');
  eq('失败只记录错误不清空模型', store.getModels().models.length, 1);
  eq('模型缓存错误可读', store.getModels().error, '暂时失败');
}

// ── 6. 批量队列 ──────────────────────────────────────────────
group('批量队列');
{
  const job = jobs.create('images', 5);
  const seen = [];
  const done = await jobs.run(job, [1, 2, 3, 4, 5], async (item, i) => {
    seen.push(item);
    if (item === 3) return { ok: false, error: '故意失败' };
    return { ok: true, id: `x${item}` };
  }, { concurrency: 2, onProgress: () => {} });
  eq('全部执行', done.done, 5);
  eq('成功 4', done.ok, 4);
  eq('失败 1', done.fail, 1);
  eq('状态结束', done.status, 'done');
  eq('每项都跑到', seen.length, 5);

  const j2 = jobs.create('videos', 3);
  j2.cancel = true;
  const r2 = await jobs.run(j2, [1, 2, 3], async () => ({ ok: true }), { concurrency: 1 });
  eq('取消后状态', r2.status, 'cancelled');
  ok('取消后不再继续', r2.done < 3);

  const j3 = jobs.create('images', 1);
  ok('可按 id 取回', jobs.get(j3.id) === j3);
  ok('取消接口', jobs.cancel(j3.id));
  ok('取消不存在的任务返回 false', !jobs.cancel('nope'));

  // R22：逐项状态必须"按下标预填、原地改"。旧的"完成一条 push 一条"有两个硬伤：
  // ① 并发下 push 顺序 ≠ 镜头顺序 → 界面按数组顺序画进度链会错位；② 只有完成态，看不出哪条在跑。
  // 这里刻意让第 0 项最慢：push 写法会把它排到末尾，预填写法必须仍是 0,1,2。
  const j4 = jobs.create('images', 3);
  await jobs.run(j4, [{ label: '镜头 #1', key: 'a' }, { label: '镜头 #2', key: 'b' }, { label: '镜头 #3', key: 'c' }],
    async (it, i) => { await new Promise((r) => setTimeout(r, i === 0 ? 60 : 5)); return { ok: true, id: `y${i}` }; },
    { concurrency: 3 });
  eq('并发下逐项顺序仍与下标一致（最慢的那条不得被排到末尾）', j4.items.map((x) => x.index).join(','), '0,1,2');
  eq('label 原样回传（进度链显示的镜头号）', j4.items.map((x) => x.label).join(','), '镜头 #1,镜头 #2,镜头 #3');
  eq('key 原样回传（界面据此把状态映射回表格行）', j4.items.map((x) => x.key).join(','), 'a,b,c');
  ok('每项都有终态（不是只有汇总数字）', j4.items.every((x) => x.state === 'ok' && x.ok === true));
  eq('预填发生在 run() 里：create 时 items 还是空的（不是先占坑再改口径）', jobs.create('images', 1).items.length, 0);
  const j5 = jobs.create('images', 2);
  await jobs.run(j5, [{}, {}], async () => ({ ok: true }), { concurrency: 1 });
  eq('未传 label/key 时兜底（不让界面出现 undefined）', `${j5.items[0].label}|${j5.items[0].key}`, '第 1 项|null');

  const j6 = jobs.create('images', 3);
  await jobs.run(j6, [{}, {}, {}], async (it, i) => (i === 1 ? { ok: false, error: '上游炸了' } : { ok: true }), { concurrency: 1 });
  eq('失败项标 fail 且带原因（"哪一镜失败、为什么"要能指出来）', `${j6.items[1].state}/${j6.items[1].error}`, 'fail/上游炸了');
  eq('失败项 ok 标记为 false（不是靠 state 猜）', j6.items[1].ok, false);

  const j7 = jobs.create('images', 4);
  const p7 = jobs.run(j7, [{}, {}, {}, {}], async () => { await new Promise((r) => setTimeout(r, 60)); return { ok: true }; }, { concurrency: 1 });
  await new Promise((r) => setTimeout(r, 15));
  jobs.cancel(j7.id);
  await p7;
  eq('取消后未轮到的项收成 cancelled（否则界面永远挂着一排"待处理"，像卡死）',
    j7.items.map((x) => x.state).join(','), 'ok,cancelled,cancelled,cancelled');
  ok('取消后不留 pending', !j7.items.some((x) => x.state === 'pending'));
}

// ── 6.5 R27 费用提取（null ≠ 0）──────────────────────────────
group('费用提取（R27）');
{
  eq('顶层 credits 直接取', agnes.extractCost({ status: 'completed', credits: 12 }).cost_credits, 12);
  eq('credits 的单位标为 credits', agnes.extractCost({ credits: 12 }).cost_unit, 'credits');
  eq('嵌套 usage.points 也认', agnes.extractCost({ usage: { points: 3 } }).cost_credits, 3);
  eq('嵌套 data.cost 落到金额字段', agnes.extractCost({ data: { cost: 0.25 } }).cost_amount, 0.25);
  eq('金额单位标为 currency', agnes.extractCost({ data: { cost: 0.25 } }).cost_unit, 'currency');
  eq('上游明确给 0 = 免费（不是未知）', agnes.extractCost({ amount: 0 }).cost_amount, 0);
  eq('上游没给 → null（不能兜成 0，0 会被读成免费）', agnes.extractCost({ status: 'completed' }).cost_credits, null);
  eq('没给时 cost_unit 也是 null', agnes.extractCost({}).cost_unit, null);
  eq('点数优先于金额（同一响应里两者都有时）', agnes.extractCost({ credits: 5, cost: 9.9 }).cost_credits, 5);
  eq('非对象输入不炸', agnes.extractCost(null).cost_credits, null);
  eq('字符串数字能认（上游常返回 "12"）', agnes.extractCost({ credits: '12' }).cost_credits, 12);
  eq('非数字的 credits 不认（不把 NaN 当钱存）', agnes.extractCost({ credits: 'many' }).cost_credits, null);
  const upd = agnes.buildSafeStatusUpdate({ status: 'completed', video_url: 'https://x/y.mp4', credits: 7 });
  eq('状态更新里带上费用（轮询路径自动落库）', upd.cost_credits, 7);
  eq('状态更新仍照常解析 video_url', upd.video_url, 'https://x/y.mp4');
}

// ── 7. 路由分发 ──────────────────────────────────────────────
group('路由分发');
{
  store._resetForTest();
  const fakePoller = {
    init() {}, stop() {}, watch() {}, pollOnce: async () => null,
    events: { emit() {}, add() {}, remove() {} }, log: [], pushLog() {},
  };
  const routes = createRoutes({ store, agnes, poller: fakePoller, jobs, version: 'test' });

  const health = routes.dispatch('GET', '/api/health', {}, {}, {}, null);
  eq('健康检查 ok', health.ok, true);
  eq('健康检查带版本', health.version, 'test');

  const p = routes.dispatch('POST', '/api/projects', { name: '路由测试' }, {}, {}, null);
  ok('路由建项目', !!p.id);

  const one = routes.dispatch('GET', `/api/projects/${p.id}`, {}, {}, {}, null);
  eq('路由取项目', one.name, '路由测试');

  const upd = routes.dispatch('PUT', `/api/projects/${p.id}`, { name: '改了' }, {}, {}, null);
  eq('路由改项目', upd.name, '改了');

  let err = null;
  try { routes.dispatch('POST', '/api/projects', { name: '' }, {}, {}, null); }
  catch (e) { err = e; }
  ok('空名称返回 400', err && err.statusCode === 400, err && err.message);

  err = null;
  try { routes.dispatch('GET', '/api/projects/nope', {}, {}, {}, null); }
  catch (e) { err = e; }
  ok('不存在的资源 404', err && err.statusCode === 404);

  eq('未匹配路由返回 undefined', routes.dispatch('GET', '/api/not-exist', {}, {}, {}, null), undefined);

  // 分镜批量 + 排序
  const sb = routes.dispatch('POST', '/api/storyboards', {
    rows: [{ project_id: p.id, episode_number: 1, shot_number: 1 }, { project_id: p.id, episode_number: 1, shot_number: 2 }],
  }, {}, {}, null);
  eq('路由批量建分镜', sb.inserted, 2);
  const list = routes.dispatch('GET', '/api/storyboards', {}, { project_id: p.id, episode: '1' }, {}, null);
  eq('路由按集过滤', list.length, 2);

  // 模板
  const t = routes.dispatch('POST', '/api/templates', { name: '测试模板', template_type: 'story_concept', content: 'hi {{x}}' }, {}, {}, null);
  ok('路由建模板', !!t.id);
  err = null;
  try { routes.dispatch('POST', '/api/templates', { name: '' }, {}, {}, null); }
  catch (e) { err = e; }
  ok('模板空名称 400', err && err.statusCode === 400);

  // 视频创建：没配 key 时应报 no_api_key（且落一条失败记录）
  store.setSettings({ agnes_api_key: '' });
  const before = store.count('video_assets');
  let vres = null;
  try { vres = await routes.dispatch('POST', '/api/videos', { prompt: 'x' }, {}, {}, null); }
  catch (e) { vres = { ok: false, error: e.message }; }
  ok('无 key 时视频提交被拦下', vres && vres.ok === false, JSON.stringify(vres));
  ok('失败也留下记录可复盘', store.count('video_assets') > before);
}

// ── 8. 内置模板种子 ──────────────────────────────────────────
group('内置模板');
{
  store._resetForTest();
  const n1 = seed.seedTemplates(store);
  ok('首装写入默认模板', n1 > 0, `写入 ${n1} 条`);
  const n2 = seed.seedTemplates(store);
  eq('重复播种不重复写', n2, 0);
  ok('含故事构思模板', store.list('prompt_templates').some((t) => t.template_type === 'story_concept'));
  ok('含脚本优化模板', store.list('prompt_templates').some((t) => t.template_type === 'optimize'));
  ok('模板带变量占位', store.list('prompt_templates').some((t) => /\{\{.+\}\}/.test(t.content)));
}

// ── 9. 文件落盘安全 ──────────────────────────────────────────
group('素材落盘');
{
  const fakePoller = {
    init() {}, stop() {}, watch() {}, pollOnce: async () => null,
    events: { emit() {} }, log: [], pushLog() {},
  };
  const routes = createRoutes({ store, agnes, poller: fakePoller, jobs, version: 'test' });
  const b64 = Buffer.from('fake-image-bytes').toString('base64');
  const saved = routes.saveImageBase64(b64, 'image/png');
  ok('图片写入磁盘', fs.existsSync(saved.file), saved.file);
  ok('落盘路径在 images 目录内', saved.file.startsWith(store.imagesDir()), saved.file);
  ok('返回可访问 URL', saved.url.startsWith('/assets/images/'), saved.url);
  eq('文件内容一致', fs.readFileSync(saved.file, 'utf8'), 'fake-image-bytes');

  // 恶意文件名必须被压成安全名字
  const evil = routes.safeName('../../evil.png', 'png');
  ok('路径穿越被挡', !evil.includes('..'), evil);
  const evil2 = routes.safeName('a/b\\c:*.png', 'png');
  ok('非法字符被替换', !/[\\/:*?"<>|]/.test(path.basename(evil2)), evil2);
  eq('空名字给默认值', path.basename(routes.safeName('', 'png')).startsWith('asset_'), true);
}

// ── 10. 前端 JSON 解析（模型坏输出兜底） ──────────────────────
group('前端 JSON 解析');
{
  const { extractJson, extractJsonArray, repairJson } =
    await import(pathToFileURL(path.join(ROOT, 'public/js/consts.js')).href);

  eq('裸数组直接解析', JSON.stringify(extractJson('[{"a":1}]')), '[{"a":1}]');
  ok('围栏 + 前后废话', Array.isArray(extractJson('好的，结果如下：\n```json\n[{"a":1}]\n```\n以上')));
  eq('对象模板输出取对象', extractJson('{"one_liner":"x","hook":"y"}').one_liner, 'x');
  eq('非 JSON 文本返回 null', extractJson('这是一段纯文字。'), null);

  // agnes-2.0-flash 真实坏输出①：值里多写了一个未转义引号（线上事故原样）
  const brokenQuote = '```json\n[\n  {\n    "shot_number": 1,\n    "narration": " "",\n    "sound_effect": "风声"\n  },\n  {\n    "shot_number": 2,\n    "dialogue": "苏婉儿：「废物！」"\n  }\n]\n```';
  const fixed1 = extractJson(brokenQuote);
  ok('修复未转义多余引号', Array.isArray(fixed1) && fixed1.length === 2, JSON.stringify(fixed1));
  eq('修复后字段完整', fixed1 && fixed1[1].dialogue, '苏婉儿：「废物！」');

  // 真实坏输出②：值里内嵌未转义英文引号
  const innerQuote = '[{"dialogue": "他说"你好"，转身走了。"}]';
  const fixed2 = extractJson(innerQuote);
  ok('修复内嵌英文引号', fixed2 && fixed2[0].dialogue === '他说"你好"，转身走了。', JSON.stringify(fixed2));

  // 尾逗号很常见
  const trailing = '{"shots":[{"a":1,},{"b":2,},],}';
  const fixed3 = extractJsonArray(trailing);
  ok('修复尾逗号', Array.isArray(fixed3) && fixed3.length === 2, JSON.stringify(fixed3));

  // json_object 模式包装成对象 → extractJsonArray 解包
  eq('对象包裹的数组解包', extractJsonArray('{"shots":[{"shot_number":1}]}').length, 1);
  eq('裸数组也能过 extractJsonArray', extractJsonArray('[{"shot_number":1}]').length, 1);
  eq('解不出数组返回 null', extractJsonArray('{"one_liner":"x"}'), null);
  ok('repairJson 不误伤正常转义', JSON.parse(repairJson('{"a":"x\\"y","b":"[1,2]"}')).a === 'x"y');
}

// ── 灾备路径：坏文件降级链（零覆盖案补钉）──────────────────
group('坏文件降级链');
await store.persist(); // 排干主库写队（跨 home 切换前必须，防旧写落错家）
{
  const HOME2 = path.join(os.tmpdir(), `agnes-corrupt-${process.pid}`);
  fs.rmSync(HOME2, { recursive: true, force: true }); fs.mkdirSync(HOME2, { recursive: true });
  fs.writeFileSync(path.join(HOME2, 'db.json'), '{oops 用户手改坏的语法');
  fs.writeFileSync(path.join(HOME2, 'db.json.bak'), JSON.stringify({ projects: [{ id: 'p_bak', name: '备份层', created_at: 'x', updated_at: 'x' }], storyboards: [] }));
  store.init(HOME2);
  const v1 = store.list('projects');
  ok('db 坏→回退 .bak（不静默清零）', v1.length === 1 && v1[0].id === 'p_bak', JSON.stringify(v1));
  ok('自愈：main 回写合法内容', JSON.parse(fs.readFileSync(path.join(HOME2, 'db.json'))).projects[0].id === 'p_bak');
  ok('自愈：.bak 不再指向坏数据（本轮修的自毁洞）', JSON.parse(fs.readFileSync(path.join(HOME2, 'db.json.bak'))).projects[0].id === 'p_bak');
  ok('坏原文已归档留证', fs.readdirSync(HOME2).some((f) => f.startsWith('db.json.corrupt-')));
  // 双坏：降级空库但不炸，且证据保留
  fs.writeFileSync(path.join(HOME2, 'db.json'), '[[[double');
  fs.writeFileSync(path.join(HOME2, 'db.json.bak'), '[[[also');
  store.init(HOME2);
  ok('双坏→空库不炸', Array.isArray(store.list('projects')) && store.list('projects').length === 0);
  fs.writeFileSync(path.join(HOME2, 'settings.json'), '{bad settings');
  store.init(HOME2);
  ok('settings 坏→空对象降级不抛', typeof store.getSettings() === 'object');
  await store.persist();
  fs.rmSync(HOME2, { recursive: true, force: true });
  store.init(HOME);
  // 注：前序「导入导出」组的 replace 语义合法清空过库——归位断言按盘上实况校验，不预设内容
  ok('主库归位（内存与盘一致）', store.stats().total_projects === JSON.parse(fs.readFileSync(path.join(HOME, 'db.json'))).projects.length);
}

// ── 收尾 ─────────────────────────────────────────────────────
fs.rmSync(HOME, { recursive: true, force: true });

// ── 轮询预算语义（R12/R13，纯函数 + 拒绝重启，不联网） ──
group('轮询预算（R12/R13）');
{
  const poller = require('./lib/poller.js');
  poller.init(store);
  store.setSettings({ video_poll_interval: '8', video_max_polls: '60' });

  // ① 递增间隔：基础值起，随次数放大，封顶 4 倍（远端长排队时密查纯浪费配额）
  const i0 = poller.intervalMs(0), i2 = poller.intervalMs(2), i9 = poller.intervalMs(9), i30 = poller.intervalMs(30);
  eq('间隔起点=基础值', i0, 8000);
  eq('间隔随次数放大（第 2 次 → 2 倍）', i2, 16000);
  eq('间隔封顶 4 倍', i9, 32000);
  eq('封顶后不再增长', i30, 32000);
  ok('间隔单调不减（含负数与非法输入兜底）', poller.intervalMs(-3) === i0 && poller.intervalMs(NaN) === i0, `neg=${poller.intervalMs(-3)} nan=${poller.intervalMs(NaN)}`);

  // ② 分级 deadline：判据只用请求里真实存在的规格字段，不猜模型名
  const light = { num_frames: 121, frame_rate: 24 };   // 约 5 秒（默认档）
  const light3 = { num_frames: 81, frame_rate: 24 };   // 约 3 秒
  const heavy10 = { num_frames: 241, frame_rate: 24 }; // 约 10 秒
  const heavy18 = { num_frames: 441, frame_rate: 24 }; // 约 18 秒
  ok('3 秒档不算重任务', poller.isHeavyTask(light3) === false);
  ok('5 秒档（默认）不算重任务', poller.isHeavyTask(light) === false);
  ok('10 秒档判为重任务', poller.isHeavyTask(heavy10) === true);
  ok('18 秒档判为重任务', poller.isHeavyTask(heavy18) === true);
  ok('缺字段/空值不误判为重任务', poller.isHeavyTask({}) === false && poller.isHeavyTask(null) === false);
  eq('轻任务预算=设置值', poller.maxPollsFor(light), 60);
  eq('重任务预算=3 倍', poller.maxPollsFor(heavy10), 180);

  // ③ 预算耗尽判定：次数触顶 / 墙钟触顶 两条路
  ok('次数触顶被判定为耗尽', !!poller.budgetExhausted(light, 60));
  ok('未触顶不判耗尽', poller.budgetExhausted(light, 59) === null);
  const stale = { ...light, poll_started_at: new Date(Date.now() - 20 * 60 * 1000).toISOString() };
  ok('墙钟触顶被判定为耗尽（20 分钟 > 轻任务 10 分钟）', !!poller.budgetExhausted(stale, 1), String(poller.budgetExhausted(stale, 1)));
  const fresh = { ...light, poll_started_at: new Date().toISOString() };
  ok('刚起步不因墙钟被误判', poller.budgetExhausted(fresh, 1) === null);

  // ④ 僵尸任务不得自动复活（R12 的核心）：预算已耗尽时 watch 必须拒绝挂表
  const zombie = store.insert('video_assets', {
    project_id: null, name: '僵尸任务探针', agnes_video_id: 'vid_zombie', model_name: 'm',
    status: 'queued', remote_status: 'queued', local_status: 'polling',
    poll_attempts: 999, poll_started_at: new Date().toISOString(),
  });
  const before = poller.activeCount();
  poller.watch(zombie.id, true);
  eq('预算耗尽的僵尸任务被拒绝重启（不挂定时器）', poller.activeCount(), before);
  ok('拒绝重启留下可排查的日志', poller.log.some((l) => String(l.msg).includes('已达轮询预算')), JSON.stringify(poller.log[0] || {}));
  // 只拒绝重启而不改状态 = 界面永远显示"轮询中"但实际没人轮询（静默停摆）→ 必须推成终态
  eq('拒绝重启时同步推成终态（不留假"轮询中"）', store.get('video_assets', zombie.id).local_status, 'poll_timeout');
  ok('终态文案给出恢复手段', /重新获取/.test(store.get('video_assets', zombie.id).error_message || ''), store.get('video_assets', zombie.id).error_message);
  eq('resume() 也不得给僵尸任务续命（重启即白送预算）', poller.resume() >= 0 && poller.activeCount(), before);

  // ⑤ 灵敏度对照：用户主动重置后必须能挂上（否则触顶任务永久不可追踪）。
  // 真实路径是「重新获取」先 pollOnce 把远端状态刷回 in_progress，再 watch(reset:true)——
  // 故这里先模拟 pollOnce 的落库效果，否则会被 isActive 守卫挡在前面，测不到重置分支。
  store.update('video_assets', zombie.id, { status: 'in_progress', local_status: 'polling' });
  poller.watch(zombie.id, true, { reset: true });
  eq('用户主动重置后挂表成功', poller.activeCount(), before + 1);
  eq('重置把累计次数与起点一起归零', store.get('video_assets', zombie.id).poll_attempts, 0);
  poller.stop(zombie.id);
  eq('stop 只停定时器、不清预算（预算事实源在记录上）', poller.activeCount(), before);
  store.remove('video_assets', zombie.id);
}

group('镜头绑定匹配与体检纯函数（批 8 补 5：名字识别 / 两档置信度 / 按目标聚合）');
{
  const { matchShotBindings, bindNames, auditShotBindings } = require('./lib/story.js');
  const chars = [
    { id: 'c1', name: '林晚', alias: '晚晚、林老板', appearance: '白衣', is_locked: false },
    { id: 'c2', name: '林晚秋', appearance: '青衣' },
    { id: 'c3', name: '雪', appearance: '白发' },          // 单字名：不该进匹配池
    { id: 'c4', name: '顾寒', appearance: '黑甲', is_locked: true },
  ];
  const cards = [
    { id: 'k1', kind: 'location', name: '临江茶馆', aliases: ['茶馆'], atmosphere: '喧闹' },
    { id: 'k2', kind: 'prop', name: '青铜钥匙', owner: '林晚' },
    { id: 'k3', kind: 'character', name: '卡片形态的角色', appearance: '不该被绑进 story_card_ids' },
  ];
  const names = (m) => m.chars.map((x) => x.name).join(',');

  // ① 可匹配名：本名 + 两种别名形态，单字名与空名不进池
  eq('角色的 alias（"、"分隔字符串）与卡片的 aliases（数组）都能进匹配池',
    bindNames(chars[0]).join('|'), '林晚|晚晚|林老板');
  eq('卡片的 aliases 数组同样进池', bindNames(cards[0]).join('|'), '临江茶馆|茶馆');
  eq('单字名不进池（撞普通词概率太高，宁可漏也不要错绑）', bindNames(chars[2]).length, 0);
  eq('空行安全', bindNames(null).length, 0);
  eq('名字里的空白被去掉', bindNames({ name: ' 林晚 ' }).join('|'), '林晚');

  // ② 两档置信度：出场人物字段=强，提示词/描述里出现=弱
  {
    const strong = matchShotBindings({ characters: '林晚、顾寒' }, { characters: chars });
    eq('「出场人物」里的名字算强匹配', strong.chars.map((x) => `${x.name}:${x.via}`).join(','), '林晚:characters,顾寒:characters');
    eq('强匹配不计入 weak', strong.weak, 0);
    eq('强匹配数如实上报', strong.strong, 2);
    const weak = matchShotBindings({ characters: '', scene_description: '林晚走进来' }, { characters: chars });
    eq('只在画面描述里出现算弱匹配', weak.chars.map((x) => `${x.name}:${x.via}`).join(','), '林晚:prompt');
    eq('弱匹配计入 weak（自动化不吃这一档）', weak.weak, 1);
    const mixed = matchShotBindings({ characters: '林晚', scene_description: '林晚秋也在' }, { characters: chars });
    eq('同一行在强文本里命中就不再看弱文本', mixed.chars.map((x) => `${x.name}:${x.via}`).join(','), '林晚:characters,林晚秋:prompt');
  }

  // ③ 名字识别：长名优先、两个都真出现时都要、别名、已绑定不重复
  eq('文本写的是"林晚秋"时不该同时绑上"林晚"（短名被长名罩住）',
    names(matchShotBindings({ characters: '林晚秋登场' }, { characters: chars })), '林晚秋');
  eq('两个名字都真的出现时都要绑',
    names(matchShotBindings({ characters: '林晚秋和林晚都来了' }, { characters: chars })), '林晚秋,林晚');
  eq('别名能匹配到本体，且 hit 记的是实际命中的别名',
    JSON.stringify(matchShotBindings({ characters: '晚晚来了' }, { characters: chars }).chars.map((x) => [x.name, x.hit])),
    '[["林晚","晚晚"]]');
  eq('单字名不匹配（"下雪了"不该绑上角色"雪"）',
    names(matchShotBindings({ characters: '下雪了' }, { characters: chars })), '');
  eq('已经绑过的角色不再重复报',
    names(matchShotBindings({ characters: '林晚', character_ids: ['c1'] }, { characters: chars })), '');
  eq('已经绑过的卡片不再重复报',
    matchShotBindings({ scene_description: '临江茶馆', story_card_ids: ['k1'] }, { cards }).cards.length, 0);
  eq('非可注入类别的卡片（人物卡）不参与匹配',
    matchShotBindings({ characters: '卡片形态的角色' }, { cards }).cards.length, 0);

  // ④ 体检按目标聚合：一个角色漏绑十几个镜头只报一条
  {
    const shots = [
      { id: 's1', shot_number: 1, episode_number: 1, characters: '林晚', character_ids: [] },
      { id: 's2', shot_number: 2, episode_number: 1, characters: '林晚、顾寒', character_ids: ['c4'] },
      { id: 's3', shot_number: 3, episode_number: 2, characters: '', scene_description: '两人走进临江茶馆' },
    ];
    const r = auditShotBindings(shots, { characters: chars, cards });
    const byCode = (c) => r.issues.filter((x) => x.code === c);
    eq('体检扫描镜头数如实上报', r.scanned, 3);
    eq('漏绑的角色聚成一条（而不是每镜头一条）', byCode('shot_char_unbound').length, 1);
    eq('聚合里带上了全部相关镜头', byCode('shot_char_unbound')[0].shot_ids.join(','), 's1,s2');
    eq('有强匹配的组算"要处理"', byCode('shot_char_unbound')[0].level, 'warn');
    eq('弱匹配的卡片组算"可优化"（可能只是撞词）', byCode('shot_card_unbound')[0].level, 'info');
    eq('可修复数如实统计', r.counts.fixable, r.issues.length);
    ok('每条都带 target_id 与修复动作码（界面据此发请求，不能拿问题码当动作码）',
      r.issues.every((x) => x.target_id && x.fixable === true && x.fix_code),
      JSON.stringify(r.issues.map((x) => [x.code, x.fix_code])));
    ok('聚合里带镜头明细（确认弹窗要列给用户看）',
      byCode('shot_char_unbound')[0].shots.some((x) => x.shot_number === 2));
    eq('空输入安全', auditShotBindings(undefined, {}).issues.length, 0);
    eq('空镜头列表的计数全 0', JSON.stringify(auditShotBindings([], {}).counts), '{"warn":0,"info":0,"fixable":0}');
  }

  // ⑤ 最隐蔽的一条：绑了但没锁定，且提示词里出现了角色名 → 按既定语义不会注入外貌
  {
    const shots = [
      { id: 'a', shot_number: 1, characters: '林晚', character_ids: ['c1'], image_prompt: '林晚站在门口' },
      { id: 'b', shot_number: 2, characters: '林晚', character_ids: ['c1'], image_prompt: 'a girl in white' },
      { id: 'c', shot_number: 3, characters: '顾寒', character_ids: ['c4'], image_prompt: '顾寒拔剑' },
    ];
    const r = auditShotBindings(shots, { characters: chars, cards: [] });
    const un = r.issues.filter((x) => x.code === 'shot_char_unlocked');
    eq('只报"提示词里出现了名字"的那些镜头', un.length === 1 && un[0].shot_ids.join(','), 'a');
    eq('锁定过的角色不算问题', un.some((x) => x.target_id === 'c4'), false);
    eq('未锁定问题的修复动作是"锁定"', un[0].fix_code, 'lock_shot_char');
    eq('fixable 仍是布尔（与卡片侧同一口径，界面按它算"可一键修复"数）', un[0].fixable, true);
    eq('未锁定只算"可优化"（界面一切正常，只是注入被跳过）', un[0].level, 'info');
    ok('详情说清"看起来绑了却没生效"的原因', un[0].detail.includes('未锁定') && un[0].detail.includes('换脸'), un[0].detail);
  }
}

group('分集骨架纯函数（批 8 补 4：按原文顺序排拍 / 幕次收口 / 硬上限 / 如实上报）');
{
  const { planEpisodes, episodeOutlineText, beatLine, EPISODE_PER_DEFAULT, EPISODE_PER_MAX, STAGE_ORDER } = require('./lib/story.js');
  const plot = (id, name, stage, order, extra) => Object.assign({ id, kind: 'plot', name, stage, order }, extra || {});
  const sizes = (p) => p.episodes.map((e) => e.beat_count).join(',');

  // ① 空输入：不编造内容，如实说"还没有剧情卡"
  {
    const p = planEpisodes([], {});
    eq('没有卡片 → 0 集', p.episodes.length, 0);
    eq('没有卡片 → 文本为空（调用方据此提示，不许静默给一段空骨架）', episodeOutlineText([], p), '');
    ok('没有卡片时给出原因', p.notes.some((n) => n.includes('还没有剧情卡')), JSON.stringify(p.notes));
    eq('默认每集拍数', p.per_episode, EPISODE_PER_DEFAULT);
    eq('undefined 安全', planEpisodes(undefined, {}).beat_count, 0);
  }

  // ② 纯计数切分（一张卡都没标幕次）
  {
    const cards = Array.from({ length: 8 }, (_, i) => plot(`p${i}`, `第${i + 1}拍`, '', i + 1));
    const p = planEpisodes(cards, { perEpisode: 3 });
    eq('没幕次 → basis=count', p.basis, 'count');
    eq('按拍数平均切（3,3,2）', sizes(p), '3,3,2');
    eq('计数切分不会触发硬切上报', p.forced_cuts, 0);
    ok('如实说明退化为计数切分', p.notes.some((n) => n.includes('都没有标幕次')));
    eq('幕次覆盖 0', p.stage_covered, 0);
  }

  // ③ 幕次收口：不拆幕，且不低于下限
  {
    const cards = [
      plot('a1', '起1', '起', 1), plot('a2', '承1', '承', 2), plot('a3', '转1', '转', 3), plot('a4', '合1', '合', 4),
      plot('b1', '起2', '起', 5), plot('b2', '承2', '承', 6), plot('b3', '转2', '转', 7), plot('b4', '合2', '合', 8),
    ];
    const p = planEpisodes(cards, { perEpisode: 3 });
    eq('全部有幕次 → basis=stage', p.basis, 'stage');
    eq('收在幕边界上（4,4，而不是 3,3,2）', sizes(p), '4,4');
    ok('每一集都不低于下限', p.episodes.every((e) => e.beat_count >= 3));
    ok('没有硬切', p.forced_cuts === 0 && p.notes.some((n) => n.includes('没有从中间劈开一幕')));
    eq('集内幕次按顺序去重', p.episodes[0].acts.join(''), STAGE_ORDER.join(''));
  }

  // ④ 硬上限：单幕过长必须切开，否则分集等于没分
  {
    const cards = Array.from({ length: 12 }, (_, i) => plot(`x${i}`, `承${i + 1}`, '承', i + 1));
    const p = planEpisodes(cards, { perEpisode: 4 });
    eq('单幕 12 拍、下限 4 → 硬上限 8 处切开', sizes(p), '8,4');
    eq('硬切次数如实上报', p.forced_cuts, 1);
    ok('硬切有专门提示（建议拆幕或调大下限）', p.notes.some((n) => n.includes('单幕过长')));
    eq('硬上限 = 下限 ×2', p.hard_limit, 8);
  }

  // ⑤ 部分标了幕次：basis=mixed，且覆盖数如实上报
  {
    const cards = [
      plot('m1', '起', '起', 1), plot('m2', '承', '承', 2), plot('m3', '合', '合', 3),
      plot('m4', '没标A', '', 4), plot('m5', '没标B', '', 5),
    ];
    const p = planEpisodes(cards, { perEpisode: 2 });
    eq('部分标幕次 → basis=mixed', p.basis, 'mixed');
    eq('幕次覆盖如实上报', p.stage_covered, 3);
    ok('提示没标幕次的拍不会被丢掉', p.notes.some((n) => n.includes('不会被丢掉')));
    eq('拍子总数不因缺幕次而减少', p.beat_count, 5);
    eq('所有拍都被分进某一集', p.episodes.reduce((n, e) => n + e.beat_count, 0), 5);
  }

  // ⑥ 参数钳制与拍序
  {
    const cards = [plot('c', '后来的', '起', 9), plot('a', '先出现的', '起', 1), plot('b', '中间的', '承', 5)];
    const p = planEpisodes(cards, { perEpisode: 0 });
    eq('下限 0 → 用默认值（不许切成"每集 0 拍"死循环）', p.per_episode, EPISODE_PER_DEFAULT);
    eq('负数同样落到默认值', planEpisodes(cards, { perEpisode: -3 }).per_episode, EPISODE_PER_DEFAULT);
    eq('NaN 同样落到默认值', planEpisodes(cards, { perEpisode: 'abc' }).per_episode, EPISODE_PER_DEFAULT);
    eq('超上限被钳到 20', planEpisodes(cards, { perEpisode: 999 }).per_episode, EPISODE_PER_MAX);
    eq('小数四舍五入', planEpisodes(cards, { perEpisode: 2.6 }).per_episode, 3);
    eq('拍序按 order（原文出现顺序），不按传入顺序',
      planEpisodes(cards, { perEpisode: 9 }).episodes[0].beats.map((b) => b.name).join(','), '先出现的,中间的,后来的');
  }

  // ⑦ 一拍一行的字段口径
  {
    const b = { name: '初见', stage: '起', conflict: '误会', turn: '认出', outcome: '结盟', involved: '林晚、顾寒' };
    eq('beatLine 带全部下游字段', beatLine(b), '初见｜起｜冲突：误会｜转折：认出｜结果：结盟｜涉及：林晚、顾寒');
    eq('没字段时退回摘要（不产出空行）', beatLine({ name: 'X', summary: '摘要' }), 'X｜摘要');
    eq('连摘要都没有时明确标"待补充"（不静默留空）', beatLine({ name: 'X' }), 'X｜（待补充）');
    eq('没名字也不产出空标题', beatLine({ stage: '起' }).startsWith('（未命名）'), true);
    const p = planEpisodes([plot('p', '初见', '起', 1, { conflict: '误会', involved: '林晚' })], {});
    eq('结构化字段原样带出（界面直接渲染，不再解析文本）',
      `${p.episodes[0].beats[0].conflict}|${p.episodes[0].beats[0].involved}`, '误会|林晚');
    ok('每集给出估算字数（界面显示"约 N 字"）', p.episodes[0].chars > 0);
  }

  // ⑧ 骨架文本：全剧设定 + 时间线 + 分集 + 切分说明
  {
    const cards = [
      { id: 'w', kind: 'world', name: '基调', genre: '悬疑', tone: '冷峻', order: 0 },
      { id: 't1', kind: 'timeline', name: '三日后', when: '第三天黄昏', order_note: '紧接第一幕', order: 1 },
      plot('p1', '初见', '起', 1, { conflict: '误会' }), plot('p2', '和解', '合', 2, { outcome: '结盟' }),
    ];
    const p = planEpisodes(cards, { perEpisode: 2 });
    const text = episodeOutlineText(cards, p);
    ok('文本带全剧设定', text.includes('【全剧设定】') && text.includes('题材：悬疑'));
    ok('文本带全剧时间线（含顺序说明）', text.includes('【全剧时间线】') && text.includes('第三天黄昏') && text.includes('紧接第一幕'));
    ok('文本带分集骨架与集号', text.includes('【分集骨架】') && text.includes('第 1 集（起·合｜2 拍）'));
    ok('文本带切分说明', text.includes('【切分说明】'));
    ok('文本不含未替换的占位符', !/\{\{|\}\}/.test(text));
    ok('文本开头说明"未新增设定"（免得用户以为模型又编了东西）', text.includes('未新增任何设定'));
    const noWorld = episodeOutlineText([plot('p', '只有剧情', '起', 1)], planEpisodes([plot('p', '只有剧情', '起', 1)], {}));
    ok('没有信息卡就不渲染"全剧设定"小节（不出现空标题）', !noWorld.includes('【全剧设定】'));
    ok('没有时间线卡就不渲染"全剧时间线"小节', !noWorld.includes('【全剧时间线】'));
    eq('不传 plan 也能自己算（调用方少一个坑）',
      episodeOutlineText(cards, null, { perEpisode: 2 }).includes('第 1 集'), true);
    eq('只有信息卡/时间线、没有剧情卡时仍有文本（设定本身也是大纲的一部分）',
      episodeOutlineText([{ id: 'w', kind: 'world', name: '基调', tone: '冷峻' }], null).includes('【全剧设定】'), true);
  }
}

group('一致性体检纯函数（批 8 补 3：同名卡 / 别名撞名 / 缺字段 / 不误报）');
{
  // 本组在文件里排在 `const story = require(...)` 之前，所以就地取一次（不能引用后面才初始化的 const）
  const { auditCards, mergeCardGroup, STORY_INJECT_KINDS, STORY_INJECT_FIELDS, STORY_FIELD_LABELS } = require('./lib/story.js');
  const mk = (id, kind, name, extra) => Object.assign({ id, kind, name }, extra);
  const codes = (cards, opts) => auditCards(cards, opts).issues.map((i) => i.code);

  eq('空列表 → 没有问题', codes([]).length, 0);
  eq('undefined 安全（项目里还没有卡片）', codes(undefined).length, 0);
  ok('干净的一组卡 → 一条都不报（不制造噪音）',
    codes([
      mk('a', 'character', '林晚', { appearance: '白衣', aliases: ['晚晚'] }),
      mk('b', 'location', '临江茶馆', { atmosphere: '喧闹潮湿' }),
      mk('c', 'plot', '初见', { stage: '起' }),
      mk('d', 'timeline', '三日后', { when: '第三天黄昏' }),
      mk('e', 'prop', '青铜钥匙', { usage: '开密室' }),
    ], { assetCardIds: ['a'] }).length === 0);

  // ① 同名同类别
  const dup = auditCards([mk('a', 'character', '林晚', { appearance: '白衣' }), mk('b', 'character', '林晚', { appearance: '白衣长剑' })], {});
  ok('同名同类别 → 报 dup_name', dup.issues.map((i) => i.code).includes('dup_name'), dup.issues.map((i) => i.code).join(','));
  eq('dup_name 可一键修复', dup.issues[0].fixable, true);
  eq('dup_name 带上全部涉及卡 id（修复要用）', dup.issues[0].card_ids.join(','), 'a,b');
  eq('冲突字段如实列出两个说法（不替用户决定）', dup.issues[0].conflicts.map((c) => c.field).join(','), 'appearance');
  eq('冲突值都在报告里（合并前能核对）', dup.issues[0].conflicts[0].values.join('|'), '白衣|白衣长剑');
  ok('同名但类别不同 → 不算重复（人物林晚 vs 地点林晚是两回事）',
    !codes([mk('a', 'character', '林晚', { appearance: 'x' }), mk('b', 'location', '林晚', { atmosphere: 'y' })], { assetCardIds: ['a'] }).includes('dup_name'));
  ok('名字大小写/空格差异也算同名（nameKey 归一化）',
    codes([mk('a', 'character', 'Lin Wan', { appearance: 'x' }), mk('b', 'character', ' lin  wan ', { appearance: 'y' })], { assetCardIds: ['a'] }).includes('dup_name'));
  eq('没有字段说法不同时不给空 conflicts（前端据此决定要不要提示核对）',
    auditCards([mk('a', 'plot', '初见', { stage: '起' }), mk('b', 'plot', '初见', { stage: '起', conflict: '误会' })], {}).issues[0].conflicts.length, 0);
  eq('幕次不同就是真冲突（合并只能留一个，必须让用户看见）',
    auditCards([mk('a', 'plot', '初见', { stage: '起' }), mk('b', 'plot', '初见', { stage: '承' })], {}).issues[0].conflicts[0].values.join('|'), '起|承');

  // ② 别名撞名
  const col = auditCards([mk('a', 'character', '林晚', { appearance: 'x' }), mk('b', 'character', '顾寒', { appearance: 'y', aliases: ['林晚'] })], { assetCardIds: ['a', 'b'] });
  ok('别名撞到另一张卡的名字 → 报 alias_collision', col.issues.map((i) => i.code).includes('alias_collision'), col.issues.map((i) => i.code).join(','));
  ok('别名撞名可一键修复', col.issues[0].fixable === true && col.issues[0].alias === '林晚');
  ok('自己就是自己的别名不算撞名（自我别名在规范化阶段已被清掉）',
    !codes([mk('a', 'character', '林晚', { aliases: ['林晚'], appearance: 'x' })], { assetCardIds: ['a'] }).includes('alias_collision'));

  // ③ 可注入类卡片没有可注入字段：绑到分镜也不生效
  eq('地点卡没有氛围/地域/时段/特征 → 报 no_inject', codes([mk('a', 'location', '临江茶馆')]).join(','), 'no_inject');
  ok('no_inject 不可自动修复（要人来补内容）', auditCards([mk('a', 'location', '空地点')], {}).issues[0].fixable === false);
  ok('只填了任意一项就不报（字段白名单与注入表同源）',
    !codes([mk('a', 'location', '临江茶馆', { time_of_day: '夜晚' })]).includes('no_inject'));
  ok('不可注入的类别不报 no_inject（人物卡/剧情卡不走这条路）',
    !codes([mk('a', 'character', '林晚', { appearance: 'x' }), mk('b', 'world', '世界观')]).includes('no_inject'));
  eq('注入类别表与注入字段表必须一致（新增类别要同时进两张表）',
    STORY_INJECT_KINDS.slice().sort().join(','), Object.keys(STORY_INJECT_FIELDS).sort().join(','));
  ok('每个可注入字段都有中文名（体检报告要说人话，不能把 atmosphere 丢给用户）',
    STORY_INJECT_KINDS.every((k) => STORY_INJECT_FIELDS[k].every((f) => !!STORY_FIELD_LABELS[f])));
  // 变更须知：注入用的表在 lib/routes.js（STORY_CARD_INJECT_FIELDS），体检用的表在 lib/story.js
  // （STORY_INJECT_FIELDS）—— 两张表必须逐项一致，否则会出现"体检说这项能注入、实际不注入"的鬼话。
  {
    const R = require('./lib/routes.js');
    eq('注入表与体检表逐项一致（两张表不能各说各话）',
      JSON.stringify(R.STORY_CARD_INJECT_FIELDS), JSON.stringify(STORY_INJECT_FIELDS));
    eq('注入类别表与体检类别表一致',
      Object.keys(R.STORY_CARD_INJECT_FIELDS).sort().join(','), STORY_INJECT_KINDS.slice().sort().join(','));
  }

  // ④ 人物卡没有长相/服装
  ok('人物卡无外貌与服装 → 报 char_no_look', codes([mk('a', 'character', '顾寒')], { assetCardIds: ['a'] }).includes('char_no_look'));
  ok('只有服装也算有长相（不报）', !codes([mk('a', 'character', '顾寒', { outfit: '黑袍' })], { assetCardIds: ['a'] }).includes('char_no_look'));

  // ⑤⑥ 剧情卡幕次 / 时间线时间点
  eq('剧情卡无幕次 → 报 plot_no_stage', codes([mk('a', 'plot', '初见')]).join(','), 'plot_no_stage');
  eq('时间线无时间点 → 报 timeline_no_when', codes([mk('a', 'timeline', '三日后')]).join(','), 'timeline_no_when');

  // ⑦ 人物卡没进资产库
  const pend = auditCards([mk('a', 'character', '林晚', { appearance: '白衣' }), mk('b', 'character', '顾寒', { appearance: '黑衣' })], { assetCardIds: ['a'] });
  eq('只有没进库的那张被算进去', pend.issues.find((i) => i.code === 'char_not_in_asset').card_ids.join(','), 'b');
  ok('char_not_in_asset 可一键修复', pend.issues.find((i) => i.code === 'char_not_in_asset').fixable === true);
  ok('全部已入资产库 → 不报这条', !codes([mk('a', 'character', '林晚', { appearance: '白衣' })], { assetCardIds: ['a'] }).includes('char_not_in_asset'));

  // counts 口径
  const c = auditCards([mk('a', 'character', '林晚', { appearance: '白衣' }), mk('b', 'character', '林晚')], { assetCardIds: ['a'] });
  eq('counts.warn 只数"要处理"', c.counts.warn, 1);
  ok('counts.info 数"可优化"', c.counts.info >= 1);
  // 这份数据里可一键修复的有两项：合并同名卡 + 把 b 写进资产库；
  // char_no_look（b 没有外貌）**不该**被算进 fixable —— 那需要人补内容，不是一键能修的
  eq('counts.fixable 只数"一键能修"的（缺字段不算）', c.counts.fixable, 2);
  ok('缺外貌只算"可优化"，不算可修复', c.issues.some((i) => i.code === 'char_no_look' && i.fixable === false));

  // mergeCardGroup：合并语义
  const before = [mk('a', 'character', '林晚', { appearance: '白衣', aliases: ['晚晚'], mentions: 1 }), mk('b', 'character', '林晚', { appearance: '白衣长剑', personality: '冷静' }), mk('c', 'location', '临江茶馆', { atmosphere: '潮湿' })];
  const m = mergeCardGroup(before, ['a', 'b']);
  eq('合并保留 id 最小的那张（最早创建）', m.keep.id, 'a');
  eq('待删除的是其余卡', m.removed.join(','), 'b');
  eq('更详细的描述取胜', m.keep.appearance, '白衣长剑');
  eq('空字段被补上', m.keep.personality, '冷静');
  eq('别名合并去重', (m.keep.aliases || []).join(','), '晚晚');
  eq('提及次数累加（"这个角色被提到几次"不能丢）', m.keep.mentions, 2);
  eq('合并后列表里只剩一张林晚', m.cards.filter((x) => x.name === '林晚').length, 1);
  eq('无关的卡片原样保留', m.cards.find((x) => x.id === 'c').atmosphere, '潮湿');
  eq('不足两张 → 不动（幂等，重复点修复不会误删）', mergeCardGroup(before, ['a']).keep, null);
  eq('不足两张时列表原样返回', mergeCardGroup(before, ['a']).cards.length, before.length);
  ok('合并只保留原 id，不产生新 id（分镜上的绑定才不会变悬空）',
    m.cards.some((x) => x.id === 'a') && !m.cards.some((x) => x.id === 'b'));
}

group('原著卡片注入纯函数（批 8 补 2：只注入看得见的两类 / 去重 / 空壳防护）');
{
  const { storyCardPhrase, storyCardLook, STORY_CARD_INJECT_FIELDS } = createRoutes;
  const teahouse = { kind: 'location', name: '临江茶馆', atmosphere: '喧闹潮湿', region: '临江', time_of_day: '夜晚', features: '木质结构' };
  const key = { kind: 'prop', name: '青铜钥匙', owner: '林晚', usage: '开密室', features: '锈迹斑斑' };
  eq('无卡片 → 原样返回（不留分隔符）', storyCardPhrase('a room', []), 'a room');
  eq('undefined 安全（批量项可能没有该字段）', storyCardPhrase('a room', undefined), 'a room');
  eq('空提示词不产出前导逗号', storyCardPhrase('', [key]), '场景道具——青铜钥匙：林晚，开密室，锈迹斑斑');
  eq('地点卡按 氛围/地域/时段/特征 顺序拼', storyCardLook(teahouse), '喧闹潮湿，临江，夜晚，木质结构');
  eq('道具卡按 持有者/用途/特征 顺序拼', storyCardLook(key), '林晚，开密室，锈迹斑斑');
  eq('多卡片用分号分隔、顺序保持', storyCardPhrase('x', [teahouse, key]),
    'x, 场景道具——临江茶馆：喧闹潮湿，临江，夜晚，木质结构；青铜钥匙：林晚，开密室，锈迹斑斑');
  // 只注入"画面上看得见"的两类：人物卡走角色库那条路（有参考图与锁定语义），
  // 信息卡/剧情卡/时间线是给编剧看的全局设定，逐镜注入只会稀释画面描述、白烧配额。
  eq('人物卡不在注入范围（走角色库那条路）', storyCardLook({ kind: 'character', name: '林岚', appearance: '长发' }), '');
  eq('信息卡不在注入范围（全局设定不该逐镜注入）', storyCardLook({ kind: 'world', name: '世界观', worldview: '架空唐朝' }), '');
  eq('剧情卡不在注入范围', storyCardLook({ kind: 'plot', name: '初见', conflict: '误会' }), '');
  eq('时间线不在注入范围', storyCardLook({ kind: 'timeline', name: '三日后', when: '第三天' }), '');
  ok('注入范围恰好是 location + prop（新增类别必须显式决策，不许默认注入）',
    Object.keys(STORY_CARD_INJECT_FIELDS).sort().join(',') === 'location,prop', Object.keys(STORY_CARD_INJECT_FIELDS).join(','));
  eq('没填任何可注入字段 → 不产出「名字：」空壳', storyCardPhrase('x', [{ kind: 'location', name: '空地点' }]), 'x');
  // 去重：同一段描述已在提示词里就不再追加（长提示词自我重复会挤掉有效信息）
  eq('描述已在提示词里 → 跳过', storyCardPhrase('喧闹潮湿，临江，夜晚，木质结构的茶馆', [teahouse]), '喧闹潮湿，临江，夜晚，木质结构的茶馆');
  eq('同名但描述不同 → 仍注入（场景换了说法）', storyCardPhrase('临江茶馆里很安静', [teahouse]),
    '临江茶馆里很安静, 场景道具——临江茶馆：喧闹潮湿，临江，夜晚，木质结构');
  eq('没有名字的卡片也能注入（只有描述）', storyCardPhrase('x', [{ kind: 'prop', usage: '开密室' }]), 'x, 场景道具——开密室');
  eq('空串名字不产出「：」', storyCardPhrase('x', [{ kind: 'prop', name: '   ', usage: '开密室' }]), 'x, 场景道具——开密室');
}

group('角色注入纯函数（R15：锁定语义 / 去重 / 空壳防护）');
{
  const { characterPhrase } = createRoutes;
  const lin = { name: '林岚', appearance: '黑色长直发、丹凤眼', outfit: '白色衬衫', is_locked: true };
  const zhou = { name: '老周', appearance: '灰白短发', is_locked: false };
  eq('无角色 → 原样返回（不留分隔符）', characterPhrase('a girl', []), 'a girl');
  eq('undefined 安全（批量项可能没有角色字段）', characterPhrase('a girl', undefined), 'a girl');
  // 空提示词时不能产出前导 ", " —— 生成链路有 finalPrompt 兜底，但纯函数自身也不该吐坏串
  eq('空提示词不产出前导逗号', characterPhrase('', [lin]), '出场角色——林岚：黑色长直发、丹凤眼，身着白色衬衫');
  eq('锁定角色无条件注入（含服装）', characterPhrase('a girl', [lin]), 'a girl, 出场角色——林岚：黑色长直发、丹凤眼，身着白色衬衫');
  eq('未锁定角色名字未被提到 → 也注入', characterPhrase('a girl', [zhou]), 'a girl, 出场角色——老周：灰白短发');
  eq('未锁定角色名字已被提到 → 跳过（尊重用户自己写的）', characterPhrase('老周点点头', [zhou]), '老周点点头');
  eq('锁定角色名字已被提到 → 照注入', characterPhrase('林岚回头', [lin]), '林岚回头, 出场角色——林岚：黑色长直发、丹凤眼，身着白色衬衫');
  eq('同样的长相描述已在提示词里 → 不重复追加',
    characterPhrase('黑色长直发、丹凤眼，身着白色衬衫的女孩', [lin]), '黑色长直发、丹凤眼，身着白色衬衫的女孩');
  eq('没填外貌 → 不产出「名字：」空壳', characterPhrase('a girl', [{ name: '无貌', appearance: '', outfit: '', is_locked: true }]), 'a girl');
  eq('只有服装也能注入', characterPhrase('a girl', [{ name: '甲', outfit: '红裙' }]), 'a girl, 出场角色——甲：身着红裙');
  eq('多角色用分号分隔、顺序保持', characterPhrase('x', [lin, zhou]), 'x, 出场角色——林岚：黑色长直发、丹凤眼，身着白色衬衫；老周：灰白短发');
  eq('无名字只有长相 → 不产出多余的「：」', characterPhrase('x', [{ appearance: '独眼' }]), 'x, 出场角色——独眼');
  // 灵敏度对照：拿一个"没有锁定判定"的朴素实现做对照，证明该分支真的在起作用
  const naive = (prompt, chars) => {
    const parts = chars.filter(Boolean).map((c) => `${c.name}：${c.appearance}`);
    return parts.length ? `${prompt}, 出场角色——${parts.join('；')}` : prompt;
  };
  ok('灵敏度对照：去掉锁定判定后未锁定角色会被误注入',
    naive('老周点点头', [zhou]) !== characterPhrase('老周点点头', [zhou]));
}

group('运镜与变体纯函数（R19/R21：白名单 / 静帧闸门 / 取模轮换）');
{
  const { cameraMovePhrase, variationPhrase } = createRoutes;
  eq('字典内的运镜取到英文', cameraMovePhrase('推镜'), 'slow push in toward the subject');
  eq('字典外的值一律落空（白名单，不是自由文本）', cameraMovePhrase('随便写一句'), '');
  eq('空值安全', cameraMovePhrase(''), ''); eq('undefined 安全', cameraMovePhrase(undefined), '');
  eq('两侧空格也认（表单值可能带空格）', cameraMovePhrase('  推镜 '), 'slow push in toward the subject');
  // 静帧闸门：运动类运镜对静态图无意义，只对视频注入
  eq('运动类运镜对静帧返回空（甩镜在图片里没有对应物）', cameraMovePhrase('甩镜', true), '');
  ok('同一运镜对视频仍返回英文（不是把整条都禁了）', cameraMovePhrase('甩镜') !== '');
  eq('机位类运镜对静帧放行（俯视换个角度看，静态图也能表达）', cameraMovePhrase('俯视', true), 'high angle looking down');
  // 变体池：首次不注入 + 取模轮换
  eq('首次生成不注入变体（第一张必须忠实于用户写的词）', variationPhrase(0), '');
  eq('负数也当首次（脏数据不得越界）', variationPhrase(-3), '');
  eq('第 1 次"再来一张"取第一条', variationPhrase(1), 'slightly different camera angle, alternative framing');
  eq('取模轮换：第 9 次回到第 1 条（不会越界成 undefined）',
    variationPhrase(9), variationPhrase(1));
  ok('变体短语不碰叙事内容（只改机位/时段/构图这类信息）',
    [1, 2, 3, 4, 5, 6, 7, 8].map(variationPhrase).every((v) => v && !/character|costume|story|plot/i.test(v)));
}

// ══════════════════════════════════════════════════════════════
// 批 8：原著解析纯函数（切块 / 规范化 / 跨块合并 / 回注渲染）
// ══════════════════════════════════════════════════════════════
const story = require('./lib/story.js');

group('原著切块（splitChunks：边界感知 + 覆盖如实上报）');
{
  // 无换行整篇（用户最常粘贴的形态：从网页/记事本复制的正文常常只有一个换行）
  const one = '林晚走进茶馆。' + '她看见了顾寒。'.repeat(400);
  const r = story.splitChunks(one, { maxChars: 300, minChars: 50 });
  ok('无换行整篇也能切块（不能只按 \\n 切）', r.chunks.length > 5, `得到 ${r.chunks.length} 块`);
  eq('全覆盖时 covered == total（一个字都不许丢）', r.covered_chars, r.total_chars);
  eq('全覆盖时 truncated=false', r.truncated, false);
  // 块自带尾随分隔符（换行），所以判"句末收尾"要先去掉尾随空白
  ok('每块都以句末标点收尾（不把一句话切两半）',
    r.chunks.every((c) => /[。！？…；]$/.test(c.text.trimEnd())), r.chunks.map((c) => c.text.trimEnd().slice(-1)).join(''));
  ok('除末块外都不超上限', r.chunks.slice(0, -1).every((c) => c.chars <= 300), r.chunks.map((c) => c.chars).join(','));
  eq('块号从 0 连续', r.chunks.map((c) => c.index).join(','), r.chunks.map((_, i) => i).join(','));
  eq('块带人类可读标签（进度链直接用）', r.chunks[0].label, `第 1/${r.chunks.length} 段`);

  // 段落边界优先于句子边界
  const para = Array.from({ length: 9 }, (_, i) => `第${i + 1}段。`.repeat(20)).join('\n');
  const r2 = story.splitChunks(para, { maxChars: 200, minChars: 60 });
  ok('段落文本按段落装块', r2.chunks.length >= 2 && r2.covered_chars === r2.total_chars);
  ok('块内保留原段落分隔（不是把段落粘成一行）', r2.chunks.some((c) => c.text.includes('\n')));

  // 无标点长墙：必须硬切但**不丢字**
  const wall = '甲'.repeat(1500);
  const r3 = story.splitChunks(wall, { maxChars: 400, minChars: 0 });
  eq('无标点长文覆盖完整（硬切也不许丢）', r3.covered_chars, 1500);
  eq('无标点长文块数 = ceil(1500/400)', r3.chunks.length, 4);
  // 显式 minChars:0 是合法用法（"别并尾块"），不能被 `|| 默认值` 吃掉
  eq('minChars:0 被尊重（不是回落到 400）', story.splitChunks(wall, { maxChars: 400, minChars: 0 }).chunks.length, 4);
  eq('不传 minChars 时按默认 400 并尾块', story.splitChunks(wall, { maxChars: 400 }).chunks.length, 3);

  // 次数闸门：截断必须如实上报，且 covered < total
  const r4 = story.splitChunks(one, { maxChars: 200, maxChunks: 2 });
  eq('超次数上限只跑 maxChunks 块', r4.chunks.length, 2);
  eq('截断时 truncated=true', r4.truncated, true);
  ok('截断时 covered < total（前端据此警告"只解析了前 N 字"）', r4.covered_chars < r4.total_chars,
    `${r4.covered_chars}/${r4.total_chars}`);
  eq('max_chunks 原样回传（界面要显示上限）', r4.max_chunks, 2);

  // 尾块并块
  const r5 = story.splitChunks('甲。'.repeat(100) + '尾巴。', { maxChars: 120, minChars: 60 });
  ok('过小的尾块向前合并（不为残句单开一次调用）',
    r5.chunks[r5.chunks.length - 1].chars >= 60 || r5.chunks.length === 1,
    `末块 ${r5.chunks[r5.chunks.length - 1].chars} 字`);

  // 边界与脏输入
  eq('空文本 → 0 块', story.splitChunks('   \n\n  ').chunks.length, 0);
  eq('空文本 total_chars=0', story.splitChunks('').total_chars, 0);
  eq('单句短文 → 1 块', story.splitChunks('只有一句话。').chunks.length, 1);
  eq('CRLF 归一（否则字数会算多）', story.normalizeText('甲\r\n乙').length, 3);
  ok('连续空行压缩', story.normalizeText('甲\n\n\n\n乙') === '甲\n\n乙');
  ok('maxChars 下限保护（不许传 1 把文本切成几千块）', story.splitChunks('甲。'.repeat(500), { maxChars: 1 }).chunks[0].chars <= 200);
}

group('卡片规范化（normalizeCard：模型输出一律不可信）');
{
  eq('中文类别名认得出', story.normalizeKind('人物'), 'character');
  eq('英文同义词认得出', story.normalizeKind('scene'), 'location');
  eq('大写也认', story.normalizeKind('PLOT'), 'plot');
  eq('认不出的类别返回空（不猜）', story.normalizeKind('不知道是啥'), '');
  eq('空类别返回空', story.normalizeKind(''), '');

  eq('无名字的卡直接丢弃', story.normalizeCard({ kind: 'character' }, {}), null);
  eq('空白名字也算无名字', story.normalizeCard({ kind: 'character', name: '   ' }, {}), null);
  eq('未知类别丢弃', story.normalizeCard({ kind: 'npc', name: '甲' }, {}), null);
  eq('null / 数组 / 字符串一律丢弃',
    [null, [], 'x', 42].map((v) => story.normalizeCard(v, {})).filter(Boolean).length, 0);

  const c = story.normalizeCard({ kind: '人物', name: '《林晚》', summary: 'x'.repeat(500), aliases: '晚晚、林晚、晚晚' }, { chunk_index: 3 });
  eq('名字去掉书名号', c.name, '林晚');
  eq('摘要截断到 300 字（防模型写小作文挤爆下游提示词）', c.summary.length, 300);
  eq('别名去重 + 去掉自己（否则提示词里出现"林晚（别名：林晚）"）', c.aliases.join(','), '晚晚');
  eq('块号原样记录（界面要能显示"这条是从第 N 段读出来的"）', c.chunk_index, 3);
  ok('未声明的字段不进卡片（白名单，不是照抄模型给的键）', !('unknown_field' in c));

  const w = story.normalizeCard({ kind: 'world', name: '临江旧事', genre: '古装', tone: '沉郁' }, {});
  eq('信息卡保留自己的业务字段', `${w.genre}/${w.tone}`, '古装/沉郁');
  eq('信息卡不带人物字段（按类白名单）', w.appearance, undefined);
  const p = story.normalizeCard({ kind: 'plot', summary: '茶馆初见，林晚试探顾寒' }, {});
  ok('剧情卡没名字时用摘要兜底（否则事件全被丢光）', p && p.name.length > 0, JSON.stringify(p));
}

group('跨块合并（mergeCards：同一人物在多段出现必须收敛成一张）');
{
  const mk = (o, i) => story.normalizeCard({ kind: 'character', name: '林晚', ...o }, { chunk_index: i });
  const m = story.mergeCards([mk({ appearance: '白衣', summary: '茶馆老板' }, 0), mk({ appearance: '白衣长剑', personality: '冷静' }, 1), mk({ appearance: '白衣' }, 2)]);
  eq('三条同名卡合并成一条', m.cards.length, 1);
  eq('合并计数如实上报', m.merged, 2);
  eq('更详细的外貌取胜（短的不许覆盖长的）', m.cards[0].appearance, '白衣长剑');
  eq('空字段被后来的卡补上', m.cards[0].personality, '冷静');
  eq('摘要保留较长的那个', m.cards[0].summary, '茶馆老板');
  eq('出现次数被累计（一致性判断的原料）', m.cards[0].mentions, 3);
  eq('证据块号按序去重', m.cards[0].evidence.join(','), '0,1,2');
  eq('合并顺序颠倒也一样（不受并发完成顺序影响）',
    story.mergeCards([mk({ appearance: '白衣长剑' }, 1), mk({ appearance: '白衣' }, 0)]).cards[0].appearance, '白衣长剑');

  // 归一化键：全角/空格/引号差异必须视为同一个人
  const m2 = story.mergeCards([mk({}, 0), story.normalizeCard({ kind: 'character', name: '林 晚' }, { chunk_index: 1 })]);
  eq('"林晚" 与 "林 晚" 视为同一人', m2.cards.length, 1);
  eq('不同类别同名不合并', story.mergeCards([mk({}, 0), story.normalizeCard({ kind: 'location', name: '林晚' }, {})]).cards.length, 2);
  eq('不同名字不合并', story.mergeCards([mk({}, 0), story.normalizeCard({ kind: 'character', name: '顾寒' }, {})]).cards.length, 2);

  // 数量上限：超出如实上报，不静默截断
  const many = Array.from({ length: 70 }, (_, i) => story.normalizeCard({ kind: 'character', name: `角色${i}` }, {}));
  const m3 = story.mergeCards(many);
  eq('单类上限生效（人物卡 60）', m3.cards.length, 60);
  eq('被丢掉的条数如实上报', m3.dropped.length, 10);
  ok('丢弃原因可读', m3.dropped[0].reason.includes('上限'));

  // 展示顺序
  const mixed = story.sortCards([
    story.normalizeCard({ kind: 'plot', name: '事件' }, { order: 0 }),
    story.normalizeCard({ kind: 'character', name: '甲' }, { order: 1 }),
    story.normalizeCard({ kind: 'world', name: '设定' }, { order: 2 }),
  ]);
  eq('展示顺序固定：信息卡 → 人物 → 地点 → 道具 → 剧情 → 时间线', mixed.map((c) => c.kind).join(','), 'world,character,plot');
}

group('回注渲染（cardsToPrompt / digestCards：反向驱动的载体）');
{
  const cards = [
    story.normalizeCard({ kind: 'character', name: '林晚', role: '主角', appearance: '白衣长剑', aliases: ['晚晚'] }, {}),
    story.normalizeCard({ kind: 'location', name: '临江茶馆', atmosphere: '喧闹潮湿' }, {}),
    story.normalizeCard({ kind: 'plot', name: '茶馆初见', stage: '起', conflict: '试探' }, {}),
  ];
  const p = story.cardsToPrompt(cards, ['character']);
  ok('只渲染指定类别', p.includes('林晚') && !p.includes('临江茶馆'), p);
  ok('带上别名与外貌（分镜一致性的关键输入）', p.includes('晚晚') && p.includes('白衣长剑'));
  ok('带"不得矛盾"的约束头（否则模型会自由发挥）', p.includes('不得与之矛盾'));
  eq('空卡片集渲染成空串（调用方据此跳过注入）', story.cardsToPrompt([], ['character']), '');
  eq('类别无卡也渲染成空串', story.cardsToPrompt(cards, ['prop']), '');

  const d = story.digestCards(cards);
  ok('摘要按类分组并带中文类名', d.includes('【人物卡】') && d.includes('【地点卡】') && d.includes('【剧情卡】'), d);
  ok('摘要逐条编号（模型可按键引用）', /1\. 林晚/.test(d));
  ok('信息缺失时给占位符而不是空白', story.cardLine({ kind: 'character', name: '甲' }).includes('待补充'));

  // 模板渲染
  eq('模板变量被替换', story.renderPrompt('甲{{x}}乙', { x: '丙' }), '甲丙乙');
  eq('未提供的变量不留 {{}} 痕迹', story.renderPrompt('甲{{x}}乙', {}), '甲乙');
  eq('同变量多处出现全部替换', story.renderPrompt('{{x}}-{{x}}', { x: 'a' }), 'a-a');
}

group('模型输出解析（parseJsonLoose / extractCards：json_mode 只是请求，不是保证）');
{
  eq('纯 JSON', story.parseJsonLoose('{"a":1}').a, 1);
  eq('```json 围栏', story.parseJsonLoose('```json\n{"a":2}\n```').a, 2);
  eq('无语言标记的围栏', story.parseJsonLoose('```\n{"a":3}\n```').a, 3);
  eq('前后带废话', story.parseJsonLoose('好的，以下是结果：\n{"a":4}\n希望有帮助').a, 4);
  eq('裸数组', story.parseJsonLoose('[1,2]').length, 2);
  eq('彻底不是 JSON → null（不抛异常）', story.parseJsonLoose('这不是 JSON'), null);
  eq('空串 → null', story.parseJsonLoose(''), null);
  eq('截断的 JSON → null（宁可这一块失败，也不猜半个对象）', story.parseJsonLoose('{"a":[1,2'), null);

  const ex = story.extractCards({ cards: [{ kind: 'character', name: '甲' }, { kind: 'npc', name: '乙' }, null] }, {});
  eq('只留下合法的卡', ex.cards.length, 1);
  eq('原始条数如实上报（界面能显示"3 条里认了 1 条"）', ex.raw_count, 3);
  eq('裸数组形态也认', story.extractCards([{ kind: 'location', name: '丙' }]).cards.length, 1);
  eq('换键名 data 也认', story.extractCards({ data: [{ kind: 'prop', name: '丁' }] }).cards.length, 1);
  eq('完全不认识的结构 → 0 条', story.extractCards({ nope: 1 }).cards.length, 0);
}

group('人物卡 → 资产库映射（cardToCharacter）');
{
  const card = story.normalizeCard({ kind: 'character', name: '林晚', role: '反派', aliases: ['晚晚'], appearance: '白衣', identity: '茶馆老板' }, {});
  card.id = 'card_1';
  const c = story.cardToCharacter(card, 'p1');
  eq('项目 id 落到行上', c.project_id, 'p1');
  eq('别名拼成字符串（characters 表是单列）', c.alias, '晚晚');
  eq('白名单内的角色定位原样保留', c.role, '反派');
  eq('没有 personality 时用 identity 兜底（不丢信息）', c.personality, '茶馆老板');
  eq('溯源：记录来自哪张卡（重复导入要幂等）', c.story_card_id, 'card_1');
  ok('默认不锁外貌（锁定是用户的显式动作）', c.is_locked === false);
  const bad = story.cardToCharacter(story.normalizeCard({ kind: 'character', name: '甲', role: '随便写的定位' }, {}), 'p1');
  eq('字典外的角色定位落回默认值', bad.role, '主角');
}

group('任务收尾阶段占位项（jobs.appendItem）');
{
  const job = jobs.create('unit_test_phase', 3);
  await jobs.run(job, [{ label: 'a' }, { label: 'b' }, { label: 'c' }], async () => ({ ok: true }));
  eq('队列本身跑完是 3/3', `${job.done}/${job.total}`, '3/3');
  const before = job.total;
  const rec = jobs.appendItem(job, '全局归并', 'reduce');
  eq('total 递增（进度条要算上收尾阶段）', job.total, before + 1);
  eq('占位项初始为 pending', rec.state, 'pending');
  eq('下标接在最后（不覆盖已有项）', rec.index, 3);
  eq('标签与 key 原样保留', `${rec.label}/${rec.key}`, '全局归并/reduce');
  rec.state = 'ok'; rec.ok = true; job.done++;
  eq('由调用方改状态后计数自洽', `${job.items.length}/${job.done}`, '4/4');
}

console.log(`\n${'═'.repeat(52)}`);
console.log(`  自检结果：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('  失败项：');
  failures.forEach((f) => console.log(`   ✗ ${f}`));
}
console.log(`${'═'.repeat(52)}\n`);
process.exit(fail ? 1 : 0);
