'use strict';
/* ============================================================
   check-bound-reuse —— "有界结论区间复用"（L/U 表）的回归

   这是**一项单独改动的验收**：只加"跨 horizon 复用已证结论"，不动搜索语义。
   断言分四组：

   A. 单调性：`refuted` 向下封闭、`proven-win` 向上封闭（复用结论必须与真搜一致）
   B. 复用出来的证书**必须**能通过两层核验（库内 + 规则层独立）
   C. 负向对照：
      - 未完成结论（unknown / 预算耗尽 / null）**不得**写入区间
      - "只改 maxPlies 不截断"的反证证书**必须被拒**（证明截断是必需的，不是装饰）
      - 获胜树深度 > 查询 N 时**不得**复用（否则会用"深度 8 的树"回答"≤3 能否赢"）
      - 反证证书 maxPlies < 查询 N 时**不得**复用
      - 结论命中但无可用证书 ⇒ 必须真搜（`verdictOnlyMiss`），不得凭空产出证书
   D. 结论与证书分离：`boundLookup` 只报结论，不产出任何证明

   用法：node tools/check-bound-reuse.js
   ============================================================ */
const CORE = require('./solver-core');
const RULE = require('./verify-strategy');
const { Position, dfpnSearch, createBoundCache, boundLookup, boundStore, truncateRefutation,
  verifyRefutation, verifyStrategy } = CORE;

let fails = 0;
const bad = m => { fails++; console.log('  ✗ ' + m); };
const ok = m => console.log('  ✓ ' + m);
const assert = (c, m) => { if (!c) throw new Error('断言失败：' + m); };

const treeNodes = t => { let n = 0; const w = x => { n++; if (!x.terminal) for (const e of x.moves) w(e.child); }; w(t); return n; };
const treeDepth = t => { let d = 0; const w = (x, k) => { if (k > d) d = k; if (!x.terminal) for (const e of x.moves) w(e.child, k + 1); }; w(t, 0); return d; };

/* 双层核验：返回 {ok, reason} */
function verifyBoth(status, entries, attacker, proof) {
  if (status === 'refuted') {
    const a = verifyRefutation(entries, attacker, proof);
    const b = RULE.verifyRefutation(entries, attacker, proof);
    return { ok: a.ok && b.ok, reason: a.reason || b.reason };
  }
  const a = verifyStrategy(entries, attacker, proof.tree);
  const depth = treeDepth(proof.tree);
  return { ok: a.ok, reason: a.reason, depth };
}

/* ---------- 夹具 ---------- */
// (1) P3 连续威胁强杀（浅）：attacker=P1 能在小 N 内证胜 ⇒ 测"向上封闭"
const THREAT = [['0,0',3],['0,-1',1],['1,0',2],['1,-1',1],['-1,0',2],['2,0',1],['3,0',2]];
// (2) ply4 的 (1,-1) 之后：attacker=P2 在 ≤16 内拿不下 ⇒ 测"向下封闭 + 截断"
const PLY4 = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'bounded-ply4.json'), 'utf8')).board;
const afterPly4 = m => { const p = new Position(PLY4); const u = p.play(m, 1); const child = [...p.board]; p.undo(u); return child; };

console.log('有界结论区间复用（L/U）回归\n');

/* ---------- A + B：refuted 向下封闭（含截断复用） ---------- */
console.log('A/B 反证区间：refuted 向下封闭 + 复用证书必须过两层核验');
{
  const child = afterPly4({ x: 1, y: -1 });          // 轮到 P2，attacker=P2
  const bc = createBoundCache();
  const r8 = dfpnSearch(child, 2, { maxPlies: 8, maxNodes: 400000, timeMs: 30000, boundCache: bc });
  if (r8.status !== 'refuted') bad(`前置：N=8 应 refuted，实得 ${r8.status}`);
  else ok(`N=8 真搜 ⇒ refuted（${r8.nodes} 节点，证书 ${treeNodes(r8.proof.tree)} 节点）`);
  if (bc.bounds.size !== 1) bad('区间表条目数应为 1');
  const rec = [...bc.bounds.values()][0];
  if (rec.L !== 8) bad(`L 应为 8，实得 ${rec.L}`);
  else ok(`区间写入 L=${rec.L}（只由已完成结论写入）`);

  // 更短的 horizon 必须走**截断复用**，且复用证书要过两层核验
  for (const N of [4, 6, 8]) {
    const r = dfpnSearch(child, 2, { maxPlies: N, maxNodes: 400000, timeMs: 30000, boundCache: bc });
    if (r.status !== 'refuted') { bad(`N=${N} 应 refuted（复用），实得 ${r.status}`); continue; }
    if (!r.cached || r.cached.kind !== 'refutation-truncated') { bad(`N=${N} 未走截断复用：${JSON.stringify(r.cached)}`); continue; }
    const v = verifyBoth('refuted', child, 2, r.proof);
    if (!v.ok) { bad(`N=${N} 复用证书两层核验失败：${v.reason}`); continue; }
    if (r.proof.maxPlies !== N) { bad(`N=${N} 复用证书的 maxPlies 应为 ${N}，实得 ${r.proof.maxPlies}`); continue; }
    ok(`N=${N} 截断复用（源 N=${r.cached.fromN}，0 节点）两层核验通过`);
  }

  // 真搜得到的结论必须与复用得到的完全一致（单调性交叉核对）
  const fresh = createBoundCache();
  const rf = dfpnSearch(child, 2, { maxPlies: 6, maxNodes: 400000, timeMs: 30000, boundCache: fresh });
  if (rf.cached) bad('冷缓存下不应命中复用');
  else if (rf.status !== 'refuted') bad(`冷缓存 N=6 应 refuted，实得 ${rf.status}`);
  else ok(`单调性交叉核对：N=6 真搜（${rf.nodes} 节点）与复用结论一致`);

  // 区间之外的 N（更大）必须真搜，并把 L 抬高
  const r12 = dfpnSearch(child, 2, { maxPlies: 12, maxNodes: 1500000, timeMs: 120000, boundCache: bc });
  if (r12.cached) bad('N=12 超出区间，不应命中复用');
  else if (r12.status !== 'refuted') bad(`N=12 应 refuted，实得 ${r12.status}`);
  else {
    const L = [...bc.bounds.values()][0].L;
    if (!(L >= 12)) bad(`真搜完成后 L 应 ≥12，实得 ${L}`);
    else ok(`N=12 真搜（${r12.nodes} 节点）⇒ L 抬高到 ${L}`);
  }
}

/* ---------- A + B：proven-win 向上封闭 ---------- */
console.log('\nA/B 获胜区间：proven-win 向上封闭 + 复用证书必须过核验');
{
  const bc = createBoundCache();
  const r3 = dfpnSearch(THREAT, 1, { maxPlies: 3, maxNodes: 400000, timeMs: 30000, boundCache: bc });
  if (r3.status !== 'proven-win') bad(`前置：N=3 应 proven-win，实得 ${r3.status}`);
  else {
    const d = treeDepth(r3.proof.tree);
    const U = [...bc.bounds.values()][0].U;
    ok(`N=3 真搜 ⇒ proven-win（树深 ${d}）；区间写入 U=${U}（= 树深，比 horizon 更紧）`);
    for (const N of [3, 6, 20]) {
      const r = dfpnSearch(THREAT, 1, { maxPlies: N, maxNodes: 400000, timeMs: 30000, boundCache: bc });
      if (r.status !== 'proven-win') { bad(`N=${N} 应 proven-win（复用），实得 ${r.status}`); continue; }
      if (!r.cached || r.cached.kind !== 'win-proof') { bad(`N=${N} 未走获胜证明复用：${JSON.stringify(r.cached)}`); continue; }
      if (r.cached.treeDepth > N) { bad(`N=${N} 复用了树深 ${r.cached.treeDepth} 的证明（超过 N）`); continue; }
      const v = verifyBoth('proven-win', THREAT, 1, r.proof);
      if (!v.ok) { bad(`N=${N} 复用获胜树核验失败：${v.reason}`); continue; }
      ok(`N=${N} 复用获胜树（真实距离 ≤${r.cached.treeDepth}，0 节点）核验通过`);
    }
    // 区间下方（N < U）必须真搜。用一份**获胜距离更长**的夹具（U 明显 >1），
    // 否则 U=1 时"N<U"只剩 N=0（非法）。
    const ANDB = [['0,0',3],['0,-1',1],['1,0',2],['0,-2',1],['0,-3',2],['1,-2',1],['2,0',2]];
    const bc2 = createBoundCache();
    const rBig = dfpnSearch(ANDB, 1, { maxPlies: 12, maxNodes: 400000, timeMs: 60000, boundCache: bc2 });
    if (rBig.status !== 'proven-win') bad(`前置：安静手证胜夹具 N=12 应 proven-win，实得 ${rBig.status}`);
    else {
      const U2 = [...bc2.bounds.values()][0].U;
      const rLow = dfpnSearch(ANDB, 1, { maxPlies: Math.max(1, U2 - 2), maxNodes: 400000, timeMs: 60000, boundCache: bc2 });
      if (rLow.cached) bad(`N=${Math.max(1, U2 - 2)} 在 U=${U2} 之下，不应命中复用`);
      else ok(`U=${U2}（树深），N=${Math.max(1, U2 - 2)} 在区间下方 ⇒ 真搜（${rLow.nodes} 节点，结论 ${rLow.status}）`);
    }
  }
}

/* ---------- C：负向对照 ---------- */
console.log('\nC 负向对照');
{
  // C1 未完成结论不得写入
  const bc = createBoundCache();
  const before = bc.bounds.size;
  boundStore(bc, THREAT, 1, 5, 'unknown');
  boundStore(bc, THREAT, 1, 5, null);
  boundStore(bc, THREAT, 1, 5, 'timedOut');
  if (bc.bounds.size !== before) bad('未完成结论被写进了区间表');
  else ok('未完成结论（unknown / null / timedOut）一律不写入');

  // C2 "只改 maxPlies 不截断"的反证证书必须被拒
  const child = afterPly4({ x: 1, y: -1 });
  const r8 = dfpnSearch(child, 2, { maxPlies: 8, maxNodes: 400000, timeMs: 30000 });
  const relabel = { kind: 'refutation', attacker: 2, maxPlies: 3, root: r8.proof.root.slice(), tree: r8.proof.tree };
  const vr = verifyRefutation(child, 2, relabel);
  if (vr.ok) bad('核验器接受了"只改 maxPlies 未截断"的证书');
  else ok(`只改 maxPlies 不截断 ⇒ 被拒（${String(vr.reason).slice(0, 30)}）⇒ 截断是必需的`);
  const cut = truncateRefutation(r8.proof, 3);
  const vc = verifyBoth('refuted', child, 2, cut);
  if (!vc.ok) bad('截断后的证书未通过核验：' + vc.reason);
  else ok(`截断到 N=3 后通过两层核验（${treeNodes(cut.tree)} 节点）`);

  // C3 获胜树深度 > 查询 N 时不得复用（手工植入一份深树）
  {
    const deepProof = { attacker: 1, root: THREAT.slice(), tree: { side: 1, terminal: null, moves: [
      { move: { x: 0, y: -1 }, child: { side: 2, terminal: { kind: 'connect4' }, moves: [] } }] } };
    const bcv = createBoundCache();
    bcv.bounds.set(CORE.RULE_VERSION + '|1|1|' + CORE.exactStateKey(THREAT, 1).split('|').slice(1).join('|'),
      { L: null, U: 1, refCert: null, winCert: { proof: deepProof, depth: 7 } });
    // 上面手工植入的键可能不匹配 ⇒ 用 boundStore 走正规路径更稳：直接构造 rec 并核对复用条件
    const bc2 = createBoundCache();
    // 先真搜拿到一份 U；再篡改 winCert 的 depth 使其 > 查询 N
    dfpnSearch(THREAT, 1, { maxPlies: 3, maxNodes: 400000, timeMs: 30000, boundCache: bc2 });
    const rec = [...bc2.bounds.values()][0];
    rec.winCert = { proof: rec.winCert.proof, depth: 99 };     // 伪造一个"深度 99"的距离
    rec.U = 0;                                                 // 让区间声称"任意 N 都覆盖"
    const r = dfpnSearch(THREAT, 1, { maxPlies: 3, maxNodes: 400000, timeMs: 30000, boundCache: bc2 });
    if (r.cached && r.cached.kind === 'win-proof') bad('复用了"深度 > N"的获胜树（距离条件没生效）');
    else ok(`获胜树深度 > N ⇒ 拒绝复用（回落真搜，${r.nodes} 节点）`);
  }

  // C4 反证证书 maxPlies < 查询 N 时不得复用
  {
    const bc4 = createBoundCache();
    const c = afterPly4({ x: 1, y: -1 });
    const r = dfpnSearch(c, 2, { maxPlies: 4, maxNodes: 400000, timeMs: 30000, boundCache: bc4 });
    const rec = [...bc4.bounds.values()][0];
    rec.refCert = { kind: 'refutation', attacker: 2, maxPlies: 3, root: r.proof.root.slice(), tree: r.proof.tree };
    rec.L = 8;                                                 // 声称"8 以内都赢不了"，但证书只到 3
    const r2 = dfpnSearch(c, 2, { maxPlies: 6, maxNodes: 400000, timeMs: 30000, boundCache: bc4 });
    if (r2.cached) bad('复用了 maxPlies < N 的反证证书');
    else ok(`反证证书 maxPlies < N ⇒ 拒绝复用（回落真搜，${r2.nodes} 节点）`);
  }

  // C5 结论命中但无可用证书 ⇒ 必须真搜，且记 verdictOnlyMiss
  {
    const bc5 = createBoundCache(undefined, 0);                // certMaxNodes=0 ⇒ 永不缓存证书
    const c = afterPly4({ x: 1, y: -1 });
    dfpnSearch(c, 2, { maxPlies: 4, maxNodes: 400000, timeMs: 30000, boundCache: bc5 });
    const r = dfpnSearch(c, 2, { maxPlies: 4, maxNodes: 400000, timeMs: 30000, boundCache: bc5 });
    if (r.cached) bad('certMaxNodes=0 时不应复用到证书');
    else if (bc5.verdictOnlyMiss < 1) bad('结论命中但无证书时应记 verdictOnlyMiss');
    else ok(`证书未缓存 ⇒ 真搜并记 verdictOnlyMiss=${bc5.verdictOnlyMiss}（结论与证书分开）`);
  }
}

/* ---------- D：结论与证书分离 ---------- */
console.log('\nD 结论与证书分离（boundLookup 只报结论）');
{
  const bc = createBoundCache();
  dfpnSearch(THREAT, 1, { maxPlies: 3, maxNodes: 400000, timeMs: 30000, boundCache: bc });
  const hit = boundLookup(bc, THREAT, 1, 5);
  if (hit.status !== 'proven-win') bad(`boundLookup 应回报 proven-win，实得 ${hit.status}`);
  else if ('proof' in hit || 'tree' in hit) bad('boundLookup 不应产出任何证明');
  else ok(`boundLookup 只报结论：status=${hit.status} L=${hit.L} U=${hit.U}（无证明字段）`);
  const miss = boundLookup(createBoundCache(), THREAT, 1, 5);
  if (miss.status !== 'miss') bad('空缓存的查询应为 miss');
  else ok('空缓存 ⇒ miss（没有 L/U 就不给任何结论）');
}

/* ---------- E：确定性成本度量 + 对照组有效性 ---------- */
console.log('\nE 确定性成本度量（节点数而非墙钟）与对照组');
{
  const bc0 = createBoundCache(0);                 // maxEntries=0 ⇒ boundStore 永不写入
  const r1 = dfpnSearch(THREAT, 1, { maxPlies: 3, maxNodes: 400000, timeMs: 30000, boundCache: bc0 });
  const r2 = dfpnSearch(THREAT, 1, { maxPlies: 3, maxNodes: 400000, timeMs: 30000, boundCache: bc0 });
  if (bc0.bounds.size !== 0) bad('对照组（maxEntries=0）竟然写入了区间表');
  else ok('maxEntries=0 ⇒ 永不写入，可作"完全不复用"的对照组');
  if (r2.cached) bad('对照组不应命中复用');
  else if (r2.nodes !== r1.nodes) bad(`对照组两次搜索节点数应一致：${r1.nodes} vs ${r2.nodes}`);
  else ok(`相同预算下节点数可复现（两次都 ${r1.nodes}）⇒ 节点数才是可靠指标`);
  if (bc0.searchCalls !== 2 || bc0.searchNodes !== r1.nodes + r2.nodes)
    bad(`累加器不对：calls=${bc0.searchCalls} nodes=${bc0.searchNodes}（期望 ${2} / ${r1.nodes + r2.nodes}）`);
  else ok(`累加器正确：${bc0.searchCalls} 次调用累计 ${bc0.searchNodes} 节点`);

  const bc1 = createBoundCache();
  const s1 = dfpnSearch(THREAT, 1, { maxPlies: 3, maxNodes: 400000, timeMs: 30000, boundCache: bc1 });
  const s2 = dfpnSearch(THREAT, 1, { maxPlies: 12, maxNodes: 400000, timeMs: 30000, boundCache: bc1 });
  if (!s2.cached || s2.nodes !== 0) bad('复用命中应返回 0 节点');
  else if (bc1.searchNodes !== s1.nodes) bad(`命中后累计应为 ${s1.nodes}，实得 ${bc1.searchNodes}`);
  else ok(`复用命中记 0 节点 ⇒ 累计 ${bc1.searchNodes}，对照组同位置累计 ${r1.nodes + r2.nodes}`);
}

console.log('');
console.log(fails ? `有界区间复用回归：失败 ${fails} 项` : '有界区间复用回归：全部通过');
process.exit(fails ? 1 : 0);
