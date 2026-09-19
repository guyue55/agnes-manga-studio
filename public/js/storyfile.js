/**
 * storyfile.js — 原著文件的本地读取与文本规范化（批 8）
 *
 * 为什么单独一个模块：
 *  ① 「读文件」与「页面渲染」是两件事，混在页面里就没法离线断言；
 *  ② 文本规范化必须与后端 `lib/story.js` 的 `normalizeText` **同源**——
 *     前端算出来的"1 万字"如果和后端切块时看到的不一样，用户就会觉得字数在骗人。
 *     uitest 有一条钉直接 import 两边的函数比对输出，改一边必须同步改另一边。
 *
 * 明确不做服务器端上传：.txt/.md 在浏览器里读成文本即可，原文本来就要进 `story_sources`，
 * 多一条上传通路 = 多一个可被外部写入的入口（与 B4 的 X2 纪律一致）。
 * .docx/.pdf 解析也不做——那是另一个数量级的依赖，与"零 npm 依赖"冲突。
 */

/** 允许选择的扩展名（accept 属性与校验共用一份，避免"能选中却被拒"） */
export const STORY_FILE_ACCEPT = ['.txt', '.md', '.markdown'];
/** 单文件上限 20MB：超过这个体积的多半是选错了文件（视频/压缩包），而不是原著 */
export const STORY_FILE_MAX = 20 * 1024 * 1024;

/** 选文件前的准入判断。纯函数，便于离线断言。 */
export function checkStoryFile({ name = '', size = 0 } = {}) {
  const lower = String(name).toLowerCase();
  if (!STORY_FILE_ACCEPT.some((ext) => lower.endsWith(ext))) {
    return { ok: false, error: `只支持 ${STORY_FILE_ACCEPT.join(' / ')} 纯文本；Word/PDF 请先另存为 txt` };
  }
  if (!size) return { ok: false, error: '这个文件是空的' };
  if (size > STORY_FILE_MAX) {
    return { ok: false, error: `文件 ${(size / 1024 / 1024).toFixed(1)}MB，超过 ${STORY_FILE_MAX / 1024 / 1024}MB 上限` };
  }
  return { ok: true };
}

/**
 * 文本规范化。**必须与后端 `lib/story.js` 的 `normalizeText` 保持一致**：
 * 去掉 BOM、统一换行、每行去尾随空白、3 个以上连续换行压成 2 个、整体 trim。
 */
export function normalizeStoryText(v) {
  return String(v == null ? '' : v)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 读一个 File 对象 → {ok, text, note} | {ok:false, error}。
 * 用 `file.text()`（现代浏览器原生）而不是 FileReader：少一层事件回调，也不用手工拼 state。
 */
export async function parseStoryText(file) {
  const chk = checkStoryFile(file || {});
  if (!chk.ok) return chk;
  let raw = '';
  try {
    raw = await file.text();
  } catch (e) {
    return { ok: false, error: `读取失败：${e && e.message ? e.message : '未知原因'}` };
  }
  const text = normalizeStoryText(raw);
  if (!text) return { ok: false, error: '文件里没有可解析的文字（可能是空文件或纯空白）' };
  const lines = text.split('\n').length;
  return { ok: true, text, note: `${lines} 行` };
}
