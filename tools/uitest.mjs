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
import { fileURLToPath } from 'node:url';

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
  const pages = ['dashboard', 'projects', 'scripts', 'storyboards', 'images', 'videos', 'tasks', 'assets', 'settings'];
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
  ok('4.1 后端使用点注入（图+视频 t2v）', routesSrc.includes('function artStylePhrase')
    && routesSrc.includes("artStylePhrase(str(body.prompt).trim(), styleOf(body.project_id))")
    && (routesSrc.match(/artStylePhrase\(str\(body\.prompt\)/g) || []).length >= 2);
  const keysOf = (src) => {
    const m = src.match(/ART_STYLE_MAP = \{([\s\S]*?)\n\};/);
    return m ? [...m[1].matchAll(/'([^']+)':/g)].map((x) => x[1]).sort().join(',') : '';
  };
  ok('4.1 前后端画风映射表同构', keysOf(routesSrc) !== '' && keysOf(routesSrc) === keysOf(constsSrc));
  ok('4.1 LLM 链禁烘画风（拆镜+补提示词，均在 storyboards）', (sbSrc.match(/不要写整体画风/g) || []).length >= 2);
  ok('4.2 分镜提示词计算态预览', sbSrc.includes('artStylePhrase') && sbSrc.includes('+画风'));
  { // 1.6 防增量棘轮：字号地坪 11px 永不回退；裸 font-size 总量只减不增
    const pageFiles = ['dashboard','projects','scripts','storyboards','images','videos','assets','tasks','settings']
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
  const dead = pairs.filter(([a, v]) =>
    !srcAll.includes(`data-${a}="${v}"`) && !srcAll.includes(`data-${a}='${v}'`) && !(a === 'sec' && secIds.includes(v)));
  ok('测试中的字面量属性选择器均存在于源码', dead.length === 0,
    dead.map(([a, v]) => `[data-${a}="${v}"]`).join(',') || `${pairs.length} 个全部命中`);

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

console.log(`  前端检查：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('  失败项：');
  failures.forEach((f) => console.log(`   ✗ ${f}`));
}
console.log(`${'═'.repeat(52)}\n`);
process.exit(fail ? 1 : 0);
