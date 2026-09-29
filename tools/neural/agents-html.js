'use strict';
/* ============================================================
   HTML 内嵌 NN-AI 对手：与最终交付使用的同一份代码路径
   （不经过 agents-leader，直接驱动 G.aiChooseMove）。
   通过 G.nnw / G.nnw2 注入 16 维叶子模型与可选 18 维根层模型；
   aiChooseMove 内部在 diff==='hard' 且 __NNW 就绪时启用 quietNega 选点。
   ============================================================ */
const fs = require('fs');
const { createGame, reset, drain } = require('./env');

function loadWeights(modelPath){
  if (!modelPath) return null;
  return JSON.parse(fs.readFileSync(modelPath, 'utf8'));
}

function makeHtmlAgent({ model, richmodel, depth = 4, branchK = 6, nodeCap = 100000, nnMix = 1.0, richMix = 0.4, blueDeeper = false, qN = 16, name = 'HL' } = {}){
  const leaf = loadWeights(model);
  const root = loadWeights(richmodel);
  const done = new WeakSet();
  return {
    name,
    async choose(G, me, opp){
      if (!done.has(G)){
        G.nnw = leaf;
        if (root) G.nnw2 = root;
        G.state.diff = 'hard';
        G.state.nnOn = true;
        G.state.nnOff = false;
        G.state.nnDepth = depth;
        G.state.nnBranch = branchK;
        G.state.nnNodeCap = nodeCap;
        G.state.nnMix = nnMix;
        G.state.richMix = richMix;
        G.state.nnBlueDeeper = blueDeeper;
        G.state.nnQN = qN;
        done.add(G);
      }
      const r = await G.aiChooseMove();
      return r;
    }
  };
}

module.exports = { makeHtmlAgent };