/* ==========================================================================
   g4-settings.js · 手机设置面板（运行时注入，不修改游戏页面）
   --------------------------------------------------------------------------
   在面板底部追加「手机设置」按钮，展开后提供：联机模式切换、服务器地址、
   本机地址、单击落子、屏幕常亮、后台保活与电池优化授权、页面热更新导入。
   ========================================================================== */
(function () {
  'use strict';
  var N = window.G4Native;
  if (!N) { return; }
  if (window.__G4SETTINGS__) { return; }
  window.__G4SETTINGS__ = 1;

  var cfg = {};
  function readCfg() {
    try { cfg = JSON.parse(N.getConfig()) || {}; } catch (e) { cfg = {}; }
  }
  function save(patch) {
    var o = {};
    for (var k in cfg) { if (Object.prototype.hasOwnProperty.call(cfg, k)) o[k] = cfg[k]; }
    for (var j in patch) { if (Object.prototype.hasOwnProperty.call(patch, j)) o[j] = patch[j]; }
    cfg = o;
    try { N.setConfig(JSON.stringify(o)); } catch (e) {}
  }

  /* ---------------- 样式 ---------------- */
  var st = document.createElement('style');
  st.setAttribute('data-g4s', '1');
  st.appendChild(document.createTextNode([
    '#g4sBtn{width:100%;margin-top:8px;padding:9px 6px;font-size:12px}',
    '.g4sWrap{position:fixed;left:0;top:0;right:0;bottom:0;z-index:99;display:none;',
    ' background:rgba(16,20,30,0);align-items:flex-end;transition:background .22s ease}',
    '.g4sWrap.open{display:flex;background:rgba(16,20,30,.45)}',
    '.g4sWrap.closing{background:rgba(16,20,30,0)}',
    '.g4sCard{background:#fff;border-radius:16px 16px 0 0;padding:18px 18px calc(20px + var(--g4-sab,0px));',
    ' max-height:calc(var(--g4-vvh,100vh) - var(--g4-sat,0px) - var(--g4-sab,0px));',
    ' overflow-y:auto;-webkit-overflow-scrolling:touch;width:100%;',
    ' box-shadow:0 -8px 30px rgba(0,0,0,.2);font-size:13px;color:#22262e;',
    ' transform:translateY(46px);opacity:0;transition:transform .26s cubic-bezier(.16,1,.3,1),opacity .26s}',
    '.g4sWrap.open .g4sCard{transform:translateY(0);opacity:1}',
    '.g4sWrap.closing .g4sCard{transform:translateY(46px);opacity:0}',
    '.g4sCard h3{margin:0 0 10px;font-size:16px;font-weight:600}',
    '.g4sRow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-top:1px solid #eceff4}',
    '.g4sRow:first-of-type{border-top:0}',
    '.g4sLbl{font-size:13px}',
    '.g4sSub{font-size:11.5px;color:#7c828d;margin-top:2px;line-height:1.5}',
    '/* 输入行右侧统一区块：本机端口 / 远端服务器 输入框宽度对齐 */',
    '.g4sVal{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;max-width:62%;justify-content:flex-end}',
    '.g4sVal .g4sInput{flex:1 1 auto;min-width:0}',
    '.g4sInput{padding:8px 9px;font-size:12.5px;border:1px solid #d5dae2;',
    ' border-radius:8px;background:#fff;color:#222}',
    '.g4sBtn{padding:8px 12px;font-size:12.5px;border:1px solid #d5dae2;background:#f6f7f9;',
    ' border-radius:8px;color:#333a45;white-space:nowrap}',
    '.g4sBtn.pri{background:#2f6fd0;border-color:#2f6fd0;color:#fff}',
    '/* 底部关闭按钮：与规则说明「知道了」同位置同款式 */',
    '.g4sCloseRow{margin-top:14px;display:flex;justify-content:flex-end;border-top:1px dashed #eceff4;padding-top:12px}',
    '.g4sCloseRow button{padding:7px 18px;font-size:12.5px;background:#242932;color:#fff;border:none;border-radius:8px;cursor:pointer;font-family:inherit}',
    '.g4sSw{width:48px;height:28px;border-radius:14px;background:#cfd5de;position:relative;flex:none;',
    ' transition:background .22s cubic-bezier(.4,0,.2,1);border:0;cursor:pointer;outline:none}',
    '.g4sSw::after{content:"";position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;',
    ' background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .22s cubic-bezier(.4,0,.2,1)}',
    '.g4sSw.on{background:#2f6fd0}',
    '.g4sSw.on::after{transform:translateX(20px)}',
    '.g4sSw:active::after{width:26px}',
    '.g4sAddr{display:flex;align-items:center;gap:8px;min-width:0}',
    '.g4sAddr .g4sMono{flex:1;min-width:0;font-family:monospace;font-size:12px;background:#f2f4f8;padding:6px 8px;border-radius:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.g4sGrid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px;align-items:stretch}',
    '.g4sGrid .g4sBtn{display:flex;align-items:center;justify-content:center;min-height:38px}',
    '/* 「导入残局」与「手机设置」按钮同行等高：保证两个按钮高度一致 */',
    '#g4sBtn,#btnLoad{height:34px;box-sizing:border-box;display:flex;align-items:center;justify-content:center}'
  ].join('')));
  document.head.appendChild(st);

  /* ---------------- 结构 ---------------- */
  var wrap = document.createElement('div');
  wrap.className = 'g4sWrap';
  var card = document.createElement('div');
  card.className = 'g4sCard';
  wrap.appendChild(card);

  var title = document.createElement('h3');
  title.textContent = '手机设置';
  card.appendChild(title);

  function row(label, sub) {
    var r = document.createElement('div');
    r.className = 'g4sRow';
    var box = document.createElement('div');
    var l = document.createElement('div');
    l.className = 'g4sLbl';
    l.textContent = label;
    box.appendChild(l);
    if (sub) {
      var s = document.createElement('div');
      s.className = 'g4sSub';
      s.textContent = sub;
      box.appendChild(s);
    }
    r.appendChild(box);
    card.appendChild(r);
    return r;
  }
  function mkSwitch(on, onChange) {
    var b = document.createElement('button');
    b.className = 'g4sSw' + (on ? ' on' : '');
    b.onclick = function () {
      b.className = 'g4sSw' + (b.className.indexOf('on') < 0 ? ' on' : '');
      onChange(b.className.indexOf('on') >= 0);
    };
    return b;
  }

  /* 本机地址 + 复制按钮同行 */
  var addrRow = row('本机地址', '把地址发给对手，对方用浏览器打开即可加入');
  var addrBox = document.createElement('div');
  addrBox.className = 'g4sAddr';
  var addrText = document.createElement('div');
  addrText.className = 'g4sMono';
  var addrCopy = document.createElement('button');
  addrCopy.className = 'g4sBtn';
  addrCopy.textContent = '复制';
  addrCopy.onclick = function () { N.copy(addrText.textContent); N.toast('地址已复制'); };
  addrBox.appendChild(addrText);
  addrBox.appendChild(addrCopy);
  addrRow.appendChild(addrBox);

  /* 端口 */
  var portRow = row('本机端口', '修改后自动重启本机服务器');
  var portVal = document.createElement('div');
  portVal.className = 'g4sVal';
  var portInput = document.createElement('input');
  portInput.className = 'g4sInput';
  portInput.inputMode = 'numeric';
  portInput.maxLength = 5;
  portInput.style.maxWidth = '96px';
  portInput.style.textAlign = 'right';
  var portBtn = document.createElement('button');
  portBtn.className = 'g4sBtn';
  portBtn.textContent = '应用';
  portBtn.onclick = function () {
    var p = parseInt(portInput.value, 10);
    if (!p || p < 1024 || p > 65535) { N.toast('端口需在 1024-65535'); return; }
    save({ port: p });
    N.toast('已应用端口 ' + p);
    refresh();
  };
  portVal.appendChild(portInput);
  portVal.appendChild(portBtn);
  portRow.appendChild(portVal);

  /* 远端地址 */
  var baseRow = row('远端服务器', '对方机器上跑 node 四子棋服务器.js 时的地址；留空则用本机服务器');
  var baseVal = document.createElement('div');
  baseVal.className = 'g4sVal';
  var baseInput = document.createElement('input');
  baseInput.className = 'g4sInput';
  baseInput.placeholder = '192.168.1.5:8765';
  var baseBtn = document.createElement('button');
  baseBtn.className = 'g4sBtn pri';
  baseBtn.textContent = '保存';
  baseBtn.onclick = function () {
    save({ base: baseInput.value });
    N.toast('已保存，正在重连');
    refresh();
  };
  baseVal.appendChild(baseInput);
  baseVal.appendChild(baseBtn);
  baseRow.appendChild(baseVal);

  /* 开关 */
  var tapRow = row('单击落子', '默认双击落子以防范误触；开启后单击即可落子');
  var tapSw = mkSwitch(false, function (v) { save({ tap: v }); });
  tapRow.appendChild(tapSw);

  var scrRow = row('屏幕常亮', '对局中不自动息屏');
  var scrSw = mkSwitch(true, function (v) { save({ screen: v }); });
  scrRow.appendChild(scrSw);

  var aliveRow = row('后台保活', '退到后台或息屏后继续接收对手落子，并常驻通知');
  var aliveSw = mkSwitch(true, function (v) { save({ alive: v }); });
  aliveRow.appendChild(aliveSw);

  var battRow = row('电池优化', '国产 ROM 需手动允许后台运行，否则保活可能被系统中断');
  var battBtn = document.createElement('button');
  battBtn.className = 'g4sBtn';
  battBtn.textContent = '去授权';
  battBtn.onclick = function () { N.batteryOpt(); };
  battRow.appendChild(battBtn);

  /* 页面来源 */
  var srcRow = row('页面来源', '更新游戏只需导入新的 HTML，无需重新打包');
  var srcBox = document.createElement('div');
  srcBox.style.textAlign = 'right';
  var srcGame = document.createElement('div');
  srcGame.className = 'g4sSub';
  var srcShim = document.createElement('div');
  srcShim.className = 'g4sSub';
  srcBox.appendChild(srcGame);
  srcBox.appendChild(srcShim);
  srcRow.appendChild(srcBox);

  /* 操作按钮 */
  var grid = document.createElement('div');
  grid.className = 'g4sGrid';
  function gbtn(text, fn, pri) {
    var b = document.createElement('button');
    b.className = 'g4sBtn' + (pri ? ' pri' : '');
    b.textContent = text;
    b.onclick = fn;
    grid.appendChild(b);
    return b;
  }
  gbtn('导入 HTML', function () { N.importHtml(); });
  gbtn('恢复内置', function () { N.clearOverrides(); });
  gbtn('重新加载', function () { N.reload(); });
  gbtn('复制本机地址', function () { N.copy(addrText.textContent); N.toast('地址已复制'); });
  card.appendChild(grid);

  /* 底部关闭按钮（与规则说明「知道了」同位置同款式） */
  var closeRow = document.createElement('div');
  closeRow.className = 'g4sCloseRow';
  var closeBtn = document.createElement('button');
  closeBtn.textContent = '关闭';
  closeRow.appendChild(closeBtn);
  card.appendChild(closeRow);

  document.body.appendChild(wrap);

  /* 入口按钮 */
  var open = document.createElement('button');
  open.id = 'g4sBtn';
  open.textContent = '手机设置';
  function showSettings(){
    wrap.classList.remove('closing');
    /* 清掉下拉/上次关闭可能残留的内联 transform，确保重新打开时从收起态入场 */
    card.style.transition = '';
    card.style.transform = '';
    wrap.style.display = 'flex';
    /* 下一帧添加 .open，触发 transition（从 transform:translateY(46px) 到 translateY(0)） */
    requestAnimationFrame(function(){ wrap.classList.add('open'); });
    refresh();
  }
  function hideSettings(){
    if (wrap.style.display !== 'flex') return;
    wrap.classList.remove('open');
    wrap.classList.add('closing');
    var done = false;
    function finish(){
      if (done) return;
      done = true;
      wrap.classList.remove('closing');
      wrap.style.display = 'none';
    }
    /* 监听卡片 transitionend（最长 260ms）；兜底 400ms 强收 */
    var tEnd = function(ev){
      if (ev && ev.target !== card) return;
      finish();
      card.removeEventListener('transitionend', tEnd);
    };
    card.addEventListener('transitionend', tEnd);
    setTimeout(finish, 420);
  }
  open.onclick = function(){
    if (wrap.style.display === 'flex') hideSettings(); else showSettings();
  };
  closeBtn.onclick = hideSettings;
  wrap.addEventListener('click', function (e) { if (e.target === wrap) hideSettings(); });
  /* 下拉收起：整卡下拖到阈值即隐藏（内容需已滚到顶部） */
  if (window.__G4MOBILE__ && window.__G4MOBILE__.pullDismiss){
    window.__G4MOBILE__.pullDismiss(card, hideSettings);
  }
  window.__G4SETTINGS__ = { close: hideSettings, open: showSettings, wrap: wrap, card: card };

  function attach() {
    var panel = document.getElementById('panel');
    var host = panel && panel.querySelector('.btns');
    /* 让「导入残局」与「手机设置」同行：取消残局按钮的整行跨越 */
    var loadBtn = document.getElementById('btnLoad');
    if (loadBtn) loadBtn.style.gridColumn = 'auto';
    (host || panel || document.body).appendChild(open);
  }
  attach();

  function refresh() {
    readCfg();
    var ip = cfg.ip || '0.0.0.0';
    addrText.textContent = 'http://' + ip + ':' + (cfg.port || 8765);
    if (document.activeElement !== portInput) portInput.value = String(cfg.port || 8765);
    if (document.activeElement !== baseInput) baseInput.value = cfg.base || '';
    setSw(tapSw, !!cfg.tap);
    setSw(scrSw, cfg.screen !== false);
    setSw(aliveSw, cfg.alive !== false);
    srcGame.textContent = '页面 ' + (cfg.htmlSrc || '');
    srcShim.textContent = '适配层 ' + (cfg.shimSrc || '');
  }
  function setSw(b, on) { b.className = 'g4sSw' + (on ? ' on' : ''); }

  refresh();
  if (window.__G4MOBILE__) window.__G4MOBILE__.settingsReady = true;
})();
