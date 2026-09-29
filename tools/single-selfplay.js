'use strict';
/* 单线程 self-play 封装（供 parallel-selfplay 并发=1 时做公平基线）
   runAll 是 async（aiChooseMove 为异步），调用方需 await */
const { runAll: runAllCore } = require('./selfplay-core');

async function run(games, diff){
  const t0 = Date.now();
  const results = await runAllCore(games, diff);
  return { wall: (Date.now() - t0) / 1000, results };
}

module.exports = { runAll: run };
