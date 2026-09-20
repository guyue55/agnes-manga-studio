/**
 * ui.js — toast / 弹窗 / 确认框 / DOM 助手
 * 所有页面共用，避免每个页面各写一套。
 */
import { icon, esc, readUntil, rememberUntil, endOfToday } from './consts.js';

// ── Toast ───────────────────────────────────────────────────
const TOAST_ICON = { ok: 'check', err: 'alert', warn: 'alert', info: 'info' };

export function toast(message, kind = 'info', ms = 3800) {
  const wrap = document.getElementById('toasts');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'err' : kind === 'success' ? 'ok' : kind === 'warn' ? 'warn' : ''}`;
  const ic = TOAST_ICON[kind === 'error' ? 'err' : kind === 'success' ? 'ok' : kind === 'warn' ? 'warn' : 'info'];
  // A11y：容器是 polite 状态区，错误再提为 alert（强宣告），整条原子播报
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.setAttribute('aria-atomic', 'true');
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
  // A11y（WAI-ARIA APG）：记住打开弹窗的元素，关闭后把焦点还回去
  const opener = (document.activeElement && document.activeElement !== document.body) ? document.activeElement : null;
  const titleId = `mt-${Math.random().toString(36).slice(2, 8)}`;
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  // role="dialog" + aria-modal + aria-labelledby：屏幕阅读器需要知道「这是一个模态、它叫什么」。
  // 我们早有 ESC/焦点陷阱/焦点归还/脏守卫，唯独缺这三个属性（竞品反而只有这三个属性、其余全缺）。
  mask.innerHTML = `
    <div class="modal ${o.wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <div class="modal-head">
        <h3 id="${titleId}">${esc(o.title || '')}</h3>
        <button class="icon-btn" data-close style="background:transparent;color:var(--text-3)" title="关闭（Esc）" aria-label="关闭">${icon('x', 16)}</button>
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
      // 仅当焦点确实已丢失（掉到 body）且触发者仍在文档中才归还，避免抢走调用方主动设置的焦点
      if (opener && opener.isConnected && (!document.activeElement || document.activeElement === document.body)) {
        try { opener.focus(); } catch { /* 已不可聚焦 */ }
      }
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
 * 让「整块可点」的元素也能键盘操作：Tab 可达 + Enter/Space 触发。
 * 仅用于内部**没有**按钮的卡片——内部已有按钮的卡片不要再加 role="button"，
 * 否则形成「按钮里嵌按钮」的 ARIA 违规（键盘用户用内部按钮即可）。
 */
/**
 * 单按钮告知弹窗：给"必须让用户看清、不能 3 秒就飘走"的说明用。
 * toast 会飘走（用户可能正低头看别处），confirm 又假装给了选择——这类场合两者都不合适。
 * 注意：lines 按 **HTML** 插入（方便调用方加粗重点），**用户数据必须由调用方 esc**。
 */
export function notice({ title = '提示', lines = [], okText = '知道了' } = {}) {
  const body = (Array.isArray(lines) ? lines : [lines])
    .filter(Boolean)
    .map((x) => `<div>${x}</div>`)
    .join('');
  return new Promise((resolve) => {
    let done = false;
    const finish = (close) => { if (done) return; done = true; if (close) close(); resolve(true); };
    modal({
      title,
      body: `<div style="font-size:13.5px;line-height:1.75;color:var(--text-2)">${body}</div>`,
      footer: `<button class="btn btn-primary" data-yes>${esc(okText)}</button>`,
      onDismiss: () => finish(null),
      onMount(root, close) {
        const b = root.querySelector('[data-yes]');
        b.onclick = () => finish(close);
        b.focus();
      },
    });
  });
}

export function clickableCard(el, fn) {
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.onclick = fn;
  el.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); fn(e); }
  };
  return el;
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

/** 「当天免提醒」偏好的存储键：存到期时间戳（今天 24 点），不是布尔 */
const COST_SKIP_KEY = 'agnes.cost.skipUntil';

/**
 * 付费动作前的成本确认。
 * 为什么必须有：出图/出视频都是**真实计费**，误点一次就是真金白银；而本项目删除类操作早就有
 * 一层 confirm，偏偏"花钱"没有 —— 这个不对称是最该补的交互缺口（5 个竞品包全都有付费确认）。
 * 已勾选「今天内不再提醒」则直接放行，避免高频生成时被反复打断。
 * @param {object} o {what:'图片'|'视频', count:number, note?:string}
 * @returns {Promise<boolean>} 是否确认继续
 */
export async function costConfirm(o = {}) {
  if (readUntil(COST_SKIP_KEY)) return true;
  const what = o.what || '内容';
  const n = Math.max(1, Number(o.count) || 1);
  const r = await confirm({
    title: '确认开始生成',
    text: `即将调用 Agnes 生成 <b>${n}</b> 个${what}任务，会产生<b>真实费用</b>（按 Agnes 账单结算，本工具不代扣）。<br><br>`
      + `${o.note ? esc(o.note) + '<br><br>' : ''}提交后可以离开页面，任务在本地服务里继续跑。`,
    okText: '开始生成',
    checkbox: { label: '今天内不再提醒', checked: true },
  });
  if (r && r.confirmed && r.checked) rememberUntil(COST_SKIP_KEY, endOfToday() - Date.now());
  return !!(r && r.confirmed);
}

/** 输入弹窗，返回 Promise<string|null> */export function prompt(o) {
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
/**
 * 空态卡片。第 4 参 action 支持两种形态：
 *   · {label, go:'#/xxx'}  → 渲染成 hash 链接（跨页跳转）
 *   · {label, act:'xxx'}   → 渲染成按钮，由调用方绑定 `[data-act="xxx"]`（本页内动作，如打开新建弹窗）
 * 空态只说"没有东西"而不给下一步，用户就得自己找路（竞品空态一律带主色按钮）。
 */
export function empty(title, desc, iconName = 'inbox', action = null) {
  const a = action && action.label
    ? (action.go
      ? `<a class="btn btn-sm btn-primary" href="${esc(action.go)}">${esc(action.label)}</a>`
      : `<button class="btn btn-sm btn-primary"${action.act ? ` data-act="${esc(action.act)}"` : ''}>${esc(action.label)}</button>`)
    : '';
  return `<div class="empty">${icon(iconName, 38)}<div class="t">${esc(title)}</div><div class="d">${esc(desc || '')}</div>
    ${a ? `<div style="margin-top:14px">${a}</div>` : ''}</div>`;
}

export function spinner(text) {
  return `<div class="loading-wrap"><div class="spinner"></div><span>${esc(text || '加载中…')}</span></div>`;
}

/**
 * 骨架屏（R9）。为什么不是 spinner：spinner 只说明"在加载"，不说明"要加载出什么"——
 * 整片空白区里一个小转圈，加载完成后布局会整体跳变（CLS）；骨架屏先把**形状**占住，
 * 用户能预判内容位置，视觉上也稳定。竞品（03/04/05）的列表/网格加载态一律用骨架屏。
 * kind：'asset'（素材网格方块）/ 'card'（卡片：封面+两行）/ 'row'（列表行）/ 'form'（表单字段）
 */
export function skeleton(kind = 'card', n = 3) {
  const one = {
    asset: '<div class="sk sk-asset"><div class="sk-box"></div><div class="sk-line w60"></div><div class="sk-line w40"></div></div>',
    card: '<div class="sk sk-card"><div class="sk-box"></div><div class="sk-line w80"></div><div class="sk-line w50"></div></div>',
    row: '<div class="sk sk-row"><div class="sk-thumb"></div><div class="sk-lines"><div class="sk-line w70"></div><div class="sk-line w45"></div></div></div>',
    form: '<div class="sk sk-form"><div class="sk-line w30"></div><div class="sk-box h40"></div><div class="sk-line w30"></div><div class="sk-box h40"></div></div>',
  }[kind] || '<div class="sk sk-card"><div class="sk-line w80"></div></div>';
  const wrap = kind === 'asset' ? 'asset-grid' : '';
  return `<div class="${wrap} sk-wrap" role="status" aria-label="加载中" aria-busy="true">${one.repeat(Math.max(1, n))}</div>`;
}

/**
 * 图片 + 加载失败兜底。
 * 为什么不能 `onerror="this.style.display='none'"`：隐藏会让布局塌陷（卡片高度突变、栅格错位），
 * 用户看到"这里什么都没有"分不清是"没生成"还是"加载失败"。兜底块继承原 class 保持尺寸并写明失败。
 */
export function imgWithFallback(url, o = {}) {
  const cls = o.cls || '';
  const style = o.style ? ` style="${o.style}"` : '';
  const alt = esc(o.alt || '');
  const fbStyle = o.style ? `,style:'${o.style}'` : '';
  return `<img class="${cls}"${style} src="${esc(url)}" alt="${alt}" loading="lazy"`
    + ` onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'${cls} img-fallback'${fbStyle},textContent:'图片加载失败'}))" />`;
}

/** D-1/A-1：加载失败专用块——红字原因 + 重试钮（调用方负责绑定 [data-retry]）。
 *  杜绝"永久 spinner"和"API 故障谎报空态"两类伪装。 */
/**
 * 按错误类型给出**不同的下一步出口**（R28）。
 *
 * 为什么不能只有一个"重试加载"：`no_api_key` 重试一万次也还是没 Key，用户真正要做的是
 * 去设置页填一个；内容审核失败重试同样会再被拒，要的是换个措辞。把"重试"当成万能出口，
 * 用户就只能在原地打转——而这正是竞品把 `errorKind` 分成 8 类并各配文案的原因。
 *
 * 纪律：出口只是**补充**，原文与追踪码一律保留（见 consts.js 的 ERROR_HINTS 注释）。
 * 未识别的类型保持原样（只有"重试加载"），不猜。
 */
// 变更须知：出口表只**补充**下一步动作，绝不替换后端原文与追踪码；
// 未识别的 errorType 保持原样（只有"重试加载"），不猜分类。
const ERR_OUTLETS = {
  no_api_key: { label: '去设置填 API Key', go: '#/settings?sec=api' },
  invalid_api_key: { label: '去设置重新填 Key', go: '#/settings?sec=api' },
  test_failed: { label: '去设置检查 Key 与地址', go: '#/settings?sec=api' },
  model_fetch_failed: { label: '去设置手动填模型名', go: '#/settings?sec=model' },
  network_error: { label: '去设置检查 API 地址', go: '#/settings?sec=api' },
  content_audit: { label: '换个措辞再试', retry: true },
  quota: { label: '去设置换模型', go: '#/settings?sec=model' },
  auth: { label: '去设置重新填 Key', go: '#/settings?sec=api' },
};

/** 取某个 errorType 对应的出口（errBox 与页面内的诊断面板共用同一张表，避免两处各写一份） */
export function errorOutlet(errorType) { return ERR_OUTLETS[errorType] || null; }

export function errBox(text = '加载失败', hint = '本地服务可能未启动或正在重启', trace = '', opts = {}) {
  // R10：带上失败追踪码并说明它有什么用——否则用户看到一个随机串只会更困惑。
  // 码同时已写进服务端「运行日志」，这是"用户截图 → 开发者定位"之间唯一的桥。
  const code = trace
    ? `<div style="margin-top:8px;font-size:12px;color:var(--text-3)">报错码 <b class="mono">${esc(trace)}</b> · 可在「设置 → 运行日志」中按此码搜索</div>`
    : '';
  const outlet = ERR_OUTLETS[opts.errorType];
  const extra = outlet && outlet.go
    ? `<a class="btn btn-sm" href="${outlet.go}" style="margin-left:8px">${esc(outlet.label)}</a>`
    : '';
  return `<div class="card" style="text-align:center;padding:36px 20px">
    <div class="note red" style="display:inline-block;text-align:left;max-width:560px">${esc(text)}<br>${esc(hint)}${code}</div>
    <div style="margin-top:14px"><button class="btn btn-sm" data-retry>重试加载</button>${extra}</div>
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
 * @param {string} hint 悬停提示；留空用通用预期。调用方知道更准的耗时（如"图生视频 1-2 分钟"）时应传入
 */
export function setBusy(btn, busy, label = '', hint = '') {
  if (!btn) return;
  // 防呆：第一个参数是**控件**（按钮/输入框），不是容器 —— 这个函数会把 `innerHTML` 换成 spinner。
  // 传容器进来会把整页内容连同**里面所有已绑定的监听**一起抹掉，而链路上**零报错**：
  // toast 照样报"成功"，只是列表不再刷新、页面从此变哑（要等 setBusy(false) 才把 HTML 字符串贴回去，
  // 那时节点已经是新的、监听全没了）。批 8 补 32「AI 补幕次」与补 33/34「回原文补字段」
  // 都这么错过了 —— 两处都只在真机上表现成"点了没反应"，直到补 35 补了真机测试才抓到。
  // 这里把错误用法变成**看得见的失败**（进 __uiRejects，真机测试会红），而不是留给下一个人再踩一次。
  if (!/^(BUTTON|INPUT|A)$/.test(String(btn.tagName || ''))) {
    const msg = `setBusy 只能传按钮/输入框，收到 <${String(btn.tagName || '?').toLowerCase()}>`
      + ' —— 传容器会把整页内容与监听一起抹掉';
    if (typeof window !== 'undefined') (window.__uiRejects = window.__uiRejects || []).push(msg);
    console.warn('[setBusy]', msg);
    return;
  }
  if (busy) {
    if (btn.dataset.busy === '1') return; // 已经在转了，别叠加
    btn.dataset.busy = '1';
    btn._origHtml = btn.innerHTML;
    btn._origTitle = btn.getAttribute('title') || '';
    btn.disabled = true;
    btn.title = hint || '模型生成通常需要 20〜60 秒，请耐心等待';
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
