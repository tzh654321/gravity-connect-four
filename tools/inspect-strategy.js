'use strict';
/* ============================================================
   inspect-strategy —— 打印一棵策略树的形状与统计，便于人工核对证明

   用法：
     node tools/inspect-strategy.js tools/proofs-losses.jsonl   # 看文件里第一条
     node tools/inspect-strategy.js --fixture                   # 看内置夹具
   ============================================================ */
const fs = require('fs');
const { pnsSearch, verifyStrategy } = require('./solver-core');

const FIXTURE = [['0,0', 3], ['0,-1', 1], ['1,0', 2], ['1,-1', 1], ['-1,0', 2], ['2,0', 1], ['3,0', 2]];

let entries, attacker, label, tree = null;
const path = process.argv[2];
if (path && !path.startsWith('--')) {
  const rec = JSON.parse(fs.readFileSync(path, 'utf8').split('\n').filter(Boolean)[0]);
  entries = rec.board; attacker = rec.attacker; tree = rec.tree;
  label = `${rec.game}${rec.ply == null ? '' : '@ply' + rec.ply}（P${attacker} 强制获胜）`;
} else {
  entries = FIXTURE; attacker = 1;
  const d = pnsSearch(entries, attacker, { maxNodes: 20000, timeMs: 20000 });
  label = `内置夹具（P${attacker} 强制获胜） status=${d.status} PNS=${d.nodes}节点/${d.ms}ms`;
  if (d.status === 'proven-win') tree = d.proof.tree;
}
console.log(label);
if (!tree) { console.log('没有可展示的策略树'); process.exit(0); }

let ands = 0, leaves = 0, maxDepth = 0, nodes = 0, replies = 0;
const walk = (n, depth) => {
  nodes++; if (depth > maxDepth) maxDepth = depth;
  if (n.terminal) { leaves++; return; }
  if (n.moves.length >= 2) { ands++; replies += n.moves.length; }
  for (const e of n.moves) walk(e.child, depth + 1);
};
walk(tree, 0);
console.log(`节点 ${nodes}（AND ${ands} / 叶子 ${leaves}） 最大深度 ${maxDepth} 覆盖对手应手 ${replies}`);
console.log('独立核验：', JSON.stringify(verifyStrategy(entries, attacker, tree)));

const shape = (n, depth) => {
  const pad = '  '.repeat(depth);
  if (n.terminal) return pad + `└ terminal(${n.terminal.kind})\n`;
  const tag = n.moves.length >= 2 ? `AND(全 ${n.moves.length} 应手)` : 'OR(1 步)';
  return pad + `${tag}\n` + n.moves.slice(0, 8).map(e =>
    pad + `  -(${e.move.x},${e.move.y})\n${shape(e.child, depth + 2)}`).join('') +
    (n.moves.length > 8 ? pad + `  … 其余 ${n.moves.length - 8} 个应手略\n` : '');
};
console.log(shape(tree, 0).slice(0, 2000));
