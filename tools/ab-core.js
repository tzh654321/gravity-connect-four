'use strict';
/* ============================================================
   ab-core —— 同一进程内**交替对照两个 solver-core 构建**（改前 vs 改后）

   为什么需要它（两次踩坑换来的）：
   本机有负载时**跨进程墙钟不可比**（未改动的参考核验器在负载期比空载慢 2.7×），
   而且**前几遍含 JIT 编译**，各遍合计会单调下降 —— 那是趋势，不是噪声。
   所以本工具：
     · **同进程**载入两个构建（零依赖，直接 require 两个文件）
     · 每遍内 old/new **紧邻**执行，**奇偶遍反转顺序**（抵消顺序偏差与漂移）
     · **丢弃 1 遍预热**（否则噪声地板被 JIT 趋势抬到 15%+）
     · 同时报**墙钟**与 **CPU 时间**（`process.cpuUsage` 的 user+system 增量，
       不含"等 CPU"的时间 ⇒ 负载下仍可比）
     · 报**中位数 + 逐遍配对差中位数**；噪声地板给两种口径，
       并以**配对差自身的地板**为准（配对设计下这才是正确标尺；实测可降到 1~2%）
     · 顺手断言两个构建的 `status / nodes / successors / expansions / keys / ws / ttHits / pn / dn`
       **逐位一致**（实现优化不许改变语义 —— 这是硬门槛，不一致直接退出码 1）

   用法：
     # 先把"改动前"的副本取出来（零依赖，直接 require）
     git show HEAD:tools/solver-core.js > /tmp/old-core.js

     node tools/ab-core.js --old /tmp/old-core.js
     node tools/ab-core.js --old /tmp/old-core.js --reps 5 --tier release
     node tools/ab-core.js --old /tmp/old-core.js --tasks hz3-refute-n16-a,hz6-pair-n14

   ⚠ 只选**预算内可确定完成**的任务：时间盒任务两版做的功不同 ⇒ 不可比（工具会拒绝）。
   ⚠ `--reps` 建议 ≥4（默认 5）：偶数的中位数取偏小那侧，遍数太少时预热残留会漏进来
     （打印了各遍差值，可自行核对）。 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

const CORE_NEW = require('./solver-core');
const OLD_PATH = argOf('old', null);
if (!OLD_PATH) { console.error('用法：node tools/ab-core.js --old <改动前的 solver-core 副本> [--reps 5] [--tier release] [--tasks id1,id2]'); process.exit(1); }
const CORE_OLD = require(path.resolve(OLD_PATH));

const SUITE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'bench-horizon.json'), 'utf8'));
const PLY4 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'bounded-ply4.json'), 'utf8'));
const TIER = argOf('tier', 'release');
const REPS = Math.max(2, Number(argOf('reps', 5)));
const ids = argOf('tasks', 'hz3-refute-n16-a,hz6-pair-n14,hz1-win-n9').split(',').map(s => s.trim());

const after = mv => { const p = new CORE_NEW.Position(PLY4.board); const u = p.play(mv, 1); const b = [...p.board]; p.undo(u); return b; };
const CASES = ids.map(id => {
  const t = SUITE.tasks.find(x => x.id === id);
  if (!t) throw new Error(`bench-horizon.json 里没有任务 ${id}`);
  if (t.budgetCapped || t.verify === 'none' || !(t.maxPlies > 0)) {
    throw new Error(`任务 ${id} 是时间盒/未知任务 ⇒ 两版做的功不同，不可比（请选预算内可确定完成的任务）`);
  }
  const b = t.budget[TIER];
  return { id, board: after(t.ply4Move), a: t.attacker, P: t.maxPlies, N: b.maxNodes, T: b.timeMs };
});

const med = a => { const s = [...a].sort((x, y) => x - y); return s[(s.length - 1) >> 1]; };
const mad = a => { const m = med(a); return med(a.map(x => Math.abs(x - m))); };
const wall = t => Number(process.hrtime.bigint() - t) / 1e6;
const cpu = c => (c.user + c.system) / 1000;      // µs → ms

console.log(`ab-core：同进程交替对照（前 = ${path.relative(process.cwd(), OLD_PATH)}，后 = tools/solver-core.js）`);
console.log(`  档位 ${TIER}｜预热 1 遍丢弃 + ${REPS} 遍测量｜每遍内 old/new 紧邻、奇偶遍反转顺序\n`);

const acc = {}; for (const c of CASES) acc[c.id] = { oC: [], nC: [], oW: [], nW: [], nodes: 0 };
let bad = 0;
const totC = [], totW = [];

for (let rep = 0; rep <= REPS; rep++) {
  const flip = rep % 2 === 1;
  const rC = [], rW = [];
  for (const c of CASES) {
    const opts = { maxPlies: c.P, maxNodes: c.N, timeMs: c.T, order: 'none', diag: true };
    const go = CORE => {
      const c0 = process.cpuUsage(), t0 = process.hrtime.bigint();
      const r = CORE.dfpnSearch(c.board, c.a, Object.assign({}, opts, { boundCache: CORE.createBoundCache() }));
      const W = wall(t0), C = cpu(process.cpuUsage(c0));
      r.proof = null;
      return { W, C, r };
    };
    const A = flip ? go(CORE_NEW) : go(CORE_OLD);
    const B = flip ? go(CORE_OLD) : go(CORE_NEW);
    const o = flip ? B : A, n = flip ? A : B;
    const same = n.r.status === o.r.status && n.r.nodes === o.r.nodes && n.r.successors === o.r.successors
      && n.r.expansions === o.r.expansions && n.r.stateKeys === o.r.stateKeys && n.r.winScans === o.r.winScans
      && n.r.ttHits === o.r.ttHits && n.r.pn === o.r.pn && n.r.dn === o.r.dn;
    if (!same) { bad++; console.log(`  ✗ ${c.id} 第 ${rep} 遍（0=预热）语义不一致：` +
      `status ${o.r.status}/${n.r.status} nodes ${o.r.nodes}/${n.r.nodes} pn ${o.r.pn}/${n.r.pn} dn ${o.r.dn}/${n.r.dn}`); }
    rC.push([o.C, n.C]); rW.push([o.W, n.W]);
    if (rep > 0) { const a = acc[c.id]; a.oC.push(o.C); a.nC.push(n.C); a.oW.push(o.W); a.nW.push(n.W); a.nodes = n.r.nodes; }
    process.stdout.write(rep === 0 ? 'W' : '.');
  }
  if (rep > 0) {
    totC.push([rC.reduce((s, x) => s + x[0], 0), rC.reduce((s, x) => s + x[1], 0)]);
    totW.push([rW.reduce((s, x) => s + x[0], 0), rW.reduce((s, x) => s + x[1], 0)]);
  }
}

console.log('\n\n  ' + '任务'.padEnd(22) + '节点'.padStart(9) + '  CPU 前→后（配对差中位）'.padEnd(44) + '  语义');
for (const c of CASES) {
  const a = acc[c.id];
  const d = a.oC.map((x, i) => a.nC[i] - x);
  const mO = med(a.oC), mN = med(a.nC), dM = med(d);
  console.log('  ' + c.id.padEnd(20) + String(a.nodes).padStart(9) + '  ' +
    `${mO.toFixed(0)}→${mN.toFixed(0)}ms  Δ${dM.toFixed(0)}ms (${(dM / mO * 100).toFixed(1)}%)  加速 ${(mO / mN).toFixed(3)}×`.padEnd(44) +
    '  ' + (bad ? '✗' : '✓ 逐位一致'));
}

const agg = (rows, label) => {
  const o = rows.map(x => x[0]), n = rows.map(x => x[1]);
  const d = o.map((x, i) => n[i] - x);
  const mO = med(o), mN = med(n), dM = med(d);
  const floorPair = mad(d) / mO, floorRaw = mad(o) / mO;
  console.log(`  ${label}：前中位 ${mO.toFixed(0)}ms → 后中位 ${mN.toFixed(0)}ms　配对差中位 ${dM.toFixed(0)}ms ` +
    `(${(dM / mO * 100).toFixed(1)}%)　加速 ${(mO / mN).toFixed(3)}×`);
  console.log(`      各遍差值 ${d.map(x => x.toFixed(0)).join(' / ')}`);
  console.log(`      地板：配对差 ${(floorPair * 100).toFixed(1)}%（原始 ${(floorRaw * 100).toFixed(1)}%）⇒ ` +
    (Math.abs(dM / mO) > floorPair ? '**超出地板，收益确认**' : '**小于地板，收益未确认**'));
};

console.log('');
agg(totC, 'CPU 合计 ');
agg(totW, '墙钟合计');
console.log(`\n  语义一致性：${bad ? `✗ ${bad} 处不一致 —— 实现优化改变了搜索，必须撤回` :
  '✓ 全部 status/nodes/successors/expansions/keys/ws/ttHits/pn/dn 逐位一致'}`);
console.log('  ⚠ 判据用**配对差**（同进程、紧邻、顺序反转）；跨进程墙钟在本机负载下不可比。');
process.exit(bad ? 1 : 0);
