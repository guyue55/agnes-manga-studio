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
      // 捕获 EventSource 实例：供测试向应用合成 SSE 事件（观测陈旧监听器泄漏）
      window.__esRefs = [];
      try {
        const OrigES = window.EventSource;
        const WrappedES = function (...a) { const es = new OrigES(...a); window.__esRefs.push(es); return es; };
        WrappedES.prototype = OrigES.prototype;
        ['CONNECTING', 'OPEN', 'CLOSED'].forEach((k) => { WrappedES[k] = OrigES[k]; });
        window.EventSource = WrappedES;
      } catch { /* ignore */ }
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
    // 两段式就地确认：首点 armed 改文案，3s 后自动回弹（不真删）。
    // 旧写法是 if (有模板) 才测、否则 ok('跳过', true) —— 条件跳过式假绿（无模板时"绿"了什么都没验）；
    // 改为先经 API 确定性建模板，让该分支必跑，并显式断言按钮存在。
    const tpl = await fetch(`http://127.0.0.1:${port}/api/templates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '两段式探针模板', template_type: 'story_concept', content: '探针内容' }),
    }).then((x) => x.json());
    ok('两段式探针模板已建', !!tpl.id, JSON.stringify(tpl).slice(0, 70));
    // 设置页在模板创建前就已挂载，其列表是旧的——必须重载页面让新模板进列表
    await cdp.send('Page.reload', {}); await sleep(900);
    await cdp.eval(`location.hash = '#/settings'; return true;`);
    await waitFor(() => cdp.eval(`!!document.querySelector('[data-sec="templates"]')`), '设置页重新就绪');
    await cdp.eval(`document.querySelector('[data-sec="templates"]').click(); return true;`); // 分节 id 是 templates（复数）：原测试写 template 且用 ?. 静默跳过，两条断言从未跑过
    await waitFor(() => cdp.eval(`!!document.querySelector('[data-del="${tpl.id}"]')`), '探针模板删除钮出现（不再条件跳过）');
    const delSel = `[data-del="${tpl.id}"]`; // 必须按 id 定位：页面上还有内置模板，取第一个会删错对象
    await cdp.eval(`document.querySelector('${delSel}').click(); return true;`);
    ok('两段式：首点进入确认态', await cdp.eval(`!!document.querySelector('${delSel}.armed')`));
    ok('两段式：首点未删除（按钮仍在）', await cdp.eval(`!!document.querySelector('${delSel}')`));
    await sleep(3500);
    ok('两段式：3s 后自动回弹（未误删）', await cdp.eval(`!document.querySelector('${delSel}.armed') && !!document.querySelector('${delSel}')`));
    // 另一半：窗口内第二击必须真的执行（否则守卫会变成"永远删不掉"）
    await cdp.eval(`const b=document.querySelector('${delSel}'); b.click(); b.click(); return true;`);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/templates`).then((x) => x.json())).every((t) => t.name !== '两段式探针模板'), '模板被真的删除', 8000);
    ok('两段式：窗口内第二击真的执行删除', true);
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

    group('宣告与图像替代文本契约（A11y：live region 与 img alt）');
    {
      // ① 反馈层必须能被屏幕阅读器宣告（此前整个 toast 层无 live region → 完全静默）
      const live = await cdp.eval(`const w = document.getElementById('toasts'); return w ? { role: w.getAttribute('role'), live: w.getAttribute('aria-live') } : null;`);
      ok('toast 容器是 live region', !!live && live.role === 'status' && live.live === 'polite', JSON.stringify(live));
      // 真机触发一条成功/一条错误 toast，断言内容确实进了 live region 且错误提为 alert
      await cdp.eval(`const m = await import('/js/ui.js'); m.toast.ok('宣告探针成功'); return true;`);
      await cdp.eval(`const m = await import('/js/ui.js'); m.toast.err('宣告探针失败'); return true;`);
      await sleep(250);
      const t = await cdp.eval(`const els = Array.from(document.querySelectorAll('#toasts .toast'));
        return { n: els.length, okRole: (els.find((e) => e.textContent.includes('宣告探针成功')) || {}).getAttribute ? els.find((e) => e.textContent.includes('宣告探针成功')).getAttribute('role') : '', errRole: (els.find((e) => e.textContent.includes('宣告探针失败')) || {}).getAttribute ? els.find((e) => e.textContent.includes('宣告探针失败')).getAttribute('role') : '', atomic: els.length ? els[0].getAttribute('aria-atomic') : '' };`);
      ok('toast 内容进入 live region 且成功=status', t.n >= 2 && t.okRole === 'status', JSON.stringify(t));
      ok('错误 toast 提为 alert（强宣告）', t.errRole === 'alert' && t.atomic === 'true', JSON.stringify(t));
      await cdp.eval(`document.querySelectorAll('#toasts .toast').forEach((e) => e.click()); return true;`);
      await sleep(400);
      // ② img 必须有 alt（无 alt 的图片会被读成文件名/URL）——逐页真机清点
      // 本钉要自证"确实扫到了图片"，故先建一张**可加载**的 fixture。
      // 不能用 /assets/none.png 之类的坏链：加载失败会被 imgWithFallback 换成占位块，反而扫不到 <img>。
      const altFix = await (await fetch(`http://127.0.0.1:${port}/api/images`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: pid, name: 'alt 扫描 fixture', usage_type: 'storyboard', generation_prompt: 'probe',
          url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' }),
      })).json();
      ok('alt 扫描 fixture 已建（自证非空跑）', !!altFix.id, JSON.stringify(altFix).slice(0, 60));
      const pages3 = ['#/dashboard', '#/projects', '#/scripts', '#/storyboards', '#/images', '#/videos', '#/tasks', '#/assets'];
      const noAlt = [];
      let imgTotal = 0;
      for (const h of pages3) {
        await cdp.eval(`location.hash = ${JSON.stringify(h)}; return true;`);
        await sleep(550);
        const res = await cdp.eval(`const imgs = Array.from(document.querySelectorAll('img'));
          return { total: imgs.length, bad: imgs.filter((i) => !i.hasAttribute('alt')).map((i) => String(i.getAttribute('src')).slice(0, 40)) };`);
        imgTotal += res.total;
        if (res.bad.length) noAlt.push(`${h}: ${res.bad.join(' | ')}`);
      }
      ok('页面内所有 img 都有 alt 属性', noAlt.length === 0, noAlt.join(' || '));
      // 灵敏度对照：确实有图片被扫到（否则本钉等于空跑）
      ok('确实扫到了图片（自证非空跑）', imgTotal > 0, `img 总数=${imgTotal}`);
      await fetch(`http://127.0.0.1:${port}/api/images/${altFix.id}`, { method: 'DELETE' }).catch(() => {});
      // 灵敏度对照：无 alt 的图片确实会被检出（证明探测有效）
      const ctrl = await cdp.eval(`const i = document.createElement('img'); i.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='; document.body.appendChild(i); const bad = !i.hasAttribute('alt'); i.remove(); return bad;`);
      ok('灵敏度对照：无 alt 的图片会被检出', ctrl === true);
      // 条件渲染路径（弹窗预览图）默认态扫不到，必须真的打开弹窗再查——首版扫描正因此漏过一处
      // 前面的组已清理图片 fixture，故自建一张（否则本钉会因空态静默跳过）
      const altImg = await (await fetch(`http://127.0.0.1:${port}/api/images`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: pid, name: 'alt 探针图', usage_type: 'storyboard', generation_prompt: 'probe', url: '/assets/none.png' }),
      })).json();
      ok('alt 探针图片已建（自证非空跑）', !!altImg.id, JSON.stringify(altImg).slice(0, 60));
      await cdp.eval(`location.hash = '#/assets'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('[data-zoom]')`), '图片预览钮出现');
      await cdp.eval(`document.querySelector('[data-zoom]').click(); return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('#modal-root img')`), '预览弹窗图片');
      ok('弹窗预览图也带 alt（条件渲染路径）', await cdp.eval(`return Array.from(document.querySelectorAll('#modal-root img')).every((i) => i.hasAttribute('alt'));`));
      await cdp.eval(`const x = document.querySelector('#modal-root [data-close]'); if (x) x.click(); return true;`);
      await fetch(`http://127.0.0.1:${port}/api/images/${altImg.id}`, { method: 'DELETE' }).catch(() => {});
    }

    group('弹窗内可达名契约（A11y：模态表单同样必须有可访问名称）');
    {
      // 起因：表单可达名扫描在无弹窗时运行，弹窗内控件从未被扫到（B44 的范围漏洞）
      const NAME = `(el) => {
        const al = el.getAttribute('aria-label'); if (al && al.trim()) return al.trim();
        const lb = (el.labels && el.labels.length) ? Array.from(el.labels).map((l) => l.textContent).join(' ') : '';
        if (lb.trim()) return lb.trim();
        const t = el.getAttribute('title'); if (t && t.trim()) return t.trim();
        return (el.textContent || '').trim();
      }`;
      const sweepModal = () => cdp.eval(`const name = ${NAME};
        const m = document.querySelector('.modal-mask');
        if (!m) return null;
        const els = Array.from(m.querySelectorAll('input, select, textarea, [role=switch], button, a[href]')).filter((e) => e.type !== 'hidden');
        return { n: els.length, bad: els.filter((e) => !name(e)).map((e) => e.id || (e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).split(' ')[0] : ''))) };`);
      const closeAll = async () => {
        await cdp.eval(`const x = document.querySelector('.modal-mask [data-close]'); if (x) x.click(); return true;`);
        await sleep(220);
        await cdp.eval(`document.querySelectorAll('.modal-mask').forEach((m) => m.remove()); return true;`); // 脏守卫可能再叠一层
        await sleep(150);
      };
      const checkForm = async (label, openJs) => {
        await cdp.eval(`${openJs} return true;`);
        await waitFor(() => cdp.eval(`!!document.querySelector('.modal-mask')`), `${label}弹窗`);
        const res = await sweepModal();
        ok(`${label}内控件都有可访问名称`, !!res && res.n > 3 && res.bad.length === 0, JSON.stringify(res));
        await closeAll();
      };
      await cdp.eval(`location.hash = '#/projects'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('#new-project')`), '项目页就绪');
      await checkForm('新建项目表单', `document.querySelector('#new-project').click();`);
      await checkForm('编辑项目表单', `document.querySelector('[data-act="edit"]').click();`);
      await cdp.eval(`location.hash = '#/settings?sec=templates'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('#t-new')`), '模板分节就绪');
      await checkForm('新建模板表单', `document.querySelector('#t-new').click();`);
      // 灵敏度对照：往弹窗里注入一个无名控件，扫描必须检出（证明上面的绿不是空跑）
      await cdp.eval(`document.querySelector('#t-new').click(); return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('.modal-mask')`), '对照弹窗');
      const ctrl = await cdp.eval(`const m = document.querySelector('.modal-mask'); const i = document.createElement('input'); i.type = 'text'; i.className = 'input'; m.querySelector('.modal-body').appendChild(i); return true;`);
      void ctrl;
      const res2 = await sweepModal();
      ok('灵敏度对照：弹窗内无名控件会被检出', !!res2 && res2.bad.length === 1, JSON.stringify(res2));
      await closeAll();
    }

    group('键盘可达契约（A11y：可点卡片必须能键盘操作）');
    {
      const J = (u, o) => fetch(`http://127.0.0.1:${port}${u}`, o).then((x) => x.json());
      const pid = (await J('/api/projects')).find((x) => x.name === '浏览器验收剧').id;
      // 工作台最近项目卡：内部无按钮 → 应整卡可键盘操作
      await cdp.eval(`location.hash = '#/dashboard'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('.proj-card[data-pid]')`), '工作台项目卡出现');
      ok('可点卡片可聚焦（tabIndex=0）', (await cdp.eval(`const c = document.querySelector('.proj-card[data-pid]'); return c ? c.tabIndex : -1;`)) === 0);
      ok('可点卡片有 role=button（屏幕阅读器可识别）', (await cdp.eval(`const c = document.querySelector('.proj-card[data-pid]'); return c ? c.getAttribute('role') : '';`)) === 'button');
      // 键盘 Enter 必须真的进入（不是只加了个属性）
      await cdp.eval(`location.hash = '#/dashboard'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('.proj-card[data-pid]')`), '工作台项目卡就绪');
      await cdp.eval(`const c = document.querySelector('.proj-card[data-pid]'); c.focus(); c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true;`);
      await sleep(700);
      ok('按 Enter 真的进入项目（键盘可用）', (await cdp.eval(`location.hash`)).includes('/storyboards'), await cdp.eval(`location.hash`));
      // 灵敏度对照：无关按键不得触发（证明不是"任意键都进"）
      await cdp.eval(`location.hash = '#/dashboard'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('.proj-card[data-pid]')`), '工作台项目卡就绪');
      await cdp.eval(`const c = document.querySelector('.proj-card[data-pid]'); c.focus(); c.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })); return true;`);
      await sleep(600);
      ok('灵敏度对照：无关按键不触发跳转', (await cdp.eval(`location.hash`)).includes('/dashboard'), await cdp.eval(`location.hash`));
      // 素材页文本卡：卡内有按钮，故不给整卡 role=button，而是提供显式「查看全文」按钮
      const sc = await J('/api/scripts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: pid, title: '键盘可达探针脚本', script_type: 'concept', content: '探针内容' }) });
      ok('键盘探针脚本已建', !!sc.id, JSON.stringify(sc).slice(0, 60));
      await cdp.eval(`location.hash = '#/assets'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('[data-tab="text"]')`), '素材页就绪');
      await cdp.eval(`document.querySelector('[data-tab="text"]').click(); return true;`); // 文本素材在独立 tab 下
      await waitFor(() => cdp.eval(`!!document.querySelector('[data-view]')`), '文本卡查看按钮出现');
      ok('文本卡有显式「查看全文」按钮（键盘可达）', await cdp.eval(`!!document.querySelector('[data-view][aria-label="查看全文"]')`));
      ok('含按钮的卡片不得再标 role=button（避免按钮嵌套）', (await cdp.eval(`const c = document.querySelector('[data-sid]'); return c ? c.getAttribute('role') : 'NO_CARD';`)) === null);
      await cdp.eval(`document.querySelector('[data-view]').click(); return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('#modal-root .modal')`), '查看全文弹窗');
      ok('点「查看全文」打开弹窗', await cdp.eval(`!!document.querySelector('#modal-root .modal')`));
      await cdp.eval(`const x = document.querySelector('#modal-root [data-close]'); if (x) x.click(); return true;`);
      await J(`/api/scripts/${sc.id}`, { method: 'DELETE' }).catch(() => {});
    }

    group('表单可达名契约（A11y：控件必须有可访问名称）');
    {
      const NAME_FN = `(el) => {
        const al = el.getAttribute('aria-label'); if (al && al.trim()) return al.trim();
        const lb = (el.labels && el.labels.length) ? Array.from(el.labels).map((l) => l.textContent).join(' ') : '';
        if (lb.trim()) return lb.trim();
        const t = el.getAttribute('title'); if (t && t.trim()) return t.trim();
        return (el.textContent || '').trim();
      }`;
      const pages2 = ['#/dashboard', '#/projects', '#/scripts', '#/storyboards', '#/images', '#/videos', '#/tasks', '#/assets', '#/settings'];
      const unnamed = [];
      let total = 0;
      for (const h of pages2) {
        await cdp.eval(`location.hash = ${JSON.stringify(h)}; return true;`);
        await waitFor(() => cdp.eval(`!!document.querySelector('.page')`), `页面就绪 ${h}`); // 裸表达式：带 return 的 body 必须含分号，否则被包成 return(return …) → SyntaxError 被 waitFor 吞成静默超时
        await sleep(500);
        const res = await cdp.eval(`const name = ${NAME_FN};
          // 整篇文档（含侧栏/页头）——首版只扫 .page，侧栏导航与折叠钮从未被覆盖
          const els = Array.from(document.querySelectorAll('input, select, textarea, [role=switch], button, a[href]'))
            .filter((e) => e.type !== 'hidden');
          const bad = els.filter((e) => !name(e)).map((e) => (e.id || e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).split(' ')[0] : '')));
          return { total: els.length, bad };`);
        total += res.total;
        if (res.bad.length) unnamed.push(`${h}: ${res.bad.join(', ')}`);
      }
      // 设置页一次只渲染一个分节，必须逐节遍历，否则多数控件根本没被扫到（首版即漏）
      await cdp.eval(`location.hash = '#/settings'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('[data-sec]')`), '设置页就绪');
      const secs = await cdp.eval(`return Array.from(document.querySelectorAll('[data-sec]')).map((b) => b.getAttribute('data-sec'));`);
      for (const sec of secs) {
        await cdp.eval(`document.querySelector('[data-sec="${sec}"]').click(); return true;`);
        await sleep(450);
        const res = await cdp.eval(`const name = ${NAME_FN};
          // 整篇文档（含侧栏/页头）——首版只扫 .page，侧栏导航与折叠钮从未被覆盖
          const els = Array.from(document.querySelectorAll('input, select, textarea, [role=switch], button, a[href]'))
            .filter((e) => e.type !== 'hidden');
          const bad = els.filter((e) => !name(e)).map((e) => (e.id || e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).split(' ')[0] : '')));
          return { total: els.length, bad };`);
        total += res.total;
        if (res.bad.length) unnamed.push(`#/settings?sec=${sec}: ${res.bad.join(', ')}`);
      }
      ok('所有表单控件都有可访问名称', unnamed.length === 0, unnamed.join(' | '));
      ok('确实扫到了表单控件（自证非空跑）', total > 20, `控件总数=${total}`);
      // for 关联的实用价值：点标签应把焦点交给控件（鼠标用户也受益）
      await cdp.eval(`document.querySelector('[data-sec="api"]').click(); return true;`);
      await sleep(400);
      const focusId = await cdp.eval(`const l = document.querySelector('label[for="s-base"]'); if (!l) return 'NO_LABEL'; l.click(); return document.activeElement ? document.activeElement.id : '';`);
      ok('点标签可聚焦关联控件（for 生效的实用价值）', focusId === 's-base', String(focusId));
      // 灵敏度对照：无 for 的等价标记点击后不会聚焦（证明上条不是"点什么都会聚焦"）
      const ctrlId = await cdp.eval(`const d = document.createElement('div'); d.innerHTML = '<label>x</label><input id="__inp">'; document.body.appendChild(d); d.querySelector('label').click(); const got = document.activeElement ? document.activeElement.id : ''; d.remove(); return got;`);
      ok('灵敏度对照：无 for 的标签点击不聚焦（探测有效）', ctrlId !== '__inp', String(ctrlId));
      // 当前页必须可被 AT 识别（此前只有视觉 .active）
      await cdp.eval(`location.hash = '#/videos'; return true;`);
      await sleep(600); // 导航恒在，直接断言即可（用 waitFor 会让缺失退化成超时异常，不如断言信息精确）
      const cur = await cdp.eval(`const a = Array.from(document.querySelectorAll('.nav-item[aria-current="page"]'));
        return { n: a.length, nav: a.length ? a[0].getAttribute('data-nav') : '', active: a.length ? a[0].classList.contains('active') : false };`);
      ok('当前页有且仅有一个 aria-current=page 且与视觉 .active 一致', cur.n === 1 && cur.nav === 'videos' && cur.active === true, JSON.stringify(cur));
    }

    group('转义汇点契约（XSS：共享字符串汇点必须转义）');
    {
      // 静态审计（第 62 轮）结论：toast/errBox/options/modal.title 四个共享汇点均 esc；
      // 但此前只有"页面数据渲染"被 XSS 组覆盖，汇点自身没有直接钉——本组补上行为级验证。
      await cdp.eval(`window.__xssSink = []; return true;`);
      const call = (js) => cdp.eval(`return (async () => { const m = await import('/js/ui.js'); ${js} })();`);
      const PAY = '<img src=x onerror="window.__xssSink.push(1)">';
      await call(`m.toast(${JSON.stringify(PAY)});`);
      await sleep(400);
      ok('toast 不执行注入（零脚本）', (await cdp.eval(`return (window.__xssSink || []).length;`)) === 0);
      const tt = await cdp.eval(`return (document.querySelector('#toasts .toast:last-child') || {}).innerText || '';`);
      ok('toast 原样显示注入文本（转义而非吞数据）', tt.includes('<img src=x onerror='), tt.slice(0, 50));
      const eb = String(await call(`return m.errBox(${JSON.stringify(PAY)});`));
      ok('errBox 输出已转义（&lt;img 且无裸 <img）', eb.includes('&lt;img') && !eb.includes('<img'), eb.slice(0, 70));
      const op = String(await call(`return m.options([{ value: '"><img src=x>', label: '<img src=x>' }]);`));
      ok('options 的 value/label 均已转义', op.includes('&lt;img') && !op.includes('<img'), op.slice(0, 80));
      await cdp.eval(`window.__xssSink = []; return true;`); // 各自独立计数，避免上一条钉的残留干扰诊断
      await call(`m.modal({ title: ${JSON.stringify(PAY)}, body: 'x' });`);
      await sleep(400);
      ok('modal 标题不执行注入', (await cdp.eval(`return (window.__xssSink || []).length;`)) === 0);
      const mt = await cdp.eval(`return (document.querySelector('#modal-root h3') || {}).innerText || '';`);
      ok('modal 标题原样显示（转义而非吞数据）', mt.includes('<img src=x onerror='), mt.slice(0, 50));
      await cdp.eval(`const x = document.querySelector('#modal-root [data-close]'); if (x) x.click(); return true;`);
      // 灵敏度对照：未转义的等价写法必须真的触发，证明上面的 0 不是探测器失灵
      await cdp.eval(`window.__xssSink = []; const d = document.createElement('div'); d.innerHTML = ${JSON.stringify(PAY)}; document.body.appendChild(d); return true;`);
      await sleep(400);
      const ctrl = await cdp.eval(`return (window.__xssSink || []).length;`);
      ok('灵敏度对照：未转义写法确实触发（探测器有效）', ctrl >= 1, `fired=${ctrl}`);
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

    group('付费确认契约（拦截 → 取消不提交 → 确认放行 → 当天免打扰）');
    {
      // 说明：本组是本文件里**第一次**触发生成类入口，因此必须先清掉"当天免提醒"票据，
      // 才能验证"第一次必弹"。确认一次后票据写入当天 24 点 —— 后续各组（E2E/防连点等）
      // 的生成点击便不再被弹窗打断，这也正是该机制要证明的行为。
      const J = (url, o) => fetch(`http://127.0.0.1:${port}${url}`, o).then((x) => x.json());
      const SKIP = 'agnes.cost.skipUntil';
      const clearTicket = () => cdp.eval(`localStorage.removeItem('${SKIP}'); return true;`);
      const dialogOpen = () => cdp.eval(`!!document.querySelector('.modal-mask [data-yes]')`);
      const plist = await J('/api/projects');
      const pid = (plist.find((x) => x.name === '浏览器验收剧') || {}).id;
      const probe = await J('/api/storyboards', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: pid, episode_number: 91, shot_number: 9101, scene_description: '付费确认探针', image_prompt: 'cost confirm probe', duration_seconds: 4 }) });
      await clearTicket();
      await cdp.eval(`location.hash = '#/storyboards?project=${pid}&episode=91'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('#batch-img') && !!document.querySelector('[data-img]')`), '付费确认探针页就绪');

      // ① 批量入口：弹窗 → 取消 → 不得提交（无 BKEY）
      await clearTicket();
      await cdp.eval(`document.querySelector('#batch-img').click(); return true;`);
      const batchDialog = await waitFor(dialogOpen, '批量入口弹出成本确认', 6000).then(() => true).catch(() => false);
      ok('批量出图入口弹出成本确认', batchDialog);
      const copy = await cdp.eval(`return (document.querySelector('.modal-body') || {}).textContent || '';`);
      ok('确认文案说清真实费用与计费归属', copy.includes('真实费用') && copy.includes('Agnes'), copy.slice(0, 60));
      ok('确认弹窗带"今天内不再提醒"勾选', await cdp.eval(`!!document.querySelector('.modal-mask [data-cb]')`));
      await cdp.eval(`document.querySelector('.modal-mask [data-no]').click(); return true;`);
      await sleep(700);
      ok('批量取消后未提交（无 BKEY、无残留弹窗）',
        !(await cdp.eval(`localStorage.getItem('agnes.batch.last')`)) && !(await dialogOpen()));

      // ② 行内单发入口：弹窗 → 取消 → 镜头仍无图且按钮未锁死
      await clearTicket();
      await cdp.eval(`document.querySelector('[data-img]').click(); return true;`);
      const rowDialog = await waitFor(dialogOpen, '行内入口弹出成本确认', 6000).then(() => true).catch(() => false);
      ok('行内出图入口弹出成本确认', rowDialog);
      await cdp.eval(`document.querySelector('.modal-mask [data-no]').click(); return true;`);
      await sleep(700);
      const afterCancel = (await J(`/api/storyboards?project_id=${pid}&episode=91`)).find((r) => r.id === probe.id);
      ok('取消后未提交（镜头仍无图）', !!afterCancel && !afterCancel.linked_image_id, JSON.stringify(afterCancel && { i: afterCancel.linked_image_id }));
      ok('取消后按钮未被锁死', await cdp.eval(`!document.querySelector('[data-img]').dataset.busy`));

      // ③ 确认放行：勾选状态下确认 → 弹窗关闭且真的走到提交（本组未配 Key，必然以错误收尾，正好当"确实提交过"的证据）
      await clearTicket();
      await cdp.eval(`document.querySelector('[data-img]').click(); return true;`);
      await waitFor(dialogOpen, '再次弹出成本确认', 6000);
      await cdp.eval(`document.querySelector('.modal-mask [data-yes]').click(); return true;`);
      await waitFor(() => cdp.eval(`!document.querySelector('.modal-mask')`), '确认后弹窗关闭', 5000);
      const reached = await waitFor(() => cdp.eval(`!!document.querySelector('.toast.err') || !!document.querySelector('[data-img]').dataset.busy`), '确认后进入实际提交', 10000).then(() => true).catch(() => false);
      ok('确认后放行到实际提交（不是只关弹窗）', reached);
      ok('勾选后写入当天到期票据', !!(await cdp.eval(`return localStorage.getItem('${SKIP}');`)));
      await waitFor(() => cdp.eval(`!document.querySelector('[data-img]').dataset.busy`), '提交结束后按钮解锁', 20000);

      // ④ 当天免打扰：再点不得再弹（否则高频生成会被反复打断）
      await cdp.eval(`document.querySelector('[data-img]').click(); return true;`);
      await sleep(900);
      ok('当天免打扰生效：再点不再弹确认', !(await dialogOpen()));
      // 清理探针镜头；票据**故意保留**（后续各组的生成点击不应被弹窗打断）
      await fetch(`http://127.0.0.1:${port}/api/storyboards/${probe.id}`, { method: 'DELETE' });
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
      // A11y（APG）：关闭弹窗后焦点必须回到打开它的元素，否则键盘用户下次 Tab 从页首开始
      await cdp.eval(`location.hash = '#/projects'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('[data-act="edit"]')`), '编辑钮就绪');
      await cdp.eval(`document.querySelector('[data-act="edit"]').focus(); document.querySelector('[data-act="edit"]').click(); return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('.modal-mask')`), '焦点归还探针弹窗');
      key('Escape', 'Escape');
      await waitFor(() => cdp.eval(`!document.querySelector('.modal-mask')`), '探针弹窗关闭', 6000);
      await sleep(250);
      ok('关闭后焦点归还触发者（APG）', await cdp.eval(`document.activeElement === document.querySelector('[data-act="edit"]')`), await cdp.eval(`document.activeElement ? document.activeElement.tagName + '/' + (document.activeElement.getAttribute('data-edit') || document.activeElement.id || '') : 'none'`));
      // 灵敏度对照：触发者在弹窗打开期间被移除 → 不得抛错、焦点不得停在游离节点
      await cdp.eval(`const b = document.querySelector('[data-act="edit"]'); b.focus(); b.click(); return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('.modal-mask')`), '对照弹窗');
      await cdp.eval(`const b = document.querySelector('[data-act="edit"]'); window.__removedOpener = b; b.remove(); return true;`);
      key('Escape', 'Escape');
      await waitFor(() => cdp.eval(`!document.querySelector('.modal-mask')`), '对照弹窗关闭', 6000);
      await sleep(250);
      ok('灵敏度对照：触发者已移除时不抛错、焦点不在游离节点',
        await cdp.eval(`return window.__removedOpener.isConnected === false && (!document.activeElement || document.activeElement.isConnected) && document.activeElement !== window.__removedOpener;`));
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
      // E8 的 UI 半边：越界值被后端钳制后，界面必须同步显示"生效值"（否则又回到"显示≠生效"）
      await cdp.eval(`document.querySelector('#t-interval').value = '1'; document.querySelector('#save-task').click(); return true;`);
      await waitFor(async () => { const g = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json(); return Number((g.data || g).video_poll_interval) === 2; }, '越界值钳到下限=2', 8000);
      await sleep(400);
      ok('越界值保存后界面同步显示钳制值（显示=生效）', await cdp.eval(`document.querySelector('#t-interval').value === '2'`), await cdp.eval(`document.querySelector('#t-interval').value`));
      // 灵敏度对照：区间内合法值不得被钳（证明上条不是"永远显示下限"）
      await cdp.eval(`document.querySelector('#t-interval').value = '30'; document.querySelector('#save-task').click(); return true;`);
      await waitFor(async () => { const g = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json(); return Number((g.data || g).video_poll_interval) === 30; }, '合法值原样落库=30', 8000);
      await sleep(400);
      ok('灵敏度对照：区间内合法值原样显示（未被钳）', await cdp.eval(`document.querySelector('#t-interval').value === '30'`), await cdp.eval(`document.querySelector('#t-interval').value`));
      await cdp.eval(`document.querySelector('#t-interval').value = '8'; document.querySelector('#save-task').click(); return true;`); // 复原默认
      await sleep(300);
    }

    group('路由竞态契约（B32：快速连切不得泄漏监听器）');
    {
      const Jget = (u) => fetch(`http://127.0.0.1:${port}${u}`).then((x) => x.json());
      const pid = (await Jget('/api/projects')).find((x) => x.name === '浏览器验收剧').id;
      // 强制排序：把 videos 页首个 /api/videos 请求延迟 350ms，使其 mount 后于 dashboard 的 resolve
      await cdp.eval(`
        window.__fetchLog = [];
        const of = window.fetch;
        let delayed = false;
        window.fetch = (...a) => {
          const u = String(a[0]);
          window.__fetchLog.push(u);
          if (!delayed && u.includes('/api/videos')) { delayed = true; return new Promise((r) => setTimeout(() => r(of(...a)), 350)); }
          return of(...a);
        };
        location.hash = '#/videos?project=${pid}';
        setTimeout(() => { location.hash = '#/dashboard'; }, 30);
        return true;
      `);
      await sleep(1500);   // 等被取代的 videos mount 晚到并 resolve
      const onDash = await cdp.eval(`return location.hash.indexOf('#/dashboard') === 0;`);
      ok('竞态后停留在后发起的页面', onDash === true, String(onDash));
      await cdp.eval(`window.__fetchLog = []; return true;`);
      const fire = `const es = (window.__esRefs || [])[0]; if (!es) return -1; es.dispatchEvent(new MessageEvent('video', { data: JSON.stringify({ id: 'probe', status: 'completed' }) })); return 1;`;
      const fired = await cdp.eval(`return (() => { ${fire} })();`);
      ok('已捕获应用 EventSource 并可合成事件', fired === 1, `fired=${fired}`);
      await sleep(1300);   // 覆盖 700ms 去抖
      const raced = await cdp.eval(`return window.__fetchLog.filter((u) => u.includes('/api/videos')).length;`);
      ok('被取代的 videos 页监听器未泄漏（合成事件不触发其抓取）', raced === 0, `fetches=${raced}`);
      // 内置灵敏度对照：活跃的 videos 页收到同一事件**必须**抓取，证明事件与计数信号有效
      await cdp.eval(`location.hash = '#/videos?project=${pid}'; return true;`);
      await waitFor(() => cdp.eval(`return !!document.querySelector('#reload');`), 'videos 页就绪');
      await sleep(600);
      await cdp.eval(`window.__fetchLog = []; return true;`);
      await cdp.eval(`return (() => { ${fire} })();`);
      await sleep(1300);
      const live = await cdp.eval(`return window.__fetchLog.filter((u) => u.includes('/api/videos')).length;`);
      ok('灵敏度对照：活跃页收到同一事件确实抓取（信号有效）', live >= 1, `fetches=${live}`);
      await cdp.eval(`location.hash = '#/dashboard'; return true;`);
    }

    group('时长→帧数契约（R4：8n+1 与上下限钳制）');
    {
      // 页面内动态 import 真实模块：断言的是真机实际下发的产物，而非源码文本
      const F = async (sec, fps) => cdp.eval(`return (async () => { const m = await import('/js/consts.js'); return m.secondsToFrames(${JSON.stringify(sec)}${fps === undefined ? '' : ', ' + fps}); })();`);
      ok('R4 默认 5s → 121 帧', (await F(5)) === 121, String(await F(5)));
      ok('R4 非法值 0 落默认（非 0 帧）', (await F(0)) === 121, String(await F(0)));
      ok('R4 负数落默认', (await F(-3)) === 121, String(await F(-3)));
      ok('R4 非数字落默认', (await F('abc')) === 121, String(await F('abc')));
      ok('R4 下限钳制 1s → 81（Agnes 下限）', (await F(1)) === 81, String(await F(1)));
      ok('R4 中段 10s → 241', (await F(10)) === 241, String(await F(10)));
      ok('R4 上限钳制 60s → 441（Agnes 上限）', (await F(60)) === 441, String(await F(60)));
      ok('R4 自定义帧率 30fps/5s → 153', (await F(5, 30)) === 153, String(await F(5, 30)));
      const sweep = await cdp.eval(`return (async () => { const m = await import('/js/consts.js'); const a = []; for (let s = 0; s <= 70; s++) a.push(m.secondsToFrames(s)); return a; })();`);
      ok('R4 全扫描 0..70s 均满足帧数 = 8n+1（云端硬要求）', Array.isArray(sweep) && sweep.length === 71 && sweep.every((x) => x % 8 === 1), JSON.stringify(sweep.slice(0, 8)));
      const mono = sweep.slice(1).every((x, i) => i === 0 || x >= sweep[i]);
      ok('R4 s≥1 单调不减（时长列真正影响产出，未被写死）', mono === true, String(mono));
    }

    group('播放不打断契约（E5：SSE 刷新不得 surprise 重绘）');
    {
      const Jget = (u) => fetch(`http://127.0.0.1:${port}${u}`).then((x) => x.json());
      const pid = (await Jget('/api/projects')).find((x) => x.name === '浏览器验收剧').id;
      await cdp.eval(`location.hash = '#/tasks?project=${pid}'; return true;`);
      await waitFor(() => cdp.eval(`return !!document.querySelector('#list');`), '任务页就绪');
      await sleep(500);
      // 注入受控 video（用自有属性遮蔽 paused/ended 真值）+ 哨兵：render() 重写 #list 会抹掉哨兵
      const inject = `window.__probePlaying = false;
        const list = document.querySelector('#list');
        list.insertAdjacentHTML('afterbegin', '<video id="probe-video"></video><span id="probe-sentinel">哨兵</span>');
        const pv = document.getElementById('probe-video');
        Object.defineProperty(pv, 'paused', { get: () => !window.__probePlaying });
        Object.defineProperty(pv, 'ended', { get: () => false });
        return !!pv;`;
      const fire = `const es = (window.__esRefs || [])[0]; if (!es) return -1; es.dispatchEvent(new MessageEvent('video', { data: JSON.stringify({ id: 'probe-e5', status: 'completed' }) })); return 1;`;
      const hasSentinel = () => cdp.eval(`return !!document.getElementById('probe-sentinel');`);

      ok('E5 探针注入受控 video 与哨兵', (await cdp.eval(`return (() => { ${inject} })();`)) === true);
      // 阶段 A：有视频在播 → 事件到达必须"挂起"，不得重绘
      await cdp.eval(`window.__probePlaying = true; return true;`);
      await cdp.eval(`return (() => { ${fire} })();`);
      await sleep(1200); // 覆盖一次 800ms 轮询
      ok('E5 播放中收到 SSE 事件不重绘（哨兵仍在）', (await hasSentinel()) === true);
      // 阶段 B：播放停止 → 800ms 轮询应补渲染（挂起不是永久冻结）
      await cdp.eval(`window.__probePlaying = false; return true;`);
      await sleep(2000);
      ok('E5 播放停止后自动补渲染（哨兵被抹）', (await hasSentinel()) === false);
      // 阶段 C：灵敏度对照——空闲时同一事件应立即重绘（证明哨兵确实能探测到 render）
      await cdp.eval(`return (() => { ${inject} })();`);
      await cdp.eval(`return (() => { ${fire} })();`);
      await sleep(400);
      ok('E5 灵敏度对照：空闲时同一事件立即重绘（哨兵被抹）', (await hasSentinel()) === false);
      await cdp.eval(`location.hash = '#/dashboard'; return true;`);
    }

    group('批量条互斥契约（E2：补提示词占用期间不被 SSE 覆盖）');
    {
      // 慢 mock：每条补提示词要 900ms，从而稳定制造 promptBusy 窗口
      const mock = http.createServer((req, res) => {
        let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'e2-probe english prompt' } }] }));
          }, 900);
        });
      });
      await new Promise((r) => mock.listen(0, '127.0.0.1', r));
      const e2Port = mock.address().port;
      let ppid = null;
      try {
        const J = (url, o) => fetch(`http://127.0.0.1:${port}${url}`, o).then((x) => x.json());
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agnes_api_base_url: `http://127.0.0.1:${e2Port}/v1`, agnes_api_key: 'e2-mutex-key' }) });
        const proj = await J('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'E2 互斥探针剧' }) });
        ppid = proj.id;
        await J('/api/storyboards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: [
          { project_id: ppid, episode_number: 1, shot_number: 1, shot_type: '特写', scene_description: '探针镜一', sort_order: 0 },
          { project_id: ppid, episode_number: 1, shot_number: 2, shot_type: '全景', scene_description: '探针镜二', sort_order: 1 },
        ] }) });
        await cdp.eval(`localStorage.removeItem('agnes.batch.last'); location.hash = '#/storyboards?project=${ppid}&episode=1'; return true;`);
        await waitFor(() => cdp.eval(`document.querySelectorAll('#table tbody tr').length >= 2`), '探针分镜两行就绪');
        await sleep(400);
        await cdp.eval(`document.querySelector('#gen-img-prompts').click(); return true;`);
        await sleep(350); // 仍在 900ms×2 的窗口内
        const during0 = await cdp.eval(`return (document.querySelector('#batch-bar') || {}).innerText || '';`);
        ok('E2 前置自证：补提示词真的占用了 #batch-bar', during0.includes('生成图片提示词'), JSON.stringify(during0).slice(0, 80));
        // 核心：进行中收到批量 SSE 事件 → 不得覆盖（bar 仍归补提示词所有）
        const fireBatch = `const es = (window.__esRefs || [])[0]; if (!es) return -1; es.dispatchEvent(new MessageEvent('batch', { data: JSON.stringify({ id: 'probe-e2', type: 'images', status: 'running', done: 42, total: 42, ok: 42, fail: 0 }) })); return 1;`;
        const fired = await cdp.eval(`return (() => { ${fireBatch} })();`);
        ok('E2 已向应用合成批量进度事件', fired === 1, `fired=${fired}`);
        await sleep(300);
        const during = await cdp.eval(`return (document.querySelector('#batch-bar') || {}).innerText || '';`);
        ok('E2 补提示词进行中：批量事件未覆盖 bar', !during.includes('批量生成图片') && !during.includes('42 / 42'), JSON.stringify(during).slice(0, 90));
        ok('E2 且 bar 仍显示补提示词进度', during.includes('生成图片提示词'), JSON.stringify(during).slice(0, 90));
        // 等这次批量补提示词跑完（2 镜 × 900ms）
        await waitFor(() => cdp.eval(`return ((document.querySelector('#batch-bar') || {}).innerText || '').includes('已为 2 个镜头补充');`), '补提示词完成汇总', 15000);
        // 灵敏度对照：结束后同一事件必须能正常渲染 bar（守卫是作用域内的，不是永久屏蔽）
        await cdp.eval(`return (() => { ${fireBatch} })();`);
        await sleep(400);
        const after = await cdp.eval(`return (document.querySelector('#batch-bar') || {}).innerText || '';`);
        ok('E2 灵敏度对照：结束后同一事件正常渲染批量条', after.includes('批量生成图片') && after.includes('42 / 42'), JSON.stringify(after).slice(0, 90));
      } finally {
        mock.close();
        await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agnes_api_key: '' }) });
        if (ppid) await fetch(`http://127.0.0.1:${port}/api/projects/${ppid}?cascade=1`, { method: 'DELETE' });
        await cdp.eval(`localStorage.removeItem('agnes.batch.last'); location.hash = '#/dashboard'; return true;`);
      }
    }

    group('字节格式化契约（fmtBytes：保存回执不得谎报 0.0 MB）');
    {
      // 页面内动态 import 真实产物；B42 前 tasks.js 手工 /1024/1024 → 小于 1MB 一律 0.0 MB
      const B = (n) => cdp.eval(`return (async () => { const m = await import('/js/consts.js'); return m.fmtBytes(${JSON.stringify(n)}); })();`);
      ok('fmtBytes 小字节数原样（11B）', (await B(11)) === '11 B', String(await B(11)));
      ok('fmtBytes 1KB 边界（1024→1.0 KB）', (await B(1024)) === '1.0 KB', String(await B(1024)));
      ok('fmtBytes 中段（51200→50.0 KB，旧式会显示 0.0 MB）', (await B(51200)) === '50.0 KB', String(await B(51200)));
      ok('fmtBytes 1MB 边界（1048576→1.0 MB）', (await B(1048576)) === '1.0 MB', String(await B(1048576)));
      ok('fmtBytes 大值（5242880→5.0 MB）', (await B(5242880)) === '5.0 MB', String(await B(5242880)));
      ok('fmtBytes 非法输入不产出 NaN', !String(await B('abc')).includes('NaN'), String(await B('abc')));
      // 灵敏度对照：旧的手工式在同一输入上确实谎报，证明本组断言有鉴别力
      const old = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
      ok('灵敏度对照：旧手工式在 51200B 上确实谎报 0.0 MB', old(51200) === '0.0 MB', old(51200));
    }

    group('卡内按钮冒泡契约（R5：不得叠出第二层弹窗）');
    {
      const J = (u, o) => fetch(`http://127.0.0.1:${port}${u}`, o).then((x) => x.json());
      const pid = (await J('/api/projects')).find((x) => x.name === '浏览器验收剧').id;
      const img = await J('/api/images', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: pid, name: 'R5 冒泡探针图', usage_type: 'storyboard', generation_prompt: 'probe' }),
      });
      ok('R5 探针图片已建', !!img.id, JSON.stringify(img).slice(0, 70));
      await cdp.eval(`location.hash = '#/assets'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('[data-fav]') || !!document.querySelector('[data-zoom]')`), '素材卡片按钮出现');
      await sleep(400);
      const modalCount = () => cdp.eval(`return document.querySelectorAll('#modal-root .modal, #modal-root [class*=modal]').length;`);
      // 卡内按钮：冒泡没挡住就会同时弹出预览层
      await cdp.eval(`const b=document.querySelector('[data-fav]') || document.querySelector('[data-zoom]'); b.click(); return true;`);
      await sleep(500);
      const afterBtn = await modalCount();
      ok('R5 卡内按钮点击未叠出预览弹窗', afterBtn === 0, `modals=${afterBtn}`);
      // 灵敏度对照：点卡片本身必须能开弹窗（证明弹窗探测器有效，上面的 0 不是探测器失灵）
      await cdp.eval(`const c=document.querySelector('[data-id]') || document.querySelector('[data-zoom]'); c.click(); return true;`);
      await sleep(600);
      const afterCard = await modalCount();
      ok('R5 灵敏度对照：点卡片确实打开预览弹窗', afterCard >= 1, `modals=${afterCard}`);
      await cdp.eval(`const x=document.querySelector('#modal-root [data-close]'); if(x) x.click(); return true;`);
      await J(`/api/images/${img.id}`, { method: 'DELETE' }).catch(() => {});
      await cdp.eval(`location.hash = '#/dashboard'; return true;`);
    }

    group('防连点契约（R6：双击不得重复创建）');
    {
      const Jget = (u) => fetch(`http://127.0.0.1:${port}${u}`).then((x) => x.json());
      const before = (await Jget('/api/projects')).length;
      await cdp.eval(`location.hash = '#/projects'; return true;`);
      await waitFor(() => cdp.eval(`return !!document.querySelector('#new-project');`), '项目页就绪');
      await cdp.eval(`document.querySelector('#new-project').click(); return true;`);
      await waitFor(() => cdp.eval(`return !!document.querySelector('#f-name');`), '新建项目弹窗就绪');
      await cdp.eval(`document.querySelector('#f-name').value = '连点对照剧'; return true;`);
      // 同一任务内连发两次点击：处理器先同步置 inflight=true 再 await，第二次必被拦（或被 setBusy 禁用）
      await cdp.eval(`const b = document.querySelector('[data-yes]'); b.click(); b.click(); return true;`);
      await waitFor(() => cdp.eval(`return !document.querySelector('#f-name');`), '弹窗关闭', 10000).catch(() => false);
      const after = await Jget('/api/projects');
      const hits = after.filter((p) => p.name === '连点对照剧');
      ok('双击创建只产生 1 个项目（R6 防连点）', hits.length === 1, `before=${before} after=${after.length} 同名=${hits.length}`);
      for (const h of hits) await fetch(`http://127.0.0.1:${port}/api/projects/${h.id}?cascade=1`, { method: 'DELETE' });   // 先清首批，避免污染对照计数
      // 灵敏度对照：两次点击**不重叠**（等第一次落库后再点）应确实产生 2 个 →
      // 证明上面的"只 1 个"来自防连点，而非名字校验/接口去重等巧合
      await cdp.eval(`document.querySelector('#new-project').click(); return true;`);
      await waitFor(() => cdp.eval(`return !!document.querySelector('#f-name');`), '对照弹窗就绪');
      await cdp.eval(`document.querySelector('#f-name').value = '连点对照剧'; return true;`);
      await cdp.eval(`const b = document.querySelector('[data-yes]'); b.click(); await new Promise((r) => setTimeout(r, 400)); b.click(); return true;`);
      await sleep(800);
      const after2 = await Jget('/api/projects');
      ok('灵敏度对照：非重叠两次点击确实产生 2 个（钉对防护缺失敏感）', after2.filter((p) => p.name === '连点对照剧').length === 2, `同名=${after2.filter((p) => p.name === '连点对照剧').length}`);
      await cdp.eval(`document.querySelector('.modal-close')?.click(); return true;`);
      for (const h of after2.filter((p) => p.name === '连点对照剧')) await fetch(`http://127.0.0.1:${port}/api/projects/${h.id}?cascade=1`, { method: 'DELETE' });
      const cleaned = (await Jget('/api/projects')).length;
      ok('连点探针已清理（项目数复原）', cleaned === before, `before=${before} cleaned=${cleaned}`);
      await cdp.eval(`location.hash = '#/dashboard'; return true;`);
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

    group('空态指路契约（空态必须给出下一步，而不是只报「没有」）');
    {
      // 用全新空项目制造确定性空态（不依赖"恰好别的组没留数据"）
      const J = (url, o) => fetch(`http://127.0.0.1:${port}${url}`, o).then((x) => x.json());
      const p = await J('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '空态探针剧' }) });
      ok('空态探针项目已建（自证非空跑）', !!p.id, JSON.stringify(p).slice(0, 50));
      try {
        await cdp.eval(`location.hash = '#/images?project=${p.id}'; return true;`);
        await waitFor(() => cdp.eval(`!!document.querySelector('#gallery [data-act="focus"]')`), '图片页空态 CTA', 8000);
        ok('图片页空态带一键 CTA', true);
        await cdp.eval(`document.querySelector('#gallery [data-act="focus"]').click(); return true;`);
        ok('点 CTA 后焦点落到提示词框（图片）', await cdp.eval(`document.activeElement && document.activeElement.id === 't2i-prompt'`), await cdp.eval(`document.activeElement && document.activeElement.id`));

        await cdp.eval(`location.hash = '#/videos?project=${p.id}'; return true;`);
        await waitFor(() => cdp.eval(`!!document.querySelector('#recent [data-act="focus"]')`), '视频页空态 CTA', 8000);
        ok('视频页空态带一键 CTA', true);
        await cdp.eval(`document.querySelector('#recent [data-act="focus"]').click(); return true;`);
        ok('点 CTA 后焦点落到提示词框（视频）', await cdp.eval(`document.activeElement && document.activeElement.id === 'f-prompt'`), await cdp.eval(`document.activeElement && document.activeElement.id`));

        // 分镜页：空项目无镜头 → CTA 跳到故事脚本页（跨页 hash 链接形态）
        await cdp.eval(`location.hash = '#/storyboards?project=${p.id}&episode=1'; return true;`);
        await waitFor(() => cdp.eval(`!!document.querySelector('.empty')`), '分镜页空态', 8000);
        ok('分镜页空态 CTA 指向故事脚本页', await cdp.eval(`!!document.querySelector('.empty a[href^="#/scripts"]')`), await cdp.eval(`(document.querySelector('.empty a') || {}).getAttribute && document.querySelector('.empty a').getAttribute('href')`));
        // 灵敏度对照：空态不能只有文案（拿一个"有 CTA"与"无 CTA"做对照）
        ok('灵敏度对照：无 action 的空态确实不带按钮/链接', await cdp.eval(`const m = await import('/js/ui.js'); const d = document.createElement('div'); d.innerHTML = m.empty('x', 'y', 'folder'); return !d.querySelector('a,button');`));
      } finally {
        await fetch(`http://127.0.0.1:${port}/api/projects/${p.id}?cascade=1`, { method: 'DELETE' });
      }
    }

    group('失败追踪码展示契约（R10：用户看得到码，且不会挂空壳）');
    {
      const withCode = await cdp.eval(`const m = await import('/js/ui.js'); const d = document.createElement('div'); d.innerHTML = m.errBox('加载失败', undefined, 'eabc123xyz'); return d.innerHTML;`);
      ok('errBox 渲染出追踪码', String(withCode).includes('eabc123xyz'));
      ok('errBox 说明码的用途（可在运行日志中按码搜索）', String(withCode).includes('运行日志'));
      // 灵敏度对照：没有码时不得渲染"报错码"这一行（否则每次加载失败都挂一个空壳）
      const noCode = await cdp.eval(`const m = await import('/js/ui.js'); const d = document.createElement('div'); d.innerHTML = m.errBox('加载失败'); return d.innerHTML;`);
      ok('灵敏度对照：无码时不渲染码行', !String(noCode).includes('报错码'));
      // 骨架屏必须真的产出占位块（不是空 div），否则等于换个名字的空白
      const sk = await cdp.eval(`const m = await import('/js/ui.js'); const d = document.createElement('div'); d.innerHTML = m.skeleton('asset', 3); return { blocks: d.querySelectorAll('.sk-box').length, lines: d.querySelectorAll('.sk-line').length, busy: d.querySelector('.sk-wrap').getAttribute('aria-busy') };`);
      ok('骨架屏产出占位块且带 aria-busy', sk.blocks === 3 && sk.lines >= 3 && sk.busy === 'true', JSON.stringify(sk));
      // 灵敏度对照：kind 写错时必须退化成默认骨架而不是抛错/空串
      const bad = await cdp.eval(`const m = await import('/js/ui.js'); const d = document.createElement('div'); d.innerHTML = m.skeleton('nope', 1); return d.innerHTML.length;`);
      ok('灵敏度对照：未知 kind 退化为默认骨架（不抛错、不返回空串）', Number(bad) > 20, String(bad));
    }

    group('设置页 API Key 收回明文契约');
    {
      // 保存成功后不得把刚输入的明文 Key 留在输入框里。旧实现靠"整页 render()"顺手重置，
      // 去掉 render() 后必须显式收回（否则明文常驻 + 提示与实际不符）。
      // 本组放在最后：上一组已把 Key 清空；base 指向不可达端口，避免刷新模型走真网。
      const put = (b) => fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      await put({ agnes_api_base_url: 'http://127.0.0.1:1/v1', agnes_api_key: '' });
      await cdp.eval(`location.hash = '#/settings?sec=api'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('#s-key')`), 'API 配置区就绪');
      const sentinel = 'ui-withdraw-probe-key-9f3a';
      await cdp.eval(`document.querySelector('#toggle-key').click(); return true;`);
      await waitFor(() => cdp.eval(`document.querySelector('#s-key').disabled === false`), 'Key 输入框进入编辑态');
      await cdp.eval(`const k = document.querySelector('#s-key'); k.value = '${sentinel}'; document.querySelector('#save-api').click(); return true;`);
      const savedKey = await waitFor(async () => {
        const g = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json();
        return !!(g.data || g).agnes_api_key_masked;
      }, 'Key 已落库（脱敏值非空）', 20000).then(() => true).catch(() => false);
      ok('UI 保存 Key 成功落库（脱敏值非空）', savedKey);
      await sleep(300);
      const ks = await cdp.eval(`return (() => { const k = document.querySelector('#s-key'); return { disabled: !!k.disabled, type: k.type, value: k.value, hint: (document.querySelector('#s-key-hint') || {}).textContent || '' }; })();`);
      ok('保存后 Key 输入框收回只读（disabled）', ks.disabled === true, JSON.stringify(ks));
      ok('保存后输入框类型回 password（不裸显）', ks.type === 'password', ks.type);
      ok('保存后不残留明文 Key', !String(ks.value).includes(sentinel), String(ks.value));
      ok('保存后提示显示当前脱敏 Key', String(ks.hint).includes('当前：'), ks.hint);
      await put({ agnes_api_base_url: '', agnes_api_key: '' });
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
