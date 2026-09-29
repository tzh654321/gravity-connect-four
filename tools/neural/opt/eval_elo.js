'use strict';
/* ============================================================
   Elo 天梯评测（突破天花板 A：循环基准 → 多对手池 + 固定锚）
   被测 = 新价值网络 + MCTS 代理；对手池 = [easy, normal, hard, 旧NN(MCTS), 旧NN(negamax)]
   - 固定锚 Elo，估计被测 Elo（相对量，但可纵向对比）
   - 先后手对半，规避先手偏差
   - 多核：--workers N (>1) 时把 (对手×局) 任务扇出到 worker_threads；主线程按固定顺序复算 Elo
   ============================================================ */
const fs = require('fs'), path = require('path');
const { Worker } = require('worker_threads');
const { playMatch } = require('./eval_core');

function args(){
  const a = {}; const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i += 2) a[v[i].replace(/^--/, '')] = v[i + 1];
  return a;
}
const A = args();
const MODEL = A.model || path.join(__dirname, 'model_pv.json');
const GAMES = +A.games || 12;
const SIMS = +A.sims || 80;
const OLD = A.old || path.join(__dirname, '..', 'model.json');
const OUT = A.out || path.join(__dirname, 'eval_elo.json');
const WORKERS = +A.workers || 1;

const OPPONENTS = ['easy', 'normal', 'hard', 'old_mcts', 'old_nn'];
const ANCHOR = { easy: 700, normal: 1000, hard: 1400, old_mcts: 1400, old_nn: 1400 };

function buildTasks(){
  const tasks = [];
  let idx = 0;
  for (const key of OPPONENTS){
    for (let i = 0; i < GAMES; i++){
      tasks.push({ oppKey: key, nnAsA: i % 2 === 0, idx: idx++ });
    }
  }
  return tasks;
}

// 单进程回退
async function runSingle(newModelJson){
  const P1 = 1, P2 = 2;
  let myElo = 1200, K = 12;
  const perOpp = {};
  for (const key of OPPONENTS) perOpp[key] = { key, anchor: ANCHOR[key], win: 0, loss: 0, draw: 0, score: 0 };
  let idx = 0;
  for (const key of OPPONENTS){
    for (let i = 0; i < GAMES; i++){
      const r = await playMatch(newModelJson, SIMS, OLD, key, i % 2 === 0);
      const opp = perOpp[key];
      opp.score += r.got;
      if (r.got === 0.5) opp.draw++; else if (r.got === 1) opp.win++; else opp.loss++;
      const expected = 1 / (1 + Math.pow(10, (opp.anchor - myElo) / 400));
      myElo += K * (r.got - expected);
      idx++;
    }
    process.stdout.write('vs ' + key.padEnd(9) + ' 胜' + perOpp[key].win + ' 负' + perOpp[key].loss + ' 和' + perOpp[key].draw + ' 胜率' + (perOpp[key].score / GAMES * 100).toFixed(1) + '%\n');
  }
  return finalize(myElo, perOpp);
}

// 多核：扇出任务 → 收集 → 固定顺序复算 Elo
async function runParallel(newModelJson){
  const tasks = buildTasks();
  const W = Math.max(1, Math.min(WORKERS, tasks.length));
  const t0 = Date.now();
  const shards = Array.from({ length: W }, () => []);
  tasks.forEach((t, i) => shards[i % W].push(t));
  const collected = [];
  await Promise.all(shards.map((shard, k) => new Promise((resolve) => {
    const w = new Worker(path.join(__dirname, 'eval_worker.js'), {
      workerData: { tasks: shard, newModelJson, SIMS, OLD }
    });
    w.on('message', m => {
      if (m.type === 'done') collected.push(...m.results);
    });
    w.on('error', e => console.error('eval worker ' + k + ' error:', e));
    w.on('exit', () => resolve());
  })));
  // 按生成顺序排序，复算与单进程一致的 Elo 轨迹
  collected.sort((a, b) => a.idx - b.idx);
  let myElo = 1200, K = 12;
  const perOpp = {};
  for (const key of OPPONENTS) perOpp[key] = { key, anchor: ANCHOR[key], win: 0, loss: 0, draw: 0, score: 0 };
  for (const r of collected){
    const opp = perOpp[r.oppKey];
    opp.score += r.got;
    if (r.got === 0.5) opp.draw++; else if (r.got === 1) opp.win++; else opp.loss++;
    const expected = 1 / (1 + Math.pow(10, (opp.anchor - myElo) / 400));
    myElo += K * (r.got - expected);
  }
  for (const key of OPPONENTS){
    const o = perOpp[key];
    process.stdout.write('vs ' + key.padEnd(9) + ' 胜' + o.win + ' 负' + o.loss + ' 和' + o.draw + ' 胜率' + (o.score / GAMES * 100).toFixed(1) + '%\n');
  }
  process.stdout.write('（' + W + ' 核，' + ((Date.now() - t0) / 1000).toFixed(0) + 's）\n');
  return finalize(myElo, perOpp);
}

function finalize(myElo, perOpp){
  const perOppOut = OPPONENTS.map(k => {
    const o = perOpp[k];
    return { key: o.key, anchor: o.anchor, win: o.win, loss: o.loss, draw: o.draw, scoreRate: (o.score / GAMES).toFixed(3) };
  });
  const summary = { newElo: Math.round(myElo), perOpp: perOppOut, gamesPerOpp: GAMES, sims: SIMS };
  console.log('\n被测 NEW Elo ≈ ' + Math.round(myElo) + ' (锚: easy700/normal1000/hard&old1400)');
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log('明细 → ' + OUT);
  return summary;
}

(async () => {
  const newModelJson = JSON.parse(fs.readFileSync(MODEL, 'utf8'));
  const summary = WORKERS > 1 ? await runParallel(newModelJson) : await runSingle(newModelJson);
  return summary;
})().catch(e => { console.error(e); process.exit(1); });
