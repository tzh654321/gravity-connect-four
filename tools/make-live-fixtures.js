'use strict';
/* ============================================================
   make-live-fixtures —— 从**实战棋谱**固定一组"实时局面"验收集

   为什么需要它：前几轮的收益证据全来自**离线 df-pn 大 horizon 任务**，
   而用户要的是"同样的思考时间，AI 作出更可靠的决定"。离线证明引擎变快
   **不自动**意味着实时 `chooseMove` 变强 ⇒ 必须有独立于离线基准的验收集。

   做法（不改任何搜索算法）：
     1. 读 `tools/bench-games-*.jsonl`（15 局自博弈，`record` 里逐手记了
        `side` / `move` / 当时 `status` / `nodes` / `legal`）；
     2. 从 `start` 逐手重放，取**双方轮次**的局面并重建显式棋盘。
        ⚠ 语料事实（必须写进报告）：**15 局全部是求解器侧的败局**，
          求解器侧 195 手里 **0 次**存在即时胜点；对手侧 204 手里有 15 个即时胜点、
          38 个必胜手。所以战术类样本只能来自对手侧 —— 但同一 AI 也会面对那些局面，
          只是这批棋谱里它恰好在另一侧。逐项标 `sideRole`。
     3. 廉价特征：合法落点数、是否即时战术、是否存在"一手造 ≥2 即时胜点且对方 0 个"的必胜手
        （并按"胜点是否全落在落子四邻"区分是否**支撑激活型**）、是否命中单点证书库；
     4. 对候选跑一次 `chooseMove`（中等预算）拿 **P3 命中/不命中**、`status`、`completedDepth`；
     5. 按**写死的配额**选 18 项覆盖 8 类；每类**每局最多取 2 项**（避免被某一局占满），
        迭代顺序 = (ply, game) 字典序 ⇒ 完全确定。**不按"哪个跑得好看"挑。**

   输出 `tools/fixtures/bench-live.json`：每项带**显式棋盘**（不依赖未入库的棋谱）、
   来源对局/手数/轮次归属、类别、以及期望特征。改选规则必须重跑本脚本并写明理由。

   用法：node tools/make-live-fixtures.js [--budget 500] [--max-per-game 2]
   ============================================================ */
const fs = require('fs');
const path = require('path');
const CORE = require('./solver-core');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const FEATURE_MS = Number(argOf('budget', 500));
const MAX_PER_GAME = Number(argOf('max-per-game', 2));

const GAME_FILES = ['bench-games-v2.jsonl', 'bench-games-lean.jsonl'].map(f => path.join(__dirname, f));
const OUT = path.join(__dirname, 'fixtures', 'bench-live.json');
const BUNDLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'cert-bundle.json'), 'utf8'));
const certKeys = new Set(BUNDLE.entries.map(e => e.sideToMove + '|' + e.rootKey));

const key = (x, y) => x + ',' + y;
const CROSS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const sortBoard = b => [...b].sort((a, c) => a[0] < c[0] ? -1 : a[0] > c[0] ? 1 : 0);
const flatKey = (board, side) => side + '|' + sortBoard([...board].map(([k, o]) => [k, o])).map(([k, o]) => k + ':' + o).join(';');

const games = [];
for (const f of GAME_FILES) {
  if (!fs.existsSync(f)) { console.log(`  （跳过不存在的棋谱 ${path.basename(f)}）`); continue; }
  for (const line of fs.readFileSync(f, 'utf8').trim().split('\n')) games.push({ file: path.basename(f), ...JSON.parse(line) });
}
if (!games.length) { console.error('没有可用的棋谱（tools/bench-games-*.jsonl 不在？）'); process.exit(1); }
console.log(`make-live-fixtures：${games.length} 局棋谱（证书库根局面 ${certKeys.size} 个）`);

/* ---- 候选：双方轮次 ---- */
const cands = [];
for (const g of games) {
  const board = new Map(g.start.map(([k, o]) => [k, o]));
  for (let i = 0; i < g.record.length; i++) {
    const rec = g.record[i], side = rec.side;
    if (rec.move) {
      cands.push({
        game: g.game, file: g.file, ply: i, side, sideRole: side === g.solverColor ? 'solver' : 'opponent',
        entries: sortBoard([...board].map(([k, o]) => [k, o])),
        recorded: side === g.solverColor
          ? { status: rec.status, proofDepth: rec.proofDepth, completedDepth: rec.completedDepth, ms: rec.ms, exhausted: rec.exhausted }
          : null,
      });
    }
    if (rec.move) board.set(key(rec.move.x, rec.move.y), side);
  }
}
console.log(`  候选局面（双方轮次）= ${cands.length}（求解器侧 ${cands.filter(c => c.sideRole === 'solver').length}）`);

/* ---- 廉价特征 ---- */
for (const c of cands) {
  const pos = new CORE.Position(c.entries), side = c.side, moves = pos.moves();
  c.legal = moves.length;
  c.certHit = certKeys.has(flatKey(pos.board, side));
  c.ownThreats = CORE.winPointsAll(pos, side).length;
  c.oppThreats = CORE.winPointsAll(pos, 3 - side).length;
  /* 与 `quickTactics` 的条件**逐字对齐**（它决定 `chooseMove` 是否在预算前返回）：
       本方有即时胜点 → value 1；否则对手有 >=2 个即时胜点 → value -1；两者皆无才继续搜。
     ⚠ 只写"本方有胜点"会漏掉"对手双杀 ⇒ 提前返回"这一类，导致计时统计里混进近零耗时样本。 */
  c.tacticKind = c.ownThreats >= 1 ? 'immediate-win' : (c.oppThreats >= 2 ? 'double-threat-loss' : null);
  c.immediate = c.tacticKind !== null;
  c.forks = [];
  if (c.oppThreats === 0) {
    for (const m of moves) {
      const u = pos.play(m, side);
      try {
        const mine = CORE.winPointsAll(pos, side), theirs = CORE.winPointsAll(pos, 3 - side);
        if (mine.length >= 2 && theirs.length === 0) {
          const cross = new Set(CROSS.map(([dx, dy]) => key(m.x + dx, m.y + dy)));
          c.forks.push({ move: key(m.x, m.y), wins: mine.map(q => key(q.x, q.y)),
            supportActivated: mine.some(q => !cross.has(key(q.x, q.y))) });
        }
      } finally { pos.undo(u); }
    }
  }
}

/* ---- 中等预算的 `chooseMove` 特征（拿 P3 命中 / status / completedDepth）---- */
const pre = cands.filter(c => c.ply <= 24).sort((a, b) => a.ply - b.ply || (a.game < b.game ? -1 : a.game > b.game ? 1 : 0));
console.log(`  跑特征（每项 ${FEATURE_MS}ms），共 ${pre.length} 项…`);
let done = 0;
for (const c of pre) {
  const r = CORE.chooseMove(c.entries, c.side, {
    timeMs: FEATURE_MS, maxNodes: 120000, maxDepth: 10, proofDepth: 12,
    proofFraction: 0.3, qDepth: 8, maxEntries: 60000,
  });
  c.feat = {
    status: r.status, completedDepth: r.completedDepth || 0, proofDepth: r.proofDepth || 0,
    exhausted: !!r.exhausted, tactical: r.tactical || null,
    p3: r.threat ? r.threat.status : null, p3Mate: r.threat ? r.threat.matePlies : 0,
    move: r.move ? key(r.move.x, r.move.y) : null, nodes: (r.nodes && r.nodes.total) || 0,
  };
  if (++done % 25 === 0) process.stdout.write('.');
}
console.log('');

/* ---- 选择（配额写死；每类每局最多 MAX_PER_GAME 项）---- */
const picked = [];
const perGame = new Map();
const take = (cat, why, pool, pred, n) => {
  let got = 0;
  for (const c of pool) {
    if (got >= n) break;
    if (picked.includes(c) || !pred(c)) continue;
    const g = c.game;
    if ((perGame.get(g) || 0) >= MAX_PER_GAME) continue;
    perGame.set(g, (perGame.get(g) || 0) + 1);
    picked.push(Object.assign(c, { cat, why })); got++;
  }
  if (got < n) console.log(`  ⚠ 类别 ${cat} 只凑到 ${got}/${n}`);
};
const searchPool = pre.filter(c => c.feat && c.feat.move && !c.feat.tactical);   // 会真正进搜索的
const tacPool = pre.filter(c => c.feat && c.feat.move && c.feat.tactical);      // 即时战术就返回

take('cert-hit', '命中单点证书库的根局面（页面会**跳过搜索**，只作对照/说明用）',
  searchPool, c => c.certHit, 1);
take('open-quiet', '开局/安静局面（≤3 手、无战术、P3 不命中）',
  searchPool, c => c.ply <= 3 && c.forks.length === 0 && c.feat.p3 !== 'proven-win', 3);
take('single-threat', '单杀强制防守（对手恰 1 个即时胜点，必须挡）',
  searchPool, c => c.oppThreats === 1, 3);
take('support-fork', '支撑激活战术（存在必胜手，且胜点不全在落子四邻 ⇒ 靠新支撑激活）',
  searchPool, c => c.forks.some(f => f.supportActivated), 3);
take('plain-fork', '必胜手（造双威胁，胜点都在落子四邻）',
  searchPool, c => c.forks.length > 0 && !c.forks.some(f => f.supportActivated), 2);
take('quiet-mid', '安静中局（≥6 手、无战术、P3 不命中、落点不多）',
  searchPool, c => c.ply >= 6 && c.forks.length === 0 && c.feat.p3 !== 'proven-win' && c.legal <= 8, 2);
take('wide-mid', '合法落点较多的中局（≥10）',
  searchPool, c => c.legal >= 10, 2);
take('p3-hit', 'P3（连续强制威胁）命中',
  searchPool, c => c.feat.p3 === 'proven-win', 2);

/* 即时战术单列（不占上面的配额；它们在页面/核心都会在预算前直接返回） */
take('immediate-tactic', '即时战术就返回（近零耗时，计时统计必须单列）',
  tacPool, () => true, 2);

picked.sort((a, b) => (a.cat < b.cat ? -1 : a.cat > b.cat ? 1 : a.game < b.game ? -1 : a.game > b.game ? 1 : a.ply - b.ply));

const SUITE = {
  ruleVersion: CORE.RULE_VERSION,
  builtAt: new Date().toISOString(),
  note: '实时（chooseMove）验收局面集。棋盘显式写出，不依赖未入库的棋谱文件。' +
    '类别只按覆盖配额挑、每类每局最多 2 项，不按"跑得好看"挑；' +
    '`immediateTactic` 与 `certHit` 为真的局面在计时统计里必须单列/排除。',
  source: 'tools/bench-games-v2.jsonl + bench-games-lean.jsonl（15 局自博弈；**全部是求解器侧败局**）',
  corpusFact: '15 局全部 loss；求解器侧 195 手中 0 次存在即时胜点，对手侧 204 手中有 15 个即时胜点、38 个必胜手 ' +
    '⇒ 战术类样本只能取对手轮次（同一 AI 也会面对，只是这批棋谱里它恰在另一侧）。',
  featureBudgetMs: FEATURE_MS,
  tasks: picked.map((c, i) => ({
    id: `${String(i + 1).padStart(2, '0')}-${c.cat}`,
    category: c.cat, categoryWhy: c.why,
    game: c.game, file: c.file, ply: c.ply, side: c.side, sideRole: c.sideRole,
    board: c.entries,
    legalAtSelection: c.legal,
    immediateTactic: c.immediate,
    tacticKind: c.tacticKind,
    ownWinPoints: c.ownThreats, oppWinPoints: c.oppThreats,
    forkMoves: c.forks.map(f => ({ move: f.move, wins: f.wins, supportActivated: f.supportActivated })),
    certHit: c.certHit,
    expect: { p3: c.feat.p3, status: c.feat.status, completedDepth: c.feat.completedDepth,
      move: c.feat.move, nodesAt500ms: c.feat.nodes },
    recorded: c.recorded,
  })),
};
fs.writeFileSync(OUT, JSON.stringify(SUITE, null, 1) + '\n');

console.log(`\n已写入 ${path.relative(process.cwd(), OUT)}（${SUITE.tasks.length} 项）\n`);
console.log('  ' + 'id'.padEnd(22) + '来源/轮次'.padEnd(22) + 'ply'.padStart(4) + 'side'.padStart(5) +
  'legal'.padStart(6) + '  即时 必胜手  P3            证书  期望走法');
for (const t of SUITE.tasks) {
  console.log('  ' + t.id.padEnd(22) + (t.game + ' ' + t.sideRole).padEnd(22) + String(t.ply).padStart(4) +
    String(t.side).padStart(5) + String(t.legalAtSelection).padStart(6) + '  ' +
    (t.immediateTactic ? ' 是 ' : ' 否 ') + '  ' + String(t.forkMoves.length).padStart(4) + '  ' +
    String(t.expect.p3).padEnd(12) + '  ' + (t.certHit ? '命中' : '不中') + '  ' + (t.expect.move || '-'));
}
const byCat = {};
for (const t of SUITE.tasks) byCat[t.category] = (byCat[t.category] || 0) + 1;
console.log('\n  类别覆盖：' + Object.entries(byCat).map(([k, v]) => `${k}×${v}`).join('、'));
console.log(`  涉及对局：${new Set(SUITE.tasks.map(t => t.game)).size} 局｜证书命中 ${SUITE.tasks.filter(t => t.certHit).length} 项` +
  `｜即时战术 ${SUITE.tasks.filter(t => t.immediateTactic).length} 项（单列）`);
console.log(`  轮次归属：求解器侧 ${SUITE.tasks.filter(t => t.sideRole === 'solver').length} 项 / 对手侧 ${SUITE.tasks.filter(t => t.sideRole === 'opponent').length} 项`);
