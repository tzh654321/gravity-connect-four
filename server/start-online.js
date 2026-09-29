#!/usr/bin/env node
/* ==========================================================================
   重力四子棋 · 一键开房
   --------------------------------------------------------------------------
   双击 / 运行：  node start-online.js [端口]        （默认 8765）
   功能：① 服务器没跑就自动启动
        ② 创建房间
        ③ 把「邀请链接」复制到剪贴板（发给对方，打开即加入）
        ④ 自动打开浏览器进入自己的对局页（等待对手）
   关闭：Ctrl+C（房间与服务器一并退出）
   测试/静默：加 --no-open 跳过自动打开浏览器
   ========================================================================== */
'use strict';
const { spawn, execSync } = require('child_process');
const os   = require('os');
const path = require('path');

const HERE    = __dirname;
const NO_OPEN = process.argv.includes('--no-open');
let   PORT    = Number(process.argv[2]) || 8765;

const ping  = async p => { try { const r = await fetch('http://127.0.0.1:' + p + '/api/ping'); return r.ok; } catch { return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function lanIP(){
  for (const list of Object.values(os.networkInterfaces()))
    for (const ni of list || [])
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
  return 'localhost';
}

(async () => {
  /* 1. 确保服务器在跑（端口被其它程序占用时自动顺延） */
  let srv = null, stopping = false;
  for (let tries = 0; tries < 10 && !(await ping(PORT)); tries++){
    if (srv) { srv.kill(); srv = null; console.log('端口 ' + PORT + ' 不可用，尝试 ' + (PORT + 1)); PORT++; }
    srv = spawn(process.execPath, [path.join(HERE, 'server.js'), String(PORT)],
                { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', d => process.stdout.write(d));
    srv.stderr.on('data', d => process.stderr.write('[服务器] ' + d));
    await sleep(600);
  }
  if (!(await ping(PORT))) { console.error('无法启动或连接服务器'); process.exit(1); }
  if (srv) console.log('[服务器已启动 · 端口 ' + PORT + ']');
  else     console.log('[服务器已在运行 · 端口 ' + PORT + ']');

  const cleanup = () => { if (srv) try { srv.kill(); } catch {} };
  process.on('exit', cleanup);
  process.on('SIGINT',  () => { stopping = true; cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { stopping = true; cleanup(); process.exit(0); });

  /* 2. 创建房间 */
  const d = await (await fetch('http://127.0.0.1:' + PORT + '/api/create')).json();

  /* 3. 组装链接并复制邀请链接 */
  const base    = 'http://' + lanIP() + ':' + PORT;
  const invite  = base + '/?room=' + d.room;                        // 发给对方：打开即自动加入
  const mine    = base + '/?room=' + d.room + '&key=' + d.token;    // 自己打开：房主直通等待
  let copied = true;
  try { execSync('clip', { input: invite }); }
  catch {
    try { execSync('powershell -NoProfile -Command "Set-Clipboard"', { input: invite }); }
    catch { copied = false; }
  }

  /* 4. 打开自己的对局页
     打开 URL 的三个坑（都踩过）：
       ① 裸传 URL 给 `cmd /c start`：cmd 把 & 当命令分隔符，URL 被截断成无 key 的邀请链接，
          房主会把自己变成 guest 占位，对方加入就报「房间已满」。
       ② explorer：会把带查询串的 URL 当路径，结果是打开文件夹而不是浏览器。
       ③ 首选 rundll32 url.dll,FileProtocolHandler：不经 cmd 解析（& 安全），
          直接走系统 URL 协议处理器 → 默认浏览器。下面按顺序兜底。 */
  if (NO_OPEN) {
    console.log('[--no-open] 跳过打开浏览器，自己打开: ' + mine);
  } else {
    const tries = [
      () => spawn('rundll32', ['url.dll,FileProtocolHandler', mine],
                  { detached: true, stdio: 'ignore' }),
      () => spawn('cmd', ['/c', 'start', '', '"' + mine + '"'],
                  { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }),
      () => spawn('powershell', ['-NoProfile', '-Command', 'Start-Process', mine],
                  { detached: true, stdio: 'ignore' })
    ];
    let opened = false;
    for (const run of tries){
      try { run().unref(); opened = true; break; }
      catch { /* 换下一种方式 */ }
    }
    if (!opened) console.log('自动打开浏览器失败，请手动打开: ' + mine);
  }

  console.log('==============================================');
  console.log('  房间码:  ' + d.room);
  console.log('  邀请链接（' + (copied ? '已复制到剪贴板' : '自动复制失败，请手动复制') + '）:');
  console.log('  ' + invite);
  console.log('  把链接发给对方，打开即自动加入');
  console.log('  已为你打开自己的对局页，等待对手…');
  console.log('  按 Ctrl+C 关闭房间和服务器');
  console.log('==============================================');
  setInterval(() => {}, 1 << 30);   // 保活
})().catch(e => { console.error('出错: ' + (e && e.message || e)); process.exit(1); });
