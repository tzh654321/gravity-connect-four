/* 人(AI扮演) vs 困难AI 对局驱动：
   node drive.js NEW <red|blue>           开新局，red=人执红先，blue=人执蓝后
   node drive.js MOVE x,y                 人落子（自动让困难AI应一手并打印局面）
   状态存 drive_state.json */
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const FILE = __dirname + '/drive_state.json';
let src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
src += `;globalThis.__G={state,addP,placePiece,updateMoving,aiChooseMove,computeDanger,K,P1,P2,BLOCK,ownerAt,
  set occ(v){occ=v},get occ(){return occ},get history(){return history},get danger(){return danger}};`;
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
const drain = () => { let f=0; while (G.state.phase==='falling' && f++<600000) G.updateMoving(1/60); };

function rebuild(moves){
  const occ = new Map(); occ.set(K(0,0), G.BLOCK); G.occ = occ;
  for (let i=0;i<moves.length;i++){ const m=moves[i]; G.addP(m.x,m.y,m.o); }
  G.state.moveCount = moves.length;
  G.state.phase = 'idle';
  G.state.turn = moves.length ? (moves[moves.length-1].o === P1 ? P2 : P1) : (moves[0]&&moves[0].o===P2?P2:P1);
}
function findHalf(){
  let h=6; for (const [k] of G.occ){ const i=k.indexOf(','); const x=+k.slice(0,i);
    if (Math.abs(x)>=h-1) h = Math.abs(x)+3; }
  return Math.min(h, 12);
}
function ascii(){
  const half = findHalf();
  const cx = G.state.lastMove ? G.state.lastMove.x : 0, cy = G.state.lastMove ? G.state.lastMove.y : 0;
  const x0 = Math.min(cx, 0)-half, x1 = Math.max(cx, 0)+half;
  const y0 = Math.min(cy, 0)-half, y1 = Math.max(cy, 0)+half;
  let out = '   '; for (let x=x0;x<=x1;x++) out += (x<0?'-':' ')+(''+x).padStart(2,'-');
  out += '\n';
  for (let y=y1;y>=y0;y--){
    let row = ' '+(y<0?'-':' ')+(''+y).padStart(2,'-')+' ';
    for (let x=x0;x<=x1;x++){
      const o = G.ownerAt(x,y);
      let ch='.';
      if (x===0&&y===0) ch='X';
      else if (o===P1) ch='R';
      else if (o===P2) ch='B';
      row += '  '+ch+' ';
    }
    out += row+'\n';
  }
  out += '   R=你('+(state_hum==='red'?'先手红':'后手红?')+') 棋盘X轴为行(y向上)\n';
  return out;
}
let state_hum = 'red';
function print(moves, tail){
  const dm = G.danger || new Map();
  const dline = [];
  for (const [k,e] of dm){ const i=k.indexOf(','); const x=+k.slice(0,i),y=+k.slice(i+1);
    const o = e.a.owner===P1?'红':'蓝'; dline.push(o+'('+x+','+y+')'+e.a.level); }
  let h = '';
  h += '局面 ' + moves.length + ' 手 · 轮到' + (G.state.turn===P1?'红':'蓝');
  if (G.state.phase==='over'){ h += ' · 对局结束'; }
  console.log(ascii());
  console.log('威胁点: ' + (dline.length? dline.join(' '):'无'));
  const last = moves[moves.length-1];
  if (tail) console.log('→ 我方: '+(state_hum==='red'?'红':'蓝')+' @('+last.x+','+last.y+')  [第'+moves.length+'手]');
  console.log('手谱尾: ' + moves.slice(-8).map(m=>(m.o===P1?'R':'B')+'@('+m.x+','+m.y+')').join(' '));
}
const cmd = process.argv[2], arg = process.argv[3];
if (cmd === 'NEW'){
  state_hum = arg === 'blue' ? 'blue' : 'red';
  const first = state_hum==='red' ? P1 : P2;   // 人红先/人蓝后
  const moves = [];
  rebuild(moves);
  G.state.turn = first;
  fs.writeFileSync(FILE, JSON.stringify({ moves, hum:state_hum, turn:first }));
  print(moves,false);
  console.log('NEW: 你执'+(state_hum==='red'?'红(先手)':'蓝(后手，等红AI先落)')+
    ' → 命令 MOVE x,y 落子（AI会自动应手）。我执红先走：MOVE 1,0');
  process.exit(0);
}
const st = JSON.parse(fs.readFileSync(FILE,'utf8'));
state_hum = st.hum;
let moves = st.moves;
rebuild(moves);
if (cmd === 'OPP'){
  const me = state_hum==='red'?P1:P2;
  if (G.state.phase==='over'){
    print(moves,false);
    console.log('对局已结束（胜者='+(G.state.winner===P1?'红':'蓝')+'）');
  } else {
    G.state.diff = 'hard';
    const c = G.aiChooseMove();
    if (c){ const ao = G.state.turn; G.placePiece(c, ao); drain(); moves.push({ o:ao, x:c.x, y:c.y }); }
  }
  fs.writeFileSync(FILE, JSON.stringify({ moves, hum:state_hum, turn:G.state.turn }));
  G.computeDanger();
  print(moves, false);
  if (G.state.phase==='over'){ console.log('胜者='+(G.state.winner===P1?'红':'蓝')+' 总'+moves.length+'手'); }
  else console.log(G.state.turn===me ? '轮到你了 → MOVE x,y' : '轮到 AI');
  process.exit(0);
}
if (cmd === 'MOVE'){
  const [x,y] = arg.split(',').map(Number);
  const me = state_hum==='red'?P1:P2;
  // 允许投点 vs 落点：为"人"简单——允许直接输入落点坐标（若是静止点则相等）。校验 owner
  if (G.ownerAt(x,y)!==0){ console.log('非法：( '+x+','+y+') 已有子'); process.exit(1); }
  const t0=Date.now();
  const ok = G.placePiece({x,y}, me);
  drain();
  if (!ok){ console.log('落子被拒'); process.exit(1); }
  moves.push({ o:me, x, y });
  // AI 应一手（若未结束）
  if (G.state.phase !== 'over'){
    G.state.diff = 'hard';
    const c = G.aiChooseMove();
    if (c){
      const ao = G.state.turn===P1?P1:P2;
      G.placePiece(c, ao);
      drain();
      moves.push({ o:ao, x:c.x, y:c.y });
    }
  }
  G.computeDanger();
  fs.writeFileSync(FILE, JSON.stringify({ moves, hum:state_hum, turn:G.state.turn }));
  print(moves, true);
  if (G.state.phase==='over'){ console.log('胜者='+(G.state.winner===P1?'红':'蓝')+' 总'+moves.length+'手');
    console.log('完整记录：');
    moves.forEach((m,i)=>console.log((i+1)+'. '+(m.o===P1?'红':'蓝')+' ('+m.x+','+m.y+')'));
  } else if (G.state.turn === me){
    console.log('轮到你了 → MOVE x,y');
  } else {
    console.log('（AI已应手，轮到你）→ MOVE x,y');
  }
}
