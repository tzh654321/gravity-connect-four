'use strict';
/* 并行训练正确性自检：
   同一初始权重 + 同一数据 + 同一 shuffle 种子，分别跑
   顺序训练（原 trainBatch 循环）与并行训练（worker 池），
   比对最终权重差异（只应来自浮点求和顺序，<1e-4）。 */
const { MLP } = require('../mlp');
const { parallelTrain } = require('./parallel_train');

function mulberry(seed){
  return function(){ seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle(arr, rng){ for (let i = arr.length - 1; i > 0; i--){ const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } }

const LAYOUT = [16, 64, 64, 32, 1];
const LR0 = 0.003, EPOCHS = 6, BS = 128;

// 合成数据
const ROWS = [];
const rng0 = mulberry(123);
for (let i = 0; i < 1500; i++){
  const f = []; let s = 0;
  for (let k = 0; k < 16; k++){ const v = rng0() * 2 - 1; f.push(v); s += v; }
  ROWS.push({ f, t: Math.tanh(0.3 * s) + (rng0() - 0.5) * 0.05 });
}
const split = Math.floor(ROWS.length * 0.9);
const train = ROWS.slice(0, split), val = ROWS.slice(split);

function mse(set, net){ let e = 0; for (const r of set){ const p = net.infer(r.f)[0]; e += (p - r.t) * (p - r.t); } return e / set.length; }

// 顺序训练（复刻原 train_pv 主循环）；共用基准初始权重
function seqTrain(initW, initB){
  const net = new MLP(LAYOUT, { act: 'tanh', outAct: 'tanh' });
  for (let i = 0; i < net.W.length; i++){ net.W[i] = Float64Array.from(initW[i]); net.B[i] = Float64Array.from(initB[i]); }
  const rng = mulberry(20260906);
  const nt = train.length, idx = train.map((_, i) => i);
  for (let ep = 1; ep <= EPOCHS; ep++){
    shuffle(idx, rng);
    const lr = LR0 * Math.pow(0.94, ep - 1);
    for (let b = 0; b < nt; b += BS){
      const bi = idx.slice(b, Math.min(b + BS, nt));
      const X = bi.map(i => train[i].f), Y = bi.map(i => train[i].t);
      net.trainBatch(X, Y, { lr, wd: 1e-5 });
    }
  }
  return net;
}

// 并行训练（同种子、同基准初始权重）
async function parTrain(initW, initB){
  const net = new MLP(LAYOUT, { act: 'tanh', outAct: 'tanh' });
  for (let i = 0; i < net.W.length; i++){ net.W[i] = Float64Array.from(initW[i]); net.B[i] = Float64Array.from(initB[i]); }
  const rng = mulberry(20260906);
  await parallelTrain(net, train, EPOCHS, LR0, rng, { val, logEvery: 100 });
  return net;
}

(async () => {
  // 基准初始权重（一份，两个网络共用）
  const base = new MLP(LAYOUT, { act: 'tanh', outAct: 'tanh' });
  const initW = base.W.map(w => Float64Array.from(w));
  const initB = base.B.map(b => Float64Array.from(b));

  const t0 = Date.now();
  const netS = seqTrain(initW, initB);
  const seqMs = Date.now() - t0;
  const t1 = Date.now();
  const netP = await parTrain(initW, initB);
  const parMs = Date.now() - t1;

  // 权重差异
  let maxDiff = 0, sumDiff = 0, cnt = 0;
  for (let L = 0; L < netS.W.length; L++){
    for (let i = 0; i < netS.W[L].length; i++){
      const d = Math.abs(netS.W[L][i] - netP.W[L][i]);
      maxDiff = Math.max(maxDiff, d); sumDiff += d; cnt++;
    }
  }
  const mseS = mse(val, netS), mseP = mse(val, netP);
  console.log('顺序训练 MSE(val)=' + mseS.toFixed(5) + '  用时=' + seqMs + 'ms');
  console.log('并行训练 MSE(val)=' + mseP.toFixed(5) + '  用时=' + parMs + 'ms');
  console.log('权重 maxDiff=' + maxDiff.toExponential(3) + '  meanDiff=' + (sumDiff / cnt).toExponential(3));
  console.log('权重相等性: ' + (maxDiff < 1e-4 ? 'PASS ✅' : 'FAIL ❌ (差异过大，疑似聚合/SAB bug)'));
  process.exit(maxDiff < 1e-4 ? 0 : 1);
})();
