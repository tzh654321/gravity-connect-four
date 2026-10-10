'use strict';
/* ============================================================
   bounded-sweep —— 对指定局面做「深度受限证明搜索」的扫深

   回答的问题（每个 N 都是**确切**结论，不是"未知"）：
     「某方能否在 ≤N 半回合内强制连四？」
       proven-win → 能，且附可独立核验的策略树；
       refuted    → 不能 —— 因为加了"剩 0 半回合 = 攻方赢不了"的伪终点，
                    整个有界博弈树是**有限**的，搜索可以穷尽它。
     只有撞到节点/时间预算时才会 unknown（此时上面两个结论都不成立）。

   为什么要它：无界的 PNS / df-pn 在"安静"局面上会发散（证明数越搜越大），
   而"能不能在 N 半回合内赢"永远可解 —— 它把一个不可解的问题换成一个可解的、且
   对实战强度判断同样有用的问题（威胁到底有多深）。

   与无界的区别必须说清：
     - 有界 `refuted` = 「N 半回合内赢不了」（定理）；
     - 无界 `refuted` = 「无法强制获胜」（可能是对手胜、也可能是无限对局）；
     - 有界的 `proven-win` 同时就是无界的 `proven-win`（强制胜不受深度上限影响）。

   用法：
     node tools/bounded-sweep.js --records tools/bench-games-lean.jsonl --game "hard|P1#7" \
       --ply 4 --moves "1,-1;0,-2" --maxPlies 4,6,8,10,12 --maxNodes 3000000 --timeMs 600000
   ============================================================ */
const fs = require('fs');
const { Position, dfpnSearch } = require('./solver-core');
const V = require('./verify-strategy');

function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined ? true : v;
}

const treeInfo = t => {
  let n = 0, leaves = 0, depth = 0;
  (function w(x, d) {
    n++; if (d > depth) depth = d;
    if (x.terminal) { leaves++; return; }
    for (const e of x.moves) w(e.child, d + 1);
  })(t, 0);
  return { nodes: n, leaves, depth };
};

(async function main() {
  const recPath = String(argOf('records', 'tools/bench-games-lean.jsonl'));
  const wantGame = typeof argOf('game', null) === 'string' ? argOf('game', null) : null;
  const ply = Number(argOf('ply', 4));
  const maxNodes = Number(argOf('maxNodes', 3000000));
  const timeMs = Number(argOf('timeMs', 600000));
  const plies = String(argOf('maxPlies', '4,6,8,10,12')).split(',').map(Number).filter(n => n > 0);
  const mode = String(argOf('attacker', 'opp'));    // opp = 走棋方的对手 | me = 走棋方本人

  const games = fs.readFileSync(recPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const g = wantGame ? games.find(x => x.game === wantGame) : games[0];
  if (!g) { console.error('找不到该局：' + wantGame); process.exit(1); }

  const pos = new Position(g.start);
  const boards = [], sides = [];
  for (const r of g.record) { boards[r.ply] = [...pos.board]; sides[r.ply] = r.side; pos.play(r.move, r.side); }
  const board = boards[ply], mover = sides[ply];
  const attacker = mode === 'me' ? mover : 3 - mover;
  const moves = new Position(board).moves();
  const spec = typeof argOf('moves', null) === 'string' ? argOf('moves', null) : null;
  const targets = spec ? spec.split(';').map(s => { const [x, y] = s.split(',').map(Number); return { x, y }; }) : moves;

  console.log(`对局 ${g.game}（求解器=P${g.solverColor}，结果 ${g.result}）`);
  console.log(`ply${ply} 轮到 P${mover}；本次扫深的目标走法 ${targets.length} 个；` +
    `待证获胜方 = P${attacker}${attacker === 3 - mover ? '（走棋方的对手）' : '（走棋方本人）'}`);
  console.log(`扫深 N ∈ {${plies.join(', ')}}  预算 = ${maxNodes} 节点 / ${timeMs}ms\n`);

  const cache = null;
  const outRecords = [];
  for (const mv of targets) {
    const p = new Position(board);
    if (!moves.some(q => q.x === mv.x && q.y === mv.y)) { console.log(`✗ (${mv.x},${mv.y}) 非法，跳过`); continue; }
    p.play(mv, mover);
    const child = [...p.board];
    console.log(`── P${mover} 走 (${mv.x},${mv.y}) → 轮到 P${3 - mover}；证 P${attacker} 能否在 N 半回合内强制连四 ──`);
    let lastRefuted = 0, bestRefut = null, minWin = null, minWinTree = null;
    for (const N of plies) {
      const t0 = Date.now();
      const r = dfpnSearch(child, attacker, { maxPlies: N, maxNodes, timeMs });
      const ms = Date.now() - t0;
      let detail = '';
      if (r.status === 'proven-win') {
        const v = V.verify(child, attacker, r.proof.tree);
        const ti = treeInfo(r.proof.tree);
        detail = `  获胜策略树核验=${v.ok ? '通过' : '失败:' + v.reason}  树 ${ti.nodes} 节点/${ti.leaves} 叶`;
        if (!v.ok) process.exitCode = 1;
        if (minWin === null) { minWin = N; minWinTree = r.proof.tree; }
      } else if (r.status === 'refuted') {
        // 反证证书必须能被**规则层独立核验器**复核 —— 这是本轮的核心产物
        const rp = r.proof;
        const v = rp ? V.verifyRefutation(child, attacker, rp) : { ok: false, reason: '未导出反证证书' };
        const ti = rp ? treeInfo(rp.tree) : null;
        detail = `  防守证书核验=${v.ok ? '通过' : '失败:' + v.reason}` +
          (ti ? `  证书 ${ti.nodes} 节点（攻击方节点 ${v.attackerNodes} / 叶 ${v.leaves}，深 ${ti.depth}）` : '');
        if (!v.ok) process.exitCode = 1;
        bestRefut = { N, proof: rp };
      }
      console.log(`  N=${String(N).padStart(2)}  ${r.status.padEnd(11)} ` +
        `pn=${r.pn} dn=${r.dn}  节点 ${r.nodes}/${maxNodes}  展开 ${r.expansions}  TT ${r.ttSize}(命中 ${r.ttHits})  ` +
        `${ms}ms${detail}`);
      if (r.status === 'refuted') {
        // 被穷尽否定 ⇒ "P{attacker} 在 ≤N 半回合内赢不了"；继续往更大的 N 走能让结论更强
        console.log(`         ⇒ 确切：P${attacker} **无法在 ≤${N} 半回合内**强制连四`);
        lastRefuted = N;
      } else if (r.status === 'proven-win') {
        console.log(`         ⇒ 确切：P${attacker} **能在 ≤${N} 半回合内**强制连四（更小的 N 已试过）`);
        break;
      }
    }
    if (lastRefuted && bestRefut && bestRefut.N === lastRefuted) {
      // 保存**最强的那个**反证证书（N 最大的），并记下确切结论
      outRecords.push({ game: g.game, ply, move: mv, mover, sideToMove: 3 - mover, attacker,
        board: child, refutation: bestRefut.proof });
      console.log(`  ⇒ 小结：P${attacker} 无法在 ≤${lastRefuted} 半回合内强制连四（已穷尽，防守证书已核验并保存）`);
    } else if (minWin !== null) {
      const ti = treeInfo(minWinTree);
      outRecords.push({ game: g.game, ply, move: mv, mover, sideToMove: 3 - mover, attacker,
        board: child, tree: minWinTree });
      console.log(`  ⇒ 小结：P${attacker} 的最小强制胜深度 = ${minWin} 半回合（获胜策略树已核验并保存，${ti.nodes} 节点）`);
    }
    console.log('');
  }

  const outPath = typeof argOf('out', null) === 'string' ? argOf('out', null) : null;
  if (outPath && outRecords.length) {
    const dir = require('path').dirname(outPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outPath, outRecords.map(o => JSON.stringify(o)).join('\n') + '\n');
    console.log(`已写入 ${outPath}（${outRecords.length} 条）——` +
      `用 node tools/verify-strategy.js ${outPath} 可在另一进程用规则层独立核验`);
  }
})().catch(e => { console.error('扫深异常：', e); process.exit(1); });
