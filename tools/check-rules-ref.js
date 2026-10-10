'use strict';
/* ============================================================
   check-rules-ref —— 交叉核对「规则参考实现」与核心

   rules-ref.js 要承担"规则层独立核验"，前提是它与核心在**能判定的范围内一致**：
   否则它只是另一套规则，核验没有意义。本脚本在固定种子的随机轨迹上逐步断言：

     - 合法落点集合完全一致；
     - 终局方一致；
     - 双方"即时胜点"集合完全一致；
     - 重力方向在整片网格上逐个一致。

   任何一处不一致都说明两者之一有错，必须查清后再信任任何"独立核验"结论。

   用法：node tools/check-rules-ref.js
   ============================================================ */
const assert = require('node:assert/strict');
const { Position, gravity } = require('./solver-core');
const R = require('./rules-ref');

const K = (x, y) => `${x},${y}`;
const keyOf = ms => ms.map(m => K(m.x, m.y)).sort();

// 1) 重力方向：整片网格逐个核对
let grav = 0;
for (let x = -8; x <= 8; x++) {
  for (let y = -8; y <= 8; y++) {
    const a = gravity(x, y), b = R.gravity(x, y);
    assert.equal(`${b[0]},${b[1]}`, `${a[0]},${a[1]}`, `重力方向不一致 (${x},${y})`);
    grav++;
  }
}

// 2) 随机轨迹上逐帧核对
let seed = 987654321;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
let steps = 0, resets = 0;
let pos = new Position();
let board = R.fromEntries(pos.board);

for (let i = 0; i < 400; i++) {
  const a = keyOf(pos.moves());
  const b = keyOf(R.legalMoves(board));
  assert.deepEqual(b, a, `第${i}步合法落点集合不一致\n  core=${a.join(' ')}\n  ref =${b.join(' ')}`);
  assert.equal(R.winner(board), pos.winner(), `第${i}步终局方不一致`);
  for (const s of [1, 2]) {
    const coreWins = keyOf(pos.moves().filter(m => pos.winning(m, s)));
    const refWins = keyOf(R.winPoints(board, s));
    assert.deepEqual(refWins, coreWins, `第${i}步 P${s} 即时胜点集合不一致`);
  }
  if (pos.winner() || !pos.moves().length) { pos = new Position(); board = R.fromEntries(pos.board); resets++; continue; }
  const ms = pos.moves();
  const m = ms[Math.floor(rnd() * ms.length)];
  pos.play(m, (pos.board.size - 1) % 2 === 0 ? 1 : 2);
  board = R.fromEntries(pos.board);
  steps++;
}

console.log(`规则参考实现 × 核心 交叉核对通过：重力 ${grav} 格 + 随机轨迹 ${steps} 步（重置 ${resets} 次）。`);
