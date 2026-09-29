'use strict';
/* ============================================================
   P3 特征增广：16 维 → 32 维（扩维 + 补上原特征完全缺失的战术/空间信息）
   原 16 维全是「聚合计数」，没有任何空间信息，也看不出：
     - 一个空位是否同时被多个窗口完成（双威胁/叉子）→ 连四类游戏的胜负手
     - 威胁点这回合能否落子（重力游戏里决定威胁是否紧急）
     - 威胁的空间分布
   P3 新增 16 维（均为一次遍历可得，成本约 2x 原特征，可在 MCTS 叶子上使用）：
     16 我方威胁点数     17 对方威胁点数
     18 我方双威胁点数   19 对方双威胁点数
     20 我方可达威胁数   21 对方可达威胁数
     22 我方延后威胁数   23 对方延后威胁数
     24 我方最大堆叠度   25 对方最大堆叠度
     26 我方立即可下双威胁 27 对方立即可下双威胁
     28 威胁差(tanh)     29 我方最近威胁中心度 30 对方最近威胁中心度
     31 手数奇偶
   注：不再做镜像 max —— P2 已证明镜像不变化对本任务无确定增益（54.2% vs round2），
       去掉可省一半特征开销，算力集中在新信号上。
   ============================================================ */
const { features } = require('../features');

/* 一次遍历：枚举「去重后的窗口」，找出双方各自的「完成点（威胁点）」及每点被多少窗口完成。
   窗口 id 用数值编码（比字符串快）。注意：棋盘无边界、坐标无上界，必须用「相对坐标」编码
   —— 先取棋子坐标下界 (minX,minY)，编码 (x-minX, y-minY)，范围由棋堆跨度决定，天然有界。
   （早期版本用固定 ±64 绝对偏移，坐标越界会让 id 变负 → id%8 为负 → D[负数] undefined → 崩溃） */
function threatScan(G, me, op){
  const WIN = G.WIN_LEN, D = G.DIRS;
  let minX = Infinity, minY = Infinity;
  for (const [k, o] of G.occ){
    if (o === G.BLOCK) continue;
    const i = k.indexOf(',');
    const x = +k.slice(0, i), y = +k.slice(i + 1);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
  }
  if (minX === Infinity){ minX = 0; minY = 0; }
  const OFF = 16, SPAN = 4096;      // 相对坐标偏移 / 行跨度
  const wins = new Set();
  for (const [k, o] of G.occ){
    if (o === G.BLOCK) continue;
    const i = k.indexOf(',');
    const x = +k.slice(0, i), y = +k.slice(i + 1);
    for (let di = 0; di < D.length; di++){
      const d = D[di];
      for (let off = 0; off < WIN; off++){
        const rx = x - d[0] * off - minX + OFF;
        const ry = y - d[1] * off - minY + OFF;
        wins.add((rx * SPAN + ry) * 8 + di);
      }
    }
  }
  const myCells = new Map(), opCells = new Map();
  for (const id of wins){
    const di = id % 8;
    let t = (id - di) / 8;
    const ry = t % SPAN;
    t = (t - ry) / SPAN;
    const sx = t + minX - OFF, sy = ry + minY - OFF;
    const d = D[di];
    let my = 0, opN = 0, blk = 0, ex = 0, ey = 0, empties = 0;
    for (let i = 0; i < WIN; i++){
      const cx = sx + d[0] * i, cy = sy + d[1] * i;
      const oo = G.ownerAt(cx, cy);
      if (oo === me) my++;
      else if (oo === op) opN++;
      else if (oo === G.BLOCK){ blk = 1; break; }
      else { empties++; ex = cx; ey = cy; }
    }
    if (blk || empties !== 1) continue;          // 只关心「差一子」窗口
    const key = ex + ',' + ey;
    if (my === WIN - 1 && opN === 0) myCells.set(key, (myCells.get(key) || 0) + 1);
    else if (opN === WIN - 1 && my === 0) opCells.set(key, (opCells.get(key) || 0) + 1);
  }
  return { myCells, opCells };
}

function landingKeys(G){
  const cs = G.genCandidates();
  const seen = new Set();
  for (const c of cs){ const l = G.settleDiscrete(c.x, c.y); seen.add(G.K(l.x, l.y)); }
  return seen;
}

function sideStats(cells, land){
  let reach = 0, deferred = 0, dbl = 0, maxStack = 0, nearCenter = 0, reachDbl = 0;
  let bestD = Infinity;
  for (const [k, cnt] of cells){
    if (cnt >= 2) dbl++;
    if (cnt > maxStack) maxStack = cnt;
    const i = k.indexOf(',');
    const x = +k.slice(0, i), y = +k.slice(i + 1);
    const d = Math.abs(x) + Math.abs(y);
    if (d < bestD) bestD = d;
    if (land.has(k)){ reach++; if (cnt >= 2) reachDbl++; } else deferred++;
  }
  if (bestD < Infinity) nearCenter = 1 / (1 + bestD);
  return { n: cells.size, reach, deferred, dbl, maxStack, nearCenter, reachDbl };
}

const FEAT_DIM = 32;
const log1p = Math.log1p;

function features_p3(G, me, op){
  const f = new Float64Array(FEAT_DIM);
  const base = features(G, me, op);          // 原 16 维（原样保留）
  for (let i = 0; i < 16; i++) f[i] = base[i];

  const { myCells, opCells } = threatScan(G, me, op);
  const land = landingKeys(G);
  const A = sideStats(myCells, land), B = sideStats(opCells, land);

  f[16] = log1p(A.n);
  f[17] = log1p(B.n);
  f[18] = Math.min(A.dbl, 4);
  f[19] = Math.min(B.dbl, 4);
  f[20] = log1p(A.reach);
  f[21] = log1p(B.reach);
  f[22] = Math.min(A.deferred, 4);
  f[23] = Math.min(B.deferred, 4);
  f[24] = Math.min(A.maxStack, 4);
  f[25] = Math.min(B.maxStack, 4);
  f[26] = A.reachDbl > 0 ? 1 : 0;      // 我方立即可下出双威胁（通常必胜）
  f[27] = B.reachDbl > 0 ? 1 : 0;      // 对方有 → 告警
  f[28] = Math.tanh((A.n - B.n) / 2);
  f[29] = A.nearCenter;
  f[30] = B.nearCenter;
  f[31] = (G.occ.size - 1) % 2;
  return f;
}

module.exports = { features: features_p3, FEAT_DIM, threatScan, landingKeys, sideStats };
