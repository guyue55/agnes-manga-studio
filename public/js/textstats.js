/**
 * textstats.js — 长文本口径的**纯函数**集中地（R16/R17/R18）
 *
 * 为什么单独一个模块：剧本链路的"计数 / 软上限 / 必填判定"散落在两个页面里最容易走样
 * （同一段文本在 scripts 页显示 5,999 字、在 storyboards 页判定超限），而这类逻辑又最适合
 * 用纯函数测边界。所以：只放无副作用的判定与格式化，不碰 DOM、不碰 api。
 *
 * 核心立场（对齐本项目"不静默截断"的既有约定）：
 *   **软上限只提醒 + 要求用户明确确认，绝不自动截断用户输入**。截断是最隐蔽的骗人——
 *   用户以为整段都喂给模型了，实际被砍掉一半，还只能从跑偏的产物里倒推。
 */

/** 单个长文本字段的建议上限（超过只是"可能变慢/超时"，不是硬闸） */
export const FIELD_SOFT_LIMIT = 6000;
/** 整条提示词（变量替换之后）的建议上限 */
export const PROMPT_SOFT_LIMIT = 12000;

/** 长文本变量的名字特征：这类变量用多行输入框、参与字数统计与必填判定 */
export function isLongVar(name) {
  return /脚本|内容|梗概|大纲|原文|小说|想法|创意|设定|点子/.test(String(name || ''));
}

/**
 * 按"字"计数的直觉口径：按码点算，而不是 UTF-16 码元。
 * 差别在 emoji 与生僻字：`'😀'.length === 2`，但用户眼里那就是一个字。
 */
export function charCount(v) {
  const s = String(v ?? '');
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** 千分位展示：1,234 字（中英文环境都一样，纯手写避免 locale 依赖） */
export function countLabel(n) {
  const x = Math.max(0, Math.floor(Number(n) || 0));
  return `${String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} 字`;
}

/**
 * 单个字段的计数状态。
 * level: empty（还没填）| ok | soft（超建议上限，需确认）
 */
export function limitState(n, soft = FIELD_SOFT_LIMIT) {
  const chars = Math.max(0, Math.floor(Number(n) || 0));
  if (chars === 0) return { chars, level: 'empty', over: false, text: '0 字' };
  if (chars <= soft) return { chars, level: 'ok', over: false, text: countLabel(chars) };
  return {
    chars,
    level: 'soft',
    over: true,
    text: `${countLabel(chars)} · 超过建议上限 ${countLabel(soft)}，生成可能变慢甚至超时`,
  };
}

/** 变量替换后的提示词总长（把 messages 里所有 content 加起来，用户看到的是"这次要发出去多少字"） */
export function promptLength(messages) {
  return (Array.isArray(messages) ? messages : [])
    .reduce((n, m) => n + charCount(m && m.content), 0);
}

/**
 * 生成前的变量体检（R16 的"确认门禁"就落在这里，而不是散在事件回调里）。
 *  · emptyLong：长文本变量空着 → **必须拦住**：没有素材的生成等于白烧一次配额
 *  · emptyShort：短变量空着 → 只提醒确认，模板里会写成「（未填写）」
 *  · over：超软上限的字段 → 提醒确认
 * 返回纯数据，页面负责怎么呈现（这样它可以在 uitest 里被直接断言）。
 */
export function checkPromptVars(vars, values, { soft = FIELD_SOFT_LIMIT } = {}) {
  const get = (v) => String((values && values[v]) ?? '');
  const emptyLong = [];
  const emptyShort = [];
  const over = [];
  for (const v of Array.isArray(vars) ? vars : []) {
    const val = get(v);
    if (!val.trim()) {
      if (isLongVar(v)) emptyLong.push(v);
      else emptyShort.push(v);
      continue;
    }
    const st = limitState(charCount(val), soft);
    if (st.over) over.push({ name: v, chars: st.chars });
  }
  return { emptyLong, emptyShort, over, blocked: emptyLong.length > 0 };
}

/**
 * 提示词体检的结论：null = 无需打扰用户；否则给出 { kind, title, lines, okText } 供确认弹窗直接渲染。
 * kind: 'blocked'（拦住）| 'confirm'（要确认）
 */
export function promptGate({ emptyLong = [], emptyShort = [], over = [], total = 0, soft = PROMPT_SOFT_LIMIT } = {}) {
  if (emptyLong.length) {
    return {
      kind: 'blocked',
      title: '还缺生成素材',
      lines: [
        `这些长文本字段还是空的：${emptyLong.join('、')}。`,
        '空着生成只会得到一段跑偏的稿子，还照样扣一次配额——先填上，或从上一个步骤「带入下一步」。',
      ],
      okText: '知道了',
    };
  }
  const lines = [];
  if (emptyShort.length) lines.push(`这些字段是空的，模板里会写成「（未填写）」：${emptyShort.join('、')}`);
  if (over.length) lines.push(`这些字段超过了建议上限（${countLabel(FIELD_SOFT_LIMIT)}）：${over.map((o) => `${o.name} ${countLabel(o.chars)}`).join('、')}`);
  if (total > soft) lines.push(`整条提示词 ${countLabel(total)}，超过建议上限 ${countLabel(soft)}，Agnes 侧可能变慢甚至超时。`);
  if (!lines.length) return null;
  return { kind: 'confirm', title: '生成前确认', lines, okText: '继续生成' };
}
