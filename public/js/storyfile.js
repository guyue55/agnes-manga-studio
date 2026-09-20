/**
 * storyfile.js — 原著文件的本地读取与文本规范化（批 8 / 批 8 补 23）
 *
 * 为什么单独一个模块：
 *  ① 「读文件」与「页面渲染」是两件事，混在页面里就没法离线断言；
 *  ② 文本规范化必须与后端 `lib/story.js` 的 `normalizeText` **同源**——
 *     前端算出来的"1 万字"如果和后端切块时看到的不一样，用户就会觉得字数在骗人。
 *     uitest 有一条钉直接 import 两边的函数比对输出，改一边必须同步改另一边。
 *
 * 明确不做服务器端上传：文件在浏览器里读成文本即可，原文本来就要进 `story_sources`，
 * 多一条上传通路 = 多一个可被外部写入的入口（与 B4 的 X2 纪律一致）。
 *
 * **关于 .docx（批 8 补 23 修正了这里的判断）**：原来写的是"docx/pdf 是另一个数量级的依赖"，
 * 这对 PDF 成立、对 .docx **不成立** —— .docx 就是个 zip，里面装着一份 `word/document.xml`，
 * 而浏览器原生就有 `DecompressionStream('deflate-raw')`。于是这里用**零依赖**的方式解 docx：
 * 自己读 zip 的中央目录（几十行），再用原生解压，然后把 XML 剥成纯文本。
 * 作者的稿件绝大多数是 .docx，"请先另存为 txt"这一步是可以省掉的。
 * **PDF 仍然不做**，理由换成了准确的：PDF 的文字提取要处理字体编码/子集/CID 映射，
 * 那是真正另一个数量级的问题，与"零 npm 依赖"冲突。
 */

/** 允许选择的扩展名（accept 属性与校验共用一份，避免"能选中却被拒"） */
export const STORY_FILE_ACCEPT = ['.txt', '.md', '.markdown', '.docx'];
/** 单文件上限 20MB：超过这个体积的多半是选错了文件（视频/压缩包），而不是原著 */
export const STORY_FILE_MAX = 20 * 1024 * 1024;

/** 选文件前的准入判断。纯函数，便于离线断言。 */
export function checkStoryFile({ name = '', size = 0 } = {}) {
  const lower = String(name).toLowerCase();
  if (!STORY_FILE_ACCEPT.some((ext) => lower.endsWith(ext))) {
    return { ok: false, error: `只支持 ${STORY_FILE_ACCEPT.join(' / ')}；PDF 请先另存为 txt（PDF 的文字提取要处理字体编码，不是"读个文件"那么简单）` };
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

// ── zip（只读，够用即止）────────────────────────────────────────────
// 只实现读中央目录所必需的部分；遇到 ZIP64 直接**如实拒绝**，不猜着往下读
// （猜错的后果是"读出来一堆乱码"，比明确报错难查得多）。

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/** 从尾部往前找 EOCD（zip 允许带最多 64KB 注释，所以不能只看最后 22 字节） */
function findEocd(dv, len) {
  const min = Math.max(0, len - 22 - 65535);
  for (let i = len - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * 列出 zip 里的条目：`[{ name, method, compressedSize, size, offset }]`。
 * `offset` 是**局部头**的位置（压缩数据要按局部头里的名字/扩展域长度再算一次偏移 ——
 * 中央目录里的扩展域长度与局部头里的可以不一样，这是 zip 的经典坑）。
 */
export function listZipEntries(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (buf.length < 22) return { ok: false, error: '这不是一个有效的 zip/docx（文件太小）' };
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = findEocd(dv, buf.length);
  if (eocd < 0) return { ok: false, error: '这不是一个有效的 zip/docx（找不到目录结尾）' };
  if (eocd >= 20 && dv.getUint32(eocd - 20, true) === EOCD64_LOCATOR_SIG) {
    return { ok: false, error: '这个文件用了 ZIP64 格式（通常超过 4GB），暂不支持——请另存为 txt' };
  }
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== CEN_SIG) break;
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const name = new TextDecoder('utf-8').decode(buf.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { ok: true, entries };
}

/** 取某个条目的**原始（可能还是压缩的）字节**。返回 `{ok, method, bytes}`。 */
export function readZipEntryRaw(bytes, entry) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const off = entry.offset;
  if (off + 30 > buf.length || dv.getUint32(off, true) !== LOC_SIG) {
    return { ok: false, error: '文件结构异常（局部头对不上），读不出内容' };
  }
  const nameLen = dv.getUint16(off + 26, true);
  const extraLen = dv.getUint16(off + 28, true);
  const start = off + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length) return { ok: false, error: '文件结构异常（内容超出文件长度），读不出内容' };
  return { ok: true, method: entry.method, bytes: buf.subarray(start, end) };
}

/** 解压 deflate-raw。用浏览器/Node 原生的 DecompressionStream，不引第三方库。 */
export async function inflateRawBytes(raw) {
  if (typeof DecompressionStream !== 'function') {
    return { ok: false, error: '这个浏览器不支持原生解压（DecompressionStream），请另存为 txt' };
  }
  try {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([raw]).stream().pipeThrough(ds);
    const out = await new Response(stream).arrayBuffer();
    return { ok: true, bytes: new Uint8Array(out) };
  } catch (e) {
    return { ok: false, error: `解压失败：${e && e.message ? e.message : '文件可能已损坏'}` };
  }
}

/** 读出 zip 里某个条目的文本内容（自动处理"存储"与"deflate"两种方式）。 */
export async function readZipText(bytes, name) {
  const listed = listZipEntries(bytes);
  if (!listed.ok) return listed;
  const entry = listed.entries.find((x) => x.name === name);
  if (!entry) return { ok: false, error: `文件里没有 ${name}` };
  const raw = readZipEntryRaw(bytes, entry);
  if (!raw.ok) return raw;
  if (raw.method === 0) return { ok: true, text: new TextDecoder('utf-8').decode(raw.bytes) };
  if (raw.method !== 8) return { ok: false, error: `不支持的压缩方式（${raw.method}）` };
  const inf = await inflateRawBytes(raw.bytes);
  if (!inf.ok) return inf;
  return { ok: true, text: new TextDecoder('utf-8').decode(inf.bytes) };
}

// ── .docx 正文 → 纯文本 ────────────────────────────────────────────

/** XML 实体解码。`&amp;` 必须**最后**解，否则 `&amp;lt;` 会被解成 `<`。 */
export function decodeXmlEntities(v) {
  return String(v == null ? '' : v)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * `word/document.xml` → 纯文本。纯函数，可离线断言。
 *
 * 做法是"先认段落与换行，再把剩下的标签全剥掉"：
 *  · `</w:p>`（段落结束）→ 空行；`<w:br/>`（软换行）→ 换行；`<w:tab/>` → 制表符；
 *  · 其余标签一律删掉 —— `<w:t>` 里的文字自然留下来，同一段里多个 run 会正确拼接。
 * 只读 `document.xml`，所以批注/脚注/页眉不会被混进正文。
 */
export function docxXmlToText(xml) {
  const s = String(xml == null ? '' : xml)
    // 段落与换行先落成真正的分隔符
    .replace(/<w:br\b[^>]*\/?>/g, '\n')
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<\/w:p>/g, '\n\n')
    .replace(/<w:p\b[^>]*\/>/g, '\n\n')
    // 删掉所有剩余标签（含 XML 声明、命名空间、批注引用等）
    .replace(/<[^>]*>/g, '');
  return decodeXmlEntities(s);
}

/** 读一个 File 对象 → {ok, text, note} | {ok:false, error}。 */
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

/** 按扩展名分发：.docx 走 zip 解出正文，其余当纯文本读。 */
export async function parseStoryFile(file) {
  const chk = checkStoryFile(file || {});
  if (!chk.ok) return chk;
  const lower = String((file && file.name) || '').toLowerCase();
  if (!lower.endsWith('.docx')) return parseStoryText(file);
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (e) {
    return { ok: false, error: `读取失败：${e && e.message ? e.message : '未知原因'}` };
  }
  const xml = await readZipText(bytes, 'word/document.xml');
  if (!xml.ok) return { ok: false, error: `读不出 Word 正文：${xml.error}` };
  const text = normalizeStoryText(docxXmlToText(xml.text));
  if (!text) return { ok: false, error: 'Word 文档里没有可解析的文字（可能是空文档，或正文全在图片里）' };
  return { ok: true, text, note: `${text.split('\n').length} 行 · 来自 Word 文档` };
}
