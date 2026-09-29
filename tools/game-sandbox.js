'use strict';
/* ============================================================
   index.html 沙箱加载器 —— 供 tools/ 下的 Node 侧脚本复用

   两条必须遵守的约定（历史上都踩过）：

   1) 页面里有 **两个** `<script>` 块：第一个是游戏逻辑，第二个是注入的
      神经网络权重（`__NNW`）。提取时必须用**非贪婪**匹配
      `/<script>([\s\S]*?)<\/script>/`；贪婪匹配会把第一个块的 `</script>`
      一起吞进 JS，直接 `SyntaxError: Unexpected token '<'`。

   2) `aiChooseMove` 是 **async** 函数，内部靠 `yieldFrame()` 让出帧，而
      `yieldFrame` 依赖 `requestAnimationFrame`。因此：
        - 加载期：rAF 必须是 noop，否则游戏的动画 loop 会在沙箱里无限递归；
        - 加载后：rAF 必须改成「同步触发回调」，`await aiChooseMove()` 才能完成，
          否则 Promise 永不 resolve，脚本静默挂死。
     见 tools/neural/env.js 里同样的处理。

   用法：
     const { HTML, loadGame, drain } = require('./game-sandbox');
     const G = loadGame(null, 'state,placePiece,aiChooseMove,K,P1,P2');
     const d = await G.aiChooseMove();            // 注意 await
   ============================================================ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML_PATH = path.join(__dirname, '..', 'index.html');
const HTML = fs.readFileSync(HTML_PATH, 'utf8');

const noop = () => {};

/* canvas 2d context 桩：只需撑住 measureText / 渐变 / canvas 三种取值 */
const ctxStub = () => new Proxy({}, {
  get(t, p){
    if (p === 'measureText') return () => ({ width: 5 });
    if (p === 'createRadialGradient' || p === 'createLinearGradient') return () => ({ addColorStop: noop });
    if (p === 'canvas') return { width: 800, height: 600 };
    if (p === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
    return noop;
  },
  set(){ return true; },
});

/* DOM 元素桩：id 查询统一返回同一个可写对象，classList 要真能增删（UI 用得上） */
const el = () => ({
  textContent: '', innerHTML: '', value: '50', checked: true, disabled: false,
  style: {}, width: 800, height: 600, clientWidth: 800, clientHeight: 600,
  classList: {
    _s: new Set(),
    add(c){ this._s.add(c); }, remove(c){ this._s.delete(c); },
    toggle(c){ this._s.has(c) ? this._s.delete(c) : this._s.add(c); },
    contains(c){ return this._s.has(c); },
  },
  addEventListener: noop, removeEventListener: noop, appendChild: noop, removeChild: noop,
  setAttribute: noop, getAttribute: () => null, focus: noop, blur: noop,
  getContext: () => ctxStub(),
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  querySelectorAll: () => [], querySelector: () => null,
});

function makeSandbox(){
  const sb = {
    console, Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean,
    parseInt, parseFloat, isNaN, isFinite, Promise, Error, RegExp, Symbol,
    performance: { now: () => Date.now() },
    /* 加载期：吞掉 rAF（防动画 loop 递归）与定时器 */
    requestAnimationFrame: noop,
    cancelAnimationFrame: noop,
    setTimeout: () => 0,
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    fetch: () => Promise.reject(new Error('sandbox: no network')),
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: {
      getElementById: () => el(), querySelector: () => null, querySelectorAll: () => [],
      addEventListener: noop, createElement: () => el(),
      body: { appendChild: noop, removeChild: noop, style: {} },
      documentElement: { style: {} },
    },
    window: { addEventListener: noop, removeEventListener: noop, devicePixelRatio: 1, innerWidth: 800, innerHeight: 600 },
    navigator: { userAgent: 'node-sandbox' },
    location: { href: 'file:///index.html', search: '' },
    WebSocket: noop,
  };
  sb.globalThis = sb;
  return sb;
}

/** 取页面里第一个 `<script>` 的内容（非贪婪，见文件头说明 1） */
function scriptOf(htmlSrc){
  const m = (htmlSrc || HTML).match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('页面里找不到 <script> 块：' + (htmlSrc ? '(传入的 htmlSrc)' : HTML_PATH));
  return m[1];
}

/**
 * 载入游戏逻辑，返回 `__G` 句柄。
 * @param {string|null} htmlSrc   页面源码；传 null 用仓库根的 index.html
 * @param {string} exportSpec     `globalThis.__G={ ... }` 内的字段列表（含 getter 写法）
 */
function loadGame(htmlSrc, exportSpec){
  const sb = makeSandbox();
  vm.createContext(sb);
  vm.runInContext(scriptOf(htmlSrc) + ';globalThis.__G={' + exportSpec + '};', sb, { filename: 'index.html' });
  /* 加载完成：rAF 改为同步触发 —— 见文件头说明 2 */
  sb.requestAnimationFrame = (cb) => { cb(); return 0; };
  if (!sb.__G) throw new Error('__G 未挂载，检查 exportSpec：' + exportSpec);
  return sb.__G;
}

/** 推进物理：一直 updateMoving 到不再处于 falling 相位 */
function drain(G){
  let f = 0;
  while (G.state.phase === 'falling' && f++ < 800000) G.updateMoving(1 / 60);
}

/** 空棋盘（仅 (0,0) 放中心块） */
function resetTo(G, extra){
  const o = new Map();
  o.set(G.K(0, 0), G.BLOCK);
  G.occ = o;
  Object.assign(G.state, {
    mode: 'mm', diff: (extra && extra.diff) || 'hard',
    phase: 'idle', turn: G.P1, moveCount: 0, winner: 0, winCells: null,
  }, extra || {});
  return G;
}

module.exports = { HTML, HTML_PATH, loadGame, drain, resetTo, scriptOf };
