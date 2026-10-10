'use strict';
/* ============================================================
   solver-bench —— 新核心（solver-core）vs 内置启发式 AI 的实战强度台

   设计要点：
   - 真值棋盘一律用 solver-core 的 Position（精确稳定落点），不依赖页面物理。
   - 内置 AI 侧仍走页面真实链路：置 occ → await aiChooseMove()（返回**投点**）
     → placePiece + drain 取**实际落点**。这样顺带验证「求解器的稳定落点可直接
     当原页面 drop」这条集成假设，落点若不在精确合法集合里就记为 mismatch。
   - 统计「完成深度」与「节点/秒」，用来回答"相同预算是否真的多算了"，而不只看胜率。
   - --record 输出整局棋谱（含每手诊断），供 analyze-failures.js 定位失败局面。

   用法：
     node tools/solver-bench.js --games 20 --diff hard --color both --timeMs 800
     node tools/solver-bench.js --games 20 --diff hard --color 1 --record tools/bench-games.jsonl
   ============================================================ */
const fs = require('fs');
const { loadGame, drain } = require('./game-sandbox');
const { Position, chooseMove } = require('./solver-core');

const EXPORTS =
  'state,set occ(v){occ=v},get occ(){return occ},aiChooseMove,placePiece,updateMoving,' +
  'K,P1,P2,BLOCK,settleExact,settleDiscrete';

const KEY = (x, y) => `${x},${y}`;

function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined ? true : v;
}

/** 内置 AI 走一步：返回页面物理算出的真实落点 */
async function builtinStep(G, pos, side, diff) {
  G.occ = new Map(pos.board);
  Object.assign(G.state, {
    mode: 'mm', diff, aiKind: 'heur', nnOn: false,
    turn: side === 1 ? G.P1 : G.P2,
    phase: 'idle', winner: 0, winCells: null,
    moveCount: pos.board.size - 1,
    gen: (G.state.gen | 0) + 1,
    mmPaused: false, thinking: false,
  });
  const drop = await G.aiChooseMove();
  if (!drop) throw new Error('内置 AI 未返回落点');
  if (!G.placePiece(drop, side === 1 ? G.P1 : G.P2)) {
    throw new Error(`placePiece 拒绝落子：${JSON.stringify(drop)}`);
  }
  drain(G);
  return { land: G.state.lastMove, winner: G.state.winner, drop };
}

async function playGame(solverColor, diff, opts, maxPly) {
  const G = loadGame(null, EXPORTS);
  const pos = new Position();
  const record = [];
  let plies = 0, solverMs = 0, builtinMs = 0, solverMoves = 0, builtinMoves = 0;
  let depthSum = 0, nodesSum = 0, mismatch = 0, illegal = 0;
  const statuses = { 'proven-win': 0, 'proven-loss': 0, unknown: 0 };
  let result = 'draw', reason = 'maxply';
  while (plies < maxPly) {
    const side = (pos.board.size - 1) % 2 === 0 ? 1 : 2;
    const legal = pos.moves().length;
    if (side === solverColor) {
      const t0 = Date.now();
      const r = chooseMove([...pos.board], side, opts);
      const ms = Date.now() - t0;
      solverMs += ms; solverMoves++;
      if (r.status in statuses) statuses[r.status]++;
      if (r.completedDepth) depthSum += r.completedDepth;
      if (r.nodes) nodesSum += r.nodes.total;
      record.push({ ply: plies, side, move: r.move, status: r.status, score: r.score,
        proofDepth: r.proofDepth, completedDepth: r.completedDepth, nodes: r.nodes || null,
        ms, legal, exhausted: !!r.exhausted });
      if (!r.move) { illegal++; reason = 'solver-null'; break; }
      if (!pos.frontier.has(KEY(r.move.x, r.move.y))) { illegal++; reason = 'solver-illegal'; break; }
      pos.play(r.move, side);
    } else {
      const t0 = Date.now();
      const st = await builtinStep(G, pos, side, diff);
      builtinMs += Date.now() - t0; builtinMoves++;
      record.push({ ply: plies, side, move: st.land, kind: 'builtin', legal });
      if (st.winner) { result = st.winner === solverColor ? 'win' : 'loss'; reason = 'builtin-claim'; break; }
      if (!st.land || !pos.frontier.has(KEY(st.land.x, st.land.y))) { mismatch++; reason = 'land-off-frontier'; break; }
      pos.play(st.land, side);
    }
    plies++;
    const w = pos.winner();
    if (w) { result = w === solverColor ? 'win' : 'loss'; reason = 'connect4'; break; }
  }
  return { result, reason, plies, solverMs, builtinMs, solverMoves, builtinMoves,
    depthSum, nodesSum, mismatch, illegal, statuses, record,
    start: [...new Position().board], diff, solverColor };
}

(async function main() {
  const games = Number(argOf('games', 4));
  const diffs = String(argOf('diff', 'hard')).split(',').map(s => s.trim()).filter(Boolean);
  const colorArg = String(argOf('color', 'both'));
  const colors = colorArg === 'both' ? [1, 2] : [Number(colorArg)];
  const timeMs = Number(argOf('timeMs', 800));
  const proofDepth = Number(argOf('proofDepth', 8));
  const maxDepth = Number(argOf('maxDepth', 8));
  const maxPly = Number(argOf('maxPly', 300));
  const recordPath = typeof argOf('record', null) === 'string' ? argOf('record', null) : null;
  const opts = { timeMs, proofDepth, maxDepth, maxNodes: 200000, qDepth: 6 };

  const recOut = recordPath ? fs.createWriteStream(recordPath, { flags: 'w' }) : null;
  const tally = {};
  for (const diff of diffs) {
    for (const color of colors) {
      const rec = tally[`${diff}|P${color}`] = { win: 0, loss: 0, draw: 0, plies: 0, solverMs: 0,
        builtinMs: 0, solverMoves: 0, builtinMoves: 0, depthSum: 0, nodesSum: 0, bad: 0,
        statuses: { 'proven-win': 0, 'proven-loss': 0, unknown: 0 } };
      for (let g = 0; g < games; g++) {
        const r = await playGame(color, diff, opts, maxPly);
        rec[r.result]++;
        rec.plies += r.plies; rec.solverMs += r.solverMs; rec.builtinMs += r.builtinMs;
        rec.solverMoves += r.solverMoves; rec.builtinMoves += r.builtinMoves;
        rec.depthSum += r.depthSum; rec.nodesSum += r.nodesSum;
        rec.bad += r.mismatch + r.illegal;
        for (const k of Object.keys(rec.statuses)) rec.statuses[k] += r.statuses[k];
        if (recOut && r.result !== 'win') recOut.write(JSON.stringify({ game: `${diff}|P${color}#${g + 1}`, ...r }) + '\n');
        const tag = r.result === 'win' ? '胜' : r.result === 'loss' ? '负' : '平';
        console.log(`  ${diff} 求解器=P${color} 第${g + 1}局: ${tag} (${r.reason}, ${r.plies}手, 本局求解${(r.solverMs / 1000).toFixed(1)}s/内置${(r.builtinMs / 1000).toFixed(1)}s)` +
          (r.mismatch || r.illegal ? ` ⚠不一致=${r.mismatch} 非法=${r.illegal}` : ''));
      }
    }
  }
  if (recOut) recOut.end();
  console.log('\n=== 汇总（求解器视角）===');
  for (const key of Object.keys(tally)) {
    const r = tally[key], n = r.win + r.loss + r.draw;
    const rate = n ? (100 * r.win / n).toFixed(0) : '-';
    const avgDepth = r.solverMoves ? (r.depthSum / r.solverMoves).toFixed(2) : '-';
    const knps = r.solverMs ? (r.nodesSum / r.solverMs).toFixed(1) : '-';
    console.log(`${key}: ${r.win}胜 ${r.loss}负 ${r.draw}平 (胜率${rate}%)  平均${(r.plies / n).toFixed(1)}手  ` +
      `求解${(r.solverMs / Math.max(1, r.solverMoves)).toFixed(0)}ms/步 内置${(r.builtinMs / Math.max(1, r.builtinMoves)).toFixed(0)}ms/步  ` +
      `平均完成深度${avgDepth} 吞吐${knps}k节点/s  ` +
      `证明[胜${r.statuses['proven-win']} 败${r.statuses['proven-loss']} 未知${r.statuses.unknown}]` +
      (r.bad ? ` ⚠异常${r.bad}` : ''));
  }
  if (recordPath) console.log(`失败棋谱已写入 ${recordPath}`);
})().catch(e => { console.error('对局台异常：', e); process.exit(1); });
