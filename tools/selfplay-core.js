'use strict';
/* self-play 核心：模块级缓存沙箱，playSelf(diff) 跑一局困难/普通自对弈 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let ENV = null;
function env(){
  if (ENV) return ENV;
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
  const src = HTML.match(/<script>([\s\S]*?)<\/script>/)[1] +
    ';globalThis.__G={state,addP,set occ(v){occ=v},get occ(){return occ},' +
    'aiChooseMove,placePiece,updateMoving,K,P1,P2,BLOCK};';
  vm.createContext(sb);
  vm.runInContext(src, sb, { filename:'g.js' });
  ENV = sb.__G;
  return ENV;
}
function drain(G){ let f=0; while (G.state.phase==='falling' && f++ < 800000) G.updateMoving(1/60); }

function playSelf(diff){
  const G = env();
  const o = new Map(); o.set(G.K(0,0), G.BLOCK); G.occ = o;
  Object.assign(G.state, { mode:'mm', diff: diff || 'hard', phase:'idle', turn:G.P1, moveCount:0, winner:0 });
  let n = 0, t0 = Date.now(), slow = 0;
  while (n < 600){
    const ts = Date.now();
    const d = G.aiChooseMove();
    const ms = Date.now() - ts; if (ms > slow) slow = ms;
    if (!d) break;
    G.placePiece(d, G.state.turn); drain(G);
    n++;
    if (G.state.phase === 'over') break;
  }
  return { n, winner: G.state.winner, ms: Date.now()-t0, slow };
}
function runAll(games, diff){
  const out = [];
  for (let i = 0; i < games; i++) out.push(playSelf(diff));
  return out;
}
module.exports = { playSelf, runAll };
