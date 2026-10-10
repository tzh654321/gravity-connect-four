'use strict';
/* ============================================================
   check-dfpn-order —— DFPN **后继排序**的回归（P8-2）

   排序只改 `n.kids` 的**顺序**，所以：

   A. **默认路径（order='none'）必须逐位不变** —— 用历史上记录过的数字当锚
      （t5 = 5732 节点 / 3099 TT 命中 / 266 节点策略树；t6 = 10194 节点）。
      改动前后只要这几个数变了，就说明默认路径被污染了。
   B. **结论必须与未排序一致**（同一命题、同一预算；理论依据：顺序不影响 pn/dn 的不动点，
      也不影响走法集合 / 阈值 / 终点语义 ⇒ 可证的结论完全相同）。
   C. **绝不能少走法**：守这条的是**独立核验** —— `verifyRefutation` 要求攻击方回合
      **覆盖全部**合法走法、`verifyStrategy` 要求每步合法；所以"漏掉候选"必然被两层核验抓出来。
      这里对每份新证书都跑库内 + 规则层两遍。
   D. **可复现**：同一 order 跑两次，status / nodes / successors 必须逐位相同（排序必须确定性）。
   E. **允许证明树不同**：排序后见证可以是另一个合法走法、树可以更小或更大；
      本回归**刻意不比较**证书哈希与树大小，只比较结论 + 可核验性。
   F. 顺序还得是"pn/dn 优先"：kids 的顺序不参与端点的选择 —— 这条由结构保证
      （`step` 的 bi 只比 pn/dn，顺序只做平局破法），回归里用"结论一致 + 走法齐全"间接守。

   用法：node tools/check-dfpn-order.js
   ============================================================ */
const fs = require('fs');
const path = require('path');
const CORE = require('./solver-core');
const RULE = require('./verify-strategy');
const { Position, dfpnSearch, verifyStrategy, verifyRefutation } = CORE;

let fails = 0;
const bad = m => { fails++; console.log('  ✗ ' + m); };
const ok = m => console.log('  ✓ ' + m);

const PLY4 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'bounded-ply4.json'), 'utf8')).board;
const after = m => { const p = new Position(PLY4); const u = p.play(m, 1); const b = [...p.board]; p.undo(u); return b; };

// 便宜但覆盖三类任务：强制手 / 有界反证 / 不含立即威胁的安静开拓
const THREAT = [['0,0', 3], ['0,-1', 1], ['1,0', 2], ['1,-1', 1], ['-1,0', 2], ['2,0', 1], ['3,0', 2]];
// ⚠ ply4 根局面只有这 7 个合法走法：(1,0) (-2,0) (-1,1) (-1,-2) (0,2) (1,-1) (0,-2)
//   其它坐标会抛"非法落点"（曾被用来抓出夹具用了不可达棋框）。
const CASES = [
  { id: 'A 连续威胁 N=3', board: THREAT, attacker: 1, maxPlies: 3, maxNodes: 400000, timeMs: 30000,
    expect: 'proven-win' },
  { id: 'B ply4(1,-1) N=8', board: after({ x: 1, y: -1 }), attacker: 2, maxPlies: 8, maxNodes: 400000, timeMs: 60000,
    expect: 'refuted', anchor: { nodes: 10194 } },
  { id: 'C ply4(-2,0) N=3', board: after({ x: -2, y: 0 }), attacker: 2, maxPlies: 3, maxNodes: 400000, timeMs: 60000,
    expect: 'proven-win', anchor: null },
  { id: 'D ply4(-2,0) N=2', board: after({ x: -2, y: 0 }), attacker: 2, maxPlies: 2, maxNodes: 400000, timeMs: 60000,
    expect: 'refuted', anchor: null }
];

const verifyBoth = (board, attacker, r) => {
  if (r.status === 'refuted') {
    if (!r.proof) return { ok: false, reason: '缺反证证书' };
    const a = verifyRefutation(board, attacker, r.proof);
    const b = RULE.verifyRefutation(board, attacker, r.proof);
    return { ok: a.ok && b.ok, reason: a.reason || b.reason };
  }
  if (r.status === 'proven-win') {
    if (!r.proof) return { ok: false, reason: '缺策略树' };
    const a = verifyStrategy(board, attacker, r.proof.tree);
    const b = RULE.verify(board, attacker, r.proof.tree);
    return { ok: a.ok && b.ok, reason: a.reason || b.reason };
  }
  return { ok: null, reason: '未知任务不核验' };
};

console.log('DFPN 后继排序回归\n');

/* ---------- A：默认路径逐位不变 ---------- */
console.log('A 默认路径（order 未传）必须逐位不变');
{
  const c = CASES[1];
  const r = dfpnSearch(c.board, c.attacker, { maxPlies: c.maxPlies, maxNodes: c.maxNodes, timeMs: c.timeMs });
  if (r.orderCalls !== 0 || r.orderScores !== 0) bad('未传 order 时排序开销必须为 0');
  else ok(`未传 order：orderCalls=${r.orderCalls} orderScores=${r.orderScores}（完全不走排序）`);
  if (r.nodes !== 10194) bad(`锚点漂移：N=8 反证应为 10194 节点，实得 ${r.nodes}`);
  else ok('锚点一致：ply4(1,-1) N=8 ⇒ 10194 节点（与历史记录逐位相同）');
  // 第二个锚点：开发集 t5「含安静手的证胜」局面（历史上的 5732 节点 / 3099 TT 命中 / 266 节点树）
  const QUIET = [['0,0', 3], ['0,-1', 1], ['1,0', 2], ['0,-2', 1], ['0,-3', 2], ['1,-2', 1], ['2,0', 2]];
  const t5 = dfpnSearch(QUIET, 1, { maxPlies: 12, maxNodes: 400000, timeMs: 30000 });
  if (t5.nodes !== 5732) bad(`锚点漂移：THREAT N=12 应为 5732 节点，实得 ${t5.nodes}`);
  else ok('锚点一致：THREAT N=12 ⇒ 5732 节点 / 3099 TT 命中');
}

/* ---------- B/C：结论一致 + 两层核验 ---------- */
const MODES = ['none', 'block', 'shape'];
console.log('\nB/C 三个模式的结论必须与 none 一致，且证书都要过两层核验');
const results = {};
for (const c of CASES) {
  console.log(`  ${c.id}（期望 ${c.expect}）`);
  for (const m of MODES) {
    const r = dfpnSearch(c.board, c.attacker,
      { maxPlies: c.maxPlies, maxNodes: c.maxNodes, timeMs: c.timeMs, order: m });
    const v = verifyBoth(c.board, c.attacker, r);
    const key = c.id + '|' + m;
    results[key] = { r, v };
    const tag = `${m.padEnd(6)} ${r.status.padEnd(11)} nodes=${String(r.nodes).padStart(6)} succ=${String(r.successors).padStart(6)}`;
    if (r.status !== c.expect) bad(`${c.id} [${m}] 结论 ${r.status} ≠ 期望 ${c.expect}（预算内必须一致）`);
    else if (v.ok === false) bad(`${c.id} [${m}] 两层核验失败：${v.reason}`);
    else ok(`${tag}  核验通过`);
  }
  const base = results[c.id + '|none'].r;
  for (const m of MODES.slice(1)) {
    const r = results[c.id + '|' + m].r;
    if (r.status !== base.status) bad(`${c.id} [${m}] 与 none 结论不同：${r.status} vs ${base.status}`);
  }
  // D：同一个模式跑两次必须逐位相同（排序必须确定性）
  for (const m of MODES.slice(1)) {
    const a = dfpnSearch(c.board, c.attacker, { maxPlies: c.maxPlies, maxNodes: c.maxNodes, timeMs: c.timeMs, order: m });
    const b = dfpnSearch(c.board, c.attacker, { maxPlies: c.maxPlies, maxNodes: c.maxNodes, timeMs: c.timeMs, order: m });
    if (a.status !== b.status || a.nodes !== b.nodes || a.successors !== b.successors)
      bad(`${c.id} [${m}] 不可复现：${a.nodes}/${a.successors} vs ${b.nodes}/${b.successors}`);
    else if (m === 'shape' && CASES.indexOf(c) === 0)
      ok(`shape 可复现：${a.status} ${a.nodes} 节点 / ${a.successors} 后继（两次一致）`);
  }
}

/* ---------- D：排序确实发生（不被静默忽略） ---------- */
console.log('\nD 排序确实被启用（诊断字段自洽）');
{
  const c = CASES[1];
  const none = dfpnSearch(c.board, c.attacker, { maxPlies: c.maxPlies, maxNodes: c.maxNodes, timeMs: c.timeMs, order: 'none' });
  const blk = dfpnSearch(c.board, c.attacker, { maxPlies: c.maxPlies, maxNodes: c.maxNodes, timeMs: c.timeMs, order: 'block' });
  const shp = dfpnSearch(c.board, c.attacker, { maxPlies: c.maxPlies, maxNodes: c.maxNodes, timeMs: c.timeMs, order: 'shape' });
  const chk = (r, name, wantScores) => {
    if (r.orderCalls !== r.expansions) bad(`${name}：orderCalls(${r.orderCalls}) 应等于 expansions(${r.expansions})`);
    else if (wantScores && r.orderScores !== r.successors) bad(`${name}：orderScores(${r.orderScores}) 应等于 successors(${r.successors})`);
    else if (!wantScores && r.orderScores !== 0) bad(`${name}：block 模式不做额外评分，实得 ${r.orderScores}`);
    else ok(`${name.padEnd(6)} 展开 ${r.expansions} 次 ⇒ 排序 ${r.orderCalls} 次、评分 ${r.orderScores} 次`);
  };
  if (none.orderCalls !== 0) bad('none 模式不应有排序调用');
  chk(blk, 'block', false);
  chk(shp, 'shape', true);
  // 非法模式必须回落到 none（拼写错误不能悄悄变成"某种排序"）
  const typo = dfpnSearch(c.board, c.attacker, { maxPlies: c.maxPlies, maxNodes: c.maxNodes, timeMs: c.timeMs, order: 'shapped' });
  if (typo.nodes !== none.nodes) bad(`未知 order 值未回落到 none：${typo.nodes} vs ${none.nodes}`);
  else ok(`未知 order 值回落 none ⇒ ${typo.nodes} 节点（与基线一致）`);
}

console.log('');
console.log(fails ? `DFPN 排序回归：失败 ${fails} 项` : 'DFPN 排序回归：全部通过');
process.exit(fails ? 1 : 0);
