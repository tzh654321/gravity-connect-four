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

const skipList = argOf('skip', null);              // 按**完整 id** 排除（前缀匹配会误伤 t10 vs t1）
const TASKS = SUITE.tasks.filter(t =>
  (!onlyFilter || onlyFilter.split(',').some(x => t.id.startsWith(x.trim()))) &&
  (!skipList || !skipList.split(',').some(x => t.id === x.trim())));

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
          // `expect: null` = 这批任务没有先验期望（例如来自其它对局），判据只有"变体结论一致 + 证书过核验"
          if (t.expect && r.status !== t.expect && !t.budgetCapped) bad(`${t.id} [${v}] 结论 ${r.status} ≠ 期望 ${t.expect}`);
          if (t.verify !== 'none' && ver.ok === false) bad(`${t.id} [${v}] 核验失败：${ver.reason}`);
        } else if (r.status !== acc[v][t.id].rows[0].r.status) {
          bad(`${t.id} [${v}] 第 ${rep + 1} 遍结论变成 ${r.status}（排序若不确定会在这里暴露）`);
        }
        acc[v][t.id].ms.push(ms);
        acc[v][t.id].rows.push(row);
      }
    }
  }

  const base = VARIANTS[0];
  const med = a => { const s = [...a].sort((x, y) => x - y); const n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
  // 本机噪声地板：用**基线自己**在多次重复里的相对波动（max-min)/median 当标尺；
  //   变体与基线的差若小于这个地板，就判"收益未确认"，而不是拿单次快慢下结论。
  const spread = a => { const m = med(a); return m > 0 ? (Math.max(...a) - Math.min(...a)) / m : 0; };

  console.log('\n  ' + '任务'.padEnd(26) + VARIANTS.map(v => ('nodes/' + v).padStart(15)).join('') +
    VARIANTS.map(v => ('ms(中位)/' + v).padStart(12)).join('') + '  完成状态(' + VARIANTS.join('/') + ')');
  const mk = () => ({ nodes: 0, succ: 0, ms: 0, ordCalls: 0, ordScores: 0, ordSkipped: 0, heap: 0, done: 0, unknown: 0 });
  const totals = {}, capTotals = {}, commonTotals = {};
  for (const v of VARIANTS) { totals[v] = mk(); capTotals[v] = mk(); commonTotals[v] = mk(); }
  const allDone = t => VARIANTS.every(v => {
    const rr = acc[v][t.id].rows[0].r;
    return rr.status !== 'unknown' && !rr.timedOut && !rr.nodeLimit;
  });
  const someDone = t => VARIANTS.some(v => {
    const rr = acc[v][t.id].rows[0].r;
    return rr.status !== 'unknown' && !rr.timedOut && !rr.nodeLimit;
  });
  const changedSet = [];
  for (const t of TASKS) {
    const line = ['  ' + t.id.padEnd(24) + (t.budgetCapped ? ' *' : '')];
    for (const v of VARIANTS) line.push(String(acc[v][t.id].rows[0].r.nodes).padStart(15));
    for (const v of VARIANTS) line.push(String(med(acc[v][t.id].ms)).padStart(12));
    line.push('  ' + VARIANTS.map(v => {
      const rr = acc[v][t.id].rows[0].r;
      return (rr.timedOut || rr.nodeLimit) ? 'budget' : rr.status;
    }).join(' / '));
    console.log(line.join(''));
    for (const v of VARIANTS) {
      const row = acc[v][t.id].rows[0], rr = row.r;
      const T = t.budgetCapped ? capTotals[v] : totals[v];   // 预算受限任务**不进**可比合计
      T.nodes += rr.nodes; T.succ += rr.successors;
      T.ms += med(acc[v][t.id].ms);
      T.ordCalls += rr.orderCalls; T.ordScores += rr.orderScores; T.ordSkipped += rr.orderSkipped || 0;
      // 峰值堆：取各遍的最大值（仍受 GC 时机影响 ⇒ 只作量级参考）
      T.heap = Math.max(T.heap, ...acc[v][t.id].rows.map(x => x.heap));
      if (allDone(t) && !t.budgetCapped) {
        commonTotals[v].nodes += rr.nodes; commonTotals[v].succ += rr.successors;
        commonTotals[v].ms += med(acc[v][t.id].ms); commonTotals[v].ordCalls += rr.orderCalls;
        commonTotals[v].ordScores += rr.orderScores; commonTotals[v].ordSkipped += rr.orderSkipped || 0;
      }
      if (rr.status === 'unknown' || rr.timedOut || rr.nodeLimit) T.unknown++; else T.done++;
      if (v !== base && rr.status !== acc[base][t.id].rows[0].r.status && !t.budgetCapped) {
        bad(`${t.id} 变体 ${v} 结论 ${rr.status} ≠ ${base} 的 ${acc[base][t.id].rows[0].r.status}`);
      }
    }
    if (someDone(t) && !allDone(t)) changedSet.push(t);
  }
  const commonCount = TASKS.filter(t => allDone(t) && !t.budgetCapped).length;
  console.log('  ' + '—'.repeat(26 + VARIANTS.length * 43));
  console.log(`  【全部变体都完成的任务】${commonCount} 个 —— 这是**共同完成集合**的成本（` +
    `单次取最小不适合确认小幅差异 ⇒ 这里报**中位数**）：`);
  console.log(`    节点    ${VARIANTS.map(v => v + '=' + commonTotals[v].nodes).join('  ')}`);
  console.log(`    后继    ${VARIANTS.map(v => v + '=' + commonTotals[v].succ).join('  ')}`);
  console.log(`    ms(中位) ${VARIANTS.map(v => v + '=' + commonTotals[v].ms).join('  ')}`);
  console.log(`    评分调用 ${VARIANTS.map(v => v + '=' + commonTotals[v].ordCalls).join('  ')}  ` +
    `评分次数 ${VARIANTS.map(v => v + '=' + commonTotals[v].ordScores).join('  ')}` +
    (VARIANTS.some(v => commonTotals[v].ordSkipped)
      ? `  深层跳过 ${VARIANTS.map(v => v + '=' + commonTotals[v].ordSkipped).join('  ')}` : ''));
  console.log(`  【预算内完成的任务（含"只有一个变体完成"的）】${TASKS.length - TASKS.filter(t => t.budgetCapped).length} 个：`);
  console.log(`    节点    ${VARIANTS.map(v => v + '=' + totals[v].nodes).join('  ')}`);
  console.log(`    ms(中位) ${VARIANTS.map(v => v + '=' + totals[v].ms).join('  ')}`);
  console.log(`    峰值堆  ${VARIANTS.map(v => v + '=' + (totals[v].heap / 1048576).toFixed(0) + 'MB').join('  ')}` +
    `（受 GC 时机影响，只作量级参考）`);
  if (TASKS.some(t => t.budgetCapped)) {
    console.log(`  【预算受限任务】${TASKS.filter(t => t.budgetCapped).length} 个，只记资源、**不判优劣**：`);
    console.log(`    节点 ${VARIANTS.map(v => v + '=' + capTotals[v].nodes).join('  ')}  ` +
      `ms(中位) ${VARIANTS.map(v => v + '=' + capTotals[v].ms).join('  ')}`);
  }
  if (changedSet.length) {
    console.log('  ⚠ **完成集合发生变化**（有的变体做完了、有的没做完）—— 这些任务**不能被排除后只比共同项**：');
    for (const t of changedSet) {
      console.log('      ' + t.id.padEnd(24) +
        VARIANTS.map(v => {
          const rr = acc[v][t.id].rows[0].r;
          return v + '=' + ((rr.timedOut || rr.nodeLimit) ? 'budget' : rr.status);
        }).join('  '));
    }
  }
  if (VARIANTS.length >= 2) {
    // 配对比较：因为变体是**交替**执行的，同一 rep 内相邻 ⇒ 可以逐 rep 配对相减
    const b = totals[base];
    const rel = (k, c) => (b[k] > 0 ? ((c / b[k] - 1) * 100).toFixed(1) + '%' : '—');  // 正=更差
    // 噪声地板用**每遍总耗时**的波动（不是逐任务相对波动的中位数）：
    //   后者会被 1ms 级的小任务主导（它们的相对波动天然几百 %），把地板抬得毫无意义。
    // 用**每遍总耗时**而不是逐任务相对波动（后者会被 1ms 级小任务抬到几百 %）；
    // 且用**中位绝对偏差**而不是 (max-min)/median —— 后者会被"某一遍整体卡顿"这种单离群值主导
    //   （实测出现过 2383/2337/2314/2302/**4117**ms：只有一遍异常，全距却给出 78% 的假地板）。
    const perRep = [];
    for (let rep = 0; rep < repeat; rep++) {
      perRep.push(TASKS.filter(t => !t.budgetCapped)
        .reduce((s, t) => s + acc[base][t.id].ms[rep], 0));
    }
    const m0 = med(perRep);
    const noiseMed = m0 > 0 ? med(perRep.map(x => Math.abs(x - m0))) / m0 : 0;
    console.log('\n  相对基线 ' + base + '（**正=更差、负=更好**；共同完成集合 + 中位数）：');
    for (const v of VARIANTS.slice(1)) {
      const bc = commonTotals[base], d = commonTotals[v];
      const relc = k => (bc[k] > 0 ? ((d[k] / bc[k] - 1) * 100).toFixed(1) + '%' : '—');
      // 逐任务配对差（同一 rep）取中位数，比"两个中位数相减"更抗漂移
      const pairs = TASKS.filter(t => allDone(t) && !t.budgetCapped).map(t => {
        const a = acc[base][t.id].ms, c = acc[v][t.id].ms;
        return med(a.map((x, i) => c[i] - x));
      });
      const pairMed = pairs.length ? med(pairs) : 0;
      const verdict = Math.abs(Number(relc('ms').replace('%', ''))) <= noiseMed * 100
        ? `  ⇒ 差异小于本机噪声地板（基线每遍总耗时的中位绝对偏差 ${(noiseMed * 100).toFixed(1)}%，` +
          `各遍 ${perRep.join('/')}ms）：**收益未确认**`
        : (Number(relc('ms').replace('%', '')) < 0 ? '  ⇒ 超出噪声地板，方向为**净收益**' : '  ⇒ 超出噪声地板，方向为**净退化**');
      console.log(`    ${v.padEnd(10)} 节点 ${relc('nodes').padStart(7)}  后继 ${relc('succ').padStart(7)}  ` +
        `ms(中位) ${relc('ms').padStart(7)}  配对差中位 ${String(Math.round(pairMed)).padStart(6)}ms`);
      console.log(`               评分调用 ${d.ordCalls}（基线 ${bc.ordCalls}）评分次数 ${d.ordScores}（基线 ${bc.ordScores}）` +
        (d.ordSkipped || bc.ordSkipped ? ` 深层跳过 ${d.ordSkipped}` : ''));
      console.log(`               ${verdict}`);
    }
    console.log('  ⚠ 判据是**总求解成本**（耗时、完成集合、评分开销、内存）；节点数只用来解释，不当结论。');
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
