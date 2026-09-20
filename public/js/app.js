/**
 * app.js — 应用外壳：侧边栏、路由、全局状态、SSE
 */
import { icon, esc } from './consts.js';
import { api } from './api.js';
import { toast } from './ui.js';
import { cachedPipeline, loadPipeline, pipelineBadge, refreshPageProgress, rememberStage, renderStrip } from './pipeline.js';

import dashboard from './pages/dashboard.js';
import projects from './pages/projects.js';
import scripts from './pages/scripts.js';
import novel from './pages/novel.js';
import storyboards from './pages/storyboards.js';
import characters from './pages/characters.js';
import images from './pages/images.js';
import videos from './pages/videos.js';
import tasks from './pages/tasks.js';
import assets from './pages/assets.js';
import settings from './pages/settings.js';

const NAV = [
  { id: 'dashboard', label: '工作台', icon: 'dashboard', page: dashboard },
  { id: 'projects', label: '项目管理', icon: 'folder', page: projects },
  { id: 'scripts', label: '故事脚本', icon: 'script', page: scripts },
  // 批 8：原著解析紧跟故事脚本——它是剧本/资产/分镜的上游，链路顺序即导航顺序
  { id: 'novel', label: '原著解析', icon: 'book', page: novel },
  { id: 'storyboards', label: '分镜制作', icon: 'film', page: storyboards },
  // R14：角色库紧跟分镜制作——分镜是角色的使用现场，两者来回切换最频繁
  { id: 'characters', label: '角色库', icon: 'users', page: characters },
  { id: 'images', label: '图片生成', icon: 'image', page: images },
  { id: 'videos', label: '视频生成', icon: 'video', page: videos },
  { id: 'tasks', label: '镜头任务', icon: 'tasks', page: tasks },
  { id: 'assets', label: '素材库', icon: 'grid', page: assets },
  { id: 'settings', label: '设置', icon: 'settings', page: settings },
];

export const state = {
  settings: {},
  projects: [],
  stats: {},
  templates: [],
  characters: [],
  models: { models: [], updated_at: null, source: 'fallback', error: '' },
  home: '',
  version: '',
  current: 'dashboard',
  // UI 重构步 A：**壳层持有**的当前项目 —— 所有创作页只读它，不再各写一套解析（见 resolveProjectId）
  projectId: '',
};

let cleanup = null;
let renderSeq = 0; // B32：渲染序号，用于识别"已被取代"的渲染（快速连切页面时防清理函数被覆写/泄漏）

// ── 路由 ────────────────────────────────────────────────────
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const params = Object.fromEntries(new URLSearchParams(qs || '').entries());
  // UI 重构步 A：项目参数的**唯一规范名**是 `project`，但历史上原著页写的是 `project_id` ——
  // 旧链接（含用户收藏的深链）必须照旧能打开，所以在这里补一个别名，页面只认 `project`。
  if (!params.project && params.project_id) params.project = params.project_id;
  return { id: path || 'dashboard', params };
}

// ── 项目上下文（UI 重构步 A）─────────────────────────────────
/**
 * 为什么要有这一段：此前 8 个页面各写一套"当前项目是哪個"的解析，口径有 5 种
 * （`params.project` / `params.project_id` / `state.projects[0]` 兜底 / `agnes.assets.project` /
 * 硬编码 `''`）。表现是"在这一页选好项目、切到另一页又变回第一个项目"，而同一个链接在不同页面上
 * 指向不同的项目 —— 这就是"UI 与创作流程关联不强"的根。现在解析只有这一处。
 */
const PROJECT_KEY = 'agnes.project';
// 2.12 的老键。注意它与 `agnes.project` **不是同一个事实**：那个是素材库那个页面的**筛选器记忆**
// （`''` = 全部项目），这个是"我在哪个项目"。这里只把它当**一次性的默认值来源**读一下，
// 读不到就当没有偏好 —— 素材库自己的筛选语义本轮不动（它是跨项目素材库，不是创作上下文）。
const LEGACY_PROJECT_KEY = 'agnes.assets.project';

function readRememberedProject() {
  try {
    const v = localStorage.getItem(PROJECT_KEY);
    if (v) return v;
    const old = localStorage.getItem(LEGACY_PROJECT_KEY);
    if (old) { localStorage.setItem(PROJECT_KEY, old); return old; }
  } catch { /* 隐私模式/配额满：读不到偏好不能拖垮页面，当没有偏好 */ }
  return '';
}

/**
 * 记住"当前项目"：状态 + 本地记忆 + 侧栏那个唯一选择器，三处一次改完。
 * **不写 URL** —— URL 由 `resolveProjectId` 在挂载时统一规范化（一处写、一处读）。
 */
export function rememberProject(id) {
  const v = String(id || '');
  const changed = state.projectId !== v;
  state.projectId = v;
  try {
    if (v) localStorage.setItem(PROJECT_KEY, v); else localStorage.removeItem(PROJECT_KEY);
  } catch { /* 记不住就当没记住 */ }
  // 侧栏那一个是"我在哪个项目"的**显式声明**，它必须跟着变（否则壳层显示的项目与页面用的不是一回事）。
  // 进度徽标与流程条也得跟着换 —— 换项目必须**强制**拉一次：TTL 是给同一项目的重复请求用的，
  // 不是给换项目用的（否则会有 5 秒显示着上一个项目的进度）。
  if (changed) { renderSidebar(); refreshPipeline({ force: true }).catch(() => { /* 拉不到就保持现状 */ }); }
  return v;
}

/**
 * 项目上下文的**唯一解析入口**。顺序（先具体后兜底）：
 * ① URL（`project`，兼容旧别名 `project_id`）→ ② 壳层当前项目 → ③ 上次记住的 → ④ 第一个项目 → ⑤ 空串。
 * 解析结果**立刻写回**壳层与 URL，于是"我在哪个项目"永远只有一份答案；空串是**诚实的结论**（还没有项目），
 * 不是失败。`opts.allowAll` 给素材库那种"跨项目筛选器"用（`__all__` 是显式选择，不改创作上下文）。
 */
export const ALL_PROJECTS = '__all__';
export function resolveProjectId(params = {}, opts = {}) {
  const asked = String(params.project || '');
  if (opts.allowAll && asked === ALL_PROJECTS) return '';
  const known = (id) => !!id && state.projects.some((p) => p.id === id);
  // URL 里写了的项目**直接用**。为什么不做 `known(asked)` 判断：`state.projects` 是**启动那一刻的快照**，
  // 它**不是"项目存不存在"的权威** —— 刚用接口建好的项目还不在快照里，拿快照当权威会把它判成死链
  // （真机上就栽在这里：XSS 探针组用 API 现建的项目深链进分镜页，被判"不存在"而切走）。
  // 所以：URL 优先，快照只用来**兜底**；"这个项目是不是真的没了"交给下面的异步核对。
  const id = asked || [state.projectId, readRememberedProject(),
    state.projects[0] && state.projects[0].id].find(known) || '';
  if (asked && !known(asked)) verifyProjectLater(asked);
  rememberProject(id);
  // URL 也是真相的一部分：把解析结果写回 hash，刷新/分享/后退都还原到同一个项目。
  // 出现旧别名时**总是**重写一次 —— 否则 `project_id` 会一直留在链接里，同一件事就有两个名字
  if (asked !== id || params.project_id) syncViewParams({ project: id });
  return id;
}

/**
 * 链接里的项目不在快照里时，**用一份新数据**核对一次（不是拿旧快照下结论）。
 * 三种结局分得很清：① 项目其实在（快照过期）→ 什么都不说，顺手把快照与侧栏刷新；
 * ② 真的没了 → 说清楚"为什么换了项目"再切到现有项目（静默换一个等于骗人）；
 * ③ 核对不了（接口失败）→ **一个字都不说**（宁可不说，也不假警报）。
 */
async function verifyProjectLater(id) {
  let list = null;
  try {
    const r = await api.projects();
    if (r.ok) list = r.data || [];
  } catch { /* 核对不了就不说 */ }
  if (!list) return;
  state.projects = list;            // 顺手修掉过期快照（侧栏那个选择器也就准了）
  if (list.some((p) => p.id === id)) { renderSidebar(); return; }
  // "用户已经走开了"要按**地址栏**判，不能按 `state.projectId` 判：壳层在刷新快照时会把这个
  // 不存在的 id 自己换成一个真项目（那是它该做的），拿它当判据会把这条提示吞掉（真机上就吞了）
  if ((parseHash().params.project || '') !== id) return;
  toast.warn('链接指向的项目不存在（可能已删除），已切到现有项目。', 6000);
  const next = (list[0] && list[0].id) || '';
  rememberProject(next);
  navigate(state.current, next ? { project: next } : {});
}

/** 2.9：静默同步视图状态进 hash（replaceState 不触发 hashchange/不重挂载），刷新与分享链接可还原 */
export function syncViewParams(patch) {
  const { id, params } = parseHash();
  const next = { ...params, ...patch };
  delete next.project_id;   // 规范名是 `project`；旧别名由 parseHash 读入、在这里一次性迁走
  for (const k of Object.keys(next)) if (next[k] == null || next[k] === '') delete next[k];
  const qs = new URLSearchParams(next).toString();
  history.replaceState(null, '', '#/' + id + (qs ? '?' + qs : ''));
}

/** 侧栏那张表是**唯一**一份"入口 id → 中文名"（别处再写一张就会分叉）。 */
export function navLabel(id) {
  const n = NAV.find((x) => x.id === id);
  return n ? n.label : '';
}

export function navigate(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  location.hash = `#/${path}${qs ? `?${qs}` : ''}`;
}

async function render() {
  const { id, params } = parseHash();
  const nav = NAV.find((n) => n.id === id) || NAV[0];
  state.current = nav.id;
  // B32：render 未串行化——快速连切两页时，先发起的 mount 可能后 resolve，
  // 若直接 `cleanup = c` 会用旧页的清理函数覆写新页的，使新页的 onEvent 订阅/
  // 去抖定时器永久泄漏（此后每次 SSE 事件都多跑一个陈旧处理器）。
  // 序号守卫：只有"最新一次渲染"才有资格登记 cleanup，被取代的立即自清。
  const seq = ++renderSeq;

  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }

  const view = document.getElementById('view');
  view.innerHTML = '';
  // 路由切换时关掉所有残留弹窗：弹窗闭包指向旧页面 DOM，留着就是吞点击/吞键盘的僵尸层
  const modalRoot = document.getElementById('modal-root');
  if (modalRoot) modalRoot.innerHTML = '';
  document.body.classList.remove('modal-open');
  const page = document.createElement('div');
  page.className = 'page';
  view.appendChild(page);

  renderSidebar();
  // 换页 = 刷新一次进度（**强制**）：流程条就在眼前，显示着上一个页面的旧数字是最容易被当成
  // "系统算错了"的那种错。一次本地 GET（~3ms），用户一次点击一次，不是高频路径。
  // 这里**等它回来**再挂页面：页头的"上游产物/下一步"（B5.5）读的就是这份缓存，
  // 不等的话首访每页都会少那一行（页面挂完才到，页面不会自己重画）。
  await refreshPipeline({ force: true }).catch(() => { /* 拉不到就保持现状 */ });

  try {
    const c = await nav.page(page, params);
    if (seq !== renderSeq) { try { if (typeof c === 'function') c(); } catch { /* ignore */ } return; }
    if (typeof c === 'function') cleanup = c;
  } catch (e) {
    if (seq !== renderSeq) return;
    page.innerHTML = `<div class="note red">页面加载失败：${esc(e.message)}</div>`;
  }
  if (seq !== renderSeq) return;
  // 挂完页面才记"停在哪一段"：`state.projectId` 是**页面**在挂载时解析出来的，
  // 在挂载之前记会记到上一个项目头上（B5.6）。
  rememberStage(state.current, state.projectId);
  window.scrollTo({ top: 0 });
}

let sbCollapsed = localStorage.getItem('agnes.sidebar.collapsed') === '1'; // B3.2
document.body.classList.toggle('sb-collapsed', sbCollapsed);

/**
 * 侧栏入口右侧那个角标：优先显示**创作进度**（这个入口还欠着什么），其次才是运行中的视频数。
 * 为什么优先：进度角标回答的是"我下一步点哪儿"，而"还有 2 个视频在跑"是任务页的事 ——
 * 两个都要时把进度放前面，因为它每页都缺、任务数是偶发的。
 * 读的是**缓存**，这里绝不许发请求：renderSidebar 会被 SSE 高频调用（每个事件一次请求就是灾难）。
 */
function navBadge(n, running) {
  const b = pipelineBadge(n.id, cachedPipeline(state.projectId));
  if (b) return `<span class="badge ${b.tone}" title="${esc(b.title)}">${esc(b.text)}</span>`;
  return n.id === 'tasks' && running ? `<span class="badge">${running}</span>` : '';
}

function renderSidebar() {
  const el = document.getElementById('sidebar');
  const running = state.stats.running_videos || 0;
  el.innerHTML = `
    <div class="brand">
      <div class="brand-mark">${icon('sparkles', 19)}</div>
      <div class="brand-txt">
        <div class="brand-name">Agnes 漫剧工坊</div>
        <div class="brand-sub">本地版 · 数据不出本机</div>
      </div>
    </div>
    ${state.projects.length ? `
    <div class="sb-project">
      <label class="sb-project-lbl" for="sb-project">${icon('folder', 12)} 当前项目</label>
      <select class="select select-sm" id="sb-project" title="在这里选一次，所有创作页都跟着走">
        ${state.projects.map((p) => `<option value="${esc(p.id)}"${p.id === state.projectId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
    </div>` : ''}
    <nav class="nav">
      ${NAV.map((n) => `
        <button class="nav-item ${n.id === state.current ? 'active' : ''}" data-nav="${n.id}" title="${esc(n.label)}"${n.id === state.current ? ' aria-current="page"' : ''}>
          ${icon(n.icon, 17)}
          <span class="lbl">${esc(n.label)}</span>
          ${navBadge(n, running)}
        </button>`).join('')}
      <button class="nav-item sb-toggle" id="sb-toggle" title="${sbCollapsed ? '展开侧栏' : '折叠侧栏'}">
        ${icon(sbCollapsed ? 'arrowRight' : 'arrowLeft', 16)}<span class="lbl">折叠侧栏</span>
      </button>
    </nav>
    <div class="sidebar-footer">
      <div class="ver">v${esc(state.version || '1.0.0')}</div>
      <div class="path" title="${esc(state.home || '')}">${esc(state.home || '')}</div>
    </div>`;

  el.querySelectorAll('[data-nav]').forEach((b) => {
    b.onclick = () => navigate(b.getAttribute('data-nav'));
  });
  const sp = el.querySelector('#sb-project');
  if (sp) sp.onchange = () => {
    // 换项目 = 换上下文：**只带 project 重新进入当前页**。刻意不保留 episode / source_id 等参数 ——
    // 它们属于旧项目，"带着旧参数切项目"正是"看起来切了、其实还指着旧数据"的来源。
    rememberProject(sp.value);   // 它内部会强制刷新进度徽标
    navigate(state.current, { project: sp.value });
  };
  const tgl = el.querySelector('#sb-toggle');
  if (tgl) tgl.onclick = () => {
    sbCollapsed = !sbCollapsed;
    document.body.classList.toggle('sb-collapsed', sbCollapsed);
    localStorage.setItem('agnes.sidebar.collapsed', sbCollapsed ? '1' : '0');
    renderSidebar();
  };
}

// ── 全局数据 ────────────────────────────────────────────────
export async function refreshState() {
  const r = await api.bootstrap();
  if (r.ok) {
    state.settings = r.data.settings || {};
    state.projects = r.data.projects || [];
    state.stats = r.data.stats || {};
    state.templates = r.data.templates || [];
    state.characters = r.data.characters || [];
    state.models = r.data.models || state.models;
    // 项目上下文要有初始值，侧栏那个选择器才显示得出来；URL 里的项目优先（深链不能被记忆盖掉）
    if (!state.projects.some((p) => p.id === state.projectId)) {
      const remembered = readRememberedProject();
      state.projectId = state.projects.some((p) => p.id === remembered)
        ? remembered
        : ((state.projects[0] && state.projects[0].id) || '');
    }
    renderSidebar();
  }
}

/**
 * 刷新七段进度（侧栏徽标 + 常驻流程条），然后重画这两处。
 * 放在 refreshState 里是**唯一**的触发点：boot、SSE 去抖刷新、页面改完数据后调的 softRefresh
 * 都会走到这里，所以徽标不会长期停在旧值上；重复请求由 loadPipeline 的 TTL/并发去重挡掉。
 */
async function refreshPipeline(opts = {}) {
  const pid = state.projectId;
  const strip = document.getElementById('pipe-strip');
  if (!pid) { renderStrip(strip, null); return; }
  const d = await loadPipeline(pid, opts);
  // 等结果的这段时间里用户可能换了项目：那份数据已经不属于当前上下文，画上去就是"两个项目混着看"
  if (pid !== state.projectId) return;
  renderSidebar();
  renderStrip(strip, d, {
    // 直达下一步：带上项目 id，省掉用户到那一页再选一次项目
    onGo: (next) => navigate(next.page, { project: pid }),
  });
  // 页头那一行与流程条必须同步（两处显示不同的"下一步"，用户没法判断该信哪个）
  refreshPageProgress(state.current, pid);
}

/**
 * R15：拉取某项目的角色档案并合并进 state.characters。
 * 为什么不让页面直接用 bootstrap 的快照：分镜/图片页要显示"生成时真正发出什么"的计算态预览，
 * 而注入是后端按库里最新数据做的 —— 快照过期 = 预览骗人。进页面时对齐一次，本地调用极快。
 * 合并而不是整体替换：别的项目的角色不该被这次请求抹掉。
 */
export async function loadCharacters(projectId) {
  if (!projectId) return [];
  const r = await api.characters(projectId);
  const list = (r.ok && r.data) || [];
  if (r.ok) {
    const others = (state.characters || []).filter((c) => c.project_id !== projectId);
    state.characters = [...others, ...list];
  }
  return list;
}

/** 给页面用：改了项目/设置之后刷新侧边栏与统计 */
export async function softRefresh() {
  await refreshState();
  // 这是"我刚改完数据"的入口，所以**强制**刷新进度：TTL 会把紧接着的这次刷新吞掉，
  // 于是"解析完了但徽标还说该解析"—— 而用户刚做完的事最不该显示成没做。
  await refreshPipeline({ force: true });
}

// ── SSE：视频状态与批量任务进度 ─────────────────────────────
const listeners = { video: [], batch: [] };
const hiddenLive = { video: null, batch: null }; // 2.14：hidden 期间的事件快照缓冲
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  const { video, batch } = hiddenLive;
  hiddenLive.video = hiddenLive.batch = null;
  if (video) listeners.video.forEach((f) => { try { f(video); } catch { /* ignore */ } });
  if (batch) listeners.batch.forEach((f) => { try { f(batch); } catch { /* ignore */ } });
  if (video || batch) debouncedRefresh();
});
export function onEvent(kind, fn) {
  listeners[kind].push(fn);
  return () => { listeners[kind] = listeners[kind].filter((f) => f !== fn); };
}

// E1：dashboard 每条事件全量刷新合并为 400ms 一次（helper 命名避开文件里已导出的 softRefresh）
let sseTmr = null;
function debouncedRefresh() {
  if (sseTmr) return;
  // 视频跑完会改变"分镜视频"那一段的进度 —— 但这里**不带 force**：TTL 保证整批任务
  // 再长也最多 5 秒一次请求（"每个事件一次请求"是灾难，哪怕接口很便宜）。
  sseTmr = setTimeout(() => { sseTmr = null; refreshState(); refreshPipeline().catch(() => { /* ignore */ }); }, 400);
}

function connectSSE() {
  try {
    const es = new EventSource('/api/events');
    let hadOpen = false;
    es.onopen = () => {
      // 浏览器自动重连成功后，断线期间错过的 video/batch 事件不会补发——主动拉一次齐。
      // 审核修正：resync 不许无脑整页 render()——那会清掉开着弹窗（未保存输入蒸发）并打断播放中的视频。
      // 弹窗打开/有视频在播时只刷状态与侧栏角标（refreshState 自带），空闲才安全重挂当前页。
      if (hadOpen) {
        refreshState().then(() => {
          const busy = document.body.classList.contains('modal-open')
            || [...document.querySelectorAll('video')].some((v) => !v.paused && !v.ended);
          if (!busy) render();
        });
      }
      hadOpen = true;
    };
    // 2.14：后台页签不派发、不刷新（省电、回前台不再闪一堆过期渲染）；
    // 每 kind 只留最新一份快照，可见时放流 + 补一次状态刷新。
    es.addEventListener('video', (e) => {
      let d = null;
      try { d = JSON.parse(e.data); } catch { return; }
      if (document.hidden) { hiddenLive.video = d; return; }
      listeners.video.forEach((f) => { try { f(d); } catch { /* ignore */ } });
      if (state.current === 'dashboard') debouncedRefresh();
    });
    es.addEventListener('batch', (e) => {
      let d = null;
      try { d = JSON.parse(e.data); } catch { return; }
      if (document.hidden) { hiddenLive.batch = d; return; }
      listeners.batch.forEach((f) => { try { f(d); } catch { /* ignore */ } });
    });
    es.onerror = () => { /* 断线由浏览器自动重连，恢复后 onopen 里 resync */ };
  } catch { /* SSE 不可用时静默降级为手动刷新 */ }
}

/**
 * 服务端跑的是**旧代码**时，在页面顶部把话说清楚（批 8 补 27）。
 *
 * 为什么会走到这里：前端静态文件每次请求都从磁盘读（`no-store`），后端代码只在启动那一刻读一次。
 * 于是页面显示的是新功能、接口还是旧的，报错偏偏是"接口不存在: POST /api/story/plan"——
 * 看起来像"这个功能根本没做"，而不像"你该重启服务"。这句话必须由页面主动说，
 * 否则用户只能靠自己猜到"重启"上去（本轮就真的这么被卡住了）。
 */
function renderStaleBar(h) {
  const bar = document.getElementById('stale-bar');
  if (!bar) return;
  if (!h.ok || !h.data.code_stale) { bar.innerHTML = ''; return; }
  const files = (h.data.stale_files || []).slice(0, 4).map(esc).join('、');
  bar.innerHTML = `<div style="margin:0 0 12px;padding:10px 12px;border:1px solid var(--warn);border-radius:8px;background:rgba(214,181,109,.10)">
    <div style="font-weight:600;color:var(--warn)">服务端跑的是旧代码：新功能会报"接口不存在"</div>
    <div class="hint-xs" style="margin-top:4px">${files ? `启动之后这些文件改过：${files}${(h.data.stale_files || []).length > 4 ? ' 等' : ''}。` : ''}前端每次都从磁盘读，后端只在启动时读一次 —— 所以页面上是新功能、接口还是旧的。</div>
    <div class="hint-xs" style="margin-top:4px">处理：结束正在运行的服务进程（当前 PID ${esc(String(h.data.pid || '?'))}），再重新启动本工作台，然后刷新本页。</div>
  </div>`;
}

// ── 启动 ────────────────────────────────────────────────────
async function boot() {
  const h = await api.health();
  if (h.ok) {
    state.home = h.data.data_home || '';
    state.version = h.data.version || '';
  }
  renderStaleBar(h);
  await refreshState();
  window.addEventListener('hashchange', render);
  await render();
  connectSSE();

  if (!h.ok) {
    // E9：本地服务没起来时页面上任何"没数据/保存失败"都是假象——先说清楚，再别催 Key
    toast.err('连不上本地工作台服务（/api/health 无响应）。若刚关掉过 exe/终端窗口，请重新打开 Agnes 漫剧工坊；本页面刷新前所有操作都不会生效。', 12000);
  } else if (!state.settings.agnes_api_key) {
    setTimeout(() => {
      toast.warn('还没有配置 Agnes API Key，去「设置」填一个就能开始生成了。', 8000);
    }, 700);
  }
}

boot();
