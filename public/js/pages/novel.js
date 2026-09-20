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
  STORY_CARD_KINDS, STORY_CARD_FIELDS, STORY_CARD_FIELD_LABELS, STORY_CARD_FIELD_MAX,
  STORY_ROLE_OPTIONS, STORY_STAGE_OPTIONS,
  CARD_IMAGE_KINDS, storyKindLabel,
} from '../consts.js';
import { toast, confirm, costConfirm, empty, skeleton, setBusy, errBox, on, dataOf, options, imgWithFallback } from '../ui.js';
import { charCount, countLabel, limitState } from '../textstats.js';
import { head, projectPicker, renderBatchBar } from './helpers.js';
import { state, onEvent, syncViewParams, navigate } from '../app.js';
import { parseStoryFiles, STORY_FILE_ACCEPT } from '../storyfile.js';

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
  let editingId = params.card_id || null;   // 正在就地编辑的卡片 id（体检的"去处理"会直接定位到这张）
  const focusCardId = params.card_id || ''; // 从体检跳进来时要滚到并高亮的那张卡
  let armedDel = '';                        // 已按过一次删除的卡片 id（两击确认）
  let imgs = [];                            // 本项目图片素材（给地点卡/道具卡挂参考图用）
  let outline = null;                       // 分集骨架结果（null = 还没算过；改卡片/换原著后作废）
  let outlinePer = Number(params.per_episode) || 4; // 每集至少几拍（可反复调，纯本地计算不花钱）

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
            <label class="btn btn-xs" for="nov-file" title="在浏览器本地读取，不上传服务器；可一次选多个文件（一章一个文件也行）">${icon('upload', 13)}选择文件</label>
            <input type="file" id="nov-file" accept="${STORY_FILE_ACCEPT.join(',')},text/plain" multiple style="display:none" />
          </div>
          <div class="field" style="margin-bottom:8px">
            <input class="input" id="nov-title" placeholder="给这份原著起个名字（便于在解析记录里区分）" />
          </div>
          <textarea class="textarea" id="nov-text" rows="12" aria-label="原著原文"
            placeholder="把小说/故事原文粘贴到这里（支持几万字，会自动分块解析）…"></textarea>
          <div class="row" style="margin-top:6px">
            <span class="hint-xs" id="nov-count"></span>
            <div class="spacer"></div>
            <span class="hint-xs">.txt / .md / .docx 在浏览器本地读取，原文只存在你本机</span>
          </div>
          <div id="nov-files"></div>
          <div class="divider"></div>
          <div class="row wrap">
            <button class="btn" id="nov-plan">${icon('search', 14)}先算一算</button>
            <button class="btn btn-primary" id="nov-run" style="flex:1;min-width:150px">${icon('sparkles', 14)}开始解析</button>
            <button class="btn" id="nov-append" style="flex:1;min-width:150px" title="只解析新增的章节并进已有卡片：已有卡一张不删、id 不变（分镜绑定不会悬空）">${icon('plus', 14)}追加到选中的原著</button>
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
          <!-- .row 默认不换行：三个按钮 + 标题在 900~1024px 会横向溢出（ui-audit 实测 2 条），
               加 .wrap 让按钮换行而不是把页面撑出横向滚动条 -->
          <div class="row wrap" style="margin-bottom:10px;row-gap:6px">
            <div class="card-title" style="margin:0">${icon('layers', 15)}卡片工作台</div>
            <div class="spacer"></div>
            <button class="btn btn-xs" id="nov-copy" title="把卡片回注文本复制到剪贴板（粘进任意模板变量）">${icon('copy', 13)}复制回注</button>
            <button class="btn btn-xs btn-primary" id="nov-toscript" title="把卡片带入「故事脚本」的模板变量，不用手工复制粘贴">${icon('arrowRight', 13)}带入剧本</button>
            <button class="btn btn-xs" id="nov-outline" title="把剧情卡按原文顺序排成拍子、按幕次收口切成集（纯本地判定，不花钱，可反复调）">${icon('grid', 13)}分集大纲</button>

            <button class="btn btn-xs" id="nov-chap" title="按章节看这份原文：每章有多少字、抽出几张卡、哪几章一段都没接住（纯本地判定，不花钱）">${icon('book', 13)}章节目录</button>
            <button class="btn btn-xs" id="nov-cover" title="查一遍这段原文哪些段落没抽出卡片：是「确实没信息」还是「模型没接住」（纯本地判定，不花钱）">${icon('search', 13)}抽取覆盖</button>
            <button class="btn btn-xs" id="nov-audit" title="查一遍同名卡、缺字段、别名撞名、没入资产库这些会毁掉一致性的问题（纯本地判定，不花钱）">${icon('check', 13)}一致性体检</button>
            <button class="btn btn-xs" id="nov-import" title="把这份原著里的人物卡批量写进角色库">${icon('users', 13)}人物入资产库</button>
            <button class="btn btn-xs" id="nov-look" title="给还没有外貌/服装的人物卡回原文找一遍（找到的必须带原文原话，对不上原文的一律丢弃；原文没写就如实说没写）">${icon('sparkles', 13)}AI 补长相</button>
            <button class="btn btn-xs" id="nov-inject" title="给没有任何可注入描述的地点卡/道具卡回原文找一遍（氛围/地域/时段/特征、持有者/用途/特征；同样必须带原文原话，对不上原文的一律丢弃）">${icon('sparkles', 13)}AI 补场景字段</button>
            <button class="btn btn-xs" id="nov-when" title="给没有时间点的时间线卡回原文找一遍（只照原文的说法写，不换算、不推算；必须带原文原话，对不上原文的一律丢弃；原文没写就如实说没写）">${icon('sparkles', 13)}AI 补时间点</button>
            <button class="btn btn-xs" id="nov-cast" title="剧情卡的「涉及人物」里有些名字没有人物卡与角色库档案 —— 回原文确认他是谁并直接建卡（必须带原文原话，对不上原文的一张都不建；原文里找不到这个人就如实说没找到，同样不建）">${icon('sparkles', 13)}AI 补人物卡</button>
          </div>
          <div id="nov-fill-box"></div>
          <div id="nov-outline-box"></div>
          <div id="nov-chap-box"></div>
          <div id="nov-cover-box"></div>
          <div id="nov-audit-box"></div>
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

  // 多选：很多作者一章一个文件。**顺序必须看得见** —— 顺序错了原文就乱了，
  // 而"乱了"这件事只有用户自己能判断（文件名里是中文数字时，自动排序排不出正确顺序）。
  function renderFilesBox(r) {
    const box = container.querySelector('#nov-files');
    if (!box) return;
    if (!r || !r.files || r.files.length < 2) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <div class="note" style="margin-top:6px">
        <div class="hint-xs"><b>按这个顺序拼起来了（共 ${r.files.length} 个文件，${countLabel(r.text.length)}）</b></div>
        <div class="hint-xs" style="margin-top:3px">${r.files.map((x, i) => `${i + 1}. ${esc(x.name)}（${countLabel(x.chars)}）`).join('<br>')}</div>
        ${r.guessed ? `<div class="hint-xs" style="margin-top:4px;color:var(--warn)">这些文件名里没有数字，位置排不出来，<b>顺序不一定对</b>：${r.unorderable.map((n) => esc(n)).join('、')}。请核对上面的顺序；不对就改成"第 1 章"这样带数字的文件名，或直接粘贴原文。</div>` : ''}
      </div>`;
  }

  container.querySelector('#nov-file').onchange = async (e) => {
    const picked = e.target.files;
    if (!picked || !picked.length) return;
    const many = picked.length > 1;
    if (many) setBusy(e.target, true, '读取中');
    const r = await parseStoryFiles(picked);
    e.target.value = ''; // 同一个文件改完再选一次也要能触发
    if (many) setBusy(e.target, false);
    if (!r.ok) { toast.err(r.error); renderFilesBox(null); return; }
    textEl.value = r.text;
    if (!titleEl.value.trim()) titleEl.value = (r.files[0].name || '').replace(/\.[^.]+$/, '');
    plan = null;
    renderPlanBox();
    syncCount();
    renderFilesBox(r);
    toast.ok(many ? `已读入 ${r.files.length} 个文件、${countLabel(r.text.length)}` : `已读入 ${countLabel(r.text.length)}`);
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
    const appendTo = sourceId ? (sources || []).find((x) => x.id === sourceId) : null;
    box.innerHTML = `
      <div class="note ${p.truncated ? 'orange' : 'gold'}" style="margin-top:10px">
        ${appendTo ? `将<b>追加</b>解析 <b>${p.chunk_count}</b> 段（已有 ${appendTo.chunk_count || 0} 段、${appendTo.card_count || 0} 张卡<b>不动</b>）`
    : `将分 <b>${p.chunk_count}</b> 段解析`}，共调用模型 <b>${p.calls}</b> 次（含全局归并 1 次）· ${cover}
        ${p.truncated ? `<br>原文超出单次解析上限（最多 ${p.max_chunks} 段），本次<b>只会解析前面的部分</b>；想全覆盖请分段提交。` : ''}
      </div>`;
  }

  // ── 真跑 ────────────────────────────────────────────────
  // 追加解析（批 8 补 10）：长篇连载越写越长，整本重解析等于为前面几十万字反复付费，
  // 已有卡还会被重建（id 全变 → 分镜绑定全悬空）。这条只解析新增章节。
  container.querySelector('#nov-append').onclick = async () => {
    const text = textEl.value.trim();
    if (!projectId) { toast.err('先在右上角选择项目'); return; }
    if (!sourceId) { toast.err('先在左侧选中要追加到哪一份原著（没选就是新建一份）'); return; }
    if (!text) { toast.err('先把新增的章节粘贴进来'); return; }
    const r0 = await api.storyPlan({ text });
    if (!r0.ok) { toast.err(r0.error); return; }
    plan = r0.data;
    renderPlanBox();
    const src = (sources || []).find((x) => x.id === sourceId) || {};
    const go = await costConfirm({
      count: plan.calls,
      what: '追加解析',
      note: `只解析新增的 ${plan.chunk_count} 段（${countLabel(plan.covered_chars)}），已有 ${src.chunk_count || 0} 段不重跑、已有卡片 id 不变。你改过的卡（标了"已改"的）不会被覆盖：人工值优先，模型只能补它空着的字段。`,
    });
    if (!go) return;
    const btn = container.querySelector('#nov-append');
    setBusy(btn, true, '提交中');
    const r = await api.storyAppend({
      project_id: projectId, source_id: sourceId,
      title: titleEl.value.trim() || undefined, text,
    });
    setBusy(btn, false);
    if (!r.ok) { toast.err(r.error); return; }
    localStorage.setItem(JOB_KEY, r.data.jobId);
    kindFilter = '';
    toast.ok(`已开始追加解析：新增 ${r.data.appended_chunks} 段（原有 ${r.data.existing_cards} 张卡保留）`, 'info');
    pollJob(r.data.jobId);
    loadSources();
  };

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
  async function onJobDone(j) {
    if (doneFor === j.id) return;
    doneFor = j.id;
    localStorage.removeItem(JOB_KEY);
    await loadSources();
    if (sourceId) loadCards();
    // 批 8 补 18：以前这里写"可在卡片列表重试"，但卡片列表根本没有重试入口（假承诺）。
    // 现在真有出口了：点名"哪几段要补抽"，并且**自动把覆盖面板打开**，不让用户自己找。
    if (j.status === 'done') {
      // 用户改过的卡有没有被保住，必须**说出来**：改过的卡"没被覆盖"和"被覆盖了却看不出来"
      // 在界面上长得一模一样（批 8 补 25）
      const keepN = Number((sources || []).find((x) => x.id === sourceId)?.protected_cards) || 0;
      toast.ok(`解析完成：成功 ${j.ok} 项${j.fail ? `，${j.fail} 段需要补抽` : ''}${keepN ? `；你改过的 ${keepN} 张卡保持原样` : ''}`);
      if (j.fail) runCoverage();
    }
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
  /** 本项目图片素材：给地点卡/道具卡挂参考图用（批 8 补 17） */
  async function loadImages() {
    const r = await api.images();
    imgs = (r.ok ? (r.data || []) : []).filter((i) => i.project_id === projectId && (i.url || i.remote_url));
  }

  // 块号 → 章节标题（批 8 补 21）：卡片出处优先说"第几章"，段号只是兜底。
  // 声明放在**第一个用它的函数之前**：放在下面（章节目录那一段）能跑，但那是靠"调用都发生在模块体末尾"
  // 这个巧合，往后谁把 loadCards 提前调一次就是 TDZ 白屏（uitest 那边已经为同类问题红过三次）。
  let chunkChapter = {};

  async function loadCards() {
    const box = container.querySelector('#nov-cards');
    await loadImages(); // 卡片编辑器里要挂参考图，素材先取到（拿不到就是空列表，不阻断卡片显示）
    // 章节映射要在**渲染之前**拿到：卡片出处那一行直接写"第 2 章"，而不是先写"第 3 段"再被改写
    // （渲染后再补一次会让已经展开的溯源面板、编辑态被重绘掉）。纯本地、一次模型都不调。
    if (sourceId) {
      const cr = await api.storyChapters(sourceId);
      if (cr.ok) {
        chunkChapter = {};
        (cr.data.chapters || []).forEach((c) => (c.chunks || []).forEach((i) => { if (chunkChapter[i] == null) chunkChapter[i] = c.title; }));
      }
    } else {
      chunkChapter = {};
    }
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

  // 打开某张卡的「原文依据」。主列表与章节复核面板**共用这一份实现** ——
  // 两处各写一遍，行为迟早会分叉（一边标了命中、另一边没标）。
  // 片段由服务端切成 {t, hit} 且**不含 HTML**，这里只负责转义与包裹：命中的词来自模型输出，必须转义。
  async function openSource(id, opts) {
    let slot = container.querySelector(`#nov-src-${id}`);
    if (!slot) {
      // 被类别筛选挡住的卡片在主列表里没有槽位 —— 先解除筛选再渲染一次，否则点了没反应
      kindFilter = '';
      syncViewParams({ kind: '' });
      renderKindChips();
      renderCards();
      slot = container.querySelector(`#nov-src-${id}`);
      if (!slot) return;
    }
    if (opts && opts.scroll) slot.scrollIntoView({ block: 'center' });
    // 主列表里点自己那一行是"开关"（再点一次收起）；从章节复核面板点过来是"给我看"
    // —— 那时用户看的是章节面板、不是那张卡，把它**关掉**会莫名其妙（force 由章节面板传）。
    if (!slot.hidden && !(opts && opts.force)) { slot.hidden = true; slot.innerHTML = ''; return; }
    slot.hidden = false;
    slot.innerHTML = `<div class="note" style="margin-top:6px">${skeleton('row', 1)}</div>`;
    const r = await api.storyCardSource(id);
    if (!r.ok) { slot.innerHTML = errBox(r.error, '原文没取到', r.trace); return; }
    const d = r.data;
    const hl = (segs) => (segs || []).map((x) => (x.hit ? `<mark>${esc(x.t)}</mark>` : esc(x.t))).join('');
    slot.innerHTML = `
      <div class="note" style="margin-top:6px">
        <div class="row wrap" style="gap:6px;align-items:flex-start">
          <div style="flex:1;min-width:180px">
            <b>原文依据</b><span class="hint-xs">　来自「${esc(d.source_title || '原著')}」</span>
            <div class="hint-xs" style="margin-top:3px">核对这张卡说得对不对，不用再回原文里数段。命中处已标出；片段只截了命中附近，不是完整段落。</div>
          </div>
          <button class="btn btn-xs" data-src-close="${esc(d.card_id)}">收起</button>
        </div>
        ${(d.notes || []).length ? `<div class="hint-xs" style="margin-top:6px;color:var(--warn)">${d.notes.map(esc).join('；')}</div>` : ''}
        ${(d.excerpts || []).length ? d.excerpts.map((x) => `
          <div style="margin-top:8px">
            <div class="hint-xs">${x.chapter_title ? `<b>${esc(x.chapter_title)}</b> · ` : ''}<b>${esc(x.label)}</b>${x.spans_chapters > 1 ? '<span style="opacity:.7">（这一段跨了多章）</span>' : ''} · 共 ${countLabel(x.chars)}${x.hits.length ? ` · 命中 ${esc(x.hits.join('、'))}` : ' · 这段里没找到这个名字'}</div>
            <div class="src-quote">${hl(x.segments)}${x.truncated ? '<span class="hint-xs">…（前后还有内容，只显示命中附近）</span>' : ''}</div>
          </div>`).join('') : `<div class="hint-xs" style="margin-top:6px">没有可展示的原文片段。</div>`}
      </div>`;
    const cb = slot.querySelector('[data-src-close]');
    if (cb) cb.onclick = () => { slot.hidden = true; slot.innerHTML = ''; };
    
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
    // 卡片溯源：把"证据段 3"变成能直接读的原文（命中处标出来）。
    on(box, '[data-src-of]', 'click', (e) => openSource(dataOf(e.currentTarget, 'src-of')));
    on(box, '[data-edit]', 'click', (e) => { editingId = dataOf(e.currentTarget, 'edit'); renderCards(); });
    on(box, '[data-cancel]', 'click', () => { editingId = null; renderCards(); });
    // 参考图选中态：勾选后给卡片描边（否则选中与未选中在缩略图上几乎看不出差别）
    on(box, '.ref-item', 'change', (e) => {
      const it = e.currentTarget;
      it.classList.toggle('on', it.querySelector('input').checked);
    });
    on(box, '[data-save]', 'click', async (e) => {
      const id = dataOf(e.currentTarget, 'save');
      const patch = collectEdits(id);
      // 参考图不在 [data-f] 里（是多选缩略图，不是单值输入），单独收集
      const refBox = container.querySelector(`#e-refs-${id}`);
      if (refBox) {
        patch.reference_image_ids = [...refBox.querySelectorAll('.ref-item')]
          .filter((it) => it.querySelector('input').checked)
          .map((it) => it.getAttribute('data-ref'));
      }
      if (!patch.name.trim()) { toast.err('名字不能为空——下游全靠名字对上号'); return; }
      const r = await api.updateStoryCard(id, patch);
      if (!r.ok) { toast.err(r.error); return; }
      editingId = null;
      // 服务端截断了要说话：静默少一截文字，用户只会以为"我明明写了的"
      const cut = (r.data && r.data.truncated) || [];
      if (cut.length) {
        toast.err(`有字段超出长度上限、已截断：${cut.map((f) => STORY_CARD_FIELD_LABELS[f] || f).join('、')}`);
      } else {
        toast.ok('已保存——下次回注会带上你的修改');
      }
      loadCards();
    });
    // 就地两击确认（与 ui.js 的 twoClick 同语义，但这里是事件委托，所以自己管一个 armedDel）：
    // 删一张卡不值得弹窗打断，但也不能一击就没
    on(box, '[data-del-card]', 'click', async (e) => {
      const el = e.currentTarget;
      const id = dataOf(el, 'del-card');
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

  // ── 分集大纲骨架（批 8 补 4）──────────────────────────────
  // 剧情卡按**原文出现顺序**排成拍子，再按幕次收口切成集。切集是可判定的（拍数下限 + 不拆幕），
  // 所以刻意不调模型：用户要反复调「每集至少几拍」，每次调都花钱的工具没人会用。
  // 真正需要 AI 的是"把这些拍写成剧本"，那一步在故事剧本页照旧走生成（有计费闸门）。
  // 修复按钮文案（每种问题一个明确的动作，不用"一键修复"这种含糊说法）
  const FIX_LABEL = {
    dup_name: '合并同名卡',
    alias_collision: '删掉撞名别名',
    char_not_in_asset: '一键入资产库',
    bind_shot_target: '绑到这些镜头',
    lock_shot_char: '锁定该角色',
    strip_style_word: '删掉写死的画风词',
    sync_character: '同步到资产库',
  };

  const BASIS_LABEL = {
    stage: '全部剧情卡都标了幕次，切分收在幕的边界上',
    mixed: '部分剧情卡标了幕次，切分优先收在幕的边界上',
    count: '剧情卡都没标幕次，退化为按拍数平均切分',
  };

  async function runOutline(per) {
    const box = container.querySelector('#nov-outline-box');
    if (per) outlinePer = per;
    const r = await api.storyEpisodes({ projectId, sourceId: sourceId || undefined, perEpisode: outlinePer });
    if (!r.ok) { toast.err(r.error); return; }
    outline = r.data;
    const d = r.data;
    if (!d.beat_count) {
      box.innerHTML = `<div class="note" style="margin-bottom:10px">${icon('grid', 13)} 分集大纲：这份原著还没有剧情卡，先解析出剧情卡才能排分集骨架。</div>`;
      return;
    }
    box.innerHTML = `
      <div class="note" style="margin-bottom:10px">
        <div class="row wrap" style="row-gap:6px;align-items:flex-start">
          <div style="flex:1;min-width:220px">
            <b>分集骨架：${d.episode_count} 集 / ${d.beat_count} 拍</b>
            <span class="hint-xs">（幕次覆盖 ${d.stage_covered}/${d.beat_count} 拍）</span>
            <div class="hint-xs" style="margin-top:3px">${esc(BASIS_LABEL[d.basis] || d.basis)}。纯本地计算，不调用模型——调拍数不花钱，随便试。</div>
          </div>
          <label class="hint-xs" for="nov-outline-per" style="flex:0 0 auto">每集至少</label>
          <input class="input" id="nov-outline-per" type="number" min="1" max="20" value="${d.per_episode}" style="width:64px;flex:0 0 auto" />
          <span class="hint-xs" style="flex:0 0 auto">拍</span>
          <button class="btn btn-xs" data-outline-recut style="flex:0 0 auto">重新切分</button>
          ${d.stage_covered < d.beat_count ? `<button class="btn btn-xs" data-outline-stage title="让模型把还没标幕次的拍点分到 起/承/转/合（只调一次模型；已有的幕次不会被动）" style="flex:0 0 auto">${icon('sparkles', 12)}AI 补幕次（${d.beat_count - d.stage_covered} 拍）</button>` : ''}
          <button class="btn btn-xs" data-outline-copy style="flex:0 0 auto">${icon('copy', 12)}复制</button>
          <button class="btn btn-xs btn-primary" data-outline-toscript style="flex:0 0 auto">${icon('arrowRight', 12)}带入剧本</button>
        </div>
        <div class="divider" style="margin:8px 0"></div>
        ${d.episodes.map((ep) => `
          <div style="padding:4px 0">
            <div><b>${esc(ep.title)}</b>
              <span class="chip" style="margin-left:4px">${esc(ep.acts.length ? ep.acts.join('·') : '未标幕次')}</span>
              <span class="hint-xs">${ep.beat_count} 拍 · 约 ${ep.chars} 字</span></div>
            <div style="padding-left:10px">
              ${ep.beats.map((b, i) => `<div class="hint-xs" style="margin-top:2px">${i + 1}. ${esc(b.name)}${b.conflict ? `｜冲突：${esc(b.conflict)}` : ''}${b.outcome ? `｜结果：${esc(b.outcome)}` : ''}${b.involved ? `｜涉及：${esc(b.involved)}` : ''}</div>`).join('')}
            </div>
          </div>`).join('')}
        <div class="divider" style="margin:8px 0"></div>
        ${d.notes.map((n) => `<div class="hint-xs">· ${esc(n)}</div>`).join('')}
      </div>`;
    on(box, '[data-outline-recut]', 'click', () => {
      const v = Number((box.querySelector('#nov-outline-per') || {}).value);
      runOutline(v > 0 ? v : 4);
    });
    on(box, '[data-outline-copy]', 'click', async () => {
      // 与「复制回注」同一条纪律：失败必须说清是浏览器没给剪贴板权限，不许静默
      try {
        await navigator.clipboard.writeText(outline ? outline.text : '');
        toast.ok(`已复制分集骨架（${d.episode_count} 集 / ${d.beat_count} 拍）——粘进剧本模板变量即可`);
      } catch { toast.err('复制失败——浏览器没给剪贴板权限，请手动选中'); }
    });
    on(box, '[data-outline-stage]', 'click', (e) => fillStages(e.currentTarget));
    on(box, '[data-outline-toscript]', 'click', () => toScriptOutline());
  }

  /**
   * AI 补幕次（批 8 补 32）：先干跑问清"要补几拍、调几次模型"，确认后再花钱。
   * 幕次是分集的依据，所以补完要**重新切一遍**并如实报出分集依据有没有真的变好
   * （`basis` 从 count 变成 stage 才是"这次调用有用"的证据）。
   */
  async function fillStages(btn) {
    if (!sourceId) { toast.err('先在左侧选中一份解析记录'); return; }
    const dry = await api.storyStageFill(sourceId, { dryRun: true });
    if (!dry.ok) { toast.err(dry.error); return; }
    if (!dry.data.targets) { toast.ok('所有剧情拍点都已经有幕次了'); return; }
    // 花钱的动作先说清楚（与本页其它生成入口同一条闸门）：补几拍、调几次、什么不会被改
    const yes = await costConfirm({
      count: 1,
      what: '补幕次',
      note: `有 ${dry.data.targets} 个剧情拍点还没标幕次（共 ${dry.data.beats} 拍），全部拍点一次交给模型判断，只调 1 次。`
        + '已经标好的幕次不会被动；模型返回的幕次只要不是「起/承/转/合」就会被丢掉并如实告诉你。',
    });
    if (!yes) return;
    // **必须传按钮**，不能传 container：setBusy 会把 innerHTML 换成 spinner，
    // 传容器会把整页抹掉（下面的 loadCards/runOutline 就都会对着一个 spinner 找节点 → 报错）。
    // 补 32 就是这么写的：toast 报"已补 N 拍"，而卡片与大纲**从来没有刷新**、页面监听也全没了
    setBusy(btn, true, '正在补幕次');
    try {
      const r = await api.storyStageFill(sourceId);
      if (!r.ok) { toast.err(r.error); return; }
      const d = r.data;
      const bad = (d.invalid || []).length + (d.missing || []).length;
      const back = (d.back_steps || []).length;
      toast.ok(`已补 ${d.assigned}/${d.targets} 拍的幕次`);
      // 说不清楚的必须说清楚：没接住的、顺序倒退的、以及"分集依据有没有真的变好"
      if (bad) toast.err(`有 ${bad} 拍没接住（模型返回的幕次不在 起/承/转/合 之内，或没给全），已保持原样`);
      if (back) toast.err(`有 ${back} 处幕次顺序倒退（模型没按"幕次不能倒退"来），建议人工看一眼`);
      if (d.basis_before !== d.basis_after) toast.ok(`分集依据：${d.basis_before} → ${d.basis_after}`);
      await loadCards();
      await runOutline();
    } finally { setBusy(btn, false); }
  }

  /** 分集骨架 → 故事脚本页（与「带入剧本」同一条链路，只是换成骨架文本） */
  function toScriptOutline() {
    if (!sourceId) { toast.err('先在左侧选中一份解析记录'); return; }
    const q = new URLSearchParams({
      project: projectId, tab: 'episode_script', bible: sourceId, outline: String(outlinePer),
    });
    location.hash = `#/scripts?${q.toString()}`;
    toast(`正在把 ${outline ? outline.episode_count : ''} 集分集骨架带入「单集脚本」的模板变量`, 'info', 5000);
  }

  container.querySelector('#nov-outline').onclick = () => {
    if (!projectId) { toast.err('先在右上角选一个项目'); return; }
    runOutline();
  };

  // ── 一致性体检（批 8 补 3）────────────────────────────────
  // 纯本地判定：同名卡、别名撞名、缺可注入字段、没进资产库… 这些是会悄悄毁掉一致性的机械问题。
  // 刻意不调模型：花钱才能查一致性的工具，用户会不敢点；而且同一份数据两次结论不同就没人信了。
  const LEVEL_LABEL = { warn: '要处理', info: '可优化' };

  async function runAudit() {
    const box = container.querySelector('#nov-audit-box');
    // 体检**按项目**而不是按当前这份原著：同名卡最常见的就是"同一个角色从两份原著里各抽出一张"，
    // 只看当前来源就永远看不见它。修复也是项目级的，报告范围与修复范围必须一致。
    const r = await api.storyAudit({ projectId });
    if (!r.ok) { toast.err(r.error); return; }
    const { counts, issues, total_cards: total } = r.data;
    const shots = r.data.shots_scanned || 0;
    if (!issues.length) {
      box.innerHTML = `<div class="note" style="margin-bottom:10px">${icon('check', 13)} 一致性体检：${total} 张卡片、${shots} 个镜头，没发现问题。</div>`;
      return;
    }
    box.innerHTML = `
      <div class="note" style="margin-bottom:10px">
        <div class="row wrap" style="row-gap:6px;align-items:flex-start">
          <div style="flex:1;min-width:200px">
            <b>一致性体检：${issues.length} 项</b>（要处理 ${counts.warn} · 可优化 ${counts.info}，其中 ${counts.fixable} 项可一键修复）
            <div class="hint-xs" style="margin-top:3px">范围是<b>整个项目</b>的 ${total} 张卡片 + ${shots} 个镜头（同名卡常常来自不同原著，只看当前这份就看不见；镜头漏绑绑定不会有任何报错，只会在出图时少一段外貌/场景描述；提示词里写死画风会让"换画风"静默失效）。剧情卡的「涉及人物」写了谁、人物卡与角色库里却没有，也会在这里报出来（它会被带进剧本，而外貌注入/绑定/参考图都落不到他身上）。只做机械判定，不调用模型——所以随时可以再点一次；需要你拍板的（两处描述哪个对）只如实列出，不替你决定。</div>
          </div>
          <button class="btn btn-xs" data-audit-again>重新体检</button>
          <button class="btn btn-xs" data-audit-close>收起</button>
        </div>
        <div class="divider" style="margin:8px 0"></div>
        ${issues.map((it, i) => `
          <div class="row" style="align-items:flex-start;gap:8px;padding:5px 0">
            <span class="badge ${it.level === 'warn' ? 'gold' : 'gray'}" style="flex:0 0 auto">${LEVEL_LABEL[it.level] || it.level}</span>
            <div style="flex:1;min-width:0">
              <div style="font-weight:550">${esc(it.title)}</div>
              <div class="hint-xs" style="margin-top:2px">${esc(it.detail)}</div>
            </div>
            ${it.fixable ? `<button class="btn btn-xs" data-audit-fix="${esc(it.fix_code || it.code)}" data-fix-idx="${i}" style="flex:0 0 auto">${FIX_LABEL[it.fix_code || it.code] || '一键修复'}</button>` : ''}
            ${!it.fixable && it.go ? `<button class="btn btn-xs" data-audit-go="${i}" style="flex:0 0 auto">去处理</button>` : ''}
          </div>`).join('')}
      </div>`;
    // 修复项：只做机械且可解释的三件事，做完重新体检（用户能立刻看到结果变化）
    on(box, '[data-audit-again]', 'click', () => runAudit());
    on(box, '[data-audit-close]', 'click', () => { box.innerHTML = ''; });
    // 需要人来选的问题（例：给重复出现的场景挑一张参考图）机器替不了，但必须给出口 ——
    // 只报告不给去处的体检，用户看完只能自己猜该去哪一页（批 8 补 19）
    on(box, '[data-audit-go]', 'click', (e) => {
      const issue = issues[Number(dataOf(e.currentTarget, 'audit-go'))] || {};
      if (!issue.go) return;
      navigate(issue.go.page, issue.go.params || {});
    });
    on(box, '[data-audit-fix]', 'click', async (e) => {
      const btn = e.currentTarget;
      // 变更须知：ui.js 的 dataOf 是**字面**取属性（`el.getAttribute('data-' + name)`），
      // 所以这里必须写 'audit-fix' 而不是 'auditFix' —— 写成驼峰只会拿到 null，
      // 表现是"按钮点了没反应"（这个 bug 在批 8 下与批 8 补 3 各犯过一次，uitest 已加通用棘轮）。
      const code = dataOf(btn, 'audit-fix');
      const issue = issues[Number(dataOf(btn, 'fix-idx'))] || {};
      if (code === 'dup_name') {
        const conflicts = (issue.conflicts || []).length;
        const okGo = await confirm({
          title: '合并同名卡',
          text: `这会把 ${issue.card_ids.length} 张同名卡并成一张（保留更详细的描述），并把分镜上指向被合并卡的绑定改指到存活卡上。`
            + (conflicts ? `<br><br>注意：有 ${conflicts} 个字段存在不同说法，合并后只保留更详细的那个——原值会显示在体检详情里，建议先核对。` : ''),
          okText: '合并',
        });
        if (!okGo) return;
      }
      if (code === 'bind_shot_target') {
        const n = (issue.shot_ids || []).length;
        const okGo = await confirm({
          title: '绑定到这些镜头',
          text: `会把「${esc(issue.target_name)}」绑到 <b>${n}</b> 个镜头上（${(issue.shots || []).slice(0, 8).map((x) => `#${x.shot_number}`).join('、')}${n > 8 ? ' 等' : ''}）。`
            + '<br><br>绑定只影响生成时注入的外貌/场景短语，<b>不会改写镜头内容</b>；绑错了可以在镜头卡片上点掉。',
          okText: '绑定',
        });
        if (!okGo) return;
      }
      if (code === 'strip_style_word') {
        const okGo = await confirm({
          title: '删掉写死的画风词',
          text: `会从 <b>${(issue.shot_ids || []).length}</b> 个镜头的提示词里删掉「${esc(issue.word || issue.target_name)}」。`
            + '<br><br>画风由<b>项目设置</b>在使用点统一注入，写死在提示词里会让「换画风」失效（改了设置图也不会变），或者两套风格打架。'
            + '<br>删掉之后这些镜头的画风就跟着项目设置走了（只改提示词，不动画面描述）。',
          okText: '删掉',
        });
        if (!okGo) return;
      }
      if (code === 'sync_character') {
        // 这一条会**覆盖**资产库里已有的描述，所以必须把"哪个值变哪个值"逐条摆出来让人确认 ——
        // 机器只负责发现与搬运，哪份对是人的判断
        const drift = issue.drift || [];
        const okGo = await confirm({
          title: '把人物卡同步到资产库',
          text: `资产库里的「${esc(issue.target_name)}」是按<b>出图时真正注入</b>的那份，人物卡是原著里读到的。`
            + `同步会以人物卡为准，改动这些字段：<br><br>`
            + drift.map((d) => `· ${esc(d.field)}：「${esc(d.asset || '空')}」→「${esc(d.card)}」`).join('<br>')
            + '<br><br>只动外貌/服饰/别名三项（真正会影响出图的），角色定位、性格这些你在资产库里改过的不动。',
          okText: '同步',
        });
        if (!okGo) return;
      }
      if (code === 'lock_shot_char') {
        const okGo = await confirm({
          title: '锁定角色',
          text: `锁定「${esc(issue.target_name)}」后，它绑定的<b>每个</b>镜头都会逐字注入同一段外貌描述（未锁定时，提示词里提到角色名就会跳过注入——这正是那 ${(issue.shot_ids || []).length} 个镜头"看起来绑了却没生效"的原因）。`,
          okText: '锁定',
        });
        if (!okGo) return;
      }
      setBusy(btn, true);
      const r = await api.storyAuditFix({
        project_id: projectId, code, card_ids: issue.card_ids || [],
        target_id: issue.target_id, shot_ids: issue.shot_ids || [], word: issue.word,
        card_ids: issue.card_ids || [],
      });
      setBusy(btn, false);
      if (!r.ok) { toast.err(r.error); return; }
      const d = r.data;
      if (code === 'dup_name') toast.ok(`已合并 ${d.merged_groups} 组同名卡，删除 ${d.removed_cards} 张，${d.repointed_shots} 个镜头的绑定已改指存活卡`);
      else if (code === 'alias_collision') toast.ok(`已清理 ${d.fixed_cards} 张卡的撞名别名`);
      else if (code === 'bind_shot_target') toast.ok(`已把「${d.target_name}」绑到 ${d.bound_shots} 个镜头上`);
      else if (code === 'lock_shot_char') toast.ok(`已锁定「${d.target_name}」，这些镜头会逐字注入它的外貌`);
      else if (code === 'strip_style_word') toast.ok(`已从 ${d.fixed_shots} 个镜头的提示词里删掉「${d.word}」，画风回到项目设置`);
      else if (code === 'sync_character') toast.ok(d.updated
        ? `已把「${d.target_name}」的${d.fields.join('/')}同步到资产库，出图用的长相跟人物卡一致了`
        : `「${d.target_name}」已经一致，没有要改的`);
      else toast.ok(`已把 ${d.created_count} 张人物卡写进资产库${d.skipped_count ? `（${d.skipped_count} 张已在库里）` : ''}`);
      await loadCards();
      await runAudit();
    });
  }

  /**
   * 抽取覆盖体检（批 8 补 18）。
   *
   * 为什么要单独一块面板：分块抽取跑几十段，模型对每段的回答有三种完全不同的结局 ——
   * 「抽到了」「模型明确说这段没信息」「模型返回了条目却被我们丢掉」。此前它们被压成同一个"失败"，
   * 于是"部分失败 8 段"常年挂着，用户很快就学会无视它；而真正丢数据的那种最隐蔽，
   * 在界面上跟"这段确实没信息"长得一模一样。这里把三者分开，并给出**能点的下一步**。
   */
  async function runChapters() {
    const box = container.querySelector('#nov-chap-box');
    if (!sourceId) { box.innerHTML = ''; toast.err('先在左侧选中一份原著'); return; }
    // 卡片列表还没加载就先补上：章节面板要按 id 列出"这一章抽到了什么"，
    // 手里没有卡片时它会写成"这一章没有抽到卡片" —— 把"不知道"说成"没有"（假信息比不报更糟）
    if (!cards.length) await loadCards();
    if (!box.innerHTML) {
      box.innerHTML = `<div class="card" style="margin-bottom:10px">${skeleton('row', 3)}</div>`;
    }
    const r = await api.storyChapters(sourceId);
    if (!r.ok) { box.innerHTML = errBox(r.error, '章节目录没取到', r.trace); return; }
    const d = r.data;
    if (!d.found) {
      box.innerHTML = `
        <div class="card" style="margin-bottom:10px;padding:12px">
          <div class="row" style="gap:6px;align-items:center">
            <b>章节目录</b><div class="spacer"></div>
            <button class="btn btn-xs" id="nov-chap-close">收起</button>
          </div>
          <div class="hint-xs" style="margin-top:6px">${esc(d.note || '没有识别到章节标题。')}</div>
        </div>`;
      const cb0 = box.querySelector('#nov-chap-close');
      if (cb0) cb0.onclick = () => { box.innerHTML = ''; };
      return;
    }
    chunkChapter = {};
    (d.chapters || []).forEach((c) => (c.chunks || []).forEach((i) => { if (chunkChapter[i] == null) chunkChapter[i] = c.title; }));
    const byId = new Map(cards.map((c) => [c.id, c]));
    const rows = (d.chapters || []).map((c) => {
      // 只有"真丢数据"才报警：模型说"这段没信息"是正常结局（对照补 18/补 19）
      const lost = (c.dropped || 0) + (c.failed || 0);
      // 就地展开"这一章抽到了什么"：光有张数没法判断抽得对不对，得看得见是哪几张、点得进原文
      const got = (c.card_ids || []).map((id) => byId.get(id)).filter(Boolean);
      const preview = (c.preview || '').replace(/\s+/g, ' ');
      return `
      <div style="border-top:1px solid var(--line);padding:6px 0">
        <div class="row" style="gap:8px;align-items:center;cursor:pointer" data-chap="${c.chapter}">
          <span class="chip ${lost ? 'red' : c.card_count ? 'green' : 'gray'}" style="flex:none">${c.card_count} 张卡</span>
          <div style="flex:1;min-width:0">
            <div class="hint-xs"><b>${esc(c.title)}</b> · ${countLabel(c.chars)} · ${c.chunk_count} 段<span style="opacity:.7">${got.length ? ' · 点开看抽到了什么' : ''}</span></div>
            ${lost ? `<div class="hint-xs" style="color:var(--warn)">这一段里有 ${lost} 段没接住（模型返回了条目却被丢掉，或调用失败）——去「抽取覆盖」看是哪几段</div>` : ''}
          </div>
        </div>
        <div id="nov-chap-${c.chapter}" data-chap-slot="${c.chapter}" hidden></div>
      </div>`;
    }).join('');
    box.innerHTML = `
      <div class="card" style="margin-bottom:10px;padding:12px">
        <div class="row wrap" style="gap:6px;align-items:center">
          <b>章节目录：共 ${(d.chapters || []).length} 章，${d.with_cards} 章抽到了卡片</b>
          <div class="spacer"></div>
          <button class="btn btn-xs" id="nov-chap-close">收起</button>
        </div>
        <div class="hint-xs" style="margin-top:4px">出处按章显示（作者想的是"第几章"，"第几段"是切块的副产物）${d.skipped ? `；另有 ${d.skipped} 个疑似目录行被忽略` : ''}${d.truncated ? '；章节过多已截断' : ''}。</div>
        ${rows}
      </div>`;
    const cb = box.querySelector('#nov-chap-close');
    if (cb) cb.onclick = () => { box.innerHTML = ''; };
    // 章节复核：点开一章就地看"这一章抽到了什么"，每张卡都能直接跳到它的原文依据。
    // 只列这一章真抽到的卡（按 evidence 落在哪一章判定），不做任何推测。
    on(box, '[data-chap]', 'click', (e) => {
      const ch = dataOf(e.currentTarget, 'chap');
      const slot = box.querySelector(`#nov-chap-${ch}`);
      if (!slot) return;
      if (!slot.hidden) { slot.hidden = true; slot.innerHTML = ''; return; }
      const info = (d.chapters || []).find((x) => String(x.chapter) === String(ch)) || {};
      const got = (info.card_ids || []).map((id) => byId.get(id)).filter(Boolean);
      const preview = (info.preview || '').replace(/\s+/g, ' ');
      slot.hidden = false;
      slot.innerHTML = `
        <div class="note" style="margin:6px 0 0">
          <div class="hint-xs">${esc(preview)}${(info.preview || '').length >= 120 ? '…' : ''}</div>
          ${got.length ? `<div class="row wrap" style="gap:6px;margin-top:8px">
            ${got.map((x) => `<button class="chip" data-chap-card="${esc(x.id)}" title="看这张卡的原文依据">${esc(storyKindLabel(x.kind))}·${esc(x.name)}</button>`).join('')}
          </div>
          <div class="hint-xs" style="margin-top:4px">点一张卡就能看到它对应的原文依据（命中处会标出来）。</div>`
          : '<div class="hint-xs" style="margin-top:6px">这一章没有抽到卡片。</div>'}
        </div>`;
      // 章节面板里的卡片 → 跳到主列表那张卡的原文依据（共用同一份实现）
      on(slot, '[data-chap-card]', 'click', (ev) => {
        ev.stopPropagation();
        openSource(dataOf(ev.currentTarget, 'chap-card'), { scroll: true, force: true });
      });
    });
  }

  async function runCoverage() {
    const box = container.querySelector('#nov-cover-box');
    if (!sourceId) { box.innerHTML = ''; toast.err('先在左侧选中一份原著'); return; }
    box.innerHTML = `<div class="card" style="margin-bottom:10px">${skeleton('row', 3)}</div>`;
    const r = await api.storyCoverage(sourceId);
    if (!r.ok) { box.innerHTML = errBox(r.error, '覆盖体检没跑起来', r.trace); return; }
    const d = r.data;
    const c = d.counts || {};
    const BADGE = { ok: 'green', empty: 'gray', dropped: 'gold', failed: 'red', unknown: 'blue', pending: 'gray' };
    const bad = (d.needs_retry || []).length;
    const rowOf = (x) => `
      <div class="row" style="gap:8px;align-items:flex-start;padding:6px 0;border-top:1px solid var(--line)">
        <span class="chip ${BADGE[x.state] || ''}" style="flex:none">${esc(x.state_label)}</span>
        <div style="flex:1;min-width:0">
          <div class="hint-xs"><b>${esc(x.label)}</b> · ${countLabel(x.chars)}${x.cards ? ` · ${x.cards} 张卡` : ''}${x.raw_count ? ` · 模型给了 ${x.raw_count} 条` : ''}${(x.raw_kinds || []).length ? `（类别：${esc(x.raw_kinds.join('、'))}）` : ''}</div>
          <div class="hint-xs" style="opacity:.75">${esc((x.preview || '').replace(/\s+/g, ' ').slice(0, 90))}</div>
          ${x.error ? `<div class="hint-xs" style="color:var(--warn)">${esc(x.error)}</div>` : ''}
        </div>
      </div>`;
    // 只把**该管的段**列出来：把几十段"已抽取"全铺开，真正要看的反而找不到
    const show = (d.chunks || []).filter((x) => x.needs_retry || x.state === 'unknown' || x.state === 'empty');
    // 原文与解析时对不上时，补抽**一定会被服务端拒绝**（按段号重抽会抽到别的段落）。
    // 那就别摆一个"点了必然失败"的按钮 —— 那是"没有出口的假承诺"的镜像：有出口、但出口是墙。
    // 这里直接把按钮换成一句说明 + 该走的路（重新解析）
    const broken = d.verified === true && (d.mismatched_chunks || []).length > 0;
    box.innerHTML = `
      <div class="card" style="margin-bottom:10px;padding:12px">
        <div class="row wrap" style="gap:6px;align-items:center">
          <b>抽取覆盖：${esc(d.note || '')}</b>
          <div class="spacer"></div>
          ${bad && !broken ? `<button class="btn btn-xs btn-primary" id="nov-cover-retry">${icon('refresh', 12)}补抽这 ${bad} 段</button>` : ''}
          ${bad && broken ? `<button class="btn btn-xs" id="nov-cover-reparse" title="这些段的原文已经和解析时不一样了：按段号重抽会抽到别的段落，只能重新解析">${icon('refresh', 12)}重新解析这份原著</button>` : ''}
          <button class="btn btn-xs" id="nov-cover-close">收起</button>
        </div>
        ${(d.notes || []).map((n) => `<div class="hint-xs" style="margin-top:4px">${esc(n)}</div>`).join('')}
        ${show.length ? show.map(rowOf).join('') : '<div class="hint-xs" style="margin-top:6px">每一段都抽到了卡片。</div>'}
      </div>`;
    const close = box.querySelector('#nov-cover-close');
    if (close) close.onclick = () => { box.innerHTML = ''; };
    // "重新解析"要真的把用户送到"只差一次点击"的位置：原文直接填回输入框，
    // 否则点了只把选中项清掉，用户还得自己去把几十万字再粘一遍（那等于没有出口）
    const reBtn = box.querySelector('#nov-cover-reparse');
    if (reBtn) reBtn.onclick = async () => {
      setBusy(reBtn, true, '取原文');
      const r2 = await api.storySource(sourceId);
      setBusy(reBtn, false);
      if (!r2.ok) { toast.err(r2.error); return; }
      textEl.value = r2.data.text || '';
      if (!titleEl.value.trim()) titleEl.value = r2.data.title || '';
      plan = null;
      renderPlanBox();
      location.hash = `#/novel?project=${encodeURIComponent(projectId)}`;
      toast.ok('原文已填好：确认后点「开始解析」，重新解析会新建一份（旧卡片与绑定都留着）', 'info');
    };
    const btn = box.querySelector('#nov-cover-retry');
    if (!btn) return;
    btn.onclick = async () => {
      // 补抽是**花钱**的动作：先说清要跑几段、只补不删，再动手
      const okGo = await costConfirm({
        count: bad,
        what: '补抽漏掉的段落',
        note: `只补这 ${bad} 段（${(d.needs_retry || []).slice(0, 6).map((i) => `第 ${i + 1} 段`).join('、')}${bad > 6 ? ' 等' : ''}）。`
          + '已有卡片只补字段、id 不变，不会把改好的卡片冲掉。',
      });
      if (!okGo) return;
      setBusy(btn, true, '提交中');
      const rr = await api.storyRetryChunks({ source_id: sourceId });
      setBusy(btn, false);
      if (!rr.ok) { toast.err(rr.error); return; }
      localStorage.setItem(JOB_KEY, rr.data.jobId);
      toast.ok(`已开始补抽 ${rr.data.count} 段`, 'info');
      pollJob(rr.data.jobId);
      await loadSources();
    };
  }

  container.querySelector('#nov-chap').onclick = () => {
    if (!projectId) { toast.err('先在右上角选一个项目'); return; }
    runChapters();
  };

  container.querySelector('#nov-cover').onclick = () => {
    if (!projectId) { toast.err('先在右上角选一个项目'); return; }
    runCoverage();
  };

  container.querySelector('#nov-audit').onclick = () => {
    if (!projectId) { toast.err('先在右上角选一个项目'); return; }
    runAudit();
  };

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
            <input class="input" id="e-name-${esc(c.id)}" data-f="name" maxlength="${STORY_CARD_FIELD_MAX.name}" value="${esc(c.name)}" /></div>
          <div class="field"><label for="e-sum-${esc(c.id)}">摘要</label>
            <textarea class="textarea" id="e-sum-${esc(c.id)}" data-f="summary" maxlength="${STORY_CARD_FIELD_MAX.summary}" rows="3">${esc(c.summary || '')}</textarea></div>
          ${fields.map((f) => `<div class="field"><label for="e-${esc(f)}-${esc(c.id)}">${esc(STORY_CARD_FIELD_LABELS[f] || f)}</label>
            ${f === 'role'
              ? `<select class="select" id="e-${esc(f)}-${esc(c.id)}" data-f="${esc(f)}">${options(STORY_ROLE_OPTIONS.map((v) => ({ value: v, label: v })), 'value', 'label', c[f])}</select>`
              : f === 'stage'
                ? `<select class="select" id="e-${esc(f)}-${esc(c.id)}" data-f="${esc(f)}">${options(STORY_STAGE_OPTIONS.map((v) => ({ value: v, label: v })), 'value', 'label', c[f])}</select>`
                : `<input class="input" id="e-${esc(f)}-${esc(c.id)}" data-f="${esc(f)}" maxlength="${STORY_CARD_FIELD_MAX[f] || 200}" value="${esc(c[f] || '')}" />`}</div>`).join('')}
          <div class="field"><label for="e-alias-${esc(c.id)}">别名（顿号或逗号分隔）</label>
            <input class="input" id="e-alias-${esc(c.id)}" data-f="aliases" value="${esc((c.aliases || []).join('、'))}" /></div>
          ${CARD_IMAGE_KINDS.includes(c.kind) ? `<div class="field"><label>参考图<span style="color:var(--text-4);font-weight:400">（从本项目的图片里挑，出图时会自动带上——同一个场景/道具前后一致就靠它）</span></label>
            ${imgs.length ? `<div class="ref-grid" id="e-refs-${esc(c.id)}">
              ${imgs.map((i) => `
                <label class="ref-item${(c.reference_image_ids || []).includes(i.id) ? ' on' : ''}" data-ref="${esc(i.id)}" title="${esc(i.prompt || i.name || '')}">
                  <input type="checkbox" ${(c.reference_image_ids || []).includes(i.id) ? 'checked' : ''} aria-label="选为参考图" />
                  ${imgWithFallback(i.url || i.remote_url, { alt: String(i.name || '参考图').slice(0, 30), cls: 'ref-thumb' })}
                </label>`).join('')}
            </div>` : `<div class="note">本项目还没有图片素材——参考图可以留空，也可以先去「图片生成」出一张场景/道具图再回来挂上。</div>`}
          </div>` : ''}
        </div>`;
    }
    const bits = fields.filter((f) => c[f]).slice(0, 4)
      .map((f) => `<span class="hint-xs"><b>${esc(STORY_CARD_FIELD_LABELS[f] || f)}</b> ${esc(String(c[f]).slice(0, 40))}</span>`).join('');
    return `
      <div class="card" style="margin-bottom:10px">
        <div class="row" style="margin-bottom:6px">
          <span class="chip">${esc(storyKindLabel(c.kind))}</span>
          <b>${esc(c.name)}</b>
          ${c.edited ? '<span class="chip on" title="你改过这张卡：追加解析/重新归并都不会覆盖它，模型只能补它空着的字段">已改</span>' : ''}
          <div class="spacer"></div>
          ${c.kind === 'character' ? `<button class="btn btn-xs" data-tochar="${esc(c.id)}">${icon('users', 12)}入资产库</button>` : ''}
          <button class="btn btn-xs" data-src-of="${esc(c.id)}" title="看这张卡是从原文哪一段读出来的">${icon('book', 12)}看原文</button>
          <button class="btn btn-xs" data-edit="${esc(c.id)}">${icon('edit', 12)}</button>
          <button class="btn btn-xs btn-danger" data-del-card="${esc(c.id)}">${icon('trash', 12)}</button>
        </div>
        ${c.summary ? `<div class="hint" style="margin-bottom:6px">${esc(c.summary)}</div>` : ''}
        ${bits ? `<div class="row wrap" style="gap:10px">${bits}</div>` : ''}
        ${(c.aliases || []).length ? `<div class="hint-xs">别名：${esc(c.aliases.join('、'))}</div>` : ''}
        <div class="hint-xs">来源：${c.origin === 'bible' ? '全局归并' : esc(chunkChapter[c.chunk_index] || `第 ${(c.chunk_index ?? 0) + 1} 段`)} · 出现 ${c.mentions || 1} 次 · 证据段 ${(c.evidence || []).map((i) => i + 1).join('/') || '—'}</div>
        <div id="nov-src-${esc(c.id)}" data-src-slot="${esc(c.id)}" hidden></div>
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

  /**
   * AI 回原文补人物长相（批 8 补 33）。
   *
   * 刻意**不**在前端算"有几张缺长相"：那个判据在服务端（`story.needsLook`，体检也用它），
   * 前端再抄一份迟早会漂（补 30 的教训）。所以按钮**总是**在，点下去先干跑 ——
   * 干跑是纯本地的、不要钱，它会如实告诉你"有几张"或"一张都不缺"。
   */
  /**
   * 回原文补字段（批 8 补 33 补长相，补 34 泛化到场景/道具）。**一个函数、按目标取配置** ——
   * 两条路只有"叫什么、报什么"不同，机制完全一样（先干跑 → 计费确认 → 分开报三种没写成）。
   *
   * 刻意**不**在前端算"有几张缺"：判据在服务端（`story.FILL_SPECS[*].missing`，体检也用它），
   * 前端再抄一份迟早会漂（补 30 的教训）。所以按钮**总是**在，点下去先干跑 ——
   * 干跑是纯本地的、不要钱，它会如实告诉你"有几张"或"一张都不缺"。
   */
  const FILL_TARGETS = {
    char_look: {
      what: '补人物长相', label: '人物长相', unit: '张人物卡',
      empty: '所有人物卡都已经有外貌或服装了',
    },
    card_inject: {
      what: '补场景道具字段', label: '场景/道具描述', unit: '张卡片',
      empty: '所有地点卡/道具卡都已经有可注入的描述',
    },
    timeline_when: {
      what: '补时间点', label: '时间点', unit: '张时间线卡',
      empty: '所有时间线卡都已经有时间点了',
    },
    /**
     * 回原文补人物卡（批 8 补 43）：与上面三项**同一套机制**（干跑 → 计费确认 → 引文核对 → 分桶上报），
     * 只是落点是**新增一张卡**而不是改字段，所以走另一个端点（`storyCastFill`）。报告形状与它们同构，
     * 于是报告渲染器、分桶文案、按钮忙碌态**一行都不用另写**。
     */
    cast_card: {
      what: '回原文补人物卡', label: '人物档案', unit: '个名字', verb: '新建',
      empty: '剧情卡里提到的名字都已经有人物卡或角色库档案了',
      cast: true,
      note: '这些名字出现在剧情卡的「涉及人物」里，但项目里还没有他们的人物卡 —— 请模型回原文确认他是谁，'
        + '并**直接建出这张卡**（外貌/服装/身份/性格等）。模型必须交出原文里的**原话**作为依据，'
        + '与原文对不上的一律丢弃、**一张卡都不会建**；原文里找不到这个人（泛称/代称）会如实报"没找到"，'
        + '同样不建卡 —— 宁可少建一张，也不建一张编出来的卡（编的卡会进剧本提示词与角色名册，'
        + '而"它是编的"在界面上完全看不出来）。',
    },
  };

  /**
   * 补字段报告：**逐张列出"写进去的值 ← 它的原文原话"**。
   *
   * 引文是这个机制唯一可核对的东西 —— 只报一个张数（或一闪而过的 toast），用户就只能盲信，
   * 而"模型编的"与"原文真写的"在卡片上长得一模一样。时间点这类**事实型**字段尤其如此：
   * 引文可能是真的、但**认错了是哪一句**（同一段里既有"三年前"又有"次日"），
   * 只有把原话摆在写进去的值旁边，人才能一眼看出来 —— 这也是本轮先做"引文可见"、再做时间点的原因。
   * 值取的是**实际落库**的那一份（服务端截断之后），不是模型的提议：报告与卡片必须是同一份数据。
   */
  function renderFillReport(d, cfg) {
    const box = container.querySelector('#nov-fill-box');
    const items = d.assigned_items || [];
    const rowOf = (x) => `
      <div class="row" style="gap:8px;align-items:flex-start;padding:6px 0;border-top:1px solid var(--line)">
        <span class="chip green" style="flex:none">已写入</span>
        <div style="flex:1;min-width:0">
          <div class="hint-xs"><b>${esc(x.name)}</b></div>
          ${(x.fields || []).map((f) => `<div class="hint-xs">${esc(STORY_CARD_FIELD_LABELS[f] || f)}：<b>${esc(String((x.values || {})[f] || ''))}</b></div>`).join('')}
          ${x.quote ? `<div class="hint-xs" style="opacity:.75;margin-top:2px">依据原文原话：「${esc(x.quote)}」</div>` : ''}
        </div>
      </div>`;
    // 三种"没写成"分开列，且**各带名字** —— 只说"有 3 张没写"，用户还得自己去几十张卡里找是哪三张
    const bucket = (title, arr, cls) => ((arr || []).length
      ? `<div class="hint-xs" style="margin-top:6px"><span class="chip ${cls}">${esc(title)}</span> ${(arr || []).map((x) => esc(x.name)).join('、')}</div>`
      : '');
    box.innerHTML = `
      <div class="card" style="margin-bottom:10px;padding:12px">
        <div class="row wrap" style="gap:6px;align-items:center">
          <b>${esc(cfg.what)}：${esc(cfg.verb || '写入')} ${d.assigned}/${d.targets} ${esc(cfg.unit)}</b>
          <div class="spacer"></div>
          <button class="btn btn-xs" id="nov-fill-close">收起</button>
        </div>
        <div class="hint-xs" style="margin-top:4px">下面每一${cfg.cast ? '张新卡' : '张'}都能核对：写进去的值 ← 它依据的原文原话。对不上原文的一条都没写。</div>
        ${d.note ? `<div class="hint-xs" style="margin-top:6px">${esc(d.note)}</div>` : ''}
        ${items.length ? items.map(rowOf).join('') : ''}
        ${bucket(`原文确实没写（${(d.not_found || []).length} ${cfg.unit}）—— 这是结论，不是失败`, d.not_found, 'gray')}
        ${bucket(`引文对不上原文，已丢弃${cfg.cast ? '、一张卡都没建' : '不写'}（${(d.ungrounded || []).length} ${cfg.unit}）—— 那是它编的`, d.ungrounded, 'red')}
        ${bucket(`没接住，${cfg.cast ? '没有建卡' : '已保持原样'}（模型没给全或编号越界）`, (d.missing || []).concat(d.invalid || [], d.empty || []), 'gold')}
        ${d.no_source ? `<div class="hint-xs" style="margin-top:6px"><span class="chip blue">没有原文出处，已跳过</span> ${d.no_source} ${esc(cfg.unit)}（人工新建或来自全局归并、没有段号，回原文找无从谈起）</div>` : ''}
        ${d.aligned === false ? '<div class="hint-xs" style="margin-top:6px;color:var(--warn)">这份原著的重新切块与解析时不一致，补上的内容请人工核对一遍。</div>' : ''}
      </div>`;
    const close = box.querySelector('#nov-fill-close');
    if (close) close.onclick = () => { box.innerHTML = ''; };
  }

  async function fillFields(target, btn) {
    const cfg = FILL_TARGETS[target];
    if (!sourceId) { toast.err('先在左侧选中一份解析记录'); return; }
    // 补字段走 field-fill（target 选规格），补一张卡走 cast-fill（落点是新增）——
    // 只差"调哪个端点"，其余（干跑、确认、分桶、报告）全部共用
    const call = (opts) => (cfg.cast ? api.storyCastFill(sourceId, opts) : api.storyFieldFill(sourceId, target, opts));
    const dry = await call({ dryRun: true });
    if (!dry.ok) { toast.err(dry.error); return; }
    if (!dry.data.targets) { toast.ok(cfg.empty); return; }
    const noSrc = dry.data.no_source || 0;
    const names = cfg.cast ? (dry.data.candidates || []).map((c) => c.name) : [];
    const yes = await costConfirm({
      count: 1,
      what: cfg.what,
      note: (cfg.note || `有 ${dry.data.targets} ${cfg.unit}还缺${cfg.label}，全部一次交给模型回原文找，只调 1 次。`
        + '模型必须交出原文里的**原话**作为依据，与原文对不上的一律丢弃；原文确实没写的会如实报"没写"，'
        + '绝不会拿编的顶上。')
        + `${names.length ? ` 这次要确认的名字：${names.slice(0, 6).join('、')}${names.length > 6 ? '…' : ''}。` : ''}`
        + `${noSrc ? `其中 ${noSrc} ${cfg.unit}没有可定位的原文出处，会被跳过（回原文找无从谈起）。` : ''}`,
    });
    if (!yes) return;
    // **必须传按钮**，不能传 container：setBusy 会把 innerHTML 换成 spinner，
    // 传容器会把整页抹掉 —— 下面 `renderFillReport` 与 `loadCards` 都会对着一个 spinner 找节点 → 报错。
    // 补 33/34 就是这么写的：toast 报"已补 N 张"，而报告没出来、卡片**从来没有刷新**、
    // 页面监听也随 innerHTML 一起没了（"成功但页面已经变哑"是最难发现的一类失败）
    setBusy(btn, true, '正在回原文找');
    try {
      const r = await call();
      if (!r.ok) { toast.err(r.error); return; }
      const d = r.data;
      toast.ok(`已${cfg.verb || '补'} ${d.assigned}/${d.targets} ${cfg.unit}的${cfg.label}`);
      // 三种"没写成"分开说：原文没写 / 引文对不上原文 / 没给全 —— 合成一个数就分不清"原著没写"和"模型在编"
      const nf = (d.not_found || []).length;
      const ug = (d.ungrounded || []).length;
      const rest = (d.missing || []).length + (d.invalid || []).length + (d.empty || []).length;
      if (nf) toast(`有 ${nf} ${cfg.unit}原文里确实没写${cfg.label}（这是结论，不是失败）：${(d.not_found || []).slice(0, 3).map((x) => x.name).join('、')}${nf > 3 ? '…' : ''}`, 'info', 7000);
      if (ug) toast.err(`有 ${ug} ${cfg.unit}模型的引文对不上原文，已丢弃不写（那是它编的）：${(d.ungrounded || []).slice(0, 3).map((x) => x.name).join('、')}${ug > 3 ? '…' : ''}`);
      if (rest) toast.err(`另有 ${rest} ${cfg.unit}没接住（模型没给全，或返回的编号越界），已保持原样`);
      if (d.no_source) toast(`有 ${d.no_source} ${cfg.unit}没有可定位的原文出处，已跳过`, 'info', 6000);
      if (d.aligned === false) toast.err('这份原著的重新切块与解析时不一致，补上的内容请人工核对一遍');
      // toast 会消失、报告不会：引文必须留在页面上，用户才有机会核对（补 35）
      renderFillReport(d, cfg);
      await loadCards();
    } finally { setBusy(btn, false); }
  }

  container.querySelector('#nov-look').onclick = (e) => fillFields('char_look', e.currentTarget);
  container.querySelector('#nov-inject').onclick = (e) => fillFields('card_inject', e.currentTarget);
  container.querySelector('#nov-when').onclick = (e) => fillFields('timeline_when', e.currentTarget);
  container.querySelector('#nov-cast').onclick = (e) => fillFields('cast_card', e.currentTarget);

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
  if (sourceId) {
    await loadCards();
  } else {
    const box0 = container.querySelector('#nov-cards');
    box0.innerHTML = `<div class="card">${empty('还没有选中原著', '左侧点一条解析记录，或用上面的输入框开始解析', 'layers', { label: '去粘贴原文', act: 'focus-text' })}</div>`;
    const b0 = box0.querySelector('[data-act="focus-text"]');
    if (b0) b0.onclick = () => { textEl.scrollIntoView({ block: 'center' }); textEl.focus(); };
  }
  // 从一致性体检"去处理"跳进来：卡片工作台可能还停在别处，这里滚到那张卡并提示它为什么被点名。
  // 注意别把它塞进上面的 if/else 中间 —— 那会让 else 挂到 focusCardId 上，
  // 于是**每次正常打开原著页**（没有 card_id）都会用"还没有选中原著"盖掉刚加载出来的卡片
  // （写这段时真的这么错过一次，只有真机浏览器测试抓得到：文本断言与语法检查全绿）。
  if (focusCardId) {
    const el = container.querySelector(`[data-card="${focusCardId}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.style.borderColor = 'var(--accent)';
    } else if (!sourceId) {
      toast('这张卡属于另一份原著：先在左侧点选它所在的那份，再回来挂参考图', 'info', 6000);
    }
  }

  // 从一致性体检"去处理"跳进来（panel=outline）：把「分集大纲」面板直接打开。
  // 那条体检项说的是"没标幕次就排不出分集"，而补幕次的按钮就在这个面板里 ——
  // 让用户自己去找这个按钮，等于体检只给了结论、没给出口（批 8 补 32）
  if (params.panel === 'outline' && sourceId) {
    await runOutline();
    const ob = container.querySelector('#nov-outline-box');
    if (ob) ob.scrollIntoView({ block: 'center' });
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
