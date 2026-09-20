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
  // 批 8 补 40：这份结果区的内容是从**哪一条剧本**载入/派生的、用**哪个模板**润色的。
  // 保存时如实带上，服务端据此记下"这份稿是从哪儿来的"并算指纹（指纹一律服务端算）。
  // 用户手改过之后这两个值就"不作数了" —— 由服务端比对正文后说了算（见 optimize）。
  let resultSourceId = null;
  let resultTemplateId = null;
  // R17：每个页签各自保留自己的结果。切页签不再丢弃中间产物——"抽取出来的东西"必须回得去，
  // 否则两段式里的"确认"环节没有对象可确认（旧行为：切走即清空，模型产出只能靠手动保存留住）。
  const results = new Map(); // tab -> { text, pristine }
  // R16：本页签当前"已带入"的上游（来自上一步的确认产物）
  let upstream = null; // { from, field, chars }
  // 批 8 补 8：分集上下文。集号 + 前情提要 + 本集大纲都从**本地**分集骨架取（一次模型都不调），
  // 所以"逐集生成"可以反复跑、反复调「每集至少几拍」而不花钱。
  let epNo = 1;                      // 当前集号（单集生成与保存都用它）
  let epPlan = null;                 // { episode_count, per_episode }
  let prior = { text: '', episodes: [], omitted: [], chars: 0, truncated: false };
  // 批 8 补 12：当前这一集"生成时喂给模型的输入"的指纹（由服务端算，前端只搬运）。
  // 存剧本时带上它，之后原著追加/重切分集导致输入变了，过期体检就能如实报出来。
  let epDigest = '';
  let priorOn = true;                // 生成时是否带上前情提要
  let batchCancel = false;           // 逐集生成的取消旗标
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
        <div class="card" id="ep-card" style="margin-bottom:18px">
          <div class="row" style="margin-bottom:8px">
            <div class="card-title" style="margin:0">${icon('grid', 15)}分集</div>
            <div class="spacer"></div>
            <span class="hint-xs" id="ep-plan"></span>
          </div>
          <div id="ep-body"><div class="hint-xs">正在读取分集骨架…</div></div>
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
  picker.onchange = () => {
    projectId = picker.value; results.clear(); clearResult(); loadSaved();
    epNo = 1; loadEpisodes();
  };
  container.querySelector('#reload').onclick = () => { loadTemplates(); loadSaved(); loadEpisodes(); };
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

  /** 取分集骨架（本地计算、不调模型）：拿到集数后才能逐集生成 */
  async function loadEpisodes() {
    epPlan = null;
    prior = { text: '', episodes: [], omitted: [], chars: 0, truncated: false };
    epDigest = '';
    if (projectId) {
      const r = await api.storyEpisodes({ project_id: projectId });
      if (r.ok && r.data.episode_count) epPlan = { episode_count: r.data.episode_count, per_episode: r.data.per_episode };
    }
    if (epPlan && epNo > epPlan.episode_count) epNo = epPlan.episode_count;
    renderEpCard();
  }

  /** 渲染分集卡：没有分集骨架时给出去原著解析的路，而不是一个点不动的按钮 */
  function renderEpCard() {
    const box = container.querySelector('#ep-body');
    const planEl = container.querySelector('#ep-plan');
    if (!box) return;
    if (!projectId) {
      if (planEl) planEl.textContent = '';
      box.innerHTML = '<div class="hint-xs">先在右上角选择项目</div>';
      return;
    }
    const n = epPlan ? epPlan.episode_count : 0;
    if (planEl) planEl.textContent = n ? `共 ${n} 集 · 每集至少 ${epPlan.per_episode} 拍` : '还没有分集骨架';
    if (!n) {
      box.innerHTML = `<div class="hint-xs">这份项目还没有分集骨架（要先有<b>剧情卡</b>）：到
        <a href="#/novel?project=${encodeURIComponent(projectId)}" style="color:var(--gold-light)">原著解析</a>
        粘贴/上传小说 → 解析出卡片 → 「分集大纲」。有了骨架，这里才能逐集生成、也才有前情提要。</div>`;
      return;
    }
    box.innerHTML = `
      <div class="row wrap" style="gap:8px;align-items:center">
        <span class="hint-xs">第</span>
        <input class="input" id="ep-no" type="number" min="1" max="${n}" value="${epNo}" style="width:74px" aria-label="集数" />
        <span class="hint-xs">集</span>
        <button class="btn btn-xs" id="ep-load">${icon('download', 12)}载入本集大纲</button>
        <label class="row" style="gap:6px;align-items:center;cursor:pointer">
          <input type="checkbox" id="ep-prior"${priorOn ? ' checked' : ''} />
          <span class="hint-xs">带上前情提要</span>
        </label>
        <div class="spacer"></div>
        <button class="btn btn-xs" id="ep-stale" title="纯本地判断：哪几集的剧本是按旧的分集骨架/旧前情生成的（不调模型、不花钱）">${icon('search', 12)}过期体检</button>
        <button class="btn btn-xs" id="gen-eps" title="按分集骨架逐集生成并保存（每集一次模型调用）">${icon('wand', 12)}逐集生成</button>
      </div>
      <div class="hint-xs" id="ep-status" style="margin-top:8px"></div>
      <div id="ep-stale-box"></div>
      <div id="ep-progress"></div>`;
    const no = box.querySelector('#ep-no');
    no.onchange = () => { epNo = Math.max(1, Math.min(n, Number(no.value) || 1)); no.value = epNo; syncEpStatus(); };
    // 体检结果与"是否带前情"绑在一起（前情变了指纹就变），改了勾选必须作废重算
    box.querySelector('#ep-load').onclick = () => loadEpisodeBrief(epNo);
    box.querySelector('#ep-prior').onchange = (e) => { priorOn = !!e.target.checked; stale = null; syncEpStatus(); };
    // 先体检再开弹窗：默认范围来自"缺剧本/已过期"的那几集。体检是本地算的、不花钱，
    // 但每次点都重算一遍会让"改完范围再点一次"变慢 —— 所以算过一次就复用（体检按钮可手动刷新）
    box.querySelector('#gen-eps').onclick = async () => { if (!stale) await runStaleCheck(); openBatch(); };
    const staleBtn = box.querySelector('#ep-stale');
    if (staleBtn) staleBtn.onclick = () => runStaleCheck();
    syncEpStatus();
  }

  /** 前情状态条：让"这一集带了多少前情、省了哪几集"在生成前就可见 */
  function syncEpStatus() {
    const el = container.querySelector('#ep-status');
    if (!el) return;
    if (!prior.text) {
      el.innerHTML = epNo > 1
        ? `第 ${epNo} 集还没载入前情提要——点「载入本集大纲」会连前情一起取回（本地计算，不花钱）`
        : '第 1 集没有前情（它是开头）';
      return;
    }
    el.innerHTML = `已载入第 ${epNo} 集：前情 ${prior.episodes.length} 集 / ${prior.chars} 字`
      + `${prior.omitted.length ? `（更早的 ${prior.omitted.length} 集已省略：${esc(prior.omitted.join('、'))}）` : ''}`
      + `${priorOn ? '' : ' · <b>当前未勾选</b>，生成时不会带上'}`;
  }

  /**
   * 载入第 N 集：把该集拍表填进模板的"大纲"变量，并取回前情提要。
   * 这一步**不调模型**，所以随便点、随便换集都不会产生费用。
   */
  async function loadEpisodeBrief(ep, withPrior) {
    const tpl = tplOf(TAB_TPL[tab]);
    if (!tpl) { toast.err('这个类型还没有模板'); return null; }
    epNo = Math.max(1, Number(ep) || 1);
    const usePrior = withPrior === undefined ? priorOn : !!withPrior;
    // with_prior 必须与**实际生成时**一致：不带前情却按"带前情"取指纹，会凭空报过期
    const r = await api.storyEpisodeBrief({
      project_id: projectId, episode: epNo,
      per_episode: epPlan ? epPlan.per_episode : undefined, with_prior: usePrior ? undefined : '0',
    });
    if (!r.ok) { toast.err(r.error); return null; }
    epDigest = r.data.input_digest || '';
    // 批 8 补 37：这一集的名册与指纹是**同一份**（服务端按本集上下文算的），
    // 所以载入即采纳 —— 否则"改了角色"这件事会因为提示词与指纹各算一遍而漏报
    if (r.data.roster_text !== undefined) {
      roster = {
        count: r.data.roster_count || 0,
        text: r.data.roster_text || '',
        truncated: r.data.roster_truncated || 0,
      };
    }
    prior = {
      text: r.data.prior || '', episodes: r.data.prior_episodes || [], omitted: r.data.prior_omitted || [],
      chars: r.data.prior_chars || 0, truncated: !!r.data.prior_truncated,
    };
    if (!r.data.exists) {
      toast.err(`第 ${epNo} 集还没有拍：先在原著页确认分集骨架`);
      syncEpStatus();
      return null;
    }
    const pick = pickBibleVar(varsOf(tpl), ['plot'], fields);
    if (pick) {
      fields.set(pick.name, r.data.brief);
      const el = [...container.querySelectorAll('[data-var]')].find((x) => x.getAttribute('data-var') === pick.name);
      if (el) el.value = r.data.brief;
      syncCounters();
    }
    syncEpStatus();
    // 批 8 补 36：如实说出这份上下文里带了什么 —— 全剧设定/时间线是**跨集一致性**的锚点，
    // 而它此前只出现在「全剧大纲」那条路上，逐集生成看不见（用户以为带了、其实没带）。
    // 数字全来自服务端（不在前端复算），没带就说没带，别让用户以为带了。
    const setChars = Number(r.data.setting_chars) || 0;
    const setNote = setChars
      ? `（含全剧设定 ${Number(r.data.world_count) || 0} 张 / 时间线 ${Number(r.data.timeline_count) || 0} 张）`
      : '（这份原著还没有信息卡/时间线卡，未带全剧设定）';
    toast.ok(`已载入第 ${epNo} 集大纲${roster.count ? `（名册 ${roster.count} 个角色）` : ''}${setNote}${prior.episodes.length ? ` + 前情 ${prior.episodes.length} 集` : ''}${pick ? '' : '（没找到合适的大纲变量，可手动粘贴）'}`);
    return r.data;
  }

  /**
   * 逐集生成（批 8 补 8）：一集一次模型调用，生成完**立刻按集保存**，
   * 中途失败只记下这一集继续往下走 —— 不能因为第 7 集返回坏 JSON 就把 8〜20 集全丢掉。
   */
  /** 过期体检结果（纯本地、零模型调用）：用户要能反复看，才敢信"该重生成哪几集" */
  let stale = null;

  async function runStaleCheck() {
    const box = container.querySelector('#ep-stale-box');
    if (!projectId) { toast.err('先在右上角选一个项目'); return null; }
    const r = await api.storyStaleness({ project_id: projectId, per_episode: epPlan ? epPlan.per_episode : undefined, with_prior: priorOn ? undefined : '0' });
    if (!r.ok) { toast.err(r.error); return null; }
    stale = r.data;
    if (!box) return stale;
    const c = stale.counts || {};
    const rows = (stale.episodes || []).map((e) => {
      const label = { missing: '还没有剧本', stale: '输入已变，建议重生成', unknown: '没有生成指纹，无法判断', ok: '一致' }[e.script_state] || e.script_state;
      const badge = e.script_state === 'stale' ? 'gold' : (e.script_state === 'missing' ? 'gray' : (e.script_state === 'ok' ? 'green' : 'gray'));
      return `<div class="row" style="gap:8px;padding:3px 0">
        <span class="hint-xs" style="flex:0 0 52px">第 ${e.episode_number} 集</span>
        <span class="badge ${badge}" style="flex:0 0 auto">${esc(label)}</span>
        <span class="hint-xs" style="flex:1;min-width:0">${e.script_id ? esc(e.script_title || '已保存') : ''}${e.shots ? ` · 分镜 ${e.shots} 镜` : ' · 还没有分镜'}</span>
      </div>`;
    }).join('');
    box.innerHTML = `<div class="note" style="margin-top:8px">
      ${icon('search', 13)} 过期体检：缺剧本 <b>${c.script_missing || 0}</b> 集 · 建议重生成 <b>${c.script_stale || 0}</b> 集
      · 一致 ${(stale.episode_count || 0) - (c.script_missing || 0) - (c.script_stale || 0) - (c.script_unknown || 0)} 集
      ${c.script_unknown ? `· 无法判断 ${c.script_unknown} 集` : ''}
      <div class="divider" style="margin:6px 0"></div>${rows}
      ${(stale.notes || []).map((x) => `<div class="hint-xs" style="margin-top:4px">${esc(x)}</div>`).join('')}
    </div>`;
    return stale;
  }

  function openBatch() {
    const n = epPlan ? epPlan.episode_count : 0;
    if (!n) return;
    // 默认只生成"缺剧本或输入已变"的集：重跑一遍全都花钱，而多数集其实没变化。
    // 体检是本地算的，没跑过就先跑一次（不花钱），让默认范围有依据。
    const todo = stale ? (stale.episodes || []).filter((e) => e.script_state === 'missing' || e.script_state === 'stale').map((e) => e.episode_number) : [];
    // 取值必须在**弹窗还活着的时候**：modal 关闭后 DOM 就被摘掉了，
    // 关掉之后再去 querySelector('#b-from') 只会拿到 null —— 用户填的范围会被静默丢掉（退回全量）。
    new Promise((resolve) => {
      let settled = false;
      const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
      modal({
        title: '逐集生成',
        body: `<div class="note">将按分集骨架逐集生成，每集<b>调用一次模型</b>（共 <b id="b-n">${n}</b> 次），
          生成完立即保存为一条脚本记录（标题带集号），可在右侧「已保存脚本」逐集查看。</div>
          <div class="row wrap" style="gap:10px;margin-top:12px">
            <div class="field" style="flex:1;min-width:110px"><label for="b-from">从第几集</label><input class="input" id="b-from" type="number" min="1" max="${n}" value="${todo.length ? todo[0] : Math.min(epNo, n)}" /></div>
            <div class="field" style="flex:1;min-width:110px"><label for="b-to">到第几集</label><input class="input" id="b-to" type="number" min="1" max="${n}" value="${todo.length ? todo[todo.length - 1] : n}" /></div>
          </div>
          ${todo.length ? `<div class="hint-xs" style="margin-top:6px">默认范围来自<b>过期体检</b>（本地算的，没花钱）：这 ${todo.length} 集的剧本是"缺的"或"输入已经变了"，第 ${todo.join('、')} 集。要重跑其它集直接改上面的范围。</div>` : ''}
          <label class="row" style="gap:8px;align-items:center;margin-top:12px;cursor:pointer">
            <input type="checkbox" id="b-prior"${priorOn ? ' checked' : ''} />
            <span class="hint-xs">带上前情提要（越往后越重要：每集都能看见前面发生了什么，本地计算、不额外花钱）</span>
          </label>
          <div class="hint-xs" style="margin-top:8px">中途可以取消：已经生成的集会保留，没轮到的不会调用。</div>`,
          footer: `<button class="btn" data-no>取消</button><button class="btn btn-primary" data-yes>开始生成</button>`,
          onDismiss: () => settle(null), // ESC / 遮罩 / × 关闭都算取消，不静默挂起
          onMount(root, close) {
            root.querySelector('[data-no]').onclick = () => { settle(null); close(); };
            root.querySelector('[data-yes]').onclick = () => {
              const from = Math.max(1, Math.min(n, Number(root.querySelector('#b-from').value) || 1));
              const to = Math.max(from, Math.min(n, Number(root.querySelector('#b-to').value) || n));
              const withPrior = !!root.querySelector('#b-prior').checked;
              settle({ from, to, withPrior });
              close();
            };
          },
        });
    }).then((cfg) => { if (cfg) runBatch(cfg.from, cfg.to, cfg.withPrior); });
  }

  async function runBatch(from, to, withPrior) {
    if (generating) { toast.err('正在生成中，等这一次结束再开始逐集生成'); return; }
    const tpl = tplOf(TAB_TPL[tab]);
    if (!tpl) return;
    if (!state.settings.agnes_api_key) { toast.err('还没配置 Agnes API Key，请到「设置」页填写。'); return; }
    const btn = container.querySelector('#gen-eps');
    const box = container.querySelector('#ep-progress');
    const total = to - from + 1;
    const done = [];   // { ep, ok, error }
    batchCancel = false;
    generating = true;
    if (btn) btn.disabled = true;
    const paint = (cur, note) => {
      if (!box) return;
      const okN = done.filter((d) => d.ok).length;
      const badN = done.length - okN;
      box.innerHTML = `<div class="divider"></div>
        <div class="row" style="gap:10px;align-items:center">
          ${cur ? '<div class="spinner sm"></div>' : ''}
          <span style="font-size:12.5px">${esc(note)}</span>
          <div class="spacer"></div>
          <span class="hint-xs">成功 ${okN} · 失败 ${badN} / 共 ${total}</span>
          ${cur ? '<button class="btn btn-xs" id="b-stop">取消</button>' : ''}
        </div>
        ${done.length ? `<div class="hint-xs" style="margin-top:6px">${done.map((d) => `${d.ok ? '✓' : '✗'}第 ${d.ep} 集`).join(' · ')}</div>` : ''}`;
      const stop = box.querySelector('#b-stop');
      if (stop) stop.onclick = () => { batchCancel = true; stop.disabled = true; stop.textContent = '正在取消…'; };
    };
    for (let ep = from; ep <= to; ep++) {
      if (batchCancel) { paint(null, '已取消'); break; }
      paint(ep, `正在生成第 ${ep} 集…`);
      try {
        const brief = await loadEpisodeBrief(ep, withPrior);
        if (!brief) { done.push({ ep, ok: false, error: '这一集没有拍' }); continue; }
        if (!withPrior) prior = { text: '', episodes: [], omitted: [], chars: 0, truncated: false };
        // 名册已经随 brief 带回来了（与 epDigest 同源），这里**不再现算** —— 现算会用
        // 更大的文本重排名册，于是提示词里的名册与指纹里的名册不是同一份（补 37 的病根）
        const r = await api.genText({
          messages: buildMessages(tpl),
          model: container.querySelector('#model').value,
          project_id: projectId || null,
          note: `${tpl.name} 第 ${ep} 集`,
          json_mode: true,
        });
        if (!r.ok) { done.push({ ep, ok: false, error: r.error }); continue; }
        const content = r.data.content || '';
        const savedR = await api.createScript({
          project_id: projectId,
          script_type: tab,
          episode_number: ep,
          title: `${SCRIPT_TYPES.find((t) => t.value === tab)?.label || '脚本'} 第 ${ep} 集`,
          content,
          model_name: container.querySelector('#model')?.value || '',
          generation_prompt: '',
          plan_digest: epDigest,   // 这一集生成时的输入指纹（服务端算的）
        });
        if (!savedR.ok) { done.push({ ep, ok: false, error: savedR.error }); continue; }
        // 结果区停在最后一集，用户可以直接看/改（逐集产物都已经存好了）
        result = content; pristine = content; resultCtx = { projectId, tab };
        resultSourceId = null; resultTemplateId = null; // 刚生成的是"本集上下文"的产物，不是派生稿
        stashResult(); renderResult();
        done.push({ ep, ok: true });
      } catch (e) {
        done.push({ ep, ok: false, error: (e && e.message) || String(e) });
      }
    }
    generating = false;
    if (btn) btn.disabled = false;
    const okN = done.filter((d) => d.ok).length;
    const bad = done.filter((d) => !d.ok);
    paint(null, batchCancel ? '已取消' : '逐集生成结束');
    loadSaved();
    if (bad.length) toast.err(`完成 ${okN} 集，${bad.length} 集失败：${bad.map((d) => `第 ${d.ep} 集（${d.error}）`).join('；')}`, 9000);
    else toast.ok(`逐集生成完成：${okN} 集已保存`);
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

  /**
   * 角色名册（批 8 补 6）：模型不知道项目里已有哪些角色，于是同一部剧里"女主/苏婉儿/婉儿"混着写，
   * 下游的镜头绑定谁也匹配不上、谁都没有外貌注入（同一张脸在几十个镜头里各长一样，且不报错）。
   * 把名册写进请求体是从源头对齐名字。**只有名字进提示词**，长相由系统在使用点统一注入。
   *
   * 批 8 补 37：渲染**只在服务端一处**（`story.characterRoster`）—— 名册是喂给模型的输入，
   * 而"输入变了要报过期"靠服务端算的指纹，两处各写一遍排序/截断迟早会出现
   * "提示词里的名册与指纹里的名册不是同一份"。载入某一集时用**那一集服务端算好的那份**
   * （与 `input_digest` 同源），没载入（没有指纹）才现算一份。
   */
  let roster = { count: 0, text: '', truncated: 0 };
  async function refreshRoster() {
    if (!projectId) { roster = { count: 0, text: '', truncated: 0 }; return roster; }
    const r = await api.storyRoster({
      project_id: projectId,
      text: [].concat(...[...fields.values()]).join('\n'),
    });
    roster = r.ok
      ? { count: r.data.count, text: r.data.text, truncated: r.data.truncated }
      : { count: 0, text: '', truncated: 0 };
    return roster;
  }

  /** 变量替换后的实际请求体：计数与发送共用同一份，避免"显示的字数"和"发出的字数"两套算法 */
  function buildMessages(tpl) {
    let prompt = tpl.content || '';
    for (const [k, v] of fields) prompt = prompt.split(`{{${k}}}`).join(v || '');
    prompt = prompt.replace(/\{\{[^}]+\}\}/g, '（未填写）');
    // 名册（谁）→ 前情（已经发生了什么）→ 任务本身（放最后，注意力最强）
    const ctx = [roster.text, priorOn ? prior.text : ''].filter(Boolean);
    if (ctx.length) prompt = `${ctx.join('\n\n')}\n\n${prompt}`;
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
    // 门禁计数与真正发出的请求体必须包含同一份内容。载入过某一集时，名册已经随 brief
    // 带回来且与 input_digest 同源 —— 再现算一遍会让"提示词里的名册"与"指纹里的名册"分叉
    // （要换名册就重新载入那一集，载入是纯本地的、不花钱）
    if (!epDigest) await refreshRoster();
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
    resultSourceId = null; resultTemplateId = null; // 结果没了，派生关系一并作废
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
        episode_number: epNo,
        title: `${SCRIPT_TYPES.find((t) => t.value === tab)?.label || '脚本'}${epNo > 1 ? ` 第 ${epNo} 集` : ''} - ${new Date().toLocaleDateString('zh-CN')}`,
        content: result,
        model_name: container.querySelector('#model')?.value || '',
        generation_prompt: '',
        plan_digest: epDigest,
        // 批 8 补 40：这份内容是从哪一条、用哪个优化模板派生的。指纹由**服务端**按它自己库里
        // 那份来源正文算（前端说了不算）—— 这样判定时用同一个函数复算，两边必然同源。
        // **有模板才算派生稿**：单纯"载入某一条再保存"只是它的副本，不是润色产物，
        // 声称派生却记不出模板，只会让体检多一条"未验"的噪音。
        source_script_id: resultTemplateId ? (resultSourceId || null) : null,
        source_template_id: resultTemplateId || null,
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

  /**
   * 润色（批 8 补 40）：**合成在服务端**，这里只负责发起与落结果。
   *
   * 从前是页面自己拼 prompt 再走 `/api/agnes/text` —— 那个端点把 messages 原样转发，
   * 服务端看不到发出去的那一份，于是"来源文本 + 模板 + 名册"三样输入**一样都进不了指纹**：
   * 改了来源剧本、或改了优化模板、或改了角色外貌，润色稿静默过期，而它带着本集上下文的
   * 指纹报到"没过期"。合成搬到服务端之后，"发出去的"与"记指纹的"由构造保证是同一份。
   */
  async function optimize(tpl) {
    if (!tpl || !result || generating) return;
    generating = true;
    const st = container.querySelector('#gen-status');
    st.innerHTML = `<div class="row" style="margin-top:12px;color:var(--gold-light)"><div class="spinner sm"></div><span style="font-size:12.5px">正在${esc(tpl.name)}…</span></div>`;
    let r;
    try {
      r = await api.polishScript({
        project_id: projectId || null,
        template_id: tpl.id,
        source_text: result,
        // 只有在"这份文本就是从某条剧本载入的、且没被改过"时才说得出源 —— 改过的话服务端
        // 比对正文后会把 source_script_id 判成 null（它不冒充是那一条的派生物）
        source_script_id: resultSourceId || null,
      });
    } finally {
      generating = false;
      st.innerHTML = '';
    }
    if (!r.ok) { toast.err(r.error); return null; }
    result = r.data.content || result;
    pristine = result; // 润色产出的也是一份"原样"，撤销改动回到这里而不是更早的版本
    resultCtx = { projectId, tab }; // 润色后同样盖上下文戳
    // 服务端说了算：来源正文对得上才记来源；对不上就记 null（保存时留空 = 体检说"不知道"，
    // 而不是按那一条复算出永远对不上的指纹 → 天天喊狼来了）
    resultSourceId = r.data.source_script_id || null;
    resultTemplateId = r.data.template_id || null;
    stashResult();
    renderResult();
    const how = r.data.source_matches_row
      ? `来源：${r.data.source_chars} 字的那一条`
      : '来源是编辑过的草稿（不记来源，过期体检只能说"不知道"）';
    toast.ok(`已${tpl.name} · ${how} · 角色名册 ${r.data.roster_count} 人`, 6000);
    return r.data;
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
            <div style="font-size:12.5px;font-weight:550">${s.episode_number ? `<span class="chip" style="margin-right:6px">第 ${s.episode_number} 集</span>` : ''}${esc(s.title)}${s.source_script_id ? '<span class="chip" style="margin-left:6px" title="这是从另一条剧本润色出来的稿子，不是本集直接生成的">润色稿</span>' : ''}${s.polish_state === 'stale' ? `<button type="button" class="prompt-tag prompt-stale" data-repolish="${esc(s.id)}" title="来源剧本/优化模板/角色名册改过了，这份稿还是按改动之前的来源润色的" style="margin-left:6px;cursor:pointer">来源已变·点此重润</button>` : ''}${s.polish_state === 'unknown' ? '<span class="prompt-tag" style="margin-left:6px" title="这份润色稿没有记下来源指纹（本轮之前润色的，或来源是编辑过的草稿）">未验</span>' : ''}</div>
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
        if (s) {
          result = s.content; pristine = s.content; resultCtx = { projectId, tab: s.script_type || tab };
          resultSourceId = s.id; resultTemplateId = null; // 载入的是"某一条"本身：它没有模板来源
          stashResult(); renderResult(); toast.ok('已载入');
        }
      };
    });
    // 批 8 补 40：「来源已变」的出口**就在标记旁边**。重润要用**它自己记下的那个模板**，
    // 不是让用户去猜当初用的是哪一个（猜错就是另一份东西）。
    el.querySelectorAll('[data-repolish]').forEach((b) => {
      b.onclick = async () => {
        const s = saved.find((x) => x.id === b.getAttribute('data-repolish'));
        if (!s) return;
        const tpl = templates.find((t) => t.id === s.source_template_id);
        if (!tpl) { toast.err('当初用的优化模板已经删了——请从下面的优化按钮里挑一个重做'); return; }
        if (s.content !== result) {
          if (!(await confirm({ text: `重润要用「${tpl.name}」重跑一次模型，会覆盖当前结果区（未保存的改动会丢）。继续？`, okText: '重润' }))) return;
        }
        // 重润的**来源是那一条来源剧本**（不是这份已经过期的润色稿）：这样重跑出来的
        // 才是"按当前来源"的那一份，而不是"在旧产物上再润一遍"
        const src = saved.find((x) => x.id === s.source_script_id);
        if (!src) { toast.err('来源剧本已经不在了——这份稿只能删掉或改成手写'); return; }
        result = src.content; pristine = src.content; resultSourceId = src.id; resultTemplateId = null;
        stashResult(); renderResult();
        const data = await optimize(tpl);
        if (!data) return;
        // **就地更新这一条**，不再另存一条：重润是"把这份派生稿刷新到当前来源"，
        // 另存会让每重润一次就多一份，而那份旧的过期稿永远挂在那儿继续报过期
        const up = await api.updateScript(s.id, {
          content: data.content,
          source_script_id: data.source_script_id,
          source_template_id: data.template_id,
        });
        if (up.ok) { toast.ok('已就地重润（更新原记录，没有另存一条）'); loadSaved(); }
        else toast.err(up.error);
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
  await loadEpisodes();
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
