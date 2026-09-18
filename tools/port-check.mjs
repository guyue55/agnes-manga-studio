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
const waitListen = async (port) => { for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return await r.json(); } catch {} await sleep(150); } throw new Error('no listener ' + port); };

const H = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
const H2 = fs.mkdtempSync(path.join(os.tmpdir(), 'guard2-'));

// 场景1：同端口 + 同目录 → 复用退出0，不起第二实例
const A = boot(5701, H); await waitListen(5701);
const B = boot(5701, H); const getB = collect(B);
const code1 = await new Promise((r) => { const t = setTimeout(() => r('ALIVE'), 4000); B.on('exit', (c) => { clearTimeout(t); r(c); }); });
console.log('场景1 同端口同目录:', code1 === 0 ? 'PASS(exit0复用)' : `FAIL(${code1})`, '|', getB().includes('已在运行') ? '含复用提示' : '无提示');
B.kill();

// 场景2：同端口 + 不同目录 → 漂移到 5702
const C = boot(5701, H2); const getC = collect(C);
await sleep(2500);
const c2 = getC().includes('5702') ? 'PASS(漂移5702)' : 'FAIL:' + getC().slice(0, 120);
console.log('场景2 不同目录漂移:', c2); C.kill();

// 场景3：异端口 + 同目录（README 口径“非文件锁强制”的已知盲区，仅记录）
const D = boot(5705, H); await sleep(2000);
const d3 = collect(D)().includes('数据目录') ? '影子实例起成（已知边界）' : 'probe fail';
console.log('场景3 异端口同目录:', d3); D.kill();

A.kill();
fs.rmSync(H, { recursive: true, force: true });
fs.rmSync(H2, { recursive: true, force: true });
process.exit(0);
