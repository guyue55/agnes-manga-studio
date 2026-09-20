/**
 * images.js — 图片生成
 * 文生图 / 图生图。生成结果直接落盘到本地素材库（不再依赖公网图床）。
 */
import { icon, esc, copyText, IMAGE_SIZES, IMAGE_USAGES, modelChoices, sizeForAspect, PRESET_TERMS, downloadUrl } from '../consts.js';
import { api } from '../api.js';
import { modal, toast, empty, spinner, skeleton, confirm, options, setBusy, costConfirm, imgWithFallback } from '../ui.js';
import { head, projectLabel } from './helpers.js';
import { state, navigate, syncViewParams, resolveProjectId } from '../app.js';
import { progressOf } from '../pipeline.js';

export default async function images(container, params) {
  let projectId = resolveProjectId(params);   // UI 重构步 A：唯一入口
  const aspectOf = () => (state.projects.find((p) => p.id === projectId) || {}).aspect_ratio; // T-1：画幅单源
  let storyboardId = params.storyboard || '';
  let mode = params.mode === 'i2i' ? 'i2i' : 't2i';   // 2.9/R11：可分享、可刷新还原
  let items = [];
  let generating = false;

  container.innerHTML = `
    ${head({
      progress: progressOf('images', state.projectId),
      title: '图片生成',
      desc: 'Agnes 图像模型 · 生成结果自动保存到本机素材库',
      actions: `
        ${projectLabel(state.projects, projectId, { emptyLabel: '未选择项目' })}
        <button class="btn" id="reload" title="刷新">${icon('refresh', 16)}</button>`,
    })}
    <div class="grid" style="grid-template-columns:minmax(320px,0.85fr) minmax(0,2fr);gap:20px">
      <div>
        <div class="card">
          <div class="card-title">${icon('image', 15)}生成参数</div>
          <div class="field">
            <label for="model">模型</label>
            <select class="select" id="model"></select>
          </div>
          <div class="segmented" id="mode" style="grid-template-columns:1fr 1fr;margin-bottom:16px">
            <button data-mode="t2i" class="${mode === 't2i' ? 'on' : ''}">文生图</button>
            <button data-mode="i2i" class="${mode === 'i2i' ? 'on' : ''}">图生图</button>
          </div>

          <div id="t2i-box"${mode === 't2i' ? '' : ' style="display:none"'}>
            <div class="field"><label for="sb-sel">关联分镜（可选）</label><select class="select" id="sb-sel"></select></div>
            <div class="field">
              <label for="t2i-prompt">图片提示词</label>
              <textarea class="textarea mono" id="t2i-prompt" rows="6" placeholder="描述画面，支持中英文&#10;例：cinematic anime style, a young woman in red dress, golden hour, detailed background"></textarea>
              <div id="t2i-presets" aria-label="常用提示词预设"></div>
            </div>
            <div class="grid g2" style="gap:0 12px">
              <div class="field"><label for="t2i-size">尺寸</label><select class="select" id="t2i-size">${options(IMAGE_SIZES, 'value', 'label', sizeForAspect(aspectOf(), 'image'))}</select></div>
              <div class="field"><label for="t2i-usage">用途</label><select class="select" id="t2i-usage">${options(IMAGE_USAGES, 'value', 'label', 'storyboard')}</select></div>
            </div>
          </div>

          <div id="i2i-box"${mode === 'i2i' ? '' : ' style="display:none"'}>
            <div class="field">
              <label for="i2i-url">原图（公网可访问 URL）</label>
              <input class="input mono" id="i2i-url" placeholder="https://…" />
              <select class="select select-sm" id="i2i-pick" style="margin-top:8px"></select>
              <div class="hint">图生图需要 Agnes 能抓到的公网图片地址。本地生成的图片请先上传到公网图床，或把 <span style="font-family:var(--mono)">remote_url</span> 填进来。</div>
            </div>
            <div class="field">
              <label for="i2i-prompt">编辑指令</label>
              <textarea class="textarea" id="i2i-prompt" rows="5" placeholder="描述想怎么改这张图…"></textarea>
            </div>
            <div class="grid g2" style="gap:0 12px">
              <div class="field"><label for="i2i-size">输出尺寸</label><select class="select" id="i2i-size">${options(IMAGE_SIZES, 'value', 'label', sizeForAspect(aspectOf(), 'image'))}</select></div>
              <div class="field">
                <label for="i2i-keep">保留原构图</label>
                <div class="row"><button type="button" role="switch" class="switch on" id="i2i-keep" aria-checked="true"></button><span style="font-size:12px;color:var(--text-3)">开启后追加 preserve composition</span></div>
              </div>
            </div>
          </div>

          <button class="btn btn-primary btn-block" id="gen">${icon('wand', 15)}生成图片</button>
          <div id="status"></div>
        </div>
      </div>

      <div>
        <div class="row" style="margin-bottom:12px">
          <div class="card-title" style="margin:0">${icon('grid', 15)}已生成图片</div>
          <span class="badge gray" id="count">0</span>
        </div>
        <div id="gallery" class="asset-grid">${skeleton('asset', 8)}</div>
      </div>
    </div>`;

  // B3.6：预设 chips——点一下补一个专业短语，写作门槛直降
  (function mountPresets() {
    const mount = container.querySelector('#t2i-presets');
    if (!mount) return;
    mount.innerHTML = PRESET_TERMS.map((g) => `
      <div class="row wrap" style="gap:5px;margin-top:5px">
        <span style="font-size:11px;color:var(--text-4);width:28px;flex:none">${esc(g.cat)}</span>
        ${g.items.map((i) => `<button type="button" class="chip" data-en="${esc(i.en)}" title="追加：${esc(i.en)}">${esc(i.label)}</button>`).join('')}
      </div>`).join('');
    mount.querySelectorAll('[data-en]').forEach((b) => {
      b.onclick = () => {
        const ta = container.querySelector('#t2i-prompt');
        const en = b.getAttribute('data-en');
        if (ta.value.includes(en)) { toast('提示词里已经有这个了', 'info'); return; }
        ta.value = ta.value.replace(/\s+$/, '') + (ta.value.trim() ? ', ' : '') + en;
        ta.focus();
      };
    });
  })();
  container.querySelector('#reload').onclick = () => { loadStoryboards(); load(); };
  container.querySelector('#gen').onclick = generate;
  container.querySelectorAll('#mode [data-mode]').forEach((b) => {
    b.onclick = () => {
      mode = b.getAttribute('data-mode');
      container.querySelectorAll('#mode [data-mode]').forEach((x) => x.classList.toggle('on', x === b));
      syncViewParams({ mode });   // R11：模式是派生视图状态，刷新/分享必须还原
      container.querySelector('#t2i-box').style.display = mode === 't2i' ? '' : 'none';
      container.querySelector('#i2i-box').style.display = mode === 'i2i' ? '' : 'none';
    };
  });
  const keep = container.querySelector('#i2i-keep');
  keep.onclick = () => keep.setAttribute('aria-checked', keep.classList.toggle('on'));

  // 模型下拉
  const ms = modelChoices(state.models, 'image', [state.settings.default_image_model || 'agnes-image-2.1-flash', 'agnes-image-2.0-flash']);
  container.querySelector('#model').innerHTML = options(ms, 'value', 'label', ms[0]?.value);

  // 分镜下拉
  async function loadStoryboards() {
    const sel = container.querySelector('#sb-sel');
    if (!sel) return;
    if (!projectId) {
      // 没选项目时明确置空并禁用，避免残留上一个项目的选项
      sel.innerHTML = '<option value="">请先选择项目</option>';
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    const r = await api.storyboards(projectId);
    const list = (r.ok && r.data) || [];
    sel.innerHTML = `<option value="">不关联</option>`
      + list.map((s) => `<option value="${esc(s.id)}">#${esc(s.shot_number)} ${esc(s.shot_type)} - ${esc(String(s.scene_description).slice(0, 22))}</option>`).join('');
    if (storyboardId) {
      sel.value = storyboardId;
      const s = list.find((x) => x.id === storyboardId);
      if (s && s.image_prompt) container.querySelector('#t2i-prompt').value = s.image_prompt;
    }
    sel.onchange = () => {
      const s = list.find((x) => x.id === sel.value);
      if (s && s.image_prompt) container.querySelector('#t2i-prompt').value = s.image_prompt;
    };
  }

  let lastPrompt = null;   // R21 变体轮换：上一次出图用的提示词
  let lastVariation = 0;   // 该提示词已出过几张（0 = 还没出过，下一张是首次）

  async function generate() {
    if (generating) return;
    const model = container.querySelector('#model').value;
    const st = container.querySelector('#status');
    let payload = { model, project_id: projectId || null };

    if (mode === 't2i') {
      const prompt = container.querySelector('#t2i-prompt').value.trim();
      if (!prompt) { toast.err('请输入图片提示词'); return; }
      const size = container.querySelector('#t2i-size').value;
      const sz = IMAGE_SIZES.find((s) => s.value === size) || IMAGE_SIZES[0];
      Object.assign(payload, {
        prompt, size, width: sz.w, height: sz.h,
        usage_type: container.querySelector('#t2i-usage').value,
        storyboard_id: container.querySelector('#sb-sel')?.value || null,
        // R21：同一条提示词第 N 次生成（N≥2）自动追加"换机位/时段/构图"短语，
        // 否则连点生成只会得到一串几乎一样的图。换提示词则计数归零（这是新的一张，不是变体）。
        variation: prompt === lastPrompt ? lastVariation + 1 : 0,
      });
    } else {
      const url = container.querySelector('#i2i-url').value.trim();
      const prompt = container.querySelector('#i2i-prompt').value.trim();
      if (!prompt) { toast.err('请输入编辑指令'); return; }
      if (!url) { toast.err('请填写原图公网 URL'); return; }
      const size = container.querySelector('#i2i-size').value;
      const sz = IMAGE_SIZES.find((s) => s.value === size) || IMAGE_SIZES[0];
      Object.assign(payload, {
        prompt: keep.classList.contains('on') ? `${prompt}, preserve the original composition` : prompt,
        size, width: sz.w, height: sz.h, image: url, usage_type: 'reference',
      });
    }

    // 付费确认：单张图片同样是真实计费。generating 占位提前到确认之前——
    // 确认弹窗期间再点「生成」不得叠出第二层弹窗（否则确认两次会提交两次）。
    generating = true;
    let confirmed;
    try {
      confirmed = await costConfirm({ what: '图片', count: 1 });
    } catch { confirmed = false; }
    if (!confirmed) { generating = false; return; }

    const genBtn = container.querySelector('#gen');
    setBusy(genBtn, true, '', '图片生成通常需要十几秒到一分钟');
    st.innerHTML = `<div class="row" style="margin-top:12px;color:var(--gold-light)"><div class="spinner sm"></div><span style="font-size:12.5px">生成中，Agnes 出图通常需要十几秒…</span></div>`;

    let r;
    try {
      r = await api.genImage(payload);
    } finally {
      // 断连时 res.text() 会抛出，必须保证锁被释放，否则按钮永久禁用
      generating = false;
      setBusy(genBtn, false);
      st.innerHTML = '';
    }
    if (!r.ok) { toast.err(r.error); return; }
    // 记账必须在成功之后：失败的请求没有消耗变体序号，重试仍按同一张算
    if (mode === 't2i') {
      const now = container.querySelector('#t2i-prompt').value.trim();
      lastVariation = now === lastPrompt ? lastVariation + 1 : 0;
      lastPrompt = now;
      toast.ok(lastVariation > 0 ? `图片已生成（第 ${lastVariation + 1} 张，已自动换个机位/时段）` : '图片已生成并保存到素材库');
    } else {
      toast.ok('图片已生成并保存到素材库');
    }
    load();
  }

  async function load() {
    const r = await api.images(projectId || undefined);
    const el = container.querySelector('#gallery');
    if (!r.ok) { el.innerHTML = `<div class="note red">${esc(r.error)}</div>`; return; }
    items = r.data || [];
    container.querySelector('#count').textContent = items.length;

    // 图生图的素材选择器
    const pick = container.querySelector('#i2i-pick');
    if (pick) {
      pick.innerHTML = `<option value="">或从素材库选（用其公网 remote_url）</option>`
        + items.filter((i) => i.remote_url).map((i) => `<option value="${esc(i.remote_url)}">${esc(i.name)}</option>`).join('');
      pick.onchange = () => { if (pick.value) container.querySelector('#i2i-url').value = pick.value; };
    }

    if (!items.length) {
      el.innerHTML = `<div class="card" style="grid-column:1/-1">${empty('还没有生成的图片', '在左侧写提示词点「生成图片」', 'image', { label: '去写提示词', act: 'focus' })}</div>`;
      const fb = el.querySelector('[data-act="focus"]');
      // 两种模式各有一个提示词框，聚焦当前可见的那个
      if (fb) fb.onclick = () => { const t = container.querySelector('#t2i-prompt') || container.querySelector('#i2i-prompt'); if (t) { t.scrollIntoView({ block: 'center' }); t.focus(); } };
      return;
    }
    el.innerHTML = items.map((img) => `
      <div class="asset-card" data-id="${esc(img.id)}">
        ${img.is_favorited ? `<span class="flag">${icon('star', 14)}</span>` : ''}
        <img src="${esc(img.url)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'loading-wrap',textContent:'图片加载失败'}))" />
        <div class="ovl">
          <div class="top">
            <button class="icon-btn ${img.is_favorited ? 'gold' : ''}" data-fav="${esc(img.id)}" title="收藏">${icon('star', 13)}</button>
            <button class="icon-btn" data-zoom="${esc(img.id)}" title="预览">${icon('eye', 13)}</button>
            <button class="icon-btn danger" data-del="${esc(img.id)}" title="删除">${icon('trash', 13)}</button>
          </div>
          <div class="btm">
            <button class="mini-btn" data-copyurl="${esc(img.id)}">复制 URL</button>
            <button class="mini-btn" data-copyprompt="${esc(img.id)}">复制提示词</button>
            <button class="mini-btn gold" data-tovideo="${esc(img.id)}">${icon('video', 11)}生成视频</button>
            <button class="mini-btn" data-dl="${esc(img.id)}">下载</button>
          </div>
        </div>
      </div>`).join('');

    const bind = (attr, fn) => el.querySelectorAll(`[data-${attr}]`).forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); fn(b.getAttribute(`data-${attr}`)); };
    });
    bind('fav', async (id) => {
      const img = items.find((x) => x.id === id);
      await api.updateImage(id, { is_favorited: !img.is_favorited });
      load();
    });
    bind('zoom', (id) => zoom(items.find((x) => x.id === id)));
    bind('del', async (id) => {
      if (!(await confirm({ text: '删除这张图片？本地文件也会一起删。', danger: true, okText: '删除' }))) return;
      const r2 = await api.deleteImage(id);
      if (r2.ok) { toast.ok('已删除'); load(); } else toast.err(r2.error);
    });
    bind('copyurl', (id) => {
      const img = items.find((x) => x.id === id);
      copyText(img.remote_url || img.url).then(() => toast.ok('已复制 URL')).catch(() => toast.err('复制失败——浏览器拦截了剪贴板，请手动选中文本复制'));
    });
    bind('copyprompt', (id) => {
      const img = items.find((x) => x.id === id);
      copyText(img.generation_prompt || '').then(() => toast.ok('已复制提示词')).catch(() => toast.err('复制失败——浏览器拦截了剪贴板，请手动选中文本复制'));
    });
    bind('dl', (id) => {
      const img = items.find((x) => x.id === id);
      // 统一走 downloadUrl：它 append 到 body 再 remove；手工建的游离 <a> 在部分浏览器不触发下载
      downloadUrl(img.url, `${img.name}.png`);
    });
    bind('tovideo', (id) => {
      const img = items.find((x) => x.id === id);
      const url = img.remote_url || (img.url.startsWith('http') ? img.url : '');
      navigate('videos', { project: projectId, image_url: url, storyboard: img.storyboard_id || '' });
      if (!url) toast.warn('这张图只有本地地址，Agnes 抓不到。要么上传公网，要么在视频页改用文生视频。', 6500);
    });
    el.querySelectorAll('[data-id]').forEach((c) => {
      c.onclick = (e) => {
        if (e.target.closest('button')) return;
        zoom(items.find((x) => x.id === c.getAttribute('data-id')));
      };
    });
  }

  function zoom(img) {
    if (!img) return;
    modal({
      title: img.name || '图片',
      wide: true,
      body: `
        <img src="${esc(img.url)}" alt="" style="width:100%;border-radius:14px;display:block" />
        <div style="margin-top:14px">
          <div class="section-label">提示词</div>
          <pre class="json-out">${esc(img.generation_prompt || '（无）')}</pre>
          <div class="kv" style="margin-top:10px"><span class="k">模型</span><span class="v">${esc(img.model_name || '—')}</span></div>
          <div class="kv"><span class="k">尺寸</span><span class="v">${esc(img.size || '—')}</span></div>
          <div class="kv"><span class="k">公网 URL</span><span class="v">${esc(img.remote_url || '（仅本地）')}</span></div>
        </div>`,
      footer: `
        <button class="btn" data-copy>复制提示词</button>
        <a class="btn btn-primary" href="${esc(img.url)}" download="${esc(img.name)}.png">下载</a>`,
      onMount(root, close) {
        root.querySelector('[data-copy]').onclick = () => {
          copyText(img.generation_prompt || '').then(() => toast.ok('已复制')).catch(() => toast.err('复制失败——浏览器拦截了剪贴板，请手动选中文本复制'));
        };
      },
    });
  }

  await loadStoryboards();
  await load();
}
