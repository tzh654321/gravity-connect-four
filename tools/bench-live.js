'use strict';
/* ============================================================
   bench-live —— **实时搜索路径**（`chooseMove`）的收益验收

   为什么单独做这个：前几轮的收益证据全来自**离线 df-pn 大 horizon 任务**，
   而用户的目标是"同样的思考时间，AI 作出更可靠的决定"。离线证明引擎变快
   **不自动**意味着实时搜索变强 ⇒ 必须在实时入口上单独验收。

   两种模式（都不改搜索算法）：
     ① `--mode work` 固定工作量
        预算给到"不可能超时"（timeMs 极大）+ 固定 maxNodes/maxDepth ⇒ 结果应当**逐位一致**
        （status / score / proofDepth / completedDepth / nodes / move / threat.status / tt 计数）。
        比较 CPU 与墙钟。这一档回答"单位工作成本是否下降"。
     ② `--mode budget` 固定实时预算
        用**页面原样的 SOLVER_OPTS**（默认从 index.html 里解析，防止与页面漂移）。
        这一档**不要求逐位一致**：比 `completedDepth` 分布、证明发现、耗时、回退、走法合法性。
        ⚠ 不把"节点更多"当"棋力更强"；固定时间下节点数与走法本来就可以变。
        ⚠ **`immediateTactic`（即时战术就返回）的局面一律单列**，否则一堆近零耗时样本
          会把真正的搜索成本平均掉。

   两个模式都必须配 **A/A 零假设对照**（同上参数，`--old` 指向当前文件的一份副本）：
   工具会比对两份文件的 sha256 并标记"这是零假设对照"，同时打印逐遍原始差值
   （不只看中位数 —— 有明显趋势 / 正负交替就不能当稳定样本）。

   ⚠⚠ **A/A 对照的实测偏差（本机，P11）**：两份**逐字节相同**的文件互相比较时，
      · 固定工作量档：第二个模块的 CPU 稳定低 **6%~11%**（合计 −6.9%）；
      · 固定实时预算档：第二个模块在同样预算内完成的节点数稳定多 **0%~16%**（合计 +8.2%）。
     两个方向一致（都是"第二个载入的模块更快"）⇒ 这是**仪器自身的偏差**，来源可能包括
     加载顺序/执行位置效应、两构建的 JIT 状态不对称、GC 落在后一次执行上、同进程互相影响、环境漂移。
     ⇒ 正确用法：**用 A/A 判断"哪一档任务本仪器分辨不了"**，而不是"把 A/A 的数字减掉"拿当收益；
     报告时要写**净值**（真对照 − A/A 偏差）并说明这是保守读法。

   用法：
     git show 9f4ea65:tools/solver-core.js > tools/tmp-core-pre.js      # P10-2 之前的提交
     node tools/bench-live.js --old tools/tmp-core-pre.js --mode budget
     node tools/bench-live.js --old tools/tmp-core-pre.js --mode work
     cp tools/solver-core.js tools/tmp-core-same.js                      # 零假设对照
     node tools/bench-live.js --old tools/tmp-core-same.js --mode budget
   ============================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const OLD_PATH = argOf('old', null);
if (!OLD_PATH) { console.error('用法：node tools/bench-live.js --old <改动前的 solver-core 副本> [--mode work|budget] [--reps 5] [--tasks id1,id2]'); process.exit(1); }

const NEW = require('./solver-core');
const OLD = require(path.resolve(OLD_PATH));
const SUITE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'bench-live.json'), 'utf8'));

/* ---- 页面原样的实时预算：从 index.html 解析，避免与页面漂移 ---- */
function liveOptsFromPage() {
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const m = html.match(/const SOLVER_OPTS = \{([^}]*)\}/);
    if (!m) return null;
    const o = {};
    for (const part of m[1].split(',')) {
      const [k, v] = part.split(':').map(s => s && s.trim());
      if (k && v !== undefined && Number.isFinite(Number(v))) o[k] = Number(v);
    }
    return Object.keys(o).length ? o : null;
  } catch (_) { return null; }
}
const PAGE_OPTS = liveOptsFromPage();
const LIVE_OPTS = PAGE_OPTS || { timeMs: 1500, maxNodes: 250000, maxDepth: 10, proofDepth: 12, proofFraction: 0.3, qDepth: 8, maxEntries: 60000 };
/* 固定工作量档：timeMs 给到不可能触发（只留节点/深度上限），结果必须逐位可复现 */
const WORK_OPTS = { timeMs: 3600 * 1000, maxNodes: 30000, maxDepth: 10, proofDepth: 12, proofFraction: 0.3, qDepth: 8, maxEntries: 60000 };

const MODE = argOf('mode', 'budget');
const REPS = Math.max(2, Number(argOf('reps', MODE === 'work' ? 3 : 5)));
const ids = argOf('tasks', '').split(',').map(s => s.trim()).filter(Boolean);
const TASKS = ids.length ? SUITE.tasks.filter(t => ids.includes(t.id)) : SUITE.tasks;

const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const hNew = sha(path.join(__dirname, 'solver-core.js'));
const hOld = sha(path.resolve(OLD_PATH));
const SAME = hNew === hOld;

const med = a => { const s = [...a].sort((x, y) => x - y); return s[(s.length - 1) >> 1]; };
const mad = a => { const m = med(a); return med(a.map(x => Math.abs(x - m))); };
const cpu = c => (c.user + c.system) / 1000;
const wall = t => Number(process.hrtime.bigint() - t) / 1e6;

console.log(`bench-live：实时路径（chooseMove）收益验收`);
console.log(`  模式 ${MODE}｜前 = ${path.relative(process.cwd(), OLD_PATH)}｜后 = tools/solver-core.js`);
console.log(`  预算：${MODE === 'work'
  ? `固定工作量（timeMs=${WORK_OPTS.timeMs}ms 不触发；maxNodes=${WORK_OPTS.maxNodes}、maxDepth=${WORK_OPTS.maxDepth}、proofDepth=${WORK_OPTS.proofDepth}）`
  : `页面原样 SOLVER_OPTS（${PAGE_OPTS ? '从 index.html 解析' : '⚠ 解析失败，用内置副本'}）：${JSON.stringify(LIVE_OPTS)}`}`);
console.log(`  预热 1 遍丢弃 + ${REPS} 遍测量｜每遍内 old/new 紧邻、奇偶遍反转顺序`);
if (SAME) console.log(`  ⚠⚠ **这是 A/A 零假设对照**（两份文件 sha256 相同 ⇒ 真值 0）：只能用来读"仪器噪声"，不能当收益。`);
console.log(`  sha256 前 ${hOld.slice(0, 12)}…　后 ${hNew.slice(0, 12)}…\n`);

const opts = MODE === 'work' ? WORK_OPTS : LIVE_OPTS;
const positions = TASKS.map(t => ({ t, pos: new NEW.Position(t.board), posOld: new OLD.Position(t.board) }));

/* ---- 固定工作量档的"语义等价"判据：只取**确定性**字段 ----
   ⚠ `ms` 是墙钟（`threat.ms` / `ms.*` / `refreshMs` 之类）必然不同，把它算进去会假报"语义不一致"。
   这里显式列出可复现的字段，任何新增字段都要**手动加进来**，避免"新加了个时间字段就永远不等"。 */
const semanticOf = r => JSON.stringify({
  status: r.status, score: r.score, proofDepth: r.proofDepth, completedDepth: r.completedDepth,
  exhausted: !!r.exhausted, tactical: r.tactical || null, proofVerified: r.proofVerified === undefined ? null : r.proofVerified,
  move: r.move ? r.move.x + ',' + r.move.y : null,
  nodes: r.nodes || null,
  threat: r.threat ? { status: r.threat.status, matePlies: r.threat.matePlies, nodes: r.threat.nodes, cacheHits: r.threat.cacheHits, timedOut: r.threat.timedOut } : null,
  pns: r.pns ? { status: r.pns.status, nodes: r.pns.nodes, expands: r.pns.expands, iters: r.pns.iters, pn: r.pns.pn, dn: r.pns.dn, rootSide: r.pns.rootSide } : null,
  tt: r.tt || null,
  rootCandidates: r.rootCandidates || null,
});

/* 走法合法性（用核心自己的合法落点集合判） */
const legalSet = (CORE, board) => new Set(new CORE.Position(board).moves().map(q => q.x + ',' + q.y));

const rows = [];
let bad = 0;
for (const { t, pos } of positions) {
  const oC = [], nC = [], oW = [], nW = [], oD = [], nD = [], oN = [], nN = [];
  const cmp = { oi: [], ni: [] };
  const recs = { old: [], neu: [] };
  const run = (CORE_, tag) => {
    const c0 = process.cpuUsage(), t0 = process.hrtime.bigint();
    const r = CORE_.chooseMove(t.board, t.side, Object.assign({}, opts));
    const W = wall(t0), C = cpu(process.cpuUsage(c0));
    return {
      C, W, r,
      depth: r.completedDepth || 0,
      proof: r.status === 'proven-win' ? 1 : 0,
      nodes: (r.nodes && r.nodes.total) || 0,
      ms: (r.ms && r.ms.total) || 0,
      move: r.move ? r.move.x + ',' + r.move.y : null,
      p3: r.threat ? r.threat.status : null,
      tactical: r.tactical || null,
      exhausted: !!r.exhausted,
      legal: !!r.move && legalSet(CORE_, t.board).has(r.move.x + ',' + r.move.y),
      proofVerified: r.proof ? (CORE_.verifyProof(t.board, r.proof).ok === true) : null,
    };
  };
  for (let rep = 0; rep <= REPS; rep++) {
    const flip = rep % 2 === 1;
    const A = flip ? run(NEW, 'new') : run(OLD, 'old');
    const B = flip ? run(OLD, 'old') : run(NEW, 'new');
    const o = flip ? B : A, n = flip ? A : B;
    if (MODE === 'work') {
      const so = semanticOf(o.r), sn = semanticOf(n.r);
      const same = so === sn;
      if (!same && !bad) {
        console.log(`  ✗ ${t.id} 语义不一致（只比确定性字段）：\n      前 ${so}\n      后 ${sn}`);
      }
      if (!same) bad++;
    }
    if (rep > 0) { oC.push(o.C); nC.push(n.C); oW.push(o.W); nW.push(n.W); oD.push(o.depth); nD.push(n.depth); oN.push(o.nodes); nN.push(n.nodes); }
    if (rep === REPS) { recs.old.push(o); recs.neu.push(n); }   // 最后一遍留作"结论样本"（如实标注）
    process.stdout.write(rep === 0 ? 'w' : '.');
  }
  rows.push({ t, oC, nC, oW, nW, oD, nD, oN, nN, last: { old: recs.old[0], neu: recs.neu[0] } });
}
console.log('\n');

/* ---------------- 报告 ---------------- */
/* 分组口径（写死）：
   · `certHit` 的局面在**页面**里根本不会进搜索（`certChoose` 先返回）⇒ 只作对照，不进合计；
   · `immediateTactic` 的局面在预算前就返回（≈0 耗时）⇒ 必须单列，否则平均掉真实成本。 */
const cert = rows.filter(r => r.t.certHit);
const imm = rows.filter(r => !r.t.certHit && r.t.immediateTactic);
const real = rows.filter(r => !r.t.certHit && !r.t.immediateTactic);
const label = MODE === 'work' ? 'CPU（固定工作量：逐位一致才算有效）' : 'CPU（固定实时预算）';

const table = (list, title) => {
  if (!list.length) return;
  console.log(`=== ${title}（${list.length} 项）===`);
  const withNodes = MODE === 'budget';
  console.log('  ' + 'id'.padEnd(20) + '类别'.padEnd(14) + '深度(前→后)'.padEnd(14) + 'CPU 前→后'.padEnd(24) +
    (withNodes ? '节点 前→后'.padEnd(22) : '') + '     证明/证书      走法合法   回退');
  for (const r of list) {
    const t = r.t;
    const mO = med(r.oC), mN = med(r.nC);
    const dO = med(r.oD), dN = med(r.nD);
    const qO = med(r.oN), qN = med(r.nN);
    const L = r.last;
    console.log('  ' + t.id.padEnd(20) + t.category.padEnd(14) +
      `${dO}→${dN}`.padEnd(14) +
      (`${mO.toFixed(0)}→${mN.toFixed(0)}ms ` + (mO > 0 ? `(${((mN - mO) / mO * 100).toFixed(0)}%)` : '(≈0)')).padEnd(24) +
      (withNodes ? (`${qO}→${qN} ` + (qO > 0 ? `(${((qN - qO) / qO * 100).toFixed(0)}%)` : '(≈0)')).padEnd(22) : '') +
      '  ' + (L.neu.proof ? (L.neu.proofVerified === true ? '证胜/已核验' : (L.neu.proofVerified === false ? '证胜/核验✗' : '证胜/无附带证书')) : '未证胜').padEnd(16) +
      (L.neu.legal ? '  是 ' : '  ✗  ') + '      ' + (L.neu.exhausted ? '时间用尽' : '自然结束'));
  }
  console.log('');
};

table(real, `${label} —— 真正的搜索局面`);
table(imm, '⚠ 单列：即时战术就返回（近零耗时，不进上面的统计）');
table(cert, '⚠ 单列：命中证书库的局面（页面会跳过搜索，这里只作对照）');

const agg = (list, label2) => {
  if (!list.length) return null;
  const o = list.map(r => r.oC.reduce((s, x, i) => s + x, 0) / r.oC.length);
  const n = list.map(r => r.nC.reduce((s, x, i) => s + x, 0) / r.nC.length);
  const d = o.map((x, i) => n[i] - x);
  const mO = med(o), mN = med(n), dM = med(d);
  const floor = mad(d) / mO;
  console.log(`  ${label2}：前中位 ${mO.toFixed(0)}ms → 后中位 ${mN.toFixed(0)}ms　配对差中位 ${dM.toFixed(0)}ms (${(dM / mO * 100).toFixed(1)}%)`);
  console.log(`      地板（配对差 MAD）${(floor * 100).toFixed(1)}%`);
  console.log(`      逐项配对差：${d.map(x => x.toFixed(0)).join(' / ')}`);
  console.log(`      逐项占比  ：${o.map((x, i) => ((n[i] - x) / x * 100).toFixed(0) + '%').join(' / ')}`);
  const pos = d.filter(x => x > 0).length, neg = d.filter(x => x < 0).length;
  console.log(`      更快/更慢：${neg} / ${pos}   非零地板比较：${Math.abs(dM / mO) > floor ? '超出地板' : '**小于地板**'}`);
  return { mO, mN, dM, floor };
};
/* 合计只统计**真的花时间**的项：P3/必胜手那类"威胁阶段就返回"的项耗时 ≈0，
   它们的配对差恒为 0 或 ±5ms，会把中位数和 MAD 一起稀释（上一轮实测地板被抬到 16%）。 */
const MINMS = Number(argOf('min-ms', 50));
const heavy = real.filter(r => med(r.oC) >= MINMS);
console.log(`=== 合计（仅"真的在做搜索"的项：前侧 CPU 中位 ≥ ${MINMS}ms，${heavy.length}/${real.length} 项）===`);
const A1 = agg(heavy, MODE === 'work' ? 'CPU 合计（固定工作量）' : 'CPU 合计（固定实时预算）');
if (heavy.length < real.length) {
  const skip = real.filter(r => med(r.oC) < MINMS);
  console.log(`  （另 ${skip.length} 项前侧耗时 <${MINMS}ms：${skip.map(r => r.t.id + ' ' + med(r.oC).toFixed(0) + 'ms').join('、')}）`);
  console.log('   ⇒ 它们证明"战术/证明阶段也是同一套查表"，但不参与时间合计。');
}
if (imm.length) console.log(`  即时战术项 ${imm.length} 个：CPU 中位 ${med(imm.map(r => med(r.oC))).toFixed(0)}→${med(imm.map(r => med(r.nC))).toFixed(0)}ms（≈0，不计入合计）`);
if (cert.length) console.log(`  证书库命中项 ${cert.length} 个：页面里不会调用搜索（这里只是把它跑了以便对照）`);

if (MODE === 'budget') {
  console.log('\n=== 固定实时预算下的"能力"读数（**不是棋力**）===');
  let up = 0, down = 0, eq = 0;
  for (const r of real) {
    const dO = med(r.oD), dN = med(r.nD);
    if (dN > dO) up++; else if (dN < dO) down++; else eq++;
  }
  console.log(`  completedDepth：更深 ${up} 项／相同 ${eq} 项／更浅 ${down} 项（即时战术项已单列）`);
  /* 固定时间预算下"完成多少工作"的直接读数：同样 CPU 预算内跑完的节点数 */
  const oN = heavy.map(r => med(r.oN)), nN = heavy.map(r => med(r.nN));
  const dN = oN.map((x, i) => nN[i] - x);
  const mON = med(oN), mNN = med(nN), dMN = med(dN);
  const fN = mad(dN) / mON;
  console.log(`  同样预算内完成的节点数：前中位 ${mON} → 后中位 ${mNN}　配对差中位 ${dMN} (${(dMN / mON * 100).toFixed(1)}%)　地板 ${(fN * 100).toFixed(1)}%`);
  console.log(`      逐项占比：${oN.map((x, i) => ((nN[i] - x) / Math.max(1, x) * 100).toFixed(0) + '%').join(' / ')}` +
    `   （更多节点 ≠ 棋力更强；这只是"同样时间里做了多少工作"）`);
  console.log(`      节点更多/更少：${dN.filter(x => x > 0).length} / ${dN.filter(x => x < 0).length}`);
  const pOld = real.filter(r => r.last.old.proof).length, pNew = real.filter(r => r.last.neu.proof).length;
  console.log(`  证明发现（只统计"最后一遍"这一次样本，仅作量级参考）：前 ${pOld} 项／后 ${pNew} 项`);
  const badLegal = rows.filter(r => !r.last.neu.legal && r.last.neu.move).length;
  const badVerify = rows.filter(r => r.last.neu.proof && r.last.neu.proofVerified === false).length;
  console.log(`  走法合法性：${rows.length - badLegal}/${rows.length} 合法${badLegal ? `（✗ ${badLegal} 项非法，必须修）` : ''}` +
    `（含即时战术与证书命中项；两者也都必须给合法走法）`);
  console.log(`  附带证书的证明声明：全部核验${badVerify ? `（✗ ${badVerify} 项不通过）` : '通过'}；` +
    `无附带证书的证胜声明（阶段 1c 只返回走法，需另行按同深度复算才能核验）：${real.filter(r => r.last.neu.proof && r.last.neu.proofVerified === null).length} 项`);
}

if (MODE === 'work') {
  console.log(`\n  固定工作量语义一致性：${bad ? `✗ ${bad} 项不一致 —— 实现优化改变了搜索，必须撤回` : '✓ 全部逐位一致（含即时战术与证书命中项）'}`);
  console.log(`  走法合法性：${rows.filter(r => r.last.neu.legal || !r.last.neu.move).length}/${rows.length}`);
}

/* 墙钟（辅助；负载下只作参考） */
{
  const o = real.map(r => r.oW.reduce((s, x, i) => s + x, 0) / r.oW.length);
  const n = real.map(r => r.nW.reduce((s, x, i) => s + x, 0) / r.nW.length);
  const d = o.map((x, i) => n[i] - x);
  console.log(`\n  墙钟合计（辅助，负载下不可比）：前 ${med(o).toFixed(0)}ms → 后 ${med(n).toFixed(0)}ms，` +
    `配对差中位 ${med(d).toFixed(0)}ms (${(med(d) / med(o) * 100).toFixed(1)}%)`);
}
if (SAME) console.log('\n  ⚠ 本行是 A/A 零假设对照：上面的百分比**就是本仪器的噪声水平**，不是收益。');
console.log('\n  ⚠ 记住口径：实时预算下节点数/走法可以变；"更深/更多节点"不等于"棋力更强"。');
process.exit(MODE === 'work' && bad ? 1 : 0);
