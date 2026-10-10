'use strict';
/* ============================================================
   bench-suite —— 固定搜索基准的运行器 + 成本剖析 + 走法排序对照（P8）

   三种驱动模式：
     --mode cold|warm|both   冷/热 boundCache 对照（同一批任务跑两趟，量化跨 horizon 复用）
     --mode order            后继**排序**对照（默认）：对同一批任务，按 --order 给出的变体
                             **交替**执行 --repeat 遍，用"/最小时的毫秒 + 确定性的节点数"比较

   为什么必须这么做（踩过的坑，别删这段注释）：
   - 本机**墙钟抖动可达 ±20%**：同一任务节点数逐位一致，却跑出过 23.8s vs 34.9s
     ⇒ 毫秒只报**多次取最小**，真正的结论看**节点数 / 生成后继数**（预算未触发时是确定的）。
   - 只有"预算内完成"的任务节点数才确定：**budgetCapped 任务（时间盒或节点预算）不能用来判优劣**，
     只记为"资源消耗"，且不按 pn 大小说谁更接近答案。
   - 排序后的**证明树可以不同**（不同见证、不同树大小）⇒ 只要求**结论一致 + 证书通过独立核验**，
     绝不要求证书哈希或节点数与旧版相同。

   用法：
     node tools/bench-suite.js                                   # 开发集，冷/热 boundCache 对照
     node tools/bench-suite.js --suite tools/fixtures/bench-holdout.json   # 留出集
     node tools/bench-suite.js --mode order --order none,block,shape --repeat 2
     node tools/bench-suite.js --only t5,t9 --mode order --order none,shape
   ============================================================ */
const fs = require('fs');
const path = require('path');
const CORE = require('./solver-core');
const RULE = require('./verify-strategy');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

const suitePath = argOf('suite', path.join(__dirname, 'fixtures', 'bench-suite.json'));
const SUITE = JSON.parse(fs.readFileSync(suitePath, 'utf8'));
const onlyFilter = argOf('only', null);
const orderCsv = argOf('order', 'none');
const VARIANTS = orderCsv.split(',').map(s => s.trim()).filter(Boolean);
const repeat = Math.max(1, Number(argOf('repeat', 1)));
const mode = argOf('mode', VARIANTS.length > 1 || VARIANTS[0] !== 'none' ? 'order' : 'both');

const PLY4PATH = path.join(__dirname, 'fixtures', 'bounded-ply4.json');
const PLY4 = fs.existsSync(PLY4PATH)
  ? JSON.parse(fs.readFileSync(PLY4PATH, 'utf8')).board : null;

let fails = 0;
const bad = m => { fails++; console.log('  ✗ ' + m); };
const okOf = m => console.log('  ✓ ' + m);

const boardOf = t => {
  if (t.ply4Move) {
    if (!PLY4) throw new Error('缺少 tools/fixtures/bounded-ply4.json');
    const p = new CORE.Position(PLY4); const u = p.play(t.ply4Move, 1); const b = [...p.board]; p.undo(u); return b;
  }
  if (t.board) return t.board;
  throw new Error(`任务 ${t.id} 既没有 ply4Move 也没有 board`);
};
const treeNodes = t => { let n = 0; const w = x => { n++; if (!x.terminal) for (const e of x.moves) w(e.child); }; w(t); return n; };

/* 独立核验（库内 + 规则层；耗时单列，不混进 msSearch）
   ⚠ 按**实际得到的结论**派发核验器，不能按任务声明的期望：
     期望写错时若仍用期望去选核验器，会把"反证证书"塞给策略树核验器，
     报出一堆与排序无关的错误（第一次跑留出集就踩到，误以为是证书坏了）。 */
function verifyTask(t, r) {
  if (t.verify === 'none' || r.status === 'unknown') return { ok: null, ms: 0 };
  const board = boardOf(t);
  const t0 = Date.now();
  if (r.status === 'refuted') {
    if (!r.proof) return { ok: false, ms: Date.now() - t0, reason: '缺少反证证书' };
    const a = CORE.verifyRefutation(board, t.attacker, r.proof);
    const b = RULE.verifyRefutation(board, t.attacker, r.proof);
    return { ok: a.ok && b.ok, ms: Date.now() - t0, reason: a.reason || b.reason, nodes: treeNodes(r.proof.tree) };
  }
  if (r.status === 'proven-win') {
    if (!r.proof) return { ok: false, ms: Date.now() - t0, reason: '缺少获胜策略树' };
    const a = CORE.verifyStrategy(board, t.attacker, r.proof.tree);
    const b = RULE.verify(board, t.attacker, r.proof.tree);
    return { ok: a.ok && b.ok, ms: Date.now() - t0, reason: a.reason || b.reason, nodes: treeNodes(r.proof.tree) };
  }
  return { ok: null, ms: 0 };
}

const TASKS = SUITE.tasks.filter(t =>
  !onlyFilter || onlyFilter.split(',').some(x => t.id.startsWith(x.trim())));

function runOne(t, opts) {
  const board = boardOf(t);
  const bc = opts.fresh ? CORE.createBoundCache() : (opts.shared || null);
  const heapBefore = process.memoryUsage().heapUsed;
  const t0 = Date.now();
  const r = CORE.dfpnSearch(board, t.attacker, {
    maxPlies: t.maxPlies, maxNodes: t.maxNodes, timeMs: t.timeMs,
    boundCache: bc, order: opts.order || 'none', diag: true
  });
  const ms = Date.now() - t0;
  const heap = process.memoryUsage().heapUsed - heapBefore;
  return { task: t, r, ms, heap, cache: bc };
}

/* ---------------- 排序对照（交替执行 + 多次取最小） ---------------- */
function runOrderMode() {
  console.log(`后继排序对照：${SUITE.tasks.length} 个任务中跑 ${TASKS.length} 个｜变体 ${VARIANTS.join(' / ')}｜每变体 ${repeat} 遍（交替）`);
  console.log('  诊断字段：nodes=新建节点  succ=生成后继  ordCalls=排序调用  ordScores=评分次数  heap=单任务堆增量');
  const acc = {};                       // variant -> taskId -> {ms[], row}
  for (const v of VARIANTS) { acc[v] = {}; for (const t of TASKS) acc[v][t.id] = { ms: [], rows: [] }; }

  for (let rep = 0; rep < repeat; rep++) {
    for (const v of VARIANTS) {                 // 变体在内层 ⇒ 机器漂移对所有变体公平
      for (const t of TASKS) {
        const { r, ms, heap, cache } = runOne(t, { fresh: true, order: v });
        const row = { r, ms, heap, cache, heap0: heap };
        if (rep === 0) {
          const ver = verifyTask(t, r);         // 核验只在第一遍做（贵，且重复核验没有新信息）
          row.verify = ver;
          if (r.status !== t.expect && !t.budgetCapped) bad(`${t.id} [${v}] 结论 ${r.status} ≠ 期望 ${t.expect}`);
          if (t.verify !== 'none' && ver.ok === false) bad(`${t.id} [${v}] 核验失败：${ver.reason}`);
        }
        acc[v][t.id].ms.push(ms);
        acc[v][t.id].rows.push(row);
      }
    }
  }

  const base = VARIANTS[0];
  console.log('\n  ' + '任务'.padEnd(26) + VARIANTS.map(v => ('nodes/' + v).padStart(16)).join('') +
    VARIANTS.map(v => ('succ/' + v).padStart(14)).join('') + VARIANTS.map(v => ('ms(min)/' + v).padStart(13)).join(''));
  const mk = () => ({ nodes: 0, succ: 0, ms: 0, ordCalls: 0, ordScores: 0, heap: 0, done: 0, unknown: 0 });
  const totals = {}, capTotals = {};
  for (const v of VARIANTS) { totals[v] = mk(); capTotals[v] = mk(); }
  for (const t of TASKS) {
    const line = ['  ' + t.id.padEnd(24) + (t.budgetCapped ? ' *' : '')];
    for (const v of VARIANTS) line.push(String(acc[v][t.id].rows[0].r.nodes).padStart(16));
    for (const v of VARIANTS) line.push(String(acc[v][t.id].rows[0].r.successors).padStart(14));
    for (const v of VARIANTS) line.push(String(Math.min(...acc[v][t.id].ms)).padStart(13));
    console.log(line.join(''));
    for (const v of VARIANTS) {
      const row = acc[v][t.id].rows[0], rr = row.r;
      const T = t.budgetCapped ? capTotals[v] : totals[v];   // 预算受限任务**不进**可比合计
      T.nodes += rr.nodes; T.succ += rr.successors;
      T.ms += Math.min(...acc[v][t.id].ms);
      T.ordCalls += rr.orderCalls; T.ordScores += rr.orderScores;
      T.heap = Math.max(T.heap, row.heap);
      if (rr.status === 'unknown' || rr.timedOut || rr.nodeLimit) T.unknown++; else T.done++;
      if (v !== base && rr.status !== acc[base][t.id].rows[0].r.status && !t.budgetCapped) {
        bad(`${t.id} 变体 ${v} 结论 ${rr.status} ≠ ${base} 的 ${acc[base][t.id].rows[0].r.status}`);
      }
    }
  }
  console.log('  ' + '—'.repeat(26 + VARIANTS.length * 43));
  console.log(`  【预算内完成的任务】${TASKS.length - TASKS.filter(t => t.budgetCapped).length} 个 ` +
    `⇒ 这是**唯一可比**的部分（带 * 的预算受限任务单独统计）：`);
  console.log(`    节点    ${VARIANTS.map(v => v + '=' + totals[v].nodes).join('  ')}`);
  console.log(`    后继    ${VARIANTS.map(v => v + '=' + totals[v].succ).join('  ')}`);
  console.log(`    ms(min) ${VARIANTS.map(v => v + '=' + totals[v].ms).join('  ')}`);
  console.log(`    峰值堆  ${VARIANTS.map(v => v + '=' + (totals[v].heap / 1048576).toFixed(0) + 'MB').join('  ')}`);
  for (const v of VARIANTS) if (totals[v].ordCalls)
    console.log(`    ${v}：排序调用 ${totals[v].ordCalls}、评分次数 ${totals[v].ordScores}`);
  if (TASKS.some(t => t.budgetCapped)) {
    console.log(`  【预算受限任务】${TASKS.filter(t => t.budgetCapped).length} 个，只记资源、**不判优劣**：`);
    console.log(`    节点 ${VARIANTS.map(v => v + '=' + capTotals[v].nodes).join('  ')}  ` +
      `ms(min) ${VARIANTS.map(v => v + '=' + capTotals[v].ms).join('  ')}`);
  }
  if (VARIANTS.length >= 2) {
    const b = totals[base];
    const rel = (k, c) => (b[k] > 0 ? ((c / b[k] - 1) * 100).toFixed(1) + '%' : '—');  // 正=更差
    console.log('\n  相对基线 ' + base + '（**正=更差、负=更好**；只算预算内完成的任务）：');
    for (const v of VARIANTS.slice(1)) {
      const d = totals[v];
      const disagree = (d.nodes - b.nodes) * (d.ms - b.ms) < 0
        ? '  ⚠ 与墙钟不一致：节点更少却更慢 ⇒ 每节点成本上升吃掉了节点收益' : '';
      console.log(`    ${v.padEnd(6)} 节点 ${rel('nodes', d.nodes).padStart(7)}  后继 ${rel('succ', d.succ).padStart(7)}  ` +
        `ms(min) ${rel('ms', d.ms).padStart(7)}${disagree}`);
    }
    console.log('  ⚠ 节点更少 ≠ 同比提速；毫秒取了多次最小值也只是辅助，本机抖动可达 ±20%。');
  }
  return totals;
}

/* ---------------- 原有：冷/热 boundCache 对照 ---------------- */
function runCacheMode(label, opts) {
  console.log(`\n===== ${label} =====`);
  console.log('  id'.padEnd(26) + 'status'.padEnd(12) +
    'nodes'.padStart(9) + 'ttHit'.padStart(8) + 'dup%'.padStart(7) + 'rslv%'.padStart(7) +
    'msSearch'.padStart(9) + 'msExtract'.padStart(10) + 'msVerify'.padStart(9) + 'cache'.padStart(9));
  console.log('  （dup% = ttHits/(nodes+ttHits) = **重复访问率**：可被复用的访问比例**上界**，不是省下的计算量；');
  console.log('   rslv% = 其中命中时该节点已有结论值（终点或 pn/dn=0）的比例 ⇒ 只有这部分直接跳过了下面的工作。）');
  const rows = [];
  for (const t of TASKS) {
    const { r, ms, heap, cache } = runOne(t, opts);
    const v = verifyTask(t, r);
    const cached = r.cached ? (r.cached.kind === 'win-proof' ? 'win' : 'trunc') : '-';
    const dup = (r.nodes + r.ttHits) > 0 ? (r.ttHits / (r.nodes + r.ttHits) * 100).toFixed(1) : '0.0';
    const rslv = r.ttHits > 0 ? (r.ttHitsResolved / r.ttHits * 100).toFixed(1) : '0.0';
    console.log('  ' + t.id.padEnd(24) + r.status.padEnd(10) +
      String(r.nodes).padStart(9) + String(r.ttHits).padStart(8) + dup.padStart(7) + rslv.padStart(7) +
      String(ms).padStart(9) + String(r.msExtract).padStart(10) +
      (v.ms === 0 ? '-' : String(v.ms)).padStart(9) + cached.padStart(9));
    if (r.status !== t.expect && !t.budgetCapped) bad(`${t.id} 结论 ${r.status} ≠ 期望 ${t.expect}`);
    if (t.verify !== 'none' && v.ok === false) bad(`${t.id} 核验失败：${v.reason}`);
    rows.push({ t, r, ms, heap, msVerify: v.ms, cache });
  }
  const sum = k => rows.reduce((a, x) => a + x[k], 0);
  const tNodes = rows.reduce((a, x) => a + x.r.nodes, 0);
  const tHits = rows.reduce((a, x) => a + x.r.ttHits, 0);
  const tRslv = rows.reduce((a, x) => a + x.r.ttHitsResolved, 0);
  console.log('  ' + '—'.repeat(100));
  const msExtract = rows.reduce((a, x) => a + x.r.msExtract, 0);
  console.log(`  合计：${rows.length} 个任务  msSearch=${sum('ms')}  msExtract=${msExtract}  ` +
    `msVerify=${sum('msVerify')}  nodes=${tNodes}  succ=${rows.reduce((a, x) => a + x.r.successors, 0)}`);
  console.log(`  重复访问率（**上界**，不是省下的计算量）= ${(tHits / (tNodes + tHits) * 100).toFixed(1)}%  ` +
    `其中“命中时该节点已有结论值”仅 ${(tRslv / Math.max(1, tHits) * 100).toFixed(1)}%`);
  if (sum('ms') > 0) console.log(`  独立核验占搜索时间 ${(sum('msVerify') / sum('ms') * 100).toFixed(1)}%；` +
    `证书导出占 ${(msExtract / sum('ms') * 100).toFixed(1)}%`);
  return rows;
}

console.log('固定搜索基准' + (mode === 'order' ? '（后继排序对照）' : '（boundCache 冷/热对照）'));
console.log(`  套件 ${path.relative(process.cwd(), suitePath)}（${TASKS.length} 个任务）`);

let cold = null, warm = null;
if (mode === 'order') {
  runOrderMode();
} else {
  if (mode === 'both' || mode === 'cold') cold = runCacheMode('冷启动（每任务一份全新 boundCache）', { fresh: true });
  if (mode === 'both' || mode === 'warm') warm = runCacheMode('热启动（全部任务共用一份 boundCache）', { shared: CORE.createBoundCache() });
  if (cold && warm) {
    console.log('\n===== 冷 / 热 对照 =====');
    console.log('  id'.padEnd(26) + 'cold ms'.padStart(9) + 'warm ms'.padStart(9) + 'cold nodes'.padStart(12) + 'warm nodes'.padStart(12) + '  复用');
    let cC = 0, cW = 0;
    for (const c of cold) {
      const w = warm.find(x => x.t.id === c.t.id); if (!w) continue;
      cC += c.ms; cW += w.ms;
      console.log('  ' + c.t.id.padEnd(24) + String(c.ms).padStart(9) + String(w.ms).padStart(9) +
        String(c.r.nodes).padStart(12) + String(w.r.nodes).padStart(12) + '  ' +
        (w.r.cached ? (w.r.cached.kind === 'win-proof' ? 'win-proof' : 'truncated') : '-'));
    }
    console.log('  ' + '—'.repeat(70));
    console.log(`  msSearch 合计：冷 ${cC} → 热 ${cW}` + (cC > 0 ? `（${((1 - cW / cC) * 100).toFixed(1)}% 减少）` : ''));
  }
}

console.log('');
console.log(fails ? `固定基准：失败 ${fails} 项` : '固定基准：全部通过（结论与期望一致 + 证书独立核验通过）');
process.exit(fails ? 1 : 0);
