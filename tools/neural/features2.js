'use strict';
/* ============================================================
   特征编码 v2：在 v1（16 维）基础上加精确战术量
   新增：
     f16 = 我方「一手造双威胁」的落点个数（活三/双三，cap 4）
     f17 = 对方同理
   口径与 HTML 的 fork 识别一致：遍历可达落点 p，addP 后数
   「再落一子即连四」的杀点数，≥2 即算一个叉点。
   浏览器端成本：每叶子约多一次 O(pts²) 扫描（1~3ms），可接受。
   ============================================================ */
const FEAT_DIM2 = 18;
const { features } = require('./features');

function forkCells(G, side){
  let n = 0;
  const cands = G.genCandidates();
  const byLand = new Map();
  for (const d of cands){
    const l = G.settleDiscrete(d.x, d.y);
    byLand.set(G.K(l.x, l.y), l);
  }
  const lcands = [...byLand.values()];
  for (const p of lcands){
    if (G.wouldWin(p, side)) continue;          // 直接成杀不叫叉
    G.addP(p.x, p.y, side);
    const c1 = G.genCandidates();
    let kills = 0;
    const lnds2 = new Set();
    for (const d of c1){
      const l2 = G.settleDiscrete(d.x, d.y);
      lnds2.add(G.K(l2.x, l2.y));
    }
    for (const k of lnds2){
      const i = k.indexOf(',');
      if (G.wouldWin({ x: +k.slice(0, i), y: +k.slice(i + 1) }, side)){ kills++; if (kills >= 2) break; }
    }
    G.removeP(p.x, p.y);
    if (kills >= 2) n++;
  }
  return n;
}

function features2(G, me, op){
  const f = features(G, me, op);
  const out = new Float64Array(FEAT_DIM2);
  for (let i = 0; i < 16; i++) out[i] = f[i];
  out[16] = Math.min(forkCells(G, me), 4);
  out[17] = Math.min(forkCells(G, op), 4);
  return out;
}

module.exports = { features2, FEAT_DIM2, forkCells, ...require('./features') };