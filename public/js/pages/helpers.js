/**
 * helpers.js — 页面通用片段：页头、项目选择器、批量进度条
 */
import { icon, esc } from '../consts.js';
import { progressLineHtml } from '../pipeline.js';

/**
 * 页头。`progress` 可选（UI 重构 B5.5）：传 `progressOf(本页入口, 当前项目)` 的结果，页头就把
 * "我是靠什么做到这一步的 / 做完这页下一步去哪儿"写在标题下面。
 * 不传（或传 null，即不在链上的页面：工作台/项目/角色库/任务/素材/设置）就完全不渲染这一行 ——
 * **向后兼容**：老的调用一个字都不用改。
 * 内容由 `progressLineHtml` 渲染（唯一一份），并且带 `#page-prog` 这个 id —— 进度刷新后壳层要**就地**
 * 更新它，否则流程条与页头会显示两个不同的"下一步"。
 */
export function head(o) {
  const prog = o.progress ? `
        <div class="page-prog" id="page-prog">${progressLineHtml(o.progress)}</div>` : '';
  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">${esc(o.title)}</h1>
        ${o.desc ? `<p class="page-desc">${esc(o.desc)}</p>` : ''}${prog}
      </div>
      <div class="page-actions">${o.actions || ''}</div>
    </div>`;
}

/** 项目下拉选择框，带「全部/无」选项 */
export function projectPicker(projects, selected, opts = {}) {
  const id = opts.id || 'project-picker';
  const cls = opts.small ? 'select select-sm' : 'select';
  return `
    <select class="${cls}" id="${id}" style="min-width:150px">
      ${opts.allowEmpty ? `<option value="">${esc(opts.emptyLabel || '未选择项目')}</option>` : ''}
      ${opts.allOption ? `<option value="__all__"${selected === '__all__' ? ' selected' : ''}>全部项目</option>` : ''}
      ${projects.map((p) => `<option value="${esc(p.id)}"${p.id === selected ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
    </select>`;
}

/**
 * 当前项目（**只读标签**，UI 重构 B5.2）。
 *
 * 为什么把页头那个下拉换成标签：换项目是"我在哪个项目"这一件事，全站只该有**一个**控件
 * （壳层侧栏那个）。页头再放一个下拉就是同一个事实的第二份来源 —— 两份必然分叉
 * （页头换过、侧栏没换，用户看到两个答案，谁也不知道哪个算）。这里只**显示**，不提供切换。
 */
export function projectLabel(projects, selected, opts = {}) {
  const p = projects.find((x) => x.id === selected);
  const name = p ? p.name : (opts.emptyLabel || '未选择项目');
  return `<span class="proj-tag${p ? '' : ' muted'}" title="当前项目（换项目请用左侧栏的「当前项目」）">`
    + `${icon('folder', 12)}<b>${esc(name)}</b></span>`;
}

/**
 * 批量任务进度（SSE 驱动）。
 *
 * R22：进度条上方多一条**逐项状态链**。只给 "5/12" 是没用的——用户真正要知道的是
 * "哪一镜失败了、现在跑到哪一镜"。链上的每一项 hover 出镜头号与失败原因。
 * 竞品的做法是"阶段链"（图/视频/音频三个阶段的徽标），但我们的批量任务本身是单阶段的
 * （一次全是图或全是视频），所以这里把"阶段"落在**逐项**上——这才是本产品里真正有用的粒度。
 * 项数上限 60：再多的链会挤成一片糊，也失去可读性（那种情况百分比条足够）。
 */
export function renderBatchBar(el, job, onCancel) {
  if (!el) return;
  if (!job) { el.innerHTML = ''; return; }
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  const title = job.type === 'images' ? '批量生成图片' : '批量提交视频';
  const items = Array.isArray(job.items) ? job.items : [];
  const chain = items.length && items.length <= 60
    ? `<div class="chain" role="list" aria-label="逐项状态">${items.map((it) => {
      const label = it.label || `第 ${it.index + 1} 项`;
      const stateZh = { pending: '待处理', running: '进行中', ok: '成功', fail: '失败', cancelled: '已取消' }[it.state] || '待处理';
      return `<span class="chain-dot ${esc(it.state || 'pending')}" role="listitem" title="${esc(label)}：${esc(stateZh)}${it.error ? `——${esc(it.error)}` : ''}"></span>`;
    }).join('')}</div>`
    : '';
  el.innerHTML = `
    <div class="note gold" style="display:flex;align-items:center;gap:14px">
      ${job.status === 'running' ? '<div class="spinner sm"></div>' : icon('check', 16)}
      <div style="flex:1;min-width:0">
        <div style="display:flex;justify-content:space-between;margin-bottom:6px">
          <span>${esc(title)}：${job.done} / ${job.total}${job.status === 'cancelled' ? '（已取消）' : ''}</span>
          <span style="color:var(--ok)">成功 ${job.ok}</span>
          ${job.fail ? `<span style="color:var(--err)">失败 ${job.fail}</span>` : ''}
        </div>
        ${chain}
        <div class="progress" style="max-width:none"><i style="width:${pct}%"></i></div>
      </div>
      ${job.status === 'running' && job.id && onCancel ? '<button class="btn btn-sm" data-cancel-batch>取消</button>' : ''}
    </div>`;
  if (onCancel) {
    const cb = el.querySelector('[data-cancel-batch]');
    if (cb) cb.onclick = onCancel;
  }
}

/** 通用表单片段：下拉 / 输入框 / 文本域 */
export function selectField(label, id, optionsHtml, extra = '') {
  return `<div class="field"><label for="${id}">${esc(label)}</label><select class="select" id="${id}" ${extra}>${optionsHtml}</select></div>`;
}

export function inputField(label, id, value = '', placeholder = '', type = 'text', cls = '') {
  return `<div class="field">
    <label for="${id}">${esc(label)}</label>
    <input class="input ${cls}" id="${id}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" />
  </div>`;
}

export function textareaField(label, id, value = '', placeholder = '', rows = 4, cls = '') {
  return `<div class="field">
    <label for="${id}">${esc(label)}</label>
    <textarea class="textarea ${cls}" id="${id}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>
  </div>`;
}

/**
 * R25：幂等键按"参数指纹"复用。
 *
 * 为什么不能每次提交都新生成一个 token：那样服务端的查重形同虚设——客户端超时后用户再点一次，
 * 就是一个全新的 token，服务端认不出来，于是同一件事下两次单、收两份钱。
 * 也不能永远复用同一个：用户"就是想再要一条一样的"时会被误判成重复提交。
 *
 * 所以规则是：**参数没变的重试复用同一个 token，参数一变立刻换新 token，提交成功后作废**。
 * 调用方负责在成功时 clear（见 videos.js / storyboards.js 的用法）。
 */
// 变更须知：token 的复用/作废规则是"防重复计费"的核心——重试（参数没变）必须复用，
// 成功或参数变化必须换新。改成"每次都新生成"= 服务端查重形同虚设（同一次提交会下两次单）。
export function makeTokenStore() {
  const m = new Map();
  const fresh = () => (globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
  const api = (scope, key) => {
    const prev = m.get(scope);
    if (prev && prev.key === key) return prev.token;
    const token = fresh();
    m.set(scope, { key, token });
    return token;
  };
  api.clear = (scope) => { if (scope === undefined) m.clear(); else m.delete(scope); };
  return api;
}
