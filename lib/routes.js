/**
 * routes.js — 全部 /api/* 接口
 * ------------------------------------------------------------------
 * 接口形状基本照抄原版前端调用的数据模型（projects / scripts / storyboards /
 * image_assets / video_assets / generation_tasks / prompt_templates），
 * 这样从云端导出的老数据能直接导入本地版。
 *
 * 相对原版的改动：
 *   · 去掉 user_id，去掉所有 auth 分支
 *   · 生成文本/图片时顺手写 generation_tasks —— 原版这张表从来没被写进去过，
 *     任务页的「文本」「图片」标签页一直是空的
 *   · 图片生成结果落盘到本地 assets/，不再依赖公网 Storage
 *   · 视频创建/查询/下载走本机的 agnes.js，前端拿不到 API Key
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// B4.1 画风分层注入：提示词入库只存"镜头内容"，画风在真正出图/出视频的使用点统一拼接。
// 换画风 = 零重生成。中文画风名映射成模型更稳的英文短语，未知/英文原样透传。
const ART_STYLE_MAP = {
  '日漫厚涂': 'japanese anime style, thick painterly shading',
  '日漫': 'japanese anime style, clean linework',
  '国漫写实': 'donghua realistic style, detailed textures',
  '吉卜力': 'studio ghibli inspired, soft watercolor tones',
  '水彩': 'watercolor illustration, soft paper texture',
  '油画': 'oil painting style, visible brush strokes',
  '赛博朋克': 'cyberpunk aesthetic, neon glow',
  '像素': 'pixel art style',
  '黑白漫画': 'black and white manga, screentone shading',
  '3D渲染': '3d render, cinematic lighting',
};
function artStylePhrase(prompt, style) {
  const st = String(style || '').trim();
  if (!st) return prompt;
  const key = Object.keys(ART_STYLE_MAP).find((k) => st.includes(k) || k.includes(st));
  const phrase = key ? ART_STYLE_MAP[key] : st;
  if (!phrase || String(prompt).toLowerCase().includes(phrase.toLowerCase())) return prompt;
  return `${prompt}, ${phrase}`;
}

/**
 * R19 运镜字典（后端镜像，zh → 英文短语）。
 * 为什么镜像而不是让前端直接送英文：① 落库的 camera_move 保持中文可读（本地版用户会翻 data/*.json）；
 * ② 词表在后端是**白名单**——前端送来的未知值会被丢弃，不会把任意文本拼进提示词；
 * ③ 以后改措辞，所有镜头一起受益，而不是新旧两套英文并存。
 * 与 public/js/consts.js 的 CAMERA_MOVES **逐对同构**（uitest 有 zh→en 全表比对钉）。
 */
const CAMERA_MOVE_MAP = {
  '推镜': 'slow push in toward the subject',
  '急推': 'rapid crash zoom in',
  '拉镜': 'pull out reveal, wider framing',
  '变焦拉远': 'zoom out to reveal the surroundings',
  '滑动变焦（希区柯克）': 'dolly zoom vertigo effect, background stretches while subject stays fixed',
  '横移': 'lateral tracking shot, camera slides sideways',
  '跟随': 'follow shot tracking behind the subject',
  '侧跟': 'side tracking shot moving parallel with the subject',
  '摇镜': 'slow pan across the scene',
  '甩镜': 'whip pan, fast motion blur transition',
  '升镜': 'crane up shot rising above the scene',
  '降镜': 'crane down descending toward the subject',
  '摇臂环绕': 'jib shot arcing around the subject',
  '环绕': 'orbiting camera circling the subject',
  '半环绕': 'half orbit arc around the subject',
  '旋转': 'camera rolls rotating the horizon',
  '手持': 'handheld camera with natural shake',
  '跟拍晃动': 'documentary style handheld following the action',
  '呼吸感微动': 'subtle breathing camera drift, static but alive',
  '固定机位': 'locked-off static camera',
  '三脚架微推': 'tripod shot with a very slow push',
  '定点摇摄': 'static camera panning to follow the subject',
  '第一人称': 'first-person POV shot',
  '过肩视角': 'over-the-shoulder framing',
  '俯视': 'high angle looking down',
  '仰视': 'low angle looking up, subject looms',
  '低角度贴地': 'ground-level low angle shot',
  '鸟瞰': 'aerial top-down bird eye view, looking straight down',
  '越肩反打': 'reverse over-the-shoulder shot',
  '穿越': 'camera flies through the scene, continuous forward motion',
  '一镜到底': 'continuous long take without cuts',
  '慢动作': 'slow motion, high frame rate feel',
  '延时': 'time-lapse, accelerated time',
  '虚实变焦': 'rack focus shifting between foreground and background',
  '穿墙进入': 'camera pushes through a wall into the next space',
  '镜头失焦再合焦': 'defocus then snap back into sharp focus',
  '闪白转场': 'flash cut transition, brief white flash',
  '无运镜': 'no camera movement',
};

/**
 * 对静帧也成立的运镜（机位/视角类）。与 consts.js 里带 `still: true` 的条目一一对应（uitest 有比对钉）。
 * 「甩镜/延时/一镜到底」描述的是时间上的运动，静态图没有对应物——只对视频注入。
 */
const CAMERA_MOVE_STILL_OK = new Set([
  '手持', '固定机位', '第一人称', '过肩视角', '俯视', '仰视', '鸟瞰', '低角度贴地', '越肩反打', '虚实变焦',
]);

/** 按中文标签取英文运镜短语；未知标签返回空串（宁可不注入，也不把中文标签喂给视频模型） */
function cameraMovePhrase(zh, forStill = false) {
  const k = String(zh || '').trim();
  if (forStill && !CAMERA_MOVE_STILL_OK.has(k)) return '';
  return CAMERA_MOVE_MAP[k] || '';
}

/**
 * R21 场景变体池（后端镜像，与 consts.js 的 VARIATION_POOL 逐条同构）。
 * 首次生成（n<=0）不注入——第一次必须忠实于用户写的词，只有"再来一张"才引入变化。
 */
/**
 * R25：视频提交幂等窗口。10 分钟这个值的取舍——短了挡不住"用户看到超时提示、去喝杯水回来再点"，
 * 长了会把"我就是想再生成一条一模一样的"（换个种子/想多要一版）误判成重复提交。
 * 幂等键由前端按"参数指纹"生成并在**重试**时复用、成功后作废，所以窗口只需要覆盖
 * "一次提交意图从发出到用户确认结果"的时间，10 分钟足够。
 */
const VIDEO_DEDUP_WINDOW_MS = 10 * 60 * 1000;

const VARIATION_POOL = [
  'slightly different camera angle, alternative framing',
  'different time of day, changed lighting mood',
  'alternate composition, rule of thirds, different lens',
  'closer framing on the subject, shallower depth of field',
  'wider establishing framing, more environment visible',
  'different weather and atmosphere',
  'lower camera position, more dramatic perspective',
  'mirrored composition, subject on the other side of frame',
];

function variationPhrase(n) {
  const i = Math.floor(Number(n) || 0);
  if (i <= 0) return '';
  return VARIATION_POOL[(i - 1) % VARIATION_POOL.length];
}


/**
 * R15 角色注入（使用点注入，与画风同范式）：把出场角色的档案短语拼进提示词。
 *  · 只取 appearance + outfit —— 性格/小传是给编剧看的，进提示词只会稀释画面描述。
 *  · is_locked 的语义：锁定 = 无条件注入（同一段长相文本逐字出现在每个镜头，这才是一致性的来源）；
 *    未锁定 = 提示词里已提到角色名就跳过（用户自己写了长相，尊重用户，不叠两套描述）。
 *  · 无论锁没锁，同样的描述已在提示词里出现就不再追加（否则长提示词自我重复、白烧配额）。
 *  · 与 public/js/consts.js 的 characterPhrase 必须逐字同构（uitest 有文本比对钉）：
 *    前端用它做"生成时真正发出什么"的计算态预览，两边逻辑一漂移，预览就开始骗人。
 */
function characterPhrase(prompt, chars) {
  const list = Array.isArray(chars) ? chars.filter(Boolean) : [];
  if (!list.length) return prompt;
  const p = String(prompt || '');
  const lower = p.toLowerCase();
  const parts = [];
  for (const c of list) {
    const name = String(c.name || '').trim();
    const outfit = String(c.outfit || '').trim();
    const look = [String(c.appearance || '').trim(), outfit ? `身着${outfit}` : ''].filter(Boolean).join('，');
    if (!look) continue;
    if (lower.includes(look.toLowerCase())) continue;
    if (!c.is_locked && name && lower.includes(name.toLowerCase())) continue;
    parts.push(name ? `${name}：${look}` : look);
  }
  if (!parts.length) return prompt;
  const block = `出场角色——${parts.join('；')}`;
  return p.trim() ? `${p}, ${block}` : block;
}

module.exports = function createRoutes(ctx) {
  const store = ctx.store;
  const agnes = ctx.agnes;
  const poller = ctx.poller;
  const jobs = ctx.jobs;

  // ── 小工具 ─────────────────────────────────────────────────
  const now = () => new Date().toISOString();

  /** X2 防护：外部可写的 local_file 只允许落在素材根目录内，
   *  否则删除路径里的 fs.unlinkSync 会退化成"以本服务身份删任意文件"。越界一律丢弃为 ''。 */
  function safeAssetLocal(p) {
    const s = typeof p === 'string' ? p.trim() : '';
    if (!s || !path.isAbsolute(s)) return '';
    const norm = path.normalize(s);
    for (const root of [store.imagesDir(), store.videosDir()]) {
      const r = path.normalize(root);
      if (norm === r || norm.startsWith(r + path.sep)) return norm;
    }
    return '';
  }

  function attach(id) {
    return `attachment; filename="${encodeURIComponent(id)}"`;
  }

  /** 把请求路径按 /api/xxx/:id 形式的模板匹配出来 */
  function match(pathname, pattern) {
    const a = pathname.split('/').filter(Boolean);
    const b = pattern.split('/').filter(Boolean);
    if (a.length !== b.length) return null;
    const params = {};
    for (let i = 0; i < b.length; i++) {
      if (b[i].startsWith(':')) {
        // B8：非法转义参数按"不匹配"处理，最终 404，不再 URIError→500
        try { params[b[i].slice(1)] = decodeURIComponent(a[i]); }
        catch { return null; }
      } else if (b[i] !== a[i]) return null;
    }
    return params;
  }

  const str = (v, d = '') => (v == null ? d : String(v));
  const num = (v, d = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const bool = (v) => v === true || v === '1' || v === 'true' || v === 1;
  /**
   * id 数组清洗：去空、去重、限长。角色绑定/参考图都是多选，脏数据（重复 id、空串、
   * 前端误传的 [null]）会让"解绑/统计"出现幽灵项，所以在入口一次洗净。
   */
  const idList = (v, max = 60) => {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const x of v) {
      const id = str(x).trim();
      if (!id || out.includes(id)) continue;
      out.push(id);
      if (out.length >= max) break;
    }
    return out;
  };
  // E8：数值参数权威钳制，避免 fps=999、负帧数、非法 seed 串直透远端。
  const clampNum = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  // R25：钳制不能是**静默**的。用户填 600 帧、我们按 441 提交、账单按 441 出——
  // 他以为要 25 秒的片子，实际拿到 18 秒，全程没人告诉他。这里把"夹了"这件事如实回报，
  // 由界面告知（前端另有前置校验，正常路径不会走到这里）。
  // 变更须知：钳制**不许改回静默**——被夹掉的参数直接决定成片时长与账单金额，
  // 必须经 clamps 回报给界面（apitest 有"夹了就要报"的钉子）。
  const clampReport = (requested, used, field) => (Number(requested) !== Number(used) ? { field, requested: Number(requested), used: Number(used) } : null);
  const framesClamp = (v) => clampNum(v, 9, 441, 121);
  const fpsClamp = (v) => Math.round(clampNum(v, 1, 60, 24));
  const seedOr = (v, d = null) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? Math.trunc(n) : d; };

  // ── 素材落盘 ───────────────────────────────────────────────
  function safeName(name, ext) {
    let n = path.basename(str(name)).replace(/[\\/:*?"<>|]+/g, '_').trim();
    if (!n || n === '.' || n === '..') n = `asset_${Date.now()}`;
    if (ext && !n.toLowerCase().endsWith('.' + ext.toLowerCase())) n += '.' + ext;
    return n;
  }

  /** 保存 base64 图片，返回 {file, url} */
  function saveImageBase64(b64, mime = 'image/png') {
    const dir = store.imagesDir();
    fs.mkdirSync(dir, { recursive: true });
    const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
    const name = safeName(`img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ext);
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    return { file, url: `/assets/images/${encodeURIComponent(name)}` };
  }

  /** 把远端图片抓到本地，失败返回 null */
  async function fetchRemoteImage(url) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!resp.ok) return null;
      const buf = Buffer.from(await resp.arrayBuffer());
      const dir = store.imagesDir();
      fs.mkdirSync(dir, { recursive: true });
      const ct = resp.headers.get('content-type') || 'image/png';
      const ext = ct.includes('jpeg') ? 'jpg' : ct.includes('webp') ? 'webp' : 'png';
      const name = safeName(`img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ext);
      const file = path.join(dir, name);
      fs.writeFileSync(file, buf);
      return { file, url: `/assets/images/${encodeURIComponent(name)}`, bytes: buf.length };
    } catch {
      return null;
    }
  }

  // ── 路由表 ─────────────────────────────────────────────────
  // 每项：['METHOD', '/api/...', handler(req, res, params, body)]
  const routes = [];
  const on = (method, pattern, handler) => routes.push({ method, pattern, handler });

  // ================= 系统 =================
  on('GET', '/api/health', () => ({
    ok: true,
    version: ctx.version,
    data_home: store.home(),
    time: now(),
  }));

  on('GET', '/api/bootstrap', () => ({
    settings: store.getSettingsMasked(),
    projects: store.list('projects'),
    stats: store.stats(),
    templates: store.list('prompt_templates'),
    // 角色库同 templates 一样随 bootstrap 下发：分镜页要给镜头挂角色、图片页要按角色注入提示词，
    // 每页各自再拉一次纯属重复请求（本地服务虽快，但会让"页面切换"变慢且逻辑重复）
    characters: store.list('characters'),
    models: store.getModels(),
  }));

  on('GET', '/api/stats', () => store.stats());

  // ================= 设置 / 模型目录 =================
  on('GET', '/api/settings', () => store.getSettingsMasked());

  on('GET', '/api/models', () => store.getModels());

  /** 手动刷新模型目录；失败时保留上一次成功缓存，不让下拉框变空 */
  async function refreshModels() {
    try {
      const result = await agnes.listModels();
      const normalized = store.normalizeModels(result.data);
      if (!normalized.length) {
        const error = 'Agnes 模型接口返回为空或格式无法识别，已保留上次模型目录。';
        store.setModelCacheError(error);
        return { ok: false, error, models: store.getModels(), diagnostics: result.diagnostics };
      }
      const models = store.setModels(result.data, { source: 'agnes' });
      return { ok: true, models, diagnostics: result.diagnostics };
    } catch (e) {
      const models = store.setModelCacheError(e.message);
      return { ok: false, error: e.message, errorType: e.errorType || 'model_fetch_failed', models };
    }
  }

  on('POST', '/api/models/refresh', async () => refreshModels());

  on('PUT', '/api/settings', (req, res, params, body) => {
    const patch = {};
    for (const k of Object.keys(store.SETTING_DEFAULTS)) {
      if (k in body) patch[k] = body[k];
    }
    store.setSettings(patch);
    return { ok: true, settings: store.getSettingsMasked() };
  });

  on('POST', '/api/settings/test', async (req, res, params, body) => {
    const kind = str(body.kind || 'text');
    try {
      const r = await agnes.testConnection(kind);
      return { ok: true, message: r.message };
    } catch (e) {
      return { ok: false, error: e.message, errorType: e.errorType || 'test_failed' };
    }
  });

  // ================= 项目 =================
  /**
   * R29：`?with_counts=1` 让服务端把三个计数一起算好。
   *
   * 原来项目页为了显示"分镜 / 图片 / 视频"三个数字，要**额外并发拉三个全量列表**再在客户端聚合：
   * 传输量随素材总数线性增长（每条还带着长提示词、URL、原始响应），而页面只需要三个整数。
   * 这里仍是 O(全部行) 的内存扫描——单机 JSON 库里这比序列化+传输便宜得多，也是真正的瓶颈所在。
   *
   * **变更须知**：这是**可选参数**，不带参数时响应形状与以前**逐字节一致**（裸数组、无 counts 字段）。
   * 老客户端/老脚本、以及任何 `store.list('projects')` 的直接调用者都不受影响；
   * 前端也保留了"没有 counts 就退回三拉"的兼容分支。改这里时不要顺手把它变成默认行为。
   */
  on('GET', '/api/projects', (req, res, params, body, query) => {
    const list = store.list('projects');
    if (str(query.with_counts) !== '1') return list;
    const zero = () => ({ storyboards: 0, image_assets: 0, video_assets: 0 });
    const counts = {};
    for (const [coll, key] of [['storyboards', 'storyboards'], ['image_assets', 'image_assets'], ['video_assets', 'video_assets']]) {
      for (const r of store.list(coll)) {
        if (!r.project_id) continue;
        if (!counts[r.project_id]) counts[r.project_id] = zero();
        counts[r.project_id][key]++;
      }
    }
    return list.map((p) => Object.assign({}, p, { counts: counts[p.id] || zero() }));
  });

  on('POST', '/api/projects', (req, res, params, body) => {
    const name = str(body.name).trim();
    if (!name) throw httpError(400, '项目名称不能为空');
    return store.insert('projects', {
      name,
      description: str(body.description),
      project_type: str(body.project_type || '自定义'),
      target_platform: str(body.target_platform || '抖音'),
      aspect_ratio: str(body.aspect_ratio || '9:16'),
      art_style: str(body.art_style),
      episode_duration: str(body.episode_duration || '1分钟'),
      planned_episodes: num(body.planned_episodes, 10),
      status: 'active',
    });
  });

  on('GET', '/api/projects/:id', (req, res, params) => {
    const p = store.get('projects', params.id);
    if (!p) throw httpError(404, '项目不存在');
    return p;
  });

  on('PUT', '/api/projects/:id', (req, res, params, body) => {
    const patch = {};
    for (const k of ['name', 'description', 'project_type', 'target_platform', 'aspect_ratio',
      'art_style', 'episode_duration', 'planned_episodes', 'status']) {
      if (k in body) patch[k] = k === 'planned_episodes' ? num(body[k], 1) : str(body[k]);
    }
    const p = store.update('projects', params.id, patch);
    if (!p) throw httpError(404, '项目不存在');
    return p;
  });

  on('DELETE', '/api/projects/:id', (req, res, params, body, query) => {
    // 两种形式都认：body 是 UI 在用的，query 是脚本/测试在用的。
    // 旧实现只读 body，导致 `?cascade=1` 被静默忽略 → 调用方以为级联删干净，实际留孤儿数据。
    const cascade = bool((body && body.cascade) || query.cascade);
    if (!store.get('projects', params.id)) throw httpError(404, '项目不存在');
    store.remove('projects', params.id);
    let removed = 0;
    let filesRemoved = 0;
    if (cascade) {
      // characters 必须在列：角色档案属于项目，漏了它级联删除会留下跨项目孤儿角色
      for (const c of ['scripts', 'storyboards', 'characters', 'image_assets', 'video_assets', 'generation_tasks']) {
        // 素材集合要连本地文件一起删，否则删完记录磁盘上全是孤儿文件
        const ownedLocalFiles = c === 'image_assets' || c === 'video_assets';
        const rows = store.list(c, { filter: (r) => r.project_id === params.id });
        if (ownedLocalFiles) {
          for (const r of rows) {
            if (r.local_file && fs.existsSync(r.local_file)) {
              try { fs.unlinkSync(r.local_file); filesRemoved++; } catch { /* 删不掉就算了 */ }
            }
          }
        }
        removed += rows.length;
        store.removeWhere(c, (r) => r.project_id === params.id);
      }
    }
    return { ok: true, removed, filesRemoved };
  });

  on('POST', '/api/projects/:id/duplicate', (req, res, params) => {
    const p = store.get('projects', params.id);
    if (!p) throw httpError(404, '项目不存在');
    const copy = Object.assign({}, p, {
      id: undefined,
      name: `${p.name} 副本`,
      created_at: undefined,
      updated_at: undefined,
    });
    delete copy.id;
    delete copy.created_at;
    delete copy.updated_at;
    return store.insert('projects', copy);
  });

  on('GET', '/api/projects/:id/export', (req, res, params) => {
    const data = store.exportProject(params.id);
    if (!data) throw httpError(404, '项目不存在');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="project-${params.id}.json"`);
    return { raw: JSON.stringify(data, null, 2) };
  });

  // B4.6 高频导出两件套：分镜表 CSV（UTF-8 BOM，Excel 双击不乱码）与视频提示词 MD（外协管线直投）
  const csvCell = (v) => {
    const x = String(v ?? '');
    return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
  };
  const SB_STATUS_ZH = { pending: '待处理', image_ready: '有图片', video_ready: '有视频', done: '完成' };

  on('GET', '/api/projects/:id/export.csv', (req, res, params, body, query) => {
    const proj = store.get('projects', params.id);
    if (!proj) throw httpError(404, '项目不存在');
    const ep = query.episode ? Number(query.episode) : null;
    const rows = store.list('storyboards', { filter: (r) => r.project_id === params.id && (ep ? Number(r.episode_number) === ep : true), limit: 100000, sort: (a, b) => (Number(a.episode_number) - Number(b.episode_number)) || (Number(a.sort_order) - Number(b.sort_order)) || (Number(a.shot_number) - Number(b.shot_number)) });
    const head = ['集数', '镜头号', '景别', '运镜', '画面描述', '人物', '绑定角色', '台词', '时长秒', '状态', '图片提示词', '图片提示词·最终词（含角色与运镜与画风）', '视频提示词', '视频提示词·最终词（含运镜；图生/多帧模式不注入角色与画风）'];
    const body1 = rows.map((r) => [
      r.episode_number, r.shot_number, r.shot_type, r.camera_move, r.scene_description, r.characters,
      resolveChars(r.character_ids).map((c) => c.name).join('、'), r.dialogue,
      r.duration_seconds, SB_STATUS_ZH[r.status] || r.status,
      r.image_prompt, finalPrompt(r.image_prompt, { projectId: params.id, storyboardId: r.id, cameraMove: r.camera_move, cameraForStill: true }),
      r.video_prompt, finalPrompt(r.video_prompt, { projectId: params.id, storyboardId: r.id, cameraMove: r.camera_move }),
    ].map(csvCell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="storyboards-${params.id}${ep ? '-ep' + ep : ''}.csv"`);
    return { raw: '\uFEFF' + [head.join(','), ...body1].join('\r\n') + '\r\n' };
  });

  on('GET', '/api/projects/:id/export.md', (req, res, params, body, query) => {
    const proj = store.get('projects', params.id);
    if (!proj) throw httpError(404, '项目不存在');
    const ep = query.episode ? Number(query.episode) : null;
    const rows = store.list('storyboards', { filter: (r) => r.project_id === params.id && (ep ? Number(r.episode_number) === ep : true), limit: 100000, sort: (a, b) => (Number(a.episode_number) - Number(b.episode_number)) || (Number(a.sort_order) - Number(b.sort_order)) || (Number(a.shot_number) - Number(b.shot_number)) });
    const L = [
      `# ${proj.name || '项目'} · 镜头提示词导出`, '',
      `- 画幅：${proj.aspect_ratio || '默认'}｜画风：${proj.art_style || '（未设，提示词即最终词）'}`,
      // 说清口径：图生/多帧模式下长相与画风由参考图携带，实际发出的是未注入版本（导出别骗人）
      '- 下方提示词已含出场角色、运镜与画风注入；**图生/多帧视频**实际发送时不注入角色与画风（长相与画风由参考图决定），**运镜仍会注入**（参考图带不了运动）', '',
    ];
    let curEp = null;
    for (const r of rows) {
      if (ep == null && r.episode_number !== curEp) { curEp = r.episode_number; L.push(`\n## 第 ${r.episode_number} 集`, ''); }
      L.push(`### #${r.shot_number} ${r.shot_type || ''}${r.camera_move ? ` · ${r.camera_move}` : ''} · ${r.duration_seconds || '?'}s`,
        r.scene_description ? `> ${r.scene_description}` : '',
        r.dialogue ? `台词：${r.dialogue}` : '',
        r.image_prompt ? `\n**图片提示词**（生成时追加出场角色、运镜与画风）\n\n\`\`\`\n${finalPrompt(r.image_prompt, { projectId: params.id, storyboardId: r.id, cameraMove: r.camera_move, cameraForStill: true })}\n\`\`\`` : '',
        r.video_prompt ? `\n**视频提示词**（生成时追加出场角色、运镜与画风）\n\n\`\`\`\n${finalPrompt(r.video_prompt, { projectId: params.id, storyboardId: r.id, cameraMove: r.camera_move })}\n\`\`\`` : '', '');
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="prompts-${params.id}${ep ? '-ep' + ep : ''}.md"`);
    return { raw: L.join('\n').replace(/\n{3,}/g, '\n\n') }; // 段落压缩，别把空行分隔误删
  });

  // ================= 剧本 =================
  on('GET', '/api/scripts', (req, res, params, body, query) => {
    const projectId = query.project_id;
    return store.list('scripts', {
      filter: (r) => (projectId ? r.project_id === projectId : true),
      sort: (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
    });
  });

  on('POST', '/api/scripts', (req, res, params, body) => {
    if (!str(body.content).trim()) throw httpError(400, '剧本内容不能为空');
    return store.insert('scripts', {
      project_id: str(body.project_id) || null,
      script_type: str(body.script_type || 'story_concept'),
      title: str(body.title) || `未命名-${now().slice(0, 10)}`,
      content: str(body.content),
      model_name: str(body.model_name),
      generation_prompt: str(body.generation_prompt),
    });
  });

  on('PUT', '/api/scripts/:id', (req, res, params, body) => {
    const patch = {};
    for (const k of ['title', 'content', 'script_type', 'project_id']) if (k in body) patch[k] = str(body[k]);
    const s = store.update('scripts', params.id, patch);
    if (!s) throw httpError(404, '剧本不存在');
    return s;
  });

  on('DELETE', '/api/scripts/:id', (req, res, params) => {
    if (!store.remove('scripts', params.id)) throw httpError(404, '剧本不存在');
    return { ok: true };
  });

  // ================= 分镜 =================
  on('GET', '/api/storyboards', (req, res, params, body, query) => {
    const projectId = query.project_id;
    const ep = query.episode ? Number(query.episode) : undefined;
    return store.list('storyboards', {
      filter: (r) => (projectId ? r.project_id === projectId : true)
        && (ep !== undefined ? Number(r.episode_number) === ep : true),
      sort: (a, b) => (num(a.sort_order, 0) - num(b.sort_order, 0)) || (num(a.shot_number, 0) - num(b.shot_number, 0)),
      limit: 1000,
    });
  });

  function storyboardRow(r, idx) {
    return {
      project_id: str(r.project_id) || null,
      episode_number: num(r.episode_number, 1),
      shot_number: num(r.shot_number, idx + 1),
      shot_type: str(r.shot_type || '中景'),
    // R19 运镜：只认字典里的值（白名单），未知值落库为空——避免任意文本被拼进视频提示词
    camera_move: cameraMovePhrase(r.camera_move) ? str(r.camera_move).trim() : '',
      scene_description: str(r.scene_description),
      // characters 是自由文本（人写的"谁出场"），character_ids 是结构化绑定（指向角色档案）。
      // 两者并存而不是二选一：老数据/粘贴脚本只有文本，硬改成 id 会让历史分镜全部丢信息。
      characters: str(r.characters),
      character_ids: idList(r.character_ids),
      scene: str(r.scene),
      action: str(r.action),
      dialogue: str(r.dialogue),
      narration: str(r.narration),
      sound_effect: str(r.sound_effect),
      duration_seconds: num(r.duration_seconds, 3),
      image_prompt: str(r.image_prompt),
      video_prompt: str(r.video_prompt),
      negative_prompt: str(r.negative_prompt || 'low quality, blurry, distorted face'),
      linked_image_id: r.linked_image_id || null,
      linked_video_id: r.linked_video_id || null,
      status: str(r.status || 'pending'),
      sort_order: num(r.sort_order, idx),
    };
  }

  on('POST', '/api/storyboards', (req, res, params, body) => {
    if (Array.isArray(body.rows)) {
      if (!body.rows.length) throw httpError(400, '没有要创建的分镜');
      const rows = store.insertMany('storyboards', body.rows.map(storyboardRow));
      return { inserted: rows.length, rows };
    }
    return store.insert('storyboards', storyboardRow(body, 0));
  });

  on('PUT', '/api/storyboards/:id', (req, res, params, body) => {
    const patch = {};
    if ('camera_move' in body) {
      const cm = str(body.camera_move).trim();
      patch.camera_move = cameraMovePhrase(cm) ? cm : ''; // 白名单：字典外的值一律落空
    }
    for (const k of ['episode_number', 'shot_number', 'shot_type', 'scene_description', 'characters',
      'scene', 'action', 'dialogue', 'narration', 'sound_effect', 'duration_seconds',
      'image_prompt', 'video_prompt', 'negative_prompt', 'linked_image_id', 'linked_video_id',
      'status', 'sort_order']) {
      if (k in body) {
        patch[k] = ['episode_number', 'shot_number', 'duration_seconds', 'sort_order'].includes(k)
          ? num(body[k], 0) : str(body[k]);
      }
    }
    // character_ids 是数组，不能走上面的 str 分支（str([...]) 会变成 "[object Object]" 这种垃圾）
    if ('character_ids' in body) patch.character_ids = idList(body.character_ids);
    const s = store.update('storyboards', params.id, patch);
    if (!s) throw httpError(404, '分镜不存在');
    return s;
  });

  on('DELETE', '/api/storyboards/:id', (req, res, params) => {
    if (!store.remove('storyboards', params.id)) throw httpError(404, '分镜不存在');
    return { ok: true };
  });

  on('POST', '/api/storyboards/reorder', (req, res, params, body) => {
    const ids = Array.isArray(body.ids) ? body.ids : [];
    ids.forEach((id, i) => store.update('storyboards', id, { sort_order: i }));
    return { ok: true, count: ids.length };
  });

  on('DELETE', '/api/storyboards', (req, res, params, body, query) => {
    // 清空某项目某集。两个参数都必须给：只给 episode 会跨项目删，都不给就是清全表 —— 一律拒绝
    const projectId = query.project_id;
    const ep = query.episode ? Number(query.episode) : undefined;
    if (!projectId || ep === undefined) throw httpError(400, '清空分镜必须同时提供 project_id 与 episode，避免误删');
    const n = store.removeWhere('storyboards', (r) => r.project_id === projectId
      && Number(r.episode_number) === ep);
    return { ok: true, removed: n };
  });

  // ================= 图片素材 =================
  on('GET', '/api/images', (req, res, params, body, query) => {
    const projectId = query.project_id;
    return store.list('image_assets', {
      filter: (r) => (projectId ? r.project_id === projectId : true),
      limit: query.limit ? Number(query.limit) : 500,
    });
  });

  on('POST', '/api/images', (req, res, params, body) => {
    return store.insert('image_assets', {
      project_id: str(body.project_id) || null,
      storyboard_id: body.storyboard_id || null,
      name: str(body.name) || `图片_${Date.now()}`,
      url: str(body.url),
      remote_url: str(body.remote_url),
      local_file: safeAssetLocal(body.local_file),
      usage_type: str(body.usage_type || 'storyboard'),
      generation_prompt: str(body.generation_prompt),
      model_name: str(body.model_name),
      width: num(body.width, 0),
      height: num(body.height, 0),
      size: str(body.size),
      source_task_id: body.source_task_id || null,
      is_favorited: bool(body.is_favorited),
      notes: str(body.notes),
      tags: Array.isArray(body.tags) ? body.tags : [],
    });
  });

  on('PUT', '/api/images/:id', (req, res, params, body) => {
    const patch = {};
    for (const k of ['name', 'usage_type', 'notes', 'project_id', 'url', 'remote_url']) {
      if (k in body) patch[k] = str(body[k]);
    }
    if ('is_favorited' in body) patch.is_favorited = bool(body.is_favorited);
    if ('tags' in body && Array.isArray(body.tags)) patch.tags = body.tags;
    const a = store.update('image_assets', params.id, patch);
    if (!a) throw httpError(404, '图片不存在');
    return a;
  });

  /** 3.5：资产删除守卫——遍历解引用 + 状态回退（image_ready/video_ready 不再说谎） */
  function unlinkAssetRefs(kind, id) {
    const field = kind === 'image' ? 'linked_image_id' : 'linked_video_id';
    let n = 0; const shots = [];
    for (const sb of store.list('storyboards', { limit: 100000 })) {
      if (sb[field] !== id) continue;
      const patch = { [field]: null };
      if (kind === 'image' && sb.status === 'image_ready') patch.status = 'pending';
      if (kind === 'video' && sb.status === 'video_ready') patch.status = sb.linked_image_id ? 'image_ready' : 'pending';
      store.update('storyboards', sb.id, patch);
      n++; if (shots.length < 3) shots.push(sb.shot_number);
    }
    return { n, shots };
  }

  on('DELETE', '/api/images/:id', (req, res, params) => {
    const a = store.get('image_assets', params.id);
    if (!a) throw httpError(404, '图片不存在');
    // 3.5：删图先解掉所有引用它的镜头（此前 linked_image_id 直接成悬挂引用，分镜表坏链）
    const refs = unlinkAssetRefs('image', params.id);
    // 本地文件跟着删，远端 URL 管不着
    if (a.local_file && fs.existsSync(a.local_file)) {
      try { fs.unlinkSync(a.local_file); } catch { /* 删不掉就算了 */ }
    }
    store.remove('image_assets', params.id);
    return { ok: true, unlinked: refs.n, shots: refs.shots };
  });

  // ================= 视频素材 / 任务 =================
  on('GET', '/api/videos', (req, res, params, body, query) => {
    const projectId = query.project_id;
    return store.list('video_assets', {
      filter: (r) => (projectId ? r.project_id === projectId : true),
      limit: query.limit ? Number(query.limit) : 300,
    });
  });

  /**
   * 创建视频任务：校验 → 提交 Agnes → 落库 → 交给轮询器
   * 超时不视为失败（原版血泪）：Agnes 可能已经收下，标记成「提交超时未知」
   * 让用户去账单核对后补录 video_id，而不是傻乎乎重复提交被重复扣费。
   */
  on('POST', '/api/videos', async (req, res, params, body) => {
    // 图生/多帧模式的**画风与长相**都由参考图自身携带，只给纯文生视频补这两层。
    // 但**运镜必须对所有模式注入**：参考图携带的是"长什么样"，携带不了"镜头怎么动"——
    // 恰恰相反，图生视频最需要的运动指令就是运镜。
    const vMode = str(body.mode || 'text_to_video');
    const cam = str(body.camera_move).trim()
      || str((store.get('storyboards', str(body.storyboard_id)) || {}).camera_move).trim();
    const prompt = vMode === 'text_to_video'
      ? finalPrompt(body.prompt, { projectId: body.project_id, characterIds: body.character_ids, storyboardId: body.storyboard_id, cameraMove: cam })
      : (() => {
        // 非文生视频：只叠运镜（有就叠，没有就原样）
        const base = str(body.prompt).trim();
        const phrase = cameraMovePhrase(cam);
        return phrase && !base.toLowerCase().includes(phrase.toLowerCase()) ? `${base}, ${phrase}` : base;
      })();
    if (!prompt) throw httpError(400, '视频提示词不能为空');

    // R26：帧数/帧率的实际取值与"被夹"的事实一起记下来，成功/失败两条路径都要回报
    const reqFrames = num(body.num_frames, 121);
    const reqFps = num(body.frame_rate, 24);
    const usedFrames = framesClamp(reqFrames);
    const usedFps = fpsClamp(reqFps);
    const clamps = [
      clampReport(reqFrames, usedFrames, 'num_frames'),
      clampReport(reqFps, usedFps, 'frame_rate'),
    ].filter(Boolean);

    /**
     * R25 提交幂等：同一个 `client_token` 在窗口内重复提交，直接返回既有的那条记录，
     * **不再向上游下单**。为什么必须有这一层：前端只有"页面布尔锁 + 按钮禁用"，
     * 而视频是**提交即计费、不可撤销**的——客户端超时（api.js 给到 600s）或连接中断时，
     * 服务端很可能已经接单，用户再点一次就是两份账单。B2 已经堵了"自动重试"这条口子，
     * 这里堵的是"人工重提"。
     *
     * 只对**可能已经花钱**的记录去重：`submit_failed`（确认没提交成功）必须放行，
     * 否则一次失败会把用户锁在"永远复现那条失败记录"里；`submit_timeout_unknown`
     * 恰恰是最需要去重的状态（结果未知 = 可能已计费）。
     */
    // 变更须知：去重只放行"确认没提交成功"的记录（submit_failed）；把状态判断放宽或改窗口，
    // 直接关系到"会不会重复计费"与"失败后还能不能重试"，改前先看本段注释与 apitest 的幂等分组。
    const clientToken = str(body.client_token).trim().slice(0, 80);
    if (clientToken) {
      const cutoff = Date.now() - VIDEO_DEDUP_WINDOW_MS;
      const dup = store.list('video_assets', {
        filter: (a) => a.client_token === clientToken
          && a.local_status !== 'submit_failed'
          && Date.parse(a.created_at || '') >= cutoff,
      })[0];
      if (dup) {
        return { ok: true, asset: dup, timed_out: dup.status === 'submit_timeout_unknown', deduped: true };
      }
    }

    const startedAt = now();
    let result;
    try {
      result = await agnes.createVideo({
        model: str(body.model) || undefined,
        prompt,
        negative_prompt: str(body.negative_prompt),
        width: num(body.width, 1152),
        height: num(body.height, 768),
        num_frames: framesClamp(body.num_frames),
        frame_rate: fpsClamp(body.frame_rate),
        seed: seedOr(body.seed) ?? undefined,
        image: body.image || undefined,
        source_images: Array.isArray(body.source_images) ? body.source_images : undefined,
        mode_flag: body.mode_flag || undefined,
        submit_retries: body.submit_retries,
      });
    } catch (e) {
      // 明确失败：也记一条本地记录，方便事后复盘参数
      const transient = agnes.isTransientError(e);
      const uncertain = !transient && e.possiblySent === true; // B2 对齐：请求可能已送达
      const retried = e.attempts > 1 ? `（已自动重试 ${e.attempts - 1} 次）` : '';
      const friendly = transient
        ? `Agnes 免费通道排队已满或限流，不是参数问题${retried}。稍等半分钟再点，或到「镜头任务」重新获取。原报错：${e.message}`
        : uncertain
          ? `请求发出后连接中断，Agnes 可能已经接单——请到「镜头任务」核对是否有新任务，不要盲目重提（可能双份计费）。原报错：${e.message}`
          : e.message;
      // 审核修复：possiblySent 的网络错不能记"未提交"（那是 B2 承诺要堵的双计费窗口）——
      // 与超时同走"结果未知"三态，用户走核对/补录流而不是直接重提。
      const failState = uncertain
        ? { status: 'submit_timeout_unknown', remote_status: 'unknown', local_status: 'submit_timeout_unknown' }
        : { status: 'failed', remote_status: 'not_submitted', local_status: 'submit_failed' };
      const asset = store.insert('video_assets', {
        project_id: str(body.project_id) || null,
        storyboard_id: body.storyboard_id || null,
        name: `视频_${Date.now()}`,
        video_url: '',
        generation_mode: str(body.mode || 'text_to_video'),
        video_prompt: prompt,
        negative_prompt: str(body.negative_prompt),
        source_image_url: str(body.image),
        source_images: Array.isArray(body.source_images) ? body.source_images : [],
        model_name: str(body.model) || store.getSettings().default_video_model,
        seed: seedOr(body.seed),
        num_frames: usedFrames,
        frame_rate: usedFps,
        width: num(body.width, 1152),
        height: num(body.height, 768),
        client_token: clientToken || null,
        cost_credits: null, cost_amount: null, cost_unit: null, // R27：失败不猜费用，null = 未知
        ...failState,
        progress: 0,
        agnes_task_id: '',
        agnes_video_id: '',
        error_message: friendly,
        is_favorited: false,
        notes: '',
        completed_at: null,
        raw_create_response: e.responseData || null,
        request_log: { error_type: e.errorType, started_at: startedAt, finished_at: now() },
      });
      return {
        ok: false,
        error: friendly, retryable: agnes.isTransientError(e),
        errorType: e.errorType || 'submit_failed',
        diagnostics: e.diagnostics || null,
        asset,
        deduped: false,
        clamps,
      };
    }

    const timedOut = result.timed_out;
    const videoId = result.video_id;
    // T1 简化：agnes 超时返回恒 video_id:''，旧写法 `timedOut ? 'remote_submitted'` 永不可达；
    // 超时统一 submit_timeout_unknown，用户可在任务卡上手动补录 video_id（bind 接口保留）。
    const localStatus = timedOut ? 'submit_timeout_unknown' : 'polling';
    const remoteStatus = timedOut && !videoId ? 'unknown' : videoId ? 'queued' : 'not_submitted';
    const legacyStatus = timedOut ? 'submit_timeout_unknown' : 'queued';

    const asset = store.insert('video_assets', {
      project_id: str(body.project_id) || null,
      storyboard_id: body.storyboard_id || null,
      name: str(body.name) || `视频_${Date.now()}`,
      video_url: '',
      generation_mode: str(body.mode || 'text_to_video'),
      video_prompt: prompt,
      negative_prompt: str(body.negative_prompt),
      source_image_url: str(body.image),
      source_images: Array.isArray(body.source_images) ? body.source_images : [],
      model_name: str(body.model) || store.getSettings().default_video_model,
      seed: seedOr(body.seed),
      num_frames: usedFrames,
      frame_rate: usedFps,
      width: num(body.width, 1152),
      height: num(body.height, 768),
      client_token: clientToken || null,
      ...agnes.extractCost(result), // R27：上游在创建响应里就给了费用的话，这一刻就落库
      status: legacyStatus,
      remote_status: remoteStatus,
      local_status: localStatus,
      progress: 0,
      agnes_task_id: result.task_id,
      agnes_video_id: videoId,
      error_message: timedOut ? str(result.message) : '',
      is_favorited: false,
      notes: '',
      completed_at: null,
      raw_create_response: result.raw,
      request_log: Object.assign({
        started_at: startedAt,
        finished_at: now(),
      }, result.diagnostics || {}),
    });

    if (videoId) poller.watch(asset.id, true);

    return {
      ok: true,
      asset,
      timed_out: timedOut,
      deduped: false,
      clamps, // R26：被夹过参数就如实回报（界面据此提醒"实际提交的是 X"）
      message: timedOut
        ? (videoId ? '请求超时，但已拿到 video_id，任务继续追踪' : '请求已发出但超时，未拿到 video_id')
        : '任务已提交',
      diagnostics: result.diagnostics || null,
    };
  });

  on('PUT', '/api/videos/:id', (req, res, params, body) => {
    const patch = {};
    for (const k of ['name', 'notes', 'error_message']) if (k in body) patch[k] = str(body[k]);
    // H5 补齐（8.7 承诺过的事）：video_url 只收 http(s) 或空——防 javascript:/data: 等形状
    // 进了下载 fetch 与"打开链接"按钮；跨主 Key 泄漏已由 downloadVideo 严格同主策略关闭。
    if ('video_url' in body) {
      const v = str(body.video_url).trim();
      patch.video_url = !v || /^https?:\/\//i.test(v) ? v : '';
    }
    if ('is_favorited' in body) patch.is_favorited = bool(body.is_favorited);
    const a = store.update('video_assets', params.id, patch);
    if (!a) throw httpError(404, '视频任务不存在');
    return a;
  });

  on('DELETE', '/api/videos/:id', (req, res, params) => {
    const a = store.get('video_assets', params.id);
    if (!a) throw httpError(404, '视频任务不存在');
    poller.stop(params.id);
    // R7→3.5：删视频清镜头回链——从"只查出生镜头"升级为全量扫描（bind 过给别人也解）
    const refs = unlinkAssetRefs('video', params.id);
    if (a.local_file && fs.existsSync(a.local_file)) {
      try { fs.unlinkSync(a.local_file); } catch { /* ignore */ }
    }
    store.remove('video_assets', params.id);
    return { ok: true, unlinked: refs.n, shots: refs.shots };
  });

  on('POST', '/api/videos/:id/refresh', async (req, res, params) => {
    const a = store.get('video_assets', params.id);
    if (!a) throw httpError(404, '视频任务不存在');
    if (!a.agnes_video_id) throw httpError(400, '本地未保存 video_id，无法自动查询。如 Agnes 账单有消费记录，请先「绑定任务 ID」。');
    try {
      const merged = await poller.pollOnce(params.id);
      // 用户主动「重新获取」→ 允许重置轮询预算（R12：只有人的动作能重置，自动 resume 不能）
      if (merged && ['queued', 'in_progress'].includes(merged.status)) poller.watch(params.id, false, { reset: true });
      return { ok: true, asset: merged };
    } catch (e) {
      return { ok: false, error: e.message, errorType: e.errorType || 'query_failed' };
    }
  });

  /** 手动补录 video_id：把「提交超时未知」的任务救回来 */
  on('POST', '/api/videos/:id/bind', (req, res, params, body) => {
    const vid = str(body.video_id).trim();
    if (!vid) throw httpError(400, '请填写 video_id');
    const a = store.get('video_assets', params.id);
    if (!a) throw httpError(404, '视频任务不存在');
    const merged = store.update('video_assets', params.id, {
      agnes_video_id: vid,
      local_status: 'polling',
      remote_status: 'queued',
      status: 'queued',
      error_message: '',
    });
    // 手动补录任务 ID 相当于给了任务第二次生命 → 重置预算
    poller.watch(params.id, true, { reset: true });
    return { ok: true, asset: merged };
  });

  on('POST', '/api/videos/:id/download', async (req, res, params) => {
    const a = store.get('video_assets', params.id);
    if (!a) throw httpError(404, '视频任务不存在');
    if (!a.video_url) throw httpError(400, '还没有视频地址，无法保存');
    const dir = store.videosDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, safeName(`${a.id}`, 'mp4'));
    try {
      const r = await agnes.downloadVideo(a.video_url, file);
      const merged = store.update('video_assets', params.id, { local_file: file });
      poller.events.emit('video', merged);
      return { ok: true, asset: merged, bytes: r.bytes };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  on('POST', '/api/videos/batch-refresh', async (req, res, params, body) => {
    const targets = store.list('video_assets').filter(
      (v) => (v.status === 'completed' || v.status === 'video_url_missing') && !v.video_url && v.agnes_video_id,
    );
    let found = 0;
    for (const v of targets) {
      try {
        const merged = await poller.pollOnce(v.id);
        if (merged && merged.video_url) found++;
        // B9：救活后仍是进行中状态的要补挂定时器，否则库面"轮询中"实际停摆到下次重启
        else if (merged && (merged.status === 'queued' || merged.status === 'in_progress')) poller.watch(v.id, false, { reset: true });
      } catch { /* 单条失败继续 */ }
    }
    return { ok: true, total: targets.length, found };
  });

  // ================= 生成任务历史 =================
  on('GET', '/api/tasks', (req, res, params, body, query) => {
    const type = query.task_type;
    return store.list('generation_tasks', {
      filter: (r) => (type ? r.task_type === type : true),
      limit: query.limit ? Number(query.limit) : 300,
    });
  });

  on('POST', '/api/tasks', (req, res, params, body) => {
    return store.insert('generation_tasks', {
      project_id: str(body.project_id) || null,
      storyboard_id: body.storyboard_id || null,
      task_type: str(body.task_type || 'text'),
      model_name: str(body.model_name),
      input_content: body.input_content || {},
      input_images: Array.isArray(body.input_images) ? body.input_images : [],
      output_result: body.output_result || null,
      status: str(body.status || 'completed'),
      error_message: str(body.error_message),
      is_favorited: false,
      notes: str(body.notes),
      seed: seedOr(body.seed),
      completed_at: now(),
    });
  });

  on('PUT', '/api/tasks/:id', (req, res, params, body) => {
    const patch = {};
    for (const k of ['notes', 'status']) if (k in body) patch[k] = str(body[k]);
    if ('is_favorited' in body) patch.is_favorited = bool(body.is_favorited);
    const t = store.update('generation_tasks', params.id, patch);
    if (!t) throw httpError(404, '任务不存在');
    return t;
  });

  on('DELETE', '/api/tasks/:id', (req, res, params) => {
    if (!store.remove('generation_tasks', params.id)) throw httpError(404, '任务不存在');
    return { ok: true };
  });

  // ================= 角色库（R14：跨镜头一致长相的锚点） =================
  /**
   * 字段设计取舍：
   *  · appearance/outfit 是"会被注入提示词"的部分（长相与服装），单独成列而不是塞进一个
   *    自由文本 notes —— 注入时要能只取"长相+服装"这两段，把性格/小传留在档案里给编剧看。
   *  · is_locked 表示"外貌锁定"：锁定后该角色的 appearance 视为不可被单镜头提示词覆盖。
   *    这是竞品（02）踩过坑的做法：不锁的话每个镜头的提示词都会各自描述长相，越写越不一致。
   *  · reference_image_ids 指向 image_assets：本地优先下参考图是"同一张脸"的最强约束。
   */
  function characterFields(b) {
    const out = {};
    for (const k of ['name', 'alias', 'role', 'gender', 'age', 'appearance', 'outfit', 'personality', 'notes']) {
      if (k in b) out[k] = str(b[k]).trim();
    }
    if ('is_locked' in b) out.is_locked = bool(b.is_locked);
    if ('reference_image_ids' in b) out.reference_image_ids = idList(b.reference_image_ids, 12);
    return out;
    // 注意：这里**不能**给缺省值。PUT 是部分更新，补一个 name:'' 会让"只改外貌"被判成
    // "改名成空"而 400（本轮真踩到）；POST 的缺省值由下面的 insert 默认对象负责。
  }

  on('GET', '/api/characters', (req, res, params, body, query) => {
    const projectId = query.project_id;
    return store.list('characters', {
      filter: (r) => (projectId ? r.project_id === projectId : true),
      sort: (a, b) => String(a.name).localeCompare(String(b.name), 'zh'),
    });
  });

  on('POST', '/api/characters', (req, res, params, body) => {
    const f = characterFields(body);
    if (!f.name) throw httpError(400, '角色名称不能为空');
    if (!str(body.project_id).trim()) throw httpError(400, '角色必须属于某个项目（project_id 必填）');
    return store.insert('characters', Object.assign({
      project_id: str(body.project_id),
      name: '', alias: '', role: '主角', gender: '', age: '',
      appearance: '', outfit: '', personality: '', notes: '',
      is_locked: false, reference_image_ids: [],
    }, f));
  });

  on('PUT', '/api/characters/:id', (req, res, params, body) => {
    if (!store.get('characters', params.id)) throw httpError(404, '角色不存在');
    const patch = characterFields(body);
    if ('name' in patch && !patch.name) throw httpError(400, '角色名称不能为空');
    const c = store.update('characters', params.id, patch);
    if (!c) throw httpError(404, '角色不存在');
    return c;
  });

  on('DELETE', '/api/characters/:id', (req, res, params) => {
    if (!store.get('characters', params.id)) throw httpError(404, '角色不存在');
    // 引用守卫（沿用 3.5 删图的做法）：分镜里还挂着这个 id 时先解绑再删。
    // 不这么做会留下"永远指不到实体"的悬空 id：分镜行的角色芯片变空白，且再也没有入口清理。
    let unlinked = 0;
    for (const sb of store.list('storyboards', { limit: 100000 })) {
      if (!Array.isArray(sb.character_ids) || !sb.character_ids.includes(params.id)) continue;
      store.update('storyboards', sb.id, { character_ids: sb.character_ids.filter((x) => x !== params.id) });
      unlinked++;
    }
    store.remove('characters', params.id);
    return { ok: true, unlinked };
  });

  // ================= 提示词模板 =================
  on('GET', '/api/templates', (req, res, params, body, query) => {
    const type = query.template_type;
    return store.list('prompt_templates', {
      filter: (r) => (type ? r.template_type === type : true),
      sort: (a, b) => String(a.template_type).localeCompare(String(b.template_type))
        || String(a.name).localeCompare(String(b.name)),
    });
  });

  on('POST', '/api/templates', (req, res, params, body) => {
    if (!str(body.name).trim()) throw httpError(400, '模板名称不能为空');
    return store.insert('prompt_templates', {
      name: str(body.name),
      template_type: str(body.template_type || 'story_concept'),
      system: str(body.system),
      content: str(body.content),
      negative_prompt: str(body.negative_prompt),
      is_favorited: bool(body.is_favorited),
      is_builtin: false,
      notes: str(body.notes),
    });
  });

  on('PUT', '/api/templates/:id', (req, res, params, body) => {
    const patch = {};
    for (const k of ['name', 'template_type', 'system', 'content', 'negative_prompt', 'notes']) {
      if (k in body) patch[k] = str(body[k]);
    }
    if ('is_favorited' in body) patch.is_favorited = bool(body.is_favorited);
    const t = store.update('prompt_templates', params.id, patch);
    if (!t) throw httpError(404, '模板不存在');
    return t;
  });

  on('DELETE', '/api/templates/:id', (req, res, params) => {
    if (!store.remove('prompt_templates', params.id)) throw httpError(404, '模板不存在');
    return { ok: true };
  });

  // ================= Agnes 调用 =================
  on('POST', '/api/agnes/text', async (req, res, params, body) => {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) throw httpError(400, 'messages 不能为空');
    const startedAt = now();
    try {
      const r = await agnes.chat(messages, {
        model: str(body.model) || undefined,
        temperature: body.temperature != null ? num(body.temperature, 0.7) : 0.7,
        timeoutMs: num(body.timeout_ms, 120000),
        json: bool(body.json_mode),
      });
      // 文本生成也留一条任务记录，任务页才有完整历史
      store.insert('generation_tasks', {
        project_id: str(body.project_id) || null,
        storyboard_id: body.storyboard_id || null,
        task_type: 'text',
        model_name: str(body.model) || store.getSettings().default_text_model,
        input_content: { messages },
        input_images: [],
        output_result: { content: r.content },
        status: 'completed',
        error_message: '',
        is_favorited: false,
        notes: str(body.note),
        seed: null,
        completed_at: now(),
      });
      return { ok: true, content: r.content, diagnostics: r.diagnostics, started_at: startedAt };
    } catch (e) {
      store.insert('generation_tasks', {
        project_id: str(body.project_id) || null,
        task_type: 'text',
        model_name: str(body.model) || store.getSettings().default_text_model,
        input_content: { messages },
        input_images: [],
        output_result: null,
        status: 'failed',
        error_message: e.message,
        is_favorited: false,
        notes: '',
        seed: null,
        completed_at: now(),
      });
      return { ok: false, error: e.message, errorType: e.errorType || 'text_failed' };
    }
  });

  /** B4.1：按项目画风拼接最终提示词（无项目/无画风原样返回，自动去重） */
  function styleOf(projectId) {
    if (!projectId) return '';
    const p = store.get('projects', String(projectId));
    return (p && p.art_style) || '';
  }

  /** 按 id 取角色实体（不存在的 id 静默丢弃：角色被删后分镜可能还留着旧 id 一瞬间） */
  function resolveChars(ids) {
    const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (!list.length) return [];
    const all = store.list('characters', { limit: 100000 });
    return list.map((id) => all.find((c) => c.id === id)).filter(Boolean);
  }

  /**
   * R15：最终提示词 = 内容 → 角色注入 → 画风注入（顺序固定）。
   * 图片/视频/CSV/MD 四个使用点都走这一个函数，保证"导出里看到的"与"实际发出去的"逐字一致
   * （这是 B4.2 计算态预览能成立的前提）。
   * 角色来源优先级：显式 character_ids > 该分镜上的绑定 —— 调用方（含批量路径）不必记得传。
   */
  function finalPrompt(base, opts = {}) {
    const text = str(base).trim();
    if (!text) return '';
    let chars = [];
    if (Array.isArray(opts.characterIds) && opts.characterIds.length) chars = resolveChars(opts.characterIds);
    else if (opts.storyboardId) chars = resolveChars((store.get('storyboards', str(opts.storyboardId)) || {}).character_ids);
    // 层次固定：内容 → 角色 → 运镜 → 画风 → 变体。前端 consts.js 的镜像按同一顺序复算，
    // 顺序一乱，"预览"和"实际发出"就开始对不上。
    let out = characterPhrase(text, chars);
    const cam = cameraMovePhrase(opts.cameraMove, opts.cameraForStill);
    if (cam && !out.toLowerCase().includes(cam.toLowerCase())) out = `${out}, ${cam}`;
    out = artStylePhrase(out, opts.projectId ? styleOf(opts.projectId) : '');
    const vp = variationPhrase(opts.variation);
    if (vp) out = `${out}, ${vp}`;
    return out;
  }

  on('POST', '/api/agnes/image', async (req, res, params, body) => {
    // 使用点注入：角色 + 运镜 + 画风 + 变体都只在这里拼，入库的 image_prompt 永远只存镜头内容
    // 运镜与角色同一口径：显式传了就用传的，没传就从分镜行取（前端只带 storyboard_id 也要生效）
    const imgCam = str(body.camera_move).trim()
      || str((store.get('storyboards', str(body.storyboard_id)) || {}).camera_move).trim();
    const prompt = finalPrompt(body.prompt, {
      projectId: body.project_id,
      characterIds: body.character_ids,
      storyboardId: body.storyboard_id,
      cameraMove: imgCam,
      cameraForStill: true, // 图片是静帧：只注入机位/视角类运镜（见 cameraMovePhrase 的 forStill）
      variation: body.variation,
    });
    if (!prompt) throw httpError(400, '图片提示词不能为空');
    const size = str(body.size || '1024x1024');
    const [w, h] = size.split('x').map((n) => Number(n) || 1024);
    const model = str(body.model) || store.getSettings().default_image_model;

    try {
      const r = await agnes.image({
        prompt, model, size,
        image: body.image || undefined,
      });

      let localUrl = '';
      let localFile = '';
      let remoteUrl = r.url || '';

      if (r.b64) {
        const saved = saveImageBase64(r.b64, r.mime);
        localFile = saved.file;
        localUrl = saved.url;
      } else if (r.url) {
        // 远端 URL 会过期，默认抓一份到本地；抓不到就退回用远端地址
        const saved = await fetchRemoteImage(r.url);
        if (saved) { localFile = saved.file; localUrl = saved.url; }
      }

      if (!localUrl && !remoteUrl) throw httpError(502, '图片生成失败：Agnes 未返回图片数据');

      const asset = store.insert('image_assets', {
        project_id: str(body.project_id) || null,
        storyboard_id: body.storyboard_id || null,
        name: str(body.name) || `图片_${Date.now()}`,
        url: localUrl || remoteUrl,
        remote_url: remoteUrl,
        local_file: localFile,
        usage_type: str(body.usage_type || 'storyboard'),
        generation_prompt: prompt,
        model_name: model,
        width: num(body.width, w),
        height: num(body.height, h),
        size,
        source_task_id: null,
        is_favorited: false,
        notes: str(body.notes),
        tags: [],
      });

      if (body.storyboard_id) {
        store.update('storyboards', body.storyboard_id, {
          linked_image_id: asset.id,
          status: 'image_ready',
        });
      }

      store.insert('generation_tasks', {
        project_id: str(body.project_id) || null,
        storyboard_id: body.storyboard_id || null,
        task_type: 'image',
        model_name: model,
        input_content: { prompt, size, image: body.image || null },
        input_images: body.image ? [body.image] : [],
        output_result: { url: asset.url },
        status: 'completed',
        error_message: '',
        is_favorited: false,
        notes: '',
        seed: null,
        completed_at: now(),
      });

      return { ok: true, asset };
    } catch (e) {
      if (e.statusCode) throw e;
      store.insert('generation_tasks', {
        project_id: str(body.project_id) || null,
        task_type: 'image',
        model_name: model,
        input_content: { prompt, size },
        input_images: body.image ? [body.image] : [],
        output_result: null,
        status: 'failed',
        error_message: e.message,
        is_favorited: false,
        notes: '',
        seed: null,
        completed_at: now(),
      });
      return { ok: false, error: e.message, errorType: e.errorType || 'image_failed' };
    }
  });

  // ================= 批量任务 =================
  /**
   * 批量生图：body = { items: [{storyboard_id, prompt, size, usage_type, project_id}], concurrency }
   * 返回 jobId，进度通过 SSE 的 batch 事件推给前端。
   */
  on('POST', '/api/batch/images', (req, res, params, body) => {
    const items = Array.isArray(body.items) ? body.items.filter((i) => str(i.prompt).trim()) : [];
    if (!items.length) throw httpError(400, '没有要生成的图片（提示词为空）');
    const job = jobs.create('images', items.length);

    // 异步跑，接口立刻返回
    (async () => {
      await jobs.run(job, items, async (item) => {
        const r = await fetchInternal('POST', '/api/agnes/image', {
          prompt: item.prompt,
          size: item.size || '1024x1024',
          usage_type: item.usage_type || 'storyboard',
          project_id: item.project_id || null,
          storyboard_id: item.storyboard_id || null,
          model: item.model || undefined,
        });
        if (!r || r.ok === false) return { ok: false, error: r?.error || '生成失败' };
        return { ok: true, id: r.asset?.id };
      }, {
        concurrency: num(body.concurrency, store.getSettings().default_concurrent_tasks),
        onProgress: (j) => poller.events.emit('batch', j),
      });
      jobs.prune();
    })();

    return { ok: true, jobId: job.id, total: job.total };
  });

  on('POST', '/api/batch/videos', (req, res, params, body) => {
    const items = Array.isArray(body.items) ? body.items.filter((i) => str(i.prompt).trim()) : [];
    if (!items.length) throw httpError(400, '没有要生成的视频（提示词为空）');
    const job = jobs.create('videos', items.length);

    (async () => {
      await jobs.run(job, items, async (item) => {
        // 限流瞬时错已在 agnes.createVideo 内做退避重试；这里允许整批覆盖预算
        const payload = body.submit_retries != null ? { ...item, submit_retries: body.submit_retries } : item;
        const r = await fetchInternal('POST', '/api/videos', payload);
        if (!r || r.ok === false) return { ok: false, error: r?.error || '提交失败' };
        return { ok: true, id: r.asset?.id };
      }, {
        concurrency: num(body.concurrency, 1), // 视频默认串行提交，避免重复扣费
        onProgress: (j) => poller.events.emit('batch', j),
      });
      jobs.prune();
    })();

    return { ok: true, jobId: job.id, total: job.total };
  });

  on('GET', '/api/batch/:id', (req, res, params) => {
    const job = jobs.get(params.id);
    if (!job) throw httpError(404, '任务不存在');
    return job;
  });

  on('POST', '/api/batch/:id/cancel', (req, res, params) => {
    if (!jobs.cancel(params.id)) throw httpError(404, '任务不存在');
    return { ok: true };
  });

  on('GET', '/api/batch', () => jobs.list());

  // ================= 导入导出 =================
  on('GET', '/api/export', (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="agnes-studio-backup-${now().slice(0, 10)}.json"`);
    return { raw: JSON.stringify(store.exportAll(), null, 2) };
  });

  on('POST', '/api/import', (req, res, params, body) => {
    const mode = str(body.mode || 'merge');
    if (!['merge', 'replace'].includes(mode)) throw httpError(400, '导入模式只能是 merge 或 replace');
    try {
      const r = store.importAll(body.data || body, mode);
      // H4：skipped 如实上报（手改 JSON 追加时忘带 id 的行不再静默蒸发）
      return { ok: true, imported: r.added, skipped: r.skipped, stats: store.stats() };
    } catch (e) {
      throw httpError(400, '导入失败：数据格式非法');
    }
  });

  // ================= 日志 =================
  on('GET', '/api/logs', () => poller.log.slice(0, 100));

  // ── 内部调用（避免批量任务里自己 fetch 自己） ──────────────
  async function fetchInternal(method, url, payload) {
    const route = routes.find((r) => r.method === method && r.pattern === url);
    if (!route) throw new Error(`内部路由不存在: ${method} ${url}`);
    return await route.handler({}, null, {}, payload || {}, {});
  }

  function httpError(status, message) {
    const e = new Error(message);
    e.statusCode = status;
    return e;
  }

  /** 匹配并执行；返回 undefined 表示没匹配到 */
  function dispatch(method, pathname, body, query, req, res) {
    for (const r of routes) {
      const params = match(pathname, r.pattern);
      if (!params) continue;
      if (r.method !== method) continue;
      return r.handler(req, res, params, body || {}, query || {});
    }
    return undefined;
  }

  return { dispatch, httpError, saveImageBase64, fetchRemoteImage, safeName, refreshModels };
};
module.exports.artStylePhrase = artStylePhrase;
module.exports.characterPhrase = characterPhrase;
module.exports.cameraMovePhrase = cameraMovePhrase;
module.exports.variationPhrase = variationPhrase;
module.exports.ART_STYLE_MAP = ART_STYLE_MAP;
