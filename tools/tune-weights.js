'use strict';
/* ============================================================
   AI 启发式权重 进化调优（差分进化 DE/best/1 + 自博弈评测）
   用法：
     node tune-weights.js --pop 8 --gens 4 --games 4 --diff normal
     --pop 每代个体数(含基线与精英)  --gens 迭代代数
     --games 每个体与基线对弈总局数(先后手各半)  --diff normal|hard
   评测：被测个体与「源码默认权重」对弈（先后手对半，抵消先手优势），
   胜+1/负-1/和 0，games 局求总。基线自身恒为 0 参照。
   每代打印 top 基因与基线胜率；结束输出建议参数 + tune_result.json。
   ============================================================ */
const fs = require('fs'), path = require('path'), vm = require('vm');

const DIR = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

const BASE = {
  s3:70, s2:11, s1:1.5,  t3:-80, t2:-13, t1:-1.5,
  myDouble:30000, mySingle:900, opDouble:-32000, opSingle:-22000,
  opFork:-24000, myFork:6000, hiThr:1e5, hiPen:1e5, loThr:130, loPen:700,
  pp:1200
};
/* 进化的自由基因：静态棋型分（三连/二连/单子 × 攻防）+ 关键大额惩罚
   （送对手杀点 opSingle、送活三 opFork、单威胁逼应 mySingle） */
const FREE = ['s3','s2','s1','t3','t2','t1','mySingle','opFork','opSingle','pp'];

function args(){
  const a = {};
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i += 2) a[v[i].replace(/^--/,'')] = v[i+1];
  return a;
}
const A = args();
const POP = +A.pop || 8, GENS = +A.gens || 4, GAMES = +A.games || 4, DIFF = A.diff || 'normal';

/* ---------- 权重注入：把基因数值写进内存源码 ---------- */
function inject(html, g){
  let s = html;
  const R = (pat, rep) => { if (!s.includes(pat)) throw new Error('注入未命中: ' + pat.slice(0,40)); s = s.replace(pat, rep); };
  R('if (mine > 0) return mine===3 ? 70 : (mine===2 ? 11 : 1.5);',
    `if (mine > 0) return mine===3 ? ${g.s3} : (mine===2 ? ${g.s2} : ${g.s1});`);
  R('if (theirs > 0) return theirs===3 ? -80 : (theirs===2 ? -13 : -1.5);',
    `if (theirs > 0) return theirs===3 ? ${g.t3} : (theirs===2 ? ${g.t2} : ${g.t1});`);
  R('(myG >= 2 ? 30000 : myG === 1 ? 900 : 0)',
    `(myG >= 2 ? ${g.myDouble} : myG === 1 ? ${g.mySingle} : 0)`);
  R('(opG >= 2 ? -32000 : opG === 1 ? -22000 : 0)',
    `(opG >= 2 ? ${g.opDouble} : opG === 1 ? ${g.opSingle} : 0)`);
  R('(opFork ? -24000 : 0)', `(opFork ? ${g.opFork} : 0)`);
  R('myFork ? 6000 : 0', `myFork ? ${g.myFork} : 0`);
  R('const PRESSURE_PEN = 1200;', `const PRESSURE_PEN = ${g.pp};`);
  const re = /o\.v2 = o\.v - \(best >= 1e5 \? 1e5 : 0\) - \(best >= 130 \? 700 : 0\);/g;
  const n2 = s.replace(re,
    `o.v2 = o.v - (best >= ${g.hiThr} ? ${g.hiPen} : 0) - (best >= ${g.loThr} ? ${g.loPen} : 0);`);
  if (n2 === s && !s.includes('best >= 1e5')) ; // 两处均已换或不存在
  if (n2 !== s) s = n2;
  return s;
}

/* ---------- 无头沙箱 ---------- */
function makeEnv(htmlSrc){
  const noop = () => {};
  const ctxStub = () => new Proxy({}, { get(t,p){
    if (p==='measureText') return ()=>({width:5});
    if (p==='createRadialGradient'||p==='createLinearGradient') return ()=>({addColorStop:noop});
    if (p==='canvas') return {width:800,height:600}; return noop; }, set(){ return true; } });
  const el = () => ({ textContent:'', value:'50', checked:true, style:{}, width:800, height:600,
    classList:{ _s:new Set(), add(c){this._s.add(c)}, remove(c){this._s.delete(c)},
      toggle(c){this._s.has(c)?this._s.delete(c):this._s.add(c)}, contains(c){return this._s.has(c)} },
    addEventListener:noop, appendChild:noop, removeChild:noop, getContext:()=>ctxStub(),
    getBoundingClientRect:()=>({left:0,top:0,width:800,height:600}), querySelectorAll:()=>[],
    clientWidth:800, clientHeight:600 });
  const sb = { console, Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean,
    parseInt, parseFloat, isNaN, performance:{now:()=>Date.now()}, requestAnimationFrame:()=>0,
    cancelAnimationFrame:noop, setTimeout:()=>0, clearTimeout:noop,
    fetch:()=>Promise.reject(new Error('x')),
    document:{ getElementById:()=>el(), querySelectorAll:()=>[], addEventListener:noop,
      createElement:()=>el(), body:{appendChild:noop, removeChild:noop} },
    window:{ addEventListener:noop, devicePixelRatio:1 }, navigator:{userAgent:'n'},
    location:{ href:'file:///x.html' } };
  sb.globalThis = sb;
  const src = htmlSrc.match(/<script>([\s\S]*?)<\/script>/)[1] +
    ';globalThis.__G={state,addP,removeP,set occ(v){occ=v},get occ(){return occ},' +
    'aiChooseMove,placePiece,updateMoving,K,P1,P2,BLOCK};';
  vm.createContext(sb);
  vm.runInContext(src, sb, { filename:'g.js' });
  return sb.__G;
}
const drain = G => { let f=0; while (G.state.phase==='falling' && f++ < 800000) G.updateMoving(1/60); };

function resetGame(G){
  const o = new Map(); o.set(G.K(0,0), G.BLOCK); G.occ = o;
  Object.assign(G.state, { phase:'idle', turn:G.P1, moveCount:0, winner:0, winCells:null });
}

/* ---------- 一局：mut 与 base 对弈。返回 +1/-1/0（mut 视角） ---------- */
function playOnce(mutHtml, firstA, diff){
  const A = makeEnv(mutHtml), B = makeEnv(HTML);   // B = 基线（源码默认权重）
  resetGame(A); resetGame(B);
  const P1=A.P1, P2=A.P2;
  for (let g=0; g<600; g++){
    const mutIsRed = (A.state.turn === P1) === firstA;
    const cur = mutIsRed ? A : B, oth = mutIsRed ? B : A;
    const me = cur.state.turn;
    cur.state.diff = diff;
    const d = cur.aiChooseMove();
    if (!d) break;
    cur.placePiece(d, me); drain(cur);
    const lm = cur.state.lastMove;
    oth.addP(lm.x, lm.y, me);
    oth.state.moveCount = cur.state.moveCount; oth.state.phase = cur.state.phase;
    oth.state.turn = cur.state.turn; oth.state.winner = cur.state.winner;
    if (cur.state.phase === 'over') break;
  }
  const w = A.state.winner;
  if (!w) return 0;
  const redWon = w === A.P1;
  return (redWon === firstA) ? 1 : -1;
}

/* ---------- 个体与基线对弈 games 局（先手交替） ---------- */
function score(gene, games, diff){
  const html = inject(HTML, Object.assign({}, BASE, gene));
  let s = 0, wins = 0;
  for (let i = 0; i < games; i++){
    const r = playOnce(html, i % 2 === 0, diff);   // 先手交替
    s += r; if (r > 0) wins++;
  }
  return { s, wins };
}

/* ---------- DE ---------- */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function randGene(rng){
  const g = {};
  for (const k of FREE) g[k] = clamp(BASE[k] * (0.55 + rng() * 1.25), -1e6, 1e6);
  return g;
}
function mutate(rng, a, b, c, F, CR){
  const g = {};
  for (const k of FREE){
    const use = rng() < CR;
    g[k] = use ? clamp(a[k] + F * (b[k] - c[k]), -5e6, 5e6) : a[k];
  }
  return g;
}
function fmt(g){ return FREE.map(k => k + '=' + Math.round(g[k]*100)/100).join(' '); }

function mulberry(seed){ return function(){ seed|=0; seed=(seed+0x6D2B79F5)|0; let t=Math.imul(seed^(seed>>>15),1|seed); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296; }; }

async function main(){
  console.log('== 启发式权重差分进化 ==  pop='+POP+' gens='+GENS+' games='+GAMES+' diff='+DIFF);
  console.log('基线 = 源码默认（得分恒 0 参照）；自由基因: ' + FREE.join(','));
  const rng = mulberry(20260904);
  const t0 = Date.now();
  // 初始种群：base + 随机
  let pop = [{ gene:{}, fit:0, tag:'BASE' }];
  for (let i = 1; i < POP; i++) pop.push({ gene:randGene(rng), fit:0, tag:'R'+i });
  // base 自身得分作为参照跑一次（应≈0）
  let best = null;
  for (let gen = 0; gen <= GENS; gen++){
    for (const ind of pop){
      if (ind.tag === 'BASE' && gen > 0){ ind.fit = 0; continue; }
      const sc = score(ind.gene, GAMES, DIFF);
      ind.fit = sc.s; ind.wins = sc.wins;
    }
    pop.sort((a,b) => b.fit - a.fit);
    if (!best || pop[0].fit > best.fit) best = { gene:pop[0].gene, fit:pop[0].fit, gen };
    const pct = ((pop[0].fit + GAMES) / (2*GAMES) * 100).toFixed(0);
    console.log('\n[代 '+gen+'] 耗时 ' + ((Date.now()-t0)/1000).toFixed(0) + 's');
    console.log('  top: fit='+pop[0].fit+'/'+GAMES+' ('+pct+'% 胜率对基线)  ' + fmt(Object.assign({},BASE,pop[0].gene)));
    console.log('  mid: fit='+pop[Math.floor(POP/2)].fit+'  BASE 参照 fit=0');
    if (gen === GENS) break;
    // 生成下一代：保留 top2 + 变异
    const nxt = [pop[0], pop[1]];
    while (nxt.length < POP){
      const a = pop[Math.floor(rng()*Math.min(4,pop.length))];
      const b = pop[Math.floor(rng()*pop.length)];
      const c = pop[Math.floor(rng()*pop.length)];
      const g = mutate(rng, a.gene, b.gene, c.gene, 0.6, 0.5);
      nxt.push({ gene:g, fit:0 });
    }
    pop = nxt;
  }
  const fin = Object.assign({}, BASE, best.gene);
  console.log('\n== 最优基因（gen '+best.gen+', fit='+best.fit+'/'+GAMES+'）==' );
  console.log(JSON.stringify(fin, null, 1));
  fs.writeFileSync(path.join(__dirname,'tune_result.json'), JSON.stringify({ best:fin, fit:best.fit, games:GAMES, diff:DIFF }, null, 2));
  console.log('已写入 tools/tune_result.json');
  console.log('\n应用到游戏（可选，会覆盖默认权重）:');
  console.log('  node tools/tune-weights.js --apply   （把 tune_result.json 写回 index.html）');
}

if (A.verify){
  /* 独立验证模式：node tune-weights.js --verify 16 --diff normal
     读取 tune_result.json 的 best，与源码基线对弈 N 局（先手交替）报告真实胜率 */
  const n = +A.verify || 16;
  const res = JSON.parse(fs.readFileSync(path.join(__dirname, 'tune_result.json'), 'utf8'));
  const g = res.best;
  let s = 0, redWin = 0, blueWin = 0;
  for (let i = 0; i < n; i++){
    const html = inject(HTML, Object.assign({}, BASE, g));
    const r = playOnce(html, i % 2 === 0, DIFF);
    s += r;
    if (r > 0){ if (i % 2 === 0) redWin++; else blueWin++; }
  }
  const pct = ((s + n) / (2 * n) * 100).toFixed(1);
  console.log('== 独立验证 == 被测(best) vs 基线  ' + n + ' 局 diff=' + DIFF);
  console.log('被测执红胜 ' + redWin + ' / 执蓝胜 ' + blueWin + ' / 总积分 ' + s + '/' + n +
              '  折算胜率 ' + pct + '%（>50% 说明确实强于基线）');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
