#!/usr/bin/env node
/* ==========================================================================
   重力四子棋 · 局域网联机服务器（零依赖，仅需 Node.js ≥ 18）
   --------------------------------------------------------------------------
   启动：  node server/server.js [端口]        （默认端口 8765）
   然后：  本机或局域网内其它设备用浏览器打开控制台打印的地址即可。
   职责：  ① 托管游戏页面（打开即玩）
           ② 房间配对（创建 / 加入）与消息中转（短轮询）
   协议：  游戏物理由双方各自本地确定性演算，网络上只同步
           「投子点 + 落定确认」，落点不一致时以先落子方为准（correction）。
   ========================================================================== */
'use strict';
const http = require('http');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const PORT   = Number(process.argv[2]) || 8765;
const HTML_FILE = path.join(__dirname, '..', 'index.html');
// guest 位被占时的「离线判定」时长：超过该时长无任何请求的 guest 可被新玩家顶替
const GUEST_TIMEOUT = Number(process.env.G4NET_GUEST_TIMEOUT) || 20000;

let HTML;
try { HTML = fs.readFileSync(HTML_FILE); }
catch (e) { console.error('未找到游戏文件: ' + HTML_FILE); process.exit(1); }

/* ---------------- 房间 ---------------- */
const rooms = new Map();   // code -> {host, guest, msgs, seq, created}
// host/guest: {token, touch, name}   msgs: [{id, from:'host'|'guest'|'sys', ...}]
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';   // 去掉易混淆的 0O1IL
function makeCode() {
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.random() * CODE_CHARS.length | 0]; }
  while (rooms.has(c));
  return c;
}
function makeToken() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
function roomOf(code) { return rooms.get(String(code || '').trim().toUpperCase()); }

/* 过期清理：双方 65 秒无任何请求则回收房间 */
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    const dead = s => !s || now - s.touch > 65000;
    if (dead(r.host) && dead(r.guest)) rooms.delete(code);
  }
}, 20000).unref();

/* ---------------- HTTP ---------------- */
function json(res, obj, code) {
  const body = JSON.stringify(obj);
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function sideOf(r, token) {
  if (r.host  && r.host.token  === token) return 'host';
  if (r.guest && r.guest.token === token) return 'guest';
  return null;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  /* 托管游戏页面 */
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(HTML);
  }
  if (req.method === 'GET' && p === '/api/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('pong');
  }

  /* 创建房间 */
  if (req.method === 'GET' && p === '/api/create') {
    const code = makeCode(), token = makeToken();
    rooms.set(code, { host: { token, touch: Date.now() }, guest: null, msgs: [], seq: 0, created: Date.now(),
                      hostReady:false, guestReady:false, firstOwner:undefined });
    return json(res, { room: code, token });
  }

  /* 加入房间（?token= 可选：匹配现有 guest 即为断线重连，不重复广播 lobby）
     guest 位被占但已离线（超过 GUEST_TIMEOUT 无请求）→ 允许新玩家顶替 */
  if (req.method === 'GET' && p === '/api/join') {
    const r = roomOf(u.searchParams.get('room'));
    if (!r) return json(res, { err: '房间不存在' }, 404);
    const tok = u.searchParams.get('token') || '';
    if (tok && r.guest && r.guest.token === tok) {          // 重连
      r.guest.touch = Date.now();
      return json(res, { token: tok, seq: r.seq });
    }
    if (r.guest) {
      if (Date.now() - r.guest.touch > GUEST_TIMEOUT) r.guest = null;   // 顶替离线者
      else return json(res, { err: '房间已满（对方在线中）' }, 409);
    }
    const token = makeToken();
    r.guest = { token, touch: Date.now() };
    r.hostReady = false; r.guestReady = false;             // 新对手到位：双方重新准备
    r.msgs.push({ id: ++r.seq, from: 'sys', type: 'sys', event: 'lobby' });
    return json(res, { token, seq: r.seq });   // seq 之前的消息对新成员是历史，勿回放
  }

  /* 发送消息 */
  if (req.method === 'POST' && p === '/api/send') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      let j; try { j = JSON.parse(body); } catch { return json(res, { err: 'bad json' }, 400); }
      const r = roomOf(j.room);
      if (!r) return json(res, { err: '房间不存在' }, 404);
      const side = sideOf(r, j.token || '');
      if (!side) return json(res, { err: '身份无效' }, 403);
      if (j.msg && j.msg.type === 'bye'){                 // 明确离开：立即释放席位
        r.msgs.push({ id: ++r.seq, from: side, type: 'bye' });
        r[side] = null;
        return json(res, { ok: true });
      }
      r[side].touch = Date.now();
      /* 准备仲裁：双方都点了准备 → 服务器推送 start（带 host 提供的首局先手） */
      if (j.msg && j.msg.type === 'ready'){
        if (j.msg.on){
          r[side + 'Ready'] = true;
          if (side === 'host' && j.msg.firstOwner) r.firstOwner = j.msg.firstOwner;
        } else {
          r[side + 'Ready'] = false;
        }
        r.msgs.push({ id: ++r.seq, from: side, type: 'ready', on: !!j.msg.on });
        if (r.hostReady && r.guestReady){
          r.hostReady = false; r.guestReady = false;
          const fo = r.firstOwner || 1;
          r.firstOwner = undefined;
          r.msgs.push({ id: ++r.seq, from: 'sys', type: 'sys', event: 'start', firstOwner: fo });
        }
        return json(res, { ok: true });
      }
      const m = Object.assign({ id: ++r.seq, from: side }, j.msg || {});
      r.msgs.push(m);
      if (r.msgs.length > 500) r.msgs.splice(0, r.msgs.length - 500);   // 防膨胀
      json(res, { ok: true, id: m.id });
    });
    return;
  }

  /* 拉取消息（since 之后的、非自己发出的）；附带对手在线状态 */
  if (req.method === 'GET' && p === '/api/poll') {
    const r = roomOf(u.searchParams.get('room'));
    const token = u.searchParams.get('token') || '';
    const since = Number(u.searchParams.get('since')) || 0;
    if (!r) return json(res, { dead: true });
    const side = sideOf(r, token);
    if (!side) return json(res, { dead: true });
    r[side].touch = Date.now();
    const oppSide = side === 'host' ? 'guest' : 'host';
    const opp = !r[oppSide] ? 'none' : (Date.now() - r[oppSide].touch > 15000 ? 'offline' : 'online');
    const msgs = r.msgs.filter(m => m.id > since && m.from !== side);
    return json(res, { msgs, opp });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
});

server.listen(PORT, () => {
  const nets = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const ni of list || [])
      if (ni.family === 'IPv4' && !ni.internal) nets.push(ni.address);
  console.log('==============================================');
  console.log('  重力四子棋 · 局域网联机服务器已启动');
  console.log('  本机游玩:   http://localhost:' + PORT);
  for (const ip of nets) console.log('  局域网游玩: http://' + ip + ':' + PORT);
  if (!nets.length) console.log('  （未检测到局域网网卡，仅本机可访问）');
  console.log('  关闭此窗口即停止联机服务');
  console.log('==============================================');
});
