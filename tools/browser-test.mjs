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
