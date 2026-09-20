/**
 * uitest.mjs — 前端静态一致性检查
 * ------------------------------------------------------------------
 * 没有 jsdom 也能抓到前端最常见的几类「静默失败」：
 *   · import 了一个不存在的符号 → 运行时 undefined，页面直接白
 *   · icon('x') 名字写错 → 静默退化成 info 图标，看不出来
 *   · api.xxx() 方法拼错 → 一点按钮就报 is not a function
 *   · index.html 引用了不存在的文件 → 404
 *
 * 用法：node tools/uitest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; return true; }
  fail++; failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
  return false;
}
// 期望值比对：失败时把"期望/实际"打出来。纯函数断言靠它才有可读的失败信息
// （只看 "false" 无法判断是差一格还是完全错了）。
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  return ok(name, a === e, `期望 ${e}，实际 ${a}`);
}
function group(t) { console.log(`\n── ${t} ──`); }

const read = (p) => fs.readFileSync(p, 'utf8');
const listJs = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f));

// ── 1. 入口与资源 ────────────────────────────────────────────
group('入口文件');
{
  const html = read(path.join(PUB, 'index.html'));
  ok('index.html 存在', html.length > 0);
  ok('引了 app.js', html.includes('./js/app.js'));
  ok('引了 app.css', html.includes('./css/app.css'));
  ok('有 view 挂载点', html.includes('id="view"'));
  ok('有 toast 容器', html.includes('id="toasts"'));
  ok('有 modal 容器', html.includes('id="modal-root"'));
  ok('声明 UTF-8', html.includes('charset="UTF-8"'));
  ok('没有登录/注册残留', !/login|register|登录|注册/i.test(html));

  // CSS 里引用的所有文件
  ok('css 文件存在', fs.existsSync(path.join(PUB, 'css', 'app.css')));
}

// ── 2. 模块文件齐全 ──────────────────────────────────────────
group('模块完整性');
{
  const pages = ['dashboard', 'projects', 'scripts', 'novel', 'storyboards', 'characters', 'images', 'videos', 'tasks', 'assets', 'settings'];
  for (const p of pages) {
    ok(`页面模块 ${p}.js 存在`, fs.existsSync(path.join(PUB, 'js', 'pages', `${p}.js`)));
  }
  for (const m of ['app.js', 'api.js', 'ui.js', 'consts.js']) {
    ok(`核心模块 ${m} 存在`, fs.existsSync(path.join(PUB, 'js', m)));
  }
  // app.js 里注册的路由必须都有对应文件
  const app = read(path.join(PUB, 'js', 'app.js'));
  for (const p of pages) {
    ok(`app.js 注册了 ${p}`, app.includes(`./pages/${p}.js`));
  }
}

// ── 3. import 符号一致性 ─────────────────────────────────────
group('import 符号');
{
  const files = [...listJs(path.join(PUB, 'js')), ...listJs(path.join(PUB, 'js', 'pages'))];

  /** 收集一个模块的具名导出 */
  function exportsOf(file) {
    const src = read(file);
    const names = new Set();
    // export const X / export function X / export class X / export { a, b }
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
      m[1].split(',').forEach((s) => {
        const n = s.trim().split(/\s+as\s+/).pop().trim();
        if (n) names.add(n);
      });
    }
    if (/export\s+default/.test(src)) names.add('default');
    return names;
  }

  for (const file of files) {
    const src = read(file);
    for (const m of src.matchAll(/import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g)) {
      const named = m[2];
      const spec = m[3];
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target)) {
        ok(`${path.basename(file)} 的 import 目标存在`, false, spec);
        continue;
      }
      const avail = exportsOf(target);
      if (named) {
        for (const raw of named.split(',')) {
          const n = raw.trim().split(/\s+as\s+/)[0].trim();
          if (!n) continue;
          ok(`${path.basename(file)} → ${spec} 导出了 ${n}`, avail.has(n), `可用：${[...avail].join(', ')}`);
        }
      }
      // 默认导入
      if (m[1] && !named) ok(`${path.basename(file)} → ${spec} 有默认导出`, avail.has('default'));
    }
  }

  // 页面模块必须默认导出一个函数（helpers.js 是纯工具模块，没有默认导出）
  for (const file of listJs(path.join(PUB, 'js', 'pages'))) {
    if (path.basename(file) === 'helpers.js') continue;
    const src = read(file);
    ok(`${path.basename(file)} 默认导出函数`, /export\s+default\s+(?:async\s+)?function/.test(src));
    // 首参必须是 router 传进来的容器（app.js 调 nav.page(page, params)）。
    // 变更须知：页面若自己 createElement 一个容器再往里写，DOM 不会进文档，
    // 表现为"切过去白屏、且**没有任何报错**"（批 8 的 novel.js 就这么白过一次）。
    // 所以这里钉死签名形状：第一个参数名必须是 container，且不能再自建 .page 容器。
    ok(`${path.basename(file)} 首参是 router 注入的容器（container）`,
      /export\s+default\s+async\s+function\s+\w+\s*\(\s*container\b/.test(src));
    ok(`${path.basename(file)} 不自建页面容器（写了也不在文档里）`,
      !/createElement\('div'\)[\s\S]{0,40}className\s*=\s*'page'/.test(src));
  }
}

// ── 4. 图标名 ────────────────────────────────────────────────
group('图标名');
{
  const consts = read(path.join(PUB, 'js', 'consts.js'));
  const block = consts.match(/const ICONS = \{([\s\S]*?)\n\};/);
  ok('解析到 ICONS 表', !!block);
  const names = new Set();
  if (block) for (const m of block[1].matchAll(/^\s{2}([A-Za-z][\w]*):/gm)) names.add(m[1]);
  ok('图标数量合理', names.size > 20, `${names.size} 个`);

  const files = [...listJs(path.join(PUB, 'js')), ...listJs(path.join(PUB, 'js', 'pages'))];
  const used = new Set();
  for (const file of files) {
    const src = read(file);
    for (const m of src.matchAll(/icon\(\s*'([A-Za-z][\w]*)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/icon\(\s*([A-Za-z][\w]*)\s*\)/g)) used.add(m[1]);
  }
  ok('页面确实用了图标', used.size > 10, `${used.size} 个`);
  for (const n of used) {
    ok(`图标 ${n} 已定义`, names.has(n));
  }
}

// ── 5. API 方法 ──────────────────────────────────────────────
group('API 方法');
{
  const apiSrc = read(path.join(PUB, 'js', 'api.js'));
  const defined = new Set();
  for (const m of apiSrc.matchAll(/^\s{2}([a-zA-Z][\w]*):/gm)) defined.add(m[1]);
  ok('api 定义了方法', defined.size > 15, `${defined.size} 个`);

  const files = [...listJs(path.join(PUB, 'js', 'pages')), path.join(PUB, 'js', 'app.js')];
  const used = new Set();
  for (const file of files) {
    const src = read(file);
    for (const m of src.matchAll(/\bapi\.([a-zA-Z][\w]*)\s*\(/g)) used.add(m[1]);
  }
  for (const n of used) {
    ok(`api.${n} 已定义`, defined.has(n));
  }
}

// ── 6. 后端接口覆盖 ──────────────────────────────────────────
group('前端调用的后端路由');
{
  const routesSrc = fs.readFileSync(path.join(ROOT, 'lib', 'routes.js'), 'utf8');
  const apiSrc = read(path.join(PUB, 'js', 'api.js'));
  // 前端写的 URL 可能是模板串（`/api/videos/${id}/refresh`），
  // 只取到第一个非字母数字占位符之前的路径前缀来比对后端注册的模式
  const urls = new Set();
  for (const m of apiSrc.matchAll(/['"`](\/api\/[A-Za-z0-9_\-/${}.[\]]*)/g)) {
    let u = m[1];
    u = u.split('?')[0].split('${')[0].replace(/\/$/, '');
    if (u.startsWith('/api/')) urls.add(u);
  }
  ok('解析到前端调用的接口', urls.size > 10, `${urls.size} 个`);
  for (const u of urls) {
    const exists = routesSrc.includes(`'${u}'`) || routesSrc.includes(`'${u}/:id'`);
    ok(`路由 ${u} 已在后端注册`, exists, u);
  }
}

// ── 7. 设计系统落地 ──────────────────────────────────────────
group('设计规范');
{
  const css = read(path.join(PUB, 'css', 'app.css'));
  // PRD 4.2 色板
  ok('主背景 #08090D', css.includes('#08090D'));
  ok('主金色 #D6B56D', css.includes('#D6B56D'));
  ok('亮金色 #F5D58A', css.includes('#F5D58A'));
  ok('成功色柔化 #4FBE8B（B1.4）', css.includes('#4FBE8B'));
  ok('失败色柔化 #F0616B（B1.4）', css.includes('#F0616B'));
  // PRD 4.4 布局
  ok('侧边栏 260px', css.includes('--sidebar-w: 260px'));
  ok('卡片圆角 24px（B1.6）', css.includes('--radius-card: 24px'));
  ok('按钮圆角 16px（B1.6）', css.includes('--radius-btn: 16px'));
  ok('按钮高度 42px', /\.btn\s*\{[^}]*height:\s*42px/.test(css));
  ok('输入框高度 42px', /\.input,\s*\.textarea,\s*\.select\s*\{[^}]*height:\s*42px/.test(css));
  ok('玻璃拟态 backdrop-filter', css.includes('backdrop-filter: blur(20px)'));
  ok('B1 金色交互 token 组', ['--gold-border-hover','--gold-glow','--focus-ring'].every((k) => css.includes(k)));
  ok('B1 入场级联与减动效兜底', css.includes('@keyframes revealIn') && css.includes('.grid > *:nth-child(-n+8)'));
  ok('侧边栏模糊 24px', css.includes('backdrop-filter: blur(24px)'));
  ok('弹窗模糊 28px', css.includes('backdrop-filter: blur(28px)'));
  ok('滚动条 hover 变金', css.includes('scrollbar-thumb:hover'));
  // PRD 4.9 禁止项
  ok('无大面积紫色主题', !/#8B5CF6|purple/.test(css));
  // 响应式
  ok('有窄屏适配', css.includes('@media (max-width: 900px)'));

// ── B2 体验缺陷批的落地钉（防回归删除）─────────────────────
group('B2 体验批钉');
{
  const ui = read(path.join(PUB, 'js', 'ui.js'));
  const app = read(path.join(PUB, 'js', 'app.js'));
  const consts = read(path.join(PUB, 'js', 'consts.js'));
  const rd = (f) => read(path.join(PUB, 'js', 'pages', f));
  const sb = rd('storyboards.js'); const tk = rd('tasks.js'); const as = rd('assets.js');
  const vd = rd('videos.js'); const st = rd('settings.js'); const db = rd('dashboard.js');
  ok('errBox 存在且四页接线', ui.includes('export function errBox') && [as, tk, st, db].every((x) => x.includes('errBox')));
  ok('空态动作出口（empty action 插槽：go 链接 / act 按钮两种形态）',
    ui.includes('action && action.label') && ui.includes('action.go') && ui.includes('data-act=')
    && sb.includes("label: '去故事脚本页'") && db.includes("label: '去新建项目'"));
  ok('T-1 画幅映射 sizeForAspect 全链路', consts.includes('export function sizeForAspect')
    && [sb, vd, rd('images.js')].every((x) => x.includes('sizeForAspect'))
    && !sb.includes("'1024x1024'") && !vd.includes('width: 1152'));
  ok('2.6 全选半选态', sb.includes('sa.indeterminate') && sb.includes('function syncSelAll'));
  ok('2.9 视图状态进 hash（syncViewParams）', app.includes('export function syncViewParams')
    && [tk, as, st, sb, rd('scripts.js')].every((x) => x.includes('syncViewParams')));
  ok('2.10 任务状态候选随 tab', tk.includes('function fillStatus') && tk.includes("tab === 'image' || tab === 'text'"));
  ok('2.12 素材筛选持久化', as.includes("localStorage.getItem('agnes.assets") && as.includes("localStorage.setItem('agnes.assets"));
  ok('2.8 视频页最近任务订阅 SSE', vd.includes("onEvent('video'") && vd.includes('loadRecent(), 700'));
  ok('2.5 弹窗脏守卫 + ⌘↵ 提交', ui.includes('有未保存的修改') && ui.includes('requestClose') && ui.includes('e.metaKey || e.ctrlKey'));
  ok('SE-1 replace 导入二段确认', st.includes('确认替换导入') && st.includes('清空并导入'));
  ok('2.14 后台页签节流+回前台放流', app.includes('hiddenLive') && app.includes("'visibilitychange'"));
}

// ── B4 结构批钉：画风分层注入 ───────────────────────────────
group('B4 画风分层');
{
  const routesSrc = read(path.join(ROOT, 'lib', 'routes.js'));
  const constsSrc = read(path.join(PUB, 'js', 'consts.js'));
  const sbSrc = read(path.join(PUB, 'js', 'pages', 'storyboards.js'));
  const scSrc = read(path.join(PUB, 'js', 'pages', 'scripts.js'));
  // 括号配平取函数体：切片长度猜不准，多切一行就可能把别的函数的注入算进来（假绿/假红都可能）
  const bodyOf = (src, sig) => {
    const i = src.indexOf(sig);
    if (i < 0) return '';
    let d = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') d++;
      else if (src[j] === '}') { d--; if (!d) return src.slice(i, j + 1); }
    }
    return '';
  };
  // R15 后统一走 finalPrompt（内容 → 角色 → 画风）：使用点恰好 6 个
  // = 图片 1 + 文生视频 1 + CSV（图/视频各 1）+ MD（图/视频各 1）
  ok('4.1 后端使用点注入：图片 + 文生视频 + CSV/MD 各两列（恰好 6 个使用点）',
    routesSrc.includes('function artStylePhrase')
    && (routesSrc.match(/finalPrompt\(body\.prompt|finalPrompt\(r\.(?:image|video)_prompt/g) || []).length === 6);
  ok('4.1 入库只存镜头内容（写入点绝不注入）',
    !/artStylePhrase|characterPhrase|finalPrompt|storyCardPhrase/.test(bodyOf(routesSrc, 'function storyboardRow')));
  // R15：角色注入的前后端镜像必须逐字同构（逻辑一漂移，界面预览就开始骗人）
  const phraseBody = (src) => {
    const i = src.indexOf('function characterPhrase(prompt, chars) {');
    return i < 0 ? '' : bodyOf(src, 'function characterPhrase(prompt, chars) {').replace(/\s+/g, '');
  };
  ok('4.1 角色注入前后端同构（逐字比对，去空白）',
    phraseBody(routesSrc).length > 300 && phraseBody(routesSrc) === phraseBody(constsSrc));
  ok('4.1 角色注入含锁定语义与去重（自证非空跑）',
    /is_locked/.test(phraseBody(routesSrc)) && /出场角色——/.test(phraseBody(routesSrc)));
  // 批 8 补 2：原著卡片注入的前后端镜像同样必须逐字同构（分镜页预览靠它算"真正发出的是什么"）
  const cardBody = (src) => {
    const i = src.indexOf('function storyCardPhrase(prompt, cards) {');
    return i < 0 ? '' : bodyOf(src, 'function storyCardPhrase(prompt, cards) {').replace(/\s+/g, '');
  };
  const lookBody = (src) => {
    const i = src.indexOf('function storyCardLook(card) {');
    return i < 0 ? '' : bodyOf(src, 'function storyCardLook(card) {').replace(/\s+/g, '');
  };
  ok('4.1 原著卡片注入前后端同构（逐字比对，去空白）',
    cardBody(routesSrc).length > 300 && cardBody(routesSrc) === cardBody(constsSrc));
  ok('4.1 原著卡片取字段逻辑前后端同构',
    lookBody(routesSrc).length > 150 && lookBody(routesSrc) === lookBody(constsSrc));
  ok('4.1 原著卡片注入含去重与空壳防护（自证非空跑）',
    /lower\.includes/.test(cardBody(routesSrc)) && /场景道具——/.test(cardBody(routesSrc)));
  const injectKeys = (src) => {
    const m = src.match(/STORY_CARD_INJECT_FIELDS = \{([\s\S]*?)\n\};/);
    return m ? [...m[1].matchAll(/(\w+):\s*\[/g)].map((x) => x[1]).sort().join(',') : '';
  };
  ok('4.1 前后端可注入类别表同构', injectKeys(routesSrc) !== '' && injectKeys(routesSrc) === injectKeys(constsSrc));
  // 批 8 补 30 / 补 31：字段长度上限的前后端镜像。它是编辑框 maxlength 的来源 ——
  // 漂了就会出现"界面允许输入 300 字、服务端砍到 200"，而用户只在保存后才发现少了一截。
  // ⚠️ 后端那张表有一半是**推导**出来的（`...Object.fromEntries(...)`，源码里没有字面数字），
  // 所以**不能**用正则去抠后端的数字（只会抠到显式的那几个，比较就成了"半张表对整张表"）。
  // 这里把后端 require 进来比**求值结果**，前端那份仍是普通字面量、按名字抠。
  const storyModEarly = createRequire(import.meta.url)(path.join(ROOT, 'lib', 'story.js'));
  const feTable = (src, name) => {
    const m = src.match(new RegExp(name + ' = \\{([\\s\\S]*?)\\n\\};'));
    return m ? [...m[1].matchAll(/(\w+):\s*(\d+)/g)].map((x) => `${x[1]}=${x[2]}`).sort().join(',') : '';
  };
  const beTable = (obj) => Object.entries(obj).map(([k, v]) => `${k}=${v}`).sort().join(',');
  ok('4.1 前后端字段长度上限表同构（编辑框 maxlength 的唯一来源）',
    feTable(constsSrc, 'STORY_CARD_FIELD_MAX') !== ''
    && beTable(storyModEarly.FIELD_MAX) === feTable(constsSrc, 'STORY_CARD_FIELD_MAX'),
    `后端 ${beTable(storyModEarly.FIELD_MAX).slice(0, 50)} / 前端 ${feTable(constsSrc, 'STORY_CARD_FIELD_MAX').slice(0, 50)}`);
  const novelMaxSrc = read(path.join(PUB, 'js', 'pages', 'novel.js')); // 同上：novelSrc 在更后面才声明
  ok('4.1 编辑框按上限表设 maxlength（输入时就挡住，而不是保存后被悄悄砍掉）',
    /maxlength="\$\{STORY_CARD_FIELD_MAX\[f\] \|\| 200\}"/.test(novelMaxSrc)
    && /maxlength="\$\{STORY_CARD_FIELD_MAX\.name\}"/.test(novelMaxSrc)
    && /maxlength="\$\{STORY_CARD_FIELD_MAX\.summary\}"/.test(novelMaxSrc));
  ok('4.1 服务端截断时界面会说话（不静默少一截文字）',
    /r\.data\.truncated/.test(novelMaxSrc) && /已截断/.test(novelMaxSrc));
  // 批 8 补 32：AI 补幕次（幕次是分集的依据，界面必须"先干跑、再花钱、后如实报"）
  {
    // 这里的 stageApiSrc 在别的块里（块作用域取不到）、stageSeedSrc 在文件更后面才声明（TDZ）——
    // 必须各读一份，别指望外层有（批 8 补 31 就为这个白查过一轮）
    const stageApiSrc = read(path.join(PUB, 'js', 'api.js'));
    const stageSeedSrc = read(path.join(ROOT, 'lib', 'seed.js'));
    // **把钉钉在 fillStages 这个函数体上**：`costConfirm(` 在本页别处也出现（其它生成入口也用它），
    // 拿整份文件去 test 就是"因错误的原因通过"—— 把 fillStages 里的计费确认删掉，断言照样绿。
    // 同理 `d.invalid`/`d.missing` 也不能靠 `|bad\b` 这种兜底分支（那等于没钉）
    const fillBody = (novelMaxSrc.match(/async function fillStages\([^)]*\)[\s\S]*?\n  \}/) || [''])[0];
    ok('4.1 找得到 fillStages 的函数体（下面几条都钉在它身上，钉不到就是空测）',
      fillBody.length > 200, String(fillBody.length));
    ok('4.1 前端有补幕次的端点封装，且带 dry_run（干跑不花钱）',
      /storyStageFill:/.test(stageApiSrc) && /\/api\/story\/stage-fill/.test(stageApiSrc) && /dry_run/.test(stageApiSrc));
    ok('4.1 补幕次按钮只在"还有拍点没标幕次"时才渲染（没有待定时不摆一个点了没反应的按钮）',
      /d\.stage_covered < d\.beat_count/.test(novelMaxSrc) && /data-outline-stage/.test(novelMaxSrc));
    ok('4.1 按钮点击接到了 fillStages', /\[data-outline-stage\][^\n]*fillStages\(/.test(novelMaxSrc));
    // 花钱的动作必须过本页统一的计费闸门，而不是自己弹一个"确认吗"
    ok('4.1 补幕次先干跑拿到"要补几拍"再走计费确认（不许直接开跑）',
      /storyStageFill\(sourceId, \{ dryRun: true \}\)/.test(fillBody) && /costConfirm\(/.test(fillBody));
    ok('4.1 干跑里就拦住"没有待定拍"的情况（不弹确认也不花钱）',
      /if \(!dry\.data\.targets\)/.test(fillBody));
    // 结果必须如实说清：补了几个、哪几拍没接住、有没有倒退、分集依据有没有真的变好
    ok('4.1 补完如实报出补了几拍', /已补 \$\{d\.assigned\}\/\$\{d\.targets\}/.test(fillBody));
    ok('4.1 没接住的拍要单独报（不能只报成功数）',
      /d\.invalid/.test(fillBody) && /d\.missing/.test(fillBody));
    ok('4.1 幕次倒退要提醒人工看一眼（服务端不替模型修顺）', /d\.back_steps/.test(fillBody) && /倒退/.test(fillBody));
    ok('4.1 分集依据变了要报出来（"这次调用有没有用"的证据）',
      /d\.basis_before !== d\.basis_after/.test(fillBody));
    ok('4.1 补完要重新载入卡片并重切分集（否则界面还显示旧骨架）',
      /await loadCards\(\)[\s\S]{0,60}await runOutline\(\)/.test(fillBody));
    // 体检的"去处理"跳进来要真的把面板打开：只切页不打开面板 = 用户还得自己找那个按钮
    ok('4.1 原著页认得体检带过来的 panel=outline 深链并打开分集大纲面板',
      /params\.panel === 'outline'/.test(novelMaxSrc) && /#nov-outline-box/.test(novelMaxSrc)
      && /panel: 'outline'/.test(read(path.join(ROOT, 'lib', 'story.js'))));
    // 补 32 的提示词模板必须真的在内置模板里（否则运行时报"缺少提示词模板"）
    ok('4.1 补幕次用的提示词模板在内置模板表里',
      stageSeedSrc.includes("key: 'plot_stage'") || stageSeedSrc.includes('key: \'plot_stage\''));
  }

  // 批 8 补 33：AI 回原文补人物长相（界面必须"先干跑、再花钱、后把三种没写成的原因分开报"）
  {
    const lookApiSrc = read(path.join(PUB, 'js', 'api.js'));
    const lookSeedSrc = read(path.join(ROOT, 'lib', 'seed.js'));
    const lookStorySrc = read(path.join(ROOT, 'lib', 'story.js'));
    // 同样把行为钉收进 fillFields 的函数体：`costConfirm(`/`toast.ok(` 在本页别处也出现，
    // 拿整份文件 test 就是"因错误的原因通过"（补 32 的 IW 对照正是这么抓出来的）
    const lookBody = (novelMaxSrc.match(/async function fillFields\(target[^)]*\)[\s\S]*?\n  \}/) || [''])[0];
    ok('4.1 找得到 fillFields 的函数体（下面几条都钉在它身上，钉不到就是空测）',
      lookBody.length > 400, String(lookBody.length));
    ok('4.1 前端有回原文补字段的端点封装，且带 dry_run（干跑不花钱）',
      /storyFieldFill:/.test(lookApiSrc) && /\/api\/story\/field-fill/.test(lookApiSrc) && /dry_run/.test(lookApiSrc));
    ok('4.1 工具栏有「AI 补长相」按钮，且点击接到了 char_look 目标',
      /id="nov-look"/.test(novelMaxSrc) && /'#nov-look'[\s\S]{0,60}fillFields\('char_look'/.test(novelMaxSrc));
    ok('4.1 补长相先干跑拿到"要补几张"再走计费确认（不许直接开跑）',
      /call\(\{ dryRun: true \}\)/.test(lookBody) && /costConfirm\(/.test(lookBody)
      && /storyFieldFill\(sourceId, target, opts\)/.test(lookBody));
    ok('4.1 干跑里就拦住"一张都不缺"的情况（不弹确认也不花钱）',
      /if \(!dry\.data\.targets\)/.test(lookBody));
    // 界面**不自己算**"有几张缺长相"：那个判据在服务端（体检也用它），前端再抄一份迟早会漂。
    // 所以"要补几张"必须来自干跑，而不是 cards.filter(...)
    ok('4.1 "要补几张"来自服务端干跑，而不是前端自己再抄一份判据',
      /dry\.data\.targets/.test(lookBody) && !/kind === 'character'[\s\S]{0,60}!c\.appearance/.test(novelMaxSrc));
    ok('4.1 两条路（补长相/补场景字段）共用**一个**函数与一份文案表（不是抄两遍）',
      (novelMaxSrc.match(/async function fillFields\(/g) || []).length === 1
      && /FILL_TARGETS = \{/.test(novelMaxSrc) && /char_look:/.test(novelMaxSrc) && /card_inject:/.test(novelMaxSrc));
    ok('4.1 补完如实报出补了几张', /已\$\{cfg\.verb \|\| '补'\} \$\{d\.assigned\}\/\$\{d\.targets\}/.test(lookBody));
    // 三种"没写成"必须**分开**报：原文没写（结论）/ 引文对不上原文（那是它编的）/ 没接住。
    // 合成一个数，用户就分不清"原著没写"和"模型在编"—— 而后者才是真正要警惕的
    ok('4.1 "原文确实没写"单独说，且明说是结论不是失败',
      /d\.not_found/.test(lookBody) && /不是失败/.test(lookBody));
    ok('4.1 "引文对不上原文"单独报警（那是模型编的）', /d\.ungrounded/.test(lookBody) && /编/.test(lookBody));
    ok('4.1 其余没接住的也单独说', /d\.missing/.test(lookBody) && /d\.invalid/.test(lookBody));
    ok('4.1 切块与解析时不一致要提醒人工核对（否则补上的内容可能对不上原文）',
      /d\.aligned === false/.test(lookBody) && /人工核对/.test(lookBody));
    ok('4.1 补完要重新载入卡片（否则界面还显示旧描述）', /await loadCards\(\)/.test(lookBody));
    // 体检的"去处理"要落到人物卡上（按钮在卡片工作台工具栏那一排）
    ok('4.1 体检的 char_no_look 有出口且落到人物卡上',
      /kind: 'character'/.test(lookStorySrc) && /code: 'char_no_look'/.test(lookStorySrc));
    // 补 33 的提示词模板必须真的在内置模板里（否则运行时报"缺少提示词模板"）
    ok('4.1 补长相用的提示词模板在内置模板表里', lookSeedSrc.includes("key: 'char_look'"));
  }

  // 批 8 补 43：AI 回原文补人物卡（与补字段同一套机制，但落点是**新增卡** → 另一个端点）
  {
    const castApiSrc = read(path.join(PUB, 'js', 'api.js'));
    const castSeedSrc = read(path.join(ROOT, 'lib', 'seed.js'));
    const castStorySrc = read(path.join(ROOT, 'lib', 'story.js'));
    const castRouteSrc = read(path.join(ROOT, 'lib', 'routes.js'));
    // 入口：工具栏按钮 → fillFields('cast_card')；体检那条问题的文案要**指名**这个入口（否则用户不知道点哪）
    ok('4.3 工具栏有「AI 补人物卡」按钮，且点击接到了 cast_card 目标',
      /id="nov-cast"/.test(novelMaxSrc) && /'#nov-cast'[\s\S]{0,60}fillFields\('cast_card'/.test(novelMaxSrc));
    ok('4.3 体检的 plot_cast_unknown 文案**指名**这个入口（体检不能只有结论、没有出口）',
      /AI 补人物卡/.test(castStorySrc) && /plot_cast_unknown/.test(castStorySrc));
    // 端点封装：另一个端点 + 同样的 dry_run 干跑闸门
    ok('4.3 前端有补卡的端点封装，且带 dry_run（干跑不花钱）',
      /storyCastFill:/.test(castApiSrc) && /\/api\/story\/cast-fill/.test(castApiSrc) && /dry_run/.test(castApiSrc));
    // **一条路**：cast 走的是同一个 fillFields（不是抄第二份函数），只在配置里多一个 cast 标记
    ok('4.3 补卡复用**同一个** fillFields（多抄一份就会有两份计费确认与报告）',
      (novelMaxSrc.match(/async function fillFields\(/g) || []).length === 1
      && /cast_card: \{/.test(novelMaxSrc) && /cfg\.cast \? api\.storyCastFill/.test(novelMaxSrc));
    // 报告同构：界面共用同一个报告渲染器（服务端返回 assigned_items，不是另造一份 created）
    ok('4.3 服务端返回与补字段**同构**的报告（assigned_items/values/quote），界面才能共用渲染器',
      /assigned_items: written/.test(castRouteSrc) && /values: meta\[i\]\.values/.test(castRouteSrc));
    // 红线：原文里找不到的人**一张卡都不许建**（泛称/代称变成卡会进提示词与名册）
    ok('4.3 服务端对 not_found 一条都不建卡（红线：宁可少建一张，也不建一张编的）',
      /not_found\.push/.test(castStorySrc) && /cards\.push\(\{ index: n, kind: 'character'/.test(castStorySrc));
    // 落库必须走**唯一一份**规范化，绝不自己拼一个卡对象
    ok('4.3 新卡落库走 normalizeCard（与分块抽取抽出来的卡形状完全一致）',
      /story\.normalizeCard\(\s*\{ kind: 'character', name: p\.name/.test(castRouteSrc));
    // 提示词模板必须在内置模板表里（否则运行时报"缺少提示词模板"）
    ok('4.3 补卡用的提示词模板在内置模板表里', castSeedSrc.includes("key: 'cast_card'"));
    ok('4.3 模板变量与路由传入的键逐字一致（写错就是静默发空）',
      castSeedSrc.includes('{{候选人物与原文片段}}') && /'候选人物与原文片段': story\.castFillLines/.test(castRouteSrc));
  }

  // 批 8 补 45：AI 认名字（体检里"角色库找不到的名字"接上 AI 出口；落点是**分镜绑定**，
  // 不是改字段也不是建卡，而且**不动用户写的字** —— 所以它既不进 FILL_TARGETS，也不进一键补齐）
  {
    const scApiSrc = read(path.join(PUB, 'js', 'api.js'));
    const scSeedSrc = read(path.join(ROOT, 'lib', 'seed.js'));
    const scStorySrc = read(path.join(ROOT, 'lib', 'story.js'));
    const scRouteSrc = read(path.join(ROOT, 'lib', 'routes.js'));
    // 签名里**必须有 btn**：`setBusy` 只接受控件（补 35 的规矩，本轮真机抓到过一次）
    const scBody = bodyOf(novelMaxSrc, 'async function fillShotChar(names, btn) {');
    // ① 出口**挂在问题上**：这一条原来既没有 fixable、也没有 go，报告出来了却一个按钮都没有
    ok('4.5 体检行按服务端给的 ai_fix 渲染按钮（前端不另写一份"哪条问题对应哪个动作"的映射表）',
      /it\.ai_fix \?/.test(novelMaxSrc) && /data-audit-ai="\$\{i\}"/.test(novelMaxSrc)
      && /ai_fix: \{ code: 'shot_char_bind'/.test(scStorySrc));
    ok('4.5 AI 出口的名字由服务端给（前端只显示 label，不自己编）',
      /esc\(it\.ai_fix\.label/.test(novelMaxSrc));
    // ② 点击处理器：读**连字符原名**的 data 属性（驼峰会静默拿到 null → "按钮点了没反应"，注意事项 7），
    //    并且按**动作码**分发（不是按显示文案）
    ok('4.5 处理器读连字符原名 data-audit-ai，且按动作码分发（不按界面文案分发）',
      /dataOf\(e\.currentTarget, 'audit-ai'\)/.test(novelMaxSrc)
      && /issue\.ai_fix && issue\.ai_fix\.code/.test(novelMaxSrc) && /code !== 'shot_char_bind'/.test(novelMaxSrc));
    // ③ 一次点击只做一个明确的动作：只认**这一条**名字（不顺手把别的名字也认了）
    ok('4.5 点一条问题只认**那一个**名字（不顺手把别的名字也认了）',
      /await fillShotChar\(\[String\(issue\.target_name \|\| ''\)\]\.filter\(Boolean\),/.test(novelMaxSrc));
    // ④ 干跑闸门：**先免费问一遍**，确认框里的次数取干跑报的那个数（不写死 1）
    ok('4.5 先干跑再弹计费确认，且次数取干跑报的数（不写死）',
      /dryRun: true, names/.test(scBody) && /costConfirm\(\{[\s\S]{0,120}count: dry\.data\.calls/.test(scBody));
    ok('4.5 计费确认说明"认出来会直接绑定、不动你在镜头里写的字"（花钱前把后果说清）',
      /不动你在镜头里写的字/.test(scBody) && /绑定/.test(scBody));
    // ⑤ 400 是**结论**、不是失败（"没有要认的名字了"和"调用炸了"是两件事）
    ok('4.5 400 当结论、其余当失败 —— 看状态码，不猜文案',
      /dry\.status === 400/.test(scBody) && /dry\.status === 400 \? 'info' : 'err'/.test(scBody));
    // ⑥ 报告**共用同一份正文**（补 43/44 的教训：另写一份就是同一个事实的第二份形状）
    ok('4.5 报告复用同一个 fillReportBody（没有第二份报告正文）',
      (novelMaxSrc.match(/function fillReportBody\(/g) || []).length === 1
      && /renderFillReport\(d, cfg\)/.test(scBody));
    // ⑦ 两个"结论桶"必须**看得见**（只报"认出来几个"的话，用户不知道剩下的该怎么办）
    ok('4.5 报告渲染 need_card 与 unknown_target 两个桶（结论要看得见，不能只报成功数）',
      /d\.need_card/.test(novelMaxSrc) && /d\.unknown_target/.test(novelMaxSrc)
      && /cfg\.needCardTitle/.test(novelMaxSrc) && /cfg\.unknownTargetTitle/.test(novelMaxSrc));
    ok('4.5 桶标题由配置给（桶名不是判据，是标题 —— 所以不写死在渲染器里）',
      /needCardTitle: '/.test(novelMaxSrc) && /unknownTargetTitle: '/.test(novelMaxSrc));
    // ⑧ 落点是**分镜**，候选来自**体检**：所以收的是 project_id，不是 source_id
    //    （没有解析过原著、只生成了分镜的项目也必须能用）
    ok('4.5 端点封装收 project_id（候选来自体检，不依赖"解析过原著"）',
      /storyShotCharFill: \(projectId/.test(scApiSrc) && /project_id: projectId, names/.test(scApiSrc));
    ok('4.5 服务端候选只来自体检（`auditShotBindings` 一份实现），不另立一份判据',
      /const aud = story\.auditShotBindings\(shots/.test(scRouteSrc)
      && /i\.code === 'shot_char_unknown'/.test(scRouteSrc));
    // ⑨ 红线：名册外的名字不许绑；绑定是**并集**（绝不覆盖人工绑定）
    ok('4.5 服务端红线：target 必须真的在名册里才绑（名册外如实报 unknown_target）',
      /byName\.get\(target\.toLowerCase\(\)\)/.test(scStorySrc) && /unknown_target\.push/.test(scStorySrc));
    ok('4.5 落库是并集语义（与补 5 的自动匹配同一个落点，绝不覆盖人工绑定）',
      /const cur = Array\.isArray\(sb\.character_ids\)/.test(scRouteSrc) && /cur\.concat\(str\(b\.character_id\)\)/.test(scRouteSrc));
    // ⑩ 提示词模板必须在内置表里，且**两个变量都在**（变量名对不上 = 名册发不出去 = 模型凭名字编）
    ok('4.5 认名字用的提示词模板在内置模板表里', scSeedSrc.includes("key: 'shot_char'"));
    ok('4.5 模板变量与路由传入的键逐字一致（写错就是静默发空）',
      scSeedSrc.includes('{{角色名册}}') && scSeedSrc.includes('{{未知名字与镜头文字}}')
      && /'角色名册': roster\.text/.test(scRouteSrc) && /'未知名字与镜头文字': story\.shotCharLines/.test(scRouteSrc));
    // ⑪ 名册走**唯一一份** `characterRoster`（与生成剧本/分镜发给模型的是同一段文字）
    ok('4.5 名册复用 characterRoster（唯一一份），不另写一段"认名字专用名册"',
      /story\.characterRoster\(chars/.test(scRouteSrc) && !/认名字专用名册/.test(scRouteSrc));
    // ⑬ **`setBusy` 只接受控件**：补 35 立的规矩，本轮真机又抓到一次 ——
    //    `fillShotChar(names)` 的签名里没有 `btn`，却写了 `setBusy(btn, …)`，
    //    于是计费确认之后**什么都没发生**，链路上只有 `btn is not defined`（"成功但页面变哑"）
    ok('4.5 认名字的动作拿得到**被点的那颗按钮**（签名里有 btn，且 setBusy 传的是它）',
      /async function fillShotChar\(names, btn\)/.test(novelMaxSrc)
      && /setBusy\(btn, true, '正在认名字'\)/.test(novelMaxSrc)
      && /fillShotChar\(\[String\(issue\.target_name \|\| ''\)\]\.filter\(Boolean\), e\.currentTarget\)/.test(novelMaxSrc));
    // ⑫ **两个写入点必须一起写**：只绑不改 → 体检那条永远消不掉（假警报），
    //    而且再点一次会白花一次模型调用并报"没认出来"（它明明认出来了）
    ok('4.5 服务端同时写**两处**：绑定 + 把「出场人物」的代称换成本名（只写一处就是假警报）',
      /patch\.character_ids = cur\.concat/.test(scRouteSrc)
      && /story\.renameShotCharacter\(sb\.characters/.test(scRouteSrc)
      && /patch\.characters = renamed/.test(scRouteSrc));
    ok('4.5 改名只在**真的提到过**这个代称时做（没命中就一个字节都不动）',
      /if \(renamed !== str\(sb\.characters\)\) patch\.characters = renamed/.test(scRouteSrc));
    ok('4.5 报告把写进去的两处都列出来（写了两处却只报一处，用户核对不到）',
      /fields: \['出场人物', '绑定角色'\]/.test(scRouteSrc));
    ok('4.5 改名走**唯一一份**实现（整词替换 + 去重，子串替换会让"林晚"误伤"林晚秋"）',
      /function renameShotCharacter\(/.test(scStorySrc) && /SHOT_CHAR_SEP/.test(scStorySrc));
    // ⑫ 认名字**不进** FILL_TARGETS（那张表的候选都来自卡片库），也不进一键补齐的步骤表
    ok('4.5 认名字不进 FILL_TARGETS（它的候选来自体检，不是卡片库）',
      !/shot_char: \{/.test(novelMaxSrc) || !/FILL_TARGETS[\s\S]{0,600}shot_char:/.test(novelMaxSrc));
    ok('4.5 认名字不进「AI 一键补齐」的步骤表（那条链是"回原文补齐卡片"，依赖 source_id）',
      !/key: 'shot_char'/.test(novelMaxSrc));
  }

  // 批 8 补 44：AI 一键回原文补齐（把「回原文找」这一族一次做完，只弹一次计费确认）
  {
    const allBody = bodyOf(novelMaxSrc, 'async function fillAll(btn) {');
    // `bodyOf` 只配平**花括号**，而步骤表是**数组** —— 拿它切只会切到第一个元素
    // （第一版就是这么错的：at('cast_card') 得到 -1，断言红得莫名其妙）。这里按方括号配平切。
    const arrOf = (src, sig) => {
      const i = src.indexOf(sig);
      if (i < 0) return '';
      let d = 0;
      for (let j = i + sig.length - 1; j < src.length; j++) {
        if (src[j] === '[') d++;
        else if (src[j] === ']') { d--; if (!d) return src.slice(i, j + 1); }
      }
      return '';
    };
    const stepsBody = arrOf(novelMaxSrc, 'const FILL_ALL_STEPS = [');
    const repBody = bodyOf(novelMaxSrc, 'function renderBatchReport(steps) {');
    const loopBody = bodyOf(allBody, 'for (const st of todo) {');
    const at = (k) => stepsBody.indexOf(`key: '${k}'`);
    ok('4.4 工具栏有「AI 一键补齐」按钮，且点击接到了 fillAll',
      /id="nov-fillall"/.test(novelMaxSrc) && /'#nov-fillall'[\s\S]{0,60}fillAll\(e\.currentTarget\)/.test(novelMaxSrc));
    // 覆盖五类，且**顺序是有意的**：补人物卡排在补长相前面 —— 新建的卡也可能缺长相，一次补齐就顺手补上
    ok('4.4 一键补齐覆盖 5 类，且补人物卡排在补长相**前面**（新建的卡也会一起补上长相）',
      ['plot_stage', 'cast_card', 'char_look', 'card_inject', 'timeline_when'].every((k) => at(k) >= 0)
      && at('plot_stage') < at('cast_card') && at('cast_card') < at('char_look')
      && at('char_look') < at('card_inject') && at('card_inject') < at('timeline_when'));
    // **判据一个都不许抄到前端**："有几张缺"全部来自服务端干跑（前端再抄一份迟早会漂，补 30 的教训）
    ok('4.4 步骤表里没有任何判据（前端不自己算"有几张缺"）',
      stepsBody.length > 0 && !/targets|missing|needsLook|\bpool\b/.test(stepsBody));
    // 名字/单位/动词只有一份来源：放在配置里（FILL_TARGETS / STAGE_FILL），步骤表只留接线
    ok('4.4 每一类"叫什么/报什么单位"只有一份来源（步骤表里不另写 label/unit/verb）',
      !/label:|unit:|verb:/.test(stepsBody) && /s\.cfg\.label/.test(repBody) && /s\.cfg\.unit/.test(repBody));
    // ① **先免费问一遍再确认**：干跑必须出现在计费确认之前（否则就是"先花钱再告诉你花了多少"）
    ok('4.4 先免费干跑算出每一类有多少候选，**再**弹计费确认（不许先开跑）',
      allBody.indexOf('dryRun: true') > 0 && allBody.indexOf('dryRun: true') < allBody.indexOf('costConfirm('));
    // ② 每一步**开跑前重新干跑**：前面的步骤会改数据（新建的卡也可能缺长相）
    ok('4.4 每一步开跑前**重新**干跑（前面的步骤会改数据，拿旧名单开跑＝对着过期候选花钱）',
      /for \(const st of todo\)[\s\S]{0,500}st\.call\(sourceId, \{ dryRun: true \}\)/.test(allBody));
    // ③ 400 是**结论**、5xx 才是失败 —— 用状态码分，不猜文案
    ok('4.4 "还没有这类卡片"（HTTP 400）当结论、真出错（5xx）当失败 —— 用状态码分、不猜文案',
      /dry\.status === 400/.test(allBody)
      && /status: 'skipped', reason: dry\.error/.test(allBody)
      && /status: 'failed', reason: dry\.error/.test(allBody));
    // ④ 失败只丢这一步
    ok('4.4 某一步失败只丢这一步（循环里一律 continue，不许 break/return/throw 中断整批）',
      loopBody.length > 0 && /status: 'failed'/.test(loopBody)
      && !/\bbreak\b|\bthrow\b|\breturn\b/.test(loopBody));
    // ⑤ 报告正文只有一份实现（另写一份＝"少一列"没人发现）
    ok('4.4 单个补与一键补齐**共用同一份**报告正文（另写一份就是同一个事实的第二份形状）',
      (novelMaxSrc.match(/function fillReportBody\(/g) || []).length === 1
      && /\$\{fillReportBody\(d, cfg\)\}/.test(novelMaxSrc)
      && /\$\{fillReportBody\(d, s\.cfg\)\}/.test(novelMaxSrc));
    // ⑥ 每一步分开报（跳过的/没做成的各占原位），报告留在页面上
    ok('4.4 报告按步骤分开列（跳过的、没做成的各占原位），且留在页面上可核对引文',
      /steps\.map\(sec\)/.test(repBody) && /这一步没做成/.test(repBody) && /跳过/.test(repBody));
  }

  // 批 8 补 34：补场景/道具字段（与补长相同一套机制 —— 界面必须是**一个**函数、两份配置）
  {
    const injApiSrc = read(path.join(PUB, 'js', 'api.js'));
    const injSeedSrc = read(path.join(ROOT, 'lib', 'seed.js'));
    const injStorySrc = read(path.join(ROOT, 'lib', 'story.js'));
    const injRouteSrc = read(path.join(ROOT, 'lib', 'routes.js'));
    ok('4.1 工具栏有「AI 补场景字段」按钮，且点击接到了 card_inject 目标',
      /id="nov-inject"/.test(novelMaxSrc) && /'#nov-inject'[\s\S]{0,60}fillFields\('card_inject'/.test(novelMaxSrc));
    ok('4.1 两条路的文案表是**两份配置**（各自的"叫什么/缺什么"不同），而不是把函数抄两遍',
      /FILL_TARGETS = \{[\s\S]*?char_look:[\s\S]*?card_inject:/.test(novelMaxSrc)
      && /补人物长相/.test(novelMaxSrc) && /补场景道具字段/.test(novelMaxSrc)
      && /所有人物卡都已经有外貌或服装了/.test(novelMaxSrc) && /可注入的描述/.test(novelMaxSrc));
    ok('4.1 前端把 target 发给服务端（而不是发两个端点）',
      /storyFieldFill:/.test(injApiSrc) && /target,/.test(injApiSrc) && /\/api\/story\/field-fill/.test(injApiSrc));
    // 规格表：两份规格、各自的模板变量名
    ok('4.1 服务端的规格表里有 char_look 与 card_inject',
      /FILL_SPECS = \{/.test(injStorySrc) && /key: 'char_look'/.test(injStorySrc) && /key: 'card_inject'/.test(injStorySrc));
    ok('4.1 规格表按类别取字段（地点与道具要的东西不同，字段表与注入表同源）',
      /fieldsOf: \(c\) => STORY_INJECT_FIELDS\[c\.kind\]/.test(injStorySrc));
    // **变量名对不上是静默失败**（renderPrompt 会把没给的 {{…}} 换成空串）：两边必须逐字对上，且路由要先检查
    ok('4.1 规格里的变量名与模板正文逐字一致（对不上就静默发空清单）',
      /varName: '人物与原文片段'/.test(injStorySrc) && /varName: '卡片与原文片段'/.test(injStorySrc)
      && /\{\{人物与原文片段\}\}/.test(injSeedSrc) && /\{\{卡片与原文片段\}\}/.test(injSeedSrc));
    ok('4.1 路由在调用前**先检查**模板里有这个变量（把静默失败变成明确报错）',
      /includes\(`\{\{\$\{spec\.varName\}\}\}`\)/.test(injRouteSrc) && /发不出去/.test(injRouteSrc));
    ok('4.1 路由照**计划里记的字段清单**写（按 kind 再推一次会得到空清单 → 报成功却没写）',
      /for \(const f of \(p\.fields \|\| \[\]\)\)/.test(injRouteSrc));
    ok('4.1 补场景字段用的提示词模板在内置模板表里',
      injSeedSrc.includes("key: 'card_inject'") && /\{\{卡片与原文片段\}\}/.test(injSeedSrc));
    // 体检的两个出口（补 34 之前只有结论、没有出口）
    ok('4.1 体检的 no_inject 有出口，且切到**该卡的类别**（地点卡与道具卡要补的字段不同）',
      /code: 'no_inject'[\s\S]{0,700}?kind: c\.kind, card_id: c\.id \}/.test(injStorySrc));
    ok('4.1 体检的 timeline_no_when 也有出口（落到那张时间线卡上）',
      /code: 'timeline_no_when'[\s\S]{0,900}?kind: 'timeline', card_id: c\.id \}/.test(injStorySrc));
    // 出口一律带 card_id（落到那张卡上），别只在新加的两个上补 —— 同一张卡的两个问题点下去行为要一致。
    // 这条是**静态**的形态检查，真正的棘轮在 selftest（对真实体检结果断言"按类别落到卡片的出口都带 card_id"）
    ok('4.1 三个"按类别落到某张卡"的出口都带 card_id（char_no_look 也补上了）',
      /kind: 'character', card_id: c\.id \}/.test(injStorySrc)
      && /kind: c\.kind, card_id: c\.id \}/.test(injStorySrc)
      && /kind: 'timeline', card_id: c\.id \}/.test(injStorySrc));
  }

  // 批 8 补 35：第三个规格（时间点）＋ **引文可见**
  {
    const whenApiSrc = read(path.join(PUB, 'js', 'api.js'));
    const whenSeedSrc = read(path.join(ROOT, 'lib', 'seed.js'));
    const whenStorySrc = read(path.join(ROOT, 'lib', 'story.js'));
    const whenRouteSrc = read(path.join(ROOT, 'lib', 'routes.js'));
    ok('4.1 工具栏有「AI 补时间点」按钮，且点击接到了 timeline_when 目标',
      /id="nov-when"/.test(novelMaxSrc) && /'#nov-when'[\s\S]{0,60}fillFields\('timeline_when'/.test(novelMaxSrc));
    // 三份规格共用一个 fillFields —— 每加一份就抄一个函数的写法迟早会分叉（引文核对抄两份最危险）
    ok('4.1 三条路仍然只有**一个** fillFields 函数（规格是数据，不是三份实现）',
      (novelMaxSrc.match(/async function fillFields\(/g) || []).length === 1
      && /timeline_when: \{[\s\S]{0,200}?what: '补时间点'/.test(novelMaxSrc)
      && /所有时间线卡都已经有时间点了/.test(novelMaxSrc));
    ok('4.1 前端仍然只发一个端点（不按 target 分叉）',
      (whenApiSrc.match(/\/api\/story\/field-fill/g) || []).length === 1 && /target,/.test(whenApiSrc));
    // 规格表：第三份规格的形状与另两份一致（同一个机制、只换数据）
    ok('4.1 服务端规格表里有 timeline_when，且只管网时间线卡、只补 when',
      /key: 'timeline_when'/.test(whenStorySrc) && /kinds: \['timeline'\]/.test(whenStorySrc)
      && /fields: \['when'\]/.test(whenStorySrc) && /payloadKey: 'whens'/.test(whenStorySrc));
    ok('4.1 规格里的变量名与模板正文逐字一致（对不上就静默发空清单）',
      /varName: '时间线卡与原文片段'/.test(whenStorySrc) && /\{\{时间线卡与原文片段\}\}/.test(whenSeedSrc));
    ok('4.1 补时间点用的提示词模板在内置模板表里',
      whenSeedSrc.includes("key: 'timeline_when'") && /不许推算/.test(whenSeedSrc));
    // **反转**：补 32 写的"这一项没有让模型补的按钮"已经不成立，文案必须跟着改（改，不是删）
    ok('4.1 体检的 timeline_no_when 文案已随反转更新（指向按钮，且不再声称没有 AI 补值）',
      /AI 补时间点/.test(whenStorySrc) && !/没有"让模型补"的按钮/.test(whenStorySrc));
    // ── 引文可见：报告必须逐张给出"写进去的值 + 它的引文" ──
    // 只报一个张数（或一闪而过的 toast），用户就只能盲信；时间点这类**事实型**字段尤其如此
    ok('4.1 原著页有一个**持久**的报告容器（toast 会消失，引文必须留在页面上）',
      /id="nov-fill-box"/.test(novelMaxSrc));
    ok('4.1 报告渲染的是服务端给的 assigned_items（不是前端自己再算一遍）',
      /renderFillReport\(d, cfg\)/.test(novelMaxSrc) && /d\.assigned_items \|\| \[\]/.test(novelMaxSrc));
    ok('4.1 报告里同时给出**写进去的值**与它的**原文原话**（值 ← 原话，才核对得了）',
      /x\.values/.test(novelMaxSrc) && /x\.quote/.test(novelMaxSrc) && /依据原文原话/.test(novelMaxSrc));
    // 注意事项 11：断言要能区分"定义了"与"被调用了" —— 带上行首与分号，避免匹配到函数定义
    ok('4.1 报告函数**被调用**了（不是只定义在那儿 —— 定义了不调用在界面上就是没有）',
      /^\s*renderFillReport\(d, cfg\);$/m.test(novelMaxSrc));
    ok('4.1 三种"没写成"在报告里**各带名字**（只说"有 3 张没写"，用户还得自己去几十张卡里找）',
      /原文确实没写/.test(novelMaxSrc) && /引文对不上原文，已丢弃不写/.test(novelMaxSrc)
      && /arr \|\| \[\]\)\.map\(\(x\) => esc\(x\.name\)\)/.test(novelMaxSrc));
    // 路由：报告必须是**真的写进去**的那一份（截断之后），不是模型的提议
    ok('4.1 路由返回 assigned_items，且记的是**实际落库**的 patch（截断之后）',
      /assigned_items: written/.test(whenRouteSrc) && /written\.push\(\{ id: p\.id, name: p\.name/.test(whenRouteSrc)
      && /values: patch/.test(whenRouteSrc));
    ok('4.1 assigned_names 与 assigned_items 同源（不再各算一遍，否则一个说 2 一个说 1）',
      /assigned_names: written\.map/.test(whenRouteSrc));
    ok('4.1 一个字都没写的不算进 assigned（"成功但没写"不能报成功）',
      /if \(Object\.keys\(patch\)\.length\) \{\s*\n\s*written\.push/.test(whenRouteSrc));
    // ── setBusy 的防呆（批 8 补 35 真机测试抓到的真 bug） ──
    // `setBusy(el, true, …)` 会把 `el.innerHTML` 换成 spinner —— 传**容器**进来就等于把整页抹掉，
    // 连带里面所有已绑定的监听；而链路上零报错（toast 照样报成功，只是列表不再刷新、页面变哑）。
    // 补 32「AI 补幕次」与补 33/34「回原文补字段」两处都这么错过了。两道防线：
    // ① 结构棘轮：页面模块里不许再把容器传给 setBusy；② 运行时防呆：setBusy 自己拒绝非控件
    ok('4.1 页面模块里没有把**容器**传给 setBusy（那会把整页内容与监听一起抹掉）',
      !/setBusy\(\s*container\b/.test(novelMaxSrc));
    ok('4.1 setBusy 自己拒绝非控件（把静默的"页面变哑"变成看得见的失败）',
      // **不能只钉"那句话在文件里"**：正对照 JK 把 `if` 条件换成 `if (false)`，字符串还在、
      // 断言照样绿 —— 那钉的是"存在"不是"生效"（注意事项 11）。条件必须与拒绝逻辑**紧挨着**才算活的。
      // 真机上的行为断言在 browser-test（故意喂一个 div，页面内容必须原样留着）
      (() => {
        const uiSrc = read(path.join(PUB, 'js', 'ui.js'));
        const at = uiSrc.indexOf('setBusy 只能传按钮');
        if (at < 0) return false;
        return /if \(!\/\^\(BUTTON\|INPUT\|A\)\$\/\.test\(String\(btn\.tagName/.test(uiSrc.slice(Math.max(0, at - 400), at));
      })());
    ok('4.1 补字段与补幕次都把**按钮**传给了 setBusy（用 e.currentTarget，不是 container）',
      /fillFields\('timeline_when', e\.currentTarget\)/.test(novelMaxSrc)
      && /fillStages\(e\.currentTarget\)/.test(novelMaxSrc));
  }

  // 批 8 补 31：角色字段上限表的前后端镜像（角色的 appearance 会原文进每一次出图提示词）
  ok('4.1 前后端角色字段上限表同构（角色编辑框 maxlength 的唯一来源）',
    feTable(constsSrc, 'CHARACTER_FIELD_MAX') !== ''
    && beTable(storyModEarly.CHARACTER_FIELD_MAX) === feTable(constsSrc, 'CHARACTER_FIELD_MAX'),
    `后端 ${beTable(storyModEarly.CHARACTER_FIELD_MAX).slice(0, 50)} / 前端 ${feTable(constsSrc, 'CHARACTER_FIELD_MAX').slice(0, 50)}`);
  const chrSrc = read(path.join(PUB, 'js', 'pages', 'characters.js'));
  ok('4.1 角色编辑框按上限表设 maxlength（输入时就挡住，而不是保存后被悄悄砍掉）',
    (chrSrc.match(/maxlength="\$\{CHARACTER_FIELD_MAX\.\w+\}"/g) || []).length >= 8);
  ok('4.1 角色保存被截断时界面会说话（不静默少一截文字）',
    /r\.data\.truncated/.test(chrSrc) && /已截断/.test(chrSrc));
  // 结构棘轮：角色有 7 个写入点，绕过漏斗的那个就是"前面所有截断都只是看起来有"
  {
    const outside = routesSrc.split('\n').filter((ln) => /store\.(insert|update)\('characters'/.test(ln));
    ok('4.1 写角色只有漏斗一个出口（任何直写 store 都会绕过那把尺子）',
      outside.length === 2 && /clipCharacterPatch/.test(outside.join('\n')),
      `直写行数 ${outside.length}`);
    ok('4.1 角色的 7 个写入点都走 insertCharacter / updateCharacter',
      (routesSrc.match(/insertCharacter\(|updateCharacter\(/g) || []).length >= 9);
  }
  // 可编辑白名单必须是**推导**的：手抄的清单漏一个字段 = "界面上能填、保存后静默丢失"
  ok('4.1 可编辑白名单从 story.CARD_EDITABLE_FIELDS 推导（不再手抄一份字段清单）',
    /story\.CARD_EDITABLE_FIELDS/.test(routesSrc)
    && !/'personality', 'role', 'gender', 'age', 'atmosphere'/.test(routesSrc));
  ok('4.1 手改走同一把尺子（story.clipField）并如实上报被截断的字段',
    /story\.clipField\(patch\[k\], k\)/.test(routesSrc) && /truncated\.push\(k\)/.test(routesSrc));
  ok('4.1 写入时按可注入类别白名单过滤（绑了人物卡不该"显示已绑定却永不生效"）',
    /function injectableCardIds/.test(routesSrc) && /story_card_ids: injectableCardIds\(/.test(routesSrc)
    && /patch\.story_card_ids = injectableCardIds\(/.test(routesSrc));
  ok('4.2 分镜页把原著卡片注入算进计算态预览（顺序：内容 → 场景道具 → 角色）',
    sbSrc.includes('storyCardPhrase') && sbSrc.indexOf('storyCardPhrase(text, cards)') < sbSrc.indexOf('characterPhrase(withCards, chars)'));
  ok('4.2 分镜页有原著卡片选择器与绑定回传', /id="s-card-pick"/.test(sbSrc) && /story_card_ids: \[\.\.\.pickedCards\]/.test(sbSrc));
  ok('4.2 分镜页表格显示绑定的原著卡片（含失效提示）', /function cardBadges/.test(sbSrc) && /原著卡片失效/.test(sbSrc));
  ok('4.2 提示词单元格标出 +场景 层', /\+场景/.test(sbSrc));
  const keysOf = (src) => {
    const m = src.match(/ART_STYLE_MAP = \{([\s\S]*?)\n\};/);
    return m ? [...m[1].matchAll(/'([^']+)':/g)].map((x) => x[1]).sort().join(',') : '';
  };
  ok('4.1 前后端画风映射表同构', keysOf(routesSrc) !== '' && keysOf(routesSrc) === keysOf(constsSrc));
  // 批 8 补 39：补提示词那条链的 system 搬到服务端模板（前端不再自己拼提示词），
  // 所以"禁令在哪"跟着搬家 —— 断言也搬，别删（禁令本身还是必须有，只是只有一处）
  ok('4.1 LLM 链禁烘画风（拆镜在 storyboards，补提示词在服务端模板）',
    /不要写整体画风/.test(sbSrc)
    && /不要写整体画风或媒介词/.test(read(path.join(ROOT, 'lib', 'seed.js'))));
  ok('4.2 分镜提示词计算态预览', sbSrc.includes('artStylePhrase') && sbSrc.includes('+画风'));
  { // 1.6 防增量棘轮：字号地坪 11px 永不回退；裸 font-size 总量只减不增
    // 新页也必须进棘轮：否则"新加的页面"天然是裸字号与微字号的免检区
    const pageFiles = ['dashboard','projects','scripts','novel','storyboards','characters','images','videos','assets','tasks','settings']
      .map((n) => read(path.join(PUB, 'js', 'pages', n + '.js')));
    const all = pageFiles.join('');
    ok('1.6 字号地坪 ≥11px（JS 页）', !/font-size:(?:[1-9]|10(?:\.5)?)px/.test(all));
    const rawCount = (all.match(/font-size:[0-9.]+px/g) || []).length;
    ok(`1.6 裸字号棘轮 ≤44（现 ${rawCount}）`, rawCount <= 44);
  }
  ok('E7 批量找回+取消', sbSrc.includes("localStorage.setItem(BKEY") && sbSrc.includes('api.cancelBatch')
    && read(path.join(PUB, 'js', 'pages', 'helpers.js')).includes('data-cancel-batch'));
}
}

// ── 8. 用户系统已清除 ────────────────────────────────────────
group('用户系统残留检查');
{
  const files = [
    ...listJs(path.join(PUB, 'js')),
    ...listJs(path.join(PUB, 'js', 'pages')),
    path.join(PUB, 'index.html'),
    path.join(ROOT, 'server.js'),
    path.join(ROOT, 'lib', 'store.js'),
    path.join(ROOT, 'lib', 'routes.js'),
    path.join(ROOT, 'lib', 'agnes.js'),
    path.join(ROOT, 'lib', 'poller.js'),
  ];
  /**
   * 注释里解释「原版用 Supabase、为什么去掉」是有价值的，不该算残留。
   * 所以只检查真正的代码：先把行注释和块注释剥掉。
   */
  function stripComments(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  for (const f of files) {
    const src = stripComments(read(f));
    const rel = path.relative(ROOT, f);
    // 「关于」页里写着「去掉 Supabase」的产品说明，那是文案不是依赖，
    // 所以只认真正的 import / 客户端调用
    ok(`${rel} 没有 supabase 依赖`, !/@supabase|from\s*['"]supabase|require\(['"]supabase|supabase\.(from|auth|storage|functions)/i.test(src));
    ok(`${rel} 没有 user_id 字段`, !/\buser_id\b/.test(src));
    ok(`${rel} 没有登录态判断`, !/未登录|登录已过期|auth\.(getUser|signIn|signUp)/.test(src));
  }
  ok('不存在登录页面文件', !fs.existsSync(path.join(PUB, 'js', 'pages', 'login.js')));
  ok('不存在注册页面文件', !fs.existsSync(path.join(PUB, 'js', 'pages', 'register.js')));
}

// ── 顶层标识符冲突（E1 修复轮教训：与已导出的 softRefresh 重名 → ESM 语法错误整页白屏）──
group('顶层标识符');
{
  const files = [
    'public/js/app.js', 'public/js/api.js', 'public/js/ui.js', 'public/js/consts.js',
    ...fs.readdirSync(path.join(ROOT, 'public/js/pages')).filter((f) => f.endsWith('.js')).map((f) => `public/js/pages/${f}`),
  ];
  for (const rel of files) {
    const src = read(rel);
    if (!src) continue;
    const seen = new Map(); // name -> 出处描述
    const lines = src.split('\n');
    lines.forEach((ln, i) => {
      // 仅扫顶格声明/导入（本项目顶层语句不缩进；模板字符串内的行有缩进，不会误伤）
      const m = /^(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/.exec(ln)
        || /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=(:]/.exec(ln)
        || /^import\s+\{([^}]+)\}/.exec(ln) && null;
      if (m) {
        const name = m[1];
        if (seen.has(name)) { fail++; failures.push(`${rel}: 顶层标识符重复 "${name}"（${seen.get(name)} vs 第${i + 1}行）`); }
        else seen.set(name, `第${i + 1}行`);
      }
      const im = /^import\s+\{([^}]+)\}\s+from/.exec(ln);
      if (im) for (const b of im[1].split(',')) {
        const name = b.split(/\s+as\s+/).pop().trim();
        if (!name) continue;
        if (seen.has(name)) { fail++; failures.push(`${rel}: 导入名 "${name}" 与顶层声明冲突（${seen.get(name)} vs 第${i + 1}行）`); }
        else seen.set(name, `第${i + 1}行`);
      }
    });
    if (!failures.some((f) => f.startsWith(rel + ':'))) ok(`${rel} 顶层无重名`, true);
  }
}


console.log(`\n${'═'.repeat(52)}`);
// ── 测试选择器一致性（防 B40 类「死选择器」回归）─────────────
// B40 事故：browser-test 点 [data-sec="template"]，而源码分节 id 是 templates，
// 又用了可选链 ?. 静默跳过 → 断言从未执行，门禁却一直是绿的。
// 这里把「测试里写的选择器必须在源码中真实存在」变成门禁内的一条硬检查。
// 检查器自身也曾误报（首版 3 条全是假阳性）：①扫到自己注释里的示例文本
// ②#p-picker 是动态 id（页面传 {id:'p-picker'}，源码写 id="${id}"）。
// 教训：会喊狼来了的检查器比没有更糟——故此处剥注释 + 对动态值给出明确解析规则。
group('布局类名不得静默塌陷（id 有、class 漏）');
{
  // 事故：角色库页写 `<div id="grid">` 而漏了 `class="grid"` —— 元素全在、断言全绿、audit 零发现，
  // 但整页塌成一列 1120px 宽的巨大卡片。只查"元素存在"的检查永远抓不到这类问题。
  const files = listJs(path.join(PUB, 'js', 'pages'));
  const bad = [];
  let seen = 0;
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/id="grid"/g)) {
      const lt = src.lastIndexOf('<', m.index);
      const gt = src.indexOf('>', m.index);
      const tag = src.slice(lt, gt + 1);
      seen++;
      if (!/class="[^"]*\bgrid\b/.test(tag)) bad.push(`${path.basename(f)}: ${tag.slice(0, 70)}`);
    }
  }
  ok('确实扫到了 id="grid" 容器（自证非空跑）', seen > 0, `扫到 ${seen} 处`);
  ok('带 id="grid" 的容器必须同时带 class="grid"', bad.length === 0, bad.join(' | '));
}

group('ui-audit 采样选择器必须真实存在（防"死采样"）');
{
  // 事故：ui-audit 的对比度采样清单里 .note.muted / .muted / .seg-btn / .sub / .prompt-cell 五个
  // 选择器在源码里根本不存在 —— 那条采样从写下的那天起就是 0 个元素，报表照样全绿。
  // 「会喊狼来了的检查器比没有更糟」，但"什么都不量的检查器"同样更糟：这里把它变成硬检查。
  const css = read(path.join(PUB, 'css', 'app.css'));
  const html = read(path.join(PUB, 'index.html'));
  const js = [...listJs(path.join(PUB, 'js')), ...listJs(path.join(PUB, 'js', 'pages'))].map(read).join('\n');
  const known = new Set();
  for (const m of css.matchAll(/\.([A-Za-z][\w-]*)/g)) known.add(m[1]);
  // 只认 class="..." 里的整词，避免 "sub" 命中 submit 这类子串（首版检查器就栽在这）
  for (const m of (js + html).matchAll(/class="([^"$]*)"/g)) m[1].split(/\s+/).forEach((t) => t && known.add(t));
  const audit = read(path.join(ROOT, 'tools', 'ui-audit.mjs'));
  const m = audit.match(/for\(const q of \[([^\]]+)\]/);
  const sels = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
  ok('采样清单解析成功（自证解析器有效）', sels.length >= 15, `sels=${sels.length}`);
  const dead = [];
  for (const q of sels) {
    if (q === 'body' || /^[a-z]+$/.test(q)) continue;
    const first = q.split('>')[0].trim();
    const miss = [...first.matchAll(/\.([A-Za-z][\w-]*)/g)].map((x) => x[1]).filter((t) => !known.has(t));
    if (miss.length) dead.push(`${q}(缺 ${miss.join(',')})`);
  }
  ok('ui-audit 采样的每个 class 都真实存在（死采样会让报表假绿）', dead.length === 0, dead.join(' | '));
  ok('灵敏度对照：不存在的 class 会被检出', !known.has('definitely-not-a-class'));
}

group('批 7：计费安全与数据效率（R25–R30）');
{
  const routesSrc = read(path.join(ROOT, 'lib', 'routes.js'));
  const agnesSrc = read(path.join(ROOT, 'lib', 'agnes.js'));
  const helperSrc = read(path.join(PUB, 'js', 'pages', 'helpers.js'));
  const vidsSrc = read(path.join(PUB, 'js', 'pages', 'videos.js'));
  const sbsSrc = read(path.join(PUB, 'js', 'pages', 'storyboards.js'));
  const uiSrc = read(path.join(PUB, 'js', 'ui.js'));
  const projSrc = read(path.join(PUB, 'js', 'pages', 'projects.js'));
  const apiSrc = read(path.join(PUB, 'js', 'api.js'));
  const constsSrc = read(path.join(PUB, 'js', 'consts.js'));
  const tasksSrc = read(path.join(PUB, 'js', 'pages', 'tasks.js'));

  // ① R25 提交幂等
  ok('R25 服务端有幂等窗口常量与说明（不是魔法数字）',
    /const VIDEO_DEDUP_WINDOW_MS = 10 \* 60 \* 1000;/.test(routesSrc) && /幂等窗口/.test(routesSrc));
  ok('R25 幂等只对"可能已花钱"的记录生效（submit_failed 必须放行，否则失败会被永久锁死）',
    /a\.local_status !== 'submit_failed'/.test(routesSrc) && /client_token === clientToken/.test(routesSrc));
  ok('R25 去重命中直接返回既有 asset 且标 deduped（不向上游下单）',
    /timed_out: dup\.status === 'submit_timeout_unknown', deduped: true/.test(routesSrc));
  ok('R25 正常路径也带 deduped:false（形状对称，前端不用猜字段在不在）',
    (routesSrc.match(/deduped: false/g) || []).length >= 2);
  ok('R25 幂等键落库且长度截断（防超长键撑爆 JSON）',
    /client_token: clientToken \|\| null/.test(routesSrc) && /slice\(0, 80\)/.test(routesSrc));
  ok('R25 token 复用规则写成共享工具（单源，避免两处各写一份）',
    /export function makeTokenStore\(\)/.test(helperSrc) && /api\.clear = /.test(helperSrc));
  ok('R25 单条提交带幂等键，且成功后才作废（重试必须复用）',
    /payload\.client_token = tokenFor\('single', JSON\.stringify\(payload\)\)/.test(vidsSrc)
    && /tokenFor\.clear\('single'\)/.test(vidsSrc));
  ok('R25 批量视频每镜一个幂等键（scope = 镜头 id）',
    /body\.client_token = batchTokenFor\(s\.id, JSON\.stringify\(body\)\)/.test(sbsSrc)
    && /batchTokenFor\.clear\(it\.key\)/.test(sbsSrc));
  ok('R25 命中幂等时明确告知用户（复用而不是静默吞掉）',
    /已复用既有任务（未重复计费）/.test(vidsSrc));

  // ② R26 钳制回报 + 时长前置说明
  ok('R26 钳制结果被回报（不许静默夹参数）',
    /const clampReport = /.test(routesSrc) && /clamps, \/\/ R26/.test(routesSrc) && /clampReport\(reqFrames, usedFrames/.test(routesSrc));
  ok('R26 前端把"实际提交的秒数"写在时长输入框旁',
    /effectiveVideoSeconds/.test(sbsSrc) && /超出模型上限，实际提交/.test(sbsSrc) && /s-dur-hint/.test(sbsSrc));
  ok('R26 时长区间由 secondsToFrames 的边界反推（单源，不另写一份）',
    /export const VIDEO_DURATION_RANGE = \{ minSec: framesToSeconds\(81\), maxSec: framesToSeconds\(441\) \};/.test(constsSrc));
  ok('R26 批量提交前先列清时长偏差再计费（花了钱才发现被改写是最差的惊喜）',
    /const drifted = shots\.map/.test(sbsSrc) && /时长会被模型改写/.test(sbsSrc) && /按实际值继续/.test(sbsSrc));
  ok('R26 时长输入框有 min/max/step（浏览器层面就挡住越界输入）',
    /min="\$\{VIDEO_DURATION_RANGE\.minSec\.toFixed\(2\)\}"/.test(sbsSrc));

  // ③ R27 费用留痕
  ok('R27 费用提取是独立纯函数（可单测，不埋在轮询里）',
    /function extractCost\(result\)/.test(agnesSrc) && /module\.exports = \{[\s\S]*extractCost/.test(agnesSrc));
  ok('R27 费用随状态更新自动落库（轮询路径不用改）',
    /const updates = \{ raw_status_response: result, \.\.\.extractCost\(result\) \};/.test(agnesSrc));
  ok('R27 创建响应里的费用也落库', /\.\.\.agnes\.extractCost\(result\)/.test(routesSrc));
  ok('R27 失败路径写 null（不猜费用）', /cost_credits: null, cost_amount: null, cost_unit: null/.test(routesSrc));
  ok('R27 null ≠ 0：界面只在有值时显示数字',
    /if \(v\.cost_credits != null\)/.test(tasksSrc) && /if \(v\.cost_amount != null\)/.test(tasksSrc)
    && /消耗 \$\{esc\(v\.cost_credits\)\} 点/.test(tasksSrc));
  ok('R27 只扫顶层与 usage/data 两层（不递归整棵树，避免把无关数字当钱）',
    /\[result, result\.usage, result\.data\]/.test(agnesSrc));

  // ④ R28 错误出口
  ok('R28 errBox 有分类出口表（不再是只有"重试加载"一个出口）',
    /const ERR_OUTLETS = \{/.test(uiSrc) && /no_api_key: \{ label: '去设置填 API Key'/.test(uiSrc));
  ok('R28 no_api_key 引导到设置页 API 分节（重试一万次也还是没 Key）',
    /go: '#\/settings\?sec=api'/.test(uiSrc) && /errorOutlet/.test(uiSrc));
  ok('R28 未识别类型保持原样（不猜分类，只有重试）',
    /return ERR_OUTLETS\[errorType\] \|\| null;/.test(uiSrc));
  ok('R28 视频诊断面板也用同一张出口表（不另写一份）',
    /errorOutlet\(d\?\.errorType\)/.test(vidsSrc) && /showDiag\(\{ ok: false, errorType: r\.errorType \}, r\.error\)/.test(vidsSrc));
  ok('R28 各页把 errorType 传给 errBox（不传则出口表永远匹配不到）',
    (read(path.join(PUB, 'js', 'pages', 'tasks.js')) + read(path.join(PUB, 'js', 'pages', 'assets.js'))
      + read(path.join(PUB, 'js', 'pages', 'characters.js')) + read(path.join(PUB, 'js', 'pages', 'settings.js'))
    ).match(/errorType: \w+\.errorType/g).length >= 4);

  // ⑤ R29 服务端计数
  ok('R29 with_counts=1 服务端聚合（不带参数时形状不变）',
    /str\(query\.with_counts\) !== '1'/.test(routesSrc) && /counts: counts\[p\.id\] \|\| zero\(\)/.test(routesSrc));
  ok('R29 项目页优先用服务端计数，且保留退回三拉的兼容分支',
    /api\.projects\(\{ withCounts: true \}\)/.test(projSrc) && /countsFromServer/.test(projSrc)
    && /api\.storyboards\(\), api\.images\(\), api\.videos\(\)/.test(projSrc));
  ok('R29 api.projects 支持 withCounts 开关（默认路径逐字节不变）',
    /projects: \(opts = \{\}\) => req\('GET', opts\.withCounts \? '\/api\/projects\?with_counts=1' : '\/api\/projects'\)/.test(apiSrc));

  // ⑥ R30 变更须知纪律
  const need = [
    ['lib/routes.js', '去重只放行'],
    ['lib/routes.js', '不许改回静默'],
    ['lib/agnes.js', '上游没给（未知）'],
    ['lib/jobs.js', '按下标预填、原地改'],
    ['public/js/pages/helpers.js', '防重复计费'],
    ['public/js/ui.js', '只**补充**下一步动作'],
    ['public/js/pages/projects.js', '保留下面这条退回三拉的兼容分支'],
    ['public/js/consts.js', '量化并夹住时长'],
  ];
  const missing = need.filter(([f, kw]) => !read(path.join(ROOT, f)).includes(`变更须知`) || !read(path.join(ROOT, f)).includes(kw));
  ok('R30 高风险接缝都写了单行「变更须知」（改之前先看它）', missing.length === 0,
    missing.map(([f, kw]) => `${f}:${kw}`).join(' | ') || `${need.length} 处全部命中`);
  const total = ['lib/routes.js', 'lib/agnes.js', 'lib/jobs.js', 'public/js/api.js', 'public/js/consts.js',
    'public/js/ui.js', 'public/js/pages/helpers.js', 'public/js/pages/projects.js']
    .map((f) => (read(path.join(ROOT, f)).match(/\/\/ 变更须知/g) || []).length).reduce((a, b) => a + b, 0);
  ok('R30 变更须知数量下限（新增接缝时应同步增加）', total >= 8, String(total));
}

group('测试选择器一致性');
{
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const srcAll = [...walk(PUB), path.join(ROOT, 'lib', 'routes.js')].map(read).join('\n');
  // 剥注释：`//` 仅在非 `:` 之后才算注释，避免把 http:// 砍断
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const settingsSrc = read(path.join(PUB, 'js', 'pages', 'settings.js'));
  const secIds = [...settingsSrc.matchAll(/\{\s*id:\s*'([a-z_]+)'/g)].map((m) => m[1]);
  ok('SECTIONS 分节 id 解析成功（自证解析器有效）', secIds.length >= 5, `解析到 ${secIds.length} 个：${secIds.join(',')}`);
  ok('灵敏度对照：B40 的错值 template 确实不在 SECTIONS 中', !secIds.includes('template'), secIds.join(','));

  const testSrc = ['browser-test.mjs', 'uitest.mjs'].map((f) => strip(read(path.join(__dirname, f)))).join('\n');
  const secUsed = [...new Set([...testSrc.matchAll(/\[data-sec="([a-z_]+)"\]/g)].map((m) => m[1]))];
  ok('测试确实用到了 data-sec 选择器（自证非空跑）', secUsed.length > 0, secUsed.join(','));
  const secBad = secUsed.filter((x) => !secIds.includes(x));
  ok('测试用到的每个 [data-sec] 值都在源码 SECTIONS 中', secBad.length === 0, secBad.join(',') || `用到 ${secUsed.join(',')} 全部命中`);

  // 字面量属性选择器 [data-x="v"]（跳过模板字面量 ${...}）：源码里必须有同名属性值
  const pairs = [...new Set([...testSrc.matchAll(/\[data-([a-z0-9-]+)="([^"$\\]+)"\]/g)].map((m) => `${m[1]}|${m[2]}`))]
    .map((x) => x.split('|'));
  // 动态值也算命中：源码里写的是 data-prompt="${field}"，测试里只能写字面量值——
  // 这时要求"属性名存在且值来自模板"，而不是要求源码里出现同一个值（否则动态属性永远过不了）。
  const dead = pairs.filter(([a, v]) =>
    !srcAll.includes(`data-${a}="${v}"`) && !srcAll.includes(`data-${a}='${v}'`)
    && !srcAll.includes(`data-${a}="\${`) && !srcAll.includes(`data-${a}='\${`)
    && !(a === 'sec' && secIds.includes(v)));
  ok('测试中的字面量属性选择器均存在于源码', dead.length === 0,
    dead.map(([a, v]) => `[data-${a}="${v}"]`).join(',') || `${pairs.length} 个全部命中`);
  ok('灵敏度对照：源码里没有的属性名仍会被检出（动态值放行不等于放行一切）',
    !srcAll.includes('data-definitely-absent=') && !srcAll.includes('data-definitely-absent="\${'));

  // #id：静态 id="x" 或动态 id="${x}" 的实参字面量（如 projectPicker(..., {id:'p-picker'})）都算命中
  const ids = [...new Set([...testSrc.matchAll(/querySelector(?:All)?\(['"`]#([a-zA-Z0-9_-]+)/g)].map((m) => m[1]))];
  const idOk = (i) => srcAll.includes(`id="${i}"`) || srcAll.includes(`id='${i}'`)
    || srcAll.includes(`'${i}'`) || srcAll.includes(`"${i}"`);
  const deadIds = ids.filter((i) => !idOk(i));
  ok('测试中的 #id 选择器均存在于源码（含动态 id 实参）', deadIds.length === 0, deadIds.join(',') || `${ids.length} 个全部命中`);
}

// ── 复用一致性（防「已有工具被绕过」）──────────────────────
// B42：tasks.js 手工 /1024/1024 格式化字节（<1MB 谎报 0.0 MB），而 consts.js 就有 fmtBytes；
// images.js 手工建游离 <a> 触发下载，而 consts.js 就有 downloadUrl（append+remove）。
group('图像替代文本（源级守卫：覆盖条件渲染路径）');
{
  const files = ['public/index.html',
    ...fs.readdirSync(path.join(ROOT, 'public/js')).filter((f) => f.endsWith('.js')).map((f) => path.join('public/js', f)),
    ...fs.readdirSync(path.join(ROOT, 'public/js/pages')).filter((f) => f.endsWith('.js')).map((f) => path.join('public/js/pages', f))];
  const bad = [];
  let total = 0;
  for (const f of files) {
    const src = read(path.join(ROOT, f));
    for (const m of src.matchAll(/<img\b[^>]*>/g)) {
      total++;
      if (!/\balt=/.test(m[0])) bad.push(`${f}: ${m[0].slice(0, 60)}`);
    }
  }
  ok('所有 <img> 字面量都带 alt 属性', bad.length === 0, bad.join(' | '));
  ok('确实扫到了 <img> 字面量（自证非空跑）', total > 0, `img 数=${total}`);
  const probe = '<img src="x.png" />';
  ok('灵敏度对照：无 alt 的 <img> 会被规则判为不合格', !/\balt=/.test(probe));
}

group('复用一致性');
{
  const pages = listJs(path.join(PUB, 'js', 'pages'));
  const handBytes = pages.filter((f) => /\/\s*1024\s*\/\s*1024\s*\)\.toFixed/.test(read(f)));
  ok('页面不得手工换算字节（须走 fmtBytes）', handBytes.length === 0, handBytes.map((f) => path.basename(f)).join(','));
  const handDl = pages.filter((f) => /createElement\('a'\)/.test(read(f)));
  ok('页面不得手工建 <a> 下载（须走 downloadUrl，含 append+remove）', handDl.length === 0, handDl.map((f) => path.basename(f)).join(','));
  // 自证：两个被绕过的工具确实存在且导出
  const consts = read(path.join(PUB, 'js', 'consts.js'));
  ok('fmtBytes / downloadUrl 均仍导出（自证守卫有替代品可依）',
    /export function fmtBytes/.test(consts) && /export function downloadUrl/.test(consts));
  // 灵敏度对照：守卫的检测式确实能命中旧写法
  const probe = "toast.ok(`x（${(r.data.bytes / 1024 / 1024).toFixed(1)} MB）`)";
  ok('灵敏度对照：守卫检测式能命中旧手工写法', /\/\s*1024\s*\/\s*1024\s*\)\.toFixed/.test(probe));
}

// ── 批 1 守卫：付费确认 / 请求超时 / 弹窗 ARIA / 图片兜底 ──────
group('付费确认与请求健壮性（源级棘轮）');
{
  const ui = read(path.join(PUB, 'js', 'ui.js'));
  const apiSrc = read(path.join(PUB, 'js', 'api.js'));
  const constsSrc = read(path.join(PUB, 'js', 'consts.js'));
  const pageSrc = listJs(path.join(PUB, 'js', 'pages')).map((f) => ({ f: path.basename(f), s: read(f) }));

  // ① 付费确认：共享件存在、走 confirm 的 checkbox、带当天过期偏好
  ok('ui.js 导出 costConfirm', /export async function costConfirm/.test(ui));
  ok('costConfirm 复用 confirm 且带"不再提醒"勾选', /await confirm\(/.test(ui) && /checkbox:\s*\{/.test(ui));
  ok('"当天免提醒"走带过期的偏好（readUntil/rememberUntil），不是布尔',
    /readUntil\(COST_SKIP_KEY\)/.test(ui) && /rememberUntil\(COST_SKIP_KEY/.test(ui));
  ok('consts.js 提供 readUntil / rememberUntil / endOfToday',
    /export function readUntil/.test(constsSrc) && /export function rememberUntil/.test(constsSrc) && /export function endOfToday/.test(constsSrc));

  // ② 付费入口必须包一层确认（棘轮：入口数不得减少）
  const paidSites = pageSrc.filter((p) => /costConfirm\(/.test(p.s)).map((p) => p.f);
  ok('付费入口接入 costConfirm（≥3 个页面：分镜/视频/图片）', paidSites.length >= 3, paidSites.join(','));
  ok('分镜页 4 个付费入口全部接入（批量图/批量视频/单图/单视频）',
    (read(path.join(PUB, 'js', 'pages', 'storyboards.js')).match(/costConfirm\(/g) || []).length >= 4,
    String((read(path.join(PUB, 'js', 'pages', 'storyboards.js')).match(/costConfirm\(/g) || []).length));
  ok('页面不得绕过 confirm 直接提交（无自造 confirm 文案 "会产生真实费用" 的散装实现）',
    pageSrc.filter((p) => /会产生真实费用/.test(p.s)).length === 0);

  // ③ 前端请求超时：req 必须带 signal，且生成类必须显式放宽
  ok('api.js 的 req 使用 AbortSignal.timeout', /AbortSignal\.timeout\(/.test(apiSrc));
  ok('api.js 有超时分级常量表', /const TIMEOUT = \{/.test(apiSrc));
  ok('生成类接口显式放宽超时（genText/genImage/batchImages/batchVideos/createVideo）',
    ['genText', 'genImage', 'batchImages', 'batchVideos', 'createVideo']
      .every((m) => new RegExp(`${m}:.*timeoutMs: TIMEOUT\\.`).test(apiSrc)));
  ok('超时文案说明"任务可能仍在后台"（不谎报失败）',
    /client_timeout/.test(constsSrc) && /仍在|继续|稍后刷新页面确认结果/.test(constsSrc));

  // ④ 错误文案：只补充不替换（formatError 保留原文）
  ok('consts.js 提供 formatError 且保留后端原文', /export function formatError/.test(constsSrc) && /return hint \? `\$\{msg\}/.test(constsSrc));
  ok('api.js 失败分支走 formatError（不再裸传后端字符串）',
    (apiSrc.match(/formatError\(/g) || []).length >= 3, String((apiSrc.match(/formatError\(/g) || []).length));

  // ⑤ 弹窗 ARIA 三角
  ok('modal 带 role="dialog" + aria-modal + aria-labelledby',
    /role="dialog"/.test(ui) && /aria-modal="true"/.test(ui) && /aria-labelledby="\$\{titleId\}"/.test(ui));

  // ⑥ 图片兜底：不得再用 display:none 隐藏加载失败的图（会塌陷布局）
  const hiddenImg = pageSrc.filter((p) => /onerror="this\.style\.display/.test(p.s)).map((p) => p.f);
  ok('页面不得用 display:none 隐藏加载失败的图（须走 imgWithFallback）', hiddenImg.length === 0, hiddenImg.join(','));
  ok('ui.js 导出 imgWithFallback 且兜底块保留原 class',
    /export function imgWithFallback/.test(ui) && /img-fallback/.test(ui));
  // 灵敏度对照：守卫的检测式能命中旧写法
  ok('灵敏度对照：display:none 检测式能命中旧写法', /onerror="this\.style\.display/.test('<img onerror="this.style.display=\'none\'" />'));
}

group('空态指路（源级棘轮）');
{
  const files = listJs(path.join(PUB, 'js', 'pages'));
  // 空态只说"没有东西"而不给下一步 = 用户得自己找路。带 action 的调用点数只增不减。
  // 用括号配对切出每个 empty(...) 的实参文本，避免正则跨调用误判。
  const argsOf = (src, at) => {
    let depth = 0;
    for (let i = at; i < src.length; i++) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (!depth) return src.slice(at + 1, i); }
    }
    return '';
  };
  let total = 0; let withAction = 0;
  for (const f of files) {
    const src = read(f);
    for (let i = src.indexOf('empty('); i >= 0; i = src.indexOf('empty(', i + 1)) {
      total++;
      if (/label:/.test(argsOf(src, i + 5))) withAction++;
    }
  }
  ok('空态调用点已被扫描（自证非空跑）', total >= 10, `total=${total}`);
  // 不变量（非"≥ 某个数"的宽松阈值——那种阈值撤掉一处也照样通过，等于没钉）：
  // 本项目所有空态都必须给出下一步，故"带 action 的调用点数 == 总调用点数"。
  ok('所有空态都必须带一键 CTA（withAction === total）', withAction === total, `withAction=${withAction}/${total}`);
  ok('ui.js 的 empty() 支持两种 action 形态（go 链接 / act 按钮）',
    /action\.label/.test(read(path.join(PUB, 'js', 'ui.js'))) && /data-act=/.test(read(path.join(PUB, 'js', 'ui.js'))));
  // 灵敏度对照：把 action 去掉必须被判为"未指路"
  ok('灵敏度对照：无 action 的调用不会被算作已指路', !/label:/.test(argsOf("empty('a', 'b', 'folder')}", 5)));
}

group('批 2：加载态与视图状态还原（源级棘轮）');
{
  const ui = read(path.join(PUB, 'js', 'ui.js'));
  const css = read(path.join(PUB, 'css', 'app.css'));
  const apiSrc = read(path.join(PUB, 'js', 'api.js'));
  const pages = listJs(path.join(PUB, 'js', 'pages')).map((f) => ({ f: path.basename(f), s: read(f) }));
  const rd = (n) => read(path.join(PUB, 'js', 'pages', n));

  // R9 骨架屏
  ok('ui.js 导出 skeleton 且支持 4 种形态', /export function skeleton/.test(ui) && ['asset', 'card', 'row', 'form'].every((k) => ui.includes(`'${k}'`)));
  ok('骨架屏对 AT 有加载语义（role=status + aria-busy）', /role="status"/.test(ui) && /aria-busy="true"/.test(ui));
  ok('app.css 定义骨架样式与微光动画', /\.sk-box/.test(css) && /@keyframes sk-shimmer/.test(css));
  // 首屏列表/网格不得再用整片 spinner：spinner 只留给"操作进行中"这类局部反馈
  const firstLoadSpinner = pages.filter((p) => /\$\{spinner\('加载/.test(p.s)).map((p) => p.f);
  ok('首屏加载态不得再用 spinner（须走形状匹配的 skeleton）', firstLoadSpinner.length === 0, firstLoadSpinner.join(','));
  const skCount = pages.reduce((n, p) => n + (p.s.match(/\$\{skeleton\(/g) || []).length, 0);
  ok('首屏骨架屏调用点 ≥ 8（只增不减）', skCount >= 8, `skeleton=${skCount}`);
  ok('灵敏度对照：旧写法会被首屏 spinner 守卫命中', /\$\{spinner\('加载/.test("<div id=\"list\">${spinner('加载项目…')}</div>"));

  // R11 派生视图状态进 URL（刷新/分享可还原）
  ok('assets 收藏筛选进 URL（且 URL 优先于本地记忆）', /syncViewParams\(\{ tab, fav/.test(rd('assets.js')) && /params\.fav/.test(rd('assets.js')));
  ok('tasks 搜索词进 URL（且回填输入框）', /q: search/.test(rd('tasks.js')) && /value="\$\{esc\(search\)\}"/.test(rd('tasks.js')));
  ok('images 生成模式进 URL（且首屏按 URL 还原）', /syncViewParams\(\{ mode \}\)/.test(rd('images.js')) && /params\.mode === 'i2i'/.test(rd('images.js')));

  // R10 失败追踪码
  ok('api.js 把追踪码拼进错误文案', /function withTrace/.test(apiSrc) && /报错码/.test(apiSrc));
  ok('errBox 接受 trace 并指向「运行日志」', /trace = ''/.test(ui) && /运行日志/.test(ui));
  const errBoxSites = pages.filter((p) => /errBox\(/.test(p.s));
  // 括号配对切实参：`errBox(f(\`${a || b}\`), undefined, x.trace)` 这类嵌套用正则会误判
  const argsAt = (src, at) => {
    let depth = 0;
    for (let i = at; i < src.length; i++) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (!depth) return src.slice(at + 1, i); }
    }
    return '';
  };
  let errBoxAll = 0; let errBoxWithTrace = 0;
  for (const p of errBoxSites) {
    for (let i = p.s.indexOf('errBox('); i >= 0; i = p.s.indexOf('errBox(', i + 1)) {
      errBoxAll++;
      if (/\btrace\b/.test(argsAt(p.s, i + 6))) errBoxWithTrace++;
    }
  }
  // 不变量：每个 errBox 调用点都必须透传 trace（漏一个，那个页面就永远看不到报错码）
  ok('errBox 调用点全部透传 trace（含自证非空跑）', errBoxAll > 0 && errBoxWithTrace === errBoxAll, `${errBoxWithTrace}/${errBoxAll}`);
  ok('灵敏度对照：不透传 trace 的调用会被检出', !/\btrace\b/.test(argsAt('errBox(`x`)', 6)));
}

group('共享符号使用必须先导入（防白屏）');
{
  // 事故背景（本轮真实踩到）：scripts.js 用了 ${skeleton(...)} 却没加进 import 列表
  // → ReferenceError → 整页挂载失败（白屏），而原有守卫只检查"导入的符号是否存在"，
  // 不检查"用到的符号是否导入"，于是静态检查全绿、只有真机矩阵才抓到。
  // 这里反向补上：调用共享导出函数却没导入 = 必然白屏。
  const shared = [];
  for (const f of ['ui.js', 'consts.js']) {
    const src = read(path.join(PUB, 'js', f));
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let)\s+([A-Za-z_$][\w$]*)/g)) shared.push({ name: m[1], from: `../${f}` });
  }
  const bad = [];
  for (const file of listJs(path.join(PUB, 'js', 'pages'))) {
    const src = read(file);
    // 该文件从 ui.js / consts.js 导入的名字
    const imported = new Set();
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/(?:ui|consts)\.js'/g)) {
      m[1].split(',').forEach((x) => { const n = x.split(/\s+as\s+/).pop().trim(); if (n) imported.add(n); });
    }
    // 先去掉注释再判：注释里写一句"on() 是逐个绑定"就会把这条钉子骗红（本轮真踩到）。
    // 剥注释要**保守**：`//` 前不能是 `:`，否则 `http://…` 里的斜杠会被当成注释起点
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const { name, from } of shared) {
      if (imported.has(name)) continue;
      // 只判"函数调用"形态，且排除属性访问（foo.skeleton()）与 import 语句自身
      const re = new RegExp(`(?<![.\\w$])${name}\\s*\\(`);
      if (re.test(code)) bad.push(`${path.basename(file)} 用了 ${name}() 但未从 ${from} 导入`);
    }
  }
  ok('页面调用共享函数前必须导入（否则整页白屏）', bad.length === 0, bad.join(' | '));
  ok('共享导出清单已解析（自证非空跑）', shared.length >= 30, `shared=${shared.length}`);
  ok('灵敏度对照：未导入的调用会被检出', /(?<![.\w$])skeleton\s*\(/.test('el.innerHTML = `${skeleton(1)}`'));
}

group('批 4：剧本链路（R16 带入下一步 / R17 就地编辑 / R18 计数）');
{
  // 纯函数直接动态 import 进来测边界——只做源级棘轮的话，"5999/6000/6001 到底算不算超限"
  // 这种最容易写错一格的逻辑只能靠真机间接覆盖。
  // public/js/*.js 是浏览器 ESM 而 package.json 没有 type 字段，Node 会打 MODULE_TYPELESS 警告；
  // 去掉 warning 监听即可（本脚本不依赖 warning）。
  process.removeAllListeners('warning');
  const ts = await import(pathToFileURL(path.join(PUB, 'js', 'textstats.js')).href);
  eq('按码点计数：中文 1 字算 1', ts.charCount('你好世界'), 4);
  eq('按码点计数：emoji 算 1 个字（不是 UTF-16 的 2）', ts.charCount('😀'), 1);
  eq('计数含换行与空格（用户看到多少就是多少）', ts.charCount('a\nb c'), 5);
  eq('空值/undefined 安全', ts.charCount(undefined), 0);
  eq('千分位展示', ts.countLabel(1234567), '1,234,567 字');
  eq('软上限边界：恰好 6000 不算超', ts.limitState(6000).over, false);
  eq('软上限边界：6001 才算超（差一格都要测）', ts.limitState(6001).over, true);
  eq('超限文案带出具体字数与上限', ts.limitState(7000).text.includes('7,000 字') && ts.limitState(7000).text.includes('6,000 字'), true);
  // 覆盖真实种子模板里的长文本字段名（故事想法/本集大纲/剧情梗概/脚本内容 都必须是多行输入框）
  ok('长文本判定覆盖真实模板字段（故事想法/本集大纲/剧情梗概/脚本内容）',
    ['故事想法', '本集大纲', '剧情梗概', '脚本内容', '小说原文'].every((x) => ts.isLongVar(x))
    && !['标题', '风格要求', '目标集数', '单集时长', '题材'].some((x) => ts.isLongVar(x)));
  eq('提示词总长 = 各条消息 content 之和', ts.promptLength([{ content: 'abc' }, { content: 'de' }]), 5);

  // R16 门禁判据
  const v = ts.checkPromptVars(['单集脚本', '标题'], { 单集脚本: '  ', 标题: 'x' });
  eq('长文本空白 → 判定为"缺素材"（空格不算填了）', v.blocked, true);
  eq('长文本空白时列出的就是它', v.emptyLong.join(','), '单集脚本');
  eq('短变量空着不算拦住', ts.checkPromptVars(['标题'], {}).blocked, false);
  eq('超软上限的字段被点名并带字数',
    ts.checkPromptVars(['单集脚本'], { 单集脚本: '字'.repeat(6001) }).over[0].chars, 6001);
  const gb = ts.promptGate({ emptyLong: ['单集脚本'] });
  eq('缺素材 → blocked（不是"确认后继续"）', gb.kind, 'blocked');
  eq('缺素材的文案给出去哪找素材（带入下一步）', /带入下一步/.test(gb.lines.join('')), true);
  const gc = ts.promptGate({ emptyShort: ['标题'], total: 13000 });
  eq('只是缺短变量/超长 → confirm（可继续）', gc.kind, 'confirm');
  ok('确认文案列出具体字段与字数', /标题/.test(gc.lines.join('')) && /13,000 字/.test(gc.lines.join('')));
  eq('一切正常 → 不打扰用户（null）', ts.promptGate({ total: 100 }), null);

  // 源级棘轮
  const sc = read(path.join(PUB, 'js', 'pages', 'scripts.js'));
  const sbs = read(path.join(PUB, 'js', 'pages', 'storyboards.js'));
  const consts = read(path.join(PUB, 'js', 'consts.js'));
  ok('链路步骤顺序是显式单一事实来源（5 步，首尾固定）',
    /export const SCRIPT_STEPS = \['story_concept', 'plot_summary', 'episode_outline', 'episode_script', 'storyboard_script'\]/.test(consts)
    && /export function nextScriptStep/.test(consts));
  ok('R17 结果区可编辑（textarea 绑 result，不是只读 pre）',
    /id="r-edit-box"/.test(sc) && /result = box\.value/.test(sc) && /id="r-undo"/.test(sc));
  ok('R17 编辑落在唯一事实来源上（复制/保存/导入都读 result）',
    /copyText\(result\)/.test(sc) && /content: result/.test(sc));
  ok('R17 格式化视图保持只读（就地改格式化 JSON 极易改坏结构）',
    /<pre class="json-out" id="r-out"/.test(sc) && /JSON\.stringify\(p2, null, 2\)/.test(sc));
  ok('R16 带入下一步写明目标步骤名（用户知道去哪）',
    /带入下一步：\$\{esc\(nextLabel\)\}/.test(sc) && /function carryToNext/.test(sc));
  ok('R16 带入只写长文本变量（不把 2000 字塞进单行输入框）',
    /varsOf\(tpl\)\.find\(isLongVar\)/.test(sc));
  ok('R16 带入可见可撤销（提示条 + 撤销带入 + 字段高亮）',
    /upstream-strip/.test(sc) && /撤销带入/.test(sc) && /carried/.test(sc) && /textarea\.carried/.test(read(path.join(PUB, 'css', 'app.css'))));
  ok('R16 生成前门禁接在 generate 开头（不是生成后才提示）',
    /if \(!\(await gateBeforeGenerate\(tpl\)\)\) return;/.test(sc));
  ok('R16 缺素材走单按钮告知（notice），有选项才用 confirm',
    /kind === 'blocked'/.test(sc) && /await notice\(/.test(sc));
  ok('R16 门禁文案对模板变量名做 esc（模板可编辑，属用户数据）', /g\.lines\.map\(\(x\) => esc\(x\)\)/.test(sc));
  ok('R18 逐字段计数 + 整条提示词计数都在界面上',
    /data-count="\$\{esc\(v\)\}"/.test(sc) && /本次提示词合计/.test(sc));
  ok('R18 计数与发送共用同一份请求体（避免两套算法）', /function buildMessages/.test(sc) && /messages,/.test(sc));
  ok('R18 分镜页粘贴框也有计数与软上限确认',
    /id="script-in-stat"/.test(sbs) && /st\.over && !\(await confirm\(/.test(sbs));
  ok('R18 超限不静默截断（全项目不得出现对用户输入的 slice 截断）',
    !/\.value\.slice\(0,/.test(sc) && !/\.value\.slice\(0,/.test(sbs));
  ok('R17 每个页签各自保留产物（切页签不再丢中间产物）',
    /const results = new Map\(\)/.test(sc) && /function stashResult/.test(sc) && /function loadResultFor/.test(sc));
}

group('批 5：提示词资产化（R19 运镜字典 / R20 平台画幅 / R21 变体池）');
{
  const sbs = read(path.join(PUB, 'js', 'pages', 'storyboards.js'));
  const projSrc = read(path.join(PUB, 'js', 'pages', 'projects.js'));
  const imgSrc = read(path.join(PUB, 'js', 'pages', 'images.js'));
  const routesSrc = read(path.join(ROOT, 'lib', 'routes.js'));

  // ① R19 运镜字典本身：数量、分组、唯一性、双语完整
  const cm = await import(pathToFileURL(path.join(PUB, 'js', 'consts.js')).href);
  ok('R19 运镜字典 38 条 8 组（数量是承诺，缩水即回归）',
    cm.CAMERA_MOVES.length === 38 && cm.CAMERA_MOVE_GROUPS.length === 8);
  ok('R19 每条都有中文标签与英文短语（缺一个就会拼出半截提示词）',
    cm.CAMERA_MOVES.every((m) => m.zh && m.en && /^[a-z]/.test(m.en)));
  ok('R19 中文标签唯一（重复标签会让选择器选错项）',
    new Set(cm.CAMERA_MOVES.map((m) => m.zh)).size === cm.CAMERA_MOVES.length);
  ok('R19 分组不丢条（分组是视图，不是第二份数据）',
    cm.CAMERA_MOVE_GROUPS.reduce((n, g) => n + g.items.length, 0) === cm.CAMERA_MOVES.length);
  ok('R19 未知标签返回空串（绝不把中文标签喂给模型）',
    cm.cameraMovePhrase('瞎写一个') === '' && cm.cameraMovePhrase('') === '');
  // 静帧 vs 视频：运动类运镜对静态图无意义，必须只在视频侧注入
  ok('R19 静帧只放行机位/视角类运镜（甩镜/延时/一镜到底对静态图无意义）',
    cm.cameraMovePhrase('俯视', true) !== '' && cm.cameraMovePhrase('甩镜', true) === ''
    && cm.cameraMovePhrase('甩镜', false) !== '' && cm.cameraMoveAffectsStill('俯视') && !cm.cameraMoveAffectsStill('甩镜'));

  // ② 前后端镜像同构（这是"预览"与"实际发出"一致的唯一保证）
  const pairsFromConsts = cm.CAMERA_MOVES.map((m) => `${m.zh}=${m.en}`).sort().join('\n');
  const routesPairs = (() => {
    const m = routesSrc.match(/CAMERA_MOVE_MAP = \{([\s\S]*?)\n\};/);
    return m ? [...m[1].matchAll(/'([^']+)':\s*'([^']*)'/g)].map((x) => `${x[1]}=${x[2]}`).sort().join('\n') : '';
  })();
  ok('R19 前后端运镜表逐对同构（38 条全等，不是"数量相等"）',
    routesPairs !== '' && routesPairs === pairsFromConsts);
  const stillFromConsts = cm.CAMERA_MOVES.filter((m) => m.still).map((m) => m.zh).sort().join(',');
  const stillFromRoutes = (() => {
    const m = routesSrc.match(/CAMERA_MOVE_STILL_OK = new Set\(\[([\s\S]*?)\]\)/);
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort().join(',') : '';
  })();
  ok('R19 前后端"静帧可用"集合同构（少一条就会出现"图片里冒出甩镜"）',
    stillFromConsts !== '' && stillFromConsts === stillFromRoutes);
  ok('R19 后端运镜镜像带静帧闸门（图片侧不注入运动类运镜）',
    /function cameraMovePhrase\(zh, forStill = false\)/.test(routesSrc)
    && /cameraForStill: true/.test(routesSrc));

  // ③ 后端接线：分镜字段白名单 + 两处使用点 + 导出列
  ok('R19 分镜 PUT 白名单放行 camera_move 且字典外落空',
    /if \('camera_move' in body\)/.test(routesSrc) && /patch\.camera_move = cameraMovePhrase\(cm\) \? cm : ''/.test(routesSrc));
  ok('R19 视频侧运镜对所有模式注入（参考图带不了运动）',
    /const cam = str\(body\.camera_move\)\.trim\(\)/.test(routesSrc) && /cameraMove: cam/.test(routesSrc));
  ok('R19 导出含运镜列与运镜口径说明',
    /'景别', '运镜'/.test(routesSrc) && /含原著场景道具、出场角色、运镜与画风/.test(routesSrc));

  // ④ 前端接线：编辑弹窗 + 行徽标 + 预览标签
  ok('R19 编辑弹窗有运镜选择器与分组（optgroup 走原生键盘可达）',
    /id="s-cam"/.test(sbs) && /<optgroup label=/.test(sbs) && /CAMERA_MOVE_GROUPS\.map/.test(sbs));
  ok('R19 选中运镜当场显示会注入的英文（不显示等于让用户猜）',
    /id="s-cam-hint"/.test(sbs) && /const syncCamHint = /.test(sbs) && /仅视频追加/.test(sbs));
  ok('R19 分镜行显示运镜徽标且标明仅视频生效',
    /cam-badge/.test(sbs) && /cameraMoveAffectsStill\(s\.camera_move\)/.test(sbs));
  ok('R19 提示词预览按列区分口径（图片列静帧口径 / 视频列全量）',
    /cameraMovePhrase\(s\.camera_move, field === 'image_prompt'\)/.test(sbs) && /\+运镜/.test(sbs));
  ok('R19 运镜 chips 与运镜字典同源（同一件事不得有两套英文）',
    cm.PRESET_TERMS[0].items.every((i) => cm.CAMERA_MOVES.some((m) => m.en === i.en)));

  // ⑤ R20 平台 → 画幅
  ok('R20 平台表带画幅推荐且抖音=9:16 竖屏',
    cm.PLATFORMS.length === 9 && cm.aspectForPlatform('抖音') === '9:16 竖屏'
    && cm.aspectForPlatform('小红书') === '3:4 竖版' && cm.aspectForPlatform('B站') === '16:9 横屏');
  ok('R20 不预设画幅的平台返回 null（自定义/横版视频不硬塞）',
    cm.aspectForPlatform('自定义') === null && cm.aspectForPlatform('不存在') === null);
  ok('R20 平台值保持旧字符串（存量项目的 target_platform 不失效）',
    cm.PLATFORMS.every((p) => typeof p.value === 'string' && p.value === p.label || p.value === '横版视频'));
  ok('R20 只有用户主动改平台才改画幅（不覆盖手动选择）',
    /platSel\.onchange = \(\) => syncRatioHint\(true\)/.test(projSrc) && /syncRatioHint\(false\)/.test(projSrc)
    && /已按「\$\{platSel\.value\}」把画幅设为/.test(projSrc));

  // ⑥ R21 变体池
  ok('R21 变体池 8 条且首次（n<=0）不注入',
    cm.VARIATION_POOL.length === 8 && cm.variationPhrase(0) === '' && cm.variationPhrase(-1) === ''
    && cm.variationPhrase(1) === cm.VARIATION_POOL[0]);
  ok('R21 取模轮换（第 9 次回到第 1 条，不会越界成 undefined）',
    cm.variationPhrase(9) === cm.VARIATION_POOL[0] && cm.variationPhrase(8) === cm.VARIATION_POOL[7]);
  const vpFromRoutes = (() => {
    const m = routesSrc.match(/VARIATION_POOL = \[([\s\S]*?)\n\];/);
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).join('|') : '';
  })();
  ok('R21 前后端变体池逐条同构', vpFromRoutes !== '' && vpFromRoutes === cm.VARIATION_POOL.join('|'));
  ok('R21 分镜页与图片页都会在"再来一张"时轮换变体',
    /variationSeen\.get\(s\.id\)/.test(sbs) && /variation: seen/.test(sbs)
    && /variation: prompt === lastPrompt \? lastVariation \+ 1 : 0/.test(imgSrc));
  ok('R21 变体只改"机位/时段/构图"（不得改动叙事内容）',
    cm.VARIATION_POOL.every((v) => !/character|costume|story|plot/.test(v)));
}

group('批 6：分镜工作台体验（R22 产出三状态点 / R23 提示词就地编辑 / R24 视觉细节）');
{
  const sbs = read(path.join(PUB, 'js', 'pages', 'storyboards.js'));
  const helperSrc = read(path.join(PUB, 'js', 'pages', 'helpers.js'));
  const jobsSrc = read(path.join(ROOT, 'lib', 'jobs.js'));
  const css = read(path.join(PUB, 'css', 'app.css'));
  const auditSrc = read(path.join(ROOT, 'tools', 'ui-audit.mjs'));

  // ① R22 后端：逐项状态必须"按下标预填、原地改"，否则并发下进度链会错位
  ok('R22 任务项按下标预填（并发下 push 顺序 ≠ 镜头顺序）',
    /job\.items = items\.map\(\(it, i\) => \(\{/.test(jobsSrc) && /index: i,/.test(jobsSrc));
  ok('R22 任务项有 pending/running/ok/fail 四态（只有完成态就看不出"哪条在跑"）',
    /state: 'pending'/.test(jobsSrc) && /rec\.state = 'running'/.test(jobsSrc)
    && /rec\.state = 'ok'/.test(jobsSrc) && /rec\.state = 'fail'/.test(jobsSrc));
  ok('R22 key 原样回传（界面据此把状态映射回具体那一行，刷新后依然成立）',
    /key: \(it && typeof it === 'object' && it\.key != null\) \? String\(it\.key\) : null/.test(jobsSrc));
  ok('R22 取消时未轮到的项标成 cancelled（否则界面永远显示一排"待处理"，像卡住了）',
    /rec\.state === 'pending' \|\| rec\.state === 'running'\) rec\.state = 'cancelled'/.test(jobsSrc));

  // ② R22 前端：产出列 + 状态链
  ok('R22 分镜表新增「产出」列（提示词/图片/视频三道关）',
    /<th style="width:64px" title="提示词 \/ 分镜图 \/ 视频 三道关的状态">产出<\/th>/.test(sbs) && /function outputCell/.test(sbs));
  ok('R22 三个点各自带文字化的状态（不靠颜色单一维度）',
    /function dot\(state, title\)/.test(sbs) && /role="img" aria-label=/.test(sbs)
    && /dot\(promptState, promptTitle\)/.test(sbs) && /dot\(imgState, '分镜图'\)/.test(sbs) && /dot\(vidState, '视频'\)/.test(sbs));
  ok('R22 图片点吃批量任务的在跑/失败态（不只吃持久字段）',
    /jobState === 'running' \? 'running'/.test(sbs) && /jobState === 'fail' \? 'fail'/.test(sbs) && /rowInflight\.has\(s\.id\)/.test(sbs));
  ok('R22 任务进行中也要重绘表格（只在结束时重绘 → "正在跑"永远看不到）',
    /if \(rows\.length && \(prev\.size \|\| jobRowState\.size\)\) renderTable\(\)/.test(sbs));
  ok('R22 状态链上限 60 项（再多会挤成一片糊，百分比条足够）',
    /items\.length <= 60/.test(helperSrc) && /class="chain"/.test(helperSrc) && /chain-dot/.test(helperSrc));
  ok('R22 状态链每项 hover 出镜头号与失败原因',
    /it\.label \|\| `第 \$\{it\.index \+ 1\} 项`/.test(helperSrc) && /it\.error \? `——\$\{esc\(it\.error\)\}`/.test(helperSrc));
  ok('R22 批量项带上 label 与 key（刷新后进度链仍对得上镜头号）',
    (sbs.match(/label: `镜头 #\$\{s\.shot_number\}`/g) || []).length >= 2 && (sbs.match(/key: s\.id/g) || []).length >= 2);

  // ③ R23 就地编辑
  ok('R23 提示词列可点击就地编辑（不必开 15 字段弹窗）',
    /data-inline="\$\{esc\(s\.id\)\}"/.test(sbs) && /function inlineEdit/.test(sbs) && /ta\.className = 'textarea mono inline-edit'/.test(sbs));
  ok('R23 空提示词也给入口（"待生成"不再是死文本）',
    /待生成（点此填写）/.test(sbs));
  ok('R23 保存后不整表 load()（会冲掉其它行的编辑态与选中态，还有竞态）',
    /row\[field\] = val; \/\/ 只改这一项/.test(sbs) && !/api\.updateStoryboard\(id, \{ \[field\]: val \}\)[\s\S]{0,120}load\(\)/.test(sbs));
  ok('R23 值没变不发请求（点一下再点别处不该写盘）',
    /if \(val === before\) \{ restore\(before\); return; \}/.test(sbs));
  ok('R23 Esc 取消 / Cmd+Enter 立即保存（长文本编辑必须有"不改了"的出口）',
    /e\.key === 'Escape'/.test(sbs) && /e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\)/.test(sbs));

  // ④ R24 视觉细节
  ok('R24 焦点环是双层（内层底色隔开 + 外层金色），单层半透明在浅色/金色底上会糊',
    /--focus-ring: 0 0 0 2px var\(--bg\), 0 0 0 4px rgba\(245, 213, 138, 0\.75\)/.test(css));
  ok('R24 焦点环只有一处定义（两份并存 = 改一处不生效）',
    (css.match(/box-shadow: var\(--focus-ring\)/g) || []).length === 1
    && !css.includes('outline: 2px solid rgba(245, 213, 138, 0.6)'));
  ok('R24 保留 outline 兜底（高对比模式下 box-shadow 常被忽略）',
    /outline: 1px solid rgba\(245, 213, 138, 0\.72\)/.test(css));
  ok('R24 长列表 content-visibility 节流 + 接近真实高度的 contain-intrinsic-size',
    /\.content-auto \{ content-visibility: auto; contain-intrinsic-size: auto 240px; \}/.test(css)
    && /contain-intrinsic-size: auto 72px/.test(css));
  ok('R24 节流已挂到素材卡与任务行（有类没挂 = 白写）',
    /class="asset-card content-auto"/.test(read(path.join(PUB, 'js', 'pages', 'assets.js')))
    && /class="task-row content-auto"/.test(read(path.join(PUB, 'js', 'pages', 'tasks.js'))));
  ok('R24 中英混排基线校正（等宽英文数字夹在中文里不再"掉下去"）',
    /\.cjk-latin \{ font-size-adjust: 0\.56; vertical-align: -0\.15em; \}/.test(css)
    && /class="mono-sm cjk-latin"/.test(read(path.join(PUB, 'js', 'pages', 'videos.js'))));
  ok('R22/R23 新组件有样式（.dot / .chain-dot / .inline-target / .link-btn）',
    /\.dot \{/.test(css) && /\.dot\.running/.test(css) && /\.chain-dot\.fail/.test(css)
    && /\.inline-target/.test(css) && /\.link-btn/.test(css));

  // ⑤ R24 ui-audit 弹窗钩子（B56 记下的覆盖缺口）
  ok('R24 审计页清单带弹窗动作钩子（弹窗此前是度量盲区）',
    /const pages = \[/.test(auditSrc) && /\['projects', '#\/projects', `document\.querySelector\('#new-project'\)\?\.click\(\);`\]/.test(auditSrc)
    && /\['storyboards', `#\/storyboards\?project=\$\{pid\}`, `document\.querySelector\('\[data-edit\]'\)\?\.click\(\);`\]/.test(auditSrc));
  ok('R24 弹窗动作钩子有自检（声明了动作却没开出弹窗 → 报成发现，钩子不会静默烂掉）',
    /弹窗未打开 \$\{w\}px \$\{name\}: 动作钩子声明了弹窗但没出现/.test(auditSrc));
  ok('R24 审计单独检查弹窗自身的横向溢出（弹窗内部滚动，页面级 overflow 抓不到）',
    /弹窗溢出 \$\{w\}px \$\{name\}/.test(auditSrc) && /弹窗越界/.test(auditSrc));
  ok('R24 审计种子补了素材与视频（空态下卡片样式根本没被量到）',
    /audit_img_1/.test(auditSrc) && /audit_vid_1/.test(auditSrc) && /image_assets: \[\{/.test(auditSrc));
}

group('角色库（R14：档案 + 绑定 + 引用守卫）');
{
  const chars = read(path.join(PUB, 'js', 'pages', 'characters.js'));
  const app = read(path.join(PUB, 'js', 'app.js'));
  const apiSrc = read(path.join(PUB, 'js', 'api.js'));
  const sbs = read(path.join(PUB, 'js', 'pages', 'storyboards.js'));
  const consts = read(path.join(PUB, 'js', 'consts.js'));

  ok('导航注册了角色库页（图标存在，否则静默退化成 info 图标）',
    /id: 'characters', label: '角色库', icon: 'users'/.test(app) && /users: '<path/.test(consts));
  ok('角色库页面模块默认导出函数', /export default async function characters/.test(chars));
  ok('api.js 暴露角色 CRUD 四个端点',
    ['characters:', 'createCharacter:', 'updateCharacter:', 'deleteCharacter:'].every((k) => apiSrc.includes(k)));
  ok('角色定位枚举存在（且非空）', /export const CHARACTER_ROLES = \['主角'/.test(consts));

  // 外貌与服装必须独立成字段：注入时要能只取这两段，把性格/小传留在档案里
  ok('外貌/服装是独立字段（不是塞进自由文本备注）',
    /id="c-appear"/.test(chars) && /id="c-outfit"/.test(chars) && /appearance: root.querySelector\('#c-appear'\)/.test(chars));
  // 参考图必须来自本项目素材，不能让用户填公网 URL（本地优先下外链抓不到）
  ok('参考图从本项目图片里挑（不要求填 URL）',
    /api\.images\(projectId\)/.test(chars) && /reference_image_ids/.test(chars) && !/placeholder="https?:\/\//.test(chars));
  ok('参考图上限与后端一致（12 张）', /idList\(b\.reference_image_ids, 12\)/.test(read(path.join(ROOT, 'lib', 'routes.js'))));
  // 搜索走 URL（与 tasks 同款），刷新/分享可还原
  ok('角色库搜索词进 URL', /syncViewParams\(\{ project: projectId, q: search \}\)/.test(chars));
  ok('角色库空态带一键出口（两种空态各有一个）',
    /empty\('这个项目还没有角色'/.test(chars) && /act: 'new'/.test(chars) && /go: '#\/projects'/.test(chars));
  ok('删除走就地两段确认（删除有引用后果，不该一键完成）', /twoClick\(b, async \(\) => \{/.test(chars));

  // 分镜侧绑定
  ok('分镜编辑弹窗提供角色多选芯片', /id="s-char-pick"/.test(sbs) && /data-char=/.test(sbs));
  ok('分镜保存提交 character_ids', /character_ids: \[\.\.\.pickedChars\]/.test(sbs));
  ok('分镜行展示绑定角色与失效引用（悬空 id 要看得见）',
    /function charCell\(/.test(sbs) && /绑定的角色已被删除/.test(sbs));
  ok('分镜行保留自由文本人物（老数据不丢信息）', /s\.characters/.test(sbs) && /人物（自由文本）/.test(sbs));
  // R15：计算态预览必须与后端注入同源。用 bootstrap 快照会在"别处新建了角色"时显示过期结果
  // （预览说没注入、后端实际注入了 = 骗人），故进页面时对齐一次角色档案。
  ok('分镜页进页面即对齐角色档案（预览不得基于过期快照）',
    /loadCharacters\(projectId\)/.test(sbs) && /export async function loadCharacters/.test(read(path.join(PUB, 'js', 'app.js'))));
  ok('预览标注角色注入徽标与最终词', /\+角色/.test(sbs) && /data-prompt="\$\{field\}"/.test(sbs));
  // 灵敏度对照：把"绑定"删掉，行渲染守卫必须能发现
  ok('灵敏度对照：charCell 缺失会被检出', !/function charCell\(/.test('const x = 1;'));
}

// ── 批 8 原著解析：前端与后端同源、页面契约 ───────────────────
group('原著解析页（批 8：卡片类别同源 / 文件读取 / 端点齐全）');
{
  const app = read(path.join(PUB, 'js', 'app.js'));
  const apiSrc = read(path.join(PUB, 'js', 'api.js'));
  const consts = read(path.join(PUB, 'js', 'consts.js'));
  const novel = read(path.join(PUB, 'js', 'pages', 'novel.js'));
  const fileSrc = read(path.join(PUB, 'js', 'storyfile.js'));
  const routesSrc = read(path.join(ROOT, 'lib', 'routes.js'));
  const storySrc = read(path.join(ROOT, 'lib', 'story.js'));

  ok('导航注册了原著解析页（图标存在，否则静默退化成 info 图标）',
    /id: 'novel', label: '原著解析', icon: 'book'/.test(app) && /book: '<path/.test(consts));
  ok('原著解析页默认导出函数', /export default async function novel/.test(novel));
  ok('原著解析页在故事脚本之后、分镜制作之前（链路顺序即导航顺序）',
    app.indexOf("id: 'novel'") > app.indexOf("id: 'scripts'") && app.indexOf("id: 'novel'") < app.indexOf("id: 'storyboards'"));

  // ① 卡片类别必须与后端同源（漂移 = "抽到了但界面不显示"）
  const parseArr = (src, re) => {
    const m = re.exec(src);
    return m ? m[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
  };
  const backKinds = parseArr(storySrc, /const CARD_KINDS = \[([^\]]+)\]/);
  const frontKinds = parseArr(consts, /export const STORY_CARD_KINDS = \[([^\]]+)\]/);
  ok('后端 CARD_KINDS 解析成功（自证解析器有效）', backKinds.length === 6, backKinds.join(','));
  eq('前端卡片类别与后端 CARD_KINDS 逐项一致（顺序也算）', frontKinds, backKinds);
  const backFields = [...storySrc.matchAll(/^\s{2}([a-z_]+): \[([^\]]*)\],/gm)].map((m) => m[1]);
  const frontFieldKeys = [...consts.matchAll(/^\s{2}([a-z_]+): \[/gm)].map((m) => m[1]);
  ok('前端字段表覆盖后端 CARD_FIELDS 的每一类',
    backKinds.every((k) => frontFieldKeys.includes(k)), `后端 ${backKinds.join(',')} / 前端 ${frontFieldKeys.join(',')}`);
  ok('前端每类字段都给了中文标签（否则编辑态显示英文键名）',
    /export const STORY_CARD_FIELD_LABELS = \{/.test(consts) && /storyKindLabel/.test(consts));
  ok('灵敏度对照：把类别表改错会被比对检出',
    JSON.stringify(['world', 'character', 'location']) !== JSON.stringify(backKinds)
    && JSON.stringify(['world', 'character']) !== JSON.stringify(backKinds));

  // ② 文本规范化必须与后端 normalizeText 输出一致（否则"字数"在骗人）
  const require2 = createRequire(import.meta.url);
  const storyMod = require2(path.join(ROOT, 'lib', 'story.js'));
  const fileMod = await import(pathToFileURL(path.join(PUB, 'js', 'storyfile.js')).href);
  const probes = [
    '\uFEFF第一章\r\n\r\n\r\n林晚走了。\r\n',
    '  前后有空白  \n\n\n\n\n中间空行很多\n',
    '甲\t\t\n乙   \n',
    '没有换行的一段文字',
  ];
  const mismatch = probes.filter((t) => fileMod.normalizeStoryText(t) !== storyMod.normalizeText(t));
  ok('前端 normalizeStoryText 与后端 normalizeText 逐例一致', mismatch.length === 0,
    mismatch.map((t) => JSON.stringify(t)).join(' | ') || `${probes.length} 例全部一致`);
  ok('灵敏度对照：两套规范化确实会不同（不是恒等的空断言）',
    fileMod.normalizeStoryText('\uFEFFa\r\n\r\n\r\nb') !== '\uFEFFa\r\n\r\n\r\nb');

  // ③ 文件读取：纯文本与 .docx 都收，超限/空文件给可读理由
  // 批 8 补 23 把"docx 明确拒绝"这条**有意反转**了：原来写"docx 是另一个数量级的依赖"，
  // 对 PDF 成立、对 docx 不成立（docx 就是个 zip，浏览器原生能解压）。断言跟着事实改，不是删掉。
  ok('接受 .docx（作者稿件绝大多数是 Word，不该逼人先另存为 txt）',
    fileMod.checkStoryFile({ name: 'a.docx', size: 100 }).ok);
  ok('.pdf 仍然拒绝，且理由指向真实原因（字体编码），不是含糊的"不支持"',
    !fileMod.checkStoryFile({ name: 'a.pdf', size: 100 }).ok
    && /字体编码/.test(fileMod.checkStoryFile({ name: 'a.pdf', size: 100 }).error));
  ok('接受 .txt/.md/.markdown', ['.txt', '.md', '.markdown'].every((e) => fileMod.checkStoryFile({ name: `a${e}`, size: 10 }).ok));
  ok('空文件被拒', !fileMod.checkStoryFile({ name: 'a.txt', size: 0 }).ok);
  ok('超大文件被拒（20MB 上限）', !fileMod.checkStoryFile({ name: 'a.txt', size: fileMod.STORY_FILE_MAX + 1 }).ok);
  ok('页面用 accept 与校验同一份扩展名表（能选中的一定能读）',
    /STORY_FILE_ACCEPT/.test(fileSrc) && /STORY_FILE_ACCEPT\.join\(','\)/.test(novel) && /accept="\$\{STORY_FILE_ACCEPT/.test(novel));
  ok('页面按扩展名分发（.docx 走解压那条路）',
    /parseStoryFiles/.test(novel) && typeof fileMod.parseStoryFile === 'function' && typeof fileMod.parseStoryFiles === 'function');
  ok('zip 只读实现齐全（中央目录 → 局部头 → 解压）',
    ['listZipEntries', 'readZipEntryRaw', 'inflateRawBytes', 'readZipText', 'docxXmlToText', 'decodeXmlEntities']
      .every((k) => typeof fileMod[k] === 'function'));
  // 真正构造一个带 ZIP64 定位器的缓冲来验（只对源码做正则等于没测行为）—— 细节断言在 selftest 里
  ok('源码里写明了 ZIP64 会被拒绝而不是猜着读（猜错的后果是一堆乱码，比报错难查）',
    /ZIP64/.test(fileSrc) && /暂不支持/.test(fileSrc));
  ok('不引第三方解压库（零依赖是硬约束）', !/from '(?!\.)|require\(/.test(fileSrc.replace(/\/\*[\s\S]*?\*\//g, '')));
  // 内置提示词同步（批 8 补 28）：提示词是抽取质量最大的杠杆，改了必须能到老用户手里，
  // 但**绝不能覆盖用户自己改过的**；而这是唯一一处会在启动时动用户数据的逻辑，接线位置本身就是安全属性
  {
    const seedSrc = read(path.join(ROOT, 'lib', 'seed.js'));
    const srvSrc = read(path.join(ROOT, 'server.js'));
    ok('有"内置模板同步"的纯函数决策（唯一会动用户数据的逻辑必须能离线验）',
      /function planTemplateSync/.test(seedSrc) && /function seedTemplates/.test(seedSrc));
    ok('历史内容指纹表在代码里（老库没有 digest 字段，只能靠它认出"还是官方那一版"）',
      /const TEMPLATE_SUPERSEDED/.test(seedSrc) && /superseded/.test(seedSrc));
    ok('两个抽取提示词都写明了 involved 只写本名（预防）',
      ['novel_extract', 'story_bible'].every((k) => {
        const i = seedSrc.indexOf(`key: '${k}'`);
        return i >= 0 && /本名/.test(seedSrc.slice(i, i + 4000));
      }));
    // 安全属性：播种会**写库**，所以必须发生在端口绑定成功之后 ——
    // 影子实例（端口被别人占着、走 X4 分支退出）绝不能动数据（persist 是整库快照，互踩会静默丢数据）
    const iListen = srvSrc.indexOf("server.once('listening'");
    const iSeed = srvSrc.indexOf('seedLib.seedTemplates(store)');
    ok('播种发生在端口绑定成功之后（影子实例不得写用户数据）',
      iListen > 0 && iSeed > iListen, `listening@${iListen} seed@${iSeed}`);
    ok('启动横幅如实报出"更新了几个 / 保留了哪几个"（不能默默不更新）',
      /提示词更新/.test(srvSrc) && /保留你的版本/.test(srvSrc));
  }

  // 剧情卡人物闭环体检（批 8 补 28）：involved 里的人是否真的存在
  {
    const nv = read(path.join(PUB, 'js', 'pages', 'novel.js'));
    ok('体检面板的说明里点出了卡片侧人物闭环（用户要知道这一项在查什么）',
      /涉及人物/.test(nv) && /人物卡与角色库/.test(nv));
    // 面板对这类问题走通用路径：不可一键修复 + 有 go → 出「去处理」按钮（不新增分支）
    ok('这类问题复用通用出口（fixable=false + go → "去处理"）',
      /!it\.fixable && it\.go/.test(nv) && /data-audit-go/.test(nv));
  }

  // 项目上下文唯一来源（UI 重构步 A）
  // 为什么钉它：此前 6 个创作页各写一套解析（口径 5 种），表现是"这一页选好项目、切到另一页又变回第一个"。
  // 钉法只钉**形状**（不许再有第二份解析），不钉具体某一行 —— 换写法不该红，多一份解析才该红。
  {
    const appSrc = read(path.join(PUB, 'js', 'app.js'));
    ok('壳层持有当前项目，并提供唯一解析入口（resolveProjectId / rememberProject）',
      /projectId: ''/.test(appSrc)
      && /export function resolveProjectId\(/.test(appSrc)
      && /export function rememberProject\(/.test(appSrc));
    ok('旧别名 project_id 只在一处归一（parseHash），页面只认 project',
      /if \(!params\.project && params\.project_id\) params\.project = params\.project_id;/.test(appSrc)
      && /delete next\.project_id;/.test(appSrc));
    ok('解析顺序是"先具体后兜底"：URL → 壳层 → 记忆 → 第一个项目',
      /asked \|\| \[state\.projectId, readRememberedProject\(\)/.test(appSrc));
    // 本轮真机抓到的回归：`state.projects` 是**启动快照**，拿它当"项目存不存在"的权威，
    // 会把刚用接口建好的项目判成死链、切到别的项目去（页面于是显示错项目的空数据）
    ok('URL 里写的项目**直接用**，不拿启动快照当权威（快照会过期）',
      !/find\(known\) \|\| '';\s*\n[^\n]*if \(asked && !known\(asked\)\) \{[^}]*warn/s.test(appSrc)
      && /asked \|\| \[/.test(appSrc));
    ok('"项目是不是真的没了"用**一份新数据**核对（异步），而且三种结局分开：在 / 真没了 / 核对不了',
      /async function verifyProjectLater\(/.test(appSrc)
      && /if \(list\.some\(\(p\) => p\.id === id\)\) \{ renderSidebar\(\); return; \}/.test(appSrc)
      && /if \(!list\) return;/.test(appSrc));
    // "用户走开了"按**地址栏**判，不按 state.projectId 判 —— 壳层刷新快照时会自己把这个不存在的 id
    // 换成一个真项目，拿它当判据会把这条提示吞掉（真机吞过一次）
    ok('死链提示的"用户已走开"判据是地址栏，不是壳层状态',
      /\(parseHash\(\)\.params\.project \|\| ''\) !== id/.test(appSrc));
    // 钉**调用**而不是那句话：注释里也会出现同样的措辞，钉短语会把注释算成第二份实现
    ok('死链拦截只有一处实现（6 个页面同享，不再各写一句 toast）',
      (appSrc.match(/toast\.warn\('链接指向的项目不存在/g) || []).length === 1);
    ok('侧栏渲染全站唯一的项目选择器，并在切换时只带 project 重进当前页',
      /id="sb-project"/.test(appSrc)
      && /#sb-project/.test(appSrc)
      && /navigate\(state\.current, \{ project: sp\.value \}\)/.test(appSrc));
    // 反向：6 个创作页**不许**再自己解析项目
    const creators = ['scripts', 'novel', 'storyboards', 'characters', 'images', 'videos'];
    const ownResolve = creators.filter((f) => {
      const src = read(path.join(PUB, 'js', 'pages', `${f}.js`));
      return /params\.project(?!_id)/.test(src) || /params\.project_id/.test(src);
    });
    ok('6 个创作页都不再自己解析项目（第二份解析＝同一件事有两个来源）',
      ownResolve.length === 0, ownResolve.join(','));
    const notUsing = creators.filter((f) => !/resolveProjectId\(params\)/.test(read(path.join(PUB, 'js', 'pages', `${f}.js`))));
    ok('6 个创作页都走同一个入口', notUsing.length === 0, notUsing.join(','));
    ok('页内换项目也写回壳层与记忆（否则壳层显示的项目与页面用的不是一回事）',
      creators.every((f) => !/projectId = picker\.value/.test(read(path.join(PUB, 'js', 'pages', `${f}.js`)))));
    ok('素材库的项目控件是**跨项目筛选器**，不是创作上下文（本轮有意不动它）',
      /agnes\.assets\.project/.test(read(path.join(PUB, 'js', 'pages', 'assets.js'))));
  }

  // 旧代码防护（批 8 补 27）：服务端跑的是旧代码时必须主动说 —— 前端每次从磁盘读、后端只在启动时读一次
  {
    const appSrc = read(path.join(PUB, 'js', 'app.js'));
    const srv = read(path.join(ROOT, 'server.js'));
    const rts = read(path.join(ROOT, 'lib', 'routes.js'));
    ok('壳层留了"旧代码"横幅容器', read(path.join(PUB, 'index.html')).includes('id="stale-bar"'));
    ok('健康体带代码指纹 / 陈旧标记 / 陈旧文件清单',
      /code_sig/.test(rts) && /code_stale/.test(rts) && /stale_files/.test(rts));
    ok('页面顶部真的会渲染这条横幅（读的是服务端给的结论，不是前端自己猜）',
      // 注意必须是**调用**而不是定义：`function renderStaleBar(h) {` 里也含 `renderStaleBar(h)`，
      // 只匹配到定义就等于没测到底调没调（对照 HD 抓出来的：把调用删掉，断言照样绿）
      /function renderStaleBar/.test(appSrc) && /h\.data\.code_stale/.test(appSrc) && /renderStaleBar\(h\);/.test(appSrc));
    ok('横幅给出可执行的下一步（结束哪个 PID + 重启 + 刷新）',
      /PID/.test(appSrc) && /重新启动/.test(appSrc) && /刷新本页/.test(appSrc));
    ok('404 会补一句"跑的是旧代码"（"接口不存在"是最容易被误读的那句）',
      /staleHint\(\)/.test(srv) && /接口不存在: \$\{req\.method\}/.test(srv));
    ok('端口被旧代码实例占着时，不再只说"已在运行"把用户堵在门外',
      /跑的是\*\*旧代码\*\*/.test(srv) && /kill \$\{alive\.pid/.test(srv));
  }

  // 逐段核对（批 8 补 26）：段号对不上时，补抽按钮不能点了必然失败，也不能假装"可以补"
  ok('原文对不上时不摆"点了必然被拒"的补抽按钮（有出口、但出口是墙，等于没出口）',
    /const broken = d\.verified === true/.test(novel) && /bad && !broken/.test(novel));
  ok('对不上时给的是真出口：重新解析，并把原文填回输入框（只差一次点击）',
    /nov-cover-reparse/.test(novel) && /textEl\.value = r2\.data\.text/.test(novel));
  ok('界面不自己猜"核对过没有"：核对结论由服务端给（verified）',
    /d\.mismatched_chunks/.test(novel) && /d\.verified/.test(novel));

  // 已改的卡不被覆盖（批 8 补 25）：界面写了"不会覆盖"，就得真的不覆盖，而且要**说出来**
  ok('追加确认里事先说明保护规则（花钱之前就把预期讲清楚）',
    /人工值优先/.test(novel) && /不会被覆盖/.test(novel));
  ok('完成时报告"你改过的 N 张卡保持原样"（保护不能是无声的）',
    /protected_cards/.test(novel) && /张卡保持原样/.test(novel));
  ok('"已改"chip 的说明与实际行为一致（追加解析/重新归并都不覆盖）',
    /追加解析\/重新归并都不会覆盖它/.test(novel) && !/重新解析不会覆盖它/.test(novel));

  // 多文件（批 8 补 24）：很多作者一章一个文件
  ok('文件选择允许多选', /id="nov-file"[^>]*multiple/.test(novel), 'novel.js 的 #nov-file 少了 multiple');
  ok('页面走多文件读取那条路（不是只取 files[0]）',
    /parseStoryFiles\(picked\)/.test(novel) && !/parseStoryFile\(picked\[0\]\)/.test(novel));
  ok('读进来的顺序**看得见**（有独立面板列出每个文件）',
    /id="nov-files"/.test(novel) && /renderFilesBox/.test(novel) && /r\.files\.map/.test(novel));
  ok('顺序排不出来时点名是哪些文件（不是含糊地说"可能不对"）',
    /r\.unorderable/.test(novel) && /r\.guessed/.test(novel));
  ok('排序与"排不动"判定都在共享模块里（不是页面里另写一套）',
    typeof fileMod.sortStoryFiles === 'function' && typeof fileMod.unorderableNames === 'function'
    && !/localeCompare/.test(novel + fileSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
    '排序不该依赖 locale（结果要可复现）');

  // ④ 端点齐全：前端调的每个 /api/story/* 后端都必须有
  // 端点路径在 api.js 里有三种写法：纯字面量、带查询参数的模板串、带 :id 的模板串。
  // 直接字符串比对会把后两种误判，所以分两步：
  //   ① 纯字面量的做**精确**存在性检查（最严，能抓拼写错）；
  //   ② 模板串取"静态前缀"（到 $ 或 : 为止），要求后端存在以它为前缀的注册路由。
  //      `cards/${id}` 与 `cards/${q...}` 都归到前缀 /api/story/cards，仍能抓住路径主体写错。
  const heads = (src) => [...new Set([...src.matchAll(/\/api\/story\/[a-z/-]*/g)].map((m) => m[0].replace(/\/+$/, '')))];
  const frontHeads = heads(apiSrc);
  const backHeads = heads(routesSrc);
  ok('api.js 暴露了 story 端点（自证非空跑）', frontHeads.length >= 6, frontHeads.join(','));
  ok('后端注册了 story 路由（自证非空跑）', backHeads.length >= 6, backHeads.join(','));
  const unmatched = frontHeads.filter((h) => !backHeads.some((b) => b === h || b.startsWith(`${h}/`)));
  ok('api.js 用到的每个 /api/story 路径后端都有对应注册', unmatched.length === 0, unmatched.join(','));
  const literals = [...new Set([...apiSrc.matchAll(/'\/api\/story\/[^'?]*'/g)].map((m) => m[0].slice(1, -1)))];
  const missLiteral = literals.filter((p2) => !routesSrc.includes(`'${p2}'`));
  ok('其中纯字面量端点做精确比对（抓拼写错）', literals.length >= 4 && missLiteral.length === 0,
    missLiteral.join(',') || `精确命中 ${literals.length} 个：${literals.join(',')}`);
  ok('api.js 暴露了干跑与卡片 CRUD',
    ['storyPlan:', 'storyAnalyze:', 'storyCards:', 'updateStoryCard:', 'deleteStoryCard:', 'storyPrompt:', 'storyCardToCharacter:', 'storyImportCharacters:', 'storySources:', 'deleteStorySource:']
      .every((k) => apiSrc.includes(k)));

  // ⑤ 计费闸门：解析入口必须先干跑再确认（不许静默花钱）
  ok('解析入口接入 costConfirm（与分镜/视频同一条付费纪律）', /costConfirm\(\{ count: plan\.calls/.test(novel));
  ok('没干跑过就先干跑一次（不许拿旧数字给新原文背书）',
    /if \(!plan\) \{/.test(novel) && /plan = null;/.test(novel) && /原文一变/.test(novel));
  ok('覆盖不全时明说（不学竞品"截断了却宣称已解析全书"）',
    /truncated \? `<br>原文超出单次解析上限/.test(novel) && /只覆盖前/.test(novel));

  // ⑥ 刷新不丢：原文落库 + 任务进度续上
  ok('解析任务 id 进 localStorage（刷新/切页回来能续上进度）', /localStorage\.setItem\(JOB_KEY/.test(novel) && /api\.batch\(saved\)/.test(novel));
  ok('解析记录可把原文载回输入框（竞品刷新即全丢的那 1 万字）',
    /data-load=/.test(novel) && /textEl\.value = r2\.data\.text/.test(novel));
  ok('删原著前告知会连带删掉多少卡片（引用后果要说清）', /张卡片会一起删除，无法撤销/.test(novel));
  ok('删单卡走就地两击确认（不弹窗打断，也不一击就没）', /armedDel !== id/.test(novel));
  ok('就地编辑保存前校验名字非空（下游全靠名字对上号）', /名字不能为空/.test(novel));

  // ⑦ 反向驱动：人物卡入资产库 + 回注文本
  ok('只有人物卡给"入资产库"按钮（地点/道具卡不该进角色库）',
    /c\.kind === 'character' \? `<button class="btn btn-xs" data-tochar=/.test(novel));
  ok('回注文本由服务端渲染（前端不重复实现 cardsToPrompt）',
    /api\.storyPrompt\(/.test(novel) && !/function cardsToPrompt/.test(novel));
  ok('复制成功文案说清"粘到哪里"（减少人工试错）', /粘贴进剧本或分镜模板的变量框/.test(novel));
  // 批 8 补：一键带入（把"复制→切页→找字段→粘贴"四步压成一步）
  ok('原著页有"带入剧本"入口（不再只有复制粘贴）', /id="nov-toscript"/.test(novel) && /#\/scripts\?\$\{q\.toString\(\)\}/.test(novel));
  ok('带入参数走 hash（可刷新/可分享/可回退）',
    /new URLSearchParams\(\{ project: projectId, tab: 'episode_script', bible: sourceId \}\)/.test(novel));
  ok('带入作用域跟随分组筛选（选了人物卡就只带人物卡）', /function scopeKinds\(\) \{ return kindFilter \? \[kindFilter\] : \[\]; \}/.test(novel));
  // ui-audit 实测过：三个按钮 + 标题在 900~1024px 会把页面撑出横向滚动条，
  // 靠 .row.wrap 换行解决。ui-audit 不是门禁，所以这里钉住修法，防止"优化时又改回不换行"。
  // 通用棘轮：ui.js 的 dataOf 是**字面**取属性（`data-` + name），驼峰写法只会拿到 null，
  // 表现是"按钮点了没反应"，而且**不会报错**——批 8 下（卡片删除）与批 8 补 3（体检修复）
  // 各犯过一次。这里按文件比对：每个 dataOf 读的名字都必须真的被渲染出来。
  for (const file of listJs(path.join(PUB, 'js', 'pages')).concat([path.join(PUB, 'js', 'app.js')])) {
    const src = read(file);
    const used = [...src.matchAll(/dataOf\([^,]+, *'([A-Za-z-]+)'\)/g)].map((m) => m[1]);
    if (!used.length) continue;
    const have = new Set([...src.matchAll(/data-([A-Za-z-]+)/g)].map((m) => m[1]));
    const missing = [...new Set(used)].filter((n) => !have.has(n));
    ok(`${path.basename(file)} dataOf 读的属性名都被渲染过（驼峰会静默拿到 null）`,
      missing.length === 0, `缺失：${missing.join(', ')}`);
  }

  // ui-audit 的钩子自检（弹窗 + 内联两种）：钩子会随界面改名慢慢烂掉，而报表依然"零发现"，
  // 所以"声明了动作就必须有产出"必须留在工具里（正向对照 Q：改坏体检入口选择器 → 4 个视口各报一条）
  {
    const ua = read(path.join(ROOT, 'tools', 'ui-audit.mjs'));
    ok('ui-audit 有内联动作自检（面板无产出即报一条发现）', /内联动作无产出/.test(ua) && /requireModal === false/.test(ua));
    ok('原著页在 ui-audit 里带内联动作且声明不是弹窗',
      /\['novel'.*#nov-audit.*requireModal: false/.test(ua));
    ok('ui-audit 种子里有卡片（否则体检面板永远是空态，量了个寂寞）',
      /story_cards: \[/.test(ua) && /audit_card_loc_1/.test(ua));
  }

  const boardsSrc = read(path.join(PUB, 'js', 'pages', 'storyboards.js'));
  const scriptsSrc = read(path.join(PUB, 'js', 'pages', 'scripts.js')); // storySrc 在本块之外已读过
  // ── 角色参考图进出图输入（批 8 补 13）──
  ok('参考图在使用点注入（入库的提示词仍只存镜头内容）',
    /function characterRefImages\(chars, opts = \{\}\)/.test(routesSrc)
    // 批 8 补 17：参考图来源从"只有角色"扩到"角色 + 地点/道具卡"，
    // 顺序固定为 显式 → 角色 → 场景道具（总上限 4 张时**先保脸**）
    && /const allRefs = \[\.\.\.new Set\(\[\.\.\.explicit, \.\.\.ref\.urls, \.\.\.refCards\.urls\]\)\]/.test(routesSrc)
    && /function storyCardRefImages\(cards, opts = \{\}\)/.test(routesSrc));
  ok('只有公网 URL 才发给上游（本地 /assets/… Agnes 抓不到），且如实上报用不上几张',
    /story\.isPublicUrl\(u\)/.test(routesSrc) && /local_skipped: ref\.local/.test(routesSrc));
  // "算不算数"只留一份实现：出图取图、卡片参考图、一致性体检三处共用同一个判据
  ok('公网 URL 判定只有一份实现（各写一份必然走偏）',
    /function isPublicUrl\(v\)/.test(read(path.join('lib', 'story.js')))
    && (routesSrc.match(/isPublicUrl\(/g) || []).length >= 2
    // 真正的棘轮：routes.js 里**不许**再出现内联的 http(s) 判定（用子串查，正则字面量在这层转义里太容易写错）
    && !routesSrc.includes('^https?'));
  ok('参考图有上限（多了互相打架也拖慢生成）',
    /num\(opts\.max, 4\)/.test(routesSrc) && /\.slice\(0, 4\)/.test(routesSrc));
  ok('溯源记的是**实际发出**的输入（记 body.image 就查不到自动带上的参考图）',
    /reference_images: \[\.\.\.ref\.urls, \.\.\.refCards\.urls\],/.test(routesSrc)
    && /input_images: inputImages,/.test(routesSrc));
  ok('前端如实报"带上了几张参考图、是谁的"，本地文件用不上时明确警告',
    /已带上 \$\{ri\.used\} 张参考图/.test(boardsSrc) && /ri\.local_skipped/.test(boardsSrc)
    // 来源要分开报：只说"N 张"用户没法判断是脸带上了还是景带上了
    && /场景\/道具 \$\{\(ri\.cards \|\| \[\]\)\.join\('、'\)\}/.test(boardsSrc));
  ok('批量出图在**花钱之前**预检参考图（先说清哪几张会真的进到出图输入）',
    /async function imageRefPrecheck\(shots\)/.test(boardsSrc)
    && /其中 \$\{refPre\.used\} 张参考图会作为出图输入/.test(boardsSrc)
    // 预检必须把场景/道具卡的参考图也算进去，否则"带了几张"是假的
    && /count\(s\.story_card_ids, cardById, cardUrls\)/.test(boardsSrc));

  // 这一片（批 8 补 18/19/20/21）共用的源码文本：**全部声明在这里**，后面任何一组都不许再声明。
  // 每个小组各声明一次的做法已经踩了三次"先用后声明"（ReferenceError）—— 往中间插一组就红一次。
  const novelSrc17 = read(path.join(PUB, 'js', 'pages', 'novel.js'));
  const constsSrc17 = read(path.join(PUB, 'js', 'consts.js'));
  const apiSrc20 = read(path.join(PUB, 'js', 'api.js'));

  // ── 章节识别与章节级溯源（批 8 补 21）──
  ok('章节目录走纯本地端点（随时可点、不花钱）',
    /storyChapters: \(sourceId\) => req\('GET', `\/api\/story\/chapters\?source_id=/.test(apiSrc20));
  ok('原著页有「章节目录」入口', /id="nov-chap"/.test(novelSrc17) && /章节目录/.test(novelSrc17));
  ok('出处优先说"第几章"，段号只做兜底（作者想的是章节，段号是切块的副产物）',
    /chunkChapter\[c\.chunk_index\] \|\| `第 \$\{\(c\.chunk_index \?\? 0\) \+ 1\} 段`/.test(novelSrc17));
  ok('章节映射在**渲染之前**取到（否则先写"第 3 段"再被改写，展开的面板会被重绘掉）',
    /章节映射要在\*\*渲染之前\*\*拿到/.test(novelSrc17));
  ok('chunkChapter 的声明在首次使用它的函数之前（放后面能跑，但那是靠调用顺序的巧合）',
    novelSrc17.indexOf('let chunkChapter') < novelSrc17.indexOf('async function loadCards'));
  ok('只有"真丢数据"才报警，不把"模型说这段没信息"也报成问题',
    /const lost = \(c\.dropped \|\| 0\) \+ \(c\.failed \|\| 0\)/.test(novelSrc17) && /去「抽取覆盖」看是哪几段/.test(novelSrc17));
  ok('没识别到章节时如实说明，不硬编章节号', /没有识别到章节标题/.test(novelSrc17));
  ok('目录行被忽略这件事如实上报（不假装原文只有一章）', /疑似目录行被忽略/.test(novelSrc17));
  ok('溯源面板显示章节标题', /x\.chapter_title \? `<b>\$\{esc\(x\.chapter_title\)\}<\/b>/.test(novelSrc17));
  ok('一段跨多章时如实标注', /这一段跨了多章/.test(novelSrc17));

  // ── 章节复核（批 8 补 22）──
  ok('点开一章就地看"这一章抽到了什么"', /data-chap="\$\{c\.chapter\}"/.test(novelSrc17) && /nov-chap-\$\{c\.chapter\}/.test(novelSrc17));
  ok('每张卡可直接跳到它的原文依据', /data-chap-card="\$\{esc\(x\.id\)\}"/.test(novelSrc17));
  ok('从章节面板点卡片是"给我看"而不是"开关"（把已展开的依据关掉会莫名其妙）',
    /openSource\(dataOf\(ev\.currentTarget, 'chap-card'\), \{ scroll: true, force: true \}\)/.test(novelSrc17)
    && /if \(!slot\.hidden && !\(opts && opts\.force\)\)/.test(novelSrc17));
  ok('列出的是这一章真抽到的卡（按 evidence 落在哪一章判定，不做推测）',
    /const got = \(c\.card_ids \|\| \[\]\)\.map\(\(id\) => byId\.get\(id\)\)\.filter\(Boolean\)/.test(novelSrc17));
  ok('原文开头先给一眼（确认点开的是不是这一章）', /info\.preview/.test(novelSrc17));
  ok('溯源只有一份实现（章节面板与主列表共用，避免两处行为分叉）',
    /async function openSource\(id, opts\)/.test(novelSrc17)
    && (novelSrc17.match(/api\.storyCardSource\(/g) || []).length === 1);
  ok('卡片列表还没加载时先补上（否则会把"不知道"说成"这一章没有抽到卡片"）',
    /if \(!cards\.length\) await loadCards\(\)/.test(novelSrc17));
  ok('被类别筛选挡住时先解除筛选再打开（否则点了没反应）',
    /kindFilter = '';\n\s+syncViewParams\(\{ kind: '' \}\);\n\s+renderKindChips\(\);\n\s+renderCards\(\);/.test(novelSrc17));

  // ── 卡片溯源（批 8 补 20）──
  ok('卡片溯源走纯本地端点（随时可点、不花钱）',
    /storyCardSource: \(cardId\) => req\('GET', `\/api\/story\/card-source\?card_id=/.test(apiSrc20));
  ok('卡片行有"看原文"入口（只给"证据段 3"这种段号，用户核对就得自己数段）',
    /data-src-of="\$\{esc\(c\.id\)\}"/.test(novelSrc17) && /看原文/.test(novelSrc17));
  ok('命中处标出来（一眼看到"就是这里"）', /<mark>\$\{esc\(x\.t\)\}<\/mark>/.test(novelSrc17));
  ok('片段逐段转义后才包 mark（命中的词来自模型输出，不转义就是把模型输出注进页面）',
    /const hl = \(segs\) => \(segs \|\| \[\]\)\.map\(\(x\) => \(x\.hit \? `<mark>\$\{esc\(x\.t\)\}<\/mark>` : esc\(x\.t\)\)\)/.test(novelSrc17));
  ok('如实说明片段只截了命中附近（不假装是完整段落）', /只显示命中附近/.test(novelSrc17));
  ok('没命中时也如实说（返回空白会让人以为出错）', /这段里没找到这个名字/.test(novelSrc17));
  const cssSrc20 = read(path.join(PUB, 'css', 'app.css'));
  ok('原文引用有自己的样式（要像"引文"而不是像界面文字）',
    /\.src-quote \{/.test(cssSrc20) && /\.src-quote mark \{/.test(cssSrc20));

  // ── 参考图缺口体检（批 8 补 19）──
  ok('体检报告里"机器修不了"的问题也要给出口（只报告不给去处 = 死胡同）',
    /data-audit-go="\$\{i\}"/.test(novelSrc17) && /navigate\(issue\.go\.page, issue\.go\.params/.test(novelSrc17));
  ok('原著页能从链接直接定位到那张卡（"去处理"必须真的落到具体对象上）',
    /params\.card_id \|\| null/.test(novelSrc17) && /data-card="\$\{focusCardId\}"/.test(novelSrc17));
  const charSrc19 = read(path.join(PUB, 'js', 'pages', 'characters.js'));
  ok('角色库页也能定位高亮（角色参考图是同一类缺口）',
    /params\.char_id/.test(charSrc19) && /char-card\[data-id="\$\{focusCharId\}"\]/.test(charSrc19));
  ok('参考图缺口按"影响镜头数"排（先修影响最大的）',
    /issues\.sort\(\(a, b\) => \(b\.shot_numbers/.test(read(path.join('lib', 'story.js'))));

  // ── 抽取覆盖体检与补抽（批 8 补 18）──
  const apiSrc18 = read(path.join(PUB, 'js', 'api.js'));
  ok('覆盖体检走纯本地端点（随时可跑、不花钱）',
    /storyCoverage: \(sourceId\) => req\('GET', `\/api\/story\/coverage\?source_id=/.test(apiSrc18));
  ok('补抽是独立端点（会调模型，所以必须能单独确认成本）',
    /storyRetryChunks: \(body\) => req\('POST', '\/api\/story\/retry-chunks', body\)/.test(apiSrc18));
  ok('原著页有覆盖体检入口与面板（不是只有后端能力）',
    /id="nov-cover"/.test(novelSrc17) && /id="nov-cover-box"/.test(novelSrc17) && /async function runCoverage\(\)/.test(novelSrc17));
  ok('四种结局分开显示（"没信息"和"被丢弃"长得一样时，真丢数据就永远看不见）',
    /const BADGE = \{ ok: 'green', empty: 'gray', dropped: 'gold', failed: 'red'/.test(novelSrc17)
    && /x\.state_label/.test(novelSrc17));
  ok('被丢弃的段要说清"模型给了几条、什么类别"（只说"丢弃了"用户没法动手修）',
    /模型给了 \$\{x\.raw_count\} 条/.test(novelSrc17) && /x\.raw_kinds\.join/.test(novelSrc17));
  ok('补抽按钮带成本确认（花钱的动作不能点一下就发出去）',
    /id="nov-cover-retry"/.test(novelSrc17) && /costConfirm\(\{[\s\S]{0,200}what: '补抽漏掉的段落'/.test(novelSrc17));
  ok('补抽后回到进度条（不是点完就没下文）', /localStorage\.setItem\(JOB_KEY, rr\.data\.jobId\)/.test(novelSrc17));
  ok('不再承诺"可在卡片列表重试"这种没有出口的话（假承诺比不提示更糟）',
    !/可在卡片列表重试或手动补/.test(novelSrc17) && /if \(j\.fail\) runCoverage\(\)/.test(novelSrc17));

  // ── 地点卡/道具卡参考图（批 8 补 17）──
  ok('地点卡/道具卡能挂参考图（此前只有人物卡有，场景/道具只有一行文字）',
    /CARD_IMAGE_KINDS\.includes\(c\.kind\)/.test(novelSrc17) && /e-refs-\$\{esc\(c\.id\)\}/.test(novelSrc17));
  ok('参考图是**多选缩略图**，保存时单独收集（它不是单值输入，不在 [data-f] 里）',
    /refBox\.querySelectorAll\('\.ref-item'\)/.test(novelSrc17) && /patch\.reference_image_ids = /.test(novelSrc17));
  ok('卡片编辑器里能看到本项目素材（取不到就是空列表，不阻断卡片显示）',
    /async function loadImages\(\)/.test(novelSrc17) && /await loadImages\(\);/.test(novelSrc17));
  // 前端词表必须与后端同源（照抄错了不会报错，只会静默不给挂图）
  const storySrc17 = read(path.join('lib', 'story.js'));
  const pick = (src) => (src.match(/CARD_IMAGE_KINDS = \[([^\]]*)\]/) || [])[1].replace(/['"\s]/g, '');
  ok('前后端的"可挂参考图的卡片类型"逐字同源（uitest 跨文件同构钉）',
    pick(storySrc17) === pick(constsSrc17) && pick(storySrc17) === 'location,prop',
    `story.js=${pick(storySrc17)} consts.js=${pick(constsSrc17)}`);
  ok('参考图 id 落库前必须清洗（去空/去重/限量，脏 id 会让出图静默少带几张）',
    /story\.normalizeRefIds\(patch\.reference_image_ids\)/.test(routesSrc)
    && /function normalizeRefIds\(v\)/.test(storySrc17));
  // 判之前先剥注释：解释"为什么不产出这个字段"的注释里必然会写出字段名（本轮又踩一次）
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  ok('归并时**绝不**产出 reference_image_ids（产出空数组会在重新解析时清空用户挂的图）',
    !/reference_image_ids/.test(stripComments((storySrc17.match(/function normalizeCard[\s\S]*?\n\}/) || [''])[0])),
    'normalizeCard 里出现了 reference_image_ids —— 重新解析会静默清空用户挂的参考图');

  // ── 全链路进度面板（批 8 补 16）──
  const dashSrc = read(path.join(PUB, 'js', 'pages', 'dashboard.js'));
  ok('工作台有七段链路进度面板（卡在哪一步一眼可见）',
    /七段链路/.test(dashSrc) && /api\.storyPipeline\(\{ project_id: pipeProject \}\)/.test(dashSrc));
  ok('"待前置"与"该做了"画得不一样（否则用户照着点却发现做不了）',
    /done: 'green', partial: 'gold', todo: 'blue', blocked: 'gray'/.test(dashSrc)
    && /x\.state === 'blocked' \? '' : 'on'/.test(dashSrc));
  ok('下一步给一个直达按钮，并带上项目 id（省掉到那页再选一次项目）',
    /去完成「\$\{esc\(d\.next_label\)\}」/.test(dashSrc) && /navigate\(nextStep\.page, \{ project: pipeProject \}\)/.test(dashSrc));
  ok('失败态也有 CTA（空态必须能一键走下去）',
    /empty\('项目加载失败', '修好后这里会显示创作进度', 'alert', \{ label: '重试', go: '#\/dashboard' \}\)/.test(dashSrc));

  // ── 逐集分镜用过期体检（批 8 补 15）──
  ok('逐集生成分镜接上过期体检（纯本地、不调模型）',
    /const stale = await api\.storyStaleness\(\{ project_id: projectId, per_episode: plan\.data\.per_episode \}\)/.test(boardsSrc));
  ok('源剧本改过的集**不跳过**（跳过的判据是"已有分镜"，而过期集恰恰有分镜）',
    /const isStale = cfg\.staleEps && cfg\.staleEps\.has\(ep\);/.test(boardsSrc)
    && /if \(cfg\.skipExisting && countByEp\.get\(ep\) && !isStale\)/.test(boardsSrc));
  ok('过期分镜可先清空再重生成，且清空按**项目 + 集**限定（服务端强制两个参数，避免误删）',
    /await api\.clearStoryboards\(projectId, ep\)/.test(boardsSrc) && /id="bs-replace"/.test(boardsSrc));
  ok('替换了多少个过期镜头要如实报出来（否则"删了又生成"看起来像什么都没发生）',
    /替换 \$\{replacedN\} 个过期镜头/.test(boardsSrc) && /已替换过期分镜/.test(boardsSrc));

  // ── 负面提示词并入出图提示词（批 8 补 14）──
  // 本组不在批 7 那个块里，agnes.js 的源码要自己读一份（同名变量在别的块里）
  const agnes14 = read(path.join(ROOT, 'lib', 'agnes.js'));
  const consts14 = read(path.join(PUB, 'js', 'consts.js'));
  ok('负面提示词的措辞只有一份实现（图片链 / 视频 2.5 系 / 前端预览三处同源）',
    /function negativePhrase\(prompt, neg\)/.test(storySrc)
    && /const prompt = story\.negativePhrase\(finalPrompt\(body\.prompt, \{/.test(routesSrc)
    && /body\.prompt = story\.negativePhrase\(params\.prompt, params\.negative_prompt\);/.test(agnes14));
  ok('图片链从**分镜行**取负面提示词（前端只带 storyboard_id 也要生效）',
    /const neg = str\(body\.negative_prompt\)\.trim\(\) \|\| str\(sbRow0\.negative_prompt\)\.trim\(\);/.test(routesSrc));
  ok('不单发 negative_prompt 字段（网关对未知字段硬拒，单发会让出图 400）——理由写在注释里',
    /not an allowed request field/.test(storySrc) && !/body\.negative_prompt = /.test(routesSrc));
  ok('前端镜像与后端逐字同构（预览不能说一套、发出去是另一套）',
    /export function negativePhrase\(prompt, neg\)/.test(consts14)
    && /if \(!n\) return prompt;/.test(consts14) && /return `\$\{prompt\}。避免出现：\$\{n\}`;/.test(consts14));
  ok('分镜表对图片列显示 +负面 标签（不然用户不知道它在起作用）',
    /negativePhrase\(artStylePhrase\(withCam, style\), s\.negative_prompt\)/.test(boardsSrc)
    && /\+负面<\/span>/.test(boardsSrc));

  // ── 剧本/分镜过期体检（批 8 补 12）──
  ok('过期体检是纯本地端点、并返回逐集状态与计数',
    /on\('GET', '\/api\/story\/staleness'/.test(routesSrc)
    && /story\.auditStaleness\(plan, scripts, shots/.test(routesSrc));
  ok('剧本记下"生成时的输入指纹"，分镜记下"来源剧本 + 它的指纹"',
    /plan_digest: str\(body\.plan_digest\)/.test(routesSrc)
    && /source_script_id: str\(r\.source_script_id\) \|\| null/.test(routesSrc)
    && /function sourceDigest\(scriptId\)/.test(routesSrc));
  ok('分镜的指纹由**服务端**按入库那一刻的正文算（前端复算哈希迟早漂移）',
    /script_digest: sourceDigest\(str\(r\.source_script_id\)\)/.test(routesSrc));
  ok('前端生成时带上指纹、并显式区分"带/不带前情"（不带前情却按带前情取指纹会凭空报过期）',
    /plan_digest: epDigest/.test(scriptsSrc) && /with_prior: usePrior \? undefined : '0'/.test(scriptsSrc));
  ok('逐集生成的默认范围来自体检（缺剧本/已过期），不是无脑全跑',
    /const todo = stale \? \(stale\.episodes \|\| \[\]\)\.filter/.test(scriptsSrc)
    && /默认范围来自<b>过期体检<\/b>/.test(scriptsSrc));
  // title 属性里出现裸双引号会**提前闭合属性**（中文引号写成英文引号就会这样），
  // 表现为按钮 title 被截断、后面多出一堆垃圾属性 —— 只对这一行做判据，别全文件扫
  {
    const line = scriptsSrc.split('\n').find((x) => x.includes('id="ep-stale"')) || '';
    ok('过期体检按钮：文案明确、且 title 里的引号是成对的（不成对会提前闭合属性）',
      /不调模型、不花钱/.test(line) && (line.match(/"/g) || []).length % 2 === 0,
      line.trim().slice(0, 120));
  }

  // ── 人物卡 ↔ 资产库漂移（批 8 补 11）──
  // 注意用本块之前就读好的 `novel`：`novelSrc` 在本块之后才声明（TDZ，用到会整份崩）
  ok('漂移体检有同步动作与按钮文案（不出现含糊的"一键修复"）',
    /sync_character: '同步到资产库'/.test(novel) && /code === 'sync_character'/.test(novel));
  ok('同步前把"哪个值变哪个值"逐条摆出来（这条会覆盖资产库里的描述，必须让人确认）',
    /d\.asset \|\| '空'/.test(novel) && /→「\$\{esc\(d\.card\)\}」/.test(novel));
  ok('确认文案说明只动外貌/服饰/别名（不影响出图的不动）',
    /只动外貌\/服饰\/别名三项/.test(novel));
  // 这条断言从"漂移体检"一路长成了**所有分组都必须并进 issues**的棘轮（补 39/40/41 各加一组）——
  // 名字跟着改，否则它红了会把人指向错的地方（"漂移体检"看着没问题，实际红在模板那一组）
  ok('体检的每一组都并进了 issues（面板渲染的是 issues；新增一组必须同时进来）',
    /story\.auditCharacterDrift\(cards/.test(routesSrc) && /drift_issues/.test(routesSrc)
    // 批 8 补 28：又加了卡片侧人物闭环一组 —— 这行断言要跟着走，否则"新增一组却忘了并进 issues"
    // （= 界面永远看不见）会静默通过
    && /styleIssues\.issues, drift\.issues, refGaps\.issues, cast\.issues, promptStale\.issues/.test(routesSrc)
    && /cast_issues: cast\.issues/.test(routesSrc)
    // 批 8 补 39：又加一组（提示词过期）—— 同上，"新增一组却忘了并进 issues"必须红
    && /prompt_issues: promptStale\.issues/.test(routesSrc)
    // 批 8 补 40：再加一组（润色派生过期）—— 同一条棘轮，新增一组必须同时进 issues
    && /polishStale\.issues/.test(routesSrc)
    && /polish_issues: polishStale\.issues/.test(routesSrc)
    // 批 8 补 41：再加一组（生成模板被改过）—— 同上
    && /tplStale\.issues\)/.test(routesSrc)
    && /template_issues: tplStale\.issues/.test(routesSrc));
  ok('同步修复只写外貌/服饰/别名，不碰角色定位与性格',
    /code === 'sync_character'/.test(routesSrc) && !/patch\.(role|personality|gender|age) =/.test(routesSrc));

  // ── 追加解析（批 8 补 10）──
  const novelSrc = fs.readFileSync(path.join(PUB, 'js/pages/novel.js'), 'utf8');
  ok('原著页有「追加到选中的原著」入口，并真的发 append_to 那类载荷',
    /id="nov-append"/.test(novelSrc) && /api\.storyAppend\(\{/.test(novelSrc) && /source_id: sourceId/.test(novelSrc));
  ok('追加前先算钱，且说明"已有章节不重跑、已有卡片 id 不变"',
    /what: '追加解析'/.test(novelSrc) && /不重跑/.test(novelSrc) && /id 不变/.test(novelSrc));
  ok('没选原著时明确告诉用户这是新建而不是追加（不静默改语义）',
    /先在左侧选中要追加到哪一份原著/.test(novelSrc));
  ok('干跑提示区分"追加解析 N 段"与"分 N 段解析"',
    /将<b>追加<\/b>解析/.test(novelSrc) && /将分 <b>\$\{p\.chunk_count\}<\/b> 段解析/.test(novelSrc));
  ok('api.js 有 storyAppend，且指向 /api/story/append',
    /storyAppend: \(payload\) => req\('POST', '\/api\/story\/append'/.test(fs.readFileSync(path.join(PUB, 'js/api.js'), 'utf8')));
  ok('后端 /api/story/append 存在，且走 mergeAppend（不删已有卡）',
    /'\/api\/story\/append'/.test(routesSrc) && /story\.mergeAppend\(existing/.test(routesSrc));
  ok('归并落库不再"删了重建"（改成就地 upsert，id 才稳定）',
    /story\.applyBibleCards\(oldBible, rows\)/.test(routesSrc) && !/removeWhere\('story_cards', \(r2\) => r2\.source_id === source\.id && r2\.origin === 'bible'\)/.test(routesSrc));

  // ── 逐集生成分镜（批 8 补 9）──
  ok('单集生成与逐集生成共用同一个内核（各写一份提示词迟早会漂移）',
    /async function shotsFromText\(text, ep, sourceScriptId\)/.test(boardsSrc)
    && /const out = await shotsFromText\(text, episode\)/.test(boardsSrc)
    && /const out = await shotsFromText\(sc\.content, ep, sc\.id\)/.test(boardsSrc));
  ok('逐集生成分镜：分镜写进对应的那一集（不串集）',
    /episode_number: ep,/.test(boardsSrc) && /note: `分镜生成\$\{ep > 1/.test(boardsSrc));
  ok('逐集生成分镜：先确认调用次数，可取消，失败只丢这一集',
    /每集<b>调用一次模型<\/b>/.test(boardsSrc) && /batchStop = true/.test(boardsSrc)
    && /done\.push\(\{ ep, error: out\.error \}\)/.test(boardsSrc));
  ok('已经有分镜的集默认跳过（重跑不会把同一集翻倍）',
    /id="bs-skip" checked/.test(boardsSrc) && /cfg\.skipExisting && countByEp\.get\(ep\)/.test(boardsSrc));
  ok('跳过判据按**整部剧**统计，不是只看当前这一集（否则其它集永远判成"没有"）',
    /const allShots = await api\.storyboards\(projectId\)/.test(boardsSrc)
    && !/const existing = \(rows \|\| \[\]\)\.filter/.test(boardsSrc));
  ok('缺分集骨架/缺分集剧本时给的是下一步该去哪，不是空转',
    /还没有分集骨架/.test(boardsSrc) && /还没有分集剧本/.test(boardsSrc) && /逐集生成/.test(boardsSrc));

  // ── 分集上下文与逐集生成（批 8 补 8）──
  ok('单集拍表与前情提要都在后端纯函数里（前端不再抄一份渲染逻辑）',
    /function episodeBriefText/.test(storySrc) && /function priorBrief/.test(storySrc)
    && /PRIOR_MAX_DEFAULT/.test(storySrc) && !/function priorBrief/.test(scriptsSrc));
  // 前端 api.js 是**所有页面**都 import 的共享模块：往里插一行插错位置，整个壳层起不来
  // （uitest 只读文本，看不出语法坏；只有真机 browser-test 会红）。这里补一条能解析的棘轮。
  ok('共享模块 api.js 语法可解析（插错位置会让整个壳层白屏）',
    await import(pathToFileURL(path.join(ROOT, 'public/js/api.js')).href).then(() => true).catch(() => false));
  ok('分集接口按集返回"本集大纲 + 前情"（本地计算，一次模型都不调）',
    /'\/api\/story\/episode-brief'/.test(routesSrc) && /story\.priorBrief\(/.test(routesSrc)
    && /story\.episodeBriefText\(/.test(routesSrc));
  ok('剧本记录带集号（逐集生成才能一集一条地存下来）',
    /episode_number: Math\.max\(0, num\(body\.episode_number, 0\)\)/.test(routesSrc)
    && /episode_number: epNo/.test(scriptsSrc));
  ok('剧本页有分集卡：载入本集大纲 / 带上前情 / 逐集生成',
    /id="ep-load"/.test(scriptsSrc) && /id="ep-prior"/.test(scriptsSrc) && /id="gen-eps"/.test(scriptsSrc));
  ok('没有分集骨架时给的是去原著解析的路，不是点不动的按钮',
    /还没有分集骨架/.test(scriptsSrc) && /#\/novel\?project=/.test(scriptsSrc));
  ok('逐集生成：先确认集数范围与调用次数，再逐集落库',
    /逐集生成/.test(scriptsSrc) && /每集<b>调用一次模型<\/b>/.test(scriptsSrc)
    && /async function runBatch\(from, to, withPrior\)/.test(scriptsSrc) && /api\.createScript\(\{/.test(scriptsSrc));
  ok('逐集生成中途失败只记这一集、继续往下走（不把后面几集一起丢掉）',
    /done\.push\(\{ ep, ok: false/.test(scriptsSrc) && /continue;/.test(scriptsSrc));
  ok('逐集生成可取消（已生成的保留，没轮到的不会调用）',
    /batchCancel = true/.test(scriptsSrc) && /if \(batchCancel\)/.test(scriptsSrc));
  ok('前情提要在生成前可见（带了多少集、省了哪几集）',
    /function syncEpStatus/.test(scriptsSrc) && /已省略/.test(scriptsSrc) && /prior\.chars/.test(scriptsSrc));

  // ── 画风写死（批 8 补 7）──
  ok('体检三源合一（卡片 / 镜头绑定 / 提示词画风），不再开第二个入口',
    /style_counts/.test(routesSrc) && /style_issues/.test(routesSrc) && /auditPromptStyle/.test(routesSrc)
    && /style_counts/.test(novel) === false && /style_issues/.test(novel) === false);
  ok('画风词表与 ART_STYLE_MAP 同源（值都在词表里，selftest 另有跨文件棘轮）',
    /STYLE_WORDS/.test(storySrc) && /japanese anime style, thick painterly shading/.test(storySrc));
  ok('修复端点支持删掉写死的画风词，并如实回报改前/改后',
    /code === 'strip_style_word'/.test(routesSrc) && /before, after/.test(routesSrc));
  ok('原著页给画风问题配了修复按钮与确认文案',
    /strip_style_word: '删掉写死的画风词'/.test(novel) && /画风由<b>项目设置<\/b>在使用点统一注入/.test(novel));
  // 批 8 补 39：补提示词的合成搬到服务端，三条禁令随之搬进 `DEFAULT_TEMPLATES` 的两个模板 ——
  // 搬的是位置、不是"可以不要了"：这里改成钉**服务端模板**里有这三条，并钉前端**不再自己拼**
  // （前端再拼一份 = 服务端看不到真正发出去的那一份 = 指纹形同虚设）。
  {
    const pSeed = read(path.join(ROOT, 'lib', 'seed.js'));
    // 只取**这个模板对象**的正文（切到下一个 key: 为止），并从里面单独取出 content 字段 ——
    // 注释里会**引用**被删掉的旧变量名（"{{镜头运动}} 因此删掉"），拿整段做匹配会打在注释上，
    // 断言必须落在真正发出去的那一行（注意事项 11：别让断言因错误的原因通过/失败）
    const segOf = (key) => {
      const i = pSeed.indexOf(`key: '${key}'`);
      if (i < 0) return { all: '', content: '' };
      const rest = pSeed.slice(i);
      const next = rest.indexOf("key: '", 10);
      const all = next > 0 ? rest.slice(0, next) : rest;
      const cm = all.match(/content: '([^']*)'/);
      return { all, content: cm ? cm[1] : '' };
    };
    const imgSeg = segOf('image_prompt').all;
    const vidSeg = segOf('video_prompt').all;
    const imgContent = segOf('image_prompt').content;
    const vidContent = segOf('video_prompt').content;
    ok('补提示词的三条禁令在服务端模板里（画风 / 长相 / 中文人名）',
      /不要写整体画风或媒介词/.test(imgSeg) && /不要写人物长相/.test(imgSeg) && /不要写中文人名/.test(imgSeg)
      && /不要写画风\/媒介词/.test(vidSeg) && /不要写人物长相/.test(vidSeg) && /不要写中文人名/.test(vidSeg));
    ok('模板正文里不写由使用点注入的东西（运镜 / 画风变量不许出现在 content 里）',
      imgContent !== '' && vidContent !== ''
      && !/\{\{镜头运动\}\}|\{\{画风\}\}|\{\{人物长相\}\}/.test(imgContent)
      && !/\{\{镜头运动\}\}|\{\{画风\}\}|\{\{人物长相\}\}/.test(vidContent));
    ok('前端不再自己拼提示词（合成只有服务端一份）',
      !/const who = flat\(s\.characters\)/.test(boardsSrc)
      && !/为以下分镜生成英文图片提示词/.test(boardsSrc)
      && /api\.genStoryboardPrompt\(s\.id, kind\)/.test(boardsSrc));
    ok('人物的兜底（「出场人物」空着时用已绑角色名）在服务端唯一实现里',
      /function promptCastText/.test(storySrc)
      && /const own = str\(shot && shot\.characters\)\.trim\(\)/.test(storySrc)
      && /character_ids/.test(storySrc));
  }

  // ── 润色产物的派生过期（批 8 补 40）──
  // 与补 39 同一条病根：润色真正的输入（来源文本 / 优化模板 / 角色名册）**前端全都有**，
  // 但合成留在页面上，服务端就看不到真正发出去的那一份，也就不可能给它算指纹。
  // 所以这里钉的不是"算得对不对"（那是 selftest/apitest 的事），而是**合成与指纹只在服务端**。
  {
    const scriptsSrc = read(path.join(PUB, 'js/pages/scripts.js'));
    ok('前端不再自己拼润色提示词（合成只有服务端一份）',
      !/tpl\.content \|\| ''\)\.replace\(\/\\{\\{/.test(scriptsSrc)
      && !/roster\.text \? `\$\{roster\.text\}/.test(scriptsSrc)
      && /api\.polishScript\(/.test(scriptsSrc));
    ok('润色改走服务端端点（不再直接打 /api/agnes/text）',
      /polishScript: \(p\) => req\('POST', '\/api\/scripts\/polish'/.test(apiSrc)
      // 合成搬走之后，润色这条路上不该再出现"自己拼 messages 再调模型"
      && !/api\.genText\(/.test(scriptsSrc.split('async function optimize')[1].split('\n  }')[0] || 'x'));
    ok('保存时如实带上"从哪一条、用哪个模板派生的"',
      /source_script_id: resultTemplateId \? \(resultSourceId \|\| null\) : null/.test(scriptsSrc)
      && /source_template_id: resultTemplateId \|\| null/.test(scriptsSrc));
    // 前端只搬运服务端算好的 `plan_digest`（本集上下文），**从不**自己算润色指纹 ——
    // 算一遍传上来，来源一改两边的口径就会分叉（补 37 的病根）。所以这里钉"页面里根本没有它"
    ok('前端**不**自己算润色指纹（算一遍传上来就会与复算口径分叉）',
      !/source_digest/.test(scriptsSrc) && !/\.digest\b/.test(scriptsSrc));
    ok('服务端有唯一的合成与指纹实现（写入点与复算点共用）',
      /function polishInput\(sourceText, tpl, chars, opts = \{\}\)/.test(storySrc)
      && /function polishInputDigest\(sourceText, tpl, chars, opts = \{\}\)/.test(storySrc)
      && /story\.polishInputDigest\(src\.content, tpl, projectCharacters\(src\.project_id\)\)/.test(routesSrc)
      && /polishInputDigest\(src\.content, tpl, chars\)/.test(storySrc));
    ok('指纹一律服务端算（前端传的 source_digest 不许被采信）',
      /patch\.source_digest = \(src && tpl\) \?/.test(routesSrc)
      && !/body\.source_digest/.test(routesSrc));
    ok('润色端点只认 optimize 模板（拿错模板会把整份剧本塞进去，产物看着像模像样）',
      /function tryPolishTemplate\(id\)/.test(routesSrc)
      && /t\.template_type === 'optimize' \? t : null/.test(routesSrc)
      && /优化模板不存在（或它不是优化类模板）/.test(routesSrc));
    ok('模型返回空**不写**（把"这次没成功"变成静默清空是最难发现的一类失败）',
      /模型返回了空内容（结果区保持原样，可重跑）/.test(routesSrc));
    ok('过期标记与它的出口在同一行上（重做入口就在标记旁边）',
      /data-repolish=/.test(scriptsSrc) && /来源已变·点此重润/.test(scriptsSrc)
      && /el\.querySelectorAll\('\[data-repolish\]'\)/.test(scriptsSrc));
    ok('重润**就地更新**那一条（另存会让每重润一次就多一份过期的旧稿）',
      /api\.updateScript\(s\.id, \{[\s\S]{0,160}source_template_id: data\.template_id/.test(scriptsSrc));
    ok('逐行下发润色状态（界面标记读的是服务端结论，不是前端猜的）',
      /polish_state: audit\.states\[r\.id\] \|\| ''/.test(routesSrc)
      && /s\.polish_state === 'stale'/.test(scriptsSrc));
  }

  // ── 生成模板也是输入（批 8 补 41）──
  // 补 12/36/37 建的是剧本的**数据侧**指纹，补 39/40 把"模板也是输入"钉在提示词链与润色链上 ——
  // 这一轮补的是**第一条链自己的模板**。结构上要钉的是"模板在**生成那一刻**记下来"：
  // 保存时再按当前页签取就晚了（用户完全可能生成完切到别的页签再保存）。
  {
    ok('服务端有模板指纹与"模板被改过"的判定（唯一一份实现）',
      /function templateDigest\(tpl\)/.test(storySrc)
      && /function auditScriptTemplate\(scripts, opts = \{\}\)/.test(storySrc)
      && /story\.templateDigest\(genTpl\)/.test(routesSrc)
      && /story\.auditScriptTemplate\(/ .test(routesSrc));
    ok('模板指纹覆盖 system + content（只改 system 也必须被看见）',
      /digestText\(\[system, content\]\.join\('\\n---\\n'\)\)/.test(storySrc));
    ok('指纹一律服务端算（前端传的 template_digest 不许被采信）',
      /row\.template_digest = genTpl \? story\.templateDigest\(genTpl\) : ''/.test(routesSrc)
      && !/body\.template_digest/.test(routesSrc));
    // 这条是这一轮的关键：模板 id 必须在**生成那一刻**记进页面状态，而不是保存时按当前页签现取
    ok('模板在**生成那一刻**记下来（保存时再取会记成别的模板）',
      /resultGenTemplateId = tpl && tpl\.id \? tpl\.id : null/.test(scriptsSrc)
      && /template_id: resultGenTemplateId \|\| null/.test(scriptsSrc)
      && !/template_id: tplOf\(/.test(scriptsSrc));
    ok('逐集生成那条路也记模板（否则那批行的模板维度永远是"没记"）',
      /template_id: tpl\.id,\s+\/\/ 批 8 补 41/.test(scriptsSrc));
    // 三条路（润色产出 / 载入既有 / 清空结果）都必须把它清掉：少一条，那份内容就会冒充
    // "这次生成"的产物去记另一个模板的指纹（数出现次数比钉某一处的上下文更稳）
    ok('载入 / 清空 / 润色之后不冒充"这次生成"的模板',
      /resultGenTemplateId = null; \/\/ 润色产物的来源是/.test(scriptsSrc)
      && /resultGenTemplateId = null; \/\/ 载入的既有内容/.test(scriptsSrc)
      // 行首（缩进后直接是它）才算"清空点"——`let resultGenTemplateId = null` 那行是声明，不能数进来
      && (scriptsSrc.match(/\n\s*resultGenTemplateId = null;/g) || []).length === 3);
    ok('标记与出口在同一行上，且出口**切到用这个模板的那个页签**',
      /data-regen-tpl=/.test(scriptsSrc) && /模板已改·去重生成/.test(scriptsSrc)
      && /el\.querySelectorAll\('\[data-regen-tpl\]'\)/.test(scriptsSrc)
      && /tab = want;/.test(scriptsSrc) && /syncViewParams\(\{ tab \}\);/.test(scriptsSrc));
    ok('逐行下发模板状态（界面标记读的是服务端结论）',
      /template_state: tplAudit\.states\[r\.id\] \|\| ''/.test(routesSrc)
      && /s\.template_state === 'stale'/.test(scriptsSrc));
    // 钉**收口那一行判据本身**，不是"出现过一个 latest.get(key)" ——
    // 第一版钉的是短语，而 `const prev = latest.get(key);` 那行一直在，把收口逻辑换掉它照样绿
    //（注意事项 11 的第四次复发：钉了"这个词出现过"，没钉"这件事发生了"；一条正对照抓出来的）
    ok('只判**槽位最新那条**（否则改一次模板就刷出一串早被取代的草稿）',
      /const latest = new Map\(\)/.test(storySrc)
      && /if \(!prev \|\| String\(s\.created_at \|\| ''\) >= String\(prev\.created_at \|\| ''\)\) latest\.set\(key, s\)/.test(storySrc)
      && /for \(const s of latest\.values\(\)\)/.test(storySrc));
  }

  // ── 角色名册（批 8 补 6）──
  // 批 8 补 37：名册是喂给模型的输入之一，而"输入变了要报过期"靠服务端算的指纹 ——
  // 所以渲染只许有**一处**（前端那份已删）。这里钉两件事：服务端有唯一实现，
  // 且前端不再自己算（两处各写一遍排序/截断 = "提示词里的名册与指纹里的名册不是同一份"）。
  ok('角色名册的渲染只有服务端一处（前端那份必须删掉，否则两处迟早分叉）',
    /function characterRoster\(chars, opts = \{\}\)/.test(storySrc)
    && /必须使用下列本名/.test(storySrc) && /不要写进 image_prompt \/ video_prompt/.test(storySrc)
    && !/characterRoster/.test(consts)
    && !/export function characterRoster/.test(scriptsSrc) && !/export function characterRoster/.test(boardsSrc));
  ok('名册排序不依赖运行环境（顺序进指纹，localeCompare 会让同一份输入在不同机器上算出不同指纹）',
    (() => {
      const i = storySrc.indexOf('function characterRoster');
      if (i < 0) return false;
      const j = storySrc.indexOf('\n}', i);
      // 注释里**会**提到 localeCompare（正是为了说明"不许用"），所以只查代码；
      // 同时正向要求那把码点比较器真的在（否则"函数不存在"也能让这条绿 —— 注意事项 11）
      const body = storySrc.slice(i, j).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      return body.length > 200 && !/localeCompare/.test(body) && /const byName = /.test(body);
    })());
  ok('名册走一个端点（两个生成入口都调它，不各算一遍）',
    /storyRoster: \(body\) => req\('POST', '\/api\/story\/roster'/.test(apiSrc)
    && /api\.storyRoster\(/.test(scriptsSrc) && /api\.storyRoster\(/.test(boardsSrc));
  ok('分镜生成把名册写进请求体（不是只在前端显示）',
    /const roster = await loadRoster\(text\)/.test(boardsSrc) && /\$\{roster\.text \? `\$\{roster\.text\}\\n\\n` : ''\}\$\{text\}/.test(boardsSrc));
  ok('分镜生成的系统提示禁止把长相写进提示词（长相只由使用点注入一次）',
    /不要写人物长相/.test(boardsSrc) && /characters\(出场人物\) 必须使用角色名册里的本名/.test(boardsSrc));
  ok('分镜页进页面就说明会不会带上名册（不留到生成完才发现名字对不上）',
    /id="roster-hint"/.test(boardsSrc) && /loadRoster\(''\)/.test(boardsSrc) && /个角色名册/.test(boardsSrc));
  ok('剧本生成也带名册（名字对齐要发生在最上游）',
    /await refreshRoster\(\)/.test(scriptsSrc) && /roster = r\.ok/.test(scriptsSrc)
    && /const ctx = \[roster\.text/.test(scriptsSrc) && /ctx\.join\('\\n\\n'\)/.test(scriptsSrc));
  ok('剧本页在门禁计数之前刷新名册（显示的字数与发出的字数必须是同一份）',
    scriptsSrc.indexOf('await refreshRoster()') < scriptsSrc.indexOf('await gateBeforeGenerate(tpl)'));
  // 批 8 补 37：载入某一集时，名册随 brief 一起回来且与 input_digest **同源** ——
  // 此时再"现算一份"就会让提示词里的名册与指纹里的名册分叉（改了角色会漏报过期）
  ok('载入某一集就采纳服务端那份名册（与指纹同源），不再现算一份把它盖掉',
    /if \(r\.data\.roster_text !== undefined\)/.test(scriptsSrc)
    && /roster_count/.test(scriptsSrc)
    && /if \(!epDigest\) await refreshRoster\(\)/.test(scriptsSrc));
  // 批 8 补 40：这条钉**跟着搬家**（不是删掉）—— 润色的合成搬到服务端之后，
  // "润色也带名册"这句话仍然必须成立，只是兑现它的地方从页面变成了 `story.polishInput`
  // （而且名册按**被润色的那份文本**算，服务端复算得到，判定时才能用同一个函数重算）。
  ok('润色也带名册（润色会重写全文，改名 = 下游全部失配）',
    /const roster = characterRoster\(chars, \{ text: src, limit: opts\.rosterLimit \}\)/.test(storySrc)
    && /const user = polishUser\(tpl, src, roster\.text\)/.test(storySrc)
    && !/const prompt = roster\.text \? `\$\{roster\.text\}/.test(scriptsSrc));
  ok('体检把"名字在角色库里找不到"单独报一类（名册的验收环）',
    /shot_char_unknown/.test(storySrc) && /UNKNOWN_NAME_STOP/.test(storySrc) && /splitShotCharacters/.test(storySrc));

  // 批 8 补 38：分镜提示词真正发出去的是 `角色名册 + 正文`（补 6 加的），而它的过期判定
  // 从前只哈希正文 —— 加了角色/改了长相，模型下次看到不同的名册，指纹却一个字都不变
  // （与补 36/37 同一类病，只是发生在"剧本 → 分镜"这一层）。
  // 两处必须**同一个构造函数**：入库那一刻（写入点）与体检复算（判定侧）。
  ok('分镜指纹把名册算进去（唯一实现），且判定侧不再退回"只哈希正文"',
    (storySrc.match(/function storyboardInputDigest\(/g) || []).length === 1
    && /storyboardInputDigest\(curScript, opts\.characters/.test(storySrc)
    && !/digestText\(curScript\.content\)/.test(storySrc));
  ok('分镜指纹复用同一个名册渲染器（不是第二份拼装）',
    (() => {
      const i = storySrc.indexOf('function storyboardInputDigest(');
      if (i < 0) return false;
      const j = storySrc.indexOf('\n}', i);
      const body = storySrc.slice(i, j);
      return body.length > 100 && /characterRoster\(chars, \{ text/.test(body)
        && /digestText\(/.test(body);
    })());
  // 自带一个取函数体的助手：下面那个 `bodyAt` 在本文件里是**后**定义的（const，TDZ），
  // 提前借用它会以 ReferenceError 崩掉整轮 —— 崩掉也算"红"，但看不出哪几条钉在管（注意事项 14）
  const fnBody = (src, sig) => {
    const i = src.indexOf(sig);
    if (i < 0) return '';
    let d = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') d++;
      else if (src[j] === '}') { d--; if (!d) return src.slice(i, j + 1); }
    }
    return '';
  };
  {
    const sd = fnBody(routesSrc, 'function sourceDigest(');
    ok('写入点按**剧本所属项目**取角色算指纹（跨项目不该互相干扰）',
      /story\.storyboardInputDigest\(sc,/.test(sd) && /c\.project_id === sc\.project_id/.test(sd)
      && /store\.list\('characters'/.test(sd), sd.slice(0, 200));
  }
  {
    const st = fnBody(routesSrc, "on('GET', '/api/story/staleness'");
    ok('判定侧把角色一并交给体检（漏传 → 复算退回"只哈希正文" → 每一集永久报过期）',
      /characters: store\.list\('characters'/.test(st), st.slice(0, 240));
  }

  // ── 镜头绑定自动匹配与镜头侧体检（批 8 补 5）──
  ok('api.js 有自动匹配方法与正确路径',
    /storyboardsAutoBind: \(body\)/.test(apiSrc) && /'\/api\/storyboards\/auto-bind'/.test(apiSrc));
  ok('后端注册了自动匹配端点', /on\('POST', '\/api\/storyboards\/auto-bind'/.test(routesSrc));
  {
    const bodyAt = (src, sig) => {
      const i = src.indexOf(sig);
      if (i < 0) return '';
      let d = 0;
      for (let j = i; j < src.length; j++) {
        if (src[j] === '{') d++;
        else if (src[j] === '}') { d--; if (!d) return src.slice(i, j + 1); }
      }
      return '';
    };
    const body = bodyAt(routesSrc, "on('POST', '/api/storyboards/auto-bind'");
    ok('自动匹配端点不引用任何模型调用（名字匹配是可判定的，不该花钱）',
      body.length > 400 && !/agnes\.|fetchInternal|agnesFetch/.test(body), body.slice(0, 60));
  }
  ok('分镜页有自动匹配按钮与"先看会绑什么再决定"的干跑',
    /id="sb-autobind"/.test(boardsSrc) && /dry_run: true/.test(boardsSrc) && /async function autoBind\(\)/.test(boardsSrc));
  ok('干跑结果先弹确认再落库（列镜头号与名字，并标出推断项）',
    /dry\.data\.matches/.test(boardsSrc) && /提示词推断/.test(boardsSrc) && /okText: '就这么绑'/.test(boardsSrc));
  ok('生成分镜后自动绑一次（只吃高置信那档，不猜）',
    /strong_only: true/.test(boardsSrc) && /并按「出场人物」自动绑定/.test(boardsSrc));
  ok('绑定是并集而不是覆盖（人手工绑过的不被抹掉）', /new Set\(\[\.\.\.\(Array\.isArray\(s\.character_ids\)/.test(routesSrc));
  ok('原著页体检渲染镜头侧问题（同一份报告里，不再开第二个入口）',
    /shot_issues/.test(routesSrc) && /shots_scanned/.test(novel) && /个镜头/.test(novel));
  ok('修复按钮文案表覆盖新动作（不出现含糊的"一键修复"）',
    /FIX_LABEL = \{/.test(novel) && /bind_shot_target: '绑到这些镜头'/.test(novel) && /lock_shot_char: '锁定该角色'/.test(novel));
  ok('修复请求带上 target_id 与 shot_ids（按目标修复，不做"能匹配的都绑上"）',
    /target_id: issue\.target_id, shot_ids: issue\.shot_ids/.test(novel));
  // 问题码（shot_char_unbound）与修复动作码（bind_shot_target）是两件事：
  // 第一版把 it.code 当修复码发给后端，界面按钮点了会 400（浏览器契约测试抓到的）
  ok('按钮发的是修复动作码而不是问题码', /data-audit-fix="\$\{esc\(it\.fix_code \|\| it\.code\)\}"/.test(novel));
  ok('锁定前弹确认并说明"锁了就是每个镜头都注入"',
    /锁定「\$\{esc\(issue\.target_name\)\}」后/.test(novel) && /每个<\/b>镜头都会逐字注入/.test(novel));

  // ── 分集大纲骨架（批 8 补 4）──
  // 注：图标名拼错（`icon()` 对不认识的名字静默回落到 info 图标）**已有**棘轮覆盖（见上文"图标 X 已定义"），
  // 本轮一度想再加一条逐文件比对，发现是重复钉就删掉了 —— 同一件事不要钉两遍（对照 S 证明那条钉是敏感的）。
  ok('原著页有分集骨架入口与结果容器', /id="nov-outline"/.test(novel) && /id="nov-outline-box"/.test(novel));
  ok('分集骨架走 api.js 的 storyEpisodes（不自己拼 fetch）',
    /storyEpisodes: \(opts = \{\}\)/.test(apiSrc) && /\/api\/story\/episodes\?/.test(apiSrc)
    && /api\.storyEpisodes\(\{ projectId, sourceId/.test(novel));
  ok('后端注册了分集骨架端点', /on\('GET', '\/api\/story\/episodes'/.test(routesSrc));
  {
    const bodyAt = (src, sig) => {
      const i = src.indexOf(sig);
      if (i < 0) return '';
      let d = 0;
      for (let j = i; j < src.length; j++) {
        if (src[j] === '{') d++;
        else if (src[j] === '}') { d--; if (!d) return src.slice(i, j + 1); }
      }
      return '';
    };
    const body = bodyAt(routesSrc, "on('GET', '/api/story/episodes'");
    ok('分集骨架端点不引用任何模型调用（切集是可判定的，不该花钱）',
      body.length > 200 && !/agnes\.|fetchInternal|agnesFetch/.test(body), body.slice(0, 60));
  }
  ok('下限可反复调（输入框 + 重新切分按钮，且说明不花钱）',
    /id="nov-outline-per"/.test(novel) && /data-outline-recut/.test(novel) && /调拍数不花钱/.test(novel));
  ok('骨架可复制、可带入剧本', /data-outline-copy/.test(novel) && /data-outline-toscript/.test(novel));
  ok('带入走既有 hash 链路并带上 outline 参数',
    /outline: String\(outlinePer\)/.test(novel) && /bible: sourceId/.test(novel));
  ok('骨架来源标注了切分依据（stage/mixed/count 三种都要说人话）',
    /BASIS_LABEL = \{/.test(novel) && /stage:/.test(novel) && /count:/.test(novel));
  ok('没有剧情卡时明确提示先解析（不静默给空骨架）', /还没有剧情卡/.test(novel));
  ok('scripts.js 认 outline 参数并走分集骨架载荷',
    /const outlinePer = Number\(params\.outline\)/.test(read(path.join(PUB, 'js', 'pages', 'scripts.js')))
    && /api\.storyEpisodes\(\{ projectId, sourceId: source, perEpisode: outlinePer \}\)/.test(read(path.join(PUB, 'js', 'pages', 'scripts.js'))));
  ok('骨架优先落「本集大纲/剧情梗概」这类字段（pickBibleVar 传 plot）',
    /pickBibleVar\(vars, outlinePer \? \['plot'\] : kinds, fields\)/.test(read(path.join(PUB, 'js', 'pages', 'scripts.js'))));

  // ── 一致性体检（批 8 补 3）──
  ok('原著页有体检入口与结果容器', /id="nov-audit"/.test(novel) && /id="nov-audit-box"/.test(novel));
  ok('体检走 api.js 的两个方法（不自己拼 fetch）',
    /storyAudit: \(opts = \{\}\)/.test(apiSrc) && /storyAuditFix: \(body\)/.test(apiSrc)
    && /api\.storyAudit\(\{ projectId/.test(novel)
    // 允许换行/多字段：钉的是"带 project_id 与 code 调这个方法"，不是某一行的排版
    && /api\.storyAuditFix\(\{[\s\S]{0,120}?project_id: projectId[\s\S]{0,60}?code[,:]/.test(novel));
  ok('api.js 的体检端点路径正确',
    /\/api\/story\/audit\?/.test(apiSrc) && /'\/api\/story\/audit\/fix'/.test(apiSrc));
  ok('后端注册了体检与修复两个端点', /on\('GET', '\/api\/story\/audit'/.test(routesSrc) && /on\('POST', '\/api\/story\/audit\/fix'/.test(routesSrc));
  // "体检不花钱"是这一批的核心承诺：源码级钉死它不碰模型（行为层另有 apitest 数调用次数）
  {
    // bodyOf 定义在 4.1 那个块里（块级作用域），本组要自己来一份
    const bodyAt = (src, sig) => {
      const i = src.indexOf(sig);
      if (i < 0) return '';
      let d = 0;
      for (let j = i; j < src.length; j++) {
        if (src[j] === '{') d++;
        else if (src[j] === '}') { d--; if (!d) return src.slice(i, j + 1); }
      }
      return '';
    };
    const body = bodyAt(routesSrc, "on('GET', '/api/story/audit'");
    ok('体检端点不引用任何模型调用（纯本地判定）',
      body.length > 80 && !/agnes\.|fetchInternal|agnesFetch/.test(body), body.slice(0, 60));
    const fixBody = bodyAt(routesSrc, "on('POST', '/api/story/audit/fix'");
    ok('修复端点也不引用模型调用（纯本地收敛）', fixBody.length > 200 && !/agnes\.|fetchInternal|agnesFetch/.test(fixBody));
  }
  ok('合并同名卡前必须确认（不可逆操作不能一点就干）',
    /const okGo = await confirm\(\{/.test(novel) && /if \(!okGo\) return;/.test(novel));
  ok('冲突字段会先告诉用户（合并只能留一个说法，不能静默丢信息）',
    /conflicts \.length|conflicts\b/.test(novel) && /存在不同说法/.test(novel));
  ok('修复后重新拉卡片并重跑体检（用户能立刻看到结果变化）',
    /await loadCards\(\);\s*\n\s*await runAudit\(\);/.test(novel));
  ok('修复按钮有防连点（setBusy 包住异步请求）', /setBusy\(btn, true\);/.test(novel) && /setBusy\(btn, false\);/.test(novel));
  ok('体检报告区分"要处理"与"可优化"（不是一锅粥的警告）',
    /LEVEL_LABEL = \{ warn: '要处理', info: '可优化' \}/.test(novel));
  ok('卡片工作台工具栏允许换行（否则窄视口横向溢出）',
    /<div class="row wrap" style="margin-bottom:10px;row-gap:6px">/.test(novel));
  ok('复制回注按钮真的渲染了（此前 data-copy 处理器是死代码）',
    /id="nov-copy"/.test(novel) && !/data-copy/.test(novel));
  ok('scripts.js 消费 bible 参数并落到模板变量', /async function applyBible\(\)/.test(read(path.join(PUB, 'js', 'pages', 'scripts.js'))));
  // 批 8 补 4 起要多抹一个 outline：写成"三个键都在同一个 syncViewParams 调用里清掉"，
  // 这样新增载荷时必须同步清 URL，而键的顺序变化不会误伤（原来钉的是字面顺序）
  {
    const sjs = read(path.join(PUB, 'js', 'pages', 'scripts.js'));
    const clear = (key) => new RegExp(`syncViewParams\\(\\{[^}]*${key}: ''[^}]*\\}\\)`).test(sjs);
    ok('带入后从 URL 抹掉参数（刷新不重复覆盖用户后来的修改）',
      clear('bible') && clear('kinds') && clear('outline'));
  }
  // 落位表：纯函数，直接断言
  const C = await import(pathToFileURL(path.join(PUB, 'js', 'consts.js')).href);
  const vals = new Map([['本集大纲', ''], ['人物', '已写好的内容']]);
  eq('落位优先取"名字匹配且为空"的字段', C.pickBibleVar(['人物', '本集大纲'], ['plot', 'world'], vals), { name: '本集大纲', matched: true });
  eq('名字匹配但都非空时按名字落位（不静默丢内容）',
    C.pickBibleVar(['人物'], ['character'], vals), { name: '人物', matched: true });
  eq('没有名字匹配时兜底到第一个空着的长文本框', C.pickBibleVar(['目标集数', '本集大纲'], ['prop'], new Map([['本集大纲', '']])), { name: '本集大纲', matched: false });
  eq('既无匹配又无空长文本框时返回 null（调用方必须告知用户，不许静默丢）',
    C.pickBibleVar(['目标集数'], ['prop'], new Map()), null);
  eq('变量名归一化：{{人物卡}}/{{人物设定}} 等价', C.bibleKindsForVar('人物卡'), ['character']);
  eq('变量名归一化不误伤具体名字（本集大纲属于 plot）', C.bibleKindsForVar('本集大纲'), ['plot', 'world']);
  ok('灵敏度对照：不认识的变量名不落位', C.bibleKindsForVar('目标集数').length === 0);
  ok('批量入资产库前告知跳过语义（幂等，不制造重复角色）', /已在库里的会自动跳过/.test(novel));
}

// ── 批 8 补 36：逐集生成也要看见全剧设定 ────────────────────────
group('全剧设定的单一来源与两条路合流（批 8 补 36）');
{
  const storySrc = read(path.join(ROOT, 'lib', 'story.js'));
  const routeSrc = read(path.join(ROOT, 'lib', 'routes.js'));
  const scriptsSrc36 = read(path.join(PUB, 'js', 'pages', 'scripts.js'));
  // 按函数名切出函数体（story.js 的顶层函数收在行首的 `}`）
  const fnBody = (name) => {
    const at = storySrc.indexOf(`function ${name}(`);
    if (at < 0) return '';
    const end = storySrc.indexOf('\n}', at);
    return end < 0 ? '' : storySrc.slice(at, end);
  };

  // ① **一份实现**：`【全剧设定】` 全文件只许出现一次（就是 settingLines 里那一行）。
  //    抄第二份渲染的代价不是多写几行，而是从此"全剧大纲"与"逐集生成"两套设定会各自漂移 ——
  //    而它们本该是同一份（补 9「一段脚本→某一集分镜只有一个实现」、补 30「两把尺子」同一纪律）。
  eq('「全剧设定」小节的渲染全项目只有一处（多一份就迟早分叉）',
    (storySrc.match(/'【全剧设定】'/g) || []).length, 1);
  eq('「全剧时间线」小节同理只有一处',
    (storySrc.match(/'【全剧时间线】'/g) || []).length, 1);
  ok('两处都在 settingLines 里（唯一的那份实现）',
    fnBody('settingLines').includes("'【全剧设定】'") && fnBody('settingLines').includes("'【全剧时间线】'"));

  // ② 分集结果**带着**设定（调用方想忘也忘不掉），而不是让每条路自己传
  ok('planEpisodes 把设定挂在分集结果上（setting_text 由 settingLines 推出）',
    /setting_text: settingLines\(list\)\.join\('\\n'\)/.test(fnBody('planEpisodes')));

  // ③ 两条路都从那一份取 —— 而且**不许**再内联按 kind 渲染
  ok('单集拍表从 plan.setting_text 取设定（这是补 36 的核心修复）',
    /str\(\(plan \|\| \{\}\)\.setting_text\)/.test(fnBody('episodeBriefText')));
  ok('单集拍表里没有第二份按 kind 渲染的设定',
    !/kind === 'world'/.test(fnBody('episodeBriefText')) && !/kind === 'timeline'/.test(fnBody('episodeBriefText')));
  ok('全剧大纲也从 plan.setting_text 取（两条路取同一份）',
    /p\.setting_text === undefined \? settingLines\(list\)/.test(fnBody('episodeOutlineText')));
  ok('全剧大纲里没有第二份按 kind 渲染的设定',
    !/kind === 'world'/.test(fnBody('episodeOutlineText')) && !/kind === 'timeline'/.test(fnBody('episodeOutlineText')));
  // 指纹跟着设定走：它复用 episodeBriefText，所以**不需要**任何额外代码
  ok('输入指纹复用单集拍表（设定因此自动进指纹，没有第二处需要同步的地方）',
    /episodeBriefText\(plan, ep\)/.test(fnBody('episodeInputDigest'))
    && !/setting_text/.test(fnBody('episodeInputDigest')));

  // ④ 信息卡的**六个字段**都要渲染（从前只有 题材/基调，另外四个抽出来却到不了任何提示词）
  {
    const wb = fnBody('cardLine');
    const worldBranch = wb.slice(wb.indexOf("c.kind === 'world'"), wb.indexOf("c.kind === 'world'") + 700);
    ['题材', '基调', '世界观', '主题', '一句话简介', '主线'].forEach((label) => {
      ok(`cardLine 渲染信息卡的「${label}」（抽出来却没人读的字段等于没抽）`, worldBranch.includes(`\`${label}：`));
    });
  }

  // ⑤ 界面要能说出"带了什么、有多大"：数字全来自服务端，前端只消费不复算
  ok('episode-brief 回传 setting_chars / world_count / timeline_count（可见性）',
    /setting_chars: str\(plan\.setting_text\)\.length/.test(routeSrc)
    && /world_count: plan\.world_count/.test(routeSrc)
    && /timeline_count: plan\.timeline_count/.test(routeSrc));
  ok('故事脚本页**读**了这三个字段（只被回传、没人读的字段等于没有）',
    /Number\(r\.data\.setting_chars\)/.test(scriptsSrc36)
    && /r\.data\.world_count/.test(scriptsSrc36)
    && /r\.data\.timeline_count/.test(scriptsSrc36));
  ok('载入提示如实说出带没带全剧设定（带没带在界面上长得一样就白带了）',
    /含全剧设定/.test(scriptsSrc36) && /未带全剧设定/.test(scriptsSrc36));
  ok('前端**不**自己拼设定块（拼接只有服务端一份）', !/【全剧设定】/.test(scriptsSrc36));
}

console.log(`  前端检查：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('  失败项：');
  failures.forEach((f) => console.log(`   ✗ ${f}`));
}
console.log(`${'═'.repeat(52)}\n`);
process.exit(fail ? 1 : 0);
