/**
 * helpers.js — 页面通用片段：页头、项目选择器、批量进度条
 */
import { icon, esc } from '../consts.js';

export function head(o) {
  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">${esc(o.title)}</h1>
        ${o.desc ? `<p class="page-desc">${esc(o.desc)}</p>` : ''}
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
