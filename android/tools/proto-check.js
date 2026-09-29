#!/usr/bin/env node
/* ==========================================================================
   联机协议一致性驱动
   --------------------------------------------------------------------------
   对目标服务器执行同一套「房间全生命周期」操作序列并输出关键事件，
   用于对比 node 服务器（四子棋服务器.js）与 APK 内置服务器行为是否一致。

   用法：
     node tools/proto-check.js http://127.0.0.1:18765      # 打某个服务器
     node tools/proto-check.js http://192.168.1.5:8765     # 打手机内置服务器
   断言失败时 exit 1。
   ========================================================================== */
'use strict';
const base = (process.argv[2] || 'http://127.0.0.1:18765').replace(/\/$/, '');
let pass = 0, fail = 0;
const events = [];

async function jget(p) {
  const r = await fetch(base + p);
  return { status: r.status, body: await r.json() };
}
async function jpost(p, obj) {
  const r = await fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  });
  return { status: r.status, body: await r.json() };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ok(name, cond, detail) {
  events.push(`${name}: ${cond ? 'PASS' : 'FAIL'}` + (detail ? ' ' + detail : ''));
  if (cond) pass++; else { fail++; console.log('  FAIL ' + name + (detail ? ' · ' + detail : '')); }
}

(async () => {
  console.log('协议检查 @ ' + base);

  /* 1. ping */
  const ping = await fetch(base + '/api/ping');
  ok('ping 返回 pong', ping.ok && (await ping.text()) === 'pong', 'status=' + ping.status);

  /* 2. 创建房间 */
  const c = await jget('/api/create');
  ok('create 返回房间', c.status === 200 && /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/.test(c.body.room) && !!c.body.token,
     JSON.stringify(c.body));

  const room = c.body.room, hostTok = c.body.token;

  /* 3. 加入不存在的房间 */
  const bad = await jget('/api/join?room=ZZZZ');
  ok('join 错误房间 → 404+err', bad.status === 404 && !!bad.body.err, 'status=' + bad.status);

  /* 4. guest 加入 */
  const g = await jget('/api/join?room=' + room);
  ok('guest 加入成功', g.status === 200 && !!g.body.token && g.body.seq >= 1,
     'seq=' + g.body.seq);
  const guestTok = g.body.token;

  /* 5. 第二人再加入 → 409（guest 在线） */
  const full = await jget('/api/join?room=' + room);
  ok('占位已满 → 409', full.status === 409 && !!full.body.err, 'status=' + full.status);

  /* 6. 非法身份发消息 → 403 */
  const badTok = await jpost('/api/send', { room, token: 'nope', msg: { type: 'x' } });
  ok('非法身份 → 403', badTok.status === 403, 'status=' + badTok.status);

  /* 7. 双 ready → sys/start 仲裁（firstOwner 取 host 提供的） */
  await jpost('/api/send', { room, token: guestTok, msg: { type: 'ready', on: true } });
  await jpost('/api/send', { room, token: hostTok, msg: { type: 'ready', on: true, firstOwner: 2 } });
  await sleep(60);

  const gh = await jget(`/api/poll?room=${room}&token=${guestTok}&since=${g.body.seq}`);
  const hh = await jget(`/api/poll?room=${room}&token=${hostTok}&since=${c.body ? 0 : 0}`);
  const gMsgs = gh.body.msgs || [];
  const startMsg = gMsgs.find(m => m.type === 'sys' && m.event === 'start');
  ok('双方 ready 后推 sys/start(firstOwner=2)', !!startMsg && startMsg.firstOwner === 2,
     JSON.stringify(gMsgs.map(m => m.type + (m.event ? ':' + m.event : ''))));

  /* 8. host 落子 move → guest 能收到 */
  const hSeqNow = (await jget(`/api/poll?room=${room}&token=${hostTok}&since=0`)).body.msgs
    .reduce((m, x) => Math.max(m, x.id), 0);
  const mv = { type: 'move', n: 1, drop: { x: 3, y: 4 }, land: { x: 3, y: 4 } };
  await jpost('/api/send', { room, token: hostTok, msg: mv });
  await sleep(60);
  const after = await jget(`/api/poll?room=${room}&token=${guestTok}&since=${gh.body.msgs.length ? Math.max(...gMsgs.map(x => x.id)) : hSeqNow}`);
  const gotMove = (after.body.msgs || []).find(m => m.type === 'move' && m.drop && m.drop.x === 3);
  ok('host 的 move 能同步到 guest', !!gotMove, JSON.stringify((after.body.msgs || []).map(m => m.type)));

  /* 9. 消息广播不含自己（host poll 不应看到自己的 move） */
  const hself = await jget(`/api/poll?room=${room}&token=${hostTok}&since=0`);
  const selfMove = (hself.body.msgs || []).find(m => m.type === 'move' && m.from === 'host');
  ok('host 拉不到自己发出的 move', !selfMove);

  /* 10. bye 释放席位 → opp=none */
  await jpost('/api/send', { room, token: guestTok, msg: { type: 'bye' } });
  await sleep(60);
  const lastPoll = await jget(`/api/poll?room=${room}&token=${hostTok}&since=0`);
  ok('bye 后对手状态 none', lastPoll.body.opp === 'none', 'opp=' + lastPoll.body.opp);

  /* 11. 死亡房间检查：乱 token poll → dead */
  const dead = await jget(`/api/poll?room=${room}&token=zzz&since=0`);
  ok('无效 token poll → dead', dead.body.dead === true);

  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  console.log('事件序列:');
  for (const e of events) console.log('  ' + e);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('出错', e); process.exit(1); });
