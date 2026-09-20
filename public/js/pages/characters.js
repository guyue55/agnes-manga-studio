/**
 * characters.js — 角色库（R14）
 * ------------------------------------------------------------------
 * 为什么要有这一页：分镜里的"人物"过去是一格自由文本，每个镜头各写各的，
 * 结果就是同一个角色在十个镜头里长十张脸。角色档案把"长相/服装"抽成可复用的一份，
 * 分镜只引用 id，注入提示词时由系统统一拼接（使用点注入，见 consts.artStylePhrase 的范式）。
 *
 * 关键取舍：
 *  · 参考图指向 image_assets（本地文件），不是让用户填公网 URL —— 本地优先下外链必然抓不到。
 *  · 「外貌锁定」是给注入用的开关：锁定 = 该角色的长相以档案为准，单镜头提示词不得覆盖。
 */
import { icon, esc, relTime, CHARACTER_ROLES, IMAGE_USAGES, CHARACTER_FIELD_MAX } from '../consts.js';
import { api } from '../api.js';
import { modal, toast, empty, skeleton, twoClick, options, setBusy, errBox, imgWithFallback } from '../ui.js';
import { head, projectPicker } from './helpers.js';
import { state, softRefresh, syncViewParams } from '../app.js';

export default async function characters(container, params) {
  let projectId = params.project || (state.projects[0] && state.projects[0].id) || '';
  let search = (params.q || '').trim().toLowerCase();
  const focusCharId = params.char_id || ''; // 从一致性体检"去处理"跳进来时要定位的角色
  let list = [];
  let images = [];

  container.innerHTML = `
    ${head({
      title: '角色库',
      desc: '把角色的长相与服装固化成档案，分镜引用后跨镜头保持一致',
      actions: `
        ${projectPicker(state.projects, projectId, { id: 'p-picker', allowEmpty: true, emptyLabel: '未选择项目' })}
        <button class="btn btn-primary" id="new-char">${icon('plus', 16)}新建角色</button>
        <button class="btn" id="reload" title="刷新">${icon('refresh', 16)}</button>`,
    })}
    <div class="card" style="margin-bottom:16px;padding:12px 16px">
      <div class="row wrap" style="gap:12px">
        <label class="row" style="gap:7px;color:var(--text-2)">
          ${icon('search', 14)}
          <input class="input input-sm" id="q" value="${esc(search)}" placeholder="搜索角色名 / 外貌关键词" aria-label="搜索角色" style="width:230px" />
        </label>
        <div class="spacer"></div>
        <span class="hint-sm" id="count"></span>
      </div>
      <div class="hint-xs" style="margin-top:9px">
        ${icon('info', 12)} 「外貌锁定」的角色，生成时会以其档案中的长相与服装为准，避免同一角色在多个镜头里换脸。
      </div>
    </div>
    <div class="grid" id="grid" style="grid-template-columns:repeat(auto-fill,minmax(212px,1fr))">${skeleton('asset', 8)}</div>`;

  const picker = container.querySelector('#p-picker');
  const qInput = container.querySelector('#q');
  picker.onchange = () => { projectId = picker.value; syncViewParams({ project: projectId }); load(); };
  container.querySelector('#reload').onclick = () => load();
  container.querySelector('#new-char').onclick = () => openForm(null);
  // 搜索防抖 + 写回 URL（R11 同款）：刷新/分享链接要能还原筛选
  let qTimer = null;
  qInput.oninput = () => {
    search = qInput.value.trim().toLowerCase();
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { syncViewParams({ project: projectId, q: search }); render(); }, 180);
  };

  async function load() {
    const el = container.querySelector('#grid');
    if (!projectId) {
      el.innerHTML = `<div class="card" style="grid-column:1/-1">${empty('先选择一个项目', '角色属于具体项目——同一个"林岚"在不同剧里是不同的人，所以不跨项目复用', 'folder', { label: '去项目管理', go: '#/projects' })}</div>`;
      container.querySelector('#count').textContent = '';
      return;
    }
    el.innerHTML = skeleton('asset', 8);
    // 参考图选择器要用的候选图：只取本项目的图片，避免把别的剧的图挂上来
    const [cr, ir] = await Promise.all([api.characters(projectId), api.images(projectId)]);
    if (!cr.ok) {
      el.innerHTML = `<div class="card" style="grid-column:1/-1">${errBox(`角色加载失败：${cr.error || '网络错误'}`, undefined, cr.trace, { errorType: cr.errorType })}</div>`;
      const rb = el.querySelector('[data-retry]');
      if (rb) rb.onclick = () => load();
      return;
    }
    list = cr.data || [];
    images = (ir.ok && ir.data) || [];
    render();
  }

  function render() {
    const el = container.querySelector('#grid');
    const hit = list.filter((c) => !search
      || `${c.name} ${c.alias || ''} ${c.appearance || ''} ${c.outfit || ''}`.toLowerCase().includes(search));
    container.querySelector('#count').textContent = list.length
      ? `共 ${list.length} 个角色${search ? ` · 命中 ${hit.length}` : ''}`
      : '';
    if (!list.length) {
      el.innerHTML = `<div class="card" style="grid-column:1/-1">${empty('这个项目还没有角色', '先建一个主角：填好长相与服装，分镜里挂上它，出图时系统会自动带上这段描述', 'users', { label: '新建角色', act: 'new' })}</div>`;
      const nb = el.querySelector('[data-act="new"]');
      if (nb) nb.onclick = () => openForm(null);
      return;
    }
    if (!hit.length) {
      el.innerHTML = `<div class="card" style="grid-column:1/-1">${empty('没有匹配的角色', `没有角色名或外貌包含「${search}」——清空搜索框可看全部`, 'search', { label: '清空搜索', act: 'clear' })}</div>`;
      const cb = el.querySelector('[data-act="clear"]');
      if (cb) cb.onclick = () => { search = ''; qInput.value = ''; syncViewParams({ project: projectId, q: '' }); render(); };
      return;
    }
    el.innerHTML = hit.map((c) => {
      const cover = images.find((i) => (c.reference_image_ids || []).includes(i.id) && i.url);
      const locked = c.is_locked;
      return `
      <div class="char-card" data-id="${esc(c.id)}">
        <div class="char-thumb">
          ${locked ? `<span class="flag" title="外貌已锁定">${icon('lock', 13)}</span>` : ''}
          ${cover
    ? imgWithFallback(cover.url, { alt: `${c.name} 参考图` })
    : `<div class="char-ph">${esc((c.name || '?').slice(0, 1))}</div>`}
          <div class="ovl">
            <button class="icon-btn" data-edit="${esc(c.id)}" title="编辑档案" aria-label="编辑角色 ${esc(c.name)}">${icon('edit', 13)}</button>
            <button class="icon-btn" data-dup="${esc(c.id)}" title="以此为模板新建" aria-label="复制角色 ${esc(c.name)}">${icon('copy', 13)}</button>
            <button class="icon-btn danger" data-del="${esc(c.id)}" title="删除" aria-label="删除角色 ${esc(c.name)}">${icon('trash', 13)}</button>
          </div>
        </div>
        <div class="char-meta">
          <div class="nm">${esc(c.name)}${c.alias ? `<span class="char-alias"> · ${esc(c.alias)}</span>` : ''}</div>
          <div class="row" style="gap:6px;flex-wrap:wrap;margin:6px 0 7px">
            <span class="badge ${c.role === '主角' ? 'gold' : 'gray'}">${esc(c.role || '配角')}</span>
            ${locked ? `<span class="badge gray">${icon('lock', 10)}外貌锁定</span>` : ''}
            ${(c.reference_image_ids || []).length ? `<span class="badge gray">${(c.reference_image_ids || []).length} 张参考图</span>` : ''}
          </div>
          <div class="ds${c.appearance ? '' : ' mute'}" title="${esc(c.appearance || '未填外貌')}">${esc(c.appearance || '（未填外貌，出图时无法保持长相一致）')}</div>
          ${c.outfit ? `<div class="ds mute" title="${esc(c.outfit)}">${esc(c.outfit)}</div>` : ''}
          <div class="upd">更新于 ${esc(relTime(c.updated_at || c.created_at))}</div>
        </div>
      </div>`;
    }).join('');

    el.querySelectorAll('[data-edit]').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); openForm(list.find((x) => x.id === b.getAttribute('data-edit'))); };
    });
    el.querySelectorAll('[data-dup]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const src = list.find((x) => x.id === b.getAttribute('data-dup'));
        if (!src) return;
        openForm(null, Object.assign({}, src, { id: null, name: `${src.name}（副本）` }));
      };
    });
    el.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const c = list.find((x) => x.id === b.getAttribute('data-del'));
        if (!c) return;
        // 就地两段确认（与分镜/素材删除一致）：删除是有引用后果的动作，值得多一次点击
        twoClick(b, async () => {
          const r = await api.deleteCharacter(c.id);
          if (r.ok) {
            toast.ok(r.data && r.data.unlinked ? `已删除，并解除了 ${r.data.unlinked} 个镜头的绑定` : '已删除');
            load(); softRefresh();
          } else toast.err(r.error);
        });
      };
    });
    // 从一致性体检"去处理"跳进来：滚到那个角色并高亮（体检报告里的问题必须能落到具体对象上）
    if (focusCharId) {
      const hit = el.querySelector(`.char-card[data-id="${focusCharId}"]`);
      if (hit) { hit.scrollIntoView({ block: 'center' }); hit.style.borderColor = 'var(--accent)'; }
    }
    // 点卡片主体 = 编辑（卡片上没有"查看大图"这类只读出口，编辑就是唯一去处）
    el.querySelectorAll('.char-card').forEach((card) => {
      card.onclick = (e) => {
        if (e.target.closest('[data-edit],[data-dup],[data-del]')) return;
        openForm(list.find((x) => x.id === card.getAttribute('data-id')));
      };
    });
  }

  function openForm(char, preset) {
    const src = preset || char;
    const isEdit = !!(char && char.id);
    const c = src || {
      name: '', alias: '', role: '主角', gender: '', age: '', appearance: '',
      outfit: '', personality: '', notes: '', is_locked: false, reference_image_ids: [],
    };
    const picked = new Set(c.reference_image_ids || []);
    modal({
      title: isEdit ? `编辑角色 · ${c.name}` : '新建角色',
      wide: true,
      body: `
        <div class="grid g2" style="gap:0 14px">
          <div class="field"><label for="c-name">角色名 *</label><input class="input" id="c-name" maxlength="${CHARACTER_FIELD_MAX.name}" value="${esc(c.name)}" placeholder="例：林岚" /></div>
          <div class="field"><label for="c-alias">别名 / 称呼</label><input class="input" id="c-alias" maxlength="${CHARACTER_FIELD_MAX.alias}" value="${esc(c.alias)}" placeholder="例：小岚、岚姐（对白里怎么叫）" /></div>
          <div class="field"><label for="c-role">定位</label><select class="select" id="c-role">${options(CHARACTER_ROLES, 'v', 'v', c.role || '主角')}</select></div>
          <div class="field"><label for="c-gender">性别</label><input class="input" id="c-gender" maxlength="${CHARACTER_FIELD_MAX.gender}" value="${esc(c.gender)}" placeholder="例：女" /></div>
          <div class="field"><label for="c-age">年龄感</label><input class="input" id="c-age" maxlength="${CHARACTER_FIELD_MAX.age}" value="${esc(c.age)}" placeholder="例：18 岁少女 / 四十岁中年" /></div>
          <div class="field"><label for="c-outfit">标志性服装</label><input class="input" id="c-outfit" maxlength="${CHARACTER_FIELD_MAX.outfit}" value="${esc(c.outfit)}" placeholder="例：白色衬衫配深蓝外套" /></div>
          <div class="field" style="grid-column:1/-1"><label for="c-appear">外貌描述（会被注入提示词）</label><textarea class="textarea" id="c-appear" maxlength="${CHARACTER_FIELD_MAX.appearance}" rows="3" placeholder="例：黑色长直发、丹凤眼、左眉尾有一颗小痣">${esc(c.appearance)}</textarea></div>
          <div class="field" style="grid-column:1/-1"><label for="c-persona">性格 / 小传</label><textarea class="textarea" id="c-persona" maxlength="${CHARACTER_FIELD_MAX.personality}" rows="2" placeholder="只给编剧看，不进提示词">${esc(c.personality)}</textarea></div>
          <div class="field" style="grid-column:1/-1"><label for="c-notes">备注</label><textarea class="textarea" id="c-notes" maxlength="${CHARACTER_FIELD_MAX.notes}" rows="2">${esc(c.notes)}</textarea></div>
        </div>
        <label class="row" style="gap:8px;margin-top:4px;cursor:pointer">
          <input type="checkbox" id="c-lock" ${c.is_locked ? 'checked' : ''} />
          <span>外貌锁定<span class="hint-xs">（生成时以本档案的长相与服装为准）</span></span>
        </label>
        <div class="field" style="margin-top:14px">
          <label>参考图<span style="color:var(--text-4);font-weight:400">（从本项目的图片里挑，最多 12 张）</span></label>
          ${images.length ? `
            <div class="ref-grid" id="c-refs">
              ${images.map((i) => `
                <label class="ref-item${picked.has(i.id) ? ' on' : ''}" data-ref="${esc(i.id)}" title="${esc(i.prompt || '')}">
                  <input type="checkbox" ${picked.has(i.id) ? 'checked' : ''} aria-label="选为参考图" />
                  ${imgWithFallback(i.url, { alt: String(i.prompt || '参考图').slice(0, 30), cls: 'ref-thumb' })}
                  <span class="ref-tag">${esc(IMAGE_USAGES.find((u) => u.value === i.usage_type)?.label || '图片')}</span>
                </label>`).join('')}
            </div>`
    : `<div class="note">本项目还没有图片素材——参考图可以留空，也可以先去「图片生成」出一张定妆照再回来挂上。</div>`}
        </div>`,
      footer: `
        <button class="btn" data-no>取消</button>
        <button class="btn btn-primary" data-yes>${isEdit ? '保存' : '创建'}</button>`,
      onMount(root, close) {
        root.querySelector('[data-no]').onclick = close;
        root.querySelector('#c-name').focus();
        // 参考图选中态：勾选后给卡片描边（否则选中与未选中在缩略图上几乎看不出差别）
        root.querySelectorAll('.ref-item').forEach((it) => {
          const cb = it.querySelector('input');
          cb.onchange = () => {
            const id = it.getAttribute('data-ref');
            cb.checked ? picked.add(id) : picked.delete(id);
            it.classList.toggle('on', cb.checked);
          };
        });
        const yes = root.querySelector('[data-yes]');
        let inflight = false;
        yes.onclick = async () => {
          if (inflight) return;
          const payload = {
            project_id: projectId,
            name: root.querySelector('#c-name').value.trim(),
            alias: root.querySelector('#c-alias').value.trim(),
            role: root.querySelector('#c-role').value,
            gender: root.querySelector('#c-gender').value.trim(),
            age: root.querySelector('#c-age').value.trim(),
            appearance: root.querySelector('#c-appear').value.trim(),
            outfit: root.querySelector('#c-outfit').value.trim(),
            personality: root.querySelector('#c-persona').value.trim(),
            notes: root.querySelector('#c-notes').value.trim(),
            is_locked: root.querySelector('#c-lock').checked,
            reference_image_ids: [...picked],
          };
          if (!payload.name) { toast.err('角色名称不能为空'); return; }
          if (!projectId) { toast.err('请先选择项目'); return; }
          inflight = true; setBusy(yes, true, '保存中');
          try {
            const r = isEdit ? await api.updateCharacter(c.id, payload) : await api.createCharacter(payload);
            // 服务端截断了要说话：静默少一截文字，用户只会以为"我明明写了的"
            const cut = (r.data && r.data.truncated) || [];
            if (r.ok) {
              if (cut.length) toast.err(`有字段超出长度上限、已截断：${cut.join('、')}`);
              else toast.ok(isEdit ? '已保存' : '角色已创建');
              close(); load(); softRefresh();
            }
            else toast.err(r.error);
          } finally { inflight = false; setBusy(yes, false); }
        };
      },
    });
  }

  await load();
}
