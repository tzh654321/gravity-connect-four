'use strict';
/* ============================================================
   check-live-page —— **浏览器/Worker 路径**的后端与实时行为核对

   前几轮的性能实验全在 Node 里做，而真实运行环境是浏览器主脚本 + Worker
   （Android 侧还有 WebView）。本脚本不建新工具体系，只复用 `game-sandbox`
   在**页面上下文**里核对四件事：

     1) 默认后端：页面内联核心读到的 `GravitySolver.AT_BACKEND` 必须是 `cols`
        （沙箱**没有 `process`**，与浏览器一致 ⇒ 走的是默认分支）；
     2) 回退后端：预置 `globalThis.__G4_AT_BACKEND='string'` 再加载同一页面 ⇒
        必须是 `string`，且新建局面的 `cols` 为 `null`（**不建索引** ⇒ 不会
        "又维护两份、却只用字符串查询"）；
     3) 证书**未命中**时确实走实时搜索路径：包装 `GravitySolver.chooseMove` 计数，
        未命中局面必须被调用、并返回**合法稳定落点**；命中局面必须**不调用**它、
        直接返回证书决策；
     4) 正常思考期间的内存与耗时：同一局面连续思考若干次，报每次耗时与堆增量
        （**不硬断言 GC 时机**，只报数字 + 是否有单调增长迹象）。

   用法：node tools/check-live-page.js
   ============================================================ */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGame, scriptOf, drain } = require('./game-sandbox');

const LIVE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'bench-live.json'), 'utf8'));
const BUNDLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'cert-bundle.json'), 'utf8'));

let fails = 0;
const ok = m => console.log('  ✓ ' + m);
const fail = m => { fails++; console.log('  ✗ ' + m); };
const head = m => console.log('\n' + m);

const EXPORT = 'state,set occ(v){occ=v},get occ(){return occ},aiChooseMove,K,P1,P2,BLOCK,' +
  'isFree,settleDiscrete,GravitySolver,certReset,certEnabled';

/* ---- 页面加载：默认后端 ---- */
head('1) 页面内联核心的默认后端（沙箱无 `process`，与浏览器一致）');
const G = loadGame(null, EXPORT, { expose: true });
{
  if (typeof G.__sb.process !== 'undefined') fail('沙箱里竟有 process ⇒ 与浏览器环境不一致，本核对失去意义');
  else ok('沙箱没有 `process`（与浏览器一致）');
  const v = G.GravitySolver && G.GravitySolver.AT_BACKEND;
  if (v === 'cols') ok(`GravitySolver.AT_BACKEND = "${v}"（默认：数值双层 Map）`);
  else fail(`GravitySolver.AT_BACKEND = ${JSON.stringify(v)}（期望 "cols"）`);
  // 顺手确认索引确实被建起来（而不是只有开关没有实现）
  const p = new G.GravitySolver.Position([['0,0', 3]]);
  const u = p.play(p.moves()[0], 1);
  if (p.cols === null || p.cols === undefined) fail('cols 模式下页面核心没有建索引');
  else ok(`页面核心的索引确实在工作（${p.cols.size} 列）`);
  p.undo(u);
}

/* ---- 回退后端：必须真的"零索引开销" ---- */
head('2) 回退后端 `string`：不得同时维护两份、却只用字符串查询');
{
  const src = '<html><body><script>\n' + "globalThis.__G4_AT_BACKEND='string';\n" + scriptOf() + '\n</script></body></html>';
  const G2 = loadGame(src, EXPORT, { expose: true });
  const v = G2.GravitySolver && G2.GravitySolver.AT_BACKEND;
  if (v === 'string') ok(`预置 __G4_AT_BACKEND 后 AT_BACKEND = "${v}"（开关在加载时生效）`);
  else fail(`预置开关无效：AT_BACKEND = ${JSON.stringify(v)}`);
  const p = new G2.GravitySolver.Position([['0,0', 3]]);
  let side = 1;
  for (let i = 0; i < 30; i++) { const ms = p.moves(); if (!ms.length) break; p.play(ms[i % ms.length], side); side = 3 - side; }
  if (p.cols !== null) fail('string 模式下仍在维护 cols ⇒ 那是"双份成本"，回退不是真的回退');
  else ok('string 模式下 30 次落子后 cols 仍为 null（不构建、不维护）');
  const src2 = G2.GravitySolver.Position.prototype._idxSet.toString();
  if (/cols\s*\.\s*(get|set)/.test(src2)) fail('string 模式下 _idxSet 仍在写 cols');
  else ok('string 模式下 _idxSet/_idxDel 是空函数');
}

/* ---- 实时路径：证书未命中 → 走搜索；命中 → 不搜索 ---- */
head('3) 实时路径归属（证书未命中必须走搜索；命中必须跳过搜索）');
function setPosition(G, task) {
  const occ = new Map();
  for (const [k, o] of task.board) occ.set(k, o);
  G.occ = occ;
  Object.assign(G.state, {
    mode: 'mm', diff: 'hard', aiKind: 'solver', nnOn: false,
    turn: task.side, phase: 'idle', moveCount: task.board.length - 1,
    winner: 0, winCells: null, gen: (G.state.gen || 1) + 1,
  });
  if (G.certReset) G.certReset('测试：切换局面');
  return task.side;
}
let chooseCalls = 0;
const origChoose = G.GravitySolver.chooseMove;
G.GravitySolver.chooseMove = function (...a) { chooseCalls++; return origChoose.apply(this, a); };

(async function () {
  // 3a 未命中：取一个 certHit=false 的搜索局面
  const miss = LIVE.tasks.find(t => !t.certHit && !t.immediateTactic);
  const me = setPosition(G, miss);
  chooseCalls = 0;
  const t0 = Date.now();
  const d = await G.aiChooseMove();
  const ms = Date.now() - t0;
  if (!chooseCalls) fail(`未命中证书的局面 ${miss.id} 没有调用实时搜索（chooseCalls=0）`);
  else ok(`未命中证书的局面 ${miss.id} 走了实时搜索（chooseMove 调用 ${chooseCalls} 次，${ms}ms）`);
  if (!d || !Number.isInteger(d.x)) fail('实时搜索未返回落点');
  else if (!G.isFree(d.x, d.y)) fail(`实时搜索返回了已占格 (${d.x},${d.y})`);
  else {
    drain(G);
    const l = G.settleDiscrete(d.x, d.y);
    if (l.x !== d.x || l.y !== d.y) fail(`返回的不是稳定落点：(${d.x},${d.y}) → (${l.x},${l.y})`);
    else ok(`落点 (${d.x},${d.y}) 合法且稳定`);
  }

  // 3b 命中：证书库那一个根局面
  const hit = LIVE.tasks.find(t => t.certHit);
  if (!hit) fail('验收集里没有 certHit 项，无法核对"命中就跳过搜索"');
  else {
    const e = BUNDLE.entries.find(x => x.sideToMove === hit.side &&
      x.rootKey === [...new G.GravitySolver.Position(hit.board).board].map(([k, o]) => k + ':' + o).sort().join(';'));
    if (!e) fail(`证书库里找不到与 ${hit.id} 匹配的 rootKey（验收集与证书包不同步？）`);
    else {
      const me2 = setPosition(G, hit);
      chooseCalls = 0;
      const dm = await G.aiChooseMove();
      if (chooseCalls) fail(`证书命中局面 ${hit.id} 竟调用了实时搜索（chooseCalls=${chooseCalls}）`);
      else ok(`证书命中局面 ${hit.id} 未调用实时搜索（页面在 certChoose 就返回了）`);
      const want = e.decision.move, got = dm && { x: dm.x, y: dm.y };
      if (!got || got.x !== want.x || got.y !== want.y) fail(`证书决策走法不符：期望 (${want.x},${want.y})，得到 ${JSON.stringify(got)}`);
      else ok(`证书决策走法一致：(${want.x},${want.y})（tier=${e.decision.tier}，basis=${e.decision.basis}）`);
    }
  }

  // 3c 即时战术局面：也应走实时搜索入口（核心内部提前返回），且落点合法
  const tac = LIVE.tasks.find(t => t.immediateTactic && !t.certHit);
  if (tac) {
    setPosition(G, tac);
    chooseCalls = 0;
    const t1 = Date.now();
    const dt = await G.aiChooseMove();
    const tms = Date.now() - t1;
    if (!chooseCalls) fail(`即时战术局面 ${tac.id} 没有走实时搜索入口`);
    else if (!dt || !G.isFree(dt.x, dt.y)) fail(`即时战术局面 ${tac.id} 返回非法落点`);
    else ok(`即时战术局面 ${tac.id} 走搜索入口并返回合法落点，耗时 ${tms}ms（应远小于 1500ms 预算）`);
  }

  /* ---- 4) 重复思考的内存与耗时 ---- */
  head('4) 正常思考期间的内存与耗时（同一局面连续 5 次）');
  if (typeof global.gc === 'function') { global.gc(); }
  const base = process.memoryUsage().heapUsed;
  const times = [], heaps = [];
  for (let i = 0; i < 5; i++) {
    setPosition(G, miss);
    const s = Date.now();
    const r = await G.aiChooseMove();
    times.push(Date.now() - s);
    heaps.push(process.memoryUsage().heapUsed - base);
    if (!r || !G.isFree(r.x, r.y)) fail(`第 ${i + 1} 次思考返回非法落点`);
  }
  console.log(`      每次耗时 ms：${times.join(' / ')}（页面预算 1500ms；不含证书与启发式档）`);
  console.log(`      堆增量 MB  ：${heaps.map(h => (h / 1048576).toFixed(1)).join(' / ')}（相对基线；GC 时机不可控，只看有无单调增长）`);
  const monotone = heaps.every((h, i) => i === 0 || h >= heaps[i - 1]);
  if (monotone && heaps[4] > heaps[0] * 1.5 + 4 * 1048576) fail('堆增量单调增长且显著 ⇒ 疑似每次思考都留下东西');
  else ok(`未见明显单调增长（末次 ${(heaps[4] / 1048576).toFixed(1)}MB vs 首次 ${(heaps[0] / 1048576).toFixed(1)}MB）`);
  if (times.some(x => x > 4000)) fail(`有单次思考超过 4s（${Math.max(...times)}ms）`); else ok('单次思考未超过 4s');

  console.log(`\n结果：${fails ? `✗ ${fails} 处失败` : '✓ 全部通过'}`);
  process.exit(fails ? 1 : 0);
})();
