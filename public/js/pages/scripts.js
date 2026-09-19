/**
 * scripts.js — 故事脚本
 * 提示词全部来自「提示词模板」（设置页可改），页面只负责收集变量、展示结果。
 * 这样改提示词不用动代码 —— 原版把提示词写死在组件里，改一个字要重新打包。
 */
import {
  icon, esc, relTime, extractJson, extractJsonArray, copyText, SCRIPT_TYPES, modelChoices,
  nextScriptStep, stepNo, pickBibleVar, UPSTREAM_LABELS,
} from '../consts.js';
import {
  charCount, countLabel, limitState, promptLength, checkPromptVars, promptGate, isLongVar,
} from '../textstats.js';
import { api } from '../api.js';
import { modal, toast, empty, spinner, skeleton, options, confirm, setBusy, notice } from '../ui.js';
import { head, projectPicker } from './helpers.js';
import { state, softRefresh, syncViewParams } from '../app.js';

const TAB_TPL = {
  story_concept: 'story_concept',
  plot_summary: 'plot_summary',
  episode_outline: 'episode_outline',
  episode_script: 'episode_script',
  storyboard_script: 'storyboard_script',
};

export default async function scripts(container, params) {
  let tab = params.tab && TAB_TPL[params.tab] ? params.tab : 'story_concept';
  let projectId = params.project && state.projects.some((p) => p.id === params.project)
    ? params.project
    : (state.projects[0] && state.projects[0].id) || '';
  if (params.project && projectId !== params.project) toast.warn('链接指向的项目不存在（可能已删除），已切到现有项目。', 6000); // E4 死链拦截
  let templates = [];
  let result = '';
  let resultCtx = null; // E4：结果诞生时的项目/页签上下文，跨语境保存前必须过问
  let generating = false;
  let saved = [];
  // R17：模型刚产出/刚载入的原文。结果区可编辑后必须有"回到原样"的退路，
  // 否则用户改坏了就只能重新烧一次配额。
  let pristine = '';
  // R17：每个页签各自保留自己的结果。切页签不再丢弃中间产物——"抽取出来的东西"必须回得去，
  // 否则两段式里的"确认"环节没有对象可确认（旧行为：切走即清空，模型产出只能靠手动保存留住）。
  const results = new Map(); // tab -> { text, pristine }
  // R16：本页签当前"已带入"的上游（来自上一步的确认产物）
  let upstream = null; // { from, field, chars }
  // fields 是跨页签共享的一张表（历史行为：同名变量在页签间延续）。
  // 带入下一步正是靠这个语义把上游写进下游模板的变量里，不另造一套存储。
  const fields = new Map();

  container.innerHTML = `
    ${head({
      title: '故事脚本',
      desc: '用 Agnes 文本模型从构思走到单集脚本，提示词模板可在设置页调整',
      actions: `
        ${projectPicker(state.projects, projectId, { id: 'p-picker', allowEmpty: true, emptyLabel: '未选择项目' })}
        <button class="btn" id="reload" title="刷新">${icon('refresh', 16)}</button>`,
    })}
    <div class="grid" style="grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:20px">
      <div>
        <div class="segmented" id="tabs" style="grid-template-columns:repeat(5,1fr);margin-bottom:18px">
          ${SCRIPT_TYPES.map((t) => `<button data-tab="${t.value}" class="${t.value === tab ? 'on' : ''}">${esc(t.label)}</button>`).join('')}
        </div>
        <div class="card">
          <div class="row" style="margin-bottom:10px">
            <div class="card-title" style="margin:0">${icon('wand', 15)}生成输入</div>
            <div class="spacer"></div>
            <span class="hint-xs" id="step-no"></span>
          </div>
          <div id="upstream"></div>
          <div id="fields">${skeleton('form', 1)}</div>
          <div class="divider"></div>
          <div class="row wrap">
            <select class="select select-sm" id="model" style="width:190px"></select>
            <button class="btn btn-primary" id="gen" style="flex:1;min-width:160px">${icon('wand', 15)}生成内容</button>
          </div>
          <div class="hint-xs" id="prompt-size" style="margin-top:8px"></div>
          <div id="gen-status"></div>
        </div>

        <div id="result-wrap" style="margin-top:18px"></div>
      </div>

      <div>
        <div class="card-title" style="padding-left:4px">${icon('history', 15)}已保存脚本</div>
        <div id="saved">${skeleton('row', 2)}</div>
      </div>
    </div>`;

  const picker = container.querySelector('#p-picker');
  picker.onchange = () => { projectId = picker.value; results.clear(); clearResult(); loadSaved(); };
  container.querySelector('#reload').onclick = () => { loadTemplates(); loadSaved(); };
  container.querySelector('#tabs').querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => {
      stashResult();                       // 先把当前页签的产物存起来（含未保存的编辑）
      tab = b.getAttribute('data-tab');
      upstream = null;                     // 上游提示条属于"某一步的输入"，切走即失效
      syncTabs();
      renderFields();
      loadResultFor(tab);
      syncViewParams({ tab });
    };
  });
  container.querySelector('#gen').onclick = generate;

  function syncTabs() {
    container.querySelectorAll('#tabs [data-tab]').forEach((b) => {
      b.classList.toggle('on', b.getAttribute('data-tab') === tab);
    });
  }

  function tplOf(type) {
    return templates.find((t) => t.template_type === type) || null;
  }

  function varsOf(tpl) {
    const set = [];
    const re = /\{\{([^}]+)\}\}/g;
    let m;
    while ((m = re.exec(tpl.content || ''))) if (!set.includes(m[1])) set.push(m[1]);
    return set;
  }

  function renderFields() {
    const tpl = tplOf(TAB_TPL[tab]);
    const box = container.querySelector('#fields');
    if (!tpl) {
      box.innerHTML = `<div class="note orange">这个类型还没有模板，去「设置 → 提示词模板」新建一个。</div>`;
      renderUpstream();
      return;
    }
    const vs = varsOf(tpl);
    box.innerHTML = `
      <div class="hint-xs" style="margin-bottom:14px">
        模板：${esc(tpl.name)}${tpl.notes ? ` · ${esc(tpl.notes)}` : ''}
      </div>
      <div class="grid g2" style="gap:0 14px">
        ${vs.map((v) => {
          // 长文本判定与 textstats 同源：两处各写一份正则，迟早会出现"这里算长、那里算短"
          const long = isLongVar(v);
          const val = fields.get(v) || '';
          const carried = upstream && upstream.field === v ? ' carried' : '';
          return long
            ? `<div class="field" style="grid-column:1/-1"><label>${esc(v)}</label>
                 <textarea class="textarea${carried}" data-var="${esc(v)}" aria-label="${esc(v)}" rows="5" placeholder="粘贴${esc(v)}…">${esc(val)}</textarea>
                 <div class="hint-xs counter" data-count="${esc(v)}"></div></div>`
            : `<div class="field"><label>${esc(v)}</label>
                 <input class="input" data-var="${esc(v)}" aria-label="${esc(v)}" value="${esc(val)}" /></div>`;
        }).join('')}
      </div>`;
    box.querySelectorAll('[data-var]').forEach((el) => {
      el.oninput = () => { fields.set(el.getAttribute('data-var'), el.value); syncCounters(); };
    });

    // 模型下拉
    const ms = container.querySelector('#model');
    const models = modelChoices(state.models, 'text', [state.settings.default_text_model || 'agnes-2.0-flash', 'agnes-2.0-pro', 'agnes-2.0-flash']);
    const current = ms.value || models[0]?.value;
    ms.innerHTML = options(models, 'value', 'label', current);
    renderUpstream();
    syncCounters();
  }

  /** R18：逐字段字数 + 整条提示词字数。生成前"要发出去多少字"必须可见 */
  function syncCounters() {
    const tpl = tplOf(TAB_TPL[tab]);
    const vs = tpl ? varsOf(tpl) : [];
    const box = container.querySelector('#fields');
    if (box) {
      box.querySelectorAll('[data-count]').forEach((el) => {
        const name = el.getAttribute('data-count');
        const st = limitState(charCount(fields.get(name) || ''));
        el.textContent = st.text;
        el.classList.toggle('over', st.over);
      });
    }
    const size = container.querySelector('#prompt-size');
    if (size) {
      const total = tpl ? promptLength(buildMessages(tpl)) : 0;
      const st = limitState(total, 12000);
      size.textContent = total ? `本次提示词合计 ${countLabel(total)}（变量已替换）` : '';
      size.classList.toggle('over', st.over);
    }
    const stepEl = container.querySelector('#step-no');
    if (stepEl) stepEl.textContent = `第 ${stepNo(tab)}/5 步`;
  }

  /** R16：把"上游已带入"这件事显式化——用户必须能看见带入的是哪一步、多少字、填进了哪个字段 */
  function renderUpstream() {
    const el = container.querySelector('#upstream');
    if (!el) return;
    if (!upstream) { el.innerHTML = ''; return; }
    const fromLabel = SCRIPT_TYPES.find((t) => t.value === upstream.from)?.label || UPSTREAM_LABELS[upstream.from] || upstream.from;
    el.innerHTML = `<div class="note gold upstream-strip">
      ${icon('arrowRight', 13)} 已从「${esc(fromLabel)}」带入 ${esc(countLabel(upstream.chars))} 到字段「${esc(upstream.field)}」——确认无误后再生成
      <button class="btn btn-xs" id="up-undo" style="margin-left:8px">撤销带入</button>
    </div>`;
    const b = el.querySelector('#up-undo');
    if (b) b.onclick = () => {
      // 变更须知：撤销要**还原成带入之前的内容**，不能一律清空 ——
      // 跨页带入（原著解析）可能覆盖用户已经写好的字段，清空等于把他的话删了。
      fields.set(upstream.field, upstream.prev || '');
      upstream = null;
      renderFields();
      toast('已撤销带入', 'info');
    };
  }

  /** 变量替换后的实际请求体：计数与发送共用同一份，避免"显示的字数"和"发出的字数"两套算法 */
  function buildMessages(tpl) {
    let prompt = tpl.content || '';
    for (const [k, v] of fields) prompt = prompt.split(`{{${k}}}`).join(v || '');
    prompt = prompt.replace(/\{\{[^}]+\}\}/g, '（未填写）');
    return [
      { role: 'system', content: tpl.system || '你是专业的AI短视频漫剧编剧。请用中文回答。' },
      { role: 'user', content: prompt },
    ];
  }

  /**
   * R16 生成前门禁（两段式的"确认"环节）：
   *  · 长文本变量空着 → **拦住**（没有素材的生成必然跑偏，还照样扣一次配额）
   *  · 短变量空着 / 超软上限 → 列出具体字段与字数，要用户明确点"继续生成"
   * 判据全在 textstats.js 的纯函数里，这里只负责呈现与中止。
   */
  async function gateBeforeGenerate(tpl) {
    const vs = varsOf(tpl);
    const values = {};
    for (const v of vs) values[v] = fields.get(v) || '';
    const g = promptGate({ ...checkPromptVars(vs, values), total: promptLength(buildMessages(tpl)) });
    if (!g) return true;
    // lines 按 HTML 插入 → 变量名来自用户可编辑的模板，必须 esc
    const lines = g.lines.map((x) => esc(x));
    if (g.kind === 'blocked') {
      await notice({ title: g.title, lines, okText: g.okText });
      return false;
    }
    return await confirm({
      title: g.title,
      text: lines.join('<br>'),
      okText: g.okText,
      cancelText: '先改一改',
    });
  }

  async function generate() {
    if (generating) return; // 双击会重复烧一次 API 配额
    const tpl = tplOf(TAB_TPL[tab]);
    if (!tpl) return;
    if (!state.settings.agnes_api_key) {
      toast.err('还没配置 Agnes API Key，请到「设置」页填写。');
      return;
    }
    if (!(await gateBeforeGenerate(tpl))) return;
    const messages = buildMessages(tpl);

    generating = true;
    const st = container.querySelector('#gen-status');
    const t0 = Date.now();
    st.innerHTML = `<div class="row" style="margin-top:12px;color:var(--gold-light)"><div class="spinner sm"></div><span style="font-size:12.5px" data-elapsed>Agnes 正在生成，通常需 10〜40s…</span></div>`;
    container.querySelector('#gen').disabled = true;
    const tmr = setInterval(() => {
      const el = st.querySelector('[data-elapsed]');
      if (el) el.textContent = `Agnes 正在生成… ${Math.round((Date.now() - t0) / 1000)}s`;
    }, 1000);

    let r;
    try {
      r = await api.genText({
        messages,
        model: container.querySelector('#model').value,
        project_id: projectId || null,
        note: tpl.name,
        json_mode: true, // 模板要求的都是结构化 JSON，走约束解码不再吐坏 JSON
      });
    } finally {
      // 断连抛出也要清定时器 + 解锁，否则按钮永久禁用且 interval 泄漏
      clearInterval(tmr);
      generating = false;
      container.querySelector('#gen').disabled = false;
      st.innerHTML = '';
    }

    if (!r.ok) { toast.err(r.error); return; }
    result = r.data.content || '';
    pristine = result;      // R17：留一份"原样"，供撤销改动
    resultCtx = { projectId, tab };
    upstream = null;        // 新结果 = 本页签自己的产物，上游带入标记功成身退
    stashResult();
    renderResult();
    renderUpstream();
  }
  function clearResult() {
    result = ''; resultCtx = null; pristine = '';
    const w = container.querySelector('#result-wrap');
    if (w) w.innerHTML = '';
  }

  /** 把当前页签的工作副本存回 per-tab 表（空结果 = 删除条目，别留空壳） */
  function stashResult() {
    if (result) results.set(tab, { text: result, pristine });
    else results.delete(tab);
  }

  /** 切到某页签时取出它自己的产物（没有就是空结果区） */
  function loadResultFor(t) {
    const r = results.get(t);
    result = r ? r.text : '';
    pristine = r ? r.pristine : '';
    resultCtx = r ? { projectId, tab: t } : null;
    renderResult();
  }

  /** 结果区当前视图：'json' 格式化（只读，用来看）| 'raw' 原文（可编辑，用来改） */
  let resultView = 'json';

  /**
   * R17：结果区可编辑。设计取舍——
   *  · 「格式化」视图保持**只读**：那是给眼睛看的，就地编辑格式化后的 JSON 极易改坏结构；
   *  · 「原文」视图是 textarea，改的是唯一事实来源 `result`，所以复制/保存/导入/带入下一步全都跟着变；
   *  · 实时回填"JSON 能否解析 + 镜头数"，改坏了立刻知道，而不是等点导入才报错。
   */
  function renderResult() {
    const wrap = container.querySelector('#result-wrap');
    if (!result) { wrap.innerHTML = ''; return; }
    const parsed = extractJson(result);
    // json_object 模式下数组会被包成 {"shots":[...]}，导入按钮按解包后的判断
    const shotArr = extractJsonArray(result);
    const next = nextScriptStep(tab);
    const nextLabel = next ? (SCRIPT_TYPES.find((t) => t.value === next)?.label || next) : '';
    const dirty = result !== pristine;
    wrap.innerHTML = `
      <div class="card">
        <div class="row wrap" style="margin-bottom:12px">
          <div class="card-title" style="margin:0">${icon('fileText', 15)}生成结果</div>
          ${dirty ? '<span class="badge gold">已改动</span>' : ''}
          <div class="spacer"></div>
          <button class="btn btn-xs" id="r-edit">${icon('edit', 12)}编辑原文</button>
          ${dirty ? `<button class="btn btn-xs" id="r-undo">${icon('refresh', 12)}撤销改动</button>` : ''}
          <button class="btn btn-xs" id="r-copy">${icon('copy', 12)}复制</button>
          <button class="btn btn-xs" id="r-save">${icon('save', 12)}保存到项目</button>
          ${shotArr && shotArr.length
            ? `<button class="btn btn-xs" id="r-storyboard">${icon('film', 12)}导入分镜表</button>` : ''}
          ${next
            ? `<button class="btn btn-xs btn-primary" id="r-next">${icon('arrowRight', 12)}带入下一步：${esc(nextLabel)}</button>`
            : '<button class="btn btn-xs" id="r-next" title="已是最后一步">复制结果备用</button>'}
        </div>
        <div class="tabs" style="margin-bottom:12px">
          <button class="${resultView === 'json' ? 'on' : ''}" data-view="json">格式化</button>
          <button class="${resultView === 'raw' ? 'on' : ''}" data-view="raw">原文${dirty ? '（已改）' : ''}</button>
        </div>
        <pre class="json-out" id="r-out"${resultView === 'raw' ? ' hidden' : ''}>${esc(parsed ? JSON.stringify(parsed, null, 2) : result)}</pre>
        <textarea class="textarea mono" id="r-edit-box" rows="14" aria-label="结果原文（可编辑）"${resultView === 'raw' ? '' : ' hidden'}>${esc(result)}</textarea>
        <div class="hint-xs" id="r-stat"></div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="section-label">脚本优化</div>
        <div class="chips" id="opt-chips"></div>
      </div>`;

    const out = wrap.querySelector('#r-out');
    const box = wrap.querySelector('#r-edit-box');
    const stat = wrap.querySelector('#r-stat');
    const refreshStat = () => {
      const st = limitState(charCount(result));
      const p2 = extractJson(result);
      const arr = extractJsonArray(result);
      const bits = [st.text];
      if (p2) bits.push(arr ? `JSON 可解析 · ${arr.length} 个镜头` : 'JSON 可解析');
      else bits.push('不是合法 JSON（可照样保存/复制，但「导入分镜表」不可用）');
      stat.textContent = bits.join(' · ');
      stat.classList.toggle('over', st.over);
    };
    refreshStat();

    const setView = (v) => {
      resultView = v;
      wrap.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('on', x.getAttribute('data-view') === v));
      out.hidden = v !== 'json';
      box.hidden = v !== 'raw';
      if (v === 'json') out.textContent = (() => { const p2 = extractJson(result); return p2 ? JSON.stringify(p2, null, 2) : result; })();
      if (v === 'raw') { box.focus(); }
    };
    wrap.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => setView(b.getAttribute('data-view')); });
    wrap.querySelector('#r-edit').onclick = () => setView(resultView === 'raw' ? 'json' : 'raw');

    const doUndo = () => {
      result = pristine;
      stashResult();
      renderResult(); // 重渲染以同步按钮组（撤销钮自己会消失）
      toast('已回到模型原样', 'info');
    };
    /**
     * "已改动"状态的两个信号（徽标 + 撤销钮）必须能**不重渲染**地出现/消失：
     * 重渲染会让 textarea 失焦、光标跳回开头——打字打到一半界面自己重置，比没有撤销还糟。
     * 所以这里走 DOM 增删，而不是 `renderResult()`。
     */
    const syncDirty = () => {
      const isDirty = result !== pristine;
      const badge = wrap.querySelector('.badge');
      if (isDirty && !badge) {
        const b2 = document.createElement('span');
        b2.className = 'badge gold';
        b2.textContent = '已改动';
        wrap.querySelector('.card-title').after(b2);
      } else if (!isDirty && badge) badge.remove();
      const undo = wrap.querySelector('#r-undo');
      if (isDirty && !undo) {
        const u = document.createElement('button');
        u.className = 'btn btn-xs';
        u.id = 'r-undo';
        u.innerHTML = `${icon('refresh', 12)}撤销改动`;
        u.onclick = doUndo;
        wrap.querySelector('#r-edit').after(u);
      } else if (!isDirty && undo) undo.remove();
    };

    // 就地编辑：改的就是 result 本身，任何下游动作都跟着走
    box.oninput = () => {
      result = box.value;
      stashResult(); // 编辑立即落到 per-tab 表：切页签再回来，改动还在
      refreshStat();
      syncDirty();
    };
    const undoBtn = wrap.querySelector('#r-undo');
    if (undoBtn) undoBtn.onclick = doUndo;
    wrap.querySelector('#r-copy').onclick = () => {
      copyText(result).then(() => toast.ok('已复制')).catch(() => toast.err('复制失败——浏览器拦截了剪贴板，请手动选中文本复制'));
    };
    const nextBtn = wrap.querySelector('#r-next');
    if (nextBtn) nextBtn.onclick = () => carryToNext(next);
    const saveBtn = wrap.querySelector('#r-save');
    saveBtn.onclick = async () => {
      if (!projectId) { toast.err('先在右上角选择项目'); return; }
      if (saveBtn.dataset.busy === '1') return; // R6 残留：保存防连点
      setBusy(saveBtn, true, '保存中');
      const r = await api.createScript({
        project_id: projectId,
        script_type: tab,
        title: `${SCRIPT_TYPES.find((t) => t.value === tab)?.label || '脚本'} - ${new Date().toLocaleDateString('zh-CN')}`,
        content: result,
        model_name: container.querySelector('#model')?.value || '',
        generation_prompt: '',
      });
      setBusy(saveBtn, false);
      if (r.ok) { toast.ok('已保存到项目'); loadSaved(); }
      else toast.err(r.error);
    };
    const sbBtn = wrap.querySelector('#r-storyboard');
    if (sbBtn) sbBtn.onclick = () => importStoryboard(shotArr);

    // 优化按钮：用 optimize 类型模板
    const opts = templates.filter((t) => t.template_type === 'optimize');
    const chips = wrap.querySelector('#opt-chips');
    chips.innerHTML = opts.map((t) => `<button class="chip" data-tpl="${esc(t.id)}">${esc(t.name)}</button>`).join('')
      || `<span style="font-size:12px;color:var(--text-3)">没有可用的优化模板</span>`;
    chips.querySelectorAll('[data-tpl]').forEach((b) => {
      b.onclick = () => optimize(opts.find((t) => t.id === b.getAttribute('data-tpl')));
    });
  }

  /**
   * R16 的核心动作：把**已确认的上游产物**带进下一步的模板变量，然后切到那一步。
   *  · 目标字段：下游模板里的第一个长文本变量（顺序即模板作者的意图）；找不到就退化为复制并说清原因，
   *    绝不"静默什么都没做"。
   *  · 带入是**可见可撤销**的（上游提示条 + 撤销带入 + 字段高亮），否则用户不知道东西去哪了。
   *  · 不带入到短变量（标题/风格这类）：把 2000 字塞进单行输入框是灾难。
   */
  function carryToNext(next) {
    if (!result.trim()) { toast.err('结果是空的，没有可带入的内容'); return; }
    if (!next) {
      copyText(result).then(() => toast.ok('已是最后一步，结果已复制到剪贴板')).catch(() => toast.err('复制失败——请手动选中文本复制'));
      return;
    }
    const tpl = tplOf(next);
    if (!tpl) {
      toast.err(`「${SCRIPT_TYPES.find((t) => t.value === next)?.label || next}」还没有提示词模板，去「设置 → 提示词模板」新建一个`);
      return;
    }
    const target = varsOf(tpl).find(isLongVar);
    if (!target) {
      copyText(result).then(() => toast.ok('下一步模板没有长文本字段，结果已复制到剪贴板')).catch(() => toast.err('复制失败——请手动选中文本复制'));
      return;
    }
    const from = tab;
    fields.set(target, result);
    upstream = { from, field: target, chars: charCount(result) };
    stashResult();           // 上游产物留在它自己的页签里，随时能回去改
    tab = next;
    syncTabs();
    renderFields();          // 会读到刚写进 fields 的值并高亮该字段
    loadResultFor(tab);      // 下游自己的结果区（首次进来是空的）
    syncViewParams({ tab });
    toast.ok(`已带入「${target}」，确认无误后点生成`);
  }

  async function optimize(tpl) {
    if (!tpl || !result || generating) return;
    generating = true;
    const st = container.querySelector('#gen-status');
    st.innerHTML = `<div class="row" style="margin-top:12px;color:var(--gold-light)"><div class="spinner sm"></div><span style="font-size:12.5px">正在${esc(tpl.name)}…</span></div>`;
    const prompt = (tpl.content || '').replace(/\{\{[^}]+\}\}/g, result);
    let r;
    try {
      r = await api.genText({
        messages: [
          { role: 'system', content: tpl.system || '你是专业的AI短视频漫剧编剧。' },
          { role: 'user', content: prompt },
        ],
        model: container.querySelector('#model')?.value,
        project_id: projectId || null,
        note: tpl.name,
      });
    } finally {
      generating = false;
      st.innerHTML = '';
    }
    if (!r.ok) { toast.err(r.error); return; }
    result = r.data.content || result;
    pristine = result; // 润色产出的也是一份"原样"，撤销改动回到这里而不是更早的版本
    resultCtx = { projectId, tab }; // 润色后同样盖上下文戳
    stashResult();
    renderResult();
    toast.ok(`已${tpl.name}`);
  }

  /** 把分镜脚本 JSON 一次性写入分镜表 */
  async function importStoryboard(parsed) {
    if (!Array.isArray(parsed) || !parsed.length) { toast.err('结果不是镜头数组，无法导入——可点「复制」把文本交给聊天工具改写后再导'); return; }
    if (!projectId) { toast.err('请先选择项目——右上角下拉选一个，或去「项目管理」新建'); return; }
    const epRaw = await modalEp();
    if (epRaw === null) return; // R1：取消/ESC/点遮罩 = 明确中止，绝不"以第 1 集导入"
    const ep = Math.max(1, Number(epRaw) || 1);
    const rows = parsed.map((s, i) => ({
      project_id: projectId,
      episode_number: ep,
      shot_number: Number(s.shot_number) || i + 1,
      shot_type: String(s.shot_type || '中景'),
      scene_description: String(s.scene_description || ''),
      characters: String(s.characters || ''),
      scene: String(s.scene || ''),
      action: String(s.action || ''),
      dialogue: String(s.dialogue || ''),
      narration: String(s.narration || ''),
      sound_effect: String(s.sound_effect || ''),
      duration_seconds: Number(s.duration_seconds) || 3,
      image_prompt: String(s.image_prompt || ''),
      video_prompt: String(s.video_prompt || ''),
      negative_prompt: String(s.negative_prompt || 'low quality, blurry, distorted face'),
      status: 'pending',
      sort_order: i,
    }));
    const r = await api.createStoryboards(rows);
    if (r.ok) {
      toast.ok(`已导入 ${r.data.inserted || rows.length} 个镜头到分镜表`);
      location.hash = `#/storyboards?project=${encodeURIComponent(projectId)}&episode=${ep}`;
    } else toast.err(r.error);
  }

  function modalEp() {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
      modal({
        title: '导入到第几集',
        body: `<div class="field"><label for="ep">集数</label><input class="input" id="ep" type="number" min="1" value="1" /></div>`,
        footer: `<button class="btn" data-no>取消</button><button class="btn btn-primary" data-yes>导入</button>`,
        // R1：ESC/遮罩/× 关闭也 resolve(null)，导入流程不再静默挂起
        onDismiss: () => settle(null),
        onMount(root, close) {
          const i = root.querySelector('#ep');
          i.focus();
          root.querySelector('[data-no]').onclick = () => { settle(null); close(); };
          root.querySelector('[data-yes]').onclick = () => { const v = i.value; settle(v); close(); };
        },
      });
    });
  }

  async function loadSaved() {
    const el = container.querySelector('#saved');
    if (!projectId) {
      el.innerHTML = `<div class="card">${empty('未选择项目', '选择项目后可查看已保存的脚本', 'folder', { label: '去项目管理', go: '#/projects' })}</div>`;
      return;
    }
    const r = await api.scripts(projectId);
    if (!r.ok) { el.innerHTML = `<div class="note red">${esc(r.error)}</div>`; return; }
    saved = (r.data || []).filter((s) => s.script_type === tab);
    if (!saved.length) {
      el.innerHTML = `<div class="card">${empty('暂无保存记录', '生成后点「保存到项目」', 'script', { label: '去生成', act: 'gen' })}</div>`;
      const gb = el.querySelector('[data-act="gen"]');
      // 生成区在左栏：滚动过去并把焦点交给主按钮，避免用户在本页继续找路
      if (gb) gb.onclick = () => { const b = container.querySelector('#gen'); if (b) { b.scrollIntoView({ block: 'center' }); b.focus(); } };
      return;
    }
    el.innerHTML = saved.map((s) => `
      <div class="card" style="margin-bottom:10px;padding:14px">
        <div class="row" style="align-items:flex-start">
          <div style="flex:1;min-width:0">
            <div style="font-size:12.5px;font-weight:550">${esc(s.title)}</div>
            <div style="font-size:11px;color:var(--text-4);margin-top:3px">${esc(relTime(s.created_at))}${s.model_name ? ` · ${esc(s.model_name)}` : ''}</div>
          </div>
          <button class="icon-btn" data-use="${esc(s.id)}" title="载入到结果区" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('edit', 13)}</button>
          <button class="icon-btn danger" data-del="${esc(s.id)}" title="删除" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('trash', 13)}</button>
        </div>
        <pre class="json-out" style="max-height:110px;margin-top:9px">${esc(String(s.content).slice(0, 700))}${String(s.content).length > 700 ? '\n…' : ''}</pre>
      </div>`).join('');

    el.querySelectorAll('[data-use]').forEach((b) => {
      b.onclick = () => {
        const s = saved.find((x) => x.id === b.getAttribute('data-use'));
        if (s) { result = s.content; pristine = s.content; resultCtx = { projectId, tab: s.script_type || tab }; stashResult(); renderResult(); toast.ok('已载入'); }
      };
    });
    el.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        const id = b.getAttribute('data-del');
        if (!(await confirm({ text: '删除这条脚本记录？', danger: true, okText: '删除' }))) return;
        const r2 = await api.deleteScript(id);
        if (r2.ok) { toast.ok('已删除'); loadSaved(); }
        else toast.err(r2.error);
      };
    });
  }

  async function loadTemplates() {
    const r = await api.templates();
    if (r.ok) templates = r.data || [];
    else templates = [];
    renderFields();
  }

  await loadTemplates();
  await loadSaved();
  await applyBible();

  /**
   * 批 8 补：跨页带入 —— 原著解析页点「带入剧本」会带 `bible=<source_id>&kinds=...` 过来，
   * 这里把回注文本填进合适的模板变量，并复用既有的"已带入"提示条（可见 + 可撤销）。
   * 消费后立刻从 URL 抹掉，避免刷新/分享链接时重复带入覆盖用户后来的修改。
   */
  async function applyBible() {
    if (!params.bible) return;
    const kinds = String(params.kinds || '').split(',').map((x) => x.trim()).filter(Boolean);
    const tpl = tplOf(TAB_TPL[tab]);
    const source = params.bible;
    // 批 8 补 4：同一入口的第二种载荷 —— 分集大纲骨架（`outline=<每集至少几拍>`）。
    // 与卡片回注共用落位逻辑，但取的是"按幕切好的集"而不是"卡片清单"。
    const outlinePer = Number(params.outline) || 0;
    syncViewParams({ bible: '', kinds: '', outline: '' });
    if (!tpl) { toast.err('当前步骤还没有提示词模板，没法带入——去设置页新建一个'); return; }
    const r = outlinePer
      ? await api.storyEpisodes({ projectId, sourceId: source, perEpisode: outlinePer })
      : await api.storyPrompt({ sourceId: source, kinds });
    if (!r.ok) { toast.err(r.error); return; }
    if (!r.data.text) {
      toast(outlinePer ? '这份原著还没有剧情卡，排不出分集骨架' : '这份原著里没有可带入的卡片', 'info');
      return;
    }
    const vars = varsOf(tpl);
    // 骨架优先落「本集大纲 / 剧情梗概」这类字段（BIBLE_VAR_KINDS 里 plot 的落点）
    const pick = pickBibleVar(vars, outlinePer ? ['plot'] : kinds, fields);
    if (!pick) {
      await notice({
        title: '没有可以落位的字段',
        lines: [
          `已经取出 <b>${esc(countLabel(r.data.text.length))}</b> 卡片文本，但「${esc(tpl.name)}」模板里的长文本框都已有内容。`,
          '可以先清空其中一个（或点结果区的「撤销带入」还原），再回来点一次「带入剧本」；也可以直接复制粘贴。',
        ],
        okText: '知道了',
      });
      return;
    }
    const prev = fields.get(pick.name) || '';
    fields.set(pick.name, r.data.text);
    upstream = { from: 'novel', field: pick.name, chars: r.data.text.length, prev };
    renderFields();
    const what = outlinePer ? `分集骨架（${r.data.episode_count} 集 / ${r.data.beat_count} 拍）` : '原著卡片';
    toast.ok(pick.matched
      ? `已把${what}带入字段「${pick.name}」——确认无误后再生成`
      : `模板里没有专门的原著字段，已把${what}带入第一个空着的长文本框「${pick.name}」`);
  }
}
