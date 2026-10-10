'use strict';
/* ============================================================
   verify-strategy —— 策略树核验器（**规则层也独立**）

   独立性分两层，本项目两层都做了：

     第一层（搜索独立）：不排序、不用置换表、不用局部战术快捷逻辑、完整检查 AND 应手覆盖。
        —— 由 solver-core 的 verifyStrategy 与本题均满足。

     第二层（规则独立）：连"合法走法生成 / 连四判定 / 重力方向"都另写一份，
        不调用核心的 Position。
        —— 由 tools/rules-ref.js 提供（窗口扫描判连四、从棋子四邻重建落点）。

   为什么需要第二层：只有第一层时，两个验证器仍然共享核心的规则实现，
   规则本身若错，两边会一起通过。

   用法：
     node tools/verify-strategy.js tools/proofs.jsonl
   ============================================================ */
const fs = require('fs');
const R = require('./rules-ref');

function verify(entries, attacker, tree) {
  if (!tree) return { ok: false, reason: '缺少策略树' };
  if (attacker !== 1 && attacker !== 2) return { ok: false, reason: '攻击方非法' };
  let nodes = 0, andNodes = 0, failure = null;
  const start = R.fromEntries(entries);
  if (R.winner(start)) return { ok: false, reason: '起始局面已终局' };

  const walk = (b, node) => {
    if (failure) return;
    if (++nodes > 500000) { failure = { ok: false, reason: '策略树过大（>50 万节点）' }; return; }
    const side = R.sideToMove(b);
    const w = R.winner(b);
    if (node.terminal) {
      const t = node.terminal;
      if (t.kind === 'connect4') {
        if (w !== attacker) failure = { ok: false, reason: 'connect4 终点不成立' };
        return;
      }
      if (t.kind === 'double-threat') {
        const a = R.winPoints(b, attacker).length, d = R.winPoints(b, 3 - attacker).length;
        if (!(a >= 2 && d === 0)) failure = { ok: false, reason: `double-threat 终点不成立（胜点 ${a}/${d}）` };
        return;
      }
      if (t.kind === 'immediate-win') {
        if (side !== attacker) { failure = { ok: false, reason: 'immediate-win 终点出现在对手回合' }; return; }
        const ok = R.legalMoves(b).some(m => m.x === t.at.x && m.y === t.at.y) &&
          (() => { const nb = R.cloneBoard(b); nb.set(R.K(t.at.x, t.at.y), attacker); return R.line4(nb, t.at.x, t.at.y, attacker); })();
        if (!ok) failure = { ok: false, reason: 'immediate-win 指向的不是即时胜点' };
        return;
      }
      failure = { ok: false, reason: '未知终点类型：' + t.kind };
      return;
    }
    if (w) { failure = { ok: false, reason: w === attacker ? '已连四却仍在展开' : '该子树里防守方已连四' }; return; }
    const legal = R.legalMoves(b);
    const moves = node.moves || [];
    if (side === attacker) {
      if (moves.length !== 1) { failure = { ok: false, reason: 'OR 节点必须恰好 1 步' }; return; }
      const m = moves[0].move;
      if (!legal.some(q => q.x === m.x && q.y === m.y)) { failure = { ok: false, reason: 'OR 步非法' }; return; }
      const nb = R.cloneBoard(b); nb.set(R.K(m.x, m.y), side);
      walk(nb, moves[0].child);
      return;
    }
    andNodes++;
    if (moves.length !== legal.length) {
      failure = { ok: false, reason: `AND 节点未覆盖全部应手（记录 ${moves.length} / 合法 ${legal.length}）` };
      return;
    }
    const got = new Set(moves.map(e => R.K(e.move.x, e.move.y)));
    for (const m of legal) if (!got.has(R.K(m.x, m.y))) { failure = { ok: false, reason: `AND 节点缺少应手 ${m.x},${m.y}` }; return; }
    if (R.winPoints(b, side).length) { failure = { ok: false, reason: '对手本可立即连四（攻击给了对手先赢）' }; return; }
    for (const e of moves) {
      if (failure) return;
      if (!legal.some(q => q.x === e.move.x && q.y === e.move.y)) { failure = { ok: false, reason: 'AND 步非法' }; return; }
      const nb = R.cloneBoard(b); nb.set(R.K(e.move.x, e.move.y), side);
      walk(nb, e.child);
    }
  };

  walk(start, tree);
  return failure || { ok: true, nodes, andNodes };
}

/** DAG 版（压缩后）：按节点 id 记忆化。
    安全性依据：DAG 节点对应唯一局面，局面决定行棋方；先断言"节点记录的行棋方 === 局面推出的行棋方"，
    再记忆化，因此共享子树只核验一次不会漏检。 */
function verifyDag(entries, attacker, dag) {
  if (!dag || !Array.isArray(dag.nodes) || !dag.nodes.length) return { ok: false, reason: '缺少 DAG' };
  if (attacker !== 1 && attacker !== 2) return { ok: false, reason: '攻击方非法' };
  const b0 = R.fromEntries(entries);
  if (R.winner(b0)) return { ok: false, reason: '起始局面已终局' };
  const memo = new Map();
  let visited = 0, memoHits = 0, failure = null;

  const walk = (b, id) => {
    if (failure) return;
    if (memo.has(id)) { memoHits++; return; }
    if (++visited > 500000) { failure = { ok: false, reason: 'DAG 过大' }; return; }
    const node = dag.nodes[id];
    if (!node) { failure = { ok: false, reason: `DAG 节点 ${id} 不存在` }; return; }
    const side = R.sideToMove(b);
    if (node.side !== side) { failure = { ok: false, reason: `DAG 节点 ${id} 的行棋方与局面不符（应 P${side}，记 P${node.side}）` }; return; }
    const w = R.winner(b);
    if (node.terminal) {
      const t = node.terminal;
      if (t.kind === 'connect4') { if (w !== attacker) failure = { ok: false, reason: `节点 ${id} connect4 终点不成立` }; }
      else if (t.kind === 'double-threat') {
        if (!(R.winPoints(b, attacker).length >= 2 && R.winPoints(b, 3 - attacker).length === 0)) failure = { ok: false, reason: `节点 ${id} 双杀终点不成立` };
      } else if (t.kind === 'immediate-win') {
        const nb = R.cloneBoard(b); nb.set(R.K(t.at.x, t.at.y), attacker);
        if (side !== attacker || !R.line4(nb, t.at.x, t.at.y, attacker)) failure = { ok: false, reason: `节点 ${id} immediate-win 终点不成立` };
      } else failure = { ok: false, reason: `节点 ${id} 未知终点类型` };
      if (!failure) memo.set(id, true);
      return;
    }
    if (w) { failure = { ok: false, reason: `节点 ${id}：已终局却仍展开` }; return; }
    const legal = R.legalMoves(b);
    const moves = node.moves || [];
    if (node.side === attacker) {
      if (moves.length !== 1) { failure = { ok: false, reason: `节点 ${id}（OR）必须恰好 1 步` }; return; }
      const m = moves[0].move;
      if (!legal.some(q => q.x === m.x && q.y === m.y)) { failure = { ok: false, reason: `节点 ${id} OR 步非法` }; return; }
      const nb = R.cloneBoard(b); nb.set(R.K(m.x, m.y), side);
      walk(nb, moves[0].child);
    } else {
      if (moves.length !== legal.length) { failure = { ok: false, reason: `节点 ${id}（AND）未覆盖全部应手（${moves.length}/${legal.length}）` }; return; }
      const got = new Set(moves.map(e => R.K(e.move.x, e.move.y)));
      for (const m of legal) if (!got.has(R.K(m.x, m.y))) { failure = { ok: false, reason: `节点 ${id} 缺少应手 ${m.x},${m.y}` }; return; }
      if (R.winPoints(b, side).length) { failure = { ok: false, reason: `节点 ${id}：对手本可立即连四` }; return; }
      for (const e of moves) {
        if (failure) return;
        if (!legal.some(q => q.x === e.move.x && q.y === e.move.y)) { failure = { ok: false, reason: `节点 ${id} AND 步非法` }; return; }
        const nb = R.cloneBoard(b); nb.set(R.K(e.move.x, e.move.y), side);
        walk(nb, e.child);
      }
    }
    if (!failure) memo.set(id, true);
  };

  walk(b0, dag.root);
  return failure || { ok: true, nodes: visited, memoHits, dagNodes: dag.nodes.length };
}

/* 作为模块被引用时导出核验函数（solve-target 等工具复用同一份规则层实现）；作为 CLI 时逐条核验。 */
module.exports = { verify, verifyDag, verifySeq, verifyRefutation };

if (require.main !== module) return;

/** 连续威胁证明（P3 的 `{attacker, steps}` 格式）的**规则层独立**核验。
    语义与核心 verifyProof 逐条对齐，但全部用 rules-ref 重算，不看核心任何代码：
      - 行棋方必须与落子数奇偶一致；
      - 攻击步：落点合法；落子后**不能给对手**留下即时胜点；该步必须制造 ≥1 个即时胜点
        （末步允许以 ≥2 个即时胜点＝双杀收尾）；若落子即连四则必须恰好是最后一步；
      - 防守步：防守方自己不能有即时胜点（否则是攻击给了对手先赢）；
        攻击方此时必须**恰好 1 个**即时胜点，且防守必须落在那唯一杀点上（被迫）；
      - 终止：末步后攻击方连四，或末步为攻击步并留下 ≥2 个即时胜点。 */
function verifySeq(entries, seq) {
  if (!seq || !Array.isArray(seq.steps) || !seq.steps.length) return { ok: false, reason: '缺少证明步骤' };
  const attacker = seq.attacker;
  if (attacker !== 1 && attacker !== 2) return { ok: false, reason: '攻击方非法' };
  const b = R.fromEntries(entries);
  if (R.winner(b)) return { ok: false, reason: '起始局面已终局' };
  const steps = seq.steps;

  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    const n = i + 1;
    const side = R.sideToMove(b);
    if (st.side !== side) return { ok: false, reason: `第${n}步行棋方不符（应 P${side}，记 P${st.side}）` };
    const isAttack = st.side === attacker, last = i === steps.length - 1;

    // —— 落子**前**的被迫性检查（只对防守步；镜像核心 verifyProof）——
    if (!isAttack) {
      if (R.winPoints(b, st.side).length) return { ok: false, reason: `第${n}步防守方本可立即连四（攻击给了对手先赢）` };
      const aw = R.winPoints(b, attacker);
      if (aw.length !== 1) return { ok: false, reason: `第${n}步防守并非被迫（当时攻击方胜点数 ${aw.length}）` };
      if (aw[0].x !== st.move.x || aw[0].y !== st.move.y) return { ok: false, reason: `第${n}步未占唯一杀点` };
    }
    if (!R.play(b, st.move, st.side)) return { ok: false, reason: `第${n}步落点非法` };

    const w = R.winner(b);
    if (w) {
      if (w !== attacker) return { ok: false, reason: `第${n}步后获胜方不是攻击方` };
      if (!last) return { ok: false, reason: `第${n}步已连四但记录未终止` };
      return { ok: true, plies: steps.length, terminal: 'connect4' };
    }
    if (isAttack) {
      if (R.winPoints(b, 3 - attacker).length) return { ok: false, reason: `第${n}步后防守方有即时胜点（攻击未防住对手）` };
      const aw = R.winPoints(b, attacker);
      if (last) {
        return aw.length >= 2 ? { ok: true, plies: steps.length, terminal: 'double-threat' }
          : { ok: false, reason: `末步既非连四也非双杀（攻击方胜点数 ${aw.length}）` };
      }
      if (aw.length < 1) return { ok: false, reason: `第${n}步没有制造任何即时威胁` };
    }
  }
  return { ok: false, reason: '记录未给出终止结论' };
}

/* 反证证书（防守策略）的**规则层独立**核验：命题是「attacker 无法在 ≤maxPlies 半回合内强制连四」。
   与获胜策略树**对偶**：攻击方回合必须覆盖全部走法，防守方回合只需 1 个见证走法；
   终点只允许 defender 已连四 / 防守方即时胜点 / 防守方双杀 / 半回合用尽且未分胜负。
   **先查胜负再查深度**：否则"最后允许的那一步恰好连四"会被误判成"超时未胜"。 */
function verifyRefutation(entries, attacker, ref) {
  if (!ref || !ref.tree) return { ok: false, reason: '缺少反证证书' };
  if (ref.kind !== 'refutation') return { ok: false, reason: '证书类型不是 refutation' };
  if (!Number.isInteger(ref.maxPlies) || ref.maxPlies <= 0) return { ok: false, reason: '必须带正整数半回合上限' };
  if (attacker !== 1 && attacker !== 2) return { ok: false, reason: '攻击方非法' };
  const defender = 3 - attacker;
  const b0 = R.fromEntries(entries);
  if (R.winner(b0)) return { ok: false, reason: '起始局面已终局' };
  let nodes = 0, attackerNodes = 0, leaves = 0, failure = null;

  const walk = (b, side, rem, node) => {
    if (failure) return;
    if (++nodes > 500000) { failure = { ok: false, reason: '反证证书过大（>50 万节点）' }; return; }
    const expect = R.sideToMove(b);
    if (side !== expect) { failure = { ok: false, reason: `行棋方不符（应 P${expect}，记 P${side}）` }; return; }
    const w = R.winner(b);
    if (w === attacker) { failure = { ok: false, reason: '证书里出现攻击方已连四（反证不成立）' }; return; }
    if (node.terminal) {
      leaves++;
      const t = node.terminal;
      if (t.kind === 'depth-limit') {
        if (w) failure = { ok: false, reason: 'depth-limit 终点却已终局' };
        else if (rem !== 0) failure = { ok: false, reason: `depth-limit 终点出现在还有 ${rem} 半回合时` };
        return;
      }
      if (t.kind === 'connect4' || t.kind === 'defender-win') {
        if (w !== defender) failure = { ok: false, reason: 'defender 连四终点不成立' };
        return;
      }
      if (t.kind === 'defender-immediate-win') {
        if (side !== defender || R.winPoints(b, defender).length < 1) failure = { ok: false, reason: 'defender-immediate-win 不成立' };
        return;
      }
      if (t.kind === 'defender-double-threat') {
        if (side !== attacker || R.winPoints(b, attacker).length !== 0 || R.winPoints(b, defender).length < 2) {
          failure = { ok: false, reason: 'defender-double-threat 不成立' };
        }
        return;
      }
      failure = { ok: false, reason: '反证证书里出现非法终点：' + t.kind };
      return;
    }
    if (w) { failure = { ok: false, reason: '已终局却仍在展开' }; return; }
    if (rem <= 0) { failure = { ok: false, reason: '半回合已用尽却不是 depth-limit 终点' }; return; }
    const legal = R.legalMoves(b);
    const moves = node.moves || [];
    if (side === attacker) {
      attackerNodes++;
      if (moves.length !== legal.length) {
        failure = { ok: false, reason: `攻击方节点未覆盖全部走法（记录 ${moves.length} / 合法 ${legal.length}）` }; return;
      }
      const got = new Set(moves.map(e => R.K(e.move.x, e.move.y)));
      for (const m of legal) if (!got.has(R.K(m.x, m.y))) { failure = { ok: false, reason: `攻击方节点缺少走法 ${m.x},${m.y}` }; return; }
      for (const e of moves) {
        if (failure) return;
        const nb = R.cloneBoard(b);
        if (!R.play(nb, e.move, side)) { failure = { ok: false, reason: '攻击方走法非法' }; return; }
        walk(nb, defender, rem - 1, e.child);
      }
      return;
    }
    if (moves.length !== 1) { failure = { ok: false, reason: '防守方节点必须恰好 1 步（见证）' }; return; }
    const nb = R.cloneBoard(b);
    if (!R.play(nb, moves[0].move, side)) { failure = { ok: false, reason: '防守方走法非法' }; return; }
    walk(nb, attacker, rem - 1, moves[0].child);
  };

  walk(b0, R.sideToMove(b0), ref.maxPlies, ref.tree);
  return failure || { ok: true, nodes, attackerNodes, leaves };
}

const path = process.argv[2];
if (!path) { console.error('用法：node tools/verify-strategy.js <proofs.jsonl>'); process.exit(1); }
const lines = fs.readFileSync(path, 'utf8').split('\n').filter(Boolean);
let ok = 0, bad = 0;
for (const line of lines) {
  const rec = JSON.parse(line);
  const useRef = !!rec.refutation;
  const useSeq = !useRef && !!rec.seq;
  const useDag = !useRef && !useSeq && !!rec.dag;
  const r = useRef ? verifyRefutation(rec.board, rec.attacker, rec.refutation)
    : useSeq ? verifySeq(rec.board, rec.seq)
      : useDag ? verifyDag(rec.board, rec.attacker, rec.dag)
        : verify(rec.board, rec.attacker, rec.tree);
  const mv = rec.move ? ` 走(${rec.move.x},${rec.move.y})` : '';
  const tag = `${rec.game}${rec.ply == null ? '' : '@ply' + rec.ply}${mv}`;
  if (r.ok) {
    ok++;
    console.log(`  ✓ ${tag}  ${useRef
      ? `P${rec.attacker} 无法在 ≤${rec.refutation.maxPlies} 半回合内强制连四  防守证书 ${r.nodes} 节点（攻击方节点 ${r.attackerNodes} / 叶 ${r.leaves}）`
      : `P${rec.attacker} 强制获胜  ` + (useSeq ? `连续威胁序列 ${r.plies} 步（终点 ${r.terminal}）`
        : useDag ? `DAG ${r.dagNodes} 节点（核验访问 ${r.nodes}，记忆命中 ${r.memoHits}）`
          : `树 ${r.nodes} 节点 / AND ${r.andNodes}`)}`);
  } else { bad++; console.log(`  ✗ ${tag}  ${r.reason}`); }
}
console.log(`\n规则层独立核验：通过 ${ok} / 失败 ${bad}（共 ${lines.length} 条）`);
process.exit(bad ? 1 : 0);
