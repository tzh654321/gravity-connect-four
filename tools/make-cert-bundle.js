'use strict';
/* ============================================================
   make-cert-bundle —— 离线生成"可嵌入页面"的证书包（P6）

   目标：把**已验证**的证据与跟随证书，编译成页面能 O(1) 查询的小数据结构，
   而不是把十几万节点的证书塞进实时核心。

   一个 bundle 条目 = 一个"根局面"（当前行棋方要落子的局面）：
     {
       id, rootKey（boardKey 字符串）, sideToMove,
       verdictHorizon,           // 判定表用的 horizon（≤ 这个步数内"能否被强制击败"）
       moves: [{x,y,verdict:'ownWin'|'survival'|'doomed'|'unknown', withinPlies|horizon,
                basis:'bound'|'exact'}],
       decision: {move, tier, basis, reason},        // 离线按同一套策略规则算出的选择
       follows: [{ move, attacker, horizon, rootKey, rows }]
     }
   `rows` 是跟随证书索引的紧凑形式：`[added, side, wx, wy, termIdx]`
     - `added`  = 相对 follow 根的**新增棋子**（排序后 `;` 连接）—— 用新增集合而不是整盘，
                  因为 N 步内新增 ≤ N 个，编码短得多；
     - `side`   = 该状态的行棋方；`remaining` = horizon − 新增数（页面自行推导）；
     - `wx,wy`  = 我方（防守方）的见证走法；攻击方回合则为 null；
     - `termIdx`= 0 非终点 / 1 depth-limit / 2 connect4 / 3 defender-win。
   生成时**必须做往返校验**：把 rows 解码回索引，逐状态与核心 `certIndex` 比对（见证与终点种类都一致）。

   用法：
     node tools/make-cert-bundle.js                 # 用 tools/fixtures/bounded-ply4.json
     node tools/make-cert-bundle.js --verdictHorizon 13 --followHorizon 6
     node tools/make-cert-bundle.js --records tools/bench-games-lean.jsonl --game "hard|P1#7" --ply 4
   ============================================================ */
const fs = require('fs');
const path = require('path');
const {
  Position, dfpnSearch, verifyRefutation, unifyRefutation, certIndex, certStateKey,
  certifyRoot, chooseMoveCertified, winPointsAll, RULE_VERSION, boardCanon, createBoundCache
} = require('./solver-core');
const ruleLayer = require('./verify-strategy');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

const TERM_IDX = { none: 0, 'depth-limit': 1, connect4: 2, 'defender-win': 3 };
const IDX_TERM = ['none', 'depth-limit', 'connect4', 'defender-win'];
const boardKeyOf = occ => [...occ].map(([k, o]) => `${k}:${o}`).sort().join(';');

let fails = 0;
const bad = m => { fails++; console.error('  ✗ ' + m); };
const ok = m => console.log('  ✓ ' + m);

function boardFromRecords(recPath, game, ply) {
  const lines = fs.readFileSync(recPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const g = game ? lines.find(x => x.game === game) : lines[0];
  if (!g) throw new Error('未找到对局：' + game);
  const pos = new Position(g.start);
  const boards = [];
  for (const r of g.record) { boards[r.ply] = [...pos.board]; pos.play(r.move, r.side); }
  return { board: boards[ply], id: `${g.game}@ply${ply}` };
}

/* 把 certIndex 编译成 rows，并**往返校验** */
function encodeFollow(ref, childBoard, move, horizon) {
  const idx = certIndex(ref, childBoard);
  const rootMap = new Map(childBoard);
  const rootKey = boardKeyOf(rootMap);
  const rows = [];
  for (const [k, rec] of idx.byExact) {
    // 解析键：rv|side|attacker|remaining|boardString
    const parts = k.split('|');
    const side = Number(parts[1]), attacker = Number(parts[2]), remaining = Number(parts[3]);
    const boardStr = parts.slice(4).join('|');
    const cells = boardStr ? boardStr.split(';') : [];
    const added = [];
    for (const c of cells) {
      const i = c.lastIndexOf(':');
      const coord = c.slice(0, i);
      if (!rootMap.has(coord)) added.push(c);
    }
    added.sort();
    rows.push([added.join(';'), side, rec.witness ? rec.witness.x : null,
      rec.witness ? rec.witness.y : null, TERM_IDX[rec.terminal] || 0]);
  }
  // —— 往返校验：把 rows 解码回索引，逐项与核心比对 ——
  const decode = new Map();
  for (const [a, side, wx, wy, t] of rows) decode.set(a, { side, wx, wy, t });
  if (decode.size !== idx.byExact.size) bad(`rows 去重后 ${decode.size} ≠ 核心索引 ${idx.byExact.size}`);
  let checked = 0;
  for (const [a, v] of decode) {
    // 由 added 重建绝对棋盘
    const cells = a ? a.split(';') : [];
    const occ = new Map(rootMap);
    for (const c of cells) { const i = c.lastIndexOf(':'); occ.set(c.slice(0, i), Number(c.slice(i + 1))); }
    const depth = cells.length;
    const rem = horizon - depth;
    if (rem < 0) { bad('rows 里出现超出 horizon 的状态'); break; }
    const key = certStateKey([...occ], v.side, idx.attacker, rem, RULE_VERSION);
    const orig = idx.byExact.get(key);
    if (!orig) { bad('往返校验：重建键在核心索引里找不到'); break; }
    if ((orig.witness ? orig.witness.x : null) !== v.wx || (orig.witness ? orig.witness.y : null) !== v.wy) {
      bad('往返校验：见证不一致'); break;
    }
    if ((TERM_IDX[orig.terminal] || 0) !== v.t) { bad('往返校验：终点种类不一致'); break; }
    checked++;
  }
  if (checked === decode.size) ok(`往返校验 ${checked} 条状态全部一致（见证/终点种类）`);
  return { rootKey, rows, uniqueStates: idx.byExact.size };
}

/* 见证一致性：短证书（在线跟随用）与长证书（判定依据）在**同一棋盘 + 同一行棋方**上
   是否选了同一个见证。remaining 不同 ⇒ 完整命题键不同，所以这里按 (棋盘, 行棋方) 对齐，
   这正是"短证书是否为长证书的策略截断"的可检查判据。
   返回 { shared, same, shortOnly, longOnly, samples }。 */
function witnessAgreement(shortRef, longRef, rootBoard) {
  const mapOf = ref => {
    const m = new Map();
    const pos = new Position(rootBoard);
    const attacker = ref.attacker;
    const walk = (node, side) => {
      if (node.terminal) return;
      if (side === 3 - attacker) {
        const k = side + '|' + boardKeyOf(new Map([...pos.board]));
        if (!m.has(k)) m.set(k, key(node.moves[0].move));
      }
      for (const e of node.moves) {
        const u = pos.play(e.move, side);
        try { walk(e.child, 3 - side); } finally { pos.undo(u); }
      }
    };
    walk(ref.tree, ((pos.board.size - 1) % 2 === 0) ? 1 : 2);
    return m;
  };
  const S = mapOf(shortRef), L = mapOf(longRef);
  let shared = 0, same = 0, shortOnly = 0, longOnly = 0;
  const samples = [];
  for (const [k, w] of S) {
    if (!L.has(k)) { shortOnly++; continue; }
    shared++;
    if (L.get(k) === w) same++;
    else if (samples.length < 3) samples.push({ state: k.split('|')[1].slice(0, 60) + '…', short: w, long: L.get(k) });
  }
  for (const k of L.keys()) if (!S.has(k)) longOnly++;
  return { shared, same, shortOnly, longOnly, samples,
    pct: shared ? Math.round(same / shared * 1000) / 10 : null };
}
const key = p => `${p.x},${p.y}`;

(function main() {
  const fixture = argOf('fixture', null);
  const recPath = argOf('records', null);
  const verdictHorizon = Number(argOf('verdictHorizon', 13));
  const followHorizon = Number(argOf('followHorizon', 6));
  const maxNodes = Number(argOf('maxNodes', 3000000));
  const timeMs = Number(argOf('timeMs', 600000));
  const outPath = argOf('out', 'tools/fixtures/cert-bundle.json');
  // `--boundCache 0` = **对照组**：容量 0 的缓存**永不写入**（boundStore 里 `size >= maxEntries` 直接返回），
  //   于是复用完全不生效，但 `searchNodes/searchCalls` **照常累加**
  //   ⇒ 两组之间唯一的差别就是"是否命中复用"，可以用确定性指标（节点数）而不是墙钟来比较。
  const boundCache = argOf('boundCache', '1') !== '0' ? createBoundCache() : createBoundCache(0);

  let root, id, sourceGame = null, sourcePly = null;
  if (fixture) {
    const d = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    root = d.board; id = path.basename(fixture).replace(/\.json$/, '');
    if (d.source) { sourceGame = d.source.game || null; sourcePly = d.source.ply; }
  } else if (recPath) {
    const r = boardFromRecords(recPath, argOf('game', null), Number(argOf('ply', 4)));
    root = r.board; id = r.id; sourceGame = argOf('game', null); sourcePly = Number(argOf('ply', 4));
  } else {
    const d = JSON.parse(fs.readFileSync('tools/fixtures/bounded-ply4.json', 'utf8'));
    root = d.board; id = 'bounded-ply4';
    // 来源对局要如实记录：用于 cert-scan 区分"开发集（证书根来源局）"与"留出集"
    if (d.source) { sourceGame = d.source.game || null; sourcePly = d.source.ply; }
  }
  const pos = new Position(root);
  const sideToMove = ((pos.board.size - 1) % 2 === 0) ? 1 : 2;
  const attacker = 3 - sideToMove;
  console.log(`证书包生成：${id}`);
  console.log(`  根局面（轮到 P${sideToMove}）| 判定 horizon=${verdictHorizon} | 在线跟随 horizon=${followHorizon}`);
  const T0 = Date.now();

  // 1) 判定表（离线；这就是"不在线算 94 秒"的那部分）
  const t0 = Date.now();
  const res = chooseMoveCertified(root, sideToMove, {
    horizon: verdictHorizon, fallback: true, fallbackDepth: 6, fallbackTimeMs: 2000, fallbackNodes: 80000,
    certify: { maxNodes, timeMs, tighten: false, boundCache }   // 判定表用"上界"口径，收紧另做；boundCache 让重复查询可复用
  });
  const ev = res.evidence;
  console.log(`  判定表完成：${((Date.now() - t0) / 1000).toFixed(1)}s  决策 (${res.move.x},${res.move.y}) tier=${res.tier} basis=${res.basis}`);
  const moves = ev.moves.map(r => {
    const v = r.ownWin ? { verdict: 'ownWin', withinPlies: r.ownWin.horizon }
      : r.survival ? { verdict: 'survival', horizon: r.survival.horizon }
        : r.opponentWin ? { verdict: 'doomed', withinPlies: r.opponentWin.horizon }
          : { verdict: 'unknown' };
    return Object.assign({ x: r.move.x, y: r.move.y, basis: 'bound' }, v);
  });
  console.log('  ' + moves.map(m => `(${m.x},${m.y}):${m.verdict}${m.withinPlies ? '≤' + m.withinPlies : m.horizon ? '≤' + m.horizon : ''}`).join('  '));

  // 2) 跟随证书（小 horizon，供在线用）—— ⚠ 这是**独立求解**，不是长证书的截断
  //    所以"可执行保证"只有 followHorizon；判定 horizon 只说明"存在更长的防守策略"。
  const compareLong = argOf('compareLong', '1') !== '0';
  const follows = [];
  for (const m of moves.filter(m => m.verdict === 'survival')) {
    const p = new Position(root);
    const u = p.play(m, sideToMove);
    const child = [...p.board]; p.undo(u);
    const r = dfpnSearch(child, attacker, { maxPlies: followHorizon, maxNodes, timeMs });
    if (r.status !== 'refuted' || !r.proof) { bad(`(${m.x},${m.y}) 在 N=${followHorizon} 上没有拿到反证证书`); continue; }
    const uni = unifyRefutation(r.proof, child);
    const v1 = verifyRefutation(child, attacker, uni.ref);
    const v2 = ruleLayer.verifyRefutation(child, attacker, uni.ref);
    if (!v1.ok || !v2.ok) { bad(`(${m.x},${m.y}) 统一后的证书核验失败：${v1.reason || v2.reason}`); continue; }
    const enc = encodeFollow(uni.ref, child, m, followHorizon);
    const rec = { move: { x: m.x, y: m.y }, attacker, horizon: followHorizon,
      // 可执行保证 = horizon；来源如实标注：本次是**独立求解**（不是从长证书截取）
      executableGuarantee: followHorizon, source: 'independent-solve',
      rootKey: enc.rootKey, rootCanon: boardCanon(child).key, rootRot: boardCanon(child).rot,
      rows: enc.rows, uniqueStates: enc.uniqueStates };
    // 与长证书（判定依据所用 horizon）做见证一致性对比：回答"是否为同策略截断"
    if (compareLong) {
      const t1 = Date.now();
      // 同一 (child, attacker, N) 判定表已经查过 ⇒ 这里应命中区间复用（0 节点）
      const lr = dfpnSearch(child, attacker, { maxPlies: verdictHorizon, maxNodes, timeMs, boundCache });
      if (lr.status === 'refuted' && lr.proof) {
        const luni = unifyRefutation(lr.proof, child);
        const ag = witnessAgreement(uni.ref, luni.ref, child);
        rec.longHorizon = verdictHorizon;
        rec.strategyAgreement = ag;
        console.log(`  长证书对比 (${m.x},${m.y})：N=${verdictHorizon} 用时 ${((Date.now() - t1) / 1000).toFixed(1)}s，` +
          `共享棋盘状态 ${ag.shared}，见证一致 ${ag.same}（${ag.pct}%），短独有 ${ag.shortOnly}，长独有 ${ag.longOnly}`);
        if (ag.samples.length) for (const s of ag.samples)
          console.log(`     分歧例：短=${s.short} 长=${s.long}`);
      } else {
        rec.strategyAgreement = null;
        console.log(`  长证书对比 (${m.x},${m.y})：N=${verdictHorizon} 未取得反证证书（${lr.status}），一致性未知`);
      }
    }
    follows.push(rec);
    console.log(`  跟随证书 (${m.x},${m.y})：可执行保证 N=${followHorizon}，唯一状态 ${enc.uniqueStates}，双核验通过，往返校验通过`);
  }

  // 3) 演示"非互斥"：同一候选既有有限防守保证、又有更长的强制败证据（用小 horizon，便宜）
  let nonExclusive = [];
  {
    const demo = certifyRoot(root, sideToMove, { horizon: 4, deepHorizon: verdictHorizon,
      maxNodes: 500000, timeMs: 120000, tighten: false, probeSelf: false });
    nonExclusive = demo.moves.filter(r => r.survival && r.opponentWinDeeper)
      .map(r => ({ move: r.move, survivesWithin: r.survival.horizon, losesWithin: r.opponentWinDeeper.horizon }));
    if (nonExclusive.length) {
      console.log(`  非互斥演示（horizon=4 且 deepHorizon=${verdictHorizon}）：` +
        nonExclusive.map(x => `(${x.move.x},${x.move.y}) 防过 ≤${x.survivesWithin} 但 ≤${x.losesWithin} 内必败`).join('；'));
    }
  }

  const bundle = {
    ruleVersion: RULE_VERSION,
    builtAt: new Date().toISOString(),
    note: '离线生成。⚠ 两个长度口径**必须分开读**：' +
      '① 判定 horizon = "存在一个防守策略，能避免对手在 ≤verdictHorizon 半回合内强制连四"（选招依据）；' +
      '② 可执行保证 = follows[].executableGuarantee = 本次装载的具体策略实际覆盖的半回合数（在线可兑现的只有这个）。' +
      'follows[].source 如实标注该策略是"独立求解"还是"从长证书截取"；strategyAgreement 给出与长证书见证一致的百分比。' +
      '页面命中根局面才使用；跟随中断/偏离即撤销保证。',
    entries: [{
      id, rootKey: boardKeyOf(new Map(root)), sideToMove, attacker,
      sourceGame, sourcePly,
      rootCanon: boardCanon(root).key, rootRot: boardCanon(root).rot,
      verdictHorizon, decision: { move: res.move, tier: res.tier, basis: res.basis,
        reason: res.reason, alternatives: res.alternatives },
      moves, follows, nonExclusiveDemo: nonExclusive
    }]
  };
  fs.writeFileSync(outPath, JSON.stringify(bundle) + '\n');
  const bytes = fs.statSync(outPath).size;
  console.log('\n  ── 长度口径汇总（**不可混用**）──');
  console.log(`  选招依据：存在防守策略，可避免对手在 ≤${verdictHorizon} 半回合内强制连四`);
  for (const f of follows) {
    const ag = f.strategyAgreement
      ? `与 N=${f.longHorizon} 长证书见证一致 ${f.strategyAgreement.pct}%（共享 ${f.strategyAgreement.shared} 个棋盘状态）`
      : '长证书对比未完成';
    console.log(`  可执行保证：(${f.move.x},${f.move.y}) 当前装载策略覆盖 ${f.executableGuarantee} 半回合` +
      `（来源 ${f.source}；${ag}）`);
  }
  if (boundCache) console.log(`  区间缓存：查询 ${boundCache.queries} 结论命中 ${boundCache.hitsVerdict} 证书复用 ${boundCache.hitsCert} ` +
    `结论命中但无证书 ${boundCache.verdictOnlyMiss} 写入 ${boundCache.stores} ` +
    `｜ dfpnSearch ${boundCache.searchCalls} 次，累计展开节点 ${boundCache.searchNodes}`);
  console.log(`  全流程墙钟 ${(((Date.now() - T0) / 1000)).toFixed(1)}s（含判定表 + 跟随证书 + 长证书对比 + 非互斥演示）`);
  console.log(`\n  已写入 ${outPath}（${(bytes / 1024).toFixed(1)} KB）`);
  console.log(fails ? `证书包生成：失败 ${fails} 项` : '证书包生成：全部通过（双核验 + 往返校验）');
  process.exit(fails ? 1 : 0);
})();
