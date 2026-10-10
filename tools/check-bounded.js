'use strict';
/* ============================================================
   check-bounded —— 深度受限证明搜索（bounded df-pn）的验证回归

   有界搜索的结论是**确切**的（「某方能否在 ≤N 半回合内强制连四」），所以它可以被
   **暴力枚举**完全独立地核对。本回归的做法：

     对每个夹具、每个 N（1..上限）：
       ① 用 bounded df-pn 求 status；
       ② 用 rules-ref（规则层独立，不碰核心 Position）
          写一个**没有任何快捷判定、没有置换表、没有证明数**的纯递归暴力搜索求同一命题；
       ③ 两者必须一致：
            df-pn proven-win ⟺ 暴力为真；df-pn refuted ⟺ 暴力为假。

   这比"两个搜索互相印证"强：暴力那一侧连"双杀/即时胜"这类捷径都没有，
   是直接从规则出发的穷举，因此能独立发现有界语义（rem 计数、伪终点、双杀的 rem 条件）里的错误。

   另外两条断言：
     - 自洽性：最小证胜深度 N ⟹ bounded(N-1) 必须被穷尽否定；
     - 无界模式下 rem 无意义，不得影响判定（曾经漏写 `!bounded` 把双杀必胜误判成赢不了）。

   用法：node tools/check-bounded.js
   ============================================================ */
const { Position, dfpnSearch } = require('./solver-core');
const V = require('./verify-strategy');
const R = require('./rules-ref');

const CASES = [
  {
    name: '连续强杀（7 子）',
    board: [['0,0', 3], ['0,-1', 1], ['1,0', 2], ['1,-1', 1], ['-1,0', 2], ['2,0', 1], ['3,0', 2]],
    attacker: 1, bruteMax: 7,
  },
  {
    name: '支撑激活型双威胁（11 子）',
    board: [['0,0', 3], ['0,1', 1], ['0,2', 2], ['-1,2', 1], ['-2,2', 2], ['1,0', 1], ['-3,2', 2], ['-1,0', 1], ['2,0', 2], ['0,3', 1], ['3,0', 2]],
    attacker: 1, bruteMax: 4,
  },
];

/** 纯暴力：attacker 能否在 ≤rem 半回合内强制连四。
    无任何快捷判定（不识别双杀、不识别即时胜），只做"合法落点枚举 + 连四判定"。
    规则全部来自 rules-ref，与核心 Position 无关。 */
function bruteWin(entries, attacker, rem, nodeCap = 4000000) {
  let nodes = 0, cut = false;
  const rec = (b, left) => {
    if (++nodes > nodeCap) { cut = true; return false; }
    const w = R.winner(b);
    if (w) return w === attacker;
    if (left <= 0) return false;
    const side = R.sideToMove(b);
    const legal = R.legalMoves(b);
    if (!legal.length) return false;
    if (side === attacker) {
      for (const m of legal) {
        const nb = R.cloneBoard(b); R.play(nb, m, side);
        if (rec(nb, left - 1)) return true;
        if (cut) return false;
      }
      return false;
    }
    for (const m of legal) {
      const nb = R.cloneBoard(b); R.play(nb, m, side);
      if (!rec(nb, left - 1)) return false;
      if (cut) return false;
    }
    return true;
  };
  const val = rec(R.fromEntries(entries), rem);
  return { value: val, nodes, cut };
}

let fails = 0;
const bad = m => { fails++; console.log('  ✗ ' + m); };

for (const c of CASES) {
  console.log(`· ${c.name}（P${c.attacker}，暴力上限 ${c.bruteMax} 半回合）`);
  let minN = null;
  for (let N = 1; N <= c.bruteMax; N++) {
    const r = dfpnSearch(c.board, c.attacker, { maxPlies: N, maxNodes: 400000, timeMs: 30000 });
    const bf = bruteWin(c.board, c.attacker, N);
    if (bf.cut) { console.log(`  · N=${N}：暴力枚举超上限，停止对照`); break; }
    const engWin = r.status === 'proven-win', engNo = r.status === 'refuted';
    if (r.status === 'unknown') { console.log(`  · N=${N}：引擎撞到预算（unknown），无法对照`); break; }
    const agree = (engWin && bf.value) || (engNo && !bf.value);
    const tag = `${engWin ? '证胜' : engNo ? '穷尽否定' : r.status}`;
    if (!agree) bad(`N=${N} 引擎=${tag} 与暴力=${bf.value} 不一致（暴力 ${bf.nodes} 节点）`);
    else console.log(`  ✓ N=${N}：引擎=${tag}，暴力=${bf.value ? '能胜' : '不能胜'}（暴力 ${bf.nodes} 节点）一致`);
    if (engWin) {
      const v = V.verify(c.board, c.attacker, r.proof.tree);
      if (!v.ok) bad(`N=${N} 证胜的策略树未通过规则层独立核验：${v.reason}`);
      if (minN === null) minN = N;
      break;                       // 找到最小证胜深度即可
    }
  }
  if (minN !== null && minN > 1) {
    const before = dfpnSearch(c.board, c.attacker, { maxPlies: minN - 1, maxNodes: 400000, timeMs: 30000 });
    if (before.status !== 'refuted') bad(`bounded(${minN - 1}) 应被穷尽否定，实际 ${before.status}`);
    else console.log(`  ✓ 自洽：最小证胜深度 = ${minN}，bounded(${minN - 1}) 已穷尽否定`);
  }
}

// 无界模式下 rem 无意义：不得因为 rem=0 而改变判定
{
  const c = CASES[0];
  const unb = dfpnSearch(c.board, c.attacker, { maxPlies: 0, maxNodes: 400000, timeMs: 30000 });
  const bnd = dfpnSearch(c.board, c.attacker, { maxPlies: 12, maxNodes: 400000, timeMs: 30000 });
  if (unb.status !== bnd.status) bad(`无界(${unb.status}) 与 有界12(${bnd.status}) 证胜结论不一致`);
  else console.log(`✓ 有界证胜可推出无界证胜（两者均为 ${unb.status}）`);
  // 无界证胜树里绝不允许出现"深度相关"的终点：那是 bounded 专属语义
  const kinds = new Set();
  (function walk(x) { if (x.terminal) kinds.add(x.terminal.kind); else for (const e of x.moves) walk(e.child); })(unb.proof.tree);
  if (kinds.has('depth-limit') || kinds.has('ply-shortfall')) bad(`无界证胜树里出现 bounded 专属终点：${[...kinds].join(',')}`);
  else console.log(`✓ 无界证胜树不含深度终点（终点：${[...kinds].join(',') || '无'}）`);
}

/* ---- 有界 / 无界的**严格隔离**（bounded 的结果绝不能被当成无界结论）---- */
{
  // ① 无界 refuted 只表示"无法强制获胜"（可能是无限对局）⇒ **不得**产出反证证书
  const fork = [['0,0', 3], ['1,0', 2], ['2,0', 1], ['3,0', 2], ['4,0', 2], ['1,1', 1], ['2,1', 1], ['3,1', 1]];
  const rf = dfpnSearch(fork, 2, { maxPlies: 0, maxNodes: 40000, timeMs: 20000 });
  if (rf.status !== 'refuted') bad(`fork 夹具应无界反证成立，实际 ${rf.status}`);
  else if (rf.proof !== null) bad('无界 refuted 不应产出反证证书');
  else console.log('✓ 无界 refuted 不产出反证证书（proof === null）');

  // ② "最后允许的那一步恰好连四"必须算攻击方赢，不能被当成"超时未胜"
  const win1 = [['0,0', 3], ['-1,0', 1], ['0,1', 1], ['1,0', 2], ['2,0', 2], ['3,0', 2]];
  const q = dfpnSearch(win1, 2, { maxPlies: 1, maxNodes: 20000, timeMs: 10000 });
  if (q.status !== 'proven-win') bad(`N=1 且攻击方有即时胜点时应判证胜（实际 ${q.status}）`);
  else if (!V.verify(win1, 2, q.proof.tree).ok) bad('N=1 的获胜策略树未通过核验');
  else console.log('✓ N=1 的最后一手连四被正确判为证胜（先查胜负、再查深度）');

  // ③ 有界反证**不得**被推广成无界结论
  try {
    const fx = JSON.parse(require('fs').readFileSync('tools/fixtures/bounded-ply4.json', 'utf8'));
    const mv = fx.moves.find(m => m.move.x === 1 && m.move.y === -1);
    if (mv && mv.result === 'refuted-up-to-N') {
      const rec = require('fs').readFileSync(fx.certFile, 'utf8').split('\n').filter(Boolean)
        .map(l => JSON.parse(l)).find(o => o.move.x === 1 && o.move.y === -1);
      const ru = dfpnSearch(rec.board, fx.attacker, { maxPlies: 0, maxNodes: 400000, timeMs: 60000 });
      if (ru.status === 'refuted') bad('有界反证被误推广成无界反证（应保持 unknown）');
      else console.log(`✓ 有界 ${mv.maxRefuted} 半回合的反证未被推广成无界结论（无界搜索 = ${ru.status}）`);
    } else console.log('· 夹具里没有 (1,-1) 反证记录，跳过③');
  } catch (e) { console.log('· 跳过③（夹具不可读：' + e.message + '）'); }
}

/* ---- 反证证书的负向对照：篡改必须被拒 ---- */
{
  const board = [['0,0', 3], ['-1,0', 1], ['-1,-1', 2], ['0,1', 1], ['0,-1', 2]];
  const p = new Position(board); p.play({ x: -2, y: 0 }, 1); const child = [...p.board];
  const r = dfpnSearch(child, 2, { maxPlies: 2, maxNodes: 20000, timeMs: 10000 });
  if (r.status !== 'refuted' || !r.proof) bad('负向对照的前置反证未成立');
  else {
    const clone = () => JSON.parse(JSON.stringify(r.proof));
    // a) 攻击方节点漏掉一个应手（覆盖不全）
    const t1 = clone();
    const findAttacker = x => {
      if (x.terminal) return null;
      if (x.side === 2) return x;
      for (const e of x.moves) { const f = findAttacker(e.child); if (f) return f; }
      return null;
    };
    const an = findAttacker(t1.tree);
    if (an && an.moves.length >= 2) {
      an.moves.pop();
      if (V.verifyRefutation(child, 2, t1).ok) bad('核验器接受了"攻击方应手覆盖不全"的反证证书');
      else console.log('✓ 攻击方应手覆盖不全的反证证书被拒');
    }
    // b) 把 maxPlies 改小（证书比允许深度更深）
    const t2 = clone(); t2.maxPlies = 1;
    if (V.verifyRefutation(child, 2, t2).ok) bad('核验器接受了"深度超过 maxPlies"的反证证书');
    else console.log('✓ 深度超过 maxPlies 的反证证书被拒');
    // c) 把 depth-limit 叶子伪造成 connect4
    const t3 = clone();
    const findLeaf = x => {
      if (x.terminal) return x.terminal.kind === 'depth-limit' ? x : null;
      for (const e of x.moves) { const f = findLeaf(e.child); if (f) return f; }
      return null;
    };
    const lf = findLeaf(t3.tree);
    if (lf) {
      lf.terminal = { kind: 'connect4' };
      if (V.verifyRefutation(child, 2, t3).ok) bad('核验器接受了被篡改成 connect4 的 depth-limit 叶子');
      else console.log('✓ 被篡改的 depth-limit 叶子被拒');
    }
    // d) 攻击方标错（奇偶不符）
    if (V.verifyRefutation(child, 1, clone()).ok) bad('核验器未拒绝攻击方标错的反证证书');
    else console.log('✓ 攻击方标错的反证证书被拒');
  }
}

console.log(fails ? `\n有界语义回归失败 ${fails} 项` : '\n有界语义回归全部通过（与纯暴力枚举逐深度一致 + 隔离/负向对照）');
process.exit(fails ? 1 : 0);
