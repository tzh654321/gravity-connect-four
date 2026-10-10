'use strict';
/* 证书跟随机制的**离线核验**（P5）。
   不只看一条主线，而是遍历整棵反证证书：
     1) 结构/记账：行棋方奇偶、攻击方节点覆盖全部合法走法、防守方节点恰 1 步、走法合法、
        深度 ≤ maxPlies、depth-limit 叶子**恰好**落在 maxPlies、终点种类只允许白名单
        （`ply-shortfall` 等搜索内部标记出现在对外证书里一律判失败）。
     2) 黑盒跟随：对每个节点用 `followRefutation(ref, 当前局面)` 问"我该走哪一步"，
        断言返回的 status/witness/replies 与证书结构一致（不直接读 tree 结构）。
     3) 只用跟随器**重建**一份证书（分支用规则生成，不走法用跟随器给的见证），
        再交给**两个**核验器（库内 + 规则层独立）验证。
     4) 四旋转变体：把根局面与整棵树一起旋转，重复 (1)(3)，检查坐标映射与核验都成立。

   用法：
     node tools/cert-follow.js [certs.jsonl] [--sample N] [--rot 1|0] [--only <move x,y>]
*/
const fs = require('fs');
const { followRefutation, verifyRefutation, refutationLeafKinds, CERT_LEAF_KINDS,
  rotateRefutation, Position } = require('./solver-core');
const ruleLayer = require('./verify-strategy');   // 规则层独立核验器（不调用核心 Position 判连四）

const argv = process.argv.slice(2);
const argOf = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt; };
// 位置参数：既不是 `--flag`，也不是紧跟在带值 flag 后面的那个值
const positionals = () => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { if (argv[i + 1] && !argv[i + 1].startsWith('--')) i++; continue; }
    out.push(argv[i]);
  }
  return out;
};
const path = positionals()[0] || 'tools/fixtures/bounded-ply4-certs.jsonl';
const doRot = argOf('rot', '1') !== '0';

let fails = 0;
const bad = msg => { fails++; console.log('  ✗ ' + msg); };

/* (1) 遍历 + 记账 */
function checkTraversal(entries, ref, label) {
  const pos = new Position(entries);
  let nodes = 0, attackerNodes = 0, leaves = 0;
  const walk = (side, rem, depth, node) => {
    nodes++;
    const expect = ((pos.board.size - 1) % 2 === 0) ? 1 : 2;
    if (side !== expect) throw new Error(`行棋方不符（应 P${expect}，记 P${side}）`);
    if (node.terminal) {
      leaves++;
      const k = node.terminal.kind;
      if (!CERT_LEAF_KINDS.includes(k)) throw new Error(`叶子终点不在白名单：${k}`);
      if (k === 'depth-limit' && depth !== ref.maxPlies) throw new Error(`depth-limit 出现在深度 ${depth}（应 ${ref.maxPlies}）`);
      return;
    }
    if (depth >= ref.maxPlies) throw new Error(`非终点节点深度 ${depth} 已达上限 ${ref.maxPlies}`);
    const legal = pos.moves();
    if (side === ref.attacker) {
      attackerNodes++;
      if (node.moves.length !== legal.length) throw new Error(`攻击方节点覆盖不全（${node.moves.length}/${legal.length}）`);
      const got = new Set(node.moves.map(e => `${e.move.x},${e.move.y}`));
      for (const m of legal) if (!got.has(`${m.x},${m.y}`)) throw new Error(`攻击方节点缺走法 ${m.x},${m.y}`);
    } else if (node.moves.length !== 1) {
      throw new Error(`防守方节点必须恰好 1 步（实际 ${node.moves.length}）`);
    }
    for (const e of node.moves) {
      if (!pos.frontier.has(`${e.move.x},${e.move.y}`)) throw new Error('走法非法（不在稳定落点集）');
      const u = pos.play(e.move, side);
      walk(3 - side, rem - 1, depth + 1, e.child);
      pos.undo(u);
    }
  };
  walk(((pos.board.size - 1) % 2 === 0) ? 1 : 2, ref.maxPlies, 0, ref.tree);
  return { nodes, attackerNodes, leaves };
}

/* (2)+(3) 只用跟随器重建证书 */
function rebuildByFollower(entries, ref, label) {
  const pos = new Position(entries);
  let mismatched = 0, nodes = 0;
  const walk = () => {
    nodes++;
    const f = followRefutation(ref, [...pos.board], entries);
    if (f.status === 'off-certificate') throw new Error('跟随器判定偏离证书：' + f.reason);
    if (f.status === 'terminal') return { side: f.side, terminal: f.terminal, moves: [] };
    const side = f.side;
    if (side === ref.attacker) {
      const legal = pos.moves();
      const rep = new Set((f.replies || []).map(m => `${m.x},${m.y}`));
      if (rep.size !== legal.length || legal.some(m => !rep.has(`${m.x},${m.y}`))) mismatched++;
      const out = [];
      for (const m of legal) {                       // 分支一律用**规则**生成，不用证书结构
        const u = pos.play(m, side);
        const c = walk();
        pos.undo(u);
        out.push({ move: m, child: c });
      }
      return { side, terminal: null, moves: out };
    }
    const w = f.witness;
    if (!pos.frontier.has(`${w.x},${w.y}`)) throw new Error('跟随器给出的见证走法非法');
    const u = pos.play(w, side);
    const c = walk();
    pos.undo(u);
    return { side, terminal: null, moves: [{ move: w, child: c }] };
  };
  const tree = walk();
  return { tree, nodes, mismatched };
}

(function main() {
  const lines = fs.readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const only = argOf('only', null);
  const atkFilter = argOf('attacker', null);
  const recs = lines.filter(r => r.refutation)
    .filter(r => !only || `${r.move.x},${r.move.y}` === only)
    .filter(r => !atkFilter || String(r.attacker) === String(atkFilter));
  // 旧证书可能没有自带 `root`（新版本 dfpnSearch 会写进去）：这里按记录补齐，
  // 使证书自包含（跟随器/旋转都依赖它）。
  for (const r of recs) if (!r.refutation.root) r.refutation.root = r.board;
  console.log(`跟随机制离线核验：${path}`);
  console.log(`  反证证书 ${recs.length} 份${doRot ? '（另做四旋转变体）' : ''}\n`);

  for (const rec of recs) {
    const tag = `${rec.game}@ply${rec.ply} 走(${rec.move.x},${rec.move.y})  P${rec.attacker} 为攻击方`;
    const ref = rec.refutation;
    const before = fails;
    try {
      // 终点纯度
      const kinds = refutationLeafKinds(ref);
      const badKinds = Object.keys(kinds).filter(k => !CERT_LEAF_KINDS.includes(k));
      if (badKinds.length) bad(`${tag}：证书里出现非白名单终点 ${badKinds.join(',')}`);

      // 两个核验器
      const v1 = verifyRefutation(rec.board, rec.attacker, ref);
      if (!v1.ok) bad(`${tag}：库内核验失败 ${v1.reason}`);
      const v2 = ruleLayer.verifyRefutation(rec.board, rec.attacker, ref);
      if (!v2.ok) bad(`${tag}：规则层独立核验失败 ${v2.reason}`);

      // (1) 遍历记账
      const tr = checkTraversal(rec.board, ref, tag);

      // (2)(3) 跟随器重建 + 双核验
      const rb = rebuildByFollower(rec.board, ref, tag);
      if (rb.mismatched) bad(`${tag}：跟随器给出的应手集与合法走法不一致（${rb.mismatched} 处）`);
      const rv1 = verifyRefutation(rec.board, rec.attacker, { kind: 'refutation', attacker: rec.attacker, maxPlies: ref.maxPlies, root: rec.board, tree: rb.tree });
      if (!rv1.ok) bad(`${tag}：跟随器重建的证书库内核验失败 ${rv1.reason}`);
      const rv2 = ruleLayer.verifyRefutation(rec.board, rec.attacker, { kind: 'refutation', attacker: rec.attacker, maxPlies: ref.maxPlies, root: rec.board, tree: rb.tree });
      if (!rv2.ok) bad(`${tag}：跟随器重建的证书规则层核验失败 ${rv2.reason}`);

      let rotInfo = '';
      if (doRot) {
        for (let r = 1; r <= 3; r++) {
          // 把**根局面与整棵树一起**旋转；核验与跟随都必须用旋转后的根局面
          const rr = rotateRefutation(ref, r);
          const rvA = verifyRefutation(rr.root, rec.attacker, rr);
          if (!rvA.ok) bad(`${tag}：旋转 ${r}×90° 后库内核验失败 ${rvA.reason}`);
          const rrb = rebuildByFollower(rr.root, rr, tag);
          const rvB = ruleLayer.verifyRefutation(rr.root, rec.attacker,
            { kind: 'refutation', attacker: rec.attacker, maxPlies: ref.maxPlies, root: rr.root, tree: rrb.tree });
          if (!rvB.ok) bad(`${tag}：旋转 ${r}×90° 后跟随器重建核验失败 ${rvB.reason}`);
        }
        rotInfo = '  旋转 3 变体通过';
      }
      if (fails === before) {
        console.log(`  ✓ ${tag}`);
        console.log(`      叶子种类 ${JSON.stringify(kinds)}  遍历 ${tr.nodes} 节点（攻击方 ${tr.attackerNodes}/叶子 ${tr.leaves}）`);
        console.log(`      跟随器重建 ${rb.nodes} 节点；库内+规则层双核验通过${rotInfo}`);
      }
    } catch (e) {
      bad(`${tag}：${e.message}`);
    }
  }
  console.log('');
  console.log(fails ? `跟随机制离线核验：失败 ${fails} 项` : '跟随机制离线核验：全部通过（遍历记账 + 黑盒跟随 + 跟随器重建双核验 + 四旋转）');
  process.exit(fails ? 1 : 0);
})();
