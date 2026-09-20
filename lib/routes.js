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
const story = require('./story.js');

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

/**
 * 批 8 补 2：原著卡片注入（使用点注入，与画风/角色同范式）。
 *  · 只注入"画面上看得见"的两类：**地点卡**与**道具卡**。人物卡走角色库那条路（有参考图、有锁定语义、
 *    还要和分镜行绑定），信息卡/剧情卡/时间线是给编剧看的全局设定——逐镜注入只会稀释画面描述、白烧配额。
 *  · 与角色注入同一纪律：同一段描述已在提示词里出现就不再追加（长提示词自我重复会挤掉有效信息）。
 *  · 与 public/js/consts.js 的 storyCardPhrase 必须逐字同构（uitest 有文本比对钉）：前端拿它算"真正
 *    发出的是什么"，两边逻辑一漂移，分镜页的预览就开始骗人。
 */
const STORY_CARD_INJECT_FIELDS = {
  location: ['atmosphere', 'region', 'time_of_day', 'features'],
  prop: ['owner', 'usage', 'features'],
};

/**
 * 按类别取"会被注入提示词"的那几个字段，拼成一句短语（没内容返回空串）。
 * 注意：这是**模块级**纯函数，不能用 createRoutes 内部的 str/num 工具（那些在闭包里），
 * 与 characterPhrase 保持同一写法，才能被 selftest 直接 require 断言；
 * 函数体内也不放注释 —— uitest 的"前后端逐字同构"钉按去空白比对，注释会让它红。
 */
function storyCardLook(card) {
  const kind = String((card && card.kind) || '').trim();
  const fields = STORY_CARD_INJECT_FIELDS[kind];
  if (!fields) return '';
  return fields.map((f) => String(card[f] == null ? '' : card[f]).trim()).filter(Boolean).join('，');
}

function storyCardPhrase(prompt, cards) {
  const list = Array.isArray(cards) ? cards.filter(Boolean) : [];
  if (!list.length) return prompt;
  const p = String(prompt || '');
  const lower = p.toLowerCase();
  const parts = [];
  for (const c of list) {
    const name = String(c.name == null ? '' : c.name).trim();
    const look = storyCardLook(c);
    if (!look) continue;
    if (lower.includes(look.toLowerCase())) continue;
    parts.push(name ? `${name}：${look}` : look);
  }
  if (!parts.length) return prompt;
  const block = `场景道具——${parts.join('；')}`;
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
  on('GET', '/api/health', () => {
    // 代码比进程新时如实报出来（批 8 补 27）：前端据此显示"请重启服务"的横幅 ——
    // 否则页面显示新功能、接口报"接口不存在"，用户会以为功能根本没做
    const st = ctx.boot && typeof ctx.boot.staleInfo === 'function'
      ? ctx.boot.staleInfo() : { stale: false, changed: [], checked: false };
    return {
      ok: true,
      version: ctx.version,
      data_home: store.home(),
      time: now(),
      pid: ctx.boot ? ctx.boot.pid : process.pid,
      booted_at: ctx.boot ? ctx.boot.at : '',
      code_sig: ctx.boot ? ctx.boot.sig : '',
      code_stale: !!st.stale,
      stale_files: st.changed || [],
      // 只把"要不要重启"这件事说清楚；具体原因留给接口报错处（那里才是用户撞上的地方）
      stale_hint: st.stale
        ? `服务端代码在启动后被改过（${(st.changed || []).slice(0, 3).join('、')}${(st.changed || []).length > 3 ? ' 等' : ''}），当前进程跑的还是旧代码：请重启服务，否则新功能会报"接口不存在"`
        : '',
    };
  });

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
    const head = ['集数', '镜头号', '景别', '运镜', '画面描述', '人物', '绑定角色', '绑定原著卡片', '台词', '时长秒', '状态', '图片提示词', '图片提示词·最终词（含原著场景道具与角色与运镜与画风）', '视频提示词', '视频提示词·最终词（含原著场景道具与运镜；图生/多帧模式不注入角色与画风）'];
    const body1 = rows.map((r) => [
      r.episode_number, r.shot_number, r.shot_type, r.camera_move, r.scene_description, r.characters,
      resolveChars(r.character_ids).map((c) => c.name).join('、'),
      resolveStoryCards(r.story_card_ids).map((c) => c.name).join('、'), r.dialogue,
      r.duration_seconds, SB_STATUS_ZH[r.status] || r.status,
      r.image_prompt, finalPrompt(r.image_prompt, { projectId: params.id, storyboardId: r.id, storyCardIds: r.story_card_ids, cameraMove: r.camera_move, cameraForStill: true }),
      r.video_prompt, finalPrompt(r.video_prompt, { projectId: params.id, storyboardId: r.id, storyCardIds: r.story_card_ids, cameraMove: r.camera_move }),
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
      '- 下方提示词已含原著场景道具、出场角色、运镜与画风注入；**图生/多帧视频**实际发送时不注入角色与画风（长相与画风由参考图决定），**运镜与原著场景道具仍会注入**（参考图带不了文字设定）', '',
    ];
    let curEp = null;
    for (const r of rows) {
      if (ep == null && r.episode_number !== curEp) { curEp = r.episode_number; L.push(`\n## 第 ${r.episode_number} 集`, ''); }
      L.push(`### #${r.shot_number} ${r.shot_type || ''}${r.camera_move ? ` · ${r.camera_move}` : ''} · ${r.duration_seconds || '?'}s`,
        r.scene_description ? `> ${r.scene_description}` : '',
        r.dialogue ? `台词：${r.dialogue}` : '',
        r.image_prompt ? `\n**图片提示词**（生成时追加原著场景道具、出场角色、运镜与画风）\n\n\`\`\`\n${finalPrompt(r.image_prompt, { projectId: params.id, storyboardId: r.id, storyCardIds: r.story_card_ids, cameraMove: r.camera_move, cameraForStill: true })}\n\`\`\`` : '',
        r.video_prompt ? `\n**视频提示词**（生成时追加原著场景道具、出场角色、运镜与画风）\n\n\`\`\`\n${finalPrompt(r.video_prompt, { projectId: params.id, storyboardId: r.id, storyCardIds: r.story_card_ids, cameraMove: r.camera_move })}\n\`\`\`` : '', '');
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
      // 批 8 补 8：剧本按集存放（0 = 未指定/全剧），逐集生成才能一集一条地存下来
      episode_number: Math.max(0, num(body.episode_number, 0)),
      // 批 8 补 12：这一集生成时"喂给模型的输入"（本集拍表 + 前情提要）的指纹。
      // 原著追加解析、重切分集都会让输入变 —— 没有指纹就只能靠用户自己记得改过什么。
      plan_digest: str(body.plan_digest),
      prior_chars: num(body.prior_chars, 0),
    });
  });

  on('PUT', '/api/scripts/:id', (req, res, params, body) => {
    const patch = {};
    for (const k of ['title', 'content', 'script_type', 'project_id', 'plan_digest']) if (k in body) patch[k] = str(body[k]);
    if ('episode_number' in body) patch.episode_number = Math.max(0, num(body.episode_number, 0));
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
      // 批 8 补 2：原著卡片绑定（地点卡/道具卡）。与 character_ids 同一范式：
      // 结构化绑定指向卡片档案，注入发生在使用点，入库的 image_prompt 仍只存镜头内容。
      story_card_ids: injectableCardIds(r.story_card_ids),
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
      // 批 8 补 12：记住"这份分镜是从哪份剧本、哪一版正文生成的"。存 id 而不是只存指纹，
      // 是为了能回答"源剧本被删了没有"；指纹回答"源剧本的内容改过没有"。两者缺一不可。
      source_script_id: str(r.source_script_id) || null,
      // 指纹按**入库那一刻**的源剧本正文算（不信任前端传来的值：前端复算哈希迟早跟服务端漂移，
      // 而这里的判据是"内容变没变"，算错了会直接导致漏报/误报过期）
      script_digest: sourceDigest(str(r.source_script_id)),
    };
  }

  /** 某份剧本正文的指纹；剧本不存在时为空串（"不知道来源"要能与"内容一致"区分开） */
  function sourceDigest(scriptId) {
    const id = str(scriptId).trim();
    if (!id) return '';
    const sc = store.get('scripts', id);
    return sc ? story.digestText(sc.content) : '';
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
    if ('story_card_ids' in body) patch.story_card_ids = injectableCardIds(body.story_card_ids);
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

  /**
   * 镜头绑定自动匹配（批 8 补 5）：把"模型写在文本里的出场人物/场景"变成结构化绑定。
   *
   * 为什么需要：分镜表是模型生成的，它只会写自由文本（`characters`），`character_ids` / `story_card_ids`
   * 是空的 —— 于是每个镜头都要人挨个点一遍，不点就**静默失去**外貌与场景注入（同一张脸在不同镜头里漂移，
   * 且没有任何报错）。匹配是可判定的（名字/别名是否出现），所以**不调模型、不花钱**。
   *
   * 两档置信度（见 `lib/story.js` 的 matchShotBindings）：`via='characters'` 是模型明确说了"谁出场"，
   * 可以自动落库；`via='prompt'` 只是文本里出现过（可能撞词），默认只报给人看。
   * `strong_only=true` 就是"生成后自动跑一次"用的模式：只吃高置信那档，绝不猜。
   */
  on('POST', '/api/storyboards/auto-bind', (req, res, params, body) => {
    const projectId = str(body.project_id).trim();
    if (!projectId) throw httpError(400, 'project_id 必填');
    const ids = idList(body.storyboard_ids);
    const ep = body.episode_number == null || body.episode_number === '' ? null : num(body.episode_number, 0);
    const dryRun = body.dry_run === true;
    const strongOnly = body.strong_only === true;
    const shots = store.list('storyboards', {
      filter: (r) => r.project_id === projectId
        && (ids.length ? ids.includes(r.id) : true)
        && (ep ? Number(r.episode_number) === ep : true),
      limit: 100000,
      sort: (a, b) => (Number(a.episode_number) - Number(b.episode_number))
        || (Number(a.sort_order) - Number(b.sort_order)) || (Number(a.shot_number) - Number(b.shot_number)),
    });
    const characters = store.list('characters', { filter: (r) => r.project_id === projectId, limit: 100000 });
    const cards = store.list('story_cards', { filter: (r) => r.project_id === projectId, limit: 100000 });
    const matches = [];
    for (const s of shots) {
      const m = story.matchShotBindings(s, { characters, cards });
      const useChars = m.chars.filter((x) => !strongOnly || !x.weak);
      const useCards = m.cards.filter((x) => !strongOnly || !x.weak);
      const skipped = (m.chars.length - useChars.length) + (m.cards.length - useCards.length);
      if (!useChars.length && !useCards.length) {
        if (skipped) matches.push({ storyboard_id: s.id, shot_number: s.shot_number, episode_number: s.episode_number, added_characters: [], added_cards: [], skipped_weak: skipped });
        continue;
      }
      matches.push({
        storyboard_id: s.id, shot_number: s.shot_number, episode_number: s.episode_number,
        added_characters: useChars.map((x) => ({ id: x.id, name: x.name, via: x.via, weak: x.weak })),
        added_cards: useCards.map((x) => ({ id: x.id, name: x.name, kind: x.kind, via: x.via, weak: x.weak })),
        skipped_weak: skipped,
      });
      if (!dryRun) {
        store.update('storyboards', s.id, {
          // 并集而不是覆盖：人手工绑过的绑定不能被自动匹配抹掉
          character_ids: [...new Set([...(Array.isArray(s.character_ids) ? s.character_ids : []), ...useChars.map((x) => x.id)])],
          story_card_ids: injectableCardIds([...(Array.isArray(s.story_card_ids) ? s.story_card_ids : []), ...useCards.map((x) => x.id)]),
        });
      }
    }
    const changed = matches.filter((m) => m.added_characters.length || m.added_cards.length);
    return {
      ok: true, dry_run: dryRun, strong_only: strongOnly,
      scanned: shots.length, updated: dryRun ? 0 : changed.length,
      strong: changed.reduce((n, m) => n + m.added_characters.filter((x) => !x.weak).length + m.added_cards.filter((x) => !x.weak).length, 0),
      weak: changed.reduce((n, m) => n + m.added_characters.filter((x) => x.weak).length + m.added_cards.filter((x) => x.weak).length, 0),
      matches: dryRun ? matches : changed,
    };
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
      ? finalPrompt(body.prompt, { projectId: body.project_id, characterIds: body.character_ids, storyCardIds: body.story_card_ids, storyboardId: body.storyboard_id, cameraMove: cam })
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
      patch.video_url = !v || story.isPublicUrl(v) ? v : '';
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
   * 写入时的白名单（与 camera_move 同一纪律）：只把"可注入类别"的卡片 id 落库。
   * 不这么做的话，绑一张人物卡会存下来却永远不生效 —— 界面上显示"已绑定"、出图时却看不见它，
   * 用户只能靠猜。注入点仍会再过滤一次（卡片可能事后被删或改了类别），两层都要有。
   */
  function injectableCardIds(ids) {
    const list = idList(ids);
    if (!list.length) return [];
    const all = store.list('story_cards', { limit: 100000 });
    return list.filter((id) => {
      const c = all.find((x) => x.id === id);
      return c && STORY_CARD_INJECT_FIELDS[c.kind];
    });
  }

  /** 取可注入的原著卡片（地点卡/道具卡）；未知 id 与不可注入的类别一律丢掉，不做静默降级 */
  function resolveStoryCards(ids) {
    const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (!list.length) return [];
    const all = store.list('story_cards', { limit: 100000 });
    return list.map((id) => all.find((c) => c.id === id))
      .filter((c) => c && STORY_CARD_INJECT_FIELDS[c.kind]);
  }

  /**
   * R15：最终提示词 = 内容 → 原著场景道具注入 → 角色注入 → 画风注入（顺序固定）。
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
    // 原著场景道具的来源优先级与角色一致：显式传的 > 该分镜上绑定的（批量路径只带 storyboard_id 也要生效）
    const sbRow = opts.storyboardId ? (store.get('storyboards', str(opts.storyboardId)) || {}) : {};
    const cards = Array.isArray(opts.storyCardIds) && opts.storyCardIds.length
      ? resolveStoryCards(opts.storyCardIds)
      : (opts.storyboardId ? resolveStoryCards(sbRow.story_card_ids) : []);
    // 层次固定：内容 → 原著场景道具 → 角色 → 运镜 → 画风 → 变体。前端 consts.js 的镜像按同一顺序复算，
    // 顺序一乱，"预览"和"实际发出"就开始对不上。
    let out = storyCardPhrase(text, cards);
    out = characterPhrase(out, chars);
    const cam = cameraMovePhrase(opts.cameraMove, opts.cameraForStill);
    if (cam && !out.toLowerCase().includes(cam.toLowerCase())) out = `${out}, ${cam}`;
    out = artStylePhrase(out, opts.projectId ? styleOf(opts.projectId) : '');
    const vp = variationPhrase(opts.variation);
    if (vp) out = `${out}, ${vp}`;
    return out;
  }

  /**
   * 角色参考图 → 出图输入（批 8 补 13）。
   *
   * 为什么需要：`characters.reference_image_ids` 是"同一张脸"的**最强约束**（本地优先下，
   * 文字描述再多也描述不出一张具体的脸），但在这之前它只被角色库页当封面显示，**从来没进过出图调用** ——
   * 用户传了参考图、勾了角色，出图却仍是一张全新的脸。
   *
   * 与运镜/画风/长相同一条纪律：**在使用点注入**，入库的 image_prompt 只存镜头内容。
   * 降级如实上报：Agnes 只能抓公网 URL，本地 `/assets/…` 抓不到（与图生视频同一判定），
   * 所以"传了参考图却用不上"必须让用户看见，而不是静默当没传。
   * @returns {{urls:string[], chars:string[], local:number, missing:number}}
   */
  function characterRefImages(chars, opts = {}) {
    const max = Math.max(1, num(opts.max, 4)); // 参考图不是越多越好：多了会互相打架，也拖慢生成
    const urls = [];
    const names = [];
    let local = 0; let missing = 0;
    for (const c of (Array.isArray(chars) ? chars : [])) {
      let hit = false;
      for (const id of (Array.isArray(c.reference_image_ids) ? c.reference_image_ids : [])) {
        const a = store.get('image_assets', str(id));
        if (!a) { missing++; continue; }
        const u = str(a.remote_url).trim() || str(a.url).trim();
        if (story.isPublicUrl(u)) {
          if (!urls.includes(u) && urls.length < max) { urls.push(u); hit = true; }
        } else local++;
      }
      if (hit) names.push(str(c.name));
    }
    return { urls, chars: names, local, missing };
  }

  /**
   * 地点卡/道具卡的参考图（批 8 补 17）。
   *
   * 与 `characterRefImages` 同一套规则（只认公网 http(s)、上限、用不上如实上报），
   * 差别只在**数据来源**：角色读 `characters`，场景/道具读绑定到镜头上的 `story_cards`。
   * 为什么需要：地点卡只有一行文字描述，于是"同一个客厅"每张图长得都不一样 ——
   * 这与批 8 补 13 修掉的"传了参考图却从不进调用"是**同一类静默失效**。
   */
  function storyCardRefImages(cards, opts = {}) {
    const max = Math.max(1, num(opts.max, 4));
    const urls = [];
    const names = [];
    let local = 0; let missing = 0;
    for (const c of (Array.isArray(cards) ? cards : [])) {
      let hit = false;
      for (const id of (Array.isArray(c.reference_image_ids) ? c.reference_image_ids : [])) {
        const a = store.get('image_assets', str(id));
        if (!a) { missing++; continue; }
        const u = str(a.remote_url).trim() || str(a.url).trim();
        if (story.isPublicUrl(u)) {
          if (!urls.includes(u) && urls.length < max) { urls.push(u); hit = true; }
        } else local++;
      }
      if (hit) names.push(str(c.name));
    }
    return { urls, cards: names, local, missing };
  }

  on('POST', '/api/agnes/image', async (req, res, params, body) => {
    // 使用点注入：原著场景道具 + 角色 + 运镜 + 画风 + 变体都只在这里拼，入库的 image_prompt 永远只存镜头内容
    // 运镜/角色/原著卡片同一口径：显式传了就用传的，没传就从分镜行取（前端只带 storyboard_id 也要生效）
    const sbRow0 = body.storyboard_id ? (store.get('storyboards', str(body.storyboard_id)) || {}) : {};
    const imgCam = str(body.camera_move).trim() || str(sbRow0.camera_move).trim();
    // 负面提示词同一口径：显式传了就用传的，没传就从分镜行取。
    // 此前图片链**完全没读它** —— 分镜行有默认负面词、视频用了它、图片却静默丢掉。
    const neg = str(body.negative_prompt).trim() || str(sbRow0.negative_prompt).trim();
    const prompt = story.negativePhrase(finalPrompt(body.prompt, {
      projectId: body.project_id,
      characterIds: body.character_ids,
      storyCardIds: body.story_card_ids,
      storyboardId: body.storyboard_id,
      cameraMove: imgCam,
      cameraForStill: true, // 图片是静帧：只注入机位/视角类运镜（见 cameraMovePhrase 的 forStill）
      variation: body.variation,
    }), neg);
    if (!prompt) throw httpError(400, '图片提示词不能为空');
    // 参考图：显式传的排前面（用户当场指定的优先），再自动补上绑定角色的参考图
    const sbRow = sbRow0;
    const refChars = resolveChars(Array.isArray(body.character_ids) && body.character_ids.length
      ? body.character_ids
      : sbRow.character_ids);
    const ref = characterRefImages(refChars);
    // 地点卡/道具卡的参考图（批 8 补 17）：与角色同一口径 —— 显式传的优先，再角色，最后场景/道具。
    // 顺序是有意的：**脸**比**景**更难靠文字说准，所以总上限 4 张时先保角色。
    // （resolveStoryCards 已只返回可注入的 kind，这里再按 CARD_IMAGE_KINDS 收一道，防注入表以后扩容。）
    const refCards = storyCardRefImages(resolveStoryCards(
      Array.isArray(body.story_card_ids) && body.story_card_ids.length
        ? body.story_card_ids
        : sbRow.story_card_ids,
    ).filter((c) => story.CARD_IMAGE_KINDS.includes(c.kind)));
    const explicit = Array.isArray(body.image) ? body.image.filter(Boolean) : (body.image ? [body.image] : []);
    const allRefs = [...new Set([...explicit, ...ref.urls, ...refCards.urls])];
    const inputImages = allRefs.slice(0, 4);
    // 被总上限挤掉的如实计数：不然"我挂了 6 张怎么只用了 4 张"没人回答
    const dropped = Math.max(0, allRefs.length - inputImages.length);
    const size = str(body.size || '1024x1024');
    const [w, h] = size.split('x').map((n) => Number(n) || 1024);
    const model = str(body.model) || store.getSettings().default_image_model;

    try {
      const r = await agnes.image({
        prompt, model, size,
        image: inputImages.length ? inputImages : undefined,
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
        input_content: {
          prompt, size,
          image: inputImages[0] || null,
          reference_images: [...ref.urls, ...refCards.urls],
          negative_prompt: neg,
        },
        input_images: inputImages,
        output_result: { url: asset.url },
        status: 'completed',
        error_message: '',
        is_favorited: false,
        notes: '',
        seed: null,
        completed_at: now(),
      });

      return {
        ok: true, asset,
        // 如实上报：传了参考图却因为不是公网 URL 用不上时，用户必须能看见（否则会以为"参考图生效了"）
        negative_prompt: neg,
        reference_images: {
          // used = **实际发出**的张数（含显式传的、角色的、场景道具卡的）—— 口径与批 8 补 13 一致
          used: inputImages.length,
          characters: ref.chars,
          // 场景/道具卡的参考图（批 8 补 17）与角色分开报：用户要知道"这几张是哪个来源带上的"
          cards: refCards.cards,
          card_urls: refCards.urls,
          local_skipped: ref.local + refCards.local,
          missing: ref.missing + refCards.missing,
          dropped,
          attached: inputImages,
        },
      };
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

  // ================= 原著解析（批 8） =================
  /**
   * 把一部长篇原文解析成结构化卡片（信息卡/人物卡/地点卡/道具卡/剧情卡/时间线）。
   *
   * 为什么是"分块 map + 全局 reduce"两段，而不是一次调用：
   *   一次调用塞不下几十万字。研读的 04 号竞品直接把原文截断到 1 万字再抽取，
   *   等于只读了开头却宣称"已解析全书"——用户拿到的卡片必然漏掉后半部的人物。
   *   分块后每块独立抽取（可并发），再由**纯函数**跨块去重合并（lib/story.js），
   *   最后用一次 reduce 调用归纳信息卡与剧情卡。哪一段没读、读漏了多少，全程如实上报。
   *
   * 计费闸门：/api/story/plan 是干跑（只切块、不调模型、不落库），
   * 前端据此告诉用户"将分 N 段、发起 N+1 次调用"并等确认，再调 analyze。
   */
  function storyChunkOpts(body) {
    return {
      maxChars: num(body.max_chars, story.DEFAULT_MAX_CHARS),
      maxChunks: num(body.max_chunks, story.DEFAULT_MAX_CHUNKS),
    };
  }

  /**
   * 按**留档的分块参数**重新切块（批 8 补 18）。
   * 补抽与体检都要按原样切，块号才有意义；老原著没有留档就退回默认参数
   * （界面从来没提供过自定义分块入口，所以老数据的默认参数是可信的）。
   */
  /**
   * 按解析时那套参数重新切块，并**逐段核对**（批 8 补 26）。
   *
   * `aligned` 的含义从"段数一样"升级成"**每段文本都和解析时一样**"：
   * 追加解析是"先切 A、再切 B"，重切整篇在接缝处必然不同，而**段数可能刚好相同** ——
   * 只比段数会把"切不回原样"当成"切回来了"，于是补抽抽到别的段落、溯源展示错的依据，
   * 两者都不报错。老原著没有逐块指纹时退回段数判据，并用 `verified:false` **如实说明**。
   * @returns {{split:object, aligned:boolean, verified:boolean, mismatched:number[]}}
   */
  function reSplitSource(source) {
    const o = source && source.chunk_opts && typeof source.chunk_opts === 'object' ? source.chunk_opts : {};
    const split = story.splitChunks(source?.text || '', {
      maxChars: num(o.max_chars, story.DEFAULT_MAX_CHARS),
      maxChunks: num(o.max_chunks, story.DEFAULT_MAX_CHUNKS),
    });
    const count = num(source?.chunk_count, 0);
    const stored = Array.isArray(source?.chunk_digests) ? source.chunk_digests : [];
    // 指纹必须**覆盖全部段**才算数：一份残缺的指纹会让"没核对到"的段看起来像"核对过了"
    const verified = stored.length > 0 && stored.length === count;
    const mismatched = story.mismatchedDigests(stored, story.chunkDigests(split.chunks));
    return {
      split, verified, mismatched,
      aligned: verified ? mismatched.length === 0 : split.chunks.length === count,
    };
  }

  /** 取出模板；没有就报错让用户去设置页补（不内置兜底提示词：那会让"可编辑模板"形同虚设） */
  function storyTemplate(key) {
    const t = store.list('prompt_templates', { filter: (r) => r.key === key })[0];
    if (!t) throw httpError(400, `缺少提示词模板「${key}」，请到「设置 → 提示词模板」恢复默认模板`);
    return t;
  }

  /** 调一次文本模型并解析出 JSON（json_mode 请求约束 + 宽松解析兜底） */
  async function storyAsk(tpl, vars, meta) {
    const r = await fetchInternal('POST', '/api/agnes/text', {
      messages: [
        { role: 'system', content: tpl.system || '' },
        { role: 'user', content: story.renderPrompt(tpl.content, vars) },
      ],
      model: meta.model || undefined,
      project_id: meta.project_id || null,
      note: meta.note,
      json_mode: true,
    });
    if (!r || r.ok === false) return { ok: false, error: r?.error || '模型调用失败' };
    const parsed = story.parseJsonLoose(r.content);
    if (parsed == null) return { ok: false, error: '模型没有返回可解析的 JSON（可能是网关降级或输出被截断）' };
    return { ok: true, parsed, content: r.content };
  }

  on('POST', '/api/story/plan', (req, res, params, body) => {
    const text = story.normalizeText(body.text);
    if (!text) throw httpError(400, '请先粘贴或上传故事/小说原文');
    const r = story.splitChunks(text, storyChunkOpts(body));
    return {
      ok: true,
      total_chars: r.total_chars,
      covered_chars: r.covered_chars,
      truncated: r.truncated,
      chunk_count: r.chunks.length,
      // 调用次数 = 每个文本块一次 + 全局归并一次（用户要按这个数确认花费）
      calls: r.chunks.length + 1,
      max_chunks: r.max_chunks,
      chunks: r.chunks.map((c) => ({ index: c.index, chars: c.chars, label: c.label })),
    };
  });

  /**
   * 追加解析（批 8 补 10）：只解析**新增的章节**，并进已有卡片。
   *
   * 为什么必须单独一条：长篇连载是"越写越长"的，整本重解析等于为前面几十万字反复付费，
   * 而且已有卡片会被重建（id 全变 → 分镜绑定全悬空）。这里只做增量：
   * 只对新增文本分块调用模型，已有卡**一张不删、id 不变**，同名的只补字段/并别名/累计出现次数。
   */
  on('POST', '/api/story/append', (req, res, params, body) => {
    const sourceId = str(body.source_id).trim();
    if (!sourceId) throw httpError(400, '请先选择要追加到哪一份原著');
    const source = store.get('story_sources', sourceId);
    if (!source) throw httpError(404, '原著记录不存在（可能已被删除）');
    const projectId = str(body.project_id).trim() || source.project_id;
    if (!store.get('projects', projectId)) throw httpError(404, '项目不存在');
    if (source.project_id !== projectId) throw httpError(400, '这份原著不属于当前项目');
    const text = story.normalizeText(body.text);
    if (!text) throw httpError(400, '请先粘贴新增的章节原文');

    const split = story.splitChunks(text, storyChunkOpts(body));
    if (!split.chunks.length) throw httpError(400, '新增内容里没有可解析的文字');
    // 块号必须接着已有的往后排：否则新卡的 evidence/chunk_index 会和旧章节撞号，
    // "这条是从哪段读出来的"就指向了错误的原文位置
    const offset = num(source.chunk_count, 0);
    const doReduce = body.reduce !== false;
    const existing = store.list('story_cards', { filter: (r) => r.source_id === sourceId && r.origin !== 'bible' });

    const items = split.chunks.map((c) => ({ label: c.label, key: String(c.index), text: c.text, index: c.index }));
    const job = jobs.create('story_append', items.length + (doReduce ? 1 : 0));
    const bucket = [];
    // 逐块结局（批 8 补 18）：并发下顺序不定，所以按块号存，最后统一整理。
    // 有了它，"这段是没信息 / 是模型没接住 / 是调用失败"三者才能分开 —— 此前一律记成"失败"。
    const chunkStates = new Map();
    const recordChunk = (index, o) => {
      chunkStates.set(index, {
        index,
        state: story.classifyChunk(o),
        cards: Math.max(0, Number(o.cardCount) || 0),
        raw_count: Math.max(0, Number(o.rawCount) || 0),
        raw_kinds: Array.isArray(o.rawKinds) ? o.rawKinds.slice(0, 8) : [],
        error: String(o.error || '').slice(0, 300),
      });
    };

    (async () => {
      await jobs.run(job, items, async (item) => {
        const tpl = storyTemplate('novel_extract');
        const r = await storyAsk(tpl, {
          段落序号: item.index + 1,
          段落总数: split.chunks.length,
          原文段落: item.text,
        }, { model: body.model, project_id: projectId, note: `原著追加 ${item.label}` });
        if (!r.ok) {
          recordChunk(item.index + offset, { error: r.error });
          return { ok: false, error: r.error };
        }
        const ex = story.extractCards(r.parsed, {
          source_id: sourceId, project_id: projectId, chunk_index: item.index + offset,
        });
        recordChunk(item.index + offset, { cardCount: ex.cards.length, rawCount: ex.raw_count, rawKinds: ex.raw_kinds });
        if (!ex.cards.length) {
          const st = story.classifyChunk({ cardCount: 0, rawCount: ex.raw_count });
          if (st === 'empty') return { ok: true, id: '0 张（无信息）' };
          return { ok: false, error: st === 'dropped'
            ? `本段抽到 ${ex.raw_count} 条，但类别不认识或名字为空，全被丢弃`
            : '本段没有抽到任何卡片（原文可能无剧情信息，或模型未按格式返回）' };
        }
        bucket.push(...ex.cards);
        return { ok: true, id: `${ex.cards.length} 张` };
      }, {
        concurrency: num(body.concurrency, store.getSettings().default_concurrent_tasks),
        onProgress: (j) => poller.events.emit('batch', j),
      });

      // touched = 本次真的并进了新数据的已有卡（只回写这些，没碰到的卡一个字段都不动）
      const ap = story.mergeAppend(existing, story.mergeCards(bucket).cards);
      for (const c of ap.touched) {
        // 已有卡：只补字段/并别名/累计出现次数 —— id、绑定、created_at 全部保持不动
        const { id, ...fields } = c;
        store.update('story_cards', id, fields);
      }
      if (ap.fresh.length) {
        store.insertMany('story_cards', ap.fresh.map((c) => ({ ...c, origin: 'chunk', source_id: sourceId, project_id: projectId })));
      }
      // 追加只覆盖新增区间：把旧的逐块记录并进来（按块号去重），总块数是接上之后的
      const newStates = story.normalizeChunkStates([...chunkStates.values()], offset + split.chunks.length);
      const chunkStateList = story.normalizeChunkStates(
        [...story.normalizeChunkStates(source.chunk_states, offset + split.chunks.length), ...newStates],
        offset + split.chunks.length,
      );
      const chunkSum = story.summarizeExtraction({ chunkCount: offset + split.chunks.length, chunkStates: chunkStateList });
      const failedChunks = chunkSum.counts.failed + chunkSum.counts.dropped;

      // 全局归并要看**全量**卡片（含前面章节），所以这里传空数组让它自己去库里取
      let reduceRec = null;
      if (doReduce && !job.cancel) {
        reduceRec = jobs.appendItem(job, '全局归并', 'reduce');
        job.status = 'running';
        reduceRec.state = 'running';
        poller.events.emit('batch', job);
        try {
          const bible = await runStoryReduce(source, [], { model: body.model });
          reduceRec.state = 'ok'; reduceRec.ok = true; reduceRec.id = `${bible.count} 张`;
          job.ok++;
        } catch (e) {
          reduceRec.state = 'fail'; reduceRec.ok = false; reduceRec.error = e.message || String(e);
          job.fail++;
        }
        job.done++;
      }

      const total = store.count('story_cards', (r) => r.source_id === sourceId);
      const allFailed = job.ok === 0;
      store.update('story_sources', sourceId, {
        // 原文也要接上：全局归并看开头/结尾、分集骨架看全文，都依赖它
        text: `${str(source.text).trim()}\n\n${text}`,
        chars: num(source.chars, 0) + split.total_chars,
        covered_chars: num(source.covered_chars, 0) + split.covered_chars,
        truncated: !!source.truncated || split.truncated,
        chunk_count: offset + split.chunks.length,
        chunk_opts: { max_chars: num(body.max_chars, story.DEFAULT_MAX_CHARS), max_chunks: num(body.max_chunks, story.DEFAULT_MAX_CHUNKS) },
        // 追加是"先切 A 再切 B"，指纹也按这个事实往后接（重切整篇在接缝处不一样）。
        // 已有指纹不完整（老原著）就**整份都不写**：残缺的指纹比没有更糟 ——
        // 它会让没核对到的段看起来像核对过了（宁可说不知道，也不猜）
        ...(Array.isArray(source.chunk_digests) && source.chunk_digests.length === offset
          ? { chunk_digests: [...source.chunk_digests, ...story.chunkDigests(split.chunks)] } : {}),
        status: allFailed ? 'failed' : 'extracted',
        card_count: total,
        failed_chunks: failedChunks,
        empty_chunks: chunkSum.counts.empty,
        chunk_states: chunkStateList,
        appended_chunks: offset + split.chunks.length,
        protected_cards: ap.protected,
        protected_names: ap.protected_names,
        error_message: allFailed ? '新增章节全部解析失败，请检查 API Key / 模型 / 网络后重试' : '',
        finished_at: now(),
      });
      job.status = job.cancel ? 'cancelled' : 'done';
      job.finished_at = now();
      poller.events.emit('batch', job);
      jobs.prune();
    })().catch((e) => {
      store.update('story_sources', sourceId, {
        status: 'failed', error_message: e.message || String(e), finished_at: now(),
      });
      job.status = 'done';
      poller.events.emit('batch', job);
    });

    return {
      ok: true, source: store.get('story_sources', sourceId), jobId: job.id, total: job.total,
      appended_chunks: split.chunks.length, chunk_offset: offset, existing_cards: existing.length,
      truncated: split.truncated, covered_chars: split.covered_chars, total_chars: split.total_chars,
    };
  });

  on('POST', '/api/story/analyze', (req, res, params, body) => {
    const projectId = str(body.project_id).trim();
    if (!projectId) throw httpError(400, '请先在右上角选择项目：解析出的卡片要挂到项目上才能驱动剧本与资产');
    if (!store.get('projects', projectId)) throw httpError(404, '项目不存在');
    const text = story.normalizeText(body.text);
    if (!text) throw httpError(400, '请先粘贴或上传故事/小说原文');

    const split = story.splitChunks(text, storyChunkOpts(body));
    if (!split.chunks.length) throw httpError(400, '原文里没有可解析的文字');
    const doReduce = body.reduce !== false;
    const source = store.insert('story_sources', {
      project_id: projectId,
      title: str(body.title).trim() || `未命名原著 ${new Date().toLocaleString('zh-CN')}`,
      text,
      chars: split.total_chars,
      covered_chars: split.covered_chars,
      truncated: split.truncated,
      chunk_count: split.chunks.length,
      // 逐块文本指纹（批 8 补 26）：段号只是切块算法的副产物，重切后要**逐段核对**才知道
      // 是不是同一段原文（只比段数会漏掉"段数相同、文本全不同"这种最危险的情况）
      chunk_digests: story.chunkDigests(split.chunks),
      // 分块参数必须留档（批 8 补 18）：补抽/体检要按**同一套参数**重新切块，
      // 否则块号对不上 —— 轻则"补抽"报错，重则把**另一段原文**当成第 N 段重新抽取
      chunk_opts: { max_chars: num(body.max_chars, story.DEFAULT_MAX_CHARS), max_chunks: num(body.max_chunks, story.DEFAULT_MAX_CHUNKS) },
      status: 'analyzing',
      card_count: 0,
      failed_chunks: 0,
      error_message: '',
      model: str(body.model) || null,
      finished_at: null,
    });

    const items = split.chunks.map((c) => ({ label: c.label, key: String(c.index), text: c.text, index: c.index }));
    const job = jobs.create('story_analyze', items.length + (doReduce ? 1 : 0));
    // 累积本 source 的原始卡片（跨块去重前）。并发下顺序不定，最后统一交给纯函数合并。
    const bucket = [];
    // 逐块结局（批 8 补 18）：并发下顺序不定，所以按块号存，最后统一整理。
    // 有了它，"这段是没信息 / 是模型没接住 / 是调用失败"三者才能分开 —— 此前一律记成"失败"。
    const chunkStates = new Map();
    const recordChunk = (index, o) => {
      chunkStates.set(index, {
        index,
        state: story.classifyChunk(o),
        cards: Math.max(0, Number(o.cardCount) || 0),
        raw_count: Math.max(0, Number(o.rawCount) || 0),
        raw_kinds: Array.isArray(o.rawKinds) ? o.rawKinds.slice(0, 8) : [],
        error: String(o.error || '').slice(0, 300),
      });
    };

    (async () => {
      await jobs.run(job, items, async (item) => {
        const tpl = storyTemplate('novel_extract');
        const r = await storyAsk(tpl, {
          段落序号: item.index + 1,
          段落总数: split.chunks.length,
          原文段落: item.text,
        }, { model: body.model, project_id: projectId, note: `原著解析 ${item.label}` });
        if (!r.ok) {
          recordChunk(item.index, { error: r.error });
          return { ok: false, error: r.error };
        }
        const ex = story.extractCards(r.parsed, {
          source_id: source.id, project_id: projectId, chunk_index: item.index,
        });
        recordChunk(item.index, { cardCount: ex.cards.length, rawCount: ex.raw_count, rawKinds: ex.raw_kinds });
        if (!ex.cards.length) {
          // 只有"真失败/真丢数据"才算任务失败：模型明确说这段没信息是**正常结局**，
          // 记成失败会让"部分失败 N 段"常年挂着，用户很快就学会无视它
          const st = story.classifyChunk({ cardCount: 0, rawCount: ex.raw_count });
          if (st === 'empty') return { ok: true, id: '0 张（无信息）' };
          return { ok: false, error: st === 'dropped'
            ? `本段抽到 ${ex.raw_count} 条，但类别不认识或名字为空，全被丢弃`
            : '本段没有抽到任何卡片（原文可能无剧情信息，或模型未按格式返回）' };
        }
        bucket.push(...ex.cards);
        return { ok: true, id: `${ex.cards.length} 张` };
      }, {
        // 并发跑抽取：块与块之间完全独立。默认取设置里的并发上限，
        // 但**不**允许超过它 —— 文本调用同样吃账号配额，批量打满会触发限流。
        concurrency: num(body.concurrency, store.getSettings().default_concurrent_tasks),
        onProgress: (j) => poller.events.emit('batch', j),
      });

      // 块跑完了就先把已抽到的卡片落库：reduce 失败也不至于让用户白烧一遍配额
      const merged = story.mergeCards(bucket);
      let inserted = [];
      if (merged.cards.length) {
        inserted = store.insertMany('story_cards', merged.cards.map((c) => ({
          ...c, origin: 'chunk', source_id: source.id, project_id: projectId,
        })));
      }
      // 口径：failed_chunks = **真的要人来管**的段（失败 + 条目被丢弃），
      // "确认无信息"单独计 —— 把正常结局算成失败，告警就会失去意义
      const chunkStateList = story.normalizeChunkStates([...chunkStates.values()], split.chunks.length);
      const chunkSum = story.summarizeExtraction({ chunkCount: split.chunks.length, chunkStates: chunkStateList });
      const failedChunks = chunkSum.counts.failed + chunkSum.counts.dropped;

      // ── 第二阶段：全局归并（信息卡 + 剧情卡）──
      let reduceRec = null;
      if (doReduce && !job.cancel) {
        reduceRec = jobs.appendItem(job, '全局归并', 'reduce');
        job.status = 'running'; // 队列已结束，但任务整体还没完：进度链必须回到进行中
        reduceRec.state = 'running';
        poller.events.emit('batch', job);
        try {
          const bible = await runStoryReduce(source, merged.cards.length ? inserted : [], { model: body.model });
          reduceRec.state = 'ok'; reduceRec.ok = true; reduceRec.id = `${bible.count} 张`;
          job.ok++;
        } catch (e) {
          reduceRec.state = 'fail'; reduceRec.ok = false; reduceRec.error = e.message || String(e);
          job.fail++;
        }
        job.done++;
      }

      const total = store.count('story_cards', (r) => r.source_id === source.id);
      const allFailed = job.ok === 0;
      store.update('story_sources', source.id, {
        status: allFailed ? 'failed' : 'extracted',
        card_count: total,
        failed_chunks: failedChunks,
        empty_chunks: chunkSum.counts.empty,
        chunk_states: chunkStateList,
        merged_count: merged.merged,
        error_message: allFailed ? '所有文本块都未能抽取成功，请检查 API Key / 模型 / 网络后重试' : '',
        finished_at: now(),
      });
      job.status = job.cancel ? 'cancelled' : 'done';
      job.finished_at = now();
      poller.events.emit('batch', job);
      jobs.prune();
    })().catch((e) => {
      // 兜底：整个异步流程炸了也必须把 source 从 analyzing 里放出来，
      // 否则界面上永远转圈，用户没有任何重试入口
      store.update('story_sources', source.id, {
        status: 'failed', error_message: e.message || String(e), finished_at: now(),
      });
      job.status = 'done';
      poller.events.emit('batch', job);
    });

    return {
      ok: true, source, jobId: job.id, total: job.total,
      chunk_count: split.chunks.length, truncated: split.truncated,
      covered_chars: split.covered_chars, total_chars: split.total_chars,
    };
  });

  /**
   * 全局归并：把已抽取的卡片清单归纳成信息卡 + 剧情卡。
   * 单独抽成函数，是因为它有两个入口 —— analyze 流程末尾自动跑一次，
   * 以及用户改完卡片后点「重新归并」单独重跑（改一张人物卡就重烧整本抽取太亏）。
   */
  async function runStoryReduce(source, cards, opts = {}) {
    const list = Array.isArray(cards) && cards.length
      ? cards
      : store.list('story_cards', { filter: (r) => r.source_id === source.id && r.origin !== 'bible' });
    if (!list.length) throw new Error('还没有可归并的卡片，请先完成一次抽取');
    const tpl = storyTemplate('story_bible');
    const text = story.normalizeText(source.text || '');
    const r = await storyAsk(tpl, {
      卡片清单: story.digestCards(list),
      开头: text.slice(0, 800),
      结尾: text.slice(-800),
    }, { model: opts.model, project_id: source.project_id, note: '原著解析 · 全局归并' });
    if (!r.ok) throw new Error(r.error);

    const payload = r.parsed || {};
    const rows = [];
    const world = payload.world || payload.info || null;
    if (world && typeof world === 'object') {
      const c = story.normalizeCard({ ...world, kind: 'world' }, { source_id: source.id, project_id: source.project_id });
      if (c) rows.push({ ...c, origin: 'bible' });
    }
    const plots = Array.isArray(payload.plots) ? payload.plots : (Array.isArray(payload.plot) ? payload.plot : []);
    plots.forEach((p, i) => {
      const c = story.normalizeCard({ ...(p && typeof p === 'object' ? p : { name: String(p) }), kind: 'plot' },
        { source_id: source.id, project_id: source.project_id, chunk_index: null, order: i });
      if (c) rows.push({ ...c, origin: 'bible' });
    });
    if (!rows.length) throw new Error('归并结果里没有可用的信息卡或剧情卡（模型未按格式返回）');
    // 重跑归并必须替换而不是叠加（否则每点一次"重新归并"就多一份信息卡），
    // 但**不能靠删了重建**：那样每次归并都换一批 id，分镜绑定与界面状态会指向不存在的卡。
    // 按 kind+名字就地更新，只删这次结果里真的没有的。
    const oldBible = store.list('story_cards', { filter: (r2) => r2.source_id === source.id && r2.origin === 'bible' });
    const plan = story.applyBibleCards(oldBible, rows);
    for (const c of plan.update) {
      const { id, ...fields } = c;
      store.update('story_cards', id, fields);
    }
    if (plan.insert.length) {
      store.insertMany('story_cards', plan.insert.map((c) => ({ ...c, origin: 'bible', source_id: source.id, project_id: source.project_id })));
    }
    if (plan.remove.length) store.removeWhere('story_cards', (r2) => plan.remove.some((x) => x.id === r2.id));
    // 用户改过的卡这次有没有被保住，必须留痕：改过的卡"没被覆盖"和"被覆盖了却看不出来"
    // 在界面上长得一模一样（批 8 补 25）
    store.update('story_sources', source.id, { protected_cards: plan.protected, protected_names: plan.protected_names });
    return { count: rows.length, world: rows.filter((x) => x.kind === 'world').length, plots: rows.filter((x) => x.kind === 'plot').length };
  }

  on('POST', '/api/story/reduce', async (req, res, params, body) => {
    const source = store.get('story_sources', str(body.source_id));
    if (!source) throw httpError(404, '原著不存在');
    const r = await runStoryReduce(source, null, { model: body.model });
    store.update('story_sources', source.id, {
      card_count: store.count('story_cards', (x) => x.source_id === source.id),
    });
    return { ok: true, ...r };
  });

  // ── 原文（故事来源）──
  on('GET', '/api/story/sources', (req, res, params, body, query) => {
    const projectId = query.project_id;
    // 列表不带全文：一本 7 万字的原著在列表里回传 24 次纯属浪费带宽
    return store.list('story_sources', {
      filter: (r) => (projectId ? r.project_id === projectId : true),
    }).map(({ text, ...rest }) => ({ ...rest, preview: String(text || '').slice(0, 120) }));
  });

  on('GET', '/api/story/sources/:id', (req, res, params) => {
    const s = store.get('story_sources', params.id);
    if (!s) throw httpError(404, '原著不存在');
    return s;
  });

  on('DELETE', '/api/story/sources/:id', (req, res, params) => {
    const s = store.get('story_sources', params.id);
    if (!s) throw httpError(404, '原著不存在');
    // 级联删卡片：留着就是"指不到原文的孤儿卡"，用户再也无法核对模型抽得对不对
    const cards = store.removeWhere('story_cards', (r) => r.source_id === params.id);
    store.remove('story_sources', params.id);
    return { ok: true, removed_cards: cards };
  });

  // ── 卡片 ──
  on('GET', '/api/story/cards', (req, res, params, body, query) => {
    const { project_id: projectId, source_id: sourceId, kind } = query;
    return story.sortCards(store.list('story_cards', {
      filter: (r) => (projectId ? r.project_id === projectId : true)
        && (sourceId ? r.source_id === sourceId : true)
        && (kind ? r.kind === kind : true),
    }));
  });

  /** 卡片 → 提示词文本（反向驱动的取用口）。渲染只在服务端做一份，前端不重复实现。 */
  on('GET', '/api/story/cards/prompt', (req, res, params, body, query) => {
    const kinds = str(query.kinds).split(',').map((k) => k.trim()).filter(Boolean);
    const cards = store.list('story_cards', {
      filter: (r) => (query.source_id ? r.source_id === query.source_id : true)
        && (query.project_id ? r.project_id === query.project_id : true),
    });
    const picked = kinds.length ? cards.filter((c) => kinds.includes(c.kind)) : cards;
    return {
      ok: true,
      count: picked.length,
      kinds: kinds.length ? kinds : story.CARD_KINDS,
      text: story.cardsToPrompt(picked, kinds.length ? kinds : story.CARD_KINDS),
    };
  });

  /**
   * 分集大纲骨架（批 8 补 4）：剧情卡 → 拍子 → 集。
   * 与 /api/story/audit 同一条纪律：**纯本地判定，一次模型都不调**（切集是可判定的，不是创作判断），
   * 所以用户可以反复调「每集至少几拍」直到满意，不花钱。写剧本那一步才走生成（有计费闸门）。
   */
  on('GET', '/api/story/episodes', (req, res, params, body, query) => {
    const projectId = str(query.project_id).trim();
    const sourceId = str(query.source_id).trim();
    const cards = store.list('story_cards', {
      filter: (r) => (projectId ? r.project_id === projectId : true) && (sourceId ? r.source_id === sourceId : true),
      limit: 100000,
    });
    const per = num(query.per_episode, story.EPISODE_PER_DEFAULT);
    const plan = story.planEpisodes(cards, { perEpisode: per });
    return {
      ok: true,
      basis: plan.basis,
      per_episode: plan.per_episode,
      hard_limit: plan.hard_limit,
      episode_count: plan.episodes.length,
      beat_count: plan.beat_count,
      stage_covered: plan.stage_covered,
      forced_cuts: plan.forced_cuts,
      timeline_count: plan.timeline_count,
      world_count: plan.world_count,
      episodes: plan.episodes,
      notes: plan.notes,
      text: story.episodeOutlineText(cards, plan),
    };
  });

  /**
   * 抽取覆盖体检（批 8 补 18）：**纯本地、一次模型都不调**（与体检/分集/过期判定同一条纪律）。
   *
   * 分块抽取跑几十段，模型对每段的回答有四种含义完全不同的结局，此前被压成同一个"失败"：
   * 模型明确说"这段没信息"是**正常**的，而"模型返回了条目却被我们丢掉"才是真丢数据 ——
   * 两者在界面上长得一模一样。这个端点把它们分开，并给出"哪几段值得补抽"。
   */
  on('GET', '/api/story/coverage', (req, res, params, body, query) => {
    const sourceId = str(query.source_id).trim();
    if (!sourceId) throw httpError(400, '请指定要体检的原著（source_id）');
    const source = store.get('story_sources', sourceId);
    if (!source) throw httpError(404, '原著不存在');
    const cards = store.list('story_cards', { filter: (r) => r.source_id === sourceId, limit: 100000 });
    const chunkCount = num(source.chunk_count, 0);
    const covered = story.chunkIndexesFromCards(cards);
    const sum = story.summarizeExtraction({
      chunkCount,
      chunkStates: source.chunk_states,
      coveredIndexes: covered,
    });
    // 给每段配一小段原文预览：用户要能**看着原文**决定这段是不是真没信息，
    // 只给"第 7 段"等于让他自己去数
    const { split: chunks, aligned, verified, mismatched } = reSplitSource(source);
    const rows = sum.states.map((r) => {
      const c = chunks.chunks[r.index];
      return {
        ...r,
        label: c ? c.label : `第 ${r.index + 1} 段`,
        chars: c ? c.text.length : 0,
        preview: c ? c.text.slice(0, 120) : '',
        state_label: story.chunkStateLabel(r.state),
        needs_retry: story.chunkNeedsRetry(r.state) || r.state === 'pending',
      };
    });
    return {
      ok: true,
      source_id: source.id,
      title: source.title,
      chunk_count: chunkCount,
      card_count: cards.length,
      has_states: sum.has_states,
      counts: sum.counts,
      chunks: rows,
      needs_retry: sum.needs_retry,
      note: story.extractionNote(sum),
      // 老原著（本轮之前解析的）没有逐块记录，只能说"这些段没有卡片" —— 不能替模型回答"没信息"
      legacy: !sum.has_states,
      // 重新切块切不出原样：预览可能对不上原文，**如实说**，别让用户看着错位的预览做判断
      aligned,
      // verified = 存了逐块指纹、且**逐段核对过**（批 8 补 26）。
      // false 表示只按段数核对 —— 界面不能把"段数一样"说成"核对过了"
      verified,
      mismatched_chunks: mismatched.map((i) => i + 1),
      notes: [
        ...(sum.has_states ? [] : ['这份原著是本轮之前解析的，没有逐块记录：只能看出"哪些段没有卡片"，不能判断是没信息还是漏了']),
        ...(aligned ? [] : [verified
          ? `第 ${mismatched.slice(0, 5).map((i) => i + 1).join('、')} 段的原文与解析时不一致（重新切块得到 ${chunks.chunks.length} 段，解析时是 ${chunkCount} 段），预览仅供参考，补抽会被拒绝`
          : `重新切块得到 ${chunks.chunks.length} 段，与解析时的 ${chunkCount} 段不一致，预览仅供参考`]),
        ...(!verified && aligned ? ['这份原著没有逐块指纹（本轮之前解析的），只能按段数核对 —— 不能保证每段与解析时是同一段原文'] : []),
      ],
    };
  });

  /**
   * 补抽指定段落（批 8 补 18）：**真的会调模型**，所以照例先算钱再动手。
   *
   * 只补不删：结果走 `mergeAppend`（同名卡只补字段/并别名/累计次数，id 不变），
   * 所以"补抽"不会让分镜绑定悬空。**"不会把用户改好的卡片冲掉"这句原先只是写在注释里**：
   * 合并规则是"更详细的描述取胜"，用户改过的短描述照样会被模型的长描述覆盖
   * （批 8 补 25 才让 `edited` 真正生效 —— 注释里的承诺必须由代码兑现）。
   */
  on('POST', '/api/story/retry-chunks', (req, res, params, body) => {
    const sourceId = str(body.source_id).trim();
    if (!sourceId) throw httpError(400, '请指定要补抽的原著（source_id）');
    const source = store.get('story_sources', sourceId);
    if (!source) throw httpError(404, '原著不存在');
    const projectId = source.project_id;

    const { split: all, aligned, verified, mismatched } = reSplitSource(source);
    if (!all.chunks.length) throw httpError(400, '这份原著里没有可解析的文字');
    // 切不回原样就**不要动手**（批 8 补 26：从"比段数"改成"**逐段比文本**"）。
    // 为什么必须先查这一步、而不是等算完"该补哪几段"再说：段号一旦对不上，
    // **"该补哪几段"这个结论本身就不可信**（它靠 chunk_states 与卡片的 evidence 段号算出来）。
    // 段数一样不等于切出来的是同一段原文（追加解析的接缝处就是这样），硬跑会把别的段落
    // 当成第 N 段重抽 —— 用户看到"补抽成功"却得到一堆指向错误原文的卡片。
    // 老原著没有逐块指纹时退回段数判据（`verified:false`），并在返回体里如实说明。
    if (!aligned) {
      if (verified) {
        const list = mismatched.slice(0, 5).map((i) => `第 ${i + 1} 段`).join('、');
        throw httpError(400, `${list}的原文与解析时不一致${mismatched.length > 5 ? `（共 ${mismatched.length} 段）` : ''}，无法安全补抽：按段号重抽会抽到**别的段落**，卡片会指向错误的原文（请对这份原著重新解析）`);
      }
      throw httpError(400, `这份原著重新切块得到 ${all.chunks.length} 段，与解析时的 ${num(source.chunk_count, 0)} 段不一致，无法安全补抽（请对这份原著重新解析）`);
    }
    // 默认补抽"该管的段"（失败 / 条目被丢弃 / 没跑完）；显式给 index 则以它为准
    let want = Array.isArray(body.indexes) ? body.indexes.map((i) => Number(i)) : null;
    if (!want) {
      const sum = story.summarizeExtraction({
        chunkCount: num(source.chunk_count, all.chunks.length),
        chunkStates: source.chunk_states,
        coveredIndexes: story.chunkIndexesFromCards(store.list('story_cards', { filter: (r) => r.source_id === sourceId, limit: 100000 })),
      });
      want = sum.needs_retry;
    }
    const indexes = [...new Set(want)]
      .filter((i) => Number.isInteger(i) && i >= 0 && i < all.chunks.length)
      .sort((a, b) => a - b);
    if (!indexes.length) throw httpError(400, '没有需要补抽的段落：所有段落都已抽取或已确认无信息');

    const items = indexes.map((i) => ({ label: all.chunks[i].label, key: String(i), text: all.chunks[i].text, index: i }));
    const job = jobs.create('story_retry_chunks', items.length);
    const bucket = [];
    const chunkStates = new Map();
    const recordChunk = (index, o) => {
      chunkStates.set(index, {
        index,
        state: story.classifyChunk(o),
        cards: Math.max(0, Number(o.cardCount) || 0),
        raw_count: Math.max(0, Number(o.rawCount) || 0),
        raw_kinds: Array.isArray(o.rawKinds) ? o.rawKinds.slice(0, 8) : [],
        error: String(o.error || '').slice(0, 300),
      });
    };

    (async () => {
      await jobs.run(job, items, async (item) => {
        const tpl = storyTemplate('novel_extract');
        const r = await storyAsk(tpl, {
          段落序号: item.index + 1,
          段落总数: all.chunks.length,
          原文段落: item.text,
        }, { model: body.model, project_id: projectId, note: `原著补抽 ${item.label}` });
        if (!r.ok) {
          recordChunk(item.index, { error: r.error });
          return { ok: false, error: r.error };
        }
        const ex = story.extractCards(r.parsed, { source_id: sourceId, project_id: projectId, chunk_index: item.index });
        recordChunk(item.index, { cardCount: ex.cards.length, rawCount: ex.raw_count, rawKinds: ex.raw_kinds });
        if (!ex.cards.length) {
          const st = story.classifyChunk({ cardCount: 0, rawCount: ex.raw_count });
          if (st === 'empty') return { ok: true, id: '0 张（无信息）' };
          return { ok: false, error: st === 'dropped'
            ? `本段抽到 ${ex.raw_count} 条，但类别不认识或名字为空，全被丢弃`
            : '本段没有抽到任何卡片（原文可能无剧情信息，或模型未按格式返回）' };
        }
        bucket.push(...ex.cards);
        return { ok: true, id: `${ex.cards.length} 张` };
      }, {
        concurrency: num(body.concurrency, store.getSettings().default_concurrent_tasks),
        onProgress: (j) => poller.events.emit('batch', j),
      });

      const existing = store.list('story_cards', { filter: (r) => r.source_id === sourceId && r.origin !== 'bible' });
      const ap = story.mergeAppend(existing, story.mergeCards(bucket).cards);
      for (const c of ap.touched) {
        const { id, ...fields } = c;
        store.update('story_cards', id, fields);
      }
      if (ap.fresh.length) {
        store.insertMany('story_cards', ap.fresh.map((c) => ({ ...c, origin: 'chunk', source_id: sourceId, project_id: projectId })));
      }

      const total = num(source.chunk_count, all.chunks.length);
      const merged = story.normalizeChunkStates(
        [...story.normalizeChunkStates(source.chunk_states, total), ...story.normalizeChunkStates([...chunkStates.values()], total)],
        total,
      );
      const sum = story.summarizeExtraction({ chunkCount: total, chunkStates: merged });
      const cardTotal = store.count('story_cards', (r) => r.source_id === sourceId);
      store.update('story_sources', sourceId, {
        chunk_states: merged,
        protected_cards: ap.protected,
        protected_names: ap.protected_names,
        failed_chunks: sum.counts.failed + sum.counts.dropped,
        empty_chunks: sum.counts.empty,
        card_count: cardTotal,
      });
      job.status = job.cancel ? 'cancelled' : 'done';
      job.finished_at = now();
      poller.events.emit('batch', job);
      jobs.prune();
    })().catch((e) => {
      // 补抽的收尾炸了不能静默：挂一条失败项，用户才看得到"补抽没成"（否则进度条默默走完）
      const rec = jobs.appendItem(job, '补抽收尾失败', 'error');
      rec.state = 'fail'; rec.ok = false; rec.error = e.message || String(e);
      job.fail++;
      job.done++;
      job.status = 'done';
      job.finished_at = now();
      poller.events.emit('batch', job);
    });

    return {
      ok: true,
      jobId: job.id,
      count: indexes.length,
      indexes,
      // 逐段核对过（true）还是只按段数核对（false，老原著没指纹）—— 界面要如实说
      verified,
      retried: indexes.length,
      // 补抽是**花钱**的动作：把要跑的段号与次数如实带回去，界面不必自己算
      labels: items.map((i) => i.label),
      note: `补抽 ${indexes.length} 段（只补不删：已有卡片只补字段、id 不变）`,
    };
  });

  /**
   * 单集拍表 + 前情提要（批 8 补 8）。
   * 逐集生成剧本时，"本集大纲"和"前情"都从**本地**分集骨架里取 —— 又是一次模型都不调，
   * 所以逐集重生成、反复调「每集至少几拍」都不花钱。
   */
  /**
   * 卡片溯源（批 8 补 20）：把"证据段 3"变成**能直接读的原文片段**（命中处标出来）。
   *
   * 纯本地（重新切块 + 文本匹配），一次模型都不调 —— 与体检/覆盖/分集同一条纪律。
   * 为什么值得做：卡片是整条链的地基，用户想核对"这张卡说得对吗"时如果只能自己回原文里数段，
   * 结果就是要么盲信（错卡一路传到剧本/分镜）要么重读整本。
   */
  on('GET', '/api/story/card-source', (req, res, params, body, query) => {
    const cardId = str(query.card_id).trim();
    if (!cardId) return { ok: false, error: '缺少 card_id' };
    const card = store.get('story_cards', cardId);
    if (!card) return { ok: false, error: '卡片不存在' };
    const terms = [card.name, ...(Array.isArray(card.aliases) ? card.aliases : [])].filter(Boolean);
    const base = {
      ok: true, card_id: card.id, name: str(card.name), kind: card.kind,
      origin: card.origin || 'chunk', terms,
      verified: false, // 下面拿到 source 后按逐块指纹覆盖（批 8 补 26）
    };
    const source = card.source_id ? store.get('story_sources', card.source_id) : null;
    if (!source) {
      return {
        ...base, excerpts: [], aligned: true, verified: false,
        notes: [card.origin === 'bible'
          ? '这张卡来自全局归并（多段合并而来），没有单一出处；下面的段号是它出现过的段落'
          : '这张卡没有关联的原著（可能是人工新建或原著已删除）'],
      };
    }
    const { split, aligned, verified, mismatched } = reSplitSource(source);
    const idx = story.chunkIndexesFromCards([card]);
    const notes = [];
    if (!idx.length) notes.push('这张卡没有记录证据段号，无法定位到原文');
    // 逐段核对（批 8 补 26）：只比段数会漏掉"段数相同、文本全不同"——那时会把**错的段落**
    // 当成这张卡的原文依据摆出来，让一张正确的卡显得可疑（溯源的全部价值就在这里，不能骗人）
    const badIdx = idx.filter((i) => verified && mismatched.includes(i));
    if (!aligned) notes.push('这份原著重新切块得到的段落与解析时不一致，下面的原文可能对不上这张卡（建议对这份原著重新解析）');
    else if (badIdx.length) notes.push(`第 ${badIdx.slice(0, 5).map((i) => i + 1).join('、')} 段的原文与解析时不一致，下面的原文可能对不上这张卡（建议对这份原著重新解析）`);
    // 出处优先说"第几章"：段号是切块算法的副产物，作者想的是章节（批 8 补 21）
    const det = story.detectChapters(source.text);
    const asg = story.assignChapters(split.chunks, det.chapters);
    const excerpts = idx.slice(0, 4).map((i) => {
      // 注意：split.chunks 的元素是对象（`{text, ...}`），不是字符串 —— 直接当字符串用会得到 "[object Object]"
      const text = str((split.chunks[i] || {}).text);
      const ex = story.excerptAround(text, terms, { radius: 400 });
      const ch = asg.by_chunk[i] || {};
      return {
        index: i,
        chapter: ch.chapter ?? -1,
        chapter_title: ch.title || '',
        spans_chapters: ch.spans || 0,
        label: `第 ${i + 1}/${split.chunks.length} 段`,
        chars: text.length,
        hits: ex.hits,
        truncated: ex.truncated,
        segments: ex.segments,
      };
    });
    return {
      ...base, source_id: source.id, source_title: str(source.title),
      chunk_count: split.chunks.length, excerpts, aligned, verified,
      mismatched_chunks: mismatched.map((i) => i + 1), notes,
    };
  });

  /**
   * 章节目录（批 8 补 21）：把"第 34 段"翻译成"第 12 章"，并回答"哪几章什么都没抽到"。
   *
   * 纯本地（重新切块 + 标题识别 + 文本匹配），一次模型都不调 —— 与体检/覆盖/溯源同一条纪律。
   * **不动切块算法**：章节只是给已有的块贴标签，所以补 18 的补抽对齐性完全不受影响。
   */
  on('GET', '/api/story/chapters', (req, res, params, body, query) => {
    const source = store.get('story_sources', str(query.source_id).trim());
    if (!source) throw httpError(404, '原著不存在');
    const { split, aligned, verified, mismatched } = reSplitSource(source);
    const det = story.detectChapters(source.text);
    const asg = story.assignChapters(split.chunks, det.chapters);
    const states = Array.isArray(source.chunk_states) ? source.chunk_states : [];
    const stateOf = (i) => (states.find((x) => Number(x.index) === i) || {}).state || 'pending';
    const cards = store.list('story_cards', { filter: (r) => r.source_id === source.id, limit: 100000 });
    // 卡片按**出现过的章**归类：一张卡跨两章就算在两章里（"这章有没有内容"问的是出现，不是归属）。
    // 直接存 id 列表、张数由列表长度得出 —— 两个口径分开算迟早会分叉（界面上"3 张卡"却只列出 2 张）。
    const cardIdsOf = new Map();
    for (const c of cards) {
      const idxs = story.chunkIndexesFromCards([c]);
      const seen = new Set();
      for (const i of idxs) {
        const ch = (asg.by_chunk[i] || {}).chapter;
        if (ch < 0 || seen.has(ch)) continue;
        seen.add(ch);
        if (!cardIdsOf.has(ch)) cardIdsOf.set(ch, []);
        cardIdsOf.get(ch).push(c.id);
      }
    }
    // 逐块结局按"**这块涉及了哪些章**"记：一块横跨两章时两章都记一次。
    // 曾经改成"只记主导章"以避免重复计数 —— 结果是**问题报在了错的章上**：
    // 标记落在第二章的那一段，因为块的主导章是第一章，用户去第一章什么也找不到。
    // "定位问题"和"给卡片贴出处"是两个问题：出处要唯一（用 by_chunk 的主导章），
    // 问题要能定位（凡涉及的章都要报）。所以这里用 c.chunks，不重复计数这件事由界面口径负责（不跨章求和）。
    // 章的原文开头：从**这一章标题在块里的位置**截，而不是从块的开头截
    // （一章从块中间开始时，块开头是上一章的正文 —— 点开第二章看到第一章的文字）
    const previewOf = (c) => {
      for (const i of c.chunks) {
        const st = ((asg.by_chunk[i] || {}).starts || []).find((x) => x.chapter === c.chapter);
        if (st) return str((split.chunks[i] || {}).text).slice(st.at, st.at + 120);
      }
      return str((split.chunks[c.chunks[0]] || {}).text).slice(0, 120);
    };
    const chapters = asg.by_chapter.map((c) => {
      const tally = { ok: 0, empty: 0, dropped: 0, failed: 0, pending: 0 };
      for (const i of c.chunks) tally[stateOf(i)] = (tally[stateOf(i)] || 0) + 1;
      const ids = cardIdsOf.get(c.chapter) || [];
      return {
        chapter: c.chapter, title: c.title, chars: c.chars,
        chunks: c.chunks, first_chunk: c.chunks[0] ?? null, chunk_count: c.chunk_count,
        // 这一章抽到的卡片 id（界面据此就地列出"抽到了什么"）与原文开头（先看一眼是不是这一章）
        card_ids: ids, card_count: ids.length,
        preview: previewOf(c),
        // 只有"真丢数据"（dropped/failed）才算问题；模型说"这段没信息"是正常结局（对照补 18）
        dropped: tally.dropped, failed: tally.failed, empty: tally.empty,
        has_cards: ids.length > 0,
      };
    });
    return {
      ok: true, source_id: source.id, title: str(source.title),
      found: det.found, skipped: det.skipped, truncated: det.truncated,
      chunk_count: split.chunks.length, aligned, chapters,
      with_cards: chapters.filter((c) => c.has_cards).length,
      // 一章都没识别出来时如实说明（不是所有原文都分章）—— 界面据此退回"按段"的说法
      note: det.chapters.length ? '' : '这份原文没有识别到章节标题（不是所有文本都分章），下面的出处仍按"段"显示',
    };
  });

  on('GET', '/api/story/episode-brief', (req, res, params, body, query) => {
    const projectId = str(query.project_id).trim();
    const sourceId = str(query.source_id).trim();
    const cards = store.list('story_cards', {
      filter: (r) => (projectId ? r.project_id === projectId : true) && (sourceId ? r.source_id === sourceId : true),
      limit: 100000,
    });
    const plan = story.planEpisodes(cards, { perEpisode: num(query.per_episode, story.EPISODE_PER_DEFAULT) });
    const ep = Math.max(1, num(query.episode, 1));
    const brief = story.episodeBriefText(plan, ep);
    const prior = story.priorBrief(plan, ep, { maxChars: num(query.prior_max, story.PRIOR_MAX_DEFAULT) });
    const withPrior = query.with_prior !== '0';
    return {
      ok: true,
      episode_number: ep,
      // 批 8 补 12：生成这一集时"喂给模型的输入"的指纹。前端存剧本时原样带上 ——
      // 指纹算法只在这里实现一份（前端复算一遍迟早会跟服务端漂移）
      input_digest: story.episodeInputDigest(plan, ep, { withPrior, priorMax: num(query.prior_max, story.PRIOR_MAX_DEFAULT) }),
      prior_chars: prior.chars,
      episode_count: plan.episodes.length,
      per_episode: plan.per_episode,
      exists: !!brief,
      brief,
      prior: prior.text,
      prior_episodes: prior.episodes,
      prior_omitted: prior.omitted,
      prior_chars: prior.chars,
      prior_truncated: prior.truncated,
      notes: brief ? [] : ['这一集还没有拍：先解析出剧情卡，再确认分集骨架'],
    };
  });

  /**
   * 剧本 / 分镜的过期体检（批 8 补 12）：**纯本地判定，一次模型都不调**。
   * 与体检/分集同一条纪律 —— "该不该重生成"要能反复看，每次看都花钱的工具没人会用。
   */
  /**
   * 全链路进度（批 8 补 16）：七段链路各自在**不同的页面**上，用户想知道"卡在哪一步、下一步点哪儿"
   * 必须自己拼。这里一次给全 —— 纯本地统计，**一次模型都不调**（与体检/分集/过期判定同一条纪律）。
   */
  on('GET', '/api/story/pipeline', (req, res, params, body, query) => {
    const projectId = str(query.project_id);
    if (!projectId) throw httpError(400, '需要 project_id');
    const sources = store.list('story_sources', { filter: (r) => r.project_id === projectId, limit: 100000 });
    const cards = store.list('story_cards', { filter: (r) => r.project_id === projectId, limit: 100000 });
    const scripts = store.list('scripts', { filter: (r) => r.project_id === projectId, limit: 100000 })
      .filter((r) => r.script_type === 'episode_script' && Number(r.episode_number) > 0);
    // 剧本按**集**去重（同一集重生成过会存多条）—— 统计"有几集写好了"，不是"存了几条"
    const epSet = new Set(scripts.map((r) => Number(r.episode_number)));
    const shots = store.list('storyboards', { filter: (r) => r.project_id === projectId, limit: 100000 });
    const withImage = shots.filter((r) => r.linked_image_id).length;
    const withVideo = shots.filter((r) => r.linked_video_id).length;
    const plan = story.planEpisodes(cards, { perEpisode: num(query.per_episode, story.EPISODE_PER_DEFAULT) });
    return {
      ok: true,
      ...story.pipelineOverview({
        sources: sources.length,
        cards: cards.length,
        plotCards: cards.filter((c) => c.kind === 'plot').length,
        episodes: plan.episodes.length,
        scripts: epSet.size,
        shots: shots.length,
        images: withImage,
        videos: withVideo,
      }),
    };
  });

  on('GET', '/api/story/staleness', (req, res, params, body, query) => {
    const projectId = str(query.project_id).trim();
    const sourceId = str(query.source_id).trim();
    const cards = store.list('story_cards', {
      filter: (r) => (projectId ? r.project_id === projectId : true) && (sourceId ? r.source_id === sourceId : true),
      limit: 100000,
    });
    const plan = story.planEpisodes(cards, { perEpisode: num(query.per_episode, story.EPISODE_PER_DEFAULT) });
    const scripts = store.list('scripts', { filter: (r) => (projectId ? r.project_id === projectId : true), limit: 100000 });
    const shots = store.list('storyboards', { filter: (r) => (projectId ? r.project_id === projectId : true), limit: 100000 });
    const r = story.auditStaleness(plan, scripts, shots, {
      withPrior: query.with_prior !== '0',
      priorMax: num(query.prior_max, story.PRIOR_MAX_DEFAULT),
    });
    return {
      ok: true,
      episode_count: plan.episodes.length, per_episode: plan.per_episode,
      scripts_scanned: scripts.length, shots_scanned: shots.length,
      counts: r.counts, episodes: r.episodes, notes: r.notes,
    };
  });

  // 白名单**从 story.js 推导**（批 8 补 30）：这里原本是手抄的一份字段清单，必须与 CARD_FIELDS 逐字一致，
  // 漏一个字段的后果是"界面上能填、保存后静默丢失"，而且只在那一个字段上悄悄发生。
  // 推导之后这类漂移在结构上不可能发生（selftest 有钉）。
  const STORY_CARD_EDITABLE = [
    ...story.CARD_EDITABLE_FIELDS,
    // 用户挂上去的参考图（批 8 补 17）：地点卡/道具卡的"同一个场景每张图都不一样"就靠它收敛。
    // 它**不在** CARD_FIELDS 里（不是模型抽的字段），所以由这里单独加
    'reference_image_ids',
  ];

  on('PUT', '/api/story/cards/:id', (req, res, params, body) => {
    const card = store.get('story_cards', params.id);
    if (!card) throw httpError(404, '卡片不存在');
    // 白名单：kind/source_id/origin 是**来源事实**，不允许被改写
    // （改了 kind 会让同一张卡在不同视图里出现两次；改了 source_id 就断了溯源）
    const patch = {};
    for (const k of STORY_CARD_EDITABLE) if (k in body) patch[k] = body[k];
    // 别名走归一化（去重 + 去掉自己）。变更须知：判"自己"必须用**本次提交后的名字**
    // （patch.name 优先），否则同一个请求里改名 + 加别名时，旧名字会被当成别名留下。
    if ('aliases' in patch && !Array.isArray(patch.aliases)) {
      patch.aliases = story.normalizeCard({ kind: card.kind, name: patch.name || card.name, aliases: patch.aliases }, {}).aliases;
    }
    if ('name' in patch && !str(patch.name).trim()) throw httpError(400, '卡片名称不能为空');
    // 参考图 id 必须清洗后再落库（去空/去重/限量）：脏 id 会让出图时静默少带几张参考图
    if ('reference_image_ids' in patch) patch.reference_image_ids = story.normalizeRefIds(patch.reference_image_ids);
    // 手改也要过**同一把尺子**（批 8 补 30）。以前只有 name/summary/aliases 走了归一化，
    // 其余字段把用户提交的原文**直接落库** —— 于是同一个字段"模型写有上限（FIELD_MAX）、人写没上限"：
    // appearance/outfit/地点道具字段都会进每一次出图提示词，一个几万字的字段能把整条链撑爆。
    // 只截断、**不丢空**：空串照写。这是关键 —— 走 normalizeCard 的话空值会被它丢掉（`if (val)`），
    // 而 store.update 是合并语义，键不在 patch 里就保留旧值，那样**用户就再也清不掉一个字段**。
    const truncated = [];
    for (const k of STORY_CARD_EDITABLE) {
      if (!(k in patch) || k === 'aliases' || k === 'reference_image_ids') continue; // 数组各有自己的归一化
      const rawStr = String(patch[k] == null ? '' : patch[k]).trim();
      const clipped = story.clipField(patch[k], k);
      if (clipped.length < rawStr.length) truncated.push(k);
      patch[k] = clipped;
    }
    const next = story.normalizeCard({ ...card, ...patch }, {});
    if (!next) throw httpError(400, '卡片内容不合法（类型或名称缺失）');
    const merged = store.update('story_cards', params.id, {
      ...patch,
      name: next.name,
      summary: next.summary,
      aliases: next.aliases,
      edited: true, // 留痕：让界面能区分"模型抽的"与"用户改过的"
    });
    // 截断了哪些字段要**如实上报**：静默少一截文字，用户只会以为"我明明写了的"
    // （正常从界面走不会触发 —— 输入框带了 maxlength；这里是给接口调用方与将来新增字段兜底）
    return truncated.length ? { ...merged, truncated } : merged;
  });

  on('DELETE', '/api/story/cards/:id', (req, res, params) => {
    if (!store.get('story_cards', params.id)) throw httpError(404, '卡片不存在');
    store.remove('story_cards', params.id);
    return { ok: true };
  });

  /** 人物卡 → 资产库（角色档案）。反向驱动的第一站：抽出来的人物必须能直接变成有参考图的角色。 */
  on('POST', '/api/story/cards/:id/to-character', (req, res, params, body) => {
    const card = store.get('story_cards', params.id);
    if (!card) throw httpError(404, '卡片不存在');
    if (card.kind !== 'character') throw httpError(400, '只有人物卡可以导入资产库');
    const projectId = str(body.project_id || card.project_id).trim();
    if (!projectId) throw httpError(400, '缺少 project_id');
    // 幂等：同一张卡重复导入必须返回已有角色，否则用户点两下就有两个"林晚"
    const dup = store.list('characters', { filter: (r) => r.story_card_id === card.id })[0];
    if (dup) return { ok: true, character: dup, deduped: true };
    const character = store.insert('characters', story.cardToCharacter({ ...card, project_id: projectId }, projectId));
    return { ok: true, character, deduped: false };
  });

  /** 批量：一次把选中的（或全部）人物卡导入资产库，返回逐条结果 */
  on('POST', '/api/story/cards/import-characters', (req, res, params, body) => {
    const projectId = str(body.project_id).trim();
    if (!projectId) throw httpError(400, '缺少 project_id');
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const all = store.list('story_cards', {
      filter: (r) => r.kind === 'character'
        && (body.source_id ? r.source_id === body.source_id : true)
        && (body.project_id ? r.project_id === body.project_id : true)
        && (ids.length ? ids.includes(r.id) : true),
    });
    if (!all.length) throw httpError(400, '没有可导入的人物卡');
    const created = []; const skipped = [];
    for (const card of all) {
      const dup = store.list('characters', { filter: (r) => r.story_card_id === card.id })[0];
      if (dup) { skipped.push({ id: card.id, name: card.name, character_id: dup.id }); continue; }
      const c = store.insert('characters', story.cardToCharacter({ ...card, project_id: projectId }, projectId));
      created.push({ id: card.id, name: card.name, character_id: c.id });
    }
    return { ok: true, created, skipped, created_count: created.length, skipped_count: skipped.length };
  });

  // ── 一致性体检（批 8 补 3）：纯本地判定，随时可跑、不花钱 ──
  /** 已经进了资产库的卡片 id（体检要用它判断"人物卡的红利还没拿到"） */
  function assetCardIds() {
    return new Set(store.list('characters', { limit: 100000 }).map((c) => c.story_card_id).filter(Boolean));
  }

  on('GET', '/api/story/audit', (req, res, params, body, query) => {
    const projectId = str(query.project_id).trim();
    const sourceId = str(query.source_id).trim();
    const cards = store.list('story_cards', {
      filter: (r) => (projectId ? r.project_id === projectId : true) && (sourceId ? r.source_id === sourceId : true),
      limit: 100000,
    });
    const r = story.auditCards(cards, { assetCardIds: assetCardIds() });
    // 批 8 补 5：体检范围从"卡片库"扩到"卡片库 ↔ 分镜绑定"。漏绑的镜头**不会有任何报错**，
    // 只会在出图时少一段外貌/场景描述（同一张脸在不同镜头里漂移）—— 这正是最难靠肉眼发现的一类不一致。
    const shotRows = store.list('storyboards', { filter: (x) => (projectId ? x.project_id === projectId : true), limit: 100000 });
    const shots = story.auditShotBindings(shotRows, {
      characters: store.list('characters', { filter: (x) => (projectId ? x.project_id === projectId : true), limit: 100000 }),
      cards,
    });
    // 批 8 补 7：画风是"使用点统一注入"的，提示词里写死画风词会让"改设置全剧跟着变"静默失效
    const style = projectId ? styleOf(projectId) : '';
    const styleKey = Object.keys(ART_STYLE_MAP).find((k) => style && (style.includes(k) || k.includes(style)));
    const styleIssues = story.auditPromptStyle(shotRows, { style, stylePhrase: styleKey ? ART_STYLE_MAP[styleKey] : style });
    // 批 8 补 11：人物卡 ↔ 资产库的漂移。人物卡是"原著里读到的这个人"，资产库那份是"出图时真正注入的长相"，
    // 复制过去之后各走各的（追加解析补全了卡，库里还是旧样子）—— 没有任何报错，只是同一张脸越画越不像。
    const drift = story.auditCharacterDrift(cards, store.list('characters', {
      filter: (x) => (projectId ? x.project_id === projectId : true), limit: 100000,
    }));
    // 批 8 补 19：参考图缺口。补 13/补 17 把参考图接进了出图调用，但"接上了"不等于"有人挂" ——
    // 一个场景在 20 个镜头里反复出现却一张图都没挂，20 张图长得都不一样，而链路上**没有任何报错**
    // （每张图单独看都"成功"）。这是最难靠肉眼发现的一类不一致，所以并进体检。
    const projectChars = store.list('characters', { filter: (x) => (projectId ? x.project_id === projectId : true), limit: 100000 });
    // 卡片上存的是图片 id：能不能被上游抓到要查图库，所以把解析器注入进去（纯函数自己不碰 store）
    const resolveRefs = (ids) => {
      const urls = []; let local = 0; let missing = 0;
      for (const id of ids) {
        const a = store.get('image_assets', str(id));
        if (!a) { missing++; continue; }
        const u = str(a.remote_url).trim() || str(a.url).trim();
        if (story.isPublicUrl(u)) urls.push(u); else local++;
      }
      return { urls, local, missing };
    };
    const refGaps = story.auditRefImageGaps({ cards, characters: projectChars, shots: shotRows, resolveRefs });
    // 批 8 补 28：剧情卡 involved 里的人物闭环。`involved` 一直只被显示（分集大纲的"涉及：…"），
    // 从没核对过那些名字是否真的存在 —— 剧情里有这个人、却没有他的卡与档案，可以一路静默传到剧本，
    // 而外貌注入/绑定/参考图全落不到他身上。发现得比 shot_char_unknown 更早，也更便宜。
    const cast = story.auditPlotCast(cards, { characters: projectChars });
    const counts = {
      warn: r.counts.warn + shots.counts.warn + styleIssues.counts.warn + drift.counts.warn + refGaps.counts.warn + cast.counts.warn,
      info: r.counts.info + shots.counts.info + styleIssues.counts.info + drift.counts.info + refGaps.counts.info + cast.counts.info,
      fixable: r.counts.fixable + shots.counts.fixable + styleIssues.counts.fixable + drift.counts.fixable + refGaps.counts.fixable + cast.counts.fixable,
    };
    return {
      ok: true, total_cards: cards.length, shots_scanned: shots.scanned,
      art_style: style,
      counts,
      card_counts: r.counts, shot_counts: shots.counts, style_counts: styleIssues.counts, drift_counts: drift.counts,
      ref_counts: refGaps.counts, cast_counts: cast.counts,
      drift_pairs: drift.pairs,
      issues: r.issues.concat(shots.issues, styleIssues.issues, drift.issues, refGaps.issues, cast.issues),
      card_issues: r.issues, shot_issues: shots.issues, style_issues: styleIssues.issues, drift_issues: drift.issues,
      ref_issues: refGaps.issues, cast_issues: cast.issues,
    };
  });

  /**
   * 一键修复：只做**机械且可逆性可控**的三件事（合并同名卡 / 删掉撞名别名 / 人物卡入资产库）。
   * 需要人拍板的（两处描述哪个对）一律不替用户决定，只如实列出冲突值。
   */
  on('POST', '/api/story/audit/fix', (req, res, params, body) => {
    const projectId = str(body.project_id).trim();
    if (!projectId) throw httpError(400, '请先在右上角选择项目');
    const code = str(body.code).trim();
    const only = Array.isArray(body.card_ids) ? body.card_ids.map(String) : [];
    const detail = [];

    if (code === 'dup_name') {
      // 同名同类别的分组：合并 → 存活最早那张 → 其余删除
      const cards = store.list('story_cards', { filter: (r) => r.project_id === projectId, limit: 100000 });
      const groups = new Map();
      for (const c of cards) {
        const k = `${c.kind}::${story.nameKey(c.name)}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(c);
      }
      let mergedGroups = 0; let removedCards = 0; let repointed = 0;
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const ids = group.map((c) => c.id);
        if (only.length && !ids.some((id) => only.includes(id))) continue;
        const r = story.mergeCardGroup(cards, ids);
        if (!r.keep) continue;
        store.update('story_cards', r.keep.id, r.keep);
        for (const rid of r.removed) store.remove('story_cards', rid);
        // 关键：把分镜上指向被删卡的绑定改指到存活卡上，否则镜头会静默失去场景/道具注入
        for (const sb of store.list('storyboards', { filter: (x) => x.project_id === projectId, limit: 100000 })) {
          const cur = Array.isArray(sb.story_card_ids) ? sb.story_card_ids : [];
          if (!cur.some((x) => r.removed.includes(x))) continue;
          const next = [...new Set(cur.map((x) => (r.removed.includes(x) ? r.keep.id : x)))];
          store.update('storyboards', sb.id, { story_card_ids: next });
          repointed++;
        }
        mergedGroups++; removedCards += r.removed.length;
        detail.push({ name: r.keep.name, kind: r.keep.kind, kept: r.keep.id, removed: r.removed });
      }
      return { ok: true, code, merged_groups: mergedGroups, removed_cards: removedCards, repointed_shots: repointed, detail };
    }

    if (code === 'alias_collision') {
      const cards = store.list('story_cards', { filter: (r) => r.project_id === projectId, limit: 100000 });
      const byName = new Map();
      for (const c of cards) byName.set(`${c.kind}::${story.nameKey(c.name)}`, c);
      let fixed = 0;
      for (const c of cards) {
        if (only.length && !only.includes(c.id)) continue;
        const keep = (c.aliases || []).filter((al) => {
          const other = byName.get(`${c.kind}::${story.nameKey(al)}`);
          return !other || other.id === c.id; // 别名撞到别的卡 → 删掉这个别名
        });
        if (keep.length === (c.aliases || []).length) continue;
        const dropped = (c.aliases || []).filter((x) => !keep.includes(x));
        store.update('story_cards', c.id, { aliases: keep, edited: true });
        fixed++;
        detail.push({ name: c.name, dropped_aliases: dropped });
      }
      return { ok: true, code, fixed_cards: fixed, detail };
    }

    /**
     * 把某个目标（角色 / 地点道具卡）绑到指定的镜头上。
     * 刻意**按目标**而不是"把这些问题镜头里能匹配的都绑上"：一次点击只做一个明确的动作，
     * 多绑一个角色会让用户在看预览时莫名其妙（而且他刚才只想修"林晚"这一条）。
     */
    if (code === 'bind_shot_target') {
      const targetId = str(body.target_id).trim();
      const shotIds = idList(body.shot_ids);
      if (!targetId) throw httpError(400, '缺少 target_id');
      if (!shotIds.length) throw httpError(400, '缺少 shot_ids');
      const char = store.get('characters', targetId);
      const card = char ? null : store.get('story_cards', targetId);
      if (!char && !card) throw httpError(404, '要绑定的角色/卡片不存在');
      if (card && !STORY_CARD_INJECT_FIELDS[card.kind]) throw httpError(400, '这类卡片不可注入提示词（只有地点卡/道具卡可以）');
      let bound = 0;
      for (const id of shotIds) {
        const sb = store.get('storyboards', id);
        if (!sb || sb.project_id !== projectId) continue;
        if (char) {
          const cur = Array.isArray(sb.character_ids) ? sb.character_ids : [];
          if (cur.includes(targetId)) continue;
          store.update('storyboards', id, { character_ids: cur.concat(targetId) });
        } else {
          const cur = Array.isArray(sb.story_card_ids) ? sb.story_card_ids : [];
          if (cur.includes(targetId)) continue;
          store.update('storyboards', id, { story_card_ids: injectableCardIds(cur.concat(targetId)) });
        }
        bound++;
        detail.push({ storyboard_id: id, shot_number: sb.shot_number });
      }
      return { ok: true, code, target_id: targetId, target_name: char ? char.name : card.name, bound_shots: bound, detail };
    }

    /** 锁定角色：锁定 = 无条件注入（同一段长相逐字出现在每个镜头），这是"未锁定就跳过"的唯一出口 */
    if (code === 'lock_shot_char') {
      const targetId = str(body.target_id).trim();
      if (!targetId) throw httpError(400, '缺少 target_id');
      const c = store.get('characters', targetId);
      if (!c) throw httpError(404, '角色不存在');
      if (c.is_locked) return { ok: true, code, target_id: targetId, locked: 0, already: true };
      store.update('characters', targetId, { is_locked: true });
      return { ok: true, code, target_id: targetId, target_name: c.name, locked: 1 };
    }

    /**
     * 删掉提示词里写死的画风词（批 8 补 7）。
     * 只做这一件事，并把"改前 / 改后"如实回报 —— 用户点完能立刻看见到底删了什么。
     */
    if (code === 'strip_style_word') {
      const word = str(body.word).trim();
      const shotIds = idList(body.shot_ids);
      if (!word) throw httpError(400, '缺少 word');
      if (!shotIds.length) throw httpError(400, '缺少 shot_ids');
      let fixed = 0;
      for (const id of shotIds) {
        const sb = store.get('storyboards', id);
        if (!sb || sb.project_id !== projectId) continue;
        const patch = {};
        for (const f of ['image_prompt', 'video_prompt']) {
          const before = str(sb[f]);
          if (!before) continue;
          const after = story.stripStyleWord(before, word);
          if (after === before) continue;
          patch[f] = after;
          detail.push({ storyboard_id: id, shot_number: sb.shot_number, field: f, before, after });
        }
        if (!Object.keys(patch).length) continue;
        store.update('storyboards', id, patch);
        fixed++;
      }
      return { ok: true, code, word, fixed_shots: fixed, detail };
    }

    if (code === 'char_not_in_asset') {
      const cards = store.list('story_cards', { filter: (r) => r.project_id === projectId && r.kind === 'character', limit: 100000 });
      const have = assetCardIds();
      const created = []; const skipped = [];
      for (const card of cards) {
        if (only.length && !only.includes(card.id)) continue;
        if (have.has(card.id)) { skipped.push({ id: card.id, name: card.name, reason: '已在资产库' }); continue; }
        const c = store.insert('characters', story.cardToCharacter({ ...card, project_id: projectId }, projectId));
        created.push({ id: card.id, name: card.name, character_id: c.id });
      }
      return { ok: true, code, created_count: created.length, skipped_count: skipped.length, created, skipped };
    }

    /**
     * 把人物卡里**会注入提示词的字段**同步到资产库那份角色上（批 8 补 11）。
     * 只同步外貌/服饰/别名三项（`characterPhrase` 与名字匹配真正用到的），不动 role/gender/age/personality ——
     * 那些是用户在资产库里可能特意改过的，同步过去只会把人的编辑覆盖掉。
     */
    if (code === 'sync_character') {
      const charId = str(body.target_id).trim();
      const cardId = str(body.card_id).trim() || (Array.isArray(body.card_ids) ? str(body.card_ids[0]).trim() : '');
      const ch = charId ? store.get('characters', charId) : null;
      if (!ch) throw httpError(404, '要同步的角色不存在（可能已被删除）');
      const card = cardId ? store.get('story_cards', cardId) : null;
      if (!card || card.kind !== 'character') throw httpError(404, '要同步的人物卡不存在');
      if (ch.story_card_id && String(ch.story_card_id) !== String(card.id)) throw httpError(400, '这个角色不是从该人物卡导入的，不能同步');
      const patch = {};
      const fields = [];
      // 用 story.clip 而不是本地拼一个：字段长度上限与人物卡那边**同一套**（
      // 各写一份迟早会出现"卡里存得下、资产库里被截断"的静默差异）
      for (const [k, label] of [['appearance', '外貌'], ['outfit', '服饰']]) {
        const v = story.clip(card[k], k);
        if (v && v !== str(ch[k]).trim()) { patch[k] = v; fields.push(label); }
      }
      const cardAl = (card.aliases || []).map((x) => str(x).trim()).filter(Boolean);
      if (cardAl.length) {
        const cur = str(ch.alias).split(/[、,，\/|]/).map((x) => x.trim()).filter(Boolean);
        const merged = [...new Set([...cur, ...cardAl])];
        if (merged.length !== cur.length) { patch.alias = merged.join('、'); fields.push('别名'); }
      }
      if (!fields.length) return { ok: true, code, updated: false, fields: [], target_name: str(ch.name), card_id: card.id, character_id: ch.id };
      // 溯源写在 notes 里：用户回头看这份长相是怎么来的时，能看见"以人物卡为准同步过"
      patch.notes = `${str(ch.notes).trim() ? `${str(ch.notes).trim()}；` : ''}与人物卡同步（${fields.join('/')}）`.slice(0, 400);
      store.update('characters', ch.id, patch);
      return { ok: true, code, updated: true, fields, target_name: str(ch.name), card_id: card.id, character_id: ch.id };
    }

    throw httpError(400, `不认识的体检项「${code}」（只支持 dup_name / alias_collision / char_not_in_asset / bind_shot_target / lock_shot_char / strip_style_word / sync_character）`);
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
// 批 8 补 2：原著卡片注入的纯函数面（离线可断言；前端 consts.js 有逐字同构的镜像）
module.exports.storyCardPhrase = storyCardPhrase;
module.exports.storyCardLook = storyCardLook;
module.exports.STORY_CARD_INJECT_FIELDS = STORY_CARD_INJECT_FIELDS;
module.exports.cameraMovePhrase = cameraMovePhrase;
module.exports.variationPhrase = variationPhrase;
module.exports.ART_STYLE_MAP = ART_STYLE_MAP;
