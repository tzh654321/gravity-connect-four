'use strict';
/* ============================================================
   prove-positions —— 对关键局面产出「完整策略树」证明，核验后持久化

   输入：`solver-bench --record` 的失败棋谱（不给则用内置夹具）。
   做法：回放每局；对每个"求解器行棋的局面"，用 PNS 试证**对手**能强制获胜
        （attacker = 对手）。第一个被证出的局面即「可证明已败」的起点。
   PNS 在这里比 analyze-failures 的"2 倍预算对照"更强：它给出的是
        **对每个我方应手都有回应的完整策略树**，而不是一次搜索结果。

   输出：JSONL，每行 { game, ply, attacker, board, tree }，
        可直接交给 `verify-strategy.js` 在**另一个进程**里独立核验。

   用法：
     node tools/prove-positions.js --records tools/bench-games-lean.jsonl --max 6 --timeMs 3000 --out tools/proofs.jsonl
     node tools/prove-positions.js --out tools/proofs-fixtures.jsonl
   ============================================================ */
const fs = require('fs');
const { Position, pnsSearch, verifyStrategy, verifyStrategyDag, compressStrategy, createCache } = require('./solver-core');

function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined ? true : v;
}

const FIXTURES = [
  { game: 'fixture:支撑激活双威胁', board: [['0,0', 3], ['0,1', 1], ['0,2', 2], ['-1,2', 1], ['-2,2', 2],
    ['1,0', 1], ['-3,2', 2], ['-1,0', 1], ['2,0', 2], ['0,3', 1], ['3,0', 2]], side: 1 },
  { game: 'fixture:需强制挡招', board: [['0,0', 3], ['0,-1', 1], ['1,0', 2], ['0,-2', 1], ['0,-3', 2],
    ['1,-2', 1], ['2,0', 2]], side: 1 },
];

function treeStats(tree) {
  let nodes = 0, andNodes = 0, orNodes = 0, leaves = 0, maxDepth = 0, replies = 0;
  const walk = (n, d) => {
    nodes++; if (d > maxDepth) maxDepth = d;
    if (n.terminal) { leaves++; return; }
    if (n.moves.length >= 2) { andNodes++; replies += n.moves.length; } else orNodes++;
    for (const e of n.moves) walk(e.child, d + 1);
  };
  walk(tree, 0);
  return { nodes, andNodes, orNodes, leaves, maxDepth, replies };
}

(async function main() {
  const recPath = typeof argOf('records', null) === 'string' ? argOf('records', null) : null;
  const outPath = String(argOf('out', 'tools/proofs.jsonl'));
  const maxGames = Number(argOf('max', 6));
  const maxNodes = Number(argOf('maxNodes', 20000));
  const timeMs = Number(argOf('timeMs', 3000));
  const cache = createCache(200000);
  const atkMode = String(argOf('attacker', recPath ? 'opponent' : 'side'));

  // 组装待证位置列表：每个"求解器行棋的局面"
  const targets = [];
  if (recPath) {
    const lines = fs.readFileSync(recPath, 'utf8').split('\n').filter(Boolean).slice(0, maxGames);
    for (const line of lines) {
      const g = JSON.parse(line);
      const pos = new Position(g.start);
      const boards = [];
      for (const r of g.record) { boards[r.ply] = [...pos.board]; pos.play(r.move, r.side); }
      for (const r of g.record) {
        if (r.kind === 'builtin') continue;
        targets.push({ game: g.game, ply: r.ply, board: boards[r.ply], side: r.side });
      }
    }
  } else {
    for (const f of FIXTURES) targets.push({ game: f.game, board: f.board, side: f.side });
  }

  const out = [];
  let proven = 0, verifiedOk = 0, dagOk = 0, ms = 0, nodes = 0;
  for (const t of targets) {
    const attacker = atkMode === 'side' ? t.side : 3 - t.side;
    const d = pnsSearch(t.board, attacker, { maxNodes, timeMs, cache, maxEntries: 200000 });
    ms += d.ms; nodes += d.nodes;
    if (d.status !== 'proven-win') continue;
    proven++;
    const v = verifyStrategy(t.board, attacker, d.proof.tree);
    if (v.ok) verifiedOk++;
    const s = treeStats(d.proof.tree);
    // 压缩成 DAG（按"局面+行棋方"四旋转规范去重）并核验压缩结果
    const dag = compressStrategy(t.board, d.proof.tree);
    const vd = dag ? verifyStrategyDag(t.board, attacker, dag) : { ok: false, reason: '压缩失败' };
    if (vd.ok) dagOk++;
    const dupRate = d.allNodes ? (1 - d.uniqueRot / d.allNodes) : 0;
    out.push({ game: t.game, ply: t.ply === undefined ? null : t.ply, sideToMove: t.side,
      attacker, board: t.board, tree: d.proof.tree, dag });
    console.log(`  ✓ ${t.game}${t.ply === undefined ? "" : "@ply" + t.ply}: 证出「P${attacker} 强制获胜」  ` +
      `树=${s.nodes}节点(OR ${s.orNodes}/AND ${s.andNodes}/叶子 ${s.leaves}) 深 ${s.maxDepth} ` +
      `覆盖对手应手 ${s.replies} PNS=${d.nodes}/${d.ms}ms`);
    console.log(`     核验=${v.ok ? '通过' : '失败:' + v.reason}；` +
      `DAG 压缩 ${s.nodes}→${dag ? dag.nodes.length : '-'} 节点，DAG 核验=${vd.ok ? '通过' : '失败:' + vd.reason}；` +
      `搜索转置：生成 ${d.allNodes} 局面，旋转去重后唯一 ${d.uniqueRot}（含旋转折叠 ${d.uniqueNoRot}→${d.uniqueRot}），重复率 ${(dupRate * 100).toFixed(1)}%`);
    if (proven >= maxGames) break;
  }

  fs.writeFileSync(outPath, out.map(o => JSON.stringify(o)).join('\n') + (out.length ? '\n' : ''));
  console.log('\n=== 汇总 ===');
  console.log(`  试证位置 ${targets.length} 个，证出 ${proven} 个；策略树核验通过 ${verifiedOk}/${proven}，DAG 核验通过 ${dagOk}/${proven}`);
  console.log(`  PNS 合计 ${nodes} 节点 / ${ms}ms`);
  console.log(`  已写入 ${outPath}（${out.length} 条）——用 node tools/verify-strategy.js ${outPath} 可在另一进程（规则层独立）核验`);
})().catch(e => { console.error('异常：', e); process.exit(1); });
