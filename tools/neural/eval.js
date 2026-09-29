'use strict';
/* ============================================================
   对战评测：NN-AI vs 内置困难 AI
   用法：node eval.js --model tools/neural/model.json [--games 20] [--depth 2] [--branch 8] [--diff hard]
                 [--out tools/neural/eval_result.json]
   约定：双方先后手对半，胜率按「NN 视角折算」（赢+1 输-1，over 折合胜率）。
   ============================================================ */
const fs = require('fs'), path = require('path');
const { playGame } = require('./arena');
const { builtinAgent } = require('./agents-builtin');
const { makeNNAgent } = require('./agents-nn');
const { makeLeaderAgent } = require('./agents-leader');
const { makeHtmlAgent } = require('./agents-html');

function args(){
  const a = {};
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i += 2) a[v[i].replace(/^--/, '')] = v[i + 1];
  return a;
}
const A = args();
const GAMES = +A.games || 16;
const DEPTH = +A.depth || 2;
const BRANCH = +A.branch || 8;
const DIFF = A.diff || 'hard';
const MODEL = A.model || path.join(__dirname, 'model.json');
const OUT = A.out || path.join(__dirname, 'eval_result.json');
const AGENT = A.agent || (A.model ? 'nn' : 'leader');
const NNMIX = A.nnmix != null ? +A.nnmix : 0.7;
const RICHMIX = A.richmix != null ? +A.richmix : 0.4;
const RICH = A.richmodel || '';          // 18 维根层模型
const NOISE = A.noise !== '0';
const TRANSCRIPT = A.transcript || '';
const COLOR = A.color || '';   // 'red'|'blue'：锁定被测侧（用于定向测量蓝/红）

function pct(s, n){ return ((s + n) / (2 * n) * 100).toFixed(1); }

function makeAgent(){
  if (AGENT === 'html'){
    return makeHtmlAgent({
      model: MODEL, richmodel: RICH, depth: DEPTH, branchK: BRANCH,
      nodeCap: 100000, nnMix: NNMIX, richMix: RICHMIX, blueDeeper: A.blueDeeper === '1',
      qN: A.qN != null ? +A.qN : 10,
      name: 'HL'
    });
  }
  if (AGENT === 'leader'){
    const modelObj = A.model && fs.existsSync(MODEL) ? JSON.parse(fs.readFileSync(MODEL, 'utf8')) : null;
    const richObj = RICH && fs.existsSync(RICH) ? JSON.parse(fs.readFileSync(RICH, 'utf8')) : null;
    return makeLeaderAgent(modelObj, { depth: DEPTH, branchK: BRANCH, nnMix: NNMIX, noise: NOISE, rootModel: richObj, richMix: RICHMIX, name: 'L' });
  }
  const model = JSON.parse(fs.readFileSync(MODEL, 'utf8'));
  return makeNNAgent(model, { depth: DEPTH, branchK: BRANCH, name: 'NN' });
}

(async () => {
  const hAgent = builtinAgent(DIFF, { label: '内置' + DIFF });
  if (TRANSCRIPT) fs.mkdirSync(TRANSCRIPT, { recursive: true });
  let score = 0, nnRedWin = 0, nnBlueWin = 0, nnRedLoss = 0, nnBlueLoss = 0, draws = 0;
  let t0 = Date.now(), totalMs = 0, movesSum = 0, slowSum = 0;
  const results = [];
  const P1 = 1, P2 = 2;
  for (let i = 0; i < GAMES; i++){
    // 偶数局: 被测 AI 执红先手; 奇数局: 被测 AI 执蓝后手（交替抵消先后手/颜色偏差）
    // --color red|blue 固定一侧（定向评测红/蓝强度）
    const nnAsA = COLOR === 'red' ? true : (COLOR === 'blue' ? false : (i % 2 === 0));
    const nnAgent = makeAgent();
    let agentA, agentB, first;
    if (nnAsA){
      agentA = { name: nnAgent.name, choose: (G, me, op) => nnAgent.choose(G, me, op) };
      agentB = { name: '内置' + DIFF, choose: (G, me, op) => hAgent.choose(G, me, op) };
      first = P1;
    } else {
      agentA = { name: '内置' + DIFF, choose: (G, me, op) => hAgent.choose(G, me, op) };
      agentB = { name: nnAgent.name, choose: (G, me, op) => nnAgent.choose(G, me, op) };
      first = P1;
    }
    const r = await playGame(agentA, agentB, { first, maxMoves: 300 });
    const w = r.winner;
    // agents[P1]=agentA, agents[P2]=agentB；nnAsA → NN 执红，否则执蓝
    const nnRed = w === P1;              // 若赢家=红且 NN 执红 → NN 胜
    const nnBlue = w === P2;             // 若赢家=蓝且 NN 执蓝 → NN 胜
    let got = 0;
    if (w === 0){ draws++; }
    else if (nnAsA && nnRed){ score += 1; nnRedWin++; got = 1; }
    else if (nnAsA){ score -= 1; nnRedLoss++; got = -1; }
    else if (!nnAsA && nnBlue){ score += 1; nnBlueWin++; got = 1; }
    else { score -= 1; nnBlueLoss++; got = -1; }
    totalMs += r.ms; movesSum += r.moves; slowSum += r.slowMs;
    results.push({ i, nnColor: nnAsA ? 'red' : 'blue', result: got, winner: w, moves: r.moves });
    if (TRANSCRIPT){
      fs.writeFileSync(path.join(TRANSCRIPT, 'g' + (i + 1) + '.json'), JSON.stringify({
        i, nnColor: nnAsA ? 'red' : 'blue', result: got, winner: w, rmv: r.history
      }, null, 1));
    }
    process.stdout.write((i + 1) + '/' + GAMES + ' ');
  }
  process.stdout.write('\n');
  const wall = (Date.now() - t0) / 1000;
  const nnWinsN = nnRedWin + nnBlueWin;
  const nnLossN = nnRedLoss + nnBlueLoss;
  console.log('== ' + AGENT + '(depth' + DEPTH + ',branch' + BRANCH + ') vs 内置' + DIFF + ' ==  ' + GAMES + ' 局');
  console.log('被测 执红 ' + nnRedWin + '胜/' + nnRedLoss + '负  |  执蓝 ' + nnBlueWin + '胜/' + nnBlueLoss + '负  |  和 ' + draws);
  console.log('折算胜率: ' + pct(score, GAMES) + '%   (积分 ' + score + '/' + GAMES + ')');
  console.log('平均每局 ' + (movesSum / GAMES).toFixed(1) + ' 手  墙钟总 ' + wall.toFixed(1) + 's');
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ score, nnRedWin, nnBlueWin, nnRedLoss, nnBlueLoss, draws, games: GAMES, diff: DIFF, depth: DEPTH, branch: BRANCH, agent: AGENT, wall }, null, 2));
})().catch(e => { console.error(e); process.exit(1); });