/**
 * ui.js — toast / 弹窗 / 确认框 / DOM 助手
 * 所有页面共用，避免每个页面各写一套。
 */
import { icon, esc } from './consts.js';

// ── Toast ───────────────────────────────────────────────────
const TOAST_ICON = { ok: 'check', err: 'alert', warn: 'alert', info: 'info' };

export function toast(message, kind = 'info', ms = 3800) {
  const wrap = document.getElementById('toasts');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'err' : kind === 'success' ? 'ok' : kind === 'warn' ? 'warn' : ''}`;
  const ic = TOAST_ICON[kind === 'error' ? 'err' : kind === 'success' ? 'ok' : kind === 'warn' ? 'warn' : 'info'];
  el.innerHTML = `${icon(ic, 16)}<div style="flex:1;min-width:0">${esc(message)}</div>`;
  // 图标需要一点上边距对齐首行文字
  el.firstElementChild && (el.firstElementChild.style.marginTop = '1px');
  wrap.appendChild(el);
  const dismiss = () => {
    if (el.dataset.gone) return;
    el.dataset.gone = '1';
    clearTimeout(tmr);
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  };
  const tmr = setTimeout(dismiss, ms);
  // 允许手动点掉长文案/错误 toast，不必干等
  el.style.cursor = 'pointer';
  el.title = '点击关闭';
  el.onclick = dismiss;
}
toast.ok = (m, ms) => toast(m, 'success', ms);
toast.err = (m, ms) => toast(m, 'error', ms || 6000);
toast.warn = (m, ms) => toast(m, 'warn', ms || 5200);
toast.info = (m, ms) => toast(m, 'info', ms);

// ── 弹窗 ────────────────────────────────────────────────────
/**
 * 打开一个通用弹窗。
 * 键盘完整性：ESC 关闭最上层、Tab 在弹窗内循环、自动聚焦到首个安全控件、
 * 弹窗打开时锁背景滚动（body.modal-open）。
 * @param {object} o {title, body(HTML或Node), footer(HTML), wide, onMount(root, close)}
 */
export function modal(o) {
  const root = document.getElementById('modal-root');
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal ${o.wide ? 'wide' : ''}">
      <div class="modal-head">
        <h3>${esc(o.title || '')}</h3>
        <button class="icon-btn" data-close style="background:transparent;color:var(--text-3)" title="关闭（Esc）">${icon('x', 16)}</button>
      </div>
      <div class="modal-body">${typeof o.body === 'string' ? o.body : ''}</div>
      ${o.footer ? `<div class="modal-foot">${o.footer}</div>` : ''}
    </div>`;
  const close = () => mask.remove();
  const bodyEl = mask.querySelector('.modal-body');
  if (o.body && typeof o.body !== 'string') bodyEl.appendChild(o.body);

  // ── 2.5：脏守卫——编辑过未提交就想关（ESC/遮罩/×），先拦截一次 ──
  let dirty = false; let submitted = false; let guardShown = false;
  bodyEl.addEventListener('input', () => { dirty = true; });
  bodyEl.addEventListener('change', () => { dirty = true; });
  mask.addEventListener('click', (e) => {
    // 点过「保存/确定」后再关闭 = 用户本意已交付，不再纠缠
    if (e.target.closest('.modal-foot .btn-primary, .modal-foot [data-yes]')) submitted = true;
  });
  const requestClose = () => {
    if (submitted || !dirty || o.dirtyGuard === false) { close(); return; }
    if (guardShown) return;
    guardShown = true;
    const bar = document.createElement('div');
    bar.className = 'note orange';
    bar.style.cssText = 'margin:0 20px 10px;display:flex;align-items:center;gap:12px;justify-content:space-between';
    bar.innerHTML = `<span>有未保存的修改，关闭后将丢失</span><span class="row" style="gap:8px;flex:none">
      <button class="btn btn-sm" data-stay>继续编辑</button><button class="btn btn-sm btn-danger" data-discard>放弃修改</button></span>`;
    const foot = mask.querySelector('.modal-foot');
    if (foot) foot.insertAdjacentElement('beforebegin', bar);
    else mask.querySelector('.modal').appendChild(bar); // 无脚注弹窗：守卫条放盒内底部
    bar.querySelector('[data-stay]').onclick = () => { bar.remove(); guardShown = false; };
    bar.querySelector('[data-discard]').onclick = () => { submitted = true; close(); };
    bar.querySelector('[data-stay]').focus();
  };
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('[data-close]')) requestClose();
  });
  root.appendChild(mask);
  document.body.classList.add('modal-open');

  const focusables = () => [...mask.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  const onKey = (e) => {
    if (e.key === 'Escape') {
      // 只关最上层，避免一次 ESC 关掉叠着的多个弹窗
      if (root.lastElementChild === mask) { e.preventDefault(); requestClose(); }
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      // 2.5：⌘/Ctrl+↵ 提交——触发脚注主按钮（禁用态不响应）
      const primary = mask.querySelector('.modal-foot .btn-primary:not(:disabled)')
        || mask.querySelector('.modal-foot [data-yes]:not(:disabled)');
      if (primary) { e.preventDefault(); primary.click(); }
    } else if (e.key === 'Tab') {
      const els = focusables();
      if (!els.length) return;
      const first = els[0]; const last = els[els.length - 1];
      const cur = document.activeElement;
      if (e.shiftKey && (cur === first || !mask.contains(cur))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
      else if (!mask.contains(cur)) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKey);
  // 弹窗 DOM 被任意方式移除（确认后 close、遮罩点击等）都收尾：解绑键盘、无弹窗时解锁滚动
  const obs = new MutationObserver(() => {
    if (!document.body.contains(mask)) {
      obs.disconnect();
      document.removeEventListener('keydown', onKey);
      if (!root.querySelector('.modal-mask')) document.body.classList.remove('modal-open');
      if (o.onDismiss) o.onDismiss(); // R1：ESC/遮罩/× 关闭也有明确信号，调用方 Promise 不会永挂
    }
  });
  obs.observe(root, { childList: true });

  // 自动聚焦：表单优先第一个输入框；否则第一个非危险按钮；再否则关闭钮
  if (o.autoFocus !== false && !o.noAutoFocus) {
    const input = mask.querySelector('.modal-body input:not([type=checkbox]):not([type=radio]), .modal-body select, .modal-body textarea');
    const safeBtn = [...mask.querySelectorAll('.modal-foot .btn')].find((b) => !b.classList.contains('btn-danger'));
    (input || safeBtn || mask.querySelector('[data-close]'))?.focus();
  }

  if (o.onMount) o.onMount(mask, requestClose); // 调用方拿到的 close 也带脏守卫
  return { close: requestClose, forceClose: close, root: mask };
}

/** 3.4：两段式就地确认——首点换文案+红底+title 三通道提示，ms 内再点才执行，超时自动回弹。
 *  用于高频单目标删除（镜头/剧本/模板），替代阻塞式 confirm，少一层打断。破坏面大的操作仍走 confirm。 */
export function twoClick(btn, run, opts = {}) {
  const { label = '确认', ms = 3000 } = opts;
  let armed = false, t = null;
  const orig = btn.innerHTML, origTitle = btn.getAttribute('title') || '';
  const disarm = () => {
    armed = false; clearTimeout(t);
    if (!btn.isConnected) return;
    btn.innerHTML = orig; btn.title = origTitle;
    btn.classList.remove('btn-danger', 'armed'); btn.style.width = '';
  };
  btn.onclick = (e) => {
    e.stopPropagation(); // 就地钮常嵌在可点卡片/行里，冒泡会误触父级打开预览
    if (armed) { disarm(); return run(); }
    armed = true;
    btn.classList.add('btn-danger', 'armed');
    btn.innerHTML = label;
    btn.title = `${Math.round(ms / 1000)} 秒内再点一次生效，超时自动取消`;
    btn.style.width = 'auto';
    t = setTimeout(disarm, ms);
  };
  return disarm;
}

/**
 * 确认框。
 * 不带 checkbox 时返回 Promise<boolean>；
 * 带 checkbox（{label, checked}）时返回 Promise<{confirmed, checked}> ——
 * 勾选状态必须在点「确定」的瞬间从 DOM 里读，弹窗一关元素就没了。
 */
export function confirm(o) {
  const text = typeof o === 'string' ? o : o.text;
  const opts = typeof o === 'string' ? {} : o;
  const cb = opts.checkbox || null;
  const cancelVal = cb ? { confirmed: false, checked: false } : false;
  const yesVal = (checked) => (cb ? { confirmed: true, checked } : true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (val, close) => { if (done) return; done = true; if (close) close(); resolve(val); };
    const m = modal({
      title: opts.title || '确认操作',
      body: `<div style="font-size:13.5px;line-height:1.7;color:var(--text-2)">${text}</div>
        ${cb ? `<div style="margin-top:12px"><label class="row" style="gap:8px;font-size:12.5px;color:var(--text-2)">
          <input type="checkbox" data-cb ${cb.checked ? 'checked' : ''} /> ${esc(cb.label)}
        </label></div>` : ''}`,
      footer: `
        <button class="btn" data-no>${esc(opts.cancelText || '取消')}</button>
        <button class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" data-yes>${esc(opts.okText || '确定')}</button>`,
      // 与 modalEp 同类修复：ESC/点遮罩/× 关闭时 confirm 也必须落定，
      // 否则任何 `await confirm()` 的破坏性操作会在取消关闭时静默永挂（done 标志防二次 resolve）。
      onDismiss: () => finish(cancelVal, null),
      onMount(root, close) {
        root.querySelector('[data-yes]').onclick = () => {
          finish(yesVal(!!root.querySelector('[data-cb]')?.checked), close);
        };
        root.querySelector('[data-no]').onclick = () => finish(cancelVal, close);
        // 危险操作绝不默认聚焦确认钮（防回车误删）；普通确认聚焦「确定」方便连做
        root.querySelector(opts.danger ? '[data-no]' : '[data-yes]').focus();
      },
    });
    // 点遮罩关闭时也要 resolve 取消值
    const obs = new MutationObserver(() => {
      if (!document.body.contains(m.root)) { obs.disconnect(); finish(cancelVal); }
    });
    obs.observe(document.getElementById('modal-root'), { childList: true });
  });
}

/** 输入弹窗，返回 Promise<string|null> */
export function prompt(o) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title: o.title || '请输入',
      body: `
        <div class="field">
          <label for="prompt-input">${esc(o.label || '')}</label>
          <input class="input ${o.mono ? 'mono' : ''}" id="prompt-input" value="${esc(o.value || '')}" placeholder="${esc(o.placeholder || '')}" />
        </div>
        ${o.hint ? `<div class="hint">${o.hint}</div>` : ''}`,
      footer: `
        <button class="btn" data-no>取消</button>
        <button class="btn btn-primary" data-yes>确定</button>`,
      onMount(root, close) {
        const input = root.querySelector('#prompt-input');
        input.focus();
        input.select();
        const submit = () => { done = true; close(); resolve(input.value.trim()); };
        root.querySelector('[data-yes]').onclick = submit;
        root.querySelector('[data-no]').onclick = () => { close(); resolve(null); };
        input.onkeydown = (e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') { close(); resolve(null); }
        };
      },
    });
    const obs = new MutationObserver(() => {
      if (!document.body.contains(m.root) && !done) { obs.disconnect(); resolve(null); }
    });
    obs.observe(document.getElementById('modal-root'), { childList: true });
  });
}

// ── DOM 助手 ────────────────────────────────────────────────
/** 设置 innerHTML 后批量挂事件：on(root, '.sel', 'click', fn) */
export function on(root, selector, type, fn, opts) {
  root.querySelectorAll(selector).forEach((el) => el.addEventListener(type, fn, opts));
}

/** 从 data-* 属性取值 */
export function dataOf(el, name) {
  return el.getAttribute(`data-${name}`);
}

/** 空态块。action={label, go:'#/route'} 时渲染成一键直达的 hash 链接（2.7：空态从指路文案变出口） */
export function empty(title, desc, iconName = 'inbox', action = null) {
  return `<div class="empty">${icon(iconName, 38)}<div class="t">${esc(title)}</div><div class="d">${esc(desc || '')}</div>
    ${action && action.go && action.label ? `<div style="margin-top:14px"><a class="btn btn-sm btn-primary" href="${esc(action.go)}">${esc(action.label)}</a></div>` : ''}</div>`;
}

export function spinner(text) {
  return `<div class="loading-wrap"><div class="spinner"></div><span>${esc(text || '加载中…')}</span></div>`;
}

/** D-1/A-1：加载失败专用块——红字原因 + 重试钮（调用方负责绑定 [data-retry]）。
 *  杜绝"永久 spinner"和"API 故障谎报空态"两类伪装。 */
export function errBox(text = '加载失败', hint = '本地服务可能未启动或正在重启') {
  return `<div class="card" style="text-align:center;padding:36px 20px">
    <div class="note red" style="display:inline-block;text-align:left;max-width:560px">${esc(text)}<br>${esc(hint)}</div>
    <div style="margin-top:14px"><button class="btn btn-sm" data-retry>重试加载</button></div>
  </div>`;
}

/** 生成 <option> 列表 */
export function options(items, valueKey = 'value', labelKey = 'label', current) {
  const html = items.map((it) => {
    const v = typeof it === 'object' ? it[valueKey] : it;
    const l = typeof it === 'object' ? it[labelKey] : it;
    return `<option value="${esc(v)}"${String(v) === String(current) ? ' selected' : ''}>${esc(l)}</option>`;
  }).join('');
  // R8：存量值不在候选里时保留为"(当前)"选项。
  // 不加这行，浏览器默认选中第一项，用户"没动"下拉保存即被静默改写（如旧数据 '9:16' → '9:16 竖屏'）。
  if (current !== undefined && current !== null && current !== '' && !items.some((it) => String(typeof it === 'object' ? it[valueKey] : it) === String(current))) {
    return `<option value="${esc(current)}" selected>${esc(current)}（当前）</option>` + html;
  }
  return html;
}

/**
 * 按钮加载态：禁用 + 内联 spinner + 秒表，结束后恢复原状。
 * 长耗时操作（模型生成、图片生成、视频提交）必须让用户看到"还在干活"，
 * 否则只剩"点了没反应 → 怀疑坏了 → 狂点"这一条路径。
 * @param {HTMLElement} btn 按钮元素
 * @param {boolean} busy true 进入加载态，false 还原
 * @param {string} label 按钮上的文案；留空则只显示 spinner（适合小图标按钮）
 */
export function setBusy(btn, busy, label = '') {
  if (!btn) return;
  if (busy) {
    if (btn.dataset.busy === '1') return; // 已经在转了，别叠加
    btn.dataset.busy = '1';
    btn._origHtml = btn.innerHTML;
    btn._origTitle = btn.getAttribute('title') || '';
    btn.disabled = true;
    btn.title = '模型生成通常需要 20〜60 秒，请耐心等待';
    const t0 = Date.now();
    btn.innerHTML = label
      ? `<span class="spinner sm"></span><span data-elapsed>${esc(label)}… 0s</span>`
      : '<span class="spinner sm"></span>';
    btn._tmr = setInterval(() => {
      const el = btn.querySelector('[data-elapsed]');
      if (el) el.textContent = `${label}… ${Math.round((Date.now() - t0) / 1000)}s`;
    }, 1000);
  } else if (btn.dataset.busy === '1') {
    clearInterval(btn._tmr);
    btn._tmr = null;
    // 表格可能已经重渲染，按钮是游离节点 —— 还原也无害
    btn.innerHTML = btn._origHtml || btn.innerHTML;
    if (btn._origTitle) btn.setAttribute('title', btn._origTitle); else btn.removeAttribute('title');
    btn.disabled = false;
    delete btn.dataset.busy;
  }
}
