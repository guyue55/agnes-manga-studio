/**
 * ui-audit.mjs — 真机布局/可访问性度量审计（Chrome CDP，与 browser-test 互补）
 * browser-test 测"行为对不对"，本工具测"量不量得过"：
 *   ① 横向溢出（4 档视口 × 全页面，定位元凶选择器）
 *   ② WCAG 对比度（前景/背景实际合成色，正文 <4.5、大字 <3 记不合格）
 *   ③ 微字号（<10px 的可读文本）与 ④ 过小可点目标（<24px，参考项）
 * 用法：node tools/ui-audit.mjs   （按需跑，不进 run-all——它是度量报表不是断言门）
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
const portBusy = (p) => new Promise((res) => {
  const s = net.connect(p, '127.0.0.1');
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('error', () => res(false));
  s.setTimeout(400, () => { s.destroy(); res(true); });
});
async function pickPortPair(base, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const p = base + ((process.pid + i * 991) % 9000);
    if (!(await portBusy(p)) && !(await portBusy(p + 1))) return [p, p + 1];
  }
  throw new Error('找不到连续两个空闲端口');
}
const [port, cdpPort] = await pickPortPair(32000);
const stamp = `${process.pid}-${Date.now().toString(36)}`;
const home = path.join(ROOT, 'build', `audit-home-${stamp}`);
const profile = path.join(ROOT, 'build', `audit-profile-${stamp}`);

function findBrowser() {
  const cands = [
    process.env.NM_BROWSER,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
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
        let msg; try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id); this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || 'CDP error')); else p.resolve(msg.result);
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
    const expression = `(async function(){${body.includes(';') ? body : `return (${body})`}})()`;
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面脚本异常');
    return r.result?.value;
  }
  async viewport(w, h) {
    await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  }
  close() { try { this.ws?.close(); } catch { /* ignore */ } }
}

async function waitFor(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch { /* 未就绪 */ }
    await sleep(150);
  }
  throw new Error(`等待超时：${label}（最后值 ${JSON.stringify(last)}）`);
}
async function getTarget() {
  const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  const list = await r.json();
  return list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl) || null;
}

// ── 页面内探针：一次 eval 全量返回本视口该页的度量 ──────────────────────
const PROBE = `
function rgbOf(c){ const m=String(c).match(/\\\\d+(\\\\.\\\\d+)?/g); return m?m.slice(0,3).map(Number):null; }
function lum(r,g,b){ const f=(v)=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);}; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); }
function blend(fg,bg){ const a=fg.length>3?Math.max(0,Math.min(1,fg[3])):1; return [0,1,2].map((i)=>a*fg[i]+(1-a)*bg[i]); }
function effBg(el){ let n=el; while(n && n.nodeType===1){ const c=rgbOf(getComputedStyle(n).backgroundColor); if(c && (String(getComputedStyle(n).backgroundColor).includes('rgba')?(c[3]>0.02):true)) return c.slice(0,3); n=n.parentElement; } return rgbOf(getComputedStyle(document.body).backgroundColor)||[20,22,28].slice(0,3); }
function sel(el){ let s=el.tagName.toLowerCase(); if(el.id) return '#'+el.id; if(el.className && typeof el.className==='string'){ const c=el.className.trim().split(/\\\\s+/).filter(x=>!x.startsWith('data-'))[0]; if(c) s+='.'+c; } return s; }
function vis(el){ const r=el.getBoundingClientRect(); const st=getComputedStyle(el); return r.width>0&&r.height>0&&st.visibility!=='hidden'&&st.display!=='none'&&parseFloat(st.opacity)>0.05; }
function hasOwnText(el){ for(const n of el.childNodes) if(n.nodeType===3&&n.textContent.trim()) return true; return false; }
const VW=innerWidth; const res={overflow:{de:document.documentElement.scrollWidth>VW+2,culprits:[]},contrast:[],micro:[],tinyTap:0,noName:0,noHint:[],scanned:0,samples:0,chips:0};
for(const el of document.querySelectorAll('body *')){ if(!vis(el)) continue; res.scanned++; if(el.className&&String(el.className).includes('chip'))res.chips++;
  const r=el.getBoundingClientRect();
  if(r.right>VW+2 && r.width>8){ if(res.overflow.culprits.length<4) res.overflow.culprits.push(sel(el)+' w='+Math.round(r.width)); }
  const fs0=parseFloat(getComputedStyle(el).fontSize);
  if(fs0<10 && hasOwnText(el) && el.textContent.trim().length>1){ if(res.micro.length<4) res.micro.push(sel(el)+' '+fs0+'px'); }
  if(el.matches('button,a,.chip,.icon-btn')){ if(r.height<23&&r.width<23) res.tinyTap++;
    const hasName = el.textContent.trim() || el.getAttribute('aria-label') || el.getAttribute('title') || (el.getAttribute('data-copy-prompt')?'x':'') || el.closest('[title]');
    if(el.matches('button,a') && !el.textContent.trim() && !el.getAttribute('aria-label') && !hasName) res.noName++; }
}
res.truncN=0;
for(const el of document.querySelectorAll('.cell-ellipsis,[class*=truncate],[style*=text-overflow]')){
  res.truncN++;
  if(el.scrollWidth>el.clientWidth+2 && !el.getAttribute('title') && !el.closest('[title]') && el.innerText.trim()){
    const sig=el.className+'::'+el.innerText.trim().slice(0,14);
    if(!res.noHint.includes(sig)) res.noHint.push(sig);
  }
}
// 采样清单里的每个选择器都必须在源码里真实存在，否则那条采样是"死采样"：
// 元素数 0、报表全绿，看着像量过，实际什么都没量（本轮发现 .note.muted/.muted/.seg-btn/.prompt-cell
// 四个都是死的）。uitest 有对应硬检查，防止再写进不存在的选择器。
for(const q of ['body','.page-title','.page-desc','h3','.nav-item','.btn','.btn-sm','.note','.note.gold','.note.red','.cell-ellipsis','.chip','.badge','.hint-sm','.hint-xs','.segmented > button','label','th','.prompt-cell']){
  const els=[...document.querySelectorAll(q)].filter(vis).slice(0,3); res.samples+=els.length;
  for(const el of els){ if(!hasOwnText(el)&&q!=='body') continue;
    const cs=getComputedStyle(el); const fg=rgbOf(cs.color); if(!fg) continue;
    const bg=effBg(el); const rgb=blend(fg,bg);
    const l1=lum(rgb[0],rgb[1],rgb[2]); const lb=lum(bg[0],bg[1],bg[2]);
    const ratio=(Math.max(l1,lb)+0.05)/(Math.min(l1,lb)+0.05);
    const big=parseFloat(cs.fontSize)>=24||(parseFloat(cs.fontSize)>=18.66&&parseFloat(cs.fontWeight)>=700);
    const min=big?3:4.5;
    if(ratio<min && !res.contrast.some(x=>x.q===q)) res.contrast.push({q,ratio:Math.round(ratio*10)/10,min,color:cs.color});
  }
}
return JSON.stringify(res);`;

const server = spawn(NODE, [path.join(ROOT, 'server.js')], {
  env: { ...process.env, PORT: String(port), NO_OPEN: '1', AGNES_STUDIO_HOME: home },
  stdio: 'ignore',
});
let browser = null; let cdp = null;
const lines = [];
try {
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { return false; } }, '本地服务');
  const bin = findBrowser();
  if (!bin) { console.log('未找到 Chrome/Edge，跳过审计。'); process.exit(0); }
  browser = spawn(bin, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu', '--mute-audio',
    '--window-size=1440,900', `http://127.0.0.1:${port}/#/dashboard`], { stdio: 'ignore' });
  const target = await waitFor(getTarget, '浏览器页面', 30000);
  cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();

  // 种子内容：让度量落在真实密度上（长提示词、长描述、多行）
  const projReq = await (await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '审计项目·超长名称占位', art_style: '日漫厚涂', aspect_ratio: '9:16 竖屏' }),
  })).json();
  for (let i = 1; i <= 4; i++) {
    await fetch(`http://127.0.0.1:${port}/api/storyboards`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: projReq.id, episode_number: 1, shot_number: i, shot_type: '特写',
        scene_description: '这是一场在暴雨夜的天台上发生的告别戏，女主角撑着透明伞，男主转身离开，霓虹在积水中碎成满地的彩色光斑，镜头从伞面缓缓下移到两人之间被雨水打湿的地面上。',
        image_prompt: 'cinematic close-up of a girl holding a transparent umbrella on a rain-soaked rooftop at night, neon reflections shimmering across puddles, melancholic atmosphere, ultra detailed foreground bokeh background, dramatic rim lighting, professional composition, moody color grading',
        video_prompt: 'camera slowly dollies in from wide shot to the girl face, rain streaks falling, subtle hair movement in wind, neon flicker reflections',
        duration_seconds: 5,
      }),
    });
  }
  // 角色卡必须"有内容"才被量到：空态下卡片样式（截断/对比度/可点目标）根本没被渲染出来
  for (const [nm, app, outfit, lock] of [
    ['审计角色·超长外貌占位', '黑色长直发垂至腰间，丹凤眼，左眉尾有一颗小痣，皮肤偏冷白，唇色偏深，颈侧有一道细长的旧疤，惯常微微侧头看人', '白色衬衫外搭深蓝西装外套，袖口卷起两折，腰间系一条细银链', true],
    ['审计角色乙', '银灰色寸头，右眼下方有一道横向伤疤', '黑色高领毛衣', false],
  ]) {
    await fetch(`http://127.0.0.1:${port}/api/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projReq.id, name: nm, role: '主角', appearance: app, outfit, is_locked: lock }),
    });
  }
  // 素材/任务页此前是**空态**在受检——空态没有卡片，卡片的截断/对比度/可点目标全都没被量到
  // （与"角色卡必须有内容"同一个坑）。用 /api/import 塞一条图片与一条已完成视频，
  // 让这两页也落在真实密度上；顺带让弹窗钩子有东西可点。
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  await fetch(`http://127.0.0.1:${port}/api/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'merge',
      data: { collections: {
        image_assets: [{
          id: 'audit_img_1', project_id: projReq.id, name: '审计素材·超长名称占位用于测量截断行为', url: tinyPng,
          usage_type: 'storyboard', generation_prompt: 'cinematic close-up of a girl holding a transparent umbrella on a rain-soaked rooftop at night, neon reflections shimmering across puddles, melancholic atmosphere',
          model_name: 'audit-model', created_at: new Date().toISOString(),
        }],
        video_assets: [{
          id: 'audit_vid_1', project_id: projReq.id, storyboard_id: null, status: 'completed',
          video_prompt: 'camera slowly dollies in from wide shot to the girl face, rain streaks falling, subtle hair movement in wind, neon flicker reflections',
          model_name: 'audit-video-model', generation_mode: 'text_to_video',
          num_frames: 120, frame_rate: 24, progress: 100, remote_url: 'https://example.invalid/x.mp4',
          created_at: new Date().toISOString(),
        }],
      } },
    }),
  });
  const pid = projReq.id;
  /**
   * 页面清单。第三项是**弹窗动作钩子**（可选）——页面渲染后执行一段脚本把弹窗打开，再度量。
   *
   * 为什么需要它：审计此前只量"页面本身"，而弹窗是全站最密的交互面（15 字段的分镜弹窗、
   * 模板编辑器、素材大图…），它的溢出/微字号/对比度/小目标至今是**盲区**。
   * 钩子里的选择器缺失不会静默跳过——下面的自检会把"声明了动作但没打开弹窗"报成一条发现，
   * 否则钩子会随着界面改名慢慢烂掉，而报表依然"零发现"。
   */
  const pages = [
    ['dashboard', '#/dashboard'],
    ['projects', '#/projects', `document.querySelector('#new-project')?.click();`],
    ['storyboards', `#/storyboards?project=${pid}`, `document.querySelector('[data-edit]')?.click();`],
    ['assets', '#/assets', `(document.querySelector('[data-zoom]')||document.querySelector('.asset-card')||{}).click?.();`],
    ['images', `#/images?project=${pid}`, `document.querySelector('[data-zoom]')?.click();`],
    ['videos', `#/videos?project=${pid}`],
    ['tasks', '#/tasks', `(document.querySelector('[data-detail]')||document.querySelector('[data-detailt]')||{}).click?.();`],
    ['scripts', `#/scripts?project=${pid}`],
    // 批 8：原著解析页（卡片工作台是新的栅格 + 长文本输入，最需要在 4 个视口下量一遍溢出）
    ['novel', `#/novel?project_id=${pid}`],
    ['characters', `#/characters?project=${pid}`, `document.querySelector('#new-char')?.click();`],
    ['settings', '#/settings?sec=templates', `document.querySelector('#t-new')?.click();`],
  ];
  const viewports = [[1440, 900], [1280, 800], [1024, 768], [900, 700]];
  let modalRuns = 0;
  for (const [w, h] of viewports) {
    await cdp.viewport(w, h);
    for (const [name, hash, action] of pages) {
      await cdp.eval(`location.hash = '${hash}'; return true;`);
      await waitFor(() => cdp.eval(`!!document.querySelector('.page') && !document.querySelector('.spinner')`), `${name}@${w}`);
      await sleep(120);
      let modalOn = false;
      if (action) {
        // 弹窗钩子：先开弹窗，再连同弹窗一起度量（PROBE 扫的是整篇文档，弹窗内容自然在内）
        await cdp.eval(`${action} return true;`);
        modalOn = await waitFor(() => cdp.eval(`return !!document.querySelector('.modal');`), `${name} 弹窗@${w}`, 4000).then(() => true).catch(() => false);
        if (!modalOn) lines.push(`弹窗未打开 ${w}px ${name}: 动作钩子声明了弹窗但没出现（选择器可能已改名）`);
        await sleep(180); // 入场动画
      }
      const res = JSON.parse(await cdp.eval(PROBE));
      if (name === 'storyboards' && w === 1440) console.log(`  [自证] scanned=${res.scanned} contrastSamples=${res.samples} chips=${res.chips} trunc=${res.truncN} noHint=${res.noHint.length} hash=${await cdp.eval('location.hash')}`);
      if (modalOn) modalRuns++;
      if (res.overflow.de) lines.push(`溢出   ${w}px ${name}: 页面横向滚动 [${res.overflow.culprits.join(' | ')}]`);
      if (modalOn) {
        const mOver = await cdp.eval(`
          const m = document.querySelector('.modal');
          if (!m) return null;
          const bad = [];
          for (const el of m.querySelectorAll('*')) {
            const r = el.getBoundingClientRect();
            if (r.width === 0) continue;
            if (r.right > innerWidth + 2 || r.left < -2) bad.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''));
            if (bad.length > 4) break;
          }
          return { scroll: m.scrollWidth > m.clientWidth + 2, bad };`);
        if (mOver && mOver.scroll) lines.push(`弹窗溢出 ${w}px ${name}: 弹窗内容横向滚动 [${mOver.bad.join(' | ')}]`);
        if (mOver && mOver.bad.length) lines.push(`弹窗越界 ${w}px ${name}: [${mOver.bad.join(' | ')}]`);
      }
      for (const c of res.contrast) lines.push(`对比度 ${w}px ${name}: ${c.q} = ${c.ratio}:1（需≥${c.min}，${c.color}）`);
      if (res.micro.length) lines.push(`微字号 ${w}px ${name}: [${res.micro.join(' | ')}]`);
      if (res.tinyTap > 2) lines.push(`小目标 ${w}px ${name}: ${res.tinyTap} 个 <23px 可点元素`);
      if (res.noName > 0) lines.push(`无障碍 ${w}px ${name}: ${res.noName} 个无文本无标签的图标钮`);
      for (const h of res.noHint) lines.push(`截断无提示 ${w}px ${name}: ${h}`);
      if (modalOn) { await cdp.eval(`document.querySelector('.modal [data-no]')?.click(); document.querySelector('.modal [data-close]')?.click(); document.querySelector('.modal-backdrop')?.click(); return true;`); await sleep(150); }
    }
  }
  console.log(`── UI 度量审计（${viewports.length} 视口 × ${pages.length} 页；其中 ${modalRuns} 次带弹窗度量）──`);
  if (!lines.length) console.log('  无任何发现：不溢出、无微字号、对比度全过 WCAG AA。');
  const seen = new Map();
  for (const l of lines) { const key = l.replace(/^\S+ +\S+ +/, '').replace(/^[\w.]+(?=:)/, ''); seen.set(key, (seen.get(key) || 0) + 1); }
  for (const l of lines) console.log('  · ' + l);
  console.log(`\n共 ${lines.length} 条度量发现（同项跨视口重复已原样保留，前缀含视口与页名）。`);
} catch (e) {
  console.error(`审计异常：${e.stack || e.message}`);
  process.exitCode = 1;
} finally {
  if (cdp) cdp.close();
  if (browser?.pid) browser.kill('SIGTERM');
  if (server?.pid) server.kill('SIGTERM');
  await sleep(300);
  for (const d of [home, profile]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 已清 */ } }
}
