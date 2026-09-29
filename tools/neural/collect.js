'use strict';
/* ============================================================
   自博弈数据收集
   用给定 agents 对局（默认内置 hard 自对弈），在每个回合记录
   (局面特征, 终局结果从行棋方视角) 样本。
   输出：JSON Lines 文件 {f:[...], t:-1|0|1}
   ============================================================ */
const fs = require('fs');
const { createGame, reset, drain, playMove } = require('./env');
const { builtinAgent } = require('./agents-builtin');
const { features } = require('./features');

/* 打一局，返回样本数组 */
async function playCollect(agentA, agentB, opts){
  const G = createGame();
  const P1 = G.P1, P2 = G.P2;
  const first = (opts && opts.first) || P1;
  G.state.turn = first;
  const agents = {}; agents[P1] = agentA; agents[P2] = agentB;
  const maxMoves = (opts && opts.maxMoves) || 300;
  const samples = [];
  let moves = 0;
  while (moves < maxMoves){
    const me = G.state.turn, op = me === P1 ? P2 : P1;
    if (G.state.phase !== 'idle') { drain(G); if (G.state.phase !== 'idle') break; }
    // 记录当前局面（行棋方 me 视角）；occ 快照供离线重编码特征
    const occSnap = [];
    for (const [k, o] of G.occ){ const i = k.indexOf(','); occSnap.push([+k.slice(0, i), +k.slice(i + 1), o]); }
    samples.push({ f: Array.from(features(G, me, op)), t: 0, ply: moves, occ: occSnap, moverRed: me === P1 });
    const cell = await agents[me].choose(G, me, op);
    if (!cell) break;
    G.placePiece(cell, me);
    drain(G);
    moves++;
    if (G.state.phase === 'over') break;
  }
  const w = G.state.winner;
  const sideIsRed = (me => me === P1);
  for (const s of samples){
    if (!w) { s.t = 0; continue; }
    // 若 sample 的 ply 是红方（P1）行棋，则视角 = red
    const turnRed = s.ply % 2 === (first === P1 ? 0 : 1);
    const view = turnRed ? P1 : P2;
    s.t = w === view ? 1 : -1;
  }
  return samples;
}

async function collect(games, diff, outPath, opts){
  const A = builtinAgent(diff, { label: 'A' });
  const B = builtinAgent(diff, { label: 'B' });
  const all = [];
  let t0 = Date.now();
  for (let i = 0; i < games; i++){
    const first = i % 2 === 0 ? 2 : 1;   // 交替先手（红蓝各半）
    const s = await playCollect(A, B, { first });
    all.push(...s);
    if ((i + 1) % 10 === 0 || i + 1 === games){
      process.stdout.write('...' + (i + 1) + '/' + games + ' 局（' + ((Date.now() - t0)/1000).toFixed(0) + 's，累计样本 ' + all.length + '）\n');
    }
  }
  const pos = Math.round(all.filter(s => s.t === 1).length / all.length * 1000) / 10;
  const neg = Math.round(all.filter(s => s.t === -1).length / all.length * 1000) / 10;
  process.stdout.write('样本 "t=+1": ' + pos + '%  "t=-1": ' + neg + '%\n');
  if (outPath){
    const lines = all.map(s => JSON.stringify({ f: s.f, t: s.t }));
    fs.writeFileSync(outPath, lines.join('\n'));
  }
  return all;
}

module.exports = { playCollect, collect };