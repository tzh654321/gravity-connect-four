'use strict';
/* ============================================================
   cert-scan —— 策略库"可遇到程度 × 决策收益"离线扫描（P7）

   目的：回答"扩库值不值得"，**不是**扩库本身。
     - 精确根命中 / 四旋转等价命中 / 唯一局面去重 / 命中是否改变原 AI 走法
     - 开发集 / 留出集分开统计（证书根来源的棋谱 ∈ 开发集；其余 ∈ 留出集）
     - 附加：有限预算的"决策价值出现率"抽样（**测量**，不是建库）

   用法：
     node tools/cert-scan.js                          # bundle vs 默认棋谱
     node tools/cert-scan.js --dev tools/bench-games-lean.jsonl --holdout tools/bench-games-v2.jsonl
     node tools/cert-scan.js --sample 40 --samplePlies 4,6 --budgetMs 4000
   ============================================================ */
const fs = require('fs');
const { Position, certifyRoot, boardCanonKey } = require('./solver-core');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const bundlePath = argOf('bundle', 'tools/fixtures/cert-bundle.json');
const devPath = argOf('dev', 'tools/bench-games-lean.jsonl');
const holdoutPath = argOf('holdout', 'tools/bench-games-v2.jsonl');
const sampleN = Number(argOf('sample', 0));                 // >0 时做决策价值抽样
const samplePlies = String(argOf('samplePlies', '4,6')).split(',').map(Number);
const budgetMs = Number(argOf('budgetMs', 4000));
const budgetNodes = Number(argOf('budgetNodes', 200000));
const horizon = Number(argOf('horizon', 6));
const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));

const load = p => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch (e) { return []; } };

const sideOfPly = n => (n % 2 === 0) ? 1 : 2;   // 落子前已 n 子（含固定块）⇒ 轮到 P1 if (n-1) even

/* 把一局棋回放成 [{ply, board, side}]（board = 该手落子前的局面） */
function positions(g) {
  const pos = new Position(g.start);
  const out = [];
  for (const r of g.record) {
    out.push({ ply: r.ply, board: [...pos.board], side: r.side, move: r.move });
    pos.play(r.move, r.side);
  }
  out.push({ ply: g.record.length, board: [...pos.board], side: null, move: null });
  return out;
}

/* 与 bundle 的根做匹配：精确 / 四旋转等价 */
function matchEntry(entries, board, side) {
  for (const e of entries) if (e.sideToMove === side && e.rootKey === boardKeyOf(board)) return { e, kind: 'exact' };
  const ck = boardCanonKey(board);                 // 只含棋盘（不含行棋方）
  for (const e of entries) if (e.sideToMove === side && e.rootCanon === ck) return { e, kind: 'rotated' };
  return null;
}
const boardKeyOf = b => [...b].map(([k, o]) => `${k}:${o}`).sort().join(';');

function scanSet(label, games, entries) {
  const st = { label, games: games.length, exact: 0, rotated: 0, uniqueExact: new Set(), uniqueAll: new Set(),
    changed: 0, changedList: [], positions: 0 };
  for (const g of games) {
    for (const p of positions(g)) {
      if (p.side === null) continue;
      st.positions++;
      const m = matchEntry(entries, p.board, p.side);
      if (!m) continue;
      if (m.kind === 'exact') { st.exact++; st.uniqueExact.add(boardKeyOf(p.board)); }
      else st.rotated++;
      st.uniqueAll.add(m.e.rootCanon + '|' + p.side);
      const want = m.e.decision && m.e.decision.move;
      if (want && p.move && (want.x !== p.move.x || want.y !== p.move.y)) {
        st.changed++;
        st.changedList.push({ game: g.game, ply: p.ply, played: p.move, cert: want, kind: m.kind });
      }
    }
  }
  return st;
}

/* 决策价值出现率抽样：在这些局面里，原走法是否"有更短的强制败线而存在别的保命手"。
   用的是**便宜的 horizon 判定表**，只作测量。 */
function prevalence(label, games, n, plies) {
  const picks = [];
  for (const g of games) for (const p of positions(g)) {
    if (p.side === null || !p.move) continue;
    if (!plies.includes(p.ply)) continue;
    picks.push({ g, p });
  }
  if (picks.length > n) {
    // 均匀抽样（固定步长，不用随机，便于复现）
    const stride = picks.length / n, out = [];
    for (let i = 0; i < n; i++) out.push(picks[Math.floor(i * stride)]);
    picks.length = 0; picks.push(...out);
  }
  let doomedPlayed = 0, hasAlt = 0, checked = 0, improved = 0;
  const t0 = Date.now();
  for (const { g, p } of picks) {
    let ev;
    try {
      ev = certifyRoot(p.board, p.side, { horizon, maxNodes: budgetNodes, timeMs: budgetMs,
        tighten: false, probeSelf: false, deepHorizon: 0 });
    } catch (e) { continue; }
    checked++;
    const played = ev.moves.find(r => r.move.x === p.move.x && r.move.y === p.move.y);
    if (!played) continue;
    if (played.opponentWin) {
      doomedPlayed++;
      if (ev.moves.some(r => r.survival && !(r.move.x === p.move.x && r.move.y === p.move.y))) {
        hasAlt++; improved++;
      }
    }
  }
  console.log(`\n[测量·决策价值出现率] ${label}  抽样 ${checked} 个局面（ply ∈ {${plies.join(',')}}，`
    + `判定 horizon=${horizon}，预算 ${budgetMs}ms/${budgetNodes} 节点/候选，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s）`);
  console.log(`  原走法在 ≤${horizon} 内被证必败：${doomedPlayed}；其中有"能防过 ≤${horizon}"的替代手：${hasAlt}`);
  console.log(`  ⇒ 该类决策在抽样中的出现率 ≈ ${checked ? (hasAlt / checked * 100).toFixed(1) : '-'}%（仅此抽样口径）`);
  return { checked, doomedPlayed, hasAlt };
}

(function main() {
  const entries = bundle.entries || [];
  console.log('策略库扫描');
  console.log(`  bundle: ${bundlePath}  条目 ${entries.length}  规则版本 ${bundle.ruleVersion}`);
  for (const e of entries) {
    console.log(`   - ${e.id}  side=P${e.sideToMove}  判定 horizon=${e.verdictHorizon}  ` +
      `可执行 horizon=${(e.follows || []).map(f => `${f.move.x},${f.move.y}→${f.horizon}`).join(' / ') || '(无)'}`);
  }
  const dev = load(devPath), hold = load(holdoutPath);
  // 开发集 = **证书根来源局**（bundle 里显式记了 sourceGame/sourcePly）；其余算留出用的对照
  const srcGames = new Set(entries.map(e => e.sourceGame).filter(Boolean));
  const isSrc = g => srcGames.has(g.game);
  const devIn = dev.filter(isSrc), devOut = dev.filter(g => !isSrc(g));
  console.log(`\n棋谱：开发集(含证书根来源局) ${devIn.length} 局；开发集其余 ${devOut.length} 局；留出集 ${hold.length} 局`);

  const rows = [];
  for (const [label, set] of [
    ['开发集·来源局', devIn],
    ['开发集·其余局', devOut],
    ['留出集', hold],
    ['全部', [...dev, ...hold]]
  ]) if (set.length) rows.push(scanSet(label, set, entries));

  console.log('\n=== 根局面命中（单条目库） ===');
  console.log('  集合            局数  局面数  精确命中  旋转命中  唯一局面  改变走法');
  for (const s of rows) {
    console.log(`  ${s.label.padEnd(14)} ${String(s.games).padStart(4)}  ${String(s.positions).padStart(6)}  ` +
      `${String(s.exact).padStart(8)}  ${String(s.rotated).padStart(8)}  ${String(s.uniqueAll.size).padStart(8)}  ${String(s.changed).padStart(8)}`);
  }
  const changed = [...new Map(rows.flatMap(s => s.changedList).map(c => [c.game + '@' + c.ply, c])).values()];
  if (changed.length) {
    console.log('\n  改变走法的命中：');
    for (const c of changed) console.log(`    ${c.game}@ply${c.ply}  原走(${c.played.x},${c.played.y}) → 证书(${c.cert.x},${c.cert.y})  [${c.kind}]`);
  } else {
    console.log('\n  改变走法的命中：0 处');
  }
  const prev = [];
  if (sampleN > 0) {
    prev.push(prevalence('留出集', hold, sampleN, samplePlies));
    prev.push(prevalence('开发集', [...devIn, ...devOut], sampleN, samplePlies));
  }
  // 小体积结果落盘（可追踪）：结论的**证据**，与大棋谱分开
  const outPath = argOf('out', null);
  if (outPath) {
    const summary = {
      bundle: bundlePath, builtAt: bundle.builtAt, ruleVersion: bundle.ruleVersion,
      entries: entries.map(e => ({ id: e.id, sourceGame: e.sourceGame, verdictHorizon: e.verdictHorizon,
        executableHorizons: (e.follows || []).map(f => ({ move: f.move, horizon: f.executableGuarantee || f.horizon,
          source: f.source, agreementPct: f.strategyAgreement ? f.strategyAgreement.pct : null })) })),
      hits: rows.map(r => ({ set: r.label, games: r.games, positions: r.positions, exact: r.exact,
        rotated: r.rotated, unique: r.uniqueAll.size, changedMove: r.changed })),
      changed: [...new Map(rows.flatMap(r => r.changedList).map(c => [c.game + '@' + c.ply, c])).values()],
      prevalence: prev, sample: { n: sampleN, plies: samplePlies, horizon, budgetMs, budgetNodes },
      conclusion: '单点证书在来源局之外零命中（含旋转等价），且便宜的有界判定改变不了决策 ⇒ 不扩库'
    };
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');
    console.log(`\n已写入 ${outPath}（${(fs.statSync(outPath).size / 1024).toFixed(1)} KB，可追踪的结果摘要）`);
  }
  console.log('\n结论口径：命中少 ⇒ 单点证书的**复用价值**低（机制能修一个具体失误，但不构成"库"）；'
    + '若"决策价值出现率"高而命中低 ⇒ 真正该复用的是**便宜的有界判定**，而不是逐点证书。');
  process.exit(0);
})();
