'use strict';
/* ============================================================
   analyze-defence —— 从**已核验的**反证（防守）证书里提取结构特征

   ⚠ 定位必须说清：本脚本只做**观察**，产出的是"候选规律"，**不是**不变量证明。
     有限深度的证书里看到重复结构，**不能**推出"防守方可以永远这样防" ——
     那需要证明三件事：初始局面满足 I；对手任意合法落子后防守方都有合法应手恢复 I；
     满足 I 时对手不能连四，且对**任意后续规模**闭合。本脚本一件都不做。

   ⚠ 且这里统计的是**搜索产出的那一个**见证策略，不是"所有防守策略"；
     防守方在证书里只保留了 1 个应手，所以"用到的格子很少"不能直接读成"必须这么防"。

   用法：node tools/analyze-defence.js [certs.jsonl]
   ============================================================ */
const fs = require('fs');
const path = process.argv[2] || 'tools/fixtures/bounded-ply4-certs.jsonl';
const lines = fs.readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

const dist = (x, y) => Math.max(Math.abs(x), Math.abs(y));

for (const rec of lines) {
  if (!rec.refutation) continue;
  const mv = rec.move;
  const defender = 3 - rec.attacker;
  const leafKinds = new Map();
  const defCells = new Map();          // 防守方选择的格子 → 次数
  const attCells = new Map();          // 攻击方走法 → 次数（覆盖面）
  let defNodes = 0, attNodes = 0, depthMax = 0, nodes = 0;
  let defMaxDist = 0, attMaxDist = 0;

  (function walk(node, depth) {
    nodes++;
    if (depth > depthMax) depthMax = depth;
    if (node.terminal) {
      leafKinds.set(node.terminal.kind, (leafKinds.get(node.terminal.kind) || 0) + 1);
      return;
    }
    const isAtt = node.side === rec.attacker;
    for (const e of node.moves) {
      const k = `${e.move.x},${e.move.y}`;
      const m = isAtt ? attCells : defCells;
      m.set(k, (m.get(k) || 0) + 1);
      const d = dist(e.move.x, e.move.y);
      if (isAtt) { if (d > attMaxDist) attMaxDist = d; } else { if (d > defMaxDist) defMaxDist = d; }
      walk(e.child, depth + 1);
    }
    if (isAtt) attNodes++; else defNodes++;
  })(rec.refutation.tree, 0);

  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  console.log(`\n=== 走 (${mv.x},${mv.y})：P${rec.attacker} 无法在 ≤${rec.refutation.maxPlies} 半回合内强制连四 ===`);
  console.log(`证书 ${nodes} 节点 / 最大深度 ${depthMax}；攻击方节点 ${attNodes}、防守方节点 ${defNodes}；` +
    `叶 ${[...leafKinds.values()].reduce((a, b) => a + b, 0)}`);
  console.log(`叶类型：${[...leafKinds.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`防守方选择：**不同的格子 ${defCells.size} 个**（共 ${defNodes} 次选择；` +
    `最远 |x|或|y| = ${defMaxDist}）`);
  console.log(`  最常见的防守格：` + top(defCells, 8).map(([k, v]) => `${k}×${v}`).join('  '));
  console.log(`攻击方走法：**不同的格子 ${attCells.size} 个**（共 ${attNodes} 个节点、` +
    `${[...attCells.values()].reduce((a, b) => a + b, 0)} 条边；最远 ${attMaxDist}）`);
  console.log(`  最常见的攻击格：` + top(attCells, 8).map(([k, v]) => `${k}×${v}`).join('  '));
}

console.log('\n注：以上只是“搜索产出的那个见证策略”的统计。它**不构成**不变量证明，' +
  '也不排除防守方另有更简单的策略。要把它变成\"能一直防\"，必须显式证明对任意合法攻击与任意后续规模闭合。');
