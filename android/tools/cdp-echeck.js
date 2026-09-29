#!/usr/bin/env node
/* ==========================================================================
   E 组联机（远端代理 = 手机加入 PC 房间）· WebView CDP 实测
   --------------------------------------------------------------------------
   通过 Chrome DevTools Protocol 直接驱动手机 WebView，无需读截图：
     ① 把手机联机模式切到「连接其他服务器」，base=127.0.0.1:8766
        （adb reverse 已把设备 8766 隧道到 PC 的 8765）
     ② 手机侧 fetch('/api/ping') 应得到 PC 服务器返回的 pong
     ③ 手机侧 /api/create 在 PC 服务器建房间，PC 侧 join 该房间验证真实存在
     ④ PC 侧建房间 roomB，手机侧 join roomB 验证「手机加入 PC 房间」
     ⑤ 切回本机开房，ping 应回到手机内置服务器返回 pong
   任何一项失败 exit 1。
   ========================================================================== */
'use strict';
const http = require('http');
const WS = globalThis.WebSocket;

const FORWARD_PORT = 9222;          // adb forward tcp:9222 -> webview_devtools_remote
const PC_BASE = 'http://127.0.0.1:8765';   // PC 服务器（PC 侧交叉验证用）
// 手机侧配置的远端地址：默认走 adb reverse 隧道；可用 G4_E_BASE 指定真实局域网地址
const REMOTE_BASE = process.env.G4_E_BASE || '127.0.0.1:8766';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (detail ? ' · ' + detail : ''));
  cond ? pass++ : fail++;
}

/* ---------- CDP 客户端 ---------- */
function getJSON(url) {
  return new Promise((res, rej) => {
    http.get(url, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const targets = await getJSON(`http://127.0.0.1:${FORWARD_PORT}/json`);
  const page = (targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl) ||
                targets.find(t => t.webSocketDebuggerUrl));
  if (!page) { console.error('找不到 WebView 调试目标'); process.exit(1); }

  const ws = new WS(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  ws.addEventListener('error', ev => { console.error('WS error', ev.message || ev); });
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable' }));

  function evalExpr(expr, awaitPromise = true) {
    return new Promise((res, rej) => {
      const my = ++id;
      pending.set(my, m => {
        if (m.error) return rej(new Error(JSON.stringify(m.error)));
        res(m.result);
      });
      ws.send(JSON.stringify({
        id: my, method: 'Runtime.evaluate',
        params: { expression: expr, awaitPromise, returnByValue: true,
                  timeout: awaitPromise ? 15000 : 3000 }
      }));
    });
  }
  async function evalText(expr) {
    const r = await evalExpr(expr);
    return r && r.result ? r.result.value : undefined;
  }
  async function evalJSON(expr) {
    const t = await evalText(expr);
    try { return JSON.parse(t); } catch { return t; }
  }

  console.log('\n[E组] 远端代理联机测试 @ ' + new Date().toISOString());

  /* ① 切到远端模式 */
  await evalText(`G4Native.setConfig(${JSON.stringify(JSON.stringify({ local: false, base: REMOTE_BASE }))})`);
  await sleep(1200);   // 等 applySettings 完成（可能停本地服务 / 切路由）

  /* ② 手机 ping → 应来自 PC 服务器 */
  const ping = await evalText(`(async()=>{const r=await fetch('/api/ping');return await r.text();})()`);
  ok('手机 ping 经远端到达 PC 服务器 (pong)', ping === 'pong', 'got=' + JSON.stringify(ping));

  /* ③ 手机在 PC 服务器建房间 */
  const created = await evalJSON(`(async()=>{const r=await fetch('/api/create');return await r.text();})()`);
  ok('手机 /api/create 返回房间', created && /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/.test(created.room),
     JSON.stringify(created));
  const roomA = created && created.room;

  /* ④ PC 侧加入该房间，验证真实存在于 PC 服务器 */
  let pcJoin = null;
  try {
    const r = await fetch(`${PC_BASE}/api/join?room=${roomA}`);
    pcJoin = { status: r.status, body: await r.json() };
  } catch (e) { pcJoin = { status: 0, err: String(e) }; }
  ok('PC 侧能加入手机创建的房间 (200)', pcJoin.status === 200 && !!pcJoin.body.token,
     JSON.stringify(pcJoin));

  /* ⑤ PC 侧建房间 roomB，手机侧加入 → 「手机加入 PC 房间」 */
  const pcCreate = await (await fetch(`${PC_BASE}/api/create`)).json();
  const roomB = pcCreate.room;
  ok('PC 侧创建 roomB', !!roomB, JSON.stringify(pcCreate));
  const phoneJoin = await evalJSON(`(async()=>{const r=await fetch('/api/join?room=${roomB}');return await r.text();})()`);
  ok('手机加入 PC 房间 roomB 成功', phoneJoin && !!phoneJoin.token && phoneJoin.seq >= 1,
     JSON.stringify(phoneJoin));

  /* ⑥ 确认配置确实处于远端模式 */
  const cfg = await evalJSON(`G4Native.getConfig()`);
  const expBase = /^https?:\/\//.test(REMOTE_BASE)
    ? REMOTE_BASE.replace(/\/+$/, '') : 'http://' + REMOTE_BASE;
  ok('配置 local=false 且 base 规范化', cfg && cfg.local === false &&
     (cfg.base || '') === expBase, JSON.stringify(cfg));

  /* ⑦ 切回本机开房，ping 应回到内置服务器 */
  await evalText(`G4Native.setConfig(${JSON.stringify(JSON.stringify({ local: true }))})`);
  await sleep(1200);
  const ping2 = await evalText(`(async()=>{const r=await fetch('/api/ping');return await r.text();})()`);
  ok('切回本机开房后 ping 回到内置服务器 (pong)', ping2 === 'pong', 'got=' + JSON.stringify(ping2));

  const cfg2 = await evalJSON(`G4Native.getConfig()`);
  ok('配置恢复 local=true', cfg2 && cfg2.local === true, JSON.stringify(cfg2));

  /* 收尾：把手机改回默认本机模式（保持出厂状态） */
  await evalText(`G4Native.setConfig(${JSON.stringify(JSON.stringify({ local: true, base: '' }))})`);

  ws.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('出错', e); process.exit(1); });
