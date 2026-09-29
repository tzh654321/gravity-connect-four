const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const m = h.match(/globalThis\.__NNW = (\{[\s\S]*?\});/);
if (!m) { console.log('NO PAYLOAD'); process.exit(1); }
const o = JSON.parse(m[1]);
console.log('payload ok', o.layout.join('x'), 'W blocks', o.W.length);
console.log('nn button:', h.includes('data-nn="1"') ? 'yes' : 'no');
console.log('marker kept:', h.includes('NN-AI'));
console.log('diff labels:', JSON.stringify([...h.matchAll(/<button data-diff="([^"]+)"[^>]*>([^<]+)<\/button>/g)].map(x => x[1] + ':' + x[2])));
require('child_process').execSync('node -e "console.log(\'done\')"');