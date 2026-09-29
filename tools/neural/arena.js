'use strict';
/* ============================================================
   双 AI 对弈：同一棋盘 arena，两 AI 轮流出招。
   agent = { name, choose(G, me, opp) -> Promise<{x,y} drop> }
   用真实 HTML 的 aiChooseMove 作为内置对手（hard 等现成强度）。
   ============================================================ */
const { createGame, reset, drain } = require('./env');

async function playGame(agentA, agentB, opts){
  const G = createGame();
  const P1 = G.P1, P2 = G.P2;
  const first = (opts && opts.first) || P1;
  G.state.turn = first;
  const agents = {};
  agents[P1] = agentA; agents[P2] = agentB;
  const maxMoves = (opts && opts.maxMoves) || 400;
  const history = [];
  let moves = 0;
  const t0 = Date.now();
  let slowMs = 0;
  while (moves < maxMoves){
    const me = G.state.turn, opp = me === P1 ? P2 : P1;
    if (G.state.phase !== 'idle') { drain(G); if (G.state.phase !== 'idle') break; }
    const t = Date.now();
    let cell = null;
    try {
      cell = await agents[me].choose(G, me, opp);
    } catch (e) {
      console.error('agent error:', e);
      cell = null;
    }
    const ms = Date.now() - t; if (ms > slowMs) slowMs = ms;
    if (!cell) break;
    G.placePiece(cell, me);
    drain(G);
    history.push({ n: moves + 1, owner: me, drop: cell, land: G.state.lastMove ? { x: G.state.lastMove.x, y: G.state.lastMove.y } : null });
    moves++;
    if (G.state.phase === 'over') break;
  }
  return {
    moves, winner: G.state.winner,
    history,
    ms: Date.now() - t0, slowMs
  };
}

module.exports = { playGame, createGame, reset, drain };