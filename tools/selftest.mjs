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
  ok('首装写入默认模板', n1.inserted > 0, `写入 ${n1.inserted} 条`);
  const n2 = seed.seedTemplates(store);
  // 批 8 补 28：返回值从"条数"变成分项结果（要能如实说出更新了几个、保留了哪几个）
  eq('重复播种不重复写', n2.inserted, 0);
  eq('第二次播种也不更新（内容一致）', n2.updated, 0);
  ok('首装的模板都带上版本与内容指纹（下次才能判断"有没有被改过"）',
    store.list('prompt_templates').every((t) => Number.isInteger(t.builtin_version) && /^[0-9a-f]{8}$/.test(t.builtin_digest || '')),
    JSON.stringify(store.list('prompt_templates')[0]));
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

group('Word 文档读取（批 8 补 23：.docx 就是个 zip，零依赖就能读）');
{
  const zlib = await import('node:zlib');
  const sf = await import(pathToFileURL(path.join(ROOT, 'public/js/storyfile.js')).href);

  // 手搓一个最小 zip：条目用**存储(0)**与**deflate(8)**两种方式各来一份，
  // 两种都要能读出来 —— 真实的 .docx 几乎都是 deflate，只测存储等于没测解压那条路。
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function makeZip(entries) {
    const enc = new TextEncoder();
    const locals = []; const central = []; let off = 0;
    for (const e of entries) {
      const nameB = enc.encode(e.name);
      const rawB = enc.encode(e.text);
      const body = e.stored ? rawB : new Uint8Array(zlib.deflateRawSync(rawB));
      const lExtra = new Uint8Array(e.localExtra || 0);   // 局部头扩展域（真实 .docx 里常见）
      const lh = new Uint8Array(30 + nameB.length + lExtra.length + body.length);
      const dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(8, e.stored ? 0 : 8, true);
      dv.setUint32(14, crc32(rawB), true); dv.setUint32(18, body.length, true); dv.setUint32(22, rawB.length, true);
      dv.setUint16(26, nameB.length, true); dv.setUint16(28, lExtra.length, true);
      lh.set(nameB, 30); lh.set(lExtra, 30 + nameB.length); lh.set(body, 30 + nameB.length + lExtra.length);
      locals.push(lh);
      const ch = new Uint8Array(46 + nameB.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(10, e.stored ? 0 : 8, true);
      cv.setUint32(16, crc32(rawB), true); cv.setUint32(20, body.length, true); cv.setUint32(24, rawB.length, true);
      cv.setUint16(28, nameB.length, true); cv.setUint32(42, off, true);
      ch.set(nameB, 46);
      central.push(ch);
      off += lh.length;
    }
    const cenSize = central.reduce((n, c) => n + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cenSize, true); ev.setUint32(16, off, true);
    const parts = [...locals, ...central, eocd];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let p = 0; for (const x of parts) { out.set(x, p); p += x.length; }
    return out;
  }

  const DOC = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>'
    + '<w:p><w:r><w:t>第一章 雨夜</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>顾寒推门而入，</w:t></w:r><w:r><w:t>林晚抬头看雨。</w:t></w:r><w:br/><w:t>他坐下了。</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>a &amp;lt; b &amp; 3 &lt; 5 &#65;&#x42;</w:t></w:r></w:p>'
    + '</w:body></w:document>';

  const plain = sf.docxXmlToText(DOC);
  ok('段落之间落成空行（Word 的段落就是原文的自然段）', /第一章 雨夜\n\n顾寒推门而入，林晚抬头看雨。/.test(plain), JSON.stringify(plain.slice(0, 80)));
  ok('同一段里的多个 run 正确拼接（不粘成两段）', /顾寒推门而入，林晚抬头看雨。/.test(plain), JSON.stringify(plain));
  ok('软换行 <w:br/> 落成换行', /他坐下了。/.test(plain) && /雨。\n他坐下了。/.test(plain), JSON.stringify(plain));
  eq('实体解码且 &amp;lt; 不会被二次解码（顺序错了就会变成 <）',
    plain.split('\n').filter((l) => l.includes('b & 3')).join(''), 'a &lt; b & 3 < 5 AB');
  ok('XML 声明与命名空间等标签不会混进正文', !/w:document|xmlns/.test(plain), JSON.stringify(plain.slice(0, 60)));

  const zipDeflated = makeZip([{ name: 'word/document.xml', text: DOC, stored: false }]);
  const zipStored = makeZip([{ name: 'word/document.xml', text: DOC, stored: true }]);
  const gotD = await sf.readZipText(zipDeflated, 'word/document.xml');
  const gotS = await sf.readZipText(zipStored, 'word/document.xml');
  ok('deflate 压缩的 docx 正文能读出来（真实的 .docx 几乎都是这种）', gotD.ok && gotD.text === DOC, JSON.stringify(gotD).slice(0, 120));
  ok('"存储"方式的 zip 也能读（两种压缩方式都要覆盖）', gotS.ok && gotS.text === DOC, JSON.stringify(gotS).slice(0, 120));
  eq('列条目能认出正文这一项', sf.listZipEntries(zipDeflated).entries.map((e) => e.name).join(','), 'word/document.xml');
  // 局部头的扩展域长度与中央目录里的**可以不一样**（真实 .docx 常见：局部头带 UT 时间戳）。
  // 拿中央目录的 extraLen 去算数据起点，读出来的就是一段垃圾 —— 这是 zip 的经典坑。
  const zipExtra = makeZip([{ name: 'word/document.xml', text: DOC, stored: false, localExtra: 8 }]);
  const gotE = await sf.readZipText(zipExtra, 'word/document.xml');
  ok('局部头带扩展域时仍能正确读出正文（两个 extraLen 可以不一样）',
    gotE.ok && gotE.text === DOC, JSON.stringify(gotE).slice(0, 120));
  ok('文件里没有正文时如实报错（不静默给空文本）',
    !(await sf.readZipText(makeZip([{ name: 'word/styles.xml', text: '<x/>', stored: true }]), 'word/document.xml')).ok);

  // 端到端：File 对象 → 纯文本
  const f = new File([zipDeflated], '雨夜.docx');
  const parsed = await sf.parseStoryFile(f);
  ok('.docx 端到端读成纯文本（含标题行）', parsed.ok && /第一章 雨夜/.test(parsed.text), JSON.stringify(parsed).slice(0, 140));
  ok('提示里说明来自 Word 文档（用户要知道自己选的是哪种）', /Word 文档/.test(parsed.note || ''), parsed.note);
  ok('文本经过规范化（与后端同源）', parsed.text === sf.normalizeStoryText(parsed.text), JSON.stringify(parsed.text.slice(0, 40)));

  // 准入判断：.docx 收下了，PDF 仍然明确拒绝且理由准确
  ok('.docx 现在被接受（"请先另存为 txt"这一步可以省掉了）', sf.checkStoryFile({ name: 'a.docx', size: 100 }).ok);
  const pdf = sf.checkStoryFile({ name: 'a.pdf', size: 100 });
  ok('.pdf 仍被拒绝', !pdf.ok);
  ok('拒绝理由指向真实原因（字体编码），不是含糊的"不支持"', /字体编码/.test(pdf.error || ''), pdf.error);
  ok('accept 表里含 .docx（能选中，不会"选得中却被拒"）', sf.STORY_FILE_ACCEPT.includes('.docx'), JSON.stringify(sf.STORY_FILE_ACCEPT));

  // 损坏文件不能把页面搞崩，要给出人话
  const junk = new Uint8Array([1, 2, 3, 4, 5]);
  const bad = await sf.parseStoryFile(new File([junk], '坏的.docx'));
  ok('损坏的 docx 报人话而不是抛异常', !bad.ok && /Word 正文/.test(bad.error || ''), JSON.stringify(bad));
  ok('不是 zip 的文件被识别出来（而不是当文本读出一堆乱码）', !sf.listZipEntries(junk).ok);

  // ZIP64：构造一个"目录结尾前面紧跟 ZIP64 定位器"的缓冲，必须明确拒绝。
  // 只对源码做正则等于没测行为 —— ZIP64 的文件按 32 位读出来是**看似成功的一堆乱码**，
  // 那比直接报错难查得多，所以这条要有真的行为断言。
  const z64 = new Uint8Array(42);
  const zv = new DataView(z64.buffer);
  zv.setUint32(0, 0x07064b50, true);          // ZIP64 定位器签名
  zv.setUint32(20, 0x06054b50, true);         // EOCD 签名（位置 20 = eocd-20）
  const r64 = sf.listZipEntries(z64);
  ok('ZIP64 明确拒绝（而不是按 32 位读出一堆乱码）', !r64.ok && /ZIP64/.test(r64.error || ''), JSON.stringify(r64));
}

group('逐段核对（批 8 补 26：段数一样 ≠ 切出来的是同一段原文）');
{
  const st = require(path.join(ROOT, 'lib/story.js'));
  const mk = (n, base) => Array.from({ length: n }, (_, i) => `第${base + i}章 夜访。` + '林晚走进茶馆，顾寒已在等她。'.repeat(8)).join('\n\n');
  const A = mk(20, 1), B = mk(10, 21);
  const opts = { maxChars: 3000, maxChunks: 200 };
  const sA = st.splitChunks(A, opts), sB = st.splitChunks(B, opts), sAB = st.splitChunks(A + '\n\n' + B, opts);

  // 追加解析的事实是"先切 A、再切 B"：chunk_count 就是两段之和
  eq('先切 A 再切 B 各得 1 段（存储的 chunk_count = 2）', sA.chunks.length + sB.chunks.length, 2);
  eq('重切整篇也是 2 段 —— **只看段数根本看不出来有问题**', sAB.chunks.length, 2);

  const stored = st.chunkDigests([...sA.chunks, ...sB.chunks]);
  const fresh = st.chunkDigests(sAB.chunks);
  eq('段数一样，但逐段文本全对不上（这就是"切不回原样"）',
    st.mismatchedDigests(stored, fresh).join(','), '0,1');
  // 光说"对不上"不够：要能点出**具体哪一段**，用户与界面才知道该怎么办
  eq('对不上的段号逐个点出来（第 1 段变了、第 2 段没变）',
    st.mismatchedDigests(stored, st.chunkDigests([sAB.chunks[0], sB.chunks[0]])).join(','), '0');
  // 与"过期体检"同一条纪律：没有指纹 = **不知道**，不能当成"对不上"（否则老原著全被判死）
  eq('没存指纹时返回空 —— "不知道"不等于"对不上"', st.mismatchedDigests([], fresh).length, 0);
  // 少了一段时，**移位的那段**与**消失的那段**都要报出来（只说段数不对没法定位）
  eq('段数不同时：移位的段与消失的段都点出来', st.mismatchedDigests(stored, st.chunkDigests(sAB.chunks.slice(0, 1))).join(','), '0,1');
  eq('指纹只按文本算：同一段文本再切一次，指纹一模一样（不是按块号或偏移）',
    st.chunkDigests(st.splitChunks(A, opts).chunks).join(','), stored.slice(0, 1).join(','));
  eq('指纹按段数一一对应', st.chunkDigests(sAB.chunks).length, 2);
}

group('已改的卡不被覆盖（批 8 补 25：界面写着"不会覆盖"，那代码就得真的不覆盖）');
{
  const st = require(path.join(ROOT, 'lib/story.js'));
  const base = (over) => ({
    id: 'c1', kind: 'character', name: '林晚', summary: '', aliases: [],
    appearance: '', personality: '', mentions: 1, evidence: [0], order: 1, ...over,
  });

  // ① 用户改短的描述不能被模型的"更详细描述"冲掉（合并规则本来是"更长者取胜"）
  const edited = base({ edited: true, appearance: '短发，左眉有疤' });
  const incoming = base({ appearance: '短发，左眉有一道很浅的疤痕，笑起来眼睛会眯成一条缝，常穿藏青外套' });
  const ap = st.mergeAppend([edited], [incoming]);
  const got = ap.cards[0];
  ok('用户改过的短描述不会被模型的长描述覆盖（人工值优先）',
    got.appearance === '短发，左眉有疤', JSON.stringify(got.appearance));
  ok('保住的张数被如实报出来（不是默默保护）',
    ap.protected === 1 && ap.protected_names.join(',') === '林晚', JSON.stringify({ p: ap.protected, n: ap.protected_names }));
  ok('已有卡的 id 与记账照旧（mentions 累加、evidence 并集）',
    got.id === 'c1' && got.mentions === 2 && got.evidence.join(',') === '0', JSON.stringify(got));

  // ② 体检删掉的撞名别名不能被追加解析"并回来"（否则那个撞名问题静默复发）
  const cleaned = base({ edited: true, aliases: ['晚晚'] });
  const back = base({ aliases: ['晚晚', '小晚'] });
  const ap2 = st.mergeAppend([cleaned], [back]);
  eq('体检删掉的别名不会被并回来（否则撞名问题静默复发）',
    (ap2.cards[0].aliases || []).join(','), '晚晚');

  // ③ 空字段仍然可以被补上 —— 保护的是"人工值"，不是"禁止补全"
  const edited2 = base({ edited: true, appearance: '短发' });
  const ap3 = st.mergeAppend([edited2], [base({ identity: '绣坊学徒', appearance: '很长很长的描述' })]);
  ok('用户没填的字段仍然由模型补上（保护 ≠ 拒绝补全）',
    ap3.cards[0].identity === '绣坊学徒' && ap3.cards[0].appearance === '短发', JSON.stringify(ap3.cards[0]));

  // ④ 没改过的卡行为一点不变（这条保护不能误伤正常的跨块合并）
  const ap4 = st.mergeAppend([base({ appearance: '短' })], [base({ appearance: '短发，左眉有疤' })]);
  eq('没改过的卡仍然"更详细的描述取胜"', ap4.cards[0].appearance, '短发，左眉有疤');
  eq('没改过的卡不计入"保住的张数"', ap4.protected, 0);

  // ⑤ 重新归并（applyBibleCards）也要保护：它原本是"整张替换"
  const oldBible = [base({ id: 'b1', origin: 'bible', edited: true, appearance: '人工写的长相', order: 3 })];
  const plan = st.applyBibleCards(oldBible, [base({ id: undefined, appearance: '模型重写的更长更详细的长相描述', origin: 'bible' })]);
  eq('重新归并不覆盖已改的卡', plan.update[0].appearance, '人工写的长相');
  eq('重新归并仍然按新结果重排 order（内容听人、顺序听模型）', plan.update[0].order, 1);
  ok('重新归并也报出保住的张数', plan.protected === 1 && plan.protected_names.join(',') === '林晚', JSON.stringify(plan.protected_names));
  ok('重新归并保留原 id（绑定不悬空）', plan.update[0].id === 'b1');

  // ⑥ 灵敏度对照：把 edited 拿掉，同样的输入就会被覆盖（证明这条断言真的在管这件事）
  const ap6 = st.mergeAppend([base({ appearance: '短发，左眉有疤' })], [incoming]);
  ok('灵敏度：没有"已改"标记时确实会被长描述覆盖（不是恒真的空断言）',
    ap6.cards[0].appearance !== '短发，左眉有疤', JSON.stringify(ap6.cards[0].appearance));
}

group('多文件上传（批 8 补 24：很多作者一章一个文件）');
{
  const zlib = await import('node:zlib');
  const sf = await import(pathToFileURL(path.join(ROOT, 'public/js/storyfile.js')).href);
  const F = (name, text) => new File([new TextEncoder().encode(text == null ? name : text)], name);

  // 排序：**按数值**比数字段，"第 10 章"必须排在"第 2 章"后面（按字符串比会排反）
  const names = (list) => sf.sortStoryFiles(list.map((n) => F(n))).map((f) => f.name);
  eq('章号按数值排（第 10 章在第 2 章之后）',
    names(['第10章.docx', '第2章.docx', '第1章.docx']).join(','), '第1章.docx,第2章.docx,第10章.docx');
  eq('文件名里的数字按数值排', names(['ch10.txt', 'ch2.txt', 'ch1.txt']).join(','), 'ch1.txt,ch2.txt,ch10.txt');
  eq('扩展名不参与排序（.docx 与 .txt 同名视为同一章）',
    names(['第1章.txt', '第1章.docx']).join(','), '第1章.txt,第1章.docx');
  eq('名字里没数字时给确定的顺序（可复现，但位置本身排不出来）',
    names(['乙.txt', '甲.txt', '丙.txt']).join(','), '丙.txt,乙.txt,甲.txt');
  ok('空输入不炸', sf.sortStoryFiles(null).length === 0 && sf.sortStoryFiles([]).length === 0);

  // 排不动就说出来：中文数字文件名自动排序排不出正确顺序，**不能默默装作排对了**
  ok('文件名里没有数字时标记"顺序是猜的"',
    sf.orderLooksGuessed([F('第一章.docx'), F('第二章.docx')]) === true);
  ok('有数字时不标记（第 1 章/第 10 章排得动）',
    sf.orderLooksGuessed([F('第1章.docx'), F('第10章.docx')]) === false);
  ok('单个文件谈不上顺序', sf.orderLooksGuessed([F('第一章.docx')]) === false);
  // 混着也要报：只报"一个数字都没有"是不够的 —— "序章"该在最前还是最后同样排不出来
  ok('"第1章 + 序章"这种混合也标记（序章该在最前还是最后排不出来）',
    sf.orderLooksGuessed([F('第1章.docx'), F('序章.docx')]) === true);
  eq('并点名是哪个文件排不出位置（用户要能直接去改文件名）',
    sf.unorderableNames([F('第1章.docx'), F('序章.docx'), F('尾声.docx')]).join(','), '序章.docx,尾声.docx');
  eq('全部带数字时没有排不动的文件',
    sf.unorderableNames([F('第1章.docx'), F('第10章.docx')]).join(','), '');

  // 拼接：一个文件读不了就**整体不落**（半份原文比没有更糟）
  const okAll = await sf.parseStoryFiles([F('第1章.txt', '第一章 甲'), F('第2章.txt', '第二章 乙')]);
  ok('多文件按序拼成一份原文', okAll.ok && /第一章 甲[\s\S]*第二章 乙/.test(okAll.text), JSON.stringify(okAll).slice(0, 140));
  eq('如实报出每个文件的字数（顺序看得见）', okAll.files.map((x) => x.name).join(','), '第1章.txt,第2章.txt');
  ok('文件之间留空行（段落语义）', /\n\n/.test(okAll.text), JSON.stringify(okAll.text));

  const bad = await sf.parseStoryFiles([F('第1章.txt', '甲'), F('坏的.pdf', 'x')]);
  ok('有一个文件读不了就整体不落，并点名是哪个文件',
    !bad.ok && /坏的\.pdf/.test(bad.error), JSON.stringify(bad));

  // 混格式：.txt 与 .docx 可以一起选（docx 走解压那条路）
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const mkDocx = (text) => {
    const enc = new TextEncoder();
    const nameB = enc.encode('word/document.xml');
    const xml = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
    const rawB = enc.encode(xml);
    const body = new Uint8Array(zlib.deflateRawSync(rawB));
    const lh = new Uint8Array(30 + nameB.length + body.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(8, 8, true);
    dv.setUint32(14, crc32(rawB), true); dv.setUint32(18, body.length, true); dv.setUint32(22, rawB.length, true);
    dv.setUint16(26, nameB.length, true);
    lh.set(nameB, 30); lh.set(body, 30 + nameB.length);
    const ch = new Uint8Array(46 + nameB.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(10, 8, true);
    cv.setUint32(16, crc32(rawB), true); cv.setUint32(20, body.length, true); cv.setUint32(24, rawB.length, true);
    cv.setUint16(28, nameB.length, true); cv.setUint32(42, 0, true);
    ch.set(nameB, 46);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true);
    ev.setUint32(12, ch.length, true); ev.setUint32(16, lh.length, true);
    const out = new Uint8Array(lh.length + ch.length + 22);
    out.set(lh, 0); out.set(ch, lh.length); out.set(eocd, lh.length + ch.length);
    return out;
  };
  const mixed = await sf.parseStoryFiles([
    new File([new TextEncoder().encode('第二章 乙')], '第2章.txt'),
    new File([mkDocx('第一章 甲')], '第1章.docx'),
  ]);
  ok('.txt 与 .docx 可以一起选并按章号排好',
    mixed.ok && mixed.text.indexOf('第一章 甲') < mixed.text.indexOf('第二章 乙'),
    JSON.stringify(mixed.text));
}

group('章节识别与章节级溯源（批 8 补 21：段号是切块的副产物，作者想的是"第几章"）');
{
  const story = require('./lib/story.js');
  const titles = (t) => story.detectChapters(t).chapters.map((c) => c.title);
  // 章节之间必须有**实打实的正文**：挨太近的行会被判成目录（下一条专门钉这个）。
  // 所以用例统一用 120 字的正文，别拿"标题挨着标题"当章节样本。
  const BODY = '正文内容。'.repeat(30);
  const book = (...ts) => ts.map((t) => `${t}\n${BODY}`).join('\n');
  const J = (x) => JSON.stringify(x);

  eq('识别中文章节标题', J(titles(book('第一章 雨夜', '第二章 茶馆'))), J(['第一章 雨夜', '第二章 茶馆']));
  eq('识别"第 12 章"这种带空格与阿拉伯数字的', J(titles(book('第 12 章'))), J(['第 12 章']));
  eq('识别回/节/卷', J(titles(book('第一回 起', '第三节 承', '第二卷 转'))),
    J(['第一回 起', '第三节 承', '第二卷 转']));
  eq('识别序章/楔子/尾声/番外', J(titles(book('楔子', '尾声'))), J(['楔子', '尾声']));
  eq('识别英文章节', J(titles(book('Chapter 3', 'Epilogue'))), J(['Chapter 3', 'Epilogue']));
  eq('识别 Markdown 标题', J(titles(book('# 开端', '## 转折'))), J(['# 开端', '## 转折']));

  // 误判防线：正文里提到章节名、以及目录页
  // 关键：这一行**以"第十二章"开头**（正文里回指章节很常见），但它很长 → 不是标题。
  // 拿"他翻开第十二章……"当反例是测不出东西的：那种行本来就不匹配 `^第…章`。
  // 这行**以"第十二章"开头**、但超过 40 字（正文里回指章节就是这么写的）→ 不是标题
  const longLine = '第十二章的书页被他翻烂了，他还是没找到那行小字，只好合上书，起身走到窗前，看雨一直下到天亮。';
  ok('反例本身要够长（否则测不到长度这道闸）', longLine.length > 40, String(longLine.length));
  eq('以章节名开头、但很长的那行不算章节（判定要求"整行就是标题"）',
    titles((longLine + '\n').repeat(20)).length, 0);
  const toc = ['第一章 雨夜', '第二章 茶馆', '第三章 决断', '', '第一章 雨夜', '', '正文正文。'.repeat(60)].join('\n');
  const dToc = story.detectChapters(toc);
  eq('目录页挤在一起的行被滤掉（只留真正的章节）', dToc.chapters.length, 1);
  eq('并如实上报滤掉了几个（不假装原文只有一章）', dToc.skipped, 3);
  eq('没有章节的文本如实说"没识别到"', story.detectChapters('就是一段普通文字，没有任何标题。').found, false);
  eq('空文本不炸', story.detectChapters('').chapters.length, 0);

  // 块 → 章：不用偏移量，靠标题字符串定位
  const novel = ['第一章 雨夜', '', '顾寒推门而入。'.repeat(30), '', '第二章 茶馆', '', '林晚等到天黑。'.repeat(30), '', '第三章 决断', '', '天亮时他走了。'.repeat(30)].join('\n');
  const det = story.detectChapters(novel);
  const sp = story.splitChunks(novel, { maxChars: 300, maxChunks: 24 });
  const asg = story.assignChapters(sp.chunks, det.chapters);
  ok('每块都归到了某一章', asg.by_chunk.every((x) => x.chapter >= 0), JSON.stringify(asg.by_chunk));
  eq('各章字数合计 = 原文总长（不重不漏）',
    asg.by_chapter.reduce((n, c) => n + c.chars, 0), novel.length);
  ok('一块横跨多章时如实报 spans（不假装每块都干净地属于一章）',
    asg.by_chunk.some((x) => x.spans > 1), JSON.stringify(asg.by_chunk.map((x) => x.spans)));
  eq('没有章节时每块都是"无章"', story.assignChapters(sp.chunks, []).by_chunk.every((x) => x.chapter === -1), true);
  eq('没有章节时 found=false', story.assignChapters(sp.chunks, []).found, false);

  // 关键回归：块尾恰好落在标题上时，下一块的开头正文必须归给**那个标题**，不是上一块占比最大的章
  // 承接逻辑用**手写的块**来钉，不依赖切块器的装箱细节（分隔符算几个字会随实现变，
  // 拿"手工算出来的边界"当用例，等于把测试绑死在装箱算术上 —— 这一版就先栽在这上面）。
  const CHS = [{ index: 0, title: '第一章 甲' }, { index: 1, title: '第二章 乙' }];
  const asg2 = story.assignChapters([
    { text: `第一章 甲\n\n${'甲'.repeat(50)}\n\n第二章 乙` }, // 标题落在块尾
    { text: '乙'.repeat(50) },                                   // 这一块的正文只能靠承接认领
  ], CHS);
  eq('标题落在块尾时，下一块的正文归给**那个标题**（不是上一块占比最大的章）',
    asg2.by_chunk[1].chapter, 1);
  ok('第二章的字数接近它自己的长度，而不是只剩标题那几个字',
    asg2.by_chapter[1].chars >= 50, String(asg2.by_chapter[1].chars));
  eq('横跨两章的块如实报 spans=2', asg2.by_chunk[0].spans, 2);

  // 章在块内的**起始位置**（批 8 补 22）：界面要"从这一章的标题开始"截原文给用户看。
  // 拿块的开头当章的开头是错的 —— 一章从块中间开始时，块开头是**上一章**的正文，
  // 点开第二章却看到第一章的文字（写探针时真踩到）。
  eq('块内每章的起始位置就是它标题出现的位置',
    JSON.stringify(asg2.by_chunk[0].starts), JSON.stringify([{ chapter: 0, at: 0 }, { chapter: 1, at: asg2.by_chunk[0].starts[1].at }]));
  eq('第二章在块内的起始位置正是"第二章 乙"那五个字的位置',
    asg2.by_chunk[0].starts.find((x) => x.chapter === 1).at, '第一章 甲\n\n'.length + 50 + 2);
  eq('起始位置落在块内（截取不会越界）',
    asg2.by_chunk[0].starts.every((x) => x.at >= 0 && x.at < `第一章 甲\n\n${'甲'.repeat(50)}\n\n第二章 乙`.length), true);
  // 口径是"**这一章在这一块里的正文从哪儿开始**"，不是"这一块里有没有标题"：
  // 承接来的章在这一块里确实从 0 开始（块本身是从章的中间截断的），如实报 0 才对。
  eq('承接来的章在这一块里从 0 开始（块是从章的中间截断的）',
    JSON.stringify(asg2.by_chunk[1].starts), JSON.stringify([{ chapter: 1, at: 0 }]));
  eq('起始位置与 chunks 名单口径一致：报出来的章都在这块的 chunks 里',
    asg2.by_chunk.every((x) => x.starts.every((st) => asg2.by_chapter[st.chapter].chunks.includes(x.index))), true);
  // `chunk_count` 的口径是"**涉及**到几块"，不是"独占几块"：一块横跨两章就算在两章里。
  // 这是刻意的 —— 问题定位要求"凡涉及的章都要报"（只报主导章会把问题报在错的章上，对照 BW）。
  eq('每章带上自己的段数（由纯函数给出，调用方不再自己数一遍）',
    JSON.stringify(asg2.by_chapter.map((c) => c.chunk_count)), JSON.stringify([1, 2]));
  eq('chunk_count 与 chunks 长度自洽（不出现两个口径）',
    asg2.by_chapter.every((c) => c.chunk_count === c.chunks.length), true);
  eq('横跨两章的那一块同时算在第一章与第二章名下（问题才定位得到）',
    asg2.by_chapter.filter((c) => c.chunks.includes(0)).length, 2);
}

group('卡片溯源（批 8 补 20：这张卡是从原文哪儿读出来的）');
{
  const story = require('./lib/story.js');
  const segs = (t, terms) => story.markTerms(t, terms).segments;

  eq('命中处被单独切出来（片段只分"命中/未命中"，不生成 HTML）',
    JSON.stringify(segs('顾寒见到林晚。', ['林晚'])),
    JSON.stringify([{ t: '顾寒见到', hit: false }, { t: '林晚', hit: true }, { t: '。', hit: false }]));
  ok('返回的是纯文本片段，**绝不含 HTML**（前端负责转义；这里若拼标签就是把模型输出直接注进页面）',
    segs('<img src=x onerror=alert(1)>林晚', ['林晚']).every((x) => typeof x.t === 'string' && !/^</.test(x.t.replace('<img src=x onerror=alert(1)>', ''))));
  // 真正吃劲的是"区间合并"，不是词的先后：换一下词序结果必须一样
  // （此前这里钉的是"按词长排序"，但对照 BP 证明排序是多余的 —— 合并已经保证了结果，故排序已删）
  eq('重叠处合并成完整词（"林晚"与"林晚儿"重叠时给出完整的那个）',
    JSON.stringify(segs('林晚儿来了', ['林晚', '林晚儿']).filter((x) => x.hit).map((x) => x.t)),
    JSON.stringify(['林晚儿']));
  eq('结果与词的先后无关（换了词序必须一样，否则就是靠巧合）',
    JSON.stringify(segs('林晚儿来了', ['林晚儿', '林晚'])),
    JSON.stringify(segs('林晚儿来了', ['林晚', '林晚儿'])));
  eq('重叠命中合并成一段（"林晚"与"林晚儿"重叠处不许切成碎渣）',
    segs('林晚儿来了', ['林晚', '林晚儿']).length, 2);
  eq('太短的词不匹配（单字会把整段切碎，等于没有信息）',
    JSON.stringify(segs('林晚来了', ['林'])), JSON.stringify([{ t: '林晚来了', hit: false }]));
  eq('没有命中词时原样返回一段', JSON.stringify(segs('林晚来了', [])), JSON.stringify([{ t: '林晚来了', hit: false }]));
  eq('别名也参与匹配', story.markTerms('阿晚来了', ['林晚', '阿晚']).hits.length, 1);

  const long = `开头。${'铺垫'.repeat(300)}林晚登场。${'后续'.repeat(300)}`;
  const ex = story.excerptAround(long, ['林晚'], { radius: 100 });
  ok('长段落只截命中附近（整段倒给用户等于让他自己找）', ex.text.length < long.length && ex.text.length <= 260, String(ex.text.length));
  ok('命中处仍在片段里且标了出来', ex.hits.includes('林晚') && ex.segments.some((x) => x.hit));
  eq('如实说明掐掉了头尾（不假装这是完整段落）', ex.truncated, true);
  const whole = story.excerptAround('林晚来了。', ['林晚']);
  eq('本来就短就不用标截断', whole.truncated, false);
  const none = story.excerptAround('这一段没有那个名字。', ['林晚']);
  eq('没命中也要给东西看（返回空白会让人以为出错）', none.text, '这一段没有那个名字。');
  eq('没命中时命中词为空', none.hits.length, 0);
}

group('参考图缺口体检（批 8 补 19：同一个场景 20 张图都不一样）');
{
  const story = require('./lib/story.js');
  ok('公网 URL 才算数（本地文件上游抓不到，与出图取图同一份实现）',
    story.isPublicUrl('https://a/b.png') && story.isPublicUrl('HTTP://A/B.PNG')
    && !story.isPublicUrl('/assets/x.png') && !story.isPublicUrl('') && !story.isPublicUrl(null));

  const shots = [
    { shot_number: 1, story_card_ids: ['c1'], character_ids: ['h1'] },
    { shot_number: 2, story_card_ids: ['c1'], character_ids: ['h1'] },
    { shot_number: 3, story_card_ids: ['c2'] },
    { shot_number: 4, story_card_ids: ['c3'] },
    { shot_number: 5, story_card_ids: ['c4'], character_ids: ['h2'] },
    { shot_number: 6, story_card_ids: ['c4'], character_ids: ['h2'] },
  ];
  const cards = [
    { id: 'c1', kind: 'location', name: '老宅' },
    { id: 'c2', kind: 'location', name: '只出现一次' },
    { id: 'c3', kind: 'world', name: '世界观' },
    { id: 'c4', kind: 'prop', name: '旧怀表', reference_image_ids: ['img-local'] },
  ];
  const chars = [
    { id: 'h1', name: '林晚', reference_image_ids: ['img-pub'] },
    { id: 'h2', name: '顾寒', reference_image_ids: ['img-local'] },
  ];
  // 卡片上存的是**图片 id**，能不能用只有查过图库才知道 —— 所以判定靠注入的解析器
  const fake = (map) => (ids) => {
    const urls = []; let local = 0; let missing = 0;
    for (const id of ids) {
      const u = map[id];
      if (u === undefined) missing++;
      else if (/^https?:\/\//i.test(u)) urls.push(u);
      else local++;
    }
    return { urls, local, missing };
  };
  const ASSETS = { 'img-pub': 'https://cdn/a.png', 'img-local': '/assets/local.png' };
  const r = story.auditRefImageGaps({ cards, characters: chars, shots, resolveRefs: fake(ASSETS) });
  const kinds = r.issues.map((x) => x.code + ':' + x.target_name);
  ok('重复出现又没挂参考图的地点卡被点名', kinds.includes('ref_image_missing:老宅'), JSON.stringify(kinds));
  ok('只出现一次的卡片不报（报它只会制造噪音）', !kinds.some((k) => k.includes('只出现一次')), JSON.stringify(kinds));
  ok('不注入提示词的卡片类型不报（给它挂图本来就没用）', !kinds.some((k) => k.includes('世界观')), JSON.stringify(kinds));
  ok('挂了能用的公网参考图就不报（假警报比不检查更糟：用户会去改本来正确的东西）',
    !kinds.some((k) => k.includes('林晚')), JSON.stringify(kinds));
  ok('挂了图但全是本地文件 → 单独报"一张都用不上"（比"没挂"更危险：用户以为已经做了）',
    kinds.includes('ref_image_local_only:顾寒'), JSON.stringify(kinds));
  ok('指向已删图片 → 报成"失效引用"而不是"没挂"（两种成因要分得开）',
    story.auditRefImageGaps({
      cards: [{ id: 'c1', kind: 'location', name: '老宅', reference_image_ids: ['gone'] }],
      shots: [{ shot_number: 1, story_card_ids: ['c1'] }, { shot_number: 2, story_card_ids: ['c1'] }],
      resolveRefs: fake(ASSETS),
    }).issues[0].code === 'ref_image_dangling');
  ok('同一类问题按影响镜头数从多到少排（先修影响最大的）',
    r.issues.every((x, i) => i === 0 || (r.issues[i - 1].shot_numbers || []).length >= (x.shot_numbers || []).length),
    JSON.stringify(r.issues.map((x) => x.shot_numbers.length)));
  eq('问题项带上目标 id 与镜头号（界面才能定位到具体对象）',
    JSON.stringify(r.issues.find((x) => x.target_name === '老宅').shot_numbers), JSON.stringify([1, 2]));
  ok('问题项带 go 去处（体检不能只有结论、没有出口）',
    r.issues.every((x) => x.go && x.go.page), JSON.stringify(r.issues.map((x) => x.go)));
  ok('角色走角色库页、卡片走原著页（去处必须是能真正改到的地方）',
    r.issues.find((x) => x.target_name === '顾寒').go.page === 'characters'
    && r.issues.find((x) => x.target_name === '老宅').go.page === 'novel');
  ok('角色库页的参数名是 project（写 project_id 会静默落到别的项目上）',
    r.issues.find((x) => x.target_name === '顾寒').go.params.project !== undefined);
  ok('卡片去处必须带 source_id（原著页只在 URL 有 source_id 时才加载卡片列表，否则落到空工作台）',
    r.issues.find((x) => x.target_name === '老宅').go.params.source_id !== undefined
    && Object.prototype.hasOwnProperty.call(r.issues.find((x) => x.target_name === '老宅').go.params, 'source_id'));
  eq('可一键修复数为 0（挑哪张图是人的判断，机器替不了）', r.counts.fixable, 0);

  const none = story.auditRefImageGaps({ cards: [], characters: [], shots: [] });
  eq('没有镜头就没有问题（也不报错）', none.issues.length, 0);
  eq('门槛是 2 个镜头起（单镜头不值得准备参考图）', story.REF_GAP_MIN_SHOTS, 2);
}

group('抽取覆盖体检（批 8 补 18：这段是"没信息"还是"模型没接住"）');
{
  const story = require('./lib/story.js');
  // 三种"没抽到卡片"的含义完全不同，此前被压成同一个"失败"
  eq('抽到卡片 = ok', story.classifyChunk({ cardCount: 2, rawCount: 2 }), 'ok');
  eq('模型明确说这段没信息 = empty（**不是失败**）', story.classifyChunk({ cardCount: 0, rawCount: 0 }), 'empty');
  eq('模型给了条目但全被丢弃 = dropped（真丢数据，最隐蔽）', story.classifyChunk({ cardCount: 0, rawCount: 3 }), 'dropped');
  eq('调用失败/不可解析 = failed', story.classifyChunk({ error: '网关 500' }), 'failed');
  eq('有错就是 failed（哪怕 rawCount 看着有东西）', story.classifyChunk({ cardCount: 0, rawCount: 3, error: 'x' }), 'failed');
  ok('只有 failed / dropped 要人来管（empty 是正常结局，报成失败会让告警失去意义）',
    story.chunkNeedsRetry('failed') && story.chunkNeedsRetry('dropped')
    && !story.chunkNeedsRetry('empty') && !story.chunkNeedsRetry('ok'));

  const states = [
    { index: 0, state: 'ok', cards: 2, raw_count: 2 },
    { index: 1, state: 'empty' },
    { index: 2, state: 'dropped', raw_count: 1 },
    { index: 3, state: 'failed', error: '网关 500' },
  ];
  const sum = story.summarizeExtraction({ chunkCount: 4, chunkStates: states });
  eq('四种结局各自计数', JSON.stringify(sum.counts), JSON.stringify({ ok: 1, empty: 1, dropped: 1, failed: 1, unknown: 0, pending: 0 }));
  eq('要补抽的只有 dropped 与 failed（empty 不打扰用户）', JSON.stringify(sum.needs_retry), JSON.stringify([2, 3]));
  ok('结论一句话说清四类各几段', /1 段抽到卡片/.test(story.extractionNote(sum)) && /1 段确认无信息/.test(story.extractionNote(sum)));

  // 有逐块记录却缺一段（取消/中断）：既不是"没信息"也不是"漏抽"，但**确实还没抽**
  const cut = story.summarizeExtraction({ chunkCount: 3, chunkStates: [states[0]] });
  eq('没跑到的段算 pending', cut.counts.pending, 2);
  eq('没跑到的段也要能补抽', JSON.stringify(cut.needs_retry), JSON.stringify([1, 2]));

  // 卡片实际覆盖了某块（人工补过卡）→ 以卡片为准，不能因为记录说 empty 就报"没信息"
  const covered = story.summarizeExtraction({ chunkCount: 2, chunkStates: [{ index: 0, state: 'empty' }], coveredIndexes: [0] });
  eq('记录说没抽到、但卡片覆盖了这一块 → 算 ok', covered.counts.ok, 1);

  // 老原著（本轮之前解析的）没有逐块记录：**不能替模型回答"没信息"**
  const legacy = story.summarizeExtraction({ chunkCount: 3, chunkStates: [], coveredIndexes: [1] });
  eq('老数据：有卡片覆盖的算 ok', legacy.counts.ok, 1);
  eq('老数据：没卡片的标 unknown（不是 empty，也不是 failed）', legacy.counts.unknown, 2);
  ok('老数据没有逐块记录', legacy.has_states === false);
  eq('老数据的 unknown 段作为补抽候选（补抽只补不删，是安全的）', JSON.stringify(legacy.needs_retry), JSON.stringify([0, 2]));

  eq('从卡片收集覆盖块号（evidence 并集）',
    JSON.stringify(story.chunkIndexesFromCards([{ evidence: [2, 0] }, { chunk_index: 2 }, { evidence: [5] }])),
    JSON.stringify([0, 2, 5]));
  eq('块号清洗：丢脏值、去重、按序', JSON.stringify(story.normalizeChunkStates(
    [{ index: 1, state: 'ok' }, { index: -1 }, { index: 'x' }, { index: 1, state: 'failed' }, { index: 9, state: 'wat' }], 5,
  )), JSON.stringify([{ index: 1, state: 'ok', cards: 0, raw_count: 0, raw_kinds: [], error: '' }]));
  eq('落库保留"模型给的类别"（只说丢弃了几条，用户没法动手修）',
    JSON.stringify(story.normalizeChunkStates([{ index: 0, state: 'dropped', raw_count: 2, raw_kinds: ['npc'] }], 1)[0].raw_kinds),
    JSON.stringify(['npc']));
  eq('超出块数的记录丢掉（脏值不能让面板画出不存在的段）',
    story.normalizeChunkStates([{ index: 7, state: 'ok' }], 3).length, 0);
}

group('地点卡/道具卡参考图（批 8 补 17：同一个场景每张图都不一样）');
{
  const story = require('./lib/story.js');
  ok('只认地点卡/道具卡（人物卡有资产库，信息卡/剧情卡/时间线不进提示词）',
    JSON.stringify(story.CARD_IMAGE_KINDS) === JSON.stringify(['location', 'prop']), JSON.stringify(story.CARD_IMAGE_KINDS));
  eq('参考图 id 清洗：去空、去重', JSON.stringify(story.normalizeRefIds(['a', '', 'a', 'b', null, 'c'])), JSON.stringify(['a', 'b', 'c']));
  eq('参考图 id 清洗：限量 12（与角色档案同一口径）', story.normalizeRefIds(Array.from({ length: 30 }, (_, i) => `i${i}`)).length, 12);
  eq('非数组一律当空（脏输入不能让卡片挂上乱七八糟的东西）', JSON.stringify(story.normalizeRefIds('abc')), '[]');

  // 关键：normalizeCard **故意不产出**这个字段 —— 产出空数组会在归并（store.update 合并）时
  // 把用户挂的参考图静默清空。这条钉钉的是"形状"，不是"值"。
  const card = story.normalizeCard({ kind: 'location', name: '老宅', atmosphere: '阴冷' }, {});
  ok('normalizeCard 不产出 reference_image_ids（产出就会在重新解析时清空用户挂的图）',
    !('reference_image_ids' in card), Object.keys(card).join(','));
  ok('但用户挂的参考图在归并时原样保留（store.update 是合并，键不在 patch 里就留着）',
    !('reference_image_ids' in story.applyBibleCards([], [{ kind: 'location', name: '老宅' }]).insert[0]));

  // 归并：旧卡有参考图、新结果里没有这个字段 → 更新包不含该键 → 合并后仍在
  const old = [{ id: 'c1', kind: 'location', name: '老宅', reference_image_ids: ['img1', 'img2'] }];
  const plan = story.applyBibleCards(old, [{ kind: 'location', name: '老宅', atmosphere: '更阴冷' }]);
  eq('同名卡就地更新（id 稳定）', plan.update[0].id, 'c1');
  ok('更新包里**不含** reference_image_ids（含了就会把用户挂的图冲掉）',
    !('reference_image_ids' in plan.update[0]), Object.keys(plan.update[0]).join(','));
  // 模拟 store.update 的 Object.assign 合并
  const merged = Object.assign({}, old[0], (({ id, ...rest }) => rest)(plan.update[0]));
  eq('合并后用户挂的两张图还在', JSON.stringify(merged.reference_image_ids), JSON.stringify(['img1', 'img2']));

  // 追加解析才是**真正会碰到地点卡**的那条路（reduce 只归并 origin=bible 的信息卡/剧情卡）：
  // mergeTwo 以旧卡为底，新卡没有这个键 → 原样保留。这里把它钉死。
  // （mergeTwo 是内部函数，从公开入口 mergeAppend 走一遍更实在）
  const ap = story.mergeAppend(
    [{ id: 'c1', kind: 'location', name: '老宅', atmosphere: '阴冷', reference_image_ids: ['img1', 'img2'] }],
    [{ kind: 'location', name: '老宅', atmosphere: '更阴冷潮湿' }],
  );
  eq('mergeAppend 把这张卡列为 touched（会被回写）', ap.touched.length, 1);
  eq('回写包里带着用户挂的参考图', JSON.stringify(ap.touched[0].reference_image_ids), JSON.stringify(['img1', 'img2']));
  eq('合并仍取更详细的描述（保留参考图没有妨碍原有语义）', ap.touched[0].atmosphere, '更阴冷潮湿');
}

group('全链路进度体检（批 8 补 16：卡在哪一步、下一步点哪儿）');
{
  const { pipelineOverview } = require('./lib/story.js');
  const keys = (r) => r.steps.map((x) => x.key).join('>');
  const state = (r, k) => (r.steps.find((x) => x.key === k) || {}).state;

  eq('七段链路的顺序就是创作顺序', keys(pipelineOverview({})), 'source>cards>episodes>scripts>shots>images>videos');
  const empty = pipelineOverview({});
  eq('空项目：第一步该做，其余都**待前置**（不是"该做了"）', state(empty, 'source') + '/' + state(empty, 'cards'), 'todo/blocked');
  ok('空项目给出下一步就是第一步', empty.next_step === 'source' && !empty.ready);
  eq('待前置的步骤如实标出被谁挡住', (empty.steps.find((x) => x.key === 'cards') || {}).gated_by, 'source');

  // 前置没做时，后面的步骤点进去也做不了 —— 必须与"轮到你了"分开
  ok('前置未完成时后面全是 blocked，绝不出现第二个 todo',
    empty.steps.filter((x) => x.state === 'todo').length === 1 && empty.steps.filter((x) => x.state === 'blocked').length === 6);

  const mid = pipelineOverview({ sources: 1, cards: 8, plotCards: 4, episodes: 3, scripts: 2, shots: 20, images: 5, videos: 0 });
  eq('做了一半的段是 partial（不是 done 也不是 todo）', state(mid, 'scripts'), 'partial');
  ok('下一步是**第一个**没做完的段，不是最后一个', mid.next_step === 'scripts', mid.next_step);
  eq('done 的段如实算完成', state(mid, 'episodes'), 'done');
  ok('notes 说清"差多少"（3 集骨架只有 2 集剧本）', mid.notes.some((n) => n.includes('3 集') && n.includes('2 集')), JSON.stringify(mid.notes));
  ok('notes 说清"多少镜头还没出图"', mid.notes.some((n) => n.includes('15 个还没有分镜图')), JSON.stringify(mid.notes));

  // 有卡片但没有剧情卡：分集骨架是按剧情卡排的 —— 这种"看着做了其实做不下去"要专门提示
  const noPlot = pipelineOverview({ sources: 1, cards: 5, plotCards: 0, episodes: 0 });
  ok('有卡片但没剧情卡时专门提示（否则用户会以为分集那步坏了）',
    noPlot.notes.some((n) => n.includes('剧情卡')), JSON.stringify(noPlot.notes));

  const full = pipelineOverview({ sources: 1, cards: 8, plotCards: 4, episodes: 3, scripts: 3, shots: 20, images: 20, videos: 20 });
  ok('全做完时 ready=true 且没有下一步', full.ready && full.next_step === '', JSON.stringify({ r: full.ready, n: full.next_step }));
  eq('全做完时没有 blocked/todo/partial', (full.counts.blocked || 0) + (full.counts.todo || 0) + (full.counts.partial || 0), 0);

  // 脏数据不能让面板崩（统计值可能来自任意来源）
  const dirty = pipelineOverview({ sources: 'x', cards: -5, episodes: null, scripts: undefined, shots: NaN, images: '3' });
  ok('脏输入一律当 0（面板不能因为一个坏值整块崩掉）',
    dirty.steps.every((x) => Number.isFinite(x.have) && x.have >= 0), JSON.stringify(dirty.steps.map((x) => x.have)));
  eq('字符串数字照常认', state(dirty, 'images') === 'partial' || state(dirty, 'images') === 'done', true);
}

group('负面提示词并入正向提示词（批 8 补 14：一份措辞，三处同源）');
{
  const { negativePhrase } = require('./lib/story.js');
  eq('有负面词时并入正向提示词（与视频 2.5 系同一措辞）', negativePhrase('一只猫', 'low quality'), '一只猫。避免出现：low quality');
  eq('没填就不拼出空尾巴', negativePhrase('一只猫', ''), '一只猫');
  eq('只有空白也算没填（否则会发出一个空的"避免出现："）', negativePhrase('一只猫', '   '), '一只猫');
  eq('undefined / null 同样当没填', negativePhrase('一只猫') + '/' + negativePhrase('一只猫', null), '一只猫/一只猫');
  eq('负面词两端的空白会被去掉', negativePhrase('一只猫', '  blurry  '), '一只猫。避免出现：blurry');
  eq('并入是**追加**，不改动用户写的正向提示词', negativePhrase('一只猫, watercolor', 'blurry').startsWith('一只猫, watercolor。'), true);
}

group('剧本/分镜的过期体检（批 8 补 12：输入变了、产物没重生成）');
{
  const { planEpisodes, episodeInputDigest, digestText, auditStaleness } = require('./lib/story.js');
  const cards = [
    { id: 'p1', kind: 'plot', name: '茶馆初见', stage: '起', order: 1 },
    { id: 'p2', kind: 'plot', name: '密室夜访', stage: '合', order: 2 },
    { id: 'p3', kind: 'plot', name: '真相', stage: '起', order: 3 },
    { id: 'p4', kind: 'plot', name: '结局', stage: '合', order: 4 },
  ];
  const plan = planEpisodes(cards, { perEpisode: 2 });
  eq('过期体检：先有两集骨架', plan.episodes.length, 2);
  const d1 = episodeInputDigest(plan, 1);
  const d2 = episodeInputDigest(plan, 2);
  ok('指纹是 8 位十六进制且同一输入稳定', /^[0-9a-f]{8}$/.test(d1) && d1 === episodeInputDigest(plan, 1), d1);
  ok('不同集的指纹不同（本集拍表进指纹）', d1 !== d2);
  ok('不存在的集返回空串（"没有这一集"要能与"有但没变"区分）', episodeInputDigest(plan, 99) === '');

  const scripts = [{ id: 's1', episode_number: 1, title: '第1集', content: '第一集正文', plan_digest: d1, created_at: '2024-01-01' }];
  const shots = [{ episode_number: 1, source_script_id: 's1', script_digest: digestText('第一集正文') }];
  const r0 = auditStaleness(plan, scripts, shots);
  eq('输入没变 → 剧本一致', r0.episodes[0].script_state, 'ok');
  eq('分镜的来源剧本没变 → 一致', r0.episodes[0].shot_state, 'ok');
  eq('第 2 集没剧本也没分镜 → 都算缺', r0.episodes[1].script_state + '/' + r0.episodes[1].shot_state, 'missing/missing');
  eq('缺剧本的集数与"该重生成"分开计数（缺 ≠ 过期）', r0.counts.script_missing + '/' + r0.counts.script_stale, '1/0');

  // 原著**往后追加**新章节：第 1 集的拍表和前情都没变 → 不该报过期。
  // 这一条是"精确性"的钉子：动不动就报过期，用户就会去重生成一堆没必要的集（真花钱）
  const grown = cards.concat([{ id: 'p5', kind: 'plot', name: '夜访灯笼', stage: '承', order: 5 }]);
  const plan2 = planEpisodes(grown, { perEpisode: 2 });
  const r1 = auditStaleness(plan2, scripts, shots);
  eq('往后追加章节：第 1 集输入没变 → 仍然一致（不无谓地喊重生成）', r1.episodes[0].script_state, 'ok');
  eq('往后追加章节：多出来的那一集如实算"还没有剧本"', r1.counts.script_missing, 2);
  eq('往后追加章节：一集都不该报过期', r1.counts.script_stale, 0);
  eq('多出来的集在列表里（用户能直接去生成）', r1.episodes.length, 3);

  // 重切分集（改每集拍数）：第 1 集的拍表被重新分组 → 指纹变 → 如实报过期
  const planPer = planEpisodes(cards, { perEpisode: 3 });
  const rp = auditStaleness(planPer, scripts, shots);
  eq('重切分集后第 1 集如实报过期', rp.episodes[0].script_state, 'stale');
  eq('过期计数只算真的过期了的那几集', rp.counts.script_stale, 1);
  ok('给出的"当前输入指纹"就是该重生成时该存的那个值',
    rp.episodes[0].input_digest === episodeInputDigest(planPer, 1) && rp.episodes[0].input_digest !== d1);

  // 改**更早**的拍：本集拍表没动，但模型看到的前情变了 —— 只对拍表取指纹就会漏报
  const front = cards.map((c) => (c.id === 'p1' ? { ...c, name: '茶馆初见·改写' } : c));
  const plan3 = planEpisodes(front, { perEpisode: 2 });
  eq('改更早的拍：第 1 集自己的拍表变了 → 过期', auditStaleness(plan3, scripts, shots).episodes[0].script_state, 'stale');
  ok('前情进指纹这件事本身：第 2 集的指纹随更早的集变化（它的拍表一个字没动）',
    episodeInputDigest(plan3, 2) !== episodeInputDigest(plan, 2)
    && JSON.stringify(plan3.episodes[1].beats) === JSON.stringify(plan.episodes[1].beats));
  eq('显式声明不带前情时，前情变化不再影响指纹（指纹要如实描述"实际喂了什么"）',
    episodeInputDigest(plan3, 2, { withPrior: false }) === episodeInputDigest(plan, 2, { withPrior: false }), true);

  // 剧本正文被改了 → 由它生成的分镜过期；源剧本被删 → 无从追溯，也算过期
  const edited = [{ ...scripts[0], content: '第一集正文（改过）' }];
  eq('剧本正文改过 → 分镜报过期', auditStaleness(plan, edited, shots).episodes[0].shot_state, 'stale');
  eq('源剧本被删 → 分镜无从追溯，如实报过期', auditStaleness(plan, [], shots).episodes[0].shot_state, 'stale');

  // "不知道"不能当成"没过期"：本轮之前生成的剧本没有指纹
  const r2 = auditStaleness(plan, [{ ...scripts[0], plan_digest: '' }], [{ episode_number: 1 }]);
  eq('没有指纹 → unknown（不替用户断言它没过期）', r2.episodes[0].script_state, 'unknown');
  eq('没有来源剧本的分镜 → unknown', r2.episodes[0].shot_state, 'unknown');
  ok('unknown 单独计数、并如实说明原因', r2.counts.script_unknown === 1 && r2.notes.some((x) => x.includes('没有生成指纹')), JSON.stringify(r2.notes));
  eq('unknown 不算"该重生成"（否则用户会被无谓的重生成烧钱）', r2.counts.script_stale, 0);

  // 同一集存了多份（重生成过）：以最新的一份为准，与界面一致
  const multi = [scripts[0], { id: 's9', episode_number: 1, title: '第1集·新', content: 'x', plan_digest: 'aaaaaaaa', created_at: '2025-01-01' }];
  eq('同一集有多份时看最新那份', auditStaleness(plan, multi, shots).episodes[0].script_id, 's9');
  eq('旧的没过期、新的过期 → 这一集算过期（不能因为存在一份"看着没问题"的就放过）',
    auditStaleness(plan, multi, shots).episodes[0].script_state, 'stale');
}

group('人物卡 ↔ 资产库漂移体检（批 8 补 11：出图用的长相与界面显示的是不是同一份）');
{
  const { auditCharacterDrift } = require('./lib/story.js');
  const card = { id: 'k1', kind: 'character', name: '林晚', appearance: '长发及腰', outfit: '青衫', aliases: ['晚晚', '阿晚'], role: '主角', personality: '冷静' };
  const ch = { id: 'ch1', name: '林晚', story_card_id: 'k1', appearance: '白衣', outfit: '', alias: '晚晚', role: '配角', personality: '暴躁' };
  const r = auditCharacterDrift([card], [ch]);
  const it = r.issues[0] || {};
  ok('漂移体检：报出外貌/服饰/别名三处不一致', r.issues.length === 1 && (it.drift || []).map((d) => d.field).join(',') === '外貌,服饰,别名');
  ok('漂移体检：有覆盖（库里非空但不同）→ warn，且值逐条摆出来给人核对',
    it.level === 'warn' && it.conflicts.length === 3
    && it.conflicts.some((c) => c.field === '外貌' && c.values.join('→') === '白衣→长发及腰'));
  ok('漂移体检：只有空字段要补 → info（纯补全，不覆盖任何已有内容）',
    auditCharacterDrift([card], [{ ...ch, appearance: '长发及腰', alias: '晚晚、阿晚' }]).issues[0].level === 'info');
  ok('漂移体检：role/gender/personality 这些**不影响出图**的字段不参与（否则每张卡都报，用户会无视面板）',
    !JSON.stringify(it.drift).includes('性格') && !JSON.stringify(it.drift).includes('定位'));
  ok('漂移体检：还没入资产库的人物卡不在本条重复报（那是 char_not_in_asset 的事）',
    auditCharacterDrift([card], []).issues.length === 0 && auditCharacterDrift([card], []).pairs === 0);
  ok('漂移体检：完全一致就一条都不报', auditCharacterDrift([card], [{ ...ch, appearance: '长发及腰', outfit: '青衫', alias: '晚晚、阿晚' }]).issues.length === 0);
  ok('漂移体检：资产库里的别名用顿号/逗号/斜杠分隔都认得（别名的写法是历史遗留）',
    auditCharacterDrift([{ ...card, aliases: ['阿晚'] }],
      [{ ...ch, appearance: '长发及腰', outfit: '青衫', alias: '晚晚,阿晚' }]).issues.length === 0);
  ok('漂移体检：卡里没写外貌就不报（不能凭"库里写了卡里没有"就报漂移）',
    auditCharacterDrift([{ id: 'k2', kind: 'character', name: '顾寒' }], [{ id: 'ch2', name: '顾寒', story_card_id: 'k2', appearance: '黑衣' }]).issues.length === 0);
  ok('漂移体检：可修，修复动作码是 sync_character（问题码 ≠ 动作码）',
    it.fixable === true && it.fix_code === 'sync_character' && it.code === 'char_drift' && it.target_id === 'ch1');
}

group('追加解析的卡片归并（批 8 补 10：长篇连载只解析新增章节）');
{
  const { mergeAppend } = require('./lib/story.js');
  const ex = [
    { id: 'c1', kind: 'character', name: '林晚', identity: '茶馆老板', aliases: ['晚晚'], order: 1, mentions: 2, evidence: [0], chunk_index: 0, source_id: 's1', project_id: 'p1' },
    { id: 'c2', kind: 'plot', name: '茶馆初见', stage: '起', order: 2, evidence: [1], chunk_index: 1, source_id: 's1', project_id: 'p1' },
    { id: 'c3', kind: 'location', name: '临江茶馆', atmosphere: '潮湿昏暗', order: 3, evidence: [1], chunk_index: 1, source_id: 's1', project_id: 'p1' },
  ];
  // 新增章节：同名人物（补外貌 + 新别名）、同名地点（更详细的氛围）、全新剧情
  const inc = [
    { kind: 'character', name: '林晚', appearance: '长发及腰', aliases: ['阿晚'], chunk_index: 5 },
    { kind: 'location', name: '临江茶馆', atmosphere: '潮湿昏暗，江风穿堂而过，灯笼忽明忽暗', chunk_index: 5 },
    { kind: 'plot', name: '夜访密室', stage: '承', chunk_index: 5 },
  ];
  const r = mergeAppend(ex, inc);
  // 找不到就当空对象：钉子要**报红**，不能因为读 undefined 的属性把整份自检崩掉
  // （崩掉会连带后面几十条钉子一起不跑，掩盖真正的问题范围）
  const byName = (n) => r.cards.find((c) => c.name === n) || {};
  ok('追加：同名卡不新建，收敛成一张', r.cards.filter((c) => c.name === '林晚').length === 1);
  ok('追加：已有卡保留原 id（绑定与正在看的卡片都靠 id 认人）', byName('林晚').id === 'c1' && byName('临江茶馆').id === 'c3');
  ok('追加：已有卡一张都不消失（删卡会让分镜绑定悬空）', ex.every((e) => r.cards.some((c) => c.id === e.id)) && r.cards.length === 4);
  ok('追加：空字段被补上、别名取并集、更详细的描述取胜',
    byName('林晚').appearance === '长发及腰'
    && (byName('林晚').aliases || []).join(',') === '晚晚,阿晚'
    && String(byName('临江茶馆').atmosphere || '').startsWith('潮湿昏暗，江风穿堂'));
  ok('追加：出现次数与块号累计（不是覆盖）',
    byName('林晚').mentions === 3 && (byName('林晚').evidence || []).join(',') === '0,5');
  ok('追加：已有卡的 order 原样保留，新卡接在最大 order 之后（否则剧情卡顺序会乱）',
    byName('茶馆初见').order === 2 && byName('临江茶馆').order === 3 && byName('夜访密室').order === 4);
  ok('追加：账目对得上（touched 只含被本次改动的已有卡，fresh 只含新卡）',
    (r.touched || []).length === 2 && r.fresh.length === 1 && r.touched.every((c) => c.id)
    && r.fresh.every((c) => !c.id) && r.cards.length === 4 && r.merged === 2);
  ok('追加：没被碰到的已有卡不在回写名单里（不必回写、也不该动它）',
    !r.touched.some((c) => c.name === '茶馆初见') && r.cards.some((c) => c.id === 'c2'));
  ok('追加：全新名字才新增（不同 kind 同名不算同一张）',
    mergeAppend(ex, [{ kind: 'prop', name: '林晚', chunk_index: 5 }]).inserted === 1);

  // 归并结果的落库：替换语义 + id 稳定（原来"删了重建"会让每次归并都换一批 id）
  const { applyBibleCards } = require('./lib/story.js');
  const oldBible = [
    { id: 'b1', kind: 'world', name: '临江旧事', summary: '旧设定', order: 1 },
    { id: 'b2', kind: 'plot', name: '茶馆初见', stage: '起', order: 2 },
    { id: 'b3', kind: 'plot', name: '被删掉的支线', stage: '转', order: 3 },
  ];
  const incoming = [
    { kind: 'world', name: '临江旧事', summary: '新设定更详细' },
    { kind: 'plot', name: '茶馆初见', stage: '起' },
    { kind: 'plot', name: '夜访密室', stage: '承' },
  ];
  const bp = applyBibleCards(oldBible, incoming);
  ok('归并落库：同名就地更新并保住原 id（删了重建会让分镜绑定指向不存在的卡）',
    bp.update.length === 2 && bp.update.find((c) => c.name === '临江旧事').id === 'b1'
    && bp.update.find((c) => c.name === '茶馆初见').id === 'b2');
  ok('归并落库：新名字才新增', bp.insert.length === 1 && bp.insert[0].name === '夜访密室');
  ok('归并落库：这次结果里没有的旧卡才删（替换而不是叠加）',
    bp.remove.length === 1 && bp.remove[0].id === 'b3');
  ok('归并落库：order 听新结果（归并是重排，不是往后接）',
    bp.update.map((c) => c.order).join(',') === '1,2' && bp.insert[0].order === 3);
  ok('归并落库：重跑同一次结果不会产生任何新增或删除（幂等）',
    (() => { const again = applyBibleCards([...bp.update, ...bp.insert], incoming); return again.insert.length === 0 && again.remove.length === 0; })());
}

group('单集拍表与前情提要（批 8 补 8：逐集生成时的连续性上下文）');
{
  const { planEpisodes, episodeBriefText, priorBrief, beatLine, PRIOR_MAX_DEFAULT } = require('./lib/story.js');
  const cards = [];
  for (let i = 1; i <= 12; i++) {
    cards.push({ kind: 'plot', id: `c${i}`, source_id: 's1', name: `事件${i}`, stage: '起', summary: `梗概${i}`, conflict: `冲突${i}`, turn: `转折${i}`, outcome: `结果${i}`, involved: '林晚' });
  }
  const plan = planEpisodes(cards, { perEpisode: 4 });
  eq('骨架按每集 4 拍切出 3 集', plan.episodes.length, 3);

  // ① 单集拍表：就是全剧版里那一集的渲染（措辞同源，靠 beatLine）
  const b2 = episodeBriefText(plan, 2);
  ok('单集拍表带集号与拍数', b2.startsWith('第 2 集（'), b2.split('\n')[0]);
  eq('单集拍表的拍数与该集一致', b2.split('\n').length - 1, plan.episodes[1].beat_count);
  ok('单集拍表用 beatLine 渲染（与全剧版同源）', b2.includes(beatLine(plan.episodes[1].beats[0])), b2);
  eq('集号字段是 index（写成 number 会静默匹配不到）', episodeBriefText(plan, 2) !== '', true);
  eq('不存在的集返回空串', episodeBriefText(plan, 99), '');
  eq('空输入安全', episodeBriefText(null, 1) + episodeBriefText(plan, 0), '');

  // ② 前情提要：只带前面的集，且从最早的一端丢
  const p1 = priorBrief(plan, 1);
  eq('第 1 集没有前情', p1.text, '');
  eq('第 1 集的前情集数为 0', p1.episodes.length, 0);
  const p2 = priorBrief(plan, 2);
  ok('第 2 集的前情里只有第 1 集', p2.text.includes('【第 1 集】') && !p2.text.includes('【第 2 集】'), p2.text);
  eq('前情集号如实上报', p2.episodes.join(','), '1');
  eq('没超预算就不算截断', p2.truncated, false);
  ok('前情写明"不要重复叙述"（否则模型会把前情复述一遍当本集内容）', p2.text.includes('不要重复叙述'), p2.text);
  ok('前情里带上每一拍的 beatLine', p2.text.includes(beatLine(plan.episodes[0].beats[0])), p2.text);

  const p3 = priorBrief(plan, 3, { maxChars: 120 });
  ok('超预算时从最早的一端丢（越近越相关）', p3.episodes.join(',') === '2', p3.episodes.join(','));
  eq('丢掉的集如实上报', p3.omitted.join(','), '1');
  eq('截断标记为真', p3.truncated, true);
  ok('省略的集在正文里点明', p3.text.includes('已省略') && p3.text.includes('第 1 集'), p3.text);
  ok('前情正文不含被省略那一集的内容', !p3.text.includes(beatLine(plan.episodes[0].beats[0])), p3.text);
  ok('至少留一集（前情不能变成空话）', priorBrief(plan, 3, { maxChars: 1 }).episodes.length === 1, '');
  eq('预算非法时回落到默认值', priorBrief(plan, 3, { maxChars: 'x' }).chars > 0, true);
  eq('默认预算是正数', PRIOR_MAX_DEFAULT > 0, true);
  eq('空输入安全', priorBrief(null, 3).text + priorBrief(plan, 0).text, '');
}

group('画风写死体检（批 8 补 7：提示词里不该写死系统要注入的东西）');
{
  const { styleWordHits, auditPromptStyle, stripStyleWord, STYLE_WORDS } = require('./lib/story.js');
  const routes = require('./lib/routes.js');

  // ① 词表与项目画风同源：每一种项目画风词都必须认得（画风表改了这里要跟着改）
  {
    const map = routes.ART_STYLE_MAP || {};
    const miss = Object.values(map).filter((ph) => styleWordHits(ph).length === 0);
    eq('每一种项目画风短语都认得（跨文件棘轮：ART_STYLE_MAP 的值）', miss.join(' | '), '');
    eq('词表非空', STYLE_WORDS.length > 10, true);
  }

  // ② 命中：媒介/画风词要抓，画面质量词不要抓（后者是镜头内容的一部分）
  eq('整条画风短语优先命中（删得干净）',
    styleWordHits('japanese anime style, thick painterly shading').map((x) => x.word).join('|'),
    'japanese anime style, thick painterly shading');
  eq('只写了半条也认得', styleWordHits('japanese anime style, a girl').map((x) => x.word).join('|'), 'japanese anime style');
  eq('英文词按词边界匹配（comical 不该命中 comic）', styleWordHits('a comical face').length, 0);
  eq('中文画风词也能抓（用户可能粘中文提示词）', styleWordHits('水彩风格的少女').map((x) => x.word).join('|'), '水彩');
  eq('重叠命中只留最长的一条（不刷屏）',
    styleWordHits('a manga panel, black and white manga, screentone shading').map((x) => x.word).join('|'),
    'manga|black and white manga, screentone shading');  // 按出现位置排；重叠的才合并
  eq('画面质量词不报（cinematic / detailed 是镜头内容）', styleWordHits('cinematic lighting, ultra detailed, 8k').length, 0);
  eq('没有画风词的提示词不报', styleWordHits('a girl walks into a teahouse, rain outside').length, 0);
  eq('空输入安全', styleWordHits('').length + styleWordHits(null).length, 0);

  // ③ 体检：按词聚合、两档（与当前画风冲突 = warn / 一致但写死了 = info）
  {
    const shots = [
      { id: 's1', shot_number: 1, episode_number: 1, image_prompt: 'a girl, oil painting style, visible brush strokes', video_prompt: 'slow dolly in' },
      { id: 's2', shot_number: 2, episode_number: 1, image_prompt: 'anime girl', video_prompt: 'pan left, manga' },
      { id: 's3', shot_number: 3, episode_number: 2, image_prompt: 'a girl in the rain' },
    ];
    const r = auditPromptStyle(shots, { style: '日漫厚涂', stylePhrase: 'japanese anime style, thick painterly shading' });
    const byWord = (w) => r.issues.find((x) => x.word === w);
    eq('扫到的镜头数如实上报', r.scanned, 3);
    eq('与当前画风冲突的算"要处理"', byWord('oil painting style, visible brush strokes').level, 'warn');
    eq('与当前画风一致的算"可优化"（今天不出错，但换画风会失效）', byWord('anime').level, 'info');
    eq('按词聚合：同一个词跨镜头只报一条', r.issues.filter((x) => x.word === 'manga').length, 1);
    eq('一条里带上全部相关镜头', byWord('manga').shot_ids.join(','), 's2');
    ok('镜头明细带上是哪个字段（图片/视频）', byWord('manga').shots[0].field === 'video_prompt', JSON.stringify(byWord('manga').shots));
    eq('修复动作码是"删掉写死的画风词"', byWord('manga').fix_code, 'strip_style_word');
    eq('可修复数如实统计', r.counts.fixable, r.issues.length);
    ok('详情讲清后果（改画风不会生效）', byWord('manga').detail.includes('改项目画风也不会生效'), byWord('manga').detail);
    ok('一致的那档也讲清"以后改画风不会跟着变"', byWord('anime').detail.includes('不会跟着变'), byWord('anime').detail);
    eq('没写画风的镜头不报', r.issues.some((x) => x.shot_ids.includes('s3')), false);
    eq('空输入安全', auditPromptStyle(undefined, {}).issues.length, 0);
  }

  // ④ 机械修复：只删那个词，别的地方一个字不动
  eq('删整条短语', stripStyleWord('japanese anime style, thick painterly shading, a girl walks in', 'japanese anime style, thick painterly shading'), 'a girl walks in');
  eq('删半条不留孤零零的 style', stripStyleWord('japanese anime style, a girl walks in', 'japanese anime style'), 'a girl walks in');
  eq('英文词按词边界删（不动 comical）', stripStyleWord('a comical face', 'comic'), 'a comical face');
  eq('中文词直接删', stripStyleWord('水彩风格，少女在雨中', '水彩'), '风格，少女在雨中');
  eq('删完收拾多余的逗号', stripStyleWord('a girl, anime, holding a sword', 'anime'), 'a girl, holding a sword');
  eq('要删的词不在里面就原样返回（幂等）', stripStyleWord('a girl walks in', 'manga'), 'a girl walks in');
  eq('空输入安全', stripStyleWord('', 'manga'), '');
}


{
  const { characterRoster } = await import(pathToFileURL(path.join(ROOT, 'public/js/consts.js')).href);
  const { splitShotCharacters, auditShotBindings } = require('./lib/story.js');
  const chars = [
    { name: '林晚', alias: '晚晚、林老板', appearance: '黑色长直发垂至腰间，丹凤眼，左眉尾有一颗小痣，皮肤偏冷白', outfit: '白色衬衫', is_locked: true },
    { name: '顾寒', alias: ['阿寒'], appearance: '黑甲', is_locked: false },
    { name: '   ', appearance: '没有名字的行不该进名册' },
  ];

  // ① 名册：只给名字与一行长相，且明确"用本名""长相别写进提示词"
  {
    const r = characterRoster(chars, { text: '林晚走进茶馆' });
    eq('无名角色不进名册', r.count, 2);
    eq('名字列表给调用方复用', r.names.join(','), '林晚,顾寒');
    ok('明确要求用本名', r.text.includes('必须使用下列本名'), r.text.slice(0, 60));
    ok('明确要求把代称换成本名', r.text.includes('女主'), r.text.slice(0, 80));
    ok('别名两种形态（"、"字符串 / 数组）都进名册',
      r.text.includes('（别名：晚晚、林老板）') && r.text.includes('（别名：阿寒）'), r.text.split('\n')[1]);
    ok('长相只给一行且明确禁止写进提示词',
      r.text.includes('不要写进 image_prompt / video_prompt'), r.text.slice(-90));
    ok('提到过的角色排在前面（本集最可能出场的先给模型看）',
      r.text.split('\n')[1].includes('林晚'), r.text.split('\n')[1]);
    ok('长长相被截断（名册不能把请求体撑爆）',
      r.text.includes('…'), r.text.split('\n')[1]);
  }
  eq('没有角色时返回空文本（调用方原样跳过，不产生空块）', characterRoster([]).text, '');
  eq('空输入安全', characterRoster(null).count, 0);
  eq('无名角色单独一条也不进名册', characterRoster([{ name: '  ' }]).count, 0);
  {
    const r = characterRoster(chars, { limit: 1 });
    eq('超上限只列前 N 个', r.count, 1);
    eq('被截掉的数量如实上报', r.truncated, 1);
    ok('截断时给出"不要新造名字"的兜底要求', r.text.includes('不要新造名字'), r.text.slice(-120));
  }

  // ② 「出场人物」拆分：分隔符 / 单字 / 泛称 / 去重
  eq('顿号逗号斜杠分号空格都算分隔符',
    splitShotCharacters('林晚、顾寒,苏婉儿/阿寒；两人 少女').join('|'), '林晚|顾寒|苏婉儿|阿寒|少女');
  eq('泛称不进候选（否则体检会刷屏）',
    splitShotCharacters('两人、三人、众人、路人、群演、旁白').length, 0);
  eq('单字名不进候选（撞词概率太高）', splitShotCharacters('雪、雨、林晚').join('|'), '林晚');
  eq('重复名字只留一个', splitShotCharacters('林晚、林晚').join('|'), '林晚');
  eq('整体括号包起来的剥掉括号', splitShotCharacters('（画外）').join('|'), '画外');
  eq('空输入安全', splitShotCharacters(undefined).length, 0);

  // ③ 体检：名字在角色库里找不到 → 报出来（这类镜头一定没有外貌注入）
  {
    const shots = [
      { id: 's1', shot_number: 1, characters: '林晚、少女' },
      { id: 's2', shot_number: 2, characters: '少女、女主' },
      { id: 's3', shot_number: 3, characters: '林晚、两人' },
      { id: 's4', shot_number: 4, characters: '晚晚' },   // 别名：算认识，不该报
    ];
    const r = auditShotBindings(shots, { characters: chars, cards: [] });
    const unk = r.issues.filter((x) => x.code === 'shot_char_unknown');
    eq('代称被聚合成一条条（按名字，而不是按镜头）', unk.map((x) => x.target_name).join(','), '少女,女主');
    eq('聚合里带上全部相关镜头', unk[0].shot_ids.join(','), 's1,s2');
    eq('只算"可优化"（可能是临时角色，也可能只是代称）', unk[0].level, 'info');
    eq('不提供一键修复（该改名还是该建角色是人的判断）', unk[0].fixable, false);
    ok('详情讲清后果与两条出路',
      unk[0].detail.includes('不会有外貌注入') && unk[0].detail.includes('自动匹配绑定'), unk[0].detail);
    ok('别名算"认识"，不报', !unk.some((x) => x.target_name === '晚晚'));
    ok('泛称不报', !unk.some((x) => x.target_name === '两人'));
  }
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

// ══════════════════════════════════════════════════════════════
// 批 8 补 28：内置提示词"能更新"（版本 + 内容指纹，只更新没被用户改过的）
// ══════════════════════════════════════════════════════════════
// 为什么这条要有断言：这是**唯一一处会在启动时动用户已有数据**的逻辑。
// 提示词是抽取质量最大的杠杆，而 seedTemplates 原来只写"库里没有的 key" ——
// 改代码里的提示词对老用户完全无效，且没有任何提示（每一轮的提示词改进都被这个洞吞掉）。
// 修法的安全性完全建立在"能不能证明这一行还是我们发的那一版"上，所以判据要逐条钉死。
group('内置提示词更新决策（批 8 补 28）');
{
  const D = [{ key: 'k', content: '新版内容', system: '新 system', builtin_version: 2 }];
  const dg = story.digestText;
  const plan = (stored, opts) => seed.planTemplateSync(stored, D, opts || {});
  // 同样"要红得干净"：keep[0] 取不到就给 {}（整段判定被反过来时，直接取字段会让自检崩掉）
  const kept = (stored, opts) => plan(stored, opts).keep[0] || {};

  eq('库里没有这个 key → 新增', plan([]).insert.length, 1);
  eq('内容与新版一致 → 不更新（也算没被改过）', kept([{ key: 'k', content: '新版内容', is_builtin: true }]).reason, 'same');
  eq('老库（没有 digest 字段）+ 历史指纹命中 → 更新',
    plan([{ key: 'k', content: '旧版内容', is_builtin: true }], { superseded: { k: [dg('旧版内容')] } }).update.length, 1);
  eq('行上 builtin_digest 自证没被改过 → 更新',
    plan([{ key: 'k', content: '旧版内容', is_builtin: true, builtin_digest: dg('旧版内容') }]).update.length, 1);
  eq('证明不了"还是官方那一版" → 保留（宁可漏更新，也不覆盖人的劳动）',
    kept([{ key: 'k', content: '用户自己改的', is_builtin: true }]).reason, 'edited');
  eq('用户把它改成自定义模板（is_builtin=false）→ 保留',
    kept([{ key: 'k', content: '旧版内容', is_builtin: false }]).reason, 'custom');
  eq('保留的项要点名（启动日志要如实说"为什么没更新"）',
    (kept([{ key: 'k', content: '用户自己改的', is_builtin: true }]).def || {}).key, 'k');
  // 正对照 FG 把这条判据反过来（证明不了也更新），下面这行必须变红
  eq('指纹对不上时**绝不**更新（这条是整段逻辑的安全底线）',
    plan([{ key: 'k', content: '用户自己改的', is_builtin: true, builtin_digest: 'deadbeef' }]).update.length, 0);

  // 棘轮：版本号与历史指纹表必须自洽，否则"改了提示词但忘了 bump/登记"会让老用户永远收不到
  ok('每个内置模板都带整数 builtin_version ≥ 1',
    seed.DEFAULT_TEMPLATES.every((t) => Number.isInteger(t.builtin_version || 1) && (t.builtin_version || 1) >= 1));
  ok('历史指纹表里的 key 都是真实存在的内置模板',
    Object.keys(seed.TEMPLATE_SUPERSEDED).every((k) => seed.DEFAULT_TEMPLATES.some((t) => t.key === k)));
  ok('历史指纹不能等于当前内容指纹（否则这条登记是废话，说明改完没更新它）',
    Object.entries(seed.TEMPLATE_SUPERSEDED).every(([k, list]) => {
      const t = seed.DEFAULT_TEMPLATES.find((x) => x.key === k);
      return list.every((h) => h !== dg(t.content));
    }));
  ok('改了提示词的模板版本要 > 1（本次改了 novel_extract / story_bible 的 involved 写法）',
    ['novel_extract', 'story_bible'].every((k) => (seed.DEFAULT_TEMPLATES.find((t) => t.key === k).builtin_version || 1) > 1));
  // 补记指纹（stamped）：内容已等于官方默认、行上却没有指纹的行要顺手补记，
  // 否则将来真改了这些提示词时，它们会被判成"用户改过"而**永不更新**（只会在下一轮才炸的陷阱）
  {
    // 必须用**真实的**内置 key：seedTemplates 只走 DEFAULT_TEMPLATES 里的那 16 个，
    // 造一个虚构 key 的行它根本不会访问（第一版就这么写错了，断言直接红）
    store._resetForTest(); // 与本文件既有的播种组同一写法（这个 block 在文件末尾，不会影响别的组）
    const st = store;
    const SAME = seed.DEFAULT_TEMPLATES.find((t) => t.key === 'story_concept');
    st.insert('prompt_templates', { key: 'story_concept', content: SAME.content, is_builtin: true }); // 内容对、无指纹
    st.insert('prompt_templates', { key: 'novel_extract', content: '用户改过的', is_builtin: true }); // 用户改过
    const r = seed.seedTemplates(st);
    const k = st.list('prompt_templates').find((x) => x.key === 'story_concept');
    const e = st.list('prompt_templates').find((x) => x.key === 'novel_extract');
    eq('内容已等于官方默认 → 补记指纹（下次才能自证）', k.builtin_digest, story.digestText(SAME.content));
    eq('补记数量如实返回', r.stamped, 1);
    eq('补记**不动内容**（只是登记事实）', k.content, SAME.content);
    eq('补记也补版本号（下次判据要一起用）', k.builtin_version, SAME.builtin_version || 1);
    eq('用户改过的行**绝不补记**（补记 = 把用户的内容登记成官方版 → 下次就会被覆盖）', e.builtin_digest, undefined);
    eq('其余没提到的内置模板照旧新增', st.list('prompt_templates').length, 16);
  }

  ok('两个抽取提示词都写明了 involved 只写本名、顿号分隔、不写泛称',
    ['novel_extract', 'story_bible'].every((k) => /involved/.test(seed.DEFAULT_TEMPLATES.find((t) => t.key === k).content)
      && /本名/.test(seed.DEFAULT_TEMPLATES.find((t) => t.key === k).content)));
}

// ══════════════════════════════════════════════════════════════
// 批 8 补 28：剧情卡人物闭环体检（involved 里的人在人物卡/角色库里找不到）
// ══════════════════════════════════════════════════════════════
// `involved` 一直被抽出来、也一直显示在分集大纲里（"涉及：…"），却**从来没人核对过这些名字是否存在**。
// 于是"剧情里有这个人、却没有他的卡与档案"可以一路静默传到剧本：剧本会写到他、分镜里他会出场，
// 而外貌注入/绑定/参考图全落不到他身上 —— 同一个角色在不同镜头里换脸，链路上没有任何报错。
group('剧情卡人物闭环体检（批 8 补 28）');
{
  const chars = [{ id: 'c1', kind: 'character', name: '林晚', aliases: ['阿晚'] }];
  const lib = [{ id: 'x1', name: '顾寒' }];
  const plot = (involved, id = 'p1', name = '夜访') => ({ id, kind: 'plot', name, involved, project_id: 'P', source_id: 'S' });
  const run = (cards, characters = lib) => story.auditPlotCast(cards, { characters });
  // 取第一条问题，取不到就给 {}：**断言要红得干净**。直接写 issues[0].x 的话，
  // 一旦体检被破坏（比如整段不查了），selftest 会以 TypeError 崩掉并中止整轮 ——
  // 那时你看不出"是哪几条钉在管这件事"，只看到一个栈（对照 IA 真踩到）。
  const one = (cards, characters = lib) => run(cards, characters).issues[0] || {};

  eq('人物卡里的名字 → 不报', run([...chars, plot('林晚')]).issues.length, 0);
  eq('人物卡的**别名**也认（阿晚）', run([...chars, plot('阿晚')]).issues.length, 0);
  eq('角色库里的名字也认（人物卡还没建、但档案已有）', run([plot('顾寒')]).issues.length, 0);
  eq('多个人名用顿号分隔 → 逐个核（林晚有卡、苏婉儿没有 → 只报后者）',
    run([...chars, plot('林晚、苏婉儿')]).issues.length, 1);
  eq('报出来的就是那个找不到的名字', one([...chars, plot('林晚、苏婉儿')]).target_name, '苏婉儿');
  // 卡片侧**故意**比镜头侧宽松：involved 是模型自由写的，带修饰的写法不该被刷成假警报
  eq('词里包含已知名字 → 视为已知（"顾寒的对峙"不报）', run([plot('顾寒的对峙')]).issues.length, 0);
  eq('泛称不进判定（"众人""两人"）', run([...chars, plot('众人、两人、林晚')]).issues.length, 0);
  eq('空 involved → 不报（没写不等于写错）', run([plot('')]).issues.length, 0);
  eq('同一张卡提到两次只算一次', (one([plot('苏婉儿、苏婉儿')]).card_ids || []).length, 1);
  // 聚合：一个不存在的名字常被好几张剧情卡提到，逐卡报会在面板里刷屏
  const agg = run([plot('苏婉儿', 'p1', '夜访'), plot('苏婉儿', 'p2', '对峙'), plot('苏婉儿', 'p3', '和好')]);
  eq('按**名字**聚合而不是按卡逐条报（三张卡提到 → 一条）', agg.issues.length, 1);
  const a1 = agg.issues[0] || {};
  eq('聚合项如实报出被几张卡提到', (a1.card_ids || []).length, 3);
  eq('聚合项如实列出涉及的卡名', (a1.cards || []).map((c) => c.name).join(','), '夜访,对峙,和好');
  eq('说明里带出涉及哪几张卡（只说"3 张"用户还得自己找）',
    /涉及：「夜访」、「对峙」、「和好」/.test(a1.detail || ''), true);
  eq('级别是 info 不是 warn（找不到 ≠ 错：可能是没抽到、可能是路人）', a1.level, 'info');
  eq('不标可一键修复（改名还是补卡要人定）', a1.fixable, false);
  eq('体检给出口：直达第一张涉及的剧情卡（原著页要 source_id 才载卡片）',
    `${(a1.go || {}).page}|${((a1.go || {}).params || {}).source_id}|${((a1.go || {}).params || {}).card_id}|${((a1.go || {}).params || {}).kind}`,
    'novel|S|p1|plot');
  eq('计数：全按 info 计，不计入 warn', `${agg.counts.warn}/${agg.counts.info}`, '0/1');
  eq('扫过的剧情卡数如实报出', run([plot('苏婉儿'), { id: 'c', kind: 'character', name: '林晚' }]).scanned, 1);
  // 近似候选只在"互为子串"时给：能一眼解释清楚，不去猜拼音/编辑距离
  const near = run([plot('苏婉')], [{ id: 'x', name: '苏婉儿' }]);
  eq('写简称而库里有全名 → 报，并给出最接近的候选', ((near.issues[0] || {}).near_names || []).join(','), '苏婉儿');
  eq('候选写进说明里（用户不用自己去猜是哪个角色）', /名字最接近的已有角色是：「苏婉儿」/.test((near.issues[0] || {}).detail || ''), true);
  eq('毫无关系的名字不给候选（假建议比没建议更糟）', (one([plot('陌生名')]).near_names || []).length, 0);
  // 与镜头侧的分工：卡片侧早一步、更便宜；这条钉住"它确实比 shot_char_unknown 更早发现"
  eq('还没生成任何分镜时就能发现（镜头侧要等分镜生成完）', run([plot('苏婉儿')]).issues.length, 1);
}

console.log(`\n${'═'.repeat(52)}`);
console.log(`  自检结果：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('  失败项：');
  failures.forEach((f) => console.log(`   ✗ ${f}`));
}
console.log(`${'═'.repeat(52)}\n`);
process.exit(fail ? 1 : 0);
