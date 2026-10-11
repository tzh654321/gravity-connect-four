'use strict';
/* ============================================================
   verify-strategy-fast —— 核验器的**实现加速版**（验证条件与参考实现完全一致）

   与 `tools/verify-strategy.js`（**慢速参考基准**，继续保留）的关系：

     相同：检查项、检查**顺序**、失败原因**文本**、出错节点路径（`P侧@x,y` 序列）、
           节点计数（`nodes` / `andNodes` / `attackerNodes` / `leaves`）、返回值形状。
     不同：只改实现方式 ——

       | 环节 | 参考实现（rules-ref + verify-strategy） | 本文件 |
       |---|---|---|
       | 棋盘 | 每个节点 `new Map(b)` 整盘复制 | 一条 DFS 路径共用**一块** Map，落子/撤销 |
       | 合法落点 | 每节点从**全部棋子四邻**重建 + 排序 | 增量维护 `avail`（落子时只重查 ≤8 个候选格） |
       | 连四判断 | 每节点扫**整盘所有棋子** | 只查**刚落的那一格**（父节点已确认无胜负） |
       | 胜点集 | 每个候选各自整盘复制后判连四 | 临时置子判连四，不复制 |

   独立性约束（**不因加速而放松**）：
     - **不**调用 solver-core 的 `Position`；规则语义仍来自 `rules-ref.js` 的独立写法
       （自己重写的重力分区 + 四格窗口扫描判连四）；
     - **不**使用局部战术快捷判断（"必须挡"之类）替代任何检查；
     - **不**使用证明缓存 / 置换表；
     - **完整保留** AND 全应手覆盖、行棋方与落子数奇偶一致、终点合法性、
       剩余半回合边界、落点合法性、攻击方一致性。

   增量的正确性依据（两条，都在 `check-verify-fast.js` 的审计模式里逐节点断言）：
     ① `avail`（去重排序后）=== `rules-ref.legalMoves(board)`；
     ② 增量连四 === `rules-ref.winner(board)`（因为父节点已确认 `w === 0`，
        所以新胜只能由**新落下的那一格**产生）。
   ============================================================ */

const R = require('./rules-ref');

/* 落点用整数编码（集合与排序比字符串快），棋盘仍用 rules-ref 的字符串键 Map
   —— 这样 `R.line4` / `R.gravity` 这些**独立规则原语**可以原样复用。 */
const OFF = 8192, SPAN = 16384;
const enc = (x, y) => (x + OFF) * SPAN + (y + OFF);
const decX = e => Math.floor(e / SPAN) - OFF;
const decY = e => (e % SPAN) - OFF;

const GDIRS = [[0, -1], [-1, 0], [0, 1], [1, 0]];   // rules-ref.gravity 的全部取值
const NB4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

class FastBoard {
  constructor(entries) {
    this.occ = new Map();                 // "x,y" -> 1|2|3（含中立子，与 rules-ref 同口径）
    for (const [k, v] of entries) this.occ.set(k, v);
    this.avail = new Set();               // 合法落点（整数编码）；**单调增**，落子时删除
    for (const m of R.legalMoves(this.occ)) this.avail.add(enc(m.x, m.y));   // 只在构造时重建一次
    this.log = [];
  }

  /** 与 rules-ref.sideToMove 同口径：`(size - 1) % 2`（size 含中立子） */
  sideToMove() { return ((this.occ.size - 1) % 2 === 0) ? 1 : 2; }

  has(x, y) { return this.avail.has(enc(x, y)); }

  /** 与 rules-ref.legalMoves 同集合、同顺序（按 x,y 升序） */
  legalSorted() {
    const a = Array.from(this.avail);
    a.sort((p, q) => p - q);
    const out = new Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = { x: decX(a[i]), y: decY(a[i]) };
    return out;
  }

  /** 落子（调用方自行保证该格合法）。落子**只会让更多格变合法** ⇒ avail 单调增 */
  place(x, y, side) {
    const k = R.K(x, y), e = enc(x, y);
    const wasAvail = this.avail.has(e);
    this.occ.set(k, side);
    this.avail.delete(e);
    const added = [];
    // (a) 邻居：q 出现后它们"贴到了棋子"，只需再看"下方有子"
    for (let i = 0; i < 4; i++) {
      const cx = x + NB4[i][0], cy = y + NB4[i][1], e2 = enc(cx, cy), k2 = R.K(cx, cy);
      if (this.occ.has(k2) || this.avail.has(e2)) continue;
      const g = R.gravity(cx, cy);
      if (this.occ.has(R.K(cx + g[0], cy + g[1]))) { this.avail.add(e2); added.push(e2); }
    }
    // (b) 原像 `r + gravity(r) === q`：q 成了它们的支撑，只需再看"相邻有子"
    for (let i = 0; i < 4; i++) {
      const gx = GDIRS[i][0], gy = GDIRS[i][1];
      const rx = x - gx, ry = y - gy;
      const gg = R.gravity(rx, ry);
      if (gg[0] !== gx || gg[1] !== gy) continue;          // 该格的重力方向不是这个 ⇒ 不是原像
      const e2 = enc(rx, ry), k2 = R.K(rx, ry);
      if (this.occ.has(k2) || this.avail.has(e2)) continue;
      let adj = false;
      for (let j = 0; j < 4; j++) if (this.occ.has(R.K(rx + NB4[j][0], ry + NB4[j][1]))) { adj = true; break; }
      if (adj) { this.avail.add(e2); added.push(e2); }
    }
    this.log.push({ k, e, wasAvail, added });
  }

  /** 撤销最近一次落子（严格 LIFO） */
  undo() {
    const t = this.log.pop();
    this.occ.delete(t.k);
    for (let i = 0; i < t.added.length; i++) this.avail.delete(t.added[i]);
    if (t.wasAvail) this.avail.add(t.e);
  }

  /** 等价于「在 b 上落 side 于 (x,y) 后 line4(board, x, y, side)」，但不复制棋盘 */
  winsAt(x, y, side) {
    const k = R.K(x, y);
    const prev = this.occ.get(k);
    this.occ.set(k, side);
    const w = R.line4(this.occ, x, y, side);
    if (prev === undefined) this.occ.delete(k); else this.occ.set(k, prev);
    return w;
  }

  /** 与 rules-ref.winPoints 同集合、同顺序；`limit` 用于只关心"是否有/是否 ≥2"时提前退出 */
  winPointsScan(side, limit) {
    const out = [];
    const legal = this.legalSorted();
    for (let i = 0; i < legal.length; i++) {
      if (this.winsAt(legal[i].x, legal[i].y, side)) {
        out.push(legal[i]);
        if (limit != null && out.length >= limit) break;
      }
    }
    return out;
  }
}

/* ---------------------------------------------------------------- 获胜策略树 */

function verifyFast(entries, attacker, tree, opts) {
  if (!tree) return { ok: false, reason: '缺少策略树' };
  if (attacker !== 1 && attacker !== 2) return { ok: false, reason: '攻击方非法' };
  let nodes = 0, andNodes = 0, failure = null;
  const b = new FastBoard(entries);
  if (R.winner(b.occ)) return { ok: false, reason: '起始局面已终局' };

  const audit = opts && opts.audit;
  const stack = [];
  const walk = (node, px, py, ps) => {
    if (failure) return;
    if (++nodes > 500000) { failure = { ok: false, reason: '策略树过大（>50 万节点）', path: stack.slice() }; return; }
    const side = b.sideToMove();
    const w = px === null ? 0 : (R.line4(b.occ, px, py, ps) ? ps : 0);
    if (audit) audit(b, { side, w, px, py, ps, node, kind: 'tree' });
    if (node.terminal) {
      const t = node.terminal;
      if (t.kind === 'connect4') {
        if (w !== attacker) failure = { ok: false, reason: 'connect4 终点不成立', path: stack.slice() };
        return;
      }
      if (t.kind === 'double-threat') {
        const a = b.winPointsScan(attacker, null).length, d = b.winPointsScan(3 - attacker, null).length;
        if (!(a >= 2 && d === 0)) failure = { ok: false, reason: `double-threat 终点不成立（胜点 ${a}/${d}）`, path: stack.slice() };
        return;
      }
      if (t.kind === 'immediate-win') {
        if (side !== attacker) { failure = { ok: false, reason: 'immediate-win 终点出现在对手回合', path: stack.slice() }; return; }
        const ok = b.has(t.at.x, t.at.y) && b.winsAt(t.at.x, t.at.y, attacker);
        if (!ok) failure = { ok: false, reason: 'immediate-win 指向的不是即时胜点', path: stack.slice() };
        return;
      }
      failure = { ok: false, reason: '未知终点类型：' + t.kind, path: stack.slice() };
      return;
    }
    if (w) { failure = { ok: false, reason: w === attacker ? '已连四却仍在展开' : '该子树里防守方已连四', path: stack.slice() }; return; }
    const moves = node.moves || [];
    if (side === attacker) {
      if (moves.length !== 1) { failure = { ok: false, reason: 'OR 节点必须恰好 1 步', path: stack.slice() }; return; }
      const m = moves[0].move;
      if (!b.has(m.x, m.y)) { failure = { ok: false, reason: 'OR 步非法', path: stack.slice() }; return; }
      b.place(m.x, m.y, side);
      stack.push(`P${side}@${m.x},${m.y}`);
      walk(moves[0].child, m.x, m.y, side);
      stack.pop();
      b.undo();
      return;
    }
    andNodes++;
    const legal = b.legalSorted();
    if (moves.length !== legal.length) {
      failure = { ok: false, reason: `AND 节点未覆盖全部应手（记录 ${moves.length} / 合法 ${legal.length}）`, path: stack.slice() };
      return;
    }
    const got = new Set();
    for (let i = 0; i < moves.length; i++) got.add(enc(moves[i].move.x, moves[i].move.y));
    for (let i = 0; i < legal.length; i++) {
      if (!got.has(enc(legal[i].x, legal[i].y))) {
        failure = { ok: false, reason: `AND 节点缺少应手 ${legal[i].x},${legal[i].y}`, path: stack.slice() }; return;
      }
    }
    if (b.winPointsScan(side, 1).length) { failure = { ok: false, reason: '对手本可立即连四（攻击给了对手先赢）', path: stack.slice() }; return; }
    for (const e of moves) {
      if (failure) return;
      if (!b.has(e.move.x, e.move.y)) { failure = { ok: false, reason: 'AND 步非法', path: stack.slice() }; return; }
      b.place(e.move.x, e.move.y, side);
      stack.push(`P${side}@${e.move.x},${e.move.y}`);
      walk(e.child, e.move.x, e.move.y, side);
      stack.pop();
      b.undo();
    }
  };

  walk(tree, null, null, 0);
  return failure || { ok: true, nodes, andNodes };
}

/* ------------------------------------------------------------------ DAG 版 */

function verifyDagFast(entries, attacker, dag, opts) {
  if (!dag || !Array.isArray(dag.nodes) || !dag.nodes.length) return { ok: false, reason: '缺少 DAG' };
  if (attacker !== 1 && attacker !== 2) return { ok: false, reason: '攻击方非法' };
  const b = new FastBoard(entries);
  if (R.winner(b.occ)) return { ok: false, reason: '起始局面已终局' };
  const audit = opts && opts.audit;
  const memo = new Map();
  let visited = 0, memoHits = 0, failure = null;

  const walk = (id, px, py, ps) => {
    if (failure) return;
    if (memo.has(id)) { memoHits++; return; }
    if (++visited > 500000) { failure = { ok: false, reason: 'DAG 过大' }; return; }
    const node = dag.nodes[id];
    if (!node) { failure = { ok: false, reason: `DAG 节点 ${id} 不存在` }; return; }
    const side = b.sideToMove();
    if (node.side !== side) { failure = { ok: false, reason: `DAG 节点 ${id} 的行棋方与局面不符（应 P${side}，记 P${node.side}）` }; return; }
    const w = px === null ? 0 : (R.line4(b.occ, px, py, ps) ? ps : 0);
    if (audit) audit(b, { side, w, px, py, ps, node, id, kind: 'dag' });
    if (node.terminal) {
      const t = node.terminal;
      if (t.kind === 'connect4') { if (w !== attacker) failure = { ok: false, reason: `节点 ${id} connect4 终点不成立` }; }
      else if (t.kind === 'double-threat') {
        if (!(b.winPointsScan(attacker, 2).length >= 2 && b.winPointsScan(3 - attacker, 1).length === 0)) {
          failure = { ok: false, reason: `节点 ${id} 双杀终点不成立` };
        }
      } else if (t.kind === 'immediate-win') {
        if (side !== attacker || !b.winsAt(t.at.x, t.at.y, attacker)) failure = { ok: false, reason: `节点 ${id} immediate-win 终点不成立` };
      } else failure = { ok: false, reason: `节点 ${id} 未知终点类型` };
      if (!failure) memo.set(id, true);
      return;
    }
    if (w) { failure = { ok: false, reason: `节点 ${id}：已终局却仍展开` }; return; }
    const moves = node.moves || [];
    if (node.side === attacker) {
      if (moves.length !== 1) { failure = { ok: false, reason: `节点 ${id}（OR）必须恰好 1 步` }; return; }
      const m = moves[0].move;
      if (!b.has(m.x, m.y)) { failure = { ok: false, reason: `节点 ${id} OR 步非法` }; return; }
      b.place(m.x, m.y, side);
      walk(moves[0].child, m.x, m.y, side);
      b.undo();
    } else {
      const legal = b.legalSorted();
      if (moves.length !== legal.length) { failure = { ok: false, reason: `节点 ${id}（AND）未覆盖全部应手（${moves.length}/${legal.length}）` }; return; }
      const got = new Set();
      for (let i = 0; i < moves.length; i++) got.add(enc(moves[i].move.x, moves[i].move.y));
      for (let i = 0; i < legal.length; i++) {
        if (!got.has(enc(legal[i].x, legal[i].y))) { failure = { ok: false, reason: `节点 ${id} 缺少应手 ${legal[i].x},${legal[i].y}` }; return; }
      }
      if (b.winPointsScan(side, 1).length) { failure = { ok: false, reason: `节点 ${id}：对手本可立即连四` }; return; }
      for (const e of moves) {
        if (failure) return;
        if (!b.has(e.move.x, e.move.y)) { failure = { ok: false, reason: `节点 ${id} AND 步非法` }; return; }
        b.place(e.move.x, e.move.y, side);
        walk(e.child, e.move.x, e.move.y, side);
        b.undo();
      }
    }
    if (!failure) memo.set(id, true);
  };

  walk(dag.root, null, null, 0);
  return failure || { ok: true, nodes: visited, memoHits, dagNodes: dag.nodes.length };
}

/* --------------------------------------------------- 连续威胁序列（P3 的 seq） */

function verifySeqFast(entries, seq, opts) {
  if (!seq || !Array.isArray(seq.steps) || !seq.steps.length) return { ok: false, reason: '缺少证明步骤' };
  const attacker = seq.attacker;
  if (attacker !== 1 && attacker !== 2) return { ok: false, reason: '攻击方非法' };
  const b = new FastBoard(entries);
  if (R.winner(b.occ)) return { ok: false, reason: '起始局面已终局' };
  const audit = opts && opts.audit;
  const steps = seq.steps;
  let lx = null, ly = null, ls = 0;      // 仅用于审计：上一步落在哪

  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    const n = i + 1;
    const side = b.sideToMove();
    if (audit) {
      const w = ls === 0 ? 0 : (R.line4(b.occ, lx, ly, ls) ? ls : 0);
      audit(b, { side, w, px: lx, py: ly, ps: ls, step: n, kind: 'seq' });
    }
    if (st.side !== side) return { ok: false, reason: `第${n}步行棋方不符（应 P${side}，记 P${st.side}）` };
    const isAttack = st.side === attacker, last = i === steps.length - 1;

    // —— 落子**前**的被迫性检查（只对防守步；镜像核心 verifyProof）——
    if (!isAttack) {
      if (b.winPointsScan(st.side, 1).length) return { ok: false, reason: `第${n}步防守方本可立即连四（攻击给了对手先赢）` };
      const aw = b.winPointsScan(attacker, 2);
      if (aw.length !== 1) return { ok: false, reason: `第${n}步防守并非被迫（当时攻击方胜点数 ${aw.length}）` };
      if (aw[0].x !== st.move.x || aw[0].y !== st.move.y) return { ok: false, reason: `第${n}步未占唯一杀点` };
    }
    if (!b.has(st.move.x, st.move.y)) return { ok: false, reason: `第${n}步落点非法` };
    b.place(st.move.x, st.move.y, st.side);
    lx = st.move.x; ly = st.move.y; ls = st.side;

    const w = R.line4(b.occ, st.move.x, st.move.y, st.side) ? st.side : 0;
    if (w) {
      if (w !== attacker) return { ok: false, reason: `第${n}步后获胜方不是攻击方` };
      if (!last) return { ok: false, reason: `第${n}步已连四但记录未终止` };
      return { ok: true, plies: steps.length, terminal: 'connect4' };
    }
    if (isAttack) {
      if (b.winPointsScan(3 - attacker, 1).length) return { ok: false, reason: `第${n}步后防守方有即时胜点（攻击未防住对手）` };
      const aw = b.winPointsScan(attacker, 2);
      if (last) {
        return aw.length >= 2 ? { ok: true, plies: steps.length, terminal: 'double-threat' }
          : { ok: false, reason: `末步既非连四也非双杀（攻击方胜点数 ${aw.length}）` };
      }
      if (aw.length < 1) return { ok: false, reason: `第${n}步没有制造任何即时威胁` };
    }
  }
  return { ok: false, reason: '记录未给出终止结论' };
}

/* -------------------------------------------------------------- 反证证书 */

function verifyRefutationFast(entries, attacker, ref, opts) {
  if (!ref || !ref.tree) return { ok: false, reason: '缺少反证证书' };
  if (ref.kind !== 'refutation') return { ok: false, reason: '证书类型不是 refutation' };
  if (!Number.isInteger(ref.maxPlies) || ref.maxPlies <= 0) return { ok: false, reason: '必须带正整数半回合上限' };
  if (attacker !== 1 && attacker !== 2) return { ok: false, reason: '攻击方非法' };
  const defender = 3 - attacker;
  const b = new FastBoard(entries);
  if (R.winner(b.occ)) return { ok: false, reason: '起始局面已终局' };
  const audit = opts && opts.audit;
  let nodes = 0, attackerNodes = 0, leaves = 0, failure = null;

  const stack = [];
  const walk = (side, rem, node, px, py, ps) => {
    if (failure) return;
    if (++nodes > 500000) { failure = { ok: false, reason: '反证证书过大（>50 万节点）', path: stack.slice() }; return; }
    const expect = b.sideToMove();
    if (side !== expect) { failure = { ok: false, reason: `行棋方不符（应 P${expect}，记 P${side}）`, path: stack.slice() }; return; }
    const w = px === null ? 0 : (R.line4(b.occ, px, py, ps) ? ps : 0);
    if (audit) audit(b, { side, w, rem, px, py, ps, node, kind: 'refutation' });
    if (w === attacker) { failure = { ok: false, reason: '证书里出现攻击方已连四（反证不成立）', path: stack.slice() }; return; }
    if (node.terminal) {
      leaves++;
      const t = node.terminal;
      if (t.kind === 'depth-limit') {
        if (w) failure = { ok: false, reason: 'depth-limit 终点却已终局', path: stack.slice() };
        else if (rem !== 0) failure = { ok: false, reason: `depth-limit 终点出现在还有 ${rem} 半回合时`, path: stack.slice() };
        return;
      }
      if (t.kind === 'connect4' || t.kind === 'defender-win') {
        if (w !== defender) failure = { ok: false, reason: 'defender 连四终点不成立', path: stack.slice() };
        return;
      }
      if (t.kind === 'defender-immediate-win') {
        if (side !== defender || !b.winPointsScan(defender, 1).length) failure = { ok: false, reason: 'defender-immediate-win 不成立', path: stack.slice() };
        return;
      }
      if (t.kind === 'defender-double-threat') {
        if (side !== attacker || b.winPointsScan(attacker, 1).length !== 0 || b.winPointsScan(defender, 2).length < 2) {
          failure = { ok: false, reason: 'defender-double-threat 不成立', path: stack.slice() };
        }
        return;
      }
      failure = { ok: false, reason: '反证证书里出现非法终点：' + t.kind, path: stack.slice() };
      return;
    }
    if (w) { failure = { ok: false, reason: '已终局却仍在展开', path: stack.slice() }; return; }
    if (rem <= 0) { failure = { ok: false, reason: '半回合已用尽却不是 depth-limit 终点', path: stack.slice() }; return; }
    const moves = node.moves || [];
    if (side === attacker) {
      attackerNodes++;
      const legal = b.legalSorted();
      if (moves.length !== legal.length) {
        failure = { ok: false, reason: `攻击方节点未覆盖全部走法（记录 ${moves.length} / 合法 ${legal.length}）`, path: stack.slice() }; return;
      }
      const got = new Set();
      for (let i = 0; i < moves.length; i++) got.add(enc(moves[i].move.x, moves[i].move.y));
      for (let i = 0; i < legal.length; i++) {
        if (!got.has(enc(legal[i].x, legal[i].y))) {
          failure = { ok: false, reason: `攻击方节点缺少走法 ${legal[i].x},${legal[i].y}`, path: stack.slice() }; return;
        }
      }
      for (const e of moves) {
        if (failure) return;
        if (!b.has(e.move.x, e.move.y)) { failure = { ok: false, reason: '攻击方走法非法', path: stack.slice() }; return; }
        b.place(e.move.x, e.move.y, side);
        stack.push(`P${side}@${e.move.x},${e.move.y}`);
        walk(defender, rem - 1, e.child, e.move.x, e.move.y, side);
        stack.pop();
        b.undo();
      }
      return;
    }
    if (moves.length !== 1) { failure = { ok: false, reason: '防守方节点必须恰好 1 步（见证）', path: stack.slice() }; return; }
    const m0 = moves[0].move;
    if (!b.has(m0.x, m0.y)) { failure = { ok: false, reason: '防守方走法非法', path: stack.slice() }; return; }
    b.place(m0.x, m0.y, side);
    stack.push(`P${side}@${m0.x},${m0.y}`);
    walk(attacker, rem - 1, moves[0].child, m0.x, m0.y, side);
    stack.pop();
    b.undo();
  };

  walk(b.sideToMove(), ref.maxPlies, ref.tree, null, null, 0);
  return failure || { ok: true, nodes, attackerNodes, leaves };
}

module.exports = { FastBoard, verifyFast, verifyDagFast, verifySeqFast, verifyRefutationFast, enc, decX, decY };

/* ------------------------------------------------------------------ CLI

   批量核验用（不替换参考实现）：
     node tools/verify-strategy-fast.js <proofs.jsonl>          # 用快速实现
     node tools/verify-strategy-fast.js <proofs.jsonl> --ref    # 用慢速参考实现
     node tools/verify-strategy-fast.js <proofs.jsonl> --both   # 双跑并逐项比对（不一致即退出码 1）
   ============================================================ */
if (require.main === module) {
  const fs = require('fs');
  const VS = require('./verify-strategy');          // 参考实现（其 CLI 段在 require 时不会执行）
  const args = process.argv.slice(2);
  const both = args.includes('--both');
  const useRef = args.includes('--ref') || both;
  const file = args.find(a => !a.startsWith('--'));
  if (!file) { console.error('用法：node tools/verify-strategy-fast.js <proofs.jsonl> [--ref|--both]'); process.exit(1); }

  const dispatch = (rec, fast) => {
    const useR = !!rec.refutation, useS = !useR && !!rec.seq, useD = !useR && !useS && !!rec.dag;
    if (fast) {
      return useR ? verifyRefutationFast(rec.board, rec.attacker, rec.refutation)
        : useS ? verifySeqFast(rec.board, rec.seq)
          : useD ? verifyDagFast(rec.board, rec.attacker, rec.dag)
            : verifyFast(rec.board, rec.attacker, rec.tree);
    }
    return useR ? VS.verifyRefutation(rec.board, rec.attacker, rec.refutation)
      : useS ? VS.verifySeq(rec.board, rec.seq)
        : useD ? VS.verifyDag(rec.board, rec.attacker, rec.dag)
          : VS.verify(rec.board, rec.attacker, rec.tree);
  };

  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let ok = 0, bad = 0, mism = 0;
  for (const line of lines) {
    const rec = JSON.parse(line);
    const mv = rec.move ? ` 走(${rec.move.x},${rec.move.y})` : '';
    const tag = `${rec.game}${rec.ply == null ? '' : '@ply' + rec.ply}${mv}`;
    const rFast = dispatch(rec, true);
    const rRef = useRef ? dispatch(rec, false) : null;
    if (rRef) {
      const same = rRef.ok === rFast.ok && rRef.reason === rFast.reason
        && (rRef.path || []).join('>') === (rFast.path || []).join('>');
      if (!same) { mism++; console.log(`  ✗ ${tag}  两类核验器不一致：参考「${rRef.reason || 'ok'}」/ 快速「${rFast.reason || 'ok'}」`); }
    }
    const shown = rRef || rFast;
    if (shown.ok) {
      ok++;
      const detail = rec.refutation
        ? `P${rec.attacker} 无法在 ≤${rec.refutation.maxPlies} 半回合内强制连四`
        : `P${rec.attacker} 强制获胜`;
      const nodes = both ? `快速 ${rFast.nodes || 0} 节点 / 参考 ${rRef.nodes || 0} 节点` : `${shown.nodes || 0} 节点`;
      console.log(`  ✓ ${tag}  ${detail}  ${nodes}`);
    } else { bad++; console.log(`  ✗ ${tag}  ${shown.reason}`); }
  }
  console.log(`\n核验：通过 ${ok} / 失败 ${bad}（共 ${lines.length} 条）` +
    (both ? `；双跑比对：${mism} 处不一致` : ''));
  process.exit(bad || mism ? 1 : 0);
}
