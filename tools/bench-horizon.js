'use strict';
/* ============================================================
   bench-horizon —— **大 horizon 固定基准**的运行器（P10）

   目的（按评审）：把当前瓶颈**固定**下来，好选出下一项值得优化的搜索成本 ——
   **不是**再建一套评测系统。因此这里刻意做薄：
     · 不新增搜索算法，不改排序（固定 order='none'）
     · 任务集很小（10 个），全部复用已有材料（bounded-ply4 / bench-suite / bench-other-games）
     · 每个任务在 fixtures/bench-horizon.json 里带**完整命题**（规则版本 / 规范棋盘+行棋方 /
       攻击方 / 有界或无界 / horizon 计数起点 / 预算 / 缓存条件 / 预期结论的**独立依据**）
     · 未知任务固定预算、**不强行求解**，且两档都不放大其预算（预算即命题）

   两个预算档：
     --tier common   改动后日常运行（固定节点上限为主，时间/内存作保险）
     --tier release  少量关键大任务（较大固定预算，默认**双核验**）

   分开计时（评审要求）：搜索 / 证书导出 / 快速核验 / 参考核验 / JSON 读取解析。
   ⚠ 计入合计的只有「**预算内完成**」的任务；时间或内存保险触发的任务**单列**，
     不参与任何可比合计（沿用 P8 已固定的口径）。

   用法：
     node tools/bench-horizon.js                       # 常用档
     node tools/bench-horizon.js --tier release        # 发布档（含参考核验）
     node tools/bench-horizon.js --only hz3,hz4        # 只跑指定任务
     node tools/bench-horizon.js --double              # 常用档也做双核验
     node tools/bench-horizon.js --explain             # 打印每个任务的完整命题
     node tools/bench-horizon.js --pin                 # 把计算出的规范键写回夹具（首次）
   ============================================================ */
const fs = require('fs');
const path = require('path');
const CORE = require('./solver-core');
const VS = require('./verify-strategy');          // 慢速参考核验器（正确性基准）
const F = require('./verify-strategy-fast');      // 快速核验器

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const has = n => argv.includes('--' + n);

const TIER = argOf('tier', 'common');
const ONLY = argOf('only', null);
const DOUBLE = has('double') || TIER === 'release';
const PIN = has('pin');
const EXPLAIN = has('explain');

const FILE = path.join(__dirname, 'fixtures', 'bench-horizon.json');
const t0json = process.hrtime.bigint();
const SUITE = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const jsonMs = Number(process.hrtime.bigint() - t0json) / 1e6;
/* 内存保险（可覆盖，便于演练该机制）：**安全阀**，不是预算 —— 正常运行不该触发；
   触发的任务按"内存保险中止"**单列**，并停止后续任务。 */
const MEM_MB = Number(argOf('memMB', (SUITE.tiers[TIER] && SUITE.tiers[TIER].memMB) || 4096));

const PLY4 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'bounded-ply4.json'), 'utf8'));

let fails = 0;
const bad = m => { fails++; console.log('  ✗ ' + m); };
const ms = t0 => Number(process.hrtime.bigint() - t0) / 1e6;

/* ------------------------------------------------------------ 命题固定 */

function boardOf(t) {
  if (t.ply4Move) {
    const p = new CORE.Position(PLY4.board);
    const u = p.play(t.ply4Move, 1);
    const b = [...p.board];
    p.undo(u);
    return b;
  }
  if (t.board) { new CORE.Position(t.board); return t.board; }   // 顺带做一次合法性校验
  throw new Error(`任务 ${t.id} 既没有 ply4Move 也没有 board`);
}
const sideOf = board => ((board.length - 1) % 2 === 0) ? 1 : 2;

console.log('大 horizon 固定基准（P10）');
console.log(`  套件 ${path.relative(process.cwd(), FILE)}  档位 ${TIER}  规则版本 ${SUITE.ruleVersion}`);
console.log(`  ${TIER === 'release' ? '**发布档**：默认双核验（快速 + 参考）' : '常用档：默认只快速核验（--double 可强制双核验）'}`);
console.log(`  JSON 读取 + 解析：${jsonMs.toFixed(0)}ms（两类核验器都要付，不计入下表）\n`);

console.log('=== 命题固定核对（行棋方 + 四旋转规范键）===');
const tasks = [];
for (const t of SUITE.tasks) {
  if (ONLY && !ONLY.split(',').some(x => t.id === x.trim())) continue;
  let board;
  try { board = boardOf(t); } catch (e) { bad(`${t.id} 局面构造失败：${e.message}`); continue; }
  const sd = sideOf(board);
  if (sd !== t.sideToMove) bad(`${t.id} 行棋方不符：夹具记 P${t.sideToMove}，按棋子数推得 P${sd}`);
  const ck = CORE.boardCanonKey(board);
  if (t.canonicalKey == null) {
    if (PIN) { t.canonicalKey = ck; console.log(`  ${t.id.padEnd(22)} 规范键 ${ck}  **已写入**`); }
    else console.log(`  ${t.id.padEnd(22)} 规范键 ${ck}  （夹具未固定，用 --pin 固化）`);
  } else if (t.canonicalKey !== ck) {
    bad(`${t.id} 规范键**变了**：夹具 ${t.canonicalKey} ≠ 实算 ${ck}`);
  } else {
    console.log(`  ${t.id.padEnd(22)} 规范键 ${ck}  ✓ 与夹具一致（P${sd}，${board.length} 子）`);
  }
  tasks.push({ t, board });
}
if (PIN) {
  fs.writeFileSync(FILE, JSON.stringify(SUITE, null, 1) + '\n');
  console.log(`  （已把规范键写回 ${path.relative(process.cwd(), FILE)}；重跑一次确认核对通过）`);
  process.exit(fails ? 1 : 0);
}

/* ------------------------------------------------------------ 运行与核验 */

function budgetOf(t) {
  const b = (t.budget && t.budget[TIER]) || null;
  if (!b) throw new Error(`任务 ${t.id} 缺少 ${TIER} 档预算`);
  return b;
}

function verifyOne(t, board, r) {
  const out = { fast: null, ref: null, msFast: 0, msRef: 0 };
  if (t.verify === 'none' || r.status === 'unknown') return out;
  if (r.status === 'proven-win') {
    if (!r.proof) { bad(`${t.id} 声称 proven-win 却没有策略树`); return out; }
    let s = process.hrtime.bigint();
    out.fast = F.verifyFast(board, t.attacker, r.proof.tree);
    out.msFast = ms(s);
    if (DOUBLE) {
      s = process.hrtime.bigint();
      out.ref = VS.verify(board, t.attacker, r.proof.tree);
      out.msRef = ms(s);
    }
  } else if (r.status === 'refuted') {
    if (!r.proof) { console.log(`      （${t.id} 无界 refuted ⇒ 按定义不出证书，跳过核验）`); return out; }
    let s = process.hrtime.bigint();
    out.fast = F.verifyRefutationFast(board, t.attacker, r.proof);
    out.msFast = ms(s);
    if (DOUBLE) {
      s = process.hrtime.bigint();
      out.ref = VS.verifyRefutation(board, t.attacker, r.proof);
      out.msRef = ms(s);
    }
  }
  if (out.fast && !out.fast.ok) bad(`${t.id} 快速核验失败：${out.fast.reason}`);
  if (out.ref && !out.ref.ok) bad(`${t.id} **参考核验**失败：${out.ref.reason}`);
  if (out.fast && out.ref && (out.fast.ok !== out.ref.ok || out.fast.reason !== out.ref.reason)) {
    bad(`${t.id} 两类核验器结论不一致`);
  }
  return out;
}

const rows = [];
if (tasks.length) {
  console.log('\n=== 逐任务（计时：搜索 / 导出 / 快速核验 / 参考核验）===');
  console.log('  ' + 'id'.padEnd(22) + 'status'.padEnd(11) + 'nodes'.padStart(9) + 'succ'.padStart(9) +
    'exp'.padStart(8) + 'keys'.padStart(9) + 'ws'.padStart(9) + 'ttHit'.padStart(8) +
    'msSearch'.padStart(10) + 'msExt'.padStart(8) + 'msFast'.padStart(8) + 'msRef'.padStart(8) + '  预算');
  for (const { t, board } of tasks) {
    const b = budgetOf(t);
    const heap0 = process.memoryUsage().heapUsed;
    const s = process.hrtime.bigint();
    const r = CORE.dfpnSearch(board, t.attacker, {
      maxPlies: t.maxPlies, maxNodes: b.maxNodes, timeMs: b.timeMs,
      boundCache: CORE.createBoundCache(), order: 'none', diag: true
    });
    const msSearch = ms(s);
    const heap = process.memoryUsage().heapUsed - heap0;
    const heapAbs = process.memoryUsage().heapUsed;
    const v = verifyOne(t, board, r);
    const interrupted = r.timedOut || r.nodeLimit;
    const memCapped = heapAbs > MEM_MB * 1048576;
    const capped = interrupted || !!t.budgetCapped || memCapped;
    console.log('  ' + t.id.padEnd(20) + r.status.padEnd(11) + String(r.nodes).padStart(9) +
      String(r.successors).padStart(9) + String(r.expansions).padStart(8) +
      String(r.stateKeys).padStart(9) + String(r.winScans).padStart(9) + String(r.ttHits).padStart(8) +
      String(msSearch.toFixed(0)).padStart(10) +
      String((r.msExtract || 0).toFixed(0)).padStart(8) +
      String(v.msFast ? v.msFast.toFixed(1) : '-').padStart(8) +
      String(v.msRef ? v.msRef.toFixed(1) : '-').padStart(8) +
      '  ' + (memCapped ? `**内存保险**（堆 ${(heapAbs / 1048576).toFixed(0)}MB > ${MEM_MB}MB）`
        : interrupted ? (r.nodeLimit ? '节点上限' : '时间盒') : '完成') +
      (t.budgetCapped ? '/设计内未知' : ''));
    if (EXPLAIN || (t.expect != null && r.status !== t.expect && !capped)) {
      console.log(`      命题：P${t.attacker} 能否在 ≤${t.maxPlies || '∞'} 半回合内强制连四｜${t.horizonOrigin}`);
      console.log(`      预期依据：${t.expectBasis || '（无先验，不预设）'}`);
    }
    if (t.expect != null && r.status !== t.expect && !capped) {
      bad(`${t.id} 结论 ${r.status} ≠ 预期 ${t.expect}（依据：${t.expectBasis}）`);
    }
    rows.push({ t, r, msSearch, heap, heapAbs, v, interrupted, capped, memCapped });
    r.proof = null;                       // 验完就丢，避免证书累积影响后续任务的内存读数
    if (memCapped) {
      console.log(`      ⇒ 内存保险触发，**停止后续任务**（防跑飞）。要演练/调整用 --memMB；` +
        `真正的硬上限需要 node --max-old-space-size=${MEM_MB}`);
      break;
    }
  }
}

/* ------------------------------------------------------------ 汇总 */

const done = rows.filter(x => !x.capped);
const unk = rows.filter(x => x.capped);
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[(s.length - 1) >> 1] : 0; };

console.log('\n=== 汇总（**只含预算内完成的任务**）===');
if (!done.length) console.log('  （没有完成的非常规任务；见下面的单列）');
else {
  const S = sum(done, x => x.msSearch), E = sum(done, x => x.r.msExtract || 0);
  const FF = sum(done, x => x.v.msFast), RR = sum(done, x => x.v.msRef);
  const N = sum(done, x => x.r.nodes), SU = sum(done, x => x.r.successors);
  console.log(`  完成 ${done.length}/${rows.length} 个｜节点 ${N}｜后继 ${SU}｜平均分支 ${(SU / Math.max(1, sum(done, x => x.r.expansions))).toFixed(2)}`);
  console.log(`  合计 搜索 ${S.toFixed(0)}ms  证书导出 ${E.toFixed(0)}ms  快速核验 ${FF.toFixed(1)}ms` +
    (DOUBLE ? `  参考核验 ${RR.toFixed(0)}ms` : '  （未跑参考核验）'));
  if (DOUBLE && RR > 0) {
    const endRef = S + E + RR + jsonMs, endFast = S + E + FF + jsonMs;
    console.log(`  端到端（搜索+导出+核验+JSON）：用参考核验 ${endRef.toFixed(0)}ms → 用快速核验 ${endFast.toFixed(0)}ms` +
      `（−${((1 - endFast / endRef) * 100).toFixed(1)}%）`);
    console.log(`  ⚠ 这是**端到端**口径：核验器自身加速 ${(RR / Math.max(1e-9, FF)).toFixed(1)}×，` +
      `但核验只占端到端 ${(RR / endRef * 100).toFixed(1)}% ⇒ 不要用"核验 15×"代表整条流水线。`);
  }
  console.log(`  每节点：搜索 ${(S * 1000 / Math.max(1, N)).toFixed(2)}µs/节点`);
  const peakAbs = Math.max(...rows.map(x => x.heapAbs)) / 1048576;
  const fired = rows.filter(x => x.memCapped);
  console.log(`  内存：绝对堆峰值 ${peakAbs.toFixed(0)}MB vs 保险 ${MEM_MB}MB ⇒ ` +
    (fired.length ? `**触发**（${fired.map(x => x.t.id).join('、')}）` : '未触发'));
  console.log(`       各任务堆增量最大 ${(Math.max(...rows.map(x => x.heap)) / 1048576).toFixed(0)}MB` +
    `（受 GC 时机影响，只作量级参考）`);
}

if (unk.length) {
  console.log(`\n=== 单列：预算受限 / 内存保险 / 设计内未知（${unk.length} 个）—— 只记资源，**不进可比合计、不按 pn 大小判优** ===`);
  for (const x of unk) {
    const why = x.memCapped ? `内存保险中止（堆 ${(x.heapAbs / 1048576).toFixed(0)}MB > ${MEM_MB}MB）`
      : x.interrupted ? (x.r.nodeLimit ? '节点上限触发' : '时间盒触发')
        : '设计内未知（预算即命题）';
    console.log(`  ${x.t.id.padEnd(22)} ${x.r.status.padEnd(9)} nodes=${String(x.r.nodes).padStart(8)} ` +
      `ms=${x.msSearch.toFixed(0).padStart(6)}  ${why}` +
      (x.r.status !== 'unknown' ? `  ⚠ 竟已得出结论 ${x.r.status}` : ''));
  }
}
const notRun = tasks.length - rows.length;
if (notRun > 0) {
  console.log(`  （另有 ${notRun} 个任务因内存保险触发而**未运行**：` +
    `${tasks.slice(rows.length).map(x => x.t.id).join('、')}）`);
}

/* ------------------------------------------------------------ 计数比率（只读剖析） */

console.log('\n=== 只读计数比率（用于解释成本结构；不需要计时器进热路径）===');
console.log(`  口径：\`keys\` = nodeAt 调用次数（= 规范化键 + 终局判定，每节点一次）；`);
console.log(`        \`ws\`   = 走到「双方即时胜点一次遍历」的节点数（非终点节点）；`);
console.log(`        \`exp\`  = 展开节点数（每个展开生成全部合法后继）；\`succ\` = 生成的后继总数。`);
const all = rows.filter(x => x.r.stateKeys);
if (all.length) {
  const K = sum(all, x => x.r.stateKeys), W = sum(all, x => x.r.winScans), X = sum(all, x => x.r.expansions);
  const SU = sum(all, x => x.r.successors), TT = sum(all, x => x.r.ttHits), ND = sum(all, x => x.r.nodes);
  const avgBranch = SU / Math.max(1, X);
  console.log(`  合计：keys ${K}｜ws ${W}（${(W / Math.max(1, K) * 100).toFixed(1)}% 的访问走到胜点遍历）｜` +
    `exp ${X}｜succ ${SU}｜平均分支 ${avgBranch.toFixed(2)}｜ttHit ${TT}（${(TT / Math.max(1, K) * 100).toFixed(1)}% 的 keys 命中）`);
  console.log(`  由此可推**每次访问的常数工作量**（估算，目的只是定位量级）：`);
  console.log(`    · 规范化键 p.signature()：${K} 次（= keys，每访问一次算一遍，**不缓存**）`);
  console.log(`    · p.moves() 重建：${W + X} 次（nodeAt 里 ${W} 次 + expand 里 ${X} 次 ⇒ **每展开节点算两遍**）`);
  console.log(`    · p.line() 调用：≈ 2 × ws × 平均分支 = ${(2 * W * avgBranch).toFixed(0)} 次` +
    `（nodeAt 对**每个合法落点**调 attacker/对手各一次）`);
  console.log(`    · play/undo：${SU} 次落子`);
  console.log(`  ⇒ 需要采样剖析确认哪一个真正占墙钟（下一步用 tools/profile-search.js，**不带计时器**）。`);
}

console.log('\n' + (fails ? `大 horizon 基准：失败 ${fails} 项` : '大 horizon 基准：全部通过（命题核对 + 结论与依据一致 + 核验通过）'));
process.exit(fails ? 1 : 0);
