# tools — AI 研发与评测工具链

所有 Node 侧脚本都通过 **`game-sandbox.js`** 加载仓库根的 `index.html`，
它把两个易错点集中处理掉了（改脚本时别绕过它）：

1. 页面里有**两个** `<script>`（游戏逻辑 + 注入的 `__NNW` 权重）→ 必须非贪婪提取；
2. `aiChooseMove` 是 **async** 函数 → 调用处必须 `await`，且沙箱的 `requestAnimationFrame`
   要在加载后被换成「同步触发」，否则 `await` 会永久挂起。

```js
const { loadGame, drain } = require('./game-sandbox');
const G = loadGame(null, 'state,addP,set occ(v){occ=v},get occ(){return occ},' +
                        'aiChooseMove,placePiece,updateMoving,K,P1,P2,BLOCK');
const d = await G.aiChooseMove();          // ← 别忘了 await
```

> 详见 [../docs/06-已知问题.md](../docs/06-已知问题.md) 第 2 条（含修复前后实测数据）。

## 启发式调试与评测

| 脚本 | 说明 |
|---|---|
| `game-sandbox.js` | 统一沙箱加载器（非贪婪提取 + rAF 补丁 + `drain`/`resetTo` 助手） |
| `tune-weights.js` | 差分进化调优启发式权重（与基线自博弈，红蓝交替抵消先手优势） |
| `parallel-selfplay.js` | worker_threads 池并行自博弈，先测并发 1 基线再打印加速比 |
| `selfplay-core.js` / `single-selfplay.js` / `spa-worker.js` | 并行自博弈的沙箱与 worker 核心 |
| `ab-ai-check.js` | A/B 两版页面同局面选点对比 + 威胁链单元测试 + 单步性能预算 |
| `ai-stats.js` | 困难 vs 困难批量对局统计（红蓝/斜直获胜、步数、对称同构局） |
| `drive.js` | 命令行「我下棋、AI 应手」交互驱动器，状态存 `drive_state.json` |
| `check-net-hint.js` | 回归：联机入口可用性提示（模拟 404 / 200 / fetch 抛错，共 10 项断言） |
| `sim_net_restart.js` | 联机 restart 消息的状态机模拟（对齐 index.html 的 `userReset`/`netHandle`） |

```bash
node tools/tune-weights.js --pop 8 --gens 6 --games 12 --diff normal
node tools/tune-weights.js --verify 32 --diff normal      # 独立验证 tune_result.json
node tools/parallel-selfplay.js --games 64 --jobs 8 --diff hard
node tools/ai-stats.js 80                                 # 跑 80 局统计
node tools/drive.js NEW red                               # 开一局，再 MOVE x,y / OPP
node tools/ab-ai-check.js                                 # 回归：选点分布 + 性能
node tools/check-net-hint.js                              # 回归：联机入口提示（需离线跑，不依赖服务端）
```

> 教训：每个个体对弈局数太少时适应度噪声极大（16 局 62.5% → 32 局 46.9% → 64 局 50.0%）。
> 可信结论需要 **games ≥ 12** 且用并行评估；当前默认权重已是局部较优点，纯调数字收益有限。
>
> 单步耗时参考（i7-14650HX 空载，困难档）：平均 0.76~0.91s / 最坏 2.9~3.1s。
> AI 内部含 `Math.random()` 噪声，自博弈局长会在 25~36 手之间波动，属正常现象。

## neural/ — 神经网络自博弈与训练

| 目录/脚本 | 说明 |
|---|---|
| `env.js` | 沙箱加载真实 `index.html` 逻辑，暴露 `Game`（含 async `aiChooseMove`） |
| `features.js` / `opt/features_p2.js` / `opt/features_p3.js` | 局面 → 特征向量（16 维 / 镜像不变化 16 维 / 扩维） |
| `mlp.js` / `train.js` / `opt/train_pv.js` / `opt/parallel_train.js` | MLP 定义与训练 |
| `opt/selfplay.js` / `opt/run_opt.js` / `opt/mcts.js` | 自博弈生成数据 + MCTS 选点 |
| `opt/eval_*.js` | Elo / head-to-head 评测 |
| `inject.js` / `verify-inject.js` | 把训练好的权重注入页面（生成 `__NNW`）并校验产物 |
| `opt/model_*.json` | 各版本权重；对战实测见 [../docs/05-实验记录.md](../docs/05-实验记录.md) |

```bash
node tools/neural/inject.js --model tools/neural/opt/model_p2.json --out index.html
node tools/neural/verify-inject.js
```

自博弈数据（`*.jsonl`）已随仓库提供，可续训；重新生成用 `opt/selfplay.js`。
这条线自带独立沙箱（`env.js`，行为与 `game-sandbox.js` 等价），未做合并以免动到已验证的管线。
