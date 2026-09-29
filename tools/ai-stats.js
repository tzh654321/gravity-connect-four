/* 困难 vs 困难 批量自对弈统计（红蓝/斜直获胜、四子中心、步数、对称同构） */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const N = parseInt(process.argv[2] || '80', 10);
const OUT = __dirname + '/g4_ai_stats_v3.csv';

let src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
src += `;globalThis.__G={state,resetGame,placePiece,updateMoving,aiChooseMove,K,P1,P2,BLOCK,
  get history(){return history},get winCells(){return state.winCells}};`;
const noop = () => {};
const cctx = () => new Proxy({}, { get:(t,p)=> p==='measureText'?()=>({width:5})
  : (p==='createRadialGradient'||p==='createLinearGradient')?()=>({addColorStop:noop})
  : (p==='canvas')?{width:800,height:600} : noop, set:()=>true });
const el = () => ({ textContent:'',value:'50',checked:true,style:{},classList:{_s:new Set(),
  add(c){this._s.add(c)},remove(c){this._s.delete(c)},toggle(c){this._s.has(c)?this._s.delete(c):this._s.add(c)},contains(c){return this._s.has(c)}},
  addEventListener:noop,appendChild:noop,removeChild:noop,getContext:()=>cctx(),
  getBoundingClientRect:()=>({left:0,top:0,width:800,height:600}),querySelectorAll:()=>[],clientWidth:800,clientHeight:600 });
const sb = { console, Math, Date, JSON, Map, Set, performance:{now:()=>Date.now()},
  requestAnimationFrame:()=>0, cancelAnimationFrame:noop, setTimeout:()=>0, clearTimeout:noop,
  fetch:()=>Promise.reject(new Error('x')),
  document:{ getElementById:()=>el(), querySelectorAll:()=>[], addEventListener:noop,
              createElement:()=>el(), body:{appendChild:noop,removeChild:noop} },
  window:{ addEventListener:noop, devicePixelRatio:1 }, navigator:{ userAgent:'n' },
  location:{ href:'file:///x.html' } };
sb.globalThis = sb; vm.createContext(sb); vm.runInContext(src, sb, { filename:'game.js' });
const G = sb.__G, P1 = G.P1, P2 = G.P2, K = G.K;

const SYMS = [];            // 8 个几何变换
for (const [a,b,c,d] of [[1,0,0,1],[-1,0,0,1],[1,0,0,-1],[-1,0,0,-1],[0,1,1,0],[0,-1,1,0],[0,1,-1,0],[0,-1,-1,0]])
  SYMS.push(p => ({ x:a*p.x+b*p.y, y:c*p.x+d*p.y }));
const tf = (t,p) => t({x:p.x,y:p.y});
/* 对局规范形：在 8 对称 × 2 颜色下取字典序最小 */
function canonKey(hist){
  let best = null;
  for (const t of SYMS){
    for (const swap of [0,1]){
      const parts = hist.map(h => {
        const q = tf(t, h.land);
        return (h.owner === P1 ? (swap?2:1) : (swap?1:2)) + ',' + q.x + ',' + q.y;
      });
      const s = parts.join(';');
      if (!best || s < best) best = s;
    }
  }
  return best;
}

function playOne(){
  G.state.mode = 'mm'; G.state.diff = 'hard'; G.resetGame();
  let n = 0, guard = 0;
  while (guard++ < 6000){
    if (G.state.phase === 'over') break;
    if (G.state.phase !== 'idle'){ G.updateMoving(1/60); continue; }
    const c = G.aiChooseMove();
    if (!c) break;
    G.placePiece(c, G.state.turn);
    n++;
  }
  while (G.state.phase === 'falling' && guard++ < 6000) G.updateMoving(1/60);
  const wc = G.winCells || null;
  let type = '', dir = '';
  if (wc && wc.length >= 2){
    const dx = wc[wc.length-1][0] - wc[0][0], dy = wc[wc.length-1][1] - wc[0][1];
    dir = Math.abs(dx) >= Math.abs(dy)
      ? (dx > 0 ? 'E→' : 'W←') + (Math.abs(dy) ? 'diag' : 'straight')
      : (dy > 0 ? 'N↑' : 'S↓') + (Math.abs(dx) ? 'diag' : 'straight');
    type = (dx !== 0 && dy !== 0) ? '斜' : '直';
  }
  let cx = '', cy = '';
  if (wc && wc.length){
    const xs = wc.map(c=>c[0]), ys = wc.map(c=>c[1]);
    const mnx = Math.min(...xs), mxx = Math.max(...xs), mny = Math.min(...ys), mxy = Math.max(...ys);
    cx = ((mnx+mxx)/2).toFixed(1); cy = ((mny+mxy)/2).toFixed(1);
  }
  return { winner: G.state.winner, moves: G.state.moveCount, wc: wc ? wc.slice() : null,
           type, dir, cx, cy, hist: G.history.map(h => ({ owner:h.owner, land:h.land })) };
}

const games = [];
const t0 = Date.now();
for (let i = 0; i < N; i++) games.push(playOne());
const msTotal = Date.now() - t0;

/* 汇总 */
const agg = { R_diag:0, R_straight:0, B_diag:0, B_straight:0 };
for (const g of games){
  if (g.winner === P1) g.winner === 1 && (g.type==='斜' ? agg.R_diag++ : agg.R_straight++);
  else g.winner === P2 && (g.type==='斜' ? agg.B_diag++ : agg.B_straight++);
}
/* 同构分组 */
const groups = new Map();
for (const g of games){ const k = canonKey(g.hist); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(g); }
const multi = [...groups.values()].filter(a => a.length > 1).sort((a,b)=>b.length-a.length);
const dupGames = multi.reduce((s,a)=>s+a.length, 0);
const dupMoves = multi.reduce((s,a)=>s+a.reduce((x,g)=>x+g.moves,0), 0);
const allMoves = games.reduce((s,g)=>s+g.moves,0);

let csv = '\uFEFF';
csv += '=== 困难 vs 困难 ' + N + ' 局 汇总（耗时 ' + (msTotal/1000).toFixed(1) + 's） ===\n';
csv += '红方斜连,红方直连,蓝方斜连,蓝方直连,总局数,平均步数\n';
csv += agg.R_diag + ',' + agg.R_straight + ',' + agg.B_diag + ',' + agg.B_straight + ',' +
       N + ',' + (allMoves/N).toFixed(2) + '\n\n';
csv += '=== 对称/旋转同构（组大小 ≥2）===\n';
csv += '同构组数,属于同构组的局数,这些局总步数,占比(局)\n';
csv += multi.length + ',' + dupGames + ',' + dupMoves + ',' + (dupGames/N*100).toFixed(1) + '%\n';
csv += '同构组,组内局数,组内总步数\n';
multi.forEach((a,i)=> { csv += 'G' + (i+1) + ',' + a.length + ',' + a.reduce((s,g)=>s+g.moves,0) + '\n'; });
csv += '\n=== 逐局明细 ===\n';
csv += '局号,胜方,连线类型,方向,中心x,中心y,步数,赢线\n';
games.forEach((g,i)=>{
  const w = g.winner===P1 ? '红' : g.winner===P2 ? '蓝' : '无';
  const line = g.wc ? g.wc.map(c=>'('+c[0]+','+c[1]+')').join('→') : '';
  csv += (i+1) + ',' + w + ',' + (g.type||'-') + ',' + (g.dir||'-') + ',' + (g.cx||'') + ',' +
         (g.cy||'') + ',' + g.moves + ',' + line + '\n';
});
fs.writeFileSync(OUT, csv, 'utf8');
console.log('已写 ' + OUT);
console.log(JSON.stringify({汇总: agg, 同构组: multi.length, 同构局数: dupGames, 同构局总步数: dupMoves,
  平均步数: +(allMoves/N).toFixed(2), 每组大小: multi.map(a=>a.length), 总耗时_s: +(msTotal/1000).toFixed(1) }));
