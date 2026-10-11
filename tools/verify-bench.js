'use strict';
/* ============================================================
   verify-bench —— 核验器**性能对照**：慢速参考实现 vs 快速实现

   报告口径（按评审要求）：
     - 总核验时间       每份证书各自计时（**不含** JSON 读取与解析；解析单独列）
     - 每节点时间       总时间 / 访问节点数
     - 峰值内存         验证前后的 RSS / heapUsed 增量（取多遍最小值，避开上一遍遗留的垃圾）
     - 访问节点数       `nodes` 计数（**确定性**指标）
     - 一致性           ok / 失败原因 / 出错节点路径 / 节点计数 必须逐项相同

   ⚠ 本机墙钟抖动可达 ±20%（同任务节点数逐位一致而耗时不同）⇒ 一律报**中位数**，
     并且不拿毫秒单独当判据；**节点数与一致性**才是硬指标。

   用法：
     node tools/verify-bench.js                  # 默认 3 遍
     node tools/verify-bench.js --reps 1         # 快速看一遍
     node tools/verify-bench.js --expose-gc      # 需配合 node --expose-gc tools/verify-bench.js
   ============================================================ */
const fs = require('fs');
const path = require('path');
const R = require('./rules-ref');
const VS = require('./verify-strategy');
const F = require('./verify-strategy-fast');

const argv = process.argv.slice(2);
const argVal = (name, dv) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dv;
};
const REPS = Math.max(1, argVal('--reps', 3));
const ONLY = (() => { const i = argv.indexOf('--only'); return i >= 0 ? argv[i + 1] : null; })();
const GC = typeof global.gc === 'function';

const FILES = [
  path.join(__dirname, 'fixtures', 'bounded-ply4-certs.jsonl'),
  path.join(__dirname, 'fixtures', 'proofs-fixtures.jsonl'),
  path.join(__dirname, 'fixtures', 'proof-loss-ply6.jsonl'),
  path.join(__dirname, 'proofs-losses.jsonl'),
];

function kindOf(rec) {
  if (rec.refutation) return 'refutation';
  if (rec.seq) return 'seq';
  if (rec.dag) return 'dag';
  if (rec.tree) return 'tree';
  return '?';
}

function run(rec, fast) {
  const k = kindOf(rec), b = rec.board, a = rec.attacker;
  if (fast) {
    return k === 'refutation' ? F.verifyRefutationFast(b, a, rec.refutation)
      : k === 'seq' ? F.verifySeqFast(b, rec.seq)
        : k === 'dag' ? F.verifyDagFast(b, a, rec.dag)
          : F.verifyFast(b, a, rec.tree);
  }
  return k === 'refutation' ? VS.verifyRefutation(b, a, rec.refutation)
    : k === 'seq' ? VS.verifySeq(b, rec.seq)
      : k === 'dag' ? VS.verifyDag(b, a, rec.dag)
        : VS.verify(b, a, rec.tree);
}

const numKeys = ['nodes', 'andNodes', 'attackerNodes', 'leaves', 'memoHits', 'plies'];
function diff(a, b) {
  const d = [];
  if (a.ok !== b.ok) d.push(`ok ${a.ok} vs ${b.ok}`);
  if (a.reason !== b.reason) d.push(`reason「${a.reason}」vs「${b.reason}」`);
  if ((a.path || []).join('>') !== (b.path || []).join('>')) d.push('path 不同');
  for (const k of numKeys) if ((a[k] || 0) !== (b[k] || 0)) d.push(`${k} ${a[k]} vs ${b[k]}`);
  return d;
}

const median = xs => { const s = [...xs].sort((p, q) => p - q); return s[(s.length - 1) >> 1]; };

/* ------------------------------------------------------------------ 装载 */

const cases = [];
for (const file of FILES) {
  if (!fs.existsSync(file)) continue;
  const rel = path.relative(__dirname, file).replace(/\\/g, '/');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  lines.forEach((l, i) => {
    const t0 = process.hrtime.bigint();
    const rec = JSON.parse(l);
    const jsonMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const mv = rec.move ? ` 走(${rec.move.x},${rec.move.y})` : '';
    const label = `${rec.game}${rec.ply == null ? '' : '@ply' + rec.ply}${mv}`;
    cases.push({ label, kind: kindOf(rec), rec, jsonMs, bytes: l.length, file: rel, idx: i });
  });
}

console.log(`核验器性能对照（参考 = rules-ref + verify-strategy；快速 = verify-strategy-fast）`);
console.log(`每项 ${REPS} 遍取中位数；GC ${GC ? '已启用（--expose-gc）' : '未启用（加 --expose-gc 可测堆增量）'}\n`);

const rows = [];
for (const c of cases) {
  if (ONLY && !(c.label.includes(ONLY) || c.kind === ONLY)) continue;
  const refT = [], fastT = [];
  let rRef = null, rFast = null;
  for (let i = 0; i < REPS; i++) {
    // 交替执行，减小顺序带来的漂移
    if (GC) global.gc();
    let t0 = process.hrtime.bigint();
    const rf = run(c.rec, true);
    fastT.push(Number(process.hrtime.bigint() - t0) / 1e6);
    rFast = rFast || rf;

    if (GC) global.gc();
    t0 = process.hrtime.bigint();
    const rr = run(c.rec, false);
    refT.push(Number(process.hrtime.bigint() - t0) / 1e6);
    rRef = rRef || rr;
  }
  rows.push({ c, rRef, rFast, refMs: median(refT), fastMs: median(fastT), d: diff(rRef, rFast) });
}

/* ------------------------------------------------------------------ 明细 */

const H = (s, n) => String(s).padStart(n);
console.log('  记录'.padEnd(34) + H('形态', 11) + H('节点', 9) + H('参考ms', 10) + H('快速ms', 10) +
  H('加速', 8) + H('参考µs/节点', 13) + H('快速µs/节点', 13) + '  一致性');
for (const r of rows) {
  const n = r.rRef.nodes || 0;
  const sp = r.fastMs > 0 ? r.refMs / r.fastMs : 0;
  console.log('  ' + r.c.label.padEnd(32) + H(r.c.kind, 11) + H(n, 9) + H(r.refMs.toFixed(0), 10) +
    H(r.fastMs.toFixed(1), 10) + H(sp.toFixed(2) + '×', 8) +
    H(n ? (r.refMs * 1000 / n).toFixed(1) : '-', 13) + H(n ? (r.fastMs * 1000 / n).toFixed(2) : '-', 13) +
    '  ' + (r.d.length ? '✗ ' + r.d.join('；') : (r.rRef.ok ? '✓ 一致（通过）' : '✓ 一致（拒绝）')));
}

/* ------------------------------------------------------------------ 汇总 */

const big = rows.filter(r => (r.rRef.nodes || 0) >= 50000);
const sumRef = rows.reduce((a, r) => a + r.refMs, 0);
const sumFast = rows.reduce((a, r) => a + r.fastMs, 0);
const sumNodes = rows.reduce((a, r) => a + (r.rRef.nodes || 0), 0);
const bRef = big.reduce((a, r) => a + r.refMs, 0);
const bFast = big.reduce((a, r) => a + r.fastMs, 0);
const bNodes = big.reduce((a, r) => a + (r.rRef.nodes || 0), 0);
const jsonSum = cases.reduce((a, c) => a + c.jsonMs, 0);
const bad = rows.filter(r => r.d.length);

console.log('\n  —— 汇总（计时**不含** JSON 读取与解析）——');
console.log(`  全部 ${rows.length} 条：参考 ${sumRef.toFixed(0)}ms（${sumNodes} 节点，${(sumRef * 1000 / sumNodes).toFixed(1)}µs/节点）  ` +
  `快速 ${sumFast.toFixed(1)}ms（${(sumFast * 1000 / sumNodes).toFixed(2)}µs/节点）  合计加速 ${(sumRef / sumFast).toFixed(2)}×`);
if (big.length) {
  console.log(`  仅大证书 ${big.length} 份：参考 ${bRef.toFixed(0)}ms  →  快速 ${bFast.toFixed(1)}ms  ` +
    `（${bNodes} 节点；${(bRef * 1000 / bNodes).toFixed(1)} → ${(bFast * 1000 / bNodes).toFixed(2)} µs/节点）  ` +
    `加速 ${(bRef / bFast).toFixed(2)}×`);
}
console.log(`  JSON 读取 + 解析合计 ${jsonSum.toFixed(0)}ms（**两类核验器都要付**，已排除在上述计时之外）`);
if (GC) {
  console.log('\n  —— 峰值内存（把整份夹具一次跑完，跑前 gc；零 GC 干扰下的高水位增量）——');
  for (const pair of [['参考', false], ['快速', true]]) {
    global.gc();
    const m0 = process.memoryUsage();
    let n = 0;
    for (const c of cases) { const r = run(c.rec, pair[1]); n += r.nodes || 0; }
    const m1 = process.memoryUsage();
    console.log(`    ${pair[0].padEnd(4)}heapUsed +${((m1.heapUsed - m0.heapUsed) / 1048576).toFixed(1)}MB  ` +
      `heapTotal +${((m1.heapTotal - m0.heapTotal) / 1048576).toFixed(1)}MB  ` +
      `RSS +${((m1.rss - m0.rss) / 1048576).toFixed(1)}MB  （${n} 节点）`);
  }
  console.log('    ⚠ JS 无法在同步计算中采样峰值 ⇒ 上表是"整份跑完的高水位增量"，只作**相对比较**用。');
} else {
  console.log('\n  峰值内存：本机未开 `--expose-gc`；用 `node --expose-gc tools/verify-bench.js` 可测高水位增量。');
}
console.log(`  一致性：${rows.length - bad.length} / ${rows.length} 条**逐项相同**（ok + 失败原因 + 出错路径 + 节点计数）` +
  (bad.length ? `\n  ✗ 不一致：${bad.map(r => r.c.label).join('、')}` : ''));
console.log('\n  说明：墙钟受本机抖动支配，**不是**判据；节点数与逐项一致性才是。');
process.exit(bad.length ? 1 : 0);
