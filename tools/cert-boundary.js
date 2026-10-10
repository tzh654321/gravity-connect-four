'use strict';
/* 未终局边界分析与证书拼接（P5）。

   A) 分析（默认）：对给定证书里的每份**反证证书**，导出全部"未终局"边界
      （depth-limit 叶子 = 这份见证策略还没有解决的分支），按精确键与四旋转规范键去重，
      再抽样做有限预算分析：这些边界上"保证还能延伸多远"（同一攻击方继续被反证的最大 N），
      以及"防守方是否已经能反证为胜"（换攻击方搜）。
   B) 拼接（--splice）：把某个小证书的**全部**边界替换成同 attacker / addPlies 的续证书，
      合成 maxPlies+addPlies 的新证书，并用两个核验器验证。
      —— 只有"全部边界"都拿到续证时才构成统一保证；部分成功只增加分支信息。

   用法：
     node tools/cert-boundary.js
     node tools/cert-boundary.js --certs tools/fixtures/bounded-ply4-certs.jsonl --sample 12 --sweep 2,4,6
     node tools/cert-boundary.js --splice --records tools/bench-games-lean.jsonl --game "hard|P1#7" --ply 6 --attacker 2 --N 2 --add 2
*/
const fs = require('fs');
const path = require('path');
const { certBoundaryStates, dedupeBoundaries, exactStateKey, canonStateKey,
  spliceRefutation, verifyRefutation, dfpnSearch, Position } = require('./solver-core');
const ruleLayer = require('./verify-strategy');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt; };
const has = name => argv.includes('--' + name);
const ints = s => String(s).split(',').map(Number).filter(n => Number.isFinite(n) && n > 0);

function boardFromRecords(recPath, game, ply) {
  const lines = fs.readFileSync(recPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const g = game ? lines.find(x => x.game === game) : lines[0];
  if (!g) throw new Error('未找到对局：' + game);
  const pos = new Position(g.start);
  const boards = [];
  for (const r of g.record) { boards[r.ply] = [...pos.board]; pos.play(r.move, r.side); }
  return boards[ply];
}

/* 该边界上"同一攻击方继续被反证"的最大 N（升序扫，遇到非 refuted 即停）。 */
function maxRefutedAt(board, side, attacker, sweep, opts) {
  let best = 0, last = null;
  for (const N of sweep) {
    const r = dfpnSearch(board, attacker, Object.assign({ maxPlies: N }, opts));
    last = r;
    if (r.status === 'refuted' && r.proof) best = N; else break;
  }
  return { maxRefuted: best, last };
}

(function main() {
  if (has('splice')) return doSplice();
  return doAnalyze();

  // ---------------- A) 分析 ----------------
  function doAnalyze() {
    const certs = argOf('certs', 'tools/fixtures/bounded-ply4-certs.jsonl');
    const sample = Number(argOf('sample', 12));
    const sweep = ints(argOf('sweep', '2,4,6'));
    const maxNodes = Number(argOf('maxNodes', 3000000));
    const timeMs = Number(argOf('timeMs', 120000));
    const lines = fs.readFileSync(certs, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const recs = lines.filter(r => r.refutation);
    console.log(`未终局边界分析：${path.basename(certs)}，反证证书 ${recs.length} 份`);
    console.log(`  抽样 ${sample} 个边界/证书，扫深 ${sweep.join('/')}，预算 ${maxNodes} 节点 / ${timeMs}ms\n`);

    for (const rec of recs) {
      const ref = rec.refutation;
      const t0 = Date.now();
      const all = certBoundaryStates(ref, rec.board);
      const ex = dedupeBoundaries(all, false);
      const rot = dedupeBoundaries(all, true);
      // 旋转去重应当 ≤ 精确去重；相等说明"没有互为旋转的边界对"
      console.log(`P${rec.attacker} 为攻击方 · 走(${rec.move.x},${rec.move.y}) · 证书 maxPlies=${ref.maxPlies}`);
      console.log(`  未终局边界 ${all.length} 个 → 精确去重 ${ex.length}（旋转去重 ${rot.length}）  ${Date.now() - t0}ms`);

      const stride = Math.max(1, Math.floor(ex.length / sample));
      const picks = [];
      for (let i = 0; i < ex.length && picks.length < sample; i += stride) picks.push(ex[i]);

      const dist = {};
      let extSum = 0, extMax = 0, defenderWins = 0, unextendable = 0;
      for (const b of picks) {
        const r = maxRefutedAt(b.board, b.side, ref.attacker, sweep,
          { maxNodes, timeMs: Math.max(2000, Math.floor(timeMs / 2)) });
        dist[r.maxRefuted] = (dist[r.maxRefuted] || 0) + 1;
        extSum += r.maxRefuted; if (r.maxRefuted > extMax) extMax = r.maxRefuted;
        if (r.maxRefuted === 0) unextendable++;
        // 防守方（另一侧）是否能在此边界上强制获胜（有界，用最大扫深）
        const other = dfpnSearch(b.board, 3 - ref.attacker,
          { maxPlies: sweep[sweep.length - 1], maxNodes, timeMs: Math.max(2000, Math.floor(timeMs / 2)) });
        if (other.status === 'proven-win') defenderWins++;
      }
      console.log(`  抽样 ${picks.length} 个：可延伸 N 的分布 ${JSON.stringify(dist)}` +
        `  平均 ${(extSum / picks.length).toFixed(2)}  最大 ${extMax}`);
      console.log(`     其中完全延伸不了（N=0）${unextendable} 个；防守方在边界上已能强制获胜 ${defenderWins} 个\n`);
    }
    console.log('说明：以上是"固定这份见证策略"下边界分支的有限预算观察；');
    console.log('      它不是"该局面必须这么防"，也不构成任何无限延伸结论。');
  }

  // ---------------- B) 拼接 ----------------
  function doSplice() {
    const recPath = argOf('records', 'tools/bench-games-lean.jsonl');
    const game = argOf('game', 'hard|P1#7');
    const ply = Number(argOf('ply', 6));
    const attacker = Number(argOf('attacker', 2));
    const N = Number(argOf('N', 2));
    const addPlies = Number(argOf('add', 2));
    const maxNodes = Number(argOf('maxNodes', 3000000));
    const timeMs = Number(argOf('timeMs', 120000));
    const board = boardFromRecords(recPath, game, ply);

    console.log(`拼接演示：${game}@ply${ply}，证 P${attacker} 无法在 ≤${N} 内强制连四，再逐边界续 ${addPlies} 半回合`);
    const base = dfpnSearch(board, attacker, { maxPlies: N, maxNodes, timeMs });
    console.log(`  第一步：bounded(${N}) → ${base.status}  节点 ${base.nodes}`);
    if (base.status !== 'refuted' || !base.proof) {
      console.log('  该 N 下没拿到反证证书；换一个 --N（更小更容易 refuted）或换局面。');
      return;
    }
    const ref = base.proof;
    const all = certBoundaryStates(ref, board);
    const ex = dedupeBoundaries(all, false);
    console.log(`  基础证书：maxPlies=${ref.maxPlies}，未终局边界 ${all.length} 个（精确去重 ${ex.length}）`);

    const parts = new Map();
    let ok = 0, fail = 0;
    for (const b of ex) {
      const r = dfpnSearch(b.board, attacker, { maxPlies: addPlies, maxNodes, timeMs: Math.max(2000, Math.floor(timeMs / 4)) });
      if (r.status === 'refuted' && r.proof) {
        parts.set(exactStateKey(b.board, b.side), r.proof); ok++;
      } else { fail++; }
    }
    console.log(`  续证：成功 ${ok} / 失败 ${fail}`);
    if (fail) {
      console.log(`  ⇒ 未覆盖全部边界，**不构成统一保证**：只增加了这 ${ok} 条分支的已知信息。`);
      console.log('     （可把 --add 调小；addPlies 越小，边界越容易被 refuted）');
      return;
    }
    const composite = spliceRefutation(ref, parts, addPlies, board);
    if (!composite) { console.log('  ✗ 拼接失败（键不匹配或参数不符）'); process.exitCode = 1; return; }
    const v1 = verifyRefutation(board, attacker, composite);
    const v2 = ruleLayer.verifyRefutation(board, attacker, composite);
    console.log(`  合成证书：maxPlies=${composite.maxPlies}（=${N}+${addPlies}）`);
    console.log(`  库内核验 ${v1.ok ? '通过' : '失败:' + v1.reason}（节点 ${v1.nodes}）`);
    console.log(`  规则层独立核验 ${v2.ok ? '通过' : '失败:' + v2.reason}`);
    // 对照：直接跑 bounded(N+add)，看结论是否一致、代价是否更高
    const direct = dfpnSearch(board, attacker, { maxPlies: N + addPlies, maxNodes, timeMs });
    console.log(`  对照（直接 bounded(${N + addPlies})）→ ${direct.status}，节点 ${direct.nodes}；` +
      `拼接用节点 ${base.nodes}+续证节点（省去重跑大部分树）`);
    if (direct.status !== 'refuted') console.log('  ⚠ 直接搜索没能在预算内 refuted，但拼接给出了确切结论（这正是拼接的价值）');
    process.exitCode = (v1.ok && v2.ok) ? 0 : 1;
  }
})();
