/**
 * pipeline.js — 七段链的**唯一一份**前端实现（UI 重构 B5.3 / B5.4）。
 *
 * 为什么单独一个模块：七段链要在**三个地方**出现 —— 侧栏入口的进度徽标、每页常驻的流程条、
 * 工作台的详细面板。三处各写一份的代价不是多几十行，而是**三个数字会分叉**，
 * 而分叉没人看得出来（用户看到两个不一样的"5/12"只会觉得系统不可信）。
 * 所以：数据一次拉、语气表一份、下一步一份，渲染按密度分两个函数（紧凑条 / 详细面板）。
 *
 * 数据来自 `GET /api/story/pipeline` —— 服务端**纯本地统计、一次模型都不调**，所以随便刷不花钱。
 *
 * 依赖方向：本模块只依赖 `api.js` / `consts.js`，**不 import app.js**（否则与壳层成环）。
 * 需要跳转的地方由调用方传回调（`opts.onGo`），这也是"低耦合"的具体做法。
 */
import { api } from './api.js';
import { icon, esc } from './consts.js';

/** 状态 → 颜色。与工作台面板**同一份**（此前那份写死在 dashboard.js 里）。 */
export const STEP_TONE = { done: 'green', partial: 'gold', todo: 'blue', blocked: 'gray' };
/** 状态 → 人话。`blocked` 与 `todo` 必须分开说：混成一个"待办"，用户会照着点却发现做不了。 */
export const STEP_WORD = { done: '已完成', partial: '进行中', todo: '该做了', blocked: '待前置' };

// 缓存：SSE 会高频触发 refreshState，而流程条/徽标都挂在它上面。
// 5 秒内不重复请求（本地统计很便宜，但"每个事件一次请求"是另一回事）。
const TTL = 5000;
const cache = new Map();     // projectId -> { data, at }
const inflight = new Map();  // projectId -> Promise（并发去重：同时点两处不该发两次）
const lastErr = new Map();   // projectId -> { error, trace }（最近一次拉取失败的原因）

/** 最近一次拉取失败的原因（成功后清空）。界面据此说清"为什么这是旧数字"。 */
export function pipelineError(projectId) {
  return lastErr.get(projectId) || null;
}

/** 同步读缓存 —— 壳层每次重渲染都要用，**绝不能在这里发请求**。 */
export function cachedPipeline(projectId) {
  const hit = cache.get(projectId);
  return hit ? hit.data : null;
}

/**
 * 拉取某项目的七段进度（带 TTL 与并发去重）。
 * 失败时**保留上一份数据**并返回它：把徽标清空成"没数据"比显示一个旧数字更糟 ——
 * 旧数字至少是真的，清空会让用户以为进度丢了。
 */
export async function loadPipeline(projectId, opts = {}) {
  if (!projectId) return null;
  const hit = cache.get(projectId);
  if (!opts.force && hit && Date.now() - hit.at < TTL) return hit.data;
  if (inflight.has(projectId)) return inflight.get(projectId);
  const p = (async () => {
    try {
      const r = await api.storyPipeline({ project_id: projectId });
      if (!r.ok) {
        // 记下原因（界面要说清"为什么这是旧数字"），但**保留旧数据** ——
        // 把徽标清空成"没进度"比显示一个旧数字更糟：旧数字至少是真的
        lastErr.set(projectId, { error: r.error || '网络错误', trace: r.trace || '' });
        return hit ? hit.data : null;
      }
      lastErr.delete(projectId);
      cache.set(projectId, { data: r.data, at: Date.now() });
      return r.data;
    } catch (e) {
      lastErr.set(projectId, { error: (e && e.message) || '网络错误', trace: '' });
      return hit ? hit.data : null;   // 拉不到不是"没有进度"，别把结论说反
    } finally {
      inflight.delete(projectId);
    }
  })();
  inflight.set(projectId, p);
  return p;
}

/** 下一步（第一个没做完的段）：key/label/page/action。全做完时返回 null。 */
export function pipelineNext(d) {
  const st = ((d && d.steps) || []).find((x) => x.key === (d || {}).next_step);
  return st ? { key: st.key, label: st.label, page: st.page, action: st.action } : null;
}

/** 数字部分（单位由服务端给，前端不自己拼 —— 拼单位就是第二份口径）。 */
function amount(x) {
  if (x.need > 1) return ` ${x.have}/${x.need}${x.unit || ''}`;
  return x.have > 0 ? ` ${x.have}${x.unit || ''}` : '';
}

function chipTitle(x) {
  return `${x.label}：${STEP_WORD[x.state] || x.state}（${x.have}/${x.need}${x.unit || ''}）—— ${x.action}`;
}

/**
 * 一段链的芯片 —— **唯一一份**渲染（流程条、工作台面板、页头三处共用）。
 * 三处各写一份的后果是同一个状态在三处长得不一样，用户会以为它们说的不是一回事。
 */
export function chipHtml(x) {
  if (!x) return '';
  const tail = x.state === 'done' ? amount(x) : ` ${STEP_WORD[x.state] || ''}${amount(x)}`;
  return `<span class="pipe-chip ${STEP_TONE[x.state] || 'gray'}" title="${esc(chipTitle(x))}">`
    + `${x.state === 'done' ? `${icon('check', 11)} ` : ''}${esc(x.label)}<b>${esc(tail)}</b></span>`;
}

/**
 * 页头要的"上游产物 + 下一步"（UI 重构 B5.5）。
 *
 * 用户站在某一页时真正的问题只有两个：**"我是靠什么才做到这一步的"**（上游产物）
 * 与**"做完这页下一步去哪儿"**。两者都能从七段链那一份数据推出来 ——
 * 所以页面只报"我是哪个入口"，不自己写上游是谁（手写就是第二份口径，改链时会分叉）。
 * 不在链上的页面（工作台/项目/角色库/任务/素材/设置）返回空对象，页头照旧。
 */
export function progressOf(navId, projectId) {
  const steps = ((cachedPipeline(projectId) || {}).steps) || [];
  const mine = steps.filter((s) => s.nav === navId);
  if (!mine.length) return null;   // 不在链上（工作台/项目/角色库/任务/素材/设置）→ 页头照旧
  const i = steps.indexOf(mine[0]);
  const first = mine.filter((s) => s.state !== 'done')[0] || null;
  // **blocked 的"下一步"不在这页**：这一页的步之所以没做，正是因为上游还没做（`gated_by`），
  // 所以此时页头只能如实说"上游产物还没做完"，**不许**把这一步写成"下一步" ——
  // 那样页头会说"下一步：分集剧本（待前置）"，而流程条同时说"下一步：解析出卡片"，
  // 两处各说各的，用户没法判断该信哪个（这正是 B5.3/B5.4 要消灭的那种分叉）。
  const next = first && first.state !== 'blocked' ? first : null;
  return { from: i > 0 ? steps[i - 1] : null, next };
}

/** 页头那一行的内容（**唯一一份**，页头初次渲染与之后就地更新都走它）。 */
export function progressLineHtml(p) {
  if (!p) return '';
  return [
    p.from ? `<span class="page-prog-lbl">上游产物</span>${chipHtml(p.from)}` : '',
    p.next ? `<span class="page-prog-lbl">下一步</span>${chipHtml(p.next)}` : '',
  ].join('');
}

/**
 * 进度刷新后**就地更新**页头那一行。
 * 为什么必须更新：流程条就在页头上面，两处说的要是不同的"下一步"，用户没法判断该信哪个。
 * 用 id 定位而不是重挂页面 —— 重挂会清掉用户正在编辑的输入。
 */
export function refreshPageProgress(navId, projectId) {
  const el = document.getElementById('page-prog');
  if (el) el.innerHTML = progressLineHtml(progressOf(navId, projectId));
}

/**
 * 侧栏入口的进度徽标：这个入口现在**欠着什么**。
 * 一个入口可能认领多步（原著入口认领"原著/卡片/分集"三步），取**最靠前那个没做完的** ——
 * 也就是这个入口的"下一步"（与 pipelineNext 同一个判据）；全做完则显示最后一步的战果。
 * 为什么不是"最靠后的没做完的"：后面的步骤之所以没做，往往正是因为**前面那步没做**
 * （`blocked`），显示"待前置"会把"你现在该点解析卡片"说成"等着吧" —— 把可行动的下一步藏起来。
 */
export function pipelineBadge(navId, d) {
  const steps = ((d && d.steps) || []).filter((s) => s.nav === navId);
  if (!steps.length) return null;
  const pending = steps.filter((s) => s.state !== 'done');
  const st = pending.length ? pending[0] : steps[steps.length - 1];
  const text = st.have > 0 ? `${st.have}${st.unit || ''}` : (STEP_WORD[st.state] || '');
  return { text, tone: STEP_TONE[st.state] || 'gray', title: chipTitle(st) };
}

/**
 * 常驻流程条（壳层，每页可见）：一行七段 + 一个"下一步"。
 * 为什么常驻：用户最需要知道"我卡在哪、下一步点哪儿"的时候，恰恰是他**已经在某一页干活**的时候，
 * 而不是回到工作台总览的时候。
 */
export function renderStrip(el, d, opts = {}) {
  if (!el) return;
  if (!d) { el.innerHTML = ''; return; }
  const next = pipelineNext(d);
  el.innerHTML = `
    <div class="pipe-strip">
      <span class="pipe-strip-lbl">${icon('film', 13)}<span class="lbl">七段链路</span></span>
      <div class="pipe-chips">${(d.steps || []).map(chipHtml).join('')}</div>
      ${next
        ? `<button class="btn btn-sm" id="pipe-strip-go" title="去完成「${esc(next.label)}」：${esc(next.action)}">${icon('play', 12)}下一步：${esc(next.label)}</button>`
        : `<span class="badge green" title="七段都做完了">${icon('check', 11)} 整条链已跑完</span>`}
    </div>`;
  const go = el.querySelector('#pipe-strip-go');
  if (go && next && typeof opts.onGo === 'function') go.onclick = () => opts.onGo(next);
}

/**
 * 工作台的详细面板：同一份数据的**高密度视图**（带备注与"去完成"）。
 * 与流程条共用语气表、数字口径与下一步算法 —— 只有排版不同，**没有第二份判断**。
 */
export function renderPanel(el, d, opts = {}) {
  if (!el) return;
  if (!d) return;
  const next = pipelineNext(d);
  el.innerHTML = `<div class="card">
    <div class="row" style="gap:10px;align-items:center;flex-wrap:wrap">
      <div class="card-title" style="margin:0">${icon('film', 15)} 七段链路</div>
      <div class="spacer"></div>
      ${next
        ? `<button class="btn btn-sm btn-primary" id="pipe-go" title="${esc(next.action)}">${icon('play', 13)}去完成「${esc(next.label)}」</button>`
        : `<span class="badge green">整条链已跑完</span>`}
    </div>
    <div class="pipe-chips" style="margin-top:10px;flex-wrap:wrap;overflow:visible">${(d.steps || []).map(chipHtml).join('')}</div>
    ${(d.notes || []).length ? `<div class="note" style="margin-top:10px">${(d.notes || []).map((n) => esc(n)).join('<br>')}</div>` : ''}
  </div>`;
  const go = el.querySelector('#pipe-go');
  if (go && next && typeof opts.onGo === 'function') go.onclick = () => opts.onGo(next);
}
