// scripts/ 下启动/重启/停止脚本的真机契约（自证式：每条结论都有进程/端口/健康体作证据）
//
// 为什么值得单独一个工具：这些脚本是**管进程**的，而管进程最容易出的两类错都不会报错 ——
//   ① 照着过期的 pid 文件 kill，误杀一个无关进程（PID 会被系统复用）；
//   ② 假设"我让它监听 5178 它就在 5178"（server.js 在端口被别的程序占用时会自动 +1 重试）。
// 两者都只在真机上才看得见，所以这里全部**真起进程、真发信号、真探测**。
//
// 安全：全程用**临时数据目录 + 高位端口**（运行期状态跟着数据目录走，见 scripts/lib.sh），
// 所以不会碰到线上实例的 pid 文件，也不会占用 5178。
//
// 用法：node tools/scripts-check.mjs
// 退出码：0 = 全过；1 = 违例；2 = 环境冲突（预检端口被占，本次结论不可用）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const probe = async (port, ms = 700) => {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch { return null; }
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ── 环境预检：本工具要验证"端口漂移"，所以基准端口与它 +1 都必须空闲 ──────────────
const BASE = 5600 + Math.floor(Math.random() * 40);
for (const p of [BASE, BASE + 1]) {
  const h = await probe(p);
  if (h) {
    console.log(`⚠ 环境冲突：端口 ${p} 已被占用（data_home=${h.data_home || '未知'}），无法验证端口漂移行为。`);
    console.log('  这不是产品违例，本次结论不可用（exit 2）。请先释放该端口再跑。');
    process.exit(2);
  }
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agnes-scripts-'));
const PID_FILE = path.join(HOME, 'run', 'server.pid');
const readPidFile = () => {
  try { return fs.readFileSync(PID_FILE, 'utf8').trim(); } catch { return ''; }
};
const env = (port) => ({ ...process.env, PORT: String(port), AGNES_STUDIO_HOME: HOME, NO_OPEN: '1' });

// 跑一个脚本，返回 {status, out}（stdout+stderr 合并 —— 用户看到的也是两股合起来）
const run = (name, port) => {
  const r = spawnSync('bash', [path.join(SCRIPTS, name)], { env: env(port), encoding: 'utf8', timeout: 90000 });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

const results = [];
const check = (name, pass, evidence) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} — ${evidence}`);
};

let decoy = null;         // 无关进程（验证"拒绝误杀"用）
let foreign = null;       // 外来端口占用者
const cleanup = () => {
  try { run('stop.sh', BASE); } catch { /* 收尾尽力而为 */ }
  try { run('stop.sh', BASE + 1); } catch { /* 上面漂移时停在这个端口 */ }
  if (decoy && alive(decoy.pid)) decoy.kill('SIGKILL');
  if (foreign) foreign.close();
  fs.rmSync(HOME, { recursive: true, force: true });
};

try {
  // ── 1. 没在运行时：status 必须说"没在运行"且退出码可脚本化（3） ──────────────
  let r = run('status.sh', BASE);
  check('没在运行时 status.sh 退出码 3（可脚本化，不是靠解析文案）', r.status === 3, `status=${r.status}`);
  check('status.sh 明说"没在运行"', /没在运行/.test(r.out), r.out.trim().split('\n')[0]);

  // ── 2. start：pid 文件 + 健康体 + 实际端口三者必须一致 ──────────────────────
  r = run('start.sh', BASE);
  const pf = readPidFile();
  const startedPid = Number(pf.split(/\s+/)[0]);
  const startedPort = Number(pf.split(/\s+/)[1]);
  const h = await probe(BASE);
  check('start.sh 退出码 0 且报"已启动"', r.status === 0 && /已启动/.test(r.out), `status=${r.status}`);
  check('pid 文件记下 <pid> <port>', startedPid > 0 && startedPort === BASE, `pid 文件="${pf}"`);
  check('健康体里的 pid 就是 pid 文件里的那个（不是"有东西在跑"就算成功）',
    !!h && h.pid === startedPid, `health.pid=${h && h.pid} pid文件=${startedPid}`);
  check('健康体的 data_home 指向本次临时数据目录（证明是我们的实例）',
    !!h && path.resolve(h.data_home) === path.resolve(HOME), `health.data_home=${h && h.data_home}`);

  // ── 3. start 幂等：同数据目录不许起第二个（X4 防护） ────────────────────────
  r = run('start.sh', BASE);
  const pf2 = readPidFile();
  check('已在运行时 start.sh 不重复启动（pid 不变、退出码 0）',
    r.status === 0 && /已在运行/.test(r.out) && pf2 === pf, `status=${r.status} pid文件="${pf2}"`);

  // ── 4. restart：pid 必须换，旧进程必须真的没了 ─────────────────────────────
  r = run('restart.sh', BASE);
  const pf3 = readPidFile();
  const newPid = Number(pf3.split(/\s+/)[0]);
  const h3 = await probe(BASE);
  check('restart.sh 退出码 0 且换了 pid', r.status === 0 && newPid > 0 && newPid !== startedPid,
    `旧=${startedPid} 新=${newPid}`);
  check('restart 后旧进程真的没了（"说了停止"≠"真的停止"）', !alive(startedPid), `kill -0 ${startedPid} → 不存在`);
  check('restart 后健康体是新进程', !!h3 && h3.pid === newPid, `health.pid=${h3 && h3.pid}`);

  // ── 5. 端口被外来程序占用 → 实际端口必须"问出来"，不能假设 ──────────────────
  run('stop.sh', BASE);
  foreign = net.createServer();
  await new Promise((res, rej) => { foreign.once('error', rej); foreign.listen(BASE, '127.0.0.1', res); });
  r = run('start.sh', BASE);
  const pf4 = readPidFile();
  const driftPid = Number(pf4.split(/\s+/)[0]);
  const driftPort = Number(pf4.split(/\s+/)[1]);
  const hDrift = await probe(BASE + 1);
  check('端口被别的程序占着时，start.sh 报出**实际**端口（BASE+1）并给出警告',
    r.status === 0 && driftPort === BASE + 1 && /被别的程序占着/.test(r.out),
    `pid 文件="${pf4}" 输出含警告=${/被别的程序占着/.test(r.out)}`);
  check('漂移后的实例健康体对得上（pid 与 data_home 都对）',
    !!hDrift && hDrift.pid === driftPid && path.resolve(hDrift.data_home) === path.resolve(HOME),
    `health.pid=${hDrift && hDrift.pid} 期望=${driftPid}`);
  r = run('status.sh', BASE);
  check('status.sh 报的端口与事实一致（读的是 pid 文件里的实际端口）',
    r.status === 0 && r.out.includes(`:${BASE + 1}`), `输出含 :${BASE + 1}=${r.out.includes(`:${BASE + 1}`)}`);

  // ── 6. 安全闸门：过期 pid 文件指向一个**活着的无关进程** → 必须拒绝动手 ───────
  run('stop.sh', BASE);
  run('stop.sh', BASE + 1);
  foreign.close(); foreign = null;
  await sleep(300);
  decoy = spawn('sleep', ['30'], { stdio: 'ignore' });
  await sleep(300);
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, `${decoy.pid} ${BASE + 5}\n`);   // 端口上什么都没有，只剩"活着的 pid"
  r = run('stop.sh', BASE + 5);
  check('过期 pid 文件指向活着的无关进程时，stop.sh **拒绝**动手（退出码 1）', r.status === 1, `status=${r.status}`);
  check('无关进程没有被误杀（PID 复用的最坏后果）', alive(decoy.pid), `kill -0 ${decoy.pid} → ${alive(decoy.pid) ? '存活' : '被杀'}`);
  check('拒绝时保留 pid 文件（不清掉证据，让人能人工核对）', readPidFile() !== '', `pid 文件="${readPidFile()}"`);
  decoy.kill('SIGKILL'); decoy = null;
  fs.rmSync(PID_FILE, { force: true });

  // ── 7. 收尾：stop 之后端口释放、pid 文件清掉、status 回到 3 ──────────────────
  r = run('start.sh', BASE);
  r = run('stop.sh', BASE);
  check('stop.sh 退出码 0 且清掉 pid 文件', r.status === 0 && readPidFile() === '', `status=${r.status} pid 文件="${readPidFile()}"`);
  check('stop 之后端口上不再有我们的实例', !(await probe(BASE)), `health@${BASE}=无`);
  r = run('status.sh', BASE);
  check('stop 之后 status.sh 回到"没在运行"（3）', r.status === 3, `status=${r.status}`);
  r = run('stop.sh', BASE);
  check('重复 stop 是幂等的（退出码 3，不报错）', r.status === 3, `status=${r.status}`);
  r = run('restart.sh', BASE);
  check('没在运行时 restart.sh 直接起（退出码 0）', r.status === 0 && /直接启动/.test(r.out), `status=${r.status}`);
  run('stop.sh', BASE);
} finally {
  cleanup();
}

// 收尾自检：工具自己不许留下进程/监听（否则下一次运行会被自己的残留骗成"环境冲突"）
await sleep(500);
const leftover = [];
for (const p of [BASE, BASE + 1]) if (await probe(p, 400)) leftover.push(p);
check('收尾无残留监听（工具自身不泄漏端口）', leftover.length === 0,
  leftover.length ? `仍被占用：${leftover.join('、')}` : `${BASE}/${BASE + 1} 均已释放`);

const failed = results.filter((x) => !x.pass);
console.log(`\n启动脚本契约：${results.length - failed.length}/${results.length} 通过`
  + (failed.length ? ` — 失败：${failed.map((f) => f.name).join('、')}` : ''));
process.exit(failed.length ? 1 : 0);
