'use strict';
/* 证书驱动的实战选招（P5）。
   对每个根候选建"证据表"（ownWin / survival / opponentWin + 启发式分），
   然后**只用可证的优劣关系**选招：
     own-win  >  survival（有防守证书）  >  unknown（交回受限搜索）  >  doomed（已证必败，尽量推迟）
   同一张表里所有候选共用同一个 horizon ⇒ 同尺度，不把上界当精确距离。

   用法：
     node tools/certified-choose.js --fixture tools/fixtures/bounded-ply4.json
     node tools/certified-choose.js --records tools/bench-games-lean.jsonl --game "hard|P1#7" --ply 4
     node tools/certified-choose.js --fixture <f> --horizon 12 --maxNodes 3000000 --timeMs 600000
     --out <path.json>   把证据表与决策落盘（可复现）
*/
const fs = require('fs');
const path = require('path');
const { chooseMoveCertified, Position, certifyRoot, winPointsAll } = require('./solver-core');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};

function boardFromRecords(recPath, game, ply) {
  const lines = fs.readFileSync(recPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const g = game ? lines.find(x => x.game === game) : lines[0];
  if (!g) throw new Error('未找到对局：' + game);
  const pos = new Position(g.start);
  const boards = [];
  for (const r of g.record) { boards[r.ply] = [...pos.board]; pos.play(r.move, r.side); }
  return { board: boards[ply], game: g.game, ply, source: recPath };
}

(function main() {
  const fixture = argOf('fixture', null);
  const recPath = argOf('records', null);
  const horizon = Number(argOf('horizon', 16));
  const maxNodes = Number(argOf('maxNodes', 3000000));
  const timeMs = Number(argOf('timeMs', 600000));
  const tighten = argOf('tighten', '1') !== '0';
  const outPath = typeof argOf('out', null) === 'string' ? argOf('out', null) : null;

  let board, label;
  if (fixture) {
    const d = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    board = d.board;
    label = `${path.basename(fixture)}  P${d.sideToMove} 走  （攻击方 P${d.attacker}）`;
  } else if (recPath) {
    const r = boardFromRecords(recPath, argOf('game', null), Number(argOf('ply', 4)));
    board = r.board; label = `${r.game}@ply${r.ply}`;
  } else {
    console.error('用法：node tools/certified-choose.js --fixture <f.json> | --records <r.jsonl> --game <g> --ply <n>');
    process.exit(1);
  }
  const pos = new Position(board);
  const side = ((pos.board.size - 1) % 2 === 0) ? 1 : 2;
  console.log(`局面：${label}`);
  console.log(`  轮到 P${side}；合法走法 ${pos.moves().length} 个；固定块在 (0,0)`);
  console.log(`  口径：horizon=${horizon} 半回合，起点 = 「走完该根候选之后的局面」；tighten=${tighten ? '开' : '关'}`);
  console.log('');

  const t0 = Date.now();
  const res = chooseMoveCertified(board, side, {
    horizon, fallback: true, fallbackDepth: 6, fallbackTimeMs: 2000, fallbackNodes: 80000,
    certify: { maxNodes, timeMs, tighten }
  });
  const ev = res.evidence;

  // —— 证据表 ——
  console.log('证据表（每行 = 一个根候选；距离起点 = 走完该手后的局面）：');
  const rows = ev.moves.slice().sort((a, b) =>
    (a.move.x - b.move.x) || (a.move.y - b.move.y));
  for (const r of rows) {
    const tag = r.ownWin ? `自己可胜 ≤${r.ownWin.minPlies == null ? r.ownWin.horizon + '(上界)' : r.ownWin.minPlies}`
      : r.survival ? `对手 ≤${r.survival.horizon} 内赢不了（有证书）`
        : r.opponentWin ? `对手可胜 ≤${r.opponentWin.minPlies == null ? r.opponentWin.horizon + '(上界)' : r.opponentWin.minPlies}`
          : '无证据（未知）';
    const kind = r.ownWin ? 'ownWin  ' : r.survival ? 'survival' : r.opponentWin ? 'doomed  ' : 'unknown ';
    console.log(`  (${String(r.move.x).padStart(2)},${String(r.move.y).padStart(2)})  ${kind}  ${tag.padEnd(28)} 启发式 ${String(r.heuristicScore).padStart(6)}`);
  }
  console.log('');

  const chosen = res.move;
  const chosenRec = ev.moves.find(r => r.move.x === chosen.x && r.move.y === chosen.y);
  console.log(`⇒ 决策：走 (${chosen.x},${chosen.y})   [tier=${res.tier}]`);
  console.log(`   理由：${res.reason}`);
  if (res.fallback) console.log(`   受限搜索兜底：深度 ${res.fallback.depth}，分 ${res.fallback.score}，节点耗尽=${res.fallback.exhausted}`);
  if (chosenRec && chosenRec.opponentWin) {
    console.log(`   ⚠ 注意：本手仍被证会在 ≤${chosenRec.opponentWin.horizon} 内被强制击败（全部候选皆如此）`);
  }
  if (res.tier === 'survival' || res.tier === 'unknown') {
    const doomed = ev.moves.filter(r => r.opponentWin);
    if (doomed.length) {
      const dist = doomed.map(r => r.opponentWin.minPlies == null ? r.opponentWin.horizon : r.opponentWin.minPlies);
      console.log(`   ✔ 已避开 ${doomed.length} 手被证必败的候选；它们被证败的深度（起点上文口径）为 ${dist.slice().sort((a, b) => a - b).join('/')} 半回合`);
      console.log(`     对照：本手拿到的是「对手在 ≤${horizon} 半回合内无法强制连四」的**防守证书**（同尺度上严格更优）`);
    }
  }
  console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (outPath) {
    const slim = {
      label, board, side, horizon, origin: ev.origin,
      moves: ev.moves.map(r => ({
        move: r.move, heuristicScore: r.heuristicScore,
        ownWin: r.ownWin ? { horizon: r.ownWin.horizon, minPlies: r.ownWin.minPlies, exact: r.ownWin.exact } : null,
        opponentWin: r.opponentWin ? { horizon: r.opponentWin.horizon, minPlies: r.opponentWin.minPlies, exact: r.opponentWin.exact } : null,
        survival: r.survival ? { horizon: r.survival.horizon } : null
      })),
      decision: { move: chosen, tier: res.tier, reason: res.reason }
    };
    fs.writeFileSync(outPath, JSON.stringify(slim, null, 2) + '\n');
    console.log(`  证据表已写入 ${outPath}`);
  }
})();
