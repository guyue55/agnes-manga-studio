/**
 * api.js — 后端接口封装
 * 统一把 HTTP 错误、业务 ok:false 都收敛成 {ok, data, error, errorType}，页面里不用层层 try。
 */
import { formatError } from './consts.js';

/**
 * 请求超时分级（毫秒）。为什么需要：后端有超时，前端**没有**——后端进程挂住/重启时
 * fetch 可以永久挂起，`setBusy` 的秒表就会一直转，用户以为"还在生成"。
 * 生成类必须比后端超时更宽（文本/图片 120s、视频提交含退避重试最长约 4.5 分钟），
 * 否则前端先放弃、后端还在跑，用户会以为失败而重复提交（= 重复计费）。
 */
const TIMEOUT = {
  quick: 10000,    // 健康检查：本地调用，慢就是有问题
  normal: 30000,   // 普通读写
  gen: 180000,     // 文本/图片生成、模型目录拉取
  submit: 600000,  // 视频提交/下载（后端含 429/503 指数退避重试）
};

/**
 * 把后端给的失败追踪码拼进错误文案（R10）。拼在**文案里**而不是只挂在返回对象上：
 * 页面里几十处 `toast.err(r.error)` 无需逐处改造就能带上码，用户看到的每一句报错都可追溯。
 */
function withTrace(msg, trace) {
  return trace ? `${msg}（报错码 ${trace}）` : msg;
}

async function req(method, url, body, opts = {}) {
  const timeoutMs = opts.timeoutMs || TIMEOUT.normal;
  const o = { method, headers: {} };
  if (body !== undefined) {
    o.headers['Content-Type'] = 'application/json';
    o.body = JSON.stringify(body);
  }
  // 超时只终止"这一次等待"，不终止服务端任务：文案必须说清"可能仍在后台跑"，
  // 否则用户会把"前端超时"当成"任务失败"而重复提交。
  if (timeoutMs > 0) o.signal = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(url, o);
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return timedOut
      ? { ok: false, errorType: 'client_timeout', error: formatError('client_timeout', `等待本地服务响应超过 ${Math.round(timeoutMs / 1000)}s`) }
      : { ok: false, errorType: 'local_service_down', error: `无法连接到本地服务：${e.message}` };
  }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const et = data?.errorType;
    return { ok: false, errorType: et, status: res.status, trace: data?.trace, error: withTrace(formatError(et, data?.error || `请求失败（HTTP ${res.status}）`), data?.trace) };
  }
  if (data && data.ok === false) {
    return { ok: false, errorType: data.errorType, trace: data?.trace, error: withTrace(formatError(data.errorType, data.error || '操作失败'), data?.trace), data };
  }
  return { ok: true, data };
}

export const api = {
  health: () => req('GET', '/api/health', undefined, { timeoutMs: TIMEOUT.quick }),
  bootstrap: () => req('GET', '/api/bootstrap'),
  stats: () => req('GET', '/api/stats'),

  settings: () => req('GET', '/api/settings'),
  models: () => req('GET', '/api/models'),
  refreshModels: () => req('POST', '/api/models/refresh', {}, { timeoutMs: TIMEOUT.gen }),
  saveSettings: (patch) => req('PUT', '/api/settings', patch),
  testSettings: (kind) => req('POST', '/api/settings/test', { kind }, { timeoutMs: TIMEOUT.gen }),

  // R29：withCounts 让服务端把三个计数一起算好，省掉项目页额外三次全量列表拉取。
  // 不传时响应与以前完全一致（裸数组、无 counts 字段）——见 lib/routes.js 的变更须知。
  projects: (opts = {}) => req('GET', opts.withCounts ? '/api/projects?with_counts=1' : '/api/projects'),
  createProject: (p) => req('POST', '/api/projects', p),
  updateProject: (id, p) => req('PUT', `/api/projects/${id}`, p),
  deleteProject: (id, cascade) => req('DELETE', `/api/projects/${id}`, { cascade }),
  duplicateProject: (id) => req('POST', `/api/projects/${id}/duplicate`, {}),

  scripts: (projectId) => req('GET', `/api/scripts${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`),
  createScript: (s) => req('POST', '/api/scripts', s),
  updateScript: (id, s) => req('PUT', `/api/scripts/${id}`, s),
  deleteScript: (id) => req('DELETE', `/api/scripts/${id}`),

  storyboards: (projectId, episode) => {
    const q = [];
    if (projectId) q.push(`project_id=${encodeURIComponent(projectId)}`);
    if (episode != null) q.push(`episode=${episode}`);
    return req('GET', `/api/storyboards${q.length ? `?${q.join('&')}` : ''}`);
  },
  createStoryboard: (s) => req('POST', '/api/storyboards', s),
  createStoryboards: (rows) => req('POST', '/api/storyboards', { rows }),
  updateStoryboard: (id, s) => req('PUT', `/api/storyboards/${id}`, s),
  deleteStoryboard: (id) => req('DELETE', `/api/storyboards/${id}`),
  reorderStoryboards: (ids) => req('POST', '/api/storyboards/reorder', { ids }),
  clearStoryboards: (projectId, episode) => req('DELETE', `/api/storyboards?project_id=${encodeURIComponent(projectId)}&episode=${episode}`),

  images: (projectId) => req('GET', `/api/images${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`),
  createImage: (a) => req('POST', '/api/images', a),
  updateImage: (id, a) => req('PUT', `/api/images/${id}`, a),
  deleteImage: (id) => req('DELETE', `/api/images/${id}`),
  genImage: (p) => req('POST', '/api/agnes/image', p, { timeoutMs: TIMEOUT.gen }),

  videos: (projectId) => req('GET', `/api/videos${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`),
  updateVideo: (id, v) => req('PUT', `/api/videos/${id}`, v),
  deleteVideo: (id) => req('DELETE', `/api/videos/${id}`),
  createVideo: (v) => req('POST', '/api/videos', v, { timeoutMs: TIMEOUT.submit }),
  refreshVideo: (id) => req('POST', `/api/videos/${id}/refresh`, {}),
  bindVideo: (id, videoId) => req('POST', `/api/videos/${id}/bind`, { video_id: videoId }),
  downloadVideo: (id) => req('POST', `/api/videos/${id}/download`, {}, { timeoutMs: TIMEOUT.submit }),
  batchRefreshVideos: () => req('POST', '/api/videos/batch-refresh', {}),

  tasks: (type) => req('GET', `/api/tasks${type ? `?task_type=${type}` : ''}`),
  createTask: (t) => req('POST', '/api/tasks', t),
  updateTask: (id, t) => req('PUT', `/api/tasks/${id}`, t),
  deleteTask: (id) => req('DELETE', `/api/tasks/${id}`),

  characters: (projectId) => req('GET', `/api/characters${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`),
  createCharacter: (c) => req('POST', '/api/characters', c),
  updateCharacter: (id, c) => req('PUT', `/api/characters/${id}`, c),
  deleteCharacter: (id) => req('DELETE', `/api/characters/${id}`),
  templates: (type) => req('GET', `/api/templates${type ? `?template_type=${type}` : ''}`),
  createTemplate: (t) => req('POST', '/api/templates', t),
  updateTemplate: (id, t) => req('PUT', `/api/templates/${id}`, t),
  deleteTemplate: (id) => req('DELETE', `/api/templates/${id}`),

  genText: (p) => req('POST', '/api/agnes/text', p, { timeoutMs: TIMEOUT.gen }),

  batchImages: (p) => req('POST', '/api/batch/images', p, { timeoutMs: TIMEOUT.gen }),
  batchVideos: (p) => req('POST', '/api/batch/videos', p, { timeoutMs: TIMEOUT.gen }),
  batch: (id) => req('GET', `/api/batch/${id}`),
  cancelBatch: (id) => req('POST', `/api/batch/${id}/cancel`, {}),

  // 批 8 原著解析。注意 /api/story/plan 是**干跑**：只切块不调模型，用于"先告诉用户要花几次调用"。
  storyPlan: (p) => req('POST', '/api/story/plan', p),
  // 解析是异步任务（分块并发 + 全局归并），受理后立刻返回 jobId，进度走 SSE 的 batch 事件
  storyAnalyze: (p) => req('POST', '/api/story/analyze', p, { timeoutMs: TIMEOUT.gen }),
  storySources: (projectId) => req('GET', `/api/story/sources${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`),
  storySource: (id) => req('GET', `/api/story/sources/${id}`),
  deleteStorySource: (id) => req('DELETE', `/api/story/sources/${id}`),
  storyCards: (opts = {}) => {
    const q = [];
    if (opts.projectId) q.push(`project_id=${encodeURIComponent(opts.projectId)}`);
    if (opts.sourceId) q.push(`source_id=${encodeURIComponent(opts.sourceId)}`);
    if (opts.kind) q.push(`kind=${encodeURIComponent(opts.kind)}`);
    return req('GET', `/api/story/cards${q.length ? `?${q.join('&')}` : ''}`);
  },
  updateStoryCard: (id, patch) => req('PUT', `/api/story/cards/${id}`, patch),
  deleteStoryCard: (id) => req('DELETE', `/api/story/cards/${id}`),
  // 回注文本由**服务端**渲染（前端不重复实现 cardsToPrompt，否则格式有两个真相来源）
  storyPrompt: (opts = {}) => {
    const q = [];
    if (opts.projectId) q.push(`project_id=${encodeURIComponent(opts.projectId)}`);
    if (opts.sourceId) q.push(`source_id=${encodeURIComponent(opts.sourceId)}`);
    if (opts.kinds && opts.kinds.length) q.push(`kinds=${encodeURIComponent(opts.kinds.join(','))}`);
    return req('GET', `/api/story/cards/prompt${q.length ? `?${q.join('&')}` : ''}`);
  },
  storyCardToCharacter: (id, payload) => req('POST', `/api/story/cards/${id}/to-character`, payload),
  storyImportCharacters: (payload) => req('POST', '/api/story/cards/import-characters', payload),
  /** 追加解析（批 8 补 10）：只解析新增章节并进已有卡片，已有卡 id 不变、一张不删 */
  storyAppend: (payload) => req('POST', '/api/story/append', payload, { timeoutMs: TIMEOUT.gen }),

  storyReduce: (sourceId) => req('POST', '/api/story/reduce', { source_id: sourceId }, { timeoutMs: TIMEOUT.gen }),

  // 镜头绑定自动匹配（批 8 补 5）：纯本地匹配（不调模型）。dryRun 用来"先看会绑什么再决定"
  storyboardsAutoBind: (body) => req('POST', '/api/storyboards/auto-bind', body),

  // 分集大纲骨架（批 8 补 4）：剧情卡 → 拍子 → 集。纯本地判定，反复调拍数也不花钱
  storyEpisodes: (opts = {}) => {
    const q = new URLSearchParams();
    if (opts.projectId) q.set('project_id', opts.projectId);
    if (opts.sourceId) q.set('source_id', opts.sourceId);
    if (opts.perEpisode) q.set('per_episode', String(opts.perEpisode));
    return req('GET', `/api/story/episodes?${q.toString()}`);
  },

  /**
   * 补分幕次（批 8 补 32）：把"还没标幕次"的剧情拍点交给模型分到 起/承/转/合。
   * `dryRun` 只回报"要补几拍、调几次模型"，不花钱 —— 界面必须先干跑再让用户确认。
   * 它**只调一次**模型（全部拍点一次给完），所以计费闸门就是"要补几拍"这一个数。
   */
  storyStageFill: (sourceId, opts = {}) => req('POST', '/api/story/stage-fill',
    { source_id: sourceId, dry_run: !!opts.dryRun, model: opts.model }, { timeoutMs: TIMEOUT.gen }),

  /** 单集拍表 + 前情提要（批 8 补 8）：逐集生成的本集大纲与连续性上下文，纯本地计算 */
  storyEpisodeBrief: (q = {}) => {
    // 这里**没有** qs 助手（本文件一贯用 URLSearchParams 拼查询串）：写 qs(...) 只会在运行时抛
    // "qs is not defined"，静态检查与文本断言都看不见 —— 真机 browser-test 才抓得到
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
    return req('GET', `/api/story/episode-brief?${u.toString()}`);
  },

  // 剧本/分镜的过期体检（批 8 补 12）：纯本地判定，一次模型都不调
  // 全链路进度（批 8 补 16）：纯本地统计，零模型调用
  storyPipeline: (q = {}) => {
    const p = new URLSearchParams();
    Object.keys(q).forEach((k) => { if (q[k] !== undefined && q[k] !== '') p.set(k, q[k]); });
    return req('GET', `/api/story/pipeline${p.toString() ? `?${p}` : ''}`);
  },

  storyStaleness: (q = {}) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
    return req('GET', `/api/story/staleness?${u.toString()}`);
  },

  // 抽取覆盖体检（批 8 补 18）：纯本地判定，零模型调用
  storyCoverage: (sourceId) => req('GET', `/api/story/coverage?source_id=${encodeURIComponent(sourceId)}`),
  // 章节目录：把"第 34 段"翻译成"第 12 章"，并回答"哪几章什么都没抽到"（纯本地）
  storyChapters: (sourceId) => req('GET', `/api/story/chapters?source_id=${encodeURIComponent(sourceId)}`),
  // 卡片溯源：把"证据段 N"变成能直接读的原文片段（纯本地，随时可点、不花钱）
  storyCardSource: (cardId) => req('GET', `/api/story/card-source?card_id=${encodeURIComponent(cardId)}`),

  // 补抽指定段落（批 8 补 18）：**会调模型**，只补不删（已有卡片只补字段、id 不变）
  storyRetryChunks: (body) => req('POST', '/api/story/retry-chunks', body),

  // 一致性体检（批 8 补 3）：纯本地判定，随时可跑、不花钱
  storyAudit: (opts = {}) => {
    const q = new URLSearchParams();
    if (opts.projectId) q.set('project_id', opts.projectId);
    if (opts.sourceId) q.set('source_id', opts.sourceId);
    return req('GET', `/api/story/audit?${q.toString()}`);
  },
  storyAuditFix: (body) => req('POST', '/api/story/audit/fix', body),

  importData: (data, mode) => req('POST', '/api/import', { data, mode }),
  logs: () => req('GET', '/api/logs'),
};
