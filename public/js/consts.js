/**
 * consts.js — 图标、枚举、状态标签、小工具
 * 图标用内联 SVG（Lucide 线性风格），不引外部库 —— 断网也能正常显示。
 */

const P = (d) => `<path d="${d}"/>`;

/** Lucide 风格图标集（24×24，stroke） */
const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  script: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h6"/><path d="M8 13h8"/><path d="M8 17h5"/>',
  film: '<rect x="2" y="2" width="20" height="20" rx="2.18"/><path d="M7 2v20"/><path d="M17 2v20"/><path d="M2 12h20"/><path d="M2 7h5"/><path d="M2 17h5"/><path d="M17 17h5"/><path d="M17 7h5"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  video: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  tasks: '<path d="M3 6h13"/><path d="M3 12h13"/><path d="M3 18h13"/><path d="m18 9 2 2 4-4"/><path d="m18 15 2 2 4-4"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.71a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 10.695a.53.53 0 0 1 .294-.904l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  wand: '<path d="m3 21 9-9"/><path d="M15 4V2"/><path d="M15 16v-2"/><path d="M8 9h2"/><path d="M20 9h2"/><path d="M17.8 11.8 19 13"/><path d="M15 9h0"/><path d="M17.8 6.2 19 5"/><path d="m3 21 3-3"/><path d="M12.2 6.2 11 5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/><path d="M5 3v4"/><path d="M3 5h4"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  zap: '<path d="M4 14h7l-2 7 11-11h-7l2-7z"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m6.08 9.5-3.5 1.6a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.5-1.59"/><path d="m6.08 14.5-3.5 1.6a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.5-1.59"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  play: '<path d="m6 3 14 9-14 9z"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  grip: '<circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  fileText: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h6"/><path d="M8 12h8"/><path d="M8 16h8"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2"/><path d="M9 2v2"/><path d="M15 20v2"/><path d="M9 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  template: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
};

/** 生成图标 SVG */
export function icon(name, size = 18, cls = '') {
  const d = ICONS[name] || ICONS.info;
  return `<svg class="${cls}" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}

// ── 枚举 ────────────────────────────────────────────────────
/**
 * 批 8：原著卡片的六种类别。
 * 变更须知：这份 id 表必须与后端 `lib/story.js` 的 `CARD_KINDS` **完全一致** ——
 * 后端按 kind 过滤/落库，前端按 kind 分组渲染，两边一旦漂移就会出现"抽到了但界面不显示"。
 * uitest 有一条钉直接读 lib/story.js 比对，改这里必须同步改那边。
 */
export const STORY_CARD_KINDS = ['world', 'character', 'location', 'prop', 'plot', 'timeline'];
export const STORY_CARD_LABELS = {
  world: '信息卡', character: '人物卡', location: '地点卡',
  prop: '道具卡', plot: '剧情卡', timeline: '时间线',
};
/** 每类卡片在编辑态要显示的字段（与后端 CARD_FIELDS 同源，顺序即展示顺序） */
export const STORY_CARD_FIELDS = {
  world: ['genre', 'tone', 'worldview', 'theme', 'logline', 'mainline'],
  character: ['role', 'identity', 'appearance', 'outfit', 'personality', 'gender', 'age'],
  location: ['atmosphere', 'region', 'time_of_day', 'features'],
  prop: ['owner', 'usage', 'features'],
  plot: ['stage', 'conflict', 'turn', 'outcome', 'involved'],
  timeline: ['when', 'order_note'],
};
export const STORY_CARD_FIELD_LABELS = {
  role: '定位', identity: '身份', appearance: '外貌', outfit: '服饰', personality: '性格',
  gender: '性别', age: '年龄', genre: '题材', tone: '基调', worldview: '世界观', theme: '主题',
  logline: '一句话故事', mainline: '主线', atmosphere: '氛围', region: '地域',
  time_of_day: '时段', features: '特征', owner: '持有者', usage: '用途', stage: '阶段',
  conflict: '冲突', turn: '转折', outcome: '结果', involved: '涉及人物',
  when: '时间', order_note: '顺序说明',
};
export function storyKindLabel(k) { return STORY_CARD_LABELS[k] || k; }

/**
 * 原著卡片 → 故事脚本模板变量的落位表（批 8 补：把"复制粘贴"变成"一键带入"）。
 *
 * 变更须知：键是**模板变量名**（用户可在设置页自由改名），值是卡片类别。
 * 之所以按变量名匹配而不是按位置：模板是用户可编辑的资产，位置会变、名字相对稳定；
 * 匹配不上时不是静默失败，而是走"第一个空着的长文本框"兜底并在提示条里说明落到了哪。
 * 名字里的"卡/设定/信息"等后缀会被归一化掉，所以 `{{人物卡}}`、`{{人物设定}}`、`{{人物}}` 等价。
 */
export const BIBLE_VAR_KINDS = {
  人物: ['character'], 角色: ['character'],
  地点: ['location'], 场景: ['location'],
  道具: ['prop'],
  剧情: ['plot'], 情节: ['plot'], 本集大纲: ['plot', 'world'], 剧情梗概: ['plot', 'world'],
  故事想法: ['world', 'plot'], 故事设定: ['world'], 原著设定: ['world', 'character', 'location', 'prop', 'plot', 'timeline'],
  信息: ['world'], 世界观: ['world'], 时间线: ['timeline'], 时间轴: ['timeline'],
};

/** 变量名归一化：去掉"卡/设定/信息/列表"等装饰词，便于与 BIBLE_VAR_KINDS 对齐 */
export function bibleVarKey(name) {
  return String(name || '').replace(/[\s（）()【】\[\]]/g, '').replace(/(卡片|卡|设定|信息|列表|清单)$/g, '');
}

/** 该变量名对应的卡片类别（不认识返回空数组） */
export function bibleKindsForVar(name) {
  const k = bibleVarKey(name);
  if (BIBLE_VAR_KINDS[k]) return BIBLE_VAR_KINDS[k];
  for (const [key, kinds] of Object.entries(BIBLE_VAR_KINDS)) {
    if (k.includes(key) || key.includes(k)) return kinds;
  }
  return [];
}

/**
 * 从模板变量里挑一个落点。纯函数（values 传"当前已填的值"），便于离线断言。
 * 优先级：① 名字匹配且当前为空 → ② 名字匹配（覆盖） → ③ 第一个空着的长文本框 → ④ 无。
 * 第 ④ 种情况返回 null，调用方必须**明确告诉用户没落位**，不许静默丢掉带入的内容。
 */
export function pickBibleVar(vars, kinds, values = new Map()) {
  const list = Array.isArray(vars) ? vars : [];
  const want = Array.isArray(kinds) && kinds.length ? kinds : null;
  const matched = list.filter((v) => {
    const ks = bibleKindsForVar(v);
    return ks.length && (!want || ks.some((k) => want.includes(k)));
  });
  const empty = (v) => !String(values.get ? (values.get(v) || '') : (values[v] || '')).trim();
  const hit = matched.find(empty) || matched[0];
  if (hit) return { name: hit, matched: true };
  const fallback = list.find((v) => isLongVarName(v) && empty(v));
  return fallback ? { name: fallback, matched: false } : null;
}

/** 长文本变量判定（与 textstats.isLongVar 同源，这里只用于挑兜底落点，故不引入循环依赖） */
function isLongVarName(name) {
  return /大纲|脚本|内容|梗概|故事|想法|描述|设定|提示词|原文|文本|台词|分镜|要求|风格/.test(String(name || ''));
}

/** 跨页带入时"上游"显示名（scripts.js 的提示条用；不在 SCRIPT_TYPES 里的来源靠它翻译） */
export const UPSTREAM_LABELS = { novel: '原著解析' };
export const STORY_ROLE_OPTIONS = ['主角', '配角', '反派', '龙套'];
export const STORY_STAGE_OPTIONS = ['起', '承', '转', '合'];

export const PROJECT_TYPES = ['爽文漫剧', '悬疑漫剧', '都市逆袭', '末世生存', '奇幻冒险', '科幻脑洞', '情绪故事', '短篇条漫动态化', '自定义'];
export const ASPECTS = ['9:16 竖屏', '16:9 横屏', '1:1 方形', '3:4 竖版', '4:3 横版'];

/**
 * R20 平台 → 画幅推荐表（`value` 与旧数据的 target_platform 字符串保持一致，老项目不失效）。
 * 为什么值得做：`PLATFORMS` 原本是个 9 项纯下拉，与 `ASPECTS` 毫无关系——用户选了「抖音」还得
 * 自己知道要选 9:16，选错了要到出片才发现。平台与画幅的对应关系是**确定性的行业常识**，
 * 让用户手填等于把已知答案变成一道考题。
 * aspect 为 null = 不预设（横版视频/自定义这类"看情况"的平台，硬塞一个反而是添乱）。
 */
export const PLATFORMS = [
  { value: '抖音', label: '抖音', aspect: '9:16 竖屏', hint: '竖屏短视频主战场' },
  { value: '快手', label: '快手', aspect: '9:16 竖屏', hint: '竖屏短视频' },
  { value: '视频号', label: '视频号', aspect: '9:16 竖屏', hint: '微信生态竖屏' },
  { value: '小红书', label: '小红书', aspect: '3:4 竖版', hint: '笔记封面偏 3:4，信息流展示面积更大' },
  { value: 'B站', label: 'B站', aspect: '16:9 横屏', hint: '横屏为主，也有竖屏 Story 模式' },
  { value: 'YouTube Shorts', label: 'YouTube Shorts', aspect: '9:16 竖屏', hint: 'Shorts 强制竖屏' },
  { value: 'TikTok', label: 'TikTok', aspect: '9:16 竖屏', hint: '竖屏短视频' },
  { value: '横版视频', label: '横版视频（通用）', aspect: '16:9 横屏', hint: '通用横屏' },
  { value: '自定义', label: '自定义', aspect: null, hint: '不预设画幅' },
];

/** 平台 → 推荐画幅（找不到或未设推荐时返回 null，调用方据此决定要不要提示） */
export function aspectForPlatform(platform) {
  const p = PLATFORMS.find((x) => x.value === String(platform || ''));
  return p && p.aspect ? p.aspect : null;
}

/**
 * R19 景别：8 → 14。补的都是**分镜脚本里真会用到的**标准景别与机位视角，
 * 而不是把电影词典整本抄进来（选项越多，下拉越难用；每个选项都必须有存在理由）。
 */
export const SHOT_TYPES = [
  '大远景', '远景', '全景', '中全景', '中景', '中近景', '近景', '特写', '极特写',
  '过肩', '主观视角', '俯拍', '仰拍', '鸟瞰',
];

/**
 * R19 运镜字典（8 组 38 条）：中文标签给人看，英文短语给视频模型用。
 * 与画风/角色同一范式——**在使用点注入**，所以改词表不用重新生成任何东西。
 * 英文写成"能直接拼进提示词的短语"，而不是行业黑话（模型不认识"dolly zoom"的缩写变体，
 * 但认识完整的镜头语言描述）。
 */
export const CAMERA_MOVES = [
  { group: '推拉', zh: '推镜', en: 'slow push in toward the subject' },
  { group: '推拉', zh: '急推', en: 'rapid crash zoom in' },
  { group: '推拉', zh: '拉镜', en: 'pull out reveal, wider framing' },
  { group: '推拉', zh: '变焦拉远', en: 'zoom out to reveal the surroundings' },
  { group: '推拉', zh: '滑动变焦（希区柯克）', en: 'dolly zoom vertigo effect, background stretches while subject stays fixed' },
  { group: '横移', zh: '横移', en: 'lateral tracking shot, camera slides sideways' },
  { group: '横移', zh: '跟随', en: 'follow shot tracking behind the subject' },
  { group: '横移', zh: '侧跟', en: 'side tracking shot moving parallel with the subject' },
  { group: '横移', zh: '摇镜', en: 'slow pan across the scene' },
  { group: '横移', zh: '甩镜', en: 'whip pan, fast motion blur transition' },
  { group: '升降', zh: '升镜', en: 'crane up shot rising above the scene' },
  { group: '升降', zh: '降镜', en: 'crane down descending toward the subject' },
  { group: '升降', zh: '摇臂环绕', en: 'jib shot arcing around the subject' },
  { group: '环绕', zh: '环绕', en: 'orbiting camera circling the subject' },
  { group: '环绕', zh: '半环绕', en: 'half orbit arc around the subject' },
  { group: '环绕', zh: '旋转', en: 'camera rolls rotating the horizon' },
  { group: '手持', zh: '手持', en: 'handheld camera with natural shake', still: true },
  { group: '手持', zh: '跟拍晃动', en: 'documentary style handheld following the action' },
  { group: '手持', zh: '呼吸感微动', en: 'subtle breathing camera drift, static but alive' },
  { group: '固定', zh: '固定机位', en: 'locked-off static camera', still: true },
  { group: '固定', zh: '三脚架微推', en: 'tripod shot with a very slow push' },
  { group: '固定', zh: '定点摇摄', en: 'static camera panning to follow the subject' },
  { group: '视角', zh: '第一人称', en: 'first-person POV shot', still: true },
  { group: '视角', zh: '过肩视角', en: 'over-the-shoulder framing', still: true },
  { group: '视角', zh: '俯视', en: 'high angle looking down', still: true },
  { group: '视角', zh: '仰视', en: 'low angle looking up, subject looms', still: true },
  { group: '视角', zh: '鸟瞰', en: 'aerial top-down bird eye view, looking straight down', still: true },
  { group: '视角', zh: '低角度贴地', en: 'ground-level low angle shot', still: true },
  { group: '视角', zh: '越肩反打', en: 'reverse over-the-shoulder shot', still: true },
  { group: '特殊', zh: '穿越', en: 'camera flies through the scene, continuous forward motion' },
  { group: '特殊', zh: '一镜到底', en: 'continuous long take without cuts' },
  { group: '特殊', zh: '慢动作', en: 'slow motion, high frame rate feel' },
  { group: '特殊', zh: '延时', en: 'time-lapse, accelerated time' },
  { group: '特殊', zh: '虚实变焦', en: 'rack focus shifting between foreground and background', still: true },
  { group: '特殊', zh: '穿墙进入', en: 'camera pushes through a wall into the next space' },
  { group: '特殊', zh: '镜头失焦再合焦', en: 'defocus then snap back into sharp focus' },
  { group: '特殊', zh: '闪白转场', en: 'flash cut transition, brief white flash' },
  { group: '特殊', zh: '无运镜', en: 'no camera movement' },
];

/** 运镜按组归类，供界面渲染分组选择器（组内顺序即上表顺序） */
export const CAMERA_MOVE_GROUPS = CAMERA_MOVES.reduce((acc, m) => {
  const g = acc.find((x) => x.group === m.group);
  if (g) g.items.push(m); else acc.push({ group: m.group, items: [m] });
  return acc;
}, []);

/**
 * 按中文标签取英文运镜短语（找不到返回空串，绝不把中文标签直接喂给视频模型）。
 * `forStill` = 给**静帧图片**用时，只放行"机位/视角类"运镜（still:true）：
 * 「甩镜」「延时」「一镜到底」这类描述的是**时间上的运动**，静态图里根本没有对应物，
 * 拼进去只会给模型添乱（还可能画出莫名其妙的运动模糊）。视频侧则全量放行。
 */
export function cameraMovePhrase(zh, forStill = false) {
  const m = CAMERA_MOVES.find((x) => x.zh === String(zh || '').trim());
  if (!m) return '';
  if (forStill && !m.still) return '';
  return m.en;
}

/** 该运镜对静帧是否成立（界面据此提示"仅视频生效"，别让用户以为图片也会跟着变） */
export function cameraMoveAffectsStill(zh) {
  const m = CAMERA_MOVES.find((x) => x.zh === String(zh || '').trim());
  return !!(m && m.still);
}

/**
 * R21 场景变体池：同一条提示词再次生成时按序轮换，避免"点第二次得到一张几乎一样的图"。
 * 与画风/角色/运镜同一范式（使用点注入），且**首次生成不注入**——第一次必须忠实于用户写的词，
 * 只有"再来一张"才引入变化。措辞刻意避开具体内容（只改机位/时段/构图这类不改变叙事的信息）。
 */
export const VARIATION_POOL = [
  'slightly different camera angle, alternative framing',
  'different time of day, changed lighting mood',
  'alternate composition, rule of thirds, different lens',
  'closer framing on the subject, shallower depth of field',
  'wider establishing framing, more environment visible',
  'different weather and atmosphere',
  'lower camera position, more dramatic perspective',
  'mirrored composition, subject on the other side of frame',
];

/** 取第 n 个变体（n 从 1 起；n<=0 返回空串 = 不注入变体） */
export function variationPhrase(n) {
  const i = Math.floor(Number(n) || 0);
  if (i <= 0) return '';
  return VARIATION_POOL[(i - 1) % VARIATION_POOL.length];
}
// R14：角色定位。只影响档案分组与提示词里的称呼方式，不做权限/流程限制——
// 竞品把"主角/配角"做成了流程门禁（配角不许锁外貌），结果用户被自己的工具挡住。
export const CHARACTER_ROLES = ['主角', '配角', '反派', '群演', '道具化角色'];
export const IMAGE_SIZES = [
  { label: '横版 1024×768', value: '1024x768', w: 1024, h: 768 },
  { label: '竖版 768×1024', value: '768x1024', w: 768, h: 1024 },
  { label: '方形 1024×1024', value: '1024x1024', w: 1024, h: 1024 },
  { label: '宽屏 1280×720', value: '1280x720', w: 1280, h: 720 },
  { label: '竖屏 720×1280', value: '720x1280', w: 720, h: 1280 },
];
export const VIDEO_RESOLUTIONS = [
  { label: '1152×768 横版', w: 1152, h: 768 },
  { label: '768×1152 竖版', w: 768, h: 1152 },
  { label: '1024×1024 方形', w: 1024, h: 1024 },
];
export const DURATION_PRESETS = [
  { label: '约 3 秒', frames: 81 },
  { label: '约 5 秒', frames: 121 },
  { label: '约 10 秒', frames: 241 },
  { label: '约 18 秒', frames: 441 },
];
// T-1：项目画幅 aspect_ratio → 合法产出尺寸映射。Agnes 图片侧支持 IMAGE_SIZES 各档，
// 视频侧只有三档固定宽高，取"同比例最接近"档；未知/缺省回落 9:16 竖屏（与后端默认一致）。
export function sizeForAspect(aspect, kind = 'image') {
  const key = String(aspect || '').slice(0, 4); // '9:16 竖屏' → '9:16'
  const img = { '9:16': '720x1280', '16:9': '1280x720', '1:1': '1024x1024', '3:4': '768x1024', '4:3': '1024x768' };
  const vid = { '9:16': { w: 768, h: 1152 }, '16:9': { w: 1152, h: 768 }, '1:1': { w: 1024, h: 1024 }, '3:4': { w: 768, h: 1152 }, '4:3': { w: 1152, h: 768 } };
  if (kind === 'video') return vid[key] || vid['9:16'];
  return img[key] || img['9:16'];
}
// R4：分镜 duration_seconds 折算为 Agnes num_frames。Agnes 要求帧数 = 8n+1、上限 441、默认 24fps。
// 给定秒数取最接近的合法值并钳进 [81, 441]，让"时长"这一列真正影响产出而不是被 121 写死覆盖。
export function secondsToFrames(sec, fps = 24) {
  const s = Number(sec);
  const raw = (Number.isFinite(s) && s > 0 ? s : 5) * fps;
  const n = Math.max(10, Math.min(55, Math.round((raw - 1) / 8)));
  return 8 * n + 1;
}
/**
 * R26：帧数 ↔ 秒的换算，以及模型真正支持的时长区间。
 *
 * 为什么要有这两个导出：`secondsToFrames` 会**量化并夹住**时长（8n+1、[81,441]），
 * 也就是"用户填 30 秒、实际提交 18.4 秒"是**正常行为**——问题在于以前没有任何地方
 * 告诉他这件事，他按 30 秒的预期去等成片。区间由同一个函数的量化边界反推（单源，
 * 改了 secondsToFrames 这里跟着变，不会各写一份而漂移）。
 */
// 变更须知：secondsToFrames 会量化并夹住时长（8n+1、[81,441]），这是模型契约不是 bug；
// 任何"用户填的秒数"都必须经 effectiveVideoSeconds 展示实际值，不许直接把填写值当结果用。
export function framesToSeconds(frames, fps = 24) {
  const f = Number(frames);
  const r = Number(fps);
  return Number.isFinite(f) && Number.isFinite(r) && r > 0 ? f / r : 0;
}
/** 分镜里写的秒数 → 实际会提交给模型的秒数 */
export function effectiveVideoSeconds(sec, fps = 24) { return framesToSeconds(secondsToFrames(sec, fps), fps); }
export const VIDEO_DURATION_RANGE = { minSec: framesToSeconds(81), maxSec: framesToSeconds(441) };

export const IMAGE_USAGES = [
  { value: 'storyboard', label: '分镜图' },
  { value: 'character', label: '角色图' },
  { value: 'scene', label: '场景图' },
  { value: 'prop', label: '道具图' },
  { value: 'style_test', label: '风格测试' },
  { value: 'reference', label: '参考图' },
];
export const IMAGE_ROLES = ['角色参考', '场景参考', '风格参考', '起始画面', '目标画面', '道具参考'];
export const VIDEO_MODES = [
  { id: 't2v', label: '文生视频', mode: 'text_to_video' },
  { id: 'i2v', label: '图生视频', mode: 'image_to_video' },
  { id: 'multi', label: '多图参考', mode: 'multi_image' },
  { id: 'keyframe', label: '关键帧动画', mode: 'keyframe' },
];
export const SCRIPT_TYPES = [
  { value: 'story_concept', label: '故事构思' },
  { value: 'plot_summary', label: '剧情梗概' },
  { value: 'episode_outline', label: '分集大纲' },
  { value: 'episode_script', label: '单集脚本' },
  { value: 'storyboard_script', label: '分镜脚本' },
];
/**
 * R16 剧本链路的**步骤顺序**（单一事实来源）：故事构思 → 剧情梗概 → 分集大纲 → 单集脚本 → 分镜脚本。
 * 为什么要显式写出来而不是靠 SCRIPT_TYPES 的数组顺序：这个顺序是"两段式"的骨架——
 * 「带入下一步」按它找下游，「上游已带入」按它找上游；数组顺序被后人调整（比如按字母排序）时，
 * 链路会静默错位，而这种错位极难从界面上看出来。
 */
export const SCRIPT_STEPS = ['story_concept', 'plot_summary', 'episode_outline', 'episode_script', 'storyboard_script'];

/** 下一步的 type；已是最后一步返回 null */
export function nextScriptStep(tab) {
  const i = SCRIPT_STEPS.indexOf(String(tab || ''));
  return i >= 0 && i < SCRIPT_STEPS.length - 1 ? SCRIPT_STEPS[i + 1] : null;
}

/** 上一步的 type；已是第一步返回 null */
export function prevScriptStep(tab) {
  const i = SCRIPT_STEPS.indexOf(String(tab || ''));
  return i > 0 ? SCRIPT_STEPS[i - 1] : null;
}

/** 步骤序号（1 起）与总步数，用于界面上标「第 2/5 步」 */
export function stepNo(tab) {
  const i = SCRIPT_STEPS.indexOf(String(tab || ''));
  return i < 0 ? 0 : i + 1;
}

/**
 * 把服务端模型目录转换成下拉项。
 * Agnes 新模型可能还没被正确标注 kind，所以 unknown 也允许作为候选；
 * 只排除明显属于其它模态的名字，避免新模型被误藏起来。
 */
export function modelChoices(directory, kind, fallbacks = []) {
  const all = Array.isArray(directory?.models) ? directory.models : [];
  const textLike = (m) => !/image|vision|video|animate|motion|wan|kling|sora/i.test(String(m.id));
  const imageLike = (m) => /image|vision|dall|flux|sdxl|seedream|画|图/i.test(String(m.id));
  const videoLike = (m) => /video|animate|motion|wan|kling|sora/i.test(String(m.id));
  const predicate = kind === 'text' ? textLike : kind === 'image' ? imageLike : videoLike;
  let ids = all.filter((m) => m.kind === kind || m.kind === 'unknown').filter(predicate).map((m) => m.id);
  if (!ids.length) ids = all.filter(predicate).map((m) => m.id);
  ids = [...new Set([...fallbacks, ...ids].filter(Boolean))];
  return ids.map((id) => ({ value: id, label: id }));
}

export const TEMPLATE_TYPES = [
  { value: 'story_concept', label: '故事生成' },
  { value: 'plot_summary', label: '剧情梗概' },
  { value: 'episode_outline', label: '分集大纲' },
  { value: 'episode_script', label: '单集脚本' },
  { value: 'storyboard_script', label: '分镜脚本' },
  { value: 'image_prompt', label: '图片提示词' },
  { value: 'video_prompt', label: '视频提示词' },
  { value: 'optimize', label: '脚本优化' },
];

// ── 状态标签与样式 ──────────────────────────────────────────
export const VIDEO_STATUS = {
  queued: { label: '排队中', cls: 'blue' },
  in_progress: { label: '生成中', cls: 'gold' },
  completed: { label: '已完成', cls: 'green' },
  failed: { label: '远端失败', cls: 'red' },
  remote_submitted: { label: '已提交', cls: 'blue' },
  poll_timeout: { label: '查询超时', cls: 'orange' },
  video_url_missing: { label: '地址待取', cls: 'yellow' },
  sync_failed: { label: '同步异常', cls: 'orange' },
  submit_timeout_unknown: { label: '提交超时未知', cls: 'orange' },
};
export const REMOTE_STATUS = {
  not_submitted: '未提交',
  unknown: '状态未知',
  queued: '排队中',
  in_progress: '生成中',
  completed: '已完成',
  failed: '远端失败',
};
export const LOCAL_STATUS = {
  draft: '草稿',
  validating: '校验参数',
  submitting: '提交中',
  submit_timeout_unknown: '提交超时未知',
  remote_submitted: '已提交',
  saving: '保存中',
  polling: '轮询中',
  poll_timeout: '查询超时',
  video_url_missing: '地址待取',
  result_parse_failed: '结果解析失败',
  completed: '已完成',
  submit_failed: '提交失败',
  sync_failed: '同步异常',
  local_error: '本地异常',
};
// B3.6：提示词预设速查（竞品 113 条库的精简子集）。中文标签=记忆负担零，英文短语=模型实际吃的话。
// 点击追加到提示词尾部，已含同短语则去重。后续可扩至分镜编辑弹窗内。
/**
 * 预设短语面板（图片页）：点一下把专业短语追加进提示词。
 * R19 去重：运镜这组**从 CAMERA_MOVES 生成**，不再另写一套英文——
 * 原来同一件事有两套措辞（这里 `slow push in`、运镜字典 `slow push in toward the subject`），
 * 用户从 chips 点一下和从运镜字段选一下会得到不同文本，模型表现也就跟着飘。
 */
const PRESET_MOVES = ['推镜', '拉镜', '横移', '环绕', '手持', '升镜'];
export const PRESET_TERMS = [
  { cat: '运镜', items: PRESET_MOVES.map((zh) => {
    const m = CAMERA_MOVES.find((x) => x.zh === zh);
    return { label: m.zh, en: m.en };
  }) },
  { cat: '光线', items: [
    { label: '逆光', en: 'strong backlight rim light' },
    { label: '黄金时刻', en: 'golden hour warm light' },
    { label: '霓虹', en: 'neon glow, cyan magenta' },
    { label: '体积光', en: 'volumetric god rays' },
    { label: '烛光', en: 'candlelight, low key' },
    { label: '冷月色', en: 'moonlit cold blue tones' },
  ] },
  { cat: '质感', items: [
    { label: '电影感', en: 'cinematic composition' },
    { label: '胶片颗粒', en: 'film grain, 35mm texture' },
    { label: '高对比', en: 'high contrast dramatic' },
    { label: '柔焦', en: 'soft focus dreamy' },
    { label: '大特写细节', en: 'intricate detail, sharp focus' },
    { label: '留白构图', en: 'negative space composition' },
  ] },
];
// B4.1 前端镜像：与 lib/routes.js 的 ART_STYLE_MAP 必须同表（uitest 有文本比对钉）。
// 用途 = 预览"生成时真正发出的完整提示词"，让计算态在界面上可见。
export const ART_STYLE_MAP = {
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
/**
 * R15 前端镜像：与 lib/story.js 的 negativePhrase **逐字同构**（uitest 有文本比对钉）。
 * 负面提示词是**并入正向提示词**发出的（网关对未知字段硬拒，单发会 400），
 * 所以"实际发出"预览必须把它算进去 —— 否则预览里看不到的那半句，用户永远不知道它在起作用。
 */
export function negativePhrase(prompt, neg) {
  const n = String(neg || '').trim();
  if (!n) return prompt;
  return `${prompt}。避免出现：${n}`;
}

export function artStylePhrase(prompt, style) {
  const st = String(style || '').trim();
  if (!st) return prompt;
  const key = Object.keys(ART_STYLE_MAP).find((k) => st.includes(k) || k.includes(st));
  const phrase = key ? ART_STYLE_MAP[key] : st;
  if (!phrase || String(prompt).toLowerCase().includes(phrase.toLowerCase())) return prompt;
  return `${prompt}, ${phrase}`;
}

/**
 * R15 前端镜像：与 lib/routes.js 的 characterPhrase **逐字同构**（uitest 有文本比对钉）。
 * 用途 = 在分镜表里预览"生成时真正发出的完整提示词"，让角色注入这个计算态在界面上可见。
 * 逻辑一漂移，预览就开始骗人 —— 这正是 B4.2 那条教训的延续。
 */
export function characterPhrase(prompt, chars) {
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
 * 批 8 补 2：原著卡片注入的前端镜像 —— 必须与 lib/routes.js 的 storyCardPhrase **逐字同构**
 * （uitest 有文本比对钉）。分镜页用它算"生成时真正发出的是什么"，两边一漂移预览就开始骗人。
 * 只注入画面上看得见的两类：地点卡与道具卡；人物卡走角色库那条路。
 */
export const STORY_CARD_INJECT_FIELDS = {
  location: ['atmosphere', 'region', 'time_of_day', 'features'],
  prop: ['owner', 'usage', 'features'],
};

/** 按类别取"会被注入提示词"的那几个字段，拼成一句短语（没内容返回空串） */
export function storyCardLook(card) {
  const kind = String((card && card.kind) || '').trim();
  const fields = STORY_CARD_INJECT_FIELDS[kind];
  if (!fields) return '';
  return fields.map((f) => String(card[f] == null ? '' : card[f]).trim()).filter(Boolean).join('，');
}

export function storyCardPhrase(prompt, cards) {
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

/**
 * 角色名册（批 8 补 6）：把资产库里的角色名单渲染成一段"生成时必须沿用这些名字"的提示词。
 *
 * 为什么需要：分镜表/剧本都是模型写的，它**不知道**项目里已经有哪些角色 —— 于是同一部剧里
 * "女主""苏婉儿""婉儿"三种叫法混着出现，落到镜头绑定上就是**谁也匹配不上、谁都没有外貌注入**
 * （同一张脸在几十个镜头里各长一样，而且不会有任何报错）。把名册写进提示词是从源头解决：
 * 模型照着本名写「出场人物」，绑定与注入自然就对上了。
 *
 * 只给**名字与别名**，长相只给一行摘要且明确要求"不要写进 image_prompt/video_prompt" ——
 * 长相由系统在使用点统一注入（`characterPhrase`），两处都写等于两套描述在打架。
 *
 * @param {Array} chars 资产库角色（`GET /api/characters`）
 * @param {{text?: string, limit?: number}} [opts] `text` 用来把"本集真的会出场"的角色排到前面
 * @returns {{count:number, names:string[], text:string, truncated:number}} 没有角色时 `text` 为空串（调用方原样跳过）
 */
export function characterRoster(chars, opts = {}) {
  const list = (Array.isArray(chars) ? chars : []).filter((c) => c && String(c.name || '').trim());
  if (!list.length) return { count: 0, names: [], text: '', truncated: 0 };
  const limit = Math.max(1, Number(opts.limit) || 30);
  const text = String(opts.text || '');
  const lower = text.toLowerCase();
  const score = (c) => {
    const names = [String(c.name).trim()].concat(
      Array.isArray(c.alias) ? c.alias : String(c.alias || '').split(/[、,，/|]/).map((x) => x.trim()),
    ).filter((n) => n.length >= 2);
    // 排序依据：本集文本里真的提到了 → 锁定（无条件注入）→ 名字。与"谁更可能出场"同序
    const hit = names.some((n) => lower.includes(n.toLowerCase())) ? 1 : 0;
    return hit * 2 + (c.is_locked ? 1 : 0);
  };
  const sorted = list.slice().sort((a, b) => (score(b) - score(a)) || String(a.name).localeCompare(String(b.name)));
  const kept = sorted.slice(0, limit);
  const lines = kept.map((c) => {
    const alias = (Array.isArray(c.alias) ? c.alias : String(c.alias || '').split(/[、,，/|]/))
      .map((x) => String(x).trim()).filter((x) => x.length >= 2);
    const look = [c.appearance, c.outfit].map((x) => String(x || '').trim()).filter(Boolean).join('，');
    const brief = look.length > 30 ? `${look.slice(0, 30)}…` : look;
    const head = alias.length ? `${String(c.name).trim()}（别名：${alias.join('、')}）` : String(c.name).trim();
    return brief ? `- ${head}｜${brief}` : `- ${head}`;
  });
  const truncated = Math.max(0, sorted.length - kept.length);
  return {
    count: kept.length,
    names: kept.map((c) => String(c.name).trim()),
    truncated,
    text: [
      '【本剧角色名册】剧本与分镜里的出场人物**必须使用下列本名**（原文里的代称如"女主/男主/少女"要换成对应本名；不要自己另起名字）：',
      ...lines,
      ...(truncated ? [`（另有 ${truncated} 个角色未列出，需要时请沿用原文里的称呼，不要新造名字）`] : []),
      '名册里的长相只供你把握人物形象，**不要写进 image_prompt / video_prompt** —— 人物长相由系统在使用点统一注入，写两遍会让同一个角色在不同镜头里长得不一样。',
    ].join('\n'),
  };
}

export const STORYBOARD_STATUS = {
  pending: { label: '待处理', cls: 'gray' },
  image_ready: { label: '有图片', cls: 'blue' },
  video_ready: { label: '有视频', cls: 'gold' },
  done: { label: '完成', cls: 'green' },
};

export function statusBadge(status) {
  const s = VIDEO_STATUS[status] || { label: status || '未知', cls: 'gray' };
  return `<span class="badge ${s.cls}">${esc(s.label)}</span>`;
}

// ── 小工具 ──────────────────────────────────────────────────
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function relTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '—';
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return fmtDate(iso);
}

export function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// ── 偏好持久化（带过期） ────────────────────────────────────
/**
 * 带过期时间的偏好读写。
 * 为什么不用布尔：像「今天不再提醒」这类偏好若只存 true，用户第二天就再也收不到提醒了 ——
 * 要么额外写清理任务，要么每次读取判断过期。存**到期时间戳**是唯一自洽的形态。
 * localStorage 在隐私模式/配额满时会抛异常，一律吞掉当「没有偏好」：偏好读取绝不能拖垮页面。
 */
export function readUntil(key) {
  try {
    const at = Number(localStorage.getItem(key));
    return Number.isFinite(at) && at > Date.now() ? at : null;
  } catch { return null; }
}

export function rememberUntil(key, ms) {
  try { localStorage.setItem(key, String(Date.now() + Math.max(0, Number(ms) || 0))); } catch { /* 存不了就当没记住 */ }
}

/** 今天 24 点（本地时区）的毫秒时间戳 —— 「当天免提醒」的统一到期口径 */
export function endOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

// ── 错误文案 ────────────────────────────────────────────────
/**
 * 后端 errorType → 「下一步怎么办」提示（键取自 lib/agnes.js 与 lib/routes.js 的 errorType 取值）。
 * 纪律（竞品用线上事故换来的反模式注释）：**只做补充，绝不替换后端原文**。
 * 用户要先看到真实原因，再看到可操作建议；任何"按关键字白名单挑着拼"的做法都会吞掉真实报错。
 */
export const ERROR_HINTS = {
  no_api_key: '去「设置」填一个 Agnes API Key',
  invalid_api_key: 'Key 可能已失效，去「设置」重新填写',
  agnes_error: '上游返回了错误，原文见上；可稍后重试',
  proxy_timeout: '上游响应超时，可稍后重试或换更快的模型',
  network_error: '检查本机网络与 API Base URL 是否可达',
  model_fetch_failed: '可稍后重试；失败时会保留上一次的模型目录',
  test_failed: '检查 Key / Base URL / 网络后重试',
  no_video_id: '上游没返回 video_id，可在「镜头任务」页用「重新获取结果」补查',
  submit_failed: '任务未提交成功，可直接重试；同一条重复提交才会重复计费',
  query_failed: '查询失败，本地任务仍在，稍后会自动继续轮询',
  text_failed: '文本生成失败，可重试或换一个文本模型',
  image_failed: '图片生成失败，可重试或换一个图像模型',
  download_failed: '可稍后在素材库重试下载（远端链接过期前有效）',
  download_unauthorized_host: '视频地址与 API Base 不同主机，为保护 Key 未带凭证；请手动下载后导入',
  client_timeout: '本地服务长时间没响应，可能在重启；稍后刷新页面确认结果',
};

/** 把 errorType 对应的「下一步」拼到后端原文之后；原文缺失时用兜底文案。 */
export function formatError(errorType, raw, fallback = '操作失败') {
  const msg = String(raw == null ? '' : raw).trim() || fallback;
  const hint = ERROR_HINTS[errorType];
  return hint ? `${msg}（${hint}）` : msg;
}

/**
 * 启发式修复模型输出 JSON 的常见毛病：
 *   · 字符串值里没转义的内嵌引号（agnes-flash 最常犯，整段解析就挂在这）
 *   · 相邻字符串之间多出来的引号（"a" "", 这种）
 *   · 数组/对象末尾多写的逗号
 *   · 字符串里裸换行/制表符
 * 只在正常解析失败后作为兜底调用，不做语义纠错。
 */
export function repairJson(src) {
  let out = '';
  let inStr = false;
  let escNext = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (!inStr) {
      if (c === '"') {
        // 刚闭合一个字符串又紧跟一个引号 → 多余引号，直接丢弃
        const prev = out.trimEnd().slice(-1);
        if (prev === '"') continue;
        inStr = true;
      }
      out += c;
      continue;
    }
    if (escNext) { out += c; escNext = false; continue; }
    if (c === '\\') { out += c; escNext = true; continue; }
    if (c === '\n') { out += '\\n'; continue; }
    if (c === '\r') { continue; }
    if (c === '\t') { out += '\\t'; continue; }
    if (c === '"') {
      // 只有当下一个非空白字符是结构符时才认为字符串闭合，否则它是内嵌引号
      let j = i + 1;
      while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j++;
      const nx = j >= src.length ? '' : src[j];
      if (nx === '' || nx === ',' || nx === ':' || nx === '}' || nx === ']' || nx === '"') inStr = false;
      else { out += '\\"'; continue; }
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function tryParse(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : undefined;
  } catch { return undefined; }
}

/** 从文本中截取第一段括号配对的 JSON（跳过字符串内部括号，容忍前后废话） */
function sliceFirstJson(s) {
  const arrStart = s.indexOf('[');
  const objStart = s.indexOf('{');
  let start = -1;
  if (arrStart >= 0 && objStart >= 0) start = Math.min(arrStart, objStart);
  else start = arrStart >= 0 ? arrStart : objStart;
  if (start < 0) return null;
  const openCh = s[start];
  const closeCh = openCh === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 从模型输出里抠出 JSON（数组或对象）。
 * 解析顺序：```围栏块 → 全文直接 parse → 截取第一对括号 → repairJson 修复后重试。
 */
export function extractJson(text) {
  if (!text) return null;
  const raw = String(text).trim();
  const candidates = [];
  const fenceRe = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(raw)) !== null) candidates.push(m[1].trim());
  candidates.push(raw);
  for (const cand of candidates) {
    if (!cand) continue;
    let v = tryParse(cand);
    if (v !== undefined) return v;
    const sliced = sliceFirstJson(cand);
    if (sliced) {
      v = tryParse(sliced);
      if (v !== undefined) return v;
      v = tryParse(repairJson(sliced));
      if (v !== undefined) return v;
    }
    v = tryParse(repairJson(cand));
    if (v !== undefined) return v;
  }
  return null;
}

/**
 * 要求模型返回「镜头/条目数组」时用这个。
 * 兼容三种形状：裸数组 [...]、围栏数组、json_object 模式包装的 {shots:[...]}。
 */
export function extractJsonArray(text) {
  const v = extractJson(text);
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    const arr = Object.values(v).find(Array.isArray);
    if (arr) return arr;
  }
  return null;
}

export function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  // 非安全上下文（比如 http 访问）的兜底
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy') ? resolve() : reject(new Error('复制失败'));
    } catch (e) { reject(e); }
    document.body.removeChild(ta);
  });
}

export function downloadUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
