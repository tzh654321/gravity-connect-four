'use strict';
/* ============================================================
   self-play 核心：playSelf(diff) 跑一局自对弈（困难/普通）

   ⚠ aiChooseMove 是 async 函数，**必须 await**；沙箱的 rAF 同步触发
   由 game-sandbox.js 统一处理（缺了它 await 会永久挂起）。
   ============================================================ */
const { loadGame, drain } = require('./game-sandbox');

/* 模块级缓存的沙箱：worker 内连续打局时复用，省掉重复解析页面 */
const G = loadGame(null,
  'state,addP,set occ(v){occ=v},get occ(){return occ},' +
  'aiChooseMove,placePiece,updateMoving,K,P1,P2,BLOCK');

async function playSelf(diff){
  const o = new Map();
  o.set(G.K(0, 0), G.BLOCK);
  G.occ = o;
  Object.assign(G.state, { mode: 'mm', diff: diff || 'hard', phase: 'idle', turn: G.P1, moveCount: 0, winner: 0 });
  let n = 0, t0 = Date.now(), slow = 0;
  while (n < 600){
    const ts = Date.now();
    const d = await G.aiChooseMove();
    const ms = Date.now() - ts; if (ms > slow) slow = ms;
    if (!d) break;
    G.placePiece(d, G.state.turn); drain(G);
    n++;
    if (G.state.phase === 'over') break;
  }
  return { n, winner: G.state.winner, ms: Date.now() - t0, slow };
}

async function runAll(games, diff){
  const out = [];
  for (let i = 0; i < games; i++) out.push(await playSelf(diff));
  return out;
}

module.exports = { playSelf, runAll };
