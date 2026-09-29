'use strict';
/* 单线程 self-play 封装（供 parallel-selfplay 并发=1 时做公平基线） */
const { runAll } = require('./selfplay-core');
function run(games, diff){
  const t0 = Date.now();
  const results = runAll(games, diff);
  return { wall: (Date.now() - t0) / 1000, results };
}
module.exports = { runAll: run };
