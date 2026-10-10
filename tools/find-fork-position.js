'use strict';
/* ============================================================
   find-fork-position —— 复现 solver-smoke.js 里「双威胁必胜手」回归局的搜局脚本

   用途：固定种子随机游走，找出真实可达、且「本方无即时胜点、但 proofDepth=1 也能证胜」
   的局面 —— 即结论只能来自双威胁规则本身。solver-smoke.js 里 hardcode 的局面由本脚本产出；
   改动 solver-core 后重跑本脚本，可确认这类局面仍然存在且可被证明。

   用法：node tools/find-fork-position.js
   ============================================================ */
const { Position, chooseMove } = require('./solver-core');

let seed = 20261009;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;

const found = [];
for (let trial = 0; trial < 4000 && found.length < 3; trial++) {
  let pos = new Position();
  for (let ply = 0; ply < 12; ply++) {
    const side = (pos.board.size - 1) % 2 === 0 ? 1 : 2;
    const ms = pos.moves();
    if (!ms.length || pos.winner()) break;
    // 检查当前行棋方是否"无即时胜点但能证明胜（proofDepth=1）"
    const hasImmediate = ms.some(p => pos.winning(p, side));
    const r = chooseMove([...pos.board], side, { proofDepth: 1, maxDepth: 0, timeMs: 3000 });
    if (!hasImmediate && r.status === 'proven-win' && r.move) {
      found.push({ board: [...pos.board], side, move: r.move });
      break;
    }
    const p = ms[Math.floor(rnd() * ms.length)];
    pos.play(p, side);
  }
}
for (const f of found) {
  console.log('side=' + f.side, 'move=' + JSON.stringify(f.move));
  console.log('  ' + JSON.stringify(f.board));
}
if (!found.length) console.log('未找到');
