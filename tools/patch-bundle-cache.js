'use strict';
/* 把共享 boundCache 接进 make-cert-bundle：判定表与"长证书对比"问的是**同一个 (局面,N)**，
   后者应直接复用前者（离线流水线里这是真实存在的重复查询）。用 --boundCache 0 可关闭以做对照。 */
const fs = require('fs');
const p = 'tools/make-cert-bundle.js';
let s = fs.readFileSync(p, 'utf8');
let n = 0;
const rep = (a, b, label) => {
  if (s.indexOf(a) < 0) { console.error('未找到：' + label); process.exit(1); }
  s = s.replace(a, b); n++;
};
rep("  certifyRoot, chooseMoveCertified, winPointsAll, RULE_VERSION, boardCanon\n} = require('./solver-core');",
    "  certifyRoot, chooseMoveCertified, winPointsAll, RULE_VERSION, boardCanon, createBoundCache\n} = require('./solver-core');",
    'import');
rep("  const outPath = argOf('out', 'tools/fixtures/cert-bundle.json');",
    "  const outPath = argOf('out', 'tools/fixtures/cert-bundle.json');\n  const boundCache = argOf('boundCache', '1') !== '0' ? createBoundCache() : null;",
    'create cache');
rep("    certify: { maxNodes, timeMs, tighten: false }     // 判定表用\"上界\"口径，收紧另做",
    "    certify: { maxNodes, timeMs, tighten: false, boundCache }   // 判定表用\"上界\"口径，收紧另做；boundCache 让重复查询可复用",
    'thread into certify');
rep("      const lr = dfpnSearch(child, attacker, { maxPlies: verdictHorizon, maxNodes, timeMs });",
    "      // 同一 (child, attacker, N) 判定表已经查过 ⇒ 这里应命中区间复用（0 节点）\n      const lr = dfpnSearch(child, attacker, { maxPlies: verdictHorizon, maxNodes, timeMs, boundCache });",
    'thread into long compare');
rep("  console.log(`\n  已写入 ${outPath}（${(bytes / 1024).toFixed(1)} KB）`);",
    "  if (boundCache) console.log(`  区间缓存：查询 ${boundCache.queries} 结论命中 ${boundCache.hitsVerdict} 证书复用 ${boundCache.hitsCert} ` +\n    `结论命中但无证书 ${boundCache.verdictOnlyMiss} 写入 ${boundCache.stores}`);\n  console.log(`\n  已写入 ${outPath}（${(bytes / 1024).toFixed(1)} KB）`);",
    'print counters');
fs.writeFileSync(p, s);
console.log('make-cert-bundle 已接共享 boundCache，共改 ' + n + ' 处');
