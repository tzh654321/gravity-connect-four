'use strict';
/* ============================================================
   micro-at —— **原语级微基准**（只用于解释，不能代替端到端结论）

   ⚠ 定位：本工具回答的是"**每次调用的成本**变了多少"，不是"搜索快了多少"。
     端到端判据看 `ab-core.js`；本工具只用来把"调用次数 × 单次成本差"换算成一个
     **期望上限**，好判断端到端测量出来的数字（或噪声）是否在合理量级内。

   比较对象：字符串查表（`board.get(key(x,y))`）vs 数值双层 Map（`cols.get(x).get(y)`）。
   口径与 `ab-core.js` 相同：同进程、old/new **紧邻**、奇偶遍反转顺序、**丢弃 1 遍预热**、
   同时记墙钟与 CPU 时间、报配对差。每轮循环都做一个 checksum 并断言两版相同
   （既防 V8 把循环消掉，也证明两侧做的是同一件工作）。

   用法：
     git show HEAD:tools/solver-core.js > tools/tmp-core-base.js
     node tools/micro-at.js --old tools/tmp-core-base.js [--ops 20000000]
   ============================================================ */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const OLD_PATH = argOf('old', null);
if (!OLD_PATH) { console.error('用法：node tools/micro-at.js --old <改动前的 solver-core 副本> [--ops 20000000]'); process.exit(1); }
const NEW = require('./solver-core');
const OLD = require(path.resolve(OLD_PATH));
const OPS = Number(argOf('ops', 20000000));
const REPS = Math.max(3, Number(argOf('reps', 5)));

const PLY4 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'bounded-ply4.json'), 'utf8'));

/* 一块"中等稠密"的棋盘：ply4 局面 + 往下铺若干子，保证 at() 的命中/未命中都有量 */
function buildBoard(CORE) {
  const p = new CORE.Position(PLY4.board);
  const side = ((p.board.size - 1) % 2 === 0) ? 1 : 2;
  let u = null;
  for (let i = 0; i < 8; i++) {
    const ms = p.moves();
    if (!ms.length) break;
    u = p.play(ms[i % ms.length], 3 - ((p.board.size - 1) % 2 === 0 ? 1 : 2));
  }
  return p;
}

/* 命中点：棋盘上已有的格 + frontier 的格（各取一批，循环使用） */
function samplePoints(pos) {
  const hits = [], miss = [];
  for (const k of pos.board.keys()) { const i = k.indexOf(','); hits.push([+k.slice(0, i), +k.slice(i + 1)]); }
  for (const k of pos.frontier) { const i = k.indexOf(','); miss.push([+k.slice(0, i), +k.slice(i + 1)]); }
  return { hits, miss };
}

/* 各原语的循环体；返回 checksum */
const BENCH = {
  'at 命中': (pos, pts, n) => { let s = 0; const a = pts.hits; for (let i = 0; i < n; i++) s += pos.at(a[i % a.length][0], a[i % a.length][1]); return s; },
  'at 未命中': (pos, pts, n) => { let s = 0; const a = pts.miss; for (let i = 0; i < n; i++) s += pos.at(a[i % a.length][0] + 97, a[i % a.length][1] - 61); return s; },
  'line（走法）': (pos, pts, n) => { let s = 0; const a = pts.miss; for (let i = 0; i < n; i++) s += pos.line({ x: a[i % a.length][0], y: a[i % a.length][1] }, 1) ? 1 : 0; return s; },
  'winning（走法）': (pos, pts, n) => { let s = 0; const a = pts.miss; for (let i = 0; i < n; i++) s += pos.winning({ x: a[i % a.length][0], y: a[i % a.length][1] }, 1) ? 1 : 0; return s; },
  'play+undo': (pos, pts, n) => {
    let s = 0; const a = pts.miss;
    for (let i = 0; i < n; i++) {
      const q = a[i % a.length];                 // q = [x, y]
      const u = pos.play({ x: q[0], y: q[1] }, 1);
      s += pos.at(q[0], q[1]);
      pos.undo(u);
    }
    return s;
  },
  'moves()': (pos, pts, n) => { let s = 0; for (let i = 0; i < n; i++) { const m = pos.moves(); s += m.length; } return s; },
  'signature': (pos, pts, n) => { let s = 0; for (let i = 0; i < n; i++) s += pos.signature(1, false).length; return s; },
};

const med = a => { const s = [...a].sort((x, y) => x - y); return s[(s.length - 1) >> 1]; };
const mad = a => { const m = med(a); return med(a.map(x => Math.abs(x - m))); };
const cpu = c => (c.user + c.system) / 1000;

const NEW_POS = buildBoard(NEW), OLD_POS = buildBoard(OLD);
const PTS = samplePoints(NEW_POS);

console.log(`micro-at：原语级微基准（**只用于解释**，端到端结论看 ab-core）`);
console.log(`  前 = ${path.relative(process.cwd(), OLD_PATH)}　后 = tools/solver-core.js`);
console.log(`  每项 ${(OPS / 1e6).toFixed(1)}M 次 × (预热 1 遍丢弃 + ${REPS} 遍配对)\n`);

const results = {};
for (const name of Object.keys(BENCH)) {
  const oC = [], nC = [], oW = [], nW = [];
  const small = name === 'signature' || name === 'moves()';
  const ops = small ? Math.max(100000, OPS / 200) : OPS;
  let chkO = null, chkN = null;
  for (let rep = 0; rep <= REPS; rep++) {
    const flip = rep % 2 === 1;
    const go = (CORE, pos) => {
      const c0 = process.cpuUsage(), t0 = process.hrtime.bigint();
      const s = BENCH[name](pos, PTS, ops);
      return { W: Number(process.hrtime.bigint() - t0) / 1e6, C: cpu(process.cpuUsage(c0)), s };
    };
    // 奇偶遍反转**执行顺序**（先跑谁），但记录的永远是"旧/新"
    const A = flip ? go(NEW, NEW_POS) : go(OLD, OLD_POS);
    const B = flip ? go(OLD, OLD_POS) : go(NEW, NEW_POS);
    const oldR = flip ? B : A, newR = flip ? A : B;
    if (chkO === null) { chkO = oldR.s; chkN = newR.s; if (chkO !== chkN) console.log(`  ✗ ${name}：两侧 checksum 不同（${chkO} vs ${chkN}）⇒ 不是同一件工作`); }
    if (rep > 0) { oC.push(oldR.C); nC.push(newR.C); oW.push(oldR.W); nW.push(newR.W); }
    process.stdout.write(rep === 0 ? 'w' : '.');
  }
  const dC = oC.map((x, i) => nC[i] - x), dW = oW.map((x, i) => nW[i] - x);
  const mO = med(oC), mN = med(nC), dM = med(dC);
  results[name] = { ops, mO, mN, dM, floor: mad(dC) / mO, dWM: med(dW), wO: med(oW) };
  console.log(`\n  ${name.padEnd(14)} ${(mO * 1e6 / ops).toFixed(1)} ns/次 → ${(mN * 1e6 / ops).toFixed(1)} ns/次` +
    `（CPU 配对差 ${(dM / mO * 100).toFixed(1)}%，地板 ${(mad(dC) / mO * 100).toFixed(1)}%）` +
    `　加速 ${(mO / mN).toFixed(2)}×`);
}

/* ---- 把原语差换算成"对 hz3 的期望上限"（纯算术，不是测量结果）---- */
console.log('\n  换算（**说明用**，不是测量结果）：hz3 一次搜索里 `at()` 调用 110 948 663 次、`play`/`undo` 各 938 340 次。');
{
  const atHit = results['at 命中'], atMiss = results['at 未命中'];
  const per = (atHit.mO / atHit.ops - atHit.mN / atHit.ops) * 1e6;   // ns/次（命中档）
  console.log(`    at() 命中档单次成本差 ${per.toFixed(1)} ns；外推到 110.9M 次 ⇒ 约省 ${(per * 110948663 / 1e9).toFixed(2)}s。`);
  console.log(`    hz3 基线 CPU 约 19~25s ⇒ **期望降幅量级 ${(per * 110948663 / 1e9 / 22 * 100).toFixed(0)}% 上下**。`);
  console.log(`    这只是"机制最多能解释多少"的上限估计，不是端到端结论。`);
  const pu = results['play+undo'];
  if (pu) console.log(`    另：play+undo 档 ${(pu.mO * 1e6 / pu.ops).toFixed(0)} → ${(pu.mN * 1e6 / pu.ops).toFixed(0)} ns/对（索引维护把这一档**变贵**了多少，是这项优化的代价）。`);
}
console.log('  ⚠ 微基准的缓存局部性远好于真实搜索（真实棋盘更宽、索引列更多）⇒ 只作量级参考，不能替代 ab-core。');
