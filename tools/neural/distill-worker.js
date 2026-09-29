
'use strict';
const { parentPort, workerData } = require('worker_threads');
const { createGame } = require('./env');
const args = workerData;
const { makeHtmlAgent } = require('./agents-html');

async function run(){
  const G = createGame();
  const leaf = JSON.parse(require('fs').readFileSync(args.model, 'utf8'));
  G.nnw = leaf; G.state.diff = 'hard'; G.state.nnOn = true;
  G.state.nnDepth = args.depth; G.state.nnBranch = args.branch; G.state.nnMix = 1.0;
  G.state.nnNodeCap = 200000;
  const P1 = G.P1, P2 = G.P2;
  const out = [];
  for (const line of args.chunk){
    const s = JSON.parse(line);
    const m = new Map();
    for (const [x, y, o] of s.occ) m.set(G.K(x, y), o);
    G.occ = m;
    const me = s.moverRed ? P1 : P2, op = me === P1 ? P2 : P1;
    const v = G.quietNega(me, op, args.depth - 1, -1e9, 1e9);   // me 视角，深度-1 轮对手
    const f = Array.from(G.nnFeatures(me, op));
    const t = Math.max(-1, Math.min(1, v / 1200));   // 与网络输出同刻度
    out.push({ f, t });
  }
  parentPort.postMessage({ kind: 'rows', rows: out });
}
run().catch(e => { parentPort.postMessage({ kind: 'err', msg: String(e && e.stack || e) }); });
