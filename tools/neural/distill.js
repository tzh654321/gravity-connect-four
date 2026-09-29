'use strict';
/* ============================================================
   Leaf 价值标签蒸馏：用 deep quietNega 重新标注既有 occ 样本，
   目标 t = 搜索价值（连续），替代「终局胜负」的含噪标签。
   输出：JSONL {f:[16], t: [-1,1]}
   用法：node distill.js --in data_leader_v1.jsonl --model model_leaf.json
                       --out data_distilled.jsonl --workers 8 --depth 5 --branch 4
   ============================================================ */
const fs = require('fs'), path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');

function arg(name, def){ const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; }
function flag(name){ return process.argv.indexOf('--' + name) >= 0; }

(async () => {
  const IN = arg('in', 'data_leader_v1.jsonl');
  const MODEL = arg('model', 'model_leaf.json');
  const OUT = arg('out', 'data_distilled.jsonl');
  const DEPTH = +arg('depth', '5');
  const BRANCH = +arg('branch', '4');
  const LIMIT = +arg('limit', '0');
  let workers = +arg('workers', '0');
  if (flag('cpus')) workers = -1;
  const WORKERS = workers <= 0 ? Math.max(1, os.cpus().length - 1) : workers;

  const lines = fs.readFileSync(IN, 'utf8').split('\n').filter(l => l.trim());
  if (LIMIT > 0) lines.length = Math.min(lines.length, LIMIT);
  console.log('蒸馏: ' + lines.length + ' 条样本, ' + WORKERS + ' worker, depth' + DEPTH + ' branch' + BRANCH);

  const WRK = path.join(__dirname, 'distill-worker.js');
  fs.writeFileSync(WRK, `
'use strict';
const { parentPort, workerData } = require('worker_threads');
const { createGame } = require('./env');
const args = workerData;
const { makeHtmlAgent } = require('./agents-html');

async function run(){
  const G = createGame();
  const leaf = JSON.parse(require('fs').readFileSync(args.model, 'utf8'));
  G.nnw = leaf; G.state.diff = 'hard'; G.state.nnOn = true;
  G.state.nnDepth = args.depth; G.state.nnBranch = args.branch; G.state.nnMix = 1.0;
  G.state.nnNodeCap = 200000;
  const P1 = G.P1, P2 = G.P2;
  const out = [];
  for (const line of args.chunk){
    const s = JSON.parse(line);
    const m = new Map();
    for (const [x, y, o] of s.occ) m.set(G.K(x, y), o);
    G.occ = m;
    const me = s.moverRed ? P1 : P2, op = me === P1 ? P2 : P1;
    const v = G.quietNega(me, op, args.depth - 1, -1e9, 1e9);   // me 视角，深度-1 轮对手
    const f = Array.from(G.nnFeatures(me, op));
    const t = Math.max(-1, Math.min(1, v / 1200));   // 与网络输出同刻度
    out.push({ f, t });
  }
  parentPort.postMessage({ kind: 'rows', rows: out });
}
run().catch(e => { parentPort.postMessage({ kind: 'err', msg: String(e && e.stack || e) }); });
`);

  const fd = fs.openSync(OUT, 'w');
  const per = Math.ceil(lines.length / WORKERS);
  let done = 0, got = 0;
  const t0 = Date.now();
  await new Promise((resolve) => {
    let active = 0;
    for (let w = 0; w < WORKERS; w++){
      const chunk = lines.slice(w * per, Math.min((w + 1) * per, lines.length));
      if (!chunk.length) continue;
      const wk = new Worker(WRK, { workerData: { chunk, model: MODEL, depth: DEPTH, branch: BRANCH } });
      active++;
      wk.on('message', (m) => {
        if (m.kind === 'rows'){
          for (const r of m.rows) fs.writeSync(fd, JSON.stringify(r) + '\n');
          got += m.rows.length; done++;
          if (done % Math.max(1, Math.floor(WORKERS / 2)) === 0 || done === active){
            console.log('progress ' + done + '/' + active + ' worker, ' + got + ' 条, 墙钟 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
          }
          try { wk.terminate(); } catch (e) {}
          active--;
          if (active <= 0) resolve();
        } else { console.error('worker err:', m.err); try { wk.terminate(); } catch (e) {} active--; if (active <= 0) resolve(); }
      });
      wk.on('error', (e) => { console.error('wk err ' + e.message); active--; if (active <= 0) resolve(); });
    }
  });
  fs.closeSync(fd);
  console.log('完成: ' + got + ' 条 → ' + OUT + '，墙钟 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });