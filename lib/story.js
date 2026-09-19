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

/** 单类卡片数量上限（超出如实上报 dropped，不静默截断） */
const KIND_MAX = { world: 8, character: 60, location: 60, prop: 60, plot: 80, timeline: 40 };

const DEFAULT_MAX_CHARS = 3000;   // 单块上限：中文 3000 字仍能稳定吐出结构化 JSON，再大就开始丢字段
const DEFAULT_MIN_CHARS = 400;    // 尾块小于此值向前并块，不为几十个字付一次调用
const DEFAULT_MAX_CHUNKS = 24;    // 调用次数上限（计费闸门）：24×3000 ≈ 7.2 万字，够一本中篇

function str(v) { return v == null ? '' : String(v); }

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
  return { cards: out, raw_count: arr.length };
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
  normalizeKind,
  nameKey,
  cleanName,
  normalizeCard,
  mergeCards,
  sortCards,
  cardLine,
  digestCards,
  cardsToPrompt,
  cardToCharacter,
  parseJsonLoose,
  extractCards,
  renderPrompt,
  STORY_INJECT_KINDS,
  STORY_INJECT_FIELDS,
  STORY_FIELD_LABELS,
  auditCards,
  mergeCardGroup,
};
