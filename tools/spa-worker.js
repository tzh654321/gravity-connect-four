'use strict';
/* self-play worker（并行模式）：每 worker 复用模块级沙箱连续打局
   playSelf 是 async，必须 await 后再回传，否则回传的是 Promise */
const { parentPort } = require('worker_threads');
const { playSelf } = require('./selfplay-core');

parentPort.on('message', async msg => {
  if (msg.kind === 'game'){
    try {
      parentPort.postMessage({ kind: 'result', id: msg.id, r: await playSelf(msg.diff || 'hard') });
    } catch (e){
      parentPort.postMessage({ kind: 'error', id: msg.id, message: String(e && e.stack || e) });
    }
  }
  if (msg.kind === 'quit') process.exit(0);
});
