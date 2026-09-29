'use strict';
/* ============================================================
   训练价值网络
   用法：node train.js --data tools/neural/data/*.jsonl [--epochs 40] [--lr 0.003]
                    [--hidden 64,64] [--out tools/neural/model.json]
   数据：JSON Lines {f:[16], t:-1|0|1}
   ============================================================ */
const fs = require('fs'), path = require('path');
const { MLP } = require('./mlp');
const { features, FEAT_DIM } = require('./features');
const { features2, FEAT_DIM2 } = require('./features2');
const { createGame, reset } = require('./env');

function args(){
  const a = {};
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i += 2) a[v[i].replace(/^--/, '')] = v[i + 1];
  return a;
}
const A = args();
const EPOCHS = +A.epochs || 40;
const LR0 = +A.lr || 0.003;
const OUT = A.out || path.join(__dirname, 'model.json');
const SEED = +A.seed || 20260905;
const FEAT = A.feat || 'v1';          // v1=16维(便宜) v2=18维(含精确叉点)

function mulberry(seed){
  return function(){ seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function loadData(paths){
  const samples = [];
  for (const p of paths){
    for (const line of fs.readFileSync(p, 'utf8').split('\n')){
      const lineT = line.trim();
      if (!lineT) continue;
      samples.push(JSON.parse(lineT));
    }
  }
  return samples;
}

function shuffle(arr, rng){
  for (let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function stats(net, samples){
  let mse = 0, corrNum = 0, corrA = 0, corrB = 0, n = samples.length;
  const tMean = samples.reduce((s, x) => s + x.t, 0) / n;
  for (const s of samples){
    const p = net.infer(s.f)[0];
    const e = p - s.t;
    mse += e * e;
    corrNum += (p * s.t);
    corrA += p * p; corrB += s.t * s.t;
  }
  const corr = (corrNum / n) / Math.sqrt((corrA / n) * (corrB / n) || 1);
  return { mse: mse / n, corr, meanPred: corrNum / n, tMean };
}

/* 由 occ 快照重建局面并计算所选特征（共享一个 env，仅重建 occ） */
let _G = null;
function featurize(s){
  if (FEAT === 'v2'){
    if (!_G) _G = createGame();
    reset(_G);
    const m = new Map();
    for (const [x, y, o] of s.occ) m.set(_G.K(x, y), o);
    _G.occ = m;
    const me = s.moverRed ? _G.P1 : _G.P2;
    const op = me === _G.P1 ? _G.P2 : _G.P1;
    return Array.from(features2(_G, me, op));
  }
  if (FEAT === 'v16'){
    if (!s.occ) return s.f;               // 旧样本降级用存盘 16 维
    if (!_G) _G = createGame();
    reset(_G);
    const m = new Map();
    for (const [x, y, o] of s.occ) m.set(_G.K(x, y), o);
    _G.occ = m;
    const me = s.moverRed ? _G.P1 : _G.P2;
    const op = me === _G.P1 ? _G.P2 : _G.P1;
    return Array.from(features(_G, me, op));
  }
  return s.f;
}

function main(){
  const dataPaths = A.data ? A.data.split(',') : (A.dataPath ? [A.dataPath] : null);
  if (!dataPaths){
    console.error('用法: --data a.jsonl,b.jsonl');
    process.exit(1);
  }
  let samples = loadData(dataPaths);
  if (FEAT === 'v2' || FEAT === 'v16'){
    const src = samples;
    samples = [];
    for (const s of src){
      const f = featurize(s);
      if (f) samples.push({ f, t: s.t });
    }
    console.log('特征 ' + FEAT + '，原 ' + src.length + ' 条，可重建/取用 ' + samples.length + ' 条');
  }
  console.log('样本数 ' + samples.length);
  const rng = mulberry(SEED);
  shuffle(samples, rng);
  const split = Math.floor(samples.length * 0.9);
  const train = samples.slice(0, split), val = samples.slice(split);
  const hidden = (A.hidden || '64,64').split(',').map(Number);
  const featDim = FEAT === 'v2' ? FEAT_DIM2 : FEAT_DIM;
  const layout = [featDim, ...hidden, 1];
  const net = new MLP(layout, { act: 'tanh', outAct: 'tanh', scale: 0.5 });
  console.log('网络: ' + layout.join('×'));

  const BS = 128;
  const nt = train.length;
  const idx = train.map((_, i) => i);
  let bestVal = Infinity;
  for (let ep = 1; ep <= EPOCHS; ep++){
    shuffle(idx, rng);
    const lr = LR0 * Math.pow(0.94, ep - 1);
    for (let b = 0; b < nt; b += BS){
      const bi = idx.slice(b, Math.min(b + BS, nt));
      const X = bi.map(i => train[i].f), Y = bi.map(i => train[i].t);
      net.trainBatch(X, Y, { lr, wd: 1e-5 });
    }
    if (ep % 2 === 0 || ep === EPOCHS){
      const st = stats(net, val);
      const stT = stats(net, train);
      const marker = st.mse < bestVal ? ' ←' : '';
      if (st.mse < bestVal) bestVal = st.mse;
      console.log('epoch ' + ep + ' train[mse=' + stT.mse.toFixed(4) + ' corr=' + stT.corr.toFixed(3) + '] ' +
        'val[mse=' + st.mse.toFixed(4) + ' corr=' + st.corr.toFixed(3) + ']' + marker);
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(net.save()));
  console.log('已保存模型 → ' + OUT);
  const fin = stats(net, samples);
  console.log('全样本 mse=' + fin.mse.toFixed(4) + ' corr=' + fin.corr.toFixed(3));
}

main();