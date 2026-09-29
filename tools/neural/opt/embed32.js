'use strict';
/* ============================================================
   把 16 维模型「嵌入」32 维网络：新增 16 维在第一层的权重置 0。
   ⇒ 32 维网络与 16 维模型功能完全等价（新维贡献恒为 0），
      但可作为 P3 的强起点：自博弈 agent 一上来就有原模型实力（对 hard 75%），
      避免冷启动随机网络先产出一批垃圾数据。
   用法：node embed32.js <输入16维模型> <输出32维模型> [新维数]
   ============================================================ */
const fs = require('fs'), path = require('path');
const { MLP } = require('../mlp');

const IN = process.argv[2] || path.join(__dirname, 'model_p2.json');
const OUT = process.argv[3] || path.join(__dirname, 'model_p3_init.json');
const NEW_DIM = +(process.argv[4] || 16);

const src = JSON.parse(fs.readFileSync(IN, 'utf8'));
const inDim = src.layout[0];
const outDim = inDim + NEW_DIM;

// 逐层复制；第一层按「输出行」展开：每行前 inDim 个权重照抄，后 NEW_DIM 个填 0
const W = [], B = [];
for (let L = 0; L < src.W.length; L++){
  const nIn = src.layout[L], nOut = src.layout[L + 1];
  const isFirst = (L === 0);
  const wLen = isFirst ? outDim * nOut : nIn * nOut;
  const w = new Float64Array(wLen);
  if (isFirst){
    for (let j = 0; j < nOut; j++){
      for (let k = 0; k < nIn; k++) w[j * outDim + k] = src.W[L][j * nIn + k];
      // 新增维权重保持 0（Float64Array 默认 0）
    }
  } else {
    w.set(src.W[L]);
  }
  W.push(Array.from(w));
  B.push(Array.from(src.B[L]));
}

const outLayout = src.layout.slice();
outLayout[0] = outDim;
const obj = { layout: outLayout, act: src.act || 'tanh', outAct: src.outAct || 'tanh', W, B };
fs.writeFileSync(OUT, JSON.stringify(obj));

// 自检：随机输入下，把新增维置 0 后应与原模型输出一致
const a = MLP.load(src), b = MLP.load(obj);
const rnd = () => Math.random() * 2 - 1;
let maxDiff = 0;
for (let t = 0; t < 200; t++){
  const x16 = Array.from({ length: inDim }, rnd);
  const x32 = x16.concat(new Array(NEW_DIM).fill(0));
  maxDiff = Math.max(maxDiff, Math.abs(a.infer(x16)[0] - b.infer(x32)[0]));
}
console.log('嵌入完成: ' + IN + ' (' + src.layout.join('×') + ') → ' + OUT + ' (' + outLayout.join('×') + ')');
console.log('等价性自检(新维置0, 200 组随机输入): maxDiff=' + maxDiff.toExponential(2) + '  ' + (maxDiff < 1e-12 ? 'PASS ✅' : 'FAIL ❌'));
