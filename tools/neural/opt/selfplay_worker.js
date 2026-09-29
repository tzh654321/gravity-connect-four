'use strict';
/* ============================================================
   selfplay 多核 worker：负责 [start, start+count) 区间的若干局自博弈，
   把每局样本 JSON 行收集后在结束时回传主线程（不写临时文件，主线程一次性写出，
   规避沙箱对 fs.unlink 的安全删除拦截）。
   ============================================================ */
const { workerData, parentPort } = require('worker_threads');
const { makeAgent, playOne } = require('./selfplay_core');

async function run(){
  const { modelJson, sims, rootTemp, maxMoves, start, count } = workerData;
  const agent = makeAgent(modelJson, sims, rootTemp);
  const lines = [];
  let samples = 0;
  for (let i = 0; i < count; i++){
    const gIdx = start + i;
    const first = (gIdx % 2 === 0) ? 2 : 1; // 全局先后手交替，保持对局平衡
    const g = await playOne(agent, first, maxMoves);
    lines.push(JSON.stringify({ w: g.w, s: g.s }));
    samples += g.s.length;
    // 发送「本局」样本数（非累计）：主线程逐局累加才不会二次膨胀
    parentPort.postMessage({ type: 'progress', done: i + 1, total: count, samples: g.s.length });
  }
  parentPort.postMessage({ type: 'done', samples, lines });
}
run().catch(e => { parentPort.postMessage({ type: 'error', message: (e && e.stack) || String(e) }); process.exit(1); });
