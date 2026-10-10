'use strict';
/* ============================================================
   check-dfpn-thresholds —— **只审算法、不调性能**的 df-pn 阈值专项检查

   为什么单独做：阈值推导错了，搜索**照样可能给出正确证书**（正确性由独立核验器兜底），
   但预算分配机制已经偏离预期。所以不能拿"终于跑动了、结果和几个夹具一致"当阈值正确的证据。
   本文件在**不碰棋盘**的层面检查四件事：

     ① 阈值公式单测：OR 用**次小 pn**、AND 用**次小 dn**，另一侧按"其余子节点贡献"扣减；
        饱和（求和被截断）时不扣减；阈值下限为 1。
     ② 进展不变量：每次下潜，选中子节点的两个阈值**至少一个严格大于**它当前值。
        （这正是早期版本 `min(thpn, pn - pn_e + 1)` 会破坏的性质 —— 它在 pn=pn_e=1 时给出 1，
         而展开后 pn = 子节点数 ≥ 2 的 AND 子节点立刻满足 `pn >= thpn`，一步也搜不动。）
     ③ 入口/返回条件：未展开节点**先展开再返回**（占位值 (1,1) 不能用阈值拦）。
     ④ 手工 AND/OR 图上的最小 df-pn：结果与人工推算一致、每次调用都有进展、且在预算内终止。

   注：这里的最小 df-pn 是**算法层的独立实现**（只复用核心导出的阈值纯函数），
   用来审查"阈值机制"本身；棋盘搜索仍由 tools/check-dfpn.js 与 PNS 对照。

   用法：node tools/check-dfpn-thresholds.js
   ============================================================ */
const { dfpnChildThresholds } = require('./solver-core');

const INF = 1e9;
const ATTACKER = 1;          // OR 侧（存在性）
const DEFENDER = 2;          // AND 侧（全称）

let fails = 0;
const fail = m => { fails++; console.log('  ✗ ' + m); };
const ok = m => console.log('  ✓ ' + m);
const eq = (a, b, m) => { if (a !== b) fail(`${m}（期望 ${b}，实得 ${a}）`); return a === b; };

/* ---------- ① 阈值公式单测 ---------- */
console.log('· ① 阈值公式');
{
  // OR 父、全部子 pn=1（次小 pn 也是 1）⇒ cpn = min(thpn, 2)。旧公式会给 1（=死锁）
  const t1 = dfpnChildThresholds(ATTACKER, ATTACKER, 100, 100, 1, 9, 1, 1, 1, 1, false, false);
  eq(t1.cpn, 2, 'OR 父：次小 pn=1 时 cpn 应为 2（不是 1）');
  if (t1.cpn === 1) fail('出现了早期版本的死锁阈值');
  // OR 父只有 1 个子（次小 = Infinity）⇒ cpn = thpn
  eq(dfpnChildThresholds(ATTACKER, ATTACKER, 100, 100, 3, 9, 3, 1, Infinity, 1, false, false).cpn, 100,
    'OR 父单子：次小为 Infinity 时 cpn 应等于 thpn');
  // OR 父的 dn 侧：按"其余子节点贡献"扣减
  eq(dfpnChildThresholds(ATTACKER, ATTACKER, 100, 50, 3, 9, 3, 2, 4, 4, false, false).cdn, 43,
    'OR 父：cdn = thdn - (dn - dn_e)');
  // AND 父、全部子 dn=1 ⇒ cdn = min(thdn, 2)
  eq(dfpnChildThresholds(DEFENDER, ATTACKER, 100, 100, 9, 1, 1, 1, 1, 1, false, false).cdn, 2,
    'AND 父：次小 dn=1 时 cdn 应为 2');
  // AND 父的 pn 侧：cpn = thpn - (pn - pn_e) = 50 - (9 - 3) = 44
  eq(dfpnChildThresholds(DEFENDER, ATTACKER, 50, 100, 9, 3, 3, 3, 1, 9, false, false).cpn, 44,
    'AND 父：cpn = thpn - (pn - pn_e)');
  // 饱和：求和被截断时不扣减
  eq(dfpnChildThresholds(ATTACKER, ATTACKER, 100, 50, 3, INF, 3, 2, 4, 4, false, true).cdn, 50,
    'OR 父：dn 求和饱和时不扣减（直接给 thdn）');
  eq(dfpnChildThresholds(DEFENDER, ATTACKER, 50, 100, INF, 3, INF, 3, 9, 1, true, false).cpn, 50,
    'AND 父：pn 求和饱和时不扣减');
  // 下限为 1
  const t2 = dfpnChildThresholds(ATTACKER, ATTACKER, 100, 3, 1, 5, 1, 5, 1, 9, false, false);
  if (t2.cdn < 1) fail('cdn 应为 ≥1');
  ok('公式单测通过（次小值 / 单子 / 扣减 / 饱和 / 下限）');
}

/* ---------- ②③ 进展不变量与返回条件（在手工图上验证） ---------- */
console.log('· ②③ 进展不变量与入口条件');
{
  // 穷举一批合法规格的输入，断言"至少一侧严格大于子节点当前值"
  let bad = 0, checked = 0;
  for (const thpn of [2, 5, 20]) {
    for (const thdn of [2, 5, 20]) {
      for (const nPn of [1, 2, 7]) for (const nDn of [1, 2, 7]) {
        for (const ePn of [1, 2]) for (const eDn of [1, 2]) {
          for (const side of [ATTACKER, DEFENDER]) {
            // 只测"合规格"：thpn > nPn 且 thdn > nDn（这是入口不变量保证的）
            if (!(thpn > nPn && thdn > nDn)) continue;
            if (side === ATTACKER ? !(nPn === ePn) : !(nDn === eDn)) continue;   // 选中子取到最小值
            const t = dfpnChildThresholds(side, ATTACKER, thpn, thdn, nPn, nDn, ePn, eDn, ePn, eDn, false, false);
            checked++;
            if (!t.progress) bad++;
          }
        }
      }
    }
  }
  if (bad) fail(`进展不变量在 ${bad}/${checked} 组输入上不成立`);
  else ok(`进展不变量在全部 ${checked} 组合法输入上成立（每次下潜必有进展）`);
}

/* ---------- ④ 手工 AND/OR 图上的最小 df-pn ---------- */
console.log('· ④ 手工 AND/OR 图');
{
  /** 图：id → { side: OR|AND, kids: [id], value: true|false|undefined } */
  const run = (G, rootId, maxNodes = 200000) => {
    const tt = new Map();
    const st = { expansions: 0, descents: 0, progressFails: 0 };
    let ttHits = 0;
    const nodeAt = id => {
      let n = tt.get(id);
      if (n) { ttHits++; return n; }
      const g = G[id];
      if (g.value === true) n = { id, side: g.side, pn: 0, dn: INF, term: true, kids: null, pnSat: false, dnSat: false };
      else if (g.value === false) n = { id, side: g.side, pn: INF, dn: 0, term: true, kids: null, pnSat: false, dnSat: false };
      else n = { id, side: g.side, pn: 1, dn: 1, term: false, kids: null, pnSat: false, dnSat: false };
      tt.set(id, n);
      return n;
    };
    const update = n => {
      if (n.term || !n.kids) return;
      const k = n.kids;
      let pn, dn;
      if (n.side === ATTACKER) { pn = INF; dn = 0; for (const c of k) { if (c.pn < pn) pn = c.pn; dn += c.dn; } }
      else { pn = 0; dn = INF; for (const c of k) { pn += c.pn; if (c.dn < dn) dn = c.dn; } }
      n.pnSat = pn > INF; n.dnSat = dn > INF;
      n.pn = pn > INF ? INF : pn;
      n.dn = dn > INF ? INF : dn;
    };
    const step = (n, thpn, thdn) => {
      if (n.term) return;
      if (!n.kids) {                                  // ③ 未展开：先展开再返回
        if (++st.expansions > maxNodes) throw new Error('节点预算耗尽');
        n.kids = G[n.id].kids.map(id => { const c = nodeAt(id); return { id, pn: c.pn, dn: c.dn, node: c }; });
        update(n);
        return;
      }
      st.descents++;
      while (n.pn > 0 && n.dn > 0 && n.pn < thpn && n.dn < thdn) {
        const k = n.kids;
        let bi = 0, pn1 = Infinity, pn2 = Infinity, dn1 = Infinity, dn2 = Infinity;
        for (let i = 0; i < k.length; i++) {
          const p0 = k[i].pn, d0 = k[i].dn;
          if (p0 < pn1) { pn2 = pn1; pn1 = p0; } else if (p0 < pn2) pn2 = p0;
          if (d0 < dn1) { dn2 = dn1; dn1 = d0; } else if (d0 < dn2) dn2 = d0;
          if (i > 0) {
            if (n.side === ATTACKER) { if (k[i].pn < k[bi].pn || (k[i].pn === k[bi].pn && k[i].dn < k[bi].dn)) bi = i; }
            else { if (k[i].dn < k[bi].dn || (k[i].dn === k[bi].dn && k[i].pn < k[bi].pn)) bi = i; }
          }
        }
        const e = k[bi];
        const th = dfpnChildThresholds(n.side, ATTACKER, thpn, thdn, n.pn, n.dn, e.pn, e.dn,
          pn2, dn2, n.pnSat, n.dnSat);
        if (!th.progress) st.progressFails++;         // ② 记录，不抛（抛出会掩盖统计）
        step(e.node, th.cpn, th.cdn);
        e.pn = e.node.pn; e.dn = e.node.dn;
        update(n);
      }
    };
    const root = nodeAt(rootId);
    try {
      while (!root.term && root.pn !== 0 && root.dn !== 0) step(root, root.pn + 1, root.dn + 1);
    } catch (e) { return { status: 'unknown', ...st, ttHits, reason: e.message }; }
    return { status: root.pn === 0 ? 'proven-win' : root.dn === 0 ? 'refuted' : 'unknown', ...st, ttHits };
  };

  const cases = [
    { name: 'OR→(胜, 负)：存在一个胜分支', g: {
        'r': { side: ATTACKER, kids: ['a', 'b'] },
        'a': { side: DEFENDER, kids: [], value: true }, 'b': { side: DEFENDER, kids: [], value: false } }, expect: 'proven-win' },
    { name: 'OR→(负, 负)：没有胜分支', g: {
        'r': { side: ATTACKER, kids: ['a', 'b'] },
        'a': { side: DEFENDER, kids: [], value: false }, 'b': { side: DEFENDER, kids: [], value: false } }, expect: 'refuted' },
    { name: 'AND→(胜, 胜)：全称成立', g: {
        'r': { side: DEFENDER, kids: ['a', 'b'] },
        'a': { side: ATTACKER, kids: [], value: true }, 'b': { side: ATTACKER, kids: [], value: true } }, expect: 'proven-win' },
    { name: 'AND→(胜, 负)：一个反例即否定', g: {
        'r': { side: DEFENDER, kids: ['a', 'b'] },
        'a': { side: ATTACKER, kids: [], value: true }, 'b': { side: ATTACKER, kids: [], value: false } }, expect: 'refuted' },
    { name: '深度 5 的 AND/OR 链（必胜）', root: 'n0', g: (() => {
        const G = {};
        for (let d = 0; d < 5; d++) {
          G['n' + d] = { side: d % 2 === 0 ? ATTACKER : DEFENDER, kids: ['n' + (d + 1)] };
        }
        G['n5'] = { side: ATTACKER, kids: [], value: true };
        return G; })(), expect: 'proven-win' },
    { name: '含转置的菱形图（被否证，且必须命中置换表）', g: {
        'r': { side: ATTACKER, kids: ['x', 'y'] },
        'x': { side: DEFENDER, kids: ['z'] }, 'y': { side: DEFENDER, kids: ['z'] },
        'z': { side: ATTACKER, kids: ['a', 'b'] },
        'a': { side: DEFENDER, kids: [], value: false }, 'b': { side: DEFENDER, kids: [], value: false } },
      expect: 'refuted', needTtHit: true },
  ];

  for (const c of cases) {
    const r = run(c.g, c.root || 'r');
    const good = r.status === c.expect && r.progressFails === 0 && (!c.needTtHit || r.ttHits > 0);
    console.log(`  ${good ? '✓' : '✗'} ${c.name}：${r.status}（期望 ${c.expect}）` +
      `  展开 ${r.expansions} 下降 ${r.descents} TT 命中 ${r.ttHits} 无进展 ${r.progressFails}` +
      (r.reason ? `  ${r.reason}` : ''));
    if (!good) fails++;
  }
}

console.log(fails ? `\ndf-pn 阈值专项检查失败 ${fails} 项` : '\ndf-pn 阈值专项检查通过（公式 / 进展不变量 / 入口条件 / 手工图）');
process.exit(fails ? 1 : 0);
