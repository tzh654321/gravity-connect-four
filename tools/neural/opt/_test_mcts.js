'use strict';
const { createGame, reset, drain } = require('../env');
const { MLP } = require('../mlp');
const { makeMCTSAgent } = require('./mcts');
const fs = require('fs');

(async () => {
  const modelPath = './tools/neural/model.json';
  let modelObj = fs.existsSync(modelPath) ? JSON.parse(fs.readFileSync(modelPath, 'utf8')) : null;
  const model = modelObj ? MLP.load(modelObj) : new MLP([16, 64, 64, 1], { act: 'tanh', outAct: 'tanh' });
  const agent = makeMCTSAgent(model, { sims: 60, maxNodes: 800 });
  const G = createGame();
  const P1 = G.P1, P2 = G.P2;
  let moves = 0, ok = true, t0 = Date.now();
  while (moves < 60){
    const me = G.state.turn, op = me === P1 ? P2 : P1;
    if (G.state.phase !== 'idle'){ drain(G); if (G.state.phase !== 'idle') break; }
    const cell = await agent.choose(G, me, op);
    if (!cell){ console.log('no move at', moves); ok = false; break; }
    G.placePiece(cell, me); drain(G); moves++;
    if (G.state.phase === 'over'){ console.log('game over winner', G.state.winner, 'moves', moves); break; }
  }
  console.log('played', moves, 'moves in', ((Date.now() - t0) / 1000).toFixed(1), 's OK=', ok);
})();
