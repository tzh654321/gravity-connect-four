'use strict';
/* ============================================================
   check-verify-fast —— 快速核验器 × 慢速参考核验器 的逐项交叉核对

   A. 全夹具一致性：对每条夹具同时跑**参考核验器**与**快速核验器**，比较
        ok / reason（逐字）/ 出错节点路径（逐项）/ 节点计数（nodes, andNodes,
        attackerNodes, leaves, memoHits, plies, terminal）。
      比较的不只是 ok，还包括**失败原因类别与出错节点路径**。

   B. 增量结构审计：按节点断言快速核验器的增量结构 === rules-ref 的全量重建
        B1 avail（去重升序）=== rules-ref.legalMoves(occ)
        B2 增量连四 === rules-ref.winner(occ)；sideToMove 同口径
        B3 winPointsScan（含 limit 截断）=== rules-ref.winPoints 的前 limit 项
           （B3 用固定种子的随机轨迹单独验，不挂在遍历上）

   C. 负向对照（8 项）：篡改后的证书必须**两类核验器都拒绝**，且给出
        **同一个**失败原因与**同一条**出错节点路径：
        1 漏掉一个 AND 应手          2 修改一个 OR 走法
        3 篡改一个终点                4 篡改攻击方
        5 越过剩余半回合限制          6 把 depth-limit 改成真实连四
        7 旋转后的证书坐标错误        8 非法或不稳定落点

   用法：
     node tools/check-verify-fast.js            # 全量（含两份 N=16 大证书）
     node tools/check-verify-fast.js --quick    # 跳过 >1MB 的大证书（迭代用）
   ============================================================ */
const fs = require('fs');
const path = require('path');
const R = require('./rules-ref');
const VS = require('./verify-strategy');
const F = require('./verify-strategy-fast');
const CORE = require('./solver-core');

const QUICK = process.argv.includes('--quick');
const BIG = 1024 * 1024;

let failures = 0;
const fail = msg => { failures++; console.log(`  ✗ ${msg}`); };

/* ------------------------------------------------------- 夹具装载与派发 */

function loadRecords(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function kindOf(rec) {
  if (rec.refutation) return 'refutation';
  if (rec.seq) return 'seq';
  if (rec.dag) return 'dag';
  if (rec.tree) return 'tree';
  return '?';
}

/** 派发规则与 `verify-strategy.js` 的 CLI 完全一致 */
function run(rec, fast, opts) {
  const k = kindOf(rec);
  const b = rec.board, a = rec.attacker;
  if (fast) {
    return k === 'refutation' ? F.verifyRefutationFast(b, a, rec.refutation, opts)
      : k === 'seq' ? F.verifySeqFast(b, rec.seq, opts)
        : k === 'dag' ? F.verifyDagFast(b, a, rec.dag, opts)
          : F.verifyFast(b, a, rec.tree, opts);
  }
  return k === 'refutation' ? VS.verifyRefutation(b, a, rec.refutation)
    : k === 'seq' ? VS.verifySeq(b, rec.seq)
      : k === 'dag' ? VS.verifyDag(b, a, rec.dag)
        : VS.verify(b, a, rec.tree);
}

const numKeys = ['nodes', 'andNodes', 'attackerNodes', 'leaves', 'memoHits', 'plies', 'dagNodes'];
function diff(a, b) {
  const d = [];
  if (a.ok !== b.ok) d.push(`ok ${a.ok} vs ${b.ok}`);
  if (a.reason !== b.reason) d.push(`reason「${a.reason}」vs「${b.reason}」`);
  const pa = (a.path || []).join(' > '), pb = (b.path || []).join(' > ');
  if (pa !== pb) d.push(`path「${pa}」vs「${pb}」`);
  for (const k of numKeys) if ((a[k] || 0) !== (b[k] || 0)) d.push(`${k} ${a[k]} vs ${b[k]}`);
  if (a.terminal !== b.terminal) d.push(`terminal ${a.terminal} vs ${b.terminal}`);
  return d;
}

/* ============================================================ A. 全夹具一致性 */

const FILES = [
  path.join(__dirname, 'fixtures', 'bounded-ply4-certs.jsonl'),
  path.join(__dirname, 'fixtures', 'proofs-fixtures.jsonl'),
  path.join(__dirname, 'fixtures', 'proof-loss-ply6.jsonl'),
  path.join(__dirname, 'proofs-fixtures.jsonl'),
  path.join(__dirname, 'proofs-losses.jsonl'),
];

console.log('=== A. 全夹具一致性（参考核验器 × 快速核验器）===');
let aTotal = 0, aOk = 0;
for (const file of FILES) {
  if (!fs.existsSync(file)) { console.log(`  （跳过，不存在）${path.relative(process.cwd(), file)}`); continue; }
  const recs = loadRecords(file);
  const rel = path.relative(process.cwd(), file);
  console.log(`\n  ${rel}（${recs.length} 条）`);
  recs.forEach((rec, i) => {
    const isBig = JSON.stringify(rec).length > BIG;
    if (QUICK && isBig) { console.log(`    #${i} ${kindOf(rec)}  跳过（--quick，>1MB）`); return; }
    const mv = rec.move ? ` 走(${rec.move.x},${rec.move.y})` : '';
    const tag = `${rec.game}${rec.ply == null ? '' : '@ply' + rec.ply}${mv}`.padEnd(30) + kindOf(rec).padEnd(11);
    const t0 = Date.now();
    const rRef = run(rec, false);
    const t1 = Date.now();
    const rFast = run(rec, true);
    const t2 = Date.now();
    aTotal++;
    const d = diff(rRef, rFast);
    const verdict = d.length ? '✗ 不一致' : (rRef.ok ? '✓ 双双通过' : '✓ 双双拒绝');
    if (rRef.ok) aOk++;
    console.log(`    ${tag}${String(rRef.nodes || 0).padStart(7)} 节点  参考 ${String(t1 - t0).padStart(5)}ms  ` +
      `快速 ${String(t2 - t1).padStart(4)}ms  ${verdict}` +
      (d.length ? `\n        ${d.join('\n        ')}` : '') +
      (!rRef.ok && !d.length ? `\n        共同原因：${rRef.reason}` : ''));
    if (d.length) fail(`${rel} #${i} 两类核验器结果不一致`);
  });
}
console.log(`\n  小结：${aTotal} 条中参考核验器通过 ${aOk} 条；两类核验器逐项一致 ${failures ? '否' : '是'}`);

/* ======================================================= B1/B2. 增量结构审计 */

console.log('\n=== B1/B2. 增量结构审计（逐节点对比全量重建）===');
{
  let audited = 0, checked = 0, mismatch = 0;
  const audit = (b, ctx) => {
    audited++;
    const ref = R.legalMoves(b.occ);
    const got = b.legalSorted();
    const s1 = got.map(m => `${m.x},${m.y}`).join(' ');
    const s2 = ref.map(m => `${m.x},${m.y}`).join(' ');
    if (s1 !== s2) { mismatch++; if (mismatch <= 3) fail(`avail ≠ legalMoves @${s1} vs ${s2}`); }
    // 增量连四必须等于全量重算（父节点已确认无胜负 ⇒ 新胜只能来自新落子）
    let wRef;
    try { wRef = R.winner(b.occ); } catch (e) { wRef = 'throw:' + e.message; }
    if (wRef !== ctx.w) {
      mismatch++;
      if (mismatch <= 3) fail(`增量连四 ${ctx.w} ≠ 全量 ${wRef}（kind=${ctx.kind} px=${ctx.px},${ctx.py}）`);
    }
    // 行棋方同口径
    if (b.sideToMove() !== R.sideToMove(b.occ)) { mismatch++; if (mismatch <= 3) fail('sideToMove 口径不一致'); }
    checked += 3;
  };
  for (const file of FILES) {
    if (!fs.existsSync(file)) continue;
    for (const rec of loadRecords(file)) {
      if (QUICK && JSON.stringify(rec).length > BIG) continue;
      run(rec, true, { audit });
    }
  }
  console.log(`  审计节点 ${audited} 个、断言 ${checked} 条，不一致 ${mismatch} 条`);
  if (mismatch) fail(`${mismatch} 条增量结构断言不成立`);
}

/* ============================================= B3. winPointsScan 单元一致性 */
{
  console.log('\n=== B3. winPointsScan × rules-ref.winPoints（固定种子随机轨迹）===');
  let seed = 20261011;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  let steps = 0, bad = 0;
  for (let game = 0; game < 40; game++) {
    let entries = [['0,0', 3]];
    let b = new F.FastBoard(entries);
    for (let ply = 0; ply < 40 && b.avail.size; ply++) {
      for (const side of [1, 2]) {
        const a = b.winPointsScan(side, null).map(m => `${m.x},${m.y}`).join(' ');
        const r = R.winPoints(b.occ, side).map(m => `${m.x},${m.y}`).join(' ');
        if (a !== r) { bad++; if (bad <= 3) fail(`winPoints 集合/顺序不一致「${a}」vs「${r}」`); }
        const a1 = b.winPointsScan(side, 1).length, r1 = Math.min(1, R.winPoints(b.occ, side).length);
        const a2 = b.winPointsScan(side, 2).length, r2 = Math.min(2, R.winPoints(b.occ, side).length);
        if (a1 !== r1 || a2 !== r2) { bad++; if (bad <= 3) fail('winPointsScan limit 截断不一致'); }
      }
      const legal = b.legalSorted();
      const m = legal[Math.floor(rnd() * legal.length)];
      b.place(m.x, m.y, b.sideToMove());
      steps++;
    }
  }
  console.log(`  随机轨迹 ${steps} 步、${steps * 8} 条断言，不一致 ${bad} 条`);
  if (bad) fail(`${bad} 条 winPoints 一致性断言不成立`);
}

/* ============================================================ C. 负向对照 */

console.log('\n=== C. 负向对照（两类核验器都必须拒绝，且原因+路径一致）===');

/** 用 rules-ref 重放路径，找到第一个满足 pred 的节点 */
function findNode(entries, attacker, tree, pred) {
  const b = R.fromEntries(entries);
  const p = [];
  let found = null;
  (function walk(node, board) {
    if (found) return;
    const side = R.sideToMove(board);
    if (pred(node, board, side, p)) { found = { node, board, side, path: p.slice() }; return; }
    for (const e of (node.moves || [])) {
      const nb = R.cloneBoard(board);
      if (!R.play(nb, e.move, side)) continue;
      p.push(e.move); walk(e.child, nb); p.pop();
      if (found) return;
    }
  })(tree, b);
  return found;
}

/** 按 move 序列取到该节点本身（path 为空即根节点） */
function nodeAt(tree, p) {
  let n = tree;
  for (const m of p) {
    const e = (n.moves || []).find(q => q.move.x === m.x && q.move.y === m.y);
    if (!e) return null;
    n = e.child;
  }
  return n;
}

/** 收集一棵树里出现的终点类型 */
function terminalKinds(tree) {
  const s = new Set();
  (function go(n) {
    if (n.terminal) s.add(n.terminal.kind);
    for (const e of (n.moves || [])) go(e.child);
  })(tree);
  return [...s];
}

function clone(x) { return JSON.parse(JSON.stringify(x)); }

const boundedRecs = loadRecords(FILES[0]);
const winRec = boundedRecs.find(r => r.tree && r.tree.moves && r.tree.moves.length);
/* 负向对照用**最小的**那份反证证书（改坏后用最快的路径暴露差异；大证书不参与构造） */
const refRec = boundedRecs.filter(r => r.refutation)
  .map(r => ({ r, n: Buffer.byteLength(JSON.stringify(r)) }))
  .sort((a, b) => a.n - b.n)[0].r;

function negTest(label, rec, expectReject, note) {
  const rRef = run(rec, false);
  const rFast = run(rec, true);
  const d = diff(rRef, rFast);
  const bothReject = !rRef.ok && !rFast.ok;
  const verdict = d.length ? '✗ 两类结果不一致' : (!bothReject ? '✗ 未被拒绝' : '✓ 双双拒绝且一致');
  console.log(`  ${label.padEnd(34)}${verdict}` +
    (d.length ? `\n        ${d.join('\n        ')}` : '') +
    (d.length ? '' : `\n        共同原因：${rRef.reason}\n        出错路径：${(rRef.path || []).join(' > ') || '（根）'}`) +
    (note ? `\n        注：${note}` : ''));
  if (d.length) fail(`${label}：两类核验器不一致`);
  else if (expectReject && !bothReject) fail(`${label}：未被拒绝`);
}

/* 1. 漏掉一个 AND 应手 */
{
  const rec = clone(winRec);
  const hit = findNode(rec.board, rec.attacker, rec.tree,
    (n, b, side) => !n.terminal && side !== rec.attacker && (n.moves || []).length > 1);
  if (!hit) fail('负向 1：夹具里找不到 >1 步的 AND 节点');
  else {
    nodeAt(rec.tree, hit.path).moves.pop();
    negTest('1 漏掉一个 AND 应手', rec, true);
  }
}

/* 2. 修改一个 OR 走法（换成另一个合法落点 ⇒ 落点合法，下游结论不再成立） */
{
  const rec = clone(winRec);
  const hit = findNode(rec.board, rec.attacker, rec.tree,
    (n, b, side, p) => !n.terminal && side === rec.attacker && p.length >= 2);
  if (!hit) fail('负向 2：夹具里找不到深层 OR 节点');
  else {
    const target = nodeAt(rec.tree, hit.path);
    const alt = R.legalMoves(hit.board)
      .filter(m => !(m.x === target.moves[0].move.x && m.y === target.moves[0].move.y))[0];
    target.moves[0].move = alt;
    negTest(`2 修改一个 OR 走法 → (${alt.x},${alt.y})`, rec, true,
      '换成**另一个合法落点**：落点本身合法，靠下游终点/覆盖检查兜住');
  }
}

/* 3. 篡改一个终点 */
{
  const rec = clone(winRec);
  const hit = findNode(rec.board, rec.attacker, rec.tree, n => !!n.terminal);
  if (!hit) fail('负向 3：夹具里找不到终点叶子');
  else {
    const kinds = terminalKinds(winRec.tree);
    const target = nodeAt(rec.tree, hit.path);
    const orig = target.terminal.kind;
    target.terminal.kind = '未知终点测试串';
    negTest(`3 篡改一个终点（${orig} → 未知类型）`, rec, true,
      `该夹具出现的终点类型：${kinds.join(' / ')}`);
  }
  const rec2 = clone(winRec);
  const hit2 = findNode(rec2.board, rec2.attacker, rec2.tree, n => n.terminal && n.terminal.kind === 'immediate-win');
  if (!hit2) console.log('  3b 篡改 immediate-win 指向的格            （夹具里没有 immediate-win 叶子，跳过）');
  else {
    nodeAt(rec2.tree, hit2.path).terminal.at = { x: 999, y: 999 };
    negTest('3b 篡改 immediate-win 指向的格', rec2, true);
  }
}

/* 4. 篡改攻击方 */
{
  const rec = clone(winRec);
  rec.attacker = 3 - winRec.attacker;
  negTest(`4a 篡改攻击方 P${winRec.attacker} → P${rec.attacker}`, rec, true);
  const rec2 = clone(winRec);
  rec2.attacker = 3;
  negTest('4b 攻击方改成非法值 3', rec2, true);
  const rec3 = clone(refRec);
  rec3.attacker = 3 - refRec.attacker;
  negTest(`4c 反证证书篡改攻击方 P${refRec.attacker} → P${rec3.attacker}`, rec3, true);
}

/* 5. 越过剩余半回合限制 */
{
  const rec = clone(refRec);
  rec.refutation.maxPlies = refRec.refutation.maxPlies + 4;
  negTest('5a 半回合上限放大 +4', rec, true, 'depth-limit 叶子出现在还有 4 半回合时');
  const rec2 = clone(refRec);
  rec2.refutation.maxPlies = 3;
  negTest('5b 半回合上限压到 3', rec2, true, '展开越过上限（半回合用尽却不是 depth-limit）');
  const rec3 = clone(refRec);
  rec3.refutation.maxPlies = 0;
  negTest('5c 半回合上限改成 0', rec3, true);
}

/* 6. 把 depth-limit 改成真实连四 */
{
  const rec = clone(refRec);
  const hit = findNode(rec.board, rec.attacker, rec.refutation.tree,
    n => n.terminal && n.terminal.kind === 'depth-limit');
  if (!hit) fail('负向 6：反证证书里找不到 depth-limit 叶子');
  else {
    nodeAt(rec.refutation.tree, hit.path).terminal = { kind: 'connect4' };
    negTest('6 depth-limit 改成真实连四', rec, true);
  }
}

/* 7. 旋转后的证书坐标错误 */
{
  const ROT = 1;
  const recRot = clone(winRec);
  recRot.board = CORE.rotateEntries(winRec.board, ROT);
  recRot.tree = CORE.rotateTree(winRec.tree, ROT);
  const rRef = run(recRot, false), rFast = run(recRot, true);
  const d = diff(rRef, rFast);
  console.log(`  7a 整份证书（棋盘+树）同步旋转 90°     ` +
    (d.length ? '✗ 两类结果不一致' : (rRef.ok && rFast.ok ? '✓ 双双通过（旋转等价）' : '✓ 双双拒绝且一致')) +
    (rRef.ok ? '' : `\n        原因：${rRef.reason}`));
  if (d.length) fail('负向 7a：旋转等价性两类核验器不一致');
  if (!rRef.ok) fail(`负向 7a：整份同步旋转本应仍然通过，却拒绝了（${rRef.reason}）`);

  const recBad = clone(winRec);           // 只旋转棋盘，**不**旋转证书 ⇒ 坐标错位
  recBad.board = CORE.rotateEntries(winRec.board, ROT);
  negTest('7b 只旋转棋盘、证书坐标不动', recBad, true,
    '证书坐标与旋转后棋盘不匹配 ⇒ 落点非法或覆盖不全');

  const recBad2 = clone(winRec);          // 只旋转证书，**不**旋转棋盘
  recBad2.tree = CORE.rotateTree(winRec.tree, ROT);
  negTest('7c 只旋转证书、棋盘不动', recBad2, true);
}

/* 8. 非法或不稳定落点 */
{
  const rec = clone(winRec);
  const hit = findNode(rec.board, rec.attacker, rec.tree,
    (n, b, side, p) => !n.terminal && side === rec.attacker && p.length >= 1);
  if (!hit) fail('负向 8a：找不到可改的 OR 节点');
  else {
    nodeAt(rec.tree, hit.path).moves[0].move = { x: 40, y: 40 };  // 悬空格：周围无子、下方无支撑
    negTest('8a OR 步改成悬空不稳定落点 (40,40)', rec, true);
  }
  const rec2 = clone(winRec);
  const hit2 = findNode(rec2.board, rec2.attacker, rec2.tree,
    (n, b, side, p) => !n.terminal && side === rec2.attacker && p.length >= 1);
  if (!hit2) fail('负向 8b：找不到可改的 OR 节点');
  else {
    const k = [...hit2.board.keys()].find(kk => R.at(hit2.board, ...kk.split(',').map(Number)) !== 3);
    const [ox, oy] = k.split(',').map(Number);
    nodeAt(rec2.tree, hit2.path).moves[0].move = { x: ox, y: oy };  // 已被占据的格
    negTest(`8b OR 步改成已被占据的格 (${ox},${oy})`, rec2, true);
  }
  const rec3 = clone(refRec);
  const hit3 = findNode(rec3.board, rec3.attacker, rec3.refutation.tree,
    (n, b, side) => !n.terminal && side !== rec3.attacker && (n.moves || []).length === 1);
  if (!hit3) console.log('  8c 反证证书防守见证改成悬空格          （找不到，跳过）');
  else {
    nodeAt(rec3.refutation.tree, hit3.path).moves[0].move = { x: 40, y: 40 };
    negTest('8c 反证证书防守见证改成悬空格', rec3, true);
  }
}

/* ------------------------------------------------------------------ 收尾 */

console.log(`\n${failures ? '✗ 失败' : '✓ 全部通过'}：共 ${failures} 项不一致。`);
console.log('说明：快速核验器只改实现方式；**参考核验器（rules-ref + verify-strategy）继续保留**，');
console.log('      关键夹具与发布前回归仍双跑。');
process.exit(failures ? 1 : 0);
