'use strict';
/* ============================================================
   纯 JS 稠密 MLP（无外部依赖）
   - infer：推理（返回输出向量，可缓存中间激活）
   - trainBatch：Adam 优化（mini-batch）
   - save/load JSON（权重可直接嵌入 HTML）
   ============================================================ */

function randn(){
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

class MLP {
  /* layout: [in, h1, h2, ..., out] */
  constructor(layout, opts){
    opts = opts || {};
    this.layout = layout;
    this.act = opts.act || 'relu';
    this.outAct = opts.outAct || 'tanh';
    this.W = []; this.B = [];
    for (let i = 0; i < layout.length - 1; i++){
      const nIn = layout[i], nOut = layout[i + 1];
      const std = Math.sqrt(2 / nIn) * (opts.scale != null ? opts.scale : 0.5);
      const W = new Float64Array(nIn * nOut);
      for (let j = 0; j < W.length; j++) W[j] = randn() * std;
      this.W.push(W);
      this.B.push(new Float64Array(nOut));
    }
    this.t = 0;
    this.ma = []; this.va = []; this.mb = []; this.vb = [];
    for (let i = 0; i < this.W.length; i++){
      this.ma.push(new Float64Array(this.W[i].length));
      this.va.push(new Float64Array(this.W[i].length));
      this.mb.push(new Float64Array(this.B[i].length));
      this.vb.push(new Float64Array(this.B[i].length));
    }
  }

  get inSize(){ return this.layout[0]; }
  get outSize(){ return this.layout[this.layout.length - 1]; }

  /* 单样本前向；返回输出数组。cache.acts 存逐层激活（用于训练） */
  infer(x, cache){
    const acts = [x];
    const nLayers = this.W.length;
    let cur = x;
    for (let i = 0; i < nLayers; i++){
      const nIn = this.layout[i], nOut = this.layout[i + 1];
      const W = this.W[i], b = this.B[i];
      const out = new Float64Array(nOut);
      const last = i === nLayers - 1;
      for (let j = 0; j < nOut; j++){
        let s = b[j];
        const r0 = j * nIn;
        for (let k = 0; k < nIn; k++) s += W[r0 + k] * cur[k];
        if (last) out[j] = this.outAct === 'tanh' ? Math.tanh(s) : (1 / (1 + Math.exp(-s)));
        else out[j] = this.act === 'relu' ? (s > 0 ? s : 0) : Math.tanh(s);
      }
      acts.push(out);
      cur = out;
    }
    if (cache) cache.acts = acts;
    return cur;
  }

  /* 批量训练（Adam） */
  trainBatch(inputs, targets, opts){
    opts = opts || {};
    const lr = opts.lr || 1e-3;
    const wd = opts.wd || 0;
    const b1 = 0.9, b2 = 0.999, eps = 1e-8;
    this.t++;
    const t = this.t;
    const n = inputs.length;
    const nLayers = this.W.length;

    // 梯度缓冲：可传入预分配的 gwOut/gbOut（复用，仅清零）以避免每批重复分配
    const gw = opts.gwOut || [], gb = opts.gbOut || [];
    for (let i = 0; i < nLayers; i++){
      if (opts.gwOut && opts.gbOut){ gw[i].fill(0); gb[i].fill(0); }
      else {
        gw.push(new Float64Array(this.W[i].length));
        gb.push(new Float64Array(this.B[i].length));
      }
    }

    const cache = {};
    for (let sIdx = 0; sIdx < n; sIdx++){
      const y = this.infer(inputs[sIdx], cache);
      const acts = cache.acts;
      const out = y[0];
      let d = (out - targets[sIdx]);
      if (this.outAct === 'tanh') d *= (1 - out * out);

      // deltas[L] 为第 L 层（输出层下标 nLayers-1）的误差
      const deltas = new Array(nLayers);
      deltas[nLayers - 1] = [d];
      for (let L = nLayers - 1; L >= 0; L--){
        const act = acts[L];
        const nIn = act.length, nOut = this.layout[L + 1];
        const W = this.W[L];
        const dlt = deltas[L];
        // 累加权/偏梯度
        for (let j = 0; j < nOut; j++){
          const dv = dlt[j];
          if (dv === 0) continue;
          const r0 = j * nIn;
          for (let k = 0; k < nIn; k++) gw[L][r0 + k] += dv * act[k];
          gb[L][j] += dv;
        }
        // 上一层误差
        if (L > 0){
          const nPrev = this.layout[L];
          const prev = new Float64Array(nPrev);
          const prevAct = acts[L];               // 本层输入 = 上一层输出，其 ReLU 导数门控误差回流
          for (let i = 0; i < nPrev; i++){
            let s2 = 0;
            for (let j = 0; j < nOut; j++) s2 += W[j * nIn + i] * dlt[j];
            if (this.act === 'relu') prev[i] = prevAct[i] > 0 ? s2 : 0;
            else prev[i] = (1 - prevAct[i] * prevAct[i]) * s2;
          }
          deltas[L - 1] = prev;
        }
      }
    }

    if (opts.rawGrad){
      // 仅记录梯度（缩放 1/n），不做参数更新（调试/裁剪用）
      this.lastGradW = gw.map(g => Float64Array.from(g, v => v / n));
      this.lastGradB = gb.map(g => Float64Array.from(g, v => v / n));
      return;
    }
    if (opts.rawGradUnscaled){
      // 纯梯度之和（不缩放、不更新），供并行训练主线程跨分片汇总后统一 Adam
      this.lastGradW = gw;
      this.lastGradB = gb;
      return;
    }
    const scale = 1 / n;
    for (let L = 0; L < nLayers; L++){
      const W = this.W[L], B = this.B[L];
      const ma = this.ma[L], va = this.va[L], mb = this.mb[L], vb = this.vb[L];
      const nOut = this.layout[L + 1], nIn = this.layout[L];
      const t1 = 1 - Math.pow(b1, t), t2v = 1 - Math.pow(b2, t);
      for (let j = 0; j < nOut; j++){
        const r0 = j * nIn;
        for (let k = 0; k < nIn; k++){
          let g = gw[L][r0 + k] * scale;
          if (wd) g -= wd * W[r0 + k] * 0.001;
          const idx = r0 + k;
          ma[idx] = b1 * ma[idx] + (1 - b1) * g;
          va[idx] = b2 * va[idx] + (1 - b2) * g * g;
          const mh = ma[idx] / t1, vh = va[idx] / t2v;
          W[idx] -= lr * mh / (Math.sqrt(vh) + eps);
        }
        let g2 = gb[L][j] * scale;
        if (wd) g2 -= wd * B[j] * 0.001;
        mb[j] = b1 * mb[j] + (1 - b1) * g2;
        vb[j] = b2 * vb[j] + (1 - b2) * g2 * g2;
        const mh = mb[j] / t1, vh = vb[j] / t2v;
        B[j] -= lr * mh / (Math.sqrt(vh) + eps);
      }
    }
  }

  save(){
    return {
      layout: this.layout,
      act: this.act, outAct: this.outAct,
      W: this.W.map(w => Array.from(w)),
      B: this.B.map(b => Array.from(b))
    };
  }

  static load(obj){
    const m = new MLP(obj.layout, { act: obj.act || 'relu', outAct: obj.outAct || 'tanh', scale: 0.001 });
    for (let i = 0; i < m.W.length; i++){
      m.W[i] = Float64Array.from(obj.W[i]);
      m.B[i] = Float64Array.from(obj.B[i]);
    }
    return m;
  }

  /* 批量推理：返回 Float64Array */
  inferBatch(inputs){
    const out = new Float64Array(inputs.length);
    for (let i = 0; i < inputs.length; i++) out[i] = this.infer(inputs[i])[0];
    return out;
  }
}

module.exports = { MLP, randn };