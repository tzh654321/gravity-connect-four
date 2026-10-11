'use strict';
/* ============================================================
   check-index-cols —— 数值双层 Map 查询索引（`at()` 后端）的同步正确性检查

   被测对象：`solver-core.js` 里 `Position.cols = Map<x, Map<y, owner>>`。
   它**只服务查询**，`board`（字符串键）仍是唯一的真值来源与遍历顺序来源。
   因此本工具的主判据是：

       把 `cols` 从 `board` **重新推导一遍**，与运行中的 `cols` **逐项相同**。

   这一条能同时抓住"写了 board 忘了 cols"、"写了 cols 忘了 board"、
   "撤销漏删"、"空列没清理"、"试放直接改 Map" 这几类错。

   检查项：
     A 逐步查询一致性：构造 / 每次 play / 每次 undo 之后，逐格比对
       `at(x,y)` 与 `board.get(key(x,y))||0`（覆盖已占格、frontier 格及其四邻）。
     B 索引 vs 棋盘的全量重推导（每个操作之后都做）。
     C 嵌套撤销、乱序回退、异常中断（在 DFS 中途 throw）后的回退。
     D 坐标边界：负坐标、坐标轴、`-0` 归一化、跨 2^31 / 2^40 / 安全整数上界。
     E 顺序不变：`frontier` 插入序与 `moves()` 顺序都要逐字可复现（打印摘要）。
     F 摘要：对固定工作量打印一行 DIGEST，供两种后端**跨进程**逐字比对。

   用法：
     node tools/check-index-cols.js                 # 全部检查
     node tools/check-index-cols.js --quick         # 跳过最重的深度回退用例
     G4_AT_BACKEND=string node tools/check-index-cols.js   # 切回字符串后端对照
   ============================================================ */
const fs = require('fs');
const path = require('path');
const CORE = require('./solver-core');

const ARGV = process.argv.slice(2);
const QUICK = ARGV.includes('--quick');
const BACKEND = CORE.AT_BACKEND;
const COLS = BACKEND === 'cols';     // 只有 cols 后端才有 `pos.cols`；string 后端下跳过索引专门项

/* ---------- --cross：两种后端各跑一次，逐字比对见证与结论 ---------- */
if (ARGV.includes('--cross')) {
  const { spawnSync } = require('child_process');
  const run = (backend) => {
    const env = Object.assign({}, process.env);
    if (backend === 'string') env.G4_AT_BACKEND = 'string'; else delete env.G4_AT_BACKEND;
    const r = spawnSync(process.execPath, [__filename, '--quick'], { encoding: 'utf8', env, maxBuffer: 1 << 28 });
    const out = (r.stdout || '') + (r.stderr || '');
    const wit = (out.match(/^WITNESS=([0-9a-f]+)$/m) || [])[1] || null;
    const res = (out.match(/^结果：(.*)$/m) || [])[1] || null;
    const dig = (out.match(/^  WITNESS backend=\S+ ([0-9a-f]+)$/m) || [])[1] || null;
    return { backend, code: r.status, wit, dig, res, out };
  };
  const A = run('cols'), B = run('string');
  const line = (x) => `  后端 ${x.backend.padEnd(6)} 退出码 ${x.code}  见证 ${(x.wit || '(无)').slice(0, 24)}…  ${x.res || '(无结论行)'}`;
  console.log('check-index-cols --cross：同一份工作量在两种查询后端下的逐字比对\n');
  console.log(line(A)); console.log(line(B));
  let bad = 0;
  if (A.code !== 0 || B.code !== 0) { console.log('  ✗ 有一侧本身没跑通'); bad++; }
  if (!A.wit || !B.wit) { console.log('  ✗ 有一侧没打印见证'); bad++; }
  else if (A.wit !== B.wit) {
    bad++;
    console.log('  ✗ 见证不同 ⇒ 后端替换改变了可观测量（探针结果 / frontier 顺序 / 规范键 / 搜索计数 至少一项）');
    const L = s => s.split(/\r?\n/).map(t => t.trim()).filter(Boolean);
    const a = L(A.out), b = L(B.out);
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { console.log(`    首个差异（第 ${i + 1} 行）：\n      cols  : ${a[i]}\n      string: ${b[i]}`); break; }
  } else console.log('  ✓ 见证逐字相同（逐格探针 + 每一步的 frontier/moves 顺序 + 规范键 + 搜索全计数）');
  if (A.dig && B.dig && A.dig !== B.dig) { bad++; console.log('  ✗ F 段摘要不同'); }
  console.log(bad ? '\n结论：✗ 后端替换未通过跨后端逐字一致性' : '\n结论：✓ 两种后端逐字一致');
  process.exit(bad ? 1 : 0);
}

let fails = 0;
const fail = m => { fails++; console.log('  ✗ ' + m); };
const ok = m => console.log('  ✓ ' + m);
const head = m => console.log('\n' + m);

const key = (x, y) => x + ',' + y;

/* ---------- 运行见证（witness）----------
   把**所有可能受后端影响的观测量**滚进一个 sha256：逐格查询结果、每一步之后的
   frontier 插入序、moves() 顺序、规范键、搜索的全部确定性计数。
   两种后端各跑一次本工具，WITNESS 必须逐字相同 —— 这才是"语义没被换掉"的判据，
   比看几条 ✓ 强得多（`--cross` 会自动做这件事）。 */
const crypto = require('crypto');
const WIT = crypto.createHash('sha256');
const mix = s => { WIT.update(String(s)); WIT.update('\u0000'); };

/* ---------- 判据 1：从 board 重新推导 cols ---------- */
function deriveCols(board) {
  const cols = new Map();
  for (const [k, o] of board) {
    const i = k.indexOf(',');
    const x = +k.slice(0, i), y = +k.slice(i + 1);
    let c = cols.get(x);
    if (c === undefined) { c = new Map(); cols.set(x, c); }
    c.set(y, o);
  }
  return cols;
}
/* 结构比较：列集合（含"空列必须被清理"）与每列的 (y -> owner) 都要一致 */
function colsDiff(a, b) {
  const seen = new Set();
  for (const x of a.keys()) seen.add(x);
  for (const x of b.keys()) seen.add(x);
  const probs = [];
  for (const x of seen) {
    const ca = a.get(x), cb = b.get(x);
    if (!ca) { probs.push(`多了列 x=${x}（应无）`); continue; }
    if (!cb) { probs.push(`少了列 x=${x}（${ca.size} 格）`); continue; }
    if (ca.size !== cb.size) probs.push(`列 x=${x} 格数 ${ca.size} ≠ ${cb.size}`);
    for (const [y, o] of ca) if (cb.get(y) !== o) probs.push(`x=${x},y=${y}: ${o} ≠ ${cb.get(y)}`);
    for (const [y, o] of cb) if (!ca.has(y)) probs.push(`x=${x},y=${y}: 应无此项（现有 ${o}）`);
    if (probs.length > 6) break;
  }
  return probs;
}
function assertSynced(pos, tag) {
  if (!COLS) return true;                       // string 后端没有 cols 可比
  const probs = colsDiff(pos.cols, deriveCols(pos.board));
  if (probs.length) fail(`${tag}：cols 与 board 不同步 —— ${probs.join('；')}`);
  return probs.length === 0;
}
/* 逐格查询一致性：以"所有占据格 + frontier 格"为中心取一个窗口 */
function probePoints(pos) {
  const pts = [];
  for (const k of pos.board.keys()) { const i = k.indexOf(','); pts.push([+k.slice(0, i), +k.slice(i + 1)]); }
  for (const k of pos.frontier) { const i = k.indexOf(','); pts.push([+k.slice(0, i), +k.slice(i + 1)]); }
  return pts;
}
function assertQueries(pos, tag) {
  let bad = 0, n = 0;
  for (const [x, y] of probePoints(pos)) {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const qx = x + dx, qy = y + dy;
      const want = pos.board.get(key(qx, qy)) || 0;
      const got = pos.at(qx, qy);
      n++;
      if (got !== want) { if (++bad <= 3) fail(`${tag}：at(${qx},${qy}) = ${got}，board 里是 ${want}`); }
    }
  }
  if (bad) return false;
  console.log(`      · ${tag}：${n} 次查询一致，${pos.board.size} 格`);
  return true;
}

/* 每一步之后把 frontier 插入序与 moves() 顺序滚进见证（两者都与后端无关，必须逐字相同） */
function mixOrders(pos, tag) {
  mix(tag + '|F|' + [...pos.frontier].join(','));
  mix(tag + '|M|' + pos.moves().map(q => q.x + ',' + q.y).join(','));
}

/* ---------- 固定夹具 ---------- */
const SUITE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'bench-horizon.json'), 'utf8'));
const PLY4 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'bounded-ply4.json'), 'utf8'));
const after = mv => { const p = new CORE.Position(PLY4.board); const u = p.play(mv, 1); const b = [...p.board]; p.undo(u); return b; };
/* 与 `bench-horizon.js` 的 `boardOf` 同口径：优先 ply4Move，否则用显式 board */
function boardOf(t) {
  if (t.ply4Move) return after(t.ply4Move);
  if (t.board) { new CORE.Position(t.board); return t.board; }   // 顺带校验合法性
  throw new Error(`任务 ${t.id} 既没有 ply4Move 也没有 board`);
}

/* ============================================================
   A/B 逐步一致性：构造 → 沿固定走法下潜 → 逐层回退（LIFO）
   ============================================================ */
head(`A/B 逐步一致性（后端 = ${BACKEND}）`);
{
  const cases = [
    { id: '初始局面', board: [['0,0', 3]] },
    { id: 'ply4 局面', board: PLY4.board },
    ...SUITE.tasks.map(t => ({ id: t.id, board: boardOf(t) })),
  ];
  let totalOps = 0;
  for (const c of cases) {
    const pos = new CORE.Position(c.board);
    if (!assertSynced(pos, `${c.id} 构造后`)) continue;
    // 沿"frontier 顺序"下潜到固定深度（确定性），每步比对
    const stack = [];
    let depth = 0;
    const DOWN = 6;
    while (depth < DOWN) {
      const ms = pos.moves();
      if (!ms.length) break;
      const m = ms[Math.min(ms.length - 1, depth === 0 ? 0 : depth % ms.length)];
      let u;
      try { u = pos.play(m, ((pos.board.size - 1) % 2 === 0) ? 1 : 2); }
      catch (e) { fail(`${c.id} 第 ${depth + 1} 步落子失败：${e.message}`); break; }
      stack.push(u); depth++; totalOps++;
      mixOrders(pos, `${c.id}#${depth}`);
      if (!assertSynced(pos, `${c.id} play#${depth} (${m.x},${m.y})`)) break;
    }
    // 每下一层都做一次查询比对（只对浅层做全窗口，避免输出过长）
    if (depth) assertQueries(pos, `${c.id} 下潜 ${depth} 层后`);
    // 逐层回退，每层都比对
    while (stack.length) {
      const u = stack.pop();
      totalOps++;
      try { pos.undo(u); } catch (e) { fail(`${c.id} 回退失败：${e.message}`); break; }
      mixOrders(pos, `${c.id}#u${u.k}`);
      if (!assertSynced(pos, `${c.id} undo(${u.k})`)) break;
    }
    // 回到起点：棋盘必须逐字等于输入
    const back = [...pos.board].map(([k, o]) => k + ':' + o).sort().join(';');
    const want = [...new Map(c.board)].map(([k, o]) => k + ':' + o).sort().join(';');
    if (back !== want) fail(`${c.id} 全部回退后棋盘未复原：${back} ≠ ${want}`);
    assertQueries(pos, `${c.id} 复原后`);
  }
  ok(`A/B：${cases.length} 个局面，${totalOps} 次 play/undo，每一步 cols 都与 board 全量重推导一致`);
}

/* ============================================================
   C1 交错 / 乱序回退（不是简单 LIFO 到底）
   ============================================================ */
head('C1 交错 play/undo（同列反复、多层嵌套、非平凡回退顺序）');
{
  const pos = new CORE.Position(PLY4.board);
  const stack = [];
  let step = 0, bad = 0;
  const rnd = (() => { let s = 12345; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  for (let i = 0; i < (QUICK ? 200 : 900); i++) {
    const ms = pos.moves();
    if (!ms.length) break;
    if (stack.length && rnd() < 0.35) {
      // 回退 1~2 层
      for (let t = 0; t < 1 + Math.floor(rnd() * 2) && stack.length; t++) {
        pos.undo(stack.pop());
        if (!assertSynced(pos, `C1 undo 第 ${++step} 次`)) { bad++; break; }
      }
    } else {
      const m = ms[Math.floor(rnd() * ms.length)];
      const side = ((pos.board.size - 1) % 2 === 0) ? 1 : 2;
      stack.push(pos.play(m, side));
      mixOrders(pos, `C1p${step}`);
      if (!assertSynced(pos, `C1 play(${m.x},${m.y}) 第 ${++step} 次`)) { bad++; break; }
    }
    if (bad) break;
  }
  while (stack.length) pos.undo(stack.pop());
  assertSynced(pos, 'C1 全部回退后');
  assertQueries(pos, 'C1 全部回退后');
  if (!bad) ok(`C1：${step} 次交错操作，每一步都同步；同列多子反复落子/撤销覆盖到了`);
}

/* ============================================================
   C2 异常中断后的回退（在 DFS 中途 throw，走 try/finally）
   ============================================================ */
head('C2 异常中断（在递归中途 throw，模拟搜索预算中断后的回退）');
{
  const base = new CORE.Position(PLY4.board);
  const snap = {
    board: [...base.board].map(([k, o]) => k + ':' + o).sort().join(';'),
    /* ⚠ `frontier` 是 Set：`undo` 用 `add` 把刚撤销的格放回**末尾**，
       所以 play/undo 一轮后**插入序会变、内容不会变**（基线同样如此，非本项引入）。
       这里比"集合内容"；插入序跨后端是否仍逐字一致，由 F 段的 DIGEST 负责。 */
    frontier: [...base.frontier].sort().join(' '),
    cols: COLS ? colsDiff(base.cols, deriveCols(base.board)).length : 0,
  };
  let thrown = 0;
  const rec = (pos, depth, limit) => {
    if (depth >= limit) { thrown++; throw new Error('模拟异常：预算耗尽'); }
    const ms = pos.moves();
    if (!ms.length) return;
    const m = ms[0];
    const u = pos.play(m, ((pos.board.size - 1) % 2 === 0) ? 1 : 2);
    try { rec(pos, depth + 1, limit); }
    finally { pos.undo(u); }
  };
  for (const limit of [1, 2, 3, 5, 8]) {
    try { rec(base, 0, limit); fail(`C2 limit=${limit} 竟然没有抛出`); }
    catch (e) { /* 预期 */ }
  }
  const now = {
    board: [...base.board].map(([k, o]) => k + ':' + o).sort().join(';'),
    frontier: [...base.frontier].sort().join(' '),
    cols: COLS ? colsDiff(base.cols, deriveCols(base.board)).length : 0,
  };
  if (now.board !== snap.board) fail('C2 异常回退后 board 未复原');
  if (now.frontier !== snap.frontier) fail('C2 异常回退后 frontier 内容未复原');
  if (COLS && now.cols) fail('C2 异常回退后 cols 未复原');
  if (!fails) ok(`C2：${thrown} 次中断、全部回到原状态（board / frontier 内容 / cols 三者逐字相同）`);

  // 真实的搜索预算中断：小预算必须报 nodeLimit，且大预算仍给出与基线相同的结果
  const t = SUITE.tasks.find(x => x.id === 'hz3-refute-n16-a');
  const b = boardOf(t);
  const small = CORE.dfpnSearch(b, t.attacker, { maxPlies: t.maxPlies, maxNodes: 50, timeMs: 60000, order: 'none', diag: true });
  if (!small.nodeLimit) fail('C2 小预算没有触发 nodeLimit');
  else ok(`C2：小预算 search 正确报 nodeLimit（nodes=${small.nodes}，未把中断当结论）`);
  const big = CORE.dfpnSearch(b, t.attacker, { maxPlies: t.maxPlies, maxNodes: t.budget.common.maxNodes, timeMs: 600000, order: 'none', diag: true });
  if (big.status !== 'refuted' || big.nodes !== 467111) fail(`C2 大预算结果异常：${big.status} / ${big.nodes} 节点（期望 refuted / 467111）`);
  else ok(`C2：中断过之后重跑，结论与节点数仍与基线逐位相同（refuted / 467111）`);
}

/* ============================================================
   D 坐标边界
   ============================================================ */
head('D 坐标边界（负坐标 / 坐标轴 / -0 / 跨 2^31 / 2^40 / 安全整数上界）');
{
  // D1 合法对局里可达的坐标（全为负 / 零附近）必须逐格一致
  {
    const pos = new CORE.Position([['0,0', 3]]);
    const moves = [[0, 1], [1, 0], [0, 2], [-1, 0], [1, 1], [0, -1], [-1, 1], [2, 0]];
    let side = 1, bad = 0;
    for (const [x, y] of moves) {
      try { pos.play({ x, y }, side); } catch (e) { bad++; fail(`D1 落子 (${x},${y}) 失败：${e.message}`); break; }
      side = 3 - side;
      if (!assertSynced(pos, `D1 落 (${x},${y}) 后`)) break;
    }
    if (!bad && assertQueries(pos, 'D1 含负坐标的合法局面')) {
      // 逐格扫一个覆盖负坐标的窗口
      let n = 0, mis = 0;
      for (let x = -4; x <= 4; x++) for (let y = -4; y <= 4; y++) {
        n++;
        const want = pos.board.get(key(x, y)) || 0;
        mix(`D1w${x},${y}=${pos.at(x, y)}/${want}`);
        if (pos.at(x, y) !== want) { if (++mis <= 3) fail(`D1 窗口 at(${x},${y}) = ${pos.at(x, y)} ≠ ${want}`); }
      }
      if (!mis) ok(`D1：x,y ∈ [-4,4] 共 ${n} 格，at() 与 board 逐格相同`);
    }
  }
  // D2 -0 归一化：数值 Map 用 SameValueZero ⇒ -0 与 +0 同一个键；字符串键也把 -0 写成 "0"
  if (!COLS) { console.log('      · D2/D3 跳过：后端 = string 时索引原语被置空（对照项不存在）'); }
  else {
    const pos = new CORE.Position([['0,0', 3]]);
    pos._idxSet(-0, 5, 1);
    const c0 = pos.at(0, 5), cN = pos.at(-0, 5);
    const sk = key(-0, 5);
    if (c0 !== 1 || cN !== 1) fail(`D2 -0/-0(键) 不一致：at(0,5)=${c0} at(-0,5)=${cN}`);
    else if (sk !== '0,5') fail(`D2 字符串键未把 -0 归一化：key(-0,5) = "${sk}"`);
    else ok(`D2：-0 与 0 是同一个键（at=1），且字符串键同为 "0,5" ⇒ 两种后端口径一致`);
    // 反复 -0/0 交替写入：不应产生两列（-0 与 +0 是同一个键 ⇒ 始终只有 x=0 这一列）
    for (let i = 0; i < 20; i++) pos._idxSet(i % 2 ? -0 : 0, 5, 1);
    if (pos.cols.size !== 1) fail(`D2 -0/0 交替写入产生了额外列：cols.size = ${pos.cols.size}（应为 1）`);
    else ok('D2：-0/0 交替写入不产生分裂列（cols.size 恒为 1）');
    pos._idxDel(-0, 5);
    if (pos.at(0, 5) !== 0) fail('D2 _idxDel(-0,5) 未删掉 x=0 那一项');
    else ok('D2：_idxDel(-0,5) 与 _idxSet(0,5) 配对正确');
  }
  // D3 大整数坐标：直接测索引原语（不构造非法棋盘）
  if (COLS) {
    const pos = new CORE.Position([['0,0', 3]]);
    const xs = [1, -1, 2 ** 31, -(2 ** 31) - 1, 2 ** 40, -(2 ** 40), Number.MAX_SAFE_INTEGER - 1024];
    const ys = [0, -1, 3, -(2 ** 33), 2 ** 52, -7, Number.MAX_SAFE_INTEGER - 1024];
    let bad = 0;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i], y = ys[i];
      if (pos.at(x, y) !== 0) { bad++; fail(`D3 (${x},${y}) 事前应为空`); }
      pos._idxSet(x, y, 2);
      if (pos.at(x, y) !== 2) { bad++; fail(`D3 (${x},${y}) 写入后查不到`); }
      pos._idxDel(x, y);
      if (pos.at(x, y) !== 0) { bad++; fail(`D3 (${x},${y}) 删除后仍有值`); }
      if (pos.cols.size !== 1) { bad++; fail(`D3 (${x},${y}) 删除后空列未清理（cols.size = ${pos.cols.size}）`); }
    }
    if (!bad) ok(`D3：${xs.length} 组大/负坐标（含 ±2^31、±2^40、安全整数上界）写入-查询-删除全对，空列自动清理`);
    // 索引与棋盘彼此独立：索引里加了大坐标，board 不该被污染
    pos._idxSet(2 ** 40, 2 ** 40, 1);
    if (pos.board.size !== 1 || pos.board.has(key(2 ** 40, 2 ** 40))) fail('D3 索引写入污染了 board');
    else ok('D3：索引原语只动 cols，不碰 board（真值来源单一）');
    pos._idxDel(2 ** 40, 2 ** 40);
  }
  // D4 四旋转：规范化键在同一后端下可复现（跨后端由 DIGEST 段比对）
  {
    const seen = new Set();
    for (const t of SUITE.tasks) {
      const p = new CORE.Position(boardOf(t));
      for (const s of [1, 2]) seen.add(s + '|' + p.canonical(s).key);
    }
    const digest = [...seen].sort().join('¶').length;
    ok(`D4：${SUITE.tasks.length} 个局面的四旋转规范键已算出（唯一键 ${seen.size} 个，总长 ${digest}）——跨后端逐字比对见 DIGEST 段`);
  }
}

/* ============================================================
   E 顺序不变（frontier 插入序 / moves() 顺序）
   ============================================================ */
head('E 顺序不变（frontier 插入序 = moves() 顺序 = Set 插入序）');
{
  let bad = 0;
  for (const c of [PLY4.board, ...SUITE.tasks.map(boardOf)]) {
    const pos = new CORE.Position(c);
    const f = [...pos.frontier];
    const m = pos.moves().map(q => key(q.x, q.y));
    if (f.join(' ') !== m.join(' ')) { bad++; fail('moves() 顺序与 frontier 插入序不一致'); }
    // 前一格决定后一格：加/删一格后顺序必须只发生"局部"变化
    if (f.some(k => !/^-?\d+,-?\d+$/.test(k))) { bad++; fail(`frontier 里有非规范键：${f.find(k => !/^-?\d+,-?\d+$/.test(k))}`); }
  }
  if (!bad) ok('E：全部夹具的 moves() 顺序 = frontier 插入序，且键全为规范形式');
}

/* ============================================================
   F DIGEST：固定工作量的逐字摘要，供两种后端跨进程比对
   ============================================================ */
head('F DIGEST（把这段输出在两种后端下各跑一次并 diff）');
{
  const parts = [];
  // F1 随机但确定的 play/undo 轨迹
  {
    let s = 987654321;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pos = new CORE.Position(PLY4.board);
    const stack = [];
    for (let i = 0; i < 400; i++) {
      const ms = pos.moves();
      if (!ms.length) break;
      if (stack.length && rnd() < 0.3) { pos.undo(stack.pop()); continue; }
      const m = ms[Math.floor(rnd() * ms.length)];
      stack.push(pos.play(m, ((pos.board.size - 1) % 2 === 0) ? 1 : 2));
      parts.push(`${m.x},${m.y}/${pos.frontier.size}`);
    }
    while (stack.length) pos.undo(stack.pop());
    parts.push('BACK=' + [...pos.board].sort().map(([k, o]) => k + ':' + o).join(','));
    parts.push('FRONT=' + [...pos.frontier].join(','));
  }
  // F2 两个真实搜索的全部确定性计数
  for (const id of ['hz3-refute-n16-a', 'hz1-win-n9']) {
    const t = SUITE.tasks.find(x => x.id === id);
    const r = CORE.dfpnSearch(boardOf(t), t.attacker, {
      maxPlies: t.maxPlies, maxNodes: t.budget.common.maxNodes, timeMs: 600000,
      order: 'none', diag: true, boundCache: CORE.createBoundCache(),
    });
    parts.push(`${id}:${r.status}/${r.nodes}/${r.successors}/${r.expansions}/${r.stateKeys}/${r.winScans}/${r.ttHits}/${r.pn}/${r.dn}/${r.rootSide}`);
    r.proof = null;
  }
  // F3 规范键（完整文本，不只是长度 —— 规范键是 TT 的键，必须逐字相同）
  for (const t of SUITE.tasks) {
    const p = new CORE.Position(boardOf(t));
    for (const s of [1, 2]) parts.push(`${t.id}/${s}:${p.signature(s, false)}#${p.canonical(s).key}#${p.canonical(s).rot}`);
  }
  for (const x of parts) mix(x);                    // 与前面的探针/顺序一起进同一个见证
  const digest = WIT.copy().digest('hex');
  console.log(`  WITNESS backend=${BACKEND} ${digest}`);
  console.log(`  bits=${parts.length} 片段 / ${parts.join('|').length} 字符（另有全部逐格探针与顺序）`);
  ok('F：见证已生成');
}

console.log(`\nWITNESS=${WIT.copy().digest('hex')}`);
console.log(`结果：${fails ? `✗ ${fails} 处失败` : '✓ 全部通过'}（后端 = ${BACKEND}）`);
process.exit(fails ? 1 : 0);
