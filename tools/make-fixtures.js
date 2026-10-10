'use strict';
/* ============================================================
   make-fixtures —— 生成可入库的小型证明夹具

   把证明流水线的产物压成"只留 DAG 形式"的小文件，便于 code review 与追踪。
   大型原始棋谱（tools/bench-games-*.jsonl、tools/proofs-*.jsonl）继续 gitignore；
   但**关键证明证据**不应全部留在未跟踪文件里，故这里产出 tools/fixtures/ 下的小夹具。

   用法（先跑流水线产出源文件）：
     node tools/prove-positions.js --out tools/proofs-fixtures.jsonl
     node tools/prove-positions.js --records tools/bench-games-lean.jsonl --max 3 --out tools/proofs-losses.jsonl
     node tools/make-fixtures.js
   ============================================================ */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'fixtures');

function slim(rec, note) {
  const o = { game: rec.game, ply: rec.ply == null ? null : rec.ply, sideToMove: rec.sideToMove,
    attacker: rec.attacker, board: rec.board };
  if (rec.dag) o.dag = rec.dag; else o.tree = rec.tree;
  if (note) o.note = note;
  return JSON.stringify(o) + '\n';
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const jobs = [
  { src: path.join(__dirname, 'proofs-fixtures.jsonl'), out: 'proofs-fixtures.jsonl',
    note: '构造回归夹具：attacker 可强制获胜；DAG 形式，可由 verify-strategy.js 独立核验' },
  { src: path.join(__dirname, 'proofs-losses.jsonl'), out: 'proof-loss-ply6.jsonl', first: true,
    note: '真实对局 earliest 可证败点：attacker 可强制获胜；DAG 形式' },
];

let made = 0;
for (const j of jobs) {
  if (!fs.existsSync(j.src)) { console.log('跳过（源文件不存在）：' + path.basename(j.src)); continue; }
  const lines = fs.readFileSync(j.src, 'utf8').split('\n').filter(Boolean);
  const recs = j.first ? [JSON.parse(lines[0])] : lines.map(l => JSON.parse(l));
  const out = recs.map(r => slim(r, j.note)).join('');
  const dst = path.join(OUT_DIR, j.out);
  fs.writeFileSync(dst, out);
  console.log(`${j.out}  ${out.length} 字节（${recs.length} 条）`);
  made++;
}
console.log(made ? '完成。用 node tools/verify-strategy.js tools/fixtures/<file>.jsonl 独立核验。' : '没有生成任何夹具。');
