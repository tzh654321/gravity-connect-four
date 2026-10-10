'use strict';
/* ============================================================
   rules-ref —— **规则参考实现**（刻意与 solver-core 完全独立）

   目的：给证明核验提供第二层独立性。
   核心的 `verifyStrategy` 已独立于"搜索/排序/置换表/局部战术快捷"，
   但它仍然调用核心的 `Position` —— 两边**共享**合法走法生成与连四判定。
   若那两块本身有错，两个验证器会一起错。本文件用另一套写法重算这两件事：

     - 棋盘：普通 Map（键 "x,y"），不依赖 Position
     - 落点：从所有棋子的四邻重建（不复用核心的 frontier 增量维护）
     - 连四：按**四格窗口扫描**判定（核心用的是"沿方向数连续子"）
     - 重力：本文件自己重写一遍方向和分区

   不追求快，只追求简单可靠、写法独立。
   ============================================================ */

const K = (x, y) => `${x},${y}`;
const parse = k => { const i = k.indexOf(','); return [+k.slice(0, i), +k.slice(i + 1)]; };

/** 重力方向（按分区，自己重写一遍） */
function gravity(x, y) {
  if (x >= 0 && y >= 1) return [0, -1];    // 右下区：向下
  if (x >= 1 && y <= 0) return [-1, 0];    // 右下区：向左
  if (x <= 0 && y <= -1) return [0, 1];    // 左上区：向上
  if (x <= -1 && y >= 0) return [1, 0];    // 左上区：向右
  return [0, 0];
}

/** 棋盘：Map("x,y" -> 1|2|3) */
function fromEntries(entries) {
  const b = new Map();
  for (const [k, v] of entries) b.set(k, v);
  return b;
}
function cloneBoard(b) { return new Map(b); }
function at(b, x, y) { return b.get(K(x, y)) || 0; }

/** 合法落点：全部棋子的四邻中"空且其重力后继有子"的格（从零重建，不用增量结构） */
function legalMoves(b) {
  const out = [];
  const seen = new Set();
  for (const k of b.keys()) {
    const [x, y] = parse(k);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const qx = x + dx, qy = y + dy, kk = K(qx, qy);
      if (seen.has(kk) || b.has(kk)) continue;
      const [gx, gy] = gravity(qx, qy);
      if (!b.has(K(qx + gx, qy + gy))) continue;
      seen.add(kk);
      out.push({ x: qx, y: qy });
    }
  }
  // 稳定排序，便于复现
  out.sort((p, q) => p.x - q.x || p.y - q.y);
  return out;
}

const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
/** 连四：按四格窗口扫描 —— 对每个方向、每个"把 (x,y) 放在 0..3 号位"的窗口整体比对 */
function line4(b, x, y, side) {
  for (const [dx, dy] of DIRS) {
    for (let off = 0; off < 4; off++) {
      let all = true;
      for (let t = 0; t < 4; t++) {
        if (at(b, x + (t - off) * dx, y + (t - off) * dy) !== side) { all = false; break; }
      }
      if (all) return true;
    }
  }
  return false;
}

/** 终局方：0 / 1 / 2（双方同时连四视为非法输入） */
function winner(b) {
  let w = 0;
  for (const [k, v] of b) {
    if (v === 3) continue;
    const [x, y] = parse(k);
    if (!line4(b, x, y, v)) continue;
    if (w && w !== v) throw new Error('输入局面双方已同时连四');
    w = v;
  }
  return w;
}

/** 落一子即连四的落点 */
function winPoints(b, side) {
  const out = [];
  for (const m of legalMoves(b)) {
    const nb = cloneBoard(b);
    nb.set(K(m.x, m.y), side);
    if (line4(nb, m.x, m.y, side)) out.push(m);
  }
  return out;
}

/** 落子并返回"是否合法"，直接改 b（调用方自行备份） */
function play(b, m, side) {
  if (!legalMoves(b).some(q => q.x === m.x && q.y === m.y)) return false;
  b.set(K(m.x, m.y), side);
  return true;
}

function sideToMove(b) { return ((b.size - 1) % 2 === 0) ? 1 : 2; }

module.exports = { K, gravity, fromEntries, cloneBoard, at, legalMoves, line4, winner,
  winPoints, play, sideToMove, DIRS };
