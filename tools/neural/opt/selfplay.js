'use strict';
/* ============================================================
   自博弈数据采集（突破天花板 B：教师锁）
   用 MCTS(value-net) 自对弈，逐局输出样本：
     { w: winner(0/1/2), s: [ {f:[16], m:mover(1|2)}, ... ] }
   - 数据来自 NN 自身而非内置 hard ⇒ 不再被 hard 封顶
   - 根层按访问分布采样（rootTemp>0）⇒ 增加局面多样性
   - 每局已记录完整序列，供 train_pv.js 做 n-step TD 目标
   - 多核：--workers N (>1) 时按切片扇出到 worker_threads，主线程合并临时文件
   ============================================================ */
const fs = require('fs'), path = require('path');
const { Worker } = require('worker_threads');
const { MLP } = require('../mlp');
const { makeAgent, playOne } = require('./selfplay_core');

function args(){
  const a = {}; const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i += 2) a[v[i].replace(/^--/, '')] = v[i + 1];
  return a;
}
const A = args();
const GAMES = +A.games || 30;
const SIMS = +A.sims || 60;
const OUT = A.out || path.join(__dirname, 'data', 'sp_selfplay.jsonl');
const MODEL = A.model || path.join(__dirname, '..', 'model.json');
const ROOT_TEMP = A.rootTemp != null ? +A.rootTemp : 1.0;
const MAXMOVES = +A.maxMoves || 300;
const WORKERS = +A.workers || 1;

function resolveModelJson(){
  if (fs.existsSync(MODEL)) return JSON.parse(fs.readFileSync(MODEL, 'utf8'));
  return new MLP([16, 64, 64, 1], { act: 'tanh', outAct: 'tanh' }).toJSON();
}

// ---- 单进程回退路径（保持与旧调用兼容）----
async function runSingle(modelJson){
  const agent = makeAgent(modelJson, SIMS, ROOT_TEMP);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const out = fs.createWriteStream(OUT, { flags: 'a' });
  let t0 = Date.now(), total = 0;
  for (let i = 0; i < GAMES; i++){
    const first = i % 2 === 0 ? 2 : 1;
    const g = await playOne(agent, first, MAXMOVES);
    out.write(JSON.stringify({ w: g.w, s: g.s }) + '\n');
    total += g.s.length;
    process.stdout.write('game ' + (i + 1) + '/' + GAMES + ' winner=' + g.w + ' samples=' + g.s.length +
      ' (' + ((Date.now() - t0) / 1000).toFixed(0) + 's, 累计 ' + total + ')\n');
  }
  out.end();
  process.stdout.write('完成：' + total + ' 样本 → ' + OUT + '\n');
}

// ---- 多核路径 ----
async function runParallel(modelJson){
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const W = Math.max(1, Math.min(WORKERS, GAMES));
  const base = Math.floor(GAMES / W);
  let rem = GAMES % W;
  const t0 = Date.now();
  let totalSamples = 0;
  const allLines = [];
  const proms = [];
  let start = 0;
  for (let k = 0; k < W; k++){
    const count = base + (k < rem ? 1 : 0);
    if (count === 0) continue;
    const w = new Worker(path.join(__dirname, 'selfplay_worker.js'), {
      workerData: { modelJson, sims: SIMS, rootTemp: ROOT_TEMP, maxMoves: MAXMOVES, start, count }
    });
    proms.push(new Promise((resolve) => {
      w.on('message', m => {
        if (m.type === 'progress'){
          totalSamples += m.samples;
          process.stdout.write('[w' + k + '] ' + m.done + '/' + m.total + ' (' + ((Date.now() - t0) / 1000).toFixed(0) + 's, 累计 ' + totalSamples + ')\n');
        } else if (m.type === 'done'){
          // 注意：done 里的 samples 是 worker 的「累计值」，progress 已逐局累加过，
          // 此处再加会二次膨胀（曾导致"55718 样本"这种假数字），故只收 lines
          allLines.push(...m.lines);
        } else if (m.type === 'error'){
          // 关键：worker 内部抛错时必须显式报出，否则整批对局会「静默消失」
          console.error('worker ' + k + ' 报错: ' + m.message);
        }
      });
      w.on('error', e => { console.error('worker ' + k + ' error:', e); });
      w.on('exit', () => resolve());
    }));
    start += count;
  }
  await Promise.all(proms);
  const out = fs.createWriteStream(OUT, { flags: 'w' });
  out.write(allLines.join('\n') + (allLines.length ? '\n' : ''));
  out.end();
  process.stdout.write('完成：' + totalSamples + ' 样本 / ' + allLines.length + ' 局 → ' + OUT + '（' + W + ' 核，' + ((Date.now() - t0) / 1000).toFixed(0) + 's）\n');
}

async function main(){
  const modelJson = resolveModelJson();
  if (WORKERS > 1) await runParallel(modelJson);
  else await runSingle(modelJson);
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { playOne, makeAgent };
