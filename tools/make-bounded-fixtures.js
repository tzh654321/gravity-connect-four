'use strict';
/* ============================================================
   make-bounded-fixtures —— 为 ply4 生成**可复现的规范夹具**

   解决两个问题：
     ① 有界反证证书很大（N=16 时 9 万 / 21 万节点、23MB），不适合直接入库；
     ② 但"结论必须能被其他对话复现"。

   做法：入库的是**规范输入 + 结论 + 证书哈希**（小文件），大证书另存一份（gitignore）。
   任何人跑一次本脚本，就能重新生成证书、用**规则层独立核验器**复核、并比对哈希。

   产物：
     tools/fixtures/bounded-ply4.json        入库（小）：源棋谱、局面、每手的结论与哈希
     tools/fixtures/bounded-ply4-certs.jsonl gitignore（大）：完整证书（获胜树 / 防守证书）

   用法：
     node tools/make-bounded-fixtures.js
   ============================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Position, dfpnSearch } = require('./solver-core');
const V = require('./verify-strategy');

const RECORDS = 'tools/bench-games-lean.jsonl';
const GAME = 'hard|P1#7';
const PLY = 4;
const OUT_JSON = 'tools/fixtures/bounded-ply4.json';
const OUT_CERTS = 'tools/fixtures/bounded-ply4-certs.jsonl';
const N_MAX = 16;                       // 攻击方=P2 的扫深上限（N=16 对两个未知走法约 27s / 34s）
const SELF_TARGETS = [{ x: 1, y: -1 }, { x: 0, y: -2 }];   // 只对这两个关键走法做"攻击方=走棋方 P1"的对称扫深
const SELF_MAX = 19;
const BUDGET = { maxNodes: 3000000, timeMs: 600000 };

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const treeStat = t => {
  let nodes = 0, leaves = 0, depth = 0, attackerNodes = 0;
  (function w(x, d) {
    nodes++; if (d > depth) depth = d;
    if (x.terminal) { leaves++; return; }
    for (const e of x.moves) w(e.child, d + 1);
  })(t, 0);
  return { nodes, leaves, depth };
};

const games = fs.readFileSync(RECORDS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const g = games.find(x => x.game === GAME);
if (!g) { console.error('找不到该局：' + GAME); process.exit(1); }

const pos = new Position(g.start);
const boards = [], sides = [];
for (const r of g.record) { boards[r.ply] = [...pos.board]; sides[r.ply] = r.side; pos.play(r.move, r.side); }
const board = boards[PLY], mover = sides[PLY], attacker = 3 - mover;
const moves = new Position(board).moves();

console.log(`对局 ${GAME}；ply${PLY} 轮到 P${mover}；待证获胜方 P${attacker}；合法走法 ${moves.length} 个`);
console.log(`扫深上限 N=${N_MAX}，预算 ${BUDGET.maxNodes} 节点 / ${BUDGET.timeMs}ms\n`);

const certLines = [];
const entries = [];
let fails = 0;

for (const mv of moves) {
  const p = new Position(board);
  p.play(mv, mover);
  const child = [...p.board];
  const rec = { move: { x: mv.x, y: mv.y }, attacker, maxPliesTested: N_MAX, result: null, minWinDepth: null, maxRefuted: null };

  // 从 N=1 起逐个加深：证胜即停（得到最小深度）；被穷尽否定就继续加深；撞预算记下来。
  // 注意结论的**单调性**与代价的**非单调性**：
  //   - 真值单调：证出"≤16 赢不了"就蕴含"≤15 也赢不了"，所以最强的结论取**已证否定的最大 N**；
  //   - 但**代价不单调**（实测 (0,-2) 在 N=15 撞 300 万节点，而 N=16 只要 90 万），
  //     所以中途的 unknown 不代表结论更弱，只说明那一档难搜。
  let bestRefut = null, provenWin = null;
  const unknownAt = [];
  for (let N = 1; N <= N_MAX; N++) {
    const r = dfpnSearch(child, attacker, Object.assign({ maxPlies: N }, BUDGET));
    if (r.status === 'proven-win') {
      const v = V.verify(child, attacker, r.proof.tree);
      const s = treeStat(r.proof.tree);
      if (!v.ok) { fails++; console.error(`  ✗ (${mv.x},${mv.y}) N=${N} 获胜策略树核验失败：${v.reason}`); }
      provenWin = { N, tree: r.proof.tree, stat: s, verified: v.ok };
      break;
    }
    if (r.status === 'refuted') {
      const v = r.proof ? V.verifyRefutation(child, attacker, r.proof) : { ok: false, reason: '未导出反证证书' };
      if (!v.ok) { fails++; console.error(`  ✗ (${mv.x},${mv.y}) N=${N} 反证证书核验失败：${v.reason}`); }
      bestRefut = { N, proof: r.proof, stat: r.proof ? treeStat(r.proof.tree) : null, verified: v.ok };
      continue;
    }
    unknownAt.push(N);               // 撞预算：继续往更大的 N 试（代价不单调）
  }
  if (provenWin) {
    rec.result = 'proven-win-within-N';
    rec.minWinDepth = provenWin.N;
    rec.winTree = Object.assign({}, provenWin.stat, {
      hash: sha256(JSON.stringify(provenWin.tree)), verified: provenWin.verified });
    certLines.push({ game: GAME, ply: PLY, move: mv, mover, sideToMove: attacker, attacker,
      board: child, tree: provenWin.tree });
  } else if (bestRefut) {
    rec.result = 'refuted-up-to-N';
    rec.maxRefuted = bestRefut.N;
    rec.unknownAt = unknownAt;
    rec.defence = bestRefut.stat
      ? Object.assign({}, bestRefut.stat, { hash: sha256(JSON.stringify(bestRefut.proof.tree)), verified: bestRefut.verified })
      : { verified: bestRefut.verified };
    certLines.push({ game: GAME, ply: PLY, move: mv, mover, sideToMove: attacker, attacker,
      board: child, refutation: bestRefut.proof });
  } else {
    rec.result = 'unknown';
    rec.unknownAt = unknownAt;
  }
  entries.push(rec);
  if (rec.result === 'proven-win-within-N') {
    console.log(`  (${mv.x},${mv.y})  P${attacker} 能在 ≤${rec.minWinDepth} 半回合内强制连四  ` +
      `（最小深度）获胜树 ${rec.winTree.nodes} 节点/深 ${rec.winTree.depth}  核验=${rec.winTree.verified ? '通过' : '失败'}` +
      (unknownAt.length ? `  ⚠ 中途 N=${unknownAt.join(',')} 撞预算` : ''));
  } else if (rec.result === 'refuted-up-to-N') {
    console.log(`  (${mv.x},${mv.y})  P${attacker} 无法在 ≤${rec.maxRefuted} 半回合内强制连四  ` +
      `防守证书 ${rec.defence.nodes} 节点/深 ${rec.defence.depth}  核验=${rec.defence.verified ? '通过' : '失败'}` +
      (unknownAt.length ? `  ⚠ 中途 N=${unknownAt.join(',')} 撞预算（代价非单调）` : ''));
  } else {
    console.log(`  (${mv.x},${mv.y})  全程撞预算（unknown），N=${rec.unknownAt.join(',')}`);
  }
}

/* ---- 第二遍：把攻击方换成**走棋方自己**（P1）。这是对称的问题："P1 能否在 ≤N 内强制连四"。
   只对两个关键走法做 —— 5 个已证败的走法在这里几乎必然一路被否定到上限，白花时间。 ---- */
console.log(`\n攻击方换成走棋方 P${mover}（对称问题：P${mover} 能否在 ≤N 半回合内强制连四，N ≤ ${SELF_MAX}）`);
for (const e of entries) {
  if (!SELF_TARGETS.some(s => s.x === e.move.x && s.y === e.move.y)) continue;
  const mv = e.move;
  const p = new Position(board); p.play(mv, mover); const child = [...p.board];
  let best = null; const unknownAt = [];
  for (let N = 1; N <= SELF_MAX; N++) {
    const r = dfpnSearch(child, mover, Object.assign({ maxPlies: N }, BUDGET));
    if (r.status === 'proven-win') { e.self = { result: 'proven-win-within-N', minWinDepth: N }; break; }
    if (r.status === 'refuted') {
      const v = r.proof ? V.verifyRefutation(child, mover, r.proof) : { ok: false, reason: '未导出反证证书' };
      if (!v.ok) { fails++; console.error(`  ✗ (${mv.x},${mv.y}) self N=${N} 反证证书核验失败：${v.reason}`); }
      best = { N, proof: r.proof, stat: r.proof ? treeStat(r.proof.tree) : null, verified: v.ok };
      continue;
    }
    unknownAt.push(N);
  }
  if (best) {
    e.self = { result: 'refuted-up-to-N', maxRefuted: best.N, unknownAt,
      defence: Object.assign({}, best.stat, { hash: sha256(JSON.stringify(best.proof.tree)), verified: best.verified }) };
    certLines.push({ game: GAME, ply: PLY, move: mv, mover, sideToMove: mover, attacker: mover,
      board: child, refutation: best.proof });
    console.log(`  (${mv.x},${mv.y})  P${mover} 无法在 ≤${best.N} 半回合内强制连四  ` +
      `防守证书 ${best.stat.nodes} 节点/深 ${best.stat.depth}  核验=${best.verified ? '通过' : '失败'}` +
      (unknownAt.length ? `  ⚠ 中途 N=${unknownAt.join(',')} 撞预算` : ''));
  } else {
    e.self = { result: 'unknown', unknownAt };
    console.log(`  (${mv.x},${mv.y})  未知（撞预算 N=${unknownAt.join(',')}）`);
  }
}

const doc = {
  note: '由 tools/make-bounded-fixtures.js 生成。命题口径：**有界博弈** —— 「某方能否在 ≤N 半回合内强制连四」；' +
    '半回合 = 一次落子。连四立即获胜，半回合用尽仍未分胜负记和棋。' +
    'refuted 表示"确切的：无法在 ≤N 半回合内强制连四"，**不是**"永远赢不了"。',
  source: { records: RECORDS, game: GAME, ply: PLY, start: g.start },
  board,
  sideToMove: mover,
  attacker,
  budget: BUDGET,
  scanUpTo: N_MAX,
  moves: entries,
  certFile: OUT_CERTS,
};
fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(doc, null, 2) + '\n');
fs.writeFileSync(OUT_CERTS, certLines.map(o => JSON.stringify(o)).join('\n') + (certLines.length ? '\n' : ''));
fs.writeFileSync(OUT_CERTS + '.sha256', sha256(fs.readFileSync(OUT_CERTS, 'utf8')) + '\n');

console.log(`\n已写入 ${OUT_JSON}（入库）与 ${OUT_CERTS}（${(fs.statSync(OUT_CERTS).size / 1048576).toFixed(1)}MB，gitignore）`);
console.log(`证书文件 SHA-256 见 ${OUT_CERTS}.sha256`);
console.log(`复核：node tools/verify-strategy.js ${OUT_CERTS}`);
if (fails) { console.error(`\n有 ${fails} 项核验失败`); process.exit(1); }
console.log('\n全部证书均通过规则层独立核验。');
