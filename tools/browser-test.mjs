/**
 * browser-test.mjs — 真实浏览器冒烟测试（Chrome/Edge CDP）
 * 不引入 Playwright。验证页面不是白屏、路由能切换、创建项目真的落盘、
 * 以及控制台错误 / unhandledrejection 为零。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// T9：端口不再由 pid 拍死（撞车不会重扫 → 冷启动期偶发「等待超时」假红）；实测空闲才用
const portBusy = (p) => new Promise((res) => {
  const s = net.connect(p, '127.0.0.1');
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('error', () => res(false));
  s.setTimeout(400, () => { s.destroy(); res(true); });
});
async function pickPortPair(base, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const p = base + ((process.pid + i * 977) % 9000);
    if (!(await portBusy(p)) && !(await portBusy(p + 1))) return [p, p + 1];
  }
  throw new Error('找不到连续两个空闲端口');
}
const [port, cdpPort] = await pickPortPair(30000);
const stamp = `${process.pid}-${Date.now().toString(36)}`;
const home = path.join(ROOT, 'build', `ui-home-${stamp}`);
const profile = path.join(ROOT, 'build', `ui-profile-${stamp}`);

let pass = 0, fail = 0;
const failures = [];
function ok(name, condition, extra = '') {
  if (condition) { pass++; return true; }
  fail++; failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
  return false;
}
function group(s) { console.log(`\n── ${s} ──`); }

function findBrowser() {
  const cands = [
    process.env.NM_BROWSER,
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    // macOS —— 之前只配了 Windows 路径，这台机器上真实冒烟测试一直被静默跳过
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ].filter(Boolean);
  return cands.find((p) => fs.existsSync(p)) || null;
}

class CDP {
  constructor(url) { this.url = url; this.ws = null; this.next = 1; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 10000);
      this.ws.onopen = () => { clearTimeout(timer); resolve(); };
      this.ws.onerror = (e) => { clearTimeout(timer); reject(new Error(`CDP WebSocket 错误：${e.message || 'unknown'}`)); };
      this.ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
          else p.resolve(msg.result);
        }
      };
    });
    await this.send('Runtime.enable');
    await this.send('Page.enable');
  }
  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const body = String(expr).trim();
    // 纯表达式自动 return；带多条语句的操作由调用方显式写 return。
    const expression = body.includes(';')
      ? `(async function(){${body}})()`
      : `(async function(){return (${body})})()`;
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面脚本异常');
    return r.result?.value;
  }
  close() { try { this.ws?.close(); } catch { /* ignore */ } }
}

async function waitFor(fn, label, timeout = 12000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch { /* 页面还没就绪 */ }
    await sleep(150);
  }
  throw new Error(`等待超时：${label}（最后值 ${JSON.stringify(last)}）`);
}

async function getTarget() {
  const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  const list = await r.json();
  return list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl) || null;
}

const server = spawn(NODE, [path.join(ROOT, 'server.js')], {
  env: { ...process.env, PORT: String(port), NO_OPEN: '1', AGNES_STUDIO_HOME: home },
  stdio: 'ignore',
});
let browser = null;
let cdp = null;

try {
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { return false; }
  }, '本地服务');

  const bin = findBrowser();
  if (!bin) {
    console.log('未找到 Chrome/Edge，跳过真实浏览器测试（不算失败）。');
    process.exitCode = 0;
  } else {
    console.log(`浏览器：${bin}`);
    browser = spawn(bin, [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu', '--mute-audio',
      '--window-size=1440,900', `http://127.0.0.1:${port}/#/dashboard`,
    ], { stdio: 'ignore' });

    const target = await waitFor(getTarget, '浏览器页面', 30000); // T9：满负荷下 Chrome 冷启动可超 12s
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.connect();

    const errors = [];
    await cdp.eval(`
      window.__uiErrors = [];
      window.__uiRejects = [];
      window.addEventListener('error', e => window.__uiErrors.push(String(e.message || e.error || 'window error')));
      window.addEventListener('unhandledrejection', e => window.__uiRejects.push(String((e.reason && e.reason.message) || e.reason || 'unhandled rejection')));
      return true;
    `);

    group('工作台');
    await waitFor(() => cdp.eval(`document.readyState === 'complete' && !!document.querySelector('.page-title')`), '工作台渲染');
    ok('工作台标题存在', await cdp.eval(`document.querySelector('.page-title')?.textContent === '工作台'`));
    ok('侧边栏存在', await cdp.eval(`!!document.querySelector('.sidebar') && document.querySelector('.sidebar').getBoundingClientRect().height > 0`));
    ok('快速入口存在', await cdp.eval(`document.querySelectorAll('.quick-item').length === 6`));
    ok('工作台非白屏', await cdp.eval(`document.body.innerText.includes('开始你的下一部漫剧')`));

    group('页面切换');
    const pages = [
      ['projects', '项目管理'], ['scripts', '故事脚本'], ['storyboards', '分镜制作'],
      ['images', '图片生成'], ['videos', '视频生成'], ['tasks', '镜头任务'],
      ['assets', '素材库'], ['settings', '设置'],
    ];
    for (const [id, title] of pages) {
      await cdp.eval(`location.hash = '#/${id}'`);
      await waitFor(() => cdp.eval(`document.querySelector('.page-title')?.textContent === ${JSON.stringify(title)}`), title);
      ok(`${title} 标题存在`, await cdp.eval(`document.querySelector('.page-title')?.textContent === ${JSON.stringify(title)}`));
      ok(`${title} 内容可见`, await cdp.eval(`document.querySelector('.page')?.getBoundingClientRect().height > 50`));
    }

    group('创建项目');
    await cdp.eval(`location.hash = '#/projects?new=1'`);
    await waitFor(() => cdp.eval(`!!document.querySelector('.modal')`), '新建项目弹窗');
    ok('新建项目弹窗打开', await cdp.eval(`!!document.querySelector('.modal')`));
    await cdp.eval(`document.querySelector('#f-name').value = '浏览器验收剧'; document.querySelector('#f-name').dispatchEvent(new Event('input', {bubbles:true})); return true;`);
    await cdp.eval(`document.querySelector('[data-yes]')?.click(); return true;`);
    await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/api/projects`);
      const d = await r.json();
      return d.some((p) => p.name === '浏览器验收剧');
    }, '项目落盘');
    ok('创建项目后接口可读回', true);
    ok('创建后弹窗关闭', await cdp.eval(`!document.querySelector('.modal')`));

    group('设置页');
    await cdp.eval(`location.hash = '#/settings'`);
    await waitFor(() => cdp.eval(`document.querySelector('.page-title')?.textContent === '设置'`), '设置页');
    await waitFor(() => cdp.eval(`!!document.querySelector('#refresh-models-api')`), '设置首页模型拉取按钮');
    ok('设置首页直接显示模型拉取按钮', await cdp.eval(`!!document.querySelector('#refresh-models-api')`));
    await cdp.eval(`document.querySelector('[data-sec="task"]')?.click(); return true;`);
    await waitFor(() => cdp.eval(`!!document.querySelector('#save-task')`), '任务设置');
    ok('任务设置面板可打开', await cdp.eval(`!!document.querySelector('#t-interval') && !!document.querySelector('#save-task')`));
    await cdp.eval(`document.querySelector('[data-sec="model"]')?.click(); return true;`);
    await waitFor(() => cdp.eval(`!!document.querySelector('#refresh-models')`), '模型设置');
    ok('动态模型面板可打开', await cdp.eval(`!!document.querySelector('#refresh-models') && !!document.querySelector('#m-ttl')`));
    ok('模型默认项可选', await cdp.eval(`document.querySelector('#m-text')?.options.length > 0 && document.querySelector('#m-image')?.options.length > 0 && document.querySelector('#m-video')?.options.length > 0`));

    group('B2/B3 交互回归');
    // 脏守卫：编辑过未提交就点 × → 拦截条出现 → 放弃才真关
    await cdp.eval(`location.hash = '#/projects?new=1'`);
    await waitFor(() => cdp.eval(`!!document.querySelector('#f-name')`), '脏守卫用弹窗');
    await cdp.eval(`document.querySelector('#f-name').value = '脏字段的剧'; document.querySelector('#f-name').dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('[data-close]').click(); return true;`);
    ok('编辑未提交点关闭→出现拦截条', await cdp.eval(`!!document.querySelector('[data-discard]')`));
    ok('拦截时弹窗未关', await cdp.eval(`!!document.querySelector('.modal')`));
    await cdp.eval(`document.querySelector('[data-discard]').click(); return true;`);
    await waitFor(() => cdp.eval(`!document.querySelector('.modal')`), '放弃后关闭');
    ok('放弃修改后弹窗关闭', await cdp.eval(`!document.querySelector('.modal')`));
    // 侧栏折叠双态 + 持久化
    await cdp.eval(`document.querySelector('#sb-toggle').click(); return true;`);
    ok('折叠生效', await cdp.eval(`document.body.classList.contains('sb-collapsed')`));
    ok('折叠已持久化', await cdp.eval(`localStorage.getItem('agnes.sidebar.collapsed') === '1'`));
    await cdp.eval(`document.querySelector('#sb-toggle').click(); return true;`);
    ok('展开恢复', await cdp.eval(`!document.body.classList.contains('sb-collapsed')`));
    // 视图状态进 hash：设置分节切换写 sec
    await cdp.eval(`location.hash = '#/settings'`);
    await waitFor(() => cdp.eval(`!!document.querySelector('[data-sec=\"task\"]')`), '设置分节');
    await cdp.eval(`document.querySelector('[data-sec=\"task\"]').click(); return true;`);
    ok('分节切换写入 hash', await cdp.eval(`location.hash.includes('sec=task')`));
    // 两段式就地确认：首点 armed 改文案，3.4s 后自动回弹（不真删）
    await cdp.eval(`document.querySelector('[data-sec=\"template\"]')?.click(); return true;`);
    const delSel = await cdp.eval(`!!document.querySelector('[data-del]')`);
    if (delSel) {
      await cdp.eval(`document.querySelector('[data-del]').click(); return true;`);
      ok('两段式：首点进入确认态', await cdp.eval(`!!document.querySelector('[data-del].armed')`));
      await sleep(3500);
      ok('两段式：3s 后自动回弹（未误删）', await cdp.eval(`!document.querySelector('[data-del].armed') && !!document.querySelector('[data-del]')`));
    } else ok('两段式：无模板可点跳过', true);
    // 导出钮在位（分镜页，用刚建的项目）
    const plist = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json();
    const pid = (plist.find((x) => x.name === '浏览器验收剧') || {}).id;
    await cdp.eval(`location.hash = '#/storyboards?project=${pid}'; return true;`);
    await waitFor(() => cdp.eval(`!!document.querySelector('#exp-csv')`), '分镜工具条');
    ok('CSV/MD 导出钮在位', await cdp.eval(`!!document.querySelector('#exp-csv') && !!document.querySelector('#exp-md')`));

    const collected = await cdp.eval(`({errors:window.__uiErrors || [], rejects:window.__uiRejects || []})`);
    ok('无 window error', collected?.errors?.length === 0, JSON.stringify(collected?.errors || []));
    ok('无未处理 Promise 拒绝', collected?.rejects?.length === 0, JSON.stringify(collected?.rejects || []));
    cdp.close();
  }
} catch (e) {
  fail++;
  failures.push(`浏览器测试异常：${e.message}`);
  console.error(`浏览器测试异常：${e.stack || e.message}`);
} finally {
  if (cdp) cdp.close();
  if (browser?.pid) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
    } else browser.kill('SIGTERM');
  }
  if (server?.pid) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    } else server.kill('SIGTERM');
  }
  await sleep(300); // 让进程松开文件句柄再清目录
  for (const dir of [home, profile]) { // T9：以前 build/ui-* 永不删除，越积越多
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 僵尸锁目录，尽力而为 */ }
  }
}

console.log(`\n__RESULT__ pass=${pass} fail=${fail}`);
if (failures.length) failures.forEach((x) => console.log(`  ✗ ${x}`));
process.exitCode = fail ? 1 : 0;
