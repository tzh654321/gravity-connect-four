'use strict';
/* ============================================================
   决定性「直接对局」测量：两模型正面对打 N 局，给出 A 的胜率与 Wilson 95% 置信区间。
   为什么需要它：eval_elo.js 的 Elo 是在线序贯估计（依赖对手顺序与局数，跨轮次不可比），
   且每对手 24~40 局时 95%CI 约 ±16%，分不清 55% 与 62%。本工具只做一件事：
   把「A 是否真的强于 B」测准。
   - 先后手对半（A 先手 / B 先手各一半）→ 消除先手偏差
   - rootTemp=0（argmax），与 eval_core 同口径：sims / maxNodes=1200
   - 两模型可各用不同特征模块（老 16 维 vs P2/P3 特征）
   用法：
     node eval_h2h.js --a model_p2.json --b model_pv_r2.json --games 150 --sims 100 \
          --featA ./features_p2 --featB ../features --workers 24
   ============================================================ */
const path = require('path'), fs = require('fs');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

function args(){
  const a = {}; const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i += 2) a[v[i].replace(/^--/, '')] = v[i + 1];
  return a;
}

async function playGame(agentA, agentB, aAsP1, maxMoves){
  const { createGame, playMove } = require('../env');
  const G = createGame();
  let me = G.P1;
  for (let mv = 0; mv < maxMoves; mv++){
    const isA = (me === G.P1) ? aAsP1 : !aAsP1;
    const drop = await (isA ? agentA : agentB).choose(G, me);
    if (!drop) break;
    playMove(G, drop, me);
    if (G.state.winner) break;
    me = (me === G.P1) ? G.P2 : G.P1;
  }
  const w = G.state.winner;
  if (!w) return 0.5;
  return w === (aAsP1 ? G.P1 : G.P2) ? 1 : 0;
}

if (!isMainThread){
  (async () => {
    const { makeMCTSAgent } = require('./mcts');
    const { MLP } = require('../mlp');
    const { modelA, modelB, sims, featA, featB, start, count, maxMoves } = workerData;
    const mk = (json, featPath) => makeMCTSAgent(MLP.load(json), {
      sims, maxNodes: 1200, rootTemp: 0,
      feat: featPath ? require(featPath).features : undefined
    });
    const A = mk(modelA, featA), B = mk(modelB, featB);
    let score = 0, win = 0, loss = 0, draw = 0;
    for (let i = 0; i < count; i++){
      const aAsP1 = ((start + i) % 2 === 0);   // 全局先后手对半
      const r = await playGame(A, B, aAsP1, maxMoves);
      score += r;
      if (r === 1) win++; else if (r === 0) loss++; else draw++;
      parentPort.postMessage({ type: 'progress', done: i + 1, total: count });
    }
    parentPort.postMessage({ type: 'done', score, win, loss, draw });
  })().catch(e => { parentPort.postMessage({ type: 'error', message: (e && e.stack) || String(e) }); process.exit(1); });
} else {
  (async () => {
    const A = args();
    const MA = A.a, MB = A.b;
    const GAMES = +A.games || 100;
    const SIMS = +A.sims || 100;
    const FA = A.featA || null, FB = A.featB || null;
    const W = Math.max(1, Math.min(+A.workers || 12, GAMES));
    const OUT = A.out || null;
    const MAXMOVES = +A.maxMoves || 300;
    if (!MA || !MB) { console.error('需要 --a 与 --b'); process.exit(1); }
    const modelA = JSON.parse(fs.readFileSync(path.resolve(MA), 'utf8'));
    const modelB = JSON.parse(fs.readFileSync(path.resolve(MB), 'utf8'));

    const t0 = Date.now();
    const base = Math.floor(GAMES / W), rem = GAMES % W;
    let start = 0, done = 0;
    const proms = [];
    for (let k = 0; k < W; k++){
      const count = base + (k < rem ? 1 : 0);
      if (count === 0) continue;
      const w = new Worker(__filename, {
        workerData: { modelA, modelB, sims: SIMS, featA: FA, featB: FB, start, count, maxMoves: MAXMOVES }
      });
      proms.push(new Promise((res) => {
        let acc = null;
        w.on('message', m => {
          if (m.type === 'progress') done++;
          else if (m.type === 'done') acc = m;
          else if (m.type === 'error') console.error('worker ' + k + ' 报错: ' + m.message);
        });
        w.on('error', e => console.error('worker ' + k + ' error:', e));
        w.on('exit', () => res(acc));
      }));
      start += count;
    }
    const res = (await Promise.all(proms)).filter(Boolean);
    const score = res.reduce((a, r) => a + r.score, 0);
    const win = res.reduce((a, r) => a + r.win, 0);
    const loss = res.reduce((a, r) => a + r.loss, 0);
    const draw = res.reduce((a, r) => a + r.draw, 0);
    const n = win + loss + draw;
    const p = n ? score / n : 0;
    // Wilson 95% 置信区间
    const z = 1.96, zn = z * z / n;
    const c = (p + zn / 2) / (1 + zn);
    const h = (z / (1 + zn)) * Math.sqrt((p * (1 - p) / n) + zn / (4 * n));
    const lo = Math.max(0, c - h), hi = Math.min(1, c + h);
    const verdict = lo > 0.5 ? 'A 显著强于 B ✅' : (hi < 0.5 ? 'A 显著弱于 B ❌' : '不显著（置信区间跨过 50%）⚠️');
    console.log('\n对局 ' + n + ' 局  sims=' + SIMS + '  ' + W + ' 核  ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
    console.log('  A=' + path.basename(MA) + (FA ? ' (' + FA + ')' : ''));
    console.log('  B=' + path.basename(MB) + (FB ? ' (' + FB + ')' : ''));
    console.log('  A 胜 ' + win + ' / 负 ' + loss + ' / 和 ' + draw + '   得分率=' + (p * 100).toFixed(1) + '%');
    console.log('  Wilson 95%CI = [' + (lo * 100).toFixed(1) + '%, ' + (hi * 100).toFixed(1) + '%]   ' + verdict);
    if (OUT){
      fs.writeFileSync(OUT, JSON.stringify({ a: MA, b: MB, games: n, sims: SIMS, win, loss, draw, scoreRate: p, ci95: [lo, hi], verdict }, null, 2));
      console.log('  明细 → ' + OUT);
    }
  })().catch(e => { console.error(e); process.exit(1); });
}
