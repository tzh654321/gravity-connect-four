'use strict';
/* ============================================================
   inject-solver —— 把 tools/solver-core.js 同步进 index.html 的主脚本

   为什么必须"内联"而不是 <script src>：
   - 页面是**单文件**发行物，且 Android 资产由 index.html 生成；
   - 页面内置 Worker 用 Blob 只复制**主脚本**（含 `function aiChooseMove` 的那块），
     外链脚本不会进 Worker，导致 Worker 里 GravitySolver 未定义。
   内联后：单文件语义、Worker 语义、Android 资产三者一次性都对。
   这与 tools/neural/inject.js 注入 __NNW 权重是同一种做法。

   用法：
     node tools/inject-solver.js          # 同步（写回 index.html）
     node tools/inject-solver.js --check  # 只校验是否已同步（CI/回归用）
   ============================================================ */
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', 'index.html');
const CORE_PATH = path.join(__dirname, 'solver-core.js');
const BEGIN = '/* ==SOLVER-CORE-BEGIN== */';
const END = '/* ==SOLVER-CORE-END== */';
const ANCHOR = 'const P1 = 1, P2 = 2, BLOCK = 3;';
const RE = /\/\* ==SOLVER-CORE-BEGIN== \*\/[\s\S]*?\/\* ==SOLVER-CORE-END== \*\//;

function coreSource() {
  // 去掉文件头的 'use strict'（内联到主脚本中部后它已不是指令位置，留着只是噪声）
  return fs.readFileSync(CORE_PATH, 'utf8').replace(/^\s*'use strict';\s*/, '').trim();
}
function blockOf(src) { return BEGIN + '\n' + src + '\n' + END; }

function main() {
  const check = process.argv.includes('--check');
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const block = blockOf(coreSource());
  const found = html.match(RE);

  if (check) {
    if (!found) { console.error('未同步：index.html 里找不到 SOLVER-CORE 标记区'); process.exit(1); }
    if (found[0].trim() !== block.trim()) {
      console.error('未同步：index.html 的标记区与 tools/solver-core.js 不一致，请运行 node tools/inject-solver.js');
      process.exit(1);
    }
    console.log('已同步：index.html 与 tools/solver-core.js 一致。');
    return;
  }

  let out;
  if (found) {
    // 用函数式替换，避免源码里的 $& / $' 等被当作替换模式
    out = html.replace(RE, () => block);
  } else {
    if (!html.includes(ANCHOR)) throw new Error('找不到注入锚点：' + ANCHOR);
    out = html.replace(ANCHOR, ANCHOR + '\n' + block);
  }
  if (out === html) { console.log('无需改动（内容一致）。'); return; }
  fs.writeFileSync(HTML_PATH, out);
  console.log(`已同步：写入 ${block.length} 字符到 index.html` + (found ? '（替换既有标记区）' : '（首次注入锚点后）'));
}

main();
