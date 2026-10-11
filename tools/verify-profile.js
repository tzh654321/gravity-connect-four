'use strict';
/* ============================================================
   verify-profile —— **参考核验器（rules-ref）的时间去哪了**

   做法：把 `rules-ref` 的**原语**用计时器包起来（`verify-strategy.js` 走的是 `R.xxx(...)`
   动态查表 ⇒ 打补丁对它也生效），然后跑一遍真实的大证书。
   ⚠ 只在剖析时打补丁：正式代码的热路径不被计时器污染。

   阶段划分（按评审要求）：
     - cloneBoard   棋盘复制（参考实现每个节点都 new Map(b)）
     - legalMoves   从占据格重建合法落点
     - winner       独立连四判定（内部调 line4）
     - winPoints    落子即连四的落点集（内部逐个 cloneBoard + line4）
     - line4        四格窗口扫描（被 winner / winPoints 调用 ⇒ 记作嵌套）
     - play         落子（内部再调一次 legalMoves ⇒ 记作嵌套）
     - 其余         证书遍历、AND 全应手覆盖、计数与记账
     - JSON         读文件 + JSON.parse（核验之外，但离线流水线也付这份钱）

   用法：
     node tools/verify-profile.js                       # 默认跑 fixtures/bounded-ply4-certs.jsonl
     node tools/verify-profile.js tools/xxx.jsonl
   ============================================================ */
const fs = require('fs');
const path = require('path');
const R = require('./rules-ref');
const VS = require('./verify-strategy');

const file = process.argv[2] || path.join(__dirname, 'fixtures', 'bounded-ply4-certs.jsonl');

const NAMES = ['cloneBoard', 'legalMoves', 'winner', 'winPoints', 'line4', 'play', 'fromEntries', 'at', 'sideToMove'];
const prof = {};
for (const n of NAMES) { prof[n] = { ms: 0, calls: 0 }; prof[n + '(嵌套)'] = { ms: 0, calls: 0 }; }
let depth = 0;
for (const n of NAMES) {
  const orig = R[n];
  R[n] = function (...a) {
    const nested = depth > 0;
    depth++;
    const t = process.hrtime.bigint();
    let r, err = null;
    try { r = orig.apply(this, a); } catch (e) { err = e; }
    const d = Number(process.hrtime.bigint() - t) / 1e6;
    depth--;
    const b = prof[nested ? n + '(嵌套)' : n];
    b.ms += d; b.calls++;
    if (err) throw err;
    return r;
  };
}

const j0 = process.hrtime.bigint();
const raw = fs.readFileSync(file, 'utf8');
const lines = raw.split('\n').filter(Boolean);
const recs = lines.map(l => JSON.parse(l));
const jsonMs = Number(process.hrtime.bigint() - j0) / 1e6;

console.log(`核验时间剖析：${path.relative(process.cwd(), file)}（${recs.length} 条记录）`);
console.log(`  JSON 读取 + 解析：${jsonMs.toFixed(1)}ms（${(raw.length / 1048576).toFixed(1)} MB）\n`);

let totalMs = 0, totalNodes = 0;
for (const rec of recs) {
  const t0 = process.hrtime.bigint();
  const useRef = !!rec.refutation;
  const useSeq = !useRef && !!rec.seq;
  const useDag = !useRef && !useSeq && !!rec.dag;
  const r = useRef ? VS.verifyRefutation(rec.board, rec.attacker, rec.refutation)
    : useSeq ? VS.verifySeq(rec.board, rec.seq)
      : useDag ? VS.verifyDag(rec.board, rec.attacker, rec.dag)
        : VS.verify(rec.board, rec.attacker, rec.tree);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  totalMs += ms; totalNodes += r.nodes || 0;
  const mv = rec.move ? ` 走(${rec.move.x},${rec.move.y})` : '';
  console.log(`  ${rec.game}${rec.ply == null ? '' : '@ply' + rec.ply}${mv}`.padEnd(30) +
    `${useRef ? '反证证书' : useSeq ? '连续威胁' : useDag ? 'DAG' : '策略树'}`.padEnd(8) +
    `${String(r.nodes).padStart(8)} 节点  ${ms.toFixed(0).padStart(6)}ms  ` +
    `${r.ok ? '通过' : '失败：' + r.reason}`);
}

const top = ['cloneBoard', 'legalMoves', 'winner', 'winPoints', 'play'];
const topSum = top.reduce((a, n) => a + prof[n].ms, 0);
console.log('\n  阶段耗时（**顶层**调用，不含被这些函数调用的嵌套部分）：');
for (const n of top) {
  const b = prof[n];
  console.log(`    ${n.padEnd(12)} ${b.ms.toFixed(0).padStart(7)}ms  ${String(b.calls).padStart(9)} 次  ` +
    `${(b.calls ? b.ms / b.calls * 1000 : 0).toFixed(1).padStart(7)}µs/次  ` +
    `${(totalMs ? b.ms / totalMs * 100 : 0).toFixed(1).padStart(5)}%`);
}
console.log(`    其余（遍历 + AND 覆盖 + 记账） ${(totalMs - topSum).toFixed(0)}ms  ` +
  `${(totalMs ? (totalMs - topSum) / totalMs * 100 : 0).toFixed(1)}%`);
console.log('\n  嵌套部分（被上列函数调用 ⇒ **不要**加到上面的合计里）：');
for (const n of ['line4', 'legalMoves', 'cloneBoard']) {
  const b = prof[n + '(嵌套)'];
  if (b.calls) console.log(`    ${n.padEnd(12)} ${b.ms.toFixed(0).padStart(7)}ms  ${String(b.calls).padStart(9)} 次`);
}
console.log(`\n  核验总耗时 ${totalMs.toFixed(0)}ms（${totalNodes} 节点 ⇒ ${(totalNodes ? totalMs * 1000 / totalNodes : 0).toFixed(1)}µs/节点）`);
console.log(`  峰值堆 ≈ ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB`);
