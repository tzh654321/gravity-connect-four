'use strict';
/* ============================================================
   eval 多核 worker：负责一批 (对手×先后手) 对局任务，
   返回每局结果 {oppKey, nnAsA, got, winner}。
   ============================================================ */
const { workerData, parentPort } = require('worker_threads');
const { playMatch } = require('./eval_core');

async function run(){
  const { tasks, newModelJson, SIMS, OLD } = workerData; // tasks: [{oppKey, nnAsA, idx}]
  const results = [];
  for (const t of tasks){
    const r = await playMatch(newModelJson, SIMS, OLD, t.oppKey, t.nnAsA);
    results.push({ oppKey: r.oppKey, nnAsA: r.nnAsA, got: r.got, winner: r.winner, idx: t.idx });
  }
  parentPort.postMessage({ type: 'done', results });
}
run().catch(e => { parentPort.postMessage({ type: 'error', message: (e && e.stack) || String(e) }); process.exit(1); });
