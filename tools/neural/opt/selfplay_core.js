'use strict';
/* ============================================================
   自博弈核心（被 selfplay.js 单进程路径与 selfplay_worker.js 多核路径共用）
   playOne：用给定 MCTS agent 自对弈一局，返回 {w, s:[{f,m}]}
   ============================================================ */
const { createGame, drain } = require('../env');
const { MLP } = require('../mlp');
const { makeMCTSAgent } = require('./mcts');

const FEATURES = (process.env.OPT_FEAT ? require(process.env.OPT_FEAT) : require('../features')).features;

function makeAgent(modelJson, sims, rootTemp){
  const model = MLP.load(modelJson);
  return makeMCTSAgent(model, { sims, maxNodes: 1500, rootTemp, feat: FEATURES });
}

async function playOne(agent, first, maxMoves){
  const G = createGame();
  const P1 = G.P1, P2 = G.P2;
  G.state.turn = first;
  const samples = [];
  let moves = 0;
  while (moves < maxMoves){
    const me = G.state.turn, op = me === P1 ? P2 : P1;
    if (G.state.phase !== 'idle'){ drain(G); if (G.state.phase !== 'idle') break; }
    samples.push({ f: Array.from(FEATURES(G, me, op)), m: me });
    const cell = await agent.choose(G, me, op);
    if (!cell) break;
    G.placePiece(cell, me); drain(G); moves++;
    if (G.state.phase === 'over') break;
  }
  return { w: G.state.winner, s: samples };
}

module.exports = { makeAgent, playOne };
