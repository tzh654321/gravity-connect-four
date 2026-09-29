'use strict';
/* ============================================================
   P2 特征增广（保持 16 维 → 可直接注入浏览器 hard 搜索，兼容现有 HTML）
   目标：修复根因「镜像特征无法区分行棋方优劣」+ 增加真实新信号
   做法：
     1) 镜像不变：对棋盘做 x→-x 反射，算原特征与镜像特征，逐维取 max
        → 表示对左右镜像不变（重力方向竖直，左右反射是本游戏唯一真实对称）
     2) 增广新信号（替换信息量最低的两维）：
        f[14] = 机动性 = log1p(唯一落点数) 归一化
        f[15] = 威胁差 = log1p(我方3连) - log1p(对方3连)
   注：机动性与威胁差本身就对镜像不变，故全 16 维均镜像不变。
   ============================================================ */
const { features, windowCounts } = require('../features');

function mirrorOcc(G){
  const m = new Map();
  for (const [k, v] of G.occ){
    const i = k.indexOf(',');
    const x = -(+k.slice(0, i)), y = +k.slice(i + 1);
    m.set(x + ',' + y, v);
  }
  return m;
}

function mirrorFeatures(G, me, op){
  const save = G.occ;
  G.occ = mirrorOcc(G);
  const f = features(G, me, op);   // 在镜像棋盘上算原 16 维特征
  G.occ = save;
  return f;
}

function features_p2(G, me, op){
  const base = features(G, me, op);      // 16 维（me/op 视角）
  const mir = mirrorFeatures(G, me, op); // 16 维（镜像视角）
  const f = new Float64Array(16);
  // (1) 镜像不变：逐维 max
  for (let i = 0; i < 16; i++) f[i] = Math.max(base[i], mir[i]);
  // (2) 增广新信号
  const cs = G.genCandidates();
  const seen = new Set();
  for (const c of cs){ const l = G.settleDiscrete(c.x, c.y); seen.add(G.K(l.x, l.y)); }
  const wc = windowCounts(G, me, op);
  f[14] = Math.log1p(seen.size) - 2.0;            // 机动性（落点越多越灵活）
  f[15] = Math.log1p(wc[2]) - Math.log1p(wc[5]);  // 我方3连 - 对方3连（威胁差）
  return f;
}

module.exports = { features: features_p2, FEAT_DIM: 16, mirrorFeatures };
