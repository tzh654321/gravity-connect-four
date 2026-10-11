'use strict';
/* ============================================================
   profile-search —— 搜索器的**只读**采样剖析（P10）

   目的（按评审）：找出搜索器究竟在**重复什么**，为"下一项只做一件事"提供依据。
   三条纪律：

     ① **不带计时器**进热路径。这里用的是 V8 自带的**采样剖析器**（`node:inspector`
        的 `Profiler`），只按固定间隔抽样调用栈 ⇒ 不改被测代码、不加计时开销。
     ② **带剖析运行只用于解释，不带剖析运行才用于性能比较**。本工具打印的墙钟受采样器
        影响（会明显变慢），**不能**当性能数字；性能请用 `tools/bench-horizon.js`。
     ③ 计数（`keys` / `ws` / `exp` / `succ`）来自搜索器**本来就有的纯诊断字段**，
        与剖析分开打印，避免把"计数"误当"耗时"。

   用法：
     node tools/profile-search.js                          # 默认剖析 hz3-refute-n16-a
     node tools/profile-search.js --task hz6-pair-n14
     node tools/profile-search.js --task hz4-refute-n16-b --interval 200 --reps 2
     node tools/profile-search.js --top 25
   ============================================================ */
const fs = require('fs');
const path = require('path');
const inspector = require('node:inspector');
const CORE = require('./solver-core');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const TASK = argOf('task', 'hz3-refute-n16-a');
const TIER = argOf('tier', 'release');
const INTERVAL = Number(argOf('interval', 100));      // µs
const REPS = Math.max(1, Number(argOf('reps', 1)));
const TOP = Number(argOf('top', 18));

const SUITE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'bench-horizon.json'), 'utf8'));
const t = SUITE.tasks.find(x => x.id === TASK);
if (!t) { console.error(`夹具里没有任务 ${TASK}`); process.exit(1); }

const PLY4 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'bounded-ply4.json'), 'utf8'));
const board = (() => {
  if (t.ply4Move) { const p = new CORE.Position(PLY4.board); const u = p.play(t.ply4Move, 1); const b = [...p.board]; p.undo(u); return b; }
  return t.board;
})();
const b = t.budget[TIER];
const opts = {
  maxPlies: t.maxPlies, maxNodes: b.maxNodes, timeMs: b.timeMs,
  boundCache: CORE.createBoundCache(), order: 'none', diag: true
};

const session = new inspector.Session();
const post = (m, p) => new Promise((res, rej) =>
  session.post(m, p, (e, r) => (e ? rej(e) : res(r))));

console.log('搜索器只读采样剖析（不改被测代码、不加计时器）');
console.log(`  任务 ${t.id}｜P${t.attacker} 能否在 ≤${t.maxPlies || '∞'} 半回合内强制连四｜档位 ${TIER}`);
console.log(`  预算 maxNodes=${b.maxNodes} timeMs=${b.timeMs}｜采样间隔 ${INTERVAL}µs｜重复 ${REPS} 遍\n`);

/* ---- 第一段：不剖析，拿计数与（参考用）墙钟 ---- */
const t0 = process.hrtime.bigint();
let r = null;
for (let i = 0; i < REPS; i++) {
  r = CORE.dfpnSearch(board, t.attacker, Object.assign({}, opts, { boundCache: CORE.createBoundCache() }));
}
const plainMs = Number(process.hrtime.bigint() - t0) / 1e6 / REPS;
console.log('=== 不带剖析（性能数字看这一段）===');
console.log(`  status=${r.status}  nodes=${r.nodes}  exp=${r.expansions}  succ=${r.successors}  keys=${r.stateKeys}  ws=${r.winScans}`);
console.log(`  ttHit=${r.ttHits}  iters=${r.iters}  maxDepth=${r.maxDepth}  msExtract=${r.msExtract}`);
console.log(`  墙钟 ${plainMs.toFixed(0)}ms（${(plainMs * 1000 / Math.max(1, r.nodes)).toFixed(2)}µs/节点）` +
  `　⚠ 本机墙钟抖动可达 ±20%，只作数量级参考`);
const branch = r.successors / Math.max(1, r.expansions);
console.log(`  每次访问的常数工作量（估算）：signature（规范化键）${r.stateKeys} 次｜` +
  `moves() 重建 ${r.winScans + r.expansions} 次（nodeAt ${r.winScans} + expand ${r.expansions}）｜` +
  `line() ≈ ${Math.round(2 * r.winScans * branch)} 次｜play ${r.successors} 次`);
const plain = { nodes: r.nodes, exp: r.expansions, succ: r.successors, keys: r.stateKeys, ws: r.winScans, branch, ms: plainMs };
r.proof = null;

/* ---- 第二段：采样剖析（只用于解释）---- */
session.connect();

(async () => {
  await post('Profiler.enable');
  await post('Profiler.setSamplingInterval', { interval: INTERVAL });
  await post('Profiler.start');
  for (let i = 0; i < REPS; i++) {
    // 剖析期间丢弃结果，只关心时间分布
    CORE.dfpnSearch(board, t.attacker, Object.assign({}, opts, { boundCache: CORE.createBoundCache() }));
  }
  const { profile } = await post('Profiler.stop');
  session.disconnect();

  /* 自带时间聚合：每个样本归属一个 nodeId，样本的耗时由 timeDeltas 给出 */
  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n.callFrame);
  const self = new Map();                 // "fn @ file:line" -> µs
  let total = 0;
  const samples = profile.samples || [], deltas = profile.timeDeltas || [];
  for (let i = 0; i < samples.length; i++) {
    const dt = deltas[i] || (INTERVAL * 1000);     // µs（timeDeltas 就是 µs）
    total += dt;
    const cf = byId.get(samples[i]);
    if (!cf) continue;
    const file = (cf.url || '').split(/[\\/]/).pop() || '(vm)';
    const key = `${cf.functionName || '(anonymous)'} @ ${file}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + dt);
  }
  const rows = [...self.entries()].sort((a, b) => b[1] - a[1]);

  console.log(`\n=== 采样剖析（**只用于解释**；样本 ${samples.length}，覆盖 ` +
    `${(total / 1000).toFixed(0)}ms，采样器会明显拖慢运行）===`);
  console.log('  ' + '自耗时'.padStart(9) + '占比'.padStart(8) + '  函数 @ 文件:行');
  for (const [k, v] of rows.slice(0, TOP)) {
    console.log('  ' + (v / 1000).toFixed(0).padStart(7) + 'ms' + (v / total * 100).toFixed(1).padStart(7) + '%' + '  ' + k);
  }

  /* 按文件汇总，回答"核心 / 核验器 / 其它各占多少" */
  const byFile = new Map();
  for (const [k, v] of rows) {
    const f = k.slice(k.lastIndexOf('@ ') + 2).split(':').slice(0, -1).join(':') || '(vm)';
    byFile.set(f, (byFile.get(f) || 0) + v);
  }
  console.log('\n  按文件汇总（自耗时）：');
  for (const [f, v] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log('    ' + f.padEnd(24) + (v / 1000).toFixed(0).padStart(7) + 'ms  ' + (v / total * 100).toFixed(1) + '%');
  }

  /* 把"每次访问的常数工作量"折算成占比，便于和"展开量"对比 */
  console.log('\n  === 判据对照（供挑选"下一项只做一件事"）===');
  console.log(`    展开量：exp=${plain.exp} 节点，succ=${plain.succ} 后继（平均分支 ${plain.branch.toFixed(2)}）`);
  console.log(`    每次访问的常数：signature ${plain.keys}｜moves() ${plain.ws + plain.exp}｜line() ≈ ${Math.round(2 * plain.ws * plain.branch)}`);
  console.log(`    ⇒ 若上面\n       · \`signature\`/\`canonical\`/\`sort\`/\`join\` 排在前列 ⇒ 是**状态键**的常数成本；`);
  console.log(`       · \`line\` 排在前列 ⇒ 是**胜点扫描**（对每个合法落点各判一次）；`);
  console.log(`       · \`moves\`/\`point\` 排在前列 ⇒ 是**落点集合重建**（每展开节点算两遍）；`);
  console.log(`       · \`play\`/\`undo\`/\`addNeighbors\` 主导且 exp 很大 ⇒ 主要是**展开量**本身，不是常数。`);
})().catch(e => { console.error(e); process.exit(1); });
