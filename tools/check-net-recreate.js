#!/usr/bin/env node
/* ============================================================================
   端到端联机回归：真 server.js + 两个沙箱客户端（一 host 一 guest）

   覆盖用户报的那条：
     「点一键开房后会出现『下轮先手/胜方先/…/准备』，
       而切换到其它模式再切回联机、点开房后就**没有了**」

   做法：起真服务器 → 沙箱里跑真实 index.html 的联机代码 → 灌真定时器
        （game-sandbox 的 setTimeout 是桩、永不触发，轮询只会跑一轮）
        → 第一轮 建房间+加入；再模拟"切走（netLeave）→切回"→第二轮 建房间+加入。

   A/B：`--broken` 会把 `netCreate`/`netDropped` 里的 lastId 复位语句删掉，
        用来确认"没有这条修复就复现"。默认跑修复版。
        ⚠ `--broken` 是**对照组，预期失败（退出码 1）** —— 别把它当 CI 门槛。

   第三段「面板常显」自带复现对照：把 `netRoomEl.style.display = inNet ? '' : 'none'`
   改回旧的 `(inNet && net.connected) ? …`，只开房不加对手时那块就会被隐藏（= 用户描述的"没了"）。

   运行：node tools/check-net-recreate.js [--broken]
   ========================================================================== */
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const { HTML, loadGame } = require('./game-sandbox');

const BROKEN = process.argv.includes('--broken');
const PORT = Number(process.env.G4NET_TEST_PORT || 8792);
const ORIGIN = 'http://127.0.0.1:' + PORT;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const HTML_BROKEN = HTML.replace(/[ \t]*net\.startSeq = 0; net\.lastId = 0;[^\n]*\n/g, '');

function startServer(){
  const p = spawn(process.execPath,
    [path.join(__dirname, '..', 'server', 'server.js'), String(PORT)],
    { stdio: ['ignore', 'ignore', 'ignore'] });
  return p;
}
async function waitServer(ms){
  const t0 = Date.now();
  while (Date.now() - t0 < ms){
    try { const r = await fetch(ORIGIN + '/api/ping'); if (r.ok) return true; } catch (e) {}
    await sleep(120);
  }
  return false;
}

const EXPORTS = 'state,resetGame,net,netCreate,netJoin,netLeave,netDropped';
const el = (G, id) => G.__sb.__els.get(id);

function mkClient(htmlSrc){
  const G = loadGame(htmlSrc, EXPORTS, {
    expose: true,
    fetch: (url, opt) => fetch(ORIGIN + url, opt),
  });
  /* 灌真定时器：否则 pollLoop 在第一次 netSleep 上永久挂起 */
  G.__sb.setTimeout = setTimeout;
  G.__sb.clearTimeout = clearTimeout;
  G.__sb.setInterval = setInterval;
  G.__sb.clearInterval = clearInterval;
  G.state.mode = 'net';                 // 联机模式（否则 refreshPrep 会被 mode 检查挡掉）
  return G;
}

async function waitFor(pred, ms){
  const t0 = Date.now();
  while (Date.now() - t0 < ms){ if (pred()) return true; await sleep(40); }
  return false;
}

/* ---------- 面板常显：只开房、**不加对手**，看房规/准备区是否出现 ---------- */
async function panelScenario(htmlSrc){
  const A = mkClient(htmlSrc);
  await A.netCreate();                 // 开房，但没有第二个人加入
  await sleep(900);
  return {
    connected: A.net.connected,
    lobbyShown: el(A, 'netLobby').style.display,
    roomShown:  el(A, 'netRoom').style.display,
    prepShown:  el(A, 'netPrep').style.display,
  };
}

async function round(A, B, tag){
  await A.netCreate();
  if (!A.net.room){
    /* 房间内 lastId 复位被删掉时，第二次 create 仍会成功——先看返回 */
    ok(false, tag + '：A 建房间返回了房间码');
    return null;
  }
  el(B, 'netCode').value = A.net.room;
  await B.netJoin();
  const hostEntered = await waitFor(() => A.net.connected === true, 6000);
  ok(hostEntered, tag + '：host 收到 sys/lobby 并进入房间');
  ok(el(A, 'netRoom').style.display === '', tag + '：host 端 #netRoom 可见（房规/准备面板）');
  ok(el(A, 'netPrep').style.display === 'flex', tag + '：host 端 #netPrep 可见');
  return A.net.room;
}

(async () => {
  const html = BROKEN ? HTML_BROKEN : HTML;
  if (BROKEN && html === HTML){ console.log('对照组替换失败（源码变了？）'); process.exit(2); }

  console.log((BROKEN ? '[对照组 · 已移除 lastId 复位]' : '[修复版]') + ' 端到端联机复现');
  const srv = startServer();
  if (!await waitServer(8000)){ srv.kill(); console.error('服务器未就绪'); process.exit(2); }

  try {
    const A = mkClient(html), B = mkClient(html);
    const r1 = await round(A, B, '第一轮');
    /* 模拟"切到其它模式再切回联机"：切走 = netLeave(true)（模式切换里的同一调用） */
    A.netLeave(true); B.netLeave(true);
    await sleep(200);
    const r2 = await round(A, B, '第二轮（切走再切回后）');
    ok(!!r1 && !!r2 && r1 !== r2, '两次开房拿到不同房间码');

    /* ---------- 面板常显：先复现用户描述，再证明修复后效果不同 ---------- */
    console.log('\n[面板常显] 用户描述："点开房后出现那块房规/准备，切走再切回、开房后就没有了"');
    const HTML_PRE = html.replace(
      /netRoomEl\.style\.display\s*=\s*inNet\s*\?\s*''\s*:\s*'none';/,
      "netRoomEl.style.display = (inNet && net.connected) ? '' : 'none';");
    ok(HTML_PRE !== html, '对照组：把"常显"改回旧的"仅已连接时显示"');

    const PRE = await panelScenario(HTML_PRE);
    ok(PRE.connected === false, '（前提）只开房、对手未加入 ⇒ 未连接');
    ok(PRE.roomShown === 'none', '复现：此状态下 #netRoom 被隐藏（= "那块没了"）');

    const FIX = await panelScenario(html);
    ok(FIX.roomShown === '', '修复后：#netRoom 常显（display=""）');
    ok(FIX.prepShown === 'flex', '修复后：#netPrep 常显（display="flex"）');
    ok(PRE.roomShown !== FIX.roomShown, '复现效果与修复后**不同**');
  } catch (e){
    fail++; console.error('  ✗ 异常：', e && e.message);
  } finally {
    srv.kill();
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
