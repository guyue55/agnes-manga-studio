/**
 * story.js — 原著解析的纯函数层（把"一部长篇"拆成"一堆可确认的卡片"）
 * ------------------------------------------------------------------
 * 竞品对照（docs/research/08-src-04-novel2script.md）：那家只抽取
 * `characters[{name, identity}]` + `mainPlot` 两个字段，且**原文一次性截断到 1 万字**，
 * 超出部分直接丢；全包零草稿持久化，刷新即全丢。
 *
 * 本模块承担"彻底分析"里所有**可离线验证**的部分，一条也不交给模型：
 *   · splitChunks   —— 按段落/句子边界切块，绝不切碎句子，也不静默丢字（超限如实上报）
 *   · normalizeCard —— 模型输出一律不可信：类型白名单、字段白名单、长度上限、空名即弃
 *   · mergeCards    —— 跨块去重合并（同一人物在多段里出现必须收敛成一张卡）
 *   · cardsToPrompt —— 把卡片回注成提示词文本（反向驱动剧本/资产/分镜的载体）
 *
 * 为什么单独成文件：这些判据全部有明确对错，必须能用断言钉住；
 * 塞进 routes.js 就只能靠"跑一次看看"来验证，改一个字都要烧配额。
 */
'use strict';

/** 卡片种类 —— 六类。label 是界面/提示词里用的中文名，id 是稳定标识（落库、接口参数都用它） */
const CARD_KINDS = ['world', 'character', 'location', 'prop', 'plot', 'timeline'];
const CARD_KIND_LABELS = {
  world: '信息卡',
  character: '人物卡',
  location: '地点卡',
  prop: '道具卡',
  plot: '剧情卡',
  timeline: '时间线',
};
/** 模型可能吐中文名/同义词，统一收敛到上面的 id；不在表里的一律丢弃（不猜） */
const KIND_ALIASES = {
  world: ['world', 'setting', 'info', 'meta', '信息卡', '设定', '世界观', '世界设定', '作品信息', '基本信息'],
  character: ['character', 'char', 'role', 'person', '人物', '人物卡', '角色', '角色卡', '人物介绍'],
  location: ['location', 'place', 'scene', 'venue', '地点', '地点卡', '场景', '场景卡', '场所'],
  prop: ['prop', 'item', 'object', '道具', '道具卡', '物品', '关键物品'],
  plot: ['plot', 'event', 'beat', 'story', '剧情', '剧情卡', '事件', '情节', '桥段'],
  timeline: ['timeline', 'chronology', '时间线', '时间轴', '年表'],
};

/**
 * 每类卡片允许的**业务字段**（除通用字段 name/summary/aliases 外）。
 * 只留"下游真的会用到"的字段：人物卡的外貌要进分镜提示词，地点卡的氛围要进场景描述，
 * 剧情卡的冲突/转折要进剧本。字段越少，用户越改得动 —— 这是 04 号包"只有两个字段"给的启示，
 * 只是我们把"少"定在"每个字段都有下游消费者"，而不是"少到丢失一致性载体"。
 */
const CARD_FIELDS = {
  world: ['genre', 'tone', 'worldview', 'theme', 'logline', 'mainline'],
  character: ['identity', 'appearance', 'outfit', 'personality', 'role', 'gender', 'age'],
  location: ['atmosphere', 'region', 'time_of_day', 'features'],
  prop: ['owner', 'usage', 'features'],
  plot: ['stage', 'conflict', 'turn', 'outcome', 'involved'],
  timeline: ['when', 'order_note'],
};
/** 各字段长度上限：防止模型"写小作文"把下游提示词挤爆（一条人物卡不该长过一段分镜提示词） */
const FIELD_MAX = {
  name: 40, summary: 300, identity: 120, appearance: 200, outfit: 120, personality: 160,
  role: 20, gender: 10, age: 20, genre: 40, tone: 60, worldview: 200, theme: 120,
  logline: 160, mainline: 300, atmosphere: 120, region: 40, time_of_day: 30, features: 200,
  owner: 40, usage: 120, stage: 20, conflict: 160, turn: 160, outcome: 160, involved: 120,
  when: 60, order_note: 120, alias: 20,
};
/**
 * 会被"使用点注入"进分镜提示词的类别与字段（批 8 补 2 起）。
 * 只有画面上看得见的两类：人物卡走角色库那条路（有参考图与锁定语义），
 * 信息卡/剧情卡/时间线是给编剧看的全局设定，逐镜注入只会稀释画面描述。
 */
const STORY_INJECT_KINDS = ['location', 'prop'];
const STORY_INJECT_FIELDS = {
  location: ['atmosphere', 'region', 'time_of_day', 'features'],
  prop: ['owner', 'usage', 'features'],
};
/** 字段中文名（体检报告要说人话，不能把 atmosphere 这种键名丢给用户） */
const STORY_FIELD_LABELS = {
  atmosphere: '氛围', region: '地域', time_of_day: '时段', features: '特征',
  owner: '持有者', usage: '用途', appearance: '外貌', outfit: '服装',
  identity: '身份', personality: '性格', role: '定位', gender: '性别', age: '年龄',
  genre: '题材', tone: '基调', worldview: '世界观', theme: '主题', logline: '一句话简介', mainline: '主线',
  stage: '幕次', conflict: '冲突', turn: '转折', outcome: '结果', involved: '涉及人物',
  when: '时间点', order_note: '顺序说明', name: '名字', summary: '摘要', aliases: '别名',
};

/** 幕次顺序（分集骨架靠它判断"幕的收口处"）；与前端 STORY_STAGE_OPTIONS 同源 */
const STAGE_ORDER = ['起', '承', '转', '合'];
const EPISODE_PER_DEFAULT = 4;   // 每集至少几拍
const EPISODE_PER_MAX = 20;      // 输入上限：再大就不是"分集"而是"一次说完"
const EPISODE_HARD_FACTOR = 2;   // 硬上限倍数：单幕长过这个倍数就必须强行切开，否则分集等于没分
const PRIOR_MAX_DEFAULT = 1200;  // 「前情提要」默认预算（字）：够放下最近几集，又不至于把本集大纲挤到角落

/** 单类卡片数量上限（超出如实上报 dropped，不静默截断） */
const KIND_MAX = { world: 8, character: 60, location: 60, prop: 60, plot: 80, timeline: 40 };

const DEFAULT_MAX_CHARS = 3000;   // 单块上限：中文 3000 字仍能稳定吐出结构化 JSON，再大就开始丢字段
const DEFAULT_MIN_CHARS = 400;    // 尾块小于此值向前并块，不为几十个字付一次调用
const DEFAULT_MAX_CHUNKS = 24;    // 调用次数上限（计费闸门）：24×3000 ≈ 7.2 万字，够一本中篇

function str(v) { return v == null ? '' : String(v); }

/** 幕次序号（不认识/没填 → 99，排到最后，且不参与"收口点"判断） */
function stageRank(v) {
  const i = STAGE_ORDER.indexOf(str(v).trim());
  return i < 0 ? 99 : i;
}

/** 换行统一 + 去行尾空白 + 压缩 3 个以上连续空行。切块前必须做，否则 \r\n 会把字数算多 */
function normalizeText(text) {
  return str(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 把一段长文本切成若干块（确定性、可复现）。
 *
 * 边界优先级：段落 → 句子 → 硬切。**永远不会**为了凑长度把一句话切两半，
 * 因为"半句话"喂给模型会让它把人物名读错（04 号包就是整篇直接截断，连边界都不管）。
 *
 * @returns {{chunks:Array<{index:number,text:string,chars:number,label:string}>,
 *            total_chars:number, covered_chars:number, truncated:boolean, max_chunks:number}}
 *   `truncated=true` 时 `covered_chars < total_chars`：调用方**必须**把这件事告诉用户，
 *   不许假装全解析了（R18「超限透明化」的同一纪律）。
 */
function splitChunks(text, opts = {}) {
  const maxChars = Math.max(200, Math.min(Number(opts.maxChars) || DEFAULT_MAX_CHARS, 20000));
  // 变更须知：minChars 必须用 `== null` 判断而不是 `|| 默认值` ——
  // 显式传 0（"永远不要并尾块"）是合法用法，写成 `||` 会被当成没传而回落到 400。
  const minChars = opts.minChars == null
    ? DEFAULT_MIN_CHARS
    : Math.max(0, Math.min(Number(opts.minChars) || 0, maxChars));
  const maxChunks = Math.max(1, Math.min(Number(opts.maxChunks) || DEFAULT_MAX_CHUNKS, 200));
  const src = normalizeText(text);
  const totalChars = src.length;
  if (!totalChars) return { chunks: [], total_chars: 0, covered_chars: 0, truncated: false, max_chunks: maxChunks };

  // 1) 段落 → 块（超长段落再按句子切）。
  //    变更须知：块**自带尾随分隔符**，装块时不再另外插入 '\n'。
  //    否则 sum(块长) 会比原文少掉"跨块丢掉的那几个换行"，covered_chars 就不再等于 total_chars，
  //    "到底读全了没有"这个唯一可信的判据就失效了（selftest 有等式钉）。
  const parts = src.split(/(\n+)/); // 交替：正文, 分隔符, 正文, ...
  const blocks = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i];
    const sep = parts[i + 1] || '';
    if (!text) {
      // 纯分隔符（开头空行等）：挂到上一块尾巴上，不许凭空丢字符
      if (sep && blocks.length) blocks[blocks.length - 1] += sep;
      continue;
    }
    if (text.length + sep.length <= maxChars) { blocks.push(text + sep); continue; }
    // 句末标点后切（保留标点）；没有标点的整段长文只能硬切，但至少保证不丢字。
    // 切出来的子块要预留 sep 的位置，否则最后一块加上分隔符就会超上限。
    const room = Math.max(1, maxChars - sep.length);
    const sub = [];
    const sentences = text.split(/(?<=[。！？…；!?;])/).filter((s) => s.length);
    let buf = '';
    for (const s of sentences) {
      if (s.length > room) {
        if (buf) { sub.push(buf); buf = ''; }
        for (let k = 0; k < s.length; k += room) sub.push(s.slice(k, k + room));
        continue;
      }
      if ((buf + s).length > room) { sub.push(buf); buf = ''; }
      buf += s;
    }
    if (buf) sub.push(buf);
    if (sub.length) sub[sub.length - 1] += sep; // 分隔符只挂在最后一块，总长才守恒
    blocks.push(...sub);
  }
  if (!blocks.length) return { chunks: [], total_chars: totalChars, covered_chars: 0, truncated: false, max_chunks: maxChunks };

  // 2) 贪心装块（块自带分隔符，直接拼）
  const packed = [];
  let cur = '';
  for (const b of blocks) {
    if (cur && (cur.length + b.length) > maxChars) { packed.push(cur); cur = ''; }
    cur += b;
  }
  if (cur) packed.push(cur);

  // 3) 尾块过小 → 并入前一块（并块后可能略超 maxChars，这是刻意的：宁可多几百字，也别为残句单开一次调用）
  if (packed.length > 1 && packed[packed.length - 1].length < minChars) {
    packed[packed.length - 2] += packed.pop();
  }

  // 4) 次数闸门：超出上限时如实截断并上报覆盖字数
  const truncated = packed.length > maxChunks;
  const kept = truncated ? packed.slice(0, maxChunks) : packed;
  const chunks = kept.map((t, i) => ({
    index: i,
    text: t,
    chars: t.length,
    label: `第 ${i + 1}/${kept.length} 段`,
  }));
  return {
    chunks,
    total_chars: totalChars,
    covered_chars: kept.reduce((a, t) => a + t.length, 0),
    truncated,
    max_chunks: maxChunks,
  };
}

/** 中文/同义词 → 稳定 kind id；不认识返回 ''（调用方据此丢卡） */
function normalizeKind(v) {
  const k = str(v).trim().toLowerCase();
  if (!k) return '';
  for (const kind of CARD_KINDS) {
    if (k === kind || KIND_ALIASES[kind].includes(k)) return kind;
  }
  return '';
}

/**
 * 名字归一化 —— 去重合并的键。
 * 必须吃掉这些差异，否则"林晚"与"「林晚」"、"林 晚"会各留一张卡，
 * 用户看到两个人，下游提示词也会把同一个人写两遍。
 */
function nameKey(v) {
  return str(v)
    .replace(/[\s\u3000]+/g, '')
    .replace(/[《》「」『』【】()（）[\]"'`·、,，.。:：;；!！?？~～\-—_]/g, '')
    .trim()
    .toLowerCase();
}

/** 名字去包装：《林晚》/「林晚」/“林晚” → 林晚。
 *  模型很爱给名字加书名号，而 nameKey 又会把它们抹掉 —— 不去包装的话，
 *  去重能对上，但界面和提示词里显示的是"《林晚》"，看着像另一个实体。 */
function cleanName(v) {
  return str(v).trim()
    .replace(/^[《〈「『【\[("'“‘]+/, '')
    .replace(/[》〉」』】\])"'”’]+$/, '')
    .trim();
}

/**
 * 负面提示词 → 并入正向提示词（批 8 补 14）。
 *
 * 为什么**不是**单发一个 `negative_prompt` 字段：Agnes 网关对未知字段是硬拒 ——
 * 视频 2.5 系实测报过 `negative_prompt is not an allowed request field`（见 docs/issues.md），
 * 单发会让整条出图链 400。宁可效果弱一点，也不能把出图打断。
 *
 * 措辞在这里只有一份实现：图片链（routes.js）、视频 2.5 系（agnes.js 的 v25Body）、
 * 前端"实际发出"预览（consts.js 镜像）三处同源，改一处三处一致。
 * 空白/空串一律视为"没填"，不拼出一个空的"避免出现："尾巴。
 */
function negativePhrase(prompt, neg) {
  const n = String(neg || '').trim();
  if (!n) return prompt;
  return `${prompt}。避免出现：${n}`;
}

function clip(v, field) {
  const s = str(v).trim();
  const max = FIELD_MAX[field] || 200;
  return s.length > max ? s.slice(0, max) : s;
}

/** 数组型字段（别名）：去空、去重（按 nameKey）、限长限量 */
function normalizeAliases(v) {
  const arr = Array.isArray(v) ? v : (str(v).trim() ? str(v).split(/[、,，/|]/) : []);
  const out = [];
  const seen = new Set();
  for (const a of arr) {
    const s = clip(a, 'alias');
    const k = nameKey(s);
    if (!s || !k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * 把模型吐出来的一条原始卡片规范化。
 * 模型输出**一律不可信**：类型不认识、名字为空、字段名编造、值不是字符串 —— 全部在这里挡掉。
 * @param raw 模型给的对象
 * @param ctx {source_id, project_id, chunk_index, order}
 * @returns 规范化后的卡片，或 null（该条丢弃）
 */
/**
 * 哪些卡片的参考图能进出图输入（批 8 补 17）。
 *
 * 只认**地点卡 / 道具卡**：它们是"会进分镜提示词、却在资产库里没有家"的两类 ——
 * 人物卡有资产库（`characters.reference_image_ids`，批 8 补 13 已接进出图），
 * 地点/道具却只有一行文字描述，于是**同一个场景每张图长得都不一样**，而且没有任何报错。
 * 信息卡/剧情卡/时间线不进提示词，给它们挂参考图没有去处。
 */
const CARD_IMAGE_KINDS = ['location', 'prop'];

/** 参考图 id 清洗：去空、去重、限量（与角色档案的"最多 12 张"同一口径） */
function normalizeRefIds(v) {
  const out = [];
  for (const x of (Array.isArray(v) ? v : [])) {
    const id = str(x).trim();
    if (id && !out.includes(id) && out.length < 12) out.push(id);
  }
  return out;
}

function normalizeCard(raw, ctx = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kind = normalizeKind(raw.kind || raw.type || raw.card_type || raw.category);
  if (!kind) return null;
  // 模型可能把内容写在别的键上（summary/desc/description/intro/content），按优先级取第一个非空
  const summary = clip(raw.summary || raw.desc || raw.description || raw.intro || raw.content || '', 'summary');
  const name = clip(cleanName(raw.name || raw.title || raw.label || (kind === 'plot' ? summary.slice(0, 20) : '')), 'name');
  if (!name) return null; // 没名字的卡无法去重、无法引用 → 直接弃，不猜
  const card = {
    kind,
    name,
    summary,
    // 别名里出现自己（模型常把正名也列进别名）要去掉，否则提示词里会出现"林晚（别名：林晚）"
    aliases: normalizeAliases(raw.aliases || raw.alias || raw.aka || raw.other_names).filter((a) => nameKey(a) !== nameKey(name)),
    chunk_index: Number.isInteger(ctx.chunk_index) ? ctx.chunk_index : null,
    source_id: ctx.source_id || null,
    project_id: ctx.project_id || null,
    order: Number.isInteger(ctx.order) ? ctx.order : 0,
  };
  for (const f of CARD_FIELDS[kind]) {
    const val = clip(raw[f], f);
    if (val) card[f] = val;
  }
  // 人物卡的外貌是**一致性载体**（R15 的注入链靠它），若模型只给了 personality 也认，
  // 但绝不把别的字段硬塞进 appearance —— 那会污染下游分镜提示词
  if (kind === 'character' && !card.role && raw.role) card.role = clip(raw.role, 'role');
  // ⚠️ 这里**故意不产出** `reference_image_ids`（批 8 补 17）。它是**用户挂上去的**，
  // 不是模型抽出来的；而归并落库走的是 `store.update`（Object.assign 合并）——
  // 只要 normalizeCard 在字段缺失时吐一个 `[]`，重新解析就会把用户挂的参考图**静默清空**。
  // 不产出 ⇒ 该键不在 patch 里 ⇒ 合并时原样保留。selftest 有钉钉死这个形状。
  return card;
}

/** 合并两张同类同名的卡：长文本取胜，集合字段取并集，先出现的 order 为准 */
function mergeTwo(a, b) {
  const out = { ...a };
  if (str(b.summary).length > str(a.summary).length) out.summary = b.summary;
  for (const [k, v] of Object.entries(b)) {
    if (v == null || v === '') continue;
    if (k === 'aliases') {
      out.aliases = normalizeAliases([...(a.aliases || []), ...(b.aliases || [])]);
      continue;
    }
    if (k === 'chunk_index') continue; // 保留首个出现位置
    if (k === 'order' || k === 'kind' || k === 'name' || k === 'source_id' || k === 'project_id') continue;
    if (!str(out[k]).trim() && str(v).trim()) out[k] = v;      // 空字段被补上
    else if (str(v).length > str(out[k]).length && k !== 'summary') out[k] = v; // 更详细的描述取胜
  }
  out.mentions = (a.mentions || 1) + (b.mentions || 1);
  // evidence：出现过的块号，供界面"这条是从哪段读出来的"（用户可核对，模型不能空口断言）
  const ev = [...new Set([...(a.evidence || []), ...(b.evidence || [])])].sort((x, y) => x - y);
  out.evidence = ev.slice(0, 8);
  return out;
}

/**
 * 跨块去重合并。
 * 同一人物在第 1 段和第 7 段都出现是常态，必须收敛成一张卡 —— 否则"人物卡"列表里
 * 会出现 5 个"林晚"，用户既没法确认也没法改，下游提示词还会重复注入。
 * @returns {{cards:Array, merged:number, dropped:Array<{kind,name,reason}>}}
 */
function mergeCards(cards, opts = {}) {
  const maxPerKind = { ...KIND_MAX, ...(opts.kindMax || {}) };
  const map = new Map();
  let merged = 0;
  let seq = 0;
  for (const raw of Array.isArray(cards) ? cards : []) {
    const c = raw && raw.kind ? raw : normalizeCard(raw, {});
    if (!c) continue;
    const card = { ...c, order: c.order || ++seq };
    if (!card.evidence) card.evidence = Number.isInteger(card.chunk_index) ? [card.chunk_index] : [];
    const key = `${card.kind}::${nameKey(card.name)}`;
    const prev = map.get(key);
    if (prev) { map.set(key, mergeTwo(prev, card)); merged++; }
    else map.set(key, card);
  }
  const all = [...map.values()];
  const cards2 = [];
  const dropped = [];
  const perKind = {};
  for (const c of all) {
    const n = (perKind[c.kind] = (perKind[c.kind] || 0) + 1);
    if (n > (maxPerKind[c.kind] || 999)) { dropped.push({ kind: c.kind, name: c.name, reason: '超出该类型数量上限' }); continue; }
    cards2.push(c);
  }
  return { cards: cards2, merged, dropped };
}

/**
 * 追加解析（批 8 补 10）：把新抽到的卡片并进**已有**卡片。
 *
 * 三个必须守住的点：
 * ① **已有的卡一张都不能消失** —— 分镜可能绑着它（`story_card_ids`），删卡会让镜头静默失去场景/道具注入；
 *    所以这里只做"补空字段 / 并别名 / 累计出现次数"，绝不输出比入参更少的已有卡。
 * ② **已有卡保留自己的 id** —— 绑定、体检的修复记录、界面上正在看的那张卡都靠 id 认人。
 * ③ **order 不能撞**：已有卡保留原 order，新增卡接在最大 order 之后（追加的原文本来就在后面）。
 *    直接沿用合并里的顺序号会与已有卡撞号，剧情卡的"原文出现顺序"就乱了（分集骨架依赖它）。
 * 同名的判定沿用 `mergeCards`（kind + 名字归一化），跨章节同名不再重复建卡。
 * @returns {{cards:Array, touched:Array, fresh:Array, updated:number, inserted:number, merged:number, dropped:Array}}
 *   `touched` = 需要回写的已有卡（本次真的并进了新数据），`fresh` = 需要新增的卡。
 */
function mergeAppend(existing, incoming) {
  const ex = Array.isArray(existing) ? existing : [];
  const inc = (Array.isArray(incoming) ? incoming : []).map((c) => (c && c.kind ? c : normalizeCard(c, {}))).filter(Boolean);
  const merged = mergeCards([...ex, ...inc]);
  const ids = new Set(ex.map((c) => c.id));
  const byId = new Map(ex.map((c) => [c.id, c]));
  // "被本次新增改动到的已有卡"= 与新增卡同 key 的那些。让本函数直接给出这份名单，
  // 调用方就不必再去猜（按块号猜是个近似，按 key 才是准的）
  const incKeys = new Set(inc.map((c) => `${c.kind}::${nameKey(c.name)}`));
  // 已有卡的 order **原样保留**（重排会让一批没动过的卡也需要回写，纯属浪费）；
  // 新增卡接在最大 order 之后 —— 追加的原文本来就在后面，剧情卡的"原文出现顺序"才不会乱
  let next = ex.reduce((m, c) => Math.max(m, Number(c.order) || 0), 0);
  const cards = merged.cards.map((c) => {
    if (ids.has(c.id)) {
      const prev = byId.get(c.id);
      return { ...c, order: Number(prev.order) || Number(c.order) || 0 };
    }
    next += 1;
    return { ...c, order: next };
  });
  const touched = cards.filter((c) => ids.has(c.id) && incKeys.has(`${c.kind}::${nameKey(c.name)}`));
  const fresh = cards.filter((c) => !ids.has(c.id));
  return {
    cards, touched, fresh,
    updated: touched.length, inserted: fresh.length, merged: merged.merged, dropped: merged.dropped,
  };
}

/**
 * 全局归并结果的落库方案（批 8 补 10）：按 kind+名字**就地更新**，只删这次结果里真的没有的旧卡。
 *
 * 原来的做法是"先删光 origin=bible 的卡再重建" —— 语义上确实是"替换而不是叠加"（不会越点越多），
 * 但**每次归并都换一批 id**：分镜绑定、界面上正在看的那张卡、体检报告里的 target_id 全都指向了不存在的卡。
 * 归并是"按新结果重排"，所以 order 一律听新结果（不是往后接）。
 * @returns {{update:Array, insert:Array, remove:Array}} update 里的卡已带原 id。
 */
function applyBibleCards(existing, incoming) {
  const inc = (Array.isArray(incoming) ? incoming : []).filter(Boolean);
  const byKey = new Map((Array.isArray(existing) ? existing : []).map((c) => [`${c.kind}::${nameKey(c.name)}`, c]));
  const keep = new Set();
  const update = [];
  const insert = [];
  inc.forEach((c, i) => {
    const card = { ...c, order: i + 1 };
    const prev = byKey.get(`${card.kind}::${nameKey(card.name)}`);
    if (prev) { keep.add(prev.id); update.push({ ...card, id: prev.id }); }
    else insert.push(card);
  });
  const remove = (Array.isArray(existing) ? existing : []).filter((c) => !keep.has(c.id));
  return { update, insert, remove };
}

/** 固定展示顺序：信息卡 → 人物 → 地点 → 道具 → 剧情 → 时间线（按 kind 表顺序，同类按首次出现） */
function sortCards(cards) {
  const rank = new Map(CARD_KINDS.map((k, i) => [k, i]));
  return [...(cards || [])].sort((a, b) => {
    const d = (rank.get(a.kind) ?? 99) - (rank.get(b.kind) ?? 99);
    return d !== 0 ? d : (a.order || 0) - (b.order || 0);
  });
}

/** 单张卡压成一行（给 reduce 调用当输入；不给模型看全文，避免它二次"创作"） */
function cardLine(c) {
  const parts = [];
  if (c.kind === 'character') {
    if (c.role) parts.push(c.role);
    if (c.identity) parts.push(c.identity);
    if (c.appearance) parts.push(`外貌：${c.appearance}`);
    if (c.personality) parts.push(`性格：${c.personality}`);
  } else if (c.kind === 'location') {
    if (c.atmosphere) parts.push(c.atmosphere);
    if (c.features) parts.push(c.features);
  } else if (c.kind === 'prop') {
    if (c.owner) parts.push(`持有者：${c.owner}`);
    if (c.usage) parts.push(c.usage);
  } else if (c.kind === 'plot') {
    if (c.stage) parts.push(`[${c.stage}]`);
    if (c.conflict) parts.push(`冲突：${c.conflict}`);
    if (c.outcome) parts.push(`结果：${c.outcome}`);
  } else if (c.kind === 'timeline') {
    if (c.when) parts.push(c.when);
  } else if (c.kind === 'world') {
    if (c.genre) parts.push(`题材：${c.genre}`);
    if (c.tone) parts.push(`基调：${c.tone}`);
  }
  const body = parts.length ? parts.join('｜') : c.summary;
  const alias = c.aliases && c.aliases.length ? `（别名：${c.aliases.join('、')}）` : '';
  return `${c.name}${alias}：${body || '（待补充）'}`;
}

/** 卡片摘要（reduce 调用的 {{cards}} 变量）：按类分组，编号稳定，便于模型按号引用 */
function digestCards(cards, opts = {}) {
  const kinds = opts.kinds && opts.kinds.length ? opts.kinds : CARD_KINDS;
  const list = sortCards(cards).filter((c) => kinds.includes(c.kind));
  const out = [];
  for (const k of kinds) {
    const group = list.filter((c) => c.kind === k);
    if (!group.length) continue;
    out.push(`【${CARD_KIND_LABELS[k]}】共 ${group.length} 条`);
    group.forEach((c, i) => out.push(`${i + 1}. ${cardLine(c)}`));
  }
  return out.join('\n');
}

/**
 * 卡片 → 提示词文本（**反向驱动**的载体）。
 * 剧本/分镜模板里加一个 {{人物卡}} / {{剧情卡}} 变量即可吃到这里的结果：
 * 不新增存储、不新增协议，沿用"同名变量在页签间延续"的既有语义。
 */
function cardsToPrompt(cards, kinds, opts = {}) {
  const body = digestCards(cards, { kinds });
  if (!body) return '';
  const head = opts.head || '以下是从原著中抽取并确认过的设定，必须严格遵守，不得与之矛盾';
  return `${head}：\n${body}`;
}

/** 人物卡 → characters 表的行（「人物卡入资产库」的映射；只搬有下游消费者的字段） */
function cardToCharacter(card, projectId) {
  const c = card || {};
  const role = ['主角', '配角', '反派', '龙套'].includes(str(c.role)) ? str(c.role) : '主角';
  return {
    project_id: projectId || c.project_id || '',
    name: clip(c.name, 'name'),
    alias: (c.aliases || []).join('、'),
    role,
    gender: ['男', '女', '其他'].includes(str(c.gender)) ? str(c.gender) : '',
    age: clip(c.age, 'age'),
    appearance: clip(c.appearance, 'appearance'),
    outfit: clip(c.outfit, 'outfit'),
    personality: clip(c.personality || c.identity, 'personality'),
    // 溯源：哪张卡变来的。资产库那边据此显示"来自原著解析"，也避免重复导入同一个角色
    notes: clip(c.summary ? `原著解析：${c.summary}` : '原著解析导入', 400),
    is_locked: false,
    reference_image_ids: [],
    story_card_id: c.id || null,
  };
}

/**
 * 从模型输出里捞出 JSON。json_mode 只是"请求"约束，不是保证：
 * 实测网关降级、模型加解释、包 ```json 围栏都出现过（R10 就是上游 200 + HTML 的事故）。
 * 纯函数放这里，是为了能钉住"围栏/前后缀废话/截断"这些真实形态，而不是靠线上碰运气。
 * @returns 解析出的对象/数组，失败返回 null
 */
function parseJsonLoose(text) {
  let s = str(text).trim();
  if (!s) return null;
  // 去掉 ```json ... ``` 围栏（贪婪匹配到最后一个围栏，避免中间还有围栏时只取一半）
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(s);
  if (fence && fence[1].trim()) s = fence[1].trim();
  try { return JSON.parse(s); } catch { /* 继续尝试截取 */ }
  // 截取第一个 { 或 [ 到最后一个配对的 } 或 ]（模型常在前后加"好的，以下是结果："）
  const starts = [s.indexOf('{'), s.indexOf('[')].filter((i) => i >= 0);
  if (!starts.length) return null;
  const from = Math.min(...starts);
  const open = s[from];
  const close = open === '{' ? '}' : ']';
  const to = s.lastIndexOf(close);
  if (to <= from) return null;
  try { return JSON.parse(s.slice(from, to + 1)); } catch { return null; }
}

/**
 * 从模型返回里取出卡片数组。
 * 容错三种真实形态：`{cards:[...]}`、裸数组、`{data:[...]}`（模型偶尔换键名）。
 * 再逐条 normalizeCard —— 认不出的条目直接丢，绝不"猜一个 kind 出来"。
 */
function extractCards(payload, ctx = {}) {
  const arr = Array.isArray(payload) ? payload
    : Array.isArray(payload?.cards) ? payload.cards
      : Array.isArray(payload?.data) ? payload.data
        : Array.isArray(payload?.items) ? payload.items : [];
  const out = [];
  arr.forEach((raw, i) => {
    const c = normalizeCard(raw, { ...ctx, order: (ctx.order || 0) + i });
    if (c) out.push(c);
  });
  // 被丢掉的**原始类别**：模型读到了东西却没接住时，用户要能知道它写的是什么类别
  // （最常见就是类别不在六类里，或者名字为空）—— 只说"丢弃了 3 条"没法动手修
  const rawKinds = [...new Set(arr.map((r) => String(r?.kind ?? r?.type ?? '').trim()).filter(Boolean))].slice(0, 8);
  return { cards: out, raw_count: arr.length, raw_kinds: rawKinds };
}

/**
 * 抽取结果的**逐块**分类（批 8 补 18）。
 *
 * 为什么必须分开：分块抽取一次跑几十段，模型对每段的回答有四种含义完全不同的结局，
 * 而此前它们被压成同一个"失败"：
 *   · `ok`      抽到了卡片 —— 正常。
 *   · `empty`   模型**明确**返回 `{"cards":[]}` —— 这段原文确实没有可抽的信息
 *               （过场、景物描写、重复铺垫都很常见）。**这不是失败**，
 *               报成失败会让"部分失败 8 段"天天挂着，用户很快就学会无视它。
 *   · `dropped` 模型**返回了条目**，但全被 `normalizeCard` 丢掉（类别不认识 / 名字为空）
 *               —— 模型确实读到了东西，是我们没接住。**这是真丢数据**，
 *               最隐蔽：界面显示"这段没抽到"，看起来跟 `empty` 一模一样。
 *   · `failed`  调用失败或返回不可解析 —— 需要重试。
 * 判据只看 `raw_count` 与 `card_count` 的关系，所以是纯事实判定，不猜。
 *
 * @param {{cardCount?:number, rawCount?:number, error?:string}} o
 * @returns {'ok'|'empty'|'dropped'|'failed'}
 */
function classifyChunk(o = {}) {
  const cardCount = Math.max(0, Number(o.cardCount) || 0);
  const rawCount = Math.max(0, Number(o.rawCount) || 0);
  if (String(o.error || '').trim()) return 'failed';
  if (cardCount > 0) return 'ok';
  if (rawCount > 0) return 'dropped';
  return 'empty';
}

const CHUNK_STATE_LABELS = {
  ok: '已抽取',
  empty: '无信息',
  dropped: '被丢弃',
  failed: '抽取失败',
  unknown: '未体检',
  pending: '未抽完',
};

function chunkStateLabel(state) {
  return CHUNK_STATE_LABELS[state] || String(state || '');
}

/** 这段的状态要不要人来管：只有"真失败"和"真丢数据"才需要补抽。 */
function chunkNeedsRetry(state) {
  return state === 'failed' || state === 'dropped';
}

/**
 * 卡片覆盖了哪些块：从 `evidence`（并集自跨块合并）与 `chunk_index` 收集。
 * 界面上"这条是从哪段读出来的"就靠它，体检"哪段一条都没有"也靠它。
 */
function chunkIndexesFromCards(cards) {
  const set = new Set();
  (Array.isArray(cards) ? cards : []).forEach((c) => {
    const ev = Array.isArray(c?.evidence) ? c.evidence : [];
    ev.forEach((i) => { if (Number.isInteger(i) && i >= 0) set.add(i); });
    if (Number.isInteger(c?.chunk_index) && c.chunk_index >= 0) set.add(c.chunk_index);
  });
  return [...set].sort((a, b) => a - b);
}

/** 落库前的清洗：脏值不能让体检面板把不存在的块号画出来。 */
function normalizeChunkStates(v, chunkCount = 0) {
  const out = [];
  const seen = new Set();
  (Array.isArray(v) ? v : []).forEach((r) => {
    if (!r || typeof r !== 'object') return;
    const index = Number(r.index);
    if (!Number.isInteger(index) || index < 0) return;
    if (chunkCount > 0 && index >= chunkCount) return;
    if (seen.has(index)) return;
    seen.add(index);
    out.push({
      index,
      state: ['ok', 'empty', 'dropped', 'failed'].includes(r.state) ? r.state : 'failed',
      cards: Math.max(0, Number(r.cards) || 0),
      raw_count: Math.max(0, Number(r.raw_count) || 0),
      raw_kinds: (Array.isArray(r.raw_kinds) ? r.raw_kinds : []).map((k) => String(k).slice(0, 40)).slice(0, 8),
      error: String(r.error || '').slice(0, 300),
    });
  });
  return out.sort((a, b) => a.index - b.index);
}

/**
 * 抽取覆盖体检（批 8 补 18）：纯本地、一次模型都不调（与体检/分集/过期判定同一条纪律）。
 *
 * 两种数据都要能吃：
 *  · 有 `chunk_states`（本轮之后的解析）：逐块给出真实分类。
 *  · 没有（本轮之前的老原著）：只能按卡片 `evidence` 反推"哪些块有卡片"，
 *    没卡片的块标成 `unknown` —— **不能说它"没信息"**（那是模型明确回答才知道的事），
 *    也不能说它"漏了"。标 unknown 并**列进候选**，让用户自己决定要不要补抽。
 *    这是"宁可说不知道，也不猜"的同一纪律（同过期体检的 unknown）。
 *
 * @returns {{counts:object, needs_retry:number[], states:object[], has_states:boolean,
 *            unknown_indexes:number[], empty_indexes:number[]}}
 */
function summarizeExtraction({ chunkCount = 0, chunkStates = [], coveredIndexes = [] } = {}) {
  const total = Math.max(0, Number(chunkCount) || 0);
  const states = normalizeChunkStates(chunkStates, total);
  const hasStates = states.length > 0;
  const byIndex = new Map(states.map((r) => [r.index, r]));
  const covered = new Set((Array.isArray(coveredIndexes) ? coveredIndexes : []).filter((i) => Number.isInteger(i) && i >= 0));
  const rows = [];
  const counts = { ok: 0, empty: 0, dropped: 0, failed: 0, unknown: 0, pending: 0 };
  for (let i = 0; i < total; i++) {
    const rec = byIndex.get(i);
    let state;
    if (rec) {
      state = rec.state;
      // 记录说没抽到、但卡片实际覆盖了这一块（人工补过卡 / 归并结果）：以卡片为准
      if (state !== 'ok' && covered.has(i)) state = 'ok';
    } else if (covered.has(i)) {
      // 没有逐块记录、但有卡片覆盖这一块（人工补过卡，或记录丢失）：以卡片为准
      state = 'ok';
    } else if (!hasStates) {
      state = 'unknown';
    } else {
      // 有逐块记录却缺这一块：多半是取消/中断没跑到 —— 既不是"没信息"也不是"漏抽"，
      // 但确实**还没抽**，所以要列进可补抽的候选
      state = 'pending';
    }
    counts[state] = (counts[state] || 0) + 1;
    rows.push({
      index: i, state,
      cards: rec ? rec.cards : 0,
      raw_count: rec ? rec.raw_count : 0,
      raw_kinds: rec ? rec.raw_kinds : [],
      error: rec ? rec.error : '',
    });
  }
  // pending 也要能补抽：取消/中断留下的段本来就该重跑（它不是"没信息"）
  const needsRetry = rows.filter((r) => chunkNeedsRetry(r.state) || r.state === 'pending').map((r) => r.index);
  // 老数据：没记录的块是候选，但状态仍是 unknown —— 补抽是安全的（只补不删）
  const unknownIndexes = rows.filter((r) => r.state === 'unknown').map((r) => r.index);
  return {
    counts,
    states: rows,
    has_states: hasStates,
    needs_retry: hasStates ? needsRetry : unknownIndexes,
    unknown_indexes: unknownIndexes,
    empty_indexes: rows.filter((r) => r.state === 'empty').map((r) => r.index),
  };
}

/** 体检结论写成一句话（面板与 toast 共用，避免两处口径走偏）。 */
function extractionNote(sum) {
  const c = sum?.counts || {};
  const parts = [];
  if (c.ok) parts.push(`${c.ok} 段抽到卡片`);
  if (c.empty) parts.push(`${c.empty} 段确认无信息`);
  if (c.dropped) parts.push(`${c.dropped} 段有条目被丢弃`);
  if (c.failed) parts.push(`${c.failed} 段抽取失败`);
  if (c.unknown) parts.push(`${c.unknown} 段未体检`);
  if (c.pending) parts.push(`${c.pending} 段没跑完`);
  if (!parts.length) return '还没有可体检的段落';
  return parts.join('，');
}

/**
 * 渲染模板里的 {{变量}}。前端 scripts.js 有一份等价实现（buildMessages），
 * 这里是服务端侧的那一份 —— 原著解析要按块循环调用，不能靠前端逐块发请求
 * （几十次请求会让"用户关掉页面"变成半途而废）。两份都必须"未填变量不留 {{}} 痕迹"。
 */
/**
 * 一致性体检（批 8 补 3）：把"卡片库里那些会悄悄毁掉一致性的机械问题"一次性查出来。
 *
 * 为什么用纯函数而不是再问一次模型：
 *  · 这里每一条都是**可判定的事实**（同名、缺字段、别名撞名、没入资产库），不是主观判断；
 *  · 交给模型只会带来"同一份数据两次体检结论不同"，用户就再也不敢信这个报告了；
 *  · 而且体检要能随时跑、不花钱 —— 花钱才能查一致性的工具，用户会不敢点。
 * 真正需要人（或模型）拍板的只有"两处描述哪个对"，那种我们**如实列出冲突值**，不替用户决定。
 *
 * @param {Array} cards 项目下的卡片（已规范化/可能被人工编辑过）
 * @param {{assetCardIds?:Set<string>|Array<string>, characterKinds?:Array<string>}} opts
 * @returns {{issues:Array, counts:{warn:number,info:number,fixable:number}}}
 */
function auditCards(cards, opts = {}) {
  const list = (Array.isArray(cards) ? cards : []).filter((c) => c && c.kind);
  const asset = opts.assetCardIds instanceof Set ? opts.assetCardIds : new Set(opts.assetCardIds || []);
  const issues = [];
  const push = (o) => { issues.push({ card_ids: [], fixable: false, ...o }); };

  // ① 同名同类别多张卡：跨来源解析（或人工新建）都会产生。不收敛的后果是下游重复注入、
  //    用户面对 5 个"林晚"没法确认哪个算数 —— 这是最该自动修的一条。
  const groups = new Map();
  for (const c of list) {
    const k = `${c.kind}::${nameKey(c.name)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  for (const [k, group] of groups) {
    if (group.length < 2) continue;
    // 冲突字段：合并时"更详细的描述取胜"，被丢掉的那个值必须让用户看见（否则是静默丢信息）
    const conflicts = [];
    for (const f of CARD_FIELDS[group[0].kind] || []) {
      const vals = [...new Set(group.map((c) => str(c[f]).trim()).filter(Boolean))];
      if (vals.length > 1) conflicts.push({ field: f, values: vals });
    }
    push({
      code: 'dup_name', level: 'warn', fixable: true,
      title: `${CARD_KIND_LABELS[group[0].kind] || group[0].kind}「${str(group[0].name)}」有 ${group.length} 张`,
      detail: conflicts.length
        ? `合并时会保留更详细的描述，以下字段存在不同说法（请核对后再合并）：${conflicts.map((x) => `${x.field}=${x.values.join(' / ')}`).join('；')}`
        : '同名同类别应当收敛成一张，否则下游会重复注入、界面上也没法确认哪张算数。',
      card_ids: group.map((c) => c.id).filter(Boolean),
      conflicts,
    });
  }

  // ② 别名撞名：一张卡的别名恰好是另一张卡（同类）的名字 —— 最典型的"张冠李戴"来源
  const byName = new Map();
  for (const c of list) byName.set(`${c.kind}::${nameKey(c.name)}`, c);
  for (const c of list) {
    for (const al of c.aliases || []) {
      const other = byName.get(`${c.kind}::${nameKey(al)}`);
      if (!other || other === c) continue;
      push({
        code: 'alias_collision', level: 'warn', fixable: true,
        title: `「${str(c.name)}」的别名「${str(al)}」与另一张${CARD_KIND_LABELS[c.kind] || c.kind}同名`,
        detail: `同一句话里出现「${str(al)}」时，无法判断指的是「${str(c.name)}」还是「${str(other.name)}」——建议删掉这个别名，或把两张卡合并。`,
        card_ids: [c.id, other.id].filter(Boolean),
        alias: str(al),
      });
    }
  }

  // ③ 可注入类卡片却没有可注入字段：绑到分镜上也不会生效（"显示已绑定却什么也没发生"）
  for (const c of list) {
    if (!STORY_INJECT_KINDS.includes(c.kind)) continue;
    const injFields = STORY_INJECT_FIELDS[c.kind];
    // 两张表（体检表 / 注入表）的一致性由 selftest 钉住；这里再兜一层，宁可漏报也不让体检整体崩掉
    if (!injFields) continue;
    const has = injFields.some((f) => str(c[f]).trim());
    if (has) continue;
    push({
      code: 'no_inject', level: 'warn', fixable: false,
      title: `${CARD_KIND_LABELS[c.kind]}「${str(c.name)}」没有任何可注入的描述`,
      detail: `分镜绑上它也不会改变提示词。去卡片里补上${injFields.map((f) => STORY_FIELD_LABELS[f] || f).join('、')}中的任意一项。`,
      card_ids: [c.id].filter(Boolean),
    });
  }

  // ④ 人物卡没有长相/服装：进了资产库也拿不到"跨镜头同一张脸"这个最大好处
  for (const c of list) {
    if (c.kind !== 'character') continue;
    if (str(c.appearance).trim() || str(c.outfit).trim()) continue;
    push({
      code: 'char_no_look', level: 'info', fixable: false,
      title: `人物卡「${str(c.name)}」没有外貌与服装`,
      detail: '角色库注入提示词靠的就是这两项；不补的话，这个角色在不同镜头里只能靠模型自由发挥。',
      card_ids: [c.id].filter(Boolean),
    });
  }

  // ⑤ 剧情卡没有幕次：排不出"起承转合"，也就没法自动分集
  for (const c of list) {
    if (c.kind !== 'plot' || str(c.stage).trim()) continue;
    push({
      code: 'plot_no_stage', level: 'info', fixable: false,
      title: `剧情卡「${str(c.name)}」没有标幕次`,
      detail: '标上「起/承/转/合」之后，剧情卡才能按幕排出分集大纲。',
      card_ids: [c.id].filter(Boolean),
    });
  }

  // ⑥ 时间线卡没有时间点：时间线等于没写
  for (const c of list) {
    if (c.kind !== 'timeline' || str(c.when).trim()) continue;
    push({
      code: 'timeline_no_when', level: 'info', fixable: false,
      title: `时间线「${str(c.name)}」没有时间点`,
      detail: '补上「第三天黄昏」这类时间锚点，跨集的时间推进才不会自相矛盾。',
      card_ids: [c.id].filter(Boolean),
    });
  }

  // ⑦ 人物卡还没进资产库：一致性红利没拿到（一键可修）
  const pending = list.filter((c) => c.kind === 'character' && !asset.has(c.id));
  if (pending.length) {
    push({
      code: 'char_not_in_asset', level: 'info', fixable: true,
      title: `${pending.length} 张人物卡还没进资产库`,
      detail: '进资产库后角色才能被分镜绑定、被出图注入长相——这是"跨镜头同一张脸"的前提。',
      card_ids: pending.map((c) => c.id).filter(Boolean),
    });
  }

  const counts = {
    warn: issues.filter((i) => i.level === 'warn').length,
    info: issues.filter((i) => i.level === 'info').length,
    fixable: issues.filter((i) => i.fixable).length,
  };
  return { issues, counts };
}

/**
 * 把一组同类别同名的卡片并成一张（体检的"合并"修复）。
 * 保留 id 最小（最早创建）的那张作为存活卡，其余并进去后返回待删除 id 列表 ——
 * 这样引用方（分镜的 story_card_ids）指向的 id 只要还在列表里就不会变成悬空引用。
 * @returns {{cards:Array, keep:object|null, removed:string[]}}
 */
function mergeCardGroup(cards, ids) {
  const all = Array.isArray(cards) ? cards : [];
  const want = new Set(ids || []);
  const group = all.filter((c) => want.has(c.id));
  if (group.length < 2) return { cards: [...all], keep: null, removed: [] };
  const sorted = [...group].sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
  let keep = sorted[0];
  for (const other of sorted.slice(1)) keep = mergeTwo(keep, other);
  keep = { ...keep, id: sorted[0].id, aliases: normalizeAliases(keep.aliases) };
  const removed = sorted.slice(1).map((c) => c.id);
  return { cards: all.map((c) => (c.id === keep.id ? keep : c)).filter((c) => !removed.includes(c.id)), keep, removed };
}

/**
 * 镜头 → 该绑定谁（批 8 补 5）：从镜头的"出场人物"与提示词文本里认出项目里的角色与可注入卡片。
 *
 * 为什么值得自动做：分镜表是**模型生成的**，它只会把"谁出场"写成自由文本（`characters`），
 * `character_ids` 这类结构化绑定是空的 —— 于是每个镜头都要人挨个点一遍，不点就**静默失去**外貌注入
 * （同一张脸在不同镜头里漂移，且没有任何报错）。这里的匹配是可判定的（名字/别名是否出现），
 * 所以不该花钱、也不该让人手工做。
 *
 * 但"可判定"不等于"永远对"：中文名字会撞上普通词（"小雨"既可以是角色也可以是天气）。
 * 因此结果分成两档，**自动化只吃高置信的那一档**：
 *  · `via='characters'`（强）：名字出现在模型自己写的"出场人物"字段里 —— 这是它明确说了"谁出场"；
 *  · `via='prompt'`（弱）：只在画面描述/台词/旁白里出现过 —— 可能是巧合，只报给人看，不自动绑。
 * 名字长度 < 2 的一律不匹配（单字名撞词概率太高，宁可漏也不要错绑）。
 *
 * @returns {{chars:Array, cards:Array, strong:number, weak:number}}
 *          每项 {id,name,kind,via,weak,hit,at}；`hit` 是实际命中的那个名字（可能是别名）。
 */
function matchShotBindings(shot, opts = {}) {
  const s = shot || {};
  const chars = Array.isArray(opts.characters) ? opts.characters.filter(Boolean) : [];
  const cards = (Array.isArray(opts.cards) ? opts.cards : [])
    .filter((c) => c && c.id && STORY_INJECT_KINDS.includes(c.kind));
  const strongText = str(s.characters);
  const weakText = [s.scene_description, s.action, s.dialogue, s.narration, s.scene, s.image_prompt, s.video_prompt]
    .map(str).join(' \n ');
  const boundChars = new Set(Array.isArray(s.character_ids) ? s.character_ids : []);
  const boundCards = new Set(Array.isArray(s.story_card_ids) ? s.story_card_ids : []);

  const collect = (rows, bound, kind) => {
    const rows2 = rows.filter((r) => !bound.has(r.id));
    const strongLongest = longestAt(strongText, rows2);
    const weakLongest = longestAt(weakText, rows2);
    const out = [];
    for (const r of rows2) {
      const names = bindNames(r);
      if (!names.length) continue;
      const strong = pickHit(hitAll(strongText, names), strongLongest);
      const weak = strong ? null : pickHit(hitAll(weakText, names), weakLongest);
      const hit = strong || weak;
      if (!hit) continue;
      out.push({
        id: r.id, name: str(r.name), kind,
        via: strong ? 'characters' : 'prompt',
        weak: !strong, hit: hit.name, at: hit.index,
      });
    }
    return out.sort((x, y) => (x.at - y.at) || String(x.name).localeCompare(String(y.name)));
  };
  const charHits = collect(chars, boundChars, 'character');
  const cardHits = collect(cards, boundCards, 'card');
  const all = charHits.concat(cardHits);
  return { chars: charHits, cards: cardHits, strong: all.filter((x) => !x.weak).length, weak: all.filter((x) => x.weak).length };
}

/** 一行数据的可匹配名：本名 + 别名（角色的 alias 是"、"分隔的字符串，卡片的 aliases 是数组） */
function bindNames(row) {
  const out = [str(row && row.name).trim()];
  const a = row && row.aliases;
  if (Array.isArray(a)) a.forEach((x) => out.push(str(x).trim()));
  if (row && typeof row.alias === 'string') str(row.alias).split(/[、,，/|]/).forEach((x) => out.push(x.trim()));
  // 单字名不进匹配池：中文里撞普通词的概率太高（"雪""雨"），宁可漏也不要错绑
  return [...new Set(out.filter((n) => n.length >= 2))];
}

/** 文本里所有名字的出现位置（每行最多留 8 个，避免长文里同一名字刷屏） */
function hitAll(text, names) {
  const t = str(text).toLowerCase();
  const hits = [];
  for (const n of names) {
    const ln = n.toLowerCase();
    let i = t.indexOf(ln);
    while (i >= 0 && hits.length < 8) {
      hits.push({ index: i, name: n });
      i = t.indexOf(ln, i + 1);
    }
  }
  return hits.sort((a, b) => (a.index - b.index) || (b.name.length - a.name.length));
}

/** 每个位置上的最长命中长度（跨所有行）：用来判断某个命中是否被更长的名字"罩住" */
function longestAt(text, rows) {
  const map = new Map();
  for (const r of rows) {
    for (const h of hitAll(text, bindNames(r))) {
      if (!map.has(h.index) || h.name.length > map.get(h.index)) map.set(h.index, h.name.length);
    }
  }
  return map;
}

/** 取最早的那个"在该位置就是最长命中"的出现；被长名罩住的短名跳过（"林晚秋"不该同时绑上"林晚"） */
function pickHit(hits, longest) {
  return hits.find((h) => longest.get(h.index) === h.name.length) || null;
}

/**
 * 提示词里**写死的画风/媒介词**（批 8 补 7）。
 *
 * 本项目的画风是**在使用点统一注入**的（`artStylePhrase` 把项目画风拼到提示词尾部），
 * 好处是"改一次设置，全剧所有镜头跟着变"。但这条链路有一个静默失效：
 * 镜头提示词里一旦写死了画风词（模型自己写的、或用户从别处粘来的），
 * 图片模型就同时收到两套风格 —— 改了项目画风，图**不会变**，而界面上没有任何提示。
 *
 * 词表只收**明确的媒介/画风词**（anime / oil painting / 水彩 …），
 * 不收 cinematic / detailed / realistic 这类"画面质量词"：那些是镜头内容的一部分，报了只会刷屏。
 */
const STYLE_WORDS = [
  // 与 lib/routes.js 的 ART_STYLE_MAP **值**同源：整条短语优先命中（删得干净），
  // selftest 有棘轮逐条钉住"每一种项目画风词都认得"
  'japanese anime style, thick painterly shading', 'japanese anime style, clean linework',
  'donghua realistic style, detailed textures', 'studio ghibli inspired, soft watercolor tones',
  'watercolor illustration, soft paper texture', 'oil painting style, visible brush strokes',
  'cyberpunk aesthetic, neon glow', 'pixel art style',
  'black and white manga, screentone shading', '3d render, cinematic lighting',
  // 短语前缀：整条短语没命中时，命中更长的一段（删掉后不会留下孤零零的 "style"）
  'japanese anime style', 'donghua realistic style', 'studio ghibli inspired',
  'watercolor illustration', 'oil painting style', 'cyberpunk aesthetic', 'black and white manga',
  'japanese anime', 'anime style', 'anime', 'manga', 'donghua', 'studio ghibli', 'ghibli',
  'cyberpunk', 'watercolor', 'oil painting', 'pixel art', 'cel shad', 'screentone',
  '3d render', 'cgi', 'cartoon', 'comic', 'sketch', 'line art', 'linework', 'photorealistic',
  '日漫', '国漫', '动漫', '漫画', '厚涂', '水彩', '油画', '吉卜力', '赛博朋克', '像素', '黑白漫画', '3d渲染', '3D渲染', '插画', '手绘',
];

/** 找出提示词里所有写死的画风词（同位置取更长的那条，避免 "oil painting" 与 "painting" 重复报） */
function styleWordHits(text) {
  const t = str(text).toLowerCase();
  const raw = [];
  for (const w of STYLE_WORDS) {
    const lw = w.toLowerCase();
    // 英文词要求词边界（"comic" 不该在 "comical" 里命中）；中文没有词边界，直接找
    const re = /^[a-z0-9 ]+$/.test(lw)
      ? new RegExp(`(?<![a-z0-9])${lw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'g')
      : null;
    if (re) {
      let m = re.exec(t);
      while (m) { raw.push({ word: w, at: m.index, len: lw.length }); m = re.exec(t); }
    } else {
      let i = t.indexOf(lw);
      while (i >= 0) { raw.push({ word: w, at: i, len: lw.length }); i = t.indexOf(lw, i + 1); }
    }
  }
  // 重叠的命中只留一条（同位置先到先得、长的优先）："japanese anime style" 不该同时报出三条
  const sorted = raw.slice().sort((a, b) => (a.at - b.at) || (b.len - a.len));
  const kept = [];
  for (const x of sorted) {
    if (kept.some((y) => x.at < y.at + y.len && y.at < x.at + x.len)) continue;
    kept.push(x);
  }
  return kept.sort((a, b) => a.at - b.at);
}

/**
 * 画风写死体检（批 8 补 7）：按**词**聚合，报出"这些镜头的提示词写死了画风"。
 *
 * @param {Array} shots 分镜（读 image_prompt / video_prompt）
 * @param {{style?: string, stylePhrase?: string}} opts `stylePhrase` = 当前项目画风真正会注入的英文短语，
 *        用来把问题分成两档：与当前画风**冲突**（warn，现在就会两套风格打架）/
 *        与当前画风**一致**（info，今天不出错，但"改设置就全剧跟着变"这条链路已经废了）
 */
function auditPromptStyle(shots, opts = {}) {
  const list = (Array.isArray(shots) ? shots : []).filter(Boolean);
  const style = str(opts.style).trim();
  const phrase = str(opts.stylePhrase).toLowerCase();
  const groups = new Map();
  for (const s of list) {
    for (const field of ['image_prompt', 'video_prompt']) {
      for (const h of styleWordHits(s[field])) {
        const key = h.word.toLowerCase();
        if (!groups.has(key)) {
          groups.set(key, {
            code: 'shot_style_baked', word: h.word, style,
            same: !!phrase && phrase.includes(key), shot_ids: [], shots: [],
          });
        }
        const g = groups.get(key);
        if (g.shot_ids.includes(s.id)) continue;
        g.shot_ids.push(s.id);
        g.shots.push({ id: s.id, shot_number: s.shot_number, episode_number: s.episode_number, field });
      }
    }
  }
  const issues = [...groups.values()].map((g) => ({
    code: g.code, level: g.same ? 'info' : 'warn', fixable: true, fix_code: 'strip_style_word',
    title: `${g.shot_ids.length} 个镜头的提示词写死了画风词「${g.word}」`,
    detail: g.same
      ? `这些镜头的提示词里已经写了「${g.word}」，与当前项目画风（${g.style || '未设置'}）一致，今天不会出错；但画风是**使用点统一注入**的 —— 写死在提示词里意味着以后改项目画风，这些镜头不会跟着变。删掉即可交还给项目设置。`
      : `这些镜头的提示词里写了「${g.word}」，与当前项目画风（${g.style || '未设置'}）不是同一套 —— 图片模型会同时收到两套风格，改项目画风也不会生效。删掉这个词，画风由项目设置统一决定。`,
    target_id: `word::${g.word}`, target_name: g.word, word: g.word,
    shot_ids: g.shot_ids, shots: g.shots,
  })).sort((a, b) => (a.level === b.level ? b.shot_ids.length - a.shot_ids.length : (a.level === 'warn' ? -1 : 1)));
  const counts = { warn: 0, info: 0, fixable: 0 };
  for (const i of issues) { counts[i.level]++; if (i.fixable) counts.fixable++; }
  return { issues, counts, scanned: list.length };
}

/** 从提示词里删掉一个写死的画风词（并把留下的多余逗号/空格收拾干净） */
function stripStyleWord(text, word) {
  const src = str(text);
  const w = str(word);
  if (!src || !w) return src;
  let out = src;
  if (/^[a-z0-9 ]+$/i.test(w)) {
    out = out.replace(new RegExp(`(?<![a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'gi'), '');
  } else {
    out = out.split(w).join('');
  }
  return out
    .replace(/\s*,\s*(?=,)/g, '')      // 连续逗号
    .replace(/^[\s,]+|[\s,]+$/g, '')   // 首尾逗号
    .replace(/\s{2,}/g, ' ')
    .replace(/,\s*,/g, ',')
    .trim();
}

/**
 * 「出场人物」里那些**在角色库里找不到**的名字（批 8 补 6）。
 *
 * 为什么值得单独报：这类镜头**一定**没有外貌注入（连绑定都建不起来），而且不报错 ——
 * 根源是模型不知道项目里已有哪些角色，于是"女主""少女""苏婉儿"三种叫法混着写。
 * 预防手段是把角色名册写进生成提示词（`characterRoster`），这里是它的**验收**：
 * 名册生效之后这一项应该一直是空的。
 *
 * 只做**精确整词**比对（不比对子串）：`出场人物` 是一个个名字用顿号隔开的字段，
 * 整词比对不会把"林晚秋"错认成"林晚"。收集词太泛（"路人""众人"）的不报，避免刷屏。
 */
const UNKNOWN_NAME_STOP = ['两人', '三人', '四人', '多人', '众人', '所有人', '人群', '群众', '围观群众', '路人', '群演', '若干人', '其他', '画外音', '旁白'];

/** 把一个候选词收拾干净：去掉尾注（"少女（路人）"→"少女"），整体括起来的只脱括号（"（画外）"→"画外"） */
function cleanShotName(x) {
  return str(x).trim()
    .replace(/^(.+?)[（(][^（()）]*[)）]$/, '$1')
    .replace(/^[（(](.*?)[)）]$/, '$1')
    .trim();
}

/** 把「出场人物」字段拆成一个个名字（顿号/逗号/斜杠/分号/空格分隔） */
function splitShotCharacters(text) {
  return [...new Set(str(text).split(/[、,，/|;；\s]+/)
    .map(cleanShotName)
    .filter((x) => x.length >= 2 && !UNKNOWN_NAME_STOP.includes(x)))];
}

/**
 * 文本指纹（批 8 补 12）：FNV-1a 32 位，纯函数、无依赖、同一输入永远同一结果。
 *
 * 用途是"**判断生成时的输入有没有变过**"，不是加密，也不要求抗碰撞 ——
 * 撞一次的概率是 1/2^32，而代价只是漏报一次"该重生成"，用户下一轮还会看见。
 */
function digestText(v) {
  const s = v == null ? '' : String(v);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0; // 32 位无符号乘法（避免浮点误差）
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 生成某一集剧本时**实际喂给模型的东西**的指纹（本集拍表 + 前情提要）。
 *
 * 为什么把前情也算进去：前情是从**更早的集**推出来的 —— 只对拍表取指纹的话，
 * 前面几集改了、这一集的拍表没动，指纹不变，可模型看到的上下文已经变了。
 * @returns {string} 8 位十六进制；这一集不存在时返回空串
 */
function episodeInputDigest(plan, ep, opts = {}) {
  const brief = episodeBriefText(plan, ep);
  if (!brief) return '';
  const prior = priorBrief(plan, ep, { maxChars: opts.priorMax });
  return digestText(`${brief}\n---\n${opts.withPrior === false ? '' : prior.text}`);
}

/**
 * 剧本 / 分镜的"过期体检"（批 8 补 12）。
 *
 * 为什么需要：生成剧本与分镜都要**花钱**，而它们的输入（分集骨架 + 前情、剧本正文）会变 ——
 * 原著追加解析会补全剧情卡、重切分集会让拍表重新分组。输入变了、产物没重生成，
 * 用户手里就是"一份看起来好好的、其实跟原著对不上的剧本"。这里**纯本地**判断，
 * 一次模型都不调，所以可以随时看、反复看。
 *
 * 三种状态要分清（"不知道"不能当成"没过期"）：
 *   · ok      —— 有指纹且与当前输入一致
 *   · stale   —— 有指纹且不一致（该重生成）
 *   · unknown —— 没有指纹（本轮之前生成的、或单集手写/粘贴来的），**不能替用户断言它没过期**
 * @param {object} plan planEpisodes 的结果
 * @param {Array} scripts 剧本行（带 episode_number / plan_digest）
 * @param {Array} shots 分镜行（带 episode_number / source_script_id / script_digest）
 * @returns {{episodes:Array, counts:object, notes:Array}}
 */
/**
 * 全链路进度体检（批 8 补 16）。
 *
 * 为什么需要：这条链有七段（原著 → 卡片 → 分集骨架 → 剧本 → 分镜 → 图片 → 视频），
 * 每段各自在**不同的页面**上，用户想知道"我现在卡在哪一步、下一步该点哪儿"必须自己拼。
 * 更糟的是**半成品状态没有任何提示**：解析完卡片但没分集、有剧本但只有一半的集、分镜齐了但一张图都没出 ——
 * 这些都不是错误，但都需要有人告诉用户下一步做什么。
 *
 * 判据纯本地（与体检/分集/过期判定同一条纪律：**一次模型都不调**），所以随时可跑、不花钱。
 * 每段给出 `have` / `need` / `state`（`done|partial|todo|blocked`）/ `next`（该去哪一页做什么）。
 * `blocked` 专门表示"前置还没做"—— 与 `todo`（前置好了，轮到你了）必须分开：
 * 前者点进去也做不了，后者点进去就能做。两者混在一起，用户会照着做却发现按钮是灰的。
 *
 * @returns {{steps:Array, counts:Object, next_step:string, ready:boolean, notes:Array}}
 */
function pipelineOverview(input = {}) {
  const sources = num0(input.sources);
  const cards = num0(input.cards);
  const plotCards = num0(input.plotCards);
  const episodes = num0(input.episodes);
  const scripts = num0(input.scripts);        // 已保存的分集剧本条数（按集去重后的集数）
  const shots = num0(input.shots);            // 分镜镜头总数
  const images = num0(input.images);          // 已出图的分镜数
  const videos = num0(input.videos);          // 已有视频的分镜数
  const steps = [];
  const add = (key, label, have, need, page, action) => {
    const state = have >= need && need > 0 ? 'done' : (have > 0 ? 'partial' : 'todo');
    steps.push({ key, label, have, need, state, page, action, unit: '' });
  };
  add('source', '原著落库', sources, 1, 'novel', '粘贴或上传小说原文');
  add('cards', '解析出卡片', cards, 1, 'novel', '点「解析」抽卡片（可追加解析）');
  add('episodes', '分集骨架', episodes, 1, 'novel', '看「分集大纲」并按每集拍数重切');
  add('scripts', '分集剧本', scripts, Math.max(episodes, 1), 'scripts', '用「逐集生成」按集生成剧本');
  add('shots', '分镜', shots, Math.max(scripts, 1), 'storyboards', '用「逐集生成分镜」按集拆镜');
  add('images', '分镜图', images, Math.max(shots, 1), 'storyboards', '批量出图（每张都计费）');
  add('videos', '分镜视频', videos, Math.max(shots, 1), 'storyboards', '批量出视频（每条都计费）');
  // 前置未完成 → 后续一律 blocked（点进去也做不了），而不是 todo
  let gated = false;
  for (const st of steps) {
    if (gated && st.state === 'todo') { st.state = 'blocked'; st.gated_by = steps[steps.indexOf(st) - 1].key; }
    if (st.state === 'todo' || st.state === 'blocked') gated = true;
  }
  const first = steps.find((st) => st.state === 'partial' || st.state === 'todo');
  const counts = {};
  for (const st of steps) counts[st.state] = (counts[st.state] || 0) + 1;
  const notes = [];
  if (cards && !plotCards) notes.push('卡片里还没有剧情卡 —— 分集骨架是按剧情卡排的，先去原著页补出剧情卡');
  if (episodes && scripts && scripts < episodes) notes.push(`分集骨架 ${episodes} 集，只有 ${scripts} 集有剧本 —— 剩下 ${episodes - scripts} 集还没写`);
  if (shots && images < shots) notes.push(`${shots} 个镜头里 ${shots - images} 个还没有分镜图`);
  return {
    steps, counts,
    next_step: first ? first.key : '',
    next_label: first ? first.label : '',
    ready: !first,
    notes,
  };
}

function num0(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function auditStaleness(plan, scripts, shots, opts = {}) {
  const eps = ((plan || {}).episodes || []);
  const scriptList = (Array.isArray(scripts) ? scripts : []).filter(Boolean);
  const shotList = (Array.isArray(shots) ? shots : []).filter(Boolean);
  const withPrior = opts.withPrior !== false;
  const priorMax = opts.priorMax;
  // 同一集可能存了多份剧本（重生成一次就多一条）：以**最新**的一条为准，与界面一致
  const latest = new Map();
  for (const sc of scriptList) {
    const n = Number(sc.episode_number) || 0; // 行上是 episode_number，不是分集对象的 index
    if (n < 1) continue;
    const cur = latest.get(n);
    if (!cur || String(sc.created_at || '') >= String(cur.created_at || '')) latest.set(n, sc);
  }
  const out = [];
  for (const e of eps) {
    const n = Number(e.index) || 0;
    const cur = latest.get(n) || null;
    const want = episodeInputDigest(plan, n, { withPrior, priorMax });
    let scriptState = 'missing';
    if (cur) {
      const have = str(cur.plan_digest).trim();
      scriptState = !have ? 'unknown' : (have === want ? 'ok' : 'stale');
    }
    // 分镜：按"生成它的那份剧本现在还在不在、内容变没变"判断
    const mine = shotList.filter((x) => (Number(x.episode_number) || 0) === n);
    let shotState = mine.length ? 'ok' : 'missing';
    if (mine.length) {
      const srcIds = [...new Set(mine.map((x) => str(x.source_script_id).trim()).filter(Boolean))];
      if (!srcIds.length) shotState = 'unknown'; // 不知道是哪份剧本生成的（早期数据/手工导入）
      else {
        const curScript = srcIds.map((id) => scriptList.find((x) => String(x.id) === id)).find(Boolean) || null;
        if (!curScript) shotState = 'stale'; // 源剧本被删了：分镜已经无从追溯
        else {
          const have = str(mine[0].script_digest).trim();
          shotState = !have ? 'unknown' : (have === digestText(curScript.content) ? 'ok' : 'stale');
        }
      }
    }
    out.push({
      episode_number: n, title: str(e.title), beats: Number(e.beat_count) || 0,
      script_id: cur ? cur.id : null, script_title: cur ? str(cur.title) : '',
      script_state: scriptState, input_digest: want,
      shots: mine.length, shot_state: shotState,
    });
  }
  const counts = {
    script_missing: out.filter((x) => x.script_state === 'missing').length,
    script_stale: out.filter((x) => x.script_state === 'stale').length,
    script_unknown: out.filter((x) => x.script_state === 'unknown').length,
    shot_missing: out.filter((x) => x.shot_state === 'missing').length,
    shot_stale: out.filter((x) => x.shot_state === 'stale').length,
    shot_unknown: out.filter((x) => x.shot_state === 'unknown').length,
  };
  const notes = [];
  if (!eps.length) notes.push('还没有分集骨架：先解析出剧情卡，才能判断剧本/分镜是否过期');
  if (counts.script_unknown) notes.push(`${counts.script_unknown} 集的剧本没有生成指纹（本轮之前生成的，或手工粘贴的），无法判断是否过期 —— 不计入"该重生成"`);
  if (counts.shot_unknown) notes.push(`${counts.shot_unknown} 集的分镜没有记录来源剧本，无法判断是否过期`);
  if (counts.script_stale || counts.shot_stale) notes.push('过期的含义是"生成时的输入已经变了"，不代表内容写错了 —— 重生成前建议先看一眼');
  return { episodes: out, counts, notes };
}

/**
 * 人物卡 ↔ 资产库的漂移体检（批 8 补 11）。
 *
 * 为什么需要：人物卡是"原著里读到的这个人"，资产库里的角色是"出图时真正注入的那份长相"。
 * 两者本来是**同一份数据的两面**（`cardToCharacter` 复制过去、并留下 `story_card_id` 指回来），
 * 但复制之后各走各的：原著追加解析补全了人物卡的外貌/别名/身份，资产库里那份还是导入时的旧样子 ——
 * 于是分镜按角色出图用的是旧长相，界面上却显示新描述。**这类不一致没有任何报错**，只会让同一张脸越画越不像。
 *
 * 判据只看**会注入提示词的字段**（`characterPhrase` 用 name/outfit/appearance，绑定靠 name/alias），
 * 不看 role/gender/age/personality 这些不影响出图的字段 —— 否则每张卡都会报"漂移"，用户会直接无视这个面板。
 * @param {Array} cards 人物卡（story_cards 里 kind=character 的）
 * @param {Array} chars 资产库角色（characters）
 * @returns {{issues:Array, counts:{warn:number,info:number,fixable:number}, scanned:number, pairs:number}}
 */
function auditCharacterDrift(cards, chars) {
  const list = (Array.isArray(cards) ? cards : []).filter((c) => c && c.kind === 'character' && c.id);
  const assets = (Array.isArray(chars) ? chars : []).filter(Boolean);
  const byCard = new Map();
  for (const a of assets) if (a.story_card_id) byCard.set(String(a.story_card_id), a);
  const issues = [];
  let pairs = 0;
  for (const card of list) {
    const ch = byCard.get(String(card.id));
    if (!ch) continue; // 还没入资产库：那是 char_not_in_asset 的事，不在本条重复报
    pairs++;
    const drift = [];
    const look = (a, b, label) => {
      const x = str(a).trim(); const y = str(b).trim();
      if (!x || x === y) return;                 // 卡里没写 → 没什么可漂移的
      if (!y) { drift.push({ field: label, card: x, asset: '' }); return; }  // 卡里有、库里空 → 出图少一段
      if (x !== y) drift.push({ field: label, card: x, asset: y });
    };
    look(card.appearance, ch.appearance, '外貌');
    look(card.outfit, ch.outfit, '服饰');
    // 别名：卡里新读出来的别名没同步过去，镜头上的「出场人物」写别名就绑不上（绑定按名字/别名匹配）
    const cardAl = (card.aliases || []).map((x) => str(x).trim()).filter(Boolean);
    const chAl = str(ch.alias).split(/[、,，\/|]/).map((x) => x.trim()).filter(Boolean);
    const missing = cardAl.filter((x) => !chAl.includes(x));
    if (missing.length) drift.push({ field: '别名', card: missing.join('、'), asset: chAl.join('、') || '（空）' });
    if (!drift.length) continue;
    const onlyAdd = drift.every((d) => !d.asset);   // 库里是空的 → 纯补全，不覆盖任何已有描述
    issues.push({
      code: 'char_drift', level: onlyAdd ? 'info' : 'warn', fixable: true, fix_code: 'sync_character',
      title: `资产库里的「${str(card.name)}」与人物卡不一致（${drift.map((d) => d.field).join('、')}）`,
      detail: onlyAdd
        ? `资产库里这几项是空的，出图时会少一段描述。同步只是把人物卡里读到的补过去，不会覆盖任何已有内容。`
        : `分镜按资产库出图、界面显示的是人物卡 —— 不一致时"看到的"和"画出来的"是两回事。`
          + `同步会以人物卡为准覆盖：${drift.map((d) => `${d.field}「${d.asset || '空'}」→「${d.card}」`).join('；')}`,
      card_ids: [card.id],
      character_ids: [ch.id],
      target_id: ch.id,
      target_name: str(card.name),
      drift,
      // 值摆出来给人核对：真正要判断的是"哪份对"，机器只负责发现与搬运
      conflicts: drift.map((d) => ({ field: d.field, values: [d.asset || '（空）', d.card] })),
    });
  }
  const counts = {
    warn: issues.filter((i) => i.level === 'warn').length,
    info: issues.filter((i) => i.level === 'info').length,
    fixable: issues.filter((i) => i.fixable).length,
  };
  return { issues, counts, scanned: list.length, pairs };
}

/**
 * 镜头绑定体检（批 8 补 5）：找出"提到了却没绑"和"绑了却不会生效"的镜头。
 *
 * 为什么按**目标**聚合而不是按镜头逐条报：一个角色漏绑往往是十几个镜头一起漏，
 * 逐镜头报会在面板里刷出一屏同样的话（用户点两次就再也不看了）。按角色聚成一条
 * "角色「林晚」有 12 个镜头提到但没绑定"，一次修复就把 12 个镜头一起绑上。
 *
 * 三种问题：
 *  · `shot_char_unbound` —— 镜头的「出场人物」/提示词里出现角色名，但没绑角色档案（不会注入外貌）；
 *  · `shot_card_unbound` —— 同上，针对地点卡/道具卡（不会注入场景/道具）；
 *  · `shot_char_unlocked` —— 绑了但角色**没锁定**，而提示词里又出现了角色名：按 characterPhrase 的既定语义
 *    （未锁定 = 提示词里已提到名字就跳过），这个镜头**不会**注入外貌 —— 这是最隐蔽的一条，界面上一切正常。
 *
 * `fixable` 与卡片侧同口径是**布尔**（计数/界面都用它），修复动作另放 `fix_code`
 * （`bind_shot_target` / `lock_shot_char`）—— 问题码与动作码是两件事，混成一个字段会让界面
 * 把 `shot_char_unbound` 当修复码发给后端（浏览器契约测试抓到过这个）。
 */
function auditShotBindings(shots, opts = {}) {
  const list = (Array.isArray(shots) ? shots : []).filter(Boolean);
  const chars = Array.isArray(opts.characters) ? opts.characters.filter(Boolean) : [];
  const cards = Array.isArray(opts.cards) ? opts.cards.filter(Boolean) : [];
  const byId = new Map();
  for (const c of chars) byId.set(c.id, { row: c, kind: 'character' });
  for (const c of cards) if (STORY_INJECT_KINDS.includes(c.kind)) byId.set(c.id, { row: c, kind: 'card' });

  const knownNames = new Set();
  for (const c of chars) for (const n of bindNames(c)) knownNames.add(n.toLowerCase());

  const groups = new Map();
  const add = (code, id, info, shot) => {
    const key = `${code}::${id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        code, target_id: id, target_name: str(info.row.name), target_kind: info.kind,
        shot_ids: [], shots: [], strong: false, level: 'info',
      });
    }
    const g = groups.get(key);
    g.shot_ids.push(shot.id);
    g.shots.push({ id: shot.id, shot_number: shot.shot_number, episode_number: shot.episode_number });
    if (info.strong) { g.strong = true; g.level = 'warn'; }
  };

  for (const s of list) {
    const m = matchShotBindings(s, { characters: chars, cards });
    for (const h of m.chars) add('shot_char_unbound', h.id, { row: { name: h.name }, kind: 'character', strong: !h.weak }, s);
    // 名字在角色库里根本找不到 → 这些镜头永远不会有外貌注入（连绑定都建不起来）
    for (const nm of splitShotCharacters(s.characters)) {
      if (knownNames.has(nm.toLowerCase())) continue;
      add('shot_char_unknown', `name::${nm}`, { row: { name: nm }, kind: 'character', strong: true }, s);
    }
    for (const h of m.cards) add('shot_card_unbound', h.id, { row: { name: h.name }, kind: 'card', strong: !h.weak }, s);
    // 已绑定但未锁定：按 characterPhrase 的真实判据（提示词里是否出现角色名）判断会不会被跳过
    const promptText = [s.image_prompt, s.video_prompt].map(str).join(' \n ');
    for (const id of (Array.isArray(s.character_ids) ? s.character_ids : [])) {
      const info = byId.get(id);
      if (!info || info.kind !== 'character' || info.row.is_locked) continue;
      const names = bindNames(info.row);
      if (!names.length) continue;
      const hit = pickHit(hitAll(promptText, names), longestAt(promptText, chars));
      if (!hit) continue;
      add('shot_char_unlocked', id, { row: info.row, kind: 'character', strong: false }, s);
    }
  }

  const LABEL = { shot_char_unbound: '角色', shot_card_unbound: '地点/道具卡', shot_char_unlocked: '角色', shot_char_unknown: '名字' };
  const issues = [...groups.values()].map((g) => {
    const n = g.shot_ids.length;
    if (g.code === 'shot_char_unlocked') {
      return {
        code: g.code, level: 'info', fixable: true, fix_code: 'lock_shot_char',
        title: `${LABEL[g.code]}「${g.target_name}」未锁定：${n} 个镜头不会注入外貌`,
        detail: `这 ${n} 个镜头的提示词里出现了「${g.target_name}」，而该角色未锁定 —— 按既定语义（未锁定 = 提示词里已提到名字就跳过）这些镜头不会注入外貌描述，出图容易换脸。锁定后每个镜头都会逐字注入同一段长相，这才是一致性的来源。`,
        target_id: g.target_id, target_name: g.target_name, target_kind: g.target_kind,
        shot_ids: g.shot_ids, shots: g.shots,
      };
    }
    if (g.code === 'shot_char_unknown') {
      return {
        code: g.code, level: 'info', fixable: false,
        title: `「${g.target_name}」在角色库里找不到（${n} 个镜头提到）`,
        detail: `这 ${n} 个镜头的「出场人物」写了「${g.target_name}」，但项目里没有这个角色档案 —— 这些镜头不会有外貌注入，同一个角色在不同镜头里会换脸，而且不会有任何报错。若它是某个已有角色的代称（"女主""少女"），把镜头里的名字改成本名，再跑一次「自动匹配绑定」；若确实是临时角色/路人，可以忽略。`,
        target_id: g.target_id, target_name: g.target_name, target_kind: g.target_kind,
        shot_ids: g.shot_ids, shots: g.shots,
      };
    }
    const what = g.target_kind === 'character' ? '外貌/服装' : '场景/道具';
    return {
      code: g.code, level: g.level, fixable: true, fix_code: 'bind_shot_target',
      title: `${LABEL[g.code]}「${g.target_name}」有 ${n} 个镜头提到但没绑定`,
      detail: g.strong
        ? `这些镜头的「出场人物」里写了「${g.target_name}」，但没有绑定档案 —— 生成时不会注入${what}，画面会漂。绑定后可随时点掉。`
        : `这些镜头的提示词/画面描述里出现了「${g.target_name}」，可能是巧合也可能是漏绑（请扫一眼再绑）。绑定后生成时会注入${what}。`,
      target_id: g.target_id, target_name: g.target_name, target_kind: g.target_kind,
      shot_ids: g.shot_ids, shots: g.shots,
    };
  }).sort((a, b) => (a.level === b.level ? b.shot_ids.length - a.shot_ids.length : (a.level === 'warn' ? -1 : 1)));

  const counts = { warn: 0, info: 0, fixable: 0 };
  for (const i of issues) { counts[i.level]++; if (i.fixable) counts.fixable++; }
  return { issues, counts, scanned: list.length };
}

/**
 * 分集大纲骨架（批 8 补 4）：把剧情卡按**原文出现顺序**排成拍子，再切成集。
 *
 * 为什么切集这件事不交给模型：
 *  · "哪几拍算一集"是**可判定**的（拍数下限 + 幕次收口），不是创作判断；
 *  · 交给模型会出现"同一份卡片两次切出不同集数"，用户就没法拿它当骨架改；
 *  · 而且分集要反复调（每集 4 拍还是 6 拍），每次调都花钱的工具用户不会用。
 * 真正需要 AI 的是"把这些拍写成剧本"，那一步在故事脚本页照旧走生成（有计费闸门）。
 *
 * 切分规则（可复现、可解释）：
 *  ① 拍子顺序 = 剧情卡的 order（= 首次出现在原文的位置），**不改写原文顺序**；
 *  ② `perEpisode` 是**下限**：攒够下限后，优先在"合"或"下一拍是起"处收口（不拆幕）；
 *  ③ 硬上限 = 下限 ×2：单幕过长时必须强行切开，否则分集等于没分（如实上报 forced）；
 *  ④ 一拍幕次都没有时退化为纯计数切分（basis='count'），并如实说明。
 *
 * @returns {{basis:'stage'|'mixed'|'count', per_episode:number, episodes:Array, beat_count:number,
 *            stage_covered:number, timeline_count:number, world_count:number, forced_cuts:number, notes:string[]}}
 */
function planEpisodes(cards, opts = {}) {
  const list = (Array.isArray(cards) ? cards : []).filter((c) => c && c.kind);
  const perRaw = Number(opts.perEpisode);
  const per = Number.isFinite(perRaw) && perRaw > 0
    ? Math.min(EPISODE_PER_MAX, Math.max(1, Math.round(perRaw)))
    : EPISODE_PER_DEFAULT;
  const beats = list.filter((c) => c.kind === 'plot')
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.id || '').localeCompare(String(b.id || '')));
  const staged = beats.filter((b) => stageRank(b.stage) < 99).length;
  const basis = !beats.length || staged === 0 ? 'count' : (staged === beats.length ? 'stage' : 'mixed');

  const groups = [];
  let cur = [];
  let forced = 0;
  for (let i = 0; i < beats.length; i++) {
    cur.push(beats[i]);
    const last = i === beats.length - 1;
    const full = cur.length >= per;
    const nextStage = i + 1 < beats.length ? stageRank(beats[i + 1].stage) : 99;
    // 收口点：这一拍本身是"合"，或下一拍要开新的一幕（"起"）
    const softCut = full && staged > 0 && (stageRank(beats[i].stage) === STAGE_ORDER.length - 1 || nextStage === 0);
    const hardCut = cur.length >= per * EPISODE_HARD_FACTOR;
    const countCut = full && staged === 0;
    if (last || softCut || hardCut || countCut) {
      if (!last && !softCut && staged > 0) forced++; // 硬上限切开的：单幕太长，必须如实上报
      groups.push(cur);
      cur = [];
    }
  }

  const episodes = groups.map((g, i) => {
    const acts = [...new Set(g.map((b) => str(b.stage).trim()).filter(Boolean))];
    const beatsOut = g.map((b) => ({
      id: b.id || null,
      name: str(b.name),
      stage: str(b.stage).trim(),
      conflict: str(b.conflict).trim(),
      turn: str(b.turn).trim(),
      outcome: str(b.outcome).trim(),
      involved: str(b.involved).trim(),
      summary: str(b.summary).trim(),
    }));
    return {
      index: i + 1,
      title: `第 ${i + 1} 集`,
      acts,
      beats: beatsOut,
      beat_count: beatsOut.length,
      chars: beatsOut.reduce((n, b) => n + beatLine(b).length + 1, 0),
    };
  });

  const notes = [];
  if (!beats.length) notes.push('这份原著还没有剧情卡：先解析出剧情卡，才能排出分集骨架');
  if (beats.length && staged === 0) notes.push('剧情卡都没有标幕次，已退化为按拍数平均切分；补上「起/承/转/合」后会优先在幕的收口处切');
  if (beats.length && staged > 0 && staged < beats.length) notes.push(`幕次覆盖 ${staged}/${beats.length} 拍：没标幕次的拍按原文顺序跟在后面，不会被丢掉`);
  if (staged > 0) notes.push(`切分优先落在「合」或下一拍「起」处，所以每集拍数不会低于 ${per}，但可能多于它（不拆幕）`);
  if (forced > 0) notes.push(`有 ${forced} 处单幕过长（超过 ${per * EPISODE_HARD_FACTOR} 拍）被强行切开，建议拆成两幕或调大「每集至少拍数」`);
  if (episodes.length && !forced && staged > 0) notes.push('所有分集都收在幕的边界上，没有从中间劈开一幕');

  return {
    basis,
    per_episode: per,
    hard_limit: per * EPISODE_HARD_FACTOR,
    episodes,
    beat_count: beats.length,
    stage_covered: staged,
    timeline_count: list.filter((c) => c.kind === 'timeline').length,
    world_count: list.filter((c) => c.kind === 'world').length,
    forced_cuts: forced,
    notes,
  };
}

/** 一拍压成一行（分集骨架里的最小单位；只搬有下游消费者的字段） */
function beatLine(b) {
  const parts = [];
  if (b.stage) parts.push(b.stage);
  if (b.conflict) parts.push(`冲突：${b.conflict}`);
  if (b.turn) parts.push(`转折：${b.turn}`);
  if (b.outcome) parts.push(`结果：${b.outcome}`);
  if (b.involved) parts.push(`涉及：${b.involved}`);
  const body = parts.length ? parts.join('｜') : (b.summary || '（待补充）');
  return `${b.name || '（未命名）'}｜${body}`;
}

/**
 * 分集骨架 → 提示词文本（落进剧本模板变量/剪贴板的那一份）。
 * 刻意把「全剧设定」「全剧时间线」一并带上：写某一集时要能看见它在全剧里的位置，
 * 否则跨集的设定漂移就是这么来的。
 */
function episodeOutlineText(cards, plan, opts = {}) {
  const list = (Array.isArray(cards) ? cards : []).filter((c) => c && c.kind);
  const p = plan || planEpisodes(list, opts);
  const worlds = sortCards(list).filter((c) => c.kind === 'world');
  const timelines = sortCards(list).filter((c) => c.kind === 'timeline');
  if (!p.episodes.length && !worlds.length && !timelines.length) return '';
  const out = [];
  out.push(opts.head || '以下是从原著抽出的分集大纲骨架（拍序按原文出现顺序，未新增任何设定）：请据此写本集剧本');
  if (worlds.length) {
    out.push('', '【全剧设定】');
    worlds.forEach((c, i) => out.push(`${i + 1}. ${cardLine(c)}`));
  }
  if (timelines.length) {
    out.push('', '【全剧时间线】');
    timelines.forEach((c, i) => out.push(`${i + 1}. ${cardLine(c)}${c.order_note ? `｜${str(c.order_note)}` : ''}`));
  }
  if (p.episodes.length) {
    const basisText = p.basis === 'count'
      ? `按每集至少 ${p.per_episode} 拍平均切分`
      : `每集至少 ${p.per_episode} 拍，优先在幕的收口处切（幕次覆盖 ${p.stage_covered}/${p.beat_count} 拍）`;
    out.push('', `【分集骨架】共 ${p.episodes.length} 集 / ${p.beat_count} 拍（${basisText}）`);
    for (const ep of p.episodes) {
      out.push('', `${ep.title}（${ep.acts.length ? ep.acts.join('·') : '未标幕次'}｜${ep.beat_count} 拍）`);
      ep.beats.forEach((b, i) => out.push(`  ${i + 1}. ${beatLine(b)}`));
    }
  }
  if (p.notes.length) {
    out.push('', '【切分说明】');
    p.notes.forEach((n) => out.push(`- ${n}`));
  }
  return out.join('\n');
}

/**
 * 单集拍表（批 8 补 8）：把分集骨架里的**某一集**单独渲染成"本集大纲"，逐集生成时用它填模板变量。
 * 与 episodeOutlineText 的全剧版共用 beatLine，措辞保持同源（改一处两处一起变）。
 */
/** 集号字段是 `index`（planEpisodes 的产物）；写成 `number` 会静默匹配不到任何一集 */
function epNo(x) { return Number(x && x.index); }

function episodeBriefText(plan, ep, opts = {}) {
  const e = ((plan || {}).episodes || []).find((x) => epNo(x) === Number(ep));
  if (!e) return '';
  const out = [`${e.title}（${e.acts.length ? e.acts.join('·') : '未标幕次'}｜${e.beat_count} 拍）`];
  e.beats.forEach((b, i) => out.push(`${i + 1}. ${beatLine(b)}`));
  if (opts.head) out.unshift(opts.head);
  return out.join('\n');
}

/**
 * 前情提要（批 8 补 8）：写第 N 集时带上"前面已经发生了什么"。
 *
 * 为什么需要：每集单独生成时模型看不见前面几集，人物口气、伏笔、剧情走向会各写各的——
 * 这就是长篇最常见的"越写越不像同一部戏"。前情只花**零成本**：分集骨架本来就在本地。
 *
 * 预算用满的取舍：**越近的集越相关**，所以超预算时从**最早**的一端丢，
 * 并如实上报丢了哪几集（不静默截断——用户要能判断这份前情够不够）。
 */
function priorBrief(plan, ep, opts = {}) {
  const all = ((plan || {}).episodes || []).filter((x) => epNo(x) < Number(ep));
  const want = Number(opts.maxChars);
  const max = Math.max(80, Number.isFinite(want) && want > 0 ? want : PRIOR_MAX_DEFAULT);
  if (!all.length) return { text: '', episodes: [], omitted: [], chars: 0, truncated: false };
  const lines = all.map((e) => `【${e.title}】${e.beats.map((b) => beatLine(b)).join('；')}`);
  const keep = [];
  let chars = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const add = lines[i].length + 1;
    if (chars + add > max && keep.length) break; // 至少留一集，否则前情成了空话
    keep.unshift(i);
    chars += add;
  }
  const omitted = all.filter((_, i) => !keep.includes(i));
  const out = ['【前情提要】以下是已经写过的内容（供你保持连贯，不要重复叙述）：'];
  if (omitted.length) out.push(`（更早的 ${omitted.length} 集已省略：${omitted.map((e) => e.title).join('、')}）`);
  keep.forEach((i) => out.push(lines[i]));
  const text = out.join('\n');
  return {
    text,
    episodes: keep.map((i) => epNo(all[i])),
    omitted: omitted.map((e) => epNo(e)),
    chars: text.length,
    truncated: omitted.length > 0,
  };
}

function renderPrompt(tpl, vars = {}) {
  let s = str(tpl);
  for (const [k, v] of Object.entries(vars)) s = s.split(`{{${k}}}`).join(str(v));
  return s.replace(/\{\{[^}]+\}\}/g, ''); // 兜底：模板里有、调用方没给的变量不留占位符
}

module.exports = {
  CARD_KINDS,
  CARD_KIND_LABELS,
  CARD_FIELDS,
  FIELD_MAX,
  KIND_MAX,
  DEFAULT_MAX_CHARS,
  DEFAULT_MIN_CHARS,
  DEFAULT_MAX_CHUNKS,
  normalizeText,
  splitChunks,
  clip,
  normalizeKind,
  nameKey,
  cleanName,
  normalizeCard,
  mergeCards,
  mergeAppend,
  applyBibleCards,
  sortCards,
  cardLine,
  digestCards,
  cardsToPrompt,
  cardToCharacter,
  parseJsonLoose,
  extractCards,
  renderPrompt,
  STAGE_ORDER,
  EPISODE_PER_DEFAULT,
  PRIOR_MAX_DEFAULT,
  episodeBriefText,
  priorBrief,
  EPISODE_PER_MAX,
  planEpisodes,
  beatLine,
  matchShotBindings,
  bindNames,
  splitShotCharacters,
  STYLE_WORDS,
  styleWordHits,
  auditPromptStyle,
  stripStyleWord,
  auditShotBindings,
  auditCharacterDrift,
  digestText,
  episodeInputDigest,
  auditStaleness,
  episodeOutlineText,
  STORY_INJECT_KINDS,
  STORY_INJECT_FIELDS,
  STORY_FIELD_LABELS,
  auditCards,
  mergeCardGroup,
  negativePhrase,
  pipelineOverview,
  classifyChunk,
  chunkStateLabel,
  chunkNeedsRetry,
  chunkIndexesFromCards,
  normalizeChunkStates,
  summarizeExtraction,
  extractionNote,
  CHUNK_STATE_LABELS,
  CARD_IMAGE_KINDS,
  normalizeRefIds,
};
