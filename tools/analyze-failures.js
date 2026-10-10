'use strict';
/* ============================================================
   analyze-failures —— 从失败棋谱定位「AI 从哪一步失去抵抗」

   输入：solver-bench --record 产出的 JSONL（每行一局失败对局，含每手诊断）。
   做法：回放棋谱 → 对每个「求解器行棋的局面」用**更大预算**重搜 → 与棋谱里
        小预算的结论对照，产出可复现的局面与分类。

   诚实边界（重要）：
   - 只有参考搜索真的**证明**了胜/败，才断言「已证败局 / 漏胜」；
     评分转负、估值变差一律只报数据，不上升为"理论必败"。
   - 每个「已证败局」都做**独立核验**：枚举全部合法应手，检查是否每个应手
     都是「对手已证胜」。任一应手不是，即报告核验失败（属核心 bug，必须修）。
     （证明搜索内部已按同样逻辑递归，这里是端到端的第二次检查。）

   用法：
     node tools/analyze-failures.js tools/bench-games-v2.jsonl [--games 6] [--refMs 2500]
   ============================================================ */
const fs = require('fs');
const { Position, chooseMove, createCache } = require('./solver-core');

function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined ? true : v;
}

(async function main() {
  const path = process.argv[2];
  if (!path || path.startsWith('--')) {
    console.error('用法：node tools/analyze-failures.js <records.jsonl> [--games 6] [--refMs 2500]');
    process.exit(1);
  }
  const maxGames = Number(argOf('games', 6));
  const refMs = Number(argOf('refMs', 2500));
  const verifyAll = process.argv.includes('--verify-all');
  const lines = fs.readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(0, maxGames);
  const refCfg = { timeMs: refMs, maxNodes: 400000, maxDepth: 10, proofDepth: 16,
    proofFraction: 0.35, qDepth: 8, maxEntries: 120000 };
  const cache = createCache(120000);   // 全流程共享：子局面高度重叠，复用收益大

  const tally = { 已证败局: 0, 漏胜: 0, 估值层面: 0, 核验失败: 0, 局数: lines.length };
  for (const line of lines) {
    const g = JSON.parse(line);
    console.log(`\n=== ${g.game}  ${g.result === 'loss' ? '负' : g.result}  ${g.plies}手  (求解器=P${g.solverColor}) ===`);
    // 回放：record 的每一项都有 ply 与 side，从空盘逐步推演
    const pos = new Position(g.start);
    const boards = [];
    for (const r of g.record) { boards[r.ply] = [...pos.board]; pos.play(r.move, r.side); }

    let firstLost = null;
    for (const mv of g.record) {
      if (mv.kind === 'builtin') continue;          // 只看求解器行棋的局面
      const board = boards[mv.ply];
      const side = mv.side;
      const p = new Position(board);
      const ref = chooseMove(board, side, Object.assign({}, refCfg, { cache }));
      const sameMove = ref.move && mv.move && ref.move.x === mv.move.x && ref.move.y === mv.move.y;
      let label = '估值层面';
      if (ref.status === 'proven-loss' && mv.status !== 'proven-loss') label = '已证败局';
      else if (ref.status === 'proven-win' && mv.status !== 'proven-win') label = '漏胜';
      tally[label]++;
      // 参考轮里"正确走法"在根排序中的位置（判断是否排序问题）
      let refRank = '-';
      if (ref.rootCandidates) {
        const i = ref.rootCandidates.findIndex(c => c.move.x === ref.move.x && c.move.y === ref.move.y);
        if (i >= 0) refRank = i;
      }
      console.log(`  ply${mv.ply} 小预算=${mv.status}/d${mv.completedDepth} 走(${mv.move.x},${mv.move.y})` +
        `  |  参考=${ref.status}/d${ref.completedDepth} 最优=(${ref.move.x},${ref.move.y})${sameMove ? ' [同手]' : ' [不同手]'}` +
        ` 参考根排序=${refRank}  ⇒ ${label}`);

      if (label === '已证败局') {
        // 已在上方按 label 统一累加
        const isFirst = !firstLost;
        if (!firstLost) firstLost = { ply: mv.ply, side, board };
        // 独立核验很贵（枚举全部应手 × 参考预算），默认只核验每局的首个已证败局
        if (!isFirst && !verifyAll) continue;
        const moves = p.moves();
        const violations = [];
        let winForUs = 0;
        for (const m of moves) {
          const u = p.play(m, side);
          const child = chooseMove([...p.board], 3 - side, Object.assign({}, refCfg, { cache }));
          p.undo(u);
          if (child.status === 'proven-win') winForUs++; else violations.push({ m, child: child.status });
        }
        if (violations.length) {
          tally.核验失败++;
          console.log(`    ✗ 核验失败：${violations.length}/${moves.length} 个应手并非「对手证胜」，首个 = ${JSON.stringify(violations[0])}`);
        } else {
          console.log(`    ✓ 核验通过：全部 ${moves.length} 个应手均为「对手证胜」`);
        }
      }
    }
    if (firstLost) {
      console.log(`  ⇒ 本局首个「可证明已败」局面：ply${firstLost.ply}（行棋方 P${firstLost.side}）`);
      console.log(`     棋盘 = ${JSON.stringify(firstLost.board)}`);
    } else {
      console.log('  ⇒ 参考预算下未出现「可证明已败」局面（本局败因不在证明层面）');
    }
  }
  console.log('\n=== 分类汇总（仅统计有证明依据的）===');
  for (const k of Object.keys(tally)) console.log(`  ${k}: ${tally[k]}`);
  console.log('注：「估值层面」只表示参考预算也没证明出任何结论，不代表没问题 —— 需换更大规模/换口径。');
})().catch(e => { console.error('分析异常：', e); process.exit(1); });
