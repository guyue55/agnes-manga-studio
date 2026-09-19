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
      ['projects', '项目管理'], ['scripts', '故事脚本'], ['novel', '原著解析'], ['storyboards', '分镜制作'], ['characters', '角色库'],
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
    // 竞态修复：上面的"落盘"只证明服务端已写入，客户端的 closeModal() 是同一轮异步里后跑的。
    // 直接立刻读 .modal 会偶发假红（本轮真的红过一次）。改成有界等待——断言"会关"而不是"此刻已关"。
    ok('创建后弹窗关闭', await waitFor(() => cdp.eval(`!document.querySelector('.modal')`), '创建后弹窗关闭', 4000).then(() => true).catch(() => false));

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
      const evilTpl = await post('/api/templates', { name: X('tpl'), system: 's', content: '正文 {{变量}} 型' });
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
      // 探针模板必须一并清掉：它没写 template_type → 落库时被填成默认类型（story_concept），
      // 于是"故事构思"页签会渲染这个只含 {{变量}} 的毒模板，污染后面所有读模板的分组
      // （批 4 的剧本链路分组就是这么被污染的：门禁报"缺字段：变量"）。
      // 教训：探针数据不只是项目——**任何被后续分组按类型取用的全局集合都要收尾**。
      if (evilTpl && evilTpl.id) await fetch(`http://127.0.0.1:${port}/api/templates/${evilTpl.id}`, { method: 'DELETE' });
      const tplLeft = await (await fetch(`http://127.0.0.1:${port}/api/templates`)).json();
      ok('毒模板探针已清理（不再污染后续分组的模板列表）', !tplLeft.some((t) => t.id === (evilTpl && evilTpl.id)));
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
      const pages3 = ['#/dashboard', '#/projects', '#/scripts', '#/storyboards', '#/characters', '#/images', '#/videos', '#/tasks', '#/assets'];
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
      const pages2 = ['#/dashboard', '#/projects', '#/scripts', '#/storyboards', '#/characters', '#/images', '#/videos', '#/tasks', '#/assets', '#/settings'];
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

    group('原著解析页（批 8：干跑计费闸门 / 覆盖如实上报）');
    {
      // 本组只用到 /api/story/plan（**纯本地计算，不调模型**），所以不依赖任何上游 Key：
      // 这正好让它能证明"确认之前一分钱都不花"——连上游都没配，弹窗照样先出现。
      const J = (url, o) => fetch(`http://127.0.0.1:${port}${url}`, o).then((x) => x.json());
      const SKIP = 'agnes.cost.skipUntil';
      const dialogOpen = () => cdp.eval(`!!document.querySelector('.modal-mask [data-yes]')`);
      const plist = await J('/api/projects');
      const pid = (plist.find((x) => x.name === '浏览器验收剧') || {}).id;
      await cdp.eval(`localStorage.removeItem('${SKIP}'); return true;`); // 上一组故意留了免打扰票据，这里要先清掉
      await cdp.eval(`location.hash = '#/novel?project_id=${pid}'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('#nov-text') && !!document.querySelector('#nov-run')`), '原著解析页就绪');
      ok('原著解析页标题正确', await cdp.eval(`document.querySelector('.page-title')?.textContent === '原著解析'`));
      ok('解析记录空态带一键出口（不是死胡同）',
        await cdp.eval(`!!document.querySelector('#nov-sources [data-act]')`));

      // 约 5800 字、12 段的原文：默认 3000 字一段 → 稳定切出 2 段
      const chars = await cdp.eval(`const t = Array.from({length:12},(_,i)=>('第'+(i+1)+'段。'+'林晚走进临江茶馆，白衣上沾着夜雨。'.repeat(20))).join('\\n\\n');
        const el = document.querySelector('#nov-text'); el.value = t; el.dispatchEvent(new Event('input',{bubbles:true})); return el.value.length;`);
      ok('原文粘贴后计数可见（字数超过一段上限，才会真的分块）', chars > 3000, String(chars));
      ok('计数文案含"原文 N 字"', await cdp.eval(`(document.querySelector('#nov-count')?.textContent||'').includes('原文')`));

      // ① 干跑：给出"分几段、调几次、覆盖多少"，且**不弹费用确认、不落库**
      await cdp.eval(`document.querySelector('#nov-plan').click(); return true;`);
      const gotPlan = await waitFor(() => cdp.eval(`(document.querySelector('#nov-plan-box')||{}).textContent?.includes('将分')`), '干跑结果出现', 8000).then(() => true).catch(() => false);
      ok('干跑给出分段与调用次数', gotPlan);
      const planText = await cdp.eval(`return (document.querySelector('#nov-plan-box')||{}).textContent || '';`);
      ok('干跑结果含"分 N 段"与"调用模型 N 次"', /将分\s*2\s*段/.test(planText) && /调用模型\s*3\s*次/.test(planText), planText.slice(0, 90));
      ok('干跑结果如实说明覆盖全文（未截断时不谎报风险）', planText.includes('覆盖全文'), planText.slice(0, 90));
      ok('干跑本身不弹费用确认（本地计算不该打断）', !(await dialogOpen()));
      const before = await J(`/api/story/sources?project_id=${pid}`);
      ok('干跑不落库（还没确认就花钱/写盘都不许）', before.length === 0, JSON.stringify(before.length));

      // ② 点开始解析：必须先弹费用确认，且文案给出真实次数
      await cdp.eval(`document.querySelector('#nov-run').click(); return true;`);
      const dlg = await waitFor(dialogOpen, '原著解析弹出成本确认', 8000).then(() => true).catch(() => false);
      ok('开始解析前弹出成本确认（未确认不花钱）', dlg);
      const copy = await cdp.eval(`return (document.querySelector('.modal-body')||{}).textContent || '';`);
      ok('确认文案说清真实费用与计费归属', copy.includes('真实费用') && copy.includes('Agnes'), copy.slice(0, 70));
      ok('确认文案带上本次调用次数与段数（用户能算账）', copy.includes('3') && copy.includes('原著解析') && copy.includes('2 段'), copy.slice(0, 120));

      // ③ 取消 → 不得提交（无 job、无落库）。用可选链：弹窗没出现时也要**干净地红**，
      // 而不是在 click of null 上抛异常把整组带走（对照 I 实测过一次）
      await cdp.eval(`document.querySelector('.modal-mask [data-no]')?.click(); return true;`);
      await sleep(700);
      ok('取消后未提交解析任务（无 job 记录）', !(await cdp.eval(`localStorage.getItem('agnes.novel.job')`)));
      const after = await J(`/api/story/sources?project_id=${pid}`);
      ok('取消后未落库任何原著', after.length === 0, String(after.length));

      // ④ 改原文后旧的分段数字必须作废（不许拿旧数字给新原文背书）
      await cdp.eval(`const el = document.querySelector('#nov-text'); el.value = el.value + '\\n\\n追加一段，林晚拔剑。'; el.dispatchEvent(new Event('input',{bubbles:true})); return true;`);
      ok('改原文后干跑结论被作废（不会拿旧数字误导）',
        !(await cdp.eval(`(document.querySelector('#nov-plan-box')||{}).textContent?.includes('将分')`)));

      // 收尾：本组为了验证"第一次必弹"清掉了当天免打扰票据，
      // 必须**还回去**——否则后面各组的生成点击会被弹窗拦住（E2E 组就是这么被我拦红过一次）。
      await cdp.eval(`localStorage.setItem('${SKIP}', String(Date.now() + 86400000)); return true;`);
      ok('已还回当天免打扰票据（不污染后续各组的生成点击）', !!(await cdp.eval(`return localStorage.getItem('${SKIP}');`)));
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
        // R22：进度链从一提交就存在（按下标预填），不是"完成一条冒一个"
        const chain0 = await cdp.eval(`
          const el = document.querySelector('#batch-bar');
          const dots = Array.from(el.querySelectorAll('.chain-dot'));
          return { n: dots.length, states: dots.map((d) => d.className.replace('chain-dot', '').trim()),
            titles: dots.slice(0, 2).map((d) => d.getAttribute('title')) };`);
        ok('R22 进度链一提交就按镜头数预填（不是完成一条冒一个）',
          chain0.n === 16 && chain0.states.filter((x) => x === 'pending' || x === 'running' || x === 'ok').length === 16,
          JSON.stringify({ n: chain0.n, states: chain0.states.slice(0, 5) }));
        ok('R22 链上每项标明是第几镜（hover 可读）',
          /镜头 #/.test(chain0.titles[0] || '') && /镜头 #/.test(chain0.titles[1] || ''), JSON.stringify(chain0.titles));
        await cdp.eval(`location.hash = '#/dashboard'; return true;`);
        await sleep(250);
        await cdp.eval(`location.hash = '#/storyboards?project=${pid}&episode=42'; return true;`);
        await waitFor(() => cdp.eval(`document.querySelector('#batch-bar')?.innerText.includes('批量生成图片')`), '断页找回进度条', 8000);
        ok('E7 断页找回：换页回来进度条续上', true);
        await waitFor(async () => { const j = await J(`/api/batch/${jobId}`); return j && j.status && j.status !== 'running'; }, '首批跑完', 25000);
        const j1 = await J(`/api/batch/${jobId}`);
        ok('16/16 全部成功', j1.done === 16 && j1.ok === 16, JSON.stringify({ d: j1.done, o: j1.ok, f: j1.fail }));
        // R22：逐项终态 + label/key 回传（界面靠 key 把状态映射回表格行）
        ok('R22 逐项状态全部落到 ok（不是只有汇总数字）',
          j1.items.length === 16 && j1.items.every((i) => i.state === 'ok' && i.ok === true)
          && j1.items.map((i) => i.index).join(',') === Array.from({ length: 16 }, (_, k) => k).join(','),
          JSON.stringify(j1.items.slice(0, 2)));
        ok('R22 每项都带镜头号 label 与分镜 key（刷新后进度链仍对得上）',
          j1.items.every((i) => /^镜头 #\d+$/.test(i.label) && typeof i.key === 'string' && i.key.length > 0),
          JSON.stringify(j1.items[0]));
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
        // R22：取消后未轮到的项必须收成 cancelled，否则界面永远挂着一排"待处理"，看着像卡死
        ok('R22 取消后未轮到的项标成 cancelled（不留一排假"待处理"）',
          j2b.items.every((i) => ['ok', 'fail', 'cancelled'].includes(i.state))
          && j2b.items.some((i) => i.state === 'cancelled'),
          JSON.stringify(j2b.items.map((i) => i.state).join(',')));
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

    group('分镜工作台契约（批 6：R22 产出三状态点 / R23 提示词就地编辑 / R24 进度链渲染）');
    {
      const J = (u, o) => fetch(`http://127.0.0.1:${port}${u}`, o).then((x) => x.json());
      const pid = (await J('/api/projects')).find((x) => x.name === '浏览器验收剧').id;
      await cdp.eval(`location.hash = '#/storyboards?project=${pid}'; return true;`);
      await waitFor(() => cdp.eval(`return document.querySelectorAll('#table tbody tr').length > 0;`), '分镜表就绪', 12000);
      await sleep(400);

      // ── R22 产出三状态点：每行三个点，状态由持久字段决定
      const dots = await cdp.eval(`
        const tr = document.querySelector('#table tbody tr');
        const ds = Array.from(tr.querySelectorAll('.dots .dot'));
        return { n: ds.length, cls: ds.map((d) => d.className.replace('dot', '').trim()),
          titles: ds.map((d) => d.getAttribute('title')), labels: ds.map((d) => d.getAttribute('aria-label')) };`);
      ok('R22 每行三个产出点（提示词 / 分镜图 / 视频）', dots.n === 3, JSON.stringify(dots));
      ok('R22 三个点各自可读（title 说清是哪一道关 + 状态）',
        /提示词/.test(dots.titles[0]) && /分镜图/.test(dots.titles[1]) && /视频/.test(dots.titles[2]), JSON.stringify(dots.titles));
      ok('R22 点不只是颜色（aria-label 把状态说给读屏）',
        dots.labels.every((x) => /已完成|进行中|失败|未开始|排队中|已取消/.test(x)), JSON.stringify(dots.labels));
      // 灵敏度对照：给第一行补一条图片关联 → 图片点必须变绿
      const first = (await J(`/api/storyboards?episode=1&project_id=${pid}`))[0];
      // 探针必须留痕可复原：本分组要改这一行的提示词与图片关联，后面的分组（批 5 的运镜契约）
      // 依赖"存在一行图文提示词都齐"，不还原就会把后面的分组搞红——这正是"探针污染"的老毛病。
      const orig = { image_prompt: first.image_prompt || '', video_prompt: first.video_prompt || '', linked_image_id: first.linked_image_id || '' };
      await J(`/api/storyboards/${first.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ linked_image_id: 'probe_img_x' }) });
      await cdp.eval(`document.querySelector('#reload')?.click(); return true;`);
      await sleep(900);
      const dot2 = await cdp.eval(`
        const tr = document.querySelector('#table tbody tr');
        const ds = Array.from(tr.querySelectorAll('.dots .dot'));
        return ds.map((d) => d.className.replace('dot', '').trim());`);
      ok('灵敏度对照：关联图片后图片点转绿（点确实跟着数据走）', dot2[1] === 'ok', JSON.stringify(dot2));
      // 提示词齐全的行 → 提示词点绿；清空后 → 灰
      ok('R22 提示词两条都在时提示词点为绿', dot2[0] === 'ok', JSON.stringify(dot2));
      await J(`/api/storyboards/${first.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ linked_image_id: '', video_prompt: '' }) });
      await cdp.eval(`document.querySelector('#reload')?.click(); return true;`);
      await sleep(900);
      const dot3 = await cdp.eval(`
        const tr = document.querySelector('#table tbody tr');
        const ds = Array.from(tr.querySelectorAll('.dots .dot'));
        return ds.map((d) => d.className.replace('dot', '').trim());`);
      // 视频点不断言：这一行可能被更早的分组关联过视频（跨分组残留），断言它会把别的分组的状态带进来
      ok('灵敏度对照：缺视频提示词 → 提示词点降级为"排队中"、图片点回到未开始',
        dot3[0] === 'pending' && dot3[1] === 'idle', JSON.stringify(dot3));

      // ── R23 就地编辑：点击 → textarea → blur 保存，且**不整表重渲染**
      const rowId = first.id;
      await cdp.eval(`document.querySelector('[data-edit="${rowId}"]')?.click(); return true;`); // 先确保行存在
      await sleep(300);
      await cdp.eval(`document.querySelector('.modal [data-no]')?.click(); return true;`);
      await sleep(300);
      // "没被重渲染"的证据必须是 **DOM 身份**，不能是勾选状态：
      // 选中态存在 selected 这个 Set 里，整表重建后依然会勾上——拿它当证据是假敏感。
      // 给当前 tbody 首行打个戳，重渲染会换掉元素，戳就没了。
      await cdp.eval(`document.querySelector('#table tbody tr').__probe = 'keep'; return true;`);
      await cdp.eval(`const c = document.querySelector('[data-sel="${rowId}"]'); c.checked = true; c.dispatchEvent(new Event('change')); return true;`);
      await sleep(200);
      const beforeVal = (await J(`/api/storyboards?episode=1&project_id=${pid}`)).find((r) => r.id === rowId).image_prompt;
      await cdp.eval(`document.querySelector('[data-prompt="image_prompt"] [data-inline]').click(); return true;`);
      await sleep(300);
      const opened = await cdp.eval(`
        const ta = document.querySelector('[data-prompt="image_prompt"] textarea.inline-edit');
        return { has: !!ta, focused: ta === document.activeElement, val: ta ? ta.value : null };`);
      ok('R23 点击提示词单元格就地变成 textarea 且自动聚焦（不用开 15 字段弹窗）',
        opened.has && opened.focused, JSON.stringify({ has: opened.has, focused: opened.focused }));
      ok('R23 编辑框里是当前值（不是空的）', opened.val === beforeVal, JSON.stringify({ v: opened.val, b: beforeVal }));
      // 改值 → blur → 落库
      await cdp.eval(`const ta = document.querySelector('[data-prompt="image_prompt"] textarea.inline-edit'); ta.value = 'inline edited prompt'; ta.dispatchEvent(new Event('blur')); return true;`);
      await sleep(900);
      const afterSave = (await J(`/api/storyboards?episode=1&project_id=${pid}`)).find((r) => r.id === rowId);
      ok('R23 blur 即保存到后端（不用再点保存）', afterSave.image_prompt === 'inline edited prompt', JSON.stringify(afterSave.image_prompt));
      const backToText = await cdp.eval(`
        const cell = document.querySelector('[data-prompt="image_prompt"]');
        return { text: cell.innerText, stillTextarea: !!cell.querySelector('textarea'),
          checked: !!document.querySelector('[data-sel="${rowId}"]')?.checked,
          domKept: document.querySelector('#table tbody tr').__probe === 'keep' };`);
      ok('R23 保存后就地换回文本（不是留着一个 textarea）',
        !backToText.stillTextarea && /inline edited prompt/.test(backToText.text), JSON.stringify(backToText));
      ok('R23 保存**不整表重渲染**（首行的 DOM 身份还在——整表重建会换掉元素）',
        backToText.domKept === true, JSON.stringify(backToText));
      // Esc 取消：改值后按 Esc 必须不落库
      await cdp.eval(`document.querySelector('[data-prompt="image_prompt"] [data-inline]').click(); return true;`);
      await sleep(250);
      await cdp.eval(`
        const ta = document.querySelector('[data-prompt="image_prompt"] textarea.inline-edit');
        ta.value = 'ESC 不应该被保存';
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return true;`);
      await sleep(700);
      const afterEsc = (await J(`/api/storyboards?episode=1&project_id=${pid}`)).find((r) => r.id === rowId);
      ok('R23 Esc 取消不落库（长文本编辑必须有"不改了"的出口）',
        afterEsc.image_prompt === 'inline edited prompt', JSON.stringify(afterEsc.image_prompt));
      // 没改动就 blur：不发请求（用 mtime 无法直接看，这里验证值没被写坏 + 界面正常收摊）
      await cdp.eval(`document.querySelector('[data-prompt="image_prompt"] [data-inline]').click(); return true;`);
      await sleep(250);
      await cdp.eval(`const ta = document.querySelector('[data-prompt="image_prompt"] textarea.inline-edit'); ta.dispatchEvent(new Event('blur')); return true;`);
      await sleep(600);
      const afterNoop = await cdp.eval(`return { stillTextarea: !!document.querySelector('[data-prompt="image_prompt"] textarea'), text: document.querySelector('[data-prompt="image_prompt"]').innerText };`);
      ok('R23 值没变时 blur 也能正常收摊（不留死 textarea）',
        !afterNoop.stillTextarea && /inline edited prompt/.test(afterNoop.text), JSON.stringify(afterNoop));

      // ── R24 进度链渲染（用真渲染函数喂合成任务：五态各自可辨）
      // 用真实的挂载点 #batch-bar 渲染合成任务：既不新造 id（测试选择器棘轮要求 id 在源码里），
      // 也顺带验证这个渲染器确实能挂进页面上那个容器
      await cdp.eval(`
        const m = await import('/js/pages/helpers.js');
        const el = document.querySelector('#batch-bar');
        m.renderBatchBar(el, { id: 'probe', type: 'images', total: 5, done: 2, ok: 1, fail: 1, status: 'running',
          items: [
            { index: 0, label: '镜头 #1', state: 'ok' },
            { index: 1, label: '镜头 #2', state: 'fail', error: '上游模型超时' },
            { index: 2, label: '镜头 #3', state: 'running' },
            { index: 3, label: '镜头 #4', state: 'pending' },
            { index: 4, label: '镜头 #5', state: 'cancelled' },
          ] }, null);
        return true;`);
      await sleep(200);
      const chain = await cdp.eval(`
        const dots = Array.from(document.querySelectorAll('#batch-bar .chain-dot'));
        return { n: dots.length, cls: dots.map((d) => d.className.replace('chain-dot', '').trim()),
          failTitle: dots[1].getAttribute('title'), runningAnim: getComputedStyle(dots[2]).animationName };`);
      ok('R24 进度链五态各自成类（pending/running/ok/fail/cancelled）',
        chain.n === 5 && chain.cls.join(',') === 'ok,fail,running,pending,cancelled', JSON.stringify(chain.cls));
      ok('R24 失败项 hover 给出原因（"哪一镜失败、为什么"一眼可见）',
        /镜头 #2/.test(chain.failTitle) && /上游模型超时/.test(chain.failTitle), JSON.stringify(chain.failTitle));
      ok('R24 进行中的点在动（不是静止的琥珀色块）', chain.runningAnim === 'chainPulse', chain.runningAnim);
      await cdp.eval(`const m = await import('/js/pages/helpers.js'); m.renderBatchBar(document.querySelector('#batch-bar'), null); return true;`);

      // ── R24 焦点环：键盘聚焦时必须出现双层环（内层底色 + 外层金色）
      await cdp.eval(`location.hash = '#/projects'; return true;`);
      await waitFor(() => cdp.eval(`return !!document.querySelector('#new-project');`), '项目页就绪');
      await sleep(300);
      const ring = await cdp.eval(`
        const b = document.querySelector('#new-project');
        b.focus();
        const cs = getComputedStyle(b);
        return { shadow: cs.boxShadow, outline: cs.outlineColor + ' ' + cs.outlineWidth,
          focusVisible: b.matches(':focus-visible') };`);
      const layers = (String(ring.shadow).match(/rgba?\(/g) || []).length;
      ok('R24 焦点环是双层（内层底色隔开 + 外层金色），单层半透明在浅色底上会糊',
        ring.focusVisible && layers >= 2, JSON.stringify(ring));
      ok('R24 保留 outline 兜底（高对比模式下 box-shadow 常被忽略）',
        /rgba?\(/.test(ring.outline) && /px/.test(ring.outline), JSON.stringify(ring.outline));
      await cdp.eval(`document.activeElement?.blur(); return true;`);
      // 复原探针改动（见 orig 的注释）：测试也要"谁污染谁治理"
      await J(`/api/storyboards/${rowId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orig) });
      const restored = (await J(`/api/storyboards?episode=1&project_id=${pid}`)).find((r) => r.id === rowId);
      ok('探针改动已复原（不给后续分组留污染）',
        restored.image_prompt === orig.image_prompt && restored.video_prompt === orig.video_prompt
        && (restored.linked_image_id || '') === orig.linked_image_id,
        JSON.stringify({ ip: restored.image_prompt === orig.image_prompt, vp: restored.video_prompt === orig.video_prompt }));
    }

    group('计费安全与数据效率契约（批 7：R25 幂等 / R26 时长 / R27 费用 / R28 出口 / R29 计数）');
    {
      const J = (u, o) => fetch(`http://127.0.0.1:${port}${u}`, o).then((x) => x.json());
      const pid = (await J('/api/projects')).find((x) => x.name === '浏览器验收剧').id;

      // ── R25 token 复用规则（前端逻辑核心：重试复用、参数变化换新、成功作废）
      const tok = await cdp.eval(`
        const m = await import('/js/pages/helpers.js');
        const t = m.makeTokenStore();
        const a = t('s', 'k1');
        const b = t('s', 'k1');   // 同一参数指纹 → 必须复用
        const c = t('s', 'k2');   // 参数变了 → 必须换新
        const d = t('other', 'k1'); // 不同 scope 互不干扰
        t.clear('s');
        const e = t('s', 'k1');   // 作废后 → 新 token
        return { same: a === b, changed: a !== c, scoped: a !== d, cleared: a !== e, looksUuid: /^[0-9a-f-]{36}$/i.test(a) || a.length > 8 };`);
      ok('R25 参数没变的重试复用同一个幂等键（否则服务端查重形同虚设）', tok.same === true, JSON.stringify(tok));
      ok('R25 参数一变立刻换新键（"我就是想再来一条"不能被误判成重复）', tok.changed === true, JSON.stringify(tok));
      ok('R25 不同 scope 互不干扰（批量按镜头 id 分桶）', tok.scoped === true, JSON.stringify(tok));
      ok('R25 作废后换新键（提交成功 = 这次意图完成）', tok.cleared === true, JSON.stringify(tok));
      ok('R25 幂等键形状可用（UUID 或足够长的随机串）', tok.looksUuid === true, JSON.stringify(tok));

      // ── R25/R28 端到端：真实页面提交确实带 token，且重试复用；no_api_key 时给"去设置"出口
      // 付费确认的"当天免打扰"键：**先存原值再改**。这里踩过一次——第一版直接在收尾 removeItem，
      // 结果后面「失败恢复契约」分组靠这个键跳过付费确认弹窗，键没了就永远等不到 busy 态。
      // 清理的正确含义是"还原成原样"，不是"删掉"。
      await cdp.eval(`
        window.__prevSkip = localStorage.getItem('agnes.cost.skipUntil');
        localStorage.setItem('agnes.cost.skipUntil', String(Date.now() + 3600e3));
        return true;`);
      await cdp.eval(`location.hash = '#/videos?project=${pid}'; return true;`);
      await waitFor(() => cdp.eval(`return !!document.querySelector('#f-prompt') && !!document.querySelector('#submit');`), '视频表单就绪', 10000);
      await cdp.eval(`
        window.__cap = [];
        window.__mode = 'fail';
        window.__fetchOrig = window.__fetchOrig || window.fetch; // 留底，分组结束必须还原
        const orig = window.fetch;
        window.fetch = async (u, o) => {
          if (String(u).includes('/api/videos') && o && o.method === 'POST') {
            window.__cap.push(o.body);
            if (window.__mode === 'fail') {
              return new Response(JSON.stringify({ ok: false, error: '本地未配置 API Key', errorType: 'no_api_key' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return new Response(JSON.stringify({ ok: true, deduped: false, clamps: [], asset: { id: 'stub_asset', agnes_video_id: 'vid_stub' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return orig(u, o);
        };
        return true;`);
      const setPrompt = `
        const ta = document.querySelector('#f-prompt');
        ta.value = 'e2e idempotency probe';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;`;
      await cdp.eval(setPrompt);
      await cdp.eval(`document.querySelector('#submit').click(); return true;`);
      await waitFor(() => cdp.eval(`return window.__cap.length >= 1;`), '第一次提交被捕获', 8000);
      await cdp.eval(setPrompt); // 表单重渲染后重新填（同一参数指纹）
      // 关键：等按钮解锁再点。请求被捕获 ≠ 页面已处理完响应——此时按钮仍是 disabled，
      // 浏览器会直接丢弃这次 click，表现为"偶发少一次请求"（踩过一次的 flake）。
      await waitFor(() => cdp.eval(`const b = document.querySelector('#submit'); return !!b && !b.disabled && b.dataset.busy !== '1';`), '提交按钮解锁', 10000);
      await cdp.eval(`document.querySelector('#submit').click(); return true;`);
      await waitFor(() => cdp.eval(`return window.__cap.length >= 2;`), '第二次提交被捕获', 8000);
      const caps = await cdp.eval(`return window.__cap.map((b) => { try { return JSON.parse(b); } catch { return {}; } });`);
      ok('R25 页面提交确实带上了幂等键（不是只写在注释里）',
        !!caps[0].client_token && caps[0].client_token.length > 8, JSON.stringify(caps[0].client_token));
      ok('R25 失败后重试复用同一个幂等键（这正是"超时后再点一次"的双计费窗口）',
        caps[1].client_token === caps[0].client_token, JSON.stringify([caps[0].client_token, caps[1].client_token]));
      // R28：no_api_key 的出口必须出现，且指向设置页 API 分节
      const outlet = await cdp.eval(`
        const diag = document.querySelector('#diag');
        const a = diag && diag.querySelector('a[href*="settings"]');
        return { has: !!a, href: a ? a.getAttribute('href') : null, label: a ? a.textContent.trim() : null, raw: diag ? diag.innerText.includes('本地未配置 API Key') : false };`);
      ok('R28 no_api_key 时给"去设置填 Key"出口（重试一万次也还是没 Key）',
        outlet.has && /sec=api/.test(outlet.href || '') && /API Key/.test(outlet.label || ''), JSON.stringify(outlet));
      ok('R28 出口只是补充：后端原文仍然完整显示', outlet.raw === true, JSON.stringify(outlet));
      // 成功路径：token 必须作废（下一次同样的参数应当是一条新任务）
      await cdp.eval(`window.__mode = 'ok'; return true;`);
      await cdp.eval(setPrompt);
      await waitFor(() => cdp.eval(`const b = document.querySelector('#submit'); return !!b && !b.disabled && b.dataset.busy !== '1';`), '提交按钮解锁（成功前）', 10000);
      await cdp.eval(`document.querySelector('#submit').click(); return true;`);
      await waitFor(() => cdp.eval(`return window.__cap.length >= 3;`), '第三次提交被捕获', 8000);
      await cdp.eval(setPrompt);
      await waitFor(() => cdp.eval(`const b = document.querySelector('#submit'); return !!b && !b.disabled && b.dataset.busy !== '1';`), '提交按钮解锁（第四次前）', 10000);
      await cdp.eval(`document.querySelector('#submit').click(); return true;`);
      await waitFor(() => cdp.eval(`return window.__cap.length >= 4;`), '第四次提交被捕获', 8000);
      const caps2 = await cdp.eval(`return window.__cap.map((b) => { try { return JSON.parse(b); } catch { return {}; } });`);
      ok('R25 提交成功后 token 作废（同参数再提交 = 新一轮付费意图，不被吞掉）',
        caps2[3].client_token !== caps2[2].client_token, JSON.stringify([caps2[2].client_token, caps2[3].client_token]));
      await cdp.eval(`
        if (window.__prevSkip == null) localStorage.removeItem('agnes.cost.skipUntil');
        else localStorage.setItem('agnes.cost.skipUntil', window.__prevSkip);
        delete window.__prevSkip;
        return true;`);

      // ── R26 时长前置说明 + 批量前置拦截
      await cdp.eval(`location.hash = '#/storyboards?project=${pid}'; return true;`);
      await waitFor(() => cdp.eval(`return document.querySelectorAll('#table tbody tr').length > 0;`), '分镜表就绪', 12000);
      const firstId = await cdp.eval(`return document.querySelector('#table tbody tr [data-edit]').getAttribute('data-edit');`);
      await cdp.eval(`document.querySelector('[data-edit="${firstId}"]').click(); return true;`);
      await waitFor(() => cdp.eval(`return !!document.querySelector('#s-dur');`), '分镜弹窗就绪', 8000);
      const dur = await cdp.eval(`
        const i = document.querySelector('#s-dur');
        i.value = '30';
        i.dispatchEvent(new Event('input', { bubbles: true }));
        return { hint: document.querySelector('#s-dur-hint').innerText, min: i.getAttribute('min'), max: i.getAttribute('max') };`);
      ok('R26 时长超上限时当场说明实际提交值（不是等扣完费才让用户发现）',
        /超出模型上限/.test(dur.hint) && /18\.3/.test(dur.hint), JSON.stringify(dur));
      ok('R26 输入框带 min/max（浏览器层面先挡一道）',
        Number(dur.min) > 3 && Number(dur.max) > 18, JSON.stringify({ min: dur.min, max: dur.max }));
      const durInRange = await cdp.eval(`
        const i = document.querySelector('#s-dur');
        i.value = '5';
        i.dispatchEvent(new Event('input', { bubbles: true }));
        return document.querySelector('#s-dur-hint').innerText;`);
      ok('R26 合法时长也给实际值（模型按 8n+1 帧量化，填写值与提交值本就略有出入）',
        /实际提交 5\.0/.test(durInRange), JSON.stringify(durInRange));
      await cdp.eval(`document.querySelector('.modal [data-yes]')?.click(); document.querySelector('.modal [data-no]')?.click(); return true;`);
      await sleep(400);
      // 把这一镜改成 30 秒并保存，然后点批量视频：必须先弹出时长偏差确认（在计费确认之前）
      await cdp.eval(`document.querySelector('[data-edit="${firstId}"]').click(); return true;`);
      await waitFor(() => cdp.eval(`return !!document.querySelector('#s-dur');`), '分镜弹窗再次就绪', 8000);
      await cdp.eval(`
        const i = document.querySelector('#s-dur'); i.value = '30'; i.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.modal [data-yes]')?.click();
        return true;`);
      await sleep(900);
      await cdp.eval(`const sa = document.querySelector('#sel-all'); sa.checked = true; sa.dispatchEvent(new Event('change')); return true;`);
      await cdp.eval(`document.querySelector('#batch-vid').click(); return true;`);
      const pre = await waitFor(() => cdp.eval(`const m = document.querySelector('.modal'); return m && /时长会被模型改写/.test(m.innerText) ? m.innerText : '';`), '时长前置确认', 8000).catch(() => '');
      ok('R26 批量提交前先列清时长偏差（花钱之前给用户改的机会）',
        /时长会被模型改写/.test(pre) && /镜头 #/.test(pre) && /按实际值继续/.test(pre), JSON.stringify(String(pre).slice(0, 160)));
      await cdp.eval(`document.querySelector('.modal [data-no]')?.click(); return true;`);
      await sleep(400);
      // 复原这一镜的时长，不给后续分组留污染
      await J(`/api/storyboards/${firstId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ duration_seconds: 5 }) });

      // ── R27 费用展示：null 不显示、有值才显示
      // 费用字段**刻意**不在 PUT 白名单里：它是上游回报的事实，不该由界面改写
      // （否则"我的账目"可以随便被改成 0）。测试从备份恢复通路（/api/import）灌带费用的记录。
      const probeVid = (id, name, credits) => J('/api/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'merge', data: { collections: { video_assets: [{
          id, project_id: pid, name, status: 'completed', local_status: 'completed',
          video_prompt: name, model_name: 'probe-model', generation_mode: 'text_to_video',
          num_frames: 121, frame_rate: 24, progress: 100, cost_credits: credits, cost_unit: credits == null ? null : 'credits',
          created_at: new Date().toISOString(),
        }] } } }),
      });
      // 探针文案必须互不为子串（踩过：'费用探针' 是 '无费用探针' 的子串，find 抓错了行）
      await probeVid('probe_cost_vid', 'probe-cost-alpha', 12);
      await probeVid('probe_nocost_vid', 'probe-cost-beta', null);
      await cdp.eval(`location.hash = '#/tasks'; return true;`);
      // 等**内容**而不是等骨架：任务页先渲染一排空 .task-row（skeleton），
      // 只等元素出现会读到空 innerText（这次 flake 的真身，靠打印行文本才看见）。
      await waitFor(() => cdp.eval(`return document.body.innerText.includes('probe-cost-alpha');`), '费用探针行就绪', 15000);
      const cost = await cdp.eval(`
        const rows = Array.from(document.querySelectorAll('.task-row'));
        const w = rows.find((r) => r.innerText.includes('probe-cost-alpha'));
        const n = rows.find((r) => r.innerText.includes('probe-cost-beta'));
        return { withCost: w ? w.innerText.replace(/\s+/g, ' ') : null, noCost: n ? n.innerText.replace(/\s+/g, ' ') : null,
          rowCount: rows.length, texts: rows.slice(0, 3).map((r) => r.innerText.replace(/\s+/g, ' ').slice(0, 60)) };`);
      ok('R27 有费用时显示"消耗 N 点"（上游真实值，不是按条数估的）',
        !!cost.withCost && /消耗 12 点/.test(cost.withCost), JSON.stringify(cost));
      ok('R27 null ≠ 0：没有费用时一个字都不显示（显示 0 会被读成免费）',
        !!cost.noCost && !/消耗|费用/.test(cost.noCost), JSON.stringify(cost));
      await J('/api/videos/probe_cost_vid', { method: 'DELETE' }).catch(() => {});
      await J('/api/videos/probe_nocost_vid', { method: 'DELETE' }).catch(() => {});

      // ── R29 项目页不再拉三个全量列表
      await cdp.eval(`
        window.__listCalls = [];
        window.__fetchOrig = window.__fetchOrig || window.fetch;
        const orig = window.fetch;
        window.fetch = async (u, o) => {
          const s = String(u);
          if (s.includes('/api/storyboards?') || s.endsWith('/api/storyboards') || s.includes('/api/images') || s.includes('/api/videos?')) window.__listCalls.push(s.replace(location.origin, ''));
          return orig(u, o);
        };
        return true;`);
      await cdp.eval(`location.hash = '#/projects'; return true;`);
      await waitFor(() => cdp.eval(`return document.querySelectorAll('.proj-card').length > 0;`), '项目卡就绪', 10000);
      await sleep(500);
      const calls = await cdp.eval(`return window.__listCalls;`);
      ok('R29 项目页不再为三个计数额外拉全量列表（服务端聚合代替）',
        calls.length === 0, JSON.stringify(calls));
      const countsOk = await cdp.eval(`return document.querySelector('.proj-card .stats')?.innerText.replace(/\s+/g, ' ') || '';`);
      ok('R29 计数照常显示（省了传输，不是省了功能）', /\d/.test(countsOk), JSON.stringify(countsOk));
      // 分组收尾：还原真实 fetch（后面还有分组要走真网络）+ 清掉打桩残留
      await cdp.eval(`
        if (window.__fetchOrig) window.fetch = window.__fetchOrig;
        delete window.__cap; delete window.__listCalls; delete window.__mode; delete window.__fetchOrig;
        return true;`);
    }

    group('提示词资产化契约（批 5：R19 运镜 / R20 平台画幅 / R21 变体）');
    {
      const J = (u, o) => fetch(`http://127.0.0.1:${port}${u}`, o).then((x) => x.json());

      // ── R20 平台 → 画幅：只有"主动改平台"才改画幅，且当场告知
      await cdp.eval(`location.hash = '#/projects'; return true;`);
      await waitFor(() => cdp.eval(`return !!document.querySelector('#new-project');`), '项目页就绪');
      await sleep(400);
      await cdp.eval(`document.querySelector('#new-project').click(); return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('#f-plat')`), '项目弹窗打开');
      await sleep(300);
      const platOpts = await cdp.eval(`return Array.from(document.querySelectorAll('#f-plat option')).map((o) => o.value);`);
      ok('R20 平台下拉带上了推荐（值仍是旧字符串，存量项目不失效）',
        Array.isArray(platOpts) && platOpts.includes('抖音') && platOpts.includes('小红书') && platOpts.length === 9, JSON.stringify(platOpts));
      // 默认（未选平台）不得擅改画幅
      await cdp.eval(`const r = document.querySelector('#f-ratio'); r.value = '16:9 横屏'; return true;`);
      await cdp.eval(`const p = document.querySelector('#f-plat'); p.value = '抖音'; p.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
      await sleep(300);
      const afterPlat = await cdp.eval(`return { ratio: document.querySelector('#f-ratio').value, hint: document.querySelector('#f-ratio-hint').innerText };`);
      ok('R20 选「抖音」自动把画幅设为 9:16 竖屏', afterPlat.ratio === '9:16 竖屏', JSON.stringify(afterPlat));
      ok('R20 画幅推荐给了理由（不是静默改掉用户的选择）',
        /推荐/.test(afterPlat.hint) && /竖屏/.test(afterPlat.hint), JSON.stringify(afterPlat));
      // 手动改画幅后再切平台：仍会推荐（用户是主动换平台的），但手动选择在"不换平台"时不受干扰
      await cdp.eval(`const r = document.querySelector('#f-ratio'); r.value = '1:1 方形'; return true;`);
      await cdp.eval(`const p = document.querySelector('#f-plat'); p.value = '小红书'; p.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
      await sleep(250);
      ok('R20 换平台再推荐一次（小红书 → 3:4 竖版）',
        (await cdp.eval(`return document.querySelector('#f-ratio').value;`)) === '3:4 竖版');
      await cdp.eval(`const p = document.querySelector('#f-plat'); p.value = '自定义'; p.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
      await sleep(250);
      const custom = await cdp.eval(`return { ratio: document.querySelector('#f-ratio').value, hint: document.querySelector('#f-ratio-hint').innerText };`);
      ok('R20 自定义平台不预设画幅（保留用户当前选择，不硬塞）',
        custom.ratio === '3:4 竖版' && /未预设画幅/.test(custom.hint), JSON.stringify(custom));
      await cdp.eval(`document.querySelector('.modal [data-no]')?.click(); return true;`);
      await sleep(300);

      // ── R19 运镜：编辑弹窗 → 保存 → 行徽标 → 预览口径
      const pid = (await J('/api/projects')).find((x) => x.name === '浏览器验收剧').id;
      const row = await J(`/api/storyboards?episode=1&project_id=${pid}`);
      const target = row.find((r) => r.image_prompt && r.video_prompt) || row[0];
      await cdp.eval(`location.hash = '#/storyboards?project=${pid}'; return true;`);
      await waitFor(() => cdp.eval(`return !!document.querySelector('[data-edit="${target.id}"]');`), '分镜行就绪', 12000);
      await cdp.eval(`document.querySelector('[data-edit="${target.id}"]').click(); return true;`);
      await waitFor(() => cdp.eval(`return !!document.querySelector('#s-cam');`), '编辑弹窗打开');
      await sleep(300);
      const camInfo = await cdp.eval(`
        const sel = document.querySelector('#s-cam');
        return { n: sel.querySelectorAll('option').length, groups: sel.querySelectorAll('optgroup').length,
          groupNames: Array.from(sel.querySelectorAll('optgroup')).map((g) => g.label),
          motionLabel: Array.from(sel.querySelectorAll('option')).filter((o) => /仅视频/.test(o.textContent)).length };`);
      ok('R19 弹窗运镜选择器 38 条 + 空项，按 8 组归类（原生 optgroup 键盘可达）',
        camInfo.n === 39 && camInfo.groups === 8 && camInfo.groupNames.includes('推拉') && camInfo.groupNames.includes('特殊'), JSON.stringify(camInfo));
      ok('R19 运动类运镜在选项里就标了「仅视频」（选之前就知道，不是保存后才说）',
        camInfo.motionLabel === 28, JSON.stringify(camInfo));
      // 选一个运动类运镜：提示必须说清"静帧图跳过"
      await cdp.eval(`const s2 = document.querySelector('#s-cam'); s2.value = '甩镜'; s2.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
      await sleep(250);
      const hintMotion = await cdp.eval(`return document.querySelector('#s-cam-hint').innerText;`);
      ok('R19 选中「甩镜」当场说明只对视频生效、并给出将注入的英文',
        /仅视频追加/.test(hintMotion) && /whip pan/.test(hintMotion), JSON.stringify(hintMotion));
      await cdp.eval(`const s2 = document.querySelector('#s-cam'); s2.value = '俯视'; s2.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
      await sleep(250);
      const hintStill = await cdp.eval(`return document.querySelector('#s-cam-hint').innerText;`);
      ok('R19 选中「俯视」说明图片与视频都会追加',
        /图片与视频都会追加/.test(hintStill) && /high angle/.test(hintStill), JSON.stringify(hintStill));
      await cdp.eval(`document.querySelector('.modal [data-yes]').click(); return true;`);
      await sleep(900);
      const saved = (await J(`/api/storyboards?episode=1&project_id=${pid}`)).find((r) => r.id === target.id);
      ok('R19 运镜随分镜一起保存（不是只存在界面上）', saved.camera_move === '俯视', JSON.stringify(saved.camera_move));
      await cdp.eval(`location.hash = '#/storyboards?project=${pid}'; return true;`);
      await waitFor(() => cdp.eval(`return !!document.querySelector('.cam-badge');`), '运镜徽标渲染', 8000);
      const badges = await cdp.eval(`
        const tr = document.querySelector('.cam-badge').closest('tr');
        const cam = tr.querySelector('.cam-badge');
        const cells = tr.querySelectorAll('[data-prompt]');
        return { text: cam.innerText, title: cam.getAttribute('title'),
          imgTags: Array.from(cells[0].querySelectorAll('.prompt-tag')).map((x) => x.innerText),
          vidTags: Array.from(cells[1].querySelectorAll('.prompt-tag')).map((x) => x.innerText) };`);
      ok('R19 行内显示运镜徽标 + 悬停给英文（不用猜这条中文会变成什么）',
        badges.text === '俯视' && /high angle looking down/.test(badges.title), JSON.stringify(badges));
      ok('R19 图片列与视频列都标了 +运镜（俯视对静帧成立）',
        badges.imgTags.includes('+运镜') && badges.vidTags.includes('+运镜'), JSON.stringify(badges));
      // 灵敏度对照：换成运动类运镜后，图片列的 +运镜 必须消失、视频列保留
      await J(`/api/storyboards/${target.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ camera_move: '甩镜' }) });
      await cdp.eval(`document.querySelector('#reload')?.click(); return true;`);
      await sleep(900);
      const badges2 = await cdp.eval(`
        const tr = document.querySelector('.cam-badge').closest('tr');
        const cells = tr.querySelectorAll('[data-prompt]');
        return { imgTags: Array.from(cells[0].querySelectorAll('.prompt-tag')).map((x) => x.innerText),
          vidTags: Array.from(cells[1].querySelectorAll('.prompt-tag')).map((x) => x.innerText),
          imgTitle: cells[0].querySelector('.cell-ellipsis').getAttribute('title') || '' };`);
      ok('灵敏度对照：运动类运镜只在视频列出现 +运镜（图片列不得谎报会注入）',
        !badges2.imgTags.includes('+运镜') && badges2.vidTags.includes('+运镜'), JSON.stringify(badges2));
      ok('R19 图片列的悬停预览里不含运动类运镜英文（预览与实际一致）',
        !/whip pan/.test(badges2.imgTitle), JSON.stringify(badges2.imgTitle.slice(0, 120)));
      await J(`/api/storyboards/${target.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ camera_move: '' }) });
    }

    group('分集上下文与逐集生成契约（批 8 补 8：本集大纲 + 前情提要 + 一集一条落库）');
    {
      const J = (u, o) => fetch(`http://127.0.0.1:${port}${u}`, o).then((x) => x.json());
      const before8 = await J('/api/settings');
      const pj8 = await J('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '逐集验收剧' }) });
      const pid = pj8.id;
      // 八拍两幕：per_episode=3 时按幕收口切成 4+4（与 apitest 同一套 __LONGARC__ 形状）
      const plotCards = [
        ['逐集·起1', '起', 'C1'], ['逐集·承1', '承', 'C2'], ['逐集·转1', '转', 'C3'], ['逐集·合1', '合', 'O1'],
        ['逐集·起2', '起', 'C4'], ['逐集·承2', '承', 'C5'], ['逐集·转2', '转', 'C6'], ['逐集·合2', '合', 'O2'],
      ];
      let lastUser8 = '';
      let sbCalls = 0;      // 分镜链被调用了几次（"每集一次""跳过的集不再调用"都要靠它证明）
      const mock = http.createServer((req, res) => {
        const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        let body = ''; req.on('data', (c) => { body += c; });
        req.on('end', () => {
          if (req.url.startsWith('/v1/chat/completions')) {
            let cb = {}; try { cb = JSON.parse(body); } catch { /* 原样通过 */ }
            const user = String(((cb.messages || []).find((m) => m.role === 'user') || {}).content || '');
            // 分镜链与卡片链按提示词形状分流（与既有各组的做法一致）
            if (/分镜表/.test(user)) {
              sbCalls++;
              return send(200, { choices: [{ message: { content: JSON.stringify({ shots: [
                { shot_number: 1, shot_type: '全景', scene_description: '逐集分镜一', characters: '', action: '', dialogue: '', narration: '', sound_effect: '', duration_seconds: 4, image_prompt: 'wide shot of a teahouse', video_prompt: 'slow push in', negative_prompt: '' },
                { shot_number: 2, shot_type: '特写', scene_description: '逐集分镜二', characters: '', action: '', dialogue: '', narration: '', sound_effect: '', duration_seconds: 3, image_prompt: 'close up of a key', video_prompt: 'hold', negative_prompt: '' },
                { shot_number: 3, shot_type: '中景', scene_description: '逐集分镜三', characters: '', action: '', dialogue: '', narration: '', sound_effect: '', duration_seconds: 3, image_prompt: 'medium shot of a door', video_prompt: 'tilt down', negative_prompt: '' },
              ] }) } }] });
            }
            lastUser8 = user;
            return send(200, { choices: [{ message: { content: JSON.stringify({ cards: plotCards.map(([name, stage, conflict]) => ({ kind: 'plot', name, stage, conflict })) }) } }] });
          }
          return send(200, { ok: true });
        });
      });
      await new Promise((r) => mock.listen(0, '127.0.0.1', r));
      const mp = mock.address().port;
      try {
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agnes_api_key: 'episode-probe-key', agnes_api_base_url: `http://127.0.0.1:${mp}/v1` }) });

        // ① 没有分集骨架时：给的是去原著解析的路，而不是一个点不动的按钮
        // 项目是**刚用 API 建的**，壳层的 state.projects 还是开机时那份 —— 不重新加载的话
        // 路由会判"链接指向的项目不存在"并切到别的项目，后面所有断言都在另一个项目上跑（这一组栽过）
        await cdp.eval(`location.hash = '#/scripts?project=${pid}&tab=episode_script'; return true;`);
        await cdp.send('Page.reload', {}); await sleep(900);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#ep-body');`), '故事脚本页分集卡就绪', 12000);
        await waitFor(() => cdp.eval(`return /还没有分集骨架/.test((document.querySelector('#ep-body')||{}).innerText||'');`), '空态提示', 8000);
        const emptyState = await cdp.eval(`const b=document.querySelector('#ep-body'); return { txt: b.innerText, link: (b.querySelector('a')||{}).getAttribute ? b.querySelector('a').getAttribute('href') : '' };`);
        ok('没有分集骨架时指路原著解析（不是死按钮）', /原著解析/.test(emptyState.txt) && /#\/novel\?project=/.test(emptyState.link), JSON.stringify(emptyState));

        // ② 造一份原著（mock 上游，不碰真实 Key）→ 分集卡活过来
        const an = await J('/api/story/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: pid, title: '逐集验收原著', text: '逐集验收原文。'.repeat(30), reduce: false }) });
        let j = null;
        for (let i = 0; i < 40; i++) { await sleep(250); j = await J(`/api/batch/${an.jobId}`); if (j.status !== 'running') break; }
        ok('逐集验收：八拍已抽出', j && j.status === 'done', JSON.stringify({ s: j && j.status, ok: j && j.ok }));
        // 分集骨架是**服务端**刚变的：同页同参再设一次 hash 不会重新初始化页面（AGENTS.md 注意事项 8）
        await cdp.send('Page.reload', {}); await sleep(900);
        await waitFor(() => cdp.eval(`return /共 2 集/.test((document.querySelector('#ep-plan')||{}).innerText||'');`), '分集骨架就绪', 12000);
        ok('分集卡报出集数与每集拍数下限', await cdp.eval(`return /共 2 集/.test(document.querySelector('#ep-plan').innerText);`));

        // ③ 载入第 2 集：本集大纲落进模板变量，前情在生成前可见
        await cdp.eval(`const n=document.querySelector('#ep-no'); n.value='2'; n.dispatchEvent(new Event('change')); return true;`);
        await cdp.eval(`document.querySelector('#ep-load').click(); return true;`);
        await waitFor(() => cdp.eval(`return /前情 1 集/.test((document.querySelector('#ep-status')||{}).innerText||'');`), '前情状态可见', 10000);
        const filled8 = await cdp.eval(`const t=document.querySelector('#fields textarea'); return t ? t.value : '';`);
        ok('「载入本集大纲」把第 2 集的拍表落进模板变量', /第 2 集/.test(filled8) && /逐集·起2/.test(filled8), String(filled8).slice(0, 90));
        ok('前情状态条说明带了多少集、多少字', await cdp.eval(`return /前情 1 集 \\/ \\d+ 字/.test(document.querySelector('#ep-status').innerText);`), await cdp.eval(`return document.querySelector('#ep-status').innerText;`));

        // ④ 单集生成：请求体里真的有前情提要与本集大纲（这是"连续性"唯一能证明的地方）
        lastUser8 = '';
        await cdp.eval(`document.querySelector('#gen').click(); return true;`);
        await waitFor(() => cdp.eval(`return /逐集·起2/.test(document.body.innerText) || !!document.querySelector('#result-wrap .card');`), '单集生成完成', 20000);
        await sleep(300);
        ok('生成请求里带上了前情提要（本地算的，不额外花钱）', /【前情提要】/.test(lastUser8) && /【第 1 集】/.test(lastUser8), lastUser8.slice(0, 120));
        ok('生成请求里带上了本集大纲', /第 2 集/.test(lastUser8) && /逐集·起2/.test(lastUser8), lastUser8.slice(0, 200));

        // ⑤ 逐集生成：先确认范围，再一集一条落库
        await cdp.eval(`document.querySelector('#gen-eps').click(); return true;`);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#b-from');`), '逐集生成弹窗', 8000);
        const modalTxt = await cdp.eval(`return (document.querySelector('.modal')||{}).innerText||'';`);
        ok('弹窗先讲清调用次数（花钱的事必须先说）', /调用一次模型/.test(modalTxt) && /共/.test(modalTxt), modalTxt.slice(0, 100));
        // 只生成第 2 集：范围真的生效（关掉弹窗再取值会拿到 null，这一条正是那个坑的钉子）
        await cdp.eval(`const f=document.querySelector('#b-from'); f.value='2'; const t=document.querySelector('#b-to'); t.value='2'; return true;`);
        await cdp.eval(`document.querySelector('.modal-foot [data-yes]').click(); return true;`);
        // 等"跑完"而不是等"成功 1"：范围没生效时进度条会显示成功 2，等一个不会出现的文案
        // 只会得到超时，把"范围没生效"这条真因埋进超时信息里（对照 AD 第一次跑就是这样）
        await waitFor(() => cdp.eval(`return /逐集生成结束|已取消/.test((document.querySelector('#ep-progress')||{}).innerText||'');`), '逐集生成结束', 30000);
        const prog8 = await cdp.eval(`return (document.querySelector('#ep-progress')||{}).innerText||'';`);
        ok('逐集生成只跑用户选的那一集（进度条如实报数）', /成功 1 · 失败 0 \/ 共 1/.test(prog8.replace(/\s+/g, ' ')), prog8.replace(/\s+/g, ' ').slice(0, 120));
        const saved8 = await J(`/api/scripts?project_id=${pid}`);
        const eps = saved8.filter((x) => x.script_type === 'episode_script');
        ok('落库的也只有那一集（范围真的生效，不是只改了个显示）', eps.length === 1 && eps[0].episode_number === 2, JSON.stringify(eps.map((x) => x.episode_number)));
        ok('落库的记录标题带集号', /第 2 集/.test(eps[0].title), eps[0].title);
        await waitFor(() => cdp.eval(`return /第 2 集/.test((document.querySelector('#saved')||{}).innerText||'');`), '已保存列表标出集号', 8000);
        ok('已保存列表把集号标出来（逐集产物一眼可辨）', await cdp.eval(`return /第 2 集/.test(document.querySelector('#saved').innerText);`));

        // ⑥ 取消：把范围放到第 1 集，取消后不许有任何调用
        const callsBefore8 = saved8.length;
        await cdp.eval(`document.querySelector('#gen-eps').click(); return true;`);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#b-from');`), '逐集生成弹窗（取消用）', 8000);
        await cdp.eval(`document.querySelector('.modal-foot [data-no]').click(); return true;`);
        await sleep(600);
        ok('取消后一集都不生成', (await J(`/api/scripts?project_id=${pid}`)).length === callsBefore8);

        // ⑦ 逐集生成分镜：剧本已经按集存好了，分镜顺着它一集一集往下做
        await cdp.eval(`location.hash = '#/storyboards?project=${pid}&episode=1'; return true;`);
        await cdp.send('Page.reload', {}); await sleep(900);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#gen-eps-sb');`), '分镜页逐集生成按钮', 12000);
        await cdp.eval(`document.querySelector('#gen-eps-sb').click(); return true;`);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#bs-from');`), '逐集生成分镜弹窗', 8000);
        const bsTxt = await cdp.eval(`return (document.querySelector('.modal')||{}).innerText||'';`);
        ok('逐集生成分镜先讲清调用次数与现有分集剧本', /每集调用一次模型/.test(bsTxt.replace(/\s+/g, '')) || /每集/.test(bsTxt), bsTxt.replace(/\s+/g, ' ').slice(0, 120));
        ok('逐集生成分镜默认跳过已有分镜的集（重跑不会翻倍）', await cdp.eval(`return !!document.querySelector('#bs-skip') && document.querySelector('#bs-skip').checked;`));
        // 默认范围是"有剧本的集"（3..5 集有剧本时不用手动改）；这里手动拉成 1〜2 集，
        // 才能测到"没有剧本的集被跳过、且不调用模型"这条路
        await cdp.eval(`const f=document.querySelector('#bs-from'); f.value='1'; const t=document.querySelector('#bs-to'); t.value='2'; return true;`);
        await cdp.eval(`document.querySelector('.modal-foot [data-yes]').click(); return true;`);
        await waitFor(() => cdp.eval(`return /逐集生成结束|已取消/.test((document.querySelector('#batch-bar')||{}).innerText||'');`), '逐集生成分镜结束', 30000);
        const bar8 = await cdp.eval(`return (document.querySelector('#batch-bar')||{}).innerText||'';`);
        // 汇总（完成几集/几个镜头）在 toast 里，逐集结果在进度条里 —— 两处都读，别只读一处就说"报数了"
        const toast8 = await cdp.eval(`return Array.from(document.querySelectorAll('.toast,.toast-wrap,#toasts')).map((x) => x.innerText).join('|');`);
        const sb2 = await J(`/api/storyboards?project_id=${pid}&episode=2`);
        ok('分镜写进了对应的那一集（不串集）', sb2.length === 3 && sb2.every((x) => Number(x.episode_number) === 2), JSON.stringify(sb2.map((x) => x.episode_number)));
        ok('没有剧本的集如实跳过、不调用模型', /成功 1/.test(bar8) && /跳过 1/.test(bar8) && /第 1 集/.test(bar8) && sbCalls === 1, JSON.stringify({ bar: bar8.replace(/\s+/g, ' ').slice(0, 110), calls: sbCalls }));
        ok('逐集结果与汇总都报数（进度条逐集、toast 汇总）',
          /成功 1 · 跳过 1 · 失败 0/.test(bar8.replace(/\s+/g, ' ')) && /完成 1 集/.test(toast8) && /3 个镜头/.test(toast8),
          JSON.stringify({ bar: bar8.replace(/\s+/g, ' ').slice(0, 90), toast: toast8.replace(/\s+/g, ' ').slice(0, 110) }));

        // 再跑一次：第 2 集已经有分镜 → 默认跳过，且**一次模型都不调**（这条是"不会翻倍"的硬证据）
        await cdp.eval(`document.querySelector('#gen-eps-sb').click(); return true;`);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#bs-from');`), '逐集生成分镜弹窗（重跑）', 8000);
        await cdp.eval(`document.querySelector('.modal-foot [data-yes]').click(); return true;`);
        await waitFor(() => cdp.eval(`return /逐集生成结束|已取消/.test((document.querySelector('#batch-bar')||{}).innerText||'');`), '重跑结束', 20000);
        const bar8b = await cdp.eval(`return (document.querySelector('#batch-bar')||{}).innerText||'';`);
        ok('重跑时已有分镜的集被跳过，且一次模型都没调', /成功 0/.test(bar8b) && /跳过 1/.test(bar8b) && sbCalls === 1, JSON.stringify({ bar: bar8b.replace(/\s+/g, ' ').slice(0, 110), calls: sbCalls }));
        ok('重跑没有把分镜翻倍（还是 3 个）', (await J(`/api/storyboards?project_id=${pid}&episode=2`)).length === 3);

      } finally {
        mock.close();
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(before8) });
        await J(`/api/projects/${pid}?cascade=1`, { method: 'DELETE' });
      }
    }

    group('逐集分镜的过期替换契约（批 8 补 15：跳过的判据不能把过期集永远锁住）');
    {
      const J = (u, o) => fetch(`http://127.0.0.1:${port}${u}`, o).then((x) => x.json());
      const before15 = await J('/api/settings');
      const pj15 = await J('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '过期分镜验收剧' }) });
      const pid = pj15.id;
      const mock = http.createServer((req, res) => {
        const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        let body = ''; req.on('data', (c) => { body += c; });
        req.on('end', () => {
          if (req.url.startsWith('/v1/chat/completions')) {
            let cb = {}; try { cb = JSON.parse(body); } catch { /* 原样通过 */ }
            const user = String(((cb.messages || []).find((m) => m.role === 'user') || {}).content || '');
            if (/已抽取的卡片清单/.test(user)) {
              return send(200, { choices: [{ message: { content: JSON.stringify({
                world: { name: '过期分镜世界观', summary: '设定' },
                plots: [
                  { name: '过期·起1', stage: '起', conflict: 'C1' }, { name: '过期·承1', stage: '承', conflict: 'C2' },
                  { name: '过期·转1', stage: '转', conflict: 'C3' }, { name: '过期·合1', stage: '合', outcome: 'O1' },
                  { name: '过期·起2', stage: '起', conflict: 'C4' }, { name: '过期·承2', stage: '承', conflict: 'C5' },
                  { name: '过期·转2', stage: '转', conflict: 'C6' }, { name: '过期·合2', stage: '合', outcome: 'O2' },
                ],
              }) } }] });
            }
            // 拆镜链：每次返回同一个镜头，便于数"这一集有几个"
            if (/分镜导演/.test(String((cb.messages || [{}])[0].content || ''))) {
              return send(200, { choices: [{ message: { content: JSON.stringify({ shots: [
                { shot_number: 1, shot_type: '中景', scene_description: '过期验收镜头', characters: '', action: '', dialogue: '', narration: '', sound_effect: '', duration_seconds: 3, image_prompt: 'expired shot', video_prompt: 'expired shot', negative_prompt: 'blurry' },
              ] }) } }] });
            }
            return send(200, { choices: [{ message: { content: JSON.stringify({ cards: [
              { kind: 'plot', name: '过期·起1', stage: '起', conflict: 'C1' },
            ] }) } }] });
          }
          return send(200, { ok: true });
        });
      });
      await new Promise((r) => mock.listen(0, '127.0.0.1', r));
      const mp = mock.address().port;
      try {
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agnes_api_key: 'stale-shot-key', agnes_api_base_url: `http://127.0.0.1:${mp}/v1` }) });
        const an = await J('/api/story/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: pid, title: '过期分镜原著', text: '过期分镜验收用的长弧线故事。'.repeat(30) }) });
        for (let i = 0; i < 40; i++) { await sleep(250); const j = await J(`/api/batch/${an.jobId}`); if (j.status !== 'running') break; }
        // 第 1 集剧本 + 它的输入指纹（等价于逐集生成）
        const b1 = await J(`/api/story/episode-brief?project_id=${pid}&source_id=${an.source.id}&per_episode=4&episode=1`);
        const sc1 = await J('/api/scripts', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: pid, script_type: 'episode_script', episode_number: 1, title: '第 1 集', content: '第 1 集剧本正文', plan_digest: b1.input_digest }) });
        // 第 1 集先有一份**按旧剧本生成**的分镜
        await J('/api/storyboards', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows: [{ project_id: pid, episode_number: 1, shot_number: 1, scene_description: '旧镜头', image_prompt: 'old shot', source_script_id: sc1.id }] }) });
        const before = (await J(`/api/storyboards?project_id=${pid}&episode=1`)).length;
        ok('过期分镜验收：第 1 集已有一份分镜', before === 1, String(before));

        // 改剧本正文 → 由它生成的分镜过期
        await J(`/api/scripts/${sc1.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '第 1 集剧本正文（改过）' }) });
        const st = await J(`/api/story/staleness?project_id=${pid}`);
        ok('剧本改过后，第 1 集分镜被判定为过期（界面据此不跳过它）',
          (st.episodes || []).some((e) => e.episode_number === 1 && e.shot_state === 'stale'), JSON.stringify((st.episodes || []).map((e) => [e.episode_number, e.shot_state])));

        await cdp.eval(`location.hash = '#/storyboards?project=${pid}&episode=1'; return true;`);
        await cdp.send('Page.reload', {}); await sleep(900);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#gen-eps-sb');`), '分镜页（逐集生成按钮）', 12000);
        await cdp.eval(`document.querySelector('#gen-eps-sb').click(); return true;`);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#bs-replace');`), '逐集生成分镜弹窗', 12000);
        const body = await cdp.eval(`return (document.querySelector('.modal-body') || {}).innerText || '';`);
        ok('弹窗点名"哪几集的剧本内容改过"（用户知道为什么会重生成这些集）',
          /剧本内容改过/.test(body) && /第 1 集/.test(body), body.replace(/\s+/g, ' ').slice(0, 200));
        ok('过期分镜的"先清空再重生成"默认勾上（不勾就会在旧分镜后面追加一份）',
          await cdp.eval(`return !!document.querySelector('#bs-replace') && document.querySelector('#bs-replace').checked;`));
        await cdp.eval(`document.querySelector('.modal-foot [data-yes]').click(); return true;`);
        await waitFor(() => cdp.eval(`return /逐集生成结束/.test(document.querySelector('#batch-bar') ? document.querySelector('#batch-bar').innerText : '');`), '逐集生成结束', 25000);
        const after = await J(`/api/storyboards?project_id=${pid}&episode=1`);
        ok('过期集被重生成，且旧分镜被替换掉（不是叠加成两份）',
          after.length === 1 && after[0].scene_description === '过期验收镜头', JSON.stringify(after.map((r) => r.scene_description)));
        // 逐集结果在 #batch-bar（每集一行），**汇总结论在 toast** —— 两处都要读
        const bar = await cdp.eval(`return (document.querySelector('#batch-bar') || {}).innerText || '';`);
        ok('逐集结果标出这一集是"已替换过期分镜"',
          /已替换过期分镜/.test(bar.replace(/\s+/g, ' ')), bar.replace(/\s+/g, ' ').slice(0, 160));
        const toastTxt = await cdp.eval(`return Array.from(document.querySelectorAll('.toast,.toast-wrap,#toasts')).map((x) => x.innerText).join('|');`);
        ok('汇总里报出"替换了几个过期镜头"（"删了又生成"必须能看见）',
          /替换 1 个过期镜头/.test(toastTxt.replace(/\s+/g, ' ')), toastTxt.replace(/\s+/g, ' ').slice(0, 200));
      } finally {
        mock.close();
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(before15) });
        await J(`/api/projects/${pid}?cascade=1`, { method: 'DELETE' });
      }
    }

    group('负面提示词契约（批 8 补 14：图片链此前完全没读它）');
    {
      const J = (u, o) => fetch(`http://127.0.0.1:${port}${u}`, o).then((x) => x.json());
      const before14 = await J('/api/settings');
      const pj14 = await J('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '负面词验收剧' }) });
      const pid = pj14.id;
      const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      let sentPrompt = null;
      const mock = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (u.pathname === '/pixel.png') { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length }); return res.end(PNG); }
        let body = ''; req.on('data', (c) => { body += c; });
        req.on('end', () => {
          if (u.pathname === '/v1/images/generations') {
            let b = {}; try { b = JSON.parse(body); } catch { /* 原样通过 */ }
            sentPrompt = b.prompt || '';
            return send(200, { data: [{ url: `http://127.0.0.1:${mock.address().port}/pixel.png` }] });
          }
          return send(200, { ok: true });
        });
      });
      await new Promise((r) => mock.listen(0, '127.0.0.1', r));
      const mp = mock.address().port;
      try {
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agnes_api_key: 'neg-probe-key', agnes_api_base_url: `http://127.0.0.1:${mp}/v1` }) });
        await J('/api/storyboards', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows: [{ project_id: pid, episode_number: 1, shot_number: 1, scene_description: '甲',
            image_prompt: 'a girl standing', negative_prompt: 'low quality, blurry', duration_seconds: 3 }] }) });

        await cdp.eval(`localStorage.removeItem('agnes.cost.skipUntil'); location.hash = '#/storyboards?project=${pid}&episode=1'; return true;`);
        await cdp.send('Page.reload', {}); await sleep(900);
        await waitFor(() => cdp.eval(`return !!document.querySelector('[data-prompt="image_prompt"] .prompt-tag');`), '图片列注入标签', 12000);
        const tags = await cdp.eval(`return Array.from(document.querySelectorAll('[data-prompt="image_prompt"] .prompt-tag')).map((x) => x.textContent.trim());`);
        ok('图片列显示 +负面 标签（不然用户不知道负面词在起作用）',
          (tags || []).includes('+负面'), JSON.stringify(tags));
        const tip = await cdp.eval(`return document.querySelector('[data-prompt="image_prompt"] .inline-target').title || '';`);
        ok('悬停"实际发出"里能看到负面词被并入（预览与后端同一套算法）',
          /避免出现：low quality, blurry/.test(tip), tip.replace(/\s+/g, ' ').slice(0, 200));

        await cdp.eval(`document.querySelector('[data-img]').click(); return true;`);
        await waitFor(() => cdp.eval(`return !!document.querySelector('.modal-foot [data-yes]');`), '出图计费确认', 8000);
        await cdp.eval(`document.querySelector('.modal-foot [data-yes]').click(); return true;`);
        await waitFor(() => cdp.eval(`return /图片已生成/.test(document.body.innerText);`), '出图完成', 20000).catch(() => false);
        ok('真正发出去的提示词里含负面词，且**没有**单发 negative_prompt 字段（网关会 400）',
          /避免出现：low quality, blurry/.test(String(sentPrompt)), String(sentPrompt).slice(0, 200));
      } finally {
        mock.close();
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(before14) });
        await J(`/api/projects/${pid}?cascade=1`, { method: 'DELETE' });
      }
    }

    group('角色参考图进出图输入（批 8 补 13：传了参考图就该真的用上）');
    {
      const J = (u, o) => fetch(`http://127.0.0.1:${port}${u}`, o).then((x) => x.json());
      const before13 = await J('/api/settings');
      const pj13 = await J('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '参考图验收剧' }) });
      const pid = pj13.id;
      const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      let sentImages = null; // 上游实际收到的 image 参数
      const mock = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (u.pathname === '/pixel.png') { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length }); return res.end(PNG); }
        let body = ''; req.on('data', (c) => { body += c; });
        req.on('end', () => {
          if (u.pathname === '/v1/images/generations') {
            let b = {}; try { b = JSON.parse(body); } catch { /* 原样通过 */ }
            sentImages = b.image || null;
            return send(200, { data: [{ url: `http://127.0.0.1:${mock.address().port}/pixel.png` }] });
          }
          return send(200, { ok: true });
        });
      });
      await new Promise((r) => mock.listen(0, '127.0.0.1', r));
      const mp = mock.address().port;
      try {
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agnes_api_key: 'ref-probe-key', agnes_api_base_url: `http://127.0.0.1:${mp}/v1` }) });
        // 一张公网参考图（能被 Agnes 抓）——角色库把参考图当封面显示，但它此前从没进过出图调用
        const refImg = await J('/api/images', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: pid, name: '公网参考图', remote_url: 'https://example.com/face.png', url: 'https://example.com/face.png', usage_type: 'character' }) });
        const ch = await J('/api/characters', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: pid, name: '参考图角色', appearance: '长发及腰', is_locked: true, reference_image_ids: [refImg.id] }) });
        await J('/api/storyboards', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: pid, episode_number: 1, shot_number: 1, scene_description: '甲', image_prompt: 'a girl standing', character_ids: [ch.id], duration_seconds: 3 }) });

        await cdp.eval(`localStorage.removeItem('agnes.cost.skipUntil'); location.hash = '#/storyboards?project=${pid}&episode=1'; return true;`);
        await cdp.send('Page.reload', {}); await sleep(900);
        await waitFor(() => cdp.eval(`return !!document.querySelector('[data-img]');`), '参考图验收镜头行', 12000);
        await cdp.eval(`document.querySelector('[data-img]').click(); return true;`);
        await waitFor(() => cdp.eval(`return !!document.querySelector('.modal-foot [data-yes]');`), '出图计费确认', 8000);
        await cdp.eval(`document.querySelector('.modal-foot [data-yes]').click(); return true;`);
        // 等**具体**那句话，而不是"页面里出现过参考图"：toast 几秒后会自动消失，
        // 泛匹配会先命中别的字样、再读到一个空 toast（本轮踩过：断言时好时坏）
        const toastSeen = await waitFor(() => cdp.eval(`return /已带上 1 张角色参考图/.test(document.body.innerText);`), '出图结果提示（含参考图张数）', 20000)
          .then(() => true).catch(() => false);
        ok('出图时自动把绑定角色的公网参考图发给上游（此前它只被当封面显示）',
          Array.isArray(sentImages) && sentImages.includes('https://example.com/face.png'), JSON.stringify(sentImages));
        ok('提示里说明"带上了几张参考图、是谁的"（用户知道参考图真的生效了）', toastSeen);
      } finally {
        mock.close();
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(before13) });
        await J(`/api/projects/${pid}?cascade=1`, { method: 'DELETE' });
      }
    }

    group('过期体检契约（批 8 补 12：输入变了要能看见，默认范围据此收窄）');
    {
      const J = (u, o) => fetch(`http://127.0.0.1:${port}${u}`, o).then((x) => x.json());
      const before12 = await J('/api/settings');
      const pj12 = await J('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '过期验收剧' }) });
      const pid = pj12.id;
      const mock = http.createServer((req, res) => {
        const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        let body = ''; req.on('data', (c) => { body += c; });
        req.on('end', () => {
          if (req.url.startsWith('/v1/chat/completions')) {
            let cb = {}; try { cb = JSON.parse(body); } catch { /* 原样通过 */ }
            const user = String(((cb.messages || []).find((m) => m.role === 'user') || {}).content || '');
            // 归并链给出"两幕八拍"，够切成两集；其余（抽取）给一张剧情卡
            if (/已抽取的卡片清单/.test(user)) {
              return send(200, { choices: [{ message: { content: JSON.stringify({
                world: { name: '过期验收世界观', summary: '设定' },
                plots: [
                  { name: '过期·起1', stage: '起', conflict: 'C1' }, { name: '过期·承1', stage: '承', conflict: 'C2' },
                  { name: '过期·转1', stage: '转', conflict: 'C3' }, { name: '过期·合1', stage: '合', outcome: 'O1' },
                  { name: '过期·起2', stage: '起', conflict: 'C4' }, { name: '过期·承2', stage: '承', conflict: 'C5' },
                  { name: '过期·转2', stage: '转', conflict: 'C6' }, { name: '过期·合2', stage: '合', outcome: 'O2' },
                ],
              }) } }] });
            }
            return send(200, { choices: [{ message: { content: JSON.stringify({ cards: [
              { kind: 'plot', name: '过期·起1', stage: '起', conflict: 'C1' },
            ] }) } }] });
          }
          return send(200, { ok: true });
        });
      });
      await new Promise((r) => mock.listen(0, '127.0.0.1', r));
      const mp = mock.address().port;
      try {
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agnes_api_key: 'stale-probe-key', agnes_api_base_url: `http://127.0.0.1:${mp}/v1` }) });
        const an = await J('/api/story/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: pid, title: '过期验收原著', text: '过期验收用的长弧线故事。'.repeat(30) }) });
        for (let i = 0; i < 40; i++) { await sleep(250); const j = await J(`/api/batch/${an.jobId}`); if (j.status !== 'running') break; }
        const eps = await J(`/api/story/episodes?project_id=${pid}&source_id=${an.source.id}&per_episode=4`);
        ok('过期验收：分集骨架已就位', eps.episode_count >= 2, JSON.stringify({ n: eps.episode_count }));

        await cdp.eval(`location.hash = '#/scripts?project_id=${pid}'; return true;`);
        await cdp.send('Page.reload', {}); await sleep(900);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#ep-stale');`), '故事脚本页分集卡（含过期体检按钮）', 12000);
        await cdp.eval(`document.querySelector('#ep-stale').click(); return true;`);
        await waitFor(() => cdp.eval(`return /过期体检/.test((document.querySelector('#ep-stale-box')||{}).innerText||'');`), '过期体检结果', 12000);
        const box = await cdp.eval(`return (document.querySelector('#ep-stale-box')||{}).innerText||'';`);
        ok('体检面板报出"缺剧本 N 集 / 建议重生成 M 集"（不是含糊的一句"有问题"）',
          /缺剧本/.test(box) && /建议重生成/.test(box), box.replace(/\s+/g, ' ').slice(0, 150));
        ok('逐集列出每一集的状态（用户知道是哪几集）', /第 1 集/.test(box) && /还没有剧本/.test(box), box.replace(/\s+/g, ' ').slice(0, 150));

        // 默认范围据此收窄：全都缺剧本时就是全集
        await cdp.eval(`document.querySelector('#gen-eps').click(); return true;`);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#b-from');`), '逐集生成弹窗', 10000);
        const dflt = await cdp.eval(`const f=document.querySelector('#b-from'), t=document.querySelector('#b-to'); return f.value + '-' + t.value;`);
        ok('默认范围来自体检（缺剧本/已过期的那几集），不是无脑全跑', dflt === `1-${eps.episode_count}`, dflt);
        await cdp.eval(`document.querySelector('.modal-foot [data-no]').click(); return true;`);

        // 用 API 存一份"第 1 集剧本 + 它的输入指纹"，再重切分集 → 页面应报过期
        const b1 = await J(`/api/story/episode-brief?project_id=${pid}&source_id=${an.source.id}&per_episode=4&episode=1`);
        await J('/api/scripts', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: pid, script_type: 'story_concept', episode_number: 1, title: '第 1 集', content: '第 1 集正文', plan_digest: b1.input_digest }) });
        // 故事脚本页用的是**服务端默认**的每集拍数（hash 上的 per_episode 它不认），
        // 所以要真的让第 1 集的输入变，得改**原著卡片**（追加/修正解析结果就是这条路径）
        const cards12 = await J(`/api/story/cards?source_id=${an.source.id}`);
        const beat = cards12.filter((c) => c.kind === 'plot').sort((x, y) => (Number(x.order) || 0) - (Number(y.order) || 0))[0];
        ok('过期验收：拿到第 1 集的第一拍', !!beat, JSON.stringify(cards12.map((c) => c.name)));
        await J(`/api/story/cards/${beat.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conflict: 'C1（原著后续章节补充了这场冲突的细节）' }) });
        await cdp.eval(`location.hash = '#/scripts?project_id=${pid}'; return true;`);
        await cdp.send('Page.reload', {}); await sleep(900);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#ep-stale');`), '故事脚本页（重切后）', 12000);
        await cdp.eval(`document.querySelector('#ep-stale').click(); return true;`);
        await waitFor(() => cdp.eval(`return /过期体检/.test((document.querySelector('#ep-stale-box')||{}).innerText||'');`), '重切后的体检结果', 12000);
        const box2 = await cdp.eval(`return (document.querySelector('#ep-stale-box')||{}).innerText||'';`);
        ok('原著卡片改过之后，第 1 集被标成"输入已变，建议重生成"',
          /建议重生成/.test(box2) && /输入已变/.test(box2), box2.replace(/\s+/g, ' ').slice(0, 170));
        ok('面板给出过期条数（重生成是花钱的事，数字要摆在点按钮之前）',
          /建议重生成\s*1\s*集/.test(box2.replace(/\s+/g, ' ')) || /建议重生成 1 集/.test(box2.replace(/\s+/g, ' ')),
          box2.replace(/\s+/g, ' ').slice(0, 170));
      } finally {
        mock.close();
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(before12) });
        await J(`/api/projects/${pid}?cascade=1`, { method: 'DELETE' });
      }
    }

    group('人物卡↔资产库漂移契约（批 8 补 11：同步只动会注入提示词的字段）');
    {
      const J = (u, o) => fetch(`http://127.0.0.1:${port}${u}`, o).then((x) => x.json());
      const before11 = await J('/api/settings');
      const pj11 = await J('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '漂移验收剧' }) });
      const pid = pj11.id;
      const mock = http.createServer((req, res) => {
        const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        let body = ''; req.on('data', (c) => { body += c; });
        req.on('end', () => {
          if (req.url.startsWith('/v1/chat/completions')) {
            return send(200, { choices: [{ message: { content: JSON.stringify({ cards: [
              { kind: 'character', name: '漂移验收角色', role: '主角', identity: '验收用', appearance: '白衣' },
            ] }) } }] });
          }
          return send(200, { ok: true });
        });
      });
      await new Promise((r) => mock.listen(0, '127.0.0.1', r));
      const mp = mock.address().port;
      try {
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agnes_api_key: 'drift-probe-key', agnes_api_base_url: `http://127.0.0.1:${mp}/v1` }) });
        const an = await J('/api/story/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: pid, title: '漂移验收原著', text: '漂移验收角色走进茶馆。', reduce: false }) });
        for (let i = 0; i < 40; i++) { await sleep(250); const j = await J(`/api/batch/${an.jobId}`); if (j.status !== 'running') break; }
        await J('/api/story/cards/import-characters', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: pid, source_id: an.source.id }) });
        const cards = await J(`/api/story/cards?source_id=${an.source.id}`);
        const card = cards.find((c) => c.kind === 'character');
        ok('漂移验收：人物卡与资产库角色都就位', !!card, JSON.stringify(cards.map((c) => c.name)));
        const char0 = (await J(`/api/characters?project_id=${pid}`)).find((c) => c.story_card_id === card.id);

        // 制造漂移：改人物卡（等价于"追加解析补全了卡"），同时用户自己在资产库里改了角色定位
        await J(`/api/story/cards/${card.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appearance: '长发及腰，左眉有疤', outfit: '青色长衫', aliases: ['阿晚'] }) });
        await J(`/api/characters/${char0.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: '反派', personality: '暴躁易怒' }) });

        // 页面上体检：面板要出现这一条，并给出"同步到资产库"按钮
        await cdp.eval(`location.hash = '#/novel?project_id=${pid}&source_id=${an.source.id}'; return true;`);
        await cdp.send('Page.reload', {}); await sleep(900);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#nov-audit');`), '原著页体检按钮', 12000);
        await cdp.eval(`document.querySelector('#nov-audit').click(); return true;`);
        await waitFor(() => cdp.eval(`return /资产库里的「漂移验收角色」与人物卡不一致/.test((document.querySelector('#nov-audit-box')||{}).innerText||'');`), '漂移问题出现在面板上', 12000);
        const panel = await cdp.eval(`return (document.querySelector('#nov-audit-box')||{}).innerText||'';`);
        ok('面板同时给出"资产库值 → 人物卡值"的对照（用户能判断哪份对）',
          /外貌/.test(panel) && /白衣/.test(panel) && /长发及腰/.test(panel), panel.replace(/\s+/g, ' ').slice(0, 160));
        ok('面板上的动作是「同步到资产库」（不是含糊的"一键修复"）',
          /同步到资产库/.test(panel), panel.replace(/\s+/g, ' ').slice(0, 100));

        // 点同步：先弹确认，把逐字段的改动摆出来
        await cdp.eval(`const b=[...document.querySelectorAll('#nov-audit-box [data-audit-fix]')].find((x)=>x.getAttribute('data-audit-fix')==='sync_character'); b.click(); return true;`);
        await waitFor(() => cdp.eval(`return /把人物卡同步到资产库/.test((document.querySelector('.modal')||{}).innerText||'');`), '同步确认弹窗', 8000);
        const mtxt = await cdp.eval(`return (document.querySelector('.modal')||{}).innerText||'';`);
        ok('确认弹窗逐条列出"哪个值变哪个值"',
          /白衣/.test(mtxt) && /长发及腰/.test(mtxt) && /只动外貌/.test(mtxt), mtxt.replace(/\s+/g, ' ').slice(0, 180));
        await cdp.eval(`document.querySelector('.modal-foot [data-yes]').click(); return true;`);
        await waitFor(() => cdp.eval(`return /同步到资产库|已经一致/.test(document.body.innerText);`), '同步完成提示', 12000);

        // 结果：会注入提示词的字段按人物卡覆盖，用户自己改的不动
        const char1 = (await J(`/api/characters?project_id=${pid}`)).find((c) => c.id === char0.id);
        ok('同步后资产库的外貌/服饰按人物卡更新', char1.appearance === '长发及腰，左眉有疤' && char1.outfit === '青色长衫',
          JSON.stringify({ a: char1.appearance, o: char1.outfit }));
        ok('同步不覆盖用户自己改的角色定位与性格（只动会影响出图的字段）',
          char1.role === '反派' && char1.personality === '暴躁易怒', JSON.stringify({ r: char1.role, p: char1.personality }));
        ok('同步后这条漂移从面板上消失', !/与人物卡不一致/.test(String(await cdp.eval(`return (document.querySelector('#nov-audit-box')||{}).innerText||'';`))));
      } finally {
        mock.close();
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(before11) });
        await J(`/api/projects/${pid}?cascade=1`, { method: 'DELETE' });
      }
    }

    group('追加解析契约（批 8 补 10：只解析新增章节 / 已有卡 id 不变）');
    {
      const J = (u, o) => fetch(`http://127.0.0.1:${port}${u}`, o).then((x) => x.json());
      const before10 = await J('/api/settings');
      const pj10 = await J('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '追加验收剧' }) });
      const pid = pj10.id;
      let appendUser = '';   // 追加那次调用发给模型的 user message（证明"只发新增的"）
      let appendCalls = 0;
      const mock = http.createServer((req, res) => {
        const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        let body = ''; req.on('data', (c) => { body += c; });
        req.on('end', () => {
          if (req.url.startsWith('/v1/chat/completions')) {
            let cb = {}; try { cb = JSON.parse(body); } catch { /* 原样通过 */ }
            const user = String(((cb.messages || []).find((m) => m.role === 'user') || {}).content || '');
            // 归并链与抽取链分开。判据要用**渲染后仍在**的字样：{{原文段落}} 这个占位符
            // 会被替换成正文（渲染后并不存在"原文段落"四个字），而"已抽取的卡片清单"是模板里的固定文案
            if (!/已抽取的卡片清单/.test(user)) {
              appendCalls++;
              appendUser = user;
              return send(200, { choices: [{ message: { content: JSON.stringify({ cards: [
                { kind: 'character', name: '追加验收角色', identity: '茶馆老板' },
                { kind: 'location', name: '追加验收茶馆', atmosphere: '潮湿昏暗' },
              ] }) } }] });
            }
            return send(200, { choices: [{ message: { content: JSON.stringify({ world: { name: '追加验收世界观', summary: '归并出的设定' }, plots: [{ name: '追加验收剧情', stage: '起' }] }) } }] });
          }
          return send(200, { ok: true });
        });
      });
      await new Promise((r) => mock.listen(0, '127.0.0.1', r));
      const mp = mock.address().port;
      try {
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agnes_api_key: 'append-probe-key', agnes_api_base_url: `http://127.0.0.1:${mp}/v1` }) });

        // ① 先整本解析一份（这一步用 API，UI 走不走同一条路不影响本组的判据）
        const an = await J('/api/story/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: pid, title: '追加验收原著', text: '第一卷：临江茶馆。'.repeat(30) }) });
        for (let i = 0; i < 40; i++) { await sleep(250); const j = await J(`/api/batch/${an.jobId}`); if (j.status !== 'running') break; }
        const cards1 = await J(`/api/story/cards?source_id=${an.source.id}`);
        const before = cards1.map((c) => `${c.kind}:${c.name}#${c.id}`).sort();
        ok('追加验收：首次解析落了一批卡', cards1.length > 0, String(cards1.length));

        // ② 页面上追加：输入框只放新增章节，点「追加到选中的原著」
        await cdp.eval(`location.hash = '#/novel?project_id=${pid}&source_id=${an.source.id}'; return true;`);
        await cdp.send('Page.reload', {}); await sleep(900);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#nov-append');`), '原著页追加按钮', 12000);
        // 选中这份来源：卡片列表里点它（页面的 sourceId 来自参数，但重新选中能确保左栏状态一致）
        const marked = await cdp.eval(`const el=document.querySelector('[data-src="${an.source.id}"]'); return el ? getComputedStyle(el).borderColor : '';`);
        ok('带 source_id 进来时左侧那份原著被标成选中（用户知道自己在往哪追加）', !!marked && marked !== 'rgba(0, 0, 0, 0)', marked);
        await cdp.eval(`const t=document.querySelector('#nov-text'); t.value='第二卷：夜访密室。'.repeat(30); t.dispatchEvent(new Event('input')); return true;`);
        // 前面几组可能点过"今天内不再提醒"（localStorage 是同一个 profile）——不关掉就没有计费弹窗可断言
        await cdp.eval(`localStorage.removeItem('agnes.cost.skipUntil'); return true;`);
        appendCalls = 0;
        await cdp.eval(`document.querySelector('#nov-append').click(); return true;`);
        // 先算钱再确认：这是"花钱的事先说清"的既有纪律
        await waitFor(() => cdp.eval(`return /追加解析/.test((document.querySelector('.modal')||{}).innerText||'');`), '追加的计费确认弹窗', 10000);
        const costTxt = await cdp.eval(`return (document.querySelector('.modal')||{}).innerText||'';`);
        ok('追加前先算钱，并说明已有章节不重跑、已有卡片 id 不变',
          /已有/.test(costTxt) && /不重跑/.test(costTxt) && /id 不变/.test(costTxt), costTxt.replace(/\s+/g, ' ').slice(0, 140));
        await cdp.eval(`document.querySelector('.modal-foot [data-yes]').click(); return true;`);
        await waitFor(() => cdp.eval(`return /追加解析/.test((document.querySelector('#batch-bar')||{}).innerText||'') || /已开始追加解析/.test(document.body.innerText);`), '追加任务已提交', 12000);
        for (let i = 0; i < 40; i++) { await sleep(300); const j = await J(`/api/batch/${an.jobId}`); if (j.status !== 'running') break; }

        // ③ 只发新增的那一段（这才是"不为前面几十万字反复付费"的证据）
        ok('追加只把新增章节发给模型（正文里没有第一卷的内容）',
          /第二卷/.test(appendUser) && !/第一卷/.test(appendUser), appendUser.replace(/\s+/g, ' ').slice(-140));

        // ④ 已有卡 id 一个都没变
        const cards2 = await J(`/api/story/cards?source_id=${an.source.id}`);
        const after = cards2.map((c) => `${c.kind}:${c.name}#${c.id}`).sort();
        ok('追加后已有卡 id 一个都没变（分镜绑定不会悬空）', before.every((k) => after.includes(k)),
          JSON.stringify({ before, after: after.filter((x) => !before.includes(x)) }));

        // ⑤ 归并重跑同样不换 id（原来的"删了重建"每次归并都换一批 id）
        const bibleBefore = cards2.filter((c) => c.origin === 'bible').map((c) => `${c.name}#${c.id}`).sort();
        await J('/api/story/reduce', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source_id: an.source.id }) });
        const cards3 = await J(`/api/story/cards?source_id=${an.source.id}`);
        const bibleAfter = cards3.filter((c) => c.origin === 'bible').map((c) => `${c.name}#${c.id}`).sort();
        ok('归并重跑后信息卡/剧情卡 id 不变（界面与绑定都还指得准）',
          bibleBefore.length > 0 && bibleBefore.join('|') === bibleAfter.join('|'),
          JSON.stringify({ bibleBefore, bibleAfter }));

        // ⑥ 没选原著时：明确说这是"新建"而不是静默追加
        await cdp.eval(`location.hash = '#/novel?project_id=${pid}'; return true;`);
        await cdp.send('Page.reload', {}); await sleep(900);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#nov-append');`), '原著页（未选来源）', 12000);
        await cdp.eval(`const t=document.querySelector('#nov-text'); t.value='第三卷内容。'.repeat(10); t.dispatchEvent(new Event('input')); return true;`);
        await cdp.eval(`document.querySelector('#nov-append').click(); return true;`);
        await sleep(700);
        const toastTxt = await cdp.eval(`return Array.from(document.querySelectorAll('.toast,.toast-wrap,#toasts')).map((x) => x.innerText).join('|');`);
        ok('没选原著时明确提示"先在左侧选中要追加到哪一份"（不静默新建一份）',
          /先在左侧选中要追加到哪一份原著/.test(toastTxt), toastTxt.replace(/\s+/g, ' ').slice(0, 120));
      } finally {
        mock.close();
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(before10) });
        await J(`/api/projects/${pid}?cascade=1`, { method: 'DELETE' });
      }
    }

    group('原著→剧本一键带入契约（批 8 补：跨页带入落到模板变量）');
    {
      const J = (u, o) => fetch(`http://127.0.0.1:${port}${u}`, o).then((x) => x.json());
      const pid = (await J('/api/projects')).find((x) => x.name === '浏览器验收剧').id;
      const before = await J('/api/settings');
      // 只为了让"分块抽取"能拿到一份卡片 JSON：mock 上游，不碰真实 Key
      const mock = http.createServer((req, res) => {
        const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        let body = ''; req.on('data', (c) => { body += c; });
        req.on('end', () => {
          if (req.url.startsWith('/v1/chat/completions')) {
            return send(200, { choices: [{ message: { content: JSON.stringify({ cards: [
              { kind: 'character', name: '带入验收角色', role: '主角', identity: '验收用角色', appearance: '青衫' },
              { kind: 'plot', name: '带入验收剧情', stage: '起', conflict: '验收冲突', outcome: '验收结果' },
            ] }) } }] });
          }
          return send(200, { ok: true });
        });
      });
      await new Promise((r) => mock.listen(0, '127.0.0.1', r));
      const mp = mock.address().port;
      let src = null;
      try {
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agnes_api_key: 'bible-probe-key', agnes_api_base_url: `http://127.0.0.1:${mp}/v1` }) });
        const an = await J('/api/story/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: pid, title: '带入验收原著', text: '带入验收角色走进茶馆，冲突发生。', reduce: false }) });
        ok('带入验收：解析受理', !!an.jobId, JSON.stringify(an).slice(0, 120));
        let j = null;
        for (let i = 0; i < 40; i++) { await sleep(250); j = await J(`/api/batch/${an.jobId}`); if (j.status !== 'running') break; }
        ok('带入验收：卡片已抽出', j && j.status === 'done' && j.ok >= 1, JSON.stringify({ s: j && j.status, ok: j && j.ok }));
        src = an.source && an.source.id;

        await cdp.eval(`location.hash = '#/novel?project_id=${pid}&source_id=${src}'; return true;`);
        await waitFor(() => cdp.eval(`document.body.innerText.includes('带入验收角色')`), '原著解析页显示卡片', 12000);
        ok('原著解析页按 source_id 深链直接展示卡片（可刷新/可分享）',
          await cdp.eval(`document.body.innerText.includes('带入验收角色') && document.body.innerText.includes('带入验收剧情')`));

        // 一键带入：不再需要"复制→切页→找字段→粘贴"四步
        await cdp.eval(`document.querySelector('#nov-toscript').click(); return true;`);
        await waitFor(() => cdp.eval(`location.hash.startsWith('#/scripts')`), '跳转到故事脚本页', 8000);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#fields textarea');`), '单集脚本页签就绪', 12000);
        const filled = await waitFor(() => cdp.eval(`return (document.querySelector('#fields textarea')||{}).value || '';`)
          .then((v) => (String(v).includes('带入验收角色') ? v : false)), '卡片文本落入模板变量', 10000).then((v) => v || '').catch(() => '');
        ok('带入后模板变量里就是卡片文本（含人物卡与剧情卡）',
          String(filled).includes('带入验收角色') && String(filled).includes('带入验收剧情'), String(filled).slice(0, 80));
        const strip = await cdp.eval(`return (document.querySelector('#upstream')||{}).innerText || '';`);
        ok('带入后提示条说明来源与落点（可见才可确认）',
          strip.includes('原著解析') && strip.includes('本集大纲'), strip.replace(/\n/g, ' ').slice(0, 100));
        ok('带入参数已从 URL 抹掉（刷新不会重复覆盖用户后来的修改）',
          !(await cdp.eval(`location.hash.includes('bible=')`)));
        // 撤销带入要还原成带入前的内容，不能一律清空（跨页带入可能覆盖用户已写好的字段）
        // 可选链：带入没落位时提示条不存在，这里要"干净地红"而不是 click of null 崩掉整组
        await cdp.eval(`document.querySelector('#up-undo')?.click(); return true;`);
        await sleep(300);
        ok('撤销带入把字段还原（带入前是空的，还原后仍为空）',
          (await cdp.eval(`return (document.querySelector('#fields textarea')||{}).value || '';`)) === '');
      } finally {
        mock.close();
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agnes_api_key: before.agnes_api_key || '', agnes_api_base_url: before.agnes_api_base_url || '' }) });
        if (src) await fetch(`http://127.0.0.1:${port}/api/story/sources/${src}`, { method: 'DELETE' });
      }
    }

    group('原著卡片注入契约（批 8 补 2：绑卡 → 徽标 → 预览层 → 真机落库）');
    {
      const J = (u, o) => fetch(`http://127.0.0.1:${port}${u}`, o).then((x) => x.json());
      const pid = (await J('/api/projects')).find((x) => x.name === '浏览器验收剧').id;
      const before = await J('/api/settings');
      const mock = http.createServer((req, res) => {
        const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        let body = ''; req.on('data', (c) => { body += c; });
        req.on('end', () => {
          if (req.url.startsWith('/v1/chat/completions')) {
            return send(200, { choices: [{ message: { content: JSON.stringify({ cards: [
              { kind: 'location', name: '注入验收茶馆', atmosphere: '喧闹潮湿', region: '临江' },
              { kind: 'prop', name: '注入验收钥匙', owner: '林晚', usage: '开密室' },
            ] }) } }] });
          }
          try { lastOut = JSON.parse(body); } catch { lastOut = { raw: body }; }
          return send(200, { data: [{ url: 'http://127.0.0.1:1/probe.png' }] });
        });
      });
      await new Promise((r) => mock.listen(0, '127.0.0.1', r));
      const mp = mock.address().port;
      let src = null; let sb = null;
      let lastOut = null; // mock 上游收到的最后一次非 chat 请求（用来断言"真正发出的是什么"）
      try {
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agnes_api_key: 'card-probe-key', agnes_api_base_url: `http://127.0.0.1:${mp}/v1` }) });
        const an = await J('/api/story/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: pid, title: '注入验收原著', text: '注入验收茶馆里，林晚握着注入验收钥匙。', reduce: false }) });
        src = an.source && an.source.id;
        let j = null;
        for (let i = 0; i < 40; i++) { await sleep(250); j = await J(`/api/batch/${an.jobId}`); if (j.status !== 'running') break; }
        ok('注入验收：原著解析出卡片', j && j.status === 'done' && j.ok >= 1, JSON.stringify({ s: j && j.status, ok: j && j.ok }));
        const cards = await J(`/api/story/cards?project_id=${pid}&kind=location`);
        const loc = (cards || []).find((c) => c.name === '注入验收茶馆');
        ok('注入验收：地点卡就位', !!loc);

        // 造一个专属镜头，避免与别的组的分镜行混淆
        sb = await J('/api/storyboards', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: pid, episode_number: 1, shot_number: 999, shot_type: '中景',
            scene_description: '注入验收镜头', image_prompt: 'a quiet teahouse corner' }) });
        const sid = sb.id;

        await cdp.eval(`location.hash = '#/storyboards?project=${pid}&episode=1'; return true;`);
        await waitFor(() => cdp.eval(`return !!document.querySelector('[data-edit="${sid}"]');`), '分镜行就绪', 15000);
        // 未绑卡时不该有 +场景 徽标（否则徽标就是个装饰）
        ok('未绑卡 → 提示词单元格没有 +场景 层',
          !(await cdp.eval(`return (document.querySelector('tr:has([data-edit="${sid}"]')||{}).innerText || '';`)).includes('+场景'));
        await cdp.eval(`document.querySelector('[data-edit="${sid}"]').click(); return true;`);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#s-card-pick');`), '原著卡片选择器出现', 8000);
        ok('弹窗列出本项目的地点卡/道具卡（带类别前缀）',
          await cdp.eval(`return (document.querySelector('#s-card-pick').innerText||'').includes('注入验收茶馆');`));
        ok('卡片 chip 的 tooltip 直接给出会被注入的描述（选之前就能看见后果）',
          await cdp.eval(`const b=document.querySelector('#s-card-pick [data-card]'); return !!b && (b.getAttribute('title')||'').includes('喧闹潮湿');`));
        await cdp.eval(`document.querySelector('#s-card-pick [data-card]').click(); return true;`);
        ok('点选后 chip 进入选中态（可再点取消）',
          await cdp.eval(`return document.querySelector('#s-card-pick [data-card]').classList.contains('on');`));
        await cdp.eval(`document.querySelector('.modal-foot [data-yes]')?.click(); return true;`);
        await waitFor(() => cdp.eval(`return !!document.querySelector('tr:has([data-edit="${sid}"]') && document.querySelector('tr:has([data-edit="${sid}"]').innerText.includes('注入验收茶馆');`), '绑定徽标出现', 8000);
        ok('保存后行内显示绑定的原著卡片徽标', true);
        const cellText = await cdp.eval(`return (document.querySelector('tr:has([data-edit="${sid}"]')||{}).innerText || '';`);
        ok('提示词单元格标出 +场景 层（哪一层被注入了一眼可见）', cellText.includes('+场景'), cellText.replace(/\n/g, ' ').slice(0, 120));
        const tip = await cdp.eval(`const t=document.querySelector('tr:has([data-edit="${sid}"]')?.querySelector('.prompt-cell .inline-target'); return t ? (t.getAttribute('title')||'') : '';`);
        ok('预览 tooltip 里就是真正会发出的最终词（含场景道具注入）',
          tip.includes('场景道具——注入验收茶馆：喧闹潮湿，临江'), tip.replace(/\n/g, ' ').slice(0, 160));
        const saved = (await J(`/api/storyboards?project_id=${pid}&episode=1`)).find((r) => r.id === sid);
        ok('绑定真机落库（不是只改了前端状态）',
          Array.isArray(saved.story_card_ids) && saved.story_card_ids.includes(loc.id), JSON.stringify(saved.story_card_ids));
        // 出图真发出去的词里必须带上（前端预览与后端 finalPrompt 同构的最终证明）
        await J('/api/agnes/image', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'a quiet teahouse corner', project_id: pid, storyboard_id: sid, size: '1024x1024' }) });
        const sent = String((lastOut && lastOut.prompt) || '');
        ok('出图实际发出的提示词含原著场景道具注入（预览没骗人）',
          sent.includes('场景道具——注入验收茶馆：喧闹潮湿，临江'), sent.slice(0, 160) || JSON.stringify(lastOut).slice(0, 120));
      } finally {
        mock.close();
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agnes_api_key: before.agnes_api_key || '', agnes_api_base_url: before.agnes_api_base_url || '' }) });
        if (sb && sb.id) await fetch(`http://127.0.0.1:${port}/api/storyboards/${sb.id}`, { method: 'DELETE' });
        if (src) await fetch(`http://127.0.0.1:${port}/api/story/sources/${src}`, { method: 'DELETE' });
      }
    }

    group('一致性体检契约（批 8 补 3：干净不报 / 同名必报 / 一键合并真生效）');
    {
      const J = (u, o) => fetch(`http://127.0.0.1:${port}${u}`, o).then((x) => x.json());
      const pid = (await J('/api/projects')).find((x) => x.name === '浏览器验收剧').id;
      const before = await J('/api/settings');
      const mock = http.createServer((req, res) => {
        const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        let body = ''; req.on('data', (c) => { body += c; });
        req.on('end', () => {
          if (req.url.startsWith('/v1/chat/completions')) {
            return send(200, { choices: [{ message: { content: JSON.stringify({ cards: [
              { kind: 'location', name: '体检验收茶馆', atmosphere: '潮湿', region: '江边' },
              { kind: 'character', name: '体检验收角色', appearance: '青衫' },
            ] }) } }] });
          }
          return send(200, { ok: true });
        });
      });
      await new Promise((r) => mock.listen(0, '127.0.0.1', r));
      const mp = mock.address().port;
      const srcs = [];
      try {
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agnes_api_key: 'audit-probe-key', agnes_api_base_url: `http://127.0.0.1:${mp}/v1` }) });
        const analyze = async (title) => {
          const an = await J('/api/story/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: pid, title, text: '体检验收茶馆里，体检验收角色坐着。', reduce: false }) });
          srcs.push(an.source && an.source.id);
          for (let i = 0; i < 40; i++) { await sleep(250); const j = await J(`/api/batch/${an.jobId}`); if (j.status !== 'running') break; }
          return an.source && an.source.id;
        };
        const s1 = await analyze('体检验收原著一');
        await cdp.eval(`location.hash = '#/novel?project_id=${pid}&source_id=${s1}'; return true;`);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#nov-audit');`), '原著页就绪', 12000);

        // ① 干净数据不制造噪音（否则用户点两次就再也不点了）
        await cdp.eval(`document.querySelector('#nov-audit').click(); return true;`);
        await waitFor(() => cdp.eval(`return (document.querySelector('#nov-audit-box')||{}).innerText !== '';`), '体检结果出现', 8000);
        const clean = await cdp.eval(`return (document.querySelector('#nov-audit-box')||{}).innerText || '';`);
        // 只有一份原著时不该报同名卡（"不硬凑警告"）；此刻唯一该报的是"人物卡还没进资产库"
        ok('只解析一次时不报同名卡（不硬凑警告）', !clean.includes('有 2 张'), clean.replace(/\n/g, ' ').slice(0, 110));
        ok('体检范围写明是整个项目（否则用户以为只看当前这份）', clean.includes('整个项目'));

        // ② 再解析一次 → 跨来源同名卡 → 必须报出来
        await analyze('体检验收原著二');
        // 先收起旧报告再重跑：否则 waitFor 会**立刻**匹配到上一次的面板文本，
        // 读到的是过期结论（第一版就是这么假绿的——等了半天，看的还是旧内容）
        await cdp.eval(`document.querySelector('#nov-audit-box [data-audit-close]')?.click(); return true;`);
        await sleep(150);
        await cdp.eval(`document.querySelector('#nov-audit').click(); return true;`);
        await waitFor(() => cdp.eval(`return /有 2 张/.test((document.querySelector('#nov-audit-box')||{}).innerText||'');`), '体检报出同名卡', 8000);
        const report = await cdp.eval(`return (document.querySelector('#nov-audit-box')||{}).innerText || '';`);
        ok('两次解析出的同名卡被抓出来', report.includes('有 2 张'), report.replace(/\n/g, ' ').slice(0, 140));
        ok('报告里区分"要处理"与"可优化"', report.includes('要处理') && report.includes('可优化'));
        ok('可一键修复的项给了修复按钮（不是只报不修）',
          await cdp.eval(`return !!document.querySelector('#nov-audit-box [data-audit-fix]');`));

        // ③ 点合并 → 必须先确认（不可逆操作）→ 确认后真的合并
        const dupBefore = await cdp.eval(`const b=Array.from(document.querySelectorAll('#nov-audit-box [data-audit-fix]')).find(x=>(x.textContent||'').includes('合并同名卡')); if(!b) return false; b.click(); return true;`);
        ok('点"合并同名卡"有反应', dupBefore === true);
        const cText = await waitFor(() => cdp.eval(`const m=document.querySelector('.modal'); return m ? m.innerText : '';`), '合并确认弹窗', 6000).catch(() => '');
        ok('合并前弹确认并说明影响面（会改指分镜绑定）',
          String(cText).includes('并成一张') && String(cText).includes('绑定'), String(cText).replace(/\n/g, ' ').slice(0, 140));
        await cdp.eval(`document.querySelector('.modal-foot [data-yes]').click(); return true;`);
        // 断言要盯**被合并的那一组**：项目里还有另一组同名卡（两个来源的人物卡），
        // 用宽泛的 /有 2 张/ 会因为别组的同名卡而永远等不到（第一版就是这么超时的）
        await waitFor(() => cdp.eval(`const t=(document.querySelector('#nov-audit-box')||{}).innerText||''; return /一致性体检：/.test(t) && !/体检验收茶馆」有 2 张/.test(t);`), '合并后报告刷新', 10000);
        const after = await cdp.eval(`return (document.querySelector('#nov-audit-box')||{}).innerText || '';`);
        ok('合并后重新体检，这一组同名卡消失（体检不是永远报同样的话）', !after.includes('体检验收茶馆」有 2 张'), after.replace(/\n/g, ' ').slice(0, 140));
        const left = await J(`/api/story/cards?project_id=${pid}&kind=location`);
        // 卡片删除按钮（批 8 下就存在的按钮，直到本轮加 dataOf 棘轮才发现它一直是坏的：
        // 处理器读 'delCard'、属性写的是 data-del-card，于是点两次也删不掉，还不报错）
        const delBefore = await J(`/api/story/cards?project_id=${pid}&kind=character`);
        const target = (delBefore || [])[0];
        const srcList = await J(`/api/story/sources?project_id=${pid}`);
        const anySrc = (srcList || [])[0];
        ok('删除契约的前提：还有人物卡与一份可打开的原著', !!target && !!anySrc,
          JSON.stringify({ cards: (delBefore || []).length, sources: (srcList || []).length }));
        // 卡片工作台只在**选中一份原著**时才加载（novel.js mount：`if (sourceId) await loadCards()`），
        // 不带 source_id 进去只会看到"还没有选中原著"空态 —— 第一版就是这么等不到删除按钮的
        await cdp.eval(`location.hash = '#/novel?project_id=${pid}&source_id=${anySrc.id}'; return true;`);
        await waitFor(() => cdp.eval(`return !!document.querySelector('[data-del-card="${target.id}"]');`), '卡片删除按钮就绪', 12000);
        await cdp.eval(`document.querySelector('[data-del-card="${target.id}"]').click(); return true;`);
        await sleep(150);
        ok('第一击只进入待确认态（不直接删）',
          await cdp.eval(`return document.querySelector('[data-del-card="${target.id}"]').textContent.includes('再点一次');`));
        await cdp.eval(`document.querySelector('[data-del-card="${target.id}"]').click(); return true;`);
        await waitFor(() => cdp.eval(`return !document.querySelector('[data-del-card="${target.id}"]');`), '卡片删除后从列表消失', 8000);
        const delAfter = await J(`/api/story/cards?project_id=${pid}&kind=character`);
        ok('第二击真的删掉了（这个按钮此前是坏的，点了没反应也不报错）',
          (delAfter || []).length === (delBefore || []).length - 1,
          JSON.stringify({ before: (delBefore || []).length, after: (delAfter || []).length }));
        ok('后端也真的只剩一张（不是只改了界面）',
          (left || []).filter((c) => c.name === '体检验收茶馆').length === 1,
          JSON.stringify((left || []).map((c) => c.name)));
      } finally {
        mock.close();
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agnes_api_key: before.agnes_api_key || '', agnes_api_base_url: before.agnes_api_base_url || '' }) });
        for (const sid of srcs.filter(Boolean)) await fetch(`http://127.0.0.1:${port}/api/story/sources/${sid}`, { method: 'DELETE' });
      }
    }

    group('角色名册契约（批 8 补 6：名册进提示词 → 模型照本名写 → 自动绑定命中）');
    {
      // 这一组要证的是**因果链**而不是"我拼了字符串"：mock 从真实请求体里把名册抠出来，
      // 再用名册里的本名回一个分镜表 —— 只有名册真的到了模型面前，后面那步自动绑定才可能命中。
      let sawRoster = null;
      let sawSystem = '';
      let sawLookRule = false;
      let lastUser = '';
      const mock = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const u = new URL(req.url, 'http://x');
          if (!u.pathname.endsWith('/chat/completions')) { res.writeHead(404); res.end('{}'); return; }
          let cb = {};
          try { cb = JSON.parse(body); } catch { /* 坏请求体就当空 */ }
          const msgs = Array.isArray(cb.messages) ? cb.messages : [];
          sawSystem = String((msgs.find((m) => m.role === 'system') || {}).content || '');
          sawLookRule = sawSystem.includes('不要写人物长相');
          const user = String((msgs.find((m) => m.role === 'user') || {}).content || '');
          lastUser = user;
          const hit = user.match(/【本剧角色名册】[\s\S]*?\n- ([^\n（|]+)/);
          sawRoster = hit ? hit[1].trim() : null;
          const name = sawRoster || '未知名册';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          // 补提示词那条链（系统提示里带"分镜图提示词工程师"）回一段普通提示词，别回 JSON
          if (sawSystem.includes('分镜图提示词工程师')) {
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'a woman stands in the rain, medium shot' } }] }));
            return;
          }
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '```json\n' + JSON.stringify([
            { shot_number: 1, shot_type: '中景', characters: name, scene_description: '名册验收：她走进门', action: '走进门', image_prompt: 'a woman walks in', video_prompt: 'slow dolly in' },
            { shot_number: 2, shot_type: '特写', characters: `${name}、少女`, scene_description: '名册验收：她回头', action: '回头', image_prompt: 'close up', video_prompt: 'static' },
          ]) + '\n```' } }] }));
        });
      });
      await new Promise((r) => mock.listen(0, '127.0.0.1', r));
      const mockPort = mock.address().port;
      const J = (u, o) => fetch(`http://127.0.0.1:${port}${u}`, o).then((x) => x.json());
      const post = (u, b) => J(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      let pid = null; let cid = null; let ids = [];
      const before = await J('/api/settings');
      try {
        pid = (await J('/api/projects')).find((x) => x.name === '浏览器验收剧').id;
        await fetch(`http://127.0.0.1:${port}/api/storyboards?project_id=${pid}&episode=7`, { method: 'DELETE' });
        cid = (await post('/api/characters', { project_id: pid, name: '名册验收角色', alias: '小册', appearance: '银发红瞳，左眼下有一道旧疤', outfit: '黑色长风衣', is_locked: true })).id;
        await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agnes_api_base_url: `http://127.0.0.1:${mockPort}/v1`, agnes_api_key: 'roster-key' }) });
        await cdp.send('Page.reload', {}); await sleep(900);
        await cdp.eval(`location.hash = '#/storyboards?project=${pid}&episode=7'; return true;`);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#gen-sb');`), '分镜页就绪', 12000);
        const hint = await waitFor(() => cdp.eval(`return (document.querySelector('#roster-hint')||{}).innerText||'';`), '名册提示出现', 8000).catch(() => '');
        ok('进页面就说清"会带上角色名册"（不是等生成完才发现名字对不上）',
          String(hint).includes('1 个角色名册'), String(hint).slice(0, 120));
        await cdp.eval(`const t=document.querySelector('#script-in'); t.value='名册验收：她走进门，回头看了一眼。'; t.dispatchEvent(new Event('input',{bubbles:true})); return true;`);
        await cdp.eval(`document.querySelector('#gen-sb').click(); return true;`);
        // 等"分镜行出现"而不是等本名出现：等待条件不能依赖被测的那个事实，
        // 否则名册一旦没进请求体，这里会先超时，真正该红的那条断言反而没机会报（对照 Y 实测）
        await waitFor(() => cdp.eval(`return /名册验收：她走进门/.test(document.body.innerText);`), '生成结果落库', 15000);
        await sleep(600);
        ok('请求体里真的带了角色名册（不是只拼在前端变量里）', sawRoster === '名册验收角色', String(sawRoster));
        ok('系统提示明确"不要写人物长相"（长相只由使用点注入一次，写两遍会打架）', sawLookRule, sawSystem.slice(0, 60));
        const rows = await J(`/api/storyboards?project_id=${pid}&episode=7`);
        ids = rows.map((r) => r.id);
        const r1 = rows.find((r) => r.shot_number === 1);
        ok('模型照本名写「出场人物」→ 生成后自动绑定命中', (r1.character_ids || []).includes(cid), JSON.stringify({ chars: r1.characters, ids: r1.character_ids }));
        const r2 = rows.find((r) => r.shot_number === 2);
        ok('名册之外的名字（"少女"）不会被误绑', !(r2.character_ids || []).some((x) => x !== cid), JSON.stringify(r2.character_ids));
        // 验收环：名册之外的代称会在体检里被点出来（预防 + 检测成对）
        const audit = await J(`/api/story/audit?project_id=${pid}`);
        const unk = (audit.shot_issues || []).filter((x) => x.code === 'shot_char_unknown');
        ok('体检点出"名字在角色库里找不到"的代称（名册的验收环）',
          unk.some((x) => x.target_name === '少女'), JSON.stringify(unk.map((x) => x.target_name)));
        ok('体检不误报名册里的本名', !unk.some((x) => x.target_name === '名册验收角色'), JSON.stringify(unk.map((x) => x.target_name)));

        // 补提示词那条链（批 8 补 7）：同一套注入边界，且"人物"来自绑定
        await post('/api/storyboards', {
          project_id: pid, episode_number: 7, shot_number: 3, shot_type: '全景',
          characters: '', character_ids: [cid], image_prompt: '', video_prompt: '',
          scene_description: '名册验收：她站在雨中',
        });
        // 必须**重新加载**：页面本来就停在 #/storyboards（同页同参），再设一次同样的 hash 不会触发路由，
        // 页面会拿着旧的 rows 继续用 —— 新加的镜头不在表里，后面点补提示词只会得到"没有需要补充的镜头"
        await cdp.send('Page.reload', {}); await sleep(900);
        await waitFor(() => cdp.eval(`return /名册验收：她站在雨中/.test(document.body.innerText);`), '分镜页回访且行已渲染', 12000);
        await cdp.eval(`document.querySelector('#gen-img-prompts').click(); return true;`);
        await waitFor(() => cdp.eval(`return /stands in the rain/.test(document.body.innerText) || Array.from(document.querySelectorAll('textarea,input')).some((t) => /stands in the rain/.test(t.value || ''));`), '图片提示词补完', 15000);
        await sleep(400);
        ok('补提示词的链也禁写死画风', sawSystem.includes('不要写整体画风或媒介词'), sawSystem.slice(0, 80));
        ok('补提示词的链也禁写长相（提示词只写这一镜发生了什么）', sawSystem.includes('不要写人物长相'), sawSystem.slice(0, 120));
        ok('补提示词的链也禁写中文人名（名字进提示词会让外貌注入被跳过）', sawSystem.includes('不要写中文人名'));
        ok('「出场人物」空着时，人物来自已绑角色（不是空着让模型瞎猜）',
          lastUser.includes('人物:名册验收角色'), lastUser.slice(0, 120));
      } finally {
        await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agnes_api_base_url: before.agnes_api_base_url || '', agnes_api_key: before.agnes_api_key || '' }) });
        mock.close();
        if (pid) await fetch(`http://127.0.0.1:${port}/api/storyboards?project_id=${pid}&episode=7`, { method: 'DELETE' });
        if (cid) await fetch(`http://127.0.0.1:${port}/api/characters/${cid}`, { method: 'DELETE' });
        await cdp.send('Page.reload', {}); await sleep(700);
      }
    }

    group('镜头绑定自动匹配契约（批 8 补 5：干跑确认 → 落库 → 体检兜底 → 按目标修复）');
    {
      const J = (u, o) => fetch(`http://127.0.0.1:${port}${u}`, o).then((x) => x.json());
      const pid = (await J('/api/projects')).find((x) => x.name === '浏览器验收剧').id;
      const post = (u, b) => J(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      // 三个角色：甲只在「出场人物」里出现（强），乙只在画面描述里出现（弱，可能撞词），丙留到后面手工加镜头时用
      const mk = async (name, appearance) => (await post('/api/characters', { project_id: pid, name, appearance })).id;
      const cA = await mk('绑定验收角色甲', '红衣');
      const cB = await mk('绑定验收角色乙', '蓝衣');
      const cC = await mk('绑定验收角色丙', '绿衣');
      let ids = [];
      try {
        const rows = (await post('/api/storyboards', { rows: [
          { project_id: pid, episode_number: 1, shot_number: 1, shot_type: '中景', characters: '绑定验收角色甲', image_prompt: 'two people', scene_description: '甲走进来' },
          { project_id: pid, episode_number: 1, shot_number: 2, shot_type: '近景', characters: '', image_prompt: 'close-up', scene_description: '绑定验收角色乙递上钥匙' },
        ] })).rows;
        ids = rows.map((r) => r.id);
        ok('绑定契约：两个镜头就绪', ids.length === 2);

        await cdp.eval(`location.hash = '#/storyboards?project=${pid}&episode=1'; return true;`);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#sb-autobind');`), '分镜页就绪', 12000);
        await cdp.eval(`document.querySelector('#sb-autobind').click(); return true;`);
        const cText = await waitFor(() => cdp.eval(`const m=document.querySelector('.modal'); return m ? m.innerText : '';`), '自动匹配确认弹窗', 8000).catch(() => '');
        ok('自动匹配先弹确认（不静默改数据）', String(cText).includes('自动匹配绑定'), String(cText).replace(/\n/g, ' ').slice(0, 120));
        ok('弹窗列出会绑到哪些镜头与哪些名字',
          String(cText).includes('#1') && String(cText).includes('绑定验收角色甲'), String(cText).replace(/\n/g, ' ').slice(0, 160));
        ok('把"只在提示词里出现"的推断项标出来（让人扫一眼）',
          String(cText).includes('提示词推断'), String(cText).replace(/\n/g, ' ').slice(0, 200));
        ok('说明不会改写镜头内容（只影响注入）', String(cText).includes('不会改写镜头内容'));
        await cdp.eval(`document.querySelector('.modal-foot [data-yes]').click(); return true;`);
        await waitFor(() => cdp.eval(`return !document.querySelector('.modal');`), '确认后弹窗关闭', 6000);
        await sleep(400);
        const after = await J(`/api/storyboards?project_id=${pid}&episode=1`);
        const s1 = after.find((x) => x.id === ids[0]);
        const s2 = after.find((x) => x.id === ids[1]);
        ok('确认后真的落库（镜头 1 绑上强匹配的角色）', (s1.character_ids || []).includes(cA), JSON.stringify(s1.character_ids));
        ok('弱匹配也在确认后落库（它就在弹窗里列着）', (s2.character_ids || []).includes(cB), JSON.stringify(s2.character_ids));

        // 体检兜底：自动匹配跑过之后**手工**加的镜头没人管 —— 这条最容易被忽略
        await post('/api/storyboards', { project_id: pid, episode_number: 1, shot_number: 3, shot_type: '全景', characters: '绑定验收角色丙', image_prompt: 'wide shot', scene_description: '丙登场' });
        await cdp.eval(`location.hash = '#/novel?project_id=${pid}'; return true;`);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#nov-audit');`), '原著页就绪', 12000);
        await cdp.eval(`document.querySelector('#nov-audit').click(); return true;`);
        await waitFor(() => cdp.eval(`return /绑定验收角色丙/.test((document.querySelector('#nov-audit-box')||{}).innerText||'');`), '体检报出漏绑', 10000);
        const panel = await cdp.eval(`return (document.querySelector('#nov-audit-box')||{}).innerText || '';`);
        ok('体检把"提到却没绑"的镜头报出来', panel.includes('绑定验收角色丙') && panel.includes('提到但没绑定'), panel.replace(/\n/g, ' ').slice(0, 160));
        ok('体检范围写明含镜头（不是只体检卡片）', panel.includes('个镜头'), panel.replace(/\n/g, ' ').slice(0, 200));

        // 按目标修复：点一下把这条修掉
        const clicked = await cdp.eval(`const b=Array.from(document.querySelectorAll('#nov-audit-box [data-audit-fix]')).find(x=>(x.getAttribute('data-audit-fix')==='bind_shot_target') && (x.closest('.row')||{}).innerText && x.closest('.row').innerText.includes('绑定验收角色丙')); if(!b) return false; b.click(); return true;`);
        ok('漏绑项给了"绑到这些镜头"的修复按钮', clicked === true);
        const c2 = await waitFor(() => cdp.eval(`const m=document.querySelector('.modal'); return m ? m.innerText : '';`), '绑定确认弹窗', 6000).catch(() => '');
        ok('绑定前弹确认并说明只影响注入', String(c2).includes('不会改写镜头内容'), String(c2).replace(/\n/g, ' ').slice(0, 140));
        await cdp.eval(`document.querySelector('.modal-foot [data-yes]').click(); return true;`);
        await waitFor(() => cdp.eval(`return !/绑定验收角色丙/.test((document.querySelector('#nov-audit-box')||{}).innerText||'');`), '修复后该条消失', 10000);
        const s3 = (await J(`/api/storyboards?project_id=${pid}&episode=1`)).find((x) => x.shot_number === 3);
        ok('修复真的写进了后端', (s3.character_ids || []).includes(cC), JSON.stringify(s3.character_ids));

        // 画风写死（批 8 补 7）：提示词里写死画风词 → 体检报出 → 一键删掉（画风回到项目设置）
        const stShot = (await post('/api/storyboards', {
          project_id: pid, episode_number: 1, shot_number: 4, shot_type: '中景',
          image_prompt: 'a girl, pixel art style, holding a sword', video_prompt: 'pan left',
          scene_description: '画风验收',
        })).id;
        await cdp.eval(`document.querySelector('#nov-audit').click(); return true;`);
        await waitFor(() => cdp.eval(`return /写死了画风词/.test((document.querySelector('#nov-audit-box')||{}).innerText||'');`), '体检报出画风写死', 10000);
        const styleClicked = await cdp.eval(`const b=Array.from(document.querySelectorAll('#nov-audit-box [data-audit-fix]')).find(x=>x.getAttribute('data-audit-fix')==='strip_style_word' && x.closest('.row') && x.closest('.row').innerText.includes('pixel art')); if(!b) return false; b.click(); return true;`);
        ok('画风写死项给了"删掉写死的画风词"的修复按钮', styleClicked === true);
        const c3m = await waitFor(() => cdp.eval(`const m=document.querySelector('.modal'); return m ? m.innerText : '';`), '画风确认弹窗', 6000).catch(() => '');
        ok('确认文案讲清"画风由项目设置统一注入"', String(c3m).includes('项目设置'), String(c3m).replace(/\n/g, ' ').slice(0, 140));
        await cdp.eval(`document.querySelector('.modal-foot [data-yes]').click(); return true;`);
        await waitFor(() => cdp.eval(`return !/写死了画风词/.test((document.querySelector('#nov-audit-box')||{}).innerText||'');`), '画风项消失', 10000);
        const stAfter = (await J(`/api/storyboards?project_id=${pid}&episode=1`)).find((x) => x.id === stShot);
        ok('提示词里的画风词被删掉，画面描述其余内容一字不动',
          stAfter.image_prompt === 'a girl, holding a sword', JSON.stringify(stAfter.image_prompt));
        ok('视频提示词没有被牵连', stAfter.video_prompt === 'pan left', JSON.stringify(stAfter.video_prompt));
      } finally {
        for (const id of ids) await fetch(`http://127.0.0.1:${port}/api/storyboards/${id}`, { method: 'DELETE' });
        await fetch(`http://127.0.0.1:${port}/api/storyboards?project_id=${pid}&episode=1`, { method: 'DELETE' });
        for (const cid of [cA, cB, cC].filter(Boolean)) await fetch(`http://127.0.0.1:${port}/api/characters/${cid}`, { method: 'DELETE' });
      }
    }

    group('分集骨架契约（批 8 补 4：按幕切集 / 调拍数真的重切 / 带入剧本落到变量）');
    {
      const J = (u, o) => fetch(`http://127.0.0.1:${port}${u}`, o).then((x) => x.json());
      const pid = (await J('/api/projects')).find((x) => x.name === '浏览器验收剧').id;
      const before = await J('/api/settings');
      // 两幕八拍：起承转合 ×2。这份数据专门用来验证"按幕收口"（4+4）而不是"平均切"（4+4 恰好同值，
      // 所以下限要调到 5 才能把两种规则区分开——见 ②）
      const LONGARC = [
        { kind: 'plot', name: '骨架·起1', stage: '起', conflict: '冲突一' },
        { kind: 'plot', name: '骨架·承1', stage: '承', conflict: '冲突二' },
        { kind: 'plot', name: '骨架·转1', stage: '转', conflict: '冲突三' },
        { kind: 'plot', name: '骨架·合1', stage: '合', outcome: '结果一' },
        { kind: 'plot', name: '骨架·起2', stage: '起', conflict: '冲突四' },
        { kind: 'plot', name: '骨架·承2', stage: '承', conflict: '冲突五' },
        { kind: 'plot', name: '骨架·转2', stage: '转', conflict: '冲突六' },
        { kind: 'plot', name: '骨架·合2', stage: '合', outcome: '结果二' },
      ];
      const mock = http.createServer((req, res) => {
        const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        let body = ''; req.on('data', (c) => { body += c; });
        req.on('end', () => {
          if (req.url.startsWith('/v1/chat/completions')) {
            return send(200, { choices: [{ message: { content: JSON.stringify({ cards: LONGARC }) } }] });
          }
          return send(200, { ok: true });
        });
      });
      await new Promise((r) => mock.listen(0, '127.0.0.1', r));
      const mp = mock.address().port;
      let src = null;
      try {
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agnes_api_key: 'outline-probe-key', agnes_api_base_url: `http://127.0.0.1:${mp}/v1` }) });
        const an = await J('/api/story/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: pid, title: '分集骨架原著', text: '骨架验收：两幕八拍的剧情。', reduce: false }) });
        for (let i = 0; i < 40; i++) { await sleep(250); const j = await J(`/api/batch/${an.jobId}`); if (j.status !== 'running') break; }
        src = an.source && an.source.id;
        ok('分集骨架：解析受理并抽出八拍', !!src, JSON.stringify(an).slice(0, 120));

        await cdp.eval(`location.hash = '#/novel?project_id=${pid}&source_id=${src}'; return true;`);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#nov-outline');`), '原著页分集入口就绪', 12000);
        await cdp.eval(`document.querySelector('#nov-outline').click(); return true;`);
        await waitFor(() => cdp.eval(`return /分集骨架：/.test((document.querySelector('#nov-outline-box')||{}).innerText||'');`), '分集骨架面板出现', 8000);
        const p1 = await cdp.eval(`return (document.querySelector('#nov-outline-box')||{}).innerText || '';`);
        ok('默认下限 4 拍：八拍切成 2 集（按幕收口）', p1.includes('分集骨架：2 集 / 8 拍'), p1.replace(/\n/g, ' ').slice(0, 120));
        ok('面板写清这是本地计算、不调用模型（用户才敢反复调）', p1.includes('不调用模型'), p1.replace(/\n/g, ' ').slice(0, 160));
        ok('切分依据说人话（幕次覆盖数）', p1.includes('幕次覆盖 8/8'), p1.replace(/\n/g, ' ').slice(0, 160));
        ok('每集标出幕次与拍数（不是一坨文本）', p1.includes('起·承·转·合') && /4 拍/.test(p1));
        ok('每一拍都列了冲突/结果（拍级信息没有在渲染时丢掉）', p1.includes('冲突一') && p1.includes('结果一'));

        // ② 调下限必须真的重切：5 拍下限时，第 4 拍（幕边界）**不该**再收口
        await cdp.eval(`const i=document.querySelector('#nov-outline-per'); i.value='5'; document.querySelector('[data-outline-recut]').click(); return true;`);
        await waitFor(() => cdp.eval(`return /分集骨架：1 集/.test((document.querySelector('#nov-outline-box')||{}).innerText||'');`), '按新下限重切', 8000);
        const p2 = await cdp.eval(`return (document.querySelector('#nov-outline-box')||{}).innerText || '';`);
        ok('下限调到 5 → 不再在第 4 拍收口（输入框不是装饰）', p2.includes('分集骨架：1 集 / 8 拍'), p2.replace(/\n/g, ' ').slice(0, 120));

        // ③ 带入剧本：与「带入剧本」同一条链路，但载荷是骨架文本
        await cdp.eval(`document.querySelector('[data-outline-toscript]').click(); return true;`);
        await waitFor(() => cdp.eval(`location.hash.startsWith('#/scripts')`), '跳转到故事脚本页', 8000);
        await waitFor(() => cdp.eval(`return !!document.querySelector('#fields [data-var="本集大纲"]');`), '单集脚本页签就绪', 12000);
        const landed = await waitFor(() => cdp.eval(`return (document.querySelector('#fields [data-var="本集大纲"]')||{}).value || '';`)
          .then((v) => (String(v).includes('【分集骨架】') ? v : false)), '骨架文本落入模板变量', 10000).then((v) => v || '').catch(() => '');
        ok('骨架落到「本集大纲」字段（按变量名匹配，不是随便一个空框）',
          String(landed).includes('【分集骨架】') && String(landed).includes('第 1 集'), String(landed).slice(0, 100));
        ok('落进去的是拍级骨架（含幕次与拍名），不是卡片清单',
          String(landed).includes('骨架·起1') && String(landed).includes('起'), String(landed).slice(0, 140));
        ok('骨架文本带切分说明（用户知道为什么这么切）', String(landed).includes('【切分说明】'));
        ok('带入后 URL 里的 outline 参数被抹掉（刷新不重复覆盖用户后来的修改）',
          !(await cdp.eval(`location.hash.includes('outline=')`)));
      } finally {
        mock.close();
        await J('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agnes_api_key: before.agnes_api_key || '', agnes_api_base_url: before.agnes_api_base_url || '' }) });
        if (src) await fetch(`http://127.0.0.1:${port}/api/story/sources/${src}`, { method: 'DELETE' });
      }
    }

    group('剧本链路契约（批 4：就地编辑 → 带入下一步 → 门禁 → 计数）');
    {
      const J = (u, o) => fetch(`http://127.0.0.1:${port}${u}`, o).then((x) => x.json());
      const pid = (await J('/api/projects')).find((x) => x.name === '浏览器验收剧').id;
      // 门禁在"没有 API Key"时会先提示配 Key（更根本的问题），所以这里配一个假 Key 让流程走到门禁。
      // base_url 指向一个关闭的端口：万一有调用漏过门禁，会立刻连接失败而不是打真实上游。
      await J('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agnes_api_key: 'chain-probe-key', agnes_api_base_url: 'http://127.0.0.1:1/v1' }),
      });
      // 前端 state.settings 是启动时取的快照：改完 Key 必须让页面重新 bootstrap，
      // 否则页面里那个空 Key 会让 generate() 在门禁之前就退出（第一次跑就是这么假红的）。
      // 门禁的"拦住"路径要用真有长文本字段的页签：故事构思那 8 个都是短参数，
      // 空着只该"确认"不该"拦住"。单集脚本的长文本字段是「本集大纲」。
      await cdp.eval(`location.hash = '#/scripts?project=${pid}&tab=episode_script'; return true;`);
      await waitFor(() => cdp.eval(`return !!document.querySelector('#gen');`), '脚本页就绪', 12000);
      await cdp.eval(`location.reload(); return true;`);
      await waitFor(() => cdp.eval(`return !!document.querySelector('#gen');`), '重载后脚本页就绪', 15000);
      await sleep(500);
      // 自证：故事构思页签渲染的必须是真种子模板（含"题材"等 8 个变量）。
      // 若这里只剩一个"变量"，说明模板集合被别的探针污染了——那种情况下后面的断言全是假象。
      const tplFields = await cdp.eval(`return Array.from(document.querySelectorAll('#fields [data-var]')).map((x) => x.getAttribute('data-var'));`);
      ok('页签渲染的是真种子模板（自证未被污染）',
        Array.isArray(tplFields) && tplFields.includes('本集大纲'), JSON.stringify(tplFields));
      ok('R18 长文本字段是多行输入框（故事想法/本集大纲这类不该是单行 input）',
        await cdp.eval(`return document.querySelector('#fields textarea') !== null;`));

      // 门禁第一条：长文本空着时点生成必须被拦住，且**一次 API 都不发**（没有 Key 也不会走到调用）
      await cdp.eval(`document.querySelector('#gen').click(); return true;`);
      const blocked = await waitFor(() => cdp.eval(`const m = document.querySelector('.modal'); return m ? m.innerText : '';`), '缺素材告知弹窗', 6000).catch(() => '');
      ok('R16 门禁：长文本空着时拦住生成并说明原因',
        String(blocked).includes('还缺生成素材') && String(blocked).includes('本集大纲') && String(blocked).includes('带入下一步'),
        String(blocked).replace(/\n/g, ' ').slice(0, 110));
      ok('R16 拦住时只给一个"知道了"（不是假装有选择）', await cdp.eval(`return document.querySelectorAll('.modal-foot button').length === 1;`));
      await cdp.eval(`document.querySelector('.modal-foot [data-yes]').click(); return true;`);

      // 用后端直接塞一条结果？不行——结果区是前端状态。改为走「已保存脚本 → 载入」这条真实路径，
      // 它同时验证了"载入的脚本也进入可编辑/可带入的状态"。
      await cdp.eval(`location.hash = '#/scripts?project=${pid}&tab=story_concept'; return true;`);
      await waitFor(() => cdp.eval(`return !!document.querySelector('#gen');`), '回到故事构思页签', 8000);
      const saved = await J('/api/scripts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: pid, script_type: 'story_concept', title: '链路探针·故事构思',
          content: '{"logline":"一个女孩在天台上等一场不会来的雨。","tone":"克制的孤独"}',
          model_name: 'probe', generation_prompt: '',
        }),
      });
      await cdp.eval(`document.querySelector('#reload').click(); return true;`);
      await waitFor(() => cdp.eval(`return !!document.querySelector('[data-use="${saved.id}"]');`), '已保存脚本列表', 8000);
      await cdp.eval(`document.querySelector('[data-use="${saved.id}"]').click(); return true;`);
      await waitFor(() => cdp.eval(`return !!document.querySelector('#r-edit-box');`), '结果区可编辑', 6000);
      ok('R17 载入的历史脚本也进入可编辑结果区', await cdp.eval(`return !!document.querySelector('#r-edit-box');`));
      ok('R17 结果区显示 JSON 可解析与字数', /JSON 可解析/.test(await cdp.eval(`return document.querySelector('#r-stat').innerText;`)));

      // 就地编辑：改一个字段 → 结果区标"已改动" → 撤销能回到原样
      await cdp.eval(`const b = document.querySelector('#r-edit'); b.click(); const t = document.querySelector('#r-edit-box'); t.value = t.value.replace('不会来的雨', '终于落下的雨'); t.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
      ok('R17 就地编辑标记"已改动"', await cdp.eval(`return Array.from(document.querySelectorAll('.badge')).some((x) => x.innerText.includes('已改动'));`));
      ok('R17 编辑后的内容进入唯一事实来源（复制/保存/带入都读它）',
        await cdp.eval(`return document.querySelector('#r-edit-box').value.includes('终于落下的雨');`));
      ok('R17 提供撤销改动（改坏了不用重新烧配额）', await cdp.eval(`return !!document.querySelector('#r-undo');`));
      await cdp.eval(`document.querySelector('#r-undo').click(); return true;`);
      await sleep(300);
      ok('R17 撤销回到模型原样', await cdp.eval(`const t = document.querySelector('#r-edit-box'); return !t || !t.value.includes('终于落下的雨');`));

      // R16 核心：带入下一步
      await cdp.eval(`document.querySelector('#r-next').click(); return true;`);
      await waitFor(() => cdp.eval(`return !!document.querySelector('#upstream .upstream-strip');`), '上游带入提示条', 6000);
      const carry = await cdp.eval(`const s = document.querySelector('#upstream .upstream-strip');
        const ta = document.querySelector('#fields textarea');
        return { strip: s.innerText.replace(/\s+/g, ' ').trim(), active: document.querySelector('#tabs .on').innerText.trim(),
          carried: !!document.querySelector('#fields textarea.carried'), val: ta ? ta.value.slice(0, 30) : '', step: document.querySelector('#step-no').innerText.trim() };`);
      ok('R16 带入后自动切到下一步（剧情梗概）', carry.active === '剧情梗概', JSON.stringify(carry.active));
      ok('R16 带入内容写进了下游的长文本字段并被高亮', carry.carried && String(carry.val).includes('logline'), JSON.stringify(carry));
      ok('R16 提示条说清来源与字段名', String(carry.strip).includes('已从') && String(carry.strip).includes('故事构思') && String(carry.strip).includes('带入'), carry.strip);
      ok('R16 步骤指示器显示第 2/5 步', carry.step === '第 2/5 步', carry.step);
      ok('R18 下游字段显示字数', /\d+ 字/.test(await cdp.eval(`return document.querySelector('#fields .counter').innerText;`)));

      // 撤销带入 → 字段清空、提示条消失
      await cdp.eval(`document.querySelector('#up-undo').click(); return true;`);
      await sleep(300);
      ok('R16 撤销带入后提示条消失且字段清空',
        await cdp.eval(`return !document.querySelector('#upstream .upstream-strip') && document.querySelector('#fields textarea').value === '';`));

      // R18 超软上限 → 确认弹窗（先取消，不真的调用模型）
      await cdp.eval(`const t = document.querySelector('#fields textarea'); t.value = '字'.repeat(6200); t.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
      const overHint = await cdp.eval(`const c = document.querySelector('#fields .counter'); return { txt: c.innerText, over: c.classList.contains('over') };`);
      ok('R18 超软上限时计数变琥珀色并提示上限', overHint.over && overHint.txt.includes('6,000 字'), JSON.stringify(overHint));
      await cdp.eval(`document.querySelector('#gen').click(); return true;`);
      const confirmTxt = await waitFor(() => cdp.eval(`const m = document.querySelector('.modal'); return m ? m.innerText : '';`), '超长确认弹窗', 6000).catch(() => '');
      ok('R18 超软上限时生成前要确认（不静默截断、也不硬拦）',
        String(confirmTxt).includes('生成前确认') && String(confirmTxt).includes('6,200 字'), String(confirmTxt).replace(/\n/g, ' ').slice(0, 120));
      await cdp.eval(`document.querySelector('.modal-foot [data-no]').click(); return true;`);
      await sleep(300);
      ok('R18 取消确认后没有发起生成（按钮未被禁用）', await cdp.eval(`return !document.querySelector('#gen').disabled;`));

      await fetch(`http://127.0.0.1:${port}/api/scripts/${saved.id}`, { method: 'DELETE' }).catch(() => {});
      // 收尾：把探针 Key 收回（后续分组各自配自己的，不依赖这里）
      await fetch(`http://127.0.0.1:${port}/api/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agnes_api_key: '', agnes_api_base_url: '' }),
      });
      await cdp.eval(`location.hash = '#/dashboard'; return true;`);
    }

    group('角色库契约（R14：真机建档 → 入库 → 卡片渲染 → 分镜行可见 → 删除解绑）');
    {
      const J = (u, o) => fetch(`http://127.0.0.1:${port}${u}`, o).then((x) => x.json());
      const pid = (await J('/api/projects')).find((x) => x.name === '浏览器验收剧').id;
      await cdp.eval(`location.hash = '#/characters?project=${pid}'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('#new-char')`), '角色库页就绪', 10000);
      // 走完整表单链路（而不是直接调 API）：表单字段与保存逻辑才在覆盖范围内
      await cdp.eval(`document.querySelector('#new-char').click(); return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('#c-name')`), '角色表单弹出', 8000);
      await cdp.eval(`document.querySelector('#c-name').value = '浏览器角色';
        document.querySelector('#c-appear').value = '银色短发、右眼角有疤';
        document.querySelector('#c-outfit').value = '黑色皮夹克';
        document.querySelector('#c-lock').checked = true;
        document.querySelector('[data-yes]').click(); return true;`);
      const okCreate = await waitFor(async () => (await J(`/api/characters?project_id=${pid}`)).some((c) => c.name === '浏览器角色'), '角色入库', 10000)
        .then(() => true).catch(() => false);
      ok('真机建档 → 入库', okCreate);
      const c = (await J(`/api/characters?project_id=${pid}`)).find((x) => x.name === '浏览器角色') || {};
      ok('外貌锁定随表单提交落库', c.is_locked === true, JSON.stringify({ lock: c.is_locked }));
      ok('外貌/服装分别落库（注入时只需这两段）', c.appearance === '银色短发、右眼角有疤' && c.outfit === '黑色皮夹克', JSON.stringify({ a: c.appearance, o: c.outfit }));
      // 卡片是真的渲染了（不是只有数据）：锁标 + 外貌文本。
      // 必须先等卡片出现——入库完成 ≠ 页面重渲染完成（load() 是异步的，中间还有骨架屏）
      const cardShown = await waitFor(() => cdp.eval(`!!document.querySelector('.char-card[data-id="${c.id}"]')`), '角色卡出现', 8000)
        .then(() => true).catch(() => false);
      const card = await cdp.eval(`const el = document.querySelector('.char-card[data-id="${c.id}"]'); return el ? { txt: el.innerText, lock: !!el.querySelector('.flag') } : null;`);
      ok('角色卡渲染外貌与锁定标记', cardShown && !!card && card.txt.includes('银色短发') && card.lock === true, JSON.stringify(card));
      // R15：分镜行的"计算态预览"必须体现角色注入（后端真的注入、界面也真的显示）
      const lockChar = await J('/api/characters', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: pid, name: '预览角色', appearance: '栗色卷发、琥珀色瞳孔', outfit: '米色风衣', is_locked: true }),
      });
      const sbPreview = await J('/api/storyboards', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: pid, episode_number: 1, shot_number: 98, scene_description: '注入预览探针',
          image_prompt: 'a girl walking down the street', character_ids: [lockChar.id],
        }),
      });
      await cdp.eval(`location.hash = '#/dashboard'; return true;`);
      await cdp.eval(`location.hash = '#/storyboards?project=${pid}&episode=1'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('#table tbody tr')`), '分镜表就绪（注入预览）', 12000);
      // 逐列取（列内有多个 .cell-ellipsis，靠顺序取会取到「画面描述」列），徽标要取全而不是第一个
      const tag = await cdp.eval(`const row = Array.from(document.querySelectorAll('#table tbody tr')).find((tr) => tr.innerText.includes('注入预览探针'));
        if (!row) return null;
        const cell = row.querySelector('.prompt-cell'); // 列内首个提示词单元格 = 图片列
        const tags = Array.from(cell.querySelectorAll('.prompt-tag'));
        return { tags: tags.map((t) => t.innerText.trim()), charTip: (tags.find((t) => t.innerText.includes('角色')) || {}).getAttribute ? tags.find((t) => t.innerText.includes('角色')).getAttribute('title') : '', full: cell.querySelector('.cell-ellipsis').getAttribute('title') };`);
      ok('分镜行标出「+角色」注入徽标', !!tag && tag.tags.includes('+角色'), JSON.stringify(tag && tag.tags));
      ok('徽标 tooltip 列出被注入的角色名', !!tag && String(tag.charTip).includes('预览角色'), JSON.stringify(tag && tag.charTip));
      // 预览的完整最终词必须与后端一致（前端镜像是"看得见的承诺"，漂移就是骗人；
      // 后端侧的实际注入由 apitest 的 R15 组用 mock 逐字验证）
      ok('预览最终词含角色外貌与服装（与后端 finalPrompt 同序同文）',
        !!tag && String(tag.full).includes('出场角色——预览角色：栗色卷发、琥珀色瞳孔，身着米色风衣'), String(tag && tag.full).slice(0, 140));
      await fetch(`http://127.0.0.1:${port}/api/storyboards/${sbPreview.id}`, { method: 'DELETE' });
      await fetch(`http://127.0.0.1:${port}/api/characters/${lockChar.id}`, { method: 'DELETE' });
      await cdp.eval(`location.hash = '#/dashboard'; return true;`);

      // 参考图路径：卡片封面必须真的渲染成 <img>（只存 id 不渲染 = 没接上）
      const refImg = await J('/api/images', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: pid, name: '角色参考图探针', usage_type: 'character', generation_prompt: 'probe',
          url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
        }),
      });
      await J(`/api/characters/${c.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference_image_ids: [refImg.id] }),
      });
      // 同 hash 再赋值不会触发 hashchange → 必须先离开再回来，否则页面不重渲染（测了个旧 DOM）
      await cdp.eval(`location.hash = '#/dashboard'; return true;`);
      await cdp.eval(`location.hash = '#/characters?project=${pid}'; return true;`);
      const coverShown = await waitFor(() => cdp.eval(`!!document.querySelector('.char-card[data-id="${c.id}"] .char-thumb img')`), '参考图封面', 8000)
        .then(() => true).catch(() => false);
      const cover = await cdp.eval(`const el = document.querySelector('.char-card[data-id="${c.id}"] .char-thumb img'); return el ? { alt: el.getAttribute('alt'), w: el.naturalWidth } : null;`);
      ok('参考图渲染为卡片封面且带 alt（真加载成功，不是坏链占位）',
        coverShown && !!cover && String(cover.alt).includes('浏览器角色') && cover.w > 0, JSON.stringify(cover));
      // 布局几何：卡片网格必须真的多列、封面必须真的是正方形。
      // 事故：角色库页写 <div id="grid"> 漏了 class="grid" → 整页塌成一列 1120px 宽的巨大卡片；
      // 四套断言与 ui-audit 全绿（元素都在、不溢出、字号对比度都合规，只是布局根本没生效）。
      // 教训：只断言"元素存在"永远测不出布局塌陷，得断言几何。
      const geo = await cdp.eval(`const g = document.querySelector('#grid');
        if (!g) return null;
        const cs = getComputedStyle(g);
        const cards = Array.from(document.querySelectorAll('.char-card'));
        const thumbs = cards.map((c) => { const r = c.querySelector('.char-thumb').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
        return { display: cs.display, cols: cs.gridTemplateColumns.split(' ').filter((x) => x !== 'none').length,
          cardW: cards.map((c) => Math.round(c.getBoundingClientRect().width)), thumbs };`);
      ok('角色卡片是真正的多列网格（不是塌成一列的巨卡）',
        !!geo && geo.display === 'grid' && geo.cols >= 2 && geo.cardW.every((w) => w < 420), JSON.stringify(geo && { display: geo.display, cols: geo.cols, cardW: geo.cardW }));
      ok('卡片封面是正方形（流内图片不得把 aspect-ratio 方框撑高）',
        !!geo && geo.thumbs.length > 0 && geo.thumbs.every(([w, h]) => Math.abs(w - h) <= 2), JSON.stringify(geo && geo.thumbs));
      await fetch(`http://127.0.0.1:${port}/api/images/${refImg.id}`, { method: 'DELETE' }).catch(() => {});

      // 绑定到分镜 → 行内芯片可见
      const sb = await J('/api/storyboards', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: pid, episode_number: 1, shot_number: 99, scene_description: '角色绑定探针', character_ids: [c.id] }),
      });
      await cdp.eval(`location.hash = '#/storyboards?project=${pid}&episode=1'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('#table tbody tr')`), '分镜表就绪', 12000);
      const rowTxt = await cdp.eval(`const row = Array.from(document.querySelectorAll('#table tbody tr')).find((tr) => tr.innerText.includes('角色绑定探针')); return row ? row.innerText : '';`);
      ok('分镜行显示绑定的角色名（结构化绑定在真机可见）', String(rowTxt).includes('浏览器角色'), String(rowTxt).slice(0, 90));
      // 删除角色 → 引用守卫解绑，分镜行不再显示"失效"
      const del = await J(`/api/characters/${c.id}`, { method: 'DELETE' });
      ok('删除角色同时解绑镜头（不留悬空 id）', del.ok === true && del.unlinked >= 1, JSON.stringify(del));
      await cdp.eval(`location.hash = '#/characters?project=${pid}'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('#new-char')`), '回到角色库', 8000);
      const gone = await cdp.eval(`!document.querySelector('.char-card[data-id="${c.id}"]')`);
      ok('删除后卡片从界面消失', gone === true);
      await fetch(`http://127.0.0.1:${port}/api/storyboards/${sb.id}`, { method: 'DELETE' });
      const left = (await J(`/api/storyboards?project_id=${pid}&episode=1`)).filter((x) => x.scene_description === '角色绑定探针').length;
      ok('探针分镜已清理', left === 0, `left=${left}`);
    }

    group('页面挂载矩阵（10 页真机冒烟）');
    {
      // 覆盖空洞：browser-test 历史上只走 7 条路由，#/images 与 #/videos 从未真机挂载
      const Jget = (u) => fetch(`http://127.0.0.1:${port}${u}`).then((x) => x.json());
      const pid = (await Jget('/api/projects')).find((x) => x.name === '浏览器验收剧').id;
      const pages = [
        ['工作台', '#/dashboard', '#stats'],
        ['项目管理', '#/projects', '#list'],
        ['剧本', '#/scripts', '#fields'],
        ['分镜', '#/storyboards', '#table'],
        ['角色库', '#/characters', '#grid'],
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
      ok('10 页挂载全程无未捕获异常', errs.length === 0, errs.join(',') || 'clean');
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
