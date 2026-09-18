/**
 * poller.js — 视频任务轮询调度 + SSE 广播
 * ------------------------------------------------------------------
 * 原版轮询跑在浏览器里：切个页面、合上笔记本盖子，轮询就断了，
 * 视频明明生成完了本地状态还停在「生成中」，得手动点刷新。
 * 本地版把轮询搬到服务端：
 *   · 关掉浏览器照样轮询，回来就看到结果
 *   · 服务重启时自动把没跑完的任务捡回来接着查
 *   · 状态变化通过 SSE 推给前端，界面不用自己瞎转圈
 */
'use strict';

const agnes = require('./agnes');

const AUTO_POLL_STATUS = new Set(['queued', 'in_progress', 'remote_submitted']);
const AUTO_POLL_LOCAL = new Set(['polling', 'remote_submitted']);

/** 重任务帧数阈值：约 5 秒（121 帧 @24fps，8n+1 规则）——预设里 3s/5s 为轻，10s/18s 为重 */
const HEAVY_FRAMES = 121;
/** 重任务预算倍数：长片排队与渲染都更久，用同一硬上限会"还没轮完就判超时"（用户看到假的失败） */
const HEAVY_BUDGET_FACTOR = 3;
/** 轮询间隔递增上限倍数：越查越稀，避免长排队任务把配额烧在密查上 */
const INTERVAL_MAX_FACTOR = 4;
/** 时长硬预算（毫秒）：次数上限之外再加一道墙钟上限，否则"递增间隔 × 大次数"会把超时推到几小时后 */
const DEADLINE_NORMAL_MS = 10 * 60 * 1000;
const DEADLINE_HEAVY_MS = 30 * 60 * 1000;

let store = null;
const timers = new Map();   // assetId -> Timeout
const clients = new Set();  // SSE 连接

function bus() {
  return {
    add(res) { clients.add(res); },
    remove(res) { clients.delete(res); },
    emit(event, payload) {
      const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
      for (const res of clients) {
        try { res.write(frame); } catch { clients.delete(res); }
      }
    },
    size() { return clients.size; },
  };
}

const events = bus();
const log = [];
function pushLog(entry) {
  log.unshift(Object.assign({ t: new Date().toISOString() }, entry));
  if (log.length > 200) log.pop();
  events.emit('log', entry);
}

/**
 * 是否为"重任务"。判据只用**请求里真实存在、且真能区分档位**的字段——时长（帧数）：
 *   · 不猜模型名：换模型后猜名字的分档会静默失效
 *   · 不用分辨率：当前三档（1152×768 / 768×1152 / 1024×1024）耗时差异不显著，分不出来
 */
function isHeavyTask(asset) {
  if (!asset) return false;
  return (Number(asset.num_frames) || 0) > HEAVY_FRAMES;
}

/** 已累计的查询次数（**落库**，重启不归零：这是 R12 的核心） */
function attemptsOf(asset) {
  return Math.max(0, Number(asset && asset.poll_attempts) || 0);
}

/**
 * 下一次查询的间隔：基础值随累计次数线性放大，最多 INTERVAL_MAX_FACTOR 倍。
 * 远端长排队时密查纯属浪费配额，越久越该放稀。
 */
function intervalMs(attempt = 0) {
  const s = store.getSettings();
  const base = Math.max(2, Number(s.video_poll_interval) || 8) * 1000;
  // Number(attempt) || 0：非法值兜底为 0。否则 NaN 会传染成 setTimeout(NaN) → 立刻触发 → 密查打爆配额
  const n = Math.max(0, Number(attempt) || 0);
  const factor = Math.min(1 + n * 0.5, INTERVAL_MAX_FACTOR);
  return Math.round(base * factor);
}

/** 次数预算：用户设置的上限 ×（重任务倍数） */
function maxPollsFor(asset) {
  const s = store.getSettings();
  const base = Math.max(1, Number(s.video_max_polls) || 60);
  return isHeavyTask(asset) ? base * HEAVY_BUDGET_FACTOR : base;
}

/** 墙钟预算：从**首次进入轮询**起算，跨重启保持（poll_started_at 落库） */
function deadlineMsFor(asset) {
  return isHeavyTask(asset) ? DEADLINE_HEAVY_MS : DEADLINE_NORMAL_MS;
}

function isActive(v) {
  return !!v.agnes_video_id
    && (AUTO_POLL_STATUS.has(v.status) || AUTO_POLL_LOCAL.has(v.local_status));
}

/** 只停定时器，**不清预算**：预算落库在任务记录上，重启后继续累计 */
function stop(assetId) {
  const t = timers.get(assetId);
  if (t) clearTimeout(t);
  timers.delete(assetId);
}

/** 查一次并落库；返回结果供调用方使用。attempt 仅供展示（手动刷新不消耗自动预算） */
async function pollOnce(assetId, attempt = null) {
  const asset = store.get('video_assets', assetId);
  if (!asset || !asset.agnes_video_id) return null;

  // 2.5 系查询必须带 model_name（见 agnes.js 头注释），v2.0 记录一并传也无副作用
  const { data } = await agnes.queryVideo(asset.agnes_video_id, asset.model_name);
  const updates = agnes.buildSafeStatusUpdate(data);
  const merged = store.update('video_assets', assetId, updates);
  // B10：任务在查询往返间被删除 → update 返回 null，不许 emit 空事件
  if (!merged) return null;
  // R7：视频**首次**出片即回写镜头关联（pollOnce 是所有刷新路径的必经点）。
  // 2e 修复：用"进入 completed 的转变"作闸门——否则对旧 completed 任务点「重新获取」
  // 会把它自己的 id 又写回 linked_video_id，把镜头链接从新片回滚到旧片。
  const justCompleted = merged.status === 'completed' && asset.status !== 'completed';
  if (justCompleted && merged.video_url && merged.storyboard_id) {
    const sb = store.get('storyboards', merged.storyboard_id);
    const patch = {};
    if (sb && sb.linked_video_id !== merged.id) patch.linked_video_id = merged.id;
    // E2E 实测修复：首片回写必须同步推进镜头状态，否则分镜行徽章永远停在"有图片"
    if (sb && sb.status !== 'done' && sb.status !== 'video_ready') patch.status = 'video_ready';
    if (Object.keys(patch).length) store.update('storyboards', merged.storyboard_id, patch);
  }
  // 3.3：SSE 附带轮询节奏视图字段。R12 起 poll_attempts 落库（重启不归零），
  // 并补 poll_budget，任务页可显示"第 n/预算 次"，用户能自己判断还要等多久。
  const n = attempt == null ? attemptsOf(asset) + 1 : attempt;
  events.emit('video', {
    ...merged,
    poll_attempts: n,
    poll_budget: maxPollsFor(asset),
    poll_interval_s: Math.round(intervalMs(n) / 1000),
  });
  return merged;
}

function schedule(assetId, delay) {
  const t = setTimeout(() => { run(assetId); }, delay);
  if (t.unref) t.unref();
  timers.set(assetId, t);
}

/** 预算是否已耗尽（次数或墙钟任一触顶） */
function budgetExhausted(asset, count) {
  if (count >= maxPollsFor(asset)) return `已查询 ${count} 次`;
  const started = Date.parse(asset.poll_started_at || '');
  if (Number.isFinite(started)) {
    const mins = Math.round((Date.now() - started) / 60000);
    if (Date.now() - started >= deadlineMsFor(asset)) return `已查询 ${mins} 分钟`;
  }
  return null;
}

async function run(assetId) {
  const asset = store.get('video_assets', assetId);
  if (!asset || !isActive(asset)) { stop(assetId); return; }

  const count = attemptsOf(asset);
  const why = budgetExhausted(asset, count);
  if (why) {
    stop(assetId);
    const merged = store.update('video_assets', assetId, {
      status: 'poll_timeout',
      local_status: 'poll_timeout',
      // 明说"不代表失败"与恢复手段：预算触顶是本地停止追踪，不是远端失败
      error_message: `${why}仍未出结果（不代表失败，可点「重新获取」继续追踪）`,
    });
    events.emit('video', merged);
    pushLog({ level: 'warn', msg: `任务 ${assetId.slice(0, 8)} 查询超时（${why}）` });
    return;
  }

  try {
    const merged = await pollOnce(assetId, count + 1);
    if (!merged) { stop(assetId); return; }

    if (merged.status === 'completed' && merged.video_url) {
      stop(assetId);
      pushLog({ level: 'ok', msg: `视频生成完成 ${merged.id.slice(0, 8)}` });
      maybeAutoDownload(merged);
      return;
    }
    if (merged.status === 'failed' || merged.status === 'video_url_missing') {
      stop(assetId);
      pushLog({ level: merged.status === 'failed' ? 'error' : 'warn', msg: `任务 ${merged.id.slice(0, 8)} → ${merged.status}` });
      return;
    }
  } catch (e) {
    // 单次查询异常不改状态，下一轮继续（但**要计入预算**：持续异常不能无限重试）
    pushLog({ level: 'warn', msg: `轮询异常：${e.message}` });
  }

  // 累计次数落库：这是跨重启、跨 resume 的**唯一**预算事实源
  store.update('video_assets', assetId, { poll_attempts: count + 1 });
  schedule(assetId, intervalMs(count + 1));
}

/** 设置里开了「自动保存视频」就顺手落盘，免得远端链接过期 */
async function maybeAutoDownload(asset) {
  try {
    const s = store.getSettings();
    if (s.auto_download_video !== '1' || !asset.video_url) return;
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = store.videosDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${asset.id}.mp4`);
    await agnes.downloadVideo(asset.video_url, file);
    store.update('video_assets', asset.id, { local_file: file });
    events.emit('video', store.get('video_assets', asset.id));
  } catch (e) {
    pushLog({ level: 'warn', msg: `自动保存视频失败：${e.message}` });
  }
}

/**
 * 挂上轮询定时器。
 * 预算语义（R12）：累计次数落库，`watch()` **不再无条件归零**——旧写法每次调用都
 * `counts.set(id, 0)`，于是一个已经查满预算的僵尸任务只要被 `resume()`（每次服务重启）
 * 或批量刷新摸到一次，就能可靠地重新获得满额预算，无限轮询下去。
 *   · 默认：预算已耗尽则**拒绝重启**并留日志（僵尸任务不得自动复活）
 *   · `opts.reset = true`：用户主动动作（重新获取 / 绑定任务 ID / 批量刷新）才允许重置，
 *     否则用户面对一个已触顶的任务将永远无法再追踪
 */
function watch(assetId, immediate = false, opts = {}) {
  if (!assetId) return;
  const asset = store.get('video_assets', assetId);
  if (!asset || !isActive(asset)) return;
  if (timers.has(assetId)) return;

  if (opts.reset) {
    store.update('video_assets', assetId, { poll_attempts: 0, poll_started_at: new Date().toISOString() });
  } else {
    const exhausted = budgetExhausted(asset, attemptsOf(asset));
    if (exhausted) {
      // 拒绝重启还不够：如果只留一条日志，任务在界面上会一直显示"轮询中"而**实际没人轮询**
      // （静默停摆）。必须同步把状态推成终态，用户才看得到"查询超时，可重新获取"。
      const merged = store.update('video_assets', assetId, {
        status: 'poll_timeout',
        local_status: 'poll_timeout',
        error_message: `${exhausted}仍未出结果（不代表失败，可点「重新获取」继续追踪）`,
      });
      if (merged) events.emit('video', merged);
      pushLog({ level: 'warn', msg: `任务 ${assetId.slice(0, 8)} 已达轮询预算（${exhausted}），不再自动重启；可在任务卡上「重新获取」重置预算` });
      return;
    }
    // 首次挂载才记起点：墙钟预算跨重启保持，重启不得白送新的时间窗
    if (!asset.poll_started_at) store.update('video_assets', assetId, { poll_started_at: new Date().toISOString() });
  }
  schedule(assetId, immediate ? 500 : intervalMs(attemptsOf(asset)));
}

/** 启动时把没跑完的任务捡回来（**不重置预算**，否则重启即白送满额预算） */
function resume() {
  const pending = store.list('video_assets').filter(isActive);
  for (const v of pending) watch(v.id, true);
  return pending.length;
}

function init(s) {
  store = s;
  return { resume, watch, stop, pollOnce, events, log, pushLog, isActive, intervalMs, maxPollsFor, isHeavyTask, attemptsOf, budgetExhausted };
}

module.exports = {
  init, resume, watch, stop, pollOnce,
  get events() { return events; },
  get log() { return log; },
  pushLog,
  activeCount: () => timers.size,
  // 供测试与诊断使用（纯函数，无副作用）
  intervalMs: (attempt) => intervalMs(attempt),
  maxPollsFor: (asset) => maxPollsFor(asset),
  isHeavyTask: (asset) => isHeavyTask(asset),
  budgetExhausted: (asset, count) => budgetExhausted(asset, count),
};
