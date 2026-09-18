/**
 * jobs.js — 批量生成队列
 * ------------------------------------------------------------------
 * 原版批量只能靠用户在界面上一个个点，图片一多就变成体力活。
 * 这里做成一个带并发上限的小队列：
 *   · 进度实时写进内存，前端通过 SSE 拿
 *   · 单项失败不影响其余项，最后汇总成功/失败数
 *   · 支持中途取消（改 cancel 标记，跑完当前项就停）
 */
'use strict';

const jobs = new Map();

function create(type, total) {
  const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const job = {
    id, type, total, done: 0, ok: 0, fail: 0,
    status: 'running', cancel: false,
    started_at: new Date().toISOString(),
    finished_at: null,
    items: [],
  };
  jobs.set(id, job);
  return job;
}

function get(id) { return jobs.get(id) || null; }
function list() { return Array.from(jobs.values()).slice(0, 50); }

/**
 * 跑队列。
 * @param job 由 create() 得到
 * @param items 任意数组
 * @param worker (item, index) => Promise<{ok:boolean, id?:string, error?:string}>
 * @param opts {concurrency, onProgress}
 *
 * R22：`job.items` 改成**按下标预填、原地改状态**（state: pending|running|ok|fail），
 * 而不是"完成一条 push 一条"。原来的写法有两个问题：① 并发下 push 顺序与镜头顺序不一致，
 * 界面按数组顺序画进度链就会错位；② 只有完成态，看不出"哪一条正在跑"。
 * `label` 由调用方带进来（如 `#3`），随任务一起回传——刷新页面后仍能对上是第几个镜头。
 */
async function run(job, items, worker, opts = {}) {
  const concurrency = Math.max(1, Math.min(Number(opts.concurrency) || 3, 8));
  const onProgress = opts.onProgress || (() => {});
  // 变更须知：逐项状态必须**按下标预填、原地改**。改回"完成时 push"会让并发下的顺序
  // 与镜头顺序错位（进度链指错行），且丢失"哪一条正在跑"——selftest 有顺序钉。
  job.items = items.map((it, i) => ({
    index: i,
    label: (it && typeof it === 'object' && it.label) ? String(it.label) : `第 ${i + 1} 项`,
    // key 是调用方给的不透明标识（本项目里是分镜 id），原样回传：
    // 界面据此把"哪一项正在跑/失败"映射回具体那一行，刷新后依然成立
    key: (it && typeof it === 'object' && it.key != null) ? String(it.key) : null,
    state: 'pending', ok: null, id: null, error: null,
  }));
  let cursor = 0;

  async function loop() {
    while (cursor < items.length) {
      if (job.cancel) break;
      const idx = cursor++;
      const item = items[idx];
      const rec = job.items[idx];
      rec.state = 'running';
      onProgress(job); // 让"正在跑哪一条"立刻可见，而不是等它跑完才知道
      try {
        const r = await worker(item, idx);
        if (r && r.ok === false) {
          job.fail++;
          rec.state = 'fail'; rec.ok = false; rec.error = r.error || '失败';
        } else {
          job.ok++;
          rec.state = 'ok'; rec.ok = true; rec.id = r?.id || null;
        }
      } catch (e) {
        job.fail++;
        rec.state = 'fail'; rec.ok = false; rec.error = e.message || String(e);
      }
      job.done++;
      onProgress(job);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) workers.push(loop());
  await Promise.all(workers);

  job.status = job.cancel ? 'cancelled' : 'done';
  // 取消时把还没轮到的项标成 cancelled：否则界面会永远显示一排"待处理"，
  // 看起来像任务卡住了，而实际是用户自己取消的
  if (job.cancel) for (const rec of job.items) if (rec.state === 'pending' || rec.state === 'running') rec.state = 'cancelled';
  job.finished_at = new Date().toISOString();
  onProgress(job);
  return job;
}

function cancel(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.cancel = true;
  return true;
}

/** 只保留最近 50 条，避免长时间运行后内存里堆一堆历史 */
function prune() {
  const all = Array.from(jobs.values());
  if (all.length <= 50) return;
  all.slice(0, all.length - 50)
    .filter((j) => j.status !== 'running')
    .forEach((j) => jobs.delete(j.id));
}

module.exports = { create, get, list, run, cancel, prune };
