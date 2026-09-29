'use strict';
/* ============================================================
   回归：联机入口的可用性提示

   背景：联机靠同源相对接口（GET /api/poll + POST /api/send），页面必须由
   server/server.js 托管。GitHub Pages 是纯静态托管，/api/* 会 404
   （实测 ping/join/poll 全 404），此时必须：
     · 把「联机」按钮置灰
     · 在面板里给出**可操作**的提示（怎么起服务端），而不是含糊的"无法连接服务器"

   跑法：node tools/check-net-hint.js
   ============================================================ */
const { loadGame } = require('./game-sandbox');

let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); c ? pass++ : fail++; };

const SPEC = 'netPing,net';
const HINT_KEY = '静态托管不含 /api 接口';

/* 假响应对象：只需 .ok（代码只读它） */
const reply = (status) => async () => ({ ok: status >= 200 && status < 300, status });

(async () => {
  /* ① 模拟 GitHub Pages：/api/ping 返回 404 */
  console.log('① 无后端（静态托管，/api/ping → 404）');
  const G1 = loadGame(null, SPEC, { expose: true, fetch: reply(404) });
  await G1.netPing();
  const btn1 = G1.__sb.document.getElementById('modeNet');
  const tip1 = G1.__sb.document.getElementById('netUnavailable');
  ok(G1.net.available === false, '判定为「无后端」');
  ok(btn1.disabled === true, '「联机」按钮置灰');
  ok(/服务端/.test(btn1.title), '按钮 tooltip 说明需要服务端');
  ok(tip1.style.display === '' && tip1.textContent.includes(HINT_KEY), '面板显示可操作提示');
  ok(/server\/server\.js/.test(tip1.textContent), '提示里给出了启动命令');
  console.log('      提示文案：' + tip1.textContent);

  /* ② 模拟自建服务器：/api/ping 返回 200 */
  console.log('\n② 有后端（server/server.js 托管，/api/ping → 200）');
  const G2 = loadGame(null, SPEC, { expose: true, fetch: reply(200) });
  await G2.netPing();
  const btn2 = G2.__sb.document.getElementById('modeNet');
  const tip2 = G2.__sb.document.getElementById('netUnavailable');
  ok(G2.net.available === true, '判定为「有后端」');
  ok(btn2.disabled === false, '「联机」按钮可用');
  ok(tip2.style.display === 'none' && tip2.textContent === '', '提示已清除');

  /* ③ 网络异常（fetch 抛错）也要走"无后端"分支，而不是崩掉 */
  console.log('\n③ 网络异常（fetch reject）');
  const G3 = loadGame(null, SPEC, { expose: true, fetch: async () => { throw new Error('boom'); } });
  await G3.netPing();
  ok(G3.net.available === false, '判定为「无后端」而不是抛异常');
  ok(G3.__sb.document.getElementById('netUnavailable').textContent.includes(HINT_KEY), '仍给出提示');

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
