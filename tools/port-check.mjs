// 端口撞车防护三场景真机验证（自证式：每条结论都有监听探测/字段对比作证据，违例非零退出）
// 场景1 同端口同目录 → 复用退出0；场景2 同端口异目录 → 漂移；场景3 异端口同目录 → 影子实例（README 已知边界）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = '/Users/apple/Project/Git/agnes-manga-studio';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const boot = (port, home) => spawn('node', ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port), AGNES_STUDIO_HOME: home, NO_OPEN: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const collect = (child) => { let o = ''; child.stdout.on('data', (d) => (o += d)); child.stderr.on('data', (d) => (o += d)); return () => o; };
const waitListen = async (port, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return await r.json(); } catch {}
    await sleep(150);
  }
  return null; // 探测失败返回 null，由调用方断言（不再 throw 掩盖）
};

const H = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
const H2 = fs.mkdtempSync(path.join(os.tmpdir(), 'guard2-'));
const results = [];
const check = (name, pass, evidence) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} — ${evidence}`);
};

const A = boot(5701, H);
const healthA = await waitListen(5701);
check('场景1a 首实例起在 5701', !!healthA && healthA.data_home === H, `data_home=${healthA && healthA.data_home}`);

const B = boot(5701, H); const getB = collect(B);
const code1 = await new Promise((r) => { const t = setTimeout(() => r('ALIVE'), 4000); B.on('exit', (c) => { clearTimeout(t); r(c); }); });
check('场景1b 同端口同目录 → 复用并 exit 0', code1 === 0, `exit=${code1} 输出含复用提示=${getB().includes('已在运行')}`);
check('场景1c 复用进程不产生第二监听', (await waitListen(5701, 2)) !== null, '5701 仍由首实例服务');
B.kill();

const C = boot(5701, H2); const getC = collect(C);
const healthDrift = await waitListen(5702);
check('场景2 同端口异目录 → 漂移到 5702', !!healthDrift && healthDrift.data_home === H2, `5702 data_home=${healthDrift && healthDrift.data_home} 输出含5702=${getC().includes('5702')}`);
C.kill();

// 场景3：README 口径"端口守卫非文件锁"——异端口同目录不会被拦，影子实例会起成（已知边界，仅记录但必须实测确认）
const D = boot(5705, H);
const healthD = await waitListen(5705);
const sharedHome = !!healthD && healthD.data_home === H;
check('场景3 异端口同目录 → 影子实例起成（README 已知边界）', !!healthD && sharedHome, `5705 监听=${!!healthD} 与首实例同数据目录=${sharedHome}`);
D.kill();

A.kill();
fs.rmSync(H, { recursive: true, force: true });
fs.rmSync(H2, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n端口防护验证：${results.length - failed.length}/${results.length} 通过${failed.length ? ' — 与 README 口径不符的场景：' + failed.map((f) => f.name).join('、') : ''}`);
process.exit(failed.length ? 1 : 0);
