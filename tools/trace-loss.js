'use strict';
/* ============================================================
   trace-loss —— 沿棋谱向前追溯「AI 是从哪一步开始失去抵抗」

   思路（不铺开整个开局树，只追一条真实棋谱）：
     1. 在该局里找到**最早**一个"对手能强制获胜"可被证明的局面 L（PNS 出证并核验）。
     2. 从 L 往前，逐个回看**求解器自己行棋**的局面 P_k，枚举 P_k 的**全部**合法走法：
          - 某一手后「对手无法强制获胜」(refuted) → 这是一个**候选救招**；
            再试证"求解器自己从这一手起能强制获胜" → 若成立就是确切的**漏掉胜招**。
          - 全部走法后对手都证胜 → 该局面的失败已不可避免 ⇒ 结论向前推一手。
          - 出现未知 → 只能到边界为止（不能说"有没有救"）。
     3. 输出"最早已证败节点 + 此前尚未解决的替代走法集合"。

   所有搜索共用一个 cache（含已证结果表），因此反复回溯并不昂贵。
   证明结论一律以 PNS 的 proven-win 为准，并与 rules-ref 的规则层独立核验挂钩。

   用法：
     node tools/trace-loss.js --records tools/bench-games-lean.jsonl --game "hard|P1#7" \
       --timeMs 1500 --maxNodes 20000 --back 4
   ============================================================ */
const fs = require('fs');
const { Position, pnsSearch, createCache } = require('./solver-core');

function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined ? true : v;
}

const K = (x, y) => `${x},${y}`;

/** 用规则参考实现独立核验一棵策略树 */
function verifyTree(board, attacker, tree) {
  const R2 = require('./rules-ref');
  let failure = null, nodes = 0;
  const start = R2.fromEntries(board);
  const walk = (b, node) => {
    if (failure) return;
    if (++nodes > 100000) { failure = '策略树过大'; return; }
    const side = R2.sideToMove(b);
    const w = R2.winner(b);
    if (node.terminal) {
      const t = node.terminal;
      if (t.kind === 'connect4') { if (w !== attacker) failure = 'connect4 终点不成立'; return; }
      if (t.kind === 'double-threat') {
        if (!(R2.winPoints(b, attacker).length >= 2 && R2.winPoints(b, 3 - attacker).length === 0)) failure = '双杀终点不成立';
        return;
      }
      if (t.kind === 'immediate-win') {
        const nb = R2.cloneBoard(b); nb.set(R2.K(t.at.x, t.at.y), attacker);
        if (side !== attacker || !R2.line4(nb, t.at.x, t.at.y, attacker)) failure = 'immediate-win 终点不成立';
        return;
      }
      failure = '未知终点类型'; return;
    }
    if (w) { failure = '已终局却仍展开'; return; }
    const legal = R2.legalMoves(b);
    const moves = node.moves || [];
    if (side === attacker) {
      if (moves.length !== 1) { failure = 'OR 节点必须恰好 1 步'; return; }
      const m = moves[0].move;
      if (!legal.some(q => q.x === m.x && q.y === m.y)) { failure = 'OR 步非法'; return; }
      const nb = R2.cloneBoard(b); nb.set(R2.K(m.x, m.y), side); walk(nb, moves[0].child); return;
    }
    if (moves.length !== legal.length) { failure = `AND 未覆盖全部应手（${moves.length}/${legal.length}）`; return; }
    const got = new Set(moves.map(e => R2.K(e.move.x, e.move.y)));
    for (const m of legal) if (!got.has(R2.K(m.x, m.y))) { failure = `AND 缺少应手 ${m.x},${m.y}`; return; }
    if (R2.winPoints(b, side).length) { failure = '对手本可立即连四'; return; }
    for (const e of moves) {
      const nb = R2.cloneBoard(b); nb.set(R2.K(e.move.x, e.move.y), side); walk(nb, e.child);
      if (failure) return;
    }
  };
  walk(start, tree);
  return failure ? { ok: false, reason: failure } : { ok: true, nodes };
}

(async function main() {
  const recPath = String(argOf('records', 'tools/bench-games-lean.jsonl'));
  const wantGame = typeof argOf('game', null) === 'string' ? argOf('game', null) : null;
  const timeMs = Number(argOf('timeMs', 1500));
  const maxNodes = Number(argOf('maxNodes', 20000));
  const back = Number(argOf('back', 4));
  const cache = createCache(300000);

  const games = fs.readFileSync(recPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const g = wantGame ? games.find(x => x.game === wantGame) : games[0];
  if (!g) { console.error('找不到该局：' + wantGame); process.exit(1); }
  console.log(`对局 ${g.game}（${g.plies} 手，求解器=P${g.solverColor}，结果 ${g.result}）\n`);

  // 回放：每个 ply 的局面 + 该手信息
  const pos = new Position(g.start);
  const boards = [], sides = [];
  for (const r of g.record) { boards[r.ply] = [...pos.board]; sides[r.ply] = r.side; pos.play(r.move, r.side); }

  // 1) 找最早"对手可强制获胜"的局面（只看求解器行棋的局面）
  const solverPlies = g.record.filter(r => !r.kind && r.side === g.solverColor).map(r => r.ply);
  let firstLost = null;
  for (const ply of solverPlies) {
    const attacker = 3 - g.solverColor;
    const d = pnsSearch(boards[ply], attacker, { maxNodes, timeMs, cache });
    if (d.status !== 'proven-win') continue;
    const v = verifyTree(boards[ply], attacker, d.proof.tree);
    firstLost = { ply, attacker, res: d, verify: v };
    break;
  }
  if (!firstLost) { console.log('参考预算内没有证出任何「对手强制获胜」的局面。'); return; }
  console.log(`① 最早已证败局面：ply${firstLost.ply}（求解器 P${g.solverColor} 行棋）`);
  console.log(`   证明：${firstLost.res.nodes} 节点 / ${firstLost.res.ms}ms；规则层独立核验 = ${firstLost.verify.ok ? '通过' : '失败:' + firstLost.verify.reason}\n`);

  // 2) 向前追溯：依次检查此前的每个求解器局面，枚举全部替代走法
  const attacker = firstLost.attacker, solver = g.solverColor;
  const earlier = solverPlies.filter(p => p < firstLost.ply).slice(-back);
  console.log(`② 向前追溯（最多 ${back} 个求解器局面，每个枚举全部合法走法）`);
  let boundary = firstLost.ply;
  for (const ply of earlier.slice().reverse()) {
    const board = boards[ply];
    const moves = new Position(board).moves();
    const actual = g.record[ply].move;
    const rows = [];
    let allLose = true, anyRefuted = false, anyUnknown = false;
    let rescueWin = null;
    for (const m of moves) {
      const p = new Position(board);
      p.play(m, solver);
      const child = [...p.board];
      const rA = pnsSearch(child, attacker, { maxNodes, timeMs, cache });   // 对手能强制获胜？
      let tag;
      if (rA.status === 'proven-win') tag = '对手证胜';
      else if (rA.status === 'refuted') {
        tag = '对手无法强制获胜';
        anyRefuted = true;
        const rS = pnsSearch(child, solver, { maxNodes, timeMs, cache });  // 自己反而能胜？
        if (rS.status === 'proven-win') { tag = '**自己可强制获胜**'; rescueWin = m; }
      } else { tag = '未知'; anyUnknown = true; }
      if (tag !== '对手证胜') allLose = false;
      const isActual = actual && m.x === actual.x && m.y === actual.y;
      rows.push(`     ${isActual ? '→实际' : '     '} (${m.x},${m.y})  ${tag}`);
    }
    console.log(`\n  ply${ply} 求解器行棋（${moves.length} 个合法走法）实际走 (${actual.x},${actual.y})`);
    for (const r of rows) console.log(r);
    let verdict;
    if (rescueWin) verdict = `**存在漏掉的胜招：(${rescueWin.x},${rescueWin.y})**`;
    else if (allLose) { verdict = '全部走法后对手都证胜 ⇒ 该局面的失败已不可避免'; boundary = ply; }
    else if (anyUnknown) verdict = `部分未知 ⇒ 只能说到此为止（有 ${rows.filter(r => r.includes('未知')).length} 个未解决）`;
    else verdict = '存在"对手无法强制获胜"的走法 ⇒ 至少有救的候选（未证自己胜）';
    console.log(`     ⇒ ${verdict}`);
  }
  console.log(`\n③ 结论：最早已证败节点 = ply${boundary}；此前尚未解决的替代走法见上（"未知"/"对手无法强制获胜"两类）。`);
})().catch(e => { console.error('追溯异常：', e); process.exit(1); });
