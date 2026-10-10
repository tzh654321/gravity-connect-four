'use strict';
/* ============================================================
   threat-report —— 证明通道（P3 连续威胁 / P4 PNS）的覆盖度与开销报告

   四臂对照，回答"同样预算下多证出了什么、代价是什么"，而不是看胜率：
     A 基线   ：threatPlies=0, pnsNodes=0     （只用 ID 证明 + alpha-beta）
     B 仅 P3  ：threatPlies=12
     C 仅 P4  ：pnsNodes=2500
     D P3+P4  ：两者都开

   每臂记录：证胜数、相对 A 的新增证出、平均单步耗时、平均完成深度（只在与 A 都进入
   alpha-beta 的同一批局面上比较，避免分母不一致）、以及各通道自身耗时/节点。
   新增证出的证明会用 verifyProof / verifyStrategy 独立核验。

   用法：
     node tools/threat-report.js --random 60 --timeMs 200
     node tools/threat-report.js tools/bench-games-lean.jsonl --max 40 --timeMs 600
   ============================================================ */
const fs = require('fs');
const { Position, chooseMove, threatSearch, verifyProof, verifyStrategy } = require('./solver-core');

function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined ? true : v;
}

const timeMs = Number(argOf('timeMs', 600));
const maxPos = Number(argOf('max', 40));
const base = { timeMs, maxDepth: 8, proofDepth: 8, qDepth: 6, maxNodes: 200000, forkScan: 16 };
const ARMS = {
  A: { threatPlies: 0, pnsNodes: 0 },
  B: { threatPlies: 12, pnsNodes: 0 },
  C: { threatPlies: 0, pnsNodes: 2500 },
  D: { threatPlies: 12, pnsNodes: 2500 },
};

function sampleFromRecords(path, cap) {
  const lines = fs.readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    const g = JSON.parse(line);
    const pos = new Position(g.start);
    const boards = [];
    for (const r of g.record) { boards[r.ply] = [...pos.board]; pos.play(r.move, r.side); }
    for (let i = 2; i < g.record.length - 1; i += 4) {
      if (out.length >= cap) return out;
      out.push({ board: boards[i], side: g.record[i].side, tag: `${g.game}@ply${i}` });
    }
  }
  return out;
}

function randomSamples(count, minPieces) {
  let seed = 424242;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const out = [];
  while (out.length < count) {
    const pos = new Position();
    const plies = 6 + Math.floor(rnd() * 14);
    for (let i = 0; i < plies; i++) {
      if (pos.winner()) break;
      const ms = pos.moves();
      if (!ms.length) break;
      pos.play(ms[Math.floor(rnd() * ms.length)], (pos.board.size - 1) % 2 === 0 ? 1 : 2);
    }
    if (pos.winner() || pos.board.size - 1 < minPieces) continue;
    out.push({ board: [...pos.board], side: (pos.board.size - 1) % 2 === 0 ? 1 : 2, tag: `rand#${out.length}` });
  }
  return out;
}

const FIXTURES = [
  { board: [['0,0', 3], ['0,1', 1], ['0,2', 2], ['-1,2', 1], ['-2,2', 2], ['1,0', 1], ['-3,2', 2],
    ['-1,0', 1], ['2,0', 2], ['0,3', 1], ['3,0', 2]], side: 1, tag: '支撑激活双威胁' },
  { board: [['0,0', 3], ['0,-1', 1], ['1,0', 2], ['1,-1', 1], ['-1,0', 2], ['2,0', 1], ['3,0', 2]],
    side: 1, tag: '连续强杀(短)' },
  { board: [['0,0', 3], ['0,-1', 1], ['1,0', 2], ['0,-2', 1], ['0,-3', 2], ['1,-2', 1], ['2,0', 2]],
    side: 1, tag: '需强制挡招' },
];

(async function main() {
  const path = process.argv[2];
  const samples = [];
  const randCount = Number(argOf('random', 0));
  if (randCount > 0) samples.push(...randomSamples(randCount, Number(argOf('minPieces', 8))));
  if (path && !path.startsWith('--')) samples.push(...sampleFromRecords(path, maxPos));
  if (!randCount && !(path && !path.startsWith('--'))) samples.push(...FIXTURES);

  const names = Object.keys(ARMS);
  const agg = {};
  for (const n of names) agg[n] = { proofs: 0, ms: 0, depth: 0, depthN: 0, p3ms: 0, p3nodes: 0, p4ms: 0, p4nodes: 0, calls: 0 };
  const perPos = [];
  let extra = 0, verified = 0, badProof = 0;
  const reasons = [], matePlies = [];

  for (const s of samples) {
    const res = {};
    for (const n of names) {
      const r = chooseMove(s.board, s.side, Object.assign({}, base, ARMS[n]));
      res[n] = r;
      agg[n].proofs += r.status === 'proven-win' ? 1 : 0;
      agg[n].ms += r.ms.total;
      if (r.threat) { agg[n].p3ms += r.threat.ms; agg[n].p3nodes += r.threat.nodes; agg[n].calls += r.threat.calls; }
      if (r.pns) { agg[n].p4ms += r.pns.ms; agg[n].p4nodes += r.pns.nodes; }
    }
    for (const n of names) {
      if (res.A.completedDepth && res[n].completedDepth) { agg[n].depth += res[n].completedDepth; agg[n].depthN++; }
    }
    for (const n of names) {
      if (n === 'A') continue;
      if (res[n].status === 'proven-win' && res.A.status !== 'proven-win') {
        extra++;
        matePlies.push(res[n].matePlies || (res[n].proof && res[n].proof.attacker ? 'tree' : '-'));
        const ok = res[n].proofVerified === true;
        if (ok) verified++; else { badProof++; reasons.push(`${s.tag} arm${n}: proofVerified=${res[n].proofVerified}`); }
      }
    }
    perPos.push(`${s.tag} P${s.side}: ` + names.map(n =>
      `${n}=${res[n].status === 'proven-win' ? '胜' : res[n].status === 'proven-loss' ? '败' : '?'}/d${res[n].completedDepth}/${res[n].ms.total}ms`).join('  '));
  }

  console.log('=== 逐局面（A 基线 / B 仅P3 / C 仅P4 / D P3+P4）===');
  for (const r of perPos) console.log('  ' + r);
  const n = samples.length;
  console.log('\n=== 汇总（局面 %d，timeMs=%d）===', n, timeMs);
  console.log('  臂       证胜  相对A新增  平均耗时   平均完成深度(与A同批)   P3自身(ms/节点)   P4自身(ms/节点)');
  for (const k of names) {
    const a = agg[k];
    const d = a.depthN ? (a.depth / a.depthN).toFixed(2) : '-';
    console.log(`  ${k}        ${String(a.proofs).padStart(3)}      ${k === 'A' ? '-' : String(a.proofs - agg.A.proofs).padStart(3)}      ` +
      `${(a.ms / n).toFixed(0).padStart(4)}ms      ${d} (n=${a.depthN})`.padEnd(56) +
      `${a.p3ms}/${a.p3nodes}   ${a.p4ms}/${a.p4nodes}`);
  }
  console.log(`\n  P3/P4 新增证出合计: ${extra}；独立核验通过 ${verified} / 失败 ${badProof}`);
  if (matePlies.length) console.log(`  新增证的 matePlies/类型: ${matePlies.join(', ')}`);
  for (const r of reasons) console.log('  ✗ ' + r);
  console.log('\n判据：新增>0 且核验全通过，同时平均完成深度不明显下降。');
})().catch(e => { console.error('报告异常：', e); process.exit(1); });
