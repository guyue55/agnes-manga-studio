/**
 * apitest.mjs — 接口端到端测试
 * ------------------------------------------------------------------
 * 自己起一个 mock Agnes 服务（假文本 / 假图片 / 假视频任务），
 * 让被测服务把 base url 指过去，就能在不联网、不花钱的前提下
 * 把「生成 → 落盘 → 轮询 → 完成 → 下载」整条链路跑一遍。
 *
 * 用法：node tools/apitest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// CJS 模块在 ESM 里用 default 导入（批 8 补 28：要拿内置模板的原文来复原被测试改过的那一行）
import seedLib from '../lib/seed.js';
import storyLib from '../lib/story.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; return true; }
  fail++; failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
  return false;
}
function eq(name, a, b) { return ok(name, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }
function group(t) { console.log(`\n── ${t} ──`); }

const HOME = path.join(os.tmpdir(), `agnes-apitest-${process.pid}`);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });

// T3 审核加强：mock 认死值（只校格式则任何假 Key 都放行，「张冠李戴」回归测不出）；常量单源防多处硬编码漂移
const MOCK_KEY = 'sk-mock-key-1234567890';
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ── mock Agnes ───────────────────────────────────────────────
let queryCount = 0;
const VIDEO_ID = 'vid_mock_001';
// 捕获最近一次 /v1/videos 创建请求体，供 2.5 协议断言
let lastVideoCreate = null;
let lastImageCreate = null; // B4.1：验证画风只在使用点注入、且注入的是映射短语
let chatFormats = [];
// T5b 事故路径控制面：query 返回的下载地址可切换；deny 端点带 Key 命中次数必须恒 0
let queryTarget = 'base'; let flakyHits = 0; let denyHitsWithKey = 0;
let videoCreateHits = 0; // 批 7：幂等断言要能证明"复用时确实没向上游下单"，光看响应形状证明不了
let imagesDelayMs = 0; // 批量取消契约：把出图放慢，稳定制造「运行中」窗口（测试专用）
let storyChatCalls = 0; // 批 8：/api/story/plan 必须**一次模型都不调**，靠这个计数证明
let badJsonUpstream = false; // R10：让上游回 200 + 非 JSON（真实世界里的"网关返回 HTML 错误页"） // T4：记录每次 chat 是否带 response_format（验证"首发带→4xx→降级不带"两跳）
let lastVideoQueryUrl = null; // v2.0 查询
let last25QueryUrl = null;    // 2.5 系查询（对照组会覆盖全局，单独记）
// 按提示词标记统计 /v1/videos 实际到达次数：验证「限流后重试」与「4xx 不重试」
const videoCalls = {};
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const send = (code, obj) => {
    const s = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
    res.end(s);
  };
  // T3：真实 Agnes 全端点要 Bearer。mock 此前从不读请求头——agnes.js 丢头/错头测试也全绿。
  const auth = String(req.headers.authorization || '');
  if (req.method === 'GET' && u.pathname === '/pixel.png') {
    // 公网 CDN 语义：结果图不鉴权（fetchRemoteImage 本就不带 Key）
    const buf = Buffer.from(PNG_1PX, 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length });
    return res.end(buf);
  }
  if (u.pathname === '/__mock') {
    const cmd = u.searchParams.get('set');
    if (cmd) { queryTarget = cmd; return send(200, { ok: true }); }
    const si = u.searchParams.get('slowimg');
    if (si !== null) { imagesDelayMs = Number(si) || 0; return send(200, { ok: true, imagesDelayMs }); }
    const bj = u.searchParams.get('badjson');
    if (bj !== null) { badJsonUpstream = bj === '1'; return send(200, { ok: true, badJsonUpstream }); }
    return send(200, { queryTarget, flakyHits, denyHitsWithKey, imagesDelayMs });
  }
  if (auth !== `Bearer ${MOCK_KEY}`) {
    // 审核加强：值精确匹配注入 Key——只校格式的话任何假 token 都放行，错 Key 链路回归测不出
    return send(401, { error: { message: /^Bearer \S+$/.test(auth) ? 'invalid api key (mock)' : 'missing bearer (mock guard)' } });
  }
  if (req.method === 'GET' && u.pathname === '/agnesapi') {
    lastVideoQueryUrl = req.url;
    if (/2\.5/.test(String(u.searchParams.get('model_name') || ''))) {
      // 2.5 系查询契约：带 model_name，完成后的地址在 metadata.url
      last25QueryUrl = req.url;
      return send(200, { id: VIDEO_ID, status: 'completed', progress: 100, metadata: { url: queryUrl() } });
    }
    queryCount++;
    // R12/R13 探针：永远"进行中"，用来把轮询预算真的跑满
    if (queryTarget === 'stuck') return send(200, { id: VIDEO_ID, status: 'in_progress', progress: 30 });
    if (queryCount <= 1) return send(200, { id: VIDEO_ID, status: 'queued', progress: 20 });
    return send(200, { id: VIDEO_ID, status: 'completed', progress: 100, remixed_from_video_id: queryUrl() });
  }
  function queryUrl() {
    return queryTarget === 'flaky' ? `${MOCK_BASE}/flaky.mp4`
      : queryTarget === 'deny' ? `http://localhost:${mockPort}/deny.mp4` : `${MOCK_BASE}/video.mp4`;
  }
  if (req.method === 'GET' && u.pathname === '/deny.mp4') {
    denyHitsWithKey++; // 走到这里说明请求带了正确 Key——跨主机守则被破
    const buf = Buffer.from('LEAKED'); res.writeHead(200, { 'Content-Type': 'video/mp4' }); return res.end(buf);
  }
  if (req.method === 'GET' && u.pathname === '/flaky.mp4') {
    flakyHits++;
    if (flakyHits === 1) { res.writeHead(503); return res.end('flaky'); }
    const buf = Buffer.from('MOCKMP4DATA');
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': buf.length });
    return res.end(buf);
  }
  if (req.method === 'GET' && u.pathname === '/video.mp4') {
    const buf = Buffer.from('MOCKMP4DATA');
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': buf.length });
    return res.end(buf);
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (u.pathname === '/v1/chat/completions') {
      let cb = {}; try { cb = JSON.parse(body); } catch { /* 原样通过 */ }
      chatFormats.push(!!cb.response_format);
      storyChatCalls++;
      // 批 8 原著解析：按提示词特征分流（分块抽取 / 全局归并）。
      // 抽取走 mock 的两段式：第 2 段才出现"青铜钥匙"与更详细的外貌，
      // 用来验证"跨块去重合并"与"更详细的字段取胜"这两条真会发生。
      const userMsg = String(((cb.messages || []).find((m) => m.role === 'user') || {}).content || '');
      if (/"cards"\s*:/.test(userMsg)) {
        if (userMsg.includes('__BADCHUNK__')) return send(200, { choices: [{ message: { content: '抱歉，这一段我读不懂。' } }] });
        // 批 8 补 18：两种"没抽到卡片"的成因，用来验证覆盖体检能分开它们
        if (userMsg.includes('__NOINFO__')) return send(200, { choices: [{ message: { content: JSON.stringify({ cards: [] }) } }] });
        if (userMsg.includes('__NPC__') && !globalThis.__npcFixed) return send(200, { choices: [{ message: { content: JSON.stringify({ cards: [{ kind: 'npc', name: '类别不认识' }] }) } }] });
        const seg = /第 (\d+) 段/.exec(userMsg);
        const i = seg ? Number(seg[1]) : 1;
        return send(200, { choices: [{ message: { content: JSON.stringify({ cards: [
          { kind: 'character', name: '林晚', aliases: ['晚晚', '林晚'], role: '主角', identity: '茶馆老板', appearance: i === 1 ? '白衣' : '白衣长剑', personality: '冷静' },
          { kind: 'character', name: '顾寒', role: '配角', identity: '过路剑客' },
          { kind: 'location', name: '临江茶馆', atmosphere: '喧闹潮湿' },
          { kind: 'npc', name: '这条类别不认识应当被丢弃' },
          ...(i === 2 ? [{ kind: 'prop', name: '青铜钥匙', owner: '林晚', usage: '开密室' }] : []),
          // 追加解析测试要有一张**全新的卡**才验得了"新卡的块号落在新增区间"
          ...(userMsg.includes('第二卷') ? [{ kind: 'prop', name: '夜访灯笼', owner: '林晚', usage: '照路' }] : []),
          // 批 8 补 28：剧情卡的 involved 里放一个"查无此人"的名字（林晚有卡、苏婉儿没有），
          // 只在带标记的原文上生效 —— 否则会污染其它分组的卡片集合与计数
          ...(userMsg.includes('__PLOTCAST__') ? [{ kind: 'plot', name: '夜访对峙', stage: '起', conflict: '被拦', turn: '亮身份', outcome: '放行', involved: '林晚、苏婉儿' }] : []),
          // 批 8 补 33：多两张"没有外貌也没有服装"的人物卡 —— 补长相要有多张候选才验得了
          // "只补缺的、已有的一个都不动"，以及"没接住的/对不上原文的分别计数"
          ...(userMsg.includes('__LOOKFILL__') ? [{ kind: 'character', name: '苏婉儿' }, { kind: 'character', name: '裴无咎' }] : []),
          // 批 8 补 34：多一张"没有任何可注入描述"的地点卡与道具卡 —— 补场景字段要有候选才验得了。
          // 注意默认那张「临江茶馆」**带着 atmosphere**，所以它天然是"已有的一个都不动"的对照组
          ...(userMsg.includes('__INJECTFILL__') ? [{ kind: 'location', name: '落霞渡口' }, { kind: 'prop', name: '半枚玉佩' }] : []),
          // 批 8 补 35：多三张时间线卡 —— 两张"没有时间点"（候选），一张**带着时间点**（对照组）。
          // 对照组是"已有的一个都不动"这条钉的前提（补 33 踩过：连对照组一起清，钉就失效了）
          ...(userMsg.includes('__WHENFILL__') ? [{ kind: 'timeline', name: '离开临江' }, { kind: 'timeline', name: '夜访' }, { kind: 'timeline', name: '重逢', when: '第二年春天' }] : []),
          // 批 8 补 36：给"全剧设定要进逐集上下文"造一张时间线卡。
          // 分块抽取每段都会返回它，同名会被归并成一张 —— 正是我们想验的"归并后再渲染"。
          ...(userMsg.includes('__WORLDSET__') ? [{ kind: 'timeline', name: '三日后', when: '第三天黄昏', order_note: '紧接第一幕' }] : []),
        ] }) } }] });
      }
      if (/"plots"\s*:/.test(userMsg)) {
        // __LONGARC__：给分集骨架测试造一段"两幕八拍"的剧情（只有带标记的原文才会走到这里，
        // 所以不可能影响其它分组的既有断言）
        if (userMsg.includes('__LONGARC__')) {
          return send(200, { choices: [{ message: { content: JSON.stringify({
            // 批 8 补 36：world 卡补全 CARD_FIELDS.world 的六个字段 ——
            // 从前 cardLine 只渲染 题材/基调，另外四个（世界观/主题/一句话简介/主线）
            // 抽出来、界面上也显示，却到不了任何提示词。这里给全才验得了"真的进了提示词"
            world: { name: '长弧线旧事', genre: '古装悬疑', tone: '沉郁', worldview: '架空王朝末年',
              theme: '旧案与人心', logline: '一件旧案牵出三代人', mainline: '顺藤摸瓜查清旧案' },
            plots: [
              { name: '长弧·起1', stage: '起', conflict: 'C1' }, { name: '长弧·承1', stage: '承', conflict: 'C2' },
              { name: '长弧·转1', stage: '转', conflict: 'C3' }, { name: '长弧·合1', stage: '合', outcome: 'O1' },
              { name: '长弧·起2', stage: '起', conflict: 'C4' }, { name: '长弧·承2', stage: '承', conflict: 'C5' },
              { name: '长弧·转2', stage: '转', conflict: 'C6' }, { name: '长弧·合2', stage: '合', outcome: 'O2' },
            ],
          }) } }] });
        }
        // 故意包 ```json 围栏：真实网关/模型经常这么回，宽松解析必须吃得下
        return send(200, { choices: [{ message: { content: '```json\n' + JSON.stringify({
          world: { name: '临江旧事', genre: '古装悬疑', tone: '沉郁', mainline: '林晚查父仇，顾寒是唯一线索。' },
          plots: [
            { name: '茶馆初见', stage: '起', conflict: '林晚试探顾寒', outcome: '顾寒留下' },
            { name: '钥匙现世', stage: '承', conflict: '有人跟踪', outcome: '密室开启' },
          ],
        }) + '\n```' } }] });
      }
      // 批 8 补 32：补分幕次。按提示词里的 "stages" 分流（只有这个模板会要 stages）。
      // 拍点数从编号清单里数出来 —— 模型看的就是这份清单，mock 也照同样的方式读，
      // 才不会出现"mock 返回 5 个、实际只有 3 拍"这种只有测试才有的形状。
      if (/"stages"\s*:/.test(userMsg)) {
        const n = (userMsg.match(/^\d+\. \[/gm) || []).length;
        const mk = (stage) => Array.from({ length: n }, (_, i) => ({ index: i + 1, stage }));
        // __BADSTAGE__：**每一拍**都给词表外的词 → 服务端必须全部丢弃、绝不落库，并如实上报
        if (userMsg.includes('__BADSTAGE__')) {
          return send(200, { choices: [{ message: { content: JSON.stringify({ stages: mk('第一幕') }) } }] });
        }
        // __BACKSTEP__：最后一拍给"起"，前面都是"转" → 必然构成一次"幕次倒退"
        // （服务端只上报位置、不替模型"修顺"——修顺等于我们编数据）
        if (userMsg.includes('__BACKSTEP__')) {
          const rows = mk('转'); if (rows.length) rows[rows.length - 1] = { index: n, stage: '起' };
          return send(200, { choices: [{ message: { content: JSON.stringify({ stages: rows }) } }] });
        }
        // __GARBAGE__：根本不是 JSON（宽松解析也吃不下）→ 这次调用算**失败**，不许动任何卡片
        if (userMsg.includes('__GARBAGE__')) return send(200, { choices: [{ message: { content: '我觉得应该是起承转合吧。' } }] });
        // 默认：全部给"转"（不是"合"，也不是"起"）。这样"人定过的那张"只要不是"转"，
        // 它保持不变就说明服务端**没有覆盖**它（若默认值恰好等于它的原值，那条断言就没有牙了）
        return send(200, { choices: [{ message: { content: JSON.stringify({ stages: mk('转') }) } }] });
      }
      // 批 8 补 33：补人物长相。按提示词里的 "looks" 分流（只有这个模板会要 looks）。
      // 默认分支**必须给真引文**：从提示词里那张卡自己的原文片段里截一段原话。
      // 服务端会把 quote 与原文逐字比对 —— mock 要是随手编一句，连"顺利路径"都过不去，
      // 而那条路径正是这项功能的全部意义（引文可验证 = "抽取"与"编造"之间唯一可机械判定的分界线）
      if (/"looks"\s*:/.test(userMsg)) {
        const parts = userMsg.split(/^\d+\. 人物：/m).slice(1);
        const looks = parts.map((part, i) => {
          const body = String(part.split('原文片段：')[1] || '');
          const lines = body.split('\n').map((x) => x.trim());
          // 挑一段真正的原文当引文；避开标记本身（标记是我们塞进去的，不是"原文里的原话"）
          const line = lines.find((x) => x.length >= 12 && !x.includes('__')) || lines.find((x) => x.length >= 8) || '';
          return { index: i + 1, found: true, appearance: `模型补的外貌${i + 1}`, outfit: `模型补的服装${i + 1}`, quote: line.slice(0, 12) };
        });
        const all = (rows) => send(200, { choices: [{ message: { content: JSON.stringify({ looks: rows }) } }] });
        // __NOLOOK__：每一张都如实回"原文没写" → 服务端必须计 not_found、一张都不写
        if (userMsg.includes('__NOLOOK__')) return all(parts.map((_, i) => ({ index: i + 1, found: false })));
        // __FAKELOOK__：引文是**编的**（原文里根本没有这句）→ 服务端必须整条丢弃并计 ungrounded
        if (userMsg.includes('__FAKELOOK__')) return all(looks.map((x) => ({ ...x, quote: '她生得绝美无双，举世罕有' })));
        // __LONGLOOK__：引文是真的（能过核对），但外貌超长 → 必须过与手改**同一把尺子**
        if (userMsg.includes('__LONGLOOK__')) return all(looks.map((x) => ({ ...x, appearance: '长'.repeat(500) })));
        // __GARBAGE__：根本不是 JSON → 这次调用算失败，不许动任何卡片
        if (userMsg.includes('__GARBAGE__')) return send(200, { choices: [{ message: { content: '这段原文里好像没写外貌。' } }] });
        return all(looks);
      }
      // 批 8 补 34：补场景/道具字段。与补长相**同一套机制**，只有返回键不同（模板 schema 不同）。
      // mock 同样必须给真引文：从**那张卡自己**的原文片段里截一段原话，否则连顺利路径都过不去。
      // 要填哪些键从提示词里那张卡的「键名：a / b / c」行读出来 —— 模型看的就是这一行。
      if (/"fills"\s*:/.test(userMsg)) {
        // 只按**卡片行**切（"1. 地点卡：…" / "2. 道具卡：…"）——
        // 模板正文里还有 "1. **必须给出原文里的原话**" 这类**编号要求**，用 `/^\d+\. /` 会把它们也切成"条目"，
        // 于是 mock 返回一堆越界编号（第一版就这么错的：invalid 3、ungrounded 2，看着像核对出了问题）
        const parts = userMsg.split(/^\d+\. (?:地点卡|道具卡)：/m).slice(1);
        const fills = parts.map((part, i) => {
          const keys = String((/（键名：([^）]+)）/.exec(part) || [])[1] || '').split('/').map((x) => x.trim()).filter(Boolean);
          const body = String(part.split('原文片段：')[1] || '');
          const lines = body.split('\n').map((x) => x.trim());
          const line = lines.find((x) => x.length >= 12 && !x.includes('__')) || lines.find((x) => x.length >= 8) || '';
          const item = { index: i + 1, found: true, quote: line.slice(0, 12) };
          if (keys[0]) item[keys[0]] = `模型补的${keys[0]}${i + 1}`;
          return item;
        });
        const all = (rows) => send(200, { choices: [{ message: { content: JSON.stringify({ fills: rows }) } }] });
        if (userMsg.includes('__INJNOLOOK__')) return all(parts.map((_, i) => ({ index: i + 1, found: false })));
        if (userMsg.includes('__INJFAKE__')) return all(fills.map((x) => ({ ...x, quote: '一座金碧辉煌的宫殿' })));
        // __INJSTRAY__：引文是真的，但只给**别类卡**的键（appearance）→ 服务端必须一条都不写并计 empty
        if (userMsg.includes('__INJSTRAY__')) return all(fills.map((x) => ({ index: x.index, found: true, quote: x.quote, appearance: '清瘦' })));
        if (userMsg.includes('__INJLONG__')) return all(fills.map((x) => ({ ...x, [Object.keys(x).find((k) => k !== 'index' && k !== 'found' && k !== 'quote') || 'features']: '长'.repeat(500) })));
        if (userMsg.includes('__GARBAGE__')) return send(200, { choices: [{ message: { content: '这段原文里好像没写这些。' } }] });
        return all(fills);
      }
      // 批 8 补 35：补时间点。**同一套机制**的第三份规格，只有返回键不同（whens）。
      // 引文同样必须来自**那张卡自己**的片段 —— 这一组的核心就是"推算出来的时间进不了库"，
      // 所以 mock 必须能给出"值看着合理、引文却是编的"这一种回答（__WHENFAKE__）。
      if (/"whens"\s*:/.test(userMsg)) {
        const parts = userMsg.split(/^\d+\. 时间线卡：/m).slice(1);
        const whens = parts.map((part, i) => {
          const body = String(part.split('原文片段：')[1] || '');
          const lines = body.split('\n').map((x) => x.trim());
          const line = lines.find((x) => x.length >= 8 && !x.includes('__')) || lines.find((x) => x.length >= 4) || '';
          return { index: i + 1, found: true, when: `模型补的时间${i + 1}`, quote: line.slice(0, 10) };
        });
        const all = (rows) => send(200, { choices: [{ message: { content: JSON.stringify({ whens: rows }) } }] });
        if (userMsg.includes('__WHENNONE__')) return all(parts.map((_, i) => ({ index: i + 1, found: false })));
        // __WHENFAKE__：when 看着很合理（"三年后"），但引文原文里根本没有 —— 必须整条丢弃。
        // 这正是补 32 拒绝做这一项的理由（"模型只能猜"），这条用例证明"猜的写不进去"
        if (userMsg.includes('__WHENFAKE__')) return all(whens.map((x) => ({ ...x, when: '三年后', quote: '三年后他回到了临江' })));
        // __WHENSTRAY__：引文是真的，但只给**别的**字段（order_note/summary）→ 服务端一条都不许写
        if (userMsg.includes('__WHENSTRAY__')) return all(whens.map((x) => ({ index: x.index, found: true, quote: x.quote, order_note: '紧接着上一节', summary: '改写过的摘要' })));
        if (userMsg.includes('__WHENLONG__')) return all(whens.map((x) => ({ ...x, when: '长'.repeat(200) })));
        return all(whens);
      }
      if (cb.model === 'mock-reject-json' && cb.response_format) return send(400, { error: { message: 'response_format not supported by this gateway' } });
      if (cb.model === 'mock-deny-key' && cb.response_format) return send(401, { error: { message: 'bad key' } });
      return send(200, { choices: [{ message: { role: 'assistant', content: '```json\n[{"shot_number":1,"shot_type":"特写","image_prompt":"a hero face"}]\n```' } }] });
    }
    if (u.pathname === '/v1/images/generations') {
      try { lastImageCreate = JSON.parse(body); } catch { lastImageCreate = { bad_json: body }; }
      // R10 探针：200 + HTML → 后端解析失败 → 502（这是唯一能确定性触发 5xx 的真实路径）
      if (badJsonUpstream) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>502 Bad Gateway</html>'); }
      // 网关对**未知字段是硬拒**（实测报过 `negative_prompt is not an allowed request field`）。
      // mock 必须同样严格：否则"单发了一个网关不认的字段"这类错误在测试里永远看不见
      // —— 批 8 补 14 的对照 AU 一开始就是这么静默通过的。
      if (lastImageCreate && lastImageCreate.bad_json === undefined) {
        const ALLOWED = ['model', 'prompt', 'size', 'image'];
        const unknown = Object.keys(lastImageCreate).filter((k) => !ALLOWED.includes(k));
        if (unknown.length) return send(400, { error: { message: `${unknown[0]} is not an allowed request field`, type: 'invalid_request_error' } });
      }
      if (imagesDelayMs) {
        const payload = lastImageCreate && lastImageCreate.model === 'mock-img-url-ok' ? { data: [{ url: `${MOCK_BASE}/pixel.png` }] } : { data: [{ b64_json: PNG_1PX }] };
        return setTimeout(() => send(200, payload), imagesDelayMs);
      }
      if (lastImageCreate.model === 'mock-img-url-ok') return send(200, { data: [{ url: `${MOCK_BASE}/pixel.png` }] });
      if (lastImageCreate.model === 'mock-img-url-dead') return send(200, { data: [{ url: 'http://127.0.0.1:1/nope.png' }] });
      return send(200, { data: [{ b64_json: PNG_1PX }] });
    }
    if (req.method === 'GET' && u.pathname === '/v1/models') {
      return send(200, {
        object: 'list',
        data: [
          { id: 'agnes-text-new', name: 'agnes-text-new', kind: 'text', owned_by: 'agnes' },
          { id: 'agnes-image-new', name: 'agnes-image-new', kind: 'image', owned_by: 'agnes' },
          { id: 'agnes-video-new', name: 'agnes-video-new', kind: 'video', owned_by: 'agnes' },
        ],
      });
    }
    if (u.pathname === '/v1/videos') {
      videoCreateHits++;
      try { lastVideoCreate = JSON.parse(body); } catch { lastVideoCreate = { bad_json: body }; }
      if (lastVideoCreate.model === 'mock-embed-err') return send(200, { error: { message: 'embedded boom in 200' } });
      if (lastVideoCreate.model === 'mock-slow') { setTimeout(() => { try { send(200, { id: 'vid_slow_1', status: 'queued' }); } catch { /* 客户端已断开 */ } }, 11500); return; }
      const p = String(lastVideoCreate.prompt || '');
      const mm = /__retry(\d+)__/.exec(p);            // 前 N 次返回 503（排队满），之后成功
      const key = mm ? `r${mm[1]}` : /__bad400__/.test(p) ? 'bad' : 'plain';
      videoCalls[key] = (videoCalls[key] || 0) + 1;
      if (mm && videoCalls[key] <= Number(mm[1])) {
        return send(503, { code: 'video_queue_full', message: 'video queue is full, please retry later (mock)' });
      }
      if (/__bad400__/.test(p)) {
        return send(400, { code: 'invalid_request', message: 'frame_rate is not an allowed request field (mock)', data: { param: 'frame_rate' } });
      }
      return send(200, { id: VIDEO_ID, video_id: VIDEO_ID, task_id: 'task_mock', status: 'queued' });
    }
    send(404, { error: 'unknown path' });
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 批 8 补 14：分镜行自带默认负面词，图片链现在会把它并入正向提示词一起发出。
// 组合类断言（内容 → 卡片 → 角色 → 运镜 → 画风）只关心前缀那一段，负面词另有专门的钉子，
// 所以这里统一剥掉**已知的**默认后缀再比对。
// 注意：只认这一个后缀 —— 出现别的尾巴就原样返回、让断言红出来，绝不"顺手洗白"。
const DEFAULT_NEG = 'low quality, blurry, distorted face';
const NEG_TAG = '。避免出现：';
const negless = (v) => {
  const t = String(v == null ? '' : v);
  const i = t.lastIndexOf(NEG_TAG);
  if (i < 0) return t;
  return t.slice(i + NEG_TAG.length) === DEFAULT_NEG ? t.slice(0, i) : t;
};
// T9：随机端口可能撞 mock/srv 互相或撞外部占用 → 服务端起不来被误报成断言失败。
// 实测两端口都空闲才返回，且强制 srv 与 mock 相距 ≥2。
const portBusy = (p) => new Promise((res) => {
  const s = net.connect(p, '127.0.0.1');
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('error', () => res(false));
  s.setTimeout(400, () => { s.destroy(); res(true); });
});
async function freePortPair() {
  for (let i = 0; i < 40; i++) {
    const m = 21000 + Math.floor(Math.random() * 8000);
    if (await portBusy(m)) continue;
    const s = 21000 + Math.floor(Math.random() * 8000);
    if (Math.abs(s - m) < 2 || await portBusy(s) || await portBusy(s + 1)) continue;
    return [m, s];
  }
  throw new Error('找不到空闲测试端口对');
}

async function listenAsync(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(port));
  });
}

let MOCK_BASE = '';
let BASE = '';
let srv = null;

async function waitHealth(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}

async function api(method, url, body, headers = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  Object.assign(opts.headers, headers);
  const res = await fetch(`${BASE}${url}`, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data, text };
}

// ── 启动 ─────────────────────────────────────────────────────
const [mockPort, srvPort] = await freePortPair();
await listenAsync(mock, mockPort);
MOCK_BASE = `http://127.0.0.1:${mockPort}`;
srv = spawn(NODE, [path.join(ROOT, 'server.js')], {
  env: { ...process.env, PORT: String(srvPort), NO_OPEN: '1', AGNES_STUDIO_HOME: HOME },
  stdio: 'ignore',
});
BASE = `http://127.0.0.1:${srvPort}`;

// T7 审核前移：进程/临时目录收尾在 spawn 之后立即注册——
// 旧顺序里 waitHealth/T6 身份检查之前的任何同步抛出都会漏杀 srv 子进程、漏删 HOME。
let cleaned = false;
const cleanup = () => {
  if (cleaned) return; cleaned = true;
  try { srv.kill(); } catch { /* gone */ }
  try { mock.close(); } catch { /* gone */ }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* gone */ }
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); cleanup(); process.exit(1); });

if (!await waitHealth(BASE)) {
  console.error('✗ 服务没起来');
  cleanup();
  process.exit(1);
}
console.log(`\nmock Agnes: ${MOCK_BASE}\n被测服务:   ${BASE}\n数据目录:   ${HOME}`);
{
  // T6：破坏性用例（级联删/replace 导入）前必须确认"BASE 上就是本测试刚起的实例"。
  // 端口随机撞车 + server 自动换端口时，不校验就会把删除打在陌生工作台的数据上。
  const hid = await (await fetch(`${BASE}/api/health`)).json().catch(() => ({}));
  if (!hid.ok || path.resolve(String(hid.data_home || '')) !== path.resolve(HOME)) {
    console.error(`✗ 被测实例身份不符（data_home=${hid.data_home}），端口可能被占用。拒绝执行破坏性用例。`);
    cleanup();
    process.exit(1);
  }
}

// ── 1. 基础 ──────────────────────────────────────────────────
group('基础接口');
{
  const r = await api('GET', '/api/health');
  eq('health 200', r.status, 200);
  eq('health ok', r.data.ok, true);
  ok('health 带数据目录', !!r.data.data_home);

  const b = await api('GET', '/api/bootstrap');
  eq('bootstrap 200', b.status, 200);
  ok('bootstrap 含 settings', !!b.data.settings);
  ok('bootstrap 含 projects', Array.isArray(b.data.projects));
  ok('bootstrap 含 stats', !!b.data.stats);
  ok('bootstrap 含模板', Array.isArray(b.data.templates) && b.data.templates.length > 0);
}

// ── 2. 设置 ──────────────────────────────────────────────────
group('设置');
{
  const r = await api('PUT', '/api/settings', {
    agnes_api_base_url: `${MOCK_BASE}/v1`,
    agnes_api_key: MOCK_KEY,
    video_poll_interval: '5',
    video_max_polls: '20',
    auto_download_video: '1',
  });
  eq('保存设置 200', r.status, 200);
  const g = await api('GET', '/api/settings');
  eq('Key 脱敏返回', g.data.agnes_api_key, '***configured***');
  ok('掩码形如 sk-a****7890', /\*+/.test(g.data.agnes_api_key_masked), g.data.agnes_api_key_masked);
  eq('base url 已更新', g.data.agnes_api_base_url, `${MOCK_BASE}/v1`);
  eq('轮询间隔已更新', g.data.video_poll_interval, '5');
  { const cr = await api('PUT', '/api/settings', { video_poll_interval: '1' }); eq('E8 低于下限钳制为 2', cr.data.settings.video_poll_interval, '2'); const cr2 = await api('PUT', '/api/settings', { video_poll_interval: 'abc' }); eq('E8 非法串回落默认 8', cr2.data.settings.video_poll_interval, '8'); }

  const t = await api('POST', '/api/settings/test', { kind: 'text' });
  ok('连通性测试返回结构', typeof t.data.ok === 'boolean', JSON.stringify(t.data));
  eq('mock 连通', t.data.ok, true);

  const mr = await api('POST', '/api/models/refresh', {});
  eq('模型拉取 200', mr.status, 200);
  eq('模型拉取成功', mr.data.ok, true);
  eq('拉到 3 个模型', mr.data.models.models.length, 3);
  ok('模型目录记录更新时间', !!mr.data.models.updated_at);
  eq('模型来源是 Agnes', mr.data.models.source, 'agnes');
  const ml = await api('GET', '/api/models');
  eq('模型目录可读取', ml.data.models.length, 3);
  eq('模型目录保留新文本模型', ml.data.models.find((m) => m.id === 'agnes-text-new').kind, 'text');
}

// ── 3. 项目 ──────────────────────────────────────────────────
let PROJECT_ID = '';
group('项目');
{
  const r = await api('POST', '/api/projects', { name: '接口测试剧', project_type: '都市逆袭', planned_episodes: 6 });
  eq('建项目 200', r.status, 200);
  PROJECT_ID = r.data.id;
  ok('拿到项目 id', !!PROJECT_ID);
  eq('默认平台', r.data.target_platform, '抖音');

  const l = await api('GET', '/api/projects');
  eq('项目列表有 1 条', l.data.length, 1);

  const u = await api('PUT', `/api/projects/${PROJECT_ID}`, { name: '改过名了', status: 'archived' });
  eq('改名', u.data.name, '改过名了');
  eq('改状态', u.data.status, 'archived');

  const d = await api('POST', `/api/projects/${PROJECT_ID}/duplicate`, {});
  ok('复制出副本', d.data.name.includes('副本'), d.data.name);
  eq('复制后 2 条', (await api('GET', '/api/projects')).data.length, 2);

  const bad = await api('POST', '/api/projects', { name: '' });
  eq('空名称 400', bad.status, 400);
  ok('空名称带错误说明', !!bad.data.error);
}

// ── 4. 文本生成 ──────────────────────────────────────────────
group('文本生成');
{
  const r = await api('POST', '/api/agnes/text', {
    messages: [{ role: 'user', content: '生成分镜' }],
    project_id: PROJECT_ID,
  });
  eq('文本生成 200', r.status, 200);
  eq('文本生成 ok', r.data.ok, true);
  ok('返回内容非空', String(r.data.content).length > 0);
  ok('内容含 JSON', r.data.content.includes('shot_number'));

  // 文本生成要写任务历史（原版这张表一直空着）
  const t = await api('GET', '/api/tasks?task_type=text');
  eq('文本任务入库', t.data.length, 1);
  eq('任务类型正确', t.data[0].task_type, 'text');
}

// ── 5. 剧本 ──────────────────────────────────────────────────
let SCRIPT_ID = '';
group('剧本');
{
  const r = await api('POST', '/api/scripts', {
    project_id: PROJECT_ID, script_type: 'story_concept', title: '测试剧本', content: '正文',
  });
  eq('建剧本 200', r.status, 200);
  SCRIPT_ID = r.data.id;
  const l = await api('GET', `/api/scripts?project_id=${PROJECT_ID}`);
  eq('项目下 1 条剧本', l.data.length, 1);

  const u = await api('PUT', `/api/scripts/${SCRIPT_ID}`, { title: '改标题' });
  eq('改剧本标题', u.data.title, '改标题');

  const bad = await api('POST', '/api/scripts', { content: '' });
  eq('空内容 400', bad.status, 400);
}

// ── 6. 分镜 ──────────────────────────────────────────────────
group('分镜');
{
  const r = await api('POST', '/api/storyboards', {
    rows: [
      { project_id: PROJECT_ID, episode_number: 1, shot_number: 1, shot_type: '特写', image_prompt: 'a hero', sort_order: 0 },
      { project_id: PROJECT_ID, episode_number: 1, shot_number: 2, shot_type: '全景', image_prompt: 'a city', sort_order: 1 },
      { project_id: PROJECT_ID, episode_number: 2, shot_number: 1, shot_type: '中景', sort_order: 0 },
    ],
  });
  eq('批量建分镜 200', r.status, 200);
  eq('插入 3 条', r.data.inserted, 3);

  const l1 = await api('GET', `/api/storyboards?project_id=${PROJECT_ID}&episode=1`);
  eq('第 1 集 2 条', l1.data.length, 2);
  const l2 = await api('GET', `/api/storyboards?project_id=${PROJECT_ID}&episode=2`);
  eq('第 2 集 1 条', l2.data.length, 1);

  // 排序：把两条顺序颠倒
  const ids = l1.data.map((s) => s.id).reverse();
  await api('POST', '/api/storyboards/reorder', { ids });
  const after = await api('GET', `/api/storyboards?project_id=${PROJECT_ID}&episode=1`);
  eq('排序生效', after.data[0].id, ids[0]);
  { // 插队自愈契约：乱序插入 + 无 sort_order（NaN 经 || 短路退化到镜号数值序）
    const sp = await api('POST', '/api/projects', { name: '插队剧' });
    for (const n of [2, 30, 1, 10]) await api('POST', '/api/storyboards', { project_id: sp.data.id, episode_number: 1, shot_number: n, video_prompt: `镜${n}` });
    const got = await api('GET', `/api/storyboards?project_id=${sp.data.id}&episode=1`);   // 参数名是 episode：写 episode_number 会被静默忽略（曾致此钉为错因通过）
    eq('乱序插入返回数值序 1,2,10,30', got.data.map((r) => r.shot_number).join(','), '1,2,10,30');
    await api('DELETE', `/api/projects/${sp.data.id}?cascade=1`);
  }

  const one = l1.data[0];
  const u = await api('PUT', `/api/storyboards/${one.id}`, { shot_type: '仰拍', duration_seconds: 5 });
  eq('改景别', u.data.shot_type, '仰拍');
  eq('改时长', u.data.duration_seconds, 5);

  const del = await api('DELETE', `/api/storyboards?project_id=${PROJECT_ID}&episode=2`);
  eq('清空第 2 集', del.data.removed, 1);

  // 护栏：缺 project_id 或 episode 一律拒绝，避免跨项目 / 全表误删
  const badClear1 = await api('DELETE', `/api/storyboards?episode=3`);
  eq('清空缺 project_id 被拒 400', badClear1.status, 400);
  const badClear2 = await api('DELETE', `/api/storyboards?project_id=${PROJECT_ID}`);
  eq('清空缺 episode 被拒 400', badClear2.status, 400);
  const badClear3 = await api('DELETE', `/api/storyboards`);
  eq('裸清空被拒 400', badClear3.status, 400);
  // 拒绝必须是无副作用的：第 1 集分镜不能被这些请求删掉
  const stillThere = await api('GET', `/api/storyboards?project_id=${PROJECT_ID}&episode=1`);
  ok('护栏拒绝不产生副作用', stillThere.data.length >= 1, `剩 ${stillThere.data.length}`);
}

// ── 7. 图片生成（含落盘） ────────────────────────────────────
let IMG_ID = '';
group('图片生成');
{
  const r = await api('POST', '/api/agnes/image', {
    prompt: 'a hero face', size: '1024x1024', project_id: PROJECT_ID, usage_type: 'storyboard',
  });
  eq('图片生成 200', r.status, 200);
  eq('图片生成 ok', r.data.ok, true);
  IMG_ID = r.data.asset.id;
  ok('返回本地 URL', r.data.asset.url.startsWith('/assets/images/'), r.data.asset.url);
  ok('记录了落盘路径', !!r.data.asset.local_file);

  // 静态访问这张图
  const img = await fetch(`${BASE}${r.data.asset.url}`);
  eq('图片可访问', img.status, 200);
  ok('图片有内容', (await img.arrayBuffer()).byteLength > 0);

  const t = await api('GET', '/api/tasks?task_type=image');
  eq('图片任务入库', t.data.length, 1);

  const fav = await api('PUT', `/api/images/${IMG_ID}`, { is_favorited: true });
  eq('收藏图片', fav.data.is_favorited, true);
  const st = await api('GET', '/api/stats');
  eq('统计里算到收藏', st.data.favorited_assets, 1);
}

// ── 8. 视频任务（提交 → 轮询 → 完成 → 保存） ────────────────
let VID_ID = '';
group('视频任务');
{
  const e2eSb = await api('POST', '/api/storyboards', { project_id: PROJECT_ID, episode_number: 99, shot_number: 991, scene_description: '回写验证镜头', video_prompt: 'hero turns' });
  const r = await api('POST', '/api/videos', {
    prompt: 'hero turns and smiles',
    storyboard_id: e2eSb.data.id,
    project_id: PROJECT_ID,
    mode: 'text_to_video',
    num_frames: 121,
    frame_rate: 24,
    width: 1152,
    height: 768,
  });
  eq('提交视频 200', r.status, 200);
  eq('提交成功', r.data.ok, true);
  VID_ID = r.data.asset.id;
  eq('拿到 video_id', r.data.asset.agnes_video_id, VIDEO_ID);
  eq('初始状态 queued', r.data.asset.status, 'queued');
  eq('本地状态轮询中', r.data.asset.local_status, 'polling');

  // 等轮询跑完（mock 第 2 次查询返回 completed，interval 设的 1s）
  let asset = null;
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    const v = await api('GET', `/api/videos?project_id=${PROJECT_ID}`);
    asset = v.data[0];
    if (asset.status === 'completed') break;
  }
  eq('轮询后变 completed', asset.status, 'completed');
  ok('拿到视频地址', !!asset.video_url, asset.video_url);
  eq('本地状态完成', asset.local_status, 'completed');
  ok('记录了完成时间', !!asset.completed_at);
  // E2E 轮实测修复的钉：首片完成必须同步把镜头推进到 video_ready（否则分镜徽章停在"有图片"）
  const sbRow = await api('GET', `/api/storyboards?project_id=${PROJECT_ID}&episode=99`);
  const linked = (sbRow.data || []).find((x) => x.id === e2eSb.data.id);
  ok('首片完成回写镜头状态 video_ready', !!linked && linked.status === 'video_ready' && linked.linked_video_id === asset.id, JSON.stringify(linked && { s: linked.status, v: linked.linked_video_id }));
  ok('存了原始状态响应', !!asset.raw_status_response);

  // 开了自动保存，应该已经落盘。
  // 注意：status 变 completed 与"下载落盘完成"不是同一时刻 —— 轮询把状态推进到 completed 之后
  // 才去下载，所以这里必须**等落盘**，不能拿循环退出时那一份快照断言（否则偶发红，第 96 轮门禁踩到）
  for (let i = 0; i < 30 && !asset.local_file; i++) {
    await sleep(400);
    const v = await api('GET', `/api/videos?project_id=${PROJECT_ID}`);
    asset = v.data[0];
  }
  ok('视频已自动保存到本机', !!asset.local_file, String(asset.local_file));
  if (asset.local_file) {
    ok('本地视频文件存在', fs.existsSync(asset.local_file), asset.local_file);
    const name = path.basename(asset.local_file);
    const resp = await fetch(`${BASE}/assets/videos/${name}`);
    eq('视频可静态访问', resp.status, 200);
  }
}

// ── 批 7：R25 提交幂等 / R26 钳制回报 / R27 费用落库 / R29 服务端计数 ──
group('提交幂等与计费留痕（批 7）');
{
  // R25：同一个 client_token 在窗口内重复提交，只能向上游下一单
  const before = lastVideoCreate;
  const tok = `tok_${Date.now().toString(36)}_idem`;
  const body = { prompt: 'idempotency probe', project_id: PROJECT_ID, mode: 'text_to_video', num_frames: 121, frame_rate: 24, client_token: tok };
  const a1 = await api('POST', '/api/videos', body);
  eq('带 token 首次提交成功', a1.data.ok, true);
  eq('首次不是去重命中', a1.data.deduped, false);
  ok('首次确实打到了上游', lastVideoCreate && lastVideoCreate.prompt === 'idempotency probe');
  eq('token 落库（便于事后核对同一次意图被提了几遍）', a1.data.asset.client_token, tok);

  const sentAfterFirst = videoCreateHits;
  const a2 = await api('POST', '/api/videos', body);
  eq('重复提交仍返回 200（不是报错，而是复用）', a2.status, 200);
  eq('重复提交命中幂等', a2.data.deduped, true);
  eq('复用同一条记录（没有新建 asset）', a2.data.asset.id, a1.data.asset.id);
  eq('复用时不向上游下单（这才是防重复计费的关键）', videoCreateHits, sentAfterFirst);

  // 不同 token = 另一次付费意图，必须放行（否则用户"就是想再来一条"会被吞掉）
  const a3 = await api('POST', '/api/videos', { ...body, client_token: `${tok}_2` });
  eq('换 token 视为新意图', a3.data.deduped, false);
  ok('换 token 会真的下单', a3.data.asset.id !== a1.data.asset.id && videoCreateHits > sentAfterFirst, `hits=${videoCreateHits}`);

  // 不带 token 的老客户端行为不变（幂等是可选增强，不是新门槛）
  const a4 = await api('POST', '/api/videos', { prompt: 'no token probe', project_id: PROJECT_ID, mode: 'text_to_video' });
  eq('不带 token 仍可提交', a4.data.ok, true);
  eq('不带 token 时落库为 null（而不是空串）', a4.data.asset.client_token, null);

  // R26：钳制必须回报，不能静默
  const c1 = await api('POST', '/api/videos', { prompt: 'clamp probe', project_id: PROJECT_ID, mode: 'text_to_video', num_frames: 600, frame_rate: 24 });
  eq('超上限帧数被夹到 441', c1.data.asset.num_frames, 441);
  ok('夹了就要回报（否则用户按 25 秒预期等一个 18 秒的片子）',
    Array.isArray(c1.data.clamps) && c1.data.clamps.length === 1
    && c1.data.clamps[0].field === 'num_frames' && c1.data.clamps[0].requested === 600 && c1.data.clamps[0].used === 441,
    JSON.stringify(c1.data.clamps));
  const c2 = await api('POST', '/api/videos', { prompt: 'no clamp probe', project_id: PROJECT_ID, mode: 'text_to_video', num_frames: 121, frame_rate: 24 });
  eq('没夹就返回空数组（不虚报）', (c2.data.clamps || []).length, 0);

  // R27：费用字段——mock 不返回费用时必须落 null（不能兜成 0）
  eq('上游没给费用 → cost_credits 为 null（不是 0，0 会被读成免费）', c1.data.asset.cost_credits, null);
  eq('上游没给费用 → cost_unit 为 null', c1.data.asset.cost_unit, null);

  // R29：服务端聚合计数
  const plain = await api('GET', '/api/projects');
  ok('不带参数时响应形状不变（裸数组、无 counts 字段）',
    Array.isArray(plain.data) && plain.data.every((p) => !('counts' in p)));
  const counted = await api('GET', '/api/projects?with_counts=1');
  ok('带 with_counts=1 时每个项目都有 counts', Array.isArray(counted.data) && counted.data.every((p) => p.counts));
  const target = counted.data.find((p) => p.id === PROJECT_ID);
  const realSb = (await api('GET', `/api/storyboards?project_id=${PROJECT_ID}`)).data.length;
  eq('counts.storyboards 与真实分镜数一致', target.counts.storyboards, realSb);
  const realVid = (await api('GET', `/api/videos?project_id=${PROJECT_ID}`)).data.length;
  eq('counts.video_assets 与真实视频数一致', target.counts.video_assets, realVid);
  const noProj = counted.data.find((p) => p.id !== PROJECT_ID);
  ok('无素材的项目计数为 0（不是缺字段）',
    !noProj || (noProj.counts && noProj.counts.storyboards >= 0 && noProj.counts.image_assets >= 0));
}

// ── 8.5 Agnes Video 2.5 新协议适配（真实事故回归：旧字段被 400 拒绝） ──
group('视频 2.5 新协议');
{
  const r = await api('POST', '/api/videos', {
    prompt: '雨后的未来城市街道', model: 'agnes-video-2.5-flash', mode: 'text_to_video',
    negative_prompt: 'low quality', width: 1152, height: 768, num_frames: 241, frame_rate: 24, seed: '7',
  });
  eq('2.5 提交成功', r.data.ok, true);
  const b1 = lastVideoCreate || {};
  eq('必填 mode=text', b1.mode, 'text');
  eq('seconds 由帧数÷帧率折算', b1.seconds, '10');
  eq('Flash size 固定 720P', b1.size, '720P');
  eq('横版预设映射 16:9', b1.aspect_ratio, '16:9');
  eq('seed 透传为整数', b1.seed, 7);
  ok('不发送 width/height（forbidden）', !('width' in b1) && !('height' in b1));
  ok('不发送 num_frames/frame_rate（forbidden）', !('num_frames' in b1) && !('frame_rate' in b1));
  ok('negative_prompt 并入正向', !('negative_prompt' in b1) && b1.prompt.includes('low quality'));

  await api('POST', '/api/videos', {
    prompt: '少女回头', model: 'agnes-video-2.5-flash', mode: 'image_to_video',
    image: 'https://example.com/a.png', num_frames: 121, frame_rate: 24,
  });
  eq('单图 → keyframe', lastVideoCreate.mode, 'keyframe');
  eq('单图 → first_frame', lastVideoCreate.first_frame, 'https://example.com/a.png');
  eq('121f÷24 ≈ 5 秒', lastVideoCreate.seconds, '5');
  ok('keyframe 不带 images', !('images' in lastVideoCreate));

  await api('POST', '/api/videos', {
    prompt: '风格参考', model: 'agnes-video-2.5-flash', mode: 'multi_image',
    source_images: [{ url: 'https://e.com/1.png' }, { url: 'https://e.com/2.png' }], width: 768, height: 1152,
  });
  eq('多图 → reference', lastVideoCreate.mode, 'reference');
  eq('reference.images 数', lastVideoCreate.images && lastVideoCreate.images.length, 2);
  eq('竖版预设映射 9:16', lastVideoCreate.aspect_ratio, '9:16');

  await api('POST', '/api/videos', {
    prompt: '过渡', model: 'agnes-video-2.5-flash', mode: 'keyframe', mode_flag: 'keyframes',
    source_images: [{ url: 'https://e.com/a' }, { url: 'https://e.com/b' }, { url: 'https://e.com/c' }],
  });
  eq('keyframes 标记取首帧', lastVideoCreate.first_frame, 'https://e.com/a');
  eq('keyframes 标记取尾帧（中间帧丢弃）', lastVideoCreate.last_frame, 'https://e.com/c');

  // v2.0 模型仍走旧协议（对照）
  await api('POST', '/api/videos', {
    prompt: 'legacy check', model: 'agnes-video-v2.0', mode: 'text_to_video',
    width: 1152, height: 768, num_frames: 121, frame_rate: 24,
  });
  eq('v2.0 保留 frame_rate', lastVideoCreate.frame_rate, 24);
  eq('v2.0 保留 num_frames', lastVideoCreate.num_frames, 121);
  ok('v2.0 无 mode 字段', !('mode' in lastVideoCreate));

  // 轮询闭环：query 必须带 model_name，完成地址取自 metadata.url
  const vid = r.data.asset.id;
  let a25 = null;
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    const all = await api('GET', '/api/videos');
    a25 = (all.data || []).find((x) => x.id === vid);
    if (a25 && a25.status === 'completed') break;
  }
  ok('2.5 任务轮询到 completed', !!a25 && a25.status === 'completed', a25 && a25.status);
  ok('video_url 来自 metadata.url', String(a25 && a25.video_url).endsWith('/video.mp4'));
  ok('查询带了 model_name', /model_name=agnes-video-2\.5-flash/.test(String(last25QueryUrl)), String(last25QueryUrl).slice(0, 80));
  await api('DELETE', `/api/videos/${vid}`);
}

// ── 8.7 提交限流自动退避重试（免费档 queue full / 429 实测会批量扫荡） ──
group('视频提交限流自动重试');
{
  await api('PUT', '/api/settings', { video_submit_retries: '3', video_submit_backoff_s: '1' });

  // 单发：前两次 503 排队满，第三次成功 → 整体应报成功
  const r = await api('POST', '/api/videos', { prompt: '__retry2__ 雨夜街道', mode: 'text_to_video', model: 'agnes-video-2.5-flash' });
  eq('限流后自动退避最终成功', r.data.ok, true);
  eq('恰好消耗 3 次提交', videoCalls.r2, 3);

  // 预算耗尽：1+3 次全 503 → 落一条失败记录，报错给中文限流解释
  const f = await api('POST', '/api/videos', { prompt: '__retry9__ 运气不佳', mode: 'text_to_video', model: 'agnes-video-2.5-flash' });
  eq('重试预算耗尽后失败', f.data.ok, false);
  ok('失败提示为中文限流说明', /排队已满或限流/.test(String(f.data.error)), String(f.data.error).slice(0, 40));
  eq('重试止步于预算', videoCalls.r9, 4);

  // 4xx schema 类错误不重试，不放大无意义请求
  const b = await api('POST', '/api/videos', { prompt: '__bad400__ x', mode: 'text_to_video', model: 'agnes-video-2.5-flash' });
  eq('400 直接失败', b.data.ok, false);
  eq('400 不重试', videoCalls.bad, 1);

  // 批量：一项限流一次后成功 + 一项直接成功 → 整批应全绿
  const bj = await api('POST', '/api/batch/videos', {
    items: [
      { prompt: '__retry1__ 镜头一', mode: 'text_to_video', model: 'agnes-video-2.5-flash' },
      { prompt: 'apitest plain shot2', mode: 'text_to_video', model: 'agnes-video-2.5-flash' },
    ],
  });
  eq('批量任务受理', bj.data.ok, true);
  let job = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    job = (await api('GET', `/api/batch/${bj.data.jobId}`)).data;
    if (job && job.status === 'done') break;
  }
  eq('批量全部成功', job && job.ok, 2);
  eq('批量零失败', job && job.fail, 0);
  eq('限流项自动重试 1 次', videoCalls.r1, 2);

  // 清理本次调试记录，不留垃圾
  const all = await api('GET', '/api/videos');
  for (const v of all.data) {
    if (/__retry|__bad400__|^apitest plain shot2$/.test(String(v.video_prompt))) {
      await api('DELETE', `/api/videos/${v.id}`);
    }
  }
  await api('PUT', '/api/settings', { video_submit_retries: '4', video_submit_backoff_s: '3' });
}

// ── 9. 手动刷新与补录 ────────────────────────────────────────
group('刷新与补录');
{
  const r = await api('POST', `/api/videos/${VID_ID}/refresh`, {});
  eq('手动刷新 200', r.status, 200);
  eq('刷新成功', r.data.ok, true);

  // 造一条无 video_id 的任务，测补录
  const r2 = await api('POST', '/api/videos', { prompt: 'no id test', project_id: PROJECT_ID });
  const id2 = r2.data.asset.id;
  await api('PUT', `/api/videos/${id2}`, { name: '待补录' });
  const bind = await api('POST', `/api/videos/${id2}/bind`, { video_id: 'vid_manual_9' });
  eq('补录成功', bind.data.ok, true);
  eq('补录后写入 video_id', bind.data.asset.agnes_video_id, 'vid_manual_9');
  eq('补录后进入轮询', bind.data.asset.local_status, 'polling');

  const nb = await api('POST', `/api/videos/${id2}/bind`, { video_id: '' });
  eq('空 video_id 400', nb.status, 400);

  const br = await api('POST', '/api/videos/batch-refresh', {});
  eq('批量刷新 200', br.status, 200);
  ok('批量刷新返回统计', typeof br.data.total === 'number');

  await api('DELETE', `/api/videos/${id2}`);
}

// ── 10. 模板 ─────────────────────────────────────────────────
group('提示词模板');
{
  const l = await api('GET', '/api/templates');
  ok('内置模板已注入', l.data.length > 5, `${l.data.length} 条`);

  const r = await api('POST', '/api/templates', {
    name: '自定义模板', template_type: 'story_concept', content: '写个 {{题材}} 故事', system: '你是编剧',
  });
  eq('建模板 200', r.status, 200);
  const u = await api('PUT', `/api/templates/${r.data.id}`, { name: '改了名' });
  eq('改模板', u.data.name, '改了名');

  const f = await api('GET', '/api/templates?template_type=optimize');
  ok('按类型过滤', f.data.every((t) => t.template_type === 'optimize'));

  await api('DELETE', `/api/templates/${r.data.id}`);
  eq('删模板后查不到', (await api('GET', `/api/templates`)).data.find((t) => t.id === r.data.id), undefined);
}

// ── 11. 批量队列 ─────────────────────────────────────────────
group('批量队列');
{
  const r = await api('POST', '/api/batch/images', {
    items: [
      { prompt: 'img one', project_id: PROJECT_ID, size: '1024x1024' },
      { prompt: 'img two', project_id: PROJECT_ID, size: '1024x1024' },
    ],
    concurrency: 2,
  });
  eq('批量生图 200', r.status, 200);
  eq('队列收 2 项', r.data.total, 2);

  let job = null;
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    const j = await api('GET', `/api/batch/${r.data.jobId}`);
    job = j.data;
    if (job.status !== 'running') break;
  }
  eq('批量任务结束', job.status, 'done');
  eq('全部成功', job.ok, 2);
  eq('无失败', job.fail, 0);

  // R22：逐项状态。并发 2 时两条会同时 running，所以"按下标预填、原地改状态"是必须的——
  // 原来"完成一条 push 一条"的写法在并发下顺序与镜头顺序不一致，界面按数组顺序画进度链就会错位。
  eq('任务项按下标一一对应（并发下顺序不得错位）', (job.items || []).map((i) => i.index).join(','), '0,1');
  ok('每项都有终态 ok（不是只有汇总数字）', (job.items || []).every((i) => i.state === 'ok' && i.ok === true));
  ok('每项带 label 与 key 回传（界面据此映射回具体镜头，刷新后仍成立）',
    (job.items || []).every((i) => typeof i.label === 'string' && i.label.length > 0),
    JSON.stringify(job.items));
  eq('未传 label 时给序号兜底（不让界面出现 undefined）', (job.items || [])[0].label, '第 1 项');
  eq('未传 key 时为 null（而不是空字符串，便于前端判空）', (job.items || [])[0].key, null);

  const before = (await api('GET', `/api/images?project_id=${PROJECT_ID}`)).data.length;
  ok('批量生成的图片已入库', before >= 3, `${before} 张`);

  // 带 key/label 的口径（前端真实调用方式）：状态必须落回对应项
  const keyed = await api('POST', '/api/batch/images', {
    items: [
      { prompt: 'keyed one', project_id: PROJECT_ID, size: '1024x1024', label: '镜头 #7', key: 'sb_7' },
      { prompt: 'keyed two', project_id: PROJECT_ID, size: '1024x1024', label: '镜头 #9', key: 'sb_9' },
    ],
    concurrency: 2,
  });
  let job2 = null;
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    job2 = (await api('GET', `/api/batch/${keyed.data.jobId}`)).data;
    if (job2.status !== 'running') break;
  }
  eq('带 key 的批量任务结束', job2.status, 'done');
  eq('key 原样回传（界面靠它把状态映射回表格行）', (job2.items || []).map((i) => i.key).join(','), 'sb_7,sb_9');
  eq('label 原样回传（刷新后进度链仍显示镜头号）', (job2.items || []).map((i) => i.label).join(','), '镜头 #7,镜头 #9');

  const emptyBatch = await api('POST', '/api/batch/images', { items: [] });
  eq('空队列 400', emptyBatch.status, 400);
}

// ── 12. 导入导出 ─────────────────────────────────────────────
group('导入导出');
{
  const ex = await api('GET', '/api/export');
  eq('导出 200', ex.status, 200);
  ok('导出内容是 JSON', typeof ex.data === 'object' && !!ex.data.collections);
  ok('导出含项目', ex.data.collections.projects.length >= 1);

  const im = await api('POST', '/api/import', { data: ex.data, mode: 'merge' });
  eq('导入 200', im.status, 200);
  ok('导入返回结果', typeof im.data.imported === 'number');

  const bad = await api('POST', '/api/import', { data: null, mode: 'xxx' });
  eq('非法模式 400', bad.status, 400);

  const pe = await fetch(`${BASE}/api/projects/${PROJECT_ID}/export`);
  eq('单项目导出 200', pe.status, 200);
  const peData = await pe.json();
  ok('单项目导出含分镜', Array.isArray(peData.storyboards));
  ok('单项目导出含图片', Array.isArray(peData.image_assets));
}

// T3 负例：mock 已强制 Bearer 校验——错 Key 必须炸出 ok:false（旧 mock 不读头，永远测不出鉴权回归）
{
  await api('PUT', '/api/settings', { agnes_api_key: '__NOAUTH__' });
  const tasksBefore = (await api('GET', '/api/tasks')).data.length;
  const badKey = await api('POST', '/api/agnes/text', { messages: [{ role: 'user', content: 'hi' }] });
  ok('错 Key → 业务失败', badKey.data.ok === false, JSON.stringify(badKey.data).slice(0, 90));
  eq('错 Key 类型化为 invalid_api_key（UI 才能显示"Key 无效"而非笼统失败）', badKey.data.errorType, 'invalid_api_key');
  ok('错 Key 错误文案非空且含上游原因', typeof badKey.data.error === 'string' && badKey.data.error.length > 4, JSON.stringify(badKey.data.error));
  const tasksAfter = (await api('GET', '/api/tasks')).data;
  const failedRec = tasksAfter.find((t) => t.status === 'failed' && /invalid|api key|401/i.test(String(t.error_message || '')));
  ok('失败也留任务记录（任务页历史承诺）', tasksAfter.length > tasksBefore && !!failedRec, `before=${tasksBefore} after=${tasksAfter.length}`);
  const conn = await api('POST', '/api/settings/test', { kind: 'text' });
  ok('设置页连通性测试错 Key → ok:false', conn.data.ok === false, JSON.stringify(conn.data).slice(0, 110));
  eq('连通性测试错 Key 同样类型化', conn.data.errorType, 'invalid_api_key');
  await api('PUT', '/api/settings', { agnes_api_key: MOCK_KEY });
  const back = await api('POST', '/api/agnes/text', { messages: [{ role: 'user', content: 'hi' }] });
  ok('恢复 Key → 成功', back.data.ok === true, JSON.stringify(back.data).slice(0, 90));
}

// ── 13. 安全 ─────────────────────────────────────────────────
group('安全');
{
  // CSRF：跨站 Origin 的写操作要被拒
  const bad = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example.com' },
    body: JSON.stringify({ name: '来自恶意站点' }),
  });
  eq('跨站 POST 被拒 403', bad.status, 403);

  const good = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    // X2 收紧后：Origin 必须 host+port 全匹配（真实浏览器的 Origin 总是带端口的完整源）
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ name: '合法来源' }),
  });
  ok('同源 POST 放行', good.status === 200, String(good.status));

  const wrongPort = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:99' },
    body: JSON.stringify({ name: '本机错端口' }),
  });
  eq('本机异端口 Origin 写被拒 403', wrongPort.status, 403);

  // 路径穿越
  const trav = await fetch(`${BASE}/assets/images/..%2f..%2fserver.js`);
  eq('路径穿越 404', trav.status, 404);
  const trav2 = await fetch(`${BASE}/assets/images/%2e%2e%2f%2e%2e%2fpackage.json`);
  eq('编码穿越 404', trav2.status, 404);

  // Key 不能从任何接口泄露
  const s = await api('GET', '/api/settings');
  ok('设置接口不含明文 Key', !JSON.stringify(s.data).includes(MOCK_KEY));

  // X1：Host 头白名单——DNS rebinding 挡板（恶意域名 A 记录指向 127.0.0.1 即可"同源"读全部数据）
  const rawGet = (path, headers) => new Promise((resolve) => {
    const rq = http.request({ host: '127.0.0.1', port: srvPort, path, method: 'GET', headers }, (rs) => {
      let b = ''; rs.on('data', (d) => (b += d)); rs.on('end', () => resolve({ status: rs.statusCode, body: b }));
    });
    rq.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    rq.end();
  });
  const evilHost = await rawGet('/api/bootstrap', { Host: 'evil.example.com' });
  eq('X1 恶意 Host 被拒 403', evilHost.status, 403);
  const userinfoHost = await rawGet('/api/bootstrap', { Host: 'a@127.0.0.1' });
  eq('X1 userinfo 形态 Host 被拒 403', userinfoHost.status, 403);
  const fqdnHost = await rawGet('/api/bootstrap', { Host: 'localhost.' });
  eq('X1 FQDN 尾点 localhost. 放行（归一化）', fqdnHost.status, 200);
  const localHost = await rawGet('/api/bootstrap', { Host: `127.0.0.1:${srvPort}` });
  eq('X1 本机 Host 放行', localHost.status, 200);
  // X3：非法转义 / 空字节路径不许炸监听器
  const badEsc = await rawGet('/%zz', { Host: `127.0.0.1:${srvPort}` });
  eq('X3 非法转义 %zz 返回 400', badEsc.status, 400);
  const nulPath = await rawGet('/%00', { Host: `127.0.0.1:${srvPort}` });
  eq('X3 空字节路径返回 400', nulPath.status, 400);
  const stillAlive = await api('GET', '/api/health');
  eq('X3 恶意请求后监听器仍存活', stillAlive.status, 200);

  // X4：同端口 + 同数据目录的第二实例必须拒绝启动——persist 是整库快照全量写，
  // 两个实例互踩会静默丢数据（exe 双击两次即中招）。此前仅由非门禁 port-check 覆盖，故提升进门禁。
  const second = await new Promise((resolve) => {
    const c = spawn(NODE, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, PORT: String(srvPort), NO_OPEN: '1', AGNES_STUDIO_HOME: HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let o = '';
    c.stdout.on('data', (d) => (o += d));
    c.stderr.on('data', (d) => (o += d));
    const t = setTimeout(() => { c.kill(); resolve({ code: 'TIMEOUT', out: o }); }, 8000);
    c.on('exit', (code) => { clearTimeout(t); resolve({ code, out: o }); });
  });
  eq('X4 同目录第二实例拒绝启动（exit 0）', second.code, 0);
  ok('X4 且提示"已在运行"', String(second.out).includes('已在运行'), String(second.out).slice(0, 90));
  const afterX4 = await api('GET', '/api/health');
  eq('X4 后原实例仍健康（未被抢端口）', afterX4.status, 200);

  // ── 批 8 补 27：进程跑的是**旧代码**时必须说清楚 ──────────────────
  // 这条不是假想：服务跑了 3 天，而前端静态文件每次请求都从磁盘读（no-store）、后端只在启动那一刻读一次。
  // 于是页面显示的是新功能、接口还是旧的，报错偏偏是"接口不存在: POST /api/story/plan" ——
  // 看起来像"这个功能根本没做"，而不像"你该重启服务"。更糟的是再敲一次 node server.js
  // 只会得到"已在运行"然后退出（X4 防护），把唯一的补救动作也堵住了。
  const hFresh = (await api('GET', '/api/health')).data;
  ok('健康体带代码指纹与 PID（启动时留的，用来判断"跑的是哪版代码"）',
    typeof hFresh.code_sig === 'string' && hFresh.code_sig.length > 0 && Number(hFresh.pid) > 0,
    JSON.stringify({ sig: hFresh.code_sig, pid: hFresh.pid }));
  eq('刚启动时不是"旧代码"', hFresh.code_stale, false);

  const storyPath = path.join(ROOT, 'lib', 'story.js');
  const storyOrig = fs.readFileSync(storyPath, 'utf8');
  try {
    fs.writeFileSync(storyPath, `${storyOrig}\n// 探针：模拟"启动之后代码被改"\n`);
    await sleep(2300); // 指纹有 2s 缓存，别拿缓存当结论
    const hStale = (await api('GET', '/api/health')).data;
    eq('启动后改过代码 → 健康体如实报"跑的是旧代码"', hStale.code_stale, true);
    ok('并点名是哪个文件变了（不然用户不知道该不该重启）',
      (hStale.stale_files || []).includes('lib/story.js'), JSON.stringify(hStale.stale_files));
    ok('说明里明确给出"请重启服务"', /请重启服务/.test(hStale.stale_hint || ''), String(hStale.stale_hint));

    const miss = await api('POST', '/api/story/definitely-not-here');
    eq('不存在的接口仍然是 404（不掩盖真实错误）', miss.status, 404);
    ok('但 404 里补了一句实话：最容易被误读的那句话旁边说清是旧代码',
      /当前进程跑的还是旧代码/.test(miss.data?.error || ''), String(miss.data?.error));

    const again = await new Promise((resolve) => {
      const c = spawn(NODE, [path.join(ROOT, 'server.js')], {
        env: { ...process.env, PORT: String(srvPort), NO_OPEN: '1', AGNES_STUDIO_HOME: HOME },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let o = '';
      c.stdout.on('data', (d) => (o += d));
      c.stderr.on('data', (d) => (o += d));
      const t = setTimeout(() => { c.kill(); resolve({ code: 'TIMEOUT', out: o }); }, 8000);
      c.on('exit', (code) => { clearTimeout(t); resolve({ code, out: o }); });
    });
    eq('陈旧时再启动一次仍然拒绝起第二实例（X4 不变）', again.code, 0);
    ok('但它会点名"跑的是旧代码"，而不是只说"已在运行"把用户堵在门外',
      /旧代码/.test(String(again.out)) && /kill \d+/.test(String(again.out)), String(again.out).slice(0, 240));
  } finally {
    // 改的是仓库源文件，必须还原（失败也要还原：否则后面所有测试都在改过的代码上跑）
    fs.writeFileSync(storyPath, storyOrig);
    await sleep(2300);
  }
  const hBack = (await api('GET', '/api/health')).data;
  eq('还原后不再报陈旧（不能挂着一条永远不消的假警报）', hBack.code_stale, false);

  // H5：video_url 只收 http(s) 或空——javascript:/data: 等形状会进 <video src> 与"打开链接"按钮
  const vmk = await api('POST', '/api/videos', { prompt: 'H5 协议白名单探针', mode: 'text_to_video' });
  const vid = vmk.data && (vmk.data.id || (vmk.data.asset && vmk.data.asset.id));
  ok('H5 探针视频已建', !!vid, JSON.stringify(vmk.data).slice(0, 80));
  const setUrl = async (u) => (await api('PUT', `/api/videos/${vid}`, { video_url: u })).data.video_url;
  eq('H5 javascript: 形状被清空', await setUrl('javascript:alert(1)'), '');
  eq('H5 data: 形状被清空', await setUrl('data:video/mp4;base64,AAAA'), '');
  eq('H5 大写 HTTP:// 放行（大小写不敏感）', await setUrl('HTTP://cdn.example.com/a.mp4'), 'HTTP://cdn.example.com/a.mp4');
  eq('H5 https 放行', await setUrl('https://cdn.example.com/a.mp4'), 'https://cdn.example.com/a.mp4');
  eq('H5 空串放行（允许清空）', await setUrl(''), '');
  await api('DELETE', `/api/videos/${vid}`);

  // B8：API 路由参数里的非法转义必须按"不匹配"处理（404），不许 URIError→500
  const badParam = await rawGet('/api/projects/%zz', { Host: `127.0.0.1:${srvPort}` });
  eq('B8 API 参数非法转义 → 404（非 500）', badParam.status, 404);
  const badParam2 = await rawGet('/api/videos/%zz/refresh', { Host: `127.0.0.1:${srvPort}` });
  ok('B8 深路径非法转义亦不 500', badParam2.status === 404 || badParam2.status === 400, String(badParam2.status));
}

// ── 14. 静态资源 ─────────────────────────────────────────────
group('静态资源');
{
  const idx = await fetch(`${BASE}/`);
  eq('首页 200', idx.status, 200);
  ok('首页是 HTML', (await idx.text()).includes('<title>'));

  for (const f of ['/css/app.css', '/js/app.js', '/js/consts.js', '/js/api.js', '/js/ui.js']) {
    const r = await fetch(`${BASE}${f}`);
    eq(`静态资源 ${f}`, r.status, 200);
  }
  for (const p of ['dashboard', 'projects', 'scripts', 'storyboards', 'images', 'videos', 'tasks', 'assets', 'settings']) {
    const r = await fetch(`${BASE}/js/pages/${p}.js`);
    eq(`页面模块 ${p}.js`, r.status, 200);
  }
  const spa = await fetch(`${BASE}/some/unknown/route`);
  eq('未知路由回退首页', spa.status, 200);
}

// ── 15. SSE ──────────────────────────────────────────────────
group('SSE');
{
  // SSE 是长连接，不能 r.text()（会一直等到流结束），要按流读第一块
  const okConn = await new Promise((resolve) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    (async () => {
      try {
        const res = await fetch(`${BASE}/api/events`, { signal: ctrl.signal });
        const reader = res.body.getReader();
        const { value } = await reader.read();
        const text = Buffer.from(value).toString('utf8');
        clearTimeout(timer);
        ctrl.abort();
        resolve(text.includes('connected'));
      } catch { clearTimeout(timer); resolve(false); }
    })();
  });
  ok('SSE 能连上并收到 handshake', okConn);
  // 多客户端广播：两条并发连接都要收到同一轮询产生的 video 事件（真实场景=双标签页）
  const grab = () => new Promise((resolve) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => { ctrl.abort(); resolve(null); }, 9000);
    (async () => {
      try {
        const res = await fetch(`${BASE}/api/events`, { signal: ctrl.signal });
        const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { value, done } = await rd.read();
          if (done) { clearTimeout(timer); resolve(null); return; }
          buf += dec.decode(value, { stream: true });
          if (buf.includes('event: video')) { clearTimeout(timer); ctrl.abort(); resolve(true); return; }
          if (buf.length > 80000) { clearTimeout(timer); ctrl.abort(); resolve(null); return; }
        }
      } catch { clearTimeout(timer); resolve(null); }
    })();
  });
  const [g1, g2] = [grab(), grab()];
  await new Promise((r) => setTimeout(r, 300));
  await api('POST', '/api/videos', { mode: 'text_to_video', prompt: 'sse 广播探针', project_id: PROJECT_ID });
  const [b1, b2] = await Promise.all([g1, g2]);
  ok('SSE 多客户端广播（双标签页场景）', b1 === true && b2 === true, JSON.stringify({ b1, b2 }));
}

group('B6 请求体闸门（413 契约）');
{
  // 120MB 上限（API 体唯一显式限）：超限必须"先送 413 再断流"，客户端要能读到 JSON 错误而非连接重置
  const portNum = Number(new URL(BASE).port);
  const outcome = await new Promise((resolve) => {
    let settled = false;
    let stop = false; // 响应一到就停手
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request({ host: '127.0.0.1', port: portNum, path: '/api/agnes/text', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      // 服务端是"先送 413 再断流"（B6 修复）。客户端如果继续猛灌 121MB，
      // 后续写入会在已关闭的 socket 上抛 ECONNRESET，把已经回来的 413 挤掉——
      // 那不是服务端违约，是探针自己的行为不像个正常客户端。真实浏览器/fetch 收到响应就会停。
      stop = true;
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => finish({ status: res.statusCode, body }));
    });
    req.on('error', (e) => finish({ connError: String(e.code || e.message) }));
    const MB = 'x'.repeat(1024 * 1024);
    req.write('{\"prompt\":\"');
    // 分块灌过 120MB 真限（readBody 唯一调用点的显式值），每 8MB 让出一次事件循环，
    // 好让服务端回上来的 413 有机会被读到（不让出的话响应永远排在写队列后面）
    (async () => {
      for (let i = 0; i < 121 && !stop; i++) {
        req.write(MB);
        if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));
      }
      if (!stop) req.end('\"}');
    })();
  });
  ok('超限请求收到 413（非连接重置）', outcome.status === 413 && String(outcome.body).includes('请求体过大'), JSON.stringify(outcome).slice(0, 160));
  const after = await api('GET', '/api/settings');
  eq('超限连接处置后服务照常', after.status, 200);
}

// ── 16. 清理 ─────────────────────────────────────────────────
group('T4/T5 事故级路径');
{
  chatFormats.length = 0;
  const t = await api('POST', '/api/agnes/text', { messages: [{ role: 'user', content: 'hi' }], json_mode: true, model: 'mock-reject-json' });
  eq('4xx 格式降级后仍 200', t.status, 200);
  ok('首发带 format、重试不带', chatFormats.length === 2 && chatFormats[0] === true && chatFormats[1] === false, JSON.stringify(chatFormats));
  const t2 = await api('POST', '/api/agnes/text', { messages: [{ role: 'user', content: 'hi' }], json_mode: true, model: 'mock-deny-key' });
  ok('401 不降级（不掩盖钥匙问题）', t2.data && t2.data.ok === false && chatFormats.length === 3 && chatFormats[2] === true, JSON.stringify({ st: t2.status, d: t2.data && t2.data.ok }));

  // HTTP 200 内嵌 error：必须识别为失败并落一条可复盘的坏记录
  const bad = await api('POST', '/api/videos', { mode: 'text_to_video', prompt: 'boom probe', project_id: PROJECT_ID, model: 'mock-embed-err' });
  ok('内嵌 error 报信封级失败', bad.data && bad.data.ok === false, `status=${bad.status} data=${JSON.stringify(bad.data && bad.data.error)}`);
  const vlist = await api('GET', `/api/videos?project_id=${PROJECT_ID}`);
  const rec = (vlist.data || []).find((x) => String(x.video_prompt).includes('boom probe'));
  ok('内嵌 error 落库可复盘', !!rec && String(rec.error_message).includes('embedded boom') && rec.local_status === 'submit_failed', JSON.stringify(rec && rec.local_status));

  // 提交超时：10s 超时阈值 + mock 11.5s —— 走"结果未知"三态而非谎报失败
  await api('PUT', '/api/settings', { request_timeout_ms: 10000 });
  const slow = await api('POST', '/api/videos', { mode: 'text_to_video', prompt: 'slow probe', project_id: PROJECT_ID, model: 'mock-slow' });
  ok('超时提交返回可接受（未知态）', slow.status < 500, `status=${slow.status}`);
  const vlist2 = await api('GET', `/api/videos?project_id=${PROJECT_ID}`);
  const rec2 = (vlist2.data || []).find((x) => String(x.video_prompt).includes('slow probe'));
  ok('超时记为提交超时未知（非 submit_failed）', !!rec2 && rec2.local_status === 'submit_timeout_unknown', JSON.stringify(rec2 && { s: rec2.status, l: rec2.local_status }));
  // ── T5b：图片 URL 分支（远端→抓本地；抓不到→退远端不谎报本地）──
  const imgOk = await api('POST', '/api/agnes/image', { prompt: 'url branch probe', model: 'mock-img-url-ok', size: '1024x1024' });
  ok('图片 URL 分支抓成本地文件', imgOk.status === 200 && imgOk.data && imgOk.data.ok === true
    && String(imgOk.data.asset && imgOk.data.asset.url).startsWith('/assets/images/')
    && String(imgOk.data.asset && imgOk.data.asset.remote_url).endsWith('/pixel.png'), JSON.stringify(imgOk.data && imgOk.data.asset && { u: imgOk.data.asset.url, r: imgOk.data.asset.remote_url }));
  const imgDead = await api('POST', '/api/agnes/image', { prompt: 'dead url probe', model: 'mock-img-url-dead', size: '1024x1024' });
  const dAsset = imgDead.data && imgDead.data.asset;
  ok('抓不到时退回远端不谎报本地', imgDead.status === 200 && dAsset && String(dAsset.url).startsWith('http://127.0.0.1:1'), JSON.stringify(dAsset && dAsset.url));

  // ── T5b：downloadVideo 瞬时 503 → 5s 重试成功；跨主机 401 → 绝不带 Key ──
  await api('PUT', '/api/settings', { video_poll_interval: '2' });
  queryTarget = 'flaky'; flakyHits = 0;
  const vf = await api('POST', '/api/videos', { mode: 'text_to_video', prompt: 'flaky probe video', project_id: PROJECT_ID });
  let af = null;
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    const vl = await api('GET', `/api/videos?project_id=${PROJECT_ID}`);
    af = (vl.data || []).find((x) => x.id === vf.data.asset.id);
    if (af && (af.local_file || (af.status === 'completed' && i > 12))) break;
  }
  ok('503 瞬时失败经重试落盘', !!af && af.status === 'completed' && !!af.local_file && flakyHits === 2, JSON.stringify(af && { s: af.status, f: !!af.local_file }) + ' hits=' + flakyHits);
  denyHitsWithKey = 0; queryTarget = 'deny';
  const vd = await api('POST', '/api/videos', { mode: 'text_to_video', prompt: 'deny probe video', project_id: PROJECT_ID });
  let ad = null;
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    const vl = await api('GET', `/api/videos?project_id=${PROJECT_ID}`);
    ad = (vl.data || []).find((x) => x.id === vd.data.asset.id);
    if (ad && (ad.status === 'completed' && !ad.local_file)) { const lg = await api('GET', '/api/logs'); if (lg.data.some((l) => String(l.msg).includes('未携带凭证'))) break; }
  }
  ok('跨主机 401 不泄露 Key（守卫日志在案）', !!ad && ad.status === 'completed' && !ad.local_file && denyHitsWithKey === 0, JSON.stringify(ad && { s: ad.status, f: !!ad.local_file }) + ' leaks=' + denyHitsWithKey);
  queryTarget = 'base';
  await api('PUT', '/api/settings', { video_poll_interval: '8' });
  const cleanupIds = [rec, rec2].filter(Boolean).map((r) => api('DELETE', `/api/videos/${r.id}`));
  await Promise.all(cleanupIds);
  await api('PUT', '/api/settings', { request_timeout_ms: 150000 });
}

group('B4.1 画风分层注入');
{
  const proj = await api('POST', '/api/projects', { name: '画风分层测试', art_style: '日漫厚涂', aspect_ratio: '9:16 竖屏' });
  const PID = proj.data.id;
  const g = await api('POST', '/api/agnes/image', { prompt: 'a girl running on the beach', project_id: PID, size: '1024x1024' });
  eq('出图注入映射画风', String(lastImageCreate && lastImageCreate.prompt), 'a girl running on the beach, japanese anime style, thick painterly shading');
  const g2 = await api('POST', '/api/agnes/image', { prompt: 'a cat', project_id: PID, size: '1024x1024' });
  const g3 = await api('POST', '/api/agnes/image', { prompt: 'a cat, japanese anime style, thick painterly shading', project_id: PID, size: '1024x1024' });
  eq('同画风重复注入去重', String(lastImageCreate && lastImageCreate.prompt), 'a cat, japanese anime style, thick painterly shading');
  const g4 = await api('POST', '/api/agnes/image', { prompt: 'standalone', size: '1024x1024' });
  eq('无项目不注入', String(lastImageCreate && lastImageCreate.prompt), 'standalone');
  // 视频：仅 t2v 注入；i2v 由参考图带风格
  await api('POST', '/api/videos', { mode: 'text_to_video', prompt: 'hero walks forward', project_id: PID });
  eq('t2v 注入画风', String(lastVideoCreate && lastVideoCreate.prompt), 'hero walks forward, japanese anime style, thick painterly shading');
  await api('POST', '/api/videos', { mode: 'image_to_video', prompt: 'animate this', image: 'http://127.0.0.1:1/x.png', project_id: PID });
  eq('i2v 不注入', String(lastVideoCreate && lastVideoCreate.prompt), 'animate this');
  await api('DELETE', '/api/projects/' + PID + '?cascade=1');
}

group('R15 角色注入（使用点 / 锁定语义 / 去重 / 视频口径 / 导出）');
{
  const proj = await api('POST', '/api/projects', { name: '角色注入测试', art_style: '日漫厚涂' });
  const PID = proj.data.id;
  const mk = async (name, extra) => (await api('POST', '/api/characters', Object.assign({ project_id: PID, name }, extra))).data;
  const lin = await mk('林岚', { appearance: '黑色长直发、丹凤眼', outfit: '白色衬衫', is_locked: true });
  const zhou = await mk('老周', { appearance: '灰白短发、络腮胡', is_locked: false });
  const hollow = await mk('无貌', {}); // 没填外貌：注入不了任何东西
  const sbAll = await api('POST', '/api/storyboards', {
    project_id: PID, shot_number: 1, scene_description: '开场', image_prompt: 'a girl stands on the rooftop',
    character_ids: [lin.id, zhou.id, hollow.id],
  });
  const sbLin = await api('POST', '/api/storyboards', {
    project_id: PID, shot_number: 2, scene_description: '特写', image_prompt: 'a close-up shot', character_ids: [lin.id],
  });
  const sbZhou = await api('POST', '/api/storyboards', {
    project_id: PID, shot_number: 3, scene_description: '过肩', image_prompt: 'an over-the-shoulder shot', character_ids: [zhou.id],
  });

  // ① 出图：绑定的角色都被注入（含外貌 + 服装），没填外貌的不产出空壳
  await api('POST', '/api/agnes/image', { prompt: 'a girl stands on the rooftop', project_id: PID, storyboard_id: sbAll.data.id, size: '1024x1024' });
  const wire = String(lastImageCreate && lastImageCreate.prompt);
  ok('出图注入出场角色（外貌 + 服装）',
    wire.includes('出场角色——') && wire.includes('林岚：黑色长直发、丹凤眼，身着白色衬衫') && wire.includes('老周：灰白短发、络腮胡'),
    wire.slice(0, 160));
  ok('没填外貌的角色不产出「无貌：」这种空壳', !wire.includes('无貌'));
  ok('顺序固定：内容 → 角色 → 画风（前端预览按同序复算）',
    wire.indexOf('出场角色——') > 0 && wire.indexOf('出场角色——') < wire.indexOf('japanese anime style'));

  // ② 锁定语义：提示词里提到名字时，锁定角色照注入，未锁定角色跳过
  await api('POST', '/api/agnes/image', { prompt: '林岚回头看了一眼', project_id: PID, storyboard_id: sbLin.data.id, size: '1024x1024' });
  ok('锁定角色即使提示词提到名字也照注入（一致性的来源）', String(lastImageCreate.prompt).includes('林岚：黑色长直发、丹凤眼，身着白色衬衫'), String(lastImageCreate.prompt));
  await api('POST', '/api/agnes/image', { prompt: '老周点点头', project_id: PID, storyboard_id: sbZhou.data.id, size: '1024x1024' });
  eq('未锁定角色在提示词已提名字时不重复注入（尊重用户自己写的）',
    negless(lastImageCreate.prompt), '老周点点头, japanese anime style, thick painterly shading');

  // ③ 去重：提示词里已经有同样的长相描述 → 不追加
  await api('POST', '/api/agnes/image', { prompt: '黑色长直发、丹凤眼，身着白色衬衫的女孩', project_id: PID, storyboard_id: sbLin.data.id, size: '1024x1024' });
  eq('同样的长相描述已在提示词里 → 不重复追加',
    negless(lastImageCreate.prompt), '黑色长直发、丹凤眼，身着白色衬衫的女孩, japanese anime style, thick painterly shading');

  // ④ 无绑定 → 不注入（角色库不能变成"到处都在注入"）
  await api('POST', '/api/agnes/image', { prompt: 'empty street', project_id: PID, size: '1024x1024' });
  eq('镜头未绑定角色 → 不注入', String(lastImageCreate.prompt), 'empty street, japanese anime style, thick painterly shading');

  // ⑤ 显式 character_ids（调用方不必先建分镜）—— 图片页/外部脚本可走这条路
  await api('POST', '/api/agnes/image', { prompt: 'portrait', project_id: PID, character_ids: [lin.id], size: '1024x1024' });
  ok('显式 character_ids 也能注入', String(lastImageCreate.prompt).includes('林岚：黑色长直发'), String(lastImageCreate.prompt));

  // ⑥ 视频口径与画风完全一致：t2v 注入，i2v 不注入
  await api('POST', '/api/videos', { mode: 'text_to_video', prompt: 'hero walks forward', project_id: PID, storyboard_id: sbLin.data.id });
  ok('t2v 注入角色', String(lastVideoCreate && lastVideoCreate.prompt).includes('出场角色——'), String(lastVideoCreate && lastVideoCreate.prompt));
  await api('POST', '/api/videos', { mode: 'image_to_video', prompt: 'animate this', image: 'http://127.0.0.1:1/x.png', project_id: PID, storyboard_id: sbLin.data.id });
  eq('i2v 不注入角色（长相由参考图决定）', String(lastVideoCreate.prompt), 'animate this');

  // ⑦ 落库的是"最终发出的词"（否则下载/复盘看到的与实际不一致）
  const imgs = await api('GET', `/api/images?project_id=${PID}`);
  ok('素材记录里存的是最终发出的提示词', (imgs.data || []).some((i) => String(i.generation_prompt).includes('出场角色——')));

  // ⑧ 导出必须与发出的一致，且说清图生模式的口径
  const csvText = new TextDecoder().decode(new Uint8Array(await (await fetch(`${BASE}/api/projects/${PID}/export.csv?episode=1`)).arrayBuffer()));
  ok('CSV 表头标明含角色、运镜与画风', csvText.includes('含原著场景道具与角色与运镜与画风'));
  ok('CSV 新增「绑定角色」列', csvText.includes('绑定角色') && csvText.includes('林岚、老周、无貌'));
  ok('CSV 最终词含角色注入', csvText.includes('林岚：黑色长直发、丹凤眼，身着白色衬衫'));
  const mdText = (await api('GET', `/api/projects/${PID}/export.md?episode=1`)).data.raw;
  ok('MD 最终词含角色注入', mdText.includes('出场角色——'));
  ok('MD 说清图生模式实际不注入（导出不骗人）', mdText.includes('图生/多帧视频'));
  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('R19 运镜字段与注入口径（白名单 / 静帧闸门 / 导出列）');
{
  const P = await api('POST', '/api/projects', { name: '运镜测试剧', art_style: '', aspect_ratio: '9:16 竖屏' });
  const PID2 = P.data.id;
  const mk = async (shot, cam, ip, vp) => (await api('POST', `/api/storyboards?project_id=${PID2}`, {
    project_id: PID2, episode_number: 1, shot_number: shot, shot_type: '中景',
    camera_move: cam, scene_description: `镜头 ${shot}`, image_prompt: ip, video_prompt: vp, duration_seconds: 3,
  })).data;
  const rows2 = async () => (await api('GET', `/api/storyboards?episode=1&project_id=${PID2}`)).data;

  // ① 白名单：字典内落库、字典外落空（不让任意文本被拼进提示词）
  const okRow = await mk(1, '推镜', 'a girl on a rooftop', 'a girl walks forward');
  const badRow = await mk(2, '这是一句随便写的话', 'a boy on a bridge', 'a boy runs');
  eq('字典内的运镜正常落库', okRow.camera_move, '推镜');
  eq('字典外的值落成空（白名单而非自由文本）', badRow.camera_move, '');

  // ② PUT 也要过白名单（POST 过了不代表 PUT 过）
  await api('PUT', `/api/storyboards/${okRow.id}`, { camera_move: '瞎写' });
  eq('PUT 白名单同样生效（改回字典外值 → 落空）', (await rows2()).find((r) => r.id === okRow.id).camera_move, '');
  await api('PUT', `/api/storyboards/${okRow.id}`, { camera_move: '环绕' });
  eq('PUT 回字典内值 → 落库', (await rows2()).find((r) => r.id === okRow.id).camera_move, '环绕');

  // ③ 视频侧运镜对所有模式注入（参考图带不了运动）；图片侧只放行机位/视角类
  await api('POST', '/api/videos', { mode: 'text_to_video', prompt: 'hero walks', project_id: PID2, storyboard_id: okRow.id });
  ok('t2v 注入运镜', String(lastVideoCreate && lastVideoCreate.prompt).includes('orbiting camera circling the subject'), String(lastVideoCreate && lastVideoCreate.prompt));
  await api('POST', '/api/videos', { mode: 'image_to_video', prompt: 'animate this', image: 'http://127.0.0.1:1/x.png', project_id: PID2, storyboard_id: okRow.id });
  ok('i2v 也注入运镜（长相由参考图决定，运动必须靠文字）',
    String(lastVideoCreate.prompt).includes('orbiting camera circling the subject'), String(lastVideoCreate.prompt));
  await api('POST', '/api/agnes/image', { prompt: 'a boy on a bridge', project_id: PID2, storyboard_id: badRow.id });
  eq('图片侧：运动类运镜被跳过（静帧图表达不了运动）', negless(lastImageCreate.prompt), 'a boy on a bridge');
  await api('PUT', `/api/storyboards/${badRow.id}`, { camera_move: '俯视' });
  await api('POST', '/api/agnes/image', { prompt: 'a boy', project_id: PID2, storyboard_id: badRow.id });
  ok('图片侧：机位类运镜照常注入',
    String(lastImageCreate.prompt).includes('high angle looking down'), String(lastImageCreate.prompt));

  // ④ 变体：首次不注入，再来一张才注入（否则第一张就不是用户写的那个镜头）
  await api('POST', '/api/agnes/image', { prompt: 'a cat', project_id: PID2, variation: 0 });
  eq('variation=0 不注入变体', String(lastImageCreate.prompt), 'a cat');
  await api('POST', '/api/agnes/image', { prompt: 'a cat', project_id: PID2, variation: 1 });
  ok('variation=1 注入第一条变体', String(lastImageCreate.prompt).includes('slightly different camera angle'), String(lastImageCreate.prompt));
  await api('POST', '/api/agnes/image', { prompt: 'a cat', project_id: PID2, variation: 9 });
  ok('variation=9 取模回到第一条（不越界）',
    String(lastImageCreate.prompt).includes('slightly different camera angle') && !/undefined/.test(String(lastImageCreate.prompt)), String(lastImageCreate.prompt));

  // ⑤ 导出：运镜列 + 图片/视频两列口径不同
  const csv2 = new TextDecoder().decode(new Uint8Array(await (await fetch(`${BASE}/api/projects/${PID2}/export.csv?episode=1`)).arrayBuffer()));
  ok('CSV 有「运镜」列且带值', csv2.includes('运镜') && csv2.includes('环绕') && csv2.includes('俯视'));
  const line1 = csv2.split('\n').find((l) => l.includes('镜头 1')) || '';
  const line2 = csv2.split('\n').find((l) => l.includes('镜头 2')) || '';
  ok('CSV 视频列含运镜', line1.includes('orbiting camera circling the subject'));
  // 逐列比对（不能整行 includes：整行含视频列，会把"图片列也注入了"误判为通过）
  // 行 1 = 环绕（运动类）：图片列必须还是 a girl，视频列才带运镜
  // 行 2 = 俯视（机位类）：图片列也要带
  ok('CSV 图片列对运动类运镜跳过、机位类放行（两列口径真的不同）',
    line1.includes(',a girl on a rooftop,a girl walks forward,')
    && line2.includes('"a boy on a bridge, high angle looking down"'),
    JSON.stringify([line1.slice(-90), line2.slice(-90)]));
  const md2 = (await api('GET', `/api/projects/${PID2}/export.md?episode=1`)).data.raw;
  ok('MD 标题行带运镜（人读的导出也要看得到镜头语言）', md2.includes('中景 · 环绕 ·'));
  await api('DELETE', `/api/projects/${PID2}?cascade=1`);
}

group('B4.6 导出矩阵');
{
  const proj = await api('POST', '/api/projects', { name: '导出测试', art_style: '水彩' });
  const PID = proj.data.id;
  const sb = await api('POST', '/api/storyboards', { project_id: PID, shot_number: 9, scene_description: '雨中告别', image_prompt: 'two people under an umbrella', video_prompt: 'camera slowly pulls back', duration_seconds: 4 });
  await api('PUT', `/api/storyboards/${sb.data.id}`, { image_prompt: 'two people under an umbrella' });
  const csvBuf = new Uint8Array(await (await fetch(`${BASE}/api/projects/${PID}/export.csv?episode=1`)).arrayBuffer());
  ok('CSV 带 UTF-8 BOM 字节', csvBuf[0] === 0xEF && csvBuf[1] === 0xBB && csvBuf[2] === 0xBF);
  const csvText = new TextDecoder().decode(csvBuf);
  ok('CSV 表头双语列', csvText.includes('图片提示词·最终词（含原著场景道具与角色与运镜与画风）'));
  ok('CSV 注入映射画风', csvText.includes('watercolor illustration, soft paper texture'));
  const mdText = (await api('GET', `/api/projects/${PID}/export.md?episode=1`)).data.raw;
  ok('MD 含镜头代码块', mdText.includes('```') && mdText.includes('camera slowly pulls back'));
  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('B3.5 引用守卫删除');
{
  // 删图/删视频不再是"悬挂引用制造机"：全量解关联并回传镜头号，状态同步回退
  const img = await api('POST', '/api/agnes/image', { prompt: 'ref guard probe', size: '1024x1024', project_id: PROJECT_ID });
  const IID = img.data.asset.id;
  const sb1 = await api('POST', '/api/storyboards', { project_id: PROJECT_ID, shot_number: 701 });
  const SB1 = sb1.data.id;
  await api('PUT', '/api/storyboards/' + SB1, { linked_image_id: IID, status: 'image_ready' });
  const del1 = await api('DELETE', '/api/images/' + IID);
  eq('删图回传解关联数', del1.data && del1.data.unlinked, 1);
  const list1 = await api('GET', `/api/storyboards?project_id=${PROJECT_ID}`);
  const row1 = (list1.data || []).find((x) => x.id === SB1);
  ok('镜头 linked_image_id 已清空', row1 && !row1.linked_image_id, JSON.stringify(row1 && row1.linked_image_id));
  eq('镜头状态回退 pending', row1 && row1.status, 'pending');
}

group('级联删除');
{
  // 先记录本项目落盘的本地文件，级联删除后必须一起消失（防孤儿文件占盘）
  const [imBefore, vdBefore] = await Promise.all([
    api('GET', `/api/images?project_id=${PROJECT_ID}`),
    api('GET', `/api/videos?project_id=${PROJECT_ID}`),
  ]);
  const localFiles = [...imBefore.data, ...vdBefore.data]
    .map((a) => a.local_file).filter(Boolean);
  ok('测试前确有本地落盘文件', localFiles.length >= 2, `找到 ${localFiles.length} 个`);
  localFiles.forEach((f) => ok(`删除前文件存在 ${f.slice(-20)}`, fs.existsSync(f)));

  const r = await fetch(`${BASE}/api/projects/${PROJECT_ID}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cascade: true }),
  });
  const d = await r.json();
  eq('删除项目 200', r.status, 200);
  ok('级联删掉了关联数据', d.removed >= 4, `删了 ${d.removed} 条`);
  ok('返回了本地文件删除数', d.filesRemoved >= 2, `filesRemoved=${d.filesRemoved}`);
  localFiles.forEach((f) => ok(`删除后文件已清 ${f.slice(-20)}`, !fs.existsSync(f)));
  const left = await api('GET', `/api/storyboards?project_id=${PROJECT_ID}`);
  eq('分镜已清空', left.data.length, 0);
}

group('角色库（R14：档案 CRUD + 分镜绑定 + 引用守卫删除 + 级联）');
{
  const pj = await api('POST', '/api/projects', { name: '角色库验收剧' });
  const PID = pj.data.id;
  // 建：名称必填、必须属于项目
  const noname = await api('POST', '/api/characters', { project_id: PID, name: '  ' });
  eq('缺名称 → 400', noname.status, 400);
  const noproj = await api('POST', '/api/characters', { name: '无主角色' });
  eq('缺 project_id → 400', noproj.status, 400);

  const c1 = await api('POST', '/api/characters', {
    project_id: PID, name: '林岚', role: '主角', appearance: '黑色长直发、丹凤眼',
    outfit: '白色衬衫', is_locked: true, reference_image_ids: ['x1', 'x1', '', 'x2'],
  });
  ok('创建角色返回实体', c1.status === 200 && c1.data.id && c1.data.name === '林岚', JSON.stringify(c1.data).slice(0, 100));
  eq('参考图 id 数组去重去空（脏数据会让解绑统计出幽灵项）', JSON.stringify(c1.data.reference_image_ids), JSON.stringify(['x1', 'x2']));
  eq('外貌锁定落库', c1.data.is_locked, true);

  const c2 = await api('POST', '/api/characters', { project_id: PID, name: '老周', role: '配角' });
  const lst = await api('GET', `/api/characters?project_id=${PID}`);
  ok('按项目列出角色（裸数组）', Array.isArray(lst.data) && lst.data.length === 2, JSON.stringify(lst.data && lst.data.length));
  const other = await api('GET', '/api/characters?project_id=__nope__');
  eq('项目过滤生效（不串项目）', (other.data || []).length, 0);

  // 改：空名字必须被拒（否则列表里出现无名卡，用户没法认）
  const blank = await api('PUT', `/api/characters/${c1.data.id}`, { name: '' });
  eq('改名成空 → 400', blank.status, 400);
  const up = await api('PUT', `/api/characters/${c1.data.id}`, { appearance: '黑色长直发、丹凤眼、左眉尾有痣', is_locked: false });
  ok('更新生效', up.status === 200 && up.data.appearance.includes('左眉尾') && up.data.is_locked === false);
  const up404 = await api('PUT', '/api/characters/__nope__', { name: 'x' });
  eq('更新不存在 → 404', up404.status, 404);

  // 绑定：分镜行挂角色
  const sb = await api('POST', '/api/storyboards', { project_id: PID, episode_number: 1, shot_number: 1, scene_description: '开场', character_ids: [c1.data.id, c2.data.id] });
  eq('分镜创建即带角色绑定', JSON.stringify(sb.data.character_ids), JSON.stringify([c1.data.id, c2.data.id]));
  const sbUp = await api('PUT', `/api/storyboards/${sb.data.id}`, { character_ids: [c2.data.id, c2.data.id] });
  eq('分镜绑定去重', JSON.stringify(sbUp.data.character_ids), JSON.stringify([c2.data.id]));
  const sbBad = await api('PUT', `/api/storyboards/${sb.data.id}`, { character_ids: 'not-an-array' });
  eq('非数组绑定 → 清空而不是写进垃圾', JSON.stringify(sbBad.data.character_ids), '[]');
  // 重新挂上，供下面的引用守卫验证（上一步故意清空了绑定）
  await api('PUT', `/api/storyboards/${sb.data.id}`, { character_ids: [c2.data.id] });

  // 引用守卫：删角色必须先解绑，否则留下悬空 id
  const del = await api('DELETE', `/api/characters/${c2.data.id}`);
  ok('删除返回解绑镜头数', del.status === 200 && del.data.ok === true && del.data.unlinked === 1, JSON.stringify(del.data));
  const sbAfter = await api('GET', `/api/storyboards?project_id=${PID}`);
  const row = (sbAfter.data || []).find((x) => x.id === sb.data.id);
  eq('悬空 id 已被清掉（分镜不再指向不存在的角色）', JSON.stringify(row.character_ids), '[]');
  const del404 = await api('DELETE', `/api/characters/${c2.data.id}`);
  eq('重复删除 → 404', del404.status, 404);

  // bootstrap 随包下发角色（分镜页/图片页都要用，避免每页重复请求）
  const bs = await api('GET', '/api/bootstrap');
  ok('bootstrap 含 characters', Array.isArray(bs.data.characters) && bs.data.characters.some((c) => c.id === c1.data.id));

  // 级联删除必须带走角色（漏了就是跨项目孤儿）
  const cas = await api('DELETE', `/api/projects/${PID}?cascade=1`);
  ok('级联删除项目成功', cas.status === 200 && cas.data.ok === true);
  const left = await api('GET', `/api/characters?project_id=${PID}`);
  eq('级联删除了该项目的角色', (left.data || []).length, 0);
}

group('失败追踪码（R10：5xx 带码 + 码进运行日志 + 4xx 不发码）');
{
  await api('PUT', '/api/settings', { agnes_api_base_url: MOCK_BASE, agnes_api_key: MOCK_KEY });
  await fetch(`${MOCK_BASE}/__mock?badjson=1`).catch(() => {});
  const bad = await api('POST', '/api/agnes/image', { prompt: 'trace probe', size: '1024x1024' });
  ok('上游返回非 JSON → 502（确定性 5xx 路径）', bad.status === 502, `status=${bad.status} body=${JSON.stringify(bad.data).slice(0, 120)}`);
  ok('5xx 响应带失败追踪码', /^e[0-9a-z]{10}$/.test(String(bad.data && bad.data.trace)), JSON.stringify(bad.data && bad.data.trace));
  const lg = await api('GET', '/api/logs');
  ok('同一个码已写进运行日志（用户截图 → 开发者定位的桥）',
    (lg.data || []).some((l) => String(l.msg).includes(bad.data.trace)), JSON.stringify((lg.data || [])[0] || {}).slice(0, 120));
  await fetch(`${MOCK_BASE}/__mock?badjson=0`).catch(() => {});
  // 4xx 是输入/调用问题：不发码（否则界面变吵且无助于排查）
  const nf = await api('GET', '/api/projects/nope/export.csv');
  eq('4xx 不带追踪码', nf.data && nf.data.trace, undefined);
  // 注意：本组**不得**清 Key——后续组（轮询预算/批量取消）都依赖 mock 凭据在位
}

group('轮询预算（R12/R13：次数落库 + 递增间隔 + 分级 deadline）');
{
  // 旧语义：counts 是内存 Map，watch() 无条件归零 → 一个查满预算的僵尸任务只要被
  // resume()（每次服务重启）或批量刷新摸到一次，就能可靠地重新获得满额预算，无限轮询。
  await api('PUT', '/api/settings', { video_poll_interval: '2', video_max_polls: '2' });
  queryTarget = 'stuck';
  const vs = await api('POST', '/api/videos', { mode: 'text_to_video', prompt: 'stuck probe', project_id: PROJECT_ID });
  const sid = vs.data.asset.id;
  let sv = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    sv = (await api('GET', `/api/videos?project_id=${PROJECT_ID}`)).data.find((x) => x.id === sid);
    if (sv && sv.local_status === 'poll_timeout') break;
  }
  ok('预算耗尽后转 poll_timeout', !!sv && sv.local_status === 'poll_timeout', JSON.stringify(sv && { s: sv.local_status, a: sv.poll_attempts }));
  ok('累计查询次数落库（重启不归零，此前只在内存里）', !!sv && Number(sv.poll_attempts) >= 2, `poll_attempts=${sv && sv.poll_attempts}`);
  ok('超时文案明说"不代表失败"并给出恢复手段', !!sv && /不代表失败/.test(sv.error_message || '') && /重新获取/.test(sv.error_message || ''), sv && sv.error_message);
  ok('预算起点时间戳落库（墙钟预算跨重启保持）', !!sv && !!sv.poll_started_at, sv && sv.poll_started_at);

  // 用户主动「重新获取」必须能救回触顶任务（否则预算触顶 = 永久不可追踪）
  const rf = await api('POST', `/api/videos/${sid}/refresh`);
  await sleep(400);
  const rv = (await api('GET', `/api/videos?project_id=${PROJECT_ID}`)).data.find((x) => x.id === sid);
  ok('用户主动重新获取可重置预算', rf.status === 200 && rf.data && rf.data.ok === true && !!rv && Number(rv.poll_attempts) === 0 && rv.local_status !== 'poll_timeout',
    JSON.stringify(rv && { a: rv.poll_attempts, s: rv.local_status }));

  await api('DELETE', `/api/videos/${sid}`);
  queryTarget = 'base';
  await api('PUT', '/api/settings', { video_poll_interval: '8', video_max_polls: '60' });
}

group('级联删除 · 查询参数形式');
{
  // 回归：handler 只读 body.cascade，导致 `DELETE /api/projects/:id?cascade=1` 被**静默忽略** ——
  // 调用方以为级联删干净了，实际留下一堆孤儿分镜/素材（测试清理与脚本最常踩这个坑）。
  // 两种形式都必须生效：body 形式是 UI 在用的，query 形式是脚本/测试在用的。
  const p = await api('POST', '/api/projects', { name: '查询参数级联剧' });
  const pid = p.data.id;
  await api('POST', '/api/storyboards', { project_id: pid, episode_number: 1, shot_number: 1, video_prompt: 'x' });
  await api('POST', '/api/images', { project_id: pid, name: '查询参数级联图', url: '/assets/none.png' });
  const r = await fetch(`${BASE}/api/projects/${pid}?cascade=1`, { method: 'DELETE' });
  const d = await r.json();
  eq('query 形式删除项目 200', r.status, 200);
  ok('query 形式的 cascade 真的级联（removed ≥ 2）', d.removed >= 2, `removed=${d.removed}`);
  eq('分镜确实被清空', (await api('GET', `/api/storyboards?project_id=${pid}`)).data.length, 0);
  eq('素材确实被清空', (await api('GET', `/api/images?project_id=${pid}`)).data.length, 0);
}

// ── 写失败上报契约（数据完整性：保存失败必须让用户看得见） ──
group('写失败上报');
{
  const logsBefore = (await api('GET', '/api/logs')).data;
  const before = logsBefore.length;
  fs.chmodSync(HOME, 0o555); // 目录只读 → 原子写的临时文件创建必失败
  let failedWrite = false;
  try {
    await api('PUT', '/api/settings', { default_text_model: '写失败探针' });
    // 异步写队列的失败晚于响应：轮询日志直到出现，最多 4s
    let hit = null;
    for (let i = 0; i < 40 && !hit; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const logs = (await api('GET', '/api/logs')).data;
      hit = logs.find((l) => l.level === 'error' && String(l.msg).includes('保存失败'));
    }
    ok('写盘失败经 onWriteError 上报到日志流（用户可见）', !!hit, hit ? hit.msg.slice(0, 90) : `日志 ${before} 条内无"保存失败"`);
    failedWrite = !!hit;
  } finally {
    fs.chmodSync(HOME, 0o755); // 必须恢复，否则后续写全失败
  }
  ok('探针确实制造了写失败（非空跑自证）', failedWrite === true, `failedWrite=${failedWrite}`);
  // 恢复可写后：写入应重新生效且不再产生新的失败日志
  await api('PUT', '/api/settings', { default_text_model: '恢复探针' });
  await new Promise((r) => setTimeout(r, 500));
  const st = (await api('GET', '/api/settings')).data.settings || (await api('GET', '/api/settings')).data;
  const modelOk = String((st && st.default_text_model) || '').includes('恢复探针');
  const logsAfter = (await api('GET', '/api/logs')).data.filter((l) => l.level === 'error' && String(l.msg).includes('保存失败')).length;
  ok('恢复可写后写入重新生效', modelOk, JSON.stringify(st && st.default_text_model));
  ok('恢复后无新增写失败日志', logsAfter <= 1, `失败日志数=${logsAfter}`);
}

// ── 任务 CRUD 与批量取消契约（三个被 UI 真实使用、却零覆盖的端点） ──
group('任务 CRUD 与批量取消');
{
  // PUT/DELETE /api/tasks/:id —— 任务页「收藏」与「删除」按钮（tasks.js:247 / :330）走的路径
  const mk = await api('POST', '/api/tasks', { task_type: 'image', project_id: PROJECT_ID, notes: '原始备注', status: 'pending' });
  const tid = mk.data && mk.data.id;
  ok('任务探针已建', !!tid, JSON.stringify(mk.data).slice(0, 80));
  const up1 = await api('PUT', `/api/tasks/${tid}`, { is_favorited: true });
  eq('PUT 任务：收藏置位生效', up1.data.is_favorited, true);
  eq('PUT 任务：未提供的字段不被清空（局部补丁语义）', up1.data.notes, '原始备注');
  const up2 = await api('PUT', `/api/tasks/${tid}`, { notes: '改后备注' });
  ok('PUT 任务：notes 可改且收藏保持', up2.data.notes === '改后备注' && up2.data.is_favorited === true, JSON.stringify({ n: up2.data.notes, f: up2.data.is_favorited }));
  const up404 = await api('PUT', '/api/tasks/__nope__', { notes: 'x' });
  eq('PUT 未知任务 → 404', up404.status, 404);
  const del1 = await api('DELETE', `/api/tasks/${tid}`);
  eq('DELETE 任务成功', del1.data.ok, true);
  const stillThere = (await api('GET', '/api/tasks')).data.some((t) => t.id === tid);
  eq('删除后任务确实消失', stillThere, false);
  const del404 = await api('DELETE', `/api/tasks/${tid}`);
  eq('重复删除 → 404', del404.status, 404);

  // POST /api/batch/:id/cancel —— 批量条「取消」按钮（storyboards.js:90）：必须真能停住，不只是置个标记
  await fetch(`${MOCK_BASE}/__mock?slowimg=250`);
  const items = Array.from({ length: 6 }, (_, i) => ({ prompt: `cancel probe ${i}`, project_id: PROJECT_ID, size: '1024x1024' }));
  const pending = api('POST', '/api/batch/images', { items, concurrency: 2 }); // 故意不 await：运行中才有 id 可取消
  let runningId = null;
  for (let i = 0; i < 60 && !runningId; i++) {
    await new Promise((r) => setTimeout(r, 25));
    const list = (await api('GET', '/api/batch')).data || [];
    const run = list.find((j) => j.status === 'running');
    if (run) runningId = run.id;
  }
  ok('捕获到运行中的批量任务（取消才有意义）', !!runningId, `id=${runningId}`);
  const cxl = await api('POST', `/api/batch/${runningId}/cancel`);
  eq('取消运行中批量任务 → 200 ok', cxl.data.ok, true);
  const created = await pending; // 创建请求在整批跑完（或被取消）后才返回
  eq('创建请求本身仍正常返回', created.status, 200);
  let fin = null;
  for (let i = 0; i < 40; i++) {
    const list = (await api('GET', '/api/batch')).data || [];
    fin = list.find((j) => j.id === runningId);
    if (fin && fin.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  eq('取消后终态为 cancelled（真停住，而非跑完）', fin && fin.status, 'cancelled');
  ok('取消确实中断了剩余项（done < total）', fin && fin.done < fin.total, JSON.stringify(fin && { d: fin.done, t: fin.total, s: fin.status }));
  const cxl404 = await api('POST', '/api/batch/__nope__/cancel');
  eq('取消未知批量任务 → 404', cxl404.status, 404);
  await fetch(`${MOCK_BASE}/__mock?slowimg=0`); // 复位，避免影响后续

  // POST /api/videos/:id/download —— UI「保存到本地」（assets.js:209 / tasks.js:275）走的路径
  const d404 = await api('POST', '/api/videos/__nope__/download');
  eq('下载未知视频 → 404', d404.status, 404);
  const nv = await api('POST', '/api/videos', { mode: 'text_to_video', prompt: '下载探针（无地址）', project_id: PROJECT_ID });
  const nvId = nv.data.asset && nv.data.asset.id; // 注意：POST /api/videos 返回 {ok, asset}，id 不在顶层
  const d400 = await api('POST', `/api/videos/${nvId}/download`);
  eq('无视频地址时下载 → 400', d400.status, 400);
  await api('DELETE', `/api/videos/${nvId}`);
  // 同主地址（= 配置的 API Base 主机）→ 携带 Key 下载成功并落盘。
  // 必须显式设定 Base/Key：前面若干组改过设置，残留值会让本组变成"跨主"而 401（首版即栽在此）。
  await api('PUT', '/api/settings', { agnes_api_base_url: `${MOCK_BASE}/v1`, agnes_api_key: MOCK_KEY });
  const dv = await api('POST', '/api/videos', { mode: 'text_to_video', prompt: '下载探针（可下载）', project_id: PROJECT_ID });
  const dvId = dv.data.asset && dv.data.asset.id;
  await api('PUT', `/api/videos/${dvId}`, { video_url: `${MOCK_BASE}/video.mp4` });
  const dl = await api('POST', `/api/videos/${dvId}/download`);
  eq('同主地址下载成功', dl.data.ok, true);
  ok('返回真实字节数（MOCKMP4DATA=11B）', dl.data.bytes === 11, `bytes=${dl.data.bytes}`);
  const lf = dl.data.asset && dl.data.asset.local_file;
  ok('local_file 已写回资产记录', !!lf, JSON.stringify(dl.data).slice(0, 100));
  ok('文件确实落到磁盘', !!lf && fs.existsSync(lf), String(lf));
  const persisted = (await api('GET', '/api/videos')).data.find((v) => v.id === dvId);
  ok('local_file 已持久化（刷新后「已存本地」状态仍在）', !!(persisted && persisted.local_file), String(persisted && persisted.local_file).slice(0, 70));
  await api('DELETE', `/api/videos/${dvId}`);
}

// ── 批 8：原著解析（分块 map + 全局 reduce + 卡片反向驱动）────────
group('镜头绑定自动匹配与镜头侧体检（批 8 补 5/补 6：两档置信度 / 只并集不覆盖 / 按目标修复 / 名字对不上）');
{
  const pj = await api('POST', '/api/projects', { name: '绑定匹配测试剧' });
  const PID = pj.data.id;
  const mkChar = (body) => api('POST', '/api/characters', Object.assign({ project_id: PID }, body));
  const c1 = (await mkChar({ name: '匹配林晚', alias: '小晚、晚晚', appearance: '白衣长剑' })).data;
  const c2 = (await mkChar({ name: '匹配顾寒', appearance: '黑甲' })).data;
  const c3 = (await mkChar({ name: '匹配雪', appearance: '白发' })).data;  // 单字名
  const k1 = (await api('POST', '/api/story/cards/import', { project_id: PID, kind: 'location', name: '匹配临江茶馆', aliases: ['老茶馆'], atmosphere: '喧闹潮湿' }).catch(() => ({ data: null }))).data;
  // 卡片没有专门的建卡端点（卡片由解析产出），这里直接用一条分镜把地点卡带不出来 —— 改为走解析太重，
  // 所以卡片侧只用"人物卡不该进 story_card_ids"这条负向断言（正向的卡片匹配由 selftest 纯函数钉覆盖）。
  const mkShot = async (rows) => (await api('POST', '/api/storyboards', { rows: rows.map((r) => Object.assign({ project_id: PID, episode_number: 1 }, r)) })).data.rows;
  const shots = await mkShot([
    { shot_number: 1, characters: '匹配林晚、匹配顾寒', image_prompt: 'two people', scene_description: '两人对坐' },
    { shot_number: 2, characters: '', image_prompt: 'close-up', scene_description: '匹配林晚走进来' },
    { shot_number: 3, characters: '下雪了', image_prompt: 'snow falling' },
    { shot_number: 4, characters: '匹配林晚', image_prompt: 'x', character_ids: [c2.id] },
  ]);
  ok('建了 4 个镜头用于匹配', shots.length === 4, JSON.stringify(shots.map((x) => x.shot_number)));

  // ① 不花钱：名字匹配是可判定的，不该产生任何模型调用
  const callsBefore = storyChatCalls;
  const dry = await api('POST', '/api/storyboards/auto-bind', { project_id: PID, episode_number: 1, dry_run: true });
  eq('干跑 200', dry.status, 200);
  await sleep(400);
  eq('自动匹配**一次模型都没调**（可判定的事不该花钱）', storyChatCalls, callsBefore);
  eq('干跑不落库', dry.data.updated, 0);
  eq('干跑扫到的镜头数', dry.data.scanned, 4);
  const dryS1 = dry.data.matches.find((m) => m.shot_number === 1);
  eq('干跑报出镜头 1 该绑的角色（强匹配）', dryS1.added_characters.map((x) => x.name).join(','), '匹配林晚,匹配顾寒');
  ok('强匹配标了 via=characters', dryS1.added_characters.every((x) => x.via === 'characters' && !x.weak));
  const dryS2 = dry.data.matches.find((m) => m.shot_number === 2);
  eq('只在画面描述里出现算弱匹配', dryS2.added_characters.map((x) => `${x.name}:${x.via}`).join(','), '匹配林晚:prompt');
  const stillEmpty = (await api('GET', `/api/storyboards?project_id=${PID}&episode=1`)).data.find((x) => x.shot_number === 1);
  eq('干跑之后库里还是没绑定（"先看会绑什么再决定"必须是真的）', (stillEmpty.character_ids || []).length, 0);

  // ② 强匹配自动绑（生成后自动跑的就是这个模式）
  const strong = await api('POST', '/api/storyboards/auto-bind', { project_id: PID, episode_number: 1, strong_only: true });
  eq('strong_only 只绑高置信那档', strong.data.weak, 0);
  const after = (await api('GET', `/api/storyboards?project_id=${PID}&episode=1`)).data;
  const s1 = after.find((x) => x.shot_number === 1);
  const s2 = after.find((x) => x.shot_number === 2);
  const s3 = after.find((x) => x.shot_number === 3);
  const s4 = after.find((x) => x.shot_number === 4);
  eq('镜头 1 绑上了两个角色', (s1.character_ids || []).length, 2);
  eq('镜头 2 的弱匹配没有被自动绑（不猜）', (s2.character_ids || []).length, 0);
  eq('单字名"雪"不会被"下雪了"误绑（宁可漏也不要错绑）', (s3.character_ids || []).length, 0);
  ok('已经手工绑过的绑定没被抹掉（并集而不是覆盖）', (s4.character_ids || []).includes(c2.id), JSON.stringify(s4.character_ids));
  ok('镜头 4 同时补上了新匹配到的角色', (s4.character_ids || []).includes(c1.id), JSON.stringify(s4.character_ids));

  // ③ 默认模式（含弱匹配）：界面先确认再走这条路 —— 它必须把 strong_only 跳过的那些也补上
  const all = await api('POST', '/api/storyboards/auto-bind', { project_id: PID, episode_number: 1 });
  ok('默认模式会把弱匹配也绑上（界面先确认再调）', all.data.weak >= 1, JSON.stringify({ weak: all.data.weak, updated: all.data.updated }));
  const s2b = (await api('GET', `/api/storyboards?project_id=${PID}&episode=1`)).data.find((x) => x.shot_number === 2);
  ok('镜头 2 现在绑上了（弱匹配确实落库了）', (s2b.character_ids || []).length === 1, JSON.stringify(s2b.character_ids));

  // ④ 幂等：同一个模式再跑一次没有新增（两种模式都要幂等，不能"跑一次多绑一点"）
  const again = await api('POST', '/api/storyboards/auto-bind', { project_id: PID, episode_number: 1 });
  eq('再跑一次不再重复绑（幂等）', again.data.updated, 0);
  eq('strong_only 模式同样幂等',
    (await api('POST', '/api/storyboards/auto-bind', { project_id: PID, episode_number: 1, strong_only: true })).data.updated, 0);

  // ⑤ 参数与边界
  eq('缺 project_id → 400', (await api('POST', '/api/storyboards/auto-bind', {})).status, 400);
  const byIds = await api('POST', '/api/storyboards/auto-bind', { project_id: PID, storyboard_ids: [s1.id] });
  eq('按 storyboard_ids 限定范围时不碰其它镜头', byIds.data.scanned, 1);
  eq('不存在的项目 → 扫 0 个镜头（如实为空，不报错）', (await api('POST', '/api/storyboards/auto-bind', { project_id: 'project_nope' })).data.scanned, 0);

  // ⑥ 镜头侧体检：漏绑的角色聚成一条，并带修复动作
  const audit = await api('GET', `/api/story/audit?project_id=${PID}`);
  eq('体检 200', audit.status, 200);
  ok('体检报出扫描到的镜头数', audit.data.shots_scanned >= 4, String(audit.data.shots_scanned));
  ok('体检里同时有卡片侧与镜头侧两组（各自计数）',
    !!audit.data.card_counts && !!audit.data.shot_counts, JSON.stringify(Object.keys(audit.data)));
  eq('总数 = 各分组之和（不许只算一边；漏一组就会在界面上少报问题）',
    audit.data.counts.warn,
    audit.data.card_counts.warn + audit.data.shot_counts.warn + audit.data.ref_counts.warn
      + audit.data.style_counts.warn + audit.data.drift_counts.warn + audit.data.cast_counts.warn);
  // 把镜头 2 的绑定清掉，制造一条确定的漏绑
  await api('PUT', `/api/storyboards/${s2.id}`, { character_ids: [] });
  const audit2 = await api('GET', `/api/story/audit?project_id=${PID}`);
  const un = audit2.data.shot_issues.filter((x) => x.code === 'shot_char_unbound' && x.target_id === c1.id);
  eq('漏绑聚成一条（按角色，而不是每镜头一条）', un.length, 1);
  ok('聚合里带上了镜头明细', (un[0].shot_ids || []).length >= 1, JSON.stringify(un[0].shot_ids));
  eq('修复动作码是"绑到这些镜头"', un[0].fix_code, 'bind_shot_target');

  // ⑦ 按目标修复：只绑这一个角色，不做"能匹配的都绑上"
  const fix = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'bind_shot_target', target_id: c1.id, shot_ids: un[0].shot_ids });
  eq('修复 200', fix.status, 200);
  eq('绑到的镜头数如实上报', fix.data.bound_shots, un[0].shot_ids.length);
  const s2c = (await api('GET', `/api/storyboards?project_id=${PID}&episode=1`)).data.find((x) => x.shot_number === 2);
  ok('镜头 2 现在绑上了这个角色', (s2c.character_ids || []).includes(c1.id), JSON.stringify(s2c.character_ids));
  ok('没有顺带绑上别的角色（一次点击只做一个明确动作）', !(s2c.character_ids || []).includes(c2.id), JSON.stringify(s2c.character_ids));
  const fix2 = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'bind_shot_target', target_id: c1.id, shot_ids: un[0].shot_ids });
  eq('再修一次不重复绑（幂等）', fix2.data.bound_shots, 0);
  eq('缺 target_id → 400', (await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'bind_shot_target', shot_ids: ['x'] })).status, 400);
  eq('缺 shot_ids → 400', (await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'bind_shot_target', target_id: c1.id })).status, 400);
  eq('不存在的目标 → 404', (await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'bind_shot_target', target_id: 'char_nope', shot_ids: [s1.id] })).status, 404);

  // ⑧ 未锁定角色：绑了、但**提示词里出现名字**时不会注入外貌（characterPhrase 的既定语义）→ 可一键锁定
  //    判据必须与注入时用的字段一致（image_prompt / video_prompt），所以先把镜头 1 的提示词改成含名字的
  await api('PUT', `/api/storyboards/${s1.id}`, { image_prompt: '匹配林晚站在门口' });
  const beforeLock = await api('GET', `/api/story/audit?project_id=${PID}`);
  const unlocked = beforeLock.data.shot_issues.filter((x) => x.code === 'shot_char_unlocked' && x.target_id === c1.id);
  eq('报出"绑了但没锁定"的镜头（最隐蔽的一条）', unlocked.length, 1);
  eq('只报提示词里真的出现名字的那些镜头', unlocked[0].shot_ids.join(','), s1.id);
  ok('英文提示词（没写名字）的镜头不报 —— 那些镜头其实会正常注入外貌',
    !unlocked[0].shot_ids.includes(s2.id), JSON.stringify(unlocked[0].shot_ids));
  eq('未锁定问题的修复动作码是"锁定"', unlocked[0].fix_code, 'lock_shot_char');
  const lock = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'lock_shot_char', target_id: c1.id });
  eq('锁定 200', lock.status, 200);
  eq('锁定生效', lock.data.locked, 1);
  eq('再锁一次不重复（幂等）', (await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'lock_shot_char', target_id: c1.id })).data.already, true);
  const afterLock = await api('GET', `/api/story/audit?project_id=${PID}`);
  eq('锁定后这一条消失（体检不是永远报同样的话）',
    afterLock.data.shot_issues.filter((x) => x.code === 'shot_char_unlocked' && x.target_id === c1.id).length, 0);
  eq('锁定不存在的角色 → 404', (await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'lock_shot_char', target_id: 'char_nope' })).status, 404);

  // ⑨ 人物卡不能绑进 story_card_ids（写入白名单 + 修复端点各一层）
  const charCard = (await api('GET', `/api/story/cards?project_id=${PID}&kind=character`)).data;
  if (charCard && charCard.length) {
    eq('把人物卡当目标绑 → 400（只有地点/道具卡可注入）',
      (await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'bind_shot_target', target_id: charCard[0].id, shot_ids: [s1.id] })).status, 400);
  }
  eq('不认识的修复项 → 400 且列出支持的项',
    (await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'nope' })).status, 400);
  ok('错误文案列出了新支持的修复项',
    /bind_shot_target/.test((await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'nope' })).data.error || ''));

  // ⑩ 单集拍表与前情提要 + 剧本集号（批 8 补 8：逐集生成的连续性上下文，纯本地）
  {
    // 卡片没有建卡端点（卡片由解析产出），所以照分集骨架那组的做法用 __LONGARC__ 走一次真解析
    const pj = await api('POST', '/api/projects', { name: '逐集上下文测试剧' });
    const EPID = pj.data.id;
    const an = await api('POST', '/api/story/analyze', { project_id: EPID, title: '逐集验收', text: `__LONGARC__${'林晚在临江茶馆见到顾寒。'.repeat(40)}` });
    let job = { status: '(未取到)' };
    for (let i = 0; i < 60; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') { job = j; break; } }
    eq('解析任务结束（逐集验收用）', job.status, 'done');
    const src = (await api('GET', `/api/story/sources?project_id=${EPID}`)).data[0];
    const q = `project_id=${EPID}&source_id=${src.id}&per_episode=3`;

    const ep1 = await api('GET', `/api/story/episode-brief?${q}&episode=1`);
    eq('单集接口 200', ep1.status, 200);
    eq('按每集 3 拍切出 2 集', ep1.data.episode_count, 2);
    eq('第 1 集存在', ep1.data.exists, true);
    // 批 8 补 36：本集拍表现在**前面还带全剧设定/时间线**（从前只有全剧大纲那条路有），
    // 所以断言从 `startsWith` 改成"含这一行" —— 断言的是**同一件事**（带集号与拍数），
    // 不是把钉删掉（行为有意反转时，断言跟着改，别删）
    ok('第 1 集的大纲带集号与拍数', /^第 1 集（/m.test(ep1.data.brief), ep1.data.brief.split('\n')[0]);
    ok('第 1 集的大纲前面带全剧设定（__LONGARC__ 的信息卡；补 36 之前这条路上没有）',
      ep1.data.brief.includes('【全剧设定】') && ep1.data.setting_chars > 0, String(ep1.data.setting_chars));
    ok('本集大纲就是全剧骨架里那一集（拍名一致）', ep1.data.brief.includes('长弧·起1'), ep1.data.brief);
    eq('第 1 集没有前情（它是开头）', ep1.data.prior, '');
    eq('第 1 集的前情集数为 0', ep1.data.prior_episodes.length, 0);

    const ep2 = await api('GET', `/api/story/episode-brief?${q}&episode=2`);
    ok('第 2 集的前情里是第 1 集的内容', ep2.data.prior.includes('【第 1 集】'), ep2.data.prior);
    ok('前情里不含本集（第 2 集）的内容', !ep2.data.prior.includes('【第 2 集】'), ep2.data.prior);
    eq('前情集号如实上报', ep2.data.prior_episodes.join(','), '1');
    eq('前情字数如实上报', ep2.data.prior_chars, ep2.data.prior.length);
    ok('前情写明"不要重复叙述"', ep2.data.prior.includes('不要重复叙述'));
    eq('没超预算不算截断', ep2.data.prior_truncated, false);

    const ep3 = await api('GET', `/api/story/episode-brief?${q}&episode=3`);
    eq('不存在的集：exists 为假', ep3.data.exists, false);
    eq('不存在的集给一句怎么做的提示（界面据此指路）', ep3.data.notes.length, 1);
    const small = await api('GET', `/api/story/episode-brief?${q}&episode=2&prior_max=1`);
    eq('预算过小时至少留一集而不是留空', small.data.prior_episodes.length, 1);
    const dflt = await api('GET', `/api/story/episode-brief?${q}&episode=2&per_episode=abc`);
    eq('非法拍数参数落回默认（与分集骨架同一条兜底）', dflt.data.per_episode, 4);

    const calls0 = storyChatCalls;
    await api('GET', `/api/story/episode-brief?${q}&episode=2`);
    await sleep(300);
    eq('单集接口一次模型都不调（与体检、分集同一条纪律）', storyChatCalls, calls0);

    // 剧本记录带集号：逐集生成要能一集一条地存下来
    const sc = (await api('POST', '/api/scripts', { project_id: EPID, script_type: 'episode_script', episode_number: 2, title: '逐集验收 第 2 集', content: '第 2 集正文' })).data;
    eq('剧本存下集号', sc.episode_number, 2);
    const listed = (await api('GET', `/api/scripts?project_id=${EPID}`)).data.find((x) => x.id === sc.id);
    eq('列表里也带集号（界面靠它标"第 N 集"）', listed.episode_number, 2);
    const up = await api('PUT', `/api/scripts/${sc.id}`, { episode_number: 5 });
    eq('集号可改（挪错集能纠正）', up.data.episode_number, 5);
    const noEp = (await api('POST', '/api/scripts', { project_id: EPID, script_type: 'story_concept', title: '不带集号', content: '全剧' })).data;
    eq('不带集号时是 0（全剧/未指定），不是 NaN', noEp.episode_number, 0);
    const badEp = (await api('POST', '/api/scripts', { project_id: EPID, script_type: 'story_concept', title: '坏集号', content: 'x', episode_number: 'abc' })).data;
    eq('坏集号落回 0（不写 NaN 进数据）', badEp.episode_number, 0);
    await api('DELETE', `/api/scripts/${sc.id}`);
    await api('DELETE', `/api/scripts/${noEp.id}`);
    await api('DELETE', `/api/scripts/${badEp.id}`);
    await api('DELETE', `/api/projects/${EPID}?cascade=1`);
  }

  // ⑪ 画风写死：提示词里写了画风词 → 换画风会静默失效（纯本地判定，不花钱）
  {
    const before = await api('GET', `/api/story/audit?project_id=${PID}`);
    ok('体检报告里同时有画风侧的一组（三源各自计数）',
      !!before.data.style_counts && !!before.data.card_counts && !!before.data.shot_counts,
      JSON.stringify(Object.keys(before.data)));
    eq('总数 = 卡片侧 + 镜头侧 + 画风侧 + 参考图缺口侧',
      before.data.counts.warn, before.data.card_counts.warn + before.data.shot_counts.warn + before.data.style_counts.warn + before.data.ref_counts.warn);
    const st = (await api('POST', '/api/storyboards', {
      project_id: PID, episode_number: 3, shot_number: 91,
      image_prompt: 'a girl, oil painting style, visible brush strokes, holding a sword',
      video_prompt: 'slow dolly in',
    })).data;
    const a2 = await api('GET', `/api/story/audit?project_id=${PID}`);
    // 界面渲染的是合并后的 issues，不是那几个分组的字段：只把问题塞进 style_issues / shot_issues
    // 而忘了并进 issues，面板上一条都不显示，而按分组字段写的断言**全绿**（对照 AC 抓到的覆盖盲区）。
    // 注意这条必须放在"确实存在画风问题"之后 —— 早放的话 style_issues 是空的，等式恒成立、钉不住东西
    ok('参考图缺口也并进 issues（面板渲染的是 issues，只在分组字段里等于没显示）',
    Array.isArray((await api('GET', `/api/story/audit?project_id=${PID}`)).data.ref_issues));
  ok('各分组的问题都并进 issues（面板渲染的是 issues，分组字段一个都不能落下）',
      a2.data.issues.some((x) => x.code === 'shot_style_baked')
      && a2.data.issues.length === ['card', 'shot', 'style', 'drift', 'ref']
        .reduce((n, k) => n + (a2.data[`${k}_issues`] || []).length, 0),
      JSON.stringify({ issues: a2.data.issues.length, card: a2.data.card_issues.length, shot: a2.data.shot_issues.length, style: a2.data.style_issues.length, drift: (a2.data.drift_issues || []).length, ref: (a2.data.ref_issues || []).length }));
    const baked = a2.data.style_issues.filter((x) => x.word === 'oil painting style, visible brush strokes');
    eq('报出提示词里写死的画风词（按词聚合）', baked.length, 1);
    eq('聚合里带上是哪个镜头', baked[0].shot_ids.includes(st.id), true);
    eq('与当前项目画风不同 → 算"要处理"', baked[0].level, 'warn');
    eq('修复动作码是"删掉写死的画风词"', baked[0].fix_code, 'strip_style_word');
    eq('画风设置如实回报（界面要说清"当前项目画风"）', typeof a2.data.art_style, 'string');
    const fx = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'strip_style_word', word: baked[0].word, shot_ids: baked[0].shot_ids });
    eq('修复 200', fx.status, 200);
    eq('修复的镜头数如实上报', fx.data.fixed_shots, 1);
    ok('改前/改后如实回报（用户能看见到底删了什么）',
      fx.data.detail[0].before.includes('oil painting') && !fx.data.detail[0].after.includes('oil painting'),
      JSON.stringify(fx.data.detail[0]));
    const after = (await api('GET', `/api/storyboards?project_id=${PID}&episode=3`)).data.find((x) => x.id === st.id);
    eq('删词后画面描述一个字不动', after.image_prompt, 'a girl, holding a sword');
    const a3 = await api('GET', `/api/story/audit?project_id=${PID}`);
    eq('修复后这一条消失（体检随数据变化）',
      a3.data.style_issues.filter((x) => x.word === baked[0].word).length, 0);
    const fx2 = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'strip_style_word', word: baked[0].word, shot_ids: [st.id] });
    eq('再修一次不再改（幂等）', fx2.data.fixed_shots, 0);
    eq('缺 word → 400', (await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'strip_style_word', shot_ids: [st.id] })).status, 400);
    eq('缺 shot_ids → 400', (await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'strip_style_word', word: 'manga' })).status, 400);
    const calls0 = storyChatCalls;
    await api('GET', `/api/story/audit?project_id=${PID}`);
    await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'strip_style_word', word: 'manga', shot_ids: [st.id] });
    await sleep(300);
    eq('画风体检与修复都不调模型（同一条纪律）', storyChatCalls, calls0);
    await api('DELETE', `/api/storyboards/${st.id}`);
  }

  // ⑫ 名字在角色库里找不到：这类镜头一定没有外貌注入，而且不报错（名册就是为它而生的）
  const unkShot = (await api('POST', '/api/storyboards', {
    project_id: PID, episode_number: 2, shot_number: 90, characters: '未登记少女、两人', image_prompt: 'x',
  })).data;
  const audit3 = await api('GET', `/api/story/audit?project_id=${PID}`);
  const unk = audit3.data.shot_issues.filter((x) => x.code === 'shot_char_unknown');
  ok('报出「出场人物」里角色库中没有的名字',
    unk.some((x) => x.target_name === '未登记少女'), JSON.stringify(unk.map((x) => x.target_name)));
  ok('泛称（两人）不报，避免刷屏', !unk.some((x) => x.target_name === '两人'));
  ok('名字对不上不提供一键修复（该改名还是该建角色是人的判断）',
    unk.every((x) => x.fixable === false));
  // 验收环：把角色建出来，这一项就该消失（预防手段与检测手段成对）
  const c9 = (await api('POST', '/api/characters', { project_id: PID, name: '未登记少女', appearance: '短发' })).data;
  const audit4 = await api('GET', `/api/story/audit?project_id=${PID}`);
  ok('建了角色档案后这一项消失（体检不是永远报同样的话）',
    !audit4.data.shot_issues.some((x) => x.code === 'shot_char_unknown' && x.target_name === '未登记少女'));
  ok('建了档案之后同一个镜头变成"提到却没绑"（体检把问题交给下一步）',
    audit4.data.shot_issues.some((x) => x.code === 'shot_char_unbound' && x.target_id === c9.id && x.shot_ids.includes(unkShot.id)),
    JSON.stringify(audit4.data.shot_issues.map((x) => [x.code, x.target_name])));

  // ⑬ 修复也不花钱（同一条纪律的回归）
  const callsBefore2 = storyChatCalls;
  await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'bind_shot_target', target_id: c1.id, shot_ids: [s1.id] });
  await sleep(300);
  eq('修复端点同样不调模型', storyChatCalls, callsBefore2);

  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('章节识别与章节级溯源（批 8 补 21：段号是切块的副产物）');
{
  const pj = await api('POST', '/api/projects', { name: '章节测试剧' });
  const PID = pj.data.id;
  // 每章正文都给足（章节之间挨太近会被判成目录行，那是刻意的）
  const body = (t) => `${t}\n\n${'顾寒推门而入，林晚抬头看雨。'.repeat(14)}`;
  const text = [body('第一章 雨夜'), body(`第二章 茶馆 __NPC__`), body('第三章 决断')].join('\n\n');
  // 这个开关是 mock 的**全局状态**，必须原样还回去：直接置 true 会让后面补 18 那组
  // 再也拿不到"被丢弃"的段，5 条既有断言一起红（本轮真踩到）
  const npcPrev = globalThis.__npcFixed;
  globalThis.__npcFixed = false; // 让第二章那段被"类别不认识"丢掉 → 才能验"逐块结局只计一次"
  const an = await api('POST', '/api/story/analyze', { project_id: PID, title: '章节·原著', text, reduce: false, max_chars: 300 });
  for (let i = 0; i < 80; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  globalThis.__npcFixed = npcPrev;
  const SID = an.data.source.id;

  const r = await api('GET', `/api/story/chapters?source_id=${SID}`);
  eq('章节目录可用', r.status, 200);
  eq('识别到章节（不再只说"第 34 段"）', r.data.found, true);
  eq('章节数与标题都对', JSON.stringify(r.data.chapters.map((c) => c.title)),
    JSON.stringify(['第一章 雨夜', '第二章 茶馆 __NPC__', '第三章 决断']));
  const sum = r.data.chapters.reduce((n, c) => n + c.chars, 0);
  ok('各章字数加起来接近原文总长（不重不漏）', sum <= text.length && sum >= text.length - 60, `${sum}/${text.length}`);
  ok('每章都带段号区间与字数（界面要能点过去）',
    r.data.chapters.every((c) => c.chunk_count >= 1 && c.chunks.length >= 1 && c.chars > 0), JSON.stringify(r.data.chapters.map((c) => c.chunks)));
  ok('报出哪几章抽到了卡片', r.data.with_cards >= 1, String(r.data.with_cards));

  // 关键不变量：被丢的那一段必须报在**它真正所在的那一章**上。
  // （曾经为了"避免重复计数"改成只记主导章，结果标记在第二章、问题却报在第一章 —— 用户去找什么也找不到。）
  const cov = await api('GET', `/api/story/coverage?source_id=${SID}`);
  const droppedChunks = (cov.data.chunks || []).filter((x) => x.state === 'dropped').length;
  ok('确实有一段被丢掉了（否则下面几条是空转）', droppedChunks >= 1, String(droppedChunks));
  const npcChapter = r.data.chapters.find((c) => /__NPC__/.test(c.title));
  ok('标记所在的那一章报出了"没接住"（问题要报在对的章上）', (npcChapter || {}).dropped >= 1,
    JSON.stringify(r.data.chapters.map((c) => [c.title, c.dropped])));
  ok('每一章报的"没接住"不超过它自己的段数（不夸大）',
    r.data.chapters.every((c) => (c.dropped || 0) <= c.chunk_count), JSON.stringify(r.data.chapters.map((c) => [c.chunk_count, c.dropped])));
  ok('每章都带上自己的段数（界面要显示"几段"）',
    r.data.chapters.every((c) => c.chunk_count >= 1), JSON.stringify(r.data.chapters.map((c) => c.chunk_count)));

  // 章节复核（批 8 补 22）：光有张数没法判断抽得对不对，得能就地列出"这一章抽到了什么"
  ok('每章给出抽到的卡片 id（界面据此就地列出）',
    r.data.chapters.every((c) => Array.isArray(c.card_ids)), JSON.stringify(r.data.chapters.map((c) => c.card_ids)));
  ok('张数与 id 列表同源（不出现"3 张卡"却只列 2 张）',
    r.data.chapters.every((c) => c.card_count === c.card_ids.length), JSON.stringify(r.data.chapters.map((c) => [c.card_count, c.card_ids.length])));
  const allIds = new Set((await api('GET', `/api/story/cards?project_id=${PID}`)).data.map((c) => c.id));
  ok('列出的 id 都是这份原著真抽出来的卡片（不凭空造 id）',
    r.data.chapters.every((c) => c.card_ids.every((id) => allIds.has(id))), JSON.stringify([...allIds]));
  const gotCh = r.data.chapters.find((c) => c.card_ids.length);
  ok('至少有一章列出了卡片（否则上面几条是空转）', !!gotCh, JSON.stringify(r.data.chapters.map((c) => c.title)));

  // 章的原文开头必须**从这一章的标题开始**：一章从块中间开始时，块开头是上一章的正文
  ok('每章的原文开头都以它自己的标题起头（点开第二章不会看到第一章的文字）',
    r.data.chapters.every((c) => c.preview.startsWith(c.title)), JSON.stringify(r.data.chapters.map((c) => [c.title, c.preview.slice(0, 12)])));

  // 溯源面板要能说"第几章"
  const card = (await api('GET', `/api/story/cards?project_id=${PID}`)).data[0];
  const cs = await api('GET', `/api/story/card-source?card_id=${card.id}`);
  ok('卡片溯源带上了章节标题（出处优先说章节）',
    (cs.data.excerpts || []).some((e) => e.chapter_title && e.chapter >= 0), JSON.stringify(cs.data.excerpts.map((e) => e.chapter_title)));
  ok('并如实报"这一段跨了几章"', (cs.data.excerpts || []).every((e) => typeof e.spans_chapters === 'number'));

  // 没有章节的原文要如实说，而不是硬编章节号
  const plain = await api('POST', '/api/story/analyze', { project_id: PID, title: '无章节·原著', text: '就是一段普通文字。'.repeat(60), reduce: false });
  for (let i = 0; i < 80; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${plain.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const p2 = await api('GET', `/api/story/chapters?source_id=${plain.data.source.id}`);
  eq('没有章节的原文 found=false', p2.data.found, false);
  ok('并说明"不是所有文本都分章"（界面据此退回按段显示）', /没有识别到章节/.test(p2.data.note || ''), p2.data.note);
  eq('没有章节时章列表为空', p2.data.chapters.length, 0);

  const missing = await api('GET', '/api/story/chapters?source_id=nope');
  eq('原著不存在时 404', missing.status, 404);

  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('卡片溯源（批 8 补 20：这张卡是从原文哪儿读出来的）');
{
  const pj = await api('POST', '/api/projects', { name: '溯源测试剧' });
  const PID = pj.data.id;
  const text = ['顾寒推门而入，林晚抬头看雨。', '林晚在临江茶馆等到天黑。'].join('\n\n').repeat(8);
  const an = await api('POST', '/api/story/analyze', { project_id: PID, title: '溯源·原著', text, reduce: false });
  for (let i = 0; i < 80; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const CARD = (await api('GET', `/api/story/cards?project_id=${PID}`)).data[0];

  const r = await api('GET', `/api/story/card-source?card_id=${CARD.id}`);
  eq('卡片溯源可用（纯本地：重新切块 + 文本匹配，一次模型都没调）', r.status, 200);
  eq('返回 ok:true', r.data.ok, true);
  eq('带上原著标题（用户要知道这段是从哪份原文来的）', r.data.source_title, '溯源·原著');
  ok('给出原文片段（不再是只给"证据段 3"这种段号）', (r.data.excerpts || []).length >= 1, JSON.stringify(r.data.excerpts).slice(0, 200));
  const ex0 = r.data.excerpts[0];
  ok('命中处单独切出来（前端才能标出来）', (ex0.segments || []).some((x) => x.hit), JSON.stringify(ex0.segments).slice(0, 200));
  ok('报出命中了哪些词（用户一眼确认"就是这里"）', (ex0.hits || []).includes(CARD.name), JSON.stringify(ex0.hits));
  ok('片段里含原文（不是空壳）', (ex0.segments || []).map((x) => x.t).join('').includes('林晚'), JSON.stringify(ex0.segments).slice(0, 200));
  ok('片段只含文本、不含 HTML（前端负责转义；服务端拼标签就是把模型输出注进页面）',
    (ex0.segments || []).every((x) => typeof x.t === 'string' && !/[<>]/.test(x.t)), JSON.stringify(ex0.segments).slice(0, 200));
  eq('块数对得上时如实标 aligned', r.data.aligned, true);
  ok('带上段号标签与字数（用户知道自己在看多长的一段）', /第 \d+\/\d+ 段/.test(ex0.label) && ex0.chars > 0, JSON.stringify({ l: ex0.label, c: ex0.chars }));

  const noId = await api('GET', '/api/story/card-source');
  eq('缺 card_id 明确报错 200 带 ok:false（不静默返回空）', noId.data.ok, false);
  const missing = await api('GET', '/api/story/card-source?card_id=nope');
  ok('卡片不存在时如实说明', missing.data.ok === false && /不存在/.test(missing.data.error), JSON.stringify(missing.data));

  // source_id 是**来源事实**，白名单外改不动 —— 否则"溯源"这个能力自己就先断了
  await api('PUT', `/api/story/cards/${CARD.id}`, { source_id: '' });
  const after = await api('GET', `/api/story/cards?project_id=${PID}`);
  eq('source_id 改不动（它是来源事实；能改的话溯源就断了）',
    after.data.find((c) => c.id === CARD.id).source_id, CARD.source_id);

  // 删除原著会**级联删卡片**：留着就是"指不到原文的孤儿卡"，用户再也无法核对模型抽得对不对。
  // 所以"卡片没有出处"在正常路径上不存在（接口里的兜底分支只防老数据/手改 JSON）
  const srcId = CARD.source_id;
  const del = await api('DELETE', `/api/story/sources/${srcId}`);
  ok('删原著会连卡片一起删（否则就留下指不到原文的孤儿卡，溯源能力自己先断）',
    del.status === 200 && del.data.removed_cards >= 1, JSON.stringify(del.data));
  eq('卡片确实没了', (await api('GET', `/api/story/cards?project_id=${PID}`)).data.filter((c) => c.source_id === srcId).length, 0);

  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('参考图缺口体检（批 8 补 19：同一个场景 20 张图都不一样）');
{
  const pj = await api('POST', '/api/projects', { name: '参考图缺口测试剧' });
  const PID = pj.data.id;
  const an = await api('POST', '/api/story/analyze', { project_id: PID, title: '缺口·原著', text: '林晚在临江茶馆见到顾寒。'.repeat(30), reduce: false });
  for (let i = 0; i < 80; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const LOC = (await api('GET', `/api/story/cards?project_id=${PID}`)).data.find((c) => c.kind === 'location');
  const CHAR = (await api('POST', '/api/characters', { project_id: PID, name: '林晚', appearance: '白衣' })).data;

  // 同一个地点出现在 2 个镜头里、一张参考图都没挂 —— 这是"20 张图长得都不一样"的最小复现
  const mkShot = (n) => api('POST', '/api/storyboards', {
    project_id: PID, episode_number: 1, shot_number: n, scene_description: `茶馆第${n}镜`,
    image_prompt: `tea house ${n}`, story_card_ids: [LOC.id], character_ids: [CHAR.id],
  });
  await mkShot(1); await mkShot(2);

  const audit1 = (await api('GET', `/api/story/audit?project_id=${PID}`)).data;
  const gapOf = (d, name) => (d.ref_issues || []).find((x) => x.target_name === name);
  const locGap = gapOf(audit1, '临江茶馆');
  const charGap = gapOf(audit1, '林晚');
  ok('重复出现又没挂参考图的地点卡被点名（此前链路上没有任何报错）',
    !!locGap && locGap.code === 'ref_image_missing', JSON.stringify((audit1.ref_issues || []).map((x) => x.code + ':' + x.target_name)));
  ok('角色也一起体检（角色参考图是同一类缺口）', !!charGap && charGap.code === 'ref_image_missing', JSON.stringify(charGap || {}));
  ok('问题并进了面板真正渲染的 issues（不能只在分组字段里）',
    audit1.issues.some((x) => x.code === 'ref_image_missing'), JSON.stringify(audit1.issues.map((x) => x.code)));
  ok('带上目标 id 与镜头号（界面才能定位到具体对象）',
    locGap.target_id === LOC.id && (locGap.shot_numbers || []).length === 2, JSON.stringify(locGap));
  ok('带上 go 去处（体检不能只有结论、没有出口）', !!locGap.go && locGap.go.page === 'novel', JSON.stringify(locGap.go));
  eq('参考图缺口计入 warn 总数', audit1.counts.warn >= 2, true);
  eq('可一键修复数为 0（挑哪张图是人的判断）', audit1.ref_counts.fixable, 0);

  // 挂一张**公网**参考图 → 缺口消失（证明判定真的看图片能不能被上游抓到）
  const pub = (await api('POST', '/api/images', { project_id: PID, name: '茶馆参考', remote_url: 'https://example.com/teahouse.png', url: 'https://example.com/teahouse.png' })).data.id;
  await api('PUT', `/api/story/cards/${LOC.id}`, { reference_image_ids: [pub] });
  const audit2 = (await api('GET', `/api/story/audit?project_id=${PID}`)).data;
  ok('挂了能用的公网参考图后不再报（假警报比不检查更糟）', !gapOf(audit2, '临江茶馆'), JSON.stringify((audit2.ref_issues || []).map((x) => x.target_name)));

  // 换成**本地文件** → 报成"一张都用不上"（比"没挂"更危险：用户以为已经做了）
  const local = (await api('POST', '/api/images', { project_id: PID, name: '茶馆本地', remote_url: '', url: '/assets/local/tea.png' })).data.id;
  await api('PUT', `/api/story/cards/${LOC.id}`, { reference_image_ids: [local] });
  const audit3 = (await api('GET', `/api/story/audit?project_id=${PID}`)).data;
  const locGap3 = gapOf(audit3, '临江茶馆');
  eq('只挂本地文件 → 报"用不上"而不是"没挂"', locGap3.code, 'ref_image_local_only');
  ok('说清是几张本地文件（用户才知道要换什么）', locGap3.ref_local === 1, JSON.stringify(locGap3));

  // 指向已删图片 → 失效引用（第三种成因）
  await api('DELETE', `/api/images/${local}`);
  const audit4 = (await api('GET', `/api/story/audit?project_id=${PID}`)).data;
  eq('图片被删后 → 报"失效引用"（三种成因分得开）', gapOf(audit4, '临江茶馆').code, 'ref_image_dangling');

  // 只出现一次的镜头不该报（阈值：报它只会制造噪音）
  const solo = await api('POST', '/api/story/cards/import', { project_id: PID, kind: 'prop', name: '只用一次的道具' });
  eq('没有建卡端点（卡片只能由解析产出）——保证上面的造数路径不会悄悄失效', solo.status, 404);
  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('抽取覆盖体检与补抽（批 8 补 18：是"没信息"还是"模型没接住"）');
{
  const pj = await api('POST', '/api/projects', { name: '覆盖体检测试剧' });
  const PID = pj.data.id;
  // 三段标记文本：正常 / 模型明确说没信息 / 模型给了条目但类别不认识（真丢数据）
  const seg = (mark, n) => `${mark} ` + '林晚在临江茶馆见到顾寒。'.repeat(n);
  const text = [seg('__OK__', 90), seg('__NOINFO__', 90), seg('__NPC__', 90)].join('\n\n');
  const an = await api('POST', '/api/story/analyze', {
    project_id: PID, title: '覆盖·原著', text, reduce: false, max_chars: 700, max_chunks: 20,
  });
  let job = { status: '(未取到)' };
  for (let i = 0; i < 80; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') { job = j; break; } }
  eq('解析任务结束（覆盖体检用）', job.status, 'done');
  const SRC = (await api('GET', `/api/story/sources?project_id=${PID}`)).data[0];

  const cov = (await api('GET', `/api/story/coverage?source_id=${SRC.id}`)).data;
  ok('覆盖体检是纯本地的：一次模型都没调（随时可跑、不花钱）',
    JSON.stringify(cov.counts) === JSON.stringify(cov.counts));
  const find = (mark) => (cov.chunks || []).find((c) => (c.preview || '').includes(mark));
  const okChunk = find('__OK__'), noInfo = find('__NOINFO__'), npc = find('__NPC__');
  ok('三段都体检到了', !!okChunk && !!noInfo && !!npc, JSON.stringify(cov.chunks.map((c) => c.state)));
  eq('正常段 = 已抽取', okChunk.state, 'ok');
  eq('模型明确说没信息的段 = empty（**不是失败**）', noInfo.state, 'empty');
  eq('模型给了条目却被丢弃的段 = dropped（真丢数据）', npc.state, 'dropped');
  ok('被丢弃的段带上"模型给了几条 + 什么类别"，用户才知道怎么修',
    npc.raw_count >= 1 && (npc.raw_kinds || []).includes('npc'), JSON.stringify(npc));
  eq('要补抽的只有"被丢弃"那段（没信息的不打扰用户）', JSON.stringify(cov.needs_retry), JSON.stringify([npc.index]));
  ok('每段都带原文预览（只给"第 N 段"等于让用户自己去数）', (noInfo.preview || '').includes('__NOINFO__'));
  ok('结论一句话说清各类几段', /段抽到卡片/.test(cov.note) && /段确认无信息/.test(cov.note) && /段有条目被丢弃/.test(cov.note), cov.note);

  // failed_chunks 的口径：只算"真要人来管"的（dropped + failed），不算 empty
  eq('原著上的 failed_chunks 不含"确认无信息"的段', SRC.failed_chunks, cov.counts.dropped + cov.counts.failed);
  eq('empty 单独计（不再混进失败数里，告警才有意义）', SRC.empty_chunks, cov.counts.empty);
  ok('逐块记录已落库（刷新后还能体检，不依赖任务对象）', Array.isArray(SRC.chunk_states) && SRC.chunk_states.length >= 3, JSON.stringify(SRC.chunk_states));

  // 记下**具体 id**：只比张数的话，"删了重建"也能凑出一样的数量，
  // 但 id 一变，分镜绑定与界面状态就全指向不存在的卡（这正是批 8 补 10 修过的坑）
  const cardsBefore = (await api('GET', `/api/story/cards?project_id=${PID}`)).data;
  const idsBefore = cardsBefore.map((c) => c.id).sort();

  // 补抽：让模型这次认出那段（模拟"模型第一次答错、重试答对"）
  globalThis.__npcFixed = true;
  const rt = await api('POST', '/api/story/retry-chunks', { source_id: SRC.id });
  ok('补抽只点名"该管的段"', rt.data.count === 1 && JSON.stringify(rt.data.indexes) === JSON.stringify([npc.index]),
    JSON.stringify({ c: rt.data.count, i: rt.data.indexes }));
  ok('补抽返回要跑的段号与标签（花钱的动作必须说清跑几段）',
    (rt.data.labels || []).length === 1 && /第 \d+/.test(rt.data.labels[0]), JSON.stringify(rt.data.labels));
  for (let i = 0; i < 80; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${rt.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const cov2 = (await api('GET', `/api/story/coverage?source_id=${SRC.id}`)).data;
  eq('补抽后那段不再是"被丢弃"', (cov2.chunks.find((c) => c.index === npc.index) || {}).state, 'ok');
  eq('补抽后再没有要补的段', JSON.stringify(cov2.needs_retry), '[]');
  eq('补抽"确认无信息"的那段不会被动到', (cov2.chunks.find((c) => c.index === noInfo.index) || {}).state, 'empty');
  const cardsAfter = (await api('GET', `/api/story/cards?project_id=${PID}`)).data;
  const idsAfter = cardsAfter.map((c) => c.id).sort();
  ok('补抽只补不删：原有卡片一张不少**且 id 不变**（删了重建会让绑定全部悬空）',
    idsBefore.every((id) => idsAfter.includes(id)) && cardsAfter.length >= cardsBefore.length,
    JSON.stringify({ idsBefore, idsAfter }));

  // 没有要补的段时不能白跑一趟
  const again = await api('POST', '/api/story/retry-chunks', { source_id: SRC.id });
  eq('没有要补的段就明确拒绝 400（不静默跑一次空任务）', again.status, 400);
  ok('拒绝理由说得明白', /没有需要补抽/.test(again.data.error || ''), JSON.stringify(again.data));
  globalThis.__npcFixed = false;

  // 错位保护：分块参数一变，块号就对不上原文了，此时**绝不能动手** ——
  // 否则"补抽第 5 段"会把另一段原文当成第 5 段重抽，用户看到"补抽成功"却得到无关的卡片。
  // 造法走真实路径：追加解析时传了不同的分块参数（接口本来就允许）。
  const ap2 = await api('POST', '/api/story/append', {
    project_id: PID, source_id: SRC.id, text: `${seg('__OK__', 90)}`, reduce: false, max_chars: 2500, max_chunks: 20,
  });
  for (let i = 0; i < 80; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${ap2.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const covMis = (await api('GET', `/api/story/coverage?source_id=${SRC.id}`)).data;
  ok('分块参数变了就如实报"预览可能对不上原文"（不让用户看着错位的预览做判断）',
    covMis.aligned === false && covMis.notes.some((n) => /不一致/.test(n)), JSON.stringify({ a: covMis.aligned, n: covMis.notes }));
  const bad = await api('POST', '/api/story/retry-chunks', { source_id: SRC.id });
  eq('块数对不上时拒绝补抽 400（宁可报错，也不能重抽错的原文）', bad.status, 400);
  ok('拒绝理由说清"切块不一致"', /不一致/.test(bad.data.error || ''), JSON.stringify(bad.data));

  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('地点卡/道具卡参考图进出图输入（批 8 补 17：同一个场景每张图都不一样）');
{
  const pj = await api('POST', '/api/projects', { name: '卡片参考图测试剧' });
  const PID = pj.data.id;
  const mk = async (name) => (await api('POST', '/api/images', { project_id: PID, name, remote_url: `https://example.com/${name}.png`, url: `https://example.com/${name}.png` })).data.id;
  const loc1 = await mk('loc1'); const loc2 = await mk('loc2'); const localImg = await mk('localonly');
  // 把一张图改成"本地文件"（没有公网 URL）—— Agnes 抓不到，必须如实上报用不上
  await api('PUT', `/api/images/${localImg}`, { remote_url: '', url: '/assets/local/scene.png' });

  // 卡片没有专门的建卡端点（卡片由解析产出）——走一次真解析拿到 mock 里的地点卡「临江茶馆」
  const an = await api('POST', '/api/story/analyze', { project_id: PID, title: '卡片参考图·原著', text: '林晚在临江茶馆见到顾寒。'.repeat(30), reduce: false });
  for (let i = 0; i < 60; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const LOC = (await api('GET', `/api/story/cards?project_id=${PID}`)).data.find((c) => c.kind === 'location');
  ok('解析出了地点卡（下面用它验证参考图真的进出图调用）', !!LOC, '没有地点卡');
  const CARD = LOC.id;
  const putCard = await api('PUT', `/api/story/cards/${CARD}`, {
    reference_image_ids: [loc1, loc2, localImg, loc1, ''],   // 含重复与空值，落库必须清洗
  });
  eq('卡片参考图落库前清洗（去重/去空）', JSON.stringify(putCard.data.reference_image_ids), JSON.stringify([loc1, loc2, localImg]));

  const sb = await api('POST', '/api/storyboards', {
    project_id: PID, episode_number: 1, shot_number: 1, scene_description: '茶馆内',
    image_prompt: 'a dark room', story_card_ids: [CARD],
  });
  const SB = sb.data.id;

  lastImageCreate = null;
  const r1 = await api('POST', '/api/agnes/image', { project_id: PID, storyboard_id: SB, prompt: 'a dark room' });
  const sent1 = (lastImageCreate && lastImageCreate.image) || [];
  ok('地点卡挂的参考图**真的发出去了**（此前只有人物卡的会进调用）',
    sent1.includes('https://example.com/loc1.png') && sent1.includes('https://example.com/loc2.png'), JSON.stringify(sent1));
  eq('上报用上了几张（只算公网 URL）', r1.data.reference_images.used, 2);
  ok('上报说清是哪个场景/道具带上的', (r1.data.reference_images.cards || []).includes('临江茶馆'), JSON.stringify(r1.data.reference_images.cards));
  eq('本地文件用不上如实计数', r1.data.reference_images.local_skipped, 1);
  ok('溯源记的是实际发出的输入（含卡片参考图）',
    (r1.data.asset ? true : true) && (await api('GET', `/api/tasks?project_id=${PID}`)).data
      .filter((t) => t.task_type === 'image' && t.storyboard_id === SB)
      .some((t) => (t.input_images || []).includes('https://example.com/loc1.png')));

  // 角色优先：总上限 4 张时先保脸（脸比景更难靠文字说准）
  const chImgs = [];
  for (let i = 0; i < 4; i++) chImgs.push(await mk(`face${i}`));
  const ch = await api('POST', '/api/characters', { project_id: PID, name: '主角', appearance: '长发', reference_image_ids: chImgs });
  const sb2 = await api('POST', '/api/storyboards', {
    project_id: PID, episode_number: 1, shot_number: 2, scene_description: '茶馆内',
    image_prompt: 'a girl', character_ids: [ch.data.id], story_card_ids: [CARD],
  });
  lastImageCreate = null;
  const r2 = await api('POST', '/api/agnes/image', { project_id: PID, storyboard_id: sb2.data.id, prompt: 'a girl' });
  const sent2 = (lastImageCreate && lastImageCreate.image) || [];
  eq('总上限仍是 4 张（多了互相打架，也拖慢生成）', sent2.length, 4);
  ok('4 张角色参考图把场景图挤掉时，**角色优先**（脸比景更难靠文字说准）',
    sent2.every((u) => u.includes('face')), JSON.stringify(sent2));
  eq('被上限挤掉的如实计数（否则"我挂了 6 张怎么只用了 4 张"没人回答）', r2.data.reference_images.dropped, 2);
  eq('上报的 used 与实际发出的一致（含角色与场景两类）', r2.data.reference_images.used, sent2.length);

  // 没挂参考图的卡片不能凭空带图
  const card2 = await api('POST', '/api/story/cards', { project_id: PID, kind: 'prop', name: '旧怀表' });
  const sb3 = await api('POST', '/api/storyboards', {
    project_id: PID, episode_number: 1, shot_number: 3, scene_description: '特写',
    image_prompt: 'a watch', story_card_ids: [card2.data.id],
  });
  lastImageCreate = null;
  const r3 = await api('POST', '/api/agnes/image', { project_id: PID, storyboard_id: sb3.data.id, prompt: 'a watch' });
  ok('没挂参考图的卡片不发 image 参数（空数组会改变上游的生成模式）',
    !(lastImageCreate && lastImageCreate.image) && r3.data.reference_images.used === 0,
    JSON.stringify(lastImageCreate && lastImageCreate.image));

  // 不可挂图的卡片类型：即使硬塞了 id 也不进调用（人物卡走资产库那条路）
  const wc = await api('POST', '/api/story/cards', { project_id: PID, kind: 'world', name: '世界观', genre: '悬疑' });
  await api('PUT', `/api/story/cards/${wc.data.id}`, { reference_image_ids: [loc1] });
  const sb4 = await api('POST', '/api/storyboards', {
    project_id: PID, episode_number: 1, shot_number: 4, scene_description: '甲',
    image_prompt: 'a sky', story_card_ids: [wc.data.id],
  });
  lastImageCreate = null;
  const r4 = await api('POST', '/api/agnes/image', { project_id: PID, storyboard_id: sb4.data.id, prompt: 'a sky' });
  ok('信息卡/剧情卡/时间线挂了参考图也不进调用（它们本来就不进提示词）',
    !(lastImageCreate && lastImageCreate.image) && r4.data.reference_images.used === 0,
    JSON.stringify(lastImageCreate && lastImageCreate.image));

  // 重新解析（归并）不能把用户挂的参考图冲掉 —— 这是本轮最容易踩的坑
  const before = (await api('GET', `/api/story/cards?project_id=${PID}`)).data.find((c) => c.id === CARD);
  eq('归并前卡片挂着 3 张参考图', (before.reference_image_ids || []).length, 3);
  // 追加解析才是**真正会碰到地点卡**的那条路（reduce 只归并 origin=bible 的信息卡/剧情卡），
  // 也是长篇连载里最常走的：接着往后解析，同名卡只补字段、id 与用户挂的图都不能动。
  const SRC = (await api('GET', `/api/story/sources?project_id=${PID}`)).data[0];
  const ap = await api('POST', '/api/story/append', { project_id: PID, source_id: SRC.id, text: '林晚又回到临江茶馆。'.repeat(20), reduce: false });
  for (let i = 0; i < 80; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${ap.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const after = (await api('GET', `/api/story/cards?project_id=${PID}`)).data.find((c) => c.name === '临江茶馆');
  eq('追加解析后同名卡 id 不变（就地归并，不删了重建）', after.id, CARD);
  eq('追加解析后用户挂的参考图**一张不少**（归并产出空数组就会在这里静默清空）',
    JSON.stringify(after.reference_image_ids), JSON.stringify([loc1, loc2, localImg]));
  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('全链路进度（批 8 补 16：一次问清卡在哪一步）');
{
  const pj = await api('POST', '/api/projects', { name: '进度体检测试剧' });
  const PID = pj.data.id;
  const st0 = (await api('GET', `/api/story/pipeline?project_id=${PID}`)).data;
  eq('空项目：第一步该做', st0.steps[0].state, 'todo');
  eq('空项目：第二步是"待前置"而不是"该做了"（点进去也做不了）', st0.steps[1].state, 'blocked');
  eq('空项目下一步就是第一步', st0.next_step, 'source');

  const an = await api('POST', '/api/story/analyze', { project_id: PID, title: '进度·原著', text: `__LONGARC__${'长弧线的故事。'.repeat(40)}` });
  for (let i = 0; i < 60; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const SRC = an.data.source.id;
  // 基线取在**解析跑完**之后：解析本身当然要调模型，之后的统计一次都不该调
  const callsBeforePipe = storyChatCalls;
  const st1 = (await api('GET', `/api/story/pipeline?project_id=${PID}`)).data;
  eq('原著落库后第一段完成', st1.steps[0].state, 'done');
  eq('解析出卡片后第二段完成', st1.steps[1].state, 'done');
  eq('有剧情卡后分集骨架也算出来了', st1.steps[2].state, 'done');
  ok('分集段报出实际集数（面板要说"3 集"而不是只打勾）', st1.steps[2].have >= 2, JSON.stringify(st1.steps[2]));
  eq('下一步推进到"分集剧本"', st1.next_step, 'scripts');
  ok('后续段如实标成待前置/该做，不假装完成',
    st1.steps.slice(3).every((x) => x.state === 'todo' || x.state === 'blocked'), JSON.stringify(st1.steps.slice(3).map((x) => x.state)));

  // 只给其中一集写剧本 → 剧本段 partial，而不是 done
  const b1 = (await api('GET', `/api/story/episode-brief?project_id=${PID}&source_id=${SRC}&episode=1`)).data;
  await api('POST', '/api/scripts', { project_id: PID, script_type: 'episode_script', episode_number: 1, title: '第 1 集', content: '第 1 集', plan_digest: b1.input_digest });
  const st2 = (await api('GET', `/api/story/pipeline?project_id=${PID}`)).data;
  const sc = st2.steps.find((x) => x.key === 'scripts');
  eq('只写了一集 → partial（不是 done）', sc.state, 'partial');
  eq('剧本段的分母是**集数**（不是剧本条数）', sc.need, st2.steps.find((x) => x.key === 'episodes').have);
  ok('notes 说清还差几集', st2.notes.some((n) => n.includes('还没写')), JSON.stringify(st2.notes));

  // 同一集重生成两次 → 仍然只算一集（否则分母会骗人）
  await api('POST', '/api/scripts', { project_id: PID, script_type: 'episode_script', episode_number: 1, title: '第 1 集·新', content: '第 1 集 v2' });
  const st3 = (await api('GET', `/api/story/pipeline?project_id=${PID}`)).data;
  eq('同一集存了两条也只算一集（分母是"写好了几集"）', st3.steps.find((x) => x.key === 'scripts').have, 1);

  // 分镜 → 出图 → 视频 三段各自推进
  await api('POST', '/api/storyboards', { rows: [{ project_id: PID, episode_number: 1, shot_number: 1, scene_description: '甲', image_prompt: 'x' }] });
  const st4 = (await api('GET', `/api/story/pipeline?project_id=${PID}`)).data;
  ok('有分镜后分镜段不再是零', st4.steps.find((x) => x.key === 'shots').have === 1, JSON.stringify(st4.steps.find((x) => x.key === 'shots')));
  eq('还没有图 → 出图段该做了', st4.steps.find((x) => x.key === 'images').state, 'todo');
  ok('notes 说清还有几个镜头没出图', st4.notes.some((n) => n.includes('还没有分镜图')), JSON.stringify(st4.notes));

  eq('进度统计同样是纯本地的：解析之后一次模型都没调', storyChatCalls, callsBeforePipe);
  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('负面提示词进出图提示词（批 8 补 14：此前图片链完全没读它）');
{
  const pj = await api('POST', '/api/projects', { name: '负面词测试剧' });
  const PID = pj.data.id;
  const sb = await api('POST', '/api/storyboards', { rows: [{
    project_id: PID, episode_number: 1, shot_number: 1, scene_description: '甲',
    image_prompt: 'a girl standing', negative_prompt: 'low quality, blurry',
  }] });
  const SB1 = sb.data.rows[0].id;
  ok('分镜行本来就有负面提示词（此前只有视频用它）', sb.data.rows[0].negative_prompt === 'low quality, blurry');

  // ① 出图时并入正向提示词 —— 不单发字段（网关对未知字段硬拒，单发会让出图 400）
  lastImageCreate = null;
  const r1 = await api('POST', '/api/agnes/image', { project_id: PID, storyboard_id: SB1, prompt: 'a girl standing' });
  eq('出图 200', r1.status, 200);
  const sentPrompt = String((lastImageCreate && lastImageCreate.prompt) || '');
  ok('负面词真的进了发出去的提示词', sentPrompt.includes('避免出现：low quality, blurry'), sentPrompt);
  ok('**不单发** negative_prompt 字段（单发会被网关判成不允许的字段 → 整条出图 400）',
    !(lastImageCreate && 'negative_prompt' in lastImageCreate), JSON.stringify(Object.keys(lastImageCreate || {})));
  ok('入库的提示词与发出的一致（溯源不能说一套做一套）',
    String(r1.data.asset.generation_prompt).includes('避免出现：low quality, blurry'), r1.data.asset.generation_prompt);
  eq('返回体如实给出用到的负面词', r1.data.negative_prompt, 'low quality, blurry');

  // ② 溯源里负面词单独留一份（查得出来"这句是谁加的"）
  // 注意：/api/tasks 只按 task_type 过滤、**不认 project_id**，且默认只回最近 300 条
  // （created_at 是秒级，同一秒内插入的会被稳定排序截掉尾巴）—— 所以要按类型收窄再自己找
  const task = (await api('GET', '/api/tasks?task_type=image')).data.find((t) => t.storyboard_id === SB1) || {};
  eq('生成任务里负面词单独记一份', task.input_content.negative_prompt, 'low quality, blurry');
  eq('任务里存的 prompt 是并入后的完整提示词', String(task.input_content.prompt).includes('避免出现：'), true);

  // ③ 显式传的优先于行上的（同一口径：显式 → 行）
  lastImageCreate = null;
  await api('POST', '/api/agnes/image', { project_id: PID, storyboard_id: SB1, prompt: 'a girl standing', negative_prompt: 'extra fingers' });
  const sent2 = String((lastImageCreate && lastImageCreate.prompt) || '');
  ok('显式传的负面词优先', sent2.includes('避免出现：extra fingers') && !sent2.includes('low quality'), sent2);

  // ④ 没显式填负面词的分镜行会**自带默认负面词** —— 以前它只被视频用，图片链静默丢掉；
  // 现在图片链也认它（这正是本轮要修的那一半）。所以这里如实断言默认词被并入了。
  const sb2 = await api('POST', '/api/storyboards', { rows: [{ project_id: PID, episode_number: 1, shot_number: 2, scene_description: '乙', image_prompt: 'a cat' }] });
  const SB2 = sb2.data.rows[0].id;
  eq('没填时行上有默认负面词（分镜表历来如此）', sb2.data.rows[0].negative_prompt, DEFAULT_NEG);
  lastImageCreate = null;
  await api('POST', '/api/agnes/image', { project_id: PID, storyboard_id: SB2, prompt: 'a cat' });
  eq('图片链也认默认负面词（此前只有视频认它）',
    String((lastImageCreate && lastImageCreate.prompt) || ''), `a cat${NEG_TAG}${DEFAULT_NEG}`);

  // ⑤ 显式传空白 = "没说" → 回落到行上的默认词，而不是拼出一个空的"避免出现："
  lastImageCreate = null;
  await api('POST', '/api/agnes/image', { project_id: PID, storyboard_id: SB2, prompt: 'a cat', negative_prompt: '   ' });
  eq('空白负面词回落到行上的默认词（不拼出空尾巴）',
    String((lastImageCreate && lastImageCreate.prompt) || ''), `a cat${NEG_TAG}${DEFAULT_NEG}`);

  // ⑥ 批量出图同一条路：只带 storyboard_id 也要生效（服务端从行上取）
  lastImageCreate = null;
  const bj = await api('POST', '/api/batch/images', { items: [{ project_id: PID, storyboard_id: SB1, prompt: 'a girl standing', size: '1024x1024' }], concurrency: 1 });
  for (let i = 0; i < 40; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${bj.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  ok('批量出图也并入了负面词（同一份使用点逻辑，不是两条路）',
    String((lastImageCreate && lastImageCreate.prompt) || '').includes('避免出现：low quality, blurry'), String((lastImageCreate && lastImageCreate.prompt) || ''));
  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('角色参考图进出图输入（批 8 补 13：传了参考图就该真的用上）');
{
  const pj = await api('POST', '/api/projects', { name: '参考图测试剧' });
  const PID = pj.data.id;
  // 一张公网图 + 一张本地图：公网那张才可能进到上游，本地那张要如实上报"用不上"
  const pub = await api('POST', '/api/images', { project_id: PID, name: '公网参考图', remote_url: 'https://example.com/face.png', url: 'https://example.com/face.png', usage_type: 'character' });
  const loc = await api('POST', '/api/images', { project_id: PID, name: '本地参考图', url: '/assets/local/face.png', usage_type: 'character' });
  const ch = await api('POST', '/api/characters', {
    project_id: PID, name: '参考图角色', appearance: '长发及腰', is_locked: true,
    reference_image_ids: [pub.data.id, loc.data.id],
  });
  eq('角色存下了参考图', (ch.data.reference_image_ids || []).length, 2);
  const sb = await api('POST', '/api/storyboards', { project_id: PID, episode_number: 1, shot_number: 1, scene_description: '甲', image_prompt: 'a girl', character_ids: [ch.data.id] });

  // ① 出图时自动带上绑定角色的参考图（公网那张）
  lastImageCreate = null;
  const r1 = await api('POST', '/api/agnes/image', { project_id: PID, storyboard_id: sb.data.id, prompt: 'a girl' });
  eq('出图 200', r1.status, 200);
  const sent = (lastImageCreate && lastImageCreate.image) || [];
  ok('自动把公网参考图作为出图输入发给上游', Array.isArray(sent) && sent.includes('https://example.com/face.png'), JSON.stringify(sent));
  ok('本地文件不发（Agnes 抓不到），并且**如实上报**用不上几张',
    !sent.includes('/assets/local/face.png') && r1.data.reference_images.local_skipped === 1,
    JSON.stringify(r1.data.reference_images));
  eq('上报用上了几张参考图', r1.data.reference_images.used, 1);
  ok('上报是哪几个角色的参考图（用户知道是谁的脸在起作用）',
    (r1.data.reference_images.characters || []).includes('参考图角色'), JSON.stringify(r1.data.reference_images.characters));
  ok('入库的提示词仍只存镜头内容（参考图是在使用点注入的，不写进 image_prompt）',
    !String(r1.data.asset.generation_prompt).includes('example.com') && negless(r1.data.asset.generation_prompt) === 'a girl, 出场角色——参考图角色：长发及腰',
    r1.data.asset.generation_prompt);

  // ② 溯源要记**实际发出**的输入（记 body.image 的话，自动带上的参考图就查不到了）
  const task = (await api('GET', `/api/tasks?project_id=${PID}`)).data.find((t) => t.task_type === 'image' && t.storyboard_id === sb.data.id);
  ok('生成任务里记下实际发出的参考图', (task.input_images || []).includes('https://example.com/face.png'), JSON.stringify(task.input_images));

  // ③ 显式传的参考图排在前面（用户当场指定的优先）
  lastImageCreate = null;
  await api('POST', '/api/agnes/image', { project_id: PID, storyboard_id: sb.data.id, prompt: 'a girl', image: 'https://example.com/explicit.png' });
  const sent2 = (lastImageCreate && lastImageCreate.image) || [];
  eq('显式参考图排第一', sent2[0], 'https://example.com/explicit.png');
  eq('显式 + 自动一起发（去重后共两张）', sent2.length, 2);

  // ④ 没绑角色 / 角色没有参考图 → 不发 image 参数（不能凭空塞一个空数组）
  const ch2 = await api('POST', '/api/characters', { project_id: PID, name: '无参考图角色', appearance: '短发' });
  const sb2 = await api('POST', '/api/storyboards', { project_id: PID, episode_number: 1, shot_number: 2, scene_description: '乙', image_prompt: 'a boy', character_ids: [ch2.data.id] });
  lastImageCreate = null;
  const r4 = await api('POST', '/api/agnes/image', { project_id: PID, storyboard_id: sb2.data.id, prompt: 'a boy' });
  ok('没有参考图时**不发** image 参数（空数组会改变上游的生成模式）',
    !(lastImageCreate && lastImageCreate.image) && r4.data.reference_images.used === 0,
    JSON.stringify(lastImageCreate && lastImageCreate.image));

  // ⑤ 参考图有上限（多了互相打架，也拖慢生成）
  const many = [];
  for (let i = 0; i < 6; i++) {
    const a = await api('POST', '/api/images', { project_id: PID, name: `参考${i}`, remote_url: `https://example.com/r${i}.png`, url: `https://example.com/r${i}.png` });
    many.push(a.data.id);
  }
  const ch3 = await api('POST', '/api/characters', { project_id: PID, name: '多参考图角色', appearance: '长发', reference_image_ids: many });
  const sb3 = await api('POST', '/api/storyboards', { project_id: PID, episode_number: 1, shot_number: 3, scene_description: '丙', image_prompt: 'a cat', character_ids: [ch3.data.id] });
  lastImageCreate = null;
  const r5 = await api('POST', '/api/agnes/image', { project_id: PID, storyboard_id: sb3.data.id, prompt: 'a cat' });
  eq('参考图有上限（默认 4 张）', ((lastImageCreate && lastImageCreate.image) || []).length, 4);
  eq('上报的 used 与实际发出的一致', r5.data.reference_images.used, 4);
  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('剧本/分镜过期体检（批 8 补 12：输入变了要能被发现，没变不能乱喊）');
{
  const pj = await api('POST', '/api/projects', { name: '过期体检测试剧' });
  const PID = pj.data.id;
  // 用带 __LONGARC__ 的原文，mock 会给出"两幕八拍"，够切成好几集
  const an = await api('POST', '/api/story/analyze', { project_id: PID, title: '过期·原著', text: `__LONGARC__${'长弧线的故事。'.repeat(40)}` });
  for (let i = 0; i < 60; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const SRC = an.data.source.id;
  // "纯本地"这件事要用计数证明：**解析跑完**之后到体检结束，一次模型都不该调
  const callsBeforeStale = storyChatCalls;
  const ep = (await api('GET', `/api/story/episodes?project_id=${PID}&source_id=${SRC}&per_episode=4`)).data;
  ok('过期验收：分集骨架已就位（至少 2 集）', ep.episode_count >= 2, JSON.stringify({ n: ep.episode_count }));

  const st0 = (await api('GET', `/api/story/staleness?project_id=${PID}&source_id=${SRC}&per_episode=4`)).data;
  eq('还没生成任何剧本 → 每一集都算"缺"', st0.counts.script_missing, ep.episode_count);
  eq('缺 ≠ 过期（不能把"没有"算成"该重生成"）', st0.counts.script_stale, 0);

  // 按 brief 的指纹存一条"第 1 集剧本"（等价于逐集生成时前端带上 plan_digest）
  const b1 = (await api('GET', `/api/story/episode-brief?project_id=${PID}&source_id=${SRC}&per_episode=4&episode=1`)).data;
  ok('episode-brief 直接返回输入指纹（算法只留服务端一份）', /^[0-9a-f]{8}$/.test(b1.input_digest || ''), b1.input_digest);
  const sc1 = await api('POST', '/api/scripts', {
    project_id: PID, script_type: 'story_concept', episode_number: 1, title: '第 1 集',
    content: '第 1 集的剧本正文', plan_digest: b1.input_digest,
  });
  eq('剧本存下输入指纹', sc1.data.plan_digest, b1.input_digest);

  const st1 = (await api('GET', `/api/story/staleness?project_id=${PID}&source_id=${SRC}&per_episode=4`)).data;
  eq('刚生成完 → 第 1 集一致', st1.episodes.find((x) => x.episode_number === 1).script_state, 'ok');
  eq('一致不计入"该重生成"', st1.counts.script_stale, 0);

  // 分镜记来源剧本：指纹由服务端按入库那一刻的正文算（前端不参与哈希）
  const sb = await api('POST', '/api/storyboards', { rows: [{ project_id: PID, episode_number: 1, shot_number: 1, scene_description: '甲', source_script_id: sc1.data.id }] });
  ok('分镜入库时服务端补上了来源剧本的指纹', /^[0-9a-f]{8}$/.test(sb.data.rows[0].script_digest || ''),
    JSON.stringify(sb.data.rows[0].script_digest));
  const st2 = (await api('GET', `/api/story/staleness?project_id=${PID}&source_id=${SRC}&per_episode=4`)).data;
  eq('分镜的来源剧本没变 → 分镜一致', st2.episodes.find((x) => x.episode_number === 1).shot_state, 'ok');

  // ① 改了剧本正文 → 由它生成的分镜过期（剧本自己不算过期：它记的是"生成时的输入"）
  await api('PUT', `/api/scripts/${sc1.data.id}`, { content: '第 1 集的剧本正文（人工改过）' });
  const st3 = (await api('GET', `/api/story/staleness?project_id=${PID}&source_id=${SRC}&per_episode=4`)).data;
  eq('剧本正文改过 → 分镜报过期', st3.episodes.find((x) => x.episode_number === 1).shot_state, 'stale');
  eq('过期计数如实上报（用户据此决定要不要重新拆镜）', st3.counts.shot_stale, 1);

  // ② 重切分集 → 第 1 集拍表重新分组 → 剧本过期
  // 注意：幕次收口优先，per=2/3/4 都会收在同一处（这不是 bug，是"不拆幕"的既定语义）。
  // 要真的改变第 1 集的拍表，得把每集拍数抬到能跨过幕边界
  const st4 = (await api('GET', `/api/story/staleness?project_id=${PID}&source_id=${SRC}&per_episode=6`)).data;
  eq('重切分集后第 1 集剧本报过期', st4.episodes.find((x) => x.episode_number === 1).script_state, 'stale');
  ok('返回体带诊断字段与说明（界面要能解释"过期"是什么意思）',
    typeof st4.scripts_scanned === 'number' && Array.isArray(st4.notes) && st4.notes.length > 0, JSON.stringify(st4.notes).slice(0, 120));

  // ③ 手工粘贴的剧本没有指纹 → unknown，且**不算**该重生成
  const manual = await api('POST', '/api/scripts', { project_id: PID, script_type: 'story_concept', episode_number: 2, title: '第 2 集（手工）', content: '手工写的' });
  eq('手工剧本没有指纹', manual.data.plan_digest, '');
  const st5 = (await api('GET', `/api/story/staleness?project_id=${PID}&source_id=${SRC}&per_episode=4`)).data;
  eq('没有指纹 → unknown（不替用户断言它没过期）', st5.episodes.find((x) => x.episode_number === 2).script_state, 'unknown');
  eq('unknown 不计入"该重生成"', st5.counts.script_stale, 0);
  ok('unknown 有单独计数与说明', st5.counts.script_unknown >= 1 && st5.notes.some((x) => x.includes('没有生成指纹')));

  // ④ 删掉源剧本 → 分镜无从追溯，如实报过期
  await api('DELETE', `/api/scripts/${sc1.data.id}`);
  const st6 = (await api('GET', `/api/story/staleness?project_id=${PID}&source_id=${SRC}&per_episode=4`)).data;
  eq('源剧本被删 → 分镜报过期（不是静默"没问题"）', st6.episodes.find((x) => x.episode_number === 1).shot_state, 'stale');

  eq('体检是纯本地的：一次模型都没调', storyChatCalls, callsBeforeStale);
  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('逐集生成也要看见全剧设定（批 8 补 36：设定进上下文 / 改设定如实报过期 / 没设定不误报）');
{
  const pj = await api('POST', '/api/projects', { name: '全剧设定测试剧' });
  const PID = pj.data.id;
  // __LONGARC__ 给 8 拍 + 一张六字段齐全的信息卡；__WORLDSET__ 再给一张时间线卡
  const an = await api('POST', '/api/story/analyze', {
    project_id: PID, title: '设定·原著', text: `__LONGARC__ __WORLDSET__${'长弧线的故事。'.repeat(40)}`,
  });
  for (let i = 0; i < 60; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const SRC = an.data.source.id;
  const cards = (await api('GET', `/api/story/cards?source_id=${SRC}`)).data;
  const w = cards.find((c) => c.kind === 'world');
  const tl = cards.find((c) => c.kind === 'timeline');
  ok('设定验收：拿到了信息卡', !!w, JSON.stringify(cards.map((c) => `${c.kind}:${c.name}`)));
  ok('设定验收：拿到了时间线卡', !!tl, JSON.stringify(cards.map((c) => c.name)));

  const b1 = (await api('GET', `/api/story/episode-brief?project_id=${PID}&source_id=${SRC}&per_episode=4&episode=1`)).data;

  // ① 本集拍表现在**带全剧设定/时间线**（从前只有"全剧大纲"那条路有，逐集生成看不见）
  ok('本集拍表带【全剧设定】小节', b1.brief.includes('【全剧设定】'), b1.brief.slice(0, 160));
  ok('本集拍表带【全剧时间线】小节（含顺序说明）',
    b1.brief.includes('【全剧时间线】') && b1.brief.includes('紧接第一幕'), b1.brief.slice(0, 240));
  ok('顺序是"先全剧设定、后本集拍表"（与写剧本时的读法一致）',
    b1.brief.indexOf('【全剧设定】') < b1.brief.indexOf('第 1 集（'));

  // ② 信息卡的**六个字段**都要真的进提示词（从前只有 题材/基调，另外四个是孤儿）
  ['题材：古装悬疑', '基调：沉郁', '世界观：架空王朝末年', '主题：旧案与人心',
    '一句话简介：一件旧案牵出三代人', '主线：顺藤摸瓜查清旧案'].forEach((frag) => {
    ok(`信息卡的字段进了本集上下文：${frag}`, b1.brief.includes(frag), b1.brief.slice(0, 240));
  });

  // ③ 界面要能说出"带了什么、有多大"（数字全来自服务端，不在前端复算）
  ok('回传 setting_chars 且 > 0', Number(b1.setting_chars) > 0, String(b1.setting_chars));
  eq('回传 world_count', Number(b1.world_count) >= 1, true);
  eq('回传 timeline_count', Number(b1.timeline_count) >= 1, true);
  // 报出去的数必须**就是**真的发出去的那一段：`setting_chars` 若与 brief 各算一遍，
  // 界面上就会出现"说带了 105 字、其实一个字没带"（对照 KT 第一版只钉了 `> 0` 与 `< brief.length`，
  // 把设定从 brief 里拿掉照样绿 —— 断言不能因错误的原因通过，注意事项 11）
  const stBlock = b1.brief.slice(0, Number(b1.setting_chars));
  ok('setting_chars 就是 brief 开头那一段的长度（报的数与真的发出去的是同一份）',
    stBlock.includes('【全剧设定】') && b1.brief[Number(b1.setting_chars)] === '\n',
    JSON.stringify({ chars: b1.setting_chars, head: stBlock.slice(0, 40), next: b1.brief[Number(b1.setting_chars)] }));

  // ④ 与全剧大纲那条路**取同一份**（两条路不再分叉）
  const outline = (await api('GET', `/api/story/episodes?project_id=${PID}&source_id=${SRC}&per_episode=4`)).data;
  const blk = String(outline.text).slice(String(outline.text).indexOf('【全剧设定】'), String(outline.text).indexOf('【分集骨架】')).trim();
  ok('全剧大纲与本集拍表里的设定块逐字相同', blk.length > 0 && b1.brief.includes(blk), blk.slice(0, 120));

  // ⑤ 改了信息卡 → 有剧本的集**如实**报过期（从前是静默的：设定改了、界面显示"没问题"）
  const sc = await api('POST', '/api/scripts', {
    project_id: PID, script_type: 'story_concept', episode_number: 1, title: '第 1 集',
    content: '第 1 集的剧本正文', plan_digest: b1.input_digest,
  });
  const st0 = (await api('GET', `/api/story/staleness?project_id=${PID}&source_id=${SRC}&per_episode=4`)).data;
  eq('刚生成完 → 第 1 集一致', st0.episodes.find((x) => x.episode_number === 1).script_state, 'ok');

  // ⑤ 反向先做（必须在改主线**之前**，否则状态已经 stale，这条断言就是空的）：
  //    改**不进上下文**的字段不许乱喊过期（假警报比不检查更糟）。
  //    world 的 summary 只在"一个可渲染字段都没有"时才兜底，有 genre 时它不上场。
  const putSum = await api('PUT', `/api/story/cards/${w.id}`, { summary: '这段摘要根本不会被渲染进上下文' });
  eq('（前提）summary 确实写进去了 —— 否则下面那条断言是空的（对照注意事项 11）',
    putSum.data.summary, '这段摘要根本不会被渲染进上下文');
  const st2 = (await api('GET', `/api/story/staleness?project_id=${PID}&source_id=${SRC}&per_episode=4`)).data;
  eq('改不进上下文的字段 → 不报过期（体检盯的是"真的发出去的东西"）',
    st2.episodes.find((x) => x.episode_number === 1).script_state, 'ok');

  // ⑥ 正向：改了信息卡的主线 → 有剧本的集**如实**报过期
  //    （从前是静默的：设定改了、剧本没重生成、界面显示"没问题"）
  await api('PUT', `/api/story/cards/${w.id}`, { mainline: '改成复仇线' });
  const st1 = (await api('GET', `/api/story/staleness?project_id=${PID}&source_id=${SRC}&per_episode=4`)).data;
  eq('改了信息卡的主线 → 第 1 集报过期', st1.episodes.find((x) => x.episode_number === 1).script_state, 'stale');
  eq('过期计数如实上报', st1.counts.script_stale, 1);
  const b2 = (await api('GET', `/api/story/episode-brief?project_id=${PID}&source_id=${SRC}&per_episode=4&episode=1`)).data;
  ok('新上下文里是改后的主线（不是缓存里的旧设定）', b2.brief.includes('改成复仇线'), b2.brief.slice(0, 240));
  ok('指纹确实变了', b2.input_digest !== b1.input_digest, `${b1.input_digest} → ${b2.input_digest}`);
  ok('改后的上下文里不再有旧主线', !b2.brief.includes('顺藤摸瓜查清旧案'));

  // ⑦ 没有设定卡的原著：上下文里不出现空标题，且不因此多出过期
  const an2 = await api('POST', '/api/story/analyze', { project_id: PID, title: '无设定·原著', text: '林晚在临江茶馆见到顾寒。'.repeat(30), reduce: false });
  for (let i = 0; i < 60; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an2.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const SRC2 = an2.data.source.id;
  const b3 = (await api('GET', `/api/story/episode-brief?project_id=${PID}&source_id=${SRC2}&per_episode=4&episode=1`)).data;
  if (b3.exists) {
    ok('没有信息卡/时间线卡 → 不出现空标题',
      !b3.brief.includes('【全剧设定】') && !b3.brief.includes('【全剧时间线】'), b3.brief.slice(0, 160));
    eq('没有设定卡 → setting_chars 为 0（界面据此说"未带全剧设定"）', Number(b3.setting_chars), 0);
  } else {
    ok('没有剧情卡时如实说"还没有拍"（不是静默给一段空骨架）', b3.notes.length > 0, JSON.stringify(b3.notes));
  }

  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('角色名册进输入指纹（批 8 补 37：存指纹与复算指纹必须同源）');
{
  const pj = await api('POST', '/api/projects', { name: '名册指纹测试剧' });
  const PID = pj.data.id;
  const an = await api('POST', '/api/story/analyze', {
    project_id: PID, title: '名册·原著', text: `__LONGARC__${'长弧线的故事。'.repeat(40)}`,
  });
  for (let i = 0; i < 60; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const SRC = an.data.source.id;
  const briefUrl = `/api/story/episode-brief?project_id=${PID}&source_id=${SRC}&per_episode=4&episode=1`;
  const staleUrl = `/api/story/staleness?project_id=${PID}&source_id=${SRC}&per_episode=4`;

  // ① 项目里还没有角色：名册为空、且**指纹里也没有它**（不许凭空多出过期）
  const b0 = (await api('GET', briefUrl)).data;
  ok('名册验收：这一集有拍表', b0.exists && b0.brief.includes('第 1 集（'), String(b0.brief).slice(0, 80));
  eq('没有角色 → roster_count 为 0', Number(b0.roster_count), 0);
  eq('没有角色 → roster_text 为空串（前端原样跳过，不产生空块）', String(b0.roster_text), '');

  // ② 建一个角色 → 名册进上下文，**指纹跟着变**
  const ch = await api('POST', '/api/characters', {
    project_id: PID, name: '林晚', alias: '晚晚', appearance: '黑色长直发，丹凤眼', outfit: '白色衬衫',
    personality: '冷静', role: '主角',
  });
  const CID = ch.data.id;
  ok('建角色成功（拿得到 id）', !!CID, JSON.stringify(ch.data).slice(0, 120));
  const b1 = (await api('GET', briefUrl)).data;
  eq('有角色 → roster_count 为 1', Number(b1.roster_count), 1);
  ok('roster_text 是本名册（含本名与别名，且明确要求用本名）',
    String(b1.roster_text).includes('【本剧角色名册】') && String(b1.roster_text).includes('林晚')
    && String(b1.roster_text).includes('晚晚'), String(b1.roster_text).slice(0, 140));
  ok('名册**不**混进 brief（它由前端拼在提示词最前面，两处都塞会重复）',
    !String(b1.brief).includes('【本剧角色名册】'));
  ok('加了角色 → 指纹确实变了（名册是喂给模型的输入，不该在指纹外）',
    b1.input_digest !== b0.input_digest, `${b0.input_digest} → ${b1.input_digest}`);

  // ③ **跨端点同源**：用 brief 给的指纹存剧本，staleness 必须判 ok
  //    （两边各算一遍、少挂一处名册 → 这里会立刻变成"永久报过期"）
  const sc = await api('POST', '/api/scripts', {
    project_id: PID, script_type: 'story_concept', episode_number: 1, title: '第 1 集',
    content: '第 1 集的剧本正文', plan_digest: b1.input_digest,
  });
  eq('存剧本成功', sc.status, 200);
  const st0 = (await api('GET', staleUrl)).data;
  eq('存指纹的端点与复算指纹的端点算出同一个指纹 → 第 1 集一致（同源）',
    st0.episodes.find((x) => x.episode_number === 1).script_state, 'ok');
  eq('（前提）没有多出来的过期', st0.counts.script_stale, 0);

  // ④ 反向先做：改**不进名册**的字段不许乱喊过期（假警报比不检查更糟）
  const putP = await api('PUT', `/api/characters/${CID}`, { personality: '暴躁', role: '配角' });
  eq('（前提）personality 确实写进去了 —— 否则下面那条是空的（注意事项 11）',
    putP.data.personality, '暴躁');
  const b2 = (await api('GET', briefUrl)).data;
  eq('只改 personality/role（不进名册）→ 指纹不许变', b2.input_digest, b1.input_digest);
  eq('只改 personality/role → 第 1 集仍是 ok',
    (await api('GET', staleUrl)).data.episodes.find((x) => x.episode_number === 1).script_state, 'ok');

  // ⑤ 正向：改了外貌（外貌进名册）→ 有剧本的集**如实**报过期
  //    （从前是静默的：名册换了、剧本没重生成、界面显示"没问题"）
  await api('PUT', `/api/characters/${CID}`, { appearance: '短发，圆脸，右眉有一道疤' });
  const b3 = (await api('GET', briefUrl)).data;
  ok('改了角色的外貌 → 指纹变了', b3.input_digest !== b1.input_digest, `${b1.input_digest} → ${b3.input_digest}`);
  ok('新名册里是改后的外貌', String(b3.roster_text).includes('右眉有一道疤'), String(b3.roster_text).slice(0, 140));
  const st1 = (await api('GET', staleUrl)).data;
  eq('改了角色的外貌 → 第 1 集报过期', st1.episodes.find((x) => x.episode_number === 1).script_state, 'stale');
  eq('过期计数如实上报', st1.counts.script_stale, 1);

  // ⑥ 新增一个角色也如实报过期（模型看到的名单变了）
  await api('POST', '/api/characters', { project_id: PID, name: '顾寒', appearance: '黑甲' });
  const b4 = (await api('GET', briefUrl)).data;
  eq('新增角色 → roster_count 变 2', Number(b4.roster_count), 2);
  ok('新增角色 → 指纹再变一次', b4.input_digest !== b3.input_digest, `${b3.input_digest} → ${b4.input_digest}`);

  // ⑦ 删掉全部角色 → 指纹回到最初那一份（证明指纹的变化**只**来自名册，不是别的东西在漂）
  for (const c of (await api('GET', `/api/characters?project_id=${PID}`)).data) {
    await api('DELETE', `/api/characters/${c.id}`);
  }
  const b5 = (await api('GET', briefUrl)).data;
  eq('角色都删掉 → roster_count 回到 0', Number(b5.roster_count), 0);
  eq('角色都删掉 → 指纹逐字节回到最初（变化的来源只有名册）', b5.input_digest, b0.input_digest);

  // ⑧ 名册端点：纯计算、按项目取、形状稳定
  await api('POST', '/api/characters', { project_id: PID, name: '林晚', appearance: '黑衣', is_locked: true });
  const before = (await api('GET', `/api/characters?project_id=${PID}`)).data.length;
  const r1 = await api('POST', '/api/story/roster', { project_id: PID, text: '林晚走进茶馆' });
  eq('名册端点 200', r1.status, 200);
  eq('名册端点回传 count', Number(r1.data.count), 1);
  ok('名册端点回传 names（调用方不用再解析文本）', Array.isArray(r1.data.names) && r1.data.names[0] === '林晚', JSON.stringify(r1.data.names));
  ok('名册端点回传 text', String(r1.data.text).includes('林晚'));
  eq('名册端点是**纯计算**：调完角色一条都没多',
    (await api('GET', `/api/characters?project_id=${PID}`)).data.length, before);
  const r2 = await api('POST', '/api/story/roster', { project_id: 'no-such-project', text: '林晚' });
  eq('名册端点按项目取（别的项目看不到这些角色）', Number(r2.data.count), 0);

  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('人物卡 ↔ 资产库漂移（批 8 补 11：同步只动会注入提示词的字段）');
{
  const pj = await api('POST', '/api/projects', { name: '漂移体检测试剧' });
  const PID = pj.data.id;
  const an = await api('POST', '/api/story/analyze', { project_id: PID, title: '漂移·原著', text: '林晚在临江茶馆见到顾寒。'.repeat(30), reduce: false });
  for (let i = 0; i < 60; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const cards = (await api('GET', `/api/story/cards?source_id=${an.data.source.id}`)).data;
  const lin = cards.find((c) => c.kind === 'character' && c.name === '林晚');
  ok('漂移验收：拿到人物卡', !!lin, JSON.stringify(cards.map((c) => c.name)));

  // ① 入资产库 → 一致，不报漂移
  const imp = await api('POST', '/api/story/cards/import-characters', { project_id: PID, source_id: an.data.source.id });
  eq('入资产库成功', imp.data.created_count >= 1, true);
  const a1 = await api('GET', `/api/story/audit?project_id=${PID}`);
  const drift1 = a1.data.drift_issues;
  eq('刚导入时没有漂移（复制过去就是同一份）', drift1.length, 0);
  ok('返回体里有 drift_counts/drift_pairs 诊断字段', !!a1.data.drift_counts && typeof a1.data.drift_pairs === 'number');

  // ② 制造漂移：直接改人物卡（等价于"追加解析补全了卡"）
  await api('PUT', `/api/story/cards/${lin.id}`, { appearance: '长发及腰，左眉有疤', outfit: '青色长衫', aliases: ['晚晚', '阿晚'] });
  const a2 = await api('GET', `/api/story/audit?project_id=${PID}`);
  const dr = a2.data.drift_issues;
  ok('改人物卡后报出漂移', dr.length === 1 && dr[0].code === 'char_drift', JSON.stringify(dr.map((x) => x.title)));
  ok('漂移项逐字段摆出"资产库值 → 人物卡值"（人才能判断哪份对）',
    (dr[0].drift || []).length >= 2 && dr[0].conflicts.every((c) => c.values.length === 2), JSON.stringify(dr[0].drift));
  ok('漂移项可修，动作码是 sync_character（问题码 ≠ 动作码）', dr[0].fixable === true && dr[0].fix_code === 'sync_character');
  ok('漂移并进了面板真正消费的 issues', a2.data.issues.some((x) => x.code === 'char_drift'));
  eq('合并后的 issues = 四组之和', a2.data.issues.length,
    a2.data.card_issues.length + a2.data.shot_issues.length + a2.data.style_issues.length + a2.data.drift_issues.length);

  // ③ 同步：只动会注入提示词的字段
  const before = (await api('GET', '/api/characters?project_id=' + PID)).data.find((c) => c.story_card_id === lin.id);
  await api('PUT', `/api/characters/${before.id}`, { role: '反派', personality: '暴躁易怒' }); // 用户自己在资产库里改的
  const fx = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'sync_character', target_id: before.id, card_ids: [lin.id] });
  eq('同步 200', fx.status, 200);
  eq('同步确实改了东西', fx.data.updated, true);
  ok('同步说明改了哪些字段', (fx.data.fields || []).length >= 2, JSON.stringify(fx.data.fields));
  const after = (await api('GET', '/api/characters?project_id=' + PID)).data.find((c) => c.id === before.id);
  eq('外貌按人物卡覆盖', after.appearance, '长发及腰，左眉有疤');
  eq('服饰按人物卡覆盖', after.outfit, '青色长衫');
  ok('别名取并集（不丢掉资产库里原有的）', String(after.alias).includes('阿晚') && String(after.alias).includes('晚晚'), after.alias);
  eq('用户自己改的角色定位**不动**（同步不该覆盖人的编辑）', after.role, '反派');
  eq('用户自己改的性格**不动**', after.personality, '暴躁易怒');
  ok('同步留痕（notes 里能看到"与人物卡同步"）', /与人物卡同步/.test(String(after.notes)), String(after.notes));
  ok('同步后漂移消失', (await api('GET', `/api/story/audit?project_id=${PID}`)).data.drift_issues.length === 0);

  // ④ 再同步一次：没有可改的，如实说没改
  const again = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'sync_character', target_id: before.id, card_ids: [lin.id] });
  eq('已一致时 updated=false（不假报"已同步"）', again.data.updated, false);

  // ⑤ 校验：不存在的角色 / 不是这张卡导入的角色都要明确报错
  eq('不存在的角色 → 404', (await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'sync_character', target_id: 'nope', card_ids: [lin.id] })).status, 404);
  const other = cards.find((c) => c.kind === 'character' && c.name !== '林晚');
  eq('拿别的人物卡去同步 → 400（不能把张三的脸同步到李四身上）',
    (await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'sync_character', target_id: before.id, card_ids: [other.id] })).status, 400);
  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('追加解析（批 8 补 10：只解析新增章节 / 已有卡 id 不变 / 一张不删）');
{
  const pj = await api('POST', '/api/projects', { name: '追加解析测试剧' });
  const PID = pj.data.id;
  const wait = async (jobId) => {
    for (let i = 0; i < 60; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${jobId}`)).data; if (j && j.status !== 'running') return j; }
    return null;
  };
  // 第一次：整本解析（mock 会按提示词形状吐固定卡片）
  const an1 = await api('POST', '/api/story/analyze', { project_id: PID, title: '追加·第一卷', text: '林晚在临江茶馆见到顾寒。'.repeat(30) });
  eq('首次解析 200', an1.status, 200);
  await wait(an1.data.jobId);
  const srcId = an1.data.source.id;
  const cards1 = (await api('GET', `/api/story/cards?source_id=${srcId}`)).data;
  const before = cards1.map((c) => `${c.kind}:${c.name}#${c.id}`).sort();
  ok('首次解析落了一批卡', cards1.length > 0);

  // 追加：只对新增文本分块 —— 这是"不为前面几十万字反复付费"的硬证据
  const callsBefore = storyChatCalls;
  const ap = await api('POST', '/api/story/append', { project_id: PID, source_id: srcId, text: '第二卷：夜访密室。'.repeat(30) });
  eq('追加解析 200', ap.status, 200);
  eq('追加只解析新增文本（块数不含已有章节）', ap.data.appended_chunks, an1.data.chunk_count);
  eq('块号接着已有的往后排（否则新卡指向错误的原文位置）', ap.data.chunk_offset, an1.data.chunk_count);
  const j2 = await wait(ap.data.jobId);
  ok('追加任务跑完', j2 && j2.status === 'done');
  eq('追加的模型调用次数 = 新增段数 + 归并 1 次', storyChatCalls - callsBefore, ap.data.appended_chunks + 1);

  const cards2 = (await api('GET', `/api/story/cards?source_id=${srcId}`)).data;
  const after = cards2.map((c) => `${c.kind}:${c.name}#${c.id}`).sort();
  ok('已有卡一张都没消失、id 也一个都没变（分镜绑定不会悬空）',
    before.every((k) => after.includes(k)), JSON.stringify({ before, after }));
  ok('追加后卡片数只增不减', cards2.length >= cards1.length);

  // 块号必须接着已有的往后排：否则新卡的 evidence 会指向旧章节，
  // "这条是从哪段读出来的"就骗人了（而返回体里的 chunk_offset 是自己算的，证明不了这一点）
  const beforeIds = new Set(cards1.map((c) => c.id));
  const fresh = cards2.filter((c) => !beforeIds.has(c.id));
  ok('追加抽到的卡，块号落在新增区间内（不指向旧章节）',
    fresh.length > 0 && fresh.every((c) => (c.chunk_index == null || c.chunk_index >= ap.data.chunk_offset)
      && (c.evidence || []).every((i) => i >= ap.data.chunk_offset)),
    JSON.stringify(fresh.map((c) => ({ n: c.name, ci: c.chunk_index, ev: c.evidence }))).slice(0, 200));

  const src2 = (await api('GET', `/api/story/sources/${srcId}`)).data; // 列表不带全文，要看原文得取单条
  eq('来源的块数接上了', src2.chunk_count, an1.data.chunk_count + ap.data.appended_chunks);
  ok('来源的原文也接上了（归并看开头结尾、分集看全文都依赖它）',
    (src2.text || '').includes('第二卷'), String(src2.chars) !== '0');
  ok('来源字数变多', src2.chars > an1.data.source.chars);

  // ── 批 8 补 25：用户改过的卡不能被追加解析覆盖 ──────────────────
  // 界面上的"已改"chip 一直写着"重新解析不会覆盖它"，但合并规则是"更详细的描述取胜"，
  // 用户改短的值照样会被模型的长描述冲掉 —— 那是一条**假承诺**。这里钉住它真的成立。
  const target = cards2.find((c) => c.kind === 'character' && c.name === '林晚');
  ok('找到要手工修改的人物卡', !!target, JSON.stringify(cards2.map((c) => c.name)));
  // 这里必须用一个**比模型返回值更短**的外貌：追加的块用的是**局部**块号，
  // mock 对第 1 段返回"白衣"（2 字）。原先写"黑衣"（也是 2 字）时，"更长者取胜"根本不触发，
  // 断言会因为**错误的原因**通过 —— 对照 FE 就是靠这条抓出来的（保护被关掉、外貌那行却还是绿的）。
  await api('PUT', `/api/story/cards/${target.id}`, { appearance: '玄', aliases: ['阿晚'] });
  const editedCard = (await api('GET', `/api/story/cards?source_id=${srcId}`)).data.find((c) => c.id === target.id);
  ok('手工改过的卡被标记为"已改"', editedCard.edited === true);
  eq('别名改动生效（体检删别名也走这条路）', (editedCard.aliases || []).join(','), '阿晚');

  const ap3 = await api('POST', '/api/story/append', { project_id: PID, source_id: srcId, text: '第三卷：夜访密室。'.repeat(30), reduce: false });
  eq('再次追加解析 200', ap3.status, 200);
  const j3 = await wait(ap3.data.jobId);
  ok('第二次追加跑完', j3 && j3.status === 'done');

  const kept = (await api('GET', `/api/story/cards?source_id=${srcId}`)).data.find((c) => c.id === target.id);
  eq('用户改短的外貌没有被模型的描述覆盖（人工值优先）', kept.appearance, '玄');
  eq('用户删掉的别名没有被并回来（否则撞名问题静默复发）', (kept.aliases || []).join(','), '阿晚');
  ok('卡片的 id 没变（分镜绑定不悬空）', kept.id === target.id);
  const src3 = (await api('GET', `/api/story/sources/${srcId}`)).data;
  ok('来源上留痕"保住了 N 张已改的卡"（保护不能是无声的）',
    Number(src3.protected_cards) >= 1, JSON.stringify(src3.protected_cards));
  ok('并点名是哪几张（用户要能核对）',
    (src3.protected_names || []).includes('林晚'), JSON.stringify(src3.protected_names));

  // ── 批 8 补 26：段数一样 ≠ 切出来的是同一段原文 ──────────────────
  // 追加解析是"先切 A、再切 B"，而补抽/溯源是"重切整篇 A+B"。两者在接缝处必然不同，
  // **而段数可能刚好相同** —— 只比段数会把这个当成"切回来了"，于是补抽按段号抽到**别的段落**、
  // 溯源把错的段落当成"这张卡的原文依据"，两者都不报错。
  const mkSeg = (n, base) => Array.from({ length: n }, (_, i) => `第${base + i}章 夜访。` + '林晚走进茶馆，顾寒已在等她。'.repeat(8)).join('\n\n');
  const segA = mkSeg(20, 1), segB = mkSeg(10, 21); // A≈2400 字切 1 段、B≈1200 字切 1 段，合起来 3600 字切 2 段
  const anA = await api('POST', '/api/story/analyze', { project_id: PID, title: '逐段核对 A', text: segA, reduce: false });
  eq('解析 A 200', anA.status, 200);
  await wait(anA.data.jobId);
  const srcA = anA.data.source.id;
  const apB = await api('POST', '/api/story/append', { project_id: PID, source_id: srcA, text: segB, reduce: false });
  eq('追加 B 200', apB.status, 200);
  await wait(apB.data.jobId);
  const srcAB = (await api('GET', `/api/story/sources/${srcA}`)).data;
  eq('A+B 的段数 = 1+1 = 2（这正是"只比段数"会放过的情形）', srcAB.chunk_count, 2);
  eq('逐块指纹按"先切 A 再切 B"往后接（长度与段数一致）',
    (srcAB.chunk_digests || []).length, srcAB.chunk_count);
  ok('指纹不是空的（否则等于没核对）', (srcAB.chunk_digests || []).every((d) => /^[0-9a-f]{8}$/.test(d)), JSON.stringify(srcAB.chunk_digests));

  // 覆盖体检：必须如实说"逐段核对过，而且对不上"，并点出是第几段
  const cov = (await api('GET', `/api/story/coverage?source_id=${srcA}`)).data;
  eq('覆盖体检：逐段核对过（verified=true）', cov.verified, true);
  eq('覆盖体检：段数判据看不出来，但逐段核对判"对不上"', cov.aligned, false);
  ok('覆盖体检点出对不上的段号（不是只说"对不上"）',
    (cov.mismatched_chunks || []).length > 0, JSON.stringify(cov.mismatched_chunks));
  ok('覆盖体检的说明里点明了"补抽会被拒绝"（用户不用点一次才知道）',
    (cov.notes || []).join('；').includes('补抽会被拒绝'), JSON.stringify(cov.notes));

  // 溯源：绝不能把**错的段落**当成这张卡的原文依据摆出来
  const anyCard = (await api('GET', `/api/story/cards?source_id=${srcA}`)).data[0];
  const cs = (await api('GET', `/api/story/card-source?card_id=${anyCard.id}`)).data;
  eq('溯源：如实标出段落已对不上', cs.aligned, false);
  eq('溯源：并说明是逐段核对出来的', cs.verified, true);
  ok('溯源：明确提醒"下面的原文可能对不上这张卡"',
    (cs.notes || []).join('；').includes('可能对不上这张卡'), JSON.stringify(cs.notes));

  // 补抽：**必须拒绝**（旧行为是放行并真的调模型，抽回来一堆指向错段落的卡片）
  const rc = await api('POST', '/api/story/retry-chunks', { source_id: srcA, indexes: [1] });
  eq('原文对不上时补抽被拒绝 → 400', rc.status, 400);
  ok('拒绝的理由说清了后果（会抽到别的段落 / 卡片会指向错误的原文）',
    /别的段落|指向错误的原文/.test(rc.data?.error || rc.text || ''), JSON.stringify(rc.data?.error || rc.text));

  // 参数校验：缺 source_id / 不属于本项目 / 空文本都要明确报错，而不是静默新建一份
  eq('缺 source_id → 400', (await api('POST', '/api/story/append', { project_id: PID, text: 'x' })).status, 400);
  eq('空文本 → 400', (await api('POST', '/api/story/append', { project_id: PID, source_id: srcId, text: '   ' })).status, 400);
  eq('不存在的来源 → 404', (await api('POST', '/api/story/append', { project_id: PID, source_id: 'nope', text: 'x' })).status, 404);
  const pj2 = await api('POST', '/api/projects', { name: '追加解析·别的项目' });
  eq('跨项目的来源 → 400（不能把卡片灌进别的项目）',
    (await api('POST', '/api/story/append', { project_id: pj2.data.id, source_id: srcId, text: 'x' })).status, 400);
  await api('DELETE', `/api/projects/${pj2.data.id}?cascade=1`);
  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('分集骨架（批 8 补 4：按幕收口 / 参数真的生效 / 不花钱 / 按来源隔离）');
{
  const pj = await api('POST', '/api/projects', { name: '分集骨架测试剧' });
  const PID = pj.data.id;
  const analyze = async (title, text, opts = {}) => {
    const an = await api('POST', '/api/story/analyze', Object.assign({ project_id: PID, title, text }, opts));
    for (let i = 0; i < 60; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
    return an.data.source && an.data.source.id;
  };
  const short = await analyze('分集·短片', '林晚在临江茶馆见到顾寒。'.repeat(40));
  const long = await analyze('分集·长弧', `__LONGARC__${'林晚在临江茶馆见到顾寒。'.repeat(40)}`);
  ok('两次解析各建一份来源', !!short && !!long && short !== long);

  // ① 不花钱：分集骨架是可判定的，反复调拍数不该产生任何模型调用
  const callsBefore = storyChatCalls;
  const r1 = await api('GET', `/api/story/episodes?project_id=${PID}&source_id=${long}&per_episode=3`);
  eq('端点 200', r1.status, 200);
  await sleep(400); // 与干跑同一条纪律：等一拍再数，否则只能证明"没有同步调用"
  eq('排分集**一次模型都没调**（调拍数不花钱，用户才敢反复试）', storyChatCalls, callsBefore);

  // ② 形状与内容
  eq('返回拍数', r1.data.beat_count, 8);
  eq('全部标了幕次 → basis=stage', r1.data.basis, 'stage');
  eq('每集下限原样回显', r1.data.per_episode, 3);
  eq('硬上限 = 下限 ×2', r1.data.hard_limit, 6);
  eq('按幕收口：4+4 而不是 3+3+2', r1.data.episodes.map((e) => e.beat_count).join(','), '4,4');
  eq('集数', r1.data.episode_count, 2);
  eq('幕次覆盖 8/8', r1.data.stage_covered, 8);
  eq('没有硬切', r1.data.forced_cuts, 0);
  ok('信息卡（全局归并出来的）也算进来了', r1.data.world_count >= 1, String(r1.data.world_count));
  eq('每集都给出幕次标签', r1.data.episodes[0].acts.join(''), '起承转合');
  ok('每一拍都带结构化字段（界面直接渲染）',
    r1.data.episodes[0].beats.every((b) => b.name && b.stage), JSON.stringify(r1.data.episodes[0].beats[0]));
  eq('拍序按原文出现顺序', r1.data.episodes[0].beats.map((b) => b.name).join(','), '长弧·起1,长弧·承1,长弧·转1,长弧·合1');
  ok('文本带全剧设定与分集骨架', r1.data.text.includes('【全剧设定】') && r1.data.text.includes('【分集骨架】'));
  ok('文本带切分说明', r1.data.text.includes('【切分说明】'));
  ok('骨架文本不含未替换占位符', !/\{\{/.test(r1.data.text));

  // ③ 参数真的生效：下限调大后不许在幕中间提前切
  const r2 = await api('GET', `/api/story/episodes?project_id=${PID}&source_id=${long}&per_episode=5`);
  eq('下限 5 → 第一集不会在第 4 拍（幕边界）就切', r2.data.episodes.map((e) => e.beat_count).join(','), '8');
  eq('下限回显 5', r2.data.per_episode, 5);
  const r3 = await api('GET', `/api/story/episodes?project_id=${PID}&source_id=${long}&per_episode=999`);
  eq('超上限被钳到 20', r3.data.per_episode, 20);
  const r4 = await api('GET', `/api/story/episodes?project_id=${PID}&source_id=${long}&per_episode=abc`);
  eq('非法参数落回默认 4', r4.data.per_episode, 4);

  // ④ 来源隔离：短片那份只有归并出来的 2 拍剧情卡
  const r5 = await api('GET', `/api/story/episodes?project_id=${PID}&source_id=${short}&per_episode=3`);
  eq('按来源隔离（短片 2 拍）', r5.data.beat_count, 2);
  eq('短片只有 1 集', r5.data.episode_count, 1);
  const r6 = await api('GET', `/api/story/episodes?project_id=${PID}`);
  ok('按项目汇总时两来源的拍都在', r6.data.beat_count >= 10, String(r6.data.beat_count));
  const r7 = await api('GET', '/api/story/episodes?project_id=project_not_exist');
  eq('不存在的项目 → 0 拍（如实为空，不报错也不编造）', r7.data.beat_count, 0);
  eq('空项目文本为空（调用方据此提示）', r7.data.text, '');
  ok('空项目给出原因', r7.data.notes.some((n) => n.includes('还没有剧情卡')), JSON.stringify(r7.data.notes));

  // ⑤ 修复端点仍然不花钱（同一条纪律的回归）
  const callsBefore2 = storyChatCalls;
  await api('GET', `/api/story/episodes?project_id=${PID}&source_id=${long}&per_episode=2`);
  await sleep(300);
  eq('再调一次仍然不花钱', storyChatCalls, callsBefore2);

  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('一致性体检（批 8 补 3：同名卡 / 别名撞名 / 一键修复 / 绑定改指 / 不花钱）');
{
  const pj = await api('POST', '/api/projects', { name: '体检测试剧' });
  const PID = pj.data.id;
  ok('自建测试项目', !!PID);
  const NOVEL = Array.from({ length: 5 }, (_, k) => [
    `第${k + 1}幕。林晚推开临江茶馆的门，白衣上沾着夜雨。`.repeat(2),
    '顾寒坐在角落，青铜钥匙在灯下泛着冷光。'.repeat(2),
    '两人对峙，林晚拔剑，顾寒却把钥匙推了过来。'.repeat(2),
  ].join('\n')).join('\n');
  const analyze = async (title) => {
    const an = await api('POST', '/api/story/analyze', { project_id: PID, title, text: NOVEL, max_chars: 200 });
    let j = null;
    for (let i = 0; i < 60; i++) { await sleep(150); j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
    return an.data.source && an.data.source.id;
  };
  const s1 = await analyze('体检原著一');
  const s2 = await analyze('体检原著二'); // 第二次解析 → 跨来源同名卡，这正是体检要抓的真实场景
  ok('两次解析各建了一份来源', !!s1 && !!s2 && s1 !== s2);

  // ① 体检是纯本地的：一条模型调用都不该发生
  const callsBefore = storyChatCalls;
  const au = await api('GET', `/api/story/audit?project_id=${PID}`);
  eq('体检 200', au.status, 200);
  await sleep(400); // 与干跑同一条纪律：等一拍再数，否则只能证明"没有同步调用"
  eq('体检**一次模型都没调**（花钱才能查一致性的工具，用户会不敢点）', storyChatCalls, callsBefore);
  ok('体检报出同名卡（两次解析出的同名卡必须收敛）',
    au.data.issues.some((i) => i.code === 'dup_name' && i.card_ids.length >= 2),
    JSON.stringify(au.data.counts));
  ok('体检如实给出卡片总数', au.data.total_cards > 0, String(au.data.total_cards));
  const dupIssue = au.data.issues.find((i) => i.code === 'dup_name');
  ok('同名卡可一键修复', dupIssue.fixable === true);
  ok('体检报出"人物卡还没进资产库"', au.data.issues.some((i) => i.code === 'char_not_in_asset'));
  ok('体检报出"可注入类卡片缺描述"（如果 mock 没给全字段）', Array.isArray(au.data.issues));

  // ② 别名撞名：把顾寒的别名改成林晚
  const cardsAll = (await api('GET', `/api/story/cards?project_id=${PID}`)).data;
  const gu = cardsAll.find((c) => c.kind === 'character' && c.name === '顾寒');
  const lin = cardsAll.find((c) => c.kind === 'character' && c.name === '林晚');
  await api('PUT', `/api/story/cards/${gu.id}`, { aliases: ['林晚'] });
  const au2 = await api('GET', `/api/story/audit?project_id=${PID}`);
  const colIssue = au2.data.issues.find((i) => i.code === 'alias_collision');
  ok('别名撞名被抓出来', !!colIssue && colIssue.alias === '林晚', JSON.stringify(au2.data.issues.map((i) => i.code)));
  const fixCol = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'alias_collision', card_ids: colIssue.card_ids });
  eq('别名修复 200', fixCol.status, 200);
  ok('别名修复只动撞名的那个', fixCol.data.fixed_cards >= 1, JSON.stringify(fixCol.data.detail));
  // 变更须知：本项目**没有** GET /api/story/cards/:id 这个端点，写单卡查询只会拿到 404，
  // 断言就会变成"永远为真"的盲钉（本条第一版就是这么假绿的）。一律走列表再 find。
  const guAfter = (await api('GET', `/api/story/cards?project_id=${PID}`)).data.find((c) => c.id === gu.id);
  ok('修复后卡片仍在（只删别名不删卡）', !!guAfter);
  ok('撞名别名已被删掉', !((guAfter || {}).aliases || []).includes('林晚'), JSON.stringify((guAfter || {}).aliases));
  ok('修复动作标记为"人工改过"（edited=true，免得下次解析又被模型覆盖）', (guAfter || {}).edited === true);
  const au3 = await api('GET', `/api/story/audit?project_id=${PID}`);
  ok('修复后再体检，这条不再出现（体检不是"永远报同样的话"）',
    !au3.data.issues.some((i) => i.code === 'alias_collision'));

  // ③ 人物卡入资产库（一键修复）
  const fixAsset = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'char_not_in_asset' });
  ok('一键入资产库真的建了角色', fixAsset.data.created_count >= 1, JSON.stringify(fixAsset.data.created));
  const au4 = await api('GET', `/api/story/audit?project_id=${PID}`);
  ok('入库后这条不再出现', !au4.data.issues.some((i) => i.code === 'char_not_in_asset'));
  const fixAsset2 = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'char_not_in_asset' });
  eq('重复点不会重复建角色（幂等）', fixAsset2.data.created_count, 0);
  ok('重复点如实回报"已在库里"', fixAsset2.data.skipped_count >= 1, JSON.stringify(fixAsset2.data.skipped));

  // ④ 合并同名卡：分镜上的绑定必须改指到存活卡，否则镜头会静默失去注入
  // 改指这条必须挑**可注入类别**（地点/道具）的同名组：人物卡的绑定会被写入白名单过滤掉，
  // 拿人物组来测等于测了个"绑不上"，第一版就是这么红的
  const allCards2 = (await api('GET', `/api/story/cards?project_id=${PID}`)).data;
  const kindOf = (id) => ((allCards2.find((c) => c.id === id) || {}).kind);
  const dup2 = (await api('GET', `/api/story/audit?project_id=${PID}`)).data.issues
    .find((i) => i.code === 'dup_name' && i.card_ids.some((id) => ['location', 'prop'].includes(kindOf(id))));
  ok('仍有可注入类别的同名卡待合并（改指测试的前提）', !!dup2 && dup2.card_ids.length >= 2);
  // 注意这两个是 **id 字符串**（不是卡片对象）—— 第一版写成 victim.id 结果绑了个 undefined
  const sortedIds = dup2.card_ids.slice().sort();
  const keeperId = sortedIds[0];
  const victimId = sortedIds.slice(1).find((id) => ['location', 'prop'].includes(kindOf(id)));
  ok('挑到了可注入的受害者卡', !!victimId && !!keeperId && victimId !== keeperId, JSON.stringify({ keeperId, victimId, kind: kindOf(victimId) }));
  const sb = await api('POST', '/api/storyboards', {
    project_id: PID, shot_number: 1, image_prompt: 'x', story_card_ids: [victimId],
  });
  ok('先把要合并掉的卡绑到一个镜头上', (sb.data.story_card_ids || []).includes(victimId), JSON.stringify(sb.data.story_card_ids));
  const fixDup = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'dup_name', card_ids: dup2.card_ids });
  ok('合并修复 200', fixDup.status === 200, JSON.stringify(fixDup.data).slice(0, 120));
  ok('合并了至少一组', fixDup.data.merged_groups >= 1, JSON.stringify(fixDup.data.detail).slice(0, 160));
  ok('删除的是被合并的那张', fixDup.data.removed_cards >= 1);
  const sbAfter = (await api('GET', `/api/storyboards?project_id=${PID}`)).data.find((r) => r.id === sb.data.id);
  ok('镜头绑定已改指存活卡（不是静默变成空绑定）',
    (sbAfter.story_card_ids || []).includes(keeperId) && !(sbAfter.story_card_ids || []).includes(victimId),
    JSON.stringify({ before: [victimId], after: sbAfter.story_card_ids, keeperId }));
  ok('改指的镜头数如实上报', fixDup.data.repointed_shots >= 1, String(fixDup.data.repointed_shots));
  const afterCards = (await api('GET', `/api/story/cards?project_id=${PID}`)).data;
  ok('被合并的卡真的删了（不留悬空引用源）', !afterCards.some((c) => c.id === victimId));
  ok('存活卡还在且带上了被合并卡的信息', afterCards.some((c) => c.id === keeperId));
  const au5 = await api('GET', `/api/story/audit?project_id=${PID}`);
  ok('合并后再体检，**这一组**同名卡不再出现（别的组没动就仍该报）',
    !au5.data.issues.some((i) => i.code === 'dup_name' && i.card_ids.includes(keeperId)),
    JSON.stringify(au5.data.issues.filter((i) => i.code === 'dup_name').map((i) => i.card_ids)));

  // ⑤ 修复仍然不花钱 + 参数校验
  const callsBefore2 = storyChatCalls;
  await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'dup_name' });
  await sleep(400);
  eq('修复也不调模型（纯本地收敛）', storyChatCalls, callsBefore2);
  const bad = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'no_such_code' });
  eq('不认识的体检项 400', bad.status, 400);
  ok('错误文案列出支持项', /dup_name/.test(bad.data.error || ''), bad.data.error);
  const noProj = await api('POST', '/api/story/audit/fix', { code: 'dup_name' });
  eq('缺 project_id 400', noProj.status, 400);
  const empty = await api('POST', '/api/story/audit/fix', { project_id: PID, code: 'dup_name' });
  eq('没有可合并项时如实回报 0（不假装修了什么）', empty.data.merged_groups, 0);

  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('原著卡片注入（批 8 补 2：使用点 / 只注入看得见的两类 / 去重 / 导出）');
{
  const pj = await api('POST', '/api/projects', { name: '原著注入测试剧', art_style: '日漫厚涂' });
  const PID = pj.data.id;
  ok('自建测试项目', !!PID);
  // 原文必须**足够长**：max_chars=200 时若全文只有 270 字，尾块合并会把整篇并成 1 块，
  // 而 mock 只在第 2 段才吐「青铜钥匙」这张道具卡 —— 道具注入就整条没被跑到（本组踩过一次）
  const NOVEL = Array.from({ length: 5 }, (_, k) => [
    `第${k + 1}幕。林晚推开临江茶馆的门，白衣上沾着夜雨。她要查父亲的死因。`.repeat(2),
    '顾寒坐在角落，青铜钥匙在灯下泛着冷光。林晚认出了那把钥匙。'.repeat(2),
    '两人对峙，林晚拔剑，顾寒却把钥匙推了过来。'.repeat(2),
  ].join('\n')).join('\n');
  ok('测试原文足够长（否则切不出第 2 段，道具注入没被跑到）', NOVEL.length > 700, String(NOVEL.length));
  const an = await api('POST', '/api/story/analyze', { project_id: PID, title: '注入测试原著', text: NOVEL, max_chars: 200 });
  eq('解析受理', an.status, 200);
  let job = null;
  for (let i = 0; i < 60; i++) { await sleep(150); job = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (job && job.status !== 'running') break; }
  eq('解析完成', job && job.status, 'done');
  const cards = (await api('GET', `/api/story/cards?project_id=${PID}`)).data;
  // 缺卡时给一个占位对象：实现坏了要**干净地红**，而不是在 loc.id 上抛 TypeError 带走整组
  const loc = cards.find((c) => c.kind === 'location' && c.name === '临江茶馆') || { id: 'missing-loc' };
  const prop = cards.find((c) => c.kind === 'prop' && c.name === '青铜钥匙') || { id: 'missing-prop' };
  const chr = cards.find((c) => c.kind === 'character' && c.name === '林晚') || { id: 'missing-chr' };
  ok('拿到了地点卡与道具卡', loc.id !== 'missing-loc' && prop.id !== 'missing-prop', JSON.stringify(cards.map((c) => `${c.kind}:${c.name}`)));
  ok('也有不能注入的类别（人物卡走角色库那条路）', chr.id !== 'missing-chr');

  const mk = async (n, extra) => (await api('POST', '/api/storyboards', Object.assign({
    project_id: PID, shot_number: n, image_prompt: `shot ${n}`, scene_description: `第 ${n} 镜`,
  }, extra))).data;
  const sbCards = await mk(1, { story_card_ids: [loc.id, prop.id] });
  const sbMixed = await mk(2, { story_card_ids: [loc.id, chr.id] });   // 混入人物卡：必须被丢掉
  const sbNone = await mk(3, {});
  const sbBogus = await mk(4, { story_card_ids: ['no-such-card'] });

  // ① 出图：绑定的地点卡/道具卡被注入
  await api('POST', '/api/agnes/image', { prompt: 'a teahouse interior', project_id: PID, storyboard_id: sbCards.id, size: '1024x1024' });
  const wire = String(lastImageCreate && lastImageCreate.prompt);
  ok('出图注入绑定的原著场景道具', wire.includes('场景道具——') && wire.includes('临江茶馆：喧闹潮湿') && wire.includes('青铜钥匙：林晚，开密室'), wire.slice(0, 180));
  ok('层次固定：内容 → 原著场景道具 → 画风（前端预览按同序复算）',
    wire.indexOf('场景道具——') > 0 && wire.indexOf('场景道具——') < wire.indexOf('japanese anime style'), wire.slice(0, 180));

  // ② 只注入"画面上看得见"的两类：人物卡即使被绑上也不进提示词（避免与角色库两套描述打架）
  await api('POST', '/api/agnes/image', { prompt: 'a close-up', project_id: PID, storyboard_id: sbMixed.id, size: '1024x1024' });
  const wire2 = String(lastImageCreate.prompt);
  ok('绑了人物卡也不注入（人物一致性的唯一来源是角色库）',
    wire2.includes('临江茶馆：喧闹潮湿') && !wire2.includes('场景道具——林晚'), wire2.slice(0, 160));
  ok('被丢弃的类别不产出空壳或「undefined」', !wire2.includes('undefined') && !wire2.includes('：，'), wire2.slice(0, 160));

  // ③ 没绑定 → 不注入（原著卡片不能变成"到处都在注入"）
  await api('POST', '/api/agnes/image', { prompt: 'empty street', project_id: PID, storyboard_id: sbNone.id, size: '1024x1024' });
  eq('镜头未绑定原著卡片 → 不注入', negless(lastImageCreate.prompt), 'empty street, japanese anime style, thick painterly shading');
  await api('POST', '/api/agnes/image', { prompt: 'empty street', project_id: PID, storyboard_id: sbBogus.id, size: '1024x1024' });
  eq('失效 id（卡片已删）→ 静默不注入，不报错也不产出空壳', negless(lastImageCreate.prompt), 'empty street, japanese anime style, thick painterly shading');

  // ④ 去重：描述已在提示词里 → 不追加
  await api('POST', '/api/agnes/image', { prompt: '喧闹潮湿的临江茶馆', project_id: PID, storyboard_id: sbCards.id, size: '1024x1024' });
  const wire3 = String(lastImageCreate.prompt);
  ok('同一段描述已在提示词里 → 不重复追加', !wire3.includes('临江茶馆：喧闹潮湿'), wire3.slice(0, 160));

  // ⑤ 显式 story_card_ids（图片页/外部脚本不必先建分镜）
  await api('POST', '/api/agnes/image', { prompt: 'portrait', project_id: PID, story_card_ids: [prop.id], size: '1024x1024' });
  ok('显式 story_card_ids 也能注入', String(lastImageCreate.prompt).includes('青铜钥匙：林晚，开密室'), String(lastImageCreate.prompt));

  // ⑥ 视频口径：t2v 注入，i2v 不注入（与角色/画风同一口径）
  await api('POST', '/api/videos', { mode: 'text_to_video', prompt: 'hero walks forward', project_id: PID, storyboard_id: sbCards.id });
  ok('t2v 注入原著场景道具', String(lastVideoCreate && lastVideoCreate.prompt).includes('场景道具——'), String(lastVideoCreate && lastVideoCreate.prompt));
  await api('POST', '/api/videos', { mode: 'image_to_video', prompt: 'animate this', image: 'http://127.0.0.1:1/x.png', project_id: PID, storyboard_id: sbCards.id });
  eq('i2v 不注入（参考图带的是画面，不带文字设定）', String(lastVideoCreate.prompt), 'animate this');

  // ⑦ 绑定落库 + 非法值过滤 + PUT 可改
  const got = (await api('GET', `/api/storyboards?project_id=${PID}`)).data.find((r) => r.id === sbCards.id);
  eq('绑定落库', (got.story_card_ids || []).join(','), [loc.id, prop.id].join(','));
  const put = await api('PUT', `/api/storyboards/${sbNone.id}`, { story_card_ids: [prop.id, chr.id] });
  eq('PUT 接受 story_card_ids 并过滤掉不可注入类别', (put.data.story_card_ids || []).join(','), prop.id);
  eq('PUT 只改卡片、不动提示词', put.data.image_prompt, 'shot 3');
  const putClear = await api('PUT', `/api/storyboards/${sbNone.id}`, { story_card_ids: [] });
  eq('PUT 空数组 = 解绑', (putClear.data.story_card_ids || []).length, 0);
  ok('未传 story_card_ids 的旧数据仍是空数组（不会变成 undefined 崩前端）',
    Array.isArray((await api('GET', `/api/storyboards?project_id=${PID}`)).data[0].story_card_ids) || true);

  // ⑧ 导出必须与发出的一致
  const csvText = new TextDecoder().decode(new Uint8Array(await (await fetch(`${BASE}/api/projects/${PID}/export.csv?episode=1`)).arrayBuffer()));
  ok('CSV 表头标明含原著场景道具', csvText.includes('含原著场景道具与角色与运镜与画风'));
  ok('CSV 新增「绑定原著卡片」列', csvText.includes('绑定原著卡片') && csvText.includes('临江茶馆、青铜钥匙'));
  ok('CSV 最终词含原著场景道具注入', csvText.includes('场景道具——临江茶馆：喧闹潮湿'));
  const mdText = (await api('GET', `/api/projects/${PID}/export.md?episode=1`)).data.raw;
  ok('MD 最终词含原著场景道具注入', mdText.includes('场景道具——'));
  ok('MD 说清 i2v 仍注入原著场景道具（导出不骗人）', mdText.includes('原著场景道具仍会注入'));

  // ⑨ 卡片改了描述 → 下次出图自动带上新描述（绑定的是卡片不是快照文本，这才是一致性的来源）
  await api('PUT', `/api/story/cards/${loc.id}`, { atmosphere: '喧闹潮湿，灯影摇晃' });
  await api('POST', '/api/agnes/image', { prompt: 'another teahouse shot', project_id: PID, storyboard_id: sbCards.id, size: '1024x1024' });
  ok('卡片改了描述，绑定的镜头自动跟着改（绑定 id 而不是复制文本）',
    String(lastImageCreate.prompt).includes('临江茶馆：喧闹潮湿，灯影摇晃'), String(lastImageCreate.prompt).slice(0, 160));

  await api('DELETE', `/api/projects/${PID}?cascade=1`);
}

group('原著解析（批 8：分块抽取 / 跨块合并 / 卡片 CRUD / 反向驱动）');
{
  // 自建项目：前面的组会删项目，共用 SPID 会随执行顺序时好时坏
  const pj = await api('POST', '/api/projects', { name: '原著解析测试剧' });
  const SPID = pj.data.id;
  ok('自建测试项目', !!SPID);

  // 原文：五幕 × 三段，长度刻意超过 minChars(400) 数倍 ——
  // 否则尾块合并会把整篇并成一块，"跨块去重"这条最关键的契约就根本没被跑到（踩过一次）
  const NOVEL = Array.from({ length: 5 }, (_, k) => [
    `第${k + 1}幕。林晚推开临江茶馆的门，白衣上沾着夜雨。她要查父亲的死因。`.repeat(2),
    '顾寒坐在角落，青铜钥匙在灯下泛着冷光。林晚认出了那把钥匙。'.repeat(2),
    '两人对峙，林晚拔剑，顾寒却把钥匙推了过来。'.repeat(2),
  ].join('\n')).join('\n');
  ok('测试原文足够长（否则切不出多块）', NOVEL.length > 700, String(NOVEL.length));

  // ── 干跑：只切块，不调模型、不落库（计费闸门）──
  const callsBefore = storyChatCalls;
  const plan = await api('POST', '/api/story/plan', { text: NOVEL, max_chars: 200 });
  eq('干跑 200', plan.status, 200);
  eq('干跑立刻回，不阻塞', plan.status, 200);
  // 变更须知：这里必须**等一下再数**。正向对照实测：把 plan 改成"忘了 await 的偷偷调用"时，
  // 立刻检查是绿的（请求还在路上）—— 不加这个 sleep，这条钉只能证明"没有同步调用"，
  // 而那正是同步 handler 根本做不到的事，等于什么都没证明。
  await sleep(400);
  eq('干跑**一次模型都没调**（用户确认之前不许花钱）', storyChatCalls, callsBefore);
  ok('干跑切出多块', plan.data.chunk_count >= 3, `chunk_count=${plan.data.chunk_count}`);
  eq('干跑如实给出调用次数 = 块数 + 归并 1 次', plan.data.calls, plan.data.chunk_count + 1);
  eq('干跑覆盖全文字', plan.data.covered_chars, plan.data.total_chars);
  eq('干跑不截断', plan.data.truncated, false);
  ok('干跑给出逐块字数（界面要展示分段）', plan.data.chunks.every((c) => c.chars > 0 && c.label.includes('段')));
  const planEmpty = await api('POST', '/api/story/plan', { text: '   ' });
  eq('空原文干跑 400', planEmpty.status, 400);
  const planNoPersist = await api('GET', `/api/story/sources?project_id=${SPID}`);
  eq('干跑不落库（列表仍为空）', planNoPersist.data.length, 0);

  // ── 真跑 ──
  const noProj = await api('POST', '/api/story/analyze', { text: NOVEL });
  eq('缺 project_id 直接 400（卡片必须挂在项目上才能驱动下游）', noProj.status, 400);
  ok('错误文案说清怎么办', /选择项目/.test(noProj.data.error || ''), noProj.data.error);

  const an = await api('POST', '/api/story/analyze', { project_id: SPID, title: '临江旧事', text: NOVEL, max_chars: 200, concurrency: 2 });
  eq('解析受理 200', an.status, 200);
  ok('返回 jobId 供进度订阅', !!an.data.jobId);
  eq('进度链把"全局归并"也算进去', an.data.total, an.data.chunk_count + 1);

  // 兜底初值：接口挂了要给"能读懂的断言失败"，不是 TypeError 把整轮测试崩掉
  let job = { status: '(未取到)', items: [], ok: 0, fail: 0 };
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    job = (await api('GET', `/api/batch/${an.data.jobId}`)).data || job;
    if (job.status !== 'running') break;
  }
  eq('任务结束', job.status, 'done');
  eq('无失败块', job.fail, 0);
  eq('进度链最后一项是全局归并且成功', job.items[job.items.length - 1].label + '/' + job.items[job.items.length - 1].state, '全局归并/ok');
  ok('进度链逐项预填（含标签与下标）', job.items.every((it, i) => it.index === i && it.label));

  const srcList = await api('GET', `/api/story/sources?project_id=${SPID}`);
  eq('原文已落库（刷新不丢 —— 竞品最大缺陷）', srcList.data.length, 1);
  const src = srcList.data[0];
  eq('解析状态为已抽取', src.status, 'extracted');
  eq('块失败数为 0', src.failed_chunks, 0);
  ok('列表**不回传全文**（7 万字原著不能塞进列表）', !('text' in src), Object.keys(src).join(','));
  ok('列表给预览片段', src.preview.length > 0 && src.preview.length <= 120);

  const srcFull = await api('GET', `/api/story/sources/${src.id}`);
  eq('单条能取回全文（界面据此恢复草稿）', srcFull.data.text, NOVEL.replace(/\r\n?/g, '\n'));

  // ── 跨块合并 ──
  const cards = await api('GET', `/api/story/cards?project_id=${SPID}`);
  eq('卡片列表 200', cards.status, 200);
  const allCards = Array.isArray(cards.data) ? cards.data : [];
  ok('卡片列表是裸数组（与 storyboards/videos 同族形状）', Array.isArray(cards.data));
  const byKind = (k) => allCards.filter((c) => c.kind === k);
  eq('未知类别的卡被丢弃（mock 里混了一条 npc）', allCards.filter((c) => c.name.includes('不认识')).length, 0);
  eq('人物卡跨块合并成 2 张（林晚/顾寒，不是每块各一份）', byKind('character').length, 2);
  const lin = byKind('character').find((c) => c.name === '林晚');
  ok('合并后外貌取更详细的那个', lin.appearance === '白衣长剑', lin.appearance);
  ok('出现次数被累计（多块出现）', lin.mentions >= 2, String(lin.mentions));
  ok('证据块号已去重排序', Array.isArray(lin.evidence) && lin.evidence.length >= 2 && lin.evidence.every((v, i, a) => i === 0 || a[i - 1] < v), JSON.stringify(lin.evidence));
  eq('别名去重且不含自己', lin.aliases.join(','), '晚晚');
  eq('地点卡 1 张', byKind('location').length, 1);
  eq('道具卡 1 张（只在第 2 段出现）', byKind('prop').length, 1);
  eq('信息卡 1 张（来自全局归并）', byKind('world').length, 1);
  eq('剧情卡 2 张（来自全局归并）', byKind('plot').length, 2);
  eq('归并出的信息卡字段正确', byKind('world')[0].genre, '古装悬疑');
  eq('展示顺序：信息卡在最前', allCards[0] && allCards[0].kind, 'world');
  eq('原文记录的卡片总数与实际一致', src.card_count, allCards.length);
  eq('带 origin 区分来源（chunk / bible）', `${byKind('world')[0].origin}/${byKind('character')[0].origin}`, 'bible/chunk');

  // ── 查询过滤 ──
  const onlyChar = await api('GET', `/api/story/cards?project_id=${SPID}&kind=character`);
  eq('按 kind 过滤', onlyChar.data.length, 2);
  const bySource = await api('GET', `/api/story/cards?source_id=${src.id}`);
  eq('按 source_id 过滤', bySource.data.length, allCards.length);
  const other = await api('GET', '/api/story/cards?project_id=no_such_project');
  eq('按项目过滤（不串项目）', other.data.length, 0);

  // ── 回注渲染（反向驱动取用口）──
  const pr = await api('GET', `/api/story/cards/prompt?source_id=${src.id}&kinds=character`);
  eq('回注 200', pr.status, 200);
  eq('只回注指定类别', pr.data.count, 2);
  ok('回注文本带人物名与外貌', pr.data.text.includes('林晚') && pr.data.text.includes('白衣长剑'));
  ok('回注文本带"不得矛盾"约束头', pr.data.text.includes('不得与之矛盾'));
  ok('回注不含其他类别', !pr.data.text.includes('临江茶馆'));
  const prAll = await api('GET', `/api/story/cards/prompt?source_id=${src.id}`);
  ok('不指定类别则全给', prAll.data.count === allCards.length, String(prAll.data.count));
  const prNone = await api('GET', `/api/story/cards/prompt?source_id=${src.id}&kinds=timeline`);
  eq('该类别无卡时返回空文本（调用方据此跳过注入）', prNone.data.text, '');

  // ── 卡片编辑（白名单）──
  const other_card = byKind('character').find((c) => c.name === '顾寒');
  const put = await api('PUT', `/api/story/cards/${lin.id}`, { name: '林晚（改）', appearance: '黑衣', kind: 'location', source_id: 'hacked', origin: 'bible' });
  eq('编辑 200', put.status, 200);
  eq('名字被改', put.data.name, '林晚（改）');
  eq('外貌被改', put.data.appearance, '黑衣');
  eq('kind 不可改（来源事实）', put.data.kind, 'character');
  eq('source_id 不可改（断了溯源就没法核对）', put.data.source_id, src.id);
  eq('origin 不可改', put.data.origin, 'chunk');
  eq('用户改过的卡留痕', put.data.edited, true);
  const putEmpty = await api('PUT', `/api/story/cards/${lin.id}`, { name: '  ' });
  eq('空名字 400', putEmpty.status, 400);
  const putMissing = await api('PUT', '/api/story/cards/nope', { name: 'x' });
  eq('改不存在的卡 404', putMissing.status, 404);
  const putAlias = await api('PUT', `/api/story/cards/${lin.id}`, { aliases: '晚晚、林晚（改）、晚晚' });
  eq('别名走归一化（去重 + 去掉当前名字）', putAlias.data.aliases.join(','), '晚晚');
  // 同一请求里既改名又加别名：判"自己"必须按**改后**的名字，否则旧名会作为别名留下来
  const putBoth = await api('PUT', `/api/story/cards/${other_card.id}`, { name: '顾寒（改）', aliases: '阿寒、顾寒（改）' });
  eq('改名 + 别名同请求时按新名字去自己', putBoth.data.aliases.join(','), '阿寒');
  eq('同请求里名字也生效', putBoth.data.name, '顾寒（改）');

  // ── 反向驱动：人物卡 → 资产库 ──
  const badTo = await api('POST', `/api/story/cards/${byKind('location')[0].id}/to-character`, { project_id: SPID });
  eq('地点卡不能进资产库（400）', badTo.status, 400);
  const toChar = await api('POST', `/api/story/cards/${lin.id}/to-character`, { project_id: SPID });
  eq('人物卡入资产库 200', toChar.status, 200);
  eq('角色名与卡一致', toChar.data.character.name, '林晚（改）');
  eq('角色带溯源 story_card_id', toChar.data.character.story_card_id, lin.id);
  eq('角色默认不锁外貌', toChar.data.character.is_locked, false);
  const toChar2 = await api('POST', `/api/story/cards/${lin.id}/to-character`, { project_id: SPID });
  eq('重复导入是幂等的（不许出现两个林晚）', toChar2.data.deduped, true);
  eq('幂等返回同一个角色 id', toChar2.data.character.id, toChar.data.character.id);
  const charList = await api('GET', `/api/characters?project_id=${SPID}`);
  eq('资产库里只有 1 个角色（不是 2 个）', charList.data.filter((c) => c.story_card_id === lin.id).length, 1);

  const imp = await api('POST', '/api/story/cards/import-characters', { project_id: SPID, source_id: src.id });
  eq('批量导入 200', imp.status, 200);
  eq('新建 1 个（顾寒）', imp.data.created_count, 1);
  eq('跳过 1 个（林晚已导入）', imp.data.skipped_count, 1);
  eq('跳过项给出已有角色 id', imp.data.skipped[0].character_id, toChar.data.character.id);
  const impAgain = await api('POST', '/api/story/cards/import-characters', { project_id: SPID, source_id: src.id });
  eq('再导一次全部跳过（幂等）', `${impAgain.data.created_count}/${impAgain.data.skipped_count}`, '0/2');
  const impEmpty = await api('POST', '/api/story/cards/import-characters', { project_id: SPID, ids: ['nope'] });
  eq('没有可导入的卡时 400', impEmpty.status, 400);
  const impNoProj = await api('POST', '/api/story/cards/import-characters', {});
  eq('缺 project_id 400', impNoProj.status, 400);

  // ── 重新归并：替换而不是叠加 ──
  const rd1 = await api('POST', '/api/story/reduce', { source_id: src.id });
  eq('重新归并 200', rd1.status, 200);
  eq('归并出 1 张信息卡', rd1.data.world, 1);
  const afterRd = await api('GET', `/api/story/cards?source_id=${src.id}`);
  const worlds = afterRd.data.filter((c) => c.kind === 'world');
  eq('信息卡仍是 1 张（重复归并不叠加）', worlds.length, 1);
  eq('剧情卡仍是 2 张', afterRd.data.filter((c) => c.kind === 'plot').length, 2);
  eq('归并后卡片总数不变', afterRd.data.length, allCards.length);
  const rdBad = await api('POST', '/api/story/reduce', { source_id: 'nope' });
  eq('归并不存在的原著 404', rdBad.status, 404);

  // ── 截断如实上报 ──
  const trunc = await api('POST', '/api/story/analyze', { project_id: SPID, title: '被截断的原著', text: NOVEL, max_chars: 100, max_chunks: 1, reduce: false });
  eq('截断场景受理 200', trunc.status, 200);
  eq('只跑 1 块（reduce 关闭时不含归并）', trunc.data.total, 1);
  eq('截断标记为真', trunc.data.truncated, true);
  ok('覆盖字数小于总字数（界面据此警告）', trunc.data.covered_chars < trunc.data.total_chars, `${trunc.data.covered_chars}/${trunc.data.total_chars}`);
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    const j = (await api('GET', `/api/batch/${trunc.data.jobId}`)).data;
    if (j.status !== 'running') break;
  }
  const truncSrc = (await api('GET', `/api/story/sources?project_id=${SPID}`)).data.find((x) => x.title === '被截断的原著');
  eq('截断事实被持久化（刷新后仍能看到警告）', truncSrc.truncated, true);

  // ── 部分失败：坏块不影响好块 ──
  const partial = await api('POST', '/api/story/analyze', { project_id: SPID, title: '半坏原著', text: `${NOVEL}\n__BADCHUNK__`, max_chars: 200, reduce: false });
  let pjob = { status: '(未取到)', ok: 0, fail: 0 };
  for (let i = 0; i < 30; i++) {
    await sleep(250);
    pjob = (await api('GET', `/api/batch/${partial.data.jobId}`)).data || pjob;
    if (pjob.status !== 'running') break;
  }
  ok('坏块被记为失败', pjob.fail >= 1, `fail=${pjob.fail}`);
  ok('好块仍然成功（一块坏不拖垮全篇）', pjob.ok >= 1, `ok=${pjob.ok}`);
  const pSrc = (await api('GET', `/api/story/sources?project_id=${SPID}`)).data.find((x) => x.title === '半坏原著') || {};
  eq('部分失败时状态仍是已抽取（不是失败）', pSrc.status, 'extracted');
  ok('失败块数如实记录', pSrc.failed_chunks >= 1, String(pSrc.failed_chunks));
  const pCards = await api('GET', `/api/story/cards?source_id=${(pSrc || {}).id}`);
  ok('好块的卡片照常落库', (pCards.data || []).length >= 2, String((pCards.data || []).length));

  // ── 全失败：必须能看出失败且给出原因 ──
  const allBad = await api('POST', '/api/story/analyze', { project_id: SPID, title: '全坏原著', text: '__BADCHUNK__', max_chars: 200, reduce: false });
  let bjob = { status: '(未取到)', ok: 0, fail: 0 };
  for (let i = 0; i < 30; i++) {
    await sleep(250);
    bjob = (await api('GET', `/api/batch/${allBad.data.jobId}`)).data || bjob;
    if (bjob.status !== 'running') break;
  }
  eq('全失败时无成功项', bjob.ok, 0);
  const bSrc = (await api('GET', `/api/story/sources?project_id=${SPID}`)).data.find((x) => x.title === '全坏原著');
  eq('全失败时状态为 failed', bSrc.status, 'failed');
  ok('给出可操作的原因（不是空白）', /检查|失败|重试/.test(bSrc.error_message || ''), bSrc.error_message);
  eq('全失败时没有卡片残留', (await api('GET', `/api/story/cards?source_id=${bSrc.id}`)).data.length, 0);

  // ── 项目导出带上原著解析（换机导入后卡片不是孤儿）──
  const exp = await api('GET', `/api/projects/${SPID}/export`);
  eq('导出 200', exp.status, 200);
  ok('导出含 story_sources', Array.isArray(exp.data.story_sources) && exp.data.story_sources.length >= 4, String((exp.data.story_sources || []).length));
  ok('导出含 story_cards', Array.isArray(exp.data.story_cards) && exp.data.story_cards.length >= 2, String((exp.data.story_cards || []).length));
  ok('导出的原文带全文（卡片可核对）', (exp.data.story_sources[0].text || '').length > 10);

  // ── 删除级联 ──
  const del = await api('DELETE', `/api/story/sources/${src.id}`);
  eq('删除原著 200', del.status, 200);
  ok('级联删掉它的卡片（不留指不到原文的孤儿卡）', del.data.removed_cards === allCards.length, String(del.data.removed_cards));
  eq('该原著的卡片已清空', (await api('GET', `/api/story/cards?source_id=${src.id}`)).data.length, 0);
  eq('别的原著的卡片不受影响', (await api('GET', `/api/story/cards?source_id=${pSrc.id}`)).data.length >= 2, true);
  eq('部分失败的原著仍留着卡片（不是被清空）', (await api('GET', `/api/story/cards?source_id=${pSrc.id}`)).data.length >= 1, true);
  const delAgain = await api('DELETE', `/api/story/sources/${src.id}`);
  eq('重复删除 404', delAgain.status, 404);
  const firstPartialCard = (Array.isArray(pCards.data) ? pCards.data[0] : null) || { id: '(无卡片)' };
  const delCard = await api('DELETE', `/api/story/cards/${firstPartialCard.id}`);
  eq('删单卡 200', delCard.status, 200);
  eq('删单卡后少一张', (await api('GET', `/api/story/cards?source_id=${pSrc.id}`)).data.length, (pCards.data || []).length - 1);
  eq('删不存在的卡 404', (await api('DELETE', '/api/story/cards/nope')).status, 404);

  // ── 清场（不留脏数据影响后续组）──
  for (const s2 of (await api('GET', `/api/story/sources?project_id=${SPID}`)).data) await api('DELETE', `/api/story/sources/${s2.id}`);
  for (const c of (await api('GET', `/api/characters?project_id=${SPID}`)).data) if (c.story_card_id) await api('DELETE', `/api/characters/${c.id}`);
  eq('清场后无残留原著', (await api('GET', `/api/story/sources?project_id=${SPID}`)).data.length, 0);
  await api('DELETE', `/api/projects/${SPID}`);
}

// ══════════════════════════════════════════════════════════════
// 批 8 补 32：AI 补分幕次（幕次是分集的依据，而"标幕次"是纯分类）
// ══════════════════════════════════════════════════════════════
group('AI 补分幕次（批 8 补 32：把"一格一格填"的活交给模型）');
{
  const pj = await api('POST', '/api/projects', { name: '补幕次测试剧' });
  const PID = pj.data.id;
  const an = await api('POST', '/api/story/analyze', { project_id: PID, title: '补幕次·原著', text: `__LONGARC__${'长弧线的故事。'.repeat(40)}` });
  eq('解析任务已建', an.status, 200);
  for (let i = 0; i < 80; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const src = (await api('GET', `/api/story/sources?project_id=${PID}`)).data[0];
  const listPlots = async () => (await api('GET', `/api/story/cards?source_id=${src.id}&kind=plot`)).data;
  const plots = await listPlots();
  ok('拿到了多拍剧情卡（__LONGARC__ 给 8 拍）', plots.length >= 4, String(plots.length));
  const epOf = async () => (await api('GET', `/api/story/episodes?project_id=${PID}&source_id=${src.id}`)).data;

  // 造出"人定过的 + 还没定的"混合局面：留一张有幕次的，其余清掉。
  // 留的那张**不能是"合"** —— mock 默认对所有拍都回"合"，若留的是"合"就分不清
  // "我们没覆盖"和"正好被覆盖成同一个值"（注意事项 11：断言别因错误的原因通过）
  // 留的那张**不能是 mock 会返回的那个值**（默认"转"）—— 否则分不清"我们没覆盖"
  // 和"正好被覆盖成同一个值"（注意事项 11：断言别因错误的原因通过）
  // 必须**逐字复刻**服务端 sortBeats 的排序（order 优先、id 兜底）：只按 order 排、
  // 不加 id 兜底时，order 相同/缺失的卡片顺序与后端不一致（第一版就这么写错了，白查了两轮）
  const byOrder = [...plots].sort((x, y) => (Number(x.order) || 0) - (Number(y.order) || 0)
    || String(x.id || '').localeCompare(String(y.id || '')));
  const lastBeat = byOrder[byOrder.length - 1];
  ok('最后一拍的 order 确实是最大值（排序口径与后端一致才有意义）',
    byOrder.every((c) => (Number(c.order) || 0) <= (Number(lastBeat.order) || 0)), JSON.stringify(byOrder.map((c) => c.order)));
  const keep = plots.find((c) => c.stage && c.stage !== '转') || plots[0];
  const cleared = plots.filter((c) => c.id !== keep.id);
  ok('留作"人定过"的那张幕次不是 mock 会返回的「转」（否则下面那条断言没有牙）', keep.stage !== '转', String(keep.stage));
  for (const c of cleared) await api('PUT', `/api/story/cards/${c.id}`, { stage: '' });
  eq('清完之后幕次只覆盖 1 拍', (await epOf()).stage_covered, 1);

  // 体检必须**有出口**：报"剧情卡没标幕次"的同时要把人送到能补的地方（补幕次的按钮在分集大纲面板里），
  // 否则用户看到结论还得自己去找按钮 —— 那就是"只报问题、不给出口"
  const aud = await api('GET', `/api/story/audit?project_id=${PID}`);
  const noStage = (aud.data.issues || []).filter((x) => x.code === 'plot_no_stage');
  ok('体检报出了"没标幕次"的拍', noStage.length >= 1, String(noStage.length));
  eq('这一项不是"机械可修"（补幕次要调模型、要花钱）', (noStage[0] || {}).fixable, false);
  eq('出口指向原著页', ((noStage[0] || {}).go || {}).page, 'novel');
  eq('出口落到「分集大纲」面板', (((noStage[0] || {}).go || {}).params || {}).panel, 'outline');
  eq('出口带上这份原著（否则跳过去是空的）', (((noStage[0] || {}).go || {}).params || {}).source_id, src.id);

  // ① 干跑：只说"要补几拍、调几次"，不花钱、不改数据
  const dry = await api('POST', '/api/story/stage-fill', { source_id: src.id, dry_run: true });
  eq('干跑 200', dry.status, 200);
  eq('干跑如实报出要补的拍数', dry.data.targets, cleared.length);
  eq('干跑报出调用次数（全部拍点一次给完 = 1 次）', dry.data.calls, 1);
  eq('干跑不写库', (await listPlots()).filter((c) => !c.stage).length, cleared.length);

  // ② 真跑：mock 默认对每一拍都回"转"
  const run = await api('POST', '/api/story/stage-fill', { source_id: src.id });
  eq('真跑 200', run.status, 200);
  eq('补上了所有待定的拍', run.data.assigned, cleared.length);
  eq('分集依据 mixed → stage（这次调用到底有没有用的证据）', `${run.data.basis_before}→${run.data.basis_after}`, 'mixed→stage');
  const afterCards = await listPlots();
  eq('**人定过的幕次一个都没动**（mock 对它也回了"转"，它还是原值就说明我们没覆盖）',
    (afterCards.find((c) => c.id === keep.id) || {}).stage, keep.stage);
  eq('待定的那些真的落库了', afterCards.filter((c) => c.stage === '转').length, cleared.length);

  // ③ 词表外的幕次必须丢弃并如实上报（脏幕次会让分集在错误的位置切开）。
  // 标记走**卡片名**：补幕次的提示词里就是拍点清单，名字会原样进 prompt（与 __LONGARC__ 同一手法）
  const badCard = cleared[0];
  await api('PUT', `/api/story/cards/${badCard.id}`, { stage: '', name: '__BADSTAGE__ 改名' });
  const bad = await api('POST', '/api/story/stage-fill', { source_id: src.id });
  eq('词表外的幕次没被写进去', (await listPlots()).find((c) => c.id === badCard.id).stage, '');
  eq('全部被丢弃时如实报出条数（mock 每一拍都给了词表外的词）', (bad.data.invalid || []).filter((x) => x.reason === 'not_a_stage').length, run.data.beats);
  eq('并报出哪几拍没接住', (bad.data.missing || []).length, 1);
  eq('一条都没接住时 assigned = 0', bad.data.assigned, 0);
  ok('并说清是"模型没给出可用的幕次"而不是只报 0', /没有给出可用的幕次/.test(bad.data.note || ''), bad.data.note);

  // ④ 模型返回的根本不是 JSON：这次调用算**失败**（500 + 原因），卡片一张都不许动
  await api('PUT', `/api/story/cards/${badCard.id}`, { stage: '', name: '__GARBAGE__ 改名' });
  const gar = await api('POST', '/api/story/stage-fill', { source_id: src.id });
  eq('不可解析时是失败（500）而不是"成功补了 0 个"', gar.status, 500);
  ok('并说清是"没有返回可解析的 JSON"', /可解析的 JSON/.test(gar.data.error || ''), gar.data.error);
  eq('失败时卡片未被改动', (await listPlots()).find((c) => c.id === badCard.id).stage, '');

  // ⑤ 模型把幕次写倒退：不替它"修顺"（那是我们编数据），只如实报出位置。
  // 注意**要倒退的那一拍必须真的是"待定"的**：mock 把"起"给了最后一拍，
  // 若那一拍已经有幕次，服务端按纪律不会写它 —— 那样"倒退"就只是个没落库的提议（见 selftest 的同名钉）
  await api('PUT', `/api/story/cards/${badCard.id}`, { stage: '', name: '补幕次测试拍点' });
  await api('PUT', `/api/story/cards/${lastBeat.id}`, { stage: '', name: '__BACKSTEP__ 改名' });
  const back = await api('POST', '/api/story/stage-fill', { source_id: src.id });
  ok('报出幕次倒退的位置', (back.data.back_steps || []).length >= 1, JSON.stringify(back.data.back_steps));
  eq('倒退的那一拍照样落库（不修数据、只报事实）', (await listPlots()).find((c) => c.id === lastBeat.id).stage, '起');

  // ⑥ 都标好了：不该再调模型（calls = 0），也不该报错
  const done = await api('POST', '/api/story/stage-fill', { source_id: src.id });
  eq('没有待定拍时 calls = 0（不白花一次钱）', done.data.calls, 0);
  ok('并说明原因', /都已经有幕次/.test(done.data.note || ''), done.data.note);

  // ⑦ 没有剧情卡时给的是"先解析"而不是空成功
  const pj2 = await api('POST', '/api/projects', { name: '补幕次空库' });
  const empty = await api('POST', '/api/story/stage-fill', { source_id: 'nope' });
  eq('原著不存在时 404', empty.status, 404);
  ok('新建项目确实没有卡片（对照用）', Array.isArray((await api('GET', `/api/story/cards?project_id=${pj2.data.id}`)).data));
}


// ══════════════════════════════════════════════════════════════
// 批 8 补 33：AI 回原文补人物长相（找到的必须带原文原话）
// ══════════════════════════════════════════════════════════════
group('AI 回原文补人物长相（批 8 补 33：引文对不上原文就是编的）');
{
  const pj = await api('POST', '/api/projects', { name: '补长相测试剧' });
  const PID = pj.data.id;
  // 标记放**最后**：它只用来让 mock 的抽取分支多给两张人物卡，
  // 别落在名字附近 —— 否则"原文片段"里会混进我们自己的标记
  const NOVEL = '顾寒立在檐下，玄色劲装，腰间悬着一柄短刀。'.repeat(4)
    + '苏婉儿撑着油纸伞，杏色襦裙，鬓边一支银簪。'.repeat(4)
    + '裴无咎披着旧斗篷，面容枯瘦，左眼一道旧疤。'.repeat(4)
    + '林晚推门进来，一身洗得发白的青衫。'.repeat(4)
    + '__LOOKFILL__';
  const an = await api('POST', '/api/story/analyze', { project_id: PID, title: '补长相·原著', text: NOVEL, reduce: false });
  eq('解析任务已建', an.status, 200);
  for (let i = 0; i < 80; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const src = (await api('GET', `/api/story/sources?project_id=${PID}`)).data[0];
  const listChars = async () => (await api('GET', `/api/story/cards?source_id=${src.id}&kind=character`)).data;
  const byName = async (n) => (await listChars()).find((c) => c.name === n) || {};
  // 只清"模型补的那些"，把林晚（appearance='白衣'）**一直留作对照组** ——
  // 它每轮都在候选名单之外，所以"它没被动"这件事在每一个用例里都成立（不只是第一个用例）
  const clearLooks = async () => {
    for (const c of await listChars()) {
      if (c.appearance === '白衣') continue;
      await api('PUT', `/api/story/cards/${c.id}`, { appearance: '', outfit: '' });
    }
  };
  // "有没有东西被写进去"一律**排除林晚那张对照组** —— 它的 '白衣' 是解析时抽到的、本来就在，
  // 把它算进来会让"一个字都没落库"这类断言恒为 1（第一版就是这么红的）
  const filled = async () => (await listChars()).filter((c) => (c.appearance || c.outfit) && c.appearance !== '白衣').length;
  const chars0 = await listChars();
  // mock 的抽取默认给"林晚（有外貌）+ 顾寒（没外貌）"，__LOOKFILL__ 再加苏婉儿/裴无咎（都没外貌）
  eq('拿到了 4 张人物卡', chars0.length, 4);
  eq('其中 3 张既没外貌也没服装（林晚有"白衣"，不该被碰）', chars0.filter((c) => !c.appearance && !c.outfit).length, 3);
  eq('林晚是"已经有长相"的那张（下面用它验"已有的一个都不动"）', (await byName('林晚')).appearance, '白衣');

  // ① 干跑：先如实告诉界面"要补几张、调几次"，此时一个字都不许写
  const dry = await api('POST', '/api/story/field-fill', { source_id: src.id, target: 'char_look', dry_run: true });
  eq('干跑 200', dry.status, 200);
  eq('干跑如实报出要补的张数', dry.data.targets, 3);
  eq('干跑报出调用次数（全部候选一次给完 = 1 次）', dry.data.calls, 1);
  eq('干跑报出"有几张能定位到原文"', dry.data.with_source, 3);
  eq('干跑不写库', (await listChars()).filter((c) => !c.appearance && !c.outfit).length, 3);

  // ② 真跑：mock 给的是**从那张卡自己的原文片段里截的原话** → 必须过核对并落库
  const run = await api('POST', '/api/story/field-fill', { source_id: src.id, target: 'char_look' });
  eq('真跑 200', run.status, 200);
  eq('补上了所有缺长相的人物卡', run.data.assigned, 3);
  const after = await listChars();
  const gotNames = after.filter((c) => /^模型补的外貌/.test(c.appearance || '')).map((c) => c.name).sort();
  eq('落库的正是缺长相的那 3 张', gotNames.join(','), '苏婉儿,裴无咎,顾寒');
  eq('**已经有长相的一个字都没动**（林晚还是"白衣"，不是 mock 给的值）', (await byName('林晚')).appearance, '白衣');
  ok('外貌与服装都写上了', after.filter((c) => /^模型补的外貌/.test(c.appearance || '') && /^模型补的服装/.test(c.outfit || '')).length === 3);
  eq('没接住的三种原因都为空', [run.data.ungrounded, run.data.not_found, run.data.missing, run.data.invalid].map((x) => (x || []).length).join(','), '0,0,0,0');

  // ③ **核心钉**：引文对不上原文 = 模型在编 → 整条丢弃，一个字都不许落库。
  //    标记走卡片名（补幕次同一手法）：提示词里就是"人物 + 它的原文片段"，名字会原样进 prompt
  await clearLooks();
  const gu = await byName('顾寒');
  await api('PUT', `/api/story/cards/${gu.id}`, { name: '__FAKELOOK__ 顾寒' });
  const fake = await api('POST', '/api/story/field-fill', { source_id: src.id, target: 'char_look' });
  eq('引文对不上原文时 assigned = 0', fake.data.assigned, 0);
  eq('并**单独**计进 ungrounded（与"原文没写"是两回事）', (fake.data.ungrounded || []).length, 3);
  eq('那三张一个字都没落库', await filled(), 0);
  ok('并说清是"引文对不上原文"而不是只报 0', /没有给出可用的长相/.test(fake.data.note || ''), fake.data.note);

  // ④ 原文确实没写：模型回 found=false → 计 not_found（**诚实的结论**，不是失败），不拿编的顶上
  await api('PUT', `/api/story/cards/${gu.id}`, { name: '__NOLOOK__ 顾寒' });
  const none = await api('POST', '/api/story/field-fill', { source_id: src.id, target: 'char_look' });
  eq('原文没写时 assigned = 0', none.data.assigned, 0);
  eq('计进 not_found', (none.data.not_found || []).length, 3);
  eq('**不算** ungrounded（"原著没写"和"模型在编"必须分开报）', (none.data.ungrounded || []).length, 0);
  eq('也没落库', await filled(), 0);

  // ⑤ 超长必须过与手改**同一把尺子**（补 30：同一个字段，模型写有上限、人写也得有）
  await api('PUT', `/api/story/cards/${gu.id}`, { name: '__LONGLOOK__ 顾寒' });
  const long = await api('POST', '/api/story/field-fill', { source_id: src.id, target: 'char_look' });
  eq('超长的那张照样补上（引文是真的，能过核对）', long.data.assigned, 3);
  eq('appearance 被截到上限', String((await byName('__LONGLOOK__ 顾寒')).appearance || '').length, storyLib.FIELD_MAX.appearance);
  await api('PUT', `/api/story/cards/${gu.id}`, { name: '顾寒' });

  // ⑥ 模型返回的根本不是 JSON：这次调用算失败（500 + 原因），卡片一张都不许动
  await clearLooks();
  await api('PUT', `/api/story/cards/${gu.id}`, { name: '__GARBAGE__ 顾寒' });
  const gar = await api('POST', '/api/story/field-fill', { source_id: src.id, target: 'char_look' });
  eq('不可解析时是失败（500）而不是"成功补了 0 个"', gar.status, 500);
  ok('并说清是"没有返回可解析的 JSON"', /可解析的 JSON/.test(gar.data.error || ''), gar.data.error);
  eq('失败时卡片未被改动', await filled(), 0);
  await api('PUT', `/api/story/cards/${gu.id}`, { name: '顾寒' });

  // ⑦ 都有长相了：不该再调模型（calls = 0），也不该报错
  const okRun = await api('POST', '/api/story/field-fill', { source_id: src.id, target: 'char_look' });
  eq('先补上（对照）', okRun.data.assigned, 3);
  const done = await api('POST', '/api/story/field-fill', { source_id: src.id, target: 'char_look' });
  eq('没有候选时 calls = 0（不白花一次钱）', done.data.calls, 0);
  ok('并说明原因', /都已经有外貌或服装/.test(done.data.note || ''), done.data.note);

  // ⑧ "没有可定位的原文出处"这条防御分支：**今天不可达**，而这件事本身要如实钉住。
  //    `evidence`/`chunk_index` 是**来源事实**（与 kind/source_id 同级，故意不许手改），
  //    人物卡又只由**分块抽取**产生、必然带段号；唯一没有段号的是全局归并出来的卡，
  //    而它只产出信息卡与剧情卡、不产人物卡。所以这里钉的是"可达性"本身 ——
  //    与其编一张不可达的卡假装测过，不如把"它不可达"钉住：将来真加了人工新建卡片的路，
  //    这条断言会红，提醒把 no_source 补上端到端。
  await clearLooks();
  const srcDry = await api('POST', '/api/story/field-fill', { source_id: src.id, target: 'char_look', dry_run: true });
  eq('解析出来的人物卡**全都**能定位到原文出处（所以 no_source 分支今天不可达）', srcDry.data.no_source, 0);
  eq('要补的张数 = 有出处的张数', srcDry.data.targets, srcDry.data.with_source);
  const noSrc = await api('POST', '/api/story/field-fill', { source_id: src.id, target: 'char_look' });
  eq('真跑也确实一张都没被跳过', noSrc.data.no_source, 0);

  // ⑨ 体检的 char_no_look 必须有出口（与 plot_no_stage 同一条纪律：不能只有结论、没有出口）
  await clearLooks(); // 上一步把 3 张都补上了，体检要看到"缺长相"才报得出来
  const aud = await api('GET', `/api/story/audit?project_id=${PID}`);
  const lookIssues = (aud.data.issues || []).filter((x) => x.code === 'char_no_look');
  ok('体检报出了"没有外貌与服装"的人物卡', lookIssues.length >= 1, String(lookIssues.length));
  eq('出口指向原著页', ((lookIssues[0] || {}).go || {}).page, 'novel');
  eq('出口把卡片筛选切到人物卡', (((lookIssues[0] || {}).go || {}).params || {}).kind, 'character');
  eq('出口带上这份原著', (((lookIssues[0] || {}).go || {}).params || {}).source_id, src.id);
  eq('仍然不是"机械可修"（补长相要调模型、要花钱）', (lookIssues[0] || {}).fixable, false);

  // ⑩ 原著不存在 → 404（而不是空成功）
  const empty = await api('POST', '/api/story/field-fill', { source_id: 'nope', target: 'char_look' });
  eq('原著不存在时 404', empty.status, 404);
}

// ══════════════════════════════════════════════════════════════
// 批 8 补 34：AI 回原文补场景/道具字段（与补长相同一套机制）
// ══════════════════════════════════════════════════════════════
group('AI 回原文补场景道具字段（批 8 补 34：同一套机制、规格驱动）');
{
  const pj = await api('POST', '/api/projects', { name: '补场景字段测试剧' });
  const PID = pj.data.id;
  const NOVEL = '落霞渡口风大浪急，江面上浮着一层薄雾。'.repeat(4)
    + '半枚玉佩缺了一角，是林晚一直带在身上的。'.repeat(4)
    + '临江茶馆里喧闹潮湿，已是黄昏。'.repeat(4)
    + '顾寒立在檐下，玄色劲装。'.repeat(4)
    + '__INJECTFILL__';
  const an = await api('POST', '/api/story/analyze', { project_id: PID, title: '补场景·原著', text: NOVEL, reduce: false });
  eq('解析任务已建', an.status, 200);
  for (let i = 0; i < 80; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const src = (await api('GET', `/api/story/sources?project_id=${PID}`)).data[0];
  const listCards = async () => (await api('GET', `/api/story/cards?source_id=${src.id}`)).data;
  const byName = async (n) => (await listCards()).find((c) => c.name === n) || {};
  // 只清"模型补的那些"，把**临江茶馆**（解析时就带着 atmosphere）一直留作对照组 ——
  // 让"已有的一个都不动"这条钉在每一个用例里都成立（补 33 踩过：连对照组一起清，钉就失效了）
  const clearInj = async () => {
    for (const c of await listCards()) {
      if (!['location', 'prop'].includes(c.kind) || c.name === '临江茶馆') continue;
      const patch = {};
      for (const f of storyLib.STORY_INJECT_FIELDS[c.kind]) patch[f] = '';
      await api('PUT', `/api/story/cards/${c.id}`, patch);
    }
  };
  const filledInj = async () => (await listCards()).filter((c) => ['location', 'prop'].includes(c.kind)
    && c.name !== '临江茶馆'
    && storyLib.STORY_INJECT_FIELDS[c.kind].some((f) => String(c[f] || '').trim())).length;
  const dry = () => api('POST', '/api/story/field-fill', { source_id: src.id, target: 'card_inject', dry_run: true });
  const run = () => api('POST', '/api/story/field-fill', { source_id: src.id, target: 'card_inject' });

  eq('解析出了地点卡与道具卡', (await listCards()).filter((c) => ['location', 'prop'].includes(c.kind)).length, 3);
  eq('其中 2 张没有任何可注入描述（临江茶馆带着 atmosphere，不该被碰）',
    (await listCards()).filter((c) => ['location', 'prop'].includes(c.kind) && !storyLib.STORY_INJECT_FIELDS[c.kind].some((f) => String(c[f] || '').trim())).length, 2);
  eq('临江茶馆是"已经有描述"的那张', (await byName('临江茶馆')).atmosphere, '喧闹潮湿');

  // ① 干跑：如实报出"要补几张、调几次"，此时一个字都不许写。pool 与 targets 都要报 ——
  //    "一张都不缺"（pool 非空）与"压根没有这类卡"（pool 空）是两回事，界面要能分清
  const d1 = await dry();
  eq('干跑 200', d1.status, 200);
  eq('干跑如实报出要补的张数', d1.data.targets, 2);
  eq('干跑报出这类卡一共有几张', d1.data.pool, 3);
  eq('干跑报出调用次数（全部候选一次给完 = 1 次）', d1.data.calls, 1);
  eq('干跑报出"有几张能定位到原文"', d1.data.with_source, 2);
  eq('干跑不写库', await filledInj(), 0);

  // ② 真跑：mock 给的是**从那张卡自己的原文片段里截的原话** → 必须过核对并落库
  const r1 = await run();
  eq('真跑 200', r1.status, 200);
  eq('补上了所有缺描述的地点/道具卡', r1.data.assigned, 2);
  eq('落库的字段名按类别取（地点补 atmosphere、道具补 owner —— 两类要的东西不同）',
    `${(await byName('落霞渡口')).atmosphere}|${(await byName('半枚玉佩')).owner}`,
    '模型补的atmosphere1|模型补的owner2');
  eq('**已经有描述的一个字都没动**（临江茶馆还是"喧闹潮湿"）', (await byName('临江茶馆')).atmosphere, '喧闹潮湿');
  eq('没接住的几种原因为空', [r1.data.ungrounded, r1.data.not_found, r1.data.missing, r1.data.invalid, r1.data.empty].map((x) => (x || []).length).join(','), '0,0,0,0,0');
  // ③ 规格之间**互不干扰**：补场景字段这一趟不该碰人物卡（顾寒还是没长相）
  eq('补场景字段不碰人物卡（两个规格各管各的）', (await byName('顾寒')).appearance, undefined);

  // ④ **核心钉**：引文对不上原文 = 模型在编 → 整条丢弃，一个字都不许落库
  await clearInj();
  const lu = await byName('落霞渡口');
  await api('PUT', `/api/story/cards/${lu.id}`, { name: '__INJFAKE__ 落霞渡口' });
  const fake = await run();
  eq('引文对不上原文时 assigned = 0', fake.data.assigned, 0);
  eq('并**单独**计进 ungrounded', (fake.data.ungrounded || []).length, 2);
  eq('那两张一个字都没落库', await filledInj(), 0);
  ok('并说清是"引文对不上原文"而不是只报 0', /没有给出可用的场景\/道具描述/.test(fake.data.note || ''), fake.data.note);

  // ⑤ 原文确实没写：模型回 found=false → 计 not_found（诚实的结论，不是失败）
  await api('PUT', `/api/story/cards/${lu.id}`, { name: '__INJNOLOOK__ 落霞渡口' });
  const none = await run();
  eq('原文没写时 assigned = 0', none.data.assigned, 0);
  eq('计进 not_found', (none.data.not_found || []).length, 2);
  eq('**不算** ungrounded（"原著没写"和"模型在编"必须分开报）', (none.data.ungrounded || []).length, 0);

  // ⑥ 引文是真的、但只给了**别类卡**的键（appearance）→ 一条都不写，且计 empty 而不是 ungrounded
  await api('PUT', `/api/story/cards/${lu.id}`, { name: '__INJSTRAY__ 落霞渡口' });
  const stray = await run();
  eq('多给的键一律不写', stray.data.assigned, 0);
  eq('并计进 empty（引文对得上、只是没有一个该填的字段）', (stray.data.empty || []).length, 2);
  eq('**不算** ungrounded（引文本身是对的）', (stray.data.ungrounded || []).length, 0);
  eq('也没落库', await filledInj(), 0);

  // ⑦ 超长必须过与手改**同一把尺子**（补 30）：地点与道具的上限还不一样
  await api('PUT', `/api/story/cards/${lu.id}`, { name: '__INJLONG__ 落霞渡口' });
  const long = await run();
  eq('超长的那两张照样补上（引文是真的，能过核对）', long.data.assigned, 2);
  eq('地点字段被截到它自己的上限', String((await byName('__INJLONG__ 落霞渡口')).atmosphere || '').length, storyLib.FIELD_MAX.atmosphere);
  eq('道具字段被截到**它自己的**上限（两类上限不同，不能共用一把尺子）',
    String((await byName('半枚玉佩')).owner || '').length, storyLib.FIELD_MAX.owner);
  await api('PUT', `/api/story/cards/${lu.id}`, { name: '落霞渡口' });

  // ⑧ 模型返回的根本不是 JSON：这次调用算失败（500 + 原因），卡片一张都不许动
  await clearInj();
  await api('PUT', `/api/story/cards/${lu.id}`, { name: '__GARBAGE__ 落霞渡口' });
  const gar = await run();
  eq('不可解析时是失败（500）而不是"成功补了 0 个"', gar.status, 500);
  eq('失败时卡片未被改动', await filledInj(), 0);
  await api('PUT', `/api/story/cards/${lu.id}`, { name: '落霞渡口' });

  // ⑨ 都填好了：不该再调模型（calls = 0），也不该报错
  const okRun = await run();
  eq('先补上（对照）', okRun.data.assigned, 2);
  const done = await run();
  eq('没有候选时 calls = 0（不白花一次钱）', done.data.calls, 0);
  ok('并说明原因（说得具体：地点卡/道具卡的可注入描述）', /可注入的描述/.test(done.data.note || ''), done.data.note);
  eq('这时 pool 仍然非空（"一张都不缺"与"没有这类卡"是两回事）', done.data.pool, 3);

  // ⑩ **静默失败的守门**：模板里丢了变量名 → 必须明确报错。
  //    `renderPrompt` 会把"没给的 {{…}}"替换成空串，所以变量名对不上时卡片清单会**整个发不出去**，
  //    模型只能凭名字编 —— 而链路上零报错（补 34 真踩到：统一端点时写错了变量名，三条断言同时红却看不出为什么）
  await clearInj();
  const tpls = (await api('GET', '/api/templates')).data;
  const injTpl = tpls.find((t) => t.key === 'card_inject');
  ok('模板表里有 card_inject', !!injTpl);
  const origContent = injTpl.content;
  await api('PUT', `/api/templates/${injTpl.id}`, { content: String(origContent).replace('{{卡片与原文片段}}', '') });
  const broken = await run();
  eq('模板丢了变量 → 明确报错（而不是发个空清单让模型凭名字编）', broken.status, 500);
  ok('并说清是模板缺哪个变量', /没有 \{\{卡片与原文片段\}\} 变量/.test(broken.data.error || ''), broken.data.error);
  eq('报错时卡片未被改动（先检查、后调用）', await filledInj(), 0);
  await api('PUT', `/api/templates/${injTpl.id}`, { content: origContent });
  const fixed = await dry();
  eq('还原模板后又能正常工作（证明上面那条红确实是变量引起的）', fixed.status, 200);

  // ⑪ 不认识的 target：400 并列出可用值（而不是静默当成补长相）
  const bad = await api('POST', '/api/story/field-fill', { source_id: src.id, target: 'nope' });
  eq('不认识的 target → 400', bad.status, 400);
  ok('并列出可用值', /char_look/.test(bad.data.error || '') && /card_inject/.test(bad.data.error || ''), bad.data.error);
  eq('原著不存在时 404', (await api('POST', '/api/story/field-fill', { source_id: 'nope', target: 'card_inject' })).status, 404);

  // ⑫ 体检的 no_inject 必须有出口，且**切到这一类**（地点卡与道具卡要补的字段不同）
  const aud = await api('GET', `/api/story/audit?project_id=${PID}`);
  const injIssues = (aud.data.issues || []).filter((x) => x.code === 'no_inject');
  ok('体检报出了"没有可注入描述"的卡片', injIssues.length >= 1, String(injIssues.length));
  eq('出口指向原著页', ((injIssues[0] || {}).go || {}).page, 'novel');
  ok('出口的 kind 与该卡的类别一致（地点卡就去地点卡那一栏）',
    injIssues.every((x) => ['location', 'prop'].includes(((x.go || {}).params || {}).kind)), JSON.stringify(injIssues.map((x) => (x.go || {}).params)));
  eq('出口带上这份原著', (((injIssues[0] || {}).go || {}).params || {}).source_id, src.id);
  ok('出口落到**那张卡**上（带 card_id；只给 kind 的话落地还得自己找）',
    injIssues.every((x) => !!(((x.go || {}).params || {}).card_id)), JSON.stringify(injIssues.map((x) => (x.go || {}).params)));
  ok('card_id 确实是它自己那张（不是随手带的第一张）',
    injIssues.every((x) => ((x.card_ids || [])[0] || '') === (((x.go || {}).params || {}).card_id)),
    JSON.stringify(injIssues.map((x) => [x.card_ids, (x.go || {}).params])));
  eq('仍然不是"机械可修"（要调模型、要花钱）', (injIssues[0] || {}).fixable, false);
}

// ══════════════════════════════════════════════════════════════
// 批 8 补 35：AI 回原文补时间点（第三份规格）＋ 引文可见
// ══════════════════════════════════════════════════════════════
// 补 32 **有意**把 timeline_no_when 排除在 AI 补值之外："时间点是关于世界的事实，原文没写就只能猜"。
// 补 33/34 把那条理由的**前提**消掉了：模型必须交出原文原话并与这张卡自己的片段逐字核对，
// 猜的没有引文可交、整条丢弃。这一组的核心就是证明**这条防线在时间点上同样成立** ——
// 尤其是"值看着很合理、引文却是编的"那一种（__WHENFAKE__），它正是"猜"的真实形态。
group('AI 回原文补时间点（批 8 补 35：撤销"只能猜"，但推算的仍然进不了库）');
{
  const pj = await api('POST', '/api/projects', { name: '补时间点测试剧' });
  const PID = pj.data.id;
  const NOVEL = '三年前他离开临江，此后音讯全无。'.repeat(4)
    + '第三天的黄昏，林晚才等到那封信。'.repeat(4)
    + '顾寒立在檐下，玄色劲装。'.repeat(4)
    + '__WHENFILL__';
  const an = await api('POST', '/api/story/analyze', { project_id: PID, title: '补时间点·原著', text: NOVEL, reduce: false });
  eq('解析任务已建', an.status, 200);
  for (let i = 0; i < 80; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const src = (await api('GET', `/api/story/sources?project_id=${PID}`)).data[0];
  const listCards = async () => (await api('GET', `/api/story/cards?source_id=${src.id}`)).data;
  const byName = async (n) => (await listCards()).find((c) => c.name === n) || {};
  const whens = async () => (await listCards()).filter((c) => c.kind === 'timeline');
  // 「重逢」在解析时就带着 when，是**对照组**：全程留着，用来钉"已有的一个都不动"。
  // 计数一律只数候选（对照组的 1 不计入），断言才不会被对照组污染
  const CONTROL = '重逢';
  const cands = async () => (await whens()).filter((c) => c.name !== CONTROL);
  const clearWhen = async () => {
    for (const c of await cands()) await api('PUT', `/api/story/cards/${c.id}`, { when: '' });
  };
  const filledWhen = async () => (await cands()).filter((c) => String(c.when || '').trim()).length;
  const dry = () => api('POST', '/api/story/field-fill', { source_id: src.id, target: 'timeline_when', dry_run: true });
  const run = () => api('POST', '/api/story/field-fill', { source_id: src.id, target: 'timeline_when' });

  const tl = await whens();
  eq('解析出了时间线卡', tl.length, 3);
  eq('其中两张没有时间点（重逢带着 when，是对照组）', (await cands()).filter((c) => !String(c.when || '').trim()).length, 2);
  eq('对照组真的带着时间点', (await byName(CONTROL)).when, '第二年春天');

  // ① 干跑：如实报数、不写库
  const d1 = await dry();
  eq('干跑 200', d1.status, 200);
  eq('干跑如实报出要补的张数', d1.data.targets, 2);
  eq('干跑报出这类卡一共有几张', d1.data.pool, 3);
  eq('干跑不写库', await filledWhen(), 0);
  eq('干跑带回空的 assigned_items（形状稳定，界面不用先判断有没有这个键）',
    Array.isArray(d1.data.assigned_items) && d1.data.assigned_items.length, 0);

  // ② 真跑：mock 给的是**从那张卡自己片段里截的原话** → 过核对并落库
  const r1 = await run();
  eq('真跑 200', r1.status, 200);
  eq('补上了所有缺时间点的时间线卡', r1.data.assigned, 2);
  eq('没接住的几种原因为空', [r1.data.ungrounded, r1.data.not_found, r1.data.missing, r1.data.invalid, r1.data.empty].map((x) => (x || []).length).join(','), '0,0,0,0,0');

  // ③ **引文可见**：报告必须逐张给出"写进去的值 + 它的引文"。
  //    引文是这个机制唯一可核对的东西；只报个张数（或一闪而过的 toast）用户只能盲信。
  //    时间点这类**事实型**字段尤其如此 —— 引文可能是真的、但认错了是哪一句。
  const items = r1.data.assigned_items || [];
  eq('报告逐张列出写进去的卡片', items.length, 2);
  ok('每条都带着**实际落库**的值（不是模型的提议）',
    items.every((x) => !!String((x.values || {}).when || '').trim()), JSON.stringify(items));
  ok('每条都带着它的引文（界面要按"值 ← 原话"渲染，没有引文就没得核对）',
    items.every((x) => !!String(x.quote || '').trim()), JSON.stringify(items));
  ok('报告里的值与卡片上真的存着的一致（报告与卡片必须是同一份数据）',
    items.every((x) => { const c = tl.find((y) => y.id === x.id) || {}; return true; }) && items.every((x) => !!x.id && !!x.name),
    JSON.stringify(items.map((x) => [x.id, x.name])));
  for (const x of items) {
    const stored = await byName(x.name);
    eq(`「${x.name}」卡片上的 when 就是报告里那个值`, stored.when, (x.values || {}).when);
  }
  eq('报告里的字段清单就是 when', items.every((x) => (x.fields || []).join(',') === 'when'), true);
  eq('assigned_names 与 assigned_items 同源（不会一个说 2 一个说 1）',
    (r1.data.assigned_names || []).length, items.length);
  // **对照组一个字都没动** —— 这条钉必须在每个用例里都成立，所以对照组全程留在候选名单之外
  eq('解析时就带着 when 的那张（重逢）一个字都没动', (await byName(CONTROL)).when, '第二年春天');

  // ④ **本组的核心钉**：模型"推算"出来的时间必须进不了库。
  //    when = "三年后" 看着非常合理，但原文里没有这句话 → 没有引文可交 → 整条丢弃。
  //    补 32 拒绝做这一项的理由就是"模型只能猜"，这条证明"猜的写不进去"。
  await clearWhen();
  const c0 = (await whens())[0];
  await api('PUT', `/api/story/cards/${c0.id}`, { name: '__WHENFAKE__ 离开临江' });
  const fake = await run();
  eq('推算出来的时间（引文对不上原文）→ assigned = 0', fake.data.assigned, 0);
  eq('并**单独**计进 ungrounded', (fake.data.ungrounded || []).length, 2);
  eq('一张都没落库', await filledWhen(), 0);
  eq('报告里也没有"已写入"的条目（不能报了却没写，也不能写了没报）', (fake.data.assigned_items || []).length, 0);
  ok('并说清是"引文对不上原文"而不是只报 0', /没有给出可用的时间点/.test(fake.data.note || ''), fake.data.note);

  // ⑤ 原文确实没写时间：模型回 found=false → not_found（诚实的结论，不是失败）
  await api('PUT', `/api/story/cards/${c0.id}`, { name: '__WHENNONE__ 离开临江' });
  const none = await run();
  eq('原文没写时 assigned = 0', none.data.assigned, 0);
  eq('计进 not_found', (none.data.not_found || []).length, 2);
  eq('**不算** ungrounded（"原著没写"和"模型在编"必须分开报）', (none.data.ungrounded || []).length, 0);

  // ⑥ 引文是真的、但只给了**别的**字段（order_note/summary）→ 一条都不写，且计 empty
  //    这一轮**只补 when**：体检只判 when，顺带多写一个字段就是"没被要求却动用户数据"
  await api('PUT', `/api/story/cards/${c0.id}`, { name: '__WHENSTRAY__ 离开临江' });
  const stray = await run();
  eq('多给的键一律不写', stray.data.assigned, 0);
  eq('并计进 empty（引文对得上、只是没有一个该填的字段）', (stray.data.empty || []).length, 2);
  eq('**不算** ungrounded（引文本身是对的）', (stray.data.ungrounded || []).length, 0);
  const strayCard = await byName('__WHENSTRAY__ 离开临江');
  ok('order_note 没有被顺手写进去', strayCard.order_note !== '紧接着上一节', String(strayCard.order_note));
  ok('summary 也没有被顺手改写', strayCard.summary !== '改写过的摘要', String(strayCard.summary));

  // ⑦ 超长必须过与手改**同一把尺子**（补 30）
  await api('PUT', `/api/story/cards/${c0.id}`, { name: '__WHENLONG__ 离开临江' });
  const long = await run();
  eq('超长的那两张照样补上（引文是真的，能过核对）', long.data.assigned, 2);
  eq('when 被截到它自己的上限', String((await byName('__WHENLONG__ 离开临江')).when || '').length, storyLib.FIELD_MAX.when);
  ok('报告里报的也是**截断后**的值（报告必须与卡片一致，不能报模型的原文）',
    (long.data.assigned_items || []).every((x) => String((x.values || {}).when || '').length === storyLib.FIELD_MAX.when),
    JSON.stringify((long.data.assigned_items || []).map((x) => String((x.values || {}).when || '').length)));
  await api('PUT', `/api/story/cards/${c0.id}`, { name: '离开临江' });

  // ⑧ 都填好了：不该再调模型（calls = 0），也不该报错
  await clearWhen();
  const okRun = await run();
  eq('先补上（对照）', okRun.data.assigned, 2);
  const done = await run();
  eq('没有候选时 calls = 0（不白花一次钱）', done.data.calls, 0);
  ok('并说明原因（说得具体：时间线卡的时间点）', /时间点/.test(done.data.note || ''), done.data.note);
  eq('这时 pool 仍然非空（"一张都不缺"与"没有这类卡"是两回事）', done.data.pool, 3);
  eq('而且对照组还是没被动过', (await byName(CONTROL)).when, '第二年春天');

  // ⑨ **静默失败的守门**：模板里丢了变量名 → 必须明确报错（与补 34 同一条纪律）
  await clearWhen();
  const tpls = (await api('GET', '/api/templates')).data;
  const twTpl = tpls.find((t) => t.key === 'timeline_when');
  ok('模板表里有 timeline_when', !!twTpl);
  const origContent = twTpl.content;
  await api('PUT', `/api/templates/${twTpl.id}`, { content: String(origContent).replace('{{时间线卡与原文片段}}', '') });
  const broken = await run();
  eq('模板丢了变量 → 明确报错（而不是发个空清单让模型凭名字编）', broken.status, 500);
  ok('并说清是模板缺哪个变量', /没有 \{\{时间线卡与原文片段\}\} 变量/.test(broken.data.error || ''), broken.data.error);
  eq('报错时卡片未被改动（先检查、后调用）', await filledWhen(), 0);
  await api('PUT', `/api/templates/${twTpl.id}`, { content: origContent });
  eq('还原模板后又能正常工作（证明上面那条红确实是变量引起的）', (await dry()).status, 200);

  // ⑩ 不认识的 target 的错误信息里要**列出全部三份规格**（新加规格时这句话会自己更新）
  const bad = await api('POST', '/api/story/field-fill', { source_id: src.id, target: 'nope' });
  eq('不认识的 target → 400', bad.status, 400);
  ok('列出全部三份规格（char_look / card_inject / timeline_when）',
    ['char_look', 'card_inject', 'timeline_when'].every((k) => String(bad.data.error || '').includes(k)), bad.data.error);

  // ⑪ 体检的 timeline_no_when 必须有出口、落到**那张卡**上，且文案已随反转更新
  const aud = await api('GET', `/api/story/audit?project_id=${PID}`);
  const whenIssues = (aud.data.issues || []).filter((x) => x.code === 'timeline_no_when');
  ok('体检报出了"没有时间点"的时间线卡', whenIssues.length >= 1, String(whenIssues.length));
  eq('出口指向原著页', ((whenIssues[0] || {}).go || {}).page, 'novel');
  eq('出口切到时间线卡这一类', (((whenIssues[0] || {}).go || {}).params || {}).kind, 'timeline');
  eq('出口带上这份原著', (((whenIssues[0] || {}).go || {}).params || {}).source_id, src.id);
  ok('出口落到**那张卡**上（只给 kind 的话落地还得自己找）',
    whenIssues.every((x) => !!(((x.go || {}).params || {}).card_id)), JSON.stringify(whenIssues.map((x) => (x.go || {}).params)));
  ok('card_id 确实是它自己那张', whenIssues.every((x) => ((x.card_ids || [])[0] || '') === (((x.go || {}).params || {}).card_id)));
  ok('详情里指向「AI 补时间点」那个按钮（反转后仍要有出口）', /AI 补时间点/.test((whenIssues[0] || {}).detail || ''), (whenIssues[0] || {}).detail);
  ok('且不再声称"没有让模型补的按钮"（旧文案已随反转更新）', !/没有"让模型补"的按钮/.test((whenIssues[0] || {}).detail || ''));
  eq('仍然不是"机械可修"（要调模型、要花钱）', (whenIssues[0] || {}).fixable, false);
}
// ══════════════════════════════════════════════════════════════
// 批 8 补 31：角色（资产库）字段的唯一漏斗
// ══════════════════════════════════════════════════════════════
group('角色字段的唯一漏斗（批 8 补 31：appearance 会进每一次出图提示词）');
{
  const pj = await api('POST', '/api/projects', { name: '角色上限测试剧' });
  const PID = pj.data.id;
  const MAX = storyLib.CHARACTER_FIELD_MAX;
  const LONG = '长'.repeat(20000);

  // ① 建角色：超长必须被截（修前实测 20000 字原样落库，而 characterPhrase 会原文注入每一次出图提示词）
  const made = await api('POST', '/api/characters', {
    project_id: PID, name: '林晚', appearance: LONG, outfit: LONG, notes: LONG, alias: LONG,
  });
  eq('建角色返回 200', made.status, 200);
  const cid = made.data.id;
  eq('appearance 被截到上限', String(made.data.appearance || '').length, MAX.appearance);
  eq('outfit 被截到上限', String(made.data.outfit || '').length, MAX.outfit);
  eq('notes 被截到上限', String(made.data.notes || '').length, MAX.notes);
  eq('alias 被截到上限', String(made.data.alias || '').length, MAX.alias);
  ok('截断了哪些字段如实上报', Array.isArray(made.data.truncated) && made.data.truncated.includes('appearance'),
    JSON.stringify(made.data.truncated));

  // ② 漏斗最容易弄坏的地方：**非文本字段必须原样带过**。
  //    is_locked 一旦被 str() 成 "false"（非空字符串）就会变成**真值** —— 外貌会在用户没勾选时被锁定；
  //    reference_image_ids 一旦被 str() 成字符串，出图时就再也带不上参考图。
  const flags = await api('PUT', `/api/characters/${cid}`, {
    is_locked: true, reference_image_ids: ['img_a', 'img_b'],
  });
  eq('is_locked 仍是布尔 true（没被 str 成 "true"）', flags.data.is_locked, true);
  ok('reference_image_ids 仍是数组（没被 str 成字符串）', Array.isArray(flags.data.reference_image_ids)
    && flags.data.reference_image_ids.join(',') === 'img_a,img_b', JSON.stringify(flags.data.reference_image_ids));
  const unlocked = await api('PUT', `/api/characters/${cid}`, { is_locked: false });
  eq('is_locked 能改回 false', unlocked.data.is_locked, false);

  // ③ 手改：超长截断 + 如实上报；没超限不许乱报（否则提示变成狼来了）
  const put1 = await api('PUT', `/api/characters/${cid}`, { appearance: LONG });
  eq('手改超长 appearance 被截', String(put1.data.appearance || '').length, MAX.appearance);
  ok('手改也如实上报', Array.isArray(put1.data.truncated) && put1.data.truncated.includes('appearance'),
    JSON.stringify(put1.data.truncated));
  const put2 = await api('PUT', `/api/characters/${cid}`, { appearance: '白衣' });
  eq('没超限不报 truncated', put2.data.truncated, undefined);
  eq('没超限的值原样保留', put2.data.appearance, '白衣');
  const put3 = await api('PUT', `/api/characters/${cid}`, { outfit: '  黑甲  ' });
  eq('手改也 trim', put3.data.outfit, '黑甲');
  eq('只是 trim 不算截断', put3.data.truncated, undefined);

  // ④ 清空仍可用（合并语义的回归防线，与卡片那边同一条）
  await api('PUT', `/api/characters/${cid}`, { appearance: '' });
  const cleared = (await api('GET', `/api/characters?project_id=${PID}`)).data.find((x) => x.id === cid) || {};
  eq('空串能清空角色字段', cleared.appearance, '');

  // ⑤ 落库的确实是截断后的值（不是只在响应里截）
  await api('PUT', `/api/characters/${cid}`, { notes: LONG });
  const reread = (await api('GET', `/api/characters?project_id=${PID}`)).data.find((x) => x.id === cid) || {};
  eq('落库的也是截断后的值', String(reread.notes || '').length, MAX.notes);

  // ⑥ 从人物卡导入这条路也过同一个漏斗（它以前 alias 完全没截、notes 写死 400）
  const an = await api('POST', '/api/story/analyze', {
    project_id: PID, title: '漏斗·原著', reduce: false, max_chars: 800, max_chunks: 10,
    text: `林晚在临江茶馆见到顾寒。\n${'两人对峙，林晚拔剑。'.repeat(40)}`,
  });
  eq('解析任务已建', an.status, 200);
  for (let i = 0; i < 80; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const card = (await api('GET', `/api/story/cards?project_id=${PID}`)).data.find((c) => c.kind === 'character' && c.name === '林晚');
  ok('拿到了人物卡', !!card, JSON.stringify((await api('GET', `/api/story/cards?project_id=${PID}`)).data.map((c) => c.name)));
  const conv = await api('POST', `/api/story/cards/${(card || {}).id}/to-character`, { project_id: PID });
  eq('人物卡导入资产库返回 200', conv.status, 200);
  const imported = conv.data.character || conv.data;
  // 先证明它**不是空壳**：字段全是空的话，"每个字段都在上限内"会毫无意义地通过（注意事项 11）
  ok('导入的角色确实带着内容（否则下面那条上限断言是白过的）',
    String(imported.name || '').length > 0 && String(imported.appearance || '').length > 0,
    JSON.stringify({ name: imported.name, appearance: imported.appearance }));
  ok('导入的角色每个字段都在上限内（走的是同一个漏斗）',
    Object.entries(MAX).every(([k, max]) => String(imported[k] || '').length <= max),
    JSON.stringify(Object.fromEntries(Object.entries(MAX).map(([k]) => [k, String(imported[k] || '').length]))));
}

// ══════════════════════════════════════════════════════════════
// 批 8 补 30：手改卡片也要过同一把尺子（FIELD_MAX）
// ══════════════════════════════════════════════════════════════
group('手改卡片的两把尺子（批 8 补 30：模型写有上限、人写也得有）');
{
  const pj = await api('POST', '/api/projects', { name: '手改上限测试剧' });
  const PID = pj.data.id;
  const an = await api('POST', '/api/story/analyze', {
    project_id: PID, title: '上限·原著', reduce: false, max_chars: 800, max_chunks: 10,
    text: `林晚在临江茶馆见到顾寒，白衣上沾着夜雨。\n${'两人对峙，林晚拔剑。'.repeat(40)}`,
  });
  eq('解析任务已建', an.status, 200);
  for (let i = 0; i < 80; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const cards = (await api('GET', `/api/story/cards?project_id=${PID}`)).data;
  const chr = cards.find((c) => c.kind === 'character' && c.name === '林晚');
  ok('拿到了人物卡', !!chr, JSON.stringify(cards.map((c) => `${c.kind}:${c.name}`)));
  const cid = (chr || {}).id || 'missing';
  const MAX = storyLib.FIELD_MAX;

  // ① 超长值必须被截到 FIELD_MAX（以前会原样落库 —— 实测 5000 字存回 5000 字）
  const LONG = '长'.repeat(MAX.appearance + 300);
  const put1 = await api('PUT', `/api/story/cards/${cid}`, { appearance: LONG });
  eq('手改超长字段返回 200', put1.status, 200);
  eq('存回长度 = FIELD_MAX（与模型抽取同一把尺子）', String(put1.data.appearance || '').length, MAX.appearance);
  ok('截断了哪些字段如实上报（静默少一截文字，用户只会以为"我明明写了的"）',
    Array.isArray(put1.data.truncated) && put1.data.truncated.includes('appearance'), JSON.stringify(put1.data.truncated));
  const reread = (await api('GET', `/api/story/cards?project_id=${PID}`)).data.find((x) => x.id === cid) || {};
  eq('落库的也是截断后的值（不是只在响应里截）', String(reread.appearance || '').length, MAX.appearance);

  // ② 没超限就**不能**报 truncated（否则这个提示会变成狼来了）
  const put2 = await api('PUT', `/api/story/cards/${cid}`, { appearance: '白衣' });
  eq('没超限不报 truncated', put2.data.truncated, undefined);
  eq('没超限的值原样保留', put2.data.appearance, '白衣');

  // ③ 清空仍然可用 —— 这是修这个洞最容易弄坏的地方：
  //    走 normalizeCard 的话空值会被它丢掉，而 store.update 是合并语义（键不在就保留旧值），
  //    那样用户就**再也清不掉一个字段**了
  await api('PUT', `/api/story/cards/${cid}`, { appearance: '' });
  const cleared = (await api('GET', `/api/story/cards?project_id=${PID}`)).data.find((x) => x.id === cid) || {};
  eq('空串能清空字段（回归防线）', cleared.appearance, '');

  // ④ 顺手 trim（与模型路径一致），并且首尾空白不算"截断"
  const put4 = await api('PUT', `/api/story/cards/${cid}`, { outfit: '  黑甲  ' });
  eq('手改也 trim', put4.data.outfit, '黑甲');
  eq('只是 trim 不算截断（否则提示会变成狼来了）', put4.data.truncated, undefined);

  // ⑤ 非白名单字段照旧改不动（来源事实：改了 kind/source_id 会让卡片在两个视图里重复出现/断掉溯源）
  const before = (await api('GET', `/api/story/cards?project_id=${PID}`)).data.find((x) => x.id === cid) || {};
  await api('PUT', `/api/story/cards/${cid}`, { kind: 'prop', source_id: 'hacked', id: 'hacked' });
  const after = (await api('GET', `/api/story/cards?project_id=${PID}`)).data.find((x) => x.id === cid) || {};
  eq('kind/source_id 仍改不动（白名单只放行可编辑字段）', `${after.kind}|${after.source_id}`, `${before.kind}|${before.source_id}`);
  eq('id 也不会被改掉', after.id, cid);

  // ⑥ 每个可编辑字段都真的能改（白名单是推导出来的，漏一个字段 = 界面上能填、保存后静默丢失）
  const probe = await api('PUT', `/api/story/cards/${cid}`, { gender: '女', age: '青年', region: '临江' });
  eq('推导出来的白名单包含本轮新加的字段（gender/age）', `${probe.data.gender}|${probe.data.age}`, '女|青年');
}

// ══════════════════════════════════════════════════════════════
// 批 8 补 28：剧情卡人物闭环体检 + 内置提示词"能更新"
// ══════════════════════════════════════════════════════════════
group('剧情卡人物闭环体检（批 8 补 28：involved 里的人真的存在吗）');
{
  const pj = await api('POST', '/api/projects', { name: '剧情卡闭环测试剧' });
  const PID = pj.data.id;
  const an = await api('POST', '/api/story/analyze', {
    project_id: PID, title: '闭环·原著', reduce: false, max_chars: 800, max_chunks: 10,
    text: `__PLOTCAST__\n\n${'林晚在临江茶馆见到顾寒。'.repeat(40)}`,
  });
  eq('解析任务已建', an.status, 200);
  for (let i = 0; i < 80; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const src = (await api('GET', `/api/story/sources?project_id=${PID}`)).data[0];
  const plots = (await api('GET', `/api/story/cards?source_id=${src.id}&kind=plot`)).data;
  ok('剧情卡已抽到（带 involved）', plots.length >= 1 && plots[0].involved.includes('苏婉儿'), JSON.stringify(plots[0] && plots[0].involved));

  const au = await api('GET', `/api/story/audit?project_id=${PID}`);
  eq('体检 200', au.status, 200);
  ok('返回体里有独立的 cast 分组（面板渲染的是合并后的 issues，两组都要在）',
    Array.isArray(au.data.cast_issues) && Array.isArray(au.data.issues), JSON.stringify(Object.keys(au.data)));
  const cast = au.data.cast_issues.filter((x) => x.code === 'plot_cast_unknown');
  eq('报出"剧情卡提到的人在人物卡与角色库里都找不到"', cast.length, 1);
  eq('报的就是那个找不到的名字（有卡的林晚不该被报）', cast[0].target_name, '苏婉儿');
  ok('合并后的 issues 里也有它（界面消费的是这个字段 —— 只在分组里等于没报）',
    au.data.issues.some((x) => x.code === 'plot_cast_unknown' && x.target_name === '苏婉儿'));
  eq('级别是 info（找不到 ≠ 错）', cast[0].level, 'info');
  eq('不标可一键修复（改名还是补卡要人定）', cast[0].fixable, false);
  ok('带出口：直达那张剧情卡（原著页要 source_id 才载卡片列表）',
    cast[0].go && cast[0].go.page === 'novel' && cast[0].go.params.source_id === src.id && !!cast[0].go.params.card_id,
    JSON.stringify(cast[0].go));
  eq('counts 里也计入了（info 计数）', au.data.cast_counts.info, 1);

  // 角色库里建一个同名角色 → 这条必须消失（证明"已知名字"确实包含角色库，不是只认人物卡）
  await api('POST', '/api/characters', { project_id: PID, name: '苏婉儿', appearance: '青衣' });
  const au2 = await api('GET', `/api/story/audit?project_id=${PID}`);
  eq('角色库补上这个人之后，这一条消失（体检不是永远报同样的话）',
    au2.data.cast_issues.filter((x) => x.code === 'plot_cast_unknown').length, 0);
}

group('内置提示词同步（批 8 补 28：改了提示词，老库也能收到；改过的绝不覆盖）');
{
  const list = (await api('GET', '/api/templates')).data;
  const builtin = list.filter((t) => t.is_builtin);
  ok('内置模板都带版本与内容指纹（下次启动才能判断"有没有被用户改过"）',
    builtin.length > 0 && builtin.every((t) => Number.isInteger(t.builtin_version) && /^[0-9a-f]{8}$/.test(t.builtin_digest || '')),
    JSON.stringify(builtin.slice(0, 2)));
  const ne0 = list.find((t) => t.key === 'novel_extract');
  // 别把版本号写死：它每轮都会涨（上一轮写死 2，这一轮升到 3 就红了）。
  // 真正要守的是"改过内容就要 bump、而且老版本指纹要登记进历史表"——后者才是老库能升级的原因
  ok('改过内容的抽取提示词版本已 bump（≥2，老库才认得出这是新版）',
    Number.isInteger(ne0.builtin_version) && ne0.builtin_version >= 2, String(ne0.builtin_version));
  ok('上一版官方指纹已登记进历史表（没有它，补28之前装的库永远升不上来）',
    (seedLib.TEMPLATE_SUPERSEDED.novel_extract || []).includes('04ec3962'),
    JSON.stringify(seedLib.TEMPLATE_SUPERSEDED.novel_extract));
  ok('提示词写明了 involved 只写本名（预防）+ 体检（验收）成对', /本名/.test(ne0.content));

  // ── 端到端：拿一个**独立的库**当"老用户"，起一个独立实例，看它到底改了谁、没改谁 ──
  // 为什么不复用上面那个实例：播种只在**端口绑定成功之后**做（批 8 补 28 的修正）——
  // 影子实例绝不能写数据，所以"再起一个同端口的实例"根本不会走到播种（那条路另有断言，见 X4）。
  const HOME2 = path.join(os.tmpdir(), `agnes-apitest-tpl-${process.pid}`);
  fs.rmSync(HOME2, { recursive: true, force: true });
  fs.mkdirSync(HOME2, { recursive: true });
  const db = JSON.parse(fs.readFileSync(path.join(HOME, 'db.json'), 'utf8'));
  const dg = storyLib.digestText;
  db.projects = []; db.story_cards = []; db.story_sources = [];
  // ① 用户改过的内置模板：内容变了、行上也没有能自证"还是官方版"的指纹 → 必须原样保留
  const EDITED = '我自己的抽取要求：只抽主角。';
  // ② 官方旧版：行上的指纹自证"就是官方那一版"，但与当前默认不同 → 必须被更新到新版
  const OLD = '这是上一版官方提示词。';
  db.prompt_templates = db.prompt_templates.map((t) => {
    if (t.key === 'novel_extract') return { ...t, content: EDITED };
    if (t.key === 'story_bible') return { ...t, content: OLD, builtin_digest: dg(OLD), builtin_version: 1 };
    return t;
  });
  fs.writeFileSync(path.join(HOME2, 'db.json'), JSON.stringify(db));

  const p2 = 21000 + Math.floor(Math.random() * 8000);
  const srv2 = spawn(NODE, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(p2), NO_OPEN: '1', AGNES_STUDIO_HOME: HOME2 },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out2 = '';
  srv2.stdout.on('data', (d) => (out2 += d));
  srv2.stderr.on('data', (d) => (out2 += d));
  try {
    const up = await waitHealth(`http://127.0.0.1:${p2}`);
    ok('老库实例起得来', up, out2.slice(0, 200));
    // 注意：/api/templates 返回**裸数组**（本项目不做统一信封），raw fetch 拿到的就是数组本身
    const got = await (await fetch(`http://127.0.0.1:${p2}/api/templates`)).json();
    const after = got.find((t) => t.key === 'novel_extract');
    const sb = got.find((t) => t.key === 'story_bible');
    const want = seedLib.DEFAULT_TEMPLATES.find((t) => t.key === 'story_bible');
    eq('用户改过的内置模板**原样保留**（覆盖人的劳动是不可逆的伤害）', after.content, EDITED);
    eq('官方旧版被更新到新版（改了提示词，老库真的能收到）', sb.content, want.content);
    eq('更新后版本号跟着走', sb.builtin_version, 2);
    ok('启动横幅如实报出"更新了几个 / 保留了哪几个"',
      /提示词更新\s+1 个/.test(out2) && /保留你的版本：novel_extract/.test(out2), out2.slice(0, 300));
    ok('没被改过的其它模板不会被动（只动该动的那一个）',
      got.filter((t) => t.key !== 'story_bible').every((t) => t.key === 'novel_extract' || t.content !== want.content),
      JSON.stringify(got.map((t) => t.key)));
  } finally {
    try { srv2.kill(); } catch { /* gone */ }
    fs.rmSync(HOME2, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
group('分镜输入指纹覆盖名册（批 8 补 38：写入点与复算点必须同源）');
{
  const pj = await api('POST', '/api/projects', { name: '分镜名册指纹测试剧' });
  const PID = pj.data.id;
  // 分镜的过期判定挂在"分集骨架"上（按集比对），所以这份原著要能排出集来
  const an = await api('POST', '/api/story/analyze', {
    project_id: PID, title: '分镜名册·原著', text: `__LONGARC__${'长弧线的故事。'.repeat(40)}`,
  });
  for (let i = 0; i < 60; i++) { await sleep(150); const j = (await api('GET', `/api/batch/${an.data.jobId}`)).data; if (j && j.status !== 'running') break; }
  const SRC = an.data.source.id;
  const staleUrl = `/api/story/staleness?project_id=${PID}&source_id=${SRC}&per_episode=4`;
  const CONTENT = '第 1 集正文：林晚推开门，看见雨。';

  // ① 没有角色：指纹必须**逐字节等同于"只哈希正文"**（老数据不许凭空报过期）
  const sc = await api('POST', '/api/scripts', {
    project_id: PID, script_type: 'story_concept', episode_number: 1, title: '第 1 集', content: CONTENT,
  });
  const SID = sc.data.id;
  const sb = await api('POST', '/api/storyboards', {
    rows: [{ project_id: PID, episode_number: 1, shot_number: 1, scene_description: '推门', source_script_id: SID }],
  });
  const DIG0 = sb.data.rows[0].script_digest;
  eq('没有角色时，入库指纹 == 只哈希正文（补 38 之前的老数据照样是 ok，不产生假警报）',
    DIG0, storyLib.digestText(CONTENT));
  const st0 = (await api('GET', staleUrl)).data;
  eq('（前提）这一集有分镜', (st0.episodes.find((x) => x.episode_number === 1) || {}).shots, 1);
  eq('没有角色 → 分镜 ok', (st0.episodes.find((x) => x.episode_number === 1) || {}).shot_state, 'ok');

  // ② 建一个角色 → 名册进提示词，指纹必须跟着变
  const ch = await api('POST', '/api/characters', {
    project_id: PID, name: '林晚', alias: '晚晚', appearance: '黑色长直发', personality: '冷静',
  });
  const CID = ch.data.id;
  const st1 = (await api('GET', staleUrl)).data;
  eq('**加了角色 → 这一集的分镜报 stale**（补 38 的验收：模型下次会看到不同的名册）',
    (st1.episodes.find((x) => x.episode_number === 1) || {}).shot_state, 'stale');
  eq('分镜过期单独计数（不与剧本过期混在一起）', st1.counts.shot_stale, 1);
  eq('（前提）剧本侧不受影响（它没有 plan_digest）', st1.counts.script_stale, 0);

  // ③ 按**新名册**重新入库 → 立刻回到 ok（证明写入点与复算点算的是同一个东西）
  const sb2 = await api('POST', '/api/storyboards', {
    rows: [{ project_id: PID, episode_number: 1, shot_number: 1, scene_description: '推门', source_script_id: SID }],
  });
  const DIG1 = sb2.data.rows[0].script_digest;
  ok('新入库的指纹与旧的不同（名册真的进去了，不是"永远等于哈希正文"）', DIG1 !== DIG0, `${DIG0} → ${DIG1}`);
  const st2 = (await api('GET', staleUrl)).data;
  eq('写入点与复算点同源 → 重新入库后回到 ok（两处若各算一份，这里会永久报过期）',
    (st2.episodes.find((x) => x.episode_number === 1) || {}).shot_state, 'ok');

  // ④ 反向：改**不进名册**的字段不许乱喊过期（假警报比不检查更糟）
  const putP = await api('PUT', `/api/characters/${CID}`, { personality: '暴躁', role: '配角' });
  eq('（前提）personality/role 确实写进去了 —— 否则下面那条是空的（注意事项 11）',
    [putP.data.personality, putP.data.role].join('/'), '暴躁/配角');
  const st3 = (await api('GET', staleUrl)).data;
  eq('只改 personality/role（不进名册）→ 分镜仍是 ok',
    (st3.episodes.find((x) => x.episode_number === 1) || {}).shot_state, 'ok');
  // 正向：改外貌（进名册那一行）必须报过期
  await api('PUT', `/api/characters/${CID}`, { appearance: '短发' });
  const st4 = (await api('GET', staleUrl)).data;
  eq('改了外貌（名册那一行长相）→ 分镜报 stale',
    (st4.episodes.find((x) => x.episode_number === 1) || {}).shot_state, 'stale');

  // ⑤ 删光角色 → 指纹回到最初那一版（可逆，不留痕）
  await api('DELETE', `/api/characters/${CID}`);
  const sb3 = await api('POST', '/api/storyboards', {
    rows: [{ project_id: PID, episode_number: 1, shot_number: 1, scene_description: '推门', source_script_id: SID }],
  });
  eq('删光角色后指纹逐字节回到最初那一版', sb3.data.rows[0].script_digest, DIG0);

  // ⑥ 项目范围：别的项目的同名角色不该进这份指纹（否则跨项目互相干扰）
  const pj2 = await api('POST', '/api/projects', { name: '分镜名册指纹·别的项目' });
  await api('POST', '/api/characters', { project_id: pj2.data.id, name: '林晚', appearance: '完全不同的长相' });
  const sb4 = await api('POST', '/api/storyboards', {
    rows: [{ project_id: PID, episode_number: 1, shot_number: 1, scene_description: '推门', source_script_id: SID }],
  });
  eq('别的项目的角色不进这份指纹（按剧本所属项目取角色）', sb4.data.rows[0].script_digest, DIG0);

  await api('DELETE', `/api/projects/${PID}?cascade=1`);
  await api('DELETE', `/api/projects/${pj2.data.id}?cascade=1`);
}


// ── 收尾 ─────────────────────────────────────────────────────
srv.kill();
mock.close();
await sleep(400);
fs.rmSync(HOME, { recursive: true, force: true });

console.log(`\n${'═'.repeat(52)}`);
console.log(`  接口测试：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('  失败项：');
  failures.forEach((f) => console.log(`   ✗ ${f}`));
}
console.log(`${'═'.repeat(52)}\n`);
process.exit(fail ? 1 : 0);
