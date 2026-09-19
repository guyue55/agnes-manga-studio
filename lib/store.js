/**
 * store.js — 本地 JSON 数据层
 * ------------------------------------------------------------------
 * 原版本地版之前跑在 Supabase（云端 Postgres + RLS + user_id 隔离）。
 * 这里整个换成单机 JSON 文件：
 *   · 没有用户系统 → 所有 user_id 字段消失，数据天然属于这台机器
 *   · 写入走「临时文件 + rename」的原子替换，中途断电不会留下半个文件
 *   · 每次写盘顺带留一个 .bak，遇到损坏能自动回滚到上一版
 *
 * 集合（collection）沿用原库表名，方便老用户从云端导出后直接导入：
 *   projects / scripts / storyboards / characters / image_assets / video_assets
 *   generation_tasks / prompt_templates / video_submit_logs
 * characters 是本项目自加的集合（原云端库没有）：角色档案是"跨镜头一致长相"的锚点，
 * 与分镜的关系是多对多，塞进 storyboards.characters 自由文本里无法复用也无法引用。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const COLLECTIONS = [
  'projects',
  'scripts',
  'storyboards',
  'characters',
  'image_assets',
  'video_assets',
  'generation_tasks',
  'prompt_templates',
  'video_submit_logs',
  // 批 8：原著解析。source 是"用户粘贴/上传的原文"，必须落库——
  // 04 号竞品零草稿持久化，刷新一次 1 万字就没了（研读报告 §3.4 点名的最大缺陷）。
  'story_sources',
  // 抽取出来的卡片（信息卡/人物卡/地点卡/道具卡/剧情卡/时间线）统一一张表 + kind 判别列：
  // 六张同构小表只会把"按类取、按类渲染、按类删"写六遍，加一类还要动 schema。
  'story_cards',
];

const EMPTY = () => ({
  projects: [],
  scripts: [],
  storyboards: [],
  characters: [],
  image_assets: [],
  video_assets: [],
  generation_tasks: [],
  prompt_templates: [],
  video_submit_logs: [],
  story_sources: [],
  story_cards: [],
});

let APP_HOME = process.cwd();
let DB_PATH = null;
let SETTINGS_PATH = null;
let MODELS_PATH = null;
let MEM = null;
let SETTINGS = null;
let MODEL_CACHE = null;
let writeQueue = Promise.resolve();

// ── id / 时间 ────────────────────────────────────────────────
let seq = 0;
function uid(prefix = 'id') {
  seq = (seq + 1) % 46656;
  const t = Date.now().toString(36);
  const r = seq.toString(36).padStart(3, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${t}${r}${rand}`;
}
const now = () => new Date().toISOString();

// ── 原子写 ───────────────────────────────────────────────────
let fsyncMisses = 0; // H3：fsync 真失败次数（selftest 断言其为 0，防死代码假修复）
function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  // B4/H3：落盘后 fsync，掉电时"返回成功的那次写"才真的稳（仅靠 rename 不保证）。
  // 上一版 flags 误写 'fs'（Node 不认）导致 openSync 必抛被吞 = fsync 从未生效；
  // 现用 'r' 真打开，失败计数导出给 selftest 断言，防"假修复"回潮。
  try {
    const fd = fs.openSync(tmp, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (e) {
    fsyncMisses++;
    failWrite(`fsync ${path.basename(file)}`, e);
  }
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  } catch { /* 备份失败不影响主流程 */ }
  fs.renameSync(tmp, file);
}

// B4 防护：写盘失败过去被 .catch(() => {}) 全静默——磁盘满/权限坏时
// API 照回"成功"但从未持久。现在经 onWriteError 钩子上报（server.js 接 console + 任务中心日志）。
let writeErrorHandler = (where, e) => console.error(`[store] ${where} 写盘失败：`, e && e.message || e);
function onWriteError(fn) { writeErrorHandler = fn; }
function failWrite(where, e) {
  try { writeErrorHandler(where, e); } catch { /* 处理器本身坏了不许拖垮写队列 */ }
}

function readJson(file, fallback, rep = {}) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (e) {
    rep.broken = true; // 主文件解析失败（存在但坏，或语法非对象）
    // 主文件坏了，试上一版备份
    try {
      const bak = fs.readFileSync(`${file}.bak`, 'utf8');
      const parsed = JSON.parse(bak);
      if (parsed && typeof parsed === 'object') { rep.recovered = true; return parsed; }
    } catch { /* 备份也坏了，用空库 */ }
    return fallback;
  }
}

/** 灾备自愈：从 .bak 恢复或降级空库后，坏主文件先归档留证，再把好状态双写回 main+bak，
 *  否则第一次 persist 会把"坏主文件"复制进 .bak——最后一份好备份被坏数据覆盖，恢复链自毁。 */
function rescueFile(file, goodObj) {
  try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* 原文件可能不存在（首启），无证据可存 */ }
  try {
    writeJsonAtomic(file, goodObj);
    fs.copyFileSync(file, `${file}.bak`); // 用刚写好的合法内容覆正备份位
  } catch (e) { failWrite(`灾备回写 ${path.basename(file)}`, e); }
}

// ── 初始化 ───────────────────────────────────────────────────
function init(home) {
  APP_HOME = home;
  DB_PATH = path.join(home, 'db.json');
  SETTINGS_PATH = path.join(home, 'settings.json');
  MODELS_PATH = path.join(home, 'models.json');
  fs.mkdirSync(home, { recursive: true });
  const dbRep = {};
  const dbObj = readJson(DB_PATH, null, dbRep);
  MEM = dbObj || EMPTY();
  for (const c of COLLECTIONS) if (!Array.isArray(MEM[c])) MEM[c] = [];
  if (dbRep.broken && fs.existsSync(DB_PATH)) rescueFile(DB_PATH, MEM);
  const stRep = {};
  SETTINGS = readJson(SETTINGS_PATH, null, stRep) || {};
  if (stRep.broken && fs.existsSync(SETTINGS_PATH)) rescueFile(SETTINGS_PATH, SETTINGS);
  MODEL_CACHE = readJson(MODELS_PATH, null) || { version: 1, updated_at: null, source: 'fallback', models: [] };
  if (!Array.isArray(MODEL_CACHE.models)) MODEL_CACHE.models = [];
  return { db: MEM, settings: SETTINGS, models: MODEL_CACHE };
}

function home() { return APP_HOME; }
function assetsDir() { return path.join(APP_HOME, 'assets'); }
function imagesDir() { return path.join(APP_HOME, 'assets', 'images'); }
function videosDir() { return path.join(APP_HOME, 'assets', 'videos'); }
function exportsDir() { return path.join(APP_HOME, 'exports'); }

/** 串行化写盘，避免并发请求互相覆盖 */
function persist() {
  writeQueue = writeQueue.then(() => {
    writeJsonAtomic(DB_PATH, MEM);
  }).catch((e) => failWrite('数据库 db.json', e));
  return writeQueue;
}

function persistSettings() {
  writeQueue = writeQueue.then(() => {
    writeJsonAtomic(SETTINGS_PATH, SETTINGS);
  }).catch((e) => failWrite('设置 settings.json', e));
  return writeQueue;
}

// ── 集合操作 ─────────────────────────────────────────────────
function assertColl(coll) {
  if (!COLLECTIONS.includes(coll)) throw new Error(`未知集合: ${coll}`);
  if (!MEM) throw new Error('store 尚未 init');
}

function list(coll, opts = {}) {
  assertColl(coll);
  let rows = MEM[coll].slice();
  if (typeof opts.filter === 'function') rows = rows.filter(opts.filter);
  if (typeof opts.sort === 'function') rows.sort(opts.sort);
  else rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  if (opts.limit) rows = rows.slice(0, opts.limit);
  return rows;
}

function get(coll, id) {
  assertColl(coll);
  return MEM[coll].find((r) => r.id === id) || null;
}

function insert(coll, row) {
  assertColl(coll);
  const full = Object.assign({}, row);
  if (!full.id) full.id = uid(coll.replace(/s$/, '').slice(0, 8));
  if (!full.created_at) full.created_at = now();
  if (!('updated_at' in full) && coll !== 'image_assets' && coll !== 'video_assets'
      && coll !== 'generation_tasks' && coll !== 'video_submit_logs') {
    full.updated_at = now();
  }
  MEM[coll].unshift(full);
  persist();
  return full;
}

function insertMany(coll, rows) {
  assertColl(coll);
  const out = rows.map((row) => {
    const full = Object.assign({}, row);
    if (!full.id) full.id = uid(coll.replace(/s$/, '').slice(0, 8));
    if (!full.created_at) full.created_at = now();
    return full;
  });
  MEM[coll] = out.concat(MEM[coll]);
  persist();
  return out;
}

function update(coll, id, patch) {
  assertColl(coll);
  const idx = MEM[coll].findIndex((r) => r.id === id);
  if (idx < 0) return null;
  const merged = Object.assign({}, MEM[coll][idx], patch);
  if ('updated_at' in MEM[coll][idx]) merged.updated_at = now();
  MEM[coll][idx] = merged;
  persist();
  return merged;
}

function remove(coll, id) {
  assertColl(coll);
  const before = MEM[coll].length;
  MEM[coll] = MEM[coll].filter((r) => r.id !== id);
  persist();
  return MEM[coll].length < before;
}

function removeWhere(coll, filterFn) {
  assertColl(coll);
  const before = MEM[coll].length;
  MEM[coll] = MEM[coll].filter((r) => !filterFn(r));
  persist();
  return before - MEM[coll].length;
}

function count(coll, filterFn) {
  assertColl(coll);
  return filterFn ? MEM[coll].filter(filterFn).length : MEM[coll].length;
}

// ── 设置 ─────────────────────────────────────────────────────
const SETTING_DEFAULTS = {
  agnes_api_base_url: 'https://apihub.agnes-ai.com/v1',
  agnes_api_key: '',
  default_text_model: 'agnes-2.0-flash',
  default_image_model: 'agnes-image-2.1-flash',
  default_video_model: 'agnes-video-v2.0',
  video_poll_interval: '8',
  video_max_polls: '60',
  // 提交遇到免费档限流/排队满（429/503 等）时的自动重试：次数与基础退避秒数（指数增长，封顶 60s）。
  // 默认 8 次 ≈ 最长 4.5 分钟/条：免费档高峰期排队窗口实测可超 1 分钟
  video_submit_retries: '8',
  video_submit_backoff_s: '3',
  default_concurrent_tasks: '3',
  auto_download_video: '0',
  request_timeout_ms: '150000',
  model_cache_ttl_hours: '24',
  auto_refresh_models: '1',
};

function getSettings() {
  const out = {};
  for (const [k, v] of Object.entries(SETTING_DEFAULTS)) out[k] = SETTINGS[k] != null ? SETTINGS[k] : v;
  return out;
}

/** 返回给前端的设置：API Key 永远只给脱敏值 */
function getSettingsMasked() {
  const s = getSettings();
  const key = String(s.agnes_api_key || '');
  return Object.assign({}, s, {
    agnes_api_key: key ? '***configured***' : '',
    agnes_api_key_masked: maskKey(key),
  });
}

function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return k.slice(0, 2) + '****';
  return `${k.slice(0, 4)}****${k.slice(-4)}`;
}

function setSettings(patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in SETTING_DEFAULTS)) continue;
    // B11：null/undefined 落到该键默认值。旧写法 String(null)='null' 会伪装成"有效值"
    //（例如 agnes_api_key='null' → 全站发 Bearer null 且界面显示"已配置"）。
    let s = String(v === null || v === undefined ? SETTING_DEFAULTS[k] : v);
    // E8：数字型设置在唯一写入口钳进合法区间并规范为纯数字串，
    // 保证"界面显示值 == 实际生效值"（旧法存 '0'/'-5'，消费端各自兜底 → 显示≠生效）。
    const range = NUMERIC_SETTINGS[k];
    if (range) {
      const n = Number(s);
      s = String(Number.isFinite(n) ? Math.min(range[1], Math.max(range[0], n)) : Number(SETTING_DEFAULTS[k]));
    }
    SETTINGS[k] = s;
  }
  persistSettings();
  return getSettings();
}

// E8：数字型设置的合法闭区间 [min, max]，与消费端语义对齐（poller 间隔下限 2s 等）。
const NUMERIC_SETTINGS = {
  video_poll_interval: [2, 3600],
  video_max_polls: [1, 10000],
  video_submit_retries: [0, 30],
  video_submit_backoff_s: [1, 60],
  default_concurrent_tasks: [1, 8],
  request_timeout_ms: [10000, 600000],
  model_cache_ttl_hours: [1, 168],
};

function getRawKey() { return String(SETTINGS.agnes_api_key || ''); }

// ── 动态模型目录 ─────────────────────────────────────────────
/**
 * 只把 Agnes 返回的公开模型元数据存本机，不保存请求头/API Key。
 * models.json 是独立文件，升级程序不会覆盖用户已经拉取到的模型清单。
 */
function normalizeModel(item) {
  const raw = typeof item === 'string' ? { id: item } : (item && typeof item === 'object' ? item : {});
  const id = String(raw.id || raw.name || raw.model || '').trim();
  if (!id) return null;
  const caps = raw.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : {};
  const modalities = Array.isArray(raw.modalities) ? raw.modalities.map(String) : [];
  const haystack = [id, raw.name, raw.owned_by, raw.type, raw.object, ...modalities, ...Object.keys(caps)]
    .filter(Boolean).join(' ').toLowerCase();
  let kind = String(raw.kind || raw.model_type || '').toLowerCase();
  if (!['text', 'image', 'video', 'unknown'].includes(kind)) {
    if (/video|animate|motion|wan|kling|sora/.test(haystack)) kind = 'video';
    else if (/image|vision|dall|flux|sdxl|seedream|画|图/.test(haystack)) kind = 'image';
    else if (/text|chat|completion|gpt|claude|qwen|deepseek|llama|豆包/.test(haystack)) kind = 'text';
    else kind = 'unknown';
  }
  return {
    id,
    name: String(raw.name || id),
    kind,
    owned_by: String(raw.owned_by || raw.provider || ''),
    capabilities: caps,
    modalities,
  };
}

function normalizeModels(payload) {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.models) ? payload.models
        : Array.isArray(payload?.items) ? payload.items : [];
  const out = [];
  const seen = new Set();
  for (const item of source) {
    const model = normalizeModel(item);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function getModels() {
  return {
    version: MODEL_CACHE?.version || 1,
    updated_at: MODEL_CACHE?.updated_at || null,
    source: MODEL_CACHE?.source || 'fallback',
    error: MODEL_CACHE?.error || '',
    models: Array.isArray(MODEL_CACHE?.models) ? MODEL_CACHE.models.slice() : [],
  };
}

function setModels(payload, meta = {}) {
  const models = normalizeModels(payload);
  MODEL_CACHE = {
    version: 1,
    updated_at: meta.updated_at || now(),
    source: meta.source || 'agnes',
    error: meta.error || '',
    models,
  };
  writeQueue = writeQueue.then(() => writeJsonAtomic(MODELS_PATH, MODEL_CACHE)).catch((e) => failWrite("模型目录 models.json", e));
  return getModels();
}

function setModelCacheError(error) {
  MODEL_CACHE = Object.assign({}, MODEL_CACHE || {}, {
    version: 1,
    error: String(error || '模型拉取失败'),
  });
  writeQueue = writeQueue.then(() => writeJsonAtomic(MODELS_PATH, MODEL_CACHE)).catch((e) => failWrite("模型目录 models.json", e));
  return getModels();
}

function modelsNeedRefresh() {
  const s = getSettings();
  if (s.auto_refresh_models !== '1') return false;
  if (!MODEL_CACHE?.updated_at || !MODEL_CACHE.models?.length) return true;
  const ttl = Math.max(1, Number(s.model_cache_ttl_hours) || 24) * 3600000;
  const updated = new Date(MODEL_CACHE.updated_at).getTime();
  if (!Number.isFinite(updated)) return true;
  return Date.now() - updated > ttl;
}

// ── 全量导入导出 ─────────────────────────────────────────────
function exportAll() {
  return { version: 1, exported_at: now(), collections: MEM };
}

/** H4：导入行的 local_file 与 POST /api/images 同规则——只认本库素材根目录。
 *  不清洗的话，"导入别人给的备份包"就能埋一条越界路径，DELETE 时以本服务身份删任意文件。 */
function sanitizeImportedRow(c, row) {
  if ((c === 'image_assets' || c === 'video_assets') && 'local_file' in row) {
    const s = typeof row.local_file === 'string' ? row.local_file.trim() : '';
    let okPath = '';
    if (s && path.isAbsolute(s)) {
      const norm = path.normalize(s);
      for (const root of [imagesDir(), videosDir()]) {
        const r = path.normalize(root);
        if (norm === r || norm.startsWith(r + path.sep)) { okPath = norm; break; }
      }
    }
    row.local_file = okPath; // 越界/非绝对 → 丢弃为 ''（记录保留，只丢指针）
  }
  return row;
}

function importAll(payload, mode = 'merge') {
  if (!payload || typeof payload !== 'object') throw new Error('导入数据格式错误');
  const src = payload.collections || payload;
  // H4：两遍法——先把所有集合校验+清洗进新数组，任何一行坏都不碰在用的 MEM。
  // 旧 replace 是"边写边炸"：中途异常时前面的表已被整体覆盖且 persist 落盘，坏行让全站永久 500。
  const staged = {};
  let skipped = 0;
  for (const c of COLLECTIONS) {
    const incoming = Array.isArray(src[c]) ? src[c] : [];
    const clean = [];
    for (const row of incoming) {
      // B5/H4（merge+replace 统一）：无 id 或非法行跳过——不可寻址的僵尸行/ null 行都不许进 MEM
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id) { skipped++; continue; }
      clean.push(sanitizeImportedRow(c, { ...row }));
    }
    staged[c] = clean;
  }
  let added = 0;
  for (const c of COLLECTIONS) {
    if (mode === 'replace') {
      // 整表替换：备份里没有的集合也要清空 —— 设置页「清空全部数据」
      // 传的就是空 collections，旧写法 continue 会静默什么都不清
      MEM[c] = staged[c];
      added += staged[c].length;
    } else {
      if (!Array.isArray(src[c])) continue;
      const existing = new Set(MEM[c].map((r) => r.id));
      for (const row of staged[c]) {
        if (existing.has(row.id)) continue;
        MEM[c].push(row);
        added++;
      }
    }
  }
  persist();
  return { added, skipped };
}

/** 单个项目及其全部关联数据，用于「导出资料」 */
function exportProject(projectId) {
  const project = get('projects', projectId);
  if (!project) return null;
  return {
    version: 1,
    exported_at: now(),
    project,
    scripts: list('scripts', { filter: (r) => r.project_id === projectId }),
    storyboards: list('storyboards', {
      filter: (r) => r.project_id === projectId,
      sort: (a, b) => (a.episode_number - b.episode_number) || (a.sort_order - b.sort_order),
    }),
    image_assets: list('image_assets', { filter: (r) => r.project_id === projectId }),
    video_assets: list('video_assets', { filter: (r) => r.project_id === projectId }),
    generation_tasks: list('generation_tasks', { filter: (r) => r.project_id === projectId }),
    // 批 8：原著解析属于项目资料 —— 导出项目时必须带上，
    // 否则换台机器导入后"卡片还在但原文没了"，卡片就成了无法核对的孤儿
    story_sources: list('story_sources', { filter: (r) => r.project_id === projectId }),
    story_cards: list('story_cards', { filter: (r) => r.project_id === projectId }),
  };
}

function stats() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString();
  const projects = MEM.projects;
  const inFlight = (v) => ['queued', 'in_progress', 'remote_submitted'].includes(v.status)
    || ['polling', 'remote_submitted'].includes(v.local_status);
  return {
    total_projects: projects.length,
    active_projects: projects.filter((p) => p.status === 'active').length,
    today_images: MEM.image_assets.filter((i) => (i.created_at || '') >= todayStr).length,
    today_videos: MEM.video_assets.filter((v) => (v.created_at || '') >= todayStr).length,
    failed_tasks: MEM.generation_tasks.filter((t) => t.status === 'failed').length
      + MEM.video_assets.filter((v) => v.status === 'failed' || v.local_status === 'submit_failed').length,
    favorited_assets: MEM.image_assets.filter((i) => i.is_favorited).length
      + MEM.video_assets.filter((v) => v.is_favorited).length,
    total_storyboards: MEM.storyboards.length,
    running_videos: MEM.video_assets.filter(inFlight).length,
  };
}

/** 测试用：把内存恢复到干净状态（不写盘，除非调用 persist） */
function _resetForTest() {
  MEM = EMPTY();
  SETTINGS = {};
  MODEL_CACHE = { version: 1, updated_at: null, source: 'fallback', models: [] };
}

module.exports = {
  COLLECTIONS,
  init, home, assetsDir, imagesDir, videosDir, exportsDir,
  uid, now, onWriteError,
  list, get, insert, insertMany, update, remove, removeWhere, count,
  getSettings, getSettingsMasked, setSettings, getRawKey, maskKey, SETTING_DEFAULTS,
  getModels, setModels, setModelCacheError, normalizeModels, normalizeModel, modelsNeedRefresh,
  exportAll, importAll, exportProject, stats, persist,
  get fsyncMisses() { return fsyncMisses; },
  _resetForTest,
  get db() { return MEM; },
};
