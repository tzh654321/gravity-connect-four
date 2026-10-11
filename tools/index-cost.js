'use strict';
/* ============================================================
   index-cost —— 数值查询索引（`Map<x, Map<y, owner>>`）的**构造/维护次数**与**内存**

   目的：把"查询变便宜"换成另一套成本（索引构造、维护、内存）时，必须把后三者量出来，
   否则只看搜索总时间就分不清是赚了还是只是把成本挪了地方。

   两段：
     ① 计数（默认做）：用**原型包装**统计
          · `at()` 调用次数（查询量）
          · `_idxSet` / `_idxDel` 调用次数（索引写入量 = 构造 + 维护）
          · `play` / `undo` 调用次数（维护时机的实际发生次数）
          · `Position` 构造次数（外部构造；`pnsSearch` 的 `mkPos` 走 `Object.create`，另用
            `_idxSet` 计数反映）
        ⚠ 包装只为**计数**，不用于性能比较（包装本身有开销）。
     ② 内存（`--mem`，需 `--expose-gc`）：两种构建（`--old`）各跑一次同一个任务，
        gc 后读 `heapUsed`；再正反两个顺序各测一次以抵消顺序偏差。
        ⚠ 索引只挂在**一个** `rootPos` 上（df-pn 是"一块棋盘 + play/undo"），
          所以它对搜索内存的贡献应当很小 —— 这里就是把"应当"变成数字。

   用法：
     node tools/index-cost.js
     node tools/index-cost.js --tasks hz1-win-n9
     node --expose-gc tools/index-cost.js --old tools/tmp-core-base.js --mem
   ============================================================ */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

const CORE = require('./solver-core');
const SUITE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'bench-horizon.json'), 'utf8'));
const PLY4 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'bounded-ply4.json'), 'utf8'));
const after = mv => { const p = new CORE.Position(PLY4.board); const u = p.play(mv, 1); const b = [...p.board]; p.undo(u); return b; };
const boardOf = t => t.ply4Move ? after(t.ply4Move) : t.board;

const ids = argOf('tasks', 'hz3-refute-n16-a,hz1-win-n9').split(',').map(s => s.trim());
const TIER = argOf('tier', 'common');

/* ---------------- ① 计数 ---------------- */
console.log(`index-cost：后端 = ${CORE.AT_BACKEND}（` +
  (CORE.AT_BACKEND === 'cols' ? '数值双层 Map' : '字符串（对照）') + `）\n`);
console.log('  ① 构造 / 维护 / 查询次数（原型包装计数；仅供量级，不作性能结论）');
console.log('  ' + '任务'.padEnd(22) + '节点'.padStart(9) + 'at()'.padStart(13) +
  '_idxSet'.padStart(11) + '_idxDel'.padStart(10) + 'play'.padStart(10) + 'undo'.padStart(10) +
  'Position'.padStart(10) + '  写入/节点');
const cnt = { at: 0, set: 0, del: 0, play: 0, undo: 0, ctor: 0 };
if (CORE.AT_BACKEND === 'cols') {
  const P = CORE.Position.prototype;
  const wrap = (name, key) => {
    const orig = P[name];
    P[name] = function (...a) { cnt[key]++; return orig.apply(this, a); };
  };
  wrap('at', 'at');
  wrap('_idxSet', 'set');
  wrap('_idxDel', 'del');
  wrap('play', 'play');
  wrap('undo', 'undo');
  const OC = CORE.Position;
  // 构造计数：把导出的 Position 换成一个计数包装（内部 `new Position` 用的是闭包里的原名，
  //  所以这里只能数"外部注入棋盘"的次数 —— 它在一次搜索里就是 1 次）
  CORE.Position = function (...a) { cnt.ctor++; return new OC(...a); };
} else {
  // 对照后端：`_idxSet/_idxDel` 已被置空，只能数 at/play/undo
  const P = CORE.Position.prototype;
  const wrap = (name, key) => { const orig = P[name]; P[name] = function (...a) { cnt[key]++; return orig.apply(this, a); }; };
  wrap('at', 'at'); wrap('play', 'play'); wrap('undo', 'undo');
}
for (const id of ids) {
  const t = SUITE.tasks.find(x => x.id === id);
  const b = t.budget[TIER];
  const before = { ...cnt };
  const r = CORE.dfpnSearch(boardOf(t), t.attacker, {
    maxPlies: t.maxPlies, maxNodes: b.maxNodes, timeMs: b.timeMs, order: 'none', diag: true,
    boundCache: CORE.createBoundCache(),
  });
  const d = k => cnt[k] - before[k];
  const writes = d('set') + d('del');
  console.log('  ' + id.padEnd(20) + String(r.nodes).padStart(9) + String(d('at')).padStart(13) +
    String(d('set')).padStart(11) + String(d('del')).padStart(10) + String(d('play')).padStart(10) +
    String(d('undo')).padStart(10) + (CORE.AT_BACKEND === 'cols' ? String(d('ctor')).padStart(10) : '         -') +
    '  ' + (r.nodes ? (writes / r.nodes).toFixed(3) : '-'));
  r.proof = null;
}
console.log('\n  ⇒ 索引写入量 ≈ 2 × 落子数（落一次 `_idxSet`、撤一次 `_idxDel`），' +
  '与"搜索节点数"无关 —— df-pn 只在一块棋盘上 play/undo，索引**构造只发生一次**。');

/* ---------------- ② 内存 ---------------- */
if (argv.includes('--mem')) {
  if (typeof global.gc !== 'function') {
    console.log('\n  ② 内存：跳过（需要 `node --expose-gc`）');
  } else {
    const OLD = argOf('old', null);
    const CORE_OLD = OLD ? require(path.resolve(OLD)) : null;
    const t = SUITE.tasks.find(x => x.id === ids[0]);
    const b = t.budget[TIER];
    const mem = () => { global.gc(); global.gc(); const m = process.memoryUsage(); return { heap: m.heapUsed, rss: m.rss }; };
    const run = (CORE_) => {
      const before = mem();
      const r = CORE_.dfpnSearch(boardOf(t), t.attacker, {
        maxPlies: t.maxPlies, maxNodes: b.maxNodes, timeMs: t.timeMs * 4, order: 'none', diag: false,
        boundCache: CORE_.createBoundCache(),
      });
      const afterRun = mem();
      r.proof = null;
      return { nodes: r.nodes, heap: afterRun.heap - before.heap, rss: afterRun.rss - before.rss };
    };
    console.log(`\n  ② 内存（任务 ${ids[0]}，gc 后读 ` + '`heapUsed`/`rss` 增量；**证书树在被测对象里**)');
    console.log(`     说明：搜索返回的树由两版共同拥有，所以增量主要反映树；此处正反两序各测一次取一致值。`);
    const res = {};
    for (const order of [['new', 'old'], ['old', 'new']]) {
      for (const which of order) {
        if (which === 'old' && !CORE_OLD) continue;
        const c = which === 'old' ? CORE_OLD : CORE;
        const x = run(c);
        res[which] = res[which] || [];
        res[which].push(x);
      }
    }
    const fmt = (a) => a ? a.map(x => `heap +${(x.heap / 1048576).toFixed(1)}MB / rss +${(x.rss / 1048576).toFixed(1)}MB (nodes ${x.nodes})`).join(' ｜ ') : '（未测）';
    console.log(`     新版（cols）  ：${fmt(res.new)}`);
    console.log(`     基线（string）：${fmt(res.old)}`);
    const dn = res.new && res.new[0].heap, doo = res.old && res.old[0].heap;
    if (dn != null && doo != null) {
      console.log(`     ⇒ 差值 ${((dn - doo) / 1048576).toFixed(2)}MB` +
        `（正 = 新版多占）—— 索引挂在单个 rootPos 上，列数 = 棋盘宽度量级`);
    }
  }
} else {
  console.log('\n  ② 内存：未测（加 `--expose-gc --mem`，并可配 `--old <基线副本>` 做对照）');
}
