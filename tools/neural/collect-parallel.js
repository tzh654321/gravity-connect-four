'use strict';
/* 并行自博弈数据收集：多 worker 逐局流式回传，增量写 JSONL */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');

const WORKER = path.join(__dirname, 'collect-worker.js');

function arg(name, def){ const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; }
function flag(name){ return process.argv.indexOf('--' + name) >= 0; }

(async () => {
  const games = parseInt(arg('games', '128'), 10);
  const diff = arg('diff', 'hard');
  const agentMode = arg('agent', 'builtin');
  const modelPath = arg('model', '');
  const outPath = arg('out', 'tools/neural/data_hard_v1.jsonl');
  let workers = parseInt(arg('workers', '0'), 10);
  if (flag('cpus')) workers = -1;
  const WORKERS = workers <= 0 ? Math.max(1, os.cpus().length - 1) : workers;
  const perWorker = Math.ceil(games / WORKERS);

  const fd = fs.openSync(outPath, 'a');
  console.log('开始采样: ' + games + ' 局, ' + WORKERS + ' worker, diff=' + diff + ', agent=' + agentMode + ' → ' + outPath);

  const t0 = Date.now();
  let got = 0, finishedGames = 0;

  await new Promise((resolve) => {
    let active = 0;
    for (let w = 0; w < WORKERS; w++){
      const wk = new Worker(WORKER);
      active++;
      wk.on('message', (m) => {
        if (m.kind === 'samples'){
          for (const s of m.samples) fs.writeSync(fd, JSON.stringify(s) + '\n');
          got += m.samples.length; finishedGames += 1;
          if (finishedGames % (WORKERS * 2) === 0 || finishedGames === games){
            const wl = ((Date.now() - t0) / 1000).toFixed(0);
            console.log('progress ' + finishedGames + '/' + games + ' 局, 样本 ' + got + ', 墙钟 ' + wl + 's');
          }
        } else if (m.kind === 'done'){
          wk.postMessage({ kind: 'quit' });
          active--;
          if (active <= 0) resolve();
        }
      });
      wk.on('error', (e) => { console.error('worker err: ' + e.message); active--; if (active <= 0) resolve(); });
      wk.postMessage({ kind: 'go', id: w, games: perWorker, diff, agent: agentMode, model: modelPath });
    }
  });

  fs.closeSync(fd);
  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('完成: ' + got + ' 条样本(' + finishedGames + ' 局), 墙钟 ' + wall + 's, ' + (games / (Date.now() - t0) * 1000).toFixed(2) + ' 局/s');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });