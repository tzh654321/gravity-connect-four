'use strict';
/* ============================================================
   优化 NN 算法 —— 编排器（按路线图的 P0/P1）
   流程：自博弈采集 → TD(n) 价值网络训练 → Elo 天梯评测 → (训练轮)注入 HTML
   用法：
     node run_opt.js trial            # 小样本试运行，验证无报错 + loss 下降 + 不强于基线
     node run_opt.js train --round 1  # 正式训练轮（可后台跑），默认从 model_leaf.json 热启动
     node run_opt.js train --round 2 --init tools/neural/opt/model_pv.json  # 基于上轮自举
   说明：baseline（旧模型）固定为 tools/neural/model_leaf.json（16维当前价值网），
        保证 ExIt 自举链：每轮自博弈用上轮产出模型，逐步脱离教师锁。
   ============================================================ */
const { spawnSync } = require('child_process');
const fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..'); // run_opt.js 在 tools/neural/opt/，需三级 .. 才回到项目根
const OPT = path.join(ROOT, 'tools', 'neural', 'opt');
const NEURAL = path.join(ROOT, 'tools', 'neural');
const NODE = process.env.WB_NODE || 'C:/Users/tzh/.workbuddy/binaries/node/versions/22.22.2/node.exe';
const BASELINE = path.join(NEURAL, 'model_leaf.json');
const INJECT_BASE = path.join(ROOT, '重力四子棋-nn-opt'); // 按轮次加 -rN 后缀，避免覆盖
const WORKERS = Math.min(require('os').cpus().length || 4, 24); // 多核：自博弈/评测并行扇出

function run(scriptRel, args, label){
  console.log('\n===== ' + label + ' =====');
  const r = spawnSync(NODE, [path.join(OPT, scriptRel), ...args], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0){ throw new Error(label + ' 失败 (exit ' + r.status + ')'); }
  return r;
}

function parseElo(jsonPath){
  try { return JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch(e){ return null; }
}

function main(){
  const mode = process.argv[2] || 'trial';
  const argv = process.argv.slice(3);
  const getArg = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };

  const round = getArg('round', '1');
  const init = getArg('init', BASELINE);
  const tag = (mode === 'trial') ? getArg('tag', 'trial') : ('r' + round);

  const spOut = path.join(OPT, 'data', 'sp_' + tag + '.jsonl');
  const modelOut = path.join(OPT, 'model_pv' + (mode === 'trial' ? '_trial' : '_r' + round) + '.json');
  const eloOut = path.join(OPT, 'eval_' + tag + '.json');

  if (mode === 'trial'){
    const GAMES = +getArg('games', '30');
    const SIMS = +getArg('sims', '60');
    const EPOCHS = +getArg('epochs', '20');
    const EGAMES = +getArg('egames', '8');
    const ESIMS = +getArg('esims', '50');
    run('selfplay.js', ['--games', GAMES, '--sims', SIMS, '--out', spOut, '--model', init, '--workers', WORKERS], '自博弈采集(' + WORKERS + '核)');
    run('train_pv.js', ['--data', spOut, '--init', init, '--out', modelOut, '--epochs', EPOCHS, '--td', '3'], 'TD(n) 训练');
    run('eval_elo.js', ['--model', modelOut, '--old', BASELINE, '--games', EGAMES, '--sims', ESIMS, '--out', eloOut, '--workers', WORKERS], 'Elo 天梯评测(' + WORKERS + '核)');
    const elo = parseElo(eloOut);
    if (elo){
      const vsHard = (elo.perOpp.find(o => o.key === 'hard') || {}).scoreRate;
      const vsOld = (elo.perOpp.find(o => o.key === 'old_mcts') || {}).scoreRate;
      console.log('\n[trial 结论] NEW Elo=' + elo.newElo + '  vs hard=' + vsHard + '  vs old_mcts=' + vsOld);
      const ok = parseFloat(vsHard) >= 0.35 && parseFloat(vsOld) >= 0.30;
      console.log(ok ? '✅ 试运行通过：无报错且未明显弱于基线，可启动正式训练。' : '⚠️ 试运行偏弱，建议检查超参后再训练。');
    }
    return;
  }

  if (mode === 'train'){
    const GAMES = +getArg('games', '200');
    const SIMS = +getArg('sims', '150');
    const EPOCHS = +getArg('epochs', '40');
    const EGAMES = +getArg('egames', '16');
    const ESIMS = +getArg('esims', '80');
    run('selfplay.js', ['--games', GAMES, '--sims', SIMS, '--out', spOut, '--model', init, '--workers', WORKERS], '自博弈采集(round ' + round + ', ' + WORKERS + '核)');
    run('train_pv.js', ['--data', spOut, '--init', init, '--out', modelOut, '--epochs', EPOCHS, '--td', '3'], 'TD(n) 训练(round ' + round + ')');
    run('eval_elo.js', ['--model', modelOut, '--old', BASELINE, '--games', EGAMES, '--sims', ESIMS, '--out', eloOut, '--workers', WORKERS], 'Elo 天梯评测(round ' + round + ', ' + WORKERS + '核)');
    // 注入 HTML：生成可用版本（不覆盖现有 nn 文件）
    const injectOut = INJECT_BASE + '-r' + round + '.html';
    run('../inject.js', ['--model', modelOut, '--out', injectOut], '注入 HTML (' + path.basename(injectOut) + ')');
    const elo = parseElo(eloOut);
    console.log('\n[train 完成] round=' + round + ' model=' + modelOut);
    if (elo) console.log('NEW Elo=' + elo.newElo + ' 明细 ' + eloOut);
    return;
  }

  if (mode === 'p2'){
    // P2 特征增广（从头训，避开跨特征空间热启动）：
    //   复用已生成的 sp_p2.jsonl（已在 features_p2 空间），训练网从随机初始化开始，
    //   冻结目标网也先在 P2 同空间用终端标签预训几轮 → 杜绝旧权重语义错配。
    //   维度仍 16 维 → 可直接注入浏览器 hard 搜索。
    process.env.OPT_FEAT = './features_p2';
    const GAMES = +getArg('games', '300');
    const SIMS = +getArg('sims', '180');
    const EPOCHS = +getArg('epochs', '90');
    const TEPOCHS = +getArg('targetEpochs', '15');
    const EGAMES = +getArg('egames', '24');
    const ESIMS = +getArg('esims', '100');
    const spOut = path.join(OPT, 'data', 'sp_p2.jsonl'); // 复用既有 P2 特征数据
    const modelOut = path.join(OPT, 'model_p2.json');
    const eloOut = path.join(OPT, 'eval_p2.json');
    const injectOut = path.join(ROOT, '重力四子棋-nn-opt-p2.html');
    if (!fs.existsSync(spOut)){ // 数据缺失才重新采集
      run('selfplay.js', ['--games', GAMES, '--sims', SIMS, '--out', spOut, '--model', path.join(OPT, 'model_pv_r2.json'), '--workers', WORKERS], 'P2 自博弈采集(' + WORKERS + '核, 镜像不变特征)');
    } else {
      console.log('\n===== 复用既有 P2 特征数据 ' + spOut + '（跳过自博弈采集）=====');
    }
    run('train_pv.js', ['--fresh', '--layout', '16,64,64,32,1', '--data', spOut, '--out', modelOut, '--epochs', EPOCHS, '--td', '3', '--targetEpochs', TEPOCHS], 'P2 TD(n) 训练(从头, ' + EPOCHS + 'ep + 目标网' + TEPOCHS + 'ep)');
    run('eval_elo.js', ['--model', modelOut, '--old', path.join(OPT, 'model_pv_r2.json'), '--games', EGAMES, '--sims', ESIMS, '--out', eloOut, '--workers', WORKERS], 'P2 Elo 天梯评测(' + WORKERS + '核, vs round2)');
    run('../inject.js', ['--model', modelOut, '--out', injectOut], '注入 HTML (' + path.basename(injectOut) + ')');
    const elo = parseElo(eloOut);
    console.log('\n[P2 完成] model=' + modelOut);
    if (elo){
      const vsR2 = (elo.perOpp.find(o => o.key === 'old_mcts') || {}).scoreRate;
      console.log('P2 NEW Elo=' + elo.newElo + '  直接对比 round2(old_mcts项)=' + vsR2 + '  明细 ' + eloOut);
    }
    return;
  }

  if (mode === 'p2r2'){
    // P2 第二轮 ExIt 自举（解决上一轮两个问题）：
    //   1) 数据不匹配：sp_p2.jsonl 是「round2 模型跑在 P2 特征空间」采的（模型与特征空间错配，数据次优）。
    //      本轮改用已在 P2 空间训好的 model_p2.json 当 agent 自采 → 模型与特征空间一致。
    //   2) 数据太少（真瓶颈）：300 局仅 ~4000 状态、网络 30 epoch 即饱和 → 局数 300 → 2500（约 ×8）。
    // 热启动（非 --fresh）：init=model_p2，与 round1→round2 自举同一套范式（同特征空间热启动是安全的，
    // 上一轮 P2 回归的根因是「跨特征空间」热启动，本轮不存在该问题）。
    process.env.OPT_FEAT = './features_p2';
    const GAMES = +getArg('games', '2500');
    const SIMS = +getArg('sims', '180');
    const EPOCHS = +getArg('epochs', '40');
    const EGAMES = +getArg('egames', '40');
    const ESIMS = +getArg('esims', '100');
    const AGENT = path.join(OPT, 'model_p2.json');        // 同空间自举：让 P2 模型自己采数据
    const R2 = path.join(OPT, 'model_pv_r2.json');        // 评测锚点：round2
    const spOut = path.join(OPT, 'data', 'sp_p2r2.jsonl');
    // --out 可改名（冒烟测试用）：train_pv 非 fresh 路径会优先加载已存在的 OUT 热启动，必须避免污染真实产物
    const outName = getArg('out', 'model_p2r2.json');
    const modelOut = path.isAbsolute(outName) ? outName : path.join(OPT, outName);
    const eloOut = path.join(OPT, 'eval_p2r2.json');
    const injectOut = path.join(ROOT, '重力四子棋-nn-opt-p2r2.html');
    run('selfplay.js', ['--games', GAMES, '--sims', SIMS, '--out', spOut, '--model', AGENT, '--workers', WORKERS], 'P2r2 自博弈采集(' + GAMES + '局, ' + WORKERS + '核, agent=model_p2 同空间)');
    run('train_pv.js', ['--init', AGENT, '--data', spOut, '--out', modelOut, '--epochs', EPOCHS, '--td', '3'], 'P2r2 TD(n) 训练(热启动 model_p2, ' + EPOCHS + 'ep)');
    run('eval_elo.js', ['--model', modelOut, '--old', R2, '--games', EGAMES, '--sims', ESIMS, '--out', eloOut, '--workers', WORKERS], 'P2r2 Elo 天梯评测(' + WORKERS + '核, vs round2)');
    run('../inject.js', ['--model', modelOut, '--out', injectOut], '注入 HTML (' + path.basename(injectOut) + ')');
    const elo = parseElo(eloOut);
    console.log('\n[P2r2 完成] model=' + modelOut);
    if (elo){
      const vsR2 = (elo.perOpp.find(o => o.key === 'old_mcts') || {}).scoreRate;
      const vsHard = (elo.perOpp.find(o => o.key === 'hard') || {}).scoreRate;
      console.log('P2r2 NEW Elo=' + elo.newElo + '  vs round2(old_mcts)=' + vsR2 + '  vs hard=' + vsHard + '  明细 ' + eloOut);
    }
    return;
  }
  console.error('未知模式: ' + mode + '（用 trial / train / p2 / p2r2）');
  process.exit(1);
}
try { main(); } catch (e){ console.error(e.message); process.exit(1); }
