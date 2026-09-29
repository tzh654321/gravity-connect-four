'use strict';
const fs=require('fs'),path=require('path');
const { loadGame } = require('./game-sandbox');
function load(htmlPath){
  const HTML = fs.readFileSync(htmlPath, 'utf8');
  return loadGame(HTML,
    'state,addP,set occ(v){occ=v},get occ(){return occ},aiChooseMove,placePiece,updateMoving,' +
    'K,P1,P2,BLOCK,get oc(){return occ},' +
    'get threatNega(){return typeof threatNega!=="undefined"?threatNega:null},' +
    'get killsReach(){return typeof killsReach!=="undefined"?killsReach:null}');
}
function mkEnv(path){ return load(path); }
const NEW=path.join(__dirname,'..','index.html');
const OLD=path.join(__dirname,'ai_base_20260904.html');
let pass=0,fail=0; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m);c?pass++:fail++;};
const drain=G=>{let f=0;while(G.state.phase==='falling'&&f++<800000)G.updateMoving(1/60);};
function replay(html,n,rec){ const G=mkEnv(html); const P1=G.P1,P2=G.P2,K=G.K;
  const occ=new Map(); occ.set(K(0,0),G.BLOCK); G.occ=occ;
  for(let i=0;i<n;i++){const[x,y]=rec[i];G.addP(x,y,i%2===0?P1:P2);} G.state.moveCount=n;
  G.state.turn=n%2===0?P1:P2; G.state.phase='idle'; G.state.diff='hard'; return G; }
async function dist(html,n,rec,N){ const out={}; for(let i=0;i<N;i++){ const G=replay(html,n,rec);
  const c=await G.aiChooseMove(); const k=c.x+','+c.y; out[k]=(out[k]||0)+1; } return out; }
(async () => {
  // 案例A：39 手局 蓝36
  const rec39=[[0,1],[-1,0],[-2,0],[-1,-1],[-1,1],[-2,1],[0,2],[0,-1],[-2,-1],[-1,-2],[-1,-3],[1,-1],[2,-1],[0,-2],[1,-2],[-1,2],[-3,0],[-3,-1],[-2,-2],[-2,-3],[1,0],[-2,2],[-3,2],[-1,-4],[-4,0],[-5,0],[-4,-1],[-6,0],[-4,-2],[-4,-3],[0,3],[0,4],[-1,3],[-5,-1],[-5,-2]];
  console.log('案例A 39手局 蓝36 分布(hard):');
  console.log('  旧: '+JSON.stringify(await dist(OLD,35,rec39,5)));
  console.log('  新: '+JSON.stringify(await dist(NEW,35,rec39,5)));
  // 案例B：27手局 蓝24(hard 表现力有限仍跑)
  const rec27=[[0,1],[-1,0],[-1,1],[-2,1],[0,-1],[-2,0],[1,0],[-2,-1],[-2,-2],[-1,-1],[-1,-2],[-2,-3],[0,-2],[1,-2],[2,0],[2,1],[1,-1],[-1,-3],[2,-1],[3,-1],[0,-3],[0,-4],[1,-3]];
  console.log('案例B 27手局 蓝24 分布(hard):');
  console.log('  旧: '+JSON.stringify(await dist(OLD,23,rec27,5)));
  console.log('  新: '+JSON.stringify(await dist(NEW,23,rec27,5)));
  // 单元：威胁链 search 能力（合成局面：红 x+y=1 三连 (0,1)(1,0)(2,-1) + (3,-2) 待垫；蓝可救）
  {
    const G=mkEnv(NEW); const P1=G.P1,P2=G.P2,K=G.K;
    // 构造：红竖 x=2: (2,0)(2,-1)(2,-2)三连, (2,-3)缺口已被(1,-3)红垫→ 红下一步杀
    const occ=new Map(); occ.set(K(0,0),G.BLOCK);
    [[0,1],[2,0],[2,-1],[2,-2],[1,-3]].forEach(([x,y])=>occ.set(K(x,y),P1));
    [[-1,0],[2,1],[1,-2],[-1,-2]].forEach(([x,y])=>occ.set(K(x,y),P2));
    G.occ=occ;
    G.state.turn=P2; G.state.phase='idle'; G.state.diff='hard';
    const v = G.threatNega ? G.threatNega(P1, P2, 6, -1e8, 1e8) : null;
    console.log('  [单元] 红先手威胁链值=' + (v===null?'(旧版无此函数)':v) + '（≈1e7 = 红有强制杀）');
    ok(v!==null && v >= 1e7 - 10, '强制链：先手能发现一步连杀');
  }
  // 性能与自对弈（新版 hard）
  {
    const G=mkEnv(NEW); const P1=G.P1,P2=G.P2,K=G.K;
    const o=new Map(); o.set(K(0,0),G.BLOCK); G.occ=o;
    Object.assign(G.state,{mode:'mm',phase:'idle',turn:P1,moveCount:0,winner:0,diff:'hard'});
    let n=0,tSlow=0,tot=0, fwHit=0;
    while(n<400){ const t0=Date.now(); const c=await G.aiChooseMove(); if(!c)break;
      const ms=Date.now()-t0; tot+=ms; if(ms>tSlow)tSlow=ms;
      if(G.__forceWin)n++; G.placePiece(c,G.state.turn); drain(G);
      n++; if(G.state.phase==='over')break; }
    const avg = tot/n;
    console.log('  新版 hard 自对弈 '+n+' 手 最慢 '+tSlow+'ms 平均 '+avg.toFixed(0)+'ms');
    ok(n>10&&n<400,'新版 hard 自对弈正常');
    /* 性能预算：随 AI 变强而上调，别按老版本数字卡死。
       实测基线（i7-14650HX / 机器空载 / 困难档 6×depth-7 链 + negamax 12000 节点）：
         平均 755~914ms/步，最坏单步 2880~3067ms。
       平均值是更稳的回归信号；最坏值噪声大，只设一个宽松上限。 */
    ok(avg<1500,'单步平均耗时在 1.5s 内（'+avg.toFixed(0)+'ms）');
    ok(tSlow<4000,'最坏单步耗时在 4s 内（'+tSlow+'ms）');
  }
  console.log('结果：'+pass+' 通过 / '+fail+' 失败'); process.exit(fail?1:0);
})().catch(e => { console.error(e); process.exit(1); });

