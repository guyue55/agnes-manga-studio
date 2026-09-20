/**
 * Agnes 漫剧工坊 · 本地版 — 本地服务
 * ------------------------------------------------------------------
 * 零依赖 Node.js HTTP 服务，只监听 127.0.0.1。负责：
 *   1. 托管前端页面
 *   2. 代理 Agnes 的文本 / 图片 / 视频接口 —— API Key 只留在本机
 *   3. 项目、剧本、分镜、素材、任务、模板的本地读写
 *   4. 视频异步任务的后台轮询（关掉浏览器也继续）
 *
 * 两种运行形态：
 *   · 源码运行   node server.js      —— 资源目录就在脚本旁边
 *   · 单文件 exe 双击运行            —— 静态资源内嵌，首次启动释放到数据目录
 *
 * 相比云端版：没有用户系统、没有 Supabase、没有 Edge Function，
 * 所有数据躺在本机 data/ 目录里，拔网线也能用（除了调 Agnes 那一步）。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { createRequire } = require('node:module');

const VERSION = '1.0.2'; // 发布时与 package.json 同步；SEA 打包会被 build-exe 再注入一次（双保险）
/** 资源戳：SEA 打包时被注入为 `sea-<版本>-<内嵌资源内容哈希>`（T8：忘 bump 也不会让新 exe 沿用旧释放）；
 *  源码运行形态不会走 materializeAssets，此处等价 VERSION 仅是占位。 */
const ASSETS_VERSION = VERSION;

// ─────────────────────────────────────────────────────────────
// 单文件 exe（Node SEA）支持
// ─────────────────────────────────────────────────────────────
let sea = null;
try { sea = require('node:sea'); } catch { /* 老版本 Node 无此模块 */ }
const IS_SEA = !!(sea && typeof sea.isSea === 'function' && sea.isSea());

/** 运行期可写目录。exe 形态下不能写自己所在目录（可能在 Program Files）。 */
function resolveHome() {
  if (process.env.AGNES_STUDIO_HOME) return path.resolve(process.env.AGNES_STUDIO_HOME);
  const exeDir = path.dirname(process.execPath);
  // 便携模式：exe 旁边放一个名为 portable 的空文件，数据就落在 exe 同级的 data/
  if (fs.existsSync(path.join(exeDir, 'portable'))) return path.join(exeDir, 'data');
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AgnesStudio');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'AgnesStudio');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'AgnesStudio');
}

const CODE_HOME = __dirname;
const storyLib = require('./lib/story.js');

// ─────────────────────────────────────────────────────────────
// 代码指纹与"进程跑的是旧代码"防护（批 8 补 27）
// ─────────────────────────────────────────────────────────────
/**
 * 为什么需要：本项目是**本地长驻**服务，一轮一轮地加功能；而前端静态文件是
 * 每次请求从磁盘读的（`Cache-Control: no-store`）、**后端代码只在启动那一刻读一次**。
 * 于是页面显示的是新功能、接口却还是旧的 —— 报错偏偏是最容易误导人的那一句
 * "接口不存在: POST /api/story/plan"，看起来像"这个功能根本没做"，而不像"你该重启了"。
 * 更糟的是再敲一次 `node server.js` 也救不了：端口被占用时走的是 X4 防护那条分支，
 * 它只会说"工作台已在运行"，然后退出 —— 把唯一的补救动作也堵住了。
 * 所以：启动时留一份代码指纹，运行期随时能回答"我现在跑的是哪版代码"。
 * exe 形态代码在二进制里、进程跑着就不可能变，给个固定值即可。
 */
function codeSignature() {
  if (IS_SEA) return { sig: `sea-${VERSION}-${ASSETS_VERSION}`, files: {} };
  const files = {};
  const names = ['server.js'];
  try {
    for (const f of fs.readdirSync(path.join(CODE_HOME, 'lib')).sort()) if (f.endsWith('.js')) names.push(`lib/${f}`);
  } catch { /* 没有 lib 目录就只算 server.js */ }
  for (const f of names) {
    try { files[f] = storyLib.digestText(fs.readFileSync(path.join(CODE_HOME, f), 'utf8')); }
    catch { files[f] = '?'; }
  }
  return { sig: storyLib.digestText(names.map((f) => `${f}:${files[f]}`).join('|')), files };
}

const BOOT = codeSignature();
const BOOTED_AT = new Date().toISOString();

/** 代码有没有在启动之后被改过（带 2s 缓存：健康检查可能被反复调，别每次重读几百 KB） */
let _staleCache = { at: 0, val: null };
function staleInfo() {
  if (IS_SEA) return { stale: false, changed: [], checked: false };
  const t = Date.now();
  if (_staleCache.val && t - _staleCache.at < 2000) return _staleCache.val;
  const now = codeSignature();
  const changed = [];
  for (const f of Object.keys(now.files)) if (BOOT.files[f] !== now.files[f]) changed.push(f);
  for (const f of Object.keys(BOOT.files)) if (!(f in now.files)) changed.push(`${f}（已删除）`);
  const val = { stale: changed.length > 0, changed, checked: true };
  _staleCache = { at: t, val };
  return val;
}

/** 给"接口不存在"这类最容易被误读的报错补一句实话 */
function staleHint() {
  const st = staleInfo();
  if (!st.stale) return '';
  return `（注意：服务端代码在启动后被改过 —— ${st.changed.slice(0, 3).join('、')}${st.changed.length > 3 ? ' 等' : ''}，`
    + '当前进程跑的还是旧代码。这个接口可能是新加的：请重启服务后再试）';
}
const APP_HOME = IS_SEA ? resolveHome() : (process.env.AGNES_STUDIO_HOME
  ? path.resolve(process.env.AGNES_STUDIO_HOME)
  : path.join(CODE_HOME, 'data'));

/** 把内嵌资源释放到可写目录（仅 exe 形态需要） */
function materializeAssets() {
  if (!IS_SEA) return;
  const stampFile = path.join(APP_HOME, '.assets-version');
  let stamp = '';
  try { stamp = fs.readFileSync(stampFile, 'utf8'); } catch { /* 首次运行 */ }
  if (stamp === ASSETS_VERSION) return;

  fs.mkdirSync(APP_HOME, { recursive: true });
  for (const key of sea.getAssetKeys()) {
    if (!key.startsWith('public/') && !key.startsWith('lib/')) continue;
    const dest = path.join(APP_HOME, key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // sea.getAsset() 返回 ArrayBuffer，writeFileSync 只收 Buffer / TypedArray
    fs.writeFileSync(dest, Buffer.from(sea.getAsset(key)));
  }
  fs.writeFileSync(stampFile, ASSETS_VERSION, 'utf8');
}

if (IS_SEA) {
  try {
    materializeAssets();
  } catch (e) {
    console.error('资源释放失败：', e.message);
  }
}

// 资源目录：exe 形态从释放目录读，源码形态从旁边读
const RES_HOME = IS_SEA ? APP_HOME : CODE_HOME;

/**
 * ⚠️ 这里不能用普通的 require('./lib/xxx')：
 *   1. SEA 主脚本里相对 require 会被当成内置模块名解析
 *   2. 需要按真实的磁盘绝对路径造一个 require
 */
const libRequire = createRequire(path.join(RES_HOME, 'server.js'));
const store = libRequire('./lib/store.js');
const agnes = libRequire('./lib/agnes.js');
const poller = libRequire('./lib/poller.js');
const jobs = libRequire('./lib/jobs.js');
const seedLib = libRequire('./lib/seed.js');
const createRoutes = libRequire('./lib/routes.js');

// ─────────────────────────────────────────────────────────────
// 初始化
// ─────────────────────────────────────────────────────────────
fs.mkdirSync(APP_HOME, { recursive: true });
store.init(APP_HOME);
for (const d of [store.imagesDir(), store.videosDir(), store.exportsDir()]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
}
poller.init(store);
seedLib.seedTemplates(store);

const routes = createRoutes({
  store, agnes, poller, jobs, version: VERSION,
  boot: { sig: storyLib.digestText(BOOT.sig), at: BOOTED_AT, pid: process.pid, staleInfo },
});

// B4：任何持久化失败都进任务中心日志与终端，不再静默"保存成功"
store.onWriteError((where, e) => {
  console.error(`[store] ${where} 写盘失败：`, e && e.message || e);
  try { poller.pushLog({ level: 'error', msg: `保存失败（${where}）：${(e && e.message) || e}` }); } catch { /* 日志链路也坏了就只剩终端 */ }
});

// 有 Key 且缓存过期时，启动后后台更新模型目录；不阻塞页面启动。
// 没有 Key 时不主动报错，用户到设置页填 Key 后点「刷新模型」即可。
// P1：长驻 exe 不能只靠重启刷目录——每 6 小时看一眼 TTL（modelsNeedRefresh 内部判 24h），过期才打远端
setInterval(() => {
  if (store.getRawKey() && store.modelsNeedRefresh()) routes.refreshModels().catch(() => {});
}, 6 * 60 * 60 * 1000).unref?.();
if (store.getRawKey() && store.modelsNeedRefresh()) {
  setTimeout(() => routes.refreshModels().catch(() => {}), 800);
}

// ─────────────────────────────────────────────────────────────
// HTTP 工具
// ─────────────────────────────────────────────────────────────

/**
 * 失败追踪码（R10）。用途：用户截图报错时，凭这个短码能在「运行日志」里定位到同一次失败，
 * 不用再问"你几点几分点的哪个按钮"。
 * 形状：e + 时间基 36 后 6 位 + 4 位随机 —— 人工可读、可口头转述，同秒多次失败也不会撞码。
 */
function traceCode() {
  return `e${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 6)}`;
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        // B6 修复：不在这里 destroy —— 先让调用方把 413 响应写出去，再断流，
        // 否则客户端只会看到连接重置，前端把"文件过大"误报成网络错误。
        reject(new Error('请求体过大'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 写操作必须校验 Origin。
 * 不加这一条，用户浏览任意网页时，那个网页就能静默删掉他的工程文件。
 */
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true; // curl / 程序自身没有 Origin
  try {
    const u = new URL(String(o));
    const h = String(u.hostname).replace(/^\[|\]$/g, '');
    if (h !== 'localhost' && h !== '127.0.0.1' && h !== '::1') return false;
    // X2 收紧：端口必须与本服务实际监听端口一致。
    // 只比 hostname 的话，本机任意端口的其他网页（别人的 dev server 等）
    // 发免预检的 simple 请求就能静默写删本工作台数据，甚至经 local_file 链删文件。
    // 审核修复：默认端口（80/443）浏览器发来的 Origin 不带 :port，u.port 为空串——
    // 以 root 或 PORT=80 部署时旧比较会拒绝一切浏览器写操作，这里补协议默认值。
    const actual = server.address();
    const op = u.port || (u.protocol === 'https:' ? '443' : '80');
    if (actual && actual.port && op !== String(actual.port)) return false;
    return true;
  } catch {
    return false;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 钉死在 base 目录内，挡路径穿越 */
function safeResolve(base, relPath) {
  const clean = path.normalize(path.join(base, relPath));
  const baseNorm = path.normalize(base);
  if (clean !== baseNorm && !clean.startsWith(baseNorm + path.sep)) return null;
  return clean;
}

function serveStatic(req, res, urlPath) {
  const publicDir = path.join(RES_HOME, 'public');
  let rel;
  try {
    rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
  } catch {
    return sendText(res, 400, 'bad path'); // X3：%zz 之类非法转义不许炸监听器
  }
  if (rel.includes('\0')) return sendText(res, 400, 'bad path');
  let file = safeResolve(publicDir, rel);

  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // SPA 回退：未知路径一律给 index.html，交给前端路由
    file = path.join(publicDir, 'index.html');
    if (!fs.existsSync(file)) return sendText(res, 404, 'Not Found');
  }

  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const stat = fs.statSync(file);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).pipe(res);
}

function serveAsset(req, res, urlPath) {
  // /assets/images/xxx.png  /assets/videos/xxx.mp4
  const parts = urlPath.split('/').filter(Boolean);
  if (parts.length < 3) return sendText(res, 404, 'Not Found');
  const kind = parts[1];
  const name = path.basename(parts.slice(2).join('/'));
  const dir = kind === 'videos' ? store.videosDir() : kind === 'images' ? store.imagesDir() : null;
  if (!dir) return sendText(res, 404, 'Not Found');
  const file = safeResolve(dir, name);
  if (!file || !fs.existsSync(file)) return sendText(res, 404, 'Not Found');
  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(file).pipe(res);
}

// ─────────────────────────────────────────────────────────────
// 请求处理
// ─────────────────────────────────────────────────────────────
/** X1 防护：校验 Host 头只允许本机名（DNS rebinding 挡板）。
 *  不挡的话，恶意域名 A 记录指到 127.0.0.1 后，那个网页就能以"同源"身份
 *  静默读取 /api/export、/api/bootstrap 等全部数据。
 *  只校验主机名不校验端口——端口由监听套接字天然钉死，写面的端口精确性归 originOk 管。 */
function hostOk(req) {
  const h = req.headers.host;
  if (!h || h.includes('@')) return false; // userinfo 形态的 Host 永不合法
  let hostname;
  try { hostname = new URL(`http://${h}`).hostname; } catch { return false; }
  hostname = hostname.replace(/\.$/, ''); // 根尾点归一（FQDN 写法），localhost. 与 127.0.0.1. 同等对待
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (e) {
    // X3 防护：监听器内任何未预料的抛出（含 async 同步段）都不许击倒进程。
    console.error(`[server] 请求异常 ${req.method} ${req.url}：`, e && e.stack || e);
    if (!res.headersSent) sendJson(res, 400, { ok: false, error: '请求格式非法' });
    else try { res.end(); } catch { /* 已断开就算了 */ }
  }
});

async function handleRequest(req, res) {
  // 非法 Host（含语法坏的 Host 头）直接 403，且不再参与任何 URL 解析
  if (!hostOk(req)) return sendText(res, 403, 'bad host');
  const u = new URL(req.url, 'http://127.0.0.1');
  const pathname = u.pathname;

  // SSE：视频状态与批量任务进度
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    poller.events.add(res);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      poller.events.remove(res);
    });
    return;
  }

  // 素材文件
  if (pathname.startsWith('/assets/')) return serveAsset(req, res, pathname);

  // API
  if (pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !originOk(req)) {
      return sendJson(res, 403, { ok: false, error: '跨站请求被拒绝（Origin 校验未通过）' });
    }
    let body = {};
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const raw = await readBody(req, 120 * 1024 * 1024).catch(() => null);
      if (raw === null) {
        /**
         * B6 的遗留竞态（第 97 轮修）：原先在 `finish` 里直接 `req.destroy()`，
         * 那是**发 RST**——客户端内核会把还没被应用读走的接收缓冲一并丢掉，
         * 于是已经送出去的 413 响应体也可能被冲掉，客户端只看到 ECONNRESET，
         * 前端又把"文件过大"误报成网络错误（apitest 偶发红，正是这个竞态）。
         *
         * 正确做法：请求还没收完时先 `resume()` **排干**在途数据，让连接以正常 FIN 收尾；
         * 同时留一个上限 —— 不停手的客户端才断流，避免被无限上传拖住（DoS 边界不变）。
         */
        res.on('finish', () => {
          if (req.complete || req.readableEnded) return; // 已经收完：正常关闭即可，destroy 反而发 RST
          req.resume();
          const t = setTimeout(() => req.destroy(), 5000);
          if (t.unref) t.unref();
          const done = () => clearTimeout(t);
          req.on('end', done); req.on('close', done); req.on('error', done);
        });
        return sendJson(res, 413, { ok: false, error: '请求体过大' });
      }
      const text = raw.toString('utf8').trim();
      if (text) {
        try { body = JSON.parse(text); } catch { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
        // B8：数字/字符串/数组等"合法 JSON 非对象"统一 400，
        // 否则下游 `'k' in body` 抛 TypeError 变 500 且回显内部报错
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return sendJson(res, 400, { ok: false, error: '请求体需为 JSON 对象' });
        }
      }
    }
    const query = Object.fromEntries(u.searchParams.entries());
    try {
      const result = routes.dispatch(req.method, pathname, body, query, req, res);
      if (result === undefined) return sendJson(res, 404, { ok: false, error: `接口不存在: ${req.method} ${pathname}${staleHint()}` });
      const out = await result;
      if (out && typeof out === 'object' && typeof out.raw === 'string') return sendText(res, 200, out.raw, res.getHeader('Content-Type') || 'text/plain; charset=utf-8');
      return sendJson(res, 200, out === undefined ? { ok: true } : out);
    } catch (e) {
      const status = e.statusCode || 500;
      // 只给 5xx 发追踪码：4xx 是输入/调用问题，发码只会让界面变吵且无助于排查。
      const trace = status >= 500 ? traceCode() : null;
      if (trace) {
        try { poller.pushLog({ level: 'error', msg: `[${trace}] ${req.method} ${pathname} → ${e.message || e}` }); } catch { /* 日志链路坏了也不能挡住错误响应本身 */ }
      }
      // errorType 一并透传（此前被丢掉）：前端 ERROR_HINTS 才能把后端分类翻成人话
      return sendJson(res, status, Object.assign(
        { ok: false, error: e.message || String(e) },
        e.errorType ? { errorType: e.errorType } : null,
        trace ? { trace } : null,
      ));
    }
  }

  // 静态资源
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);

  return sendText(res, 405, 'Method Not Allowed');
}

// ─────────────────────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────────────────────
const START_PORT = Number(process.env.PORT || 5178);
const MAX_TRY = 40;

function listen(port, attempt = 0) {
  server.once('error', async (e) => {
    if (e.code === 'EADDRINUSE' && attempt < MAX_TRY) {
      // X4 防护：若占用者就是"同一数据目录的本工作台"，绝不静默起第二个影子实例——
      // persist 是整库快照全量写，两个实例互踩会静默丢数据（exe 双击两次即中招）。
      const alive = await sameAppAlive(port);
      if (alive) {
        console.log(`\n✓ 工作台已在运行：http://127.0.0.1:${port}（相同数据目录），不再启动第二个实例。`);
        // 正在跑的那个是不是**旧代码**？是的话只报"已在运行"会把用户堵死在门外：
        // 页面显示新功能、接口报"不存在"，而唯一的补救动作（再启动一次）恰好被这条分支挡住
        if (alive.code_sig && alive.code_sig !== storyLib.digestText(BOOT.sig)) {
          console.log('');
          console.log('  ⚠ 但那个进程跑的是**旧代码**（服务端代码在它启动之后改过）。');
          console.log(`    页面上的新功能会报"接口不存在"，看起来像没做，其实是没重启。`);
          console.log(`    请先结束它再启动：kill ${alive.pid || '<PID>'}${alive.pid ? '' : '（用 lsof -nP -iTCP:' + port + ' -sTCP:LISTEN 查 PID）'}`);
          console.log('    （它用的是同一份数据，直接结束是安全的：数据是落盘的 JSON。）');
        }
        console.log('  若要重新打开页面，直接访问上面的地址即可。');
        if (!process.env.NO_OPEN) openBrowser(`http://127.0.0.1:${port}`);
        process.exit(0);
      }
      listen(port + 1, attempt + 1);
    } else {
      console.error(`\n✗ 启动失败：${e.message}`);
      if (e.code === 'EADDRINUSE') console.error(`  端口 ${port} 起被占用，可用 PORT=xxxx 指定别的端口。`);
      process.exit(1);
    }
  });
  // B7 修复：成功回调只注册一次（旧写法每次重试都往 'listening' 叠一个，
  // 端口换成功后连打多张横幅、弹多个浏览器标签且首个指向别人的服务）。
  if (attempt === 0) {
    server.once('listening', () => {
      // 审核修复：启动期 once('error') 的兜底是 exit(1)——端口绑定成功后它还挂着的。
      // 换成只记录的常驻监听，运行期 server 'error'（如 EMFILE）不再"以启动失败名义"击杀服务。
      server.removeAllListeners('error');
      server.on('error', (e) => console.error('[server] 运行期错误：', e && e.message || e));
      const url = `http://127.0.0.1:${server.address().port}`;
      const resumed = poller.resume();
      banner(url, server.address().port, resumed);
      if (!process.env.NO_OPEN) openBrowser(url);
    });
  }
  server.listen(port, '127.0.0.1');
}

/**
 * 探测目标端口上是否已有一个使用相同数据目录的本应用实例。
 * @returns {false|object} 不是本应用 → false；是 → 健康体（带 `pid` / `code_sig`，
 *   调用方据此判断"跑的是不是旧代码"，见批 8 补 27）
 */
async function sameAppAlive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const j = await r.json();
    return Boolean(j.ok) && path.resolve(String(j.data_home || '')) === APP_HOME ? j : false;
  } catch {
    return false;
  }
}

function banner(url, port, resumed) {
  const line = '─'.repeat(58);
  console.log('');
  console.log(line);
  console.log('  Agnes 漫剧工坊 · 本地版  v' + VERSION);
  console.log(line);
  console.log(`  访问地址    ${url}`);
  console.log(`  数据目录    ${APP_HOME}`);
  console.log(`  素材目录    ${path.join(APP_HOME, 'assets')}`);
  if (resumed) console.log(`  恢复轮询    ${resumed} 个未完成的视频任务`);
  console.log('');
  console.log('  关闭这个窗口即可退出程序。');
  console.log(line);
  console.log('');
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      execFile('open', [url], () => {});
    } else {
      execFile('xdg-open', [url], () => {});
    }
  } catch { /* 打不开就算了，地址已经印在控制台 */ }
}

process.on('SIGINT', () => { console.log('\n正在退出…'); process.exit(0); });
// X3 最后防线：漏网异步异常只记日志不杀进程（轮询/后台任务里一个坏响应不该带走整个工作台）
process.on('unhandledRejection', (e) => console.error('[server] unhandledRejection:', e && e.stack || e));
process.on('uncaughtException', (e) => console.error('[server] uncaughtException:', e && e.stack || e));

if (require.main === module) listen(START_PORT);

module.exports = { server, listen, APP_HOME, VERSION };
