'use strict';
/* ============================================================
   游戏沙箱加载（真实 HTML 逻辑）
   暴露：Game 对象 —— 含状态/棋盘/物理/胜负，及 async aiChooseMove
   说明：aiChooseMove 在源 HTML 里是 async，必须 await 获取落点。
   ============================================================ */
const fs = require('fs'), path = require('path'), vm = require('vm');

const DIR = path.join(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

function makeLoad(htmlSrc){
  let src = htmlSrc.match(/<script>([\s\S]*?)<\/script>/)[1];   /* 非贪婪：只取第一个 script，忽略注入的权重脚本 */
  src += ';globalThis.__G={state,addP,removeP,ownerAt,isFree,canSettleCell,wouldWin,checkWin,computeDanger,' +
    'set occ(v){occ=v},get occ(){return occ},K,P1,P2,BLOCK,WIN_LEN,DIRS,INF,genCandidates,landingSet,settleDiscrete,settleExact,' +
    'deltaEval,scoreWin,countWins,forkCount,reachPts,lookaheadThreat,scoreOption,oppBestReply,threatNega,' +
    'placePiece,updateMoving,aiChooseMove,nnFeatures,nnFeatures18,nnFeatures32,nnFeaturesP2,nnMirrorFeatures,nnThreatScan,nnSideStats,nnFeatFor,nnForkCells,quietNega,quietLeafVal,richNnVal,nnInit,' +
    'set nnw(v){globalThis.__NNW=v;__NNMODEL=null;},set nnw2(v){globalThis.__NNW2=v;__NNMODEL=null;}};';
  const noop = () => {};
  const cctx = () => new Proxy({}, { get(t,p){
    if (p==='measureText') return ()=>({width:5});
    if (p==='createRadialGradient'||p==='createLinearGradient') return ()=>({addColorStop:noop});
    if (p==='canvas') return {width:800,height:600}; return noop; }, set(){ return true; } });
  const el = () => ({ textContent:'', value:'50', checked:true, style:{}, width:800, height:600,
    classList:{ _s:new Set(), add(c){this._s.add(c)}, remove(c){this._s.delete(c)},
      toggle(c){this._s.has(c)?this._s.delete(c):this._s.add(c)}, contains(c){return this._s.has(c)} },
    addEventListener:noop, appendChild:noop, removeChild:noop, getContext:()=>cctx(),
    getBoundingClientRect:()=>({left:0,top:0,width:800,height:600}), querySelectorAll:()=>[],
    clientWidth:800, clientHeight:600 });
  const sb = { console, Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean,
    parseInt, parseFloat, isNaN, performance:{now:()=>Date.now()},
    requestAnimationFrame:noop,   // 加载期吞掉 rAF，防止游戏的动画 loop 无限递归
    cancelAnimationFrame:noop, setTimeout:()=>0, clearTimeout:noop,
    fetch:()=>Promise.reject(new Error('x')),
    document:{ getElementById:()=>el(), querySelectorAll:()=>[], addEventListener:noop,
      createElement:()=>el(), body:{appendChild:noop, removeChild:noop} },
    window:{ addEventListener:noop, devicePixelRatio:1 }, navigator:{userAgent:'n'},
    location:{ href:'file:///x.html' } };
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(src, sb, { filename:'g.js' });
  /* 加载完成后：rAF 改为同步触发回调 —— 让 async aiChooseMove 里的 yieldFrame 能完成，
     同时动画 loop 已在上一步被吞掉不再运行 */
  sb.requestAnimationFrame = (cb)=>{ cb(); return 0; };
  return sb.__G;
}

function createGame(){
  const G = makeLoad(HTML);
  reset(G);
  return G;
}

function reset(G){
  const o = new Map(); o.set(G.K(0,0), G.BLOCK);
  G.occ = o;
  Object.assign(G.state, { mode:'mm', phase:'idle', turn:G.P1, moveCount:0, winner:0, winCells:null, diff:'hard', mmPaused:false });
}

/* 推进下落直到固定 */
function drain(G){
  let f = 0;
  while (G.state.phase === 'falling' && f++ < 800000) G.updateMoving(1/60);
}

/* 在 G 上落地一枚 owner 的棋子（含投点），返回最终落点 */
function playMove(G, drop, owner){
  const ok = G.placePiece(drop, owner);
  drain(G);
  return ok ? G.state.lastMove : null;
}

module.exports = { createGame, reset, drain, playMove, makeLoad };