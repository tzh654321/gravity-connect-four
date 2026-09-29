'use strict';
/* ============================================================
   Leader AI（冲刺版）：= 内置 hard 的全部战术骨干 + 安静局面深搜
   - 完全复用 HTML 导出：scoreOption / oppBestReply / lookaheadThreat /
     threatNega / forkCount / deltaEval（与真实 AI 零偏差）
   - 差异点：最终选择不在「近优带内随机」，而用 quietNega 对安静
     候选做 3~4 层深搜，叶子可选纯静态(delta) 或 静态+NN 混合
   目的：验证「安静局面多算几步」能否稳定击败 hard（hard 安静只算 1~2 层）。
   ============================================================ */
const { MLP } = require('./mlp');
const { features } = require('./features');
const { features2 } = require('./features2');

const FW = 1e7, FSNEG_INF = 5e7;      // 与 HTML 一致
const QFW = 2e6;                        // 安静搜索的强制胜分
const NN_SCALE = 1200;
const PRESSURE_PEN = 1200;

function reachPtsNode(G){
  const cands = G.genCandidates();
  const byLand = new Map();
  for (const d of cands){
    const l = G.settleDiscrete(d.x, d.y);
    byLand.set(G.K(l.x, l.y), { x: l.x, y: l.y });
  }
  return [...byLand.values()];
}

function makeLeaderAgent(modelObj, opts){
  opts = opts || {};
  const model = modelObj instanceof MLP ? modelObj : (modelObj ? MLP.load(modelObj) : null);
  const rootModel = opts.rootModel instanceof MLP ? opts.rootModel : (opts.rootModel ? MLP.load(opts.rootModel) : null);
  const useNN = opts.useNN !== false && !!model;
  const depth = opts.depth || 4;        // 根层 quietNega 总深度（含根自己的 ply）
  const branchK = opts.branchK || 6;
  const useNNMix = opts.nnMix != null ? opts.nnMix : 0.7;   // NN/静态混合系数
  const useFallbackNoise = opts.noise !== false;
  const richMix = opts.richMix != null ? opts.richMix : 0.4; // 根层 18维NN 占比

  let qnNodes = 0;

  function staticQuietLeaf(G, me, opp){
    const pts = reachPtsNode(G);
    let best = 0, sec = 0;
    for (const p of pts){
      const v = G.deltaEval(p, me) + 0.95 * G.deltaEval(p, opp);
      if (v > best){ sec = best; best = v; }
      else if (v > sec) sec = v;
    }
    return 10 * (best + 0.35 * sec);
  }

  function nnQuietLeaf(G, me, opp){
    const v = model.infer(features(G, me, opp))[0] * NN_SCALE;
    const st = staticQuietLeaf(G, me, opp);
    return useNNMix * v + (1 - useNNMix) * st;
  }

  function richNnEval(G, me){
    const op = me === G.P1 ? G.P2 : G.P1;
    return rootModel.infer(features2(G, me, op))[0] * NN_SCALE;
  }

  /* 返回 side 视角估值 */
  function quietNega(G, side, opp, depthLeft, alpha, beta){
    if (++qnNodes > 100000) return 0;
    const R = reachPtsNode(G);
    if (!R.length) return 0;
    for (const p of R) if (G.wouldWin(p, side)) return QFW - Math.min(R.length, 40) * 10;
    const opWins = [];
    for (const p of R) if (G.wouldWin(p, opp)) opWins.push(p);
    if (opWins.length){
      if (depthLeft <= 0) return -QFW + 5;
      let best = -Infinity;
      const tries = opWins.slice(0, 6);
      for (const c of tries){
        G.addP(c.x, c.y, side);
        let v;
        if (G.wouldWin(c, side)) v = QFW;
        else v = -quietNega(G, opp, side, depthLeft - 1, -beta, -alpha);
        G.removeP(c.x, c.y);
        if (v > best) best = v;
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
      }
      return best === -Infinity ? 0 : best;
    }
    if (depthLeft <= 0) return useNN ? nnQuietLeaf(G, side, opp) : staticQuietLeaf(G, side, opp);
    const scored = [];
    for (const p of R) scored.push({ p, v: G.deltaEval(p, side) + 0.35 * G.deltaEval(p, opp) });
    scored.sort((a, b) => b.v - a.v);
    const cand = scored.slice(0, branchK).map(s => s.p);
    let best = -Infinity;
    for (const c of cand){
      G.addP(c.x, c.y, side);
      const v = -quietNega(G, opp, side, depthLeft - 1, -beta, -alpha);
      G.removeP(c.x, c.y);
      if (v > best) best = v;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best === -Infinity ? 0 : best;
  }

  async function choose(G, me){
    const opp = me === G.P1 ? G.P2 : G.P1;
    G.state.diff = 'hard';                       // lookaheadThreat 用 hard 档
    const cands = G.genCandidates();
    if (!cands.length) return null;

    // 1) 投点 → 落点（同 aiChooseMove）
    const landMap = new Map();
    for (const c of cands){
      const l = G.settleDiscrete(c.x, c.y);
      const k = G.K(l.x, l.y);
      const rec = landMap.get(k);
      if (!rec) landMap.set(k, { drop: c, land: l });
      else if (Math.abs(c.x) + Math.abs(c.y) < Math.abs(rec.drop.x) + Math.abs(rec.drop.y)) rec.drop = c;
    }
    let options = [...landMap.values()];
    if (!options.length) return null;

    // 2) 一步取胜（精确复核）
    for (const o of options){
      if (!G.wouldWin(o.land, me)) continue;
      const ex = G.settleExact(o.drop.x, o.drop.y);
      if (G.wouldWin(ex, me)) return o.drop;
    }

    // 3) 粗排
    for (const o of options) o.v0 = G.deltaEval(o.land, me) + 0.95 * G.deltaEval(o.land, opp) + (Math.random() - 0.5) * 2;
    options.sort((a, b) => b.v0 - a.v0);

    // 5) 对手致命点（立即连四 / 一手造活三）
    const pts0 = [];
    for (const c of cands){
      if (G.settleDiscrete(c.x, c.y).x !== c.x || G.settleDiscrete(c.x, c.y).y !== c.y) continue; // 非落点
      if (G.wouldWin(c, opp)){ pts0.push({ drop: c, land: { x: c.x, y: c.y } }); continue; }
      G.addP(c.x, c.y, opp);
      const c1 = G.genCandidates();
      let n = 0;
      for (const d of c1){
        const ld = G.settleDiscrete(d.x, d.y);
        if (G.wouldWin(ld, opp)){ n++; if (n >= 2) break; }
      }
      G.removeP(c.x, c.y);
      if (n >= 2) pts0.push({ drop: c, land: { x: c.x, y: c.y } });
    }

    // 6) scoreOption（同 hard）
    const K1 = 20;
    const sel = new Map();
    for (const o of options.slice(0, K1)) sel.set(G.K(o.land.x, o.land.y), o);
    for (const c of pts0) if (!sel.has(G.K(c.x, c.y))) sel.set(G.K(c.x, c.y), c);
    let top = [...sel.values()];
    for (const o of top) G.scoreOption(o, me, opp);
    top.sort((a, b) => b.v - a.v);

    // 6.5) oppBestReply（hard）
    for (const o of top){
      const best = G.oppBestReply(o, me, opp);
      o.v2 = o.v - (best >= 1e5 ? 1e5 : 0) - (best >= 130 ? 700 : 0);
    }
    top.sort((a, b) => b.v2 - a.v2);

    // 7) lookaheadThreat（hard：前 C 个；level2 否决 / level1 减施压罚分）
    const small = pts0.length <= 12;
    const C = small ? top.length : Math.min(top.length, 12);
    for (let i = 0; i < C; i++){
      const o = top[i];
      const lt = G.lookaheadThreat(o, me, opp);
      o._lt = lt;
      if (lt >= 2){ o.threat = true; o.v2 += -26000; }
      else if (lt === 1 && !o.doom){ o.pressure = true; o.v2 += -PRESSURE_PEN; }
    }
    top.sort((a, b) => b.v2 - a.v2);

    // 9) 强制威胁链（threatNega，同 hard）
    if (pts0.length <= 45 && top.length > 1){
      const seqTop = top.slice(0, Math.min(6, top.length));
      let hasFW = false;
      for (const o of seqTop){
        if (o.doom || o.threat) continue;
        G.addP(o.land.x, o.land.y, me);
        const v = -G.threatNega(opp, me, 7, -FSNEG_INF, FSNEG_INF);
        G.removeP(o.land.x, o.land.y);
        if (v >= FW){ o.forceWin = 1; o.v2 = 6e6; hasFW = true; }
        else if (v <= -FW + 50){ o.threat = true; o.v2 += -26000; }
      }
      if (hasFW) top.sort((a, b) => b.v2 - a.v2);
    }

    // 10) 一票否决 → usable
    let usable = top.filter(o => !o.doom && !o.threat);
    if (!usable.length) usable = top;

    // 11) ★ 安静局面：quietNega 深搜选点（覆盖 hard 的近优带随机）
    qnNodes = 0;
    const qCand = usable.slice(0, 6);
    let bestV = -Infinity, bestO = null;
    for (const o of qCand){
      if (o.doom || o.threat) continue;
      G.addP(o.land.x, o.land.y, me);
      let v;
      if (G.wouldWin(o.land, me)) v = QFW + 2;
      else {
        const q = -quietNega(G, opp, me, depth - 1, -FSNEG_INF, FSNEG_INF);
        v = rootModel ? (1 - richMix) * q + richMix * (-richNnEval(G, opp)) : q;
      }
      G.removeP(o.land.x, o.land.y);
      if (useFallbackNoise) v += (Math.random() - 0.5) * 60;
      if (v > bestV){ bestV = v; bestO = o; }
    }
    if (!bestO){ bestO = usable[0]; }
    // 精确复核最终落点
    const ex = G.settleExact(bestO.drop.x, bestO.drop.y);
    return ex ? bestO.drop : bestO.drop;
  }

  return {
    name: opts.name || ('Leader(d' + depth + ',b' + branchK + ',' + (useNN ? 'nn' : 'static') + ')'),
    depth, branchK, qnNodes: () => qnNodes,
    async choose(G, me, opp){ return await choose(G, me); }
  };
}

module.exports = { makeLeaderAgent, reachPtsNode };