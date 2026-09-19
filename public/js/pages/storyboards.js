/**
 * storyboards.js — 分镜制作
 * 分镜表是整个链路的中枢：往下接图片生成，再往下接视频生成。
 * 支持批量补提示词、批量出图、批量出视频（带队列进度）。
 */
import {
  icon, esc, extractJsonArray, copyText, SHOT_TYPES, STORYBOARD_STATUS, secondsToFrames, sizeForAspect, artStylePhrase, characterPhrase,
  storyCardPhrase, storyCardLook, STORY_CARD_INJECT_FIELDS, STORY_CARD_LABELS, characterRoster,
  effectiveVideoSeconds, VIDEO_DURATION_RANGE,
  CAMERA_MOVES, CAMERA_MOVE_GROUPS, cameraMovePhrase, cameraMoveAffectsStill,
} from '../consts.js';
import { api } from '../api.js';
import { modal, toast, empty, spinner, skeleton, twoClick, confirm, options, setBusy, costConfirm, imgWithFallback, notice } from '../ui.js';
import { head, projectPicker, renderBatchBar, makeTokenStore } from './helpers.js';
import { charCount, limitState, FIELD_SOFT_LIMIT } from '../textstats.js';
import { state, onEvent, syncViewParams, loadCharacters } from '../app.js';

export default async function storyboards(container, params) {
  let projectId = params.project || (state.projects[0] && state.projects[0].id) || '';
  let episode = Number(params.episode || 1);
  const aspectOf = () => (state.projects.find((p) => p.id === projectId) || {}).aspect_ratio; // T-1：画幅单源
  // R14：本项目的角色档案（bootstrap 随 state 下发，不再单独请求）
  const charsOf = () => (state.characters || []).filter((c) => c.project_id === projectId);
  // 批 8 补 2：本项目可注入的原著卡片（只含地点卡/道具卡，与后端 STORY_CARD_INJECT_FIELDS 同源）
  const cardsOf = () => (state.storyCards || []).filter((c) => c.project_id === projectId && STORY_CARD_INJECT_FIELDS[c.kind]);
  async function loadStoryCards(pid) {
    if (!pid) return;
    const r = await api.storyCards({ projectId: pid });
    state.storyCards = (r.ok && r.data) || [];
  }
  let rows = [];
  const selected = new Set();
  let job = null;

  container.innerHTML = `
    ${head({
      title: '分镜制作',
      desc: '管理分镜表：补提示词 → 批量出图 → 批量出视频，一条龙',
      actions: `
        ${projectPicker(state.projects, projectId, { id: 'p-picker', allowEmpty: true, emptyLabel: '未选择项目' })}
        <select class="select select-sm" id="ep" style="width:110px"></select>
        <button class="btn" id="reload" title="刷新">${icon('refresh', 16)}</button>`,
    })}

    <div class="card" style="margin-bottom:18px">
      <div class="card-title">${icon('wand', 15)}从脚本一键生成分镜表</div>
      <textarea class="textarea mono" id="script-in" aria-label="脚本内容" rows="4" placeholder="粘贴单集脚本或分镜脚本内容，点「生成分镜」由 Agnes 拆成镜头表…"></textarea>
      <div class="hint-xs" id="script-in-stat" style="margin-top:6px"></div>
      <div class="hint-xs" id="roster-hint" style="margin-top:4px"></div>
      <div class="row wrap" style="margin-top:12px">
        <button class="btn btn-primary btn-sm" id="gen-sb">${icon('wand', 14)}生成第 ${episode} 集分镜</button>
        <button class="btn btn-sm" id="gen-eps-sb" title="按已保存的分集剧本逐集生成分镜（每集一次模型调用）">${icon('grid', 14)}逐集生成分镜</button>
        <button class="btn btn-sm" id="add-shot">${icon('plus', 14)}手动添加镜头</button>
        <button class="btn btn-sm" id="sb-autobind" title="按「出场人物」与提示词文本，把项目里的角色与地点/道具卡自动绑到对应镜头（纯本地匹配，不调模型）">${icon('link', 14)}自动匹配绑定</button>
        <div class="spacer"></div>
        <button class="btn btn-sm" id="gen-img-prompts">${icon('image', 14)}批量补图片提示词</button>
        <button class="btn btn-sm" id="gen-vid-prompts">${icon('video', 14)}批量补视频提示词</button>
      </div>
    </div>

    <div id="batch-bar"></div>

    <div class="card" style="padding:14px 16px;margin-bottom:14px">
      <div class="row wrap">
        <label class="row" style="gap:7px;font-size:12.5px;color:var(--text-2);cursor:pointer">
          <input type="checkbox" id="sel-all" /> 全选
        </label>
        <span style="font-size:12px;color:var(--text-3)" id="sel-count">已选 0 个镜头</span>
        <div class="spacer"></div>
        <button class="btn btn-sm" id="batch-img">${icon('image', 14)}批量生成图片</button>
        <button class="btn btn-sm" id="batch-vid">${icon('video', 14)}批量生成视频</button>
        <button class="btn btn-sm" id="exp-csv" title="本集分镜表 CSV（UTF-8 BOM，Excel 直开）">${icon('download', 13)}CSV</button>
        <button class="btn btn-sm" id="exp-md" title="本集提示词 Markdown（含画风注入，可直接交给外协管线）">${icon('download', 13)}MD</button>
        <button class="btn btn-sm btn-danger" id="clear-ep">${icon('trash', 14)}清空本集</button>
      </div>
    </div>

    <div id="table">${skeleton('row', 6)}</div>`;

  // R18：粘贴/输入时实时显示字数与软上限提醒（生成前就知道要发多少字）
  const syncScriptStat = () => {
    const el = container.querySelector('#script-in-stat');
    if (!el) return;
    const ta = container.querySelector('#script-in');
    const st = limitState(charCount(ta.value), FIELD_SOFT_LIMIT);
    el.textContent = ta.value.trim() ? st.text : '';
    el.classList.toggle('over', st.over);
  };
  container.querySelector('#script-in').oninput = syncScriptStat;
  syncScriptStat();

  const picker = container.querySelector('#p-picker');
  const epSel = container.querySelector('#ep');
  epSel.innerHTML = Array.from({ length: 30 }, (_, i) => i + 1)
    .map((n) => `<option value="${n}"${n === episode ? ' selected' : ''}>第 ${n} 集</option>`).join('');
  picker.onchange = () => { projectId = picker.value; selected.clear(); syncViewParams({ project: projectId, episode }); load(); };
  epSel.onchange = () => { episode = Number(epSel.value); selected.clear(); syncViewParams({ project: projectId, episode }); load(); };
  container.querySelector('#reload').onclick = () => load();
  container.querySelector('#gen-sb').onclick = genFromScript;
  container.querySelector('#gen-eps-sb').onclick = openBatchShots;
  container.querySelector('#add-shot').onclick = () => editShot(null);
  container.querySelector('#sb-autobind').onclick = autoBind;
  loadRoster(''); // 进页面就把"会不会带上名册"讲清楚，而不是等生成完才发现名字对不上
  container.querySelector('#gen-img-prompts').onclick = () => batchPrompts('image');
  container.querySelector('#gen-vid-prompts').onclick = () => batchPrompts('video');
  container.querySelector('#batch-img').onclick = () => batchImages();
  container.querySelector('#batch-vid').onclick = () => batchVideos();
  container.querySelector('#clear-ep').onclick = clearEpisode;
  // B4.6：导出跟着"当前项目+当前集"语境走
  container.querySelector('#exp-csv').onclick = () => { if (projectId) window.open(`/api/projects/${projectId}/export.csv?episode=${episode}`, '_blank'); else toast.err('请先选择项目——右上角下拉选一个，或去「项目管理」新建'); };
  container.querySelector('#exp-md').onclick = () => { if (projectId) window.open(`/api/projects/${projectId}/export.md?episode=${episode}`, '_blank'); else toast.err('请先选择项目——右上角下拉选一个，或去「项目管理」新建'); };
  container.querySelector('#sel-all').onchange = (e) => {
    selected.clear();
    if (e.target.checked) rows.forEach((r) => selected.add(r.id));
    renderTable();
  };

  // E7/4.5：批量任务跨页签、跨刷新找回——记 id、进页续订、可取消
  const BKEY = 'agnes.batch.last';
  /**
   * R22：批量任务里"每一行现在是什么状态"。key 是分镜 id（任务项里原样回传的 key），
   * 值是 pending|running|ok|fail|cancelled。表格据此画产出点——只看 job.done/total 的话，
   * 用户永远不知道是哪一镜在跑、哪一镜失败了。
   */
  let jobRowState = new Map();
  function syncJobRows(j) {
    const m = new Map();
    if (j && Array.isArray(j.items)) for (const it of j.items) if (it.key) m.set(it.key, it.state || 'pending');
    jobRowState = m;
  }

  const cancelBatch = () => {
    if (!job || !job.id) return;
    api.cancelBatch(job.id).then((r) => {
      if (r.ok) toast('已请求取消——在跑的那条完成后就停', 'info');
      else toast.err(r.error);
    });
  };
  const offBatch = onEvent('batch', (j) => {
    job = j;
    if (j.status !== 'running') localStorage.removeItem(BKEY);
    if (promptBusy) return; // E2：「批量补提示词」正占着 #batch-bar，结束后会补渲染，别互踩
    renderBatchBar(container.querySelector('#batch-bar'), j, cancelBatch);
    // R22：产出点要跟着任务实时变——只在结束时重绘的话，"正在跑"这个状态永远看不到。
    // 只重画表格（不动别的 DOM），避免把用户正在填的粘贴框或选中态冲掉。
    const prev = jobRowState;
    syncJobRows(j);
    if (rows.length && (prev.size || jobRowState.size)) renderTable();
    if (j.status !== 'running') {
      load();
      setTimeout(() => { job = null; jobRowState = new Map(); renderBatchBar(container.querySelector('#batch-bar'), null); }, 4000);
    }
  });
  (async () => {
    const saved = localStorage.getItem(BKEY);
    if (!saved) return;
    const r = await api.batch(saved);
    if (!r.ok) { localStorage.removeItem(BKEY); return; } // 服务重启后旧 job 已蒸发，别拿 404 骚扰
    if (r.data.status === 'running') {
      job = r.data;
      syncJobRows(r.data);
      if (!promptBusy) renderBatchBar(container.querySelector('#batch-bar'), r.data, cancelBatch);
      toast('发现进行中的批量任务，进度已续上', 'info');
    } else localStorage.removeItem(BKEY);
  })();

  async function load() {
    const el = container.querySelector('#table');
    if (!projectId) {
      el.innerHTML = `<div class="card">${empty('请先选择项目', '右上角下拉选一个项目，或去「项目管理」新建', 'folder', { label: '去项目管理', go: '#/projects' })}</div>`;
      return;
    }
    // 角色档案与分镜并行拉：预览要显示角色注入，快照过期会让预览与后端不一致
    // 角色档案 / 原著卡片与分镜并行拉：预览要显示注入，快照过期会让预览与后端不一致
    const [r, imgs] = await Promise.all([api.storyboards(projectId, episode), api.images(projectId), loadCharacters(projectId), loadStoryCards(projectId)]);
    if (!r.ok) { el.innerHTML = `<div class="note red">${esc(r.error)}</div>`; return; }
    rows = r.data || [];
    // 分镜 → 图片的映射，批量生成视频时用来判断是否走图生视频
    window.__imgMap = {};
    ((imgs.ok && imgs.data) || []).forEach((i) => { window.__imgMap[i.id] = i; });
    renderTable();
  }

  function syncSelAll() { // 2.6：全选钮与行选择双向同步，部分选中显示半选
    const sa = container.querySelector('#sel-all');
    if (!sa) return;
    sa.checked = rows.length > 0 && selected.size === rows.length;
    sa.indeterminate = selected.size > 0 && selected.size < rows.length;
  }

  function renderTable() {
    const el = container.querySelector('#table');
    container.querySelector('#sel-count').textContent = `已选 ${selected.size} 个镜头`;
    syncSelAll();
    if (!rows.length) {
      el.innerHTML = `<div class="card">${empty('第 ' + episode + ' 集还没有分镜', '在上面粘贴脚本点「生成分镜」，或手动添加镜头', 'film', { label: '去故事脚本页', go: '#/scripts' + (projectId ? '?project=' + encodeURIComponent(projectId) : '') })}</div>`;
      return;
    }
    el.innerHTML = `<div class="table-wrap"><table class="tbl">
      <thead><tr>
        <th style="width:36px"></th>
        <th style="width:52px">镜头</th>
        <th style="width:76px">景别</th>
        <th style="min-width:190px">画面描述</th>
        <th style="width:150px">人物 / 角色</th>
        <th style="min-width:130px">台词</th>
        <th style="width:54px">时长</th>
        <th style="min-width:200px">图片提示词</th>
        <th style="min-width:200px">视频提示词</th>
        <th style="width:64px" title="提示词 / 分镜图 / 视频 三道关的状态">产出</th>
        <th style="width:80px">状态</th>
        <th style="width:150px">操作</th>
      </tr></thead>
      <tbody>
        ${rows.map((s) => {
          const st = STORYBOARD_STATUS[s.status] || STORYBOARD_STATUS.pending;
          return `<tr>
            <td><input type="checkbox" data-sel="${esc(s.id)}" aria-label="选择镜头 #${esc(s.shot_number)}" ${selected.has(s.id) ? 'checked' : ''} /></td>
            <td style="font-family:var(--mono);color:var(--text)">#${esc(s.shot_number)}</td>
            <td><span class="badge gray">${esc(s.shot_type)}</span>${
              s.camera_move ? `<span class="badge gray cam-badge" title="运镜：${esc(cameraMovePhrase(s.camera_move) || '—')}${cameraMoveAffectsStill(s.camera_move) ? '' : '（仅视频生效，静帧图无法表达运动）'}">${esc(s.camera_move)}</span>` : ''}</td>
            <td><div class="cell-ellipsis" style="max-width:260px" title="${esc(s.scene_description)}">${esc(s.scene_description || '—')}</div>${cardBadges(s)}</td>
            <td>${charCell(s)}</td>
            <td><div class="cell-ellipsis" style="max-width:150px;color:var(--text-3)" title="${esc(s.dialogue)}">${esc(s.dialogue || '—')}</div></td>
            <td>${esc(s.duration_seconds)}s</td>
            <td>${promptCell(s, 'image_prompt')}</td>
            <td>${promptCell(s, 'video_prompt')}</td>
            <td>${outputCell(s)}</td>
            <td><span class="badge ${st.cls}">${esc(st.label)}</span></td>
            <td>
              <div class="row" style="gap:4px">
                <button class="icon-btn" data-edit="${esc(s.id)}" title="编辑" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('edit', 13)}</button>
                <button class="icon-btn" data-img="${esc(s.id)}" title="生成图片" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('image', 13)}</button>
                <button class="icon-btn" data-vid="${esc(s.id)}" title="生成视频" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('video', 13)}</button>
                <button class="icon-btn" data-up="${esc(s.id)}" title="上移" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('chevronUp', 13)}</button>
                <button class="icon-btn" data-down="${esc(s.id)}" title="下移" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('chevronDown', 13)}</button>
                <button class="icon-btn" data-del="${esc(s.id)}" title="删除" style="background:rgba(255,255,255,0.07);color:var(--text-2)">${icon('trash', 13)}</button>
              </div>
            </td>
          </tr>`;
        }).join('')}
      </tbody></table></div>`;

    el.querySelectorAll('[data-sel]').forEach((c) => {
      c.onchange = () => {
        const id = c.getAttribute('data-sel');
        c.checked ? selected.add(id) : selected.delete(id);
        container.querySelector('#sel-count').textContent = `已选 ${selected.size} 个镜头`;
        syncSelAll();
      };
    });
    const bind = (attr, fn) => el.querySelectorAll(`[data-${attr}]`).forEach((b) => { b.onclick = () => fn(b.getAttribute(`data-${attr}`), b); });
    bind('edit', (id) => editShot(rows.find((x) => x.id === id)));
    bind('img', (id, b) => genImage(rows.find((x) => x.id === id), b));
    bind('vid', (id, b) => genVideo(rows.find((x) => x.id === id), b));
    bind('del', (id, b) => twoClick(b, async () => { // 3.4：单镜头删除改就地两段确认
      const r = await api.deleteStoryboard(id);
      if (r.ok) { toast.ok('已删除'); load(); } else toast.err(r.error);
    }));
    bind('up', (id) => move(id, -1));
    bind('down', (id) => move(id, 1));
    el.querySelectorAll('[data-copy-prompt]').forEach((b) => {
      b.onclick = () => copyText(b.getAttribute('data-copy-prompt')).then(() => toast.ok('已复制提示词'));
    });
    // R23：提示词列就地编辑（见 inlineEdit 的注释）
    el.querySelectorAll('[data-inline]').forEach((b) => {
      b.onclick = () => inlineEdit(b);
    });
  }

  /**
   * R23 提示词就地编辑。
   *
   * 原来改一条提示词要开 15 个字段的宽弹窗——而"看着表格把几条英文提示词顺一遍"是最常见的动作，
   * 每次都开弹窗等于每次都要重新定位。这里点击直接把单元格换成 textarea。
   *
   * 三条刻意的取舍：
   * ① **保存后不 `load()`**：整表重渲染会把其它行的编辑态和选中态冲掉，还有与在途请求的竞态。
   *    只改 `rows` 里那一项 + 就地换回文本（报告的"风险注记"说的就是这个）。
   * ② **没改动不发请求**：blur 时值没变就直接收摊——否则点一下单元格再点别处就会写一次盘。
   * ③ **Esc 取消、Ctrl/⌘+Enter 立即保存**：长文本编辑里鼠标离开是常态，得有个"不改了"的出口。
   */
  function inlineEdit(btn) {
    const id = btn.getAttribute('data-inline');
    const cell = btn.closest('[data-prompt]');
    const field = cell.getAttribute('data-prompt');
    const row = rows.find((x) => x.id === id);
    if (!row) return;
    const before = String(row[field] || '');
    const ta = document.createElement('textarea');
    ta.className = 'textarea mono inline-edit';
    ta.rows = 3;
    ta.value = before;
    ta.setAttribute('aria-label', field === 'image_prompt' ? '就地编辑图片提示词' : '就地编辑视频提示词');
    cell.replaceChildren(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    let closed = false;  // 编辑态已收摊（收摊后不能再收一次）
    let saving = false;  // 保存中（防重复提交）
    const restore = (text) => {
      if (closed) return;
      closed = true;
      // 就地换回只读文本：走一次 renderTable 会把整表重建（丢焦点、丢选中），代价不值得
      const fresh = promptCell({ ...row, [field]: text }, field);
      const holder = document.createElement('div');
      holder.innerHTML = fresh;
      cell.replaceWith(holder.firstElementChild);
      const nb = container.querySelector(`[data-prompt="${field}"] [data-inline]`);
      if (nb) nb.onclick = () => inlineEdit(nb);
    };
    const save = async () => {
      if (closed || saving) return;
      const val = ta.value.trim();
      if (val === before) { restore(before); return; }
      saving = true;
      const r = await api.updateStoryboard(id, { [field]: val });
      if (!r.ok) {
        // 保存失败**不收摊**：用户刚敲的字不能因为一次网络抖动就蒸发，留在框里让他重试
        saving = false;
        toast.err(`${r.error}（内容还在编辑框里，可直接重试）`);
        return;
      }
      row[field] = val; // 只改这一项：rows 是渲染的唯一来源
      toast.ok(val ? '提示词已保存' : '提示词已清空');
      restore(val);
    };
    ta.onblur = save;
    ta.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); restore(before); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
    };
  }

  /** 绑定的原著卡片徽标（批 8 补 2）：让"这个镜头挂了哪些场景/道具"不打开弹窗就能看见 */
  function cardBadges(s) {
    const ids = Array.isArray(s.story_card_ids) ? s.story_card_ids : [];
    if (!ids.length) return '';
    const bound = ids.map((id) => cardsOf().find((c) => c.id === id)).filter(Boolean);
    if (!bound.length) return `<div class="row" style="gap:4px;margin-top:3px"><span class="badge red" title="绑定的原著卡片已被删除，点编辑可清理">原著卡片失效 ${ids.length}</span></div>`;
    const label = (c) => `${STORY_CARD_LABELS[c.kind] || c.kind}：${c.name}`;
    return `<div class="row" style="gap:4px;margin-top:3px;flex-wrap:wrap" title="出图/出视频时会把这几张卡的场景与道具描述统一注入：\n${esc(bound.map((c) => label(c)).join('\n'))}">
      ${bound.slice(0, 2).map((c) => `<span class="badge gray">${esc(c.name)}</span>`).join('')}
      ${bound.length > 2 ? `<span class="badge gray">+${bound.length - 2}</span>` : ''}
    </div>`;
  }

  /**
   * 人物单元格（R14）：结构化角色绑定优先展示，自由文本作为补充。
   * 两者都显示而不是二选一——老分镜只有文本，新分镜才有 id；只显示其中一种会让另一半"看起来丢了"。
   */
  function charCell(s) {
    const ids = Array.isArray(s.character_ids) ? s.character_ids : [];
    const bound = ids.map((id) => charsOf().find((c) => c.id === id)).filter(Boolean);
    const text = String(s.characters || '').trim();
    const title = [bound.map((c) => c.name).join('、'), text].filter(Boolean).join('\n') || '未指定人物';
    if (!bound.length && !text) return '<span style="color:var(--text-4)">—</span>';
    return `<div class="cell-ellipsis" style="max-width:150px" title="${esc(title)}">
      <div class="row" style="gap:4px;flex-wrap:wrap">
        ${bound.slice(0, 2).map((c) => `<span class="badge gray" title="${esc(c.name)}${c.is_locked ? '（外貌已锁定）' : ''}">${c.is_locked ? icon('lock', 9) : ''}${esc(c.name)}</span>`).join('')}
        ${bound.length > 2 ? `<span class="badge gray">+${bound.length - 2}</span>` : ''}
        ${text ? `<span style="color:var(--text-3)">${esc(text)}</span>` : ''}
        ${ids.length > bound.length ? `<span class="badge red" title="绑定的角色已被删除，点编辑可清理">失效 ${ids.length - bound.length}</span>` : ''}
      </div>
    </div>`;
  }

  /**
   * 提示词单元格（B4.2 计算态 + R15 角色维度）：
   * 预览必须与后端 finalPrompt 同序（内容 → 角色 → 画风），否则"看到的"和"发出去的"会分叉。
   * 徽标只标"哪一层被注入了"，完整最终词放 tooltip —— 表格里塞全文会撑爆列宽。
   */
  /**
   * R22 产出三状态点：提示词 / 图片 / 视频。
   *
   * 为什么是这三个：这是本产品一条镜头真正要经过的三道关（我们没有 TTS，硬凑一个音频点
   * 只会是永远灰着的装饰）。原来只有一个 `status` 单值，且它是"最后一道关"的结论——
   * 用户看不出"提示词齐了但图没出"和"图出了但视频没提交"的区别，而那恰恰是要不要点按钮的依据。
   *
   * 状态来自两处：持久字段（linked_image_id / linked_video_id / 提示词是否为空）
   * 与当前批量任务的逐项状态（在跑/失败）。
   */
  function dot(state, title) {
    const zh = { ok: '已完成', running: '进行中', fail: '失败', idle: '未开始', pending: '排队中', cancelled: '已取消' }[state] || state;
    return `<span class="dot ${esc(state)}" title="${esc(title)}：${esc(zh)}" role="img" aria-label="${esc(title)}${esc(zh)}"></span>`;
  }

  function outputCell(s) {
    const jobState = jobRowState.get(s.id);
    // 提示词：两条都有才算齐（缺哪条就生成不了对应产物）
    const hasIp = !!String(s.image_prompt || '').trim();
    const hasVp = !!String(s.video_prompt || '').trim();
    const promptState = hasIp && hasVp ? 'ok' : (hasIp || hasVp ? 'pending' : 'idle');
    const promptTitle = `提示词（图片${hasIp ? '有' : '无'}／视频${hasVp ? '有' : '无'}）`;
    // 图片：持久字段优先；没有就吃批量任务的在跑/失败态
    const imgState = s.linked_image_id ? 'ok'
      : (jobState === 'running' ? 'running' : (jobState === 'fail' ? 'fail' : (rowInflight.has(s.id) ? 'running' : 'idle')));
    const vidState = s.linked_video_id ? 'ok' : 'idle';
    return `<div class="dots">${
      dot(promptState, promptTitle)}${
      dot(imgState, '分镜图')}${
      dot(vidState, '视频')}</div>`;
  }

  function promptCell(s, field) {
    const text = s[field];
    // 空提示词也给一个就地编辑入口：以前"待生成"是个死文本，只能开 15 字段的弹窗才能填
    if (!text) {
      return `<div class="row prompt-cell" style="gap:6px" data-prompt="${field}">
        <button type="button" class="link-btn" data-inline="${esc(s.id)}" title="就地填写${field === 'image_prompt' ? '图片' : '视频'}提示词">待生成（点此填写）</button>
      </div>`;
    }
    const style = (state.projects.find((p) => p.id === projectId) || {}).art_style || '';
    const chars = (Array.isArray(s.character_ids) ? s.character_ids : [])
      .map((id) => charsOf().find((c) => c.id === id)).filter(Boolean);
    const cards = (Array.isArray(s.story_card_ids) ? s.story_card_ids : [])
      .map((id) => cardsOf().find((c) => c.id === id)).filter(Boolean);
    // 顺序必须与后端 finalPrompt 一致：内容 → 原著场景道具 → 角色 → 运镜 → 画风
    const withCards = storyCardPhrase(text, cards);
    const withChars = characterPhrase(withCards, chars);
    // 图片是静帧：运镜只认机位/视角类；视频列全量（见 consts.js cameraMovePhrase 的 forStill）
    const cam = cameraMovePhrase(s.camera_move, field === 'image_prompt');
    const withCam = cam && !withChars.toLowerCase().includes(cam.toLowerCase()) ? `${withChars}, ${cam}` : withChars;
    const final = artStylePhrase(withCam, style);
    const injected = chars.filter((c) => withChars.includes(c.name));
    // data-prompt 给测试与后续就地编辑一个稳定锚点（列内还有别的 .cell-ellipsis，靠选择器顺序取会取错）
    return `<div class="row prompt-cell" style="gap:6px" data-prompt="${field}">
      <button type="button" class="cell-ellipsis inline-target" data-inline="${esc(s.id)}" style="font-family:var(--mono);font-size:11px;max-width:180px;color:var(--text-3);text-align:left" title="点击就地编辑\n${final !== text ? `生成时实际发出：\n${esc(final)}` : esc(text)}">${esc(text)}</button>
      ${withCards !== text ? `<span class="prompt-tag" title="原著场景道具由系统统一注入：${esc(cards.filter((c) => withCards.includes(c.name)).map((c) => c.name).join('、'))}">+场景</span>` : ''}
      ${withChars !== withCards ? `<span class="prompt-tag" title="出场角色由系统统一注入：${esc(injected.map((c) => c.name).join('、'))}">+角色</span>` : ''}
      ${withCam !== withChars ? `<span class="prompt-tag" title="运镜由系统统一注入：${esc(cam)}">+运镜</span>` : ''}
      ${style && final !== withCam ? `<span class="prompt-tag" title="画风由系统统一注入：${esc(style)}">+画风</span>` : ''}
      <button class="icon-btn" data-copy-prompt="${esc(text)}" title="复制（不含系统注入的原著场景道具、角色与画风）" style="width:26px;height:26px;background:rgba(255,255,255,0.06);color:var(--text-3)">${icon('copy', 11)}</button>
    </div>`;
  }

  async function move(id, dir) {
    const idx = rows.findIndex((r) => r.id === id);
    const to = idx + dir;
    if (idx < 0 || to < 0 || to >= rows.length) return;
    const arr = rows.slice();
    [arr[idx], arr[to]] = [arr[to], arr[idx]];
    const r = await api.reorderStoryboards(arr.map((x) => x.id));
    if (r.ok) { rows = arr; renderTable(); } else toast.err(r.error);
  }

  // ── 从脚本生成分镜 ───────────────────────────────────────
  let genBusy = false;
  let batchStop = false;   // 逐集生成分镜的取消旗标（与批量出图的 cancelBatch 分开：两者互不干扰）
  /** 模型可能把 characters / sound_effect 返回成数组，统一拼成可读文本 */
  const flat = (v) => Array.isArray(v)
    ? v.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : String(x))).join('、')
    : String(v ?? '');

  /**
   * 逐集生成分镜（批 8 补 9）：剧本已经按集存好了（补 8 的 episode_number），这里顺着它一集一集往下做。
   * 三条纪律与逐集生成剧本一致：**先确认调用次数**、**失败只丢这一集**、**可取消**；
   * 另加一条：**已经有分镜的集默认跳过**（重跑一次就会把同一集的分镜翻倍，那是灾难性的）。
   */
  async function openBatchShots() {
    if (genBusy) { toast.err('正在生成中，等这一次结束再开始逐集生成'); return; }
    if (!projectId) { toast.err('请先选择项目'); return; }
    const plan = await api.storyEpisodes({ project_id: projectId });
    if (!plan.ok || !plan.data.episode_count) {
      await notice({
        title: '还没有分集骨架',
        lines: [
          '逐集生成分镜要先有<b>分集剧本</b>，而分集骨架来自原著解析里的剧情卡。',
          '到「原著解析」粘贴/上传小说 → 解析出卡片 → 看「分集大纲」；再到「故事脚本」页用「逐集生成」把每集剧本生成出来。',
        ],
        okText: '知道了',
      });
      return;
    }
    const n = plan.data.episode_count;
    const sr = await api.scripts(projectId);
    const byEp = new Map();
    for (const sc of (sr.ok ? sr.data : [])) {
      if (sc.script_type !== 'episode_script' || !sc.episode_number) continue;
      // 同一集有多条（重生成过）时取最新的一条：列表按 created_at 倒序，第一条即最新
      if (!byEp.has(sc.episode_number)) byEp.set(sc.episode_number, sc);
    }
    if (!byEp.size) {
      await notice({
        title: '还没有分集剧本',
        lines: [
          '逐集生成分镜的输入是<b>按集保存的剧本</b>，现在一条都没有。',
          '到「故事脚本」页选「单集脚本」页签 → 「逐集生成」，生成完会自动按集存下来。',
        ],
        okText: '知道了',
      });
      return;
    }
    // 已有分镜的集数必须**按整部剧**统计：页面上的 rows 只有当前这一集，
    // 拿它判断"其它集有没有分镜"永远得到"没有"，重跑就会把那些集翻倍（这正是要防的事）
    const allShots = await api.storyboards(projectId);
    const countByEp = new Map();
    for (const r of (allShots.ok ? allShots.data : [])) {
      const k = Number(r.episode_number) || 1;
      countByEp.set(k, (countByEp.get(k) || 0) + 1);
    }
    const eps = [...byEp.keys()].sort((a, b) => a - b);
    const cfg = await new Promise((resolve) => {
      let settled = false;
      const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
      modal({
        title: '逐集生成分镜',
        body: `<div class="note">按已保存的分集剧本逐集生成，每集<b>调用一次模型</b>。分镜写进对应的那一集
          （不会串集），生成后同样按「出场人物」自动绑定角色/场景。</div>
          <div class="hint-xs" style="margin-top:8px">现有分集剧本：${eps.map((e) => `第 ${e} 集`).join('、')}（共 ${eps.length} 集，分集骨架 ${n} 集）</div>
          ${[...countByEp.keys()].length ? `<div class="hint-xs" style="margin-top:4px">已有分镜的集：${[...countByEp.entries()].sort((a, b) => a[0] - b[0]).map(([e, c]) => `第 ${e} 集(${c})`).join('、')}</div>` : ''}
          <div class="row wrap" style="gap:10px;margin-top:12px">
            <div class="field" style="flex:1;min-width:110px"><label for="bs-from">从第几集</label><input class="input" id="bs-from" type="number" min="1" max="${n}" value="${eps[0]}" /></div>
            <div class="field" style="flex:1;min-width:110px"><label for="bs-to">到第几集</label><input class="input" id="bs-to" type="number" min="1" max="${n}" value="${eps[eps.length - 1]}" /></div>
          </div>
          <label class="row" style="gap:8px;align-items:center;margin-top:12px;cursor:pointer">
            <input type="checkbox" id="bs-skip" checked />
            <span class="hint-xs">已经有分镜的集跳过（默认勾选：重跑不会把同一集的分镜翻倍）</span>
          </label>
          <div class="hint-xs" style="margin-top:8px">没有剧本的集会如实跳过、不会调用模型；中途可以取消，已经生成的集保留。</div>`,
        footer: `<button class="btn" data-no>取消</button><button class="btn btn-primary" data-yes>开始生成</button>`,
        onDismiss: () => settle(null),
        onMount(root, close) {
          root.querySelector('[data-no]').onclick = () => { settle(null); close(); };
          root.querySelector('[data-yes]').onclick = () => {
            settle({
              from: Math.max(1, Math.min(n, Number(root.querySelector('#bs-from').value) || 1)),
              to: Math.max(1, Math.min(n, Number(root.querySelector('#bs-to').value) || n)),
              skipExisting: !!root.querySelector('#bs-skip').checked,
            });
            close();
          };
        },
      });
    });
    if (cfg) runBatchShots(cfg, byEp, countByEp);
  }

  async function runBatchShots(cfg, byEp, countByEp) {
    const from = Math.min(cfg.from, cfg.to);
    const to = Math.max(cfg.from, cfg.to);
    const box = container.querySelector('#batch-bar');
    const btn = container.querySelector('#gen-eps-sb');
    const done = [];
    batchStop = false;
    genBusy = true;
    if (btn) btn.disabled = true;
    const paint = (cur, note) => {
      if (!box) return;
      const okN = done.filter((d) => d.ok).length;
      const skipN = done.filter((d) => d.skipped).length;
      const badN = done.filter((d) => !d.ok && !d.skipped).length;
      box.innerHTML = `<div class="card" style="margin-bottom:12px;padding:12px 14px">
        <div class="row" style="gap:10px;align-items:center">
          ${cur ? '<div class="spinner sm"></div>' : ''}
          <span style="font-size:12.5px">${esc(note)}</span>
          <div class="spacer"></div>
          <span class="hint-xs">成功 ${okN} · 跳过 ${skipN} · 失败 ${badN}</span>
          ${cur ? '<button class="btn btn-xs" id="bs-stop">取消</button>' : ''}
        </div>
        ${done.length ? `<div class="hint-xs" style="margin-top:6px">${done.map((d) => `${d.ok ? '✓' : (d.skipped ? '–' : '✗')}第 ${d.ep} 集`).join(' · ')}</div>` : ''}
      </div>`;
      const stop = box.querySelector('#bs-stop');
      if (stop) stop.onclick = () => { batchStop = true; stop.disabled = true; stop.textContent = '正在取消…'; };
    };
    for (let ep = from; ep <= to; ep++) {
      if (batchStop) { paint(null, '已取消'); break; }
      const sc = byEp.get(ep);
      if (!sc) { done.push({ ep, skipped: true, why: '没有剧本' }); continue; }
      if (cfg.skipExisting && countByEp.get(ep)) {
        done.push({ ep, skipped: true, why: `已有 ${countByEp.get(ep)} 个镜头` });
        continue;
      }
      paint(ep, `正在生成第 ${ep} 集分镜…`);
      const out = await shotsFromText(sc.content, ep, sc.id);
      if (out.ok) done.push({ ep, ok: true, inserted: out.inserted, bound: out.bound });
      else done.push({ ep, error: out.error });
    }
    genBusy = false;
    if (btn) btn.disabled = false;
    const okN = done.filter((d) => d.ok).length;
    const shotsN = done.reduce((a, d) => a + (d.inserted || 0), 0);
    const bad = done.filter((d) => !d.ok && !d.skipped);
    const skipped = done.filter((d) => d.skipped);
    paint(null, batchStop ? '已取消' : '逐集生成结束');
    if (okN) await load();
    const parts = [`完成 ${okN} 集 / ${shotsN} 个镜头`];
    if (skipped.length) parts.push(`跳过 ${skipped.length} 集（${skipped.map((d) => `第 ${d.ep} 集：${d.why}`).join('；')}）`);
    if (bad.length) parts.push(`失败 ${bad.length} 集（${bad.map((d) => `第 ${d.ep} 集：${d.error}`).join('；')}）`);
    if (bad.length) toast.err(parts.join(' · '), 9000);
    else toast.ok(parts.join(' · '));
  }

  /**
   * 一段脚本 → 某一集的分镜（生成 + 落库 + 生成即绑定）。
   * 单集生成与逐集生成**共用这一份**：两条路各写一份提示词与字段映射，迟早会出现
   * "单集生成有 13 个字段、批量生成少两个"这种静默漂移。
   * 不碰 UI（不 toast、不弹窗、不刷新）—— 那是调用方的事。
   */
  /**
   * @param {string} text 剧本正文
   * @param {number} ep 集号
   * @param {string} [sourceScriptId] 这份正文来自哪条剧本记录 —— 记下来才能判断
   *   "剧本后来改过没有"（批 8 补 12）。指纹由服务端按入库那一刻的正文算，前端不参与。
   */
  async function shotsFromText(text, ep, sourceScriptId) {
    const roster = await loadRoster(text);
    const r = await api.genText({
      messages: [
        { role: 'system', content: '你是专业的AI漫剧分镜导演。只输出 JSON，不要输出任何解释文字。每个镜头必须包含所有字段，英文图片/视频提示词要专业、详细。提示词只写镜头内容，不要写整体画风或媒介词（anime style、oil painting 等），也不要写人物长相——画风与人物长相都由系统在使用点统一注入，写进提示词会与注入的那份打架。characters(出场人物) 必须使用角色名册里的本名。' },
        {
          role: 'user',
          content: `请将以下脚本内容转换为分镜表。输出一个 JSON 对象，格式：{"shots": [ ...每个元素是一个镜头... ]}，每个镜头包含：
shot_number(数字)、shot_type(景别)、scene_description(画面描述)、characters(出场人物)、action(动作)、dialogue(台词)、narration(旁白)、sound_effect(音效)、duration_seconds(时长数字)、image_prompt(英文图片提示词)、video_prompt(英文视频提示词)、negative_prompt(英文负面提示词)。

${roster.text ? `${roster.text}\n\n` : ''}${text}`,
        },
      ],
      project_id: projectId,
      note: `分镜生成${ep > 1 ? ` 第 ${ep} 集` : ''}`,
      json_mode: true, // 走 response_format=json_object，杜绝语法坏 JSON
    });
    if (!r.ok) return { ok: false, error: `模型调用失败：${r.error}` };
    const shots = extractJsonArray(r.data.content);
    if (!shots || !shots.length) {
      const len = (r.data.content || '').length;
      return { ok: false, error: len ? `模型输出无法解析成镜头数组（共 ${len} 字符）` : '模型返回了空内容', raw: r.data.content || '' };
    }
    const rows2 = shots.map((s, i) => ({
      project_id: projectId,
      episode_number: ep,
      shot_number: Math.max(1, Number(s.shot_number) || i + 1),
      shot_type: flat(s.shot_type) || '中景',
      scene_description: flat(s.scene_description),
      characters: flat(s.characters),
      scene: flat(s.scene),
      action: flat(s.action),
      dialogue: flat(s.dialogue),
      narration: flat(s.narration),
      sound_effect: flat(s.sound_effect),
      duration_seconds: Number(s.duration_seconds) || 3,
      image_prompt: flat(s.image_prompt),
      video_prompt: flat(s.video_prompt),
      negative_prompt: flat(s.negative_prompt) || 'low quality, blurry, distorted face',
      status: 'pending',
      sort_order: i,
      source_script_id: sourceScriptId || null,
    }));
    const r2 = await api.createStoryboards(rows2);
    if (!r2.ok) return { ok: false, error: r2.error };
    // 生成即绑定：模型自己写了「出场人物」，名字能对上项目里的角色就直接绑上（只吃高置信那档）。
    // 不绑的话，用户得挨个镜头点一遍，不点就静默没有外貌注入。
    const rows = (r2.data && r2.data.rows) || [];
    const ab = await api.storyboardsAutoBind({
      project_id: projectId, storyboard_ids: rows.map((x) => x.id), strong_only: true,
    });
    return { ok: true, inserted: r2.data.inserted, bound: ab.ok ? ab.data.updated : 0, roster, rows };
  }

  async function genFromScript() {
    if (genBusy) return; // 双击会重复烧一次 API 配额
    const text = container.querySelector('#script-in').value.trim();
    if (!text) { toast.err('请先粘贴脚本内容'); return; }
    if (!projectId) { toast.err('请先选择项目——右上角下拉选一个，或去「项目管理」新建'); return; }
    // R18：超软上限不静默截断，也不硬拦——把"这次要发多少字、可能变慢"摆出来让用户决定
    const st = limitState(charCount(text), FIELD_SOFT_LIMIT);
    if (st.over && !(await confirm({
      title: '文本较长，确认要生成吗',
      text: `脚本 ${esc(st.text)}。<br>Agnes 侧可能变慢甚至超时（超时会保留已生成的部分或直接报错）。<br>建议先压缩，或分段生成。`,
      okText: '继续生成',
      cancelText: '先压缩一下',
    }))) return;
    const btn = container.querySelector('#gen-sb');
    genBusy = true;
    setBusy(btn, true, '分镜生成中');
    try {
      const out = await shotsFromText(text, episode);
      if (!out.ok) {
        if (out.raw === undefined) { toast.err(out.error); return; }
        // 解析失败不再只甩一句话：把原始输出亮出来，用户能自己判断问题在哪
        modal({
          title: '无法从模型输出中解析出镜头数组',
          wide: true,
          body: `<div class="note red" style="margin-bottom:10px">${esc(out.error)}（见下方原文）。可换更强的模型（如 agnes-2.5-pro）重试，或照原文手动录入。</div>
            <pre class="json-out" style="max-height:55vh;overflow:auto">${esc(out.raw)}</pre>`,
          footer: `<button class="btn" data-close>关闭</button>`,
        });
        return;
      }
      const named = out.roster.count ? `（已按 ${out.roster.count} 个角色的本名生成）` : '';
      toast.ok(out.bound
        ? `已生成 ${out.inserted} 个镜头${named}，并按「出场人物」自动绑定 ${out.bound} 个镜头的角色/场景（可点掉）`
        : `已生成 ${out.inserted} 个镜头${named}`);
      container.querySelector('#script-in').value = '';
      load();
    } finally {
      genBusy = false;
      setBusy(btn, false);
    }
  }

  /**
   * 取角色名册并渲染提示条。名字对齐是"一致性"最便宜的一环：
   * 模型照着本名写「出场人物」，第 8 补 5 的自动绑定才能命中，外貌注入才真的发生。
   */
  async function loadRoster(text) {
    const box = container.querySelector('#roster-hint');
    if (!projectId) { if (box) box.textContent = ''; return { count: 0, text: '' }; }
    const r = await api.characters(projectId);
    const roster = r.ok ? characterRoster(r.data, { text: text || '' }) : { count: 0, text: '' };
    if (box) {
      box.innerHTML = roster.count
        ? `${icon('check', 12)} 生成时会带上 ${roster.count} 个角色名册（名字 + 别名，长相不进提示词）——让分镜里的「出场人物」直接用本名，自动绑定才命中${roster.truncated ? `；另有 ${roster.truncated} 个角色名册过长未列出` : ''}`
        : '项目里还没有角色档案：生成出来的「出场人物」将无法自动绑定，也就不会有外貌注入（先到「角色库」建角色，或把原著解析出的人物卡一键入资产库）';
    }
    return roster;
  }

  // ── 自动匹配绑定（批 8 补 5）────────────────────────────
  /**
   * 分镜表是模型生成的，它只把"谁出场"写成自由文本，结构化绑定是空的 —— 不点就静默失去
   * 外貌/场景注入。这里把可判定的匹配（名字/别名出现在「出场人物」或提示词里）自动绑上。
   * 分两档：模型明确写了"出场人物"的直接绑；只是文本里出现过的先列出来让人确认（中文名字会撞词）。
   */
  async function autoBind() {
    if (!projectId) { toast.err('先选一个项目'); return; }
    const btn = container.querySelector('#sb-autobind');
    setBusy(btn, true);
    try {
      const dry = await api.storyboardsAutoBind({ project_id: projectId, episode_number: episode, dry_run: true });
      if (!dry.ok) { toast.err(dry.error); return; }
      const hits = (dry.data.matches || []).filter((m) => m.added_characters.length || m.added_cards.length);
      if (!hits.length) { toast('本集没有发现可以自动匹配的绑定——先确认分镜里写了「出场人物」，且项目里有对应角色/卡片', 'info', 6000); return; }
      const lines = hits.slice(0, 12).map((m) => {
        const names = m.added_characters.concat(m.added_cards)
          .map((x) => `${esc(x.name)}${x.weak ? '<span class="hint-xs">（提示词推断）</span>' : ''}`).join('、');
        return `#${m.shot_number} → ${names}`;
      });
      const more = hits.length > 12 ? `<div class="hint-xs">…另有 ${hits.length - 12} 个镜头</div>` : '';
      const okc = await confirm({
        title: '自动匹配绑定',
        text: `将在 <b>${hits.length}</b> 个镜头上补 ${dry.data.strong + dry.data.weak} 处绑定（其中 <b>${dry.data.weak}</b> 处是"提示词里出现过"的推断，可能撞词，请扫一眼）：<br><br>`
          + lines.join('<br>') + more
          + '<br><br>绑定只影响生成时注入的外貌/场景短语，<b>不会改写镜头内容</b>；绑错了可以在镜头卡片上点掉。',
        okText: '就这么绑',
      });
      if (!okc) return;
      const r = await api.storyboardsAutoBind({ project_id: projectId, episode_number: episode });
      if (!r.ok) { toast.err(r.error); return; }
      toast.ok(`已给 ${r.data.updated} 个镜头补上绑定（共 ${r.data.strong + r.data.weak} 处）`);
      load();
    } finally {
      setBusy(btn, false);
    }
  }

  // ── 批量补提示词 ─────────────────────────────────────────
  let promptBusy = false;
  async function batchPrompts(kind) {
    if (promptBusy) return;
    const targets = rows.filter((r) => !(kind === 'image' ? r.image_prompt : r.video_prompt));
    if (!targets.length) { toast.info('没有需要补充的镜头'); return; }
    promptBusy = true;
    const bar = container.querySelector('#batch-bar');
    let done = 0;
    let failed = 0; // E3：失败不再混进"已完成"计数
    try {
      for (const s of targets) {
        bar.innerHTML = `<div class="note gold"><div class="row"><div class="spinner sm"></div><span>${kind === 'image' ? '生成图片提示词' : '生成视频提示词'}：${done + failed + 1} / ${targets.length}（每条约 5〜20s）</span></div></div>`;
      // 批 8 补 7：提示词只写"这一镜发生了什么"，**由系统在使用点注入的东西一律不写** ——
      // 画风、人物长相、中文人名。写死的后果各不相同但都静默：换画风全部作废 / 与注入的长相打架导致换脸 /
      // 名字进提示词会让 characterPhrase 跳过外貌注入（未锁定的角色）。
      const sys = kind === 'image'
        ? '你是专业的AI漫剧分镜图提示词工程师，请生成适合图像生成的英文提示词，细节丰富。只写镜头内容（主体、动作、表情、景别构图、局部光效），并且**不要写整体画风或媒介词**（anime style、oil painting、watercolor 等——画风由系统在使用点统一注入，写死会导致换画风全部作废）；**不要写人物长相**（发色、瞳色、服装、面部特征——长相由系统按角色档案注入，写两遍会打架）；**不要写中文人名**（写进英文提示词没有意义，还会让系统跳过这个角色的外貌注入）。只输出提示词，不要解释。'
        : '你是专业的AI视频提示词工程师。请用英文输出，只描述画面运动与镜头运动，不要重复静态外观，也不要写画风/媒介词（由系统在使用点统一注入）。';
      // 人物只给"有谁"，不给长相：模型据此安排画面，长相仍由注入决定
      const who = flat(s.characters) || (Array.isArray(s.character_ids) ? s.character_ids
        .map((id) => (charsOf().find((c) => c.id === id) || {}).name).filter(Boolean).join('、') : '');
      const user = kind === 'image'
        ? `为以下分镜生成英文图片提示词：景别:${s.shot_type}，画面:${s.scene_description}，人物:${who}，动作:${s.action}`
        : `为以下分镜生成英文视频运动提示词：画面:${s.scene_description}，动作:${s.action}，台词:${s.dialogue}`;
        const r = await api.genText({ messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], project_id: projectId });
        if (r.ok) {
          const txt = (r.data.content || '').trim().replace(/^["']|["']$/g, '');
          await api.updateStoryboard(s.id, kind === 'image' ? { image_prompt: txt } : { video_prompt: txt });
          done++;
        } else failed++;
      }
      bar.innerHTML = failed
        ? `<div class="note orange">已为 ${done} 个镜头补充提示词，${failed} 条失败（保持原样，可重跑补差）</div>`
        : `<div class="note green">${icon('check', 14)} 已为 ${done} 个镜头补充${kind === 'image' ? '图片' : '视频'}提示词</div>`;
      setTimeout(() => { bar.innerHTML = ''; if (job) renderBatchBar(bar, job, cancelBatch); }, 3500);
      load();
    } finally {
      promptBusy = false;
    }
  }

  // ── 批量任务 ─────────────────────────────────────────────
  function targetShots() {
    const sel = rows.filter((r) => selected.has(r.id));
    return sel.length ? sel : rows;
  }

  let submitBusy = false; // R6：批量提交入口防双击——重复提交是真金白银
  async function batchImages() {
    if (submitBusy) return;
    const shots = targetShots().filter((s) => s.image_prompt);
    if (!shots.length) { toast.err('选中的镜头还没有图片提示词，先「批量补图片提示词」'); return; }
    // 付费确认期间再点不得叠出第二层弹窗（占位提前到确认之前）
    submitBusy = true;
    try {
      if (!(await costConfirm({ what: '图片', count: shots.length }))) return;
      const r = await api.batchImages({
        items: shots.map((s) => ({
          storyboard_id: s.id,
          project_id: projectId,
          prompt: s.image_prompt,
          size: sizeForAspect(aspectOf(), 'image'),
          usage_type: 'storyboard',
          label: `镜头 #${s.shot_number}`, // R22：随任务回传，刷新后进度链仍对得上镜头号
          key: s.id,                      // R22：逐项状态映射回表格行
        })),
        concurrency: 3,
      });
      if (r.ok) { localStorage.setItem(BKEY, r.data.jobId); toast.ok(`已提交 ${r.data.total} 张图片的批量任务`); }
      else toast.err(r.error);
    } finally {
      submitBusy = false;
    }
  }

  /** R2/R3 统一判定：镜头关联图能否作为图生视频输入（必须公网 URL；本地 /assets/… Agnes 抓不到） */
  function videoImageOf(s) {
    const img = s.linked_image_id ? (window.__imgMap?.[s.linked_image_id] || null) : null;
    const u = img ? (img.remote_url || img.url || '') : '';
    return /^https?:\/\//.test(u) ? u : '';
  }

  async function batchVideos() {
    if (submitBusy) return;
    const shots = targetShots().filter((s) => s.video_prompt);
    if (!shots.length) { toast.err('选中的镜头还没有视频提示词，先「批量补视频提示词」'); return; }
    // 有分镜图且图是公网 URL 的走图生视频；本地文件真正降级为文生视频（R2：toast 承诺与提交参数一致）
    let downgraded = 0;
    const items = shots.map((s) => {
      const imgUrl = videoImageOf(s);
      if (!imgUrl && s.linked_image_id) downgraded++;
      const body = {
        project_id: projectId,
        storyboard_id: s.id,
        mode: imgUrl ? 'image_to_video' : 'text_to_video',
        prompt: s.video_prompt,
        image: imgUrl || undefined,
        negative_prompt: s.negative_prompt,
        num_frames: secondsToFrames(s.duration_seconds),
        frame_rate: 24,
        label: `镜头 #${s.shot_number}`, // R22：同图片批量
        key: s.id,
        ...sizeForAspect(aspectOf(), 'video'),
      };
      // R25：每镜一个幂等键（scope 用镜头 id）。参数没变的重提会被服务端认出来——
      // 批量视频最典型的双计费场景就是"点了没反应，又点了一次"。
      body.client_token = batchTokenFor(s.id, JSON.stringify(body));
      return body;
    });
    if (downgraded) {
      toast.warn(`${downgraded} 个镜头的分镜图是本地文件，Agnes 无法抓取（需公网 URL），这些镜头已改用文生视频。`, 6500);
    }
    // R26：前置时长校验。视频是提交即计费、不可撤销的，等扣完费再告诉用户"你要的 30 秒
    // 实际只有 18 秒"是最差的一种惊喜。这里在**花钱之前**把偏差列清楚，让他自己决定。
    const drifted = shots.map((s) => {
      const want = Number(s.duration_seconds);
      const eff = effectiveVideoSeconds(want);
      return Number.isFinite(want) && want > 0 && Math.abs(eff - want) > 0.4 ? { shot: s.shot_number, want, eff } : null;
    }).filter(Boolean);
    if (drifted.length) {
      const lines = drifted.slice(0, 6).map((d) => `镜头 #${d.shot}：${d.want} 秒 → ${d.eff.toFixed(2)} 秒`).join('；');
      const more = drifted.length > 6 ? `……等 ${drifted.length} 个镜头` : '';
      const okGo = await confirm({
        title: '时长会被模型改写',
        text: `模型只接受 ${VIDEO_DURATION_RANGE.minSec.toFixed(2)}–${VIDEO_DURATION_RANGE.maxSec.toFixed(2)} 秒且按 8n+1 帧量化，以下镜头将按实际值提交：<br><br>${esc(lines)}${esc(more)}<br><br>想改的话先去分镜编辑里调时长；继续则按上面这些实际值计费。`,
        okText: '按实际值继续',
      });
      if (!okGo) return;
    }
    submitBusy = true;
    try {
      if (!(await costConfirm({ what: '视频', count: items.length, note: '视频按条计费且单价高于图片，确认镜头数与提示词后再提交。' }))) return;
      const r = await api.batchVideos({ items, concurrency: 1 });
      if (r.ok) {
        for (const it of items) batchTokenFor.clear(it.key); // R25：这批意图已完成，token 作废
        localStorage.setItem(BKEY, r.data.jobId);
        toast.ok(`已提交 ${r.data.total} 个视频任务（${items.some((i) => i.mode === 'image_to_video') ? '含图生视频' : '文生视频'}）`);
      } else toast.err(r.error);
    } finally {
      submitBusy = false;
    }
  }

  // 行内单发入口的在途集合：按镜头 id 去重（保留"多行可同时生成"的能力，
  // 只挡同一行连点——付费确认期间再点不得叠出第二层弹窗）。
  // R25：批量视频的幂等键仓库（scope = 镜头 id）。与单条提交同一套规则：
  // 参数没变的重试复用、成功后作废。
  const batchTokenFor = makeTokenStore();
  const rowInflight = new Set();
  const variationSeen = new Map(); // 分镜 id → 已出图次数（R21 变体轮换用）

  async function genImage(s, btn) {
    if (!s?.image_prompt) { toast.err('这个镜头还没有图片提示词——点「编辑」补上，或勾选后批量补提示词'); return; }
    if (rowInflight.has(s.id)) return;
    rowInflight.add(s.id);
    try {
      if (!(await costConfirm({ what: '图片', count: 1 }))) return;
      // R21 变体轮换：同一个镜头第 N 次出图（N≥2）自动追加一条"换机位/时段/构图"的短语，
      // 否则反复点生成只会拿到一串几乎一样的图。首次（0）不注入——第一张必须忠实于用户写的词。
      const seen = variationSeen.get(s.id) || 0;
      setBusy(btn, true);
      const r = await api.genImage({
        project_id: projectId,
        storyboard_id: s.id,
        prompt: s.image_prompt,
        size: sizeForAspect(aspectOf(), 'image'),
        usage_type: 'storyboard',
        variation: seen,
      });
      if (r.ok) {
        variationSeen.set(s.id, seen + 1);
        toast.ok(seen > 0 ? `图片已生成（第 ${seen + 1} 张，已自动换个机位/时段，避免与上一张雷同）` : '图片已生成并关联到分镜');
        load();
      } else toast.err(r.error);
    } finally {
      setBusy(btn, false);
      rowInflight.delete(s.id);
    }
  }

  async function genVideo(s, btn) {
    if (!s?.video_prompt) { toast.err('这个镜头还没有视频提示词——点「编辑」补上，或勾选后批量补提示词'); return; }
    if (rowInflight.has(s.id)) return;
    rowInflight.add(s.id);
    try {
      if (!(await costConfirm({ what: '视频', count: 1, note: '视频按条计费且单价高于图片。' }))) return;
      setBusy(btn, true, '', '视频生成通常需要 1〜3 分钟，可离开页面，任务在本地服务里继续跑');
      // R3：与批量路径同一判定——有可用分镜图就走图生视频，不再永远文生视频
      const imgUrl = videoImageOf(s);
      const r = await api.createVideo({
        project_id: projectId,
        storyboard_id: s.id,
        mode: imgUrl ? 'image_to_video' : 'text_to_video',
        prompt: s.video_prompt,
        image: imgUrl || undefined,
        negative_prompt: s.negative_prompt,
        num_frames: secondsToFrames(s.duration_seconds),
        frame_rate: 24,
        ...sizeForAspect(aspectOf(), 'video'),
      });
      if (r.ok) { toast.ok('视频任务已提交，去「镜头任务」看进度'); location.hash = '#/tasks'; }
      else toast.err(r.error);
    } finally {
      setBusy(btn, false);
      rowInflight.delete(s.id);
    }
  }

  async function clearEpisode() {
    if (!projectId) { toast.err('请先选择项目再清空本集'); return; }
    if (!(await confirm({
      text: `确定清空第 ${episode} 集的全部 ${rows.length} 个镜头吗？此操作不可撤销。`,
      danger: true, okText: '清空',
    }))) return;
    const r = await api.clearStoryboards(projectId, episode);
    if (r.ok) { toast.ok(`已清空 ${r.data.removed} 个镜头`); load(); } else toast.err(r.error);
  }

  // ── 镜头编辑弹窗 ─────────────────────────────────────────
  function editShot(shot) {
    const isNew = !shot;
    const s = shot || {
      shot_number: rows.length + 1, shot_type: '中景', scene_description: '', characters: '',
      scene: '', action: '', dialogue: '', narration: '', sound_effect: '', duration_seconds: 3,
      image_prompt: '', video_prompt: '', negative_prompt: 'low quality, blurry, distorted face',
    };
    const pickedChars = new Set(Array.isArray(s.character_ids) ? s.character_ids : []);
    const pickedCards = new Set(Array.isArray(s.story_card_ids) ? s.story_card_ids : []);
    modal({
      title: isNew ? '添加镜头' : `编辑镜头 #${s.shot_number}`,
      wide: true,
      body: `
        <div class="grid g2" style="gap:0 14px">
          <div class="field"><label for="s-num">镜头编号</label><input class="input" id="s-num" type="number" value="${esc(s.shot_number)}" /></div>
          <div class="field"><label for="s-type">景别</label><select class="select" id="s-type">${options(SHOT_TYPES, 'v', 'v', s.shot_type)}</select></div>
          <div class="field" style="grid-column:1/-1">
            <label for="s-cam">运镜<span style="color:var(--text-4);font-weight:400">（38 条按组归类；视频全量生效，静帧图只认机位/视角类）</span></label>
            <select class="select" id="s-cam">
              <option value="">（不指定）</option>
              ${CAMERA_MOVE_GROUPS.map((g) => `<optgroup label="${esc(g.group)}">${g.items.map((m) => `<option value="${esc(m.zh)}"${m.zh === s.camera_move ? ' selected' : ''}>${esc(m.zh)}${m.still ? '' : '（仅视频）'}</option>`).join('')}</optgroup>`).join('')}
            </select>
            <div class="hint-xs" id="s-cam-hint"></div>
          </div>
          <div class="field" style="grid-column:1/-1"><label for="s-desc">画面描述</label><textarea class="textarea" id="s-desc" rows="2">${esc(s.scene_description)}</textarea></div>
          <div class="field"><label for="s-chars">人物（自由文本）</label><input class="input" id="s-chars" value="${esc(s.characters)}" placeholder="例：林岚、老周（不想建档案时随手写）" /></div>
          <div class="field" style="grid-column:1/-1">
            <label>出场角色（角色库）<span style="color:var(--text-4);font-weight:400">（选中的角色会以档案里的长相/服装保持跨镜头一致）</span></label>
            ${charsOf().length
    ? `<div class="chips" id="s-char-pick">${charsOf().map((c) => `<button type="button" class="chip${(s.character_ids || []).includes(c.id) ? ' on' : ''}" data-char="${esc(c.id)}" title="${esc(c.appearance || '未填外貌')}">${c.is_locked ? icon('lock', 11) : ''}${esc(c.name)}</button>`).join('')}</div>`
    : '<div class="note">本项目还没有角色档案 —— 去「角色库」建一个主角，之后每个镜头挂上它，出图就不会换脸。</div>'}
          </div>
          <div class="field" style="grid-column:1/-1">
            <label>原著场景道具（地点卡 / 道具卡）<span style="color:var(--text-4);font-weight:400">（选中的卡片会在出图/出视频时统一注入描述，跨镜头不换场景）</span></label>
            ${cardsOf().length
    ? `<div class="chips" id="s-card-pick">${cardsOf().map((c) => `<button type="button" class="chip${(s.story_card_ids || []).includes(c.id) ? ' on' : ''}" data-card="${esc(c.id)}" title="${esc(storyCardLook(c) || '未填描述')}">${esc(STORY_CARD_LABELS[c.kind] || '')}·${esc(c.name)}</button>`).join('')}</div>`
    : '<div class="note">本项目还没有地点卡/道具卡 —— 去「原著解析」粘一段原文解析一次，或手工在卡片工作台补。</div>'}
          </div>
          <div class="field"><label for="s-scene">场景</label><input class="input" id="s-scene" value="${esc(s.scene)}" /></div>
          <div class="field" style="grid-column:1/-1"><label for="s-action">动作</label><input class="input" id="s-action" value="${esc(s.action)}" /></div>
          <div class="field"><label for="s-dlg">台词</label><textarea class="textarea" id="s-dlg" rows="2">${esc(s.dialogue)}</textarea></div>
          <div class="field"><label for="s-nar">旁白</label><textarea class="textarea" id="s-nar" rows="2">${esc(s.narration)}</textarea></div>
          <div class="field"><label for="s-sfx">音效</label><input class="input" id="s-sfx" value="${esc(s.sound_effect)}" /></div>
          <div class="field"><label for="s-dur">时长（秒）</label><input class="input" id="s-dur" type="number" min="${VIDEO_DURATION_RANGE.minSec.toFixed(2)}" max="${VIDEO_DURATION_RANGE.maxSec.toFixed(2)}" step="0.5" value="${esc(s.duration_seconds)}" />
            <div class="hint-xs" id="s-dur-hint"></div></div>
          <div class="field" style="grid-column:1/-1"><label for="s-ip">图片提示词</label><textarea class="textarea mono" id="s-ip" rows="3">${esc(s.image_prompt)}</textarea></div>
          <div class="field" style="grid-column:1/-1"><label for="s-vp">视频提示词</label><textarea class="textarea mono" id="s-vp" rows="3">${esc(s.video_prompt)}</textarea></div>
          <div class="field" style="grid-column:1/-1"><label for="s-np">负面提示词</label><textarea class="textarea mono" id="s-np" rows="2">${esc(s.negative_prompt)}</textarea></div>
        </div>`,
      footer: `
        <button class="btn" data-no>取消</button>
        <button class="btn btn-primary" data-yes>${isNew ? '添加' : '保存'}</button>`,
      onMount(root, close) {
        root.querySelector('[data-no]').onclick = close;
        // 运镜选择：把"这次会注入哪句英文、静帧图会不会生效"当场说清楚。
        // 不显示的话，用户选完「甩镜」会以为图片也会甩——而静帧图根本表达不了运动。
        const camSel = root.querySelector('#s-cam');
        const camHint = root.querySelector('#s-cam-hint');
        const syncCamHint = () => {
          const zh = camSel.value;
          if (!zh) { camHint.textContent = ''; return; }
          const en = cameraMovePhrase(zh);
          camHint.innerHTML = cameraMoveAffectsStill(zh)
            ? `图片与视频都会追加：<code>${esc(en)}</code>`
            : `仅视频追加：<code>${esc(en)}</code>　静帧图无法表达这种时间上的运动，出图时会自动跳过`;
        };
        camSel.onchange = syncCamHint;
        syncCamHint();
        // R26：时长的"实际提交值"必须写在用户填的地方。secondsToFrames 会量化到 8n+1 帧
        // 并夹进模型区间——不说明的话，用户填 30 秒会一直等一个 18 秒的片子。
        const durInp = root.querySelector('#s-dur');
        const durHint = root.querySelector('#s-dur-hint');
        const syncDurHint = () => {
          const raw = Number(durInp.value);
          const eff = effectiveVideoSeconds(raw);
          const lo = VIDEO_DURATION_RANGE.minSec; const hi = VIDEO_DURATION_RANGE.maxSec;
          if (!Number.isFinite(raw) || raw <= 0) { durHint.textContent = `留空或非正数按 5 秒算（实际提交 ${effectiveVideoSeconds(5).toFixed(2)} 秒）`; return; }
          if (raw > hi) durHint.innerHTML = `<span style="color:var(--warn)">超出模型上限，实际提交 ${eff.toFixed(2)} 秒（最多 ${hi.toFixed(2)} 秒）</span>`;
          else if (raw < lo) durHint.innerHTML = `<span style="color:var(--warn)">低于模型下限，实际提交 ${eff.toFixed(2)} 秒（最少 ${lo.toFixed(2)} 秒）</span>`;
          else durHint.textContent = `实际提交 ${eff.toFixed(2)} 秒（模型按 8n+1 帧量化，与填写值略有出入是正常的）`;
        };
        durInp.oninput = syncDurHint;
        syncDurHint();
        // R14：角色芯片切换。用 Set 存选中态而不是读 DOM class——保存时不必再解析一遍 DOM
        root.querySelectorAll('#s-char-pick [data-char]').forEach((b) => {
          b.onclick = () => {
            const id = b.getAttribute('data-char');
            if (pickedChars.has(id)) pickedChars.delete(id); else pickedChars.add(id);
            b.classList.toggle('on', pickedChars.has(id));
          };
        });
        // 原著卡片（地点卡/道具卡）：与角色同一交互范式，选中的会在使用点注入
        root.querySelectorAll('#s-card-pick [data-card]').forEach((b) => {
          b.onclick = () => {
            const id = b.getAttribute('data-card');
            if (pickedCards.has(id)) pickedCards.delete(id); else pickedCards.add(id);
            b.classList.toggle('on', pickedCards.has(id));
          };
        });
        root.querySelector('[data-yes]').onclick = async () => {
          const payload = {
            shot_number: Math.max(1, Number(root.querySelector('#s-num').value) || 1),
            shot_type: root.querySelector('#s-type').value,
            camera_move: root.querySelector('#s-cam').value,
            scene_description: root.querySelector('#s-desc').value,
            characters: root.querySelector('#s-chars').value,
            character_ids: [...pickedChars],
            story_card_ids: [...pickedCards],
            scene: root.querySelector('#s-scene').value,
            action: root.querySelector('#s-action').value,
            dialogue: root.querySelector('#s-dlg').value,
            narration: root.querySelector('#s-nar').value,
            sound_effect: root.querySelector('#s-sfx').value,
            duration_seconds: Math.min(600, Math.max(1, Number(root.querySelector('#s-dur').value) || 3)),
            image_prompt: root.querySelector('#s-ip').value,
            video_prompt: root.querySelector('#s-vp').value,
            negative_prompt: root.querySelector('#s-np').value,
          };
          let r;
          if (isNew) {
            r = await api.createStoryboard({
              ...payload, project_id: projectId, episode_number: episode,
              status: 'pending', sort_order: rows.length,
            });
          } else {
            r = await api.updateStoryboard(s.id, payload);
          }
          if (r.ok) { toast.ok(isNew ? '已添加' : '已保存'); close(); load(); }
          else toast.err(r.error);
        };
      },
    });
  }

  await load();
  return () => offBatch && offBatch();
}
