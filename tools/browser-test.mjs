/**
 * browser-test.mjs — 真实浏览器冒烟测试（Chrome/Edge CDP）
 * 不引入 Playwright。验证页面不是白屏、路由能切换、创建项目真的落盘、
 * 以及控制台错误 / unhandledrejection 为零。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
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
    // 钩子必须跨 reload 存活：套件里有大量 Page.reload，若只做一次 cdp.eval，
    // 首次 reload 后 window.__uiErrors 消失，末尾 `|| []` 兜底会让"无未捕获异常"永久假绿。
    const HOOK = `
      window.__uiErrors = [];
      window.__uiRejects = [];
      window.addEventListener('error', e => window.__uiErrors.push(String(e.message || e.error || 'window error')));
      window.addEventListener('unhandledrejection', e => window.__uiRejects.push(String((e.reason && e.reason.message) || e.reason || 'unhandled rejection')));
    `;
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
    await cdp.eval(`${HOOK}\nreturn true;`);

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

    group('存储型 XSS 注入探针');
    {
      const post = async (url, body) => {
        const r = await fetch(`http://127.0.0.1:${port}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return r.json();
      };
      const X = (tag) => `<img src=x onerror="window.__xss=(window.__xss||[]).concat('${tag}')">`;
      const evil = await post('/api/projects', { name: X('proj'), art_style: X('style'), aspect_ratio: '9:16 竖屏' });
      const pid = evil.id;
      await post(`/api/storyboards?project_id=${pid}`, { project_id: pid, shot_number: 1, scene_description: X('scene'), characters: X('chars'), dialogue: X('dlg'), shot_type: X('type'), image_prompt: X('iprompt'), video_prompt: X('vprompt') });
      await post('/api/scripts', { project_id: pid, title: X('script'), content: '正文里也有 ' + X('body'), script_type: 'story_concept' });
      await post('/api/images', { project_id: pid, name: X('assetname'), notes: X('notes'), url: '/assets/none.png' });
      await post('/api/templates', { name: X('tpl'), system: 's', content: '正文 {{变量}} 型' });
      for (const [hash, tag] of [['#/dashboard','dash'],['#/projects','projects'],[`#/storyboards?project=${pid}`,'sbs'],[`#/scripts?project=${pid}&tab=story_concept`,'scripts'],['#/assets','assets'],['#/settings?sec=template','settings']]) {
        await cdp.eval(`location.hash = '${hash}'; return true;`);
        await waitFor(() => cdp.eval(`!!document.querySelector('.page')`), `XSS 页 ${tag}`);
        await sleep(400);
      }
      const fired = await cdp.eval(`window.__xss || []`);
      ok('六页全渲染无脚本执行（注入向量×12）', !fired || fired.length === 0, JSON.stringify(fired));
      // 恶意值必须原样可见（esc 生效而非吞数据）
      await cdp.eval(`location.hash = '#/projects'; return true;`);
      await waitFor(() => cdp.eval(`document.querySelector('.page-title')?.textContent === '项目管理'`), 'XSS 回显检查');
      await sleep(300);
      ok('恶意字面量原样回显（转义非丢弃）', await cdp.eval(`document.body.innerText.includes('<img src=x onerror=')`));
      await cdp.eval(`location.hash = '#/storyboards?project=${pid}'; return true;`);
      await waitFor(() => cdp.eval(`document.body.innerText.includes('onerror=')`), '分镜毒数据可见');
      ok('分镜页毒字段确已渲染（非空跑）', await cdp.eval(`document.body.innerText.includes('<img src=x onerror=')`));
      await cdp.eval(`location.hash = '#/assets'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('.asset-card[data-id]')`), '素材卡出现');
      await cdp.eval(`(document.querySelector('.asset-card [data-zoom]')||document.querySelector('.asset-card')||{}).click?.(); return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('.modal')`), '素材详情弹窗');
      await sleep(300); // modal 入场动画
      const fired2 = await cdp.eval(`window.__xss || []`);
      ok('点开毒素材弹窗仍零执行', !fired2 || fired2.length === 0, JSON.stringify(fired2));
      ok('弹窗标题毒名称原样转义', await cdp.eval(`!!document.querySelector('.modal') && document.querySelector('.modal').innerText.includes('<img src=x onerror=')`));
      await cdp.eval(`document.querySelector('.modal [data-close]')?.click(); document.querySelector('.modal [data-discard]')?.click(); return true;`);
      await fetch(`http://127.0.0.1:${port}/api/projects/${pid}?cascade=1`, { method: 'DELETE' });
    }

    group('容量性能基线');
    {
      const sbs = Array.from({ length: 300 }, (_, i) => ({
        id: `perf_sb_${i}`, project_id: 'perf_proj', episode_number: (i % 10) + 1, shot_number: i + 1,
        shot_type: '特写', scene_description: `容量验证第 ${i} 镜：暴雨天台的长句描述用于贴近真实密度`, characters: '主角A', dialogue: '台词', duration_seconds: 4,
        image_prompt: 'cinematic shot prompt number ' + i, video_prompt: 'slow dolly in ' + i, status: 'pending',
      }));
      const imgs = Array.from({ length: 60 }, (_, i) => ({ id: `perf_img_${i}`, project_id: 'perf_proj', name: `容量图 ${i}`, url: '/assets/none.png', remote_url: '', local_file: '', usage_type: 'storyboard', generation_prompt: 'p', model_name: 'm', is_favorited: false, tags: [] }));
      const t0 = Date.now();
      const r = await fetch(`http://127.0.0.1:${port}/api/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'merge', data: { projects: [{ id: 'perf_proj', name: '容量验证剧', art_style: '日漫', aspect_ratio: '1:1 方形' }], storyboards: sbs, image_assets: imgs } }) });
      const j = await r.json();
      ok('360 行导入成功', j.ok === true && j.imported >= 360, JSON.stringify(j).slice(0, 120));
      const ta = Date.now();
      const apiR = await (await fetch(`http://127.0.0.1:${port}/api/storyboards?project_id=perf_proj&episode=1`)).json();
      ok('300 行接口查询 <800ms 且数据完整', Date.now() - ta < 800 && Array.isArray(apiR) && apiR.length === 30, JSON.stringify({ ms: Date.now() - ta, n: (apiR || []).length }));
      const paintMs = await cdp.eval(`
        const t0 = performance.now();
        location.hash = '#/storyboards?project=perf_proj&episode=1';
        while (performance.now() - t0 < 9000) {
          if (document.querySelectorAll('#table tbody tr').length >= 30) break;
          await new Promise((r) => setTimeout(r, 40));
        }
        return Math.round(performance.now() - t0);`);
      console.log(`  [容量] 分镜页 30 镜首绘 ${paintMs}ms（UI 按集分页，全表 300 行不存在单视图渲染）`);
      ok('分镜页单集 30 镜首绘 <3s', paintMs < 3000, `${paintMs}ms`);
      const assetMs = await cdp.eval(`
        const t0 = performance.now();
        location.hash = '#/assets';
        while (performance.now() - t0 < 9000) {
          if (document.querySelectorAll('.asset-card').length >= 60) break;
          await new Promise((r) => setTimeout(r, 40));
        }
        return Math.round(performance.now() - t0);`);
      console.log(`  [容量] 素材页 60 卡渲染 ${assetMs}ms`);
      ok('素材页 60 卡渲染 <3s', assetMs < 3000, `${assetMs}ms`);
      const heap = await cdp.eval(`performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : -1`);
      console.log(`  [容量] JS 堆 ${heap}MB`);
      ok('JS 堆占用 <250MB（渲染 300 行后）', heap < 250, `${heap}MB`);
    }

    group('全链路 E2E（mock 上游 × 真实 UI）');
    {
      const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      let mockHit = { img: 0, vid: 0, query: 0 };
      const mock = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (u.pathname === '/pixel.png') { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length }); return res.end(PNG); }
        if (u.pathname === '/done.mp4') { const b = Buffer.from('E2EMP4DATA'); res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': b.length }); return res.end(b); }
        let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
          if (u.pathname === '/v1/images/generations') { mockHit.img++; return send(200, { data: [{ url: `http://127.0.0.1:${mockPort}/pixel.png` }] }); }
          if (u.pathname === '/v1/videos') { mockHit.vid++; return send(200, { id: 'e2e_vid_1', status: 'queued' }); }
          if (u.pathname === '/agnesapi') { mockHit.query++; return send(200, { id: 'e2e_vid_1', status: 'completed', progress: 100, remixed_from_video_id: `http://127.0.0.1:${mockPort}/done.mp4` }); }
          return send(200, { ok: true });
        });
      });
      await new Promise((r) => mock.listen(0, '127.0.0.1', r));
      const mockPort = mock.address().port;
      try {
        const jset = await (await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agnes_api_base_url: `http://127.0.0.1:${mockPort}/v1`, agnes_api_key: 'e2e-mock-key', auto_download_video: '1', video_poll_interval: '2' }) })).json();
        ok('E2E mock 上游接入设置', jset.ok === true);
        const plist = await (await fetch(`http://127.0.0.1:${port}/api/projects`)).json();
        const pid = (plist.find((x) => x.name === '浏览器验收剧') || {}).id;
        const sb = await (await fetch(`http://127.0.0.1:${port}/api/storyboards`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: pid, episode_number: 1, shot_number: 77, scene_description: 'E2E 贯穿镜头', image_prompt: 'e2e image prompt', video_prompt: 'e2e video prompt', duration_seconds: 4 }) })).json();
        await cdp.eval(`location.hash = '#/storyboards?project=${pid}&episode=1'; return true;`);
        await waitFor(() => cdp.eval(`[...document.querySelectorAll('#table tbody tr')].some((tr)=>tr.innerText.includes('#77'))`), 'E2E 镜头行出现');
        await cdp.eval(`const tr=[...document.querySelectorAll('#table tbody tr')].find((t)=>t.innerText.includes('#77'));tr.querySelector('[data-img]').click();return true;`);
        await waitFor(async () => {
          const v = await (await fetch(`http://127.0.0.1:${port}/api/storyboards?project_id=${pid}&episode=1`)).json();
          const row = v.find((x) => x.shot_number === 77);
          return row && row.linked_image_id;
        }, 'UI 出图链落库', 20000);
        ok('E2E 一点出图：资产关联+mock 恰一发', mockHit.img === 1, JSON.stringify(mockHit));
        ok('出图后分镜状态推进', await (await fetch(`http://127.0.0.1:${port}/api/storyboards?project_id=${pid}&episode=1`)).json().then((v) => (v.find((x) => x.shot_number === 77) || {}).status === 'image_ready'));
        await cdp.eval(`const tr=[...document.querySelectorAll('#table tbody tr')].find((t)=>t.innerText.includes('#77'));tr.querySelector('[data-vid]').click();return true;`);
        await waitFor(() => cdp.eval(`location.hash.startsWith('#/tasks')`), 'E2E 提交后跳任务页', 10000);
        await waitFor(() => cdp.eval(`[...document.querySelectorAll('.task-row')].some((el)=>el.innerText.includes('e2e video prompt')&&el.innerText.includes('完成'))`), 'SSE 免刷新推进到完成（行级）', 25000);
        ok('E2E 出视频链贯通（提交→轮询→SSE 免刷新）', mockHit.vid === 1 && mockHit.query >= 1, JSON.stringify(mockHit));
        const vids = await (await fetch(`http://127.0.0.1:${port}/api/videos?project_id=${pid}`)).json();
        const mine = vids.find((v) => String(v.video_prompt).includes('e2e video prompt'));
        ok('自动下载落盘+状态双完成', !!mine && mine.status === 'completed' && mine.local_status === 'completed' && !!mine.local_file, JSON.stringify(mine && { s: mine.status, l: mine.local_status, f: !!mine.local_file }));
        await cdp.eval(`location.hash = '#/storyboards?project=${pid}&episode=1'; return true;`);
        await waitFor(() => cdp.eval(`[...document.querySelectorAll('#table tbody tr')].some((tr)=>tr.innerText.includes('#77')&&tr.innerText.includes('有视频'))`), '回分镜页见「有视频」回显');
        ok('E2E 终点：分镜行回显视频态', true);
        await cdp.eval(`location.hash = '#/assets?tab=video'; return true;`);
        const vsrc = await waitFor(() => cdp.eval(`(document.querySelector('video[src*="/assets/videos/"]') || {}).src || null`), '素材页视频本地播放源', 10000);
        ok('成片以本地文件回显（非远端 URL）', !!vsrc, String(vsrc).slice(0, 90));
        const serve = await fetch(vsrc);
        ok('本地视频静态服务可读', serve.ok && (await serve.arrayBuffer()).byteLength > 0, String(serve.status));
        await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agnes_api_key: '', video_poll_interval: '8' }) });
      } finally { mock.close(); }
    }

    group('批量队列 E2E（断页找回 + 取消）');
    {
      const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      let imgHits = 0;
      const mock = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/pixel.png') { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length }); return res.end(PNG); }
        let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
          if (u.pathname === '/v1/images/generations') { imgHits++; setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${bPort}/pixel.png` }] })); }, 300); return; }
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
        });
      });
      await new Promise((r) => mock.listen(0, '127.0.0.1', r));
      const bPort = mock.address().port;
      try {
        const J = (url, o) => fetch(`http://127.0.0.1:${port}${url}`, o).then((x) => x.json());
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agnes_api_base_url: `http://127.0.0.1:${bPort}/v1`, agnes_api_key: 'batch-mock-key', image_poll_interval: '2' }) });
        const pid = (await J('/api/projects')).find((x) => x.name === '浏览器验收剧').id;
        for (let i = 0; i < 16; i++) await J('/api/storyboards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: pid, episode_number: 42, shot_number: 4201 + i, scene_description: `批量 E2E 第 ${i} 镜`, image_prompt: `batch e2e prompt ${i}`, duration_seconds: 4 }) });
        await cdp.eval(`localStorage.removeItem('agnes.batch.last'); location.hash = '#/storyboards?project=${pid}&episode=42'; return true;`);
        await waitFor(() => cdp.eval(`document.querySelectorAll('#table tbody tr').length >= 16`), '批量镜头行齐');
        await cdp.eval(`const sa=document.querySelector('#sel-all');sa.checked=true;sa.dispatchEvent(new Event('change'));return true;`);
        await cdp.eval(`document.querySelector('#batch-img').click();return true;`);
        await sleep(400);
        const jobId = await cdp.eval(`return localStorage.getItem('agnes.batch.last');`);
        ok('提交后 BKEY 即写（找回凭证）', !!jobId && jobId !== 'null', String(jobId));
        await cdp.eval(`location.hash = '#/dashboard'; return true;`);
        await sleep(250);
        await cdp.eval(`location.hash = '#/storyboards?project=${pid}&episode=42'; return true;`);
        await waitFor(() => cdp.eval(`document.querySelector('#batch-bar')?.innerText.includes('批量生成图片')`), '断页找回进度条', 8000);
        ok('E7 断页找回：换页回来进度条续上', true);
        await waitFor(async () => { const j = await J(`/api/batch/${jobId}`); return j && j.status && j.status !== 'running'; }, '首批跑完', 25000);
        const j1 = await J(`/api/batch/${jobId}`);
        ok('16/16 全部成功', j1.done === 16 && j1.ok === 16, JSON.stringify({ d: j1.done, o: j1.ok, f: j1.fail }));
        const rows42 = (await J(`/api/storyboards?project_id=${pid}&episode=42`)).filter((r) => r.episode_number === 42);
        ok('批量出图逐行回写关联（16 镜 image_ready）', rows42.length === 16 && rows42.every((r) => r.linked_image_id && r.status === 'image_ready'));
        ok('BKEY 完结即清', (await cdp.eval(`return localStorage.getItem('agnes.batch.last');`)) === null);
        await cdp.eval(`document.querySelector('#batch-img').click();return true;`);
        await waitFor(() => cdp.eval(`!!document.querySelector('[data-cancel-batch]')`), '取消钮出现', 8000);
        const jobId2 = await cdp.eval(`return localStorage.getItem('agnes.batch.last');`);
        await cdp.eval(`document.querySelector('[data-cancel-batch]').click();return true;`);
        await waitFor(() => cdp.eval(`document.querySelector('#batch-bar')?.innerText.includes('已取消')`), '条上见已取消', 10000);
        const j2a = await J(`/api/batch/${jobId2}`);
        const hitsA = imgHits;
        await sleep(800);
        const j2b = await J(`/api/batch/${jobId2}`);
        ok('取消生效：job 停止且不再打新请求', j2b.status === 'cancelled' && j2b.done < 16 && imgHits === hitsA && j2b.done === j2a.done, JSON.stringify({ s: j2b.status, d: j2b.done, h: imgHits - hitsA }));
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agnes_api_key: '' }) });
        await cdp.eval(`location.hash = '#/dashboard'; return true;`); // 离开现场防 BKEY 残留干扰收尾
      } finally { mock.close(); }
    }

    group('创作链 E2E（拆镜→补提示词→出图→画风边界注入）');
    {
      const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      const SHOTS = { shots: [
        { shot_number: 1, shot_type: '特写', scene_description: '雨滴砸在天台栏杆', characters: ['林夕', '陈默'], action: '回头', dialogue: '你来了', narration: '', sound_effect: ['雨声', '雷鸣'], duration_seconds: 5, image_prompt: 'rain on rooftop close up', video_prompt: 'slow tilt up', negative_prompt: '' },
        { shot_number: 2, scene_description: '全景城市夜色' },
        { shot_number: 3, shot_type: '俯视', scene_description: '伞落在积水里', characters: '无人', image_prompt: 'umbrella in puddle top view' },
      ] };
      const cloudPrompts = [];
      const mock = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        const send = (o, ms) => setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); }, ms || 0);
        if (u.pathname === '/pixel.png') { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length }); return res.end(PNG); }
        let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
          const b = (() => { try { return JSON.parse(body); } catch { return {}; } })();
          if (u.pathname === '/v1/chat/completions') {
            const sys = String((b.messages || [{}])[0].content || '');
            return send(sys.includes('分镜导演') ? { choices: [{ message: { content: JSON.stringify(SHOTS) } }] } : { choices: [{ message: { content: 'e2e11 cinematic english prompt' } }] });
          }
          if (u.pathname === '/v1/images/generations') { cloudPrompts.push(String(b.prompt || '')); return send({ data: [{ url: `http://127.0.0.1:${cPort}/pixel.png` }] }, 200); }
          return send({ ok: true });
        });
      });
      await new Promise((r) => mock.listen(0, '127.0.0.1', r));
      const cPort = mock.address().port;
      try {
        const J = (url, o) => fetch(`http://127.0.0.1:${port}${url}`, o).then((x) => x.json());
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agnes_api_base_url: `http://127.0.0.1:${cPort}/v1`, agnes_api_key: 'chain-mock-key' }) });
        const pid = (await J('/api/projects')).find((x) => x.name === '浏览器验收剧').id;
        await J('/api/projects/' + pid, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ art_style: '水彩' }) });
        await cdp.eval(`localStorage.removeItem('agnes.batch.last'); location.hash = '#/storyboards?project=${pid}&episode=77'; return true;`);
        await waitFor(() => cdp.eval(`!!document.querySelector('#script-in')`), '拆镜输入框出现');
        await cdp.eval(`document.querySelector('#script-in').value = '暴雨夜。林夕站在天台，陈默从身后走来，说：你来了。'; document.querySelector('#gen-sb').click(); return true;`);
        await waitFor(async () => (await J(`/api/storyboards?project_id=${pid}&episode=77`)).length === 3, 'LLM 拆镜 3 镜入库', 15000);
        const rows = await J(`/api/storyboards?project_id=${pid}&episode=77`);
        const r1 = rows.find((x) => x.shot_number === 1), r2 = rows.find((x) => x.shot_number === 2);
        ok('拆镜数组字段拍平（characters/sound_effect 顿号连接）', r1.characters === '林夕、陈默' && r1.sound_effect === '雨声、雷鸣', JSON.stringify({ c: r1.characters, s: r1.sound_effect }));
        ok('缺字段兜底（默认中景 + 默认负面提示词）', r2.shot_type === '中景' && String(r2.negative_prompt).includes('low quality'), JSON.stringify({ t: r2.shot_type, n: r2.negative_prompt }));
        await cdp.eval(`document.querySelector('#gen-img-prompts').click(); return true;`);
        await waitFor(async () => { const rs = (await J(`/api/storyboards?project_id=${pid}&episode=77`)); return rs.length === 3 && rs.every((r) => String(r.image_prompt).trim().length > 0); }, '三镜提示词齐', 20000);
        const after = await J(`/api/storyboards?project_id=${pid}&episode=77`);
        const a1 = after.find((x) => x.shot_number === 1), a2 = after.find((x) => x.shot_number === 2);
        ok('批量补提示词精准补缺（已有提示词的镜不被覆写）', a2.image_prompt === 'e2e11 cinematic english prompt' && a1.image_prompt === 'rain on rooftop close up', JSON.stringify({ p1: a1.image_prompt, p2: a2.image_prompt }));
        await cdp.eval(`location.hash = '#/dashboard'; return true;`);
        await cdp.eval(`location.hash = '#/storyboards?project=${pid}&episode=77'; return true;`);
        await waitFor(() => cdp.eval(`document.querySelectorAll('#table tbody tr').length >= 3`), '回页行齐');
        await sleep(600); // load() 刷新行状态
        await cdp.eval(`document.querySelector('#batch-img').click(); return true;`);
        await waitFor(async () => cloudPrompts.length === 3, '云端收到 3 张出图请求', 25000);
        ok('B4 画风分层实证：3/3 云端 prompt 均带水彩短语且只注入一次', cloudPrompts.length === 3 && cloudPrompts.every((x) => x.includes('watercolor illustration') && x.indexOf('watercolor') === x.lastIndexOf('watercolor')), JSON.stringify(cloudPrompts[0] || '').slice(0, 140));
        await waitFor(async () => (await J(`/api/storyboards?project_id=${pid}&episode=77`)).every((r) => r.status === 'image_ready' && r.linked_image_id), '3 镜出图关联回写', 25000);
        ok('创作链终点：3 镜全部 image_ready', true);
        await waitFor(() => cdp.eval(`const trs=[...document.querySelectorAll('#table tbody tr')];return trs.length === 3 && trs.filter((t)=>t.innerText.includes('e2e11')).length === 1 && trs.every((t)=>t.innerText.includes('有图片'));`), '回显就位（补缺 1 镜 + 3 镜有图片）', 10000);
        ok('回显：唯一缺提示词的镜补上 mock 文本，3 镜全亮「有图片」', true);
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agnes_api_key: '' }) });
        await J('/api/storyboards/batch-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: rows.map((r) => r.id) }) }).catch(() => {});
        await cdp.eval(`location.hash = '#/dashboard'; return true;`);
      } finally { mock.close(); }
    }

    group('脚本页生成-保存链 E2E');
    {
      const mock = http.createServer((req, res) => {
        let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: 'E12概念产出：末世题材，少年漫主角觉醒。' } }] }));
        });
      });
      await new Promise((r) => mock.listen(0, '127.0.0.1', r));
      const kPort = mock.address().port;
      try {
        const J = (url, o) => fetch(`http://127.0.0.1:${port}${url}`, o).then((x) => x.json());
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agnes_api_base_url: `http://127.0.0.1:${kPort}/v1`, agnes_api_key: 'e12-key' }) });
        const pid = (await J('/api/projects')).find((x) => x.name === '浏览器验收剧').id;
        await cdp.send('Page.reload', {}); await sleep(900); // 让前端 state.settings 吸收新 Key（真实用户是在设置页保存的，天然新鲜）
        await cdp.eval(`location.hash = '#/scripts?project=${pid}&tab=story_concept'; return true;`);
        await waitFor(() => cdp.eval(`document.querySelectorAll('#fields input, #fields textarea').length >= 1`), '模板字段渲染');
        await cdp.eval(`document.querySelectorAll('#fields input, #fields textarea').forEach((el)=>{el.value='末世少年';el.dispatchEvent(new Event('input',{bubbles:true}));}); document.querySelector('#gen').click(); return true;`);
        await waitFor(() => cdp.eval(`!!document.querySelector('#r-out') && document.querySelector('#r-out').innerText.includes('E12概念产出')`), '生成结果卡回显', 15000)
        await cdp.eval(`document.querySelector('#r-save').click(); return true;`);
        await waitFor(async () => { const ss = await J(`/api/scripts?project_id=${pid}`); return ss.some((x) => String(x.content).includes('E12概念产出')); }, '脚本入库', 10000);
        ok('脚本生成→保存全链贯通（模板变量→LLM→入库）', true);
        await waitFor(() => cdp.eval(`document.querySelector('#saved').innerText.includes('故事构思')`), '已保存列表回显', 8000);
        ok('已保存列表同步回显', true);
        const ss = await J(`/api/scripts?project_id=${pid}`);
        const mine = ss.find((x) => String(x.content).includes('E12概念产出'));
        await fetch(`http://127.0.0.1:${port}/api/scripts/${mine.id}`, { method: 'DELETE' });
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agnes_api_key: '' }) });
      } finally { mock.close(); }
    }
    group('F5 深链复原（boot 竞态）');
    {
      const J = (url) => fetch(`http://127.0.0.1:${port}${url}`).then((x) => x.json());
      const pid = (await J('/api/projects')).find((x) => x.name === '浏览器验收剧').id;
      await cdp.eval(`location.hash = '#/storyboards?project=${pid}'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('#p-picker, select')`), '分镜页初始就绪');
      await cdp.send('Page.reload', {});
      await sleep(900);
      const boot = await cdp.eval(`({hash: location.hash, hasTable: !!document.querySelector('#table') && document.querySelectorAll('#table tbody tr').length, empty: document.body.innerText.includes('请先选择项目')})`);
      ok('F5 后深链参数保留且项目不错位', String(boot.hash).includes(`#/storyboards?project=${pid}`) && !boot.empty, JSON.stringify(boot));
    }

    group('弹窗键盘行为（焦点陷阱 / ESC / Ctrl+Enter）');
    {
      const Jget = (u) => fetch(`http://127.0.0.1:${port}${u}`).then((x) => x.json());
      const pid = (await Jget('/api/projects')).find((x) => x.name === '浏览器验收剧').id;
      await cdp.eval(`location.hash = '#/storyboards?project=${pid}'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('[data-edit]')`), '编辑钮就绪');
      const key = (k, code, mods) => {
        cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers: mods || 0 });
        cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers: mods || 0 });
      };
      await cdp.eval(`document.querySelector('[data-edit]').click(); return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('.modal-mask')`), '编辑弹窗打开');
      const a1 = await cdp.eval(`({tag:document.activeElement.tagName, inMask:!!document.activeElement.closest('.modal-mask'), locked:document.body.classList.contains('modal-open')})`);
      ok('自动聚焦进表单且页面锁滚动', ['INPUT', 'TEXTAREA', 'SELECT'].includes(a1.tag) && a1.inMask && a1.locked, JSON.stringify(a1));
      await cdp.eval(`document.activeElement.blur(); return true;`); // 焦点丢到体外
      for (let i = 0; i < 3; i++) { key('Tab', 'Tab'); await sleep(60); }
      ok('Tab 回捕：焦点曾逸出仍被拉回弹窗', await cdp.eval(`!!document.activeElement.closest('.modal-mask')`));
      for (let i = 0; i < 15; i++) { key('Tab', 'Tab'); await sleep(50); }
      ok('Tab×15 不逃出焦点陷阱', await cdp.eval(`!!document.activeElement.closest('.modal-mask')`));
      await cdp.eval(`({tag:document.activeElement.tagName})`);
      key('Escape', 'Escape');
      await waitFor(() => cdp.eval(`!document.querySelector('.modal-mask')`), 'ESC 关闭弹窗', 6000);
      await sleep(250);
      ok('ESC 关闭且解锁滚动', await cdp.eval(`!document.body.classList.contains('modal-open')`));
      await cdp.eval(`document.querySelector('[data-edit]').click(); return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('.modal-mask')`), '二开弹窗');
      key('Enter', 'Enter', 2); // Ctrl+Enter
      await waitFor(() => cdp.eval(`!document.querySelector('.modal-mask')`), 'Ctrl+Enter 提交关闭', 6000);
      ok('Ctrl+Enter 走主按钮提交路径', true);
      await cdp.eval(`location.hash = '#/dashboard'; return true;`);
    }

    group('设置页写入回环（最后未穿的交互页）');
    {
      await cdp.eval(`location.hash = '#/settings?sec=task'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('#t-interval')`), '任务参数区就绪');
      await cdp.eval(`document.querySelector('#t-interval').value = '6'; document.querySelector('#save-task').click(); return true;`);
      await waitFor(async () => { const g = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json(); return Number((g.data || g).video_poll_interval) === 6; }, '轮询间隔落库=6', 8000);
      ok('数值字段 UI→PUT→落库回环', true);
      await cdp.eval(`document.querySelector('#t-auto').click(); document.querySelector('#save-task').click(); return true;`);
      await waitFor(async () => { const g = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json(); const v = (g.data || g).auto_download_video; return v === '0' || v === '1'; }, '开关翻转落库', 8000);
      const g2 = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json();
      const adv = (g2.data || g2).auto_download_video;
      await cdp.eval(`location.hash = '#/dashboard'; return true;`);
      await cdp.eval(`location.hash = '#/settings?sec=task'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('#t-auto')`), '重进任务区');
      ok('重进页面控件与库值同步（读回显示）', await cdp.eval(`document.querySelector('#t-interval').value === '6' && document.querySelector('#t-auto').classList.contains('on') === (${adv === '1'})`), String(adv));
      await cdp.eval(`document.querySelector('#t-interval').value = '8'; document.querySelector('#save-task').click(); return true;`); // 复原默认
      await sleep(300);
    }

    group('页面挂载矩阵（9 页真机冒烟）');
    {
      // 覆盖空洞：browser-test 历史上只走 7 条路由，#/images 与 #/videos 从未真机挂载
      const Jget = (u) => fetch(`http://127.0.0.1:${port}${u}`).then((x) => x.json());
      const pid = (await Jget('/api/projects')).find((x) => x.name === '浏览器验收剧').id;
      const pages = [
        ['工作台', '#/dashboard', '#stats'],
        ['项目管理', '#/projects', '#list'],
        ['剧本', '#/scripts', '#fields'],
        ['分镜', '#/storyboards', '#table'],
        ['图片生成', '#/images', '#model'],
        ['视频生成', '#/videos', '#model'],
        ['任务', '#/tasks', '#tabs'],
        ['素材', '#/assets', '#tabs'],
        ['设置', '#/settings', '#panel'],
      ];
      const errs = [];
      for (const [name, route, anchorSel] of pages) {
        await cdp.eval(`location.hash = '${route}?project=${pid}'; return true;`);
        const mounted = await waitFor(
          () => cdp.eval(`return !!document.querySelector('${anchorSel}') && (document.querySelector('#view') || {}).innerHTML.length > 200;`),
          `${name} 挂载`, 12000,
        ).then(() => true).catch(() => false);
        ok(`页面「${name}」真机挂载（${anchorSel} 就绪且内容非空）`, mounted);
        const n = await cdp.eval(`return (window.__uiErrors || []).length;`);
        if (n > 0) errs.push(`${name}×${n}`);
      }
      ok('9 页挂载全程无未捕获异常', errs.length === 0, errs.join(',') || 'clean');
      // 两页补强：控件必须真的渲染出来（此前无任何真机断言）
      for (const [name, route] of [['图片生成', '#/images'], ['视频生成', '#/videos']]) {
        await cdp.eval(`location.hash = '${route}?project=${pid}'; return true;`);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#model');`), `${name} 模型选择器`, 10000);
        const st = await cdp.eval(`return (() => { const m = document.querySelector('#model'); return { opts: m ? m.options.length : -1, mode: !!document.querySelector('#mode'), reload: !!document.querySelector('#reload') }; })();`);
        ok(`「${name}」控件齐备（模型下拉有项 / 模式 / 刷新）`, st.opts > 0 && st.mode && st.reload, JSON.stringify(st));
      }
      await cdp.eval(`location.hash = '#/dashboard'; return true;`);
    }

    group('失败恢复契约（M8：断连不得锁死按钮）');
    {
      // 慢失败上游：1.2s 后 500——给 busy 态留出确定性观测窗口
      const mock = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const u = new URL(req.url, 'http://x');
          if (u.pathname.endsWith('/images/generations')) {
            setTimeout(() => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'probe upstream down' } })); }, 1200);
            return;
          }
          res.writeHead(404); res.end('{}');
        });
      });
      await new Promise((r) => mock.listen(0, '127.0.0.1', r));
      const mockPort = mock.address().port;
      const Jget = (u) => fetch(`http://127.0.0.1:${port}${u}`).then((x) => x.json());
      const busySel = `return (() => { const b = document.querySelector('[data-img]'); return !!b && b.dataset.busy === '1'; })();`;
      const idleSel = `return (() => { const b = document.querySelector('[data-img]'); return !!b && b.dataset.busy !== '1' && !b.disabled; })();`;
      try {
        const pid = (await Jget('/api/projects')).find((x) => x.name === '浏览器验收剧').id;
        const shot = await fetch(`http://127.0.0.1:${port}/api/storyboards`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: pid, episode_number: 88, shot_number: 881, image_prompt: 'fail recovery probe', video_prompt: 'fail recovery probe' }) }).then((r) => r.json());
        ok('失败探针镜头已建', !!shot.id);
        await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agnes_api_base_url: `http://127.0.0.1:${mockPort}/v1`, agnes_api_key: 'probe-key' }) });
        await cdp.send('Page.reload', {}); await sleep(900);
        await cdp.eval(`location.hash = '#/storyboards?project=${pid}&episode=88'; return true;`);
        await waitFor(() => cdp.eval(`!!document.querySelector('[data-img]')`), '失败探针镜头行就绪');
        await cdp.eval(`document.querySelector('[data-img]').click(); return true;`);
        const sawBusy = await waitFor(() => cdp.eval(busySel), '提交态置位', 8000).then(() => true).catch(() => false);
        ok('点击后进入提交态（busy 置位）', sawBusy);
        await waitFor(() => cdp.eval(idleSel), '失败后按钮自动解锁', 20000);
        const st = await cdp.eval(`return (() => { const b = document.querySelector('[data-img]'); return { busy: b.dataset.busy || '', disabled: !!b.disabled, title: b.getAttribute('title') || '', errToast: !!document.querySelector('.toast.err') }; })();`);
        ok('解锁后无残留 busy/disabled', st.busy !== '1' && !st.disabled, JSON.stringify(st));
        ok('title 复原（未卡在等待文案）', !String(st.title).includes('耐心等待'), String(st.title));
        ok('失败对用户可见（错误提示）', !!st.errToast);
        await cdp.eval(`document.querySelector('[data-img]').click(); return true;`);
        const again = await waitFor(() => cdp.eval(busySel), '可二次提交', 8000).then(() => true).catch(() => false);
        ok('解锁后可重试（二次点击再次进入提交态）', again);
        await waitFor(() => cdp.eval(idleSel), '二次失败后仍解锁', 20000);
        const rec = await Jget(`/api/storyboards?project_id=${pid}&episode=88`);   // 裸数组：路由返回值原样发出，无统一信封
        ok('失败未污染数据（镜头仍在且无图）', Array.isArray(rec) && rec.some((r) => r.id === shot.id && !r.linked_image_id), `type=${Array.isArray(rec) ? 'array' : typeof rec} n=${Array.isArray(rec) ? rec.length : '-'}`);
      } finally {
        await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agnes_api_base_url: '', agnes_api_key: '' }) });
        mock.close();
        await cdp.send('Page.reload', {}); await sleep(700);
        await cdp.eval(`location.hash = '#/dashboard'; return true;`);
      }
    }

    const collected = await cdp.eval(`({hookLive: Array.isArray(window.__uiErrors), errors: window.__uiErrors || [], rejects: window.__uiRejects || []})`);
    ok('异常钩子存活（自证非空跑：reload 后仍可捕获）', collected?.hookLive === true, JSON.stringify(collected));
    ok('无 window error', collected?.errors?.length === 0, JSON.stringify(collected?.errors || []));
    ok('无未处理 Promise 拒绝', collected?.rejects?.length === 0, JSON.stringify(collected?.rejects || []));
    // 正向对照：证明"检测器能检测"——故意抛错必须被捕获，否则上面的绿是空跑
    await cdp.eval(`setTimeout(() => { throw new Error('__hook_probe__'); }, 0); return true;`);
    await sleep(400);
    const probe = await cdp.eval(`return (window.__uiErrors || []).some((m) => String(m).includes('__hook_probe__'));`);
    ok('异常钩子正向对照（故意抛错必须被捕获）', probe === true);
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
