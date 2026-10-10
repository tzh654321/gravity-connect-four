'use strict';
/* ============================================================
   find-support-fork —— 搜两类夹具局面（供 solver-smoke.js 做定向回归）

   注意：只搜索**真正轮到该方行棋**的局面（按落子数奇偶判定）。
   早期版本对两侧都试，产出的棋盘在实际轮次上是另一方的，
   属于"不可达棋框"—— 独立验证器的奇偶检查正好会拒掉这种记录。

   产出 1：支撑激活型双威胁（旧"只查穿落子窗口"的逻辑会漏数的局面）
   产出 2：多步连续强制威胁强杀（P3 正例，matePlies 较长）

   用法：node tools/find-support-fork.js
   ============================================================ */
const { Position, threatSearch, verifyProof } = require('./solver-core');

const KEY = (x, y) => `${x},${y}`;
const sideToMove = pos => ((pos.board.size - 1) % 2 === 0 ? 1 : 2);
const fullWins = (pos, side) => {
  const out = [];
  const ms = pos.moves();
  for (const q of ms) if (pos.winning(q, side)) out.push(q);
  return out;
};
const windowOnlyWins = (pos, p, side) => {
  const set = new Set();
  for (const id of pos._windowIds(p)) {
    const w = pos._winPoint(id);
    if (w && w.side === side) { const kk = KEY(w.x, w.y); if (pos.frontier.has(kk)) set.add(kk); }
  }
  return set;
};

let seed = 20261009;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;

// ---- 产出 1：支撑激活型双威胁 ----
const forks = [];
for (let trial = 0; trial < 500 && forks.length < 2; trial++) {
  const pos = new Position();
  for (let ply = 0; ply < 16; ply++) {
    if (pos.winner()) break;
    const ms = pos.moves();
    if (!ms.length) break;
    const side = sideToMove(pos);
    if (ms.length <= 18 && !fullWins(pos, side).length) {
      for (const p of ms) {
        const u = pos.play(p, side);
        const mineFull = fullWins(pos, side).length;
        const theirsFull = fullWins(pos, 3 - side).length;
        const mineWin = windowOnlyWins(pos, p, side).size;
        pos.undo(u);
        if (mineFull >= 2 && theirsFull === 0 && mineWin < 2) {
          forks.push({ side, move: p, board: [...pos.board], fullWins: mineFull, windowOnly: mineWin });
          break;
        }
      }
    }
    if (forks.length) break;
    pos.play(ms[Math.floor(rnd() * ms.length)], side);
  }
}
console.log('--- 支撑激活型双威胁 ---');
for (const f of forks) {
  console.log(`side=P${f.side}（实际轮次 P${f.side}）move=(${f.move.x},${f.move.y})  全扫描胜点=${f.fullWins}  旧窗口逻辑=${f.windowOnly}`);
  console.log('  ' + JSON.stringify(f.board));
}
if (!forks.length) console.log('未找到');

// ---- 产出 2：连续强制威胁强杀（只测实际行棋方）----
let seed2 = 777;
const rnd2 = () => (seed2 = (Math.imul(seed2, 1664525) + 1013904223) >>> 0) / 4294967296;
let best = null;
for (let trial = 0; trial < 900 && !(best && best.matePlies >= 7); trial++) {
  const pos = new Position();
  for (let ply = 0; ply < 18; ply++) {
    if (pos.winner()) break;
    const ms = pos.moves();
    if (!ms.length) break;
    const side = sideToMove(pos);
    if (ms.length >= 8 && ms.length <= 20) {
      const r = threatSearch(pos.board, side, { plies: 14, attackScan: 20, timeMs: 120 });
      if (r.status === 'proven-win' && r.proof && verifyProof(pos.board, r.proof).ok) {
        if (!best || r.matePlies > best.matePlies) best = { side, matePlies: r.matePlies, board: [...pos.board], move: r.move };
      }
    }
    pos.play(ms[Math.floor(rnd2() * ms.length)], side);
  }
}
console.log('\n--- 连续强制威胁强杀 ---');
if (best) {
  console.log(`side=P${best.side}（实际轮次 P${best.side}）move=(${best.move.x},${best.move.y}) matePlies=${best.matePlies}`);
  console.log('  ' + JSON.stringify(best.board));
} else console.log('未找到');

// ---- 产出 3：PNS 策略树里含 AND 节点（≥2 应手）的局面，用于"覆盖不全必须被拒"的回归 ----
{
  const { pnsSearch, verifyStrategy } = require('./solver-core');
  let s3 = 1234567;
  const r3 = () => (s3 = (Math.imul(s3, 1664525) + 1013904223) >>> 0) / 4294967296;
  const hasBigAnd = tree => {
    let found = false;
    const walk = n => {
      if (found || n.terminal) return;
      if (n.moves.length >= 2) { found = true; return; }
      for (const e of n.moves) walk(e.child);
    };
    walk(tree);
    return found;
  };
  let hit = null;
  for (let trial = 0; trial < 400 && !hit; trial++) {
    const pos = new Position();
    for (let ply = 0; ply < 16; ply++) {
      if (pos.winner()) break;
      const ms = pos.moves();
      if (!ms.length) break;
      const side = sideToMove(pos);
      if (ms.length >= 6 && ms.length <= 14) {
        const d = pnsSearch(pos.board, side, { maxNodes: 4000, timeMs: 3000 });
        if (d.status === 'proven-win' && d.proof && hasBigAnd(d.proof.tree) &&
            verifyStrategy(pos.board, side, d.proof.tree).ok) {
          hit = { side, board: [...pos.board] };
          break;
        }
      }
      pos.play(ms[Math.floor(r3() * ms.length)], side);
    }
  }
  console.log('\n--- 含 AND 节点的 PNS 策略树局面 ---');
  if (hit) {
    console.log(`side=P${hit.side}（实际轮次 P${hit.side}）`);
    console.log('  ' + JSON.stringify(hit.board));
  } else console.log('未找到');
}
