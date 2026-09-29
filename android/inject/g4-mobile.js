/* ==========================================================================
   g4-mobile.js · 重力四子棋 Android 适配注入层
   --------------------------------------------------------------------------
   由壳层在返回 HTML 时插入 <script> 标签注入，运行在页面主脚本之前。
   设计原则：不修改游戏 HTML 一个字符，全部能力在壳层与注入层实现。
   语法保持在 ES5/ES6 交集，避免旧系统 WebView 解析失败。

   职责：
     ① 网络桥：/api/* 请求改走原生（file/appassets 源下相对路径无处可去）
     ② 触摸桥：单指 → mousedown/mousemove/mouseup（复用页面双击落子逻辑）
     ③ 手势：  双指 pinch → wheel，换算与页面滚轮公式严格互逆
     ④ 剪贴板：navigator.clipboard / execCommand 兜底到原生
     ⑤ UI：    小屏样式、安全区、文案替换、overscroll 抑制
     ⑥ 生命周期：前后台切换钩子（后台轮询由原生接管，无需页面参与）
   ========================================================================== */
(function () {
  'use strict';
  if (window.__G4MOBILE__) { return; }

  var N = window.G4Native || null;          /* addJavascriptInterface 注入 */
  var hasN = !!N;

  /* 与页面 wheel 处理器严格对应的系数：f = exp(-deltaY * K) */
  var K_WHEEL = 0.0016;
  var TAP_SLOP = 10;          /* 单指抖动死区（CSS px），超过才派发 mousemove */
  var PINCH_PAN_SLOP = 14;    /* 双指中心位移死区，超过才平移 */
  var DBL_MS = 340;           /* 与页面双击判定窗口一致 */
  var TAP_PLACE = false;      /* 单击即落子（关闭：保持与桌面一致的防误触） */

  function log() {
    if (hasN && N.log) { try { N.log('[g4m] ' + Array.prototype.join.call(arguments, ' ')); } catch (e) {} }
  }

  /* ========================================================================
     ① 网络桥：把所有 /api/* 请求交给原生层
     ------------------------------------------------------------------------
     为什么不用 shouldInterceptRequest：拿不到 POST 请求体，而 /api/send 正是
     POST + JSON。改走 JS 桥是唯一能完整保留协议的方式。
     ======================================================================== */
  var seq = 0;
  var pending = Object.create(null);
  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;

  function pathOf(u) {
    var s = String(u);
    var m = s.match(/^[a-z]+:\/\/[^/]+(\/[^?#]*)?/i);
    if (m) { return m[1] || '/'; }
    return s.split('?')[0].split('#')[0];
  }
  function isApi(u) {
    var p = pathOf(u);
    return p.indexOf('/api/') === 0 || p === '/api';
  }

  window.fetch = function (input, init) {
    var req = (input && typeof input === 'object' && typeof input.url === 'string') ? input : null;
    var url = req ? req.url : String(input);

    if (!hasN || !isApi(url)) { return nativeFetch ? nativeFetch(input, init) : Promise.reject(new TypeError('no fetch')); }

    var method = 'GET', body = '';
    if (req) { method = req.method || 'GET'; }
    if (init) {
      if (init.method) { method = init.method; }
      if (init.body != null) { body = String(init.body); }
    }

    var id = 'r' + (++seq);
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject, url: url };
      try {
        N.http(id, String(method).toUpperCase(), url, body);
      } catch (e) {
        delete pending[id];
        reject(e);
      }
    });
  };

  /* 原生层回调：status === 0 表示网络失败 → reject，页面会显示「无法连接服务器」 */
  window.__g4HttpDone = function (id, status, body) {
    var p = pending[id];
    if (!p) { return; }
    delete pending[id];
    if (status === 0) {
      p.reject(new TypeError('NetworkError: ' + (body || 'bridge failed')));
      return;
    }
    var ct = pathOf(p.url).indexOf('/api/ping') === 0 ? 'text/plain' : 'application/json; charset=utf-8';
    var res;
    try {
      res = new Response(status === 204 || status === 304 ? null : body, {
        status: status,
        statusText: status === 200 ? 'OK' : String(status),
        headers: { 'Content-Type': ct }
      });
    } catch (e) {
      p.reject(e);
      return;
    }
    p.resolve(res);
  };

  /* ========================================================================
     ② 剪贴板兜底
     ======================================================================== */
  function nativeCopy(text) {
    if (hasN && N.copy) {
      try { N.copy(String(text)); return true; } catch (e) {}
    }
    return false;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    var origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    try {
      navigator.clipboard.writeText = function (t) {
        return origWrite(t)['catch'](function () {
          return nativeCopy(t) ? Promise.resolve() : Promise.reject(new Error('copy failed'));
        });
      };
    } catch (e) {}
  }
  var origExec = document.execCommand ? document.execCommand.bind(document) : null;
  document.execCommand = function (cmd) {
    if (String(cmd).toLowerCase() === 'copy') {
      var txt = '';
      var sel = window.getSelection ? String(window.getSelection()) : '';
      if (sel) { txt = sel; }
      else {
        var a = document.activeElement;
        if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) {
          txt = a.value.substring(a.selectionStart || 0, a.selectionEnd || 0) || a.value;
        }
      }
      if (txt && nativeCopy(txt)) { return true; }
    }
    return origExec ? origExec.apply(document, arguments) : false;
  };

  /* ========================================================================
     ③④ 触摸桥接与双指缩放
     ------------------------------------------------------------------------
     事件合成策略（关键点）：
       · canvas 上的 touch 一律 preventDefault，阻止系统再合成一遍鼠标事件
       · 单指：按下派发 mousedown（canvas），移动派发 mousemove（window），
         抬起派发 mouseup（window）—— 完整复用页面原有的双击落子判定
       · 抖动死区：手指微抖不派发 mousemove，否则页面 dragMoved 累加超限，
         点击会被误判成拖拽，导致双击落子失效
       · 双指：进入 pinch 后不再派发任何鼠标事件；结束时只派发 mouseleave，
         绝不派发 mouseup —— 否则可能被页面判定成一次点击，与上一次点击凑成
         双击而误落子
       · pinch → wheel：deltaY = -ln(ratio)/K，与页面 f = exp(-deltaY*K) 互逆
     ======================================================================== */
  function mkMouse(type, x, y) {
    var e;
    try {
      e = new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y, screenX: x, screenY: y,
        button: 0, detail: 1,
        buttons: (type === 'mouseup') ? 0 : 1
      });
    } catch (err) {
      e = document.createEvent('MouseEvents');
      e.initMouseEvent(type, true, true, window, 1, x, y, x, y, false, false, false, false, 0, null);
    }
    return e;
  }
  function mkWheel(x, y, deltaY) {
    var e;
    try {
      e = new WheelEvent('wheel', {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y, deltaY: deltaY, deltaMode: 0
      });
    } catch (err) {
      e = document.createEvent('WheelEvent');
      e.initWheelEvent('wheel', true, true, window, 0, x, y, x, y, 0, deltaY);
    }
    return e;
  }

  function installTouch(cv) {
    if (!cv) { return; }
    cv.style.touchAction = 'none';
    cv.style.webkitUserSelect = 'none';

    var mode = 0;          /* 0 空闲 / 1 单指 / 2 双指 */
    var sid = null;        /* 单指 identifier */
    var downPt = null, lastPt = null, moving = false;
    var pinch = null;      /* {d, cx, cy} */
    var lastTapT = 0, lastTapX = 0, lastTapY = 0;

    function P(t) { return { x: t.clientX, y: t.clientY }; }
    function dist(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }
    function geom(tl) {
      var a = P(tl[0]), b = P(tl[1]);
      return { d: dist(a, b) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    }

    cv.addEventListener('touchstart', function (e) {
      e.preventDefault();
      if (e.touches.length === 1) {
        var t = e.touches[0];
        mode = 1; sid = t.identifier;
        downPt = P(t); lastPt = P(t); moving = false;
        cv.dispatchEvent(mkMouse('mousedown', downPt.x, downPt.y));
      } else if (e.touches.length >= 2) {
        mode = 2; sid = null; moving = false;
        pinch = geom(e.touches);
        /* 以双指中点为锚点向页面发起「拖拽」：后续双指整体平移走页面相机逻辑 */
        cv.dispatchEvent(mkMouse('mousedown', pinch.cx, pinch.cy));
      }
    }, { passive: false });

    cv.addEventListener('touchmove', function (e) {
      e.preventDefault();
      if (mode === 2 && e.touches.length >= 2) {
        var g = geom(e.touches);
        if (!pinch) { pinch = g; return; }
        var ratio = g.d / pinch.d;
        if (ratio > 0 && Math.abs(ratio - 1) > 0.0004) {
          cv.dispatchEvent(mkWheel(g.cx, g.cy, -Math.log(ratio) / K_WHEEL));
        }
        /* 双指整体平移：dragging 已为真，页面相机逻辑直接处理（锚点=双指中点） */
        cv.dispatchEvent(mkMouse('mousemove', g.cx, g.cy));
        pinch = g;
        return;
      }
      if (mode === 1) {
        var t = null, i;
        for (i = 0; i < e.touches.length; i++) { if (e.touches[i].identifier === sid) { t = e.touches[i]; break; } }
        if (!t) { return; }
        var p = P(t);
        if (!moving && Math.abs(p.x - downPt.x) + Math.abs(p.y - downPt.y) > TAP_SLOP) { moving = true; }
        if (moving) { window.dispatchEvent(mkMouse('mousemove', p.x, p.y)); }
        lastPt = p;
      }
    }, { passive: false });

    function endTouch(e) {
      if (mode === 2) {
        if (e.touches.length >= 2) { pinch = geom(e.touches); return; }
        /* 结束双指手势：收尾合成拖拽（平移已使 dragMoved 很大 → 不会误判双击） */
        var lc = pinch ? { x: pinch.cx, y: pinch.cy } : { x: 0, y: 0 };
        mode = 0; pinch = null;
        window.dispatchEvent(mkMouse('mouseup', lc.x, lc.y));
        cv.dispatchEvent(mkMouse('mouseleave', 0, 0));
        return;
      }
      if (mode === 1) {
        var p = lastPt || (e.changedTouches && e.changedTouches[0] ? P(e.changedTouches[0]) : downPt);
        if (e.changedTouches && e.changedTouches.length && e.changedTouches[0].identifier !== sid) { return; }
        window.dispatchEvent(mkMouse('mouseup', p.x, p.y));
        /* 抬起后再补一次 mousemove 到 canvas：dragging 已置 false，页面借此刷新落点预测 */
        cv.dispatchEvent(mkMouse('mousemove', p.x, p.y));

        if (moving) { lastTapT = 0; }
        else {
          var now = Date.now();
          if (TAP_PLACE && lastTapT && now - lastTapT < DBL_MS) { lastTapT = 0; }
          else { lastTapT = now; lastTapX = p.x; lastTapY = p.y; }
        }
        mode = 0; sid = null; lastPt = null; moving = false;
      }
    }
    cv.addEventListener('touchend', function (e) { e.preventDefault(); endTouch(e); }, { passive: false });
    cv.addEventListener('touchcancel', function (e) { e.preventDefault(); endTouch(e); }, { passive: false });
  }

  /* ========================================================================
     ⑤ UI 适配：小屏样式、安全区、文案
     ======================================================================== */
  function injectCss() {
    var css = [
      'html,body{overscroll-behavior:none;-webkit-tap-highlight-color:transparent}',
      'canvas#cv{touch-action:none}',
      ':root{--g4-sat:0px;--g4-sab:0px;--g4-sal:0px;--g4-sar:0px}',
      '@supports (top:env(safe-area-inset-top)){',
      ' :root{--g4-sat:env(safe-area-inset-top);--g4-sab:env(safe-area-inset-bottom);',
      ' --g4-sal:env(safe-area-inset-left);--g4-sar:env(safe-area-inset-right)}}',
      '#panel{max-height:calc(100vh - 16px - var(--g4-sat) - var(--g4-sab));overflow-y:auto;',
      ' -webkit-overflow-scrolling:touch;overscroll-behavior:contain}',
      /* 面板选项区（落点预测/镜头跟随/显示坐标/显示序号/危险提示）双列显示：
         直接子级 label.chk 两两成行；float 使它们不依赖父容器为 grid */
      '#panel > label.chk{float:left;width:50%;box-sizing:border-box;padding-right:8px;margin:4px 0}',
      '#panel > .hint{clear:both}',
      '@media (max-width:820px){',
      ' #panel{width:min(62vw,236px);padding:10px 11px 9px;font-size:12px;',
      '  top:calc(6px + var(--g4-sat));left:calc(6px + var(--g4-sal))}',
      ' #panel h1{font-size:15px}',
      ' #panel .sub{font-size:10.5px}',
      ' #panel .lbl{margin-top:7px}',
      ' #panel .btns button,#panel .netBtn{padding:8px 6px;font-size:12px}',
      ' #panel .chk{font-size:12px;padding:3px 0}',
      ' #tab{top:calc(6px + var(--g4-sat));left:calc(6px + var(--g4-sal))}',
      ' #topRight{top:calc(6px + var(--g4-sat));right:calc(6px + var(--g4-sar))}',
      ' #undoBtn{padding:7px 12px}',
      ' #zoomFloat{bottom:calc(6px + var(--g4-sab));right:calc(6px + var(--g4-sar))}',
      ' #banner{min-width:248px;max-width:92vw;white-space:nowrap;text-align:center}',
      ' #banner .big,#banner .big span{white-space:nowrap}',
      ' #banner .bnRow{flex-wrap:nowrap}',
      ' #help{align-items:flex-end;padding:0}',
      ' #helpBox{position:static;margin:0 auto;width:100%;max-width:100%;border-radius:16px 16px 0 0;',
      '  max-height:calc(var(--g4-vvh,100vh) - var(--g4-sat) - var(--g4-sab));overflow-y:auto;',
      '  -webkit-overflow-scrolling:touch;padding:18px 18px calc(20px + var(--g4-sab))}',
      ' #load{align-items:flex-end;padding:0}',
      ' #loadBox{position:static;margin:0 auto;width:100%;max-width:100%;border-radius:16px 16px 0 0;',
      '  max-height:calc(var(--g4-vvh,100vh) - var(--g4-sat) - var(--g4-sab));',
      '  -webkit-overflow-scrolling:touch;padding:18px 18px calc(20px + var(--g4-sab))}',
      '}',
      '@media (min-width:821px) and (orientation:landscape){',
      ' #tab,#topRight{top:calc(6px + var(--g4-sat))}',
      ' #zoomFloat{bottom:calc(6px + var(--g4-sab));right:calc(6px + var(--g4-sar))}',
      ' #panel{top:calc(6px + var(--g4-sat));left:calc(6px + var(--g4-sal))}',
      '}',
      /* 键盘弹出时把可见高度写到 --g4-vvh，注入层与手机设置都基于它排版 */
      ':root{--g4-vvh:100vh}',
      '@supports (height:100dvh){:root{--g4-vvh:100dvh}}'
    ].join('');
    var s = document.createElement('style');
    s.setAttribute('data-g4m', '1');
    s.appendChild(document.createTextNode(css));
    document.head.appendChild(s);
  }

  function fixText() {
    var h = document.querySelector('#panel .hint');
    if (h && h.textContent.indexOf('滚轮') >= 0) {
      h.textContent = '双指缩放 · 单指拖拽平移 · 双击落子';
    }
    var mr = document.getElementById('modeNet');
    if (mr) {
      mr.setAttribute('title', '需先开启联机服务器：本机开房或填入局域网服务器地址');
    }
  }

  /* 原生层在 insets 变化时回调（比 env() 更可靠，适配挖孔/手势条） */
  window.__g4Insets = function (top, right, bottom, left) {
    var r = document.documentElement;
    if (!r) { return; }
    r.style.setProperty('--g4-sat', (top || 0) + 'px');
    r.style.setProperty('--g4-sar', (right || 0) + 'px');
    r.style.setProperty('--g4-sab', (bottom || 0) + 'px');
    r.style.setProperty('--g4-sal', (left || 0) + 'px');
  };

  /* ========================================================================
     软键盘避让（adjustNothing 配套）
     ------------------------------------------------------------------------
     软键盘弹出时 visualViewport.height 缩小 → 把当前可见高度写到 --g4-vvh，
     手机设置 / 规则 / 导入残局 用 var(--g4-vvh) 限定高度（见对应 CSS）。
     聚焦输入框主动滚到所在滚动容器中央，确保不被键盘遮住。
     整个 WebView 保持不动，画布不 pan/resize。
     ======================================================================== */
  function installKeyboardAvoid() {
    var vv = window.visualViewport;
    if (!vv) { return; }
    function onVV(){
      var r = document.documentElement;
      if (r) { r.style.setProperty('--g4-vvh', Math.round(vv.height) + 'px'); }
      var ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')){
        try { ae.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
      }
    }
    vv.addEventListener('resize', onVV);
    vv.addEventListener('scroll', onVV);
  }

  /* ========================================================================
     手势收起/折叠
     ------------------------------------------------------------------------
     pullDismiss(card, onClose)：底部弹出面板「下拖收起」——
       · 内容滚动到顶（scrollTop==0）时下拖，整卡跟手（带阻尼）
       · 松手超过阈值即滑出关闭；否则回弹
       · 内容未到顶时先正常滚动；滚到顶后继续下拖即触发（标准底栏行为）
     swipeLeftFold(panel, onFold)：左侧目录面板「左划折叠」
     ======================================================================== */
  function pullDismiss(card, onClose) {
    if (!card) { return; }
    var CLOSE_PX = 88, RESIST = 0.45;
    var stY = 0, dy = 0, tracking = false, engaged = false;
    function scrollTop() {
      try { return card.scrollTop || 0; } catch (e) { return 0; }
    }
    function springBack() {
      card.style.transition = 'transform .28s cubic-bezier(.2,.8,.3,1)';
      card.style.transform = '';
      setTimeout(function () { card.style.transition = ''; }, 300);
    }
    function finish() {
      if (!engaged) { tracking = false; return; }
      if (dy > CLOSE_PX) {
        card.style.transition = 'transform .22s ease';
        card.style.transform = 'translateY(120%)';
        setTimeout(onClose, 230);
      } else {
        springBack();
      }
      tracking = false; engaged = false;
    }
    card.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { tracking = false; return; }
      if (scrollTop() > 0) { tracking = false; return; }   // 内容未到顶 → 先允许正常滚动
      tracking = true; engaged = false; dy = 0;
      stY = e.touches[0].clientY;
    }, { passive: true });
    card.addEventListener('touchmove', function (e) {
      if (!tracking) { return; }
      var y = e.touches[0].clientY;
      dy = y - stY;
      if (!engaged) {
        if (dy > 10) { engaged = true; }                   // 下拖超 10px 开始跟手
        else if (dy < -2) { tracking = false; }            // 明显上滑则放弃
        return;
      }
      if (dy <= 0) { springBack(); tracking = false; return; }
      card.style.transition = 'none';
      card.style.transform = 'translateY(' + Math.round(dy * RESIST) + 'px)';
    }, { passive: true });
    card.addEventListener('touchend', finish, { passive: true });
    card.addEventListener('touchcancel', function () {
      if (engaged) { springBack(); }
      tracking = false; engaged = false;
    }, { passive: true });
  }

  function swipeLeftFold(panel, onFold) {
    /* 最终位判定（容忍起手抖动）：touchend 时算 dx/dy，水平主导且 dx<-40 即折叠。
       上一版 mid-move armed 遇到轻微竖向偏移即失败，改判定终态更稳。 */
    if (!panel) { return; }
    var sx = 0, sy = 0, tracking = false;
    panel.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { tracking = false; return; }
      tracking = true; sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    }, { passive: true });
    panel.addEventListener('touchend', function (e) {
      if (!tracking) { tracking = false; return; }
      tracking = false;
      var t = e.changedTouches && e.changedTouches[0];
      if (!t) { return; }
      var dx = t.clientX - sx, dy = t.clientY - sy;
      if (dx < -40 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        if (onFold) { onFold(); }
      }
    }, { passive: true });
    panel.addEventListener('touchcancel', function () { tracking = false; }, { passive: true });
  }

  /* ========================================================================
     ⑥ 生命周期
     ======================================================================== */
  window.__g4OnPause = function () { log('pause'); };
  window.__g4OnResume = function () { log('resume'); };
  /* 原生层在后台代跑 /api/poll，回到前台后统一回调挂起的请求，页面无感 */

  window.__g4Toast = function (msg) {
    if (hasN && N.toast) { try { N.toast(String(msg)); } catch (e) {} }
  };

  window.__G4MOBILE__ = {
    v: '1.0.0',
    ready: false,
    setTapToPlace: function (on) { TAP_PLACE = !!on; },
    getTapToPlace: function () { return TAP_PLACE; },
    pullDismiss: pullDismiss,
    swipeLeftFold: swipeLeftFold,
    log: log
  };

  function boot() {
    injectCss();
    fixText();
    installTouch(document.getElementById('cv'));
    installKeyboardAvoid();
    /* 规则说明底部弹出：下拖收起；目录面板：左划折叠 */
    var hb = document.getElementById('helpBox');
    if (hb) {
      pullDismiss(hb, function () {
        var h = document.getElementById('help');
        if (h) { h.classList.add('hidden'); }
      });
    }
    var pnl = document.getElementById('panel');
    if (pnl) {
      swipeLeftFold(pnl, function () {
        var f = document.getElementById('btnFold');
        if (f) { f.click(); }
      });
    }
    /* 折叠态的 ≡ 入口：右划展开（等效点击） */
    var tab = document.getElementById('tab');
    if (tab) {
      (function () {
        var sx = 0, sy = 0, tr = false;
        tab.addEventListener('touchstart', function (e) {
          tr = e.touches.length === 1;
          if (tr) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }
        }, { passive: true });
        tab.addEventListener('touchend', function (e) {
          if (!tr || !e.changedTouches.length) { tr = false; return; }
          tr = false;
          var x = e.changedTouches[0].clientX - sx;
          var y = e.changedTouches[0].clientY - sy;
          if (x > 46 && x > Math.abs(y)) { tab.click(); }
        }, { passive: true });
      })();
    }
    window.__G4MOBILE__.ready = true;
    try { var _p=document.getElementById('panel'); var _t=document.getElementById('tab'); log('dbg panel='+(_p?(_p.offsetWidth+'x'+_p.offsetHeight+' d='+getComputedStyle(_p).display):'NULL')+' tab='+(_t?_t.offsetWidth+'x'+_t.offsetHeight:'NULL')+' cv='+(document.getElementById('cv')?'ok':'NULL')); } catch(e){ log('dbg-err '+e.message); }
    log('ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
