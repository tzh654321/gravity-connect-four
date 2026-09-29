'use strict';
/* 并行自博弈数据收集 worker：每打完一局立即回传，便于增量落盘与监控
   agent='html' → 被测方用 HTML 内嵌 NN-AI（aiChooseMove），对手走内置 hard */
const { parentPort } = require('worker_threads');
const { playCollect } = require('./collect');
const { builtinAgent } = require('./agents-builtin');

parentPort.on('message', async (msg) => {
  if (msg.kind === 'quit'){ process.exit(0); return; }
  const diff = msg.diff || 'hard';
  let A, B;
  if (msg.agent === 'html'){
    const { makeHtmlAgent } = require('./agents-html');
    A = makeHtmlAgent({ model: msg.model, depth: msg.depth || 4, branchK: msg.branch || 6, nnMix: 1.0, name: 'HL' });
    B = builtinAgent(diff);
  } else {
    A = builtinAgent(diff);
    B = builtinAgent(diff);
  }
  const extra = msg.extra || {};
  const t0 = Date.now();
  for (let i = 0; i < msg.games; i++){
    const first = i % 2 === 0 ? 2 : 1;
    const s = await playCollect(A, B, { first, maxMoves: extra.maxMoves });
    parentPort.postMessage({ kind: 'samples', id: msg.id, samples: s, g: i + 1, ng: msg.games, t: Math.round((Date.now() - t0) / 1000) });
  }
  parentPort.postMessage({ kind: 'done', id: msg.id });
});