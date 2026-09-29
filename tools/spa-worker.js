'use strict';
/* self-play worker（并行模式）：每 worker 复用模块级沙箱连续打局 */
const { parentPort } = require('worker_threads');
const { playSelf } = require('./selfplay-core');
parentPort.on('message', msg => {
  if (msg.kind === 'game') parentPort.postMessage({ kind:'result', id:msg.id, r: playSelf(msg.diff || 'hard') });
  if (msg.kind === 'quit') process.exit(0);
});
