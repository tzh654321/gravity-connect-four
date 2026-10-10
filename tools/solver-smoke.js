'use strict';
// 仅规则/回归基础检查，不做胜率测评或批量对战。
const assert = require('node:assert/strict');
const { Position, chooseMove, gravity, createCache, threatSearch, verifyProof, pnsSearch, verifyStrategy,
  dfpnSearch, verifyRefutation, certifyRoot, chooseMoveCertified, followRefutation,
  certBoundaryStates, dedupeBoundaries, spliceRefutation, refutationLeafKinds, rotateRefutation,
  exactStateKey, CERT_LEAF_KINDS, checkRefutationInvariants, unifyRefutation, certIndex, certStateKey, RULE_VERSION,
  boardCanon, boardCanonKey, rotateEntries } = require('./solver-core');
const { loadGame } = require('./game-sandbox');
const G = loadGame(null, 'settleDiscrete,settleExact,quietNega,QFW,P1,P2,state,set occ(v){occ=v}');
const sorted = pos => [...pos.frontier].sort();
const initial = new Position();
assert.deepEqual(sorted(initial), ['-1,0', '0,-1', '0,1', '1,0']);
const before = initial.signature(1), f = sorted(initial);
const undo = initial.play({ x: 1, y: 0 }, 1);
assert(initial.frontier.has('1,1'));
initial.undo(undo);
assert.equal(initial.signature(1), before);
assert.deepEqual(sorted(initial), f);

const forced = [['0,0', 3], ['0,1', 1], ['0,2', 1], ['0,3', 1], ['-1,0', 2], ['-2,0', 2]];
const win = chooseMove(forced, 1);
assert.equal(win.status, 'proven-win');
assert.deepEqual(win.move, { x: 0, y: 4 });
const defense = chooseMove(forced, 2, { proofDepth: 0, maxDepth: 1, qDepth: 0, timeMs: 5000 });
assert.deepEqual(defense.move, { x: 0, y: 4 });
assert.equal(defense.status, 'unknown');
assert(Math.abs(defense.score) < 500000);
G.occ = new Map(forced);
// 复现旧引擎：明明能挡，旧覆盖统计却判成强制败。
assert.equal(G.quietNega(2, 1, 1, -Infinity, Infinity), -G.QFW + 5);

const fork = [['0,0', 3], ['1,0', 2], ['2,0', 1], ['3,0', 2], ['4,0', 2],
  ['1,1', 1], ['2,1', 1], ['3,1', 1]];
assert.equal(chooseMove(fork, 2).status, 'proven-loss');
const centralBlock = new Position([['0,0', 3], ['-1,0', 1], ['-2,0', 1], ['1,0', 1]]);
assert.equal(centralBlock.winning({ x: 2, y: 0 }, 1), false);

// 双威胁（活三）必胜手：无即时胜点，但一手能造出 >=2 个即时胜点且对方 0 个 → 严格必胜。
// 该局面由随机游走搜得，proofDepth=1 也能证出，说明结论来自双威胁规则而非更深搜索。
const forkPos = new Position([['0,0', 3], ['-1,0', 1], ['1,0', 2], ['0,-1', 1], ['1,1', 2], ['-2,0', 1]]);
assert(!forkPos.moves().some(p => forkPos.winning(p, 2)), '该局面本方应无即时胜点');
const forkRes = chooseMove([...forkPos.board], 2, { proofDepth: 1, maxDepth: 0, timeMs: 3000 });
assert.equal(forkRes.status, 'proven-win');
const fu = forkPos.play(forkRes.move, 2);
let mineW = 0, oppW = 0;
for (const q of forkPos.moves()) {
  if (forkPos.winning(q, 2)) mineW++;
  if (forkPos.winning(q, 1)) oppW++;
}
forkPos.undo(fu);
assert(mineW >= 2 && oppW === 0, `双威胁应满足 >=2 胜点且对方 0 个，实得 ${mineW}/${oppW}`);
// 负向对照：安静局面在 proofDepth=1 下不应被证胜。
assert.equal(chooseMove([...new Position().board], 1, { proofDepth: 1, maxDepth: 0, timeMs: 3000 }).status, 'unknown');

// 固定种子的短规则轨迹：落点集合与旧离散模型交叉核对；不是 AI 对战。
let seed = 17, pos = new Position();
for (let i = 0; i < 24; i++) {
  G.occ = new Map(pos.board);
  const simulated = new Set();
  for (let x = -30; x <= 30; x++) for (let y = -30; y <= 30; y++) {
    if (pos.at(x, y)) continue;
    const p = G.settleDiscrete(x, y);
    simulated.add(`${p.x},${p.y}`);
  }
  assert.deepEqual([...simulated].sort(), sorted(pos));
  for (const p of pos.moves()) {
    const exact = G.settleExact(p.x, p.y);
    assert.equal(`${exact.x},${exact.y}`, `${p.x},${p.y}`);
    const [dx, dy] = gravity(p.x, p.y), [rx, ry] = gravity(-p.y, p.x);
    assert.equal(rx || 0, -dy || 0); assert.equal(ry || 0, dx || 0);
  }
  const rotated = new Position([...pos.board].map(([k, o]) => {
    const [x, y] = k.split(',').map(Number); return [`${-y},${x}`, o];
  }));
  assert.equal(pos.signature(1, true), rotated.signature(1, true));
  const moves = pos.moves();
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const p = moves[seed % moves.length], side = i % 2 + 1;
  const won = pos.winning(p, side);
  pos.play(p, side);
  assert.deepEqual(sorted(pos), sorted(new Position(pos.board)));
  if (won) pos = new Position();
}
// 战术判定必须与"暴力枚举"一致（不得产生虚假证胜/证败）：
// 随机局面上用 Position 公开 API 暴力算即时胜点与双威胁，与 chooseMove(proofDepth=1) 的结论比对。
const winPts = (p, s) => { const out = []; for (const q of p.moves()) if (p.winning(q, s)) out.push(q); return out; };
const bruteFork = (p, side) => {
  for (const m of p.moves()) {
    const u = p.play(m, side);
    const mine = winPts(p, side).length, theirs = winPts(p, 3 - side).length;
    p.undo(u);
    if (mine >= 2 && theirs === 0) return m;
  }
  return null;
};
let seed2 = 4242, cur = new Position(), checked = 0;
const rnd2 = () => (seed2 = (Math.imul(seed2, 1664525) + 1013904223) >>> 0) / 4294967296;
for (let i = 0; i < 80; i++) {
  const side = (cur.board.size - 1) % 2 === 0 ? 1 : 2;
  if (!cur.winner()) {
    const mine = winPts(cur, side).length, theirs = winPts(cur, 3 - side).length;
    const fork = mine === 0 && theirs < 2 ? bruteFork(cur, side) : null;
    const got = chooseMove([...cur.board], side, { proofDepth: 1, maxDepth: 0, timeMs: 5000, forkScan: 999, threatPlies: 0, pnsNodes: 0 }).status;
    // 单向不矛盾：暴力枚举能确认的事实必须被尊重；求解器可以证得更多（更深），但不得声称假胜。
    if (mine > 0) assert.equal(got, 'proven-win', `有即时胜却未证胜（第${i}步 got=${got}）`);
    else if (theirs >= 2) assert.equal(got, 'proven-loss', `对手双杀却未证败（第${i}步 got=${got}）`);
    else if (fork) assert.equal(got, 'proven-win', `暴力发现双威胁必胜手却未证胜（第${i}步 got=${got}）`);
    else assert.notEqual(got, 'proven-win', `无胜手却声称证胜（第${i}步）`);
    checked++;
  }
  const ms = cur.moves();
  if (!ms.length || cur.winner()) { cur = new Position(); continue; }
  cur.play(ms[Math.floor(rnd2() * ms.length)], side);
}
assert(checked > 40, '暴力核对样本过少：' + checked);

// 置换表不得改变搜索结果：同一局面同一深度，"冷表"与"被浅层搜索预热过的表"必须给出相同分数。
const mid = new Position();
{
  let sd = 99;
  const rnd3 = () => (sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 8; i++) {
    const ms = mid.moves();
    if (!ms.length || mid.winner()) break;
    mid.play(ms[Math.floor(rnd3() * ms.length)], (mid.board.size - 1) % 2 === 0 ? 1 : 2);
  }
}
const deepCfg = { proofDepth: 0, maxDepth: 3, qDepth: 3, timeMs: 60000, maxNodes: 5000000 };
const cold = chooseMove([...mid.board], 1, deepCfg);
const warm = createCache();
chooseMove([...mid.board], 1, Object.assign({}, deepCfg, { maxDepth: 1, cache: warm }));
const warmRun = chooseMove([...mid.board], 1, Object.assign({}, deepCfg, { cache: warm }));
assert.equal(warmRun.score, cold.score, '置换表改变了搜索结果（冷表 vs 预热表）');
assert.equal(warmRun.completedDepth, cold.completedDepth, '置换表改变了完成深度');

const entries = [...initial.board];
const timeout = chooseMove(entries, 1, { timeMs: 0 });
assert.equal(timeout.status, 'unknown');
assert.equal(timeout.completedDepth, 0);
assert(initial.frontier.has(`${timeout.move.x},${timeout.move.y}`));
assert.deepEqual(entries, [...initial.board]);
const search = chooseMove(entries, 1, { proofDepth: 2, maxDepth: 2, timeMs: 5000 });
assert.equal(search.completedDepth, 2);
assert.equal(search.status, 'unknown');
// —— 支撑激活型双威胁的定向回归 ——
// 该局面里 P1 走 (-1,3) 后全扫描有 2 个胜点，但"只查穿落子窗口"的旧逻辑只数出 1 个：
// 另一个胜点是靠 (-1,3) 提供支撑才可落、其赢线不经过落子位置。
// 旧实现因此会漏掉这手必胜棋（且不会误判，只是漏算）。
const supportFork = [['0,0', 3], ['0,1', 1], ['0,2', 2], ['-1,2', 1], ['-2,2', 2],
  ['1,0', 1], ['-3,2', 2], ['-1,0', 1], ['2,0', 2], ['0,3', 1], ['3,0', 2]];
{
  const p = new Position(supportFork);
  const u = p.play({ x: -1, y: 3 }, 1);
  const full = winPts(p, 1).length;
  const windowOnly = (() => {
    const set = new Set();
    for (const id of p._windowIds({ x: -1, y: 3 })) {
      const w = p._winPoint(id);
      if (w && w.side === 1) { const kk = `${w.x},${w.y}`; if (p.frontier.has(kk)) set.add(kk); }
    }
    return set.size;
  })();
  p.undo(u);
  assert(full >= 2 && windowOnly < 2, `该局面应"全扫描>=2 且窗口逻辑<2"（实得 ${full}/${windowOnly}）`);
}
assert.equal(chooseMove(supportFork, 1, { proofDepth: 1, maxDepth: 0, timeMs: 5000, forkScan: 999, threatPlies: 0 }).status,
  'proven-win', '支撑激活型双威胁未被识别');

// —— 连续强制威胁搜索（P3）＋独立验证器 ——
const threatBoard = [['0,0', 3], ['0,-1', 1], ['1,0', 2], ['1,-1', 1], ['-1,0', 2], ['2,0', 1], ['3,0', 2]];
const tr = threatSearch(threatBoard, 1, { plies: 14 });
assert.equal(tr.status, 'proven-win', '连续威胁搜索未找到强杀');
assert(tr.matePlies >= 7, `强杀线应足够长（实得 ${tr.matePlies}）`);
assert(tr.proof && tr.proof.steps.length === tr.matePlies, '证明记录长度应与 matePlies 一致');
assert(verifyProof(threatBoard, tr.proof).ok, '独立验证器拒绝了搜索给出的证明');
// 负向对照 1：把某个防守步改成别处 → 防守不再被迫，必须被拒
{
  const bad = { attacker: 1, steps: tr.proof.steps.map(s => ({ ...s, move: { ...s.move } })) };
  const dIdx = bad.steps.findIndex(s => s.side !== 1);
  assert(dIdx >= 0, '证明里应有防守步');
  const legal = new Position(threatBoard).moves().find(m =>
    !(m.x === bad.steps[dIdx].move.x && m.y === bad.steps[dIdx].move.y));
  bad.steps[dIdx].move = legal;
  assert.equal(verifyProof(threatBoard, bad).ok, false, '验证器接受了被篡改的防守步');
}
// 负向对照 2：截断结尾 → 未给出终止结论，必须被拒
assert.equal(verifyProof(threatBoard, { attacker: 1, steps: tr.proof.steps.slice(0, -1) }).ok, false,
  '验证器接受了被截断的证明');
// 负向对照 3：行棋方不符（不可达棋框）→ 必须被拒。
// （这条正是实测抓到的问题：夹具用了"实际轮到另一方"的棋盘。chooseMove 不校验奇偶，
//   但独立验证器必须校验，否则证明可以建立在不存在的棋框上。）
assert.equal(verifyProof(threatBoard, { attacker: 1, steps: [{ side: 2, move: tr.proof.steps[0].move }] }).ok, false,
  '验证器未拒绝行棋方不符的记录');
// 集成：chooseMove 的 P3 通道应采用该证明，并自报已验证
{
  const r = chooseMove(threatBoard, 1, { timeMs: 4000 });
  assert.equal(r.status, 'proven-win', 'P3 通道未在 chooseMove 中生效');
  assert(r.proofVerified === true, 'P3 给出的证明未通过内建验证');
  assert(r.threat && r.threat.calls === 1, '缺少 P3 诊断信息');
}
// 未知局面不得被写成必败：空盘上威胁搜索返回未知，且 chooseMove 仍报未知
assert.equal(threatSearch([['0,0', 3]], 1).status, 'unknown', '空盘不应有连续强杀');
assert.equal(chooseMove([['0,0', 3]], 1, { timeMs: 3000 }).status, 'unknown', '把未知当成了必败');

// —— P4：PNS + 策略树验证器 ——
{
  const clone = t => JSON.parse(JSON.stringify(t));
  const firstTerminal = t => {
    let n = t, g = 0;
    while (n && !n.terminal && n.moves && n.moves.length && g++ < 400) n = n.moves[0].child;
    return n;
  };
  const firstAnd = t => {           // 找 AND 节点（对手回合、多个应手）
    let n = t, g = 0;
    while (n && !n.terminal && n.moves && n.moves.length && g++ < 400) {
      if (n.moves.length >= 2) return n;
      n = n.moves[0].child;
    }
    return null;
  };
  // 证胜 + 策略树 + 独立验证（该局面的一手双杀已在 P3 段落里测过，这里用更一般的局面）
  const andBoard = [['0,0', 3], ['0,-1', 1], ['1,0', 2], ['0,-2', 1], ['0,-3', 2], ['1,-2', 1], ['2,0', 2]];
  const d = pnsSearch(andBoard, 1, { maxNodes: 30000, timeMs: 20000 });
  assert.equal(d.status, 'proven-win', 'PNS 未证出该局面的强制胜');
  assert(d.proof && d.proof.tree, 'PNS 证胜时应给出策略树');
  const vs = verifyStrategy(andBoard, 1, d.proof.tree);
  assert(vs.ok, '独立验证器拒绝了 PNS 的策略树：' + (vs.reason || ''));
  const bad = clone(d.proof.tree);
  assert(firstAnd(bad), '该回归要求策略树里含 AND 节点');
  // 负向对照 1：AND 节点漏掉一个应手（覆盖不全）→ 必须被拒
  {
    const t = clone(d.proof.tree);
    firstAnd(t).moves.pop();
    assert.equal(verifyStrategy(andBoard, 1, t).ok, false, '验证器接受了覆盖不全的 AND 节点');
  }
  // 负向对照 2：OR 节点的走法非法 → 必须被拒
  {
    const t = clone(d.proof.tree);
    t.moves[0].move = { x: 99, y: 99 };
    assert.equal(verifyStrategy(andBoard, 1, t).ok, false, '验证器接受了非法 OR 走法');
  }
  // 负向对照 3：篡改终点 → 必须被拒
  {
    const t = clone(d.proof.tree);
    const n = firstTerminal(t);
    if (n && n.terminal && n.terminal.kind !== 'connect4') {
      n.terminal = { kind: 'connect4' };
      assert.equal(verifyStrategy(andBoard, 1, t).ok, false, '验证器接受了被篡改的终点');
    }
  }
  // 负向对照 4：攻击方标错（与落子数奇偶不符）→ 必须被拒
  assert.equal(verifyStrategy(andBoard, 2, d.proof.tree).ok, false, '验证器未拒绝攻击方标错的策略树');
  // 语义：PNS 的 'refuted' 只表示"本方无法强制获胜"，绝不能当成必败
  const dr = pnsSearch([['0,0', 3]], 1, { maxNodes: 6000, timeMs: 5000 });
  assert.notEqual(dr.status, 'proven-win', '空盘不应被证胜');
  const cm = chooseMove([['0,0', 3]], 1, { timeMs: 2000 });
  assert.notEqual(cm.status, 'proven-loss', 'PNS 的反证被误当成了必败');
  assert.notEqual(cm.status, 'proven-win', '空盘不应被证胜');
  // 集成：chooseMove 的 P4 通道应采用策略树并自报已验证
  const r4 = chooseMove(andBoard, 1, { timeMs: 8000, threatPlies: 0, pnsNodes: 8000 });
  assert.equal(r4.status, 'proven-win', 'P4 通道未在 chooseMove 中生效');
  assert(r4.proofVerified === true, 'P4 给出的策略树未通过内建验证');
  assert(r4.pns && r4.pns.calls === 1, '缺少 P4 诊断信息');
}

// —— P4 缓存语义：两种根节点分别回归（OR 根 / AND 根）——
// 混淆点：普通胜负表(solved)的键是"棋盘 + 行棋方"，值只描述**行棋方**的胜负。
// 当"实际轮到防守方、证 attacker 仍能强制获胜"时根是 AND 节点；
// 此时行棋方是**负**的一方，且**绝不能**把防守方应手写成攻击方的获胜见证。
{
  const andBoard = [['0,0', 3], ['0,-1', 1], ['1,0', 2], ['0,-2', 1], ['0,-3', 2], ['1,-2', 1], ['2,0', 2]];
  const c1 = createCache();
  const d1 = pnsSearch(andBoard, 1, { maxNodes: 40000, timeMs: 20000, cache: c1 });
  assert.equal(d1.status, 'proven-win', 'OR 根未证出');
  assert.equal(d1.rootSide, 1, 'OR 根的行棋方应等于 attacker');
  const e1 = c1.solved.get(new Position(andBoard).canonical(1).key);
  assert(e1 && e1.outcome === 1, 'OR 根应把「行棋方胜」写进普通胜负表');
  const rt1 = chooseMove(andBoard, 1, { timeMs: 3000, cache: c1, threatPlies: 0, pnsNodes: 0 });
  assert.equal(rt1.status, 'proven-win', '普通搜索未复用 OR 根写下的胜结论');
  // 缓存里的见证是**规范坐标**，消费方必须反旋转才能用；这里端到端验证反旋转正确
  assert(rt1.move && new Position(andBoard).frontier.has(`${rt1.move.x},${rt1.move.y}`),
    '复用缓存后返回的走法不在合法落点集里（旋转还原有误）');

  const lostBoard = [['0,0', 3], ['-1,0', 1], ['-1,-1', 2], ['0,1', 1], ['0,-1', 2], ['1,0', 1], ['1,-1', 2]];
  const c2 = createCache();
  const d2 = pnsSearch(lostBoard, 2, { maxNodes: 40000, timeMs: 20000, cache: c2 });
  assert.equal(d2.status, 'proven-win', 'AND 根未证出「P2 强制获胜」');
  assert.equal(d2.rootSide, 1, 'AND 根的行棋方应是防守方 P1');
  const e2 = c2.solved.get(new Position(lostBoard).canonical(1).key);
  assert(e2 && e2.outcome === -1, 'AND 根应把「行棋方负」写进普通胜负表');
  assert.equal(e2.move, null, 'AND 根不得把防守方应手当成攻击方获胜见证（缓存命题混淆）');
  assert([...c2.proofs.keys()].some(k => k.indexOf('1|2|') === 0), '固定攻击方证明表缺少 (行棋方|attacker|局面) 条目');
  const rt2 = chooseMove(lostBoard, 1, { timeMs: 3000, cache: c2, threatPlies: 0, pnsNodes: 0 });
  assert.equal(rt2.status, 'proven-loss', '普通搜索未复用 AND 根写下的必败结论');
}

assert.throws(() => new Position([['0,0', 3], ['5,5', 1]]), /未稳定/);
console.log('基础验证通过：合法点、增量撤销、立即胜/防守/双杀、双威胁必胜手、中心阻断、旋转、旧缺陷复现、预算回退。');
console.log('空棋盘搜索示例：', JSON.stringify(search));

// —— 策略树 → 证明 DAG 压缩 + DAG 核验 ——
{
  const { compressStrategy, verifyStrategyDag } = require('./solver-core');
  const andBoard2 = [['0,0', 3], ['0,-1', 1], ['1,0', 2], ['0,-2', 1], ['0,-3', 2], ['1,-2', 1], ['2,0', 2]];
  const d = pnsSearch(andBoard2, 1, { maxNodes: 40000, timeMs: 20000 });
  assert.equal(d.status, 'proven-win', 'DAG 回归的前置证明未成立');
  let treeNodes = 0;
  (function count(n) { treeNodes++; if (!n.terminal) for (const e of n.moves) count(e.child); })(d.proof.tree);
  const dag = compressStrategy(andBoard2, d.proof.tree);
  assert(dag && dag.nodes.length <= treeNodes, '压缩后节点数不应变多：' + (dag && dag.nodes.length) + ' > ' + treeNodes);
  const vd = verifyStrategyDag(andBoard2, 1, dag);
  assert(vd.ok, 'DAG 核验失败：' + (vd.reason || ''));
  // 负向对照 1：DAG 里某个 AND 节点漏掉一个应手 → 必须被拒
  const bad1 = JSON.parse(JSON.stringify(dag));
  const andIdx = bad1.nodes.findIndex(n => !n.terminal && n.moves.length >= 2);
  assert(andIdx >= 0, 'DAG 里应存在 AND 节点');
  bad1.nodes[andIdx].moves.pop();
  assert.equal(verifyStrategyDag(andBoard2, 1, bad1).ok, false, 'DAG 核验接受了覆盖不全的 AND 节点');
  // 负向对照 2：篡改根节点的行棋方 → 必须被拒
  const bad2 = JSON.parse(JSON.stringify(dag));
  bad2.nodes[bad2.root].side = 3 - bad2.nodes[bad2.root].side;
  assert.equal(verifyStrategyDag(andBoard2, 1, bad2).ok, false, 'DAG 核验接受了行棋方不符的节点');
  console.log('（DAG 压缩：树 ' + treeNodes + ' → DAG ' + dag.nodes.length +
    ' 节点，核验访问 ' + vd.nodes + '、记忆命中 ' + vd.memoHits + '）');
}

// —— df-pn：阈值递归证明搜索（必须在同一批夹具上与 PNS 结论一致） ——
{
  const { dfpnSearch } = require('./solver-core');
  const andBoard3 = [['0,0', 3], ['0,-1', 1], ['1,0', 2], ['0,-2', 1], ['0,-3', 2], ['1,-2', 1], ['2,0', 2]];
  const d = dfpnSearch(andBoard3, 1, { maxNodes: 40000, timeMs: 20000 });
  assert.equal(d.status, 'proven-win', 'df-pn 未证出该局面的强制胜');
  const vs = verifyStrategy(andBoard3, 1, d.proof.tree);
  assert(vs.ok, 'df-pn 的策略树未通过核验：' + (vs.reason || ''));
  const p = pnsSearch(andBoard3, 1, { maxNodes: 40000, timeMs: 20000 });
  assert.equal(p.status, d.status, 'df-pn 与 PNS 在同一局面上结论不一致');
  const d2 = dfpnSearch(andBoard3, 1, { maxNodes: 40000, timeMs: 20000 });
  assert.equal(d2.status, d.status, 'df-pn 重复求解结论不稳定');
  // 终点语义：预算不够时只能是 unknown，不能冒充"胜"或"对手必胜"
  const dr = dfpnSearch([['0,0', 3]], 1, { maxNodes: 3000, timeMs: 5000 });
  assert.notEqual(dr.status, 'proven-win', '空盘不应被 df-pn 证胜');
  assert.notEqual(dr.status, 'refuted', '空盘不应被判成"无法强制获胜"');
  const cnt = (function n(t) { let c = 1; if (!t.terminal) for (const e of t.moves) c += n(e.child); return c; })(d.proof.tree);
  console.log('（df-pn：' + d.nodes + ' 节点 / ' + d.expansions + ' 展开，TT 命中 ' + d.ttHits +
    '，最大深度 ' + d.maxDepth + '，策略树 ' + cnt + ' 节点）');
}

// —— P5：证据表 / 证书驱动选招 / 跟随 / 边界拼接 ——
{
  // 夹具：P2 在 y=0 有 (1,0)(2,0)(3,0) 三连，唯一胜点 (4,0)；P1 无胜点。
  // 轮到 P1：除了占 (4,0)，任何一手都让 P2 下一手连四 ⇒ 应是"6 手已被证必败 + 1 手有防守证书"。
  const blockBoard = [['0,0', 3], ['1,0', 2], ['2,0', 2], ['3,0', 2], ['1,1', 1], ['2,1', 1], ['-1,0', 1]];
  const bp = new Position(blockBoard);
  assert.equal(bp.winner(), 0, '夹具不应已连四');
  assert.equal((bp.board.size - 1) % 2, 0, '夹具应轮到 P1');
  assert.equal(bp.frontier.has('4,0'), true, '(4,0) 应是合法稳定落点');

  const ev = certifyRoot(blockBoard, 1, { horizon: 1, maxNodes: 200000, timeMs: 20000, tighten: false });
  const doomed = ev.moves.filter(r => r.opponentWin), surv = ev.moves.filter(r => r.survival);
  assert.equal(ev.origin, 'after-move', '证据表的距离起点应是"走完该手后的局面"');
  assert.equal(surv.length, 1, `应恰好 1 手有防守证书（实得 ${surv.length}）`);
  assert.equal(surv[0].move.x, 4, '有防守证书的应是封堵手 (4,0)');
  assert.equal(surv[0].move.y, 0, '有防守证书的应是封堵手 (4,0)');
  assert(doomed.length >= 5, `其余合法走法应被证必败（实得 ${doomed.length}）`);
  for (const r of doomed) assert.equal(r.ownWin, null, '未知/必败的候选不得被填成自己的胜证');

  // 证书驱动选招：必须挑到有防守证书的那一手，而不是任何被证必败的手
  const dec = chooseMoveCertified(blockBoard, 1, { horizon: 1, fallback: false });
  assert.equal(dec.tier, 'survival', `应走 survival 档（实得 ${dec.tier}）`);
  assert.equal(dec.move.x, 4, '选招必须避开被证必败的走法');
  assert.equal(dec.move.y, 0, '选招必须避开被证必败的走法');

  // —— 反证证书：跟着走 + 终点纯度 + 边界导出 + 拼接 ——
  const tiny = [['0,0', 3], ['0,1', 1], ['0,2', 2]];
  const b2 = dfpnSearch(tiny, 2, { maxPlies: 2, maxNodes: 200000, timeMs: 20000 });
  assert.equal(b2.status, 'refuted', '小局面在 N=2 内应被穷尽否定');
  assert(b2.proof && b2.proof.root, '反证证书应自包含根局面（root）');

  const kinds = refutationLeafKinds(b2.proof);
  assert(!kinds['ply-shortfall'], '对外证书不得含搜索内部标记 ply-shortfall');
  for (const k of Object.keys(kinds)) assert(CERT_LEAF_KINDS.includes(k), `证书出现非白名单终点：${k}`);

  const vLib = verifyRefutation(tiny, 2, b2.proof);
  assert(vLib.ok, '库内核验应通过：' + (vLib.reason || ''));
  const ruleLayer = require('./verify-strategy');
  assert(ruleLayer.verifyRefutation(tiny, 2, b2.proof).ok, '规则层独立核验应通过');

  // 乱改终点种类 ⇒ 必须被拒（ply-shortfall / 未知种类都不得被接受）
  {
    const clone = JSON.parse(JSON.stringify(b2.proof));
    const flip = n => { if (n.terminal) { n.terminal = { kind: 'ply-shortfall' }; return true; } for (const e of n.moves) if (flip(e.child)) return true; return false; };
    assert(flip(clone.tree), '夹具应存在可篡改的叶子');
    assert.equal(verifyRefutation(tiny, 2, clone).ok, false, '核验器接受了 ply-shortfall 叶子');
  }

  // 跟随器：根节点是防守方 ⇒ 应给出见证；偏离证书 ⇒ 立即失效
  const fRoot = followRefutation(b2.proof, tiny);
  assert.equal(fRoot.status, 'defend', `根应是防守方回合（实得 ${fRoot.status}）`);
  assert(fRoot.witness, '防守节点应给出见证走法');
  assert.equal(fRoot.remaining, 2, '根节点剩余半回合应等于 maxPlies');
  {
    const p = new Position(tiny);
    const alt = p.moves().find(m => !(m.x === fRoot.witness.x && m.y === fRoot.witness.y));
    assert(alt, '夹具应有非见证的合法走法');
    const u = p.play(alt, 1);
    const deviated = [...p.board]; p.undo(u);
    assert.equal(followRefutation(b2.proof, deviated).status, 'off-certificate', '偏离证书后必须立刻失效');
  }

  // 边界：全部 depth-limit 叶子；去重；拼接（全部边界续 1 半回合）
  const bnd = certBoundaryStates(b2.proof);
  assert(bnd.length > 0, '应存在未终局边界');
  const dedup = dedupeBoundaries(bnd, true);
  assert(dedup.length <= bnd.length, '去重后不应变多');
  const parts = new Map();
  for (const b of dedup) {
    const r = dfpnSearch(b.board, 2, { maxPlies: 1, maxNodes: 100000, timeMs: 10000 });
    assert.equal(r.status, 'refuted', '边界在 N=1 上应被穷尽否定');
    parts.set(exactStateKey(b.board, b.side), r.proof);
  }
  const spliced = spliceRefutation(b2.proof, parts, 1);
  assert(spliced, '全部边界都有续证时应能拼接');
  assert.equal(spliced.maxPlies, 3, '拼接后 maxPlies 应为 N+addPlies');
  assert(verifyRefutation(tiny, 2, spliced).ok, '拼接结果库内核验应通过');
  assert(ruleLayer.verifyRefutation(tiny, 2, spliced).ok, '拼接结果规则层核验应通过');
  assert.equal(spliceRefutation(b2.proof, new Map(), 1), null, '缺任一续证时不得拼接');
  assert.equal(spliceRefutation(JSON.parse(JSON.stringify(b2.proof)), parts, 2), null, 'addPlies 与续证上限不符时不得拼接');

  // 四旋转：核验必须照样通过
  for (let r = 1; r <= 3; r++) {
    const rr = rotateRefutation(b2.proof, r);
    const vr = verifyRefutation(rr.root, 2, rr);
    assert(vr.ok, `旋转 ${r}×90° 后核验应通过：` + (vr.reason || ''));
  }

  console.log('（P5：证据表/证书选招/跟随/边界拼接/终点纯度/四旋转 全部通过）');
}

// —— P6：语义收口（必要条件 / 完整命题键 / 统一见证 / 索引 / 非互斥证据） ——
{
  const fs2 = require('fs'), path2 = require('path');
  const ruleLayer6 = require('./verify-strategy');
  const tinyP6 = [['0,0', 3], ['0,1', 1], ['0,2', 2]];
  const c6 = dfpnSearch(tinyP6, 2, { maxPlies: 2, maxNodes: 200000, timeMs: 20000 });
  assert.equal(c6.status, 'refuted', 'P6 前置：小局面应 refuted');

  // 必要条件：按正确口径（未终局 / 轮到攻击方 / 剩余≥1）筛选后，攻击方即时胜点必须为 0
  const inv = checkRefutationInvariants(c6.proof, tinyP6);
  assert.equal(inv.violations.length, 0, '必要条件被违反（攻击方在见证后仍有即时胜点）');
  assert.equal(inv.checked + inv.skippedTerminal + inv.skippedNoPlies, inv.defenderNodes,
    '筛选口径不闭合：跳过原因应只有「已终局」与「半回合用尽」两类');

  // 完整命题键：规则版本 + 棋盘 + 行棋方 + 攻击方 + 剩余保证
  const k1 = certStateKey(tinyP6, 1, 2, 2, RULE_VERSION);
  assert.notEqual(k1, certStateKey(tinyP6, 1, 2, 1, RULE_VERSION), '不同剩余保证必须是不同命题键');
  assert.equal(k1.split('|')[0], RULE_VERSION, '命题键必须带规则版本');

  // 统一见证 ⇒ 确定性策略，且两套核验仍然通过
  const uni = unifyRefutation(c6.proof, tinyP6);
  assert(uni && uni.ref, '统一见证失败');
  assert.equal(checkRefutationInvariants(uni.ref, tinyP6).multiWitness.length, 0, '统一后仍存在多种见证');
  assert(verifyRefutation(tinyP6, 2, uni.ref).ok, '统一后库内核验失败');
  assert(ruleLayer6.verifyRefutation(tinyP6, 2, uni.ref).ok, '统一后规则层核验失败');

  // 证书索引：命中给见证、剩余不符给 miss
  const idx6 = certIndex(uni.ref, tinyP6);
  assert(idx6.byExact.size > 0, '索引为空');
  const rootSide6 = 1;
  const atRoot = idx6.at(tinyP6, rootSide6, uni.ref.maxPlies);
  assert.equal(atRoot.status, 'defend', '根状态应给出见证');
  assert.equal(atRoot.witness.x, uni.ref.tree.moves[0].move.x, '索引见证应与证书一致');
  assert.equal(idx6.at(tinyP6, rootSide6, uni.ref.maxPlies + 5).status, 'miss', '错误的剩余保证必须 miss');

  // 证据表：允许同一候选**同时**有有限防守保证与更长的强制败证据（字段非互斥）
  const ply = JSON.parse(fs2.readFileSync(path2.join(__dirname, 'fixtures', 'bounded-ply4.json'), 'utf8'));
  const ev2 = certifyRoot(ply.board, ply.sideToMove,
    { horizon: 4, deepHorizon: 7, maxNodes: 200000, timeMs: 30000, tighten: false, probeSelf: false });
  const both = ev2.moves.filter(r => r.survival && r.opponentWinDeeper);
  assert(both.length > 0, '应存在「防得住 h、但更长的 d 内必败」的候选（两字段非互斥）');
  assert(ev2.moves.every(r => !(r.opponentWin && r.survival)), '同一 horizon 上 survival 与 opponentWin 不应同时为真');
  console.log('（P6：必要条件 / 完整命题键 / 统一见证 / 证书索引 / 非互斥证据 全部通过；非互斥候选 ' + both.length + ' 个）');
}

// —— P7：旋转规范键（根局面查询用） ——
{
  const p7fx = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'bounded-ply4.json'), 'utf8'));
  const b7 = p7fx.board;
  const c0 = boardCanon(b7);
  assert.equal(c0.key.slice(0, 0), '', 'sanity');
  for (let r = 1; r <= 3; r++) {
    const rb = rotateEntries(b7, r);
    const c = boardCanon(rb);
    assert.equal(c.key, c0.key, `旋转 ${r}×90° 后四旋转规范键必须相同`);
    assert.equal(((c0.rot - c.rot) % 4 + 4) % 4, r,
      `旋转 ${r}×90° 的坐标还原次数应为 ${r}（实得 ${((c0.rot - c.rot) % 4 + 4) % 4}）`);
  }
  assert.equal(boardCanonKey(rotateEntries(b7, 2)), boardCanonKey(b7),
    'boardCanonKey 必须在四旋转下不变');
  // 镜像**不是**等价：本游戏左/右重力区不对称，x 取反后不应与旋转等价
  const mir = b7.map(([k, o]) => {
    const i = k.indexOf(',');
    return [(-Number(k.slice(0, i))) + ',' + k.slice(i + 1), o];
  });
  assert.notEqual(boardCanonKey(mir), c0.key, '镜像不应被当作旋转等价（左/右重力区并不对称）');
  console.log('（P7：四旋转规范键不变 + 还原次数正确 + 镜像不等价 全部通过）');
}
