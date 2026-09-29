'use strict';
/* ============================================================
   并行训练器：把「反向传播算梯度」扇出到 worker 池，主线程持有网络与
   Adam 状态，汇总各分片梯度后做唯一一次 Adam 更新。
   - 数学上等价于单线程 trainBatch（同快照、同 Adam 轨迹），仅加速反向传播
   - 权重经 SharedArrayBuffer 与 worker 共享（零拷贝，minibatch 内稳定→同步 SGD）
   - --workers N 控制扇出（默认 min(逻辑核心,24)）
   ============================================================ */
const { Worker } = require('worker_threads');
const os = require('os');
const path = require('path');

function nWorkers(){
  // 实测：本网络仅 7.2K 参数，每批聚合成本 ∝ worker数×参数量，
  // worker 过多时主线程聚合反成瓶颈 → 默认上限锁 8（甜点 6~12）
  const DEFAULT_CAP = 8;
  const explicit = +process.env.TRAIN_WORKERS;
  if (explicit && explicit > 0) return Math.max(1, explicit);      // 显式指定优先
  return Math.max(1, Math.min(os.cpus().length || 4, DEFAULT_CAP));
}

// 把 net.W/B 迁到 SharedArrayBuffer（保留当前值），返回 SAB 数组供 workerData
function toShared(net){
  const sabs = [];
  for (let i = 0; i < net.W.length; i++){
    const w = net.W[i], b = net.B[i];
    const sw = new SharedArrayBuffer(w.byteLength);
    const sb = new SharedArrayBuffer(b.byteLength);
    new Float64Array(sw).set(w);
    new Float64Array(sb).set(b);
    sabs.push({ w: sw, b: sb });
    net.W[i] = new Float64Array(sw);   // 主线程此后直接写共享内存（Adam 更新立即可见）
    net.B[i] = new Float64Array(sb);
  }
  return sabs;
}

function applyAdam(net, accW, accB, n, lr, wd, t){
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  const t1 = 1 - Math.pow(b1, t), t2v = 1 - Math.pow(b2, t);
  const nLayers = net.W.length;
  for (let L = 0; L < nLayers; L++){
    const W = net.W[L], B = net.B[L];
    const ma = net.ma[L], va = net.va[L], mb = net.mb[L], vb = net.vb[L];
    const nOut = net.layout[L + 1], nIn = net.layout[L];
    for (let j = 0; j < nOut; j++){
      const r0 = j * nIn;
      for (let k = 0; k < nIn; k++){
        let g = accW[L][r0 + k] / n;
        if (wd) g -= wd * W[r0 + k] * 0.001;
        const idx = r0 + k;
        ma[idx] = b1 * ma[idx] + (1 - b1) * g;
        va[idx] = b2 * va[idx] + (1 - b2) * g * g;
        const mh = ma[idx] / t1, vh = va[idx] / t2v;
        W[idx] -= lr * mh / (Math.sqrt(vh) + eps);
      }
      let g2 = accB[L][j] / n;
      if (wd) g2 -= wd * B[j] * 0.001;
      mb[j] = b1 * mb[j] + (1 - b1) * g2;
      vb[j] = b2 * vb[j] + (1 - b2) * g2 * g2;
      const mh = mb[j] / t1, vh = vb[j] / t2v;
      B[j] -= lr * mh / (Math.sqrt(vh) + eps);
    }
  }
}

/* 并行训练（原地更新 net）。返回 bestVal。 */
async function parallelTrain(net, rows, epochs, lr0, rng, opts){
  opts = opts || {};
  const bs = opts.bs || 128;
  const wd = opts.wd != null ? opts.wd : 1e-5;
  const logEvery = opts.logEvery || 2;
  const label = opts.label || '';
  const NIN = net.layout[0];
  const workers = nWorkers();
  const sabs = toShared(net);

  // 启动 worker 池（梯度走 transferable 回传，主线程读普通数组，实测最快）
  const pool = [];
  for (let i = 0; i < workers; i++){
    const w = new Worker(path.join(__dirname, 'train_worker.js'), {
      workerData: { layout: net.layout, act: net.act, outAct: net.outAct, W: sabs.map(s => s.w), B: sabs.map(s => s.b) }
    });
    w.__pending = null;
    w.on('message', (m) => { if (w.__pending){ const r = w.__pending; w.__pending = null; r(m); } });
    pool.push(w);
  }

  // 主线程梯度累加器（预分配，每批只清零）
  const accW = net.W.map(w => new Float64Array(w.length));
  const accB = net.B.map(b => new Float64Array(b.length));

  const nt = rows.length;
  const idx = rows.map((_, i) => i);
  let bestVal = Infinity;

  const mse = (set) => { let e = 0; for (const r of set){ const p = net.infer(r.f)[0]; e += (p - r.t) * (p - r.t); } return e / set.length; };
  const val = opts.val;

  for (let ep = 1; ep <= epochs; ep++){
    // 洗牌
    for (let i = nt - 1; i > 0; i--){ const j = Math.floor(rng() * (i + 1)); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
    const lr = lr0 * Math.pow(0.94, ep - 1);
    for (let b = 0; b < nt; b += bs){
      const bi = idx.slice(b, Math.min(b + bs, nt));
      const n = bi.length;
      // 把 minibatch 轮转分到各 worker
      const shards = Array.from({ length: workers }, () => []);
      bi.forEach((sIdx, si) => shards[si % workers].push(sIdx));
      const tasks = [];
      for (let wi = 0; wi < workers; wi++){
        const shard = shards[wi];
        if (shard.length === 0) continue;
        const feats = new Float64Array(shard.length * NIN);
        const targets = new Float64Array(shard.length);
        shard.forEach((sIdx, si) => { feats.set(rows[sIdx].f, si * NIN); targets[si] = rows[sIdx].t; });
        tasks.push(new Promise((res) => {
          pool[wi].__pending = res;
          pool[wi].postMessage({ type: 'grad', feats, targets }, [feats.buffer, targets.buffer]);
        }));
      }
      const resps = await Promise.all(tasks);
      // 汇总各 worker 回传的梯度
      for (const a of accW) a.fill(0);
      for (const a of accB) a.fill(0);
      for (const r of resps){
        for (let L = 0; L < accW.length; L++){
          const a = accW[L], g = r.gw[L];
          for (let i = 0; i < a.length; i++) a[i] += g[i];
        }
        for (let L = 0; L < accB.length; L++){
          const a = accB[L], g = r.gb[L];
          for (let i = 0; i < a.length; i++) a[i] += g[i];
        }
      }
      net.t++;
      applyAdam(net, accW, accB, n, lr, wd, net.t);
      // 共享权重已更新 → worker 下一 minibatch 读到新快照（minibatch 内不变→同步 SGD）
    }
    if ((ep % logEvery === 0 || ep === epochs) && val){
      const tM = mse(rows), vM = mse(val);
      const mark = vM < bestVal ? ' ←' : '';
      if (vM < bestVal) bestVal = vM;
      console.log(label + ' epoch ' + ep + ' train[mse=' + tM.toFixed(4) + '] val[mse=' + vM.toFixed(4) + ']' + mark);
    } else if (ep % logEvery === 0 || ep === epochs){
      console.log(label + ' epoch ' + ep + ' (无验证集)');
    }
  }

  // 收尾 worker
  await Promise.all(pool.map(w => new Promise((res) => { w.on('exit', res); w.terminate(); })));
  return bestVal;
}

module.exports = { parallelTrain, nWorkers, toShared };
