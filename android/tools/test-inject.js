#!/usr/bin/env node
/* ==========================================================================
   注入层无头测试：手势事件序列 / pinch→wheel 换算 / 网络桥
   运行：node tools/test-inject.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INJECT = fs.readFileSync(path.join(__dirname, '..', 'inject', 'g4-mobile.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}
function approx(a, b, tol) { return Math.abs(a - b) <= tol; }

/* ---------------- DOM 桩 ---------------- */
class Evt {
  constructor(type, props) { this.type = type; Object.assign(this, props || {}); }
}
class MouseEvent extends Evt {}
class WheelEvent extends Evt {}

function makeEl() {
  const el = {
    style: {}, attrs: {}, children: [],
    handlers: {},
    addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); },
    appendChild(c) { this.children.push(c); return c; },
    setAttribute() {}, setProperty() {},
    dispatchEvent(ev) {
      this._evts = this._evts || [];
      this._evts.push(ev);
      const hs = this.handlers[ev.type];
      if (hs) for (const h of hs) h.call(this, ev);
    },
    querySelector() { return null; },
    getElementById() { return null; }
  };
  return el;
}

const canvas = makeEl();
const documentEl = makeEl();
const elements = { cv: canvas, panel: null };
const records = [];
let nativeHttpCalls = [];
let nativeCopyText = null;

const G4Native = {
  http(id, method, url, body) {
    nativeHttpCalls.push({ id, method, url, body });
    /* 同步回调，模拟原生层立即应答 */
    const bodyText = url.indexOf('/api/ping') >= 0 ? 'pong' : '{}';
    sandbox.window.__g4HttpDone(id, 200, bodyText);
  },
  copy(t) { nativeCopyText = t; },
  toast() {}, log() {},
  getConfig() { return '{}'; },
  setConfig() {}
};

const windowEl = {
  _evts: [],
  dispatchEvent(ev) {
    this._evts.push(ev);
    records.push({ target: 'window', type: ev.type, x: ev.clientX, y: ev.clientY, deltaY: ev.deltaY });
    const hs = this.handlers && this.handlers[ev.type];
    if (hs) for (const h of hs) h.call(this, ev);
  },
  addEventListener(t, f) { (this.handlers = this.handlers || {})[t] = (this.handlers[t] || []).concat([f]); },
  getSelection() { return { toString: () => '' }; }
};
canvas.dispatchEvent = function (ev) {
  this._evts = this._evts || [];
  this._evts.push(ev);
  records.push({ target: 'canvas', type: ev.type, x: ev.clientX, y: ev.clientY, deltaY: ev.deltaY });
  const hs = this.handlers[ev.type];
  if (hs) for (const h of hs) h.call(this, ev);
};

const sandbox = {
  window: windowEl, document: documentEl, navigator: { clipboard: null },
  location: { href: 'https://g4.local/index.html' },
  MouseEvent, WheelEvent, Response: class Response { constructor(b, o) { this._b = b; this.status = o && o.status; this.ok = !o || o.status < 400; this._body = b; } json() { return Promise.resolve(JSON.parse(this._body)); } text() { return Promise.resolve(this._body); } get ok_() { return this.status >= 200 && this.status < 300; } },
  Promise, Math, Date, JSON, Object, Array, String, Number, Boolean,
  setTimeout, clearTimeout, console,
  G4Native,
  __g4HttpDone: () => {}
};
sandbox.window.__G4MOBILE__ = undefined;
sandbox.window.G4Native = G4Native;
sandbox.globalThis = sandbox;

documentEl.getElementById = (id) => (id === 'cv' ? canvas : elements[id] || null);
documentEl.createElement = () => makeEl();
documentEl.createTextNode = (t) => ({ text: t });
documentEl.head = { appendChild() {} };
documentEl.readyState = 'complete';
documentEl.addEventListener = function () {};
documentEl.execCommand = function () { return false; };

/* 记录 canvas 上的事件简写 */
const cvFire = (type, opts) => {
  const ev = new Evt(type, opts);
  ev.preventDefault = () => {};
  canvas.dispatchEvent(ev);
  return ev;
};
const touchList = (pts) => pts.map((p, i) => ({ identifier: i, clientX: p[0], clientY: p[1] }));

vm.runInNewContext(INJECT, sandbox, { filename: 'g4-mobile.js' });

/* ========================================================================
   用例
   ======================================================================== */
function reset() { records.length = 0; canvas._evts = []; windowEl._evts = []; }
const recs = () => records.filter(r => !/^touch/.test(r.type))
  .map(r => r.type + (r.target === 'canvas' ? '@cv' : '@win'));
function press(x, y) { cvFire('touchstart', { touches: touchList([[x, y]]) }); }
function move(x, y) { cvFire('touchmove', { touches: touchList([[x, y]]) }); }
function release(x, y) { cvFire('touchend', { touches: [], changedTouches: touchList([[x, y]]) }); }

console.log('\n[1] 单击序列');
{
  reset();
  press(100, 100);
  release(100, 100);
  const r = recs();
  ok(r.join(',') === 'mousedown@cv,mouseup@win,mousemove@cv',
     'tap → mousedown(cv)+mouseup(win)+补发mousemove(cv 以刷新落点预测)，实际: ' + r.join(','));
}

console.log('\n[2] 抖动死区：微移不触发拖拽');
{
  reset();
  press(100, 100);
  move(103, 100);   // 位移 3 < 10
  move(106, 100);   // 累计 6 < 10
  const during = recs();
  release(106, 100);
  ok(!during.some(x => x === 'mousemove@win'), '移动阶段不派发 mousemove，实际: ' + during.join(','));
}

console.log('\n[3] 真实拖动：超过死区后按位移派发');
{
  reset();
  press(100, 100);
  move(115, 100);   // 15 > 10 → 派发一次（从按下点直接跳到 15px，保证页面 dragMoved 一次到位）
  move(125, 100);
  const during = recs();
  release(125, 100);
  ok(during.filter(x => x === 'mousemove@win').length === 2,
     '拖动阶段两次 mousemove，实际: ' + during.join(','));
}

console.log('\n[4] 双击落子语义：340ms 内两次 tap');
{
  reset();
  press(200, 200); release(200, 200);
  press(200, 200); release(200, 200);
  const ups = recs().filter(x => x === 'mouseup@win');
  ok(ups.length === 2, '两次 mouseup → 页面自行判定双击，实际: ' + recs().join(','));
}

console.log('\n[5] pinch→wheel 换算精度');
{
  reset();
  cvFire('touchstart', { touches: touchList([[100, 100], [300, 100]]) });  // d=200
  let sum = 0;
  // 逐步把距离从 200 缩到 100（每次 -10）
  for (let d = 190; d >= 100; d -= 10) {
    const x2 = 100 + d;
    cvFire('touchmove', { touches: touchList([[100, 100], [x2, 100]]) });
  }
  const wheels = records.filter(r => r.type === 'wheel');
  for (const w of wheels) sum += w.deltaY;
  // 期望: f = exp(-ΣdeltaY*0.0016) = 0.5
  const f = Math.exp(-sum * 0.0016);
  ok(wheels.length === 10, '10 帧 wheel（每次距离变化触发一次），实际 ' + wheels.length);
  ok(approx(f, 0.5, 0.004), '累计缩放倍率 = 0.5（200→100），实际 ' + f.toFixed(4) + ' Σ=' + sum.toFixed(1));
}

console.log('\n[6] pinch 结束：收尾合成拖拽，不误落子');
{
  reset();
  cvFire('touchstart', { touches: touchList([[100, 100], [300, 100]]) });
  cvFire('touchmove', { touches: touchList([[100, 100], [200, 100]]) });
  cvFire('touchend', { touches: [], changedTouches: touchList([[100, 100], [200, 100]]) });
  const r = recs();
  ok(r.includes('mousedown@cv') && r.includes('mouseup@win') && r.includes('mouseleave@cv'),
     'pinch 结束：mousedown→wheel/移动→mouseup→mouseleave，实际: ' + r.join(','));
  const md = r.filter(x => x === 'mousedown@cv').length;
  ok(md === 1, '仅 1 次 mousedown → 不可能凑成双击误落子，实际 mousedown@cv=' + md);
}

console.log('\n[7] pinch 中双指中点位移 → 平移 (mousemove@cv)');
{
  reset();
  cvFire('touchstart', { touches: touchList([[100, 100], [300, 100]]) });
  cvFire('touchmove', { touches: touchList([[130, 120], [330, 120]]) });  // 中点移 (30,20) 距离>14
  const r = recs();
  ok(r.some(x => x === 'mousemove@cv'), '双指平移触发 canvas mousemove（页面相机逻辑处理），实际: ' + r.join(','));
}

/* ---------------- 网络桥 ---------------- */
console.log('\n[8] fetch 覆写：/api/* 走原生桥');
(async () => {
  nativeHttpCalls = [];
  await sandbox.window.fetch('/api/ping');
  ok(nativeHttpCalls.length === 1 && nativeHttpCalls[0].method === 'GET' &&
     nativeHttpCalls[0].url === '/api/ping', 'GET /api/ping 进入桥');

  nativeHttpCalls = [];
  const body = JSON.stringify({ room: 'ABCD', token: 't', msg: { type: 'ready', on: true } });
  await sandbox.window.fetch('/api/send', { method: 'POST', body });
  ok(nativeHttpCalls.length === 1 && nativeHttpCalls[0].method === 'POST' &&
     nativeHttpCalls[0].body === body, 'POST /api/send 带 body 进入桥');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('执行出错', e); process.exit(1); });
