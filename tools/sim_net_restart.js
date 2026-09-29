#!/usr/bin/env node
/* 仿真验证：联机「再来一局」先手仲裁（host 唯一权威）在消息交叉下双方收敛一致
   逻辑与 index.html 的 userReset/netHandle 'restart' 逐条对齐，非完整游戏模拟。 */
'use strict';

const P1=1, P2=2;
function mkSide(role, rulesWinner){ // role 'host'|'guest'
  return {
    side: role, winner: rulesWinner||0,
    netStartSeq: 0, awaitRestart: false,
    moveCount: 0,            // 新局=0；模拟中开局后不放子，恒 0
    opened: [],              // 已应用的开局 firstOwner 记录（最后一次生效）
    log: [],
  };
}
/* 与 calcFirstByRule 一致 */
function calcFirstByRule(bySide, winner, r){
  const my = bySide==='host'?P1:P2;
  if (r==='resigner') return my===P1?P2:P1;
  if (r==='winner') return winner||P1;
  if (r==='loser') return winner ? (winner===P1?P2:P1) : P1;
  return Math.random()<0.5?P1:P2;      // random
}
/* guest/host 各自收到的消息队列（模拟任意到达顺序） */
function deliver(dst, msg, rndRules){
  const s=dst;
  // netHandle 'restart'
  if (s.moveCount>0) return;
  if (msg.author==='host'){
    if (s.side==='guest'){
      s.awaitRestart=false;
      s.opened.push(msg.firstOwner||P1);
      console.error('  [guest] applied host restart firstOwner='+(msg.firstOwner||P1));
    }
    // host 不会收到自己消息（服务器不回发）
  } else if (msg.author==='guest' && s.side==='host'){
    console.error('  [host] got guest req seq='+msg.seq+' firstOwner='+(msg.firstOwner||P1));
    if (msg.seq<=s.netStartSeq && s.netStartSeq>0){
      // host 已开局：重发自己的权威 restart（模拟给 guest 投递）
      const own = s.opened.length ? s.opened[s.opened.length-1] : (calcFirstByRule(s.side, s.winner, rndRules));
      pending.push({ to: other(s.side), msg:{ type:'restart', author:'host', seq:s.netStartSeq, firstOwner:own } });
    } else {
      const first = msg.firstOwner||P1;
      s.netStartSeq = msg.seq||1;
      pending.push({ to: other(s.side), msg:{ type:'restart', author:'host', seq:s.netStartSeq, firstOwner:first } });
      s.opened.push(first);
      console.error('  [host] adopt & echo firstOwner='+first);
    }
  } else if (msg.author==='host' && s.side==='host'){ console.error('  [host] got own echo??'); }
}
let pending=[];
function other(x){ return x==='host'?'guest':'host'; }
const peers = { host:null, guest:null };
function press(role, r){
  const s=peers[role];
  // userReset net branch
  if (role==='host'){
    const first=calcFirstByRule('host', s.winner, r);
    s.netStartSeq++;
    pending.push({ to: other(role), msg:{ type:'restart', author:'host', seq:s.netStartSeq, firstOwner:first } });
    s.opened.push(first);            // host 本地 newGame(first)
  } else {
    if (s.awaitRestart) return;      // 重复请求守卫
    s.awaitRestart=true;
    const first=calcFirstByRule('guest', s.winner, r);
    s.netStartSeq++;
    pending.push({ to: other(role), msg:{ type:'restart', author:'guest', seq:s.netStartSeq, firstOwner:first } });
  }
}
function run(title, r, winner, script){   // script: array of ()=>press(...) initial; then drain pending until empty
  pending=[]; peers.host=mkSide('host', winner); peers.guest=mkSide('guest', winner);
  for (const f of script) f(r);
  let guard=0;
  while (pending.length && guard++<50){ const job=pending.shift(); console.error('    job -> '+job.to+' author='+job.msg.author+' seq='+job.msg.seq+' first='+(job.msg.firstOwner||'?')); deliver(peers[job.to], job.msg, r); }
  const ho = peers.host.opened.length?peers.host.opened[peers.host.opened.length-1]:null;
  const go = peers.guest.opened.length?peers.guest.opened[peers.guest.opened.length-1]:null;
  const ok = ho!==null && ho===go;
  console.log((ok?'PASS ':'FAIL ') + title + '  host=' + ho + ' guest=' + go);
  if(!ok) process.exitCode = 1;
  return ok;
}

const W=0, WIN_RED=P1;   // winner=红
const rules=['resigner','loser','winner','random'];
for (const r of rules){
  // 决定性规则下用固定 winner 模拟；random 用 RNG
  const win = (r==='winner') ? WIN_RED : (r==='loser' ? WIN_RED : W);
  run(r+': 仅host重开', r, win, [()=>press('host',r)]);
  run(r+': 仅guest重开', r, win, [()=>press('guest',r)]);
  run(r+': 同时重开-先投host', r, win, [()=>press('host',r), ()=>press('guest',r)]);
  run(r+': 同时重开-先投guest', r, win, [()=>press('guest',r), ()=>press('host',r)]);
  run(r+': guest双击连点', r, win, [()=>press('guest',r), ()=>press('guest',r), ()=>press('host',r)]);
}
console.log('done');
