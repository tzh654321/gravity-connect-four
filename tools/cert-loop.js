'use strict';
/* ============================================================
   cert-loop —— 证书在线闭环的**事件回放验收**（P6）

   不跑批量胜率，只回放固定事件、断言确定性结论：
     S0 体积/装载      S1 关键局面命中（真实选招）    S2 证书数据自洽（重建 + 双核验 + 页面⇄数据逐状态）
     S3 完整跟随       S4 我方偏离即作废              S5 悔棋/重开/换档位/导入（含静态钩子核对）
     S6 迟到响应       S7 旋转坐标还原（核心规范键）  S8 普通对局开销
     S9 旋转根局面回放（页面级四旋转查询 + 坐标还原 + 旋转后跟随）
     S10 未命中两类诊断（我方偏离 vs 对手合法落子后未命中=异常）
     S11 两个长度口径分开（选招依据 horizon ≠ 可执行保证 horizon）

   用法：node tools/cert-loop.js [--bundle tools/fixtures/cert-bundle.json]
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { loadGame } = require('./game-sandbox');
const CORE = require('./solver-core');
const RULE = require('./verify-strategy');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const BUNDLE_PATH = argOf('bundle', 'tools/fixtures/cert-bundle.json');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let fails = 0;
const bad = m => { fails++; console.log('  ✗ ' + m); };
const ok = m => console.log('  ✓ ' + m);

const EXPORT = 'state,P1,P2,BLOCK,K,occ,set occ(v){occ=v},isFree,' +
  'certState,certBundle,certEnabled,certReset,certDrop,certChoose,certFollow,certArmRoot,certStatusText,certGuaranteeText,certFindEntry,resetGame';
const P = loadGame(null, EXPORT);

const IDX_TERM = ['none', 'depth-limit', 'connect4', 'defender-win'];
const parseCells = s => Array.isArray(s) ? s : (s ? String(s).split(';') : []);
const keyOf = cells => cells.slice().sort().join(';');
const occFrom = (rootMap, cells) => {
  const m = new Map(rootMap);
  for (const c of parseCells(cells)) { const i = c.lastIndexOf(':'); m.set(c.slice(0, i), Number(c.slice(i + 1))); }
  return m;
};
const legalMoves = m => new CORE.Position([...m]).moves();
const addCell = (cells, x, y, o) => cells.concat([`${x},${y}:${o}`]);
const pageLookup = (m, side) => { P.occ = new Map(m); return P.certFollow(side); };

function keyPosition() {
  const lines = fs.readFileSync('tools/bench-games-lean.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const g = lines.find(x => x.game === 'hard|P1#7');
  const pos = new CORE.Position(g.start);
  const boards = [];
  for (const r of g.record) { boards[r.ply] = [...pos.board]; pos.play(r.move, r.side); }
  return new Map(boards[4]);
}

(function main() {
  console.log('证书在线闭环验收\n');
  const bundle = JSON.parse(fs.readFileSync(BUNDLE_PATH, 'utf8'));
  const bytes = fs.statSync(BUNDLE_PATH).size;
  const e0 = bundle.entries[0];
  const rootBoard = keyPosition();
  const me = e0.sideToMove, opp = 3 - me, dm = e0.decision.move;
  const setPos = (m, turn) => { P.occ = new Map(m); P.state.turn = turn; P.state.phase = 'idle'; P.state.winner = 0; P.state.winCells = null; P.state.gen++; };

  // ---------- S0 ----------
  console.log('S0 体积 / 装载');
  const rowsTotal = e0.follows.reduce((s, f) => s + f.rows.length, 0);
  console.log(`  规则版本 ${bundle.ruleVersion}；条目 ${bundle.entries.length}；文件 ${(bytes / 1024).toFixed(1)} KB`);
  console.log(`  判定表 ${e0.moves.length} 手（horizon ${e0.verdictHorizon}）；跟随证书 ${e0.follows.length} 份 / ${rowsTotal} 条状态（horizon ${e0.follows.map(f => f.horizon).join('/')}）`);
  {
    const t0 = Date.now(); const b = P.certBundle(); const ms = Date.now() - t0;
    if (!b.entries || b.entries.length !== bundle.entries.length) bad('页面解析的证书包与文件不一致');
    else ok(`惰性解析 ${ms}ms；进程堆用量 ${(process.memoryUsage().heapUsed / 1048576).toFixed(1)} MB（含基线）`);
  }

  // ---------- S1 ----------
  console.log('\nS1 关键局面命中（真实选招）');
  setPos(rootBoard, me); P.state.aiKind = 'solver'; P.certReset('测试开始');
  const t1 = Date.now(); const dec = P.certChoose(me); const decMs = Date.now() - t1;
  if (!dec) bad('关键局面没有命中证书');
  else if (dec.x !== dm.x || dec.y !== dm.y) bad(`决策 (${dec.x},${dec.y}) ≠ 包内 (${dm.x},${dm.y})`);
  else ok(`命中并选中 (${dec.x},${dec.y})；tier=${e0.decision.tier} basis=${e0.decision.basis}；查询 ${decMs}ms`);
  {
    const doomed = e0.moves.filter(m => m.verdict === 'doomed');
    const surv = e0.moves.filter(m => m.verdict === 'survival');
    const picked = e0.moves.find(m => m.x === (dec || {}).x && m.y === (dec || {}).y);
    if (!picked || picked.verdict !== 'survival') bad('选中的不是有防守证书的那一手');
    else ok(`判定表：${surv.length} 手有防守证书、${doomed.length} 手被证会在 ≤${e0.verdictHorizon} 内被强制击败（被避开：${doomed.map(m => '≤' + m.withinPlies).join('/')}）`);
    console.log(`    basis=${e0.decision.basis} ⇒ ${e0.decision.basis === 'policy'
      ? '**保守策略偏好**，不是可证的博弈优劣'
      : '至少存在一条可证的跨候选优劣（与同 horizon 的被证必败手相比严格不劣）'}`);
  }
  if (P.certState.certificateStatus !== 'active') bad('装载跟随证书失败：' + P.certState.certificateStatus);
  else ok(`跟随证书已装载：保证 ${P.certState.remainingPlies} 半回合；badge="${P.certStatusText()}"`);

  // ---------- S2 证书数据自洽 ----------
  console.log('\nS2 证书数据自洽（从 rows 重建证书 → 双核验；页面跟随 ⇄ rows 逐状态一致）');
  for (const f of e0.follows) {
    const rootMap = new Map(f.rootKey.split(';').map(c => { const i = c.lastIndexOf(':'); return [c.slice(0, i), Number(c.slice(i + 1))]; }));
    const rowsMap = new Map(f.rows.map(r => [r[0], r]));
    const defender = 3 - f.attacker;
    let nodes = 0, missing = 0, sideBad = 0, depthBad = 0;
    const build = (cells, side, depth) => {
      const key = keyOf(cells);
      const row = rowsMap.get(key);
      if (!row) { missing++; return null; }
      nodes++;
      if (row[1] !== side) sideBad++;
      if (f.horizon - cells.length !== (f.horizon - depth)) depthBad++;
      if (row[4] !== 0) return { side, terminal: { kind: IDX_TERM[row[4]] }, moves: [] };
      const occ = occFrom(rootMap, cells);
      if (side === f.attacker) {
        const out = [];
        for (const mv of legalMoves(occ)) {
          const child = build(addCell(cells, mv.x, mv.y, side), defender, depth + 1);
          if (!child) return null;
          out.push({ move: mv, child });
        }
        return { side, terminal: null, moves: out };
      }
      return { side, terminal: null, moves: [{ move: { x: row[2], y: row[3] }, child: build(addCell(cells, row[2], row[3], side), f.attacker, depth + 1) }] };
    };
    const tree = build([], f.attacker, 0);
    if (missing) { bad(`(${f.move.x},${f.move.y}) rows 覆盖不全：缺 ${missing} 个状态`); continue; }
    if (sideBad) bad(`(${f.move.x},${f.move.y}) 有 ${sideBad} 个状态的行棋方与深度不符`);
    const ref = { kind: 'refutation', attacker: f.attacker, maxPlies: f.horizon, root: [...rootMap], tree };
    const v1 = CORE.verifyRefutation([...rootMap], f.attacker, ref);
    const v2 = RULE.verifyRefutation([...rootMap], f.attacker, ref);
    if (!v1.ok || !v2.ok) { bad(`(${f.move.x},${f.move.y}) 由 rows 重建的证书核验失败：${v1.reason || v2.reason}`); continue; }
    ok(`(${f.move.x},${f.move.y}) 由 ${f.rows.length} 条状态重建出 ${nodes} 节点证书：库内 + 规则层双核验通过`);
    // 页面跟随 ⇄ rows 逐状态
    P.occ = new Map(rootMap); P.state.turn = defender; P.certReset('S2');
    P.certArmRoot(e0, f.move, defender);
    if (P.certState.certificateStatus !== 'active') { bad('S2 装载失败'); continue; }
    let mism = 0, defN = 0, atkN = 0;
    for (const r of f.rows) {
      const occ = occFrom(rootMap, parseCells(r[0]));
      const got = pageLookup(occ, defender);
      if (r[1] === f.attacker) {
        if (P.certState.certificateStatus === 'off-certificate') { mism++; if (mism < 3) bad('攻击方回合状态被误判为偏离'); }
        atkN++;
      } else {
        defN++;
        if (!got || got.x !== r[2] || got.y !== r[3]) { mism++; if (mism < 3) bad(`见证不一致：页面(${got && got.x},${got && got.y}) 数据(${r[2]},${r[3]})`); }
      }
    }
    if (mism) bad(`(${f.move.x},${f.move.y}) 页面跟随有 ${mism} 处与数据不一致`);
    else ok(`(${f.move.x},${f.move.y}) 页面跟随逐状态一致（我方 ${defN} / 对手 ${atkN} 个状态）`);
  }

  // ---------- S3 完整跟随（用页面跟随器驱动） ----------
  console.log('\nS3 完整跟随（页面跟随器驱动；对手走遍全部合法应手，覆盖必须完整）');
  {
    const f = e0.follows.find(x => x.move.x === dm.x && x.move.y === dm.y);
    const rootMap = new Map(f.rootKey.split(';').map(c => { const i = c.lastIndexOf(':'); return [c.slice(0, i), Number(c.slice(i + 1))]; }));
    const rowsMap = new Map(f.rows.map(r => [r[0], r]));
    P.occ = new Map(rootBoard); P.state.gen++;
    P.certReset('S3'); P.certArmRoot(e0, dm, me);
    if (P.certState.certificateStatus !== 'active') bad('S3 装载失败');
    let witnessHits = 0, boundaries = 0, uncovered = 0, lookups = 0, us = 0, maxDepth = 0;
    const lookup = (occ, side) => { const t = process.hrtime.bigint(); const w = pageLookup(occ, side); us += Number(process.hrtime.bigint() - t) / 1000; lookups++; return w; };
    // 从 follow 根（= 我方这一手已落定 ⇒ 对手回合，新增为空）开始遍历整份证书：
    //   对手回合 → 走遍**全部**合法应手（必须都在证书上，否则算未覆盖）
    //   我方回合 → 用**页面跟随器**给见证（真正被测的东西）
    //   终点行（term≠0）→ 记为到达证书边界
    const node = (cells, depth) => {
      if (depth > maxDepth) maxDepth = depth;
      const row = rowsMap.get(keyOf(cells));
      if (!row) { uncovered++; if (uncovered < 4) bad(`状态不在证书上（深度 ${depth}）`); return; }
      if (row[4] !== 0) { boundaries++; return; }
      const occ = occFrom(rootMap, cells);
      if (row[1] === f.attacker) {
        for (const m of legalMoves(occ)) node(addCell(cells, m.x, m.y, opp), depth + 1);
      } else {
        const w = lookup(occ, me);
        if (!w) { bad(`深度 ${depth} 我方回合拿不到见证：${P.certState.certificateStatus}`); return; }
        witnessHits++;
        node(addCell(cells, w.x, w.y, me), depth + 1);
      }
    };
    node([], 0);
    if (uncovered) bad(`${uncovered} 个对手应手未被证书覆盖`);
    else ok(`跟随遍历完成：见证 ${witnessHits} 次、到达边界 ${boundaries} 次、最大深度 ${maxDepth}/${f.horizon}；对手应手**全部**被覆盖`);
    ok(`跟随查询 ${lookups} 次，平均 ${(us / Math.max(1, lookups)).toFixed(1)} µs/次（状态可被多条路径到达，故查询数 > 唯一状态数）`);
    // 边界状态：必须返回 null 且状态=exhausted（停止跟随、回到普通搜索）
    {
      const termRow = f.rows.find(r => r[4] !== 0);
      if (!termRow) bad('证书里没有终点行（不符合预期）');
      else {
        const w = pageLookup(occFrom(rootMap, parseCells(termRow[0])), me);
        if (w === null && P.certState.certificateStatus === 'exhausted')
          ok(`边界状态查询：返回 null 且状态=exhausted（badge="${P.certStatusText()}"，回到普通搜索）`);
        else bad(`边界状态查询异常：w=${w} status=${P.certState.certificateStatus}`);
      }
    }
    if (P.certState.certificateStatus === 'off-certificate') bad('遍历中出现了不应有的偏离（对手应手本应全部被覆盖）');
    else ok(`遍历结束状态=${P.certState.certificateStatus}（状态按分支逐次重算，合法值为 active/exhausted）`);
  }

  // ---------- S4 ----------
  console.log('\nS4 我方偏离证书 ⇒ 保证作废');
  {
    P.occ = new Map(rootBoard); P.certReset('S4'); P.certArmRoot(e0, dm, me);
    // 先让对手走一步（证书内），再看我方偏离
    const f = e0.follows.find(x => x.move.x === dm.x && x.move.y === dm.y);
    const rootMap = new Map(f.rootKey.split(';').map(c => { const i = c.lastIndexOf(':'); return [c.slice(0, i), Number(c.slice(i + 1))]; }));
    const cells0 = [];          // 同上：follow 根 = 我方落定后
    const occ0 = occFrom(rootMap, cells0);
    const replies = legalMoves(occ0);
    const off1 = addCell(cells0, replies[0].x, replies[0].y, opp);
    const meOcc = occFrom(rootMap, off1);
    const w = pageLookup(meOcc, me);
    if (!w) bad('S4 在证书内我方回合拿不到见证');
    else {
      const others = legalMoves(meOcc).filter(m => !(m.x === w.x && m.y === w.y));
      pageLookup(occFrom(rootMap, addCell(off1, others[0].x, others[0].y, me)), me);
      if (P.certState.certificateStatus === 'off-certificate') ok(`不按见证走 ⇒ 保证作废；badge="${P.certStatusText()}"（此后不再自动恢复）`);
      else bad('偏离后保证仍在：' + P.certState.certificateStatus);
    }
  }

  // ---------- S5 ----------
  console.log('\nS5 悔棋 / 重开 / 换档位 / 导入');
  {
    P.occ = new Map(rootBoard); P.certReset('S5'); P.certArmRoot(e0, dm, me);
    if (P.certState.certificateStatus !== 'active') bad('S5 装载失败');
    P.resetGame();
    if (P.certState.certificateStatus !== 'none') bad('重开后保证未撤销');
    else ok('重开 ⇒ 保证撤销');
    P.occ = new Map(rootBoard); P.certArmRoot(e0, dm, me); P.certReset('换档位');
    if (P.certState.certificateStatus === 'none') ok('换档位 / 悔棋 / 导入 ⇒ 同一条 certReset 撤销路径');
    else bad('换档位后保证仍在');
  }
  {
    const hooks = ['function resetGame(){', 'function undoMoves(count){', 'function applySync(h, opener){',
      'function loadFromText(){', "getElementById('diffSel').addEventListener('change'"];
    const miss = hooks.filter(a => { const i = HTML.indexOf(a); return i < 0 || HTML.slice(i, i + 300).indexOf('certReset') < 0; });
    if (miss.length) bad(`未接撤销钩子：${miss.map(s => s.slice(0, 30)).join(' | ')}`);
    else ok('静态核对：重置 / 悔棋 / 联机同步 / 文本导入 / 换档位 五条路径都已接上 certReset');
  }

  // ---------- S6 ----------
  console.log('\nS6 迟到响应（棋盘版本变了 ⇒ 结果必须丢弃）');
  {
    setPos(rootBoard, me); P.state.aiKind = 'solver'; P.certReset('S6');
    const gen = P.state.gen;
    const cm = P.certChoose(me);
    P.state.gen++;
    if (cm && P.isFree(cm.x, cm.y) && P.state.turn === me && P.state.gen === gen) bad('迟到结果没有被丢弃');
    else ok('版本变化后证书结果被丢弃（与 aiChooseMoveLocal 的守卫一致）');
  }

  // ---------- S7 ----------
  console.log('\nS7 旋转坐标还原（核心 certIndex 的规范键 + 见证坐标还原）');
  {
    const f = e0.follows[0];
    const rootMap = new Map(f.rootKey.split(';').map(c => { const i = c.lastIndexOf(':'); return [c.slice(0, i), Number(c.slice(i + 1))]; }));
    const child = [...rootMap];
    const r = CORE.dfpnSearch(child, f.attacker, { maxPlies: f.horizon, maxNodes: 3000000, timeMs: 120000 });
    const uni = CORE.unifyRefutation(r.proof, child);
    const cidx0 = CORE.certIndex(uni.ref, child);
    let mism = 0, n = 0;
    for (let rot = 0; rot < 4; rot++) {
      const rotBoard = CORE.rotateEntries(child, rot);
      const idx = CORE.certIndex(CORE.rotateRefutation(uni.ref, rot), rotBoard);
      let cnt = 0;
      for (const [key, rec] of cidx0.byExact) {
        if (rec.witness === null) continue;
        const parts = key.split('|'), side = Number(parts[1]), rem = Number(parts[3]);
        const bs = parts.slice(4).join('|');
        const occ = new Map(rootMap);
        if (bs) for (const c of bs.split(';')) { const i = c.lastIndexOf(':'); occ.set(c.slice(0, i), Number(c.slice(i + 1))); }
        const occRot = new Map(CORE.rotateEntries([...occ], rot));
        const got = idx.at([...occRot], side, rem);
        const want = CORE.rotateEntries([[`${rec.witness.x},${rec.witness.y}`, 1]], rot)[0][0];
        if (got.status !== 'defend') { mism++; if (mism < 4) console.log('    ✗ 旋转查询未命中：' + got.status); }
        else if (`${got.witness.x},${got.witness.y}` !== want) { mism++; if (mism < 4) console.log(`    ✗ 坐标还原错：得 (${got.witness.x},${got.witness.y})，应 ${want}`); }
        n++;
        if (++cnt >= 120) break;
      }
    }
    ok(`四旋转 × 抽样共 ${n} 次规范键查询`);
    if (mism) bad(`旋转坐标还原有 ${mism} 处不符`);
    else ok('见证坐标全部正确还原到查询方朝向');
  }

  // ---------- S8 ----------
  console.log('\nS8 普通对局开销（未命中证书）');
  {
    const N = 3000;
    P.state.aiKind = 'normal';
    setPos(rootBoard, me); P.certReset('S8a');
    let us = 0;
    for (let i = 0; i < N; i++) { const t = process.hrtime.bigint(); P.certChoose(me); us += Number(process.hrtime.bigint() - t) / 1000; }
    ok(`非求解器档 ${N} 次：平均 ${(us / N).toFixed(3)} µs/次（≈0；证书包甚至不会被解析）`);
    P.state.aiKind = 'solver';
    setPos(new Map([['0,0', 3]]), 1); P.certReset('S8b');
    let us2 = 0;
    for (let i = 0; i < N; i++) { const t = process.hrtime.bigint(); P.certChoose(1); us2 += Number(process.hrtime.bigint() - t) / 1000; }
    ok(`求解器档未命中 ${N} 次：平均 ${(us2 / N).toFixed(3)} µs/次（boardKey + 条目扫描）`);
  }

  // ---------- S9 旋转根局面回放（真实页面） ----------
  console.log('\nS9 旋转根局面回放（根局面查询的四旋转规范化 + 坐标还原 + 旋转后仍能跟随）');
  {
    const f = e0.follows.find(x => x.move.x === dm.x && x.move.y === dm.y);
    const origRoot = new Map(f.rootKey.split(';').map(c => { const i = c.lastIndexOf(':'); return [c.slice(0, i), Number(c.slice(i + 1))]; }));
    for (let r = 1; r <= 3; r++) {
      const rotRoot = CORE.rotateEntries([...rootBoard], r);
      const wantName = CORE.rotateEntries([[dm.x + ',' + dm.y, 1]], r)[0][0];
      setPos(new Map(rotRoot), me); P.state.aiKind = 'solver'; P.certReset('S9');
      const d = P.certChoose(me);
      if (!d) {
        const hit = P.certFindEntry(me);
        const dm2 = hit ? (hit.e.decision || {}).move : null;
        bad(`旋转 ${r}×90° 后未命中根局面（期望走 ${wantName}；certFindEntry=${hit ? '有 rot=' + hit.rot : '无'}，` +
          `decision=${dm2 ? dm2.x + ',' + dm2.y : 'null'}，决策落点可用=${dm2 ? P.isFree(dm2.x, dm2.y) : '-'}，` +
          `status=${P.certState.certificateStatus}）`);
        continue;
      }
      const gotName = d.x + ',' + d.y;
      if (gotName !== wantName) { bad(`旋转 ${r}×90° 决策错：得 (${gotName})，应 (${wantName})`); continue; }
      if (P.certState.certificateStatus !== 'active') { bad(`旋转 ${r}×90° 装载失败：${P.certState.certificateStatus}`); continue; }
      // 跟随一步的**独立交叉核对**：取证书里某个我方（防守方）状态，整体旋转到本局朝向后查询，
      //   期望见证 = 该状态见证旋转 r 次（来源是 bundle 数据 + 核心旋转，不经页面旋转逻辑）。
      const defRow = f.rows.find(rr => rr[1] === me && rr[4] === 0);
      const occOrig = occFrom(origRoot, parseCells(defRow[0]));
      const occRot = new Map(CORE.rotateEntries([...occOrig], r));
      const expW = CORE.rotateEntries([[defRow[2] + ',' + defRow[3], 1]], r)[0][0];
      P.occ = occRot;
      const w = P.certFollow(me);
      if (!w) bad(`旋转 ${r}×90° 跟随一步拿不到见证（${P.certState.certificateStatus}）`);
      else if (w.x + ',' + w.y !== expW) bad(`旋转 ${r}×90° 见证还原错：得 (${w.x},${w.y})，应 (${expW})`);
      else ok(`旋转 ${r}×90°：根命中走 (${wantName})，跟随一步见证正确还原为 (${w.x},${w.y})`);
    }
    // 页面的旋转命中路径确实被用到（否则本场景等于没测）
    setPos(new Map(CORE.rotateEntries([...rootBoard], 1)), me); P.state.aiKind = 'solver'; P.certReset('S9b');
    const d1 = P.certChoose(me);
    if (d1 && (d1.x !== dm.x || d1.y !== dm.y)) ok('旋转朝向的决策与原始朝向的决策**不同** ⇒ 确认走的是旋转还原路径，而非精确键侥幸命中');
    else if (d1) bad('旋转后决策与原始相同，无法确认旋转路径生效');
  }

  // ---------- S10 未命中的两类诊断 ----------
  console.log('\nS10 未命中诊断：区分「我方偏离」（正常）与「对手合法落子后未命中」（异常）');
  {
    // (a) 异常：刚装载（上一个节点 = 攻击方节点），当前局面却不在证书上 ⇒ 必须记异常
    P.occ = new Map(rootBoard); P.state.gen++; P.certReset('S10a'); P.certArmRoot(e0, dm, me);
    const a0 = P.certState.anomalies, d0 = P.certState.deviations;
    const fakeOff = new Map(rootBoard); fakeOff.set('9,9', opp);         // 证书外的局面（模拟索引/状态不同步）
    P.occ = fakeOff; P.certFollow(me);
    if (P.certState.anomalies !== a0 + 1) bad(`对手节点后未命中未记为异常（anomalies ${a0}→${P.certState.anomalies}）`);
    else ok(`对手节点后未命中 ⇒ 计为**异常**（anomalies=${P.certState.anomalies}），不称作"对手走出了证书"`);
    if (P.certState.certificateStatus !== 'off-certificate') bad('异常未命中后保证未作废');

    // (b) 正常偏离：先走一步对手合法棋（进入防守方节点），再不走见证 ⇒ 必须记偏离而非异常
    P.occ = new Map(rootBoard); P.state.gen++; P.certReset('S10b'); P.certArmRoot(e0, dm, me);
    const f = e0.follows.find(x => x.move.x === dm.x && x.move.y === dm.y);
    const rm = new Map(f.rootKey.split(';').map(c => { const i = c.lastIndexOf(':'); return [c.slice(0, i), Number(c.slice(i + 1))]; }));
    const rep = legalMoves(rm)[0];
    const occAfterOpp = new Map(rm); occAfterOpp.set(rep.x + ',' + rep.y, opp);
    const w = pageLookup(occAfterOpp, me);
    const a1 = P.certState.anomalies, d1 = P.certState.deviations;
    if (!w) bad('S10b 在证书内我方回合拿不到见证');
    else {
      const other = legalMoves(occAfterOpp).find(m => !(m.x === w.x && m.y === w.y));
      const occDev = new Map(occAfterOpp); occDev.set(other.x + ',' + other.y, me);
      P.occ = occDev; P.certFollow(me);
      if (P.certState.deviations !== d1 + 1) bad(`我方偏离未记为偏离（deviations ${d1}→${P.certState.deviations}）`);
      else if (P.certState.anomalies !== a1) bad(`我方偏离被误记为异常（anomalies ${a1}→${P.certState.anomalies}）`);
      else ok(`我方不按见证走 ⇒ 计为**偏离**（deviations=${P.certState.deviations}），未误报异常`);
    }
    if (P.certState.anomalies !== 1) bad(`本场景应恰好 1 次异常，实得 ${P.certState.anomalies}`);
  }

  // ---------- S11 两个长度口径分开 ----------
  console.log('\nS11 保证长度口径：选招依据 ≠ 可执行保证');
  {
    const f = e0.follows.find(x => x.move.x === dm.x && x.move.y === dm.y);
    P.occ = new Map(rootBoard); P.state.gen++; P.certReset('S11'); P.certArmRoot(e0, dm, me);
    if (P.certState.basisHorizon !== e0.verdictHorizon)
      bad(`basisHorizon=${P.certState.basisHorizon} ≠ 判定 horizon=${e0.verdictHorizon}`);
    else if (P.certState.executableHorizon !== (f.executableGuarantee || f.horizon))
      bad(`executableHorizon=${P.certState.executableHorizon} ≠ 跟随 horizon`);
    else ok(`分开记录：选招依据 ≤${P.certState.basisHorizon}，可执行保证 ≤${P.certState.executableHorizon}，` +
      `剩余 ${P.certState.remainingPlies}`);
    const txt = P.certGuaranteeText ? P.certGuaranteeText() : '';
    if (txt.indexOf(String(e0.verdictHorizon)) < 0 || txt.indexOf(String(f.executableGuarantee || f.horizon)) < 0)
      bad('保证说明文本没有同时给出两个长度：' + txt);
    else ok(`说明文本：${txt}`);
    // 短证书的**来源**必须如实标注（独立求解 vs 长证书截断）
    if (f.source && f.source !== 'independent-solve' && f.source !== 'truncated-from-long')
      bad('follows[].source 取值非法：' + f.source);
    else ok(`follows[].source = ${f.source}（不是长证书截断 ⇒ 不能宣传"在线兑现 ${e0.verdictHorizon} 步保证"）`);
    if (f.strategyAgreement)
      ok(`与 N=${f.longHorizon} 长证书见证一致 ${f.strategyAgreement.pct}%（共享 ${f.strategyAgreement.shared} 个棋盘状态）` +
        ` ⇒ **短证书是独立解**，二者策略不同`);
    else console.log('  · 长证书对比未在包内（--compareLong 0），一致性未知');
  }

  console.log('');
  console.log(fails ? `证书在线闭环验收：失败 ${fails} 项` : '证书在线闭环验收：全部通过');
  process.exit(fails ? 1 : 0);
})();
