'use strict';
/* ============================================================
   特征编码：局面 -> 定长向量（针对「行棋方 me」视角，红蓝对称）
   设计原则：把游戏已有的启发式结构（4 连窗口计数）压缩成紧凑特征，
   加上少量精确战术量（立即连四肢点数），供价值网络输入。
   ============================================================ */

const FEAT_DIM = 16;

/* 把所有窗口计数累加（某方向连续 4 格，逐子+偏移枚举，与 deltaEval 同口径） */
function windowCounts(G, me, op){
  const c = new Float64Array(12);
  // index 映射: my1..my3 -> 0..2, op1..op3 -> 3..5, mix11 -> 6, mix21 -> 7, mix12 -> 8
  for (const [k, o] of G.occ){
    if (o === G.BLOCK) continue;
    const i = k.indexOf(',');
    const x = +k.slice(0, i), y = +k.slice(i + 1);
    for (const d of G.DIRS){
      for (let off = 0; off < G.WIN_LEN; off++){
        let my = 0, opN = 0, blk = 0;
        for (let t = 0; t < G.WIN_LEN; t++){
          const oo = G.ownerAt(x + d[0] * (t - off), y + d[1] * (t - off));
          if (oo === me) my++;
          else if (oo === op) opN++;
          else if (oo === G.BLOCK) { blk = 1; break; }
        }
        if (blk || my + opN > G.WIN_LEN - 1) continue;
        if (opN === 0){
          if (my > 0) c[my - 1] += 1;
        } else if (my === 0){
          c[3 + opN - 1] += 1;
        } else {
          if (my === 1 && opN === 1) c[6] += 1;
          else if (my === 2 && opN === 1) c[7] += 1;
          else if (my === 1 && opN === 2) c[8] += 1;
        }
      }
    }
  }
  return c;
}

/* 精确「连四肢点」计数：我方/对方各行一子即连四的落点个数 */
function winPoints(G, side){
  let n = 0;
  const cands = G.genCandidates();
  for (const c of cands){
    if (G.isFree(c.x, c.y) && G.wouldWin(c, side)) n++;
  }
  return n;
}

const log1p = Math.log1p;

function features(G, me, op){
  const f = new Float64Array(FEAT_DIM);
  const wc = windowCounts(G, me, op);
  // 棋型计数（压缩量级）
  for (let i = 0; i < 9; i++) f[4 + i] = log1p(wc[i]);
  // 子数/中心度
  let nMy = 0, nOp = 0, nearMy = 0, nearOp = 0;
  for (const [k, o] of G.occ){
    if (o === G.BLOCK) continue;
    const i2 = k.indexOf(',');
    const x = +k.slice(0, i2), y = +k.slice(i2 + 1);
    const d = Math.abs(x) + Math.abs(y);
    if (o === me){ nMy++; nearMy += 1 / (1 + d); }
    else { nOp++; nearOp += 1 / (1 + d); }
  }
  f[0] = log1p(nMy);
  f[1] = log1p(nOp);
  f[2] = log1p(nearMy);
  f[3] = log1p(nearOp);
  // 精确连四肢点（截断，防异常放大）
  f[13] = Math.min(winPoints(G, me), 4);
  f[14] = Math.min(winPoints(G, op), 4);
  // 行棋节奏：总手数奇偶（本游戏先后手轮换固定，等价于 turn == me）
  f[15] = (G.occ.size - 1) % 2;
  return f;
}

module.exports = { features, FEAT_DIM, windowCounts, winPoints };