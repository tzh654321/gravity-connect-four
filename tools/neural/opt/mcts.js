'use strict';
/* ============================================================
   PUCT MCTS 搜索代理（价值网络 + 启发式先验）
   - 行动空间 = 可达落点（genCandidates → settleDiscrete 去重）
   - 叶子评估 = 价值网络（features → [-1,1]，行棋方视角）
   - 先验 P = deltaEval 启发式 softmax
   - 根层返回「落点对应的最优投点」（与 agents-nn 同口径：取最靠中心的投点）
   设计目标：用深搜索替代固定深度 alpha-beta 叶子（突破天花板 C：浅搜索），
            数据来源为 NN 自身（配合 selfplay.js 突破天花板 B：教师锁）。
   注：重力四子棋盘无边界（中心堆积），故策略头改为「落点集合」动态大小，
       本模块以 MCTS 访问分布作为策略信号，价值网络为唯一可训练组件。
   ============================================================ */
function opponent(G, me){ return me === G.P1 ? G.P2 : G.P1; }

/* 特征模块可切换：默认 ../features（16维），P2 用 OPT_FEAT=./features_p2；
   也可在 makeMCTSAgent 的 opts.feat 单独指定（供 eval 同时跑新旧两种维度模型） */
function resolveFeatures(opts){
  if (opts && opts.feat) return opts.feat;
  if (process.env.OPT_FEAT) return require(process.env.OPT_FEAT).features;
  return require('../features').features;
}

/* 枚举唯一落点 + 每个落点对应的最优（最靠中心）投点 */
function landingActions(G){
  const cands = G.genCandidates();
  const map = new Map();
  for (const d of cands){
    const l = G.settleDiscrete(d.x, d.y);
    const k = G.K(l.x, l.y);
    const rec = map.get(k);
    if (!rec) map.set(k, { land: l, drop: d });
    else if (Math.abs(d.x) + Math.abs(d.y) < Math.abs(rec.drop.x) + Math.abs(rec.drop.y)) rec.drop = d;
  }
  return [...map.values()];
}

function cloneOcc(G){ return new Map(G.occ); }

function withOcc(G, occ, fn){
  const save = G.occ; G.occ = occ; const r = fn(); G.occ = save; return r;
}

function makeMCTSAgent(model, opts){
  opts = opts || {};
  const valueFn = (G, me, op) => model.infer(resolveFeatures(opts)(G, me, op))[0]; // [-1,1]
  const sims = opts.sims || 120;
  const cpuct = opts.cpuct != null ? opts.cpuct : 1.4;
  const maxNodes = opts.maxNodes || 1500;
  const priorTemp = opts.priorTemp != null ? opts.priorTemp : 1.0;
  const rootTemp = opts.rootTemp != null ? opts.rootTemp : 1.0; // >0 探索采样；0 = 取 argmax
  const durMax = opts.moveCap || 300;

  function priorScores(G, acts, me, op){
    const sc = new Array(acts.length);
    let mx = -Infinity;
    for (let i = 0; i < acts.length; i++){
      const p = acts[i].land;
      const s = G.deltaEval(p, me) + 0.35 * G.deltaEval(p, op);
      sc[i] = s; if (s > mx) mx = s;
    }
    let sum = 0; const pr = new Array(acts.length);
    for (let i = 0; i < acts.length; i++){ const e = Math.exp((sc[i] - mx) / priorTemp); pr[i] = e; sum += e; }
    for (let i = 0; i < acts.length; i++) pr[i] /= sum;
    return pr;
  }

  function newNode(occ, turn){
    return { occ, turn, expanded: false, acts: [], pri: [], N: [], W: [], Q: [],
             kids: new Map(), isWin: false, winAct: null, terminal: false, termVal: 0, actFromParent: -1 };
  }

  function expand(G, node){
    if (node.expanded) return;
    node.expanded = true;
    const acts = landingActions(G);
    if (!acts.length){ node.terminal = true; node.termVal = 0; return; }
    node.acts = acts;
    node.pri = priorScores(G, acts, node.turn, opponent(G, node.turn));
    node.N = new Array(acts.length).fill(0);
    node.W = new Array(acts.length).fill(0);
    node.Q = new Array(acts.length).fill(0);
    node.kids = new Map();
    for (let i = 0; i < acts.length; i++){
      if (G.wouldWin(acts[i].land, node.turn)){ node.isWin = true; node.winAct = i; break; }
    }
  }

  let nodeBudget = 0;

  function search(G, root){
    for (let s = 0; s < sims; s++){
      const path = [root];
      let node = root;
      let leafV = 0;
      // 下降：直到到达终端/胜节点，或节点预算耗尽（叶子用价值网络评估）
      while (true){
        if (node.terminal){ leafV = node.termVal; break; }
        if (!node.expanded){
          if (nodeBudget >= maxNodes){ leafV = valueEval(G, node); break; }
          nodeBudget++;
          withOcc(G, node.occ, () => expand(G, node));
        }
        if (node.isWin){ leafV = 1; break; }              // 行棋方此刻可一步成杀
        if (!node.acts.length){ node.terminal = true; node.termVal = 0; leafV = 0; break; }
        const a = selectAction(node);
        // 取/建子节点
        let child = node.kids.get(a);
        if (!child){
          const act = node.acts[a];
          const childOcc = new Map(node.occ);
          let childWin = false;
          withOcc(G, childOcc, () => { G.addP(act.land.x, act.land.y, node.turn); childWin = G.wouldWin(act.land, node.turn); });
          child = newNode(childOcc, opponent(G, node.turn));
          child.actFromParent = a;
          if (childWin){ child.terminal = true; child.termVal = -1; } // 对手视角：刚被击败
          node.kids.set(a, child);
        }
        path.push(child);
        node = child;
        // 下一轮循环顶部处理 child.terminal / child.isWin
      }
      leafBackup(path, leafV);   // 一次性沿 path 反号回传
    }
  }

  function leafBackup(path, leafV){
    // leafV = 当前叶子行棋方视角值；沿 path 向上逐层反号
    let v = leafV;
    for (let i = path.length - 1; i > 0; i--){
      const node = path[i];
      const parent = path[i - 1];
      const a = node.actFromParent;
      if (a < 0) break;
      const vp = -v;
      parent.N[a]++; parent.W[a] += vp; parent.Q[a] = parent.W[a] / parent.N[a];
      v = vp;
    }
  }

  function valueEval(G, node){
    // 行棋方视角价值网络评估
    return withOcc(G, node.occ, () => valueFn(G, node.turn, opponent(G, node.turn)));
  }

  function selectAction(node){
    let totalN = 0; for (let i = 0; i < node.N.length; i++) totalN += node.N[i];
    let bestA = -1, bestU = -Infinity;
    for (let i = 0; i < node.acts.length; i++){
      const n = node.N[i];
      let u;
      if (n === 0) u = node.pri[i] * Math.sqrt(totalN + 1) + 1e-3 * Math.random();
      else u = node.Q[i] + cpuct * node.pri[i] * Math.sqrt(totalN) / (1 + n);
      if (u > bestU){ bestU = u; bestA = i; }
    }
    return bestA;
  }

  async function choose(G, me){
    const op = opponent(G, me);
    const root = newNode(cloneOcc(G), me);
    nodeBudget = 0;
    withOcc(G, root.occ, () => expand(G, root));
    // 根层一步杀直取
    if (root.isWin){
      const land = root.acts[root.winAct].land;
      const ex = G.settleExact(root.acts[root.winAct].drop.x, root.acts[root.winAct].drop.y);
      if (G.wouldWin(ex, me)) return root.acts[root.winAct].drop;
    }
    if (!root.acts.length) return null;
    search(G, root);
    // 根层选点：rootTemp>0 则按访问次数 softmax 采样（自博弈探索），否则 argmax N
    let pick;
    if (rootTemp > 0){
      let mx = -Infinity; for (let i = 0; i < root.N.length; i++) if (root.N[i] > mx) mx = root.N[i];
      const probs = root.N.map(n => Math.exp((n - mx) / (rootTemp * Math.max(1, mx))));
      let sum = probs.reduce((a, b) => a + b, 0), r = Math.random() * sum;
      pick = 0; for (let i = 0; i < probs.length; i++){ r -= probs[i]; if (r <= 0){ pick = i; break; } }
    } else {
      let bi = -1, bv = -Infinity; for (let i = 0; i < root.N.length; i++){ if (root.N[i] > bv){ bv = root.N[i]; bi = i; } }
      pick = bi;
    }
    return root.acts[pick].drop;
  }

  return {
    name: opts.name || ('MCTS(s' + sims + ')'),
    sims,
    async choose(G, me, op){ return await choose(G, me); }
  };
}

module.exports = { makeMCTSAgent, landingActions, cloneOcc, withOcc, opponent };
