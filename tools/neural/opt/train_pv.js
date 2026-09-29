'use strict';
/* ============================================================
   TD(n) 价值网络训练（突破天花板 B：单局±1标签 → 低方差连续目标）
   - 目标网络冻结（init 的副本），提供 n-step bootstrapped 连续目标
   - 训练网络用 MSE 回归（tanh 输出 [-1,1]）
   - 支持从现有 model.json 热启动（保留已≈hard 的强度，再自举提升）
   数据格式（selfplay.js 输出）：每行 { w, s:[{f,m},...] }
   ============================================================ */
const fs = require('fs'), path = require('path');
const { MLP } = require('../mlp');
const { parallelTrain, nWorkers } = require('./parallel_train');

function args(){
  const a = {}; const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++){
    const key = v[i].replace(/^--/, '');
    if (i + 1 >= v.length || v[i + 1].startsWith('--')) a[key] = true; // 布尔开关
    else { a[key] = v[i + 1]; i++; }
  }
  return a;
}
const A = args();
const DATA = A.data || path.join(__dirname, 'data', 'sp_selfplay.jsonl');
const INIT = A.init || path.join(__dirname, '..', 'model.json');
const OUT = A.out || path.join(__dirname, 'model_pv.json');
const EPOCHS = +A.epochs || 30;
const LR0 = +A.lr || 0.003;
const TD = +A.td || 3;
const HIDDEN = (A.hidden || '64,64').split(',').map(Number);
const SEED = +A.seed || 20260906;
const BS = 128;
const FRESH = !!A.fresh;                       // 从头训（随机初始化，无跨特征空间热启动）
const LAYOUT = (A.layout ? A.layout.split(',').map(Number) : [16, 64, 64, 32, 1]);
const TARGET_EPOCHS = +A.targetEpochs || 12;  // --fresh 时：先在同空间用终端标签预训目标网几轮
// B 方案（抗自举退化）：
//   --data 支持逗号分隔的多份数据（混合不同策略产出的数据，避免分布收窄）
//   --targetTerminal 让目标网改用「真实胜负标签」独立预训练，而不是拿 init 当目标（斩断自我蒸馏）
const TARGET_TERMINAL = !!A.targetTerminal;

function mulberry(seed){
  return function(){ seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function loadGames(p){
  const games = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')){
    const t = line.trim(); if (!t) continue;
    games.push(JSON.parse(t));
  }
  return games;
}

// 为每局预计算目标网络价值（固定），并展开为 (f, target) 样本
function buildTargets(games, targetNet){
  const rows = [];
  for (const g of games){
    const s = g.s; const L = s.length;
    const vT = new Float64Array(L);
    for (let k = 0; k < L; k++) vT[k] = targetNet.infer(s[k].f)[0];
    for (let i = 0; i < L; i++){
      const m = s[i].m;
      let target;
      if (i + TD >= L) target = (g.w === 0 ? 0 : (g.w === m ? 1 : -1));
      else target = ((TD % 2 === 0) ? 1 : -1) * vT[i + TD];
      rows.push({ f: s[i].f, t: target });
    }
  }
  return rows;
}

function shuffle(arr, rng){ for (let i = arr.length - 1; i > 0; i--){ const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } }

function terminalRows(games){
  // 终端标签：每个局面 → 该局最终胜负（特征空间无关，适合从零训）
  const rows = [];
  for (const g of games){
    for (const s of g.s){
      const m = s.m;
      const t = (g.w === 0) ? 0 : (g.w === m ? 1 : -1);
      rows.push({ f: s.f, t });
    }
  }
  return rows;
}

function trainNetOn(net, rows, epochs, rng, lr0){
  const nt = rows.length;
  const idx = rows.map((_, i) => i);
  for (let ep = 1; ep <= epochs; ep++){
    shuffle(idx, rng);
    const lr = lr0 * Math.pow(0.94, ep - 1);
    for (let b = 0; b < nt; b += BS){
      const bi = idx.slice(b, Math.min(b + BS, nt));
      const X = bi.map(i => rows[i].f), Y = bi.map(i => rows[i].t);
      net.trainBatch(X, Y, { lr, wd: 1e-5 });
    }
  }
}

async function main(){
  if (A.workers) process.env.TRAIN_WORKERS = String(+A.workers);
  const nW = nWorkers();
  // B 方案：--data 可给多份（逗号分隔），混合不同策略产出的数据，避免分布收窄
  const files = DATA.split(',').map(s => s.trim()).filter(Boolean);
  let games = [];
  for (const f of files) games = games.concat(loadGames(f));
  console.log('数据文件 ' + files.length + ' 份: ' + files.map(f => path.basename(f)).join(' + '));
  console.log('自博弈局数', games.length, ' 目标 TD(n)=' + TD + (FRESH ? ' [从头训]' : '') + '  训练并行核=' + nW);

  let targetNet, net, layout;
  if (FRESH){
    // 从头训：随机初始化训练网；目标网也随机初始化，但先在同空间用终端标签预训几轮
    // → 目标网与训练数据同处 P2 特征流形，避免「旧权重热启动跨特征空间」的语义错配
    layout = LAYOUT;
    targetNet = new MLP(layout, { act: 'tanh', outAct: 'tanh' });
    console.log('从头训：目标网用终端标签预训 ' + TARGET_EPOCHS + ' 轮（同空间, ' + nW + ' 核）');
    await parallelTrain(targetNet, terminalRows(games), TARGET_EPOCHS, LR0, mulberry(SEED + 1), { logEvery: 5, label: '[目标网]' });
  } else {
    const initObj = fs.existsSync(INIT) ? JSON.parse(fs.readFileSync(INIT, 'utf8')) : null;
    if (!initObj){ console.error('init 模型不存在：' + INIT); process.exit(1); }
    targetNet = MLP.load(initObj);     // 冻结目标网络（默认：拿 init 当目标）
    net = (fs.existsSync(OUT) && (() => { try { return MLP.load(JSON.parse(fs.readFileSync(OUT, 'utf8'))); } catch(e){ return null; } })()) || MLP.load(initObj);
    layout = net.layout;
    if (TARGET_TERMINAL){
      // B 方案关键：目标网改为在「真实胜负标签」上独立预训练的新网络，
      // 而不是拿 init 当作目标 —— 斩断「用自己当目标训练自己」的自我蒸馏，
      // 让 TD 目标反映真实对局结果，而不是 init 网络自身的估值偏置。
      targetNet = new MLP(layout, { act: 'tanh', outAct: 'tanh' });
      console.log('B方案：目标网改用终端胜负标签独立预训练 ' + TARGET_EPOCHS + ' 轮（' + nW + ' 核）');
      await parallelTrain(targetNet, terminalRows(games), TARGET_EPOCHS, LR0, mulberry(SEED + 1), { logEvery: 5, label: '[目标网·终端]' });
    }
  }

  const all = buildTargets(games, targetNet);
  console.log('展开样本', all.length);

  const rng = mulberry(SEED);
  shuffle(all, rng);
  const split = Math.floor(all.length * 0.9);
  const train = all.slice(0, split), val = all.slice(split);
  console.log('网络', layout.join('×'), '  训练样本', train.length, ' 验证样本', val.length);

  if (FRESH) net = new MLP(layout, { act: 'tanh', outAct: 'tanh' });

  // 主训练：worker 池并行反向传播（数学上等价于原单线程 trainBatch，同 Adam 轨迹）
  const bestVal = await parallelTrain(net, train, EPOCHS, LR0, rng, { val, bs: 128, wd: 1e-5, logEvery: 2, label: '' });
  fs.writeFileSync(OUT, JSON.stringify(net.save()));
  console.log('已保存 → ' + OUT + ' (best val mse=' + (bestVal === Infinity ? 'n/a' : bestVal.toFixed(4)) + ')');
}
if (require.main === module) { main().catch(e => { console.error(e); process.exit(1); }); }
module.exports = { buildTargets, mulberry };
