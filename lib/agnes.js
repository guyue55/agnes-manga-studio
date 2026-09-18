/**
 * agnes.js — Agnes API 客户端
 * ------------------------------------------------------------------
 * 原版要绕一层 Supabase Edge Function 才能调 Agnes（因为浏览器有跨域、
 * 且 API Key 不能落前端）。本地版把这一层收进本机服务：
 *   · API Key 只存在本机 settings.json，前端永远拿不到明文
 *   · 没有 Edge Function 的 90s/150s 双层超时，改成直连，超时自己定
 *   · 原版的链路诊断（request_sent / response_received / response_status）
 *     保留下来 —— 排查「到底 Agnes 收没收到请求」时这几个字段最值钱
 *
 * 接口规则（照搬原版验证过的结论）：
 *   text         POST {base}/v1/chat/completions
 *   image        POST {base}/v1/images/generations   图生图 body.image=[url]
 *   video_create POST {base}/v1/videos               image 直接放顶层
 *   video_query  GET  {rootBase}/agnesapi?video_id=&model_name=  （rootBase = 去掉 /v1）
 *
 * 模型代际：
 *   · v2.0 系（agnes-video-v2.0）：width/height/num_frames/frame_rate/negative_prompt
 *   · 2.5 系（agnes-video-2.5 / -2.5-flash，官方文档 docs/agnes-video-25）：
 *     OpenAI-Videos 兼容新协议 —— 必填 mode(text|keyframe|reference)，时长 seconds
 *     （字符串 "4"-"12"），分辨率档位 size（Flash 固定 720P），画幅 aspect_ratio；
 *     媒体按模式用 first_frame/last_frame/images，旧的五个字段全部 forbidden；
 *     完成后的视频地址在 metadata.url。createVideo/queryVideo 按模型自动分流。
 */
'use strict';

const store = require('./store');

// ── URL 归一化 ───────────────────────────────────────────────
function normalizeBase(raw) {
  let base = String(raw || 'https://apihub.agnes-ai.com/v1').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  return base;
}
/** 去掉结尾 /v1，查询接口用的是域名根路径 */
function rootBase(base) {
  return normalizeBase(base).replace(/\/v1$/, '');
}
function withV1(base) {
  const b = normalizeBase(base);
  return b.endsWith('/v1') ? b : `${b}/v1`;
}

// ── 错误 ─────────────────────────────────────────────────────
class AgnesError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'AgnesError';
    this.errorType = opts.errorType || 'agnes_error';
    this.status = opts.status || 0;
    this.responseData = opts.responseData || null;
    this.diagnostics = opts.diagnostics || null;
    // B2：请求是否可能已到达服务端（到达后的断连/超时不可盲目重发——可能已入队计费）
    this.possiblySent = Boolean(opts.possiblySent);
  }
}

function noKey() {
  return new AgnesError('请先在「设置」页配置 Agnes API Key。', {
    errorType: 'no_api_key',
    status: 0,
    responseData: null,
    diagnostics: { request_sent: false, response_received: false, response_status: null },
  });
}

/**
 * 瞬时性拒绝（免费档排队满 503 / 限流 429 / 查询风暴 429 / 网络抖动）——
 * 与 schema、配额耗尽、鉴权这类"重试也不会好"的错误区分开，前者值得退避重试。
 */
function isTransientError(e) {
  if (!e) return false;
  const st = Number(e.status) || 0;
  // B2：请求体可能已送达（发出后断连、等满超时）→ 绝不自动重试。
  // 视频提交"重试"同一次网络抖动 = N 条真实计费任务，这正是本函数想防的事。
  // 这类失败会走 submit_timeout_unknown 记录流，由用户手动补录 video_id。
  if (st === 0 && e.possiblySent) return false;
  if (st === 408 || st === 429 || st >= 500) return true;
  if (st >= 400) return false; // 明确的其它 4xx（schema/鉴权/配额）重试无意义
  // 拿不到 HTTP 状态（网络层抛出、或 HTTP200 里包 error 对象）→ 按报错文案识别
  return /queue is full|rate limit|too many|retry later|请求 Agnes 超时|网络异常/i.test(String(e.message || ''));
}

/**
 * 统一发起请求。
 * @returns {Promise<{data:object, diagnostics:object}>}
 */
async function request(url, { method = 'POST', body, timeoutMs = 25000, apiKey }) {
  const startedAt = Date.now();
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) options.body = JSON.stringify(body);

  let resp;
  let text;
  try {
    resp = await fetch(url, options);
    text = await resp.text();
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    const causeCode = String((e && e.cause && e.cause.code) || e.code || '');
    // B2：只有"连接就没建立"（拒连/DNS 失败）才确定未送达；其余断连按可能已送达处理
    const notSent = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(causeCode)
      && !/timed out|abort/i.test(msg);
    const isTimeout = /timed out|abort/i.test(msg);
    const err = new AgnesError(
      isTimeout ? `请求 Agnes 超时（${Math.round(timeoutMs / 1000)}s 未返回）` : `网络异常：${msg}`,
      {
        errorType: isTimeout ? 'proxy_timeout' : 'network_error',
        status: 0,
        responseData: null,
        possiblySent: !notSent,
        diagnostics: {
          request_sent: !notSent,
          response_received: false,
          response_status: null,
          duration_ms: Date.now() - startedAt,
          timed_out: isTimeout,
        },
      },
    );
    throw err;
  }

  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { _raw: text }; }

  const diagnostics = {
    request_sent: true,
    response_received: true,
    response_status: resp.status,
    duration_ms: Date.now() - startedAt,
    final_request_url: url,
  };

  if (!resp.ok) {
    const msg = String((data && (data.error?.message || data.error || data.message)) || `Agnes 返回 HTTP ${resp.status}`);
    throw new AgnesError(typeof msg === 'string' ? msg : JSON.stringify(msg), {
      errorType: data?.error?.type === 'invalid_api_key' || resp.status === 401 ? 'invalid_api_key' : 'agnes_error',
      status: resp.status,
      responseData: data,
      diagnostics,
    });
  }

  return { data, diagnostics };
}

// ── 文本 ─────────────────────────────────────────────────────
/**
 * 调用文本模型。
 * @param {boolean} json 强制 JSON 输出：走 OpenAI 兼容的 response_format=json_object，
 *   网关做约束解码，模型不可能再吐出语法错误的 JSON（实测 agnes-2.0-flash 支持）。
 *   个别模型/网关不支持时自动降级为普通请求重试一次，不让功能整个挂掉。
 *   注意：json_object 模式下数组会被包装成 {"shots": [...]} 这类对象，前端负责解包。
 */
async function chat(messages, { model, temperature = 0.7, timeoutMs = 120000, json = false } = {}) {
  const s = store.getSettings();
  const key = store.getRawKey();
  if (!key) throw noKey();
  const url = `${withV1(s.agnes_api_base_url)}/chat/completions`;
  const body = { model: model || s.default_text_model, messages, temperature };
  if (json) body.response_format = { type: 'json_object' };

  let data, diagnostics;
  try {
    ({ data, diagnostics } = await request(url, { method: 'POST', body, timeoutMs, apiKey: key }));
  } catch (e) {
    const canFallback = json && e instanceof AgnesError
      && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 403;
    if (!canFallback) throw e;
    delete body.response_format;
    ({ data, diagnostics } = await request(url, { method: 'POST', body, timeoutMs, apiKey: key }));
  }
  const content = data?.choices?.[0]?.message?.content || '';
  return { content, raw: data, diagnostics };
}

// ── 图片 ─────────────────────────────────────────────────────
/**
 * 生成图片。Agnes 走 LiteLLM 代理，不认 response_format，
 * 实际返回 b64_json 居多 —— 由调用方落盘成本地文件。
 * @returns {{url?:string, b64?:string, mime:string, raw:object, diagnostics:object}}
 */
async function image({ prompt, model, size = '1024x1024', image: inputImage, timeoutMs = 120000 }) {
  const s = store.getSettings();
  const key = store.getRawKey();
  if (!key) throw noKey();
  const url = `${withV1(s.agnes_api_base_url)}/images/generations`;
  const body = { model: model || s.default_image_model, prompt, size };
  if (inputImage) body.image = Array.isArray(inputImage) ? inputImage : [inputImage];

  const { data, diagnostics } = await request(url, { method: 'POST', body, timeoutMs, apiKey: key });
  const item = data?.data?.[0] || {};
  return {
    url: item.url || '',
    b64: item.b64_json || '',
    mime: 'image/png',
    raw: data,
    diagnostics,
  };
}

// ── 视频创建 ─────────────────────────────────────────────────
const V25_MODEL = /^agnes-video-2\.5/i;
const FLASH_MODEL = /flash/i;

/** v2.0 的「帧数预设 ÷ 帧率」折算成 2.5 的秒数，并夹进合法的 "4"–"12" */
function v25Seconds(frames, fps) {
  const n = Number(frames) || 121;
  const f = Number(fps) || 24;
  return String(Math.min(12, Math.max(4, Math.round(n / f))));
}
/** 像素预设 → 2.5 分辨率档位；Flash 只认 720P */
function v25Size(model, width, height) {
  if (FLASH_MODEL.test(model)) return '720P';
  const m = Math.max(Number(width) || 1152, Number(height) || 768);
  return m >= 2048 ? '2K' : m >= 1536 ? '1080P' : m >= 1024 ? '1K' : '720P';
}
/** 按横版/竖版/方形的预设意图映射画幅（1152×768→16:9，768×1152→9:16，1024²→1:1） */
function v25Aspect(width, height) {
  const w = Number(width) || 1152;
  const h = Number(height) || 768;
  const r = w / h;
  if (r >= 1.9) return '21:9';
  if (r >= 1.2) return '16:9';
  if (r > 0.85) return '1:1';
  return '9:16';
}
/**
 * 2.5 系新协议 body。模式映射：
 *   无图 → text；单图(i2v/分镜批量) → keyframe+first_frame（沿用“图作为首帧”语义）；
 *   keyframes 标记 → keyframe+首/尾帧（多帧时中间帧除日志外无法传达，取首尾）；
 *   其余多图 → reference+images。negative_prompt 不允许单发，并进正向提示词。
 */
function v25Body(model, params) {
  const body = { model };
  body.prompt = params.negative_prompt ? `${params.prompt}。避免出现：${params.negative_prompt}` : params.prompt;
  body.seconds = v25Seconds(params.num_frames, params.frame_rate);
  body.size = v25Size(model, params.width, params.height);
  body.aspect_ratio = v25Aspect(params.width, params.height);
  if (params.seed != null && params.seed !== '') body.seed = Number(params.seed);
  const urls = (params.source_images || []).map((i) => (i && i.url) || i).filter(Boolean);
  if (urls.length) {
    if (params.mode_flag === 'keyframes') {
      body.mode = 'keyframe';
      body.first_frame = urls[0];
      if (urls.length > 1) body.last_frame = urls[urls.length - 1];
    } else {
      body.mode = 'reference';
      body.images = FLASH_MODEL.test(model) ? urls.slice(0, 5) : urls; // Flash 上限 5 张
    }
  } else if (params.image) {
    body.mode = 'keyframe';
    body.first_frame = typeof params.image === 'string' ? params.image : params.image.url;
  } else {
    body.mode = 'text';
  }
  return body;
}

/**
 * 提交视频任务。只要拿到 video_id / task_id 就算提交成功，不等生成完成。
 * 图生视频时 Agnes 要先从公网抓参考图，可能很久 —— 超时按 150s 起。
 */
async function submitVideoOnce(params) {
  const s = store.getSettings();
  const key = store.getRawKey();
  if (!key) throw noKey();

  const model = params.model || s.default_video_model;
  let body;
  if (V25_MODEL.test(model)) {
    body = v25Body(model, params);
  } else {
    body = {
      model,
      prompt: params.prompt,
      width: params.width || 1152,
      height: params.height || 768,
      num_frames: params.num_frames || 121,
      frame_rate: params.frame_rate || 24,
    };
    if (params.negative_prompt) body.negative_prompt = params.negative_prompt;
    if (params.seed != null && params.seed !== '') body.seed = Number(params.seed);
    if (params.source_images && params.source_images.length) {
      // 多图参考 / 关键帧：image 是 URL 数组，直接放顶层（不能包 extra_body）
      body.image = params.source_images.map((i) => i.url || i);
      if (params.mode_flag === 'keyframes') body.mode = 'keyframes';
    } else if (params.image) {
      body.image = params.image;
    }
  }

  const url = `${withV1(s.agnes_api_base_url)}/videos`;
  const timeoutMs = Number(s.request_timeout_ms) || 150000;

  try {
    const { data, diagnostics } = await request(url, { method: 'POST', body, timeoutMs, apiKey: key });
    if (data?.error && !data?.video_id && !data?.id) {
      throw new AgnesError(String(data.error?.message || data.error), {
        errorType: 'agnes_error', status: 200, responseData: data, diagnostics,
      });
    }
    const video_id = data?.video_id || data?.id || '';
    if (!video_id) {
      throw new AgnesError('Agnes 未返回 video_id（响应体中无 video_id / id 字段）', {
        errorType: 'no_video_id', status: 200, responseData: data, diagnostics,
      });
    }
    return { video_id, task_id: data?.task_id || '', raw: data, diagnostics, timed_out: false };
  } catch (e) {
    // 超时但请求已发出：Agnes 可能已经收下任务了。不能当失败丢掉 ——
    // 原版为此专门做了「提交超时未知」状态，让用户去 Agnes 账单核对后再补录 video_id。
    if (e instanceof AgnesError && e.errorType === 'proxy_timeout') {
      return {
        video_id: '',
        task_id: '',
        raw: e.responseData || {},
        diagnostics: e.diagnostics,
        timed_out: true,
        message: e.message,
      };
    }
    throw e;
  }
}

/**
 * 对外的提交入口：命中免费档「排队已满 / 限流」这类瞬时拒绝时指数退避自动重试。
 * 注意与超时的区别：proxy_timeout 可能已被 Agnes 收单（重复提交=重复扣费），
 * 由 submitVideoOnce 转成 timed_out 结果返回，不参与重试。
 * params.submit_retries 可显式覆盖预算（如批量队列传更大值）。
 */
async function createVideo(params) {
  const s = store.getSettings();
  const maxRetries = Math.max(0, Number(params.submit_retries != null ? params.submit_retries : s.video_submit_retries) || 0);
  const baseMs = Math.max(500, (Number(s.video_submit_backoff_s) || 3) * 1000);
  let attempt = 0;
  for (;;) {
    try {
      const result = await submitVideoOnce(params);
      if (attempt > 0) result.attempts = attempt + 1;
      return result;
    } catch (e) {
      if (!isTransientError(e) || attempt >= maxRetries) {
        if (attempt > 0) e.attempts = attempt + 1;
        throw e;
      }
      const wait = Math.min(60000, baseMs * 2 ** attempt) + Math.floor(Math.random() * 1500);
      await new Promise((r) => setTimeout(r, wait));
      attempt++;
    }
  }
}

// ── 视频查询 ─────────────────────────────────────────────────
/**
 * 查询视频任务。2.5 的 keyframe/reference 模式必须带 model_name 才查得到
 * （官方文档对 text 模式也推荐全带），v2.0 老任务不传即保持旧 URL 形态。
 */
async function queryVideo(videoId, modelName) {
  const s = store.getSettings();
  const key = store.getRawKey();
  if (!key) throw noKey();
  let url = `${rootBase(s.agnes_api_base_url)}/agnesapi?video_id=${encodeURIComponent(videoId)}`;
  if (modelName) url += `&model_name=${encodeURIComponent(modelName)}`;
  const { data, diagnostics } = await request(url, { method: 'GET', timeoutMs: 25000, apiKey: key });
  return { data, diagnostics };
}

/** v2.0 把地址放 remixed_from_video_id；2.5 系放 metadata.url（官方文档） */
function extractVideoUrl(result) {
  const meta = typeof result?.metadata?.url === 'string' ? result.metadata.url : '';
  return meta || result?.remixed_from_video_id || result?.video_url || result?.output_url || result?.url || '';
}

/**
 * 状态机保护：由 Agnes 查询结果生成安全的更新字段。
 * 规则（原版踩坑总结）：
 *   1. 只有 Agnes 明确 status=failed 才标远端失败
 *   2. completed 但没 video_url → video_url_missing，不是 failed
 *   3. 未知 status → 不动状态，只存原始响应
 */
function buildSafeStatusUpdate(result) {
  const updates = { raw_status_response: result };
  const agnesStatus = result?.status;
  const videoUrl = extractVideoUrl(result);
  const progress = result?.progress;

  if (videoUrl) updates.video_url = videoUrl;
  if (result?.error) updates.error_message = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
  if (progress != null) updates.progress = Number(progress) || 0;

  if (agnesStatus === 'failed') {
    updates.status = 'failed';
    updates.remote_status = 'failed';
  } else if (agnesStatus === 'completed') {
    updates.completed_at = new Date().toISOString();
    updates.remote_status = 'completed';
    if (videoUrl) {
      updates.status = 'completed';
      updates.local_status = 'completed';
    } else {
      updates.status = 'video_url_missing';
      updates.local_status = 'result_parse_failed';
    }
  } else if (agnesStatus === 'in_progress') {
    updates.status = 'in_progress';
    updates.remote_status = 'in_progress';
    updates.local_status = 'polling';
  } else if (agnesStatus === 'queued') {
    updates.status = 'queued';
    updates.remote_status = 'queued';
    updates.local_status = 'polling';
  }
  return updates;
}

// ── 视频下载 ─────────────────────────────────────────────────
/** B3 防护：Authorization 只默认发给与 API base 同主的地址。
 *  video_url 并非全可信（远端响应字段、用户可编辑），无条件带头 = 把 Key 送给任意主机。
 *  审核修复：base 要先过 normalizeBase——用户设置里存的常是无 scheme 的裸域名（normalizeBase 支持），
 *  直接 new URL('apihub.agnes-ai.com/v1') 抛错 → 同主 CDN 被误判跨主 → 带 Key 的下载变裸奔失败。 */
function keyAllowedFor(videoUrl, base) {
  try {
    return new URL(videoUrl).host === new URL(normalizeBase(base)).host;
  } catch {
    return false;
  }
}

async function downloadVideo(videoUrl, destFile) {
  const s = store.getSettings();
  const key = store.getRawKey();
  const sameHost = keyAllowedFor(videoUrl, s.agnes_api_base_url);
  const headers = sameHost && key ? { Authorization: `Bearer ${key}` } : {};
  let resp = await fetch(videoUrl, { headers, signal: AbortSignal.timeout(300000) });
  // 实测 2.5 任务刚 completed 时，结果文件在 CDN 上会瞬时 401/404 —— 等几秒重试一次再报错
  if (!resp.ok && (resp.status === 401 || resp.status === 403 || resp.status === 404 || resp.status >= 500)) {
    await new Promise((r) => setTimeout(r, 5000));
    resp = await fetch(videoUrl, { headers, signal: AbortSignal.timeout(300000) });
  }
  if (!resp.ok && !sameHost && (resp.status === 401 || resp.status === 403)) {
    // B3：绝不因跨主 401 就"兜底带 Key 重试"——那等于给任意主机一个用 401 钓 Key 的接口。
    throw new AgnesError('视频地址与 API Base 不同主机，为保护 API Key 未携带凭证下载（HTTP 401）', { errorType: 'download_unauthorized_host', status: resp.status });
  }
  if (!resp.ok) throw new AgnesError(`视频下载失败：HTTP ${resp.status}`, { errorType: 'download_failed', status: resp.status });
  const buf = Buffer.from(await resp.arrayBuffer());
  require('node:fs').writeFileSync(destFile, buf);
  return { file: destFile, bytes: buf.length };
}

// ── 动态模型目录 ─────────────────────────────────────────────
/**
 * 读取 OpenAI 兼容的 GET /v1/models。
 * 兼容 Agnes 可能返回的三种形状：
 *   { data: [{ id: ... }] } / { models: [...] } / [...]。
 * 模型目录是可选能力：接口不存在或临时失败时，不影响已有模型和生成流程。
 */
async function listModels({ timeoutMs = 30000 } = {}) {
  const s = store.getSettings();
  const key = store.getRawKey();
  if (!key) throw noKey();
  const url = `${withV1(s.agnes_api_base_url)}/models`;
  const { data, diagnostics } = await request(url, {
    method: 'GET',
    timeoutMs,
    apiKey: key,
  });
  return { data, diagnostics };
}

// ── 连通性测试 ───────────────────────────────────────────────
async function testConnection(kind = 'text') {
  const key = store.getRawKey();
  if (!key) throw noKey();
  if (kind === 'text') {
    const r = await chat([{ role: 'user', content: '回复两个字：正常' }], { timeoutMs: 30000 });
    return { ok: true, message: r.content.slice(0, 60) || '已连通（返回为空）' };
  }
  // B1：图片/视频"测试连接"绝不再真实生成——一次点击=一张图/一条在途计费任务且结果被丢弃。
  // 统一走 GET /models 只读探测（鉴权同样经过它，401 会照常抛出被路由层转成失败）。
  if (kind !== 'text') {
    const { data } = await listModels({ timeoutMs: 20000 });
    const n = Array.isArray(data) ? data.length : (data && Array.isArray(data.data) ? data.data.length : 0);
    const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '接口';
    return { ok: true, message: `${label}链路可达（目录 ${n} 个模型，未触发真实生成）` };
  }
}

module.exports = {
  normalizeBase, rootBase, withV1,
  AgnesError, isTransientError,
  chat, image, createVideo, queryVideo, downloadVideo, listModels,
  extractVideoUrl, buildSafeStatusUpdate,
  testConnection,
};
