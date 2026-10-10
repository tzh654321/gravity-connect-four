'use strict';
/* ============================================================
   check-dfpn —— df-pn 与 PNS 的**同一批局面单项对照**

   为什么单独对照：两者终点语义、pn/dn 的 OR/AND 定义完全相同，但
   搜索方式不同（PNS 无阈值、每轮从根再走一遍；df-pn 有阈值递归 + 惰性展开）。
   同一局面下两者必须给出**相同结论**；df-pn 的证明还必须通过
   **规则层独立核验器**（tools/rules-ref.js 那一套，不复用核心 Position）。

   对照项：status、pn/dn 是否为 0、证明能否独立核验、节点数/展开数。

   用法：node tools/check-dfpn.js
   ============================================================ */
const { pnsSearch, dfpnSearch } = require('./solver-core');
const V = require('./verify-strategy');

const FIXTURES = [
  { name: '连续强杀（威胁序列）', board: [['0,0', 3], ['0,-1', 1], ['1,0', 2], ['1,-1', 1], ['-1,0', 2], ['2,0', 1], ['3,0', 2]], attacker: 1, expect: 'proven-win' },
  { name: '需强制挡招（含 AND 节点）', board: [['0,0', 3], ['0,-1', 1], ['1,0', 2], ['0,-2', 1], ['0,-3', 2], ['1,-2', 1], ['2,0', 2]], attacker: 1, expect: 'proven-win' },
  { name: '支撑激活型双威胁', board: [['0,0', 3], ['0,1', 1], ['0,2', 2], ['-1,2', 1], ['-2,2', 2], ['1,0', 1], ['-3,2', 2], ['-1,0', 1], ['2,0', 2], ['0,3', 1], ['3,0', 2]], attacker: 1, expect: 'proven-win' },
  { name: '初始局面（未解）', board: [['0,0', 3]], attacker: 1, expect: 'unknown' },
];

let fails = 0;
for (const f of FIXTURES) {
  const opts = { maxNodes: 60000, timeMs: 20000 };
  const p = pnsSearch(f.board, f.attacker, opts);
  const d = dfpnSearch(f.board, f.attacker, opts);
  const same = p.status === d.status;
  const expectOk = d.status === f.expect;
  let proofOk = '—';
  if (d.status === 'proven-win') {
    const v = V.verify(f.board, d.attacker || f.attacker, d.proof.tree);
    proofOk = v.ok ? '通过' : '失败：' + v.reason;
    if (!v.ok) fails++;
  }
  console.log(`${same && expectOk ? '✓' : '✗'} ${f.name}`);
  console.log(`    PNS   status=${p.status} pn=${p.pn} dn=${p.dn} 节点 ${p.nodes}/${p.ms}ms` +
    (p.status === 'proven-win' ? ` 树 ${treeSize(p.proof.tree)}` : ''));
  console.log(`    df-pn status=${d.status} pn=${d.pn} dn=${d.dn} 节点 ${d.nodes} 展开 ${d.expansions} ` +
    `下降 ${d.descents} TT ${d.ttSize}(命中 ${d.ttHits}) 最大深度 ${d.maxDepth} ${d.ms}ms` +
    (d.status === 'proven-win' ? ` 树 ${treeSize(d.proof.tree)}` : ''));
  console.log(`    ⇒ 结论一致=${same}  与预期一致=${expectOk}  规则层独立核验=${proofOk}`);
  if (!same || !expectOk) fails++;
}

function treeSize(t) { let n = 0; (function w(x) { n++; if (!x.terminal) for (const e of x.moves) w(e.child); })(t); return n; }

console.log(fails ? `\ndf-pn 对照失败 ${fails} 项` : '\ndf-pn 对照全部通过（结论与 PNS 一致，证明可独立核验）');
process.exit(fails ? 1 : 0);
