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
  ok('全量导出含 8 张表', Object.keys(all.collections).length === 8, Object.keys(all.collections).join(','));

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

console.log(`\n${'═'.repeat(52)}`);
console.log(`  自检结果：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('  失败项：');
  failures.forEach((f) => console.log(`   ✗ ${f}`));
}
console.log(`${'═'.repeat(52)}\n`);
process.exit(fail ? 1 : 0);
