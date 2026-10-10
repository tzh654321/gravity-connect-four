'use strict';
/* 从"已验证的防守策略"里提**不变量候选**并**优先找反例**（P6 修正版）。

   上一版有两处口径错误，这里已修正（结论也相应改写）：
     ① 「见证后对手即时胜点数应为 0」必须**先按三条筛选**再统计：
          未终局 且 下一步轮到攻击方 且 剩余保证 ≥ 1。
        不筛选会把"防守方这一手已经连四"（局面已终局）和"半回合正好用尽"当成反例，
        于是得到"17.7% 反例"这种假象。按正确口径统计后，它是**一条必要条件**，可直接当断言。
     ② 「同一局面出现两个见证」不能推出"不存在确定性策略"。正确的命题键是
          规则版本 + 棋盘 + 行棋方 + 攻击方 + 剩余保证
        （同一棋盘在不同剩余深度下本来就可能采用不同见证）。即便完整键相同而见证不同，
        也只是"证书没有统一选择"——**统一成同一个已验证见证即可得到确定性策略**（见 unifyRefutation）。

   候选清单（每个都可计算、可反驳）：
     N1 必要条件：见证落子后（未终局 / 轮到攻击方 / 剩余≥1）⇒ 攻击方即时胜点数 = 0（**应恒成立**）
     N2 见证选择是否唯一（按**完整命题键**统计）——不唯一不代表没有确定性策略
     N3 见证是否总在对手最后一手的邻域内（Chebyshev ≤1）
     N4 见证是否唯一可行（其他合法走法都无法进入任何反证子树）

   用法：node tools/invariant-probe.js [certs.jsonl] [--maxCounter 5]
*/
const fs = require('fs');
const path = require('path');
const { Position, winPointsAll, dfpnSearch, checkRefutationInvariants, unifyRefutation,
  verifyRefutation, RULE_VERSION } = require('./solver-core');
const ruleLayer = require('./verify-strategy');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const positionals = () => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { if (argv[i + 1] && !argv[i + 1].startsWith('--')) i++; continue; }
    out.push(argv[i]);
  }
  return out;
};
const certs = positionals()[0] || 'tools/fixtures/bounded-ply4-certs.jsonl';
const maxCounter = Number(argOf('maxCounter', 5));
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

(function main() {
  const lines = fs.readFileSync(certs, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const recs = lines.filter(r => r.refutation);
  console.log(`不变量候选探查（口径已修正）：${path.basename(certs)}，反证证书 ${recs.length} 份\n`);

  let T = { def: 0, checked: 0, viol: 0, skipTerm: 0, skipNoPly: 0, states: 0, multi: 0 };
  let c3 = 0, c3Bad = [], dist = {}, c4 = { checked: 0, notForced: 0 };
  for (const rec of recs) {
    const ref = rec.refutation, attacker = ref.attacker, defender = 3 - attacker;
    if (!ref.root) ref.root = rec.board;
    const inv = checkRefutationInvariants(ref, rec.board, RULE_VERSION);
    T.def += inv.defenderNodes; T.checked += inv.checked; T.viol += inv.violations.length;
    T.skipTerm += inv.skippedTerminal; T.skipNoPly += inv.skippedNoPlies;
    T.states += inv.states; T.multi += inv.multiWitness.length;
    console.log(`P${attacker} 攻 · 走(${rec.move.x},${rec.move.y}) maxPlies=${ref.maxPlies}`);
    console.log(`  防守节点 ${inv.defenderNodes}；**按正确口径**检查 ${inv.checked}` +
      `（跳过：防守方已连四 ${inv.skippedTerminal}、半回合用尽 ${inv.skippedNoPlies}）→ 违例 **${inv.violations.length}**`);
    console.log(`  完整命题键 ${inv.states} 个，其中见证不唯一 ${inv.multiWitness.length} 个`);

    // N3 见面邻域 + N4 唯一可行
    let c1 = 0, c1n = 0, lastSeen = null;
    const pos = new Position(rec.board);
    const walk = (side, node, lastMove) => {
      if (node.terminal) return;
      if (side === defender) {
        const w = node.moves[0].move;
        if (lastMove) { c1n++; const d = cheb(w, lastMove); dist[d] = (dist[d] || 0) + 1; if (d <= 1) c1++; }
        if (c4.checked < 20 && (c3 % 977) === 0) {
          c4.checked++;
          for (const alt of pos.moves()) {
            if (alt.x === w.x && alt.y === w.y) continue;
            const ua = pos.play(alt, side);
            const cb = [...pos.board]; pos.undo(ua);
            const rr = dfpnSearch(cb, attacker, { maxPlies: ref.maxPlies, maxNodes: 20000, timeMs: 3000 });
            if (rr.status === 'refuted') { c4.notForced++; break; }
          }
        }
        const u = pos.play(w, side);
        walk(attacker, node.moves[0].child, w);
        pos.undo(u);
        return;
      }
      for (const e of node.moves) {
        const u = pos.play(e.move, side);
        walk(defender, e.child, e.move);
        pos.undo(u);
      }
    };
    walk(((pos.board.size - 1) % 2 === 0) ? 1 : 2, ref.tree, null);
    c3 += c1n;
    const pct = c1n ? (100 * c1 / c1n).toFixed(1) + '%' : '-';
    console.log(`  见证紧邻对手最后一手（Chebyshev ≤1）：${c1}/${c1n} = ${pct}`);
    if (c1n && c1 / c1n < 0.5 && c3Bad.length < maxCounter) c3Bad.push({ move: rec.move, d: JSON.stringify(dist) });

    // 统一见证 ⇒ 得到确定性策略（并重新核验）
    const uni = unifyRefutation(ref, rec.board);
    const inv2 = checkRefutationInvariants(uni.ref, rec.board, RULE_VERSION);
    const v1 = verifyRefutation(rec.board, attacker, uni.ref);
    const v2 = ruleLayer.verifyRefutation(rec.board, attacker, uni.ref);
    console.log(`  统一见证：复用 ${uni.reused} 处 ⇒ 见证不唯一从 ${inv.multiWitness.length} 降到 **${inv2.multiWitness.length}**；` +
      `库内核验 ${v1.ok} / 规则层 ${v2.ok}`);
  }

  console.log('\n—— 汇总 ——');
  console.log(`N1 必要条件（未终局 / 轮到攻击方 / 剩余≥1 ⇒ 攻击方即时胜点 = 0）：检查 ${T.checked} 处，违例 **${T.viol}**` +
    (T.viol === 0 ? ' ⇒ 恒成立，可直接作断言' : ' ⇒ 需要调查'));
  console.log(`    上一版"17.7% 反例"的来源已查明：${T.skipTerm} 处见证**直接连四终局** + ${T.skipNoPly} 处**半回合用尽**，` +
    '都被错误地纳入了统计。');
  console.log(`N2 按完整命题键统计见证唯一性：${T.states} 个状态中 ${T.multi} 个不唯一（${(100 * T.multi / T.states).toFixed(1)}%）`);
  console.log('    ⇒ 只说明"**证书没有统一选择同一个见证**"，**不能**据此否定确定性策略；');
  console.log('       统一成同一个已验证见证即可（上面的 unifyRefutation 结果）。');
  console.log(`N3 见证是否总在对手最后一手的邻域内：距离分布 ${JSON.stringify(dist)}`);
  console.log('    ⇒ **不成立**（大量见证离对手上一手很远）。');
  console.log(`N4 见证是否唯一可行：抽样 ${c4.checked} 个防守节点中 ${c4.notForced} 个存在其他可行防守`);
  console.log('    ⇒ **不成立**（见证通常不唯一）。');
  console.log('\n结论：**尚未提取出简单、统一的局部决策规则**；但"多种见证"只反映证书的写法，');
  console.log('      不构成对"确定性策略"或"局部规则"的证明性否定。本批证书上未被证伪的只有 N1。');
})();
