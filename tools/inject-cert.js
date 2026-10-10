'use strict';
/* ============================================================
   inject-cert —— 把 tools/fixtures/cert-bundle.json 嵌进 index.html

   与 inject-solver.js 同样的理由：页面是**单文件**发行物，
   且内置 Worker 只复制主脚本 —— 外链的证书数据在 Worker 里拿不到。
   但**只嵌数据**（离线生成的小证书包），页面侧的查询逻辑是静态代码，
   不随核心膨胀；日常对局完全不走这条路（惰性解析）。

   用法：
     node tools/inject-cert.js            # 同步（写回 index.html）
     node tools/inject-cert.js --check    # 只校验是否已同步
   ============================================================ */
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', 'index.html');
const BUNDLE_PATH = path.join(__dirname, 'fixtures', 'cert-bundle.json');
const BEGIN = '/* ==CERT-BUNDLE-BEGIN== */';
const END = '/* ==CERT-BUNDLE-END== */';
const RE = /\/\* ==CERT-BUNDLE-BEGIN== \*\/[\s\S]*?\/\* ==CERT-BUNDLE-END== \*\//;

function bundleSource() {
  if (!fs.existsSync(BUNDLE_PATH)) return '';
  const txt = fs.readFileSync(BUNDLE_PATH, 'utf8').trim();
  // 用模板字符串承载 JSON：转义反引号、反斜杠与 ${（JSON 里正常不会出现，稳妥起见处理）
  const safe = txt.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return 'const CERT_BUNDLE_RAW = `' + safe + '`;';
}
function blockOf(src) { return BEGIN + '\n' + (src || 'const CERT_BUNDLE_RAW = "";') + '\n' + END; }

function main() {
  const check = process.argv.includes('--check');
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const block = blockOf(bundleSource());
  const found = html.match(RE);
  if (check) {
    if (!found) { console.error('未同步：index.html 里找不到 CERT-BUNDLE 标记区'); process.exit(1); }
    if (found[0].trim() !== block.trim()) {
      console.error('未同步：index.html 的证书包与 tools/fixtures/cert-bundle.json 不一致（请跑 node tools/inject-cert.js）');
      process.exit(1);
    }
    console.log('已同步：index.html 与 tools/fixtures/cert-bundle.json 一致。');
    return;
  }
  if (!found) {
    console.error('index.html 里找不到 CERT-BUNDLE 标记区，无法写入');
    process.exit(1);
  }
  fs.writeFileSync(HTML_PATH, html.replace(RE, block));
  console.log(`已同步：写入 ${block.length} 字符到 index.html（替换既有证书包标记区）`);
}

main();
