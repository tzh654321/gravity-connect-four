'use strict';
/* ============================================================
   check-solver-page —— 「求解器-精确」档接入 index.html 的回归检查

   覆盖三件事：
   1) 主脚本里确实内联了 GravitySolver（否则 Worker 里也会缺，见 inject-solver.js 说明）；
   2) 走页面真实入口 aiChooseMove() 时，返回的是**合法稳定落点**；
   3) 核心被拿掉时应回退启发式、而不是返回 null 把对局判结束。

   用法：node tools/check-solver-page.js
   ============================================================ */
const assert = require('node:assert/strict');
const { loadGame } = require('./game-sandbox');

const G = loadGame(null,
  'state,set occ(v){occ=v},get occ(){return occ},aiChooseMove,K,P1,P2,BLOCK,' +
  'isFree,settleDiscrete,GravitySolver',
  { expose: true });

function setup(kind) {
  G.occ = new Map([[G.K(0, 0), G.BLOCK]]);
  Object.assign(G.state, {
    mode: 'mm', diff: 'hard', aiKind: kind, nnOn: false,
    turn: G.P1, phase: 'idle', moveCount: 0, winner: 0, winCells: null, gen: 1,
  });
}

(async function main() {
  // 1) 核心已内联
  assert(G.GravitySolver && typeof G.GravitySolver.chooseMove === 'function',
    'index.html 主脚本未内联 GravitySolver（先跑 node tools/inject-solver.js）');

  // 2) 求解器档返回合法稳定落点
  const t0 = Date.now();
  setup('solver');
  const d = await G.aiChooseMove();
  assert(d && Number.isInteger(d.x) && Number.isInteger(d.y), '求解器档未返回落点');
  assert(G.isFree(d.x, d.y), `落点已被占据：${JSON.stringify(d)}`);
  const l = G.settleDiscrete(d.x, d.y);
  assert.equal(`${l.x},${l.y}`, `${d.x},${d.y}`, '求解器返回的不是稳定落点（会漂移）');
  const solverMs = Date.now() - t0;

  // 3) 核心缺失 → 回退启发式，仍返回合法落点，不返回 null
  delete G.__sb.GravitySolver;
  setup('solver');
  const fb = await G.aiChooseMove();
  assert(fb && Number.isInteger(fb.x) && Number.isInteger(fb.y),
    '核心缺失时未回退启发式（返回了 null 会把对局误判结束）');
  assert(G.isFree(fb.x, fb.y), '回退落点非法');

  console.log(`求解器档页面接入检查通过：内联核心可用、落点合法稳定、缺核心可回退。` +
    `（求解器单步 ${solverMs}ms，回退落点 ${fb.x},${fb.y}）`);
})().catch(e => { console.error('检查失败：', e); process.exit(1); });
