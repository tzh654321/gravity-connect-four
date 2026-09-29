'use strict';
/* ============================================================
   自我博弈 多核并行（worker_threads）—— 演示与工具
   用法：
     node parallel-selfplay.js --games 16 --jobs 8 --diff hard
     --games 总对局数  --jobs 并行 worker 数(默认 = min(8, CPU核))  --diff normal|hard
   先测单线程基线(并发1)再做并发，打印加速比。
   注意：启发式评估是串行逻辑 + 单点物理模拟，瓶颈在单核 CPU；
   GPU 对这类「分支逻辑/物理模拟」无用武之地——只有把评估换成神经网络后
   才谈得上 GPU 矩阵加速（见 README 路线）。
   ============================================================ */
const fs = require('fs'), path = require('path'), os = require('os');
const { Worker } = require('worker_threads');

const A = {};
const v = process.argv.slice(2);
for (let i = 0; i < v.length; i += 2) A[v[i].replace(/^--/,'')] = v[i+1];
const GAMES = +A.games || 16;
const DIFF = A.diff || 'hard';
const CORES = os.cpus().length;
const JOBS = Math.min(+A.jobs || Math.min(8, CORES), CORES);

const freeGB = os.freemem() / 2**30;
console.log('CPU ' + CORES + ' 核 (' + (os.cpus()[0] && os.cpus()[0].model) + ') 可用内存 ' + freeGB.toFixed(1) + 'GB');
if (freeGB < 1.5) console.log('⚠ 可用内存紧张，建议关闭其它程序；如内存溢出请调低 --jobs');

function run(jobs){
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    if (jobs === 1){
      // 单线程基线：主进程内跑（无 worker 开销，最接近纯计算耗时）
      require('./single-selfplay').runAll(GAMES, DIFF).then(resolve, reject);
      return;
    }
    let pending = GAMES, done = 0, inflight = 0, qi = 0;
    const results = [];
    const finish = () => {
      const wall = (Date.now() - t0) / 1000;
      resolve({ wall, results });
    };
    const workers = [];
    for (let w = 0; w < jobs; w++){
      const wk = new Worker(path.join(__dirname, 'spa-worker.js'));
      wk.on('message', msg => {
        if (msg.kind === 'error'){ reject(new Error('[worker] ' + msg.message)); return; }
        if (msg.kind !== 'result') return;
        results.push(msg.r); inflight--; done++;
        if (done === GAMES){ workers.forEach(x => x.postMessage({ kind:'quit' })); finish(); return; }
        if (qi < GAMES){ wk.postMessage({ kind:'game', id: qi++, diff: DIFF }); inflight++; }
      });
      wk.on('error', reject);
      workers.push(wk);
    }
    // 填充初批
    while (qi < GAMES && inflight < jobs){ workers[inflight].postMessage({ kind:'game', id: qi++, diff: DIFF }); inflight++; }
  });
}

(async () => {
  const base = await run(1);
  const redW = base.results.filter(r => r.winner === 1).length;
  const n = base.results.length;
  const moves = base.results.reduce((s, r) => s + r.n, 0);
  console.log('\n[并发 1 基线] ' + n + ' 局 墙钟 ' + base.wall.toFixed(1) + 's  ' +
    '红' + redW + '/蓝' + (n - redW) + ' 平均 ' + (moves/n).toFixed(1) + ' 手 最慢步 ' +
    Math.max(...base.results.map(r => r.slow)).toFixed(0) + 'ms');

  const par = await run(JOBS);
  const redW2 = par.results.filter(r => r.winner === 1).length;
  console.log('[并发 ' + JOBS + '] ' + par.results.length + ' 局 墙钟 ' + par.wall.toFixed(1) + 's  ' +
    '红' + redW2 + '/蓝' + (par.results.length - redW2) + ' 平均 ' +
    (par.results.reduce((s, r) => s + r.n, 0)/par.results.length).toFixed(1) + ' 手');
  console.log('加速比 ' + (base.wall / par.wall).toFixed(2) + '×  （理论上限 ' + JOBS + '×，受单局长短不均与内存带宽影响）');
})().catch(e => { console.error(e); process.exit(1); });
