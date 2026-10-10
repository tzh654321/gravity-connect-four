'use strict';
/* ============================================================
   solve-target —— 对**指定的具体局面/具体走法**投大预算做证明

   与 trace-loss 的区别：trace-loss 是"沿一条棋谱自动往前追溯"，
   本工具是"我知道要解哪两手，给我把它们解到底"。

   对每个目标（= 把某手走法落在某局面的结果局面）：
     1. 先试证「对手能强制获胜」(attacker = 对手)；
     2. 若被 refuted（对手无法强制获胜）→ 再试证「自己反而能强制获胜」(attacker = 自己)；
     3. 任何一种 proven-win 都用 **规则层独立核验器** 复核，通过才写入 --out。

   语义边界（与核心一致，报告里必须保留）：
     - proven-win  = 在该规则下有强制获胜策略，可导出策略树并独立核验；
     - refuted     = 「attacker 无法强制获胜」≠ 对手必胜（无限棋盘可能有无限对局）；
     - unknown     = 预算内没结论；同时打印 pn/dn 轨迹，说明"还差多远"。

   用法：
     node tools/solve-target.js --records tools/bench-games-lean.jsonl --game "hard|P1#7" \
       --ply 4 --moves "1,-1;0,-2" --maxNodes 1000000 --timeMs 300000 --out tools/proofs-ply4.jsonl
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { Position, pnsSearch, dfpnSearch, createCache, compressStrategy, threatSearch, verifyProof } = require('./solver-core');
const V = require('./verify-strategy');

function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined ? true : v;
}

function loadGame(recPath, wantGame) {
  const games = fs.readFileSync(recPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  return wantGame ? games.find(x => x.game === wantGame) : games[0];
}

/** 回放：boards[ply] = 第 ply 手**落子前**的局面 */
function replay(g) {
  const pos = new Position(g.start);
  const boards = [], sides = [];
  for (const r of g.record) { boards[r.ply] = [...pos.board]; sides[r.ply] = r.side; pos.play(r.move, r.side); }
  return { boards, sides };
}

const fmt = n => n === undefined || n === null ? '-' : String(n);

/** 进度回调：每 10s 打一行 pn/dn/节点，用来判断"是否在收敛"而不是盲烧预算 */
function mkTick(t0) {
  let last = Date.now();
  return (st, root) => {
    const now = Date.now();
    if (now - last < 10000) return;
    last = now;
    const secs = (now - t0) / 1000;
    console.log(`   … ${secs.toFixed(0)}s  节点 ${st.nodes}  iters ${st.iters}  ` +
      `pn=${root.pn} dn=${root.dn}  ${(st.nodes / secs).toFixed(0)} 节点/s`);
  };
}

(async function main() {
  const recPath = String(argOf('records', 'tools/bench-games-lean.jsonl'));
  const wantGame = typeof argOf('game', null) === 'string' ? argOf('game', null) : null;
  const ply = Number(argOf('ply', 4));
  const maxNodes = Number(argOf('maxNodes', 200000));
  const timeMs = Number(argOf('timeMs', 60000));
  const wantStats = !!argOf('stats', false);
  const outPath = typeof argOf('out', null) === 'string' ? argOf('out', null) : null;
  const threatPlies = Number(argOf('threatPlies', 0));      // >0 时先跑 P3 连续威胁搜索
  const threatScan = Number(argOf('threatScan', 30));
  const threatMs = Number(argOf('threatMs', 60000));
  const algo = String(argOf('algo', 'pns'));                 // pns | dfpn
  const maxPlies = Number(argOf('maxPlies', 0));             // >0：df-pn 进入"深度受限"模式（结论确切）
  const attackerMode = String(argOf('attacker', 'opp'));     // opp | me | both

  const g = loadGame(recPath, wantGame);
  if (!g) { console.error('找不到该局：' + wantGame); process.exit(1); }
  const { boards, sides } = replay(g);
  if (!boards[ply]) { console.error(`该局没有 ply${ply}（共 ${g.plies} 手）`); process.exit(1); }
  const board = boards[ply], mover = sides[ply], opp = 3 - mover;

  console.log(`对局 ${g.game}（求解器=P${g.solverColor}，结果 ${g.result}）`);
  console.log(`目标局面：ply${ply}（轮到 P${mover}），棋子 ${board.length - 1} 个 + 固定块`);
  console.log(`  棋盘 ${JSON.stringify(board)}`);

  const allMoves = new Position(board).moves();
  const spec = typeof argOf('moves', null) === 'string' ? argOf('moves', null) : null;
  const targets = spec
    ? spec.split(';').map(s => { const [x, y] = s.split(',').map(Number); return { x, y }; })
    : allMoves;
  console.log(`  P${mover} 的合法走法共 ${allMoves.length} 个；本次目标 ${targets.length} 个：` +
    targets.map(m => `(${m.x},${m.y})`).join(' ') + '\n');

  const cache = createCache(400000);
  const out = [];
  const record = (childBoard, attacker, payload) => {
    out.push(Object.assign({ game: g.game, ply, mover, sideToMove: opp, attacker,
      board: childBoard }, payload));
    return out[out.length - 1];
  };

  for (const mv of targets) {
    const legal = allMoves.some(q => q.x === mv.x && q.y === mv.y);
    if (!legal) { console.log(`✗ (${mv.x},${mv.y}) 不是合法落点，跳过`); continue; }
    const p = new Position(board);
    p.play(mv, mover);
    const child = [...p.board];

    console.log(`── 走 (${mv.x},${mv.y}) → 轮到 P${opp} ──`);

    // ① 先走便宜的 P3 连续强制威胁搜索：攻击方只走"制造即时威胁"的招，分支小、能看很深。
    //    找不到只代表"没有连续强杀"，**不代表没赢**（必胜也可能要先下安静布局手）。
    if (threatPlies > 0) {
      const tT = Date.now();
      const tr = threatSearch(child, opp, { plies: threatPlies, attackScan: threatScan, timeMs: threatMs });
      if (tr.status === 'proven-win') {
        const v = verifyProof(child, tr.proof);
        console.log(`  P3 连续威胁搜索：proven-win  matePlies=${tr.matePlies}  节点 ${tr.nodes}  ` +
          `${Date.now() - tT}ms  核验 ${v.ok ? '通过' : '失败：' + v.reason}`);
        if (v.ok) { record(child, opp, { kind: 'threat', move: mv, seq: tr.proof, matePlies: tr.matePlies }); console.log(''); continue; }
      } else {
        console.log(`  P3 连续威胁搜索：unknown（无连续强杀；**不等于没赢**）  节点 ${tr.nodes}  ${Date.now() - tT}ms`);
      }
    }

    const who = attackerMode === 'me' ? [mover] : attackerMode === 'both' ? [opp, mover] : [opp];
    let proof = null, proofWho = null;
    for (const atk of who) {
      const t = Date.now();
      const r = search(child, atk, mkTick(t));
      report(`试证「P${atk} 能强制获胜」`, r, t);
      if (r.note) console.log(`     · ${r.note}`);
      if (r.status === 'proven-win') { proof = { attacker: atk, res: r }; proofWho = atk === opp ? 'opp' : 'me'; break; }
      if (r.status === 'refuted') {
        console.log(`   ↳ refuted：P${atk} 无法强制获胜 —— **不等于对手必胜**（无限棋盘可能有无限对局）`);
      }
    }

    if (proof) {
      const { attacker, res } = proof;
      const v = V.verify(child, attacker, res.proof.tree);
      console.log(`   ⇒ 结论：P${attacker} 可强制获胜；规则层独立核验 = ${v.ok ? '通过' : '失败：' + v.reason}` +
        (v.ok ? `（树 ${v.nodes} 节点 / AND ${v.andNodes}）` : ''));
      const dag = compressStrategy(child, res.proof.tree);
      const vd = dag ? V.verifyDag(child, attacker, dag) : null;
      console.log(`   ⇒ DAG 压缩：${dag ? dag.nodes.length + ' 节点' : '-'}；DAG 核验 = ` +
        (vd ? (vd.ok ? `通过（访问 ${vd.nodes}，记忆命中 ${vd.memoHits}）` : '失败：' + vd.reason) : '-'));
      if (v.ok) { record(child, attacker, { kind: 'tree', move: mv, tree: res.proof.tree, dag }); console.log(`   ✓ 已记录到 ${outPath}`); }
    } else {
      console.log(`   ⇒ 结论：**未知**（预算内未证出；见上面 pn/dn，不能当必败/必胜）`);
    }
    console.log('');
  }

  if (outPath && out.length) {
    const dir = path.dirname(outPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outPath, out.map(o => JSON.stringify(o)).join('\n') + '\n');
    console.log(`已写入 ${outPath}（${out.length} 条）——用 node tools/verify-strategy.js ${outPath} 可另进程独立核验`);
  }

  function search(childBoard, atk, tick) {
    const opts = { maxNodes, timeMs, cache, stats: wantStats, onTick: tick };
    return algo === 'dfpn'
      ? dfpnSearch(childBoard, atk, { maxNodes, timeMs, maxPlies, onTick: (r, s) => tick(s, r) })
      : pnsSearch(childBoard, atk, opts);
  }

  function report(title, r, t0) {
    const ms = Date.now() - t0;
    const rate = ms > 0 ? Math.round(r.nodes / (ms / 1000)) : 0;
    const dup = wantStats && r.allNodes ? ((1 - r.uniqueRot / r.allNodes) * 100).toFixed(1) + '%' : '-';
    const extra = algo === 'dfpn'
      ? `展开 ${r.expansions}  下降 ${r.descents}  TT ${r.ttSize}(命中 ${r.ttHits})  最大深度 ${r.maxDepth}` +
        (r.maxPlies ? `  半回合上限 ${r.maxPlies}` : '')
      : `iters ${r.iters}  重复率 ${dup}`;
    console.log(`  ${title}：status=${r.status}  pn=${fmt(r.pn)} dn=${fmt(r.dn)}  ` +
      `节点 ${r.nodes}/${maxNodes}  ${extra}  ${ms}ms  ${rate} 节点/s`);
  }
})().catch(e => { console.error('求解异常：', e); process.exit(1); });
