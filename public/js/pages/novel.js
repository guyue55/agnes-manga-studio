/**
 * novel.js — 原著解析（批 8）
 *
 * 这个页面存在的理由：竞品（04 号包）能"粘贴小说 → 出剧本"，但只抽两个字段、只调一次模型、
 * 原文**截断到 1 万字**，而且**全包零持久化**——刷新一下，粘的 1 万字和手改的人物全丢。
 * 所以这里的每一处设计都对着那几个具体缺陷：
 *   ① 原文落库（`story_sources`），刷新/切页/重开浏览器都还在，可从解析记录一键载回输入框；
 *   ② 干跑（`/api/story/plan`）先算"分 N 段、发 N+1 次调用、覆盖 X/Y 字"，**用户确认后**才真花钱；
 *   ③ 覆盖不全就**明说**（"本次只解析了前 N 字"），不学竞品"截断了却宣称已解析全书"；
 *   ④ 六类卡片（信息卡/人物卡/地点卡/道具卡/剧情卡/时间线）就地可改可删——
 *      模型抽错一个字不必重烧整本原著（重烧 = 重新计费 + 丢掉所有人工修改）；
 *   ⑤ 反向驱动：人物卡一键进资产库（拿到参考图与分镜注入能力），任意卡片组一键复制回注文本。
 */
import { api } from '../api.js';
import {
  esc, icon, fmtTime,
  STORY_CARD_KINDS, STORY_CARD_FIELDS, STORY_CARD_FIELD_LABELS, STORY_ROLE_OPTIONS, STORY_STAGE_OPTIONS,
  storyKindLabel,
} from '../consts.js';
import { toast, confirm, costConfirm, empty, skeleton, setBusy, errBox, on, dataOf, options } from '../ui.js';
import { charCount, countLabel, limitState } from '../textstats.js';
import { head, projectPicker, renderBatchBar } from './helpers.js';
import { state, onEvent, syncViewParams } from '../app.js';
import { parseStoryText } from '../storyfile.js';

const JOB_KEY = 'agnes.novel.job'; // 解析任务 id：刷新/切页回来能续上进度（与分镜批量的做法一致）
const TEXT_SOFT = 60000;           // 输入框软上限：超了不拦，只提示"会分很多段、花很多次调用"

export default async function novel(container, params = {}) {
  let projectId = params.project_id || state.projects[0]?.id || '';
  let sourceId = params.source_id || '';   // 当前工作台对着哪一份原著
  let kindFilter = params.kind || '';      // 卡片分组筛选（'' = 全部）
  let sources = [];
  let cards = [];
  let plan = null;                          // 干跑结果：null = 还没算过 / 原文变了就作废
  let job = null;
  let editingId = null;                     // 正在就地编辑的卡片 id
  let armedDel = '';                        // 已按过一次删除的卡片 id（两击确认）

  container.innerHTML = `
    ${head({
      title: '原著解析',
      desc: '粘贴或上传故事/小说，自动抽取人物卡、地点卡、道具卡、剧情卡等信息卡，反向驱动剧本、资产库与分镜',
      actions: `${projectPicker(state.projects, projectId, { id: 'p-picker' })}
        <button class="btn btn-sm" id="reload">${icon('refresh', 14)}刷新</button>`,
    })}
    <div class="grid" style="grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:20px">
      <div>
        <div class="card">
          <div class="row" style="margin-bottom:10px">
            <div class="card-title" style="margin:0">${icon('book', 15)}原著原文</div>
            <div class="spacer"></div>
            <label class="btn btn-xs" for="nov-file" title="在浏览器本地读取，不上传服务器">${icon('upload', 13)}选择文件</label>
            <input type="file" id="nov-file" accept=".txt,.md,.markdown,text/plain" style="display:none" />
          </div>
          <div class="field" style="margin-bottom:8px">
            <input class="input" id="nov-title" placeholder="给这份原著起个名字（便于在解析记录里区分）" />
          </div>
          <textarea class="textarea" id="nov-text" rows="12" aria-label="原著原文"
            placeholder="把小说/故事原文粘贴到这里（支持几万字，会自动分块解析）…"></textarea>
          <div class="row" style="margin-top:6px">
            <span class="hint-xs" id="nov-count"></span>
            <div class="spacer"></div>
            <span class="hint-xs">.txt / .md 在浏览器本地读取，原文只存在你本机</span>
          </div>
          <div class="divider"></div>
          <div class="row wrap">
            <button class="btn" id="nov-plan">${icon('search', 14)}先算一算</button>
            <button class="btn btn-primary" id="nov-run" style="flex:1;min-width:150px">${icon('sparkles', 14)}开始解析</button>
          </div>
          <div id="nov-plan-box"></div>
          <div id="batch-bar" style="margin-top:10px"></div>
        </div>

        <div class="card" style="margin-top:18px">
          <div class="card-title">${icon('history', 15)}解析记录</div>
          <div id="nov-sources">${skeleton('row', 2)}</div>
        </div>
      </div>

      <div>
        <div class="card">
          <div class="row" style="margin-bottom:10px">
            <div class="card-title" style="margin:0">${icon('layers', 15)}卡片工作台</div>
            <div class="spacer"></div>
            <button class="btn btn-xs" id="nov-copy" title="把卡片回注文本复制到剪贴板（粘进任意模板变量）">${icon('copy', 13)}复制回注</button>
            <button class="btn btn-xs btn-primary" id="nov-toscript" title="把卡片带入「故事脚本」的模板变量，不用手工复制粘贴">${icon('arrowRight', 13)}带入剧本</button>
            <button class="btn btn-xs" id="nov-import" title="把这份原著里的人物卡批量写进角色库">${icon('users', 13)}人物入资产库</button>
          </div>
          <div id="nov-kinds" class="chips wrap" style="margin-bottom:10px"></div>
          <div id="nov-cards">${skeleton('card', 2)}</div>
        </div>
      </div>
    </div>`;

  // ── 输入框 ──────────────────────────────────────────────
  const textEl = container.querySelector('#nov-text');
  const titleEl = container.querySelector('#nov-title');
  textEl.oninput = () => {
    plan = null;               // 原文一变，上次的"要花几次调用"就作废——不许拿旧数字给新原文背书
    renderPlanBox();
    syncCount();
  };
  titleEl.oninput = () => syncCount();

  function syncCount() {
    const n = charCount(textEl.value);
    const st = limitState(n, TEXT_SOFT);
    const el = container.querySelector('#nov-count');
    el.textContent = n ? `原文 ${countLabel(n)}${st.over ? '（偏长，会分很多段、花很多次调用）' : ''}` : '';
    el.classList.toggle('over', st.over);
  }

  container.querySelector('#nov-file').onchange = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = await parseStoryText(f);
    e.target.value = ''; // 同一个文件改完再选一次也要能触发
    if (!r.ok) { toast.err(r.error); return; }
    textEl.value = r.text;
    if (!titleEl.value.trim()) titleEl.value = f.name.replace(/\.[^.]+$/, '');
    plan = null;
    renderPlanBox();
    syncCount();
    toast.ok(`已读入 ${countLabel(r.text.length)}（${r.note}）`);
  };

  // ── 干跑：先告诉用户"要花几次调用"，再决定要不要花 ──────
  container.querySelector('#nov-plan').onclick = async () => {
    const text = textEl.value.trim();
    if (!text) { toast.err('先把原著原文粘贴进来'); return; }
    const btn = container.querySelector('#nov-plan');
    setBusy(btn, true, '计算中');
    const r = await api.storyPlan({ text });
    setBusy(btn, false);
    if (!r.ok) { toast.err(r.error); return; }
    plan = r.data;
    renderPlanBox();
  };

  function renderPlanBox() {
    const box = container.querySelector('#nov-plan-box');
    if (!plan) { box.innerHTML = ''; return; }
    const p = plan;
    const cover = p.covered_chars === p.total_chars
      ? `覆盖全文 ${countLabel(p.total_chars)}`
      : `<b class="warn">只覆盖前 ${countLabel(p.covered_chars)} / ${countLabel(p.total_chars)}</b>`;
    box.innerHTML = `
      <div class="note ${p.truncated ? 'orange' : 'gold'}" style="margin-top:10px">
        将分 <b>${p.chunk_count}</b> 段解析，共调用模型 <b>${p.calls}</b> 次（含全局归并 1 次）· ${cover}
        ${p.truncated ? `<br>原文超出单次解析上限（最多 ${p.max_chunks} 段），本次<b>只会解析前面的部分</b>；想全覆盖请分段提交。` : ''}
      </div>`;
  }

  // ── 真跑 ────────────────────────────────────────────────
  container.querySelector('#nov-run').onclick = async () => {
    const text = textEl.value.trim();
    if (!projectId) { toast.err('先在右上角选择项目——卡片要挂在项目上才能驱动剧本和分镜'); return; }
    if (!text) { toast.err('先把原著原文粘贴进来'); return; }
    if (!plan) { // 没干跑过就先算一次：宁可多一次本地计算，也不让用户在不知情下花钱
      const r = await api.storyPlan({ text });
      if (!r.ok) { toast.err(r.error); return; }
      plan = r.data;
      renderPlanBox();
    }
    const note = plan.truncated
      ? `原文较长，本次只解析前 ${countLabel(plan.covered_chars)}（共 ${countLabel(plan.total_chars)}）。`
      : `覆盖全文 ${countLabel(plan.total_chars)}。`;
    const go = await costConfirm({ count: plan.calls, what: '原著解析', note: `${note}分 ${plan.chunk_count} 段抽取后做一次全局归并。` });
    if (!go) return;
    const btn = container.querySelector('#nov-run');
    setBusy(btn, true, '提交中');
    const r = await api.storyAnalyze({ project_id: projectId, title: titleEl.value.trim() || '未命名原著', text });
    setBusy(btn, false);
    if (!r.ok) { toast.err(r.error); return; }
    localStorage.setItem(JOB_KEY, r.data.jobId);
    sourceId = r.data.source.id;
    syncViewParams({ source_id: sourceId, kind: '' });
    kindFilter = '';
    toast.ok(`已开始解析：${r.data.chunk_count} 段 + 全局归并`, 'info');
    pollJob(r.data.jobId);
    loadSources();
  };

  // 进度：优先 SSE 推送；同时保留"任务不在本页发起"（刷新后）时的兜底轮询
  const offBatch = onEvent('batch', (j) => {
    if (!job || j.id !== job.id) return;
    job = j;
    renderBatchBar(container.querySelector('#batch-bar'), j, cancelJob);
    if (j.status !== 'running') onJobDone(j);
  });

  const cancelJob = () => {
    if (!job?.id) return;
    api.cancelBatch(job.id).then((r) => { if (r.ok) toast('已请求取消——在跑的那条完成后就停', 'info'); else toast.err(r.error); });
  };

  async function pollJob(id) {
    const r = await api.batch(id);
    if (!r.ok) { localStorage.removeItem(JOB_KEY); toast.err(r.error); return; }
    job = r.data;
    renderBatchBar(container.querySelector('#batch-bar'), job, cancelJob);
    if (job.status === 'running') setTimeout(() => { if (job?.status === 'running') pollJob(id); }, 1500);
    else onJobDone(job);
  }

  let doneFor = ''; // 防重：SSE 与轮询可能同时报"结束"，卡片列表不能被刷两遍
  function onJobDone(j) {
    if (doneFor === j.id) return;
    doneFor = j.id;
    localStorage.removeItem(JOB_KEY);
    loadSources();
    if (sourceId) loadCards();
    if (j.status === 'done') toast.ok(`解析完成：成功 ${j.ok} 项${j.fail ? `，失败 ${j.fail} 项（可在卡片列表重试或手动补）` : ''}`);
    else if (j.status === 'cancelled') toast('解析已取消——已抽出的卡片仍然保留', 'info');
  }

  // 刷新/切页回来：任务可能还在跑，续上进度条
  (async () => {
    const saved = localStorage.getItem(JOB_KEY);
    if (!saved) return;
    const r = await api.batch(saved);
    if (!r.ok) { localStorage.removeItem(JOB_KEY); return; } // 服务重启后旧 job 已蒸发，别拿 404 骚扰
    if (r.data.status === 'running') { job = r.data; renderBatchBar(container.querySelector('#batch-bar'), job, cancelJob); pollJob(saved); }
    else localStorage.removeItem(JOB_KEY);
  })();

  // ── 解析记录 ────────────────────────────────────────────
  async function loadSources() {
    const box = container.querySelector('#nov-sources');
    const r = await api.storySources(projectId);
    if (!r.ok) { box.innerHTML = errBox(r.error, '解析记录没取到', r.trace); return; }
    sources = r.data || [];
    if (!sources.length) {
      box.innerHTML = `<div class="card">${empty('还没有解析记录', '粘贴一段故事原文，点「开始解析」就会在这里留下记录——原文会存在本机，刷新不丢', 'book', { label: '去粘贴原文', act: 'focus-text' })}</div>`;
      const fb = box.querySelector('[data-act="focus-text"]');
      if (fb) fb.onclick = () => { textEl.scrollIntoView({ block: 'center' }); textEl.focus(); };
      return;
    }
    box.innerHTML = sources.map((s) => `
      <div class="card" style="margin-bottom:10px;padding:12px;${s.id === sourceId ? 'border-color:var(--accent)' : ''}" data-src="${esc(s.id)}">
        <div style="flex:1;min-width:0">
          <div class="row" style="gap:6px">
            <b>${esc(s.title || '未命名原著')}</b>
            ${statusChip(s)}
          </div>
          <div class="hint-xs">${esc(s.preview || '')}</div>
          <div class="hint-xs">${countLabel(s.chars)} · ${s.chunk_count} 段 · ${s.card_count} 张卡片 · ${fmtTime(s.created_at)}</div>
        </div>
        <div class="row" style="gap:4px;margin-top:6px">
          <button class="btn btn-xs" data-load="${esc(s.id)}">载入原文</button>
          <div class="spacer"></div>
          <button class="btn btn-xs btn-danger" data-del="${esc(s.id)}">${icon('trash', 12)}删除</button>
        </div>
      </div>`).join('');

    on(box, '[data-src]', 'click', (e) => {
      const el = e.currentTarget;
      const id = dataOf(el, 'src');
      if (id !== sourceId) pickSource(id);
    });
    on(box, '[data-load]', 'click', async (e) => {
      e.stopPropagation();
      const el = e.currentTarget;
      const r2 = await api.storySource(dataOf(el, 'load'));
      if (!r2.ok) { toast.err(r2.error); return; }
      textEl.value = r2.data.text || '';
      titleEl.value = r2.data.title || '';
      plan = null;
      renderPlanBox();
      syncCount();
      pickSource(r2.data.id);
      toast.ok('已把原文载回输入框——可以改完再解析一次');
    });
    on(box, '[data-del]', 'click', async (e) => {
      e.stopPropagation();
      const el = e.currentTarget;
      const id = dataOf(el, 'del');
      const s = sources.find((x) => x.id === id) || {};
      const r2 = await confirm({
        title: '删除这份原著？',
        text: `「${esc(s.title || '未命名原著')}」及其 <b>${s.card_count || 0}</b> 张卡片会一起删除，无法撤销。已经写进角色库的角色不受影响。`,
        okText: '删除', danger: true,
      });
      if (!r2) return;
      const d = await api.deleteStorySource(id);
      if (!d.ok) { toast.err(d.error); return; }
      if (sourceId === id) { sourceId = ''; syncViewParams({ source_id: '' }); cards = []; renderCards(); }
      toast.ok(`已删除（连带 ${d.data.removed_cards || 0} 张卡片）`);
      loadSources();
    });
  }

  function statusChip(s) {
    // 只用既有的 .chip / .chip.on 两个变体（本项目没有 chip.danger/warn 这种类），
    // 失败态靠文案 + title 说明，不靠颜色——颜色在小尺寸 chip 上本来也读不出来
    if (s.status === 'analyzing') return `<span class="chip on">解析中…</span>`;
    if (s.status === 'failed') return `<span class="chip on" title="${esc(s.error_message || '解析失败')}">解析失败（悬停看原因）</span>`;
    if (s.failed_chunks) return `<span class="chip on" title="有 ${s.failed_chunks} 段没抽出来">部分失败 ${s.failed_chunks} 段</span>`;
    return `<span class="chip">已解析</span>`;
  }

  function pickSource(id) {
    sourceId = id;
    editingId = null;
    syncViewParams({ source_id: id });
    loadSources();
    loadCards();
  }

  // ── 卡片工作台 ──────────────────────────────────────────
  async function loadCards() {
    const box = container.querySelector('#nov-cards');
    const r = await api.storyCards({ sourceId: sourceId || undefined, projectId: sourceId ? undefined : projectId });
    if (!r.ok) { box.innerHTML = errBox(r.error, '卡片没取到', r.trace); return; }
    cards = r.data || [];
    renderKindChips();
    renderCards();
  }

  function renderKindChips() {
    const box = container.querySelector('#nov-kinds');
    const count = (k) => cards.filter((c) => c.kind === k).length;
    box.innerHTML = `<button class="chip${kindFilter === '' ? ' on' : ''}" data-kind="">全部 ${cards.length}</button>`
      + STORY_CARD_KINDS.filter((k) => count(k)).map((k) =>
        `<button class="chip${kindFilter === k ? ' on' : ''}" data-kind="${k}">${esc(storyKindLabel(k))} ${count(k)}</button>`).join('');
    on(box, '[data-kind]', 'click', (e) => {
      kindFilter = dataOf(e.currentTarget, 'kind');
      syncViewParams({ kind: kindFilter });
      renderKindChips();
      renderCards();
    });
  }

  function renderCards() {
    const box = container.querySelector('#nov-cards');
    if (!cards.length) {
      box.innerHTML = `<div class="card">${empty(
        sourceId ? '这份原著还没抽出卡片' : '还没有卡片',
        sourceId ? '可能是这一段没有可抽取的信息，或者解析失败了——看左侧记录的提示' : '选一份解析记录，或粘贴原文开始解析',
        'layers',
        sourceId ? { label: '看解析记录', act: 'to-sources' } : { label: '去粘贴原文', act: 'focus-text' })}</div>`;
      const eb = box.querySelector('[data-act]');
      if (eb) eb.onclick = () => {
        if (eb.getAttribute('data-act') === 'to-sources') container.querySelector('#nov-sources').scrollIntoView({ block: 'center' });
        else { textEl.scrollIntoView({ block: 'center' }); textEl.focus(); }
      };
      return;
    }
    const shown = kindFilter ? cards.filter((c) => c.kind === kindFilter) : cards;
    box.innerHTML = shown.map(cardHtml).join('');
    on(box, '[data-edit]', 'click', (e) => { editingId = dataOf(e.currentTarget, 'edit'); renderCards(); });
    on(box, '[data-cancel]', 'click', () => { editingId = null; renderCards(); });
    on(box, '[data-save]', 'click', async (e) => {
      const id = dataOf(e.currentTarget, 'save');
      const patch = collectEdits(id);
      if (!patch.name.trim()) { toast.err('名字不能为空——下游全靠名字对上号'); return; }
      const r = await api.updateStoryCard(id, patch);
      if (!r.ok) { toast.err(r.error); return; }
      editingId = null;
      toast.ok('已保存——下次回注会带上你的修改');
      loadCards();
    });
    // 就地两击确认（与 ui.js 的 twoClick 同语义，但这里是事件委托，所以自己管一个 armedDel）：
    // 删一张卡不值得弹窗打断，但也不能一击就没
    on(box, '[data-del-card]', 'click', async (e) => {
      const el = e.currentTarget;
      const id = dataOf(el, 'delCard');
      if (armedDel !== id) {
        armedDel = id;
        el.classList.add('btn-danger', 'armed');
        el.textContent = '再点一次';
        setTimeout(() => { if (armedDel === id) { armedDel = ''; renderCards(); } }, 3000);
        return;
      }
      armedDel = '';
      const c = cards.find((x) => x.id === id) || {};
      const r = await api.deleteStoryCard(id);
      if (!r.ok) { toast.err(r.error); return; }
      toast.ok(`已删除「${c.name || ''}」`);
      loadCards();
    });
    on(box, '[data-tochar]', 'click', async (e) => {
      const id = dataOf(e.currentTarget, 'tochar');
      const btn = e.currentTarget;
      setBusy(btn, true, '导入中');
      const r = await api.storyCardToCharacter(id, { project_id: projectId });
      setBusy(btn, false);
      if (!r.ok) { toast.err(r.error); return; }
      toast.ok(r.data.deduped ? '这个角色已经在资产库里了（已跳过）' : '已写进角色库——去角色库挂参考图、上锁外貌');
      loadCards();
    });
  }

  /** 当前作用域：选了某个分组就只带这一类，否则带全部 */
  function scopeKinds() { return kindFilter ? [kindFilter] : []; }
  function scopeLabel() { return kindFilter ? storyKindLabel(kindFilter) : '全部卡片'; }

  // 复制回注文本：粘进任意模板变量（跨页带入不适用时的通用出口）
  container.querySelector('#nov-copy').onclick = async () => {
    const kinds = scopeKinds();
    const r = await api.storyPrompt({ sourceId: sourceId || undefined, projectId: sourceId ? undefined : projectId, kinds });
    if (!r.ok) { toast.err(r.error); return; }
    if (!r.data.text) { toast('还没有可回注的卡片——先解析一份原著', 'info'); return; }
    try {
      await navigator.clipboard.writeText(r.data.text);
      toast.ok(`已复制${scopeLabel()}的回注文本（${r.data.count} 张卡 / ${countLabel(r.data.text.length)}）——粘贴进剧本或分镜模板的变量框即可`);
    } catch { toast.err('复制失败——浏览器没给剪贴板权限，请手动选中'); }
  };

  // 带入剧本：跳到故事脚本页并把文本落到合适的模板变量（消费端在 scripts.js 的 applyBible）
  container.querySelector('#nov-toscript').onclick = () => {
    if (!sourceId) { toast.err('先在左侧选中一份解析记录'); return; }
    if (!cards.length) { toast.err('这份原著还没有卡片可带入'); return; }
    const kinds = scopeKinds();
    const q = new URLSearchParams({ project: projectId, tab: 'episode_script', bible: sourceId });
    if (kinds.length) q.set('kinds', kinds.join(','));
    // 用 hash 传参而不是共享内存：可刷新、可分享、可回退（app.js 的路由本来就读这些参数）
    location.hash = `#/scripts?${q.toString()}`;
    toast(`正在把${scopeLabel()}带入「单集脚本」——没有对应字段时会落在第一个空着的长文本框`, 'info', 5000);
  };

  function cardHtml(c) {
    const editing = c.id === editingId;
    const fields = STORY_CARD_FIELDS[c.kind] || [];
    if (editing) {
      return `
        <div class="card" style="margin-bottom:10px" data-card="${esc(c.id)}">
          <div class="row" style="margin-bottom:8px">
            <span class="chip on">${esc(storyKindLabel(c.kind))}</span>
            <div class="spacer"></div>
            <button class="btn btn-xs" data-cancel>取消</button>
            <button class="btn btn-xs btn-primary" data-save="${esc(c.id)}">保存</button>
          </div>
          <div class="field"><label for="e-name-${esc(c.id)}">名字</label>
            <input class="input" id="e-name-${esc(c.id)}" data-f="name" value="${esc(c.name)}" /></div>
          <div class="field"><label for="e-sum-${esc(c.id)}">摘要</label>
            <textarea class="textarea" id="e-sum-${esc(c.id)}" data-f="summary" rows="3">${esc(c.summary || '')}</textarea></div>
          ${fields.map((f) => `<div class="field"><label for="e-${esc(f)}-${esc(c.id)}">${esc(STORY_CARD_FIELD_LABELS[f] || f)}</label>
            ${f === 'role'
              ? `<select class="select" id="e-${esc(f)}-${esc(c.id)}" data-f="${esc(f)}">${options(STORY_ROLE_OPTIONS.map((v) => ({ value: v, label: v })), 'value', 'label', c[f])}</select>`
              : f === 'stage'
                ? `<select class="select" id="e-${esc(f)}-${esc(c.id)}" data-f="${esc(f)}">${options(STORY_STAGE_OPTIONS.map((v) => ({ value: v, label: v })), 'value', 'label', c[f])}</select>`
                : `<input class="input" id="e-${esc(f)}-${esc(c.id)}" data-f="${esc(f)}" value="${esc(c[f] || '')}" />`}</div>`).join('')}
          <div class="field"><label for="e-alias-${esc(c.id)}">别名（顿号或逗号分隔）</label>
            <input class="input" id="e-alias-${esc(c.id)}" data-f="aliases" value="${esc((c.aliases || []).join('、'))}" /></div>
          <div class="hint-xs">来源：${c.origin === 'bible' ? '全局归并' : `第 ${(c.chunk_index ?? 0) + 1} 段`} · 出现 ${c.mentions || 1} 次 · 证据段 ${(c.evidence || []).map((i) => i + 1).join('/') || '—'}</div>
        </div>`;
    }
    const bits = fields.filter((f) => c[f]).slice(0, 4)
      .map((f) => `<span class="hint-xs"><b>${esc(STORY_CARD_FIELD_LABELS[f] || f)}</b> ${esc(String(c[f]).slice(0, 40))}</span>`).join('');
    return `
      <div class="card" style="margin-bottom:10px">
        <div class="row" style="margin-bottom:6px">
          <span class="chip">${esc(storyKindLabel(c.kind))}</span>
          <b>${esc(c.name)}</b>
          ${c.edited ? '<span class="chip on" title="你改过这张卡，重新解析不会覆盖它">已改</span>' : ''}
          <div class="spacer"></div>
          ${c.kind === 'character' ? `<button class="btn btn-xs" data-tochar="${esc(c.id)}">${icon('users', 12)}入资产库</button>` : ''}
          <button class="btn btn-xs" data-edit="${esc(c.id)}">${icon('edit', 12)}</button>
          <button class="btn btn-xs btn-danger" data-del-card="${esc(c.id)}">${icon('trash', 12)}</button>
        </div>
        ${c.summary ? `<div class="hint" style="margin-bottom:6px">${esc(c.summary)}</div>` : ''}
        ${bits ? `<div class="row wrap" style="gap:10px">${bits}</div>` : ''}
        ${(c.aliases || []).length ? `<div class="hint-xs">别名：${esc(c.aliases.join('、'))}</div>` : ''}
      </div>`;
  }

  function collectEdits(id) {
    const root = container.querySelector(`[data-card="${id}"]`);
    const patch = {};
    root.querySelectorAll('[data-f]').forEach((el) => {
      const f = el.getAttribute('data-f');
      patch[f] = f === 'aliases'
        ? el.value.split(/[、,，;；\s]+/).map((s) => s.trim()).filter(Boolean)
        : el.value;
    });
    return patch;
  }

  // 回注文本：整份原著的卡片一次性复制
  container.querySelector('#nov-import').onclick = async () => {
    if (!projectId) { toast.err('先选择项目'); return; }
    const chars = cards.filter((c) => c.kind === 'character');
    if (!chars.length) { toast.err('还没有人物卡——先解析一份原著'); return; }
    const go = await confirm({
      title: '把人物卡写进角色库？',
      text: `将把 <b>${chars.length}</b> 张人物卡写入本项目角色库（已在库里的会自动跳过）。<br><br>写进去之后就能给角色挂参考图、上锁外貌，并被分镜批量注入——这是"跨镜头长相一致"的前提。`,
      okText: '写入角色库',
    });
    if (!go) return;
    const btn = container.querySelector('#nov-import');
    setBusy(btn, true, '写入中');
    const r = await api.storyImportCharacters({ project_id: projectId, source_id: sourceId || undefined });
    setBusy(btn, false);
    if (!r.ok) { toast.err(r.error); return; }
    toast.ok(`已写入 ${r.data.created_count} 个角色，跳过 ${r.data.skipped_count} 个已存在的`);
    loadCards();
  };

  const picker = container.querySelector('#p-picker');
  picker.onchange = () => {
    projectId = picker.value;
    sourceId = '';
    kindFilter = '';
    plan = null;
    editingId = null;
    syncViewParams({ project_id: projectId, source_id: '', kind: '' });
    renderPlanBox();
    loadSources();
    cards = [];
    renderCards();
  };
  container.querySelector('#reload').onclick = () => { loadSources(); if (sourceId) loadCards(); };

  syncCount();
  await loadSources();
  if (sourceId) await loadCards();
  else {
    const box0 = container.querySelector('#nov-cards');
    box0.innerHTML = `<div class="card">${empty('还没有选中原著', '左侧点一条解析记录，或用上面的输入框开始解析', 'layers', { label: '去粘贴原文', act: 'focus-text' })}</div>`;
    const b0 = box0.querySelector('[data-act="focus-text"]');
    if (b0) b0.onclick = () => { textEl.scrollIntoView({ block: 'center' }); textEl.focus(); };
  }

  return {
    el: container,
    title: '原著解析',
    cleanup() {
      offBatch();
      job = null;
    },
  };
}
