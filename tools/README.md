# tools — AI 研发与评测工具链

> ⚠️ **注意**：下表中标 🚧 的脚本尚未适配 async 版 `aiChooseMove`，跑出来的自博弈是失效的
> （一局只走 1 步）。原因与修复要点见 [../docs/06-已知问题.md](../docs/06-已知问题.md) 第 2 条。
> 神经网络那条线（`neural/`）不受影响。

## 启发式调试

| 脚本 | 说明 | 状态 |
|---|---|---|
| `tune-weights.js` | 差分进化调优启发式权重（与基线自博弈，红蓝交替抵消先手优势） | 🚧 |
| `parallel-selfplay.js` | worker_threads 池并行自博弈；实测 12 局并发 8 → 3.6× 加速 | 🚧 |
| `selfplay-core.js` / `single-selfplay.js` / `spa-worker.js` | 并行自博弈的沙箱与 worker 核心 | 🚧 |
| `ab-ai-check.js` | A/B 两版页面同局面选点对比 | 🚧 |
| `ai-stats.js` | 困难 vs 困难批量对局统计（红蓝/斜直获胜、步数、同构局） | 🚧 |
| `drive.js` | 命令行「我下棋、AI 应手」交互驱动器，状态存 `drive_state.json` | 🚧 |
| `sim_net_restart.js` | 联机 restart 消息的状态机模拟（对齐 index.html 的 `userReset`/`netHandle`） | ✅ |

```bash
node tools/tune-weights.js --pop 8 --gens 6 --games 12 --diff normal
node tools/tune-weights.js --verify 32 --diff normal      # 独立验证 tune_result.json
node tools/parallel-selfplay.js --games 64 --jobs 8 --diff hard
node tools/ai-stats.js 80                                 # 跑 80 局统计
```

> 教训：每个个体对弈局数太少时适应度噪声极大（16 局 62.5% → 32 局 46.9% → 64 局 50.0%）。
> 可信结论需要 **games ≥ 12** 且用并行评估；当前默认权重已是局部较优点，纯调数字收益有限。

## neural/ — 神经网络自博弈与训练

| 目录/脚本 | 说明 |
|---|---|
| `env.js` | 沙箱加载真实 `index.html` 逻辑，暴露 `Game`（含 async `aiChooseMove`） |
| `features.js` / `opt/features_p2.js` / `opt/features_p3.js` | 局面 → 特征向量（16 维 / 镜像不变化 16 维 / 扩维） |
| `mlp.js` / `train.js` / `opt/train_pv.js` / `opt/parallel_train.js` | MLP 定义与训练 |
| `opt/selfplay.js` / `opt/run_opt.js` / `opt/mcts.js` | 自博弈生成 + MCTS 选点 |
| `opt/eval_*.js` | Elo / head-to-head 评测 |
| `inject.js` / `verify-inject.js` | 把训练好的权重注入页面（生成 `__NNW`），并校验注入产物 |
| `opt/model_*.json` | 各版本权重；对局实测见 [../docs/05-实验记录.md](../docs/05-实验记录.md) |

```bash
node tools/neural/inject.js --model tools/neural/opt/model_p2.json --out index.html
node tools/neural/verify-inject.js
```

数据（自博弈 `*.jsonl`）已随仓库提供，可续训；重新生成则用 `opt/selfplay.js`。
