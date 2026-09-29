'use strict';
/* ============================================================
   并行训练 worker：仅负责「反向传播算梯度」，不做 Adam 更新。
   - 权重 W/B：SharedArrayBuffer 共享（主线程 Adam 更新后立即可见）
   - 梯度：每次在 trainBatch 内分配普通 Float64Array（V8 访问最快），
           算完经 transferable 零拷贝回传（实测优于共享内存写入/读取）
   ============================================================ */
const { MLP } = require('../mlp');
const { workerData, parentPort } = require('worker_threads');

const LAYOUT = workerData.layout;
const ACT = workerData.act || 'tanh';
const OUTACT = workerData.outAct || 'tanh';
const NIN = LAYOUT[0];

const net = new MLP(LAYOUT, { act: ACT, outAct: OUTACT });
for (let i = 0; i < net.W.length; i++){
  net.W[i] = new Float64Array(workerData.W[i]);   // 视图，直接映射共享内存
  net.B[i] = new Float64Array(workerData.B[i]);
}

parentPort.on('message', (msg) => {
  if (msg.type !== 'grad') return;
  const feats = msg.feats;       // Float64Array, 长度 = count*NIN（已打包）
  const targets = msg.targets;   // Float64Array, 长度 = count
  const count = targets.length;
  const X = new Array(count), Y = new Array(count);
  for (let s = 0; s < count; s++){
    X[s] = feats.subarray(s * NIN, (s + 1) * NIN);
    Y[s] = targets[s];
  }
  net.trainBatch(X, Y, { rawGradUnscaled: true });   // 只算梯度之和，不更新
  const gw = net.lastGradW, gb = net.lastGradB;
  const transfer = [];
  for (const g of gw) transfer.push(g.buffer);
  for (const g of gb) transfer.push(g.buffer);
  parentPort.postMessage({ type: 'grad', gw, gb }, transfer);
  // 提示：gw/gb 的 buffer 已转移，下次 trainBatch 会重建，无副作用
});
