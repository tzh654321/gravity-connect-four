'use strict';
/* 一键将训练好的 16 维叶子模型注入 HTML，生成浏览器可直接运行的独立文件。
   用法：
     node tools/neural/inject.js --model tools/neural/model_leaf.json
                                 [--out 重力四子棋-nn.html]
   注入方式：在 </body> 前插入 <script>globalThis.__NNW={...};</script>；
   浏览器加载后，选「困难」即自动启用 quietNega + 叶子价值网络。
   env.js 的 regex 只提取第一个 <script>，因此注入的第二个脚本不影响 Node 端加载。
   ============================================================ */
const fs = require('fs'), path = require('path');

function arg(name, def){ const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; }

const ROOT = path.join(__dirname, '..', '..');
const HTML_IN  = arg('html', path.join(ROOT, 'index.html'));
const MODEL    = arg('model', '');
const HTML_OUT = arg('out',  path.join(ROOT, '重力四子棋-nn.html'));
// --feat p2：标记该模型用的是哪套特征函数，HTML 端据此选择（p2=镜像不变化16维）
const FEAT = arg('feat', '');
const MARKER   = '<!-- ============ NN-AI 权重注入（由 tools/neural/inject.js 自动填充，勿手改） ============ -->';

if (!MODEL){
  console.error('用法: node inject.js --model path/to/model.json [--out path.html]');
  process.exit(1);
}

const modelObj = JSON.parse(fs.readFileSync(MODEL, 'utf8'));
if (FEAT) modelObj.feat = FEAT;          // 供 HTML 的 nnFeatFor 选择对应特征函数
const json = JSON.stringify(modelObj);
// 对可能的 </script> 做转义
const safeJson = json.replace(/<\//g, '<\\/');
const tag = '<script>globalThis.__NNW = ' + safeJson + ';</script>\n';

let html = fs.readFileSync(HTML_IN, 'utf8');
if (html.includes('globalThis.__NNW')){
  html = html.replace(/<script>globalThis\.__NNW = [^<]*<\/script>\n?/g, '');
}
if (!html.includes(MARKER)){
  console.error('未找到权重注入标记：' + MARKER);
  process.exit(1);
}
html = html.replace(MARKER, tag + MARKER);

fs.writeFileSync(HTML_OUT, html, 'utf8');
console.log('已注入模型（' + MODEL + '，' + modelObj.layout.join('×') + '）→ ' + HTML_OUT);
