'use strict';
/* ============================================================
   神经网络 AI 对手：
   - 候选：genCandidates + settleDiscrete → 落点（取最靠近中心的投点）
   - 一手成杀（精确物理复核）
   - 强制应杀（对方连四肢点唯一时占领；多杀点选风险最小）
   - 其余走 negamax 深度搜索，叶子用价值网络评估
   ============================================================ */
const { MLP } = require('./mlp');
const { features } = require('./features');

const FW_S = 2e6;          // 强制胜分（略高于普通分范围）
const NN_SCALE = 1200;     // 网络输出 [-1,1] → 分
const FSNEG_INF = 5e7;

function makeNNAgent(modelObj, opts){
  opts = opts || {};
  const model = modelObj instanceof MLP ? modelObj : MLP.load(modelObj);
  const depth = opts.depth || 2;
  const branchK = opts.branchK || 8;           // 每层候选分支上限

  function nnEval(G, me){
    const op = me === G.P1 ? G.P2 : G.P1;
    const f = features(G, me, op);
    const v = model.infer(f)[0];
    return v;
  }

  function reachPts(G){
    // 返回「可达落点（去重）」；后续直接用落点加子（与根层 landMap 同口径）
    const cands = G.genCandidates();
    const byLand = new Map();
    for (const drop of cands){
      const lc = G.settleDiscrete(drop.x, drop.y);
      byLand.set(G.K(lc.x, lc.y), { x: lc.x, y: lc.y });
    }
    return [...byLand.values()];
  }

  function wouldWinAt(G, p, side){
    return G.wouldWin(p, side);
  }

  let nodeCount = 0;

  /* 返回 me 视角估值 */
  function negamax(G, me, op, depth, alpha, beta){
    if (++nodeCount > 400000) return 0;
    const pts = reachPts(G);
    if (!pts.length) return 0;
    // 我方可立即成杀 → 越快越好
    for (const p of pts){
      if (G.wouldWin(p, me)) return FW_S - nodeDepthBonus(depth, pts.length);
    }
    // 对方连四肢点：必须应
    const opWins = [];
    for (const p of pts) if (G.wouldWin(p, op)) opWins.push(p);
    if (opWins.length){
      if (depth <= 0) return -FW_S + nodeDepthBonus(depth, opWins.length);
      let best = -Infinity;
      const tries = opWins.slice(0, 7);
      for (const c of tries){
        G.addP(c.x, c.y, me);
        let v;
        if (G.wouldWin(c, me)) v = FW_S;
        else v = -negamax(G, op, me, depth - 1, -beta, -alpha);
        G.removeP(c.x, c.y);
        if (v > best) best = v;
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
      }
      return best;
    }
    if (depth <= 0){
      return nnEval(G, me) * NN_SCALE;
    }
    // 排序候选（用 1 层 NN 前瞻近似 + 立即成杀优先）
    const scored = [];
    for (let i = 0; i < pts.length; i++){
      const p = pts[i];
      G.addP(p.x, p.y, me);
      let v;
      if (G.wouldWin(p, me)) v = FW_S;                      // 成杀
      else v = -nnEval(G, op);                               // 对手视角 1 层
      G.removeP(p.x, p.y);
      scored.push({ p, v });
    }
    scored.sort((a, b) => b.v - a.v);
    const cand = scored.slice(0, branchK).map(s => s.p);
    let best = -Infinity, quiet = 0;
    for (const c of cand){
      G.addP(c.x, c.y, me);
      const v = -negamax(G, op, me, depth - 1, -beta, -alpha);
      G.removeP(c.x, c.y);
      if (v > best) best = v;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
      if (v === 0){ if (++quiet >= 3) break; } else quiet = 0;
    }
    if (best === -Infinity) best = 0;
    return best;
  }

  function nodeDepthBonus(depth, n){
    return Math.min(n, 40) * 10 - depth * 3;
  }

  /* 根层 move 选择 */
  async function choose(G, me){
    const op = me === G.P1 ? G.P2 : G.P1;
    // 1) 候选投点 → 落点映射
    const cands = G.genCandidates();
    if (!cands.length) return null;
    const landMap = new Map();
    for (const c of cands){
      const l = G.settleDiscrete(c.x, c.y);
      const k = G.K(l.x, l.y);
      const rec = landMap.get(k);
      if (!rec) landMap.set(k, { drop: c, land: l });
      else if (Math.abs(c.x) + Math.abs(c.y) < Math.abs(rec.drop.x) + Math.abs(rec.drop.y)) rec.drop = c;
    }
    const options = [...landMap.values()];
    if (!options.length) return null;
    // 2) 我方一步成杀 → 直取
    for (const o of options){
      if (G.wouldWin(o.land, me)){
        const ex = G.settleExact(o.drop.x, o.drop.y);
        if (G.wouldWin(ex, me)) return o.drop;
      }
    }
    // 3) 对方一步成杀 → 必须应
    const opWins = [];
    for (const o of options) if (G.wouldWin(o.land, op)) opWins.push(o);
    if (opWins.length){
      // 在杀手场景下仍用搜索挑（可能有的应在杀点的同时自己成杀），但限定为杀点/近点
      nodeCount = 0;
      let best = null, bestV = -Infinity;
      const cand = opWins.slice(0, 6);
      for (const o of cand){
        const ex = G.settleExact(o.drop.x, o.drop.y);
        o.land = ex;
        G.addP(o.land.x, o.land.y, me);
        let v = -negamax(G, op, me, depth - 1, -FSNEG_INF, FSNEG_INF);
        G.removeP(o.land.x, o.land.y);
        if (o.land && G.wouldWin(o.land, me)) v = FW_S;
        if (v > bestV){ bestV = v; best = o.drop; }
      }
      if (best) return best;
    }
    // 4) 一般局面：negamax 根层
    nodeCount = 0;
    let bestO = null, bestV = -Infinity;
    const scored = [];
    for (const o of options){
      const l = G.settleExact(o.drop.x, o.drop.y);
      o.land = l;
      G.addP(l.x, l.y, me);
      const v = -nnEval(G, op);
      G.removeP(l.x, l.y);
      scored.push({ o, v });
      if (v > bestV){ bestV = v; bestO = o; }
    }
    scored.sort((a, b) => b.v - a.v);
    const cand = scored.slice(0, Math.max(4, branchK)).map(s => s.o);
    bestV = -Infinity;
    for (const o of cand){
      if (G.wouldWin(o.land, me)){ bestV = FW_S + 1; bestO = o; break; }
      G.addP(o.land.x, o.land.y, me);
      const v = -negamax(G, op, me, depth - 1, -FSNEG_INF, FSNEG_INF);
      G.removeP(o.land.x, o.land.y);
      if (v > bestV){ bestV = v; bestO = o; }
    }
    return bestO ? bestO.drop : null;
  }

  return {
    name: opts.name || 'NN',
    depth, branchK,
    async choose(G, me, op){
      return await choose(G, me);
    }
  };
}

module.exports = { makeNNAgent, FW_S, NN_SCALE };