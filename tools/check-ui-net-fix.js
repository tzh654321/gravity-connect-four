#!/usr/bin/env node
/* 验收：本轮 UI / 联机修复
   ① 切到"机器先手"模式后**不自动落子**，主按钮显示「开始对局」；点击后才启动 AI 并变回「重新开局」
   ② 选项区（落点预测~危险提示）双列布局 + 窄屏单列回退
   ③ nativeServer 桥：向 Android 发 {server:true/false}
   ④ 联机开房 lastId/startSeq 复位（含"残留水位"端到端 A/B 复现）
   ⑤ Android 侧：启动不再自动起服务器（文本断言）

   运行：node tools/check-ui-net-fix.js
   退出码：0 = 全绿；1 = 有失败
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { HTML, loadGame } = require('./game-sandbox');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; console.log('  \u2717 ' + m); } };
const eq = (a, b, m) => ok(Object.is(a, b), m + '   [got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ']');
const flush = async (n) => { n = n || 30; for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

const EXPORTS = 'state,resetGame,userReset,maybeAI,updateUI,net,netCreate,netDropped,netLeave,aiOpens,isHuman,nativeServer';
const btnText = G => G.__sb.__els.get('btnNew').textContent;

/* ------------------------------------------------------------------ ① */
function testMachineFirst(){
  console.log('\n[1] 机器先手：切换后不落子 + 按钮文案');
  const G = loadGame(null, EXPORTS, { expose: true });

  // 切到 机·机：停在"待开始"
  G.state.mode = 'mm';
  G.resetGame({ awaitStart: true });
  eq(G.state.awaitStart, true, 'mm: 切模式后 awaitStart=true');
  eq(btnText(G), '开始对局', 'mm: 主按钮文案 = 开始对局');
  eq(G.state.thinking, false, 'mm: 未进入思考');
  eq(G.state.moveCount, 0, 'mm: 未落子');
  eq(G.state.phase, 'idle', 'mm: 相位 idle');

  // 期间任何触发都不应落子
  G.maybeAI();
  eq(G.state.thinking, false, 'mm: maybeAI() 在待开始时是空操作');

  // 点「开始对局」
  G.userReset();
  eq(G.state.awaitStart, false, 'mm: 点击后 awaitStart 清除');
  eq(btnText(G), '重新开局', 'mm: 点击后按钮文案 = 重新开局');
  eq(G.state.thinking, true, 'mm: 点击后 AI 开始思考');

  // 机·人（机器先手）同样成立
  const G2 = loadGame(null, EXPORTS, { expose: true });
  G2.state.mode = 'mh';
  G2.resetGame({ awaitStart: true });
  eq(G2.state.awaitStart, true, 'mh: 切模式后 awaitStart=true');
  eq(btnText(G2), '开始对局', 'mh: 主按钮文案 = 开始对局');
  eq(G2.state.moveCount, 0, 'mh: 未落子');

  // 人先的模式 / 联机：不该出现「开始对局」
  const G3 = loadGame(null, EXPORTS, { expose: true });
  for (const m of ['hh', 'hm', 'net']){
    G3.state.mode = m;
    G3.resetGame({ awaitStart: true });
    eq(G3.state.awaitStart, false, m + ': awaitStart 被忽略');
    eq(btnText(G3), '重新开局', m + ': 主按钮文案 = 重新开局');
  }

  // aiOpens 口径
  const G4 = loadGame(null, EXPORTS, { expose: true });
  const expect = { mm:true, mh:true, hh:false, hm:false, net:false };
  for (const m of Object.keys(expect)){ G4.state.mode = m; eq(G4.aiOpens(), expect[m], 'aiOpens(' + m + ')'); }

  // 普通重开（不带 awaitStart）仍应立即落子 —— 不破坏原有行为
  const G5 = loadGame(null, EXPORTS, { expose: true });
  G5.state.mode = 'mm';
  G5.resetGame();
  eq(G5.state.awaitStart, false, '普通重开: awaitStart=false');
  eq(G5.state.thinking, true, '普通重开: AI 立即思考');
  eq(btnText(G5), '重新开局', '普通重开: 文案 = 重新开局');
}

/* ------------------------------------------------------------------ ② */
function testTwoColumn(){
  console.log('\n[2] 选项区双列布局');
  const m = HTML.match(/<div class="opts">([\s\S]*?)<\/div>/);
  ok(!!m, '存在 .opts 容器');
  const ids = ['optPredict', 'optFollow', 'optCoord', 'optNumber', 'optDanger'];
  if (m){
    for (const id of ids) ok(m[1].includes('id="' + id + '"'), '  ' + id + ' 在 .opts 内');
  }
  for (const id of ids){
    const c = (HTML.match(new RegExp('id="' + id + '"', 'g')) || []).length;
    eq(c, 1, id + ' 全页只出现一次');
  }
  ok(/\.opts\{display:grid;grid-template-columns:repeat\(2,minmax\(96px,1fr\)\)/.test(HTML), 'CSS: 两列 grid');
  ok(HTML.includes('@supports not (grid-template-columns:repeat(2,minmax(96px,1fr)))'), 'CSS: 窄屏单列回退');
}

/* ------------------------------------------------------------------ ③ */
function testNativeBridge(){
  console.log('\n[3] nativeServer 桥');
  const G = loadGame(null, EXPORTS, { expose: true });
  const calls = [];
  G.__sb.window.G4Native = { setConfig: s => calls.push(s) };
  G.nativeServer(true);
  G.nativeServer(false);
  eq(calls.length, 2, '两次调用都到达 native');
  eq(calls[0], '{"server":true}', '开 ⇒ {server:true}');
  eq(calls[1], '{"server":false}', '关 ⇒ {server:false}');
  // 无桥时不得抛错
  const G2 = loadGame(null, EXPORTS, { expose: true });
  let threw = false;
  try { G2.nativeServer(true); } catch (e) { threw = true; }
  eq(threw, false, '无 G4Native 桥时静默忽略');
}

/* ------------------------------------------------------------------ ④ */
function makeServer(){
  const S = { seq: 0, msgs: [] };
  S.fetch = async (url) => {
    const u = new URL(url, 'http://x');
    if (u.pathname === '/api/create'){
      /* 真实流程：/api/create 建空房间（msgs:[]），随后**对手加入**时服务端才推
         {id:1,type:'sys',event:'lobby'}。沙箱里 setTimeout 是桩 ⇒ 轮询只会跑一轮，
         所以这里在 create 时就把"对手已加入"的那条 lobby 消息放上，让首轮 poll 能看到。
         这不影响本测试结论：判据是 host 用哪个 since 去拉——since>1 就会把 id=1 滤掉。 */
      S.seq = 0; S.msgs = [];
      S.msgs.push({ id: ++S.seq, type: 'sys', event: 'lobby' });
      return { ok: true, json: async () => ({ room: 'ABCD', token: 'tok1' }) };
    }
    if (u.pathname === '/api/poll'){
      const since = Number(u.searchParams.get('since') || 0);
      return { ok: true, json: async () => ({ msgs: S.msgs.filter(m => m.id > since) }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  return S;
}

async function runCreateScenario(html, label){
  const S = makeServer();
  const G = loadGame(html, EXPORTS, { expose: true, fetch: S.fetch });
  G.net.lastId = 7; G.net.startSeq = 7;          // 模拟上一局残留水位
  await G.netCreate();
  await flush();
  return { G, connected: G.net.connected, lastId: G.net.lastId, startSeq: G.net.startSeq };
}

async function testNetReset(){
  console.log('\n[4] 联机开房：lastId/startSeq 复位');
  // —— 当前版本（含修复）
  const FIXED = await runCreateScenario(HTML, 'fixed');
  eq(FIXED.lastId, 1, '修复版: 收到 id=1 的 lobby 消息');
  eq(FIXED.connected, true, '修复版: 进入房间（netStart 被触发）');

  // —— 移除修复后的对照组（应复现 bug）
  const NOFIX = HTML.replace(/[ \t]*net\.startSeq = 0; net\.lastId = 0;[^\n]*\n/g, '');
  ok(NOFIX !== HTML, '对照组: 已移除复位语句');
  const BROKEN = await runCreateScenario(NOFIX, 'nofix');
  eq(BROKEN.connected, false, '对照组: 残留 since=7 跳过了 lobby ⇒ 未进房间（复现 bug）');

  // netDropped 也应复位
  const G = loadGame(null, EXPORTS, { expose: true });
  G.net.lastId = 5; G.net.startSeq = 5;
  G.netDropped('');
  eq(G.net.lastId, 0, 'netDropped: lastId 归零');
  eq(G.net.startSeq, 0, 'netDropped: startSeq 归零');

  // 切模式离开联机 ⇒ 断开 ⇒ 复位（handler 内 netLeave(true)）
  const G2 = loadGame(null, EXPORTS, { expose: true });
  G2.net.lastId = 9; G2.net.startSeq = 9; G2.net.connected = true;
  ok(/if \(state\.mode === 'net' && b\.dataset\.mode !== 'net'\) netLeave\(true\)/.test(HTML),
     '模式切换: 离开联机时调用 netLeave(true)');
}

/* ------------------------------------------------------------------ ⑦ */
async function testModeSwitchNoServer(){
  console.log('\n[7] 切到联机模式不请求起服务器（页面侧 · G4Native 桩）');
  const S = makeServer();
  const G = loadGame(null, EXPORTS, { expose: true, fetch: S.fetch });
  const calls = [];
  G.__sb.window.G4Native = { setConfig: s => calls.push(s) };

  /* 模式切换处理器做的事：改 state.mode + resetGame（处理器内不调用 nativeServer） */
  G.state.mode = 'net';
  G.resetGame({ awaitStart: true });
  eq(calls.length, 0, '切到 net 模式后：未发出 setConfig（不起服务器）');

  await G.netCreate();                       // 点「创建房间」
  eq(calls.filter(s => s === '{"server":true}').length, 1, '点「创建房间」：发 {server:true}');

  G.netLeave(true);                          // 离开联机 / 断开连接
  eq(calls[calls.length - 1], '{"server":false}', '离开联机：发 {server:false}');
}

/* ------------------------------------------------------------------ ⑤ */
function testAndroid(){
  console.log('\n[5] Android：服务器的启动时机');
  const base = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'java', 'com', 'tzh', 'g4');
  const main = fs.readFileSync(path.join(base, 'MainActivity.java'), 'utf8');
  const prefs = fs.readFileSync(path.join(base, 'Prefs.java'), 'utf8');
  const bridge = fs.readFileSync(path.join(base, 'G4Bridge.java'), 'utf8');
  ok(/boolean want = Prefs\.isLocal\(this\) && srvWanted;/.test(main),
     'MainActivity.syncServer: 仅当"本机模式 且 本次会话请求"才监听');
  ok(/private volatile boolean srvWanted = false;/.test(main), 'srvWanted 字段默认 false');
  ok(/public boolean serverWanted\(\)/.test(main) && /public void setServerWanted\(/.test(main),
     '提供 serverWanted()/setServerWanted()');
  ok(!/K_SRV_WANT/.test(prefs.replace(/\/\*[\s\S]*?\*\//g, '')),
     'Prefs: 已不再持久化监听开关（残留旧键不读取）');
  ok(!/Prefs\.serverWanted|Prefs\.setServerWanted/.test(bridge), 'G4Bridge: 不再经由 Prefs');
  ok(/if \(o\.has\("server"\)\) act\.setServerWanted\(/.test(bridge), 'G4Bridge.setConfig 读取 "server"');
  ok(/o\.put\("server", act\.serverWanted\(\)\)/.test(bridge), 'G4Bridge.getConfig 回读 "server"');
}

/* ------------------------------------------------------------------ ⑥ */
function testServerTriggers(){
  console.log('\n[6] 服务器启动时机：只认「开房 / 加入」');
  eq((HTML.match(/nativeServer\(true\)/g) || []).length, 2, 'nativeServer(true) 恰好 2 处');
  eq((HTML.match(/nativeServer\(false\)/g) || []).length, 1, 'nativeServer(false) 恰好 1 处');

  const handler = HTML.match(/getElementById\('modeSeg'\)\.addEventListener\('click',[\s\S]*?\n\}\);/);
  ok(!!handler, '取到模式切换处理器');
  if (handler) ok(!/nativeServer/.test(handler[0]), '切到联机模式**不**调用 nativeServer');

  const nm = HTML.match(/function netEnterMode\(\)\{[\s\S]*?\n\}/);
  ok(!!nm, '取到 netEnterMode');
  if (nm) ok(!/nativeServer/.test(nm[0]), 'netEnterMode 不调用 nativeServer');

  const inCreate = /async function netCreate\(\)\{[\s\S]*?\n\}/.exec(HTML);
  ok(!!inCreate && /nativeServer\(true\)/.test(inCreate[0]), 'netCreate（开房）请求开监听');
  const inJoin = /async function netJoin\(\)\{[\s\S]*?\n\}/.exec(HTML);
  ok(!!inJoin && /nativeServer\(true\)/.test(inJoin[0]), 'netJoin（加入）请求开监听');
  const inLeave = /async function netLeave\(silent\)\{[\s\S]*?\n\}/.exec(HTML);
  ok(!!inLeave && /nativeServer\(false\)/.test(inLeave[0]), 'netLeave（离开/断开）请求关监听');
  ok(/if \(state\.mode === 'net' && b\.dataset\.mode !== 'net'\) netLeave\(true\);/.test(HTML),
     '离开联机模式走 netLeave ⇒ 顺带关监听');
}

/* ------------------------------------------------------------------ ⑧ */
function testStaticLabelOverwritten(){
  console.log('\n[8] 暂停按钮文案：静态 HTML 不得与 updateUI 写入值不一致');
  const G = loadGame(null, EXPORTS, { expose: true });
  G.state.mode = 'mm';
  G.resetGame({ awaitStart: true });                 // 未暂停
  const statik = (HTML.match(/<button id="mmPause">([\s\S]*?)<\/button>/) || [])[1];
  const runtime = G.__sb.__els.get('mmPause').textContent;
  ok(statik != null, '取到静态 HTML 文案：' + JSON.stringify(statik));
  eq(runtime, statik, 'updateUI 写入值 === 静态 HTML（不等 ⇒ 静态那处是死代码，改它没用）');
  G.state.mmPaused = true; G.updateUI();
  eq(G.__sb.__els.get('mmPause').textContent, '⏵', '暂停中 → 显示「⏵」（可继续）');
  G.state.mmPaused = false; G.updateUI();
  eq(G.__sb.__els.get('mmPause').textContent, statik, '恢复运行 → 回到静态文案');
}

(async () => {
  testMachineFirst();
  testTwoColumn();
  testNativeBridge();
  await testNetReset();
  await testModeSwitchNoServer();
  testAndroid();
  testServerTriggers();
  testStaticLabelOverwritten();
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); process.exit(2); });
