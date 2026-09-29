'use strict';
/* ============================================================
   Elo 评测核心（被 eval_elo.js 单进程路径与 eval_worker.js 多核路径共用）
   playMatch：被测 NEW(MCTS+价值网) 对某一对手打一局，返回 {oppKey, nnAsA, got, winner}
   ============================================================ */
const fs = require('fs');
const { playGame } = require('../arena');
const { builtinAgent } = require('../agents-builtin');
const { makeNNAgent } = require('../agents-nn');
const { makeMCTSAgent } = require('./mcts');
const { MLP } = require('../mlp');

// 被测 NEW 模型用 OPT_FEAT 指定的特征（P2=./features_p2，默认 16维）；旧对手固定用 16维 ../features
const NEW_FEAT = (process.env.OPT_FEAT ? require(process.env.OPT_FEAT) : require('../features')).features;
const ORIG_FEAT = require('../features').features;

function makeOpponent(key, OLD, SIMS){
  if (key === 'easy') return builtinAgent('easy', { label: 'easy' });
  if (key === 'normal') return builtinAgent('normal', { label: 'normal' });
  if (key === 'hard') return builtinAgent('hard', { label: 'hard' });
  if (key === 'old_mcts') return makeMCTSAgent(MLP.load(JSON.parse(fs.readFileSync(OLD, 'utf8'))), { sims: SIMS, maxNodes: 1200, rootTemp: 0, name: 'OLD_MCTS', feat: ORIG_FEAT });
  if (key === 'old_nn') return makeNNAgent(JSON.parse(fs.readFileSync(OLD, 'utf8')), { depth: 2, branchK: 8, name: 'OLD_NN' });
  throw new Error('unknown opponent ' + key);
}

async function playMatch(newModelJson, SIMS, OLD, oppKey, nnAsA){
  const P1 = 1, P2 = 2;
  const newAgent = makeMCTSAgent(MLP.load(newModelJson), { sims: SIMS, maxNodes: 1200, rootTemp: 0, name: 'NEW', feat: NEW_FEAT });
  const oppA = makeOpponent(oppKey, OLD, SIMS);
  const oppB = makeOpponent(oppKey, OLD, SIMS);
  const agentA = nnAsA ? newAgent : oppA;
  const agentB = nnAsA ? oppB : newAgent;
  const r = await playGame(
    { name: agentA.name, choose: (G, me, o) => agentA.choose(G, me, o) },
    { name: agentB.name, choose: (G, me, o) => agentB.choose(G, me, o) },
    { first: P1, maxMoves: 300 });
  const nnRed = r.winner === P1, nnBlue = r.winner === P2;
  let got;
  if (r.winner === 0) got = 0.5;
  else if (nnAsA && nnRed) got = 1;
  else if (nnAsA) got = 0;
  else if (!nnAsA && nnBlue) got = 1;
  else got = 0;
  return { oppKey, nnAsA, got, winner: r.winner };
}

module.exports = { makeOpponent, playMatch };
