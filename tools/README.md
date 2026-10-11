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

## solver — 精确落点 + 三值证明搜索（新核心）

独立于启发式/神经网络之外的一支：**精确走法生成**（稳定落点集恰为 `{p | p 空且 p+g(p) 有子}`，
不超过 `4·|O|`，无需棋盘半径）+ **三值 AND/OR 证明搜索**（`1/-1/0`，未知绝不当和棋）
+ **全宽 alpha-beta**（不截前 K，置换表区分 exact/lower/upper）。设计与边界见
[../docs/07-精确落点与证明搜索.md](../docs/07-精确落点与证明搜索.md)。

| 脚本 | 说明 |
|---|---|
| `solver-core.js` | 核心：`Position`（精确稳定落点集，`play`/`undo` 保持廉价）+ `chooseMove`（证明 + 估值双通道，可传 `cache` 跨回合复用，可传 `forkScan`/`threatPlies`/`pnsNodes` 做消融）+ **`threatSearch`（P3 连续强制威胁）+ `pnsSearch`（PNS，无阈值递归）+ `dfpnSearch`（阈值递归 + 置换表；`maxPlies>0` 进入"深度受限"模式、结论确切，`refuted` 时导出**防守策略证书**）+ `verifyProof`/`verifyStrategy`/`verifyRefutation`（库内核验器）+ `certifyRoot`/`chooseMoveCertified`（P5：证据表 + 证书驱动选招）+ `followRefutation`（证书跟随）+ `certBoundaryStates`/`dedupeBoundaries`/`spliceRefutation`（边界导出/去重/拼接）+ `rotateEntries`/`rotateTree`/`rotateRefutation` + **`checkRefutationInvariants`（必要条件断言）/`unifyRefutation`（统一见证 ⇒ 确定性策略）/`certIndex`（状态→见证索引，精确键 + 四旋转规范键含坐标还原）/`certStateKey`/`RULE_VERSION` + **`createBoundCache`/`boundLookup`/`boundStore`/`truncateRefutation`（有界结论 L/U 区间复用；**默认不启用**，传 `boundCache` 才生效）**。零依赖，Node/浏览器通用 |
| `solver-smoke.js` | 回归：合法点、增量撤销、立即胜/唯一防守/双杀、**双威胁必胜手**、**支撑激活型双威胁**、中心阻断、四旋转、旧缺陷复现、预算回退、**战术判定 vs 暴力枚举**、**置换表不改变搜索结果**、**连续威胁证明 + 验证器**、**PNS 策略树 + 四类负向对照**、**df-pn 与 PNS 同结论**、**P5：证据表 / 证书驱动选招避开必败手 / 终点纯度（不得含 `ply-shortfall`）/ 跟随器偏离即失效 / 边界拼接（缺证不得拼）** |
| `certified-choose.js` | **证书驱动的实战选招**：打印每个根候选的证据表（ownWin / survival / opponentWin / 启发式），按"只用可证优劣关系"的规则选招；同一 horizon ⇒ 同尺度 |
| `cert-follow.js` | **证书跟随机制的离线核验**：整棵树遍历记账（行棋方奇偶、攻击方全覆盖、防守方恰 1 步、深度上限、终点白名单）+ 黑盒调用跟随器 + **只用跟随器重建一份证书再双核验** + 四旋转变体 |
| `cert-boundary.js` | **未终局边界分析 + 拼接**：导出 `depth-limit` 边界、精确/旋转去重、抽样做有限预算延伸分析；`--splice` 把全部边界替换成续证书合成 `N+add` 的新证书并双核验（部分成功明确标注"不构成统一保证"） |
| `invariant-probe.js` | 从见证策略里提**不变量候选**并**优先找反例**（C1 见面在邻域 / C2 落子后对手无即时胜点 / C3 局面唯一决定见证 / C4 见证唯一可行）；找不到就如实报告，不包装成无限证明 |
| `cert-scan.js` | **策略库"是否值得扩"的离线扫描**：精确/四旋转根命中、唯一局面去重、命中是否改变原 AI 走法，**开发集（证书根来源局）与留出集分开统计**；另做有限预算的"决策价值出现率"抽样（标注为测量，不是建库） |
| `make-cert-bundle.js` | **离线生成可嵌入页面的证书包**：判定表（有界口径）+ 小 horizon 跟随证书（统一见证 → 双核验 → 紧凑编码 → **往返校验**）→ `tools/fixtures/cert-bundle.json` |
| `inject-cert.js` | 把 `cert-bundle.json` 内联进 `index.html`（`--check` 校验同步）；**只嵌数据**，页面查询逻辑是静态代码 |
| `cert-loop.js` | **在线闭环的事件回放验收**：关键局面真实选招 / 从 rows 重建证书双核验 / 页面跟随⇄数据逐状态 / 完整跟随（对手全覆盖）/ 偏离即作废 / 悔棋重开导入换档 / 迟到响应 / 旋转坐标还原 / 普通对局开销 |
| `check-dfpn-order.js` | **DFPN 后继排序的回归**（P8-2）：默认路径锚点不变（`ply4(1,-1) N=8` = 10194 节点、`THREAT N=12` = 5732 / 3099 / 266）／三种 order 结论必须一致／每份证书都过库内+规则层（⇒ 没少走法）／同一 order 跑两次逐位可复现／`orderCalls==expansions` 且未知取值回落 `none` |
| `bench-other-games.json` | **不同源任务集**（11 个，P8-3）：来自 `bench-games-v2.jsonl` 的 9 局（**都不是** ply4 来源局 `hard\|P1#7`）在 ply 10/12 去重后的棋盘；`attacker = 3 − 行棋方`、N 固定 9。**没有先验期望**（`expect: null`），正确性判据只有"变体结论一致 + 证书双层核验" |
| `bench-suite.js` | **固定搜索基准 + 成本剖析**：读 `tools/fixtures/bench-suite.json`（10 个固定任务：浅证胜/反证、P3 连续威胁、含安静手证胜、较大 horizon 反证、固定预算内未知），**冷/热两趟对照**分别测"每任务全新缓存"与"跨任务共享缓存"；把**搜索 / 证书导出（核心内计数）/ 独立核验**分开计时，并记录 TT 命中、重复率、峰值堆。**节点/秒只作辅助指标**。排序对照用 `--mode order --order none,block,shape --repeat 2`（变体在内层**交替**执行、毫秒取 min），留出集用 `--suite` |
| `fixtures/bench-horizon.json` | **大 horizon 固定任务集**（P10，10 个任务）：覆盖较深证胜 / 较深有界反证 / 相邻 horizon 对 / 固定预算内未知 / 不同来源局面。每个任务带**完整命题**：规则版本、规范棋盘与行棋方（含**四旋转规范键**，runner 每次核对）、攻击方、有界或无界与 horizon 计数起点、两档预算、缓存条件、**预期结论的独立依据**（无依据就 `expect: null`，禁止把旧搜索值当真值）。未知任务的预算**两档都不放大**（预算即命题） |
| `bench-horizon.js` | **大 horizon 基准的运行器**（P10）：`--tier common\|release` 两个预算档（常用档只快速核验，发布档默认**双核验**）；分开计时**搜索 / 证书导出 / 快速核验 / 参考核验 / JSON**；**只有预算内完成的任务进可比合计**，时间盒·节点上限·**内存保险**触发的任务一律**单列**；另打印**只读计数比率**（`keys`/`ws`/`exp`/`succ` 推出的"每次访问的常数工作量"）。`--pin` 固化规范键、`--explain` 打印命题、`--memMB` 演练内存保险 |
| `profile-search.js` | **搜索器的只读采样剖析**（P10）：用 `node:inspector` 的 Profiler 按固定间隔抽样调用栈 ⇒ **不改被测代码、不加计时器**；输出自耗时 top、按文件汇总、以及"展开量 vs 每次访问的常数工作量"的判据对照。⚠ **带剖析的运行只用于解释，性能数字看它输出的"不带剖析"那一段**（性能请用 `bench-horizon.js`） |
| `ab-core.js` | **同一进程内交替对照两个 solver-core 构建**（判断"热路径实现优化"是否有效）：`--old <副本>`（用 `git show HEAD:tools/solver-core.js > /tmp/old-core.js` 取）。每遍内 old/new 紧邻、**奇偶遍反转顺序**、**丢弃 1 遍预热**；同时报**墙钟**与 **CPU 时间**（`process.cpuUsage`，不含"等 CPU"的时间）、**中位数 + 逐遍配对差中位数**，并给两种噪声地板（以**配对差自身**为准）。顺手断言两构建 `status/nodes/successors/expansions/keys/ws/ttHits/pn/dn` **逐位一致**，不一致即退出码 1。⚠ 本机经验：跨进程墙钟在有负载时差到 **2.7×**、JIT 预热会把地板从 1.9% 抬到 **16%** ⇒ 这类优化**只能**用配对口径判。⚠⚠ **必须配一次零假设对照**：`cp tools/solver-core.js tools/tmp-core-same.js && node tools/ab-core.js --old tools/tmp-core-same.js`（两份逐字节相同 ⇒ 真值 0）；实测它能在大任务上**虚报 −7.0%**、逐遍差值达 ±34%，所以"比工具给的地板大"还不够 —— 要**比零假设对照自身的偏差大**才算数 |
| `micro-at.js` | **原语级微基准**（P10-2，**只用于解释**）：`--old <副本>`，同进程配对口径比较 `at`（命中/未命中）、`line`、`winning`、`play+undo`、`moves()`、`signature` 的**单次**成本，并把差值外推成"对某任务的期望降幅上限"。⚠ **不能代替端到端结论**（微基准的缓存局部性远好于真实搜索）；用途是判断端到端测出来的数字是否在合理量级内 |
| `index-cost.js` | **查询索引的成本计数与内存**（P10-2）：① 用**原型包装**数 `at()` / `_idxSet` / `_idxDel` / `play` / `undo` / `Position` 的次数 ⇒ 索引**构造与维护量**（包装仅为计数，不作性能结论）；② `--mem --expose-gc --old <副本>` 新旧两版各跑同一任务，gc 后读 `heapUsed`/`rss` 增量、正反两序各测一次 |
| `check-index-cols.js` | **查询索引的同步正确性检查**（P10-2）：主判据 = 把 `cols` 从 `board` **全量重推导**再逐项比对，能同时抓"写了 board 忘 cols"、"撤了 board 留 cols"、"空列没清理"、"试放绕过统一入口"。含 A 逐步一致性、C1 交错与嵌套回退、C2 **异常中断**（DFS 中途 throw + 真实小预算搜索）、D 坐标边界（负坐标 / 坐标轴 / **`-0` 归一化** / 跨 2^31 / 2^40 / 安全整数上界，直接测索引原语）、E `moves()` 顺序不变；`--cross` **自动跨后端自比对**：同一份工作量在 `cols` 与 `G4_AT_BACKEND=string` 下各跑一次，比对**运行见证哈希**（逐格探针 + 每步的 frontier/moves 顺序 + 规范键 + 搜索全计数） |

**查询后端的开关**（P10-2）：`solver-core.js` 的 `at()` 默认走数值双层 Map 索引 `Map<x, Map<y, owner>>`；
设 `G4_AT_BACKEND=string`（或 `globalThis.__G4_AT_BACKEND='string'`）**在加载时**切回原来的字符串查表
（`at` 用**原型替换**，默认路径上没有 per-call 分支）。`CORE.AT_BACKEND` 可读当前值。
| ⚠ **度量口径（实现优化的热路径改动专用）** | 只改实现、不改语义的优化，**节点数是恒等的**（那恰恰是"没改语义"的证据）⇒ 判据只能是①**逐位一致**（锚点 + 全计数）②**配对时间差**。用 `ab-core.js`（同进程交替 + 丢弃预热 + CPU 口径）；**不要**拿两次单独运行比墙钟（负载期同代码差 2.7×），也**不要**保留预热遍（会把地板抬到 16%） |
| ⚠ **度量口径（基准类实验通用）** | 本机**墙钟抖动可达 ±20%**（同一任务节点数逐位一致却跑出 23.8s / 34.9s）⇒ 判断"优化是否有效"必须用**确定性指标**：核心给每个 `boundCache` 累加 `searchNodes` / `searchCalls`（纯诊断字段，由 `dfpnSearch` 写入），「同一流水线在有/无复用下的**节点数之差**」才是可靠读数，墙钟只作辅助。做对照时用 `createBoundCache(0)`（`maxEntries=0` ⇒ `boundStore` 永不写入 ⇒ 复用完全不生效，但计数照常累加）当对照组 |
| `check-bound-reuse.js` | **有界结论区间复用（L/U 表）的回归**：单调性（`refuted` 向下封闭 / `proven-win` 向上封闭，复用结论必须与真搜一致）、复用证书的**两层核验**、五条负向对照（未完成结论不得写入 / 只改 `maxPlies` 不截断必须被拒 / 获胜树深度 > N 不得复用 / 反证证书 `maxPlies` < N 不得复用 / 结论命中但无证书必须真搜）、结论与证书分离；E 组验**确定性成本度量**（`searchNodes`/`searchCalls` 累加、`maxEntries=0` 对照组永不写入、相同预算下节点数可复现、复用命中记 0 节点） |
| `check-dfpn.js` | **df-pn ↔ PNS 对照台**：同一批夹具上两者结论必须一致、策略树必须通过规则层独立核验（用来盯阈值递归；曾靠它复现"AND 子节点一步也搜不动"的空转） |
| `check-dfpn-thresholds.js` | **只审算法、不调性能**的阈值专项检查：公式单测（次小值 / 单子 / 扣减 / 饱和 / 下限）、**进展不变量**（120 组合法输入）、入口条件、**手工 AND/OR 图**上的最小 df-pn（含转置命中） |
| `check-bounded.js` | **深度受限搜索的语义回归**：用**纯递归暴力枚举**（无快捷判定、无置换表、规则取自 `rules-ref`）逐深度核对有界结论；另含**有界/无界隔离**（无界 `refuted` 不产出证书、无界证胜树不含深度终点、N=1 最后一手连四须判胜、有界反证不得推广成无界）与**证书篡改的四条负向对照** |
| `solve-target.js` | **对指定局面/走法投预算求解**：先试 P3，再按 `--algo pns\|dfpn` 试证双方（`--attacker opp\|me\|both`）；`--maxPlies` 走深度受限（结论确切）；`--out` 落盘可核验证明 |
| `bounded-sweep.js` | **扫深**：对指定走法逐个 N 求「某方能否在 ≤N 半回合内强制连四」，被穷尽否定时继续加深；**顺带导出并核验证书**（证胜→策略树 / 反证→防守证书），`--out` 落盘 |
| `make-bounded-fixtures.js` | 生成 ply4 的**可复现夹具**：入库小文件（规范输入 + 结论 + 证书 SHA-256），大证书确定性重生成（gitignore）；两向扫深（`attacker=opp` 与 `attacker=me`） |
| `analyze-defence.js` | 从**已核验的防守证书**提取结构特征（叶类型分布、防守方用到的格子数等）。**只是观察、不是不变量证明**（头部写明了它**不**做什么） |
| `rules-ref.js` | **规则参考实现**（窗口扫描判连四、从棋子四邻重建落点、自己重写重力分区）；**不调用核心 `Position`**，用于给核验提供"规则层独立" |
| `check-rules-ref.js` | 交叉一致性回归：整片网格核对重力方向、随机轨迹逐帧核对合法落点/终局方/双方即时胜点，确认参考实现与核心一致 |
| `trace-loss.js` | **向前追溯**：找最早可证败点，回看此前每个己方局面并枚举**全部**替代走法，分类为「已证胜/已证败/未知」，指出值得投大预算的具体局面 |
| `make-fixtures.js` | 把关键证明压成 `tools/fixtures/` 下的小夹具（只留 DAG 形式，入库追踪） |
| `solver-bench.js` | 强度台：新核心 vs 内置 AI（真值棋盘用 `Position`，内置侧走页面真实 `placePiece`+`drain`），分先/后手统计胜负、完成深度与节点吞吐；`--record` 导出整局棋谱 |
| `analyze-failures.js` | 失败局面定位：回放 `--record` 棋谱，用更大预算对照，只用**证明**下结论，并对「已证败局」枚举全部应手做交叉核验 |
| `threat-report.js` | 证明通道的**覆盖度与开销**报告：四臂对照（基线 / 仅 P3 / 仅 P4 / 两者），回答"多证出了什么、代价是什么"；`--random N` 走随机中局采样，`--minPieces` 可只采残局 |
| `prove-positions.js` | **离线证明引擎**：对关键局面用 PNS 出完整策略树、核验后持久化成 JSONL；`--attacker side\|opponent` |
| `verify-strategy.js` | **独立实现的**核验器（刻意不复用核心代码）：核策略树 / DAG / P3 连续威胁序列 / **有界反证的防守证书**；同时作为模块导出供其他工具复用 |
| `verify-strategy-fast.js` | **核验器的实现加速版（不替换上面那份参考实现）**：只改实现方式——一条 DFS 路径共用一块棋盘（落子/撤销）、**增量维护合法落点**（落子只重查 ≤8 个候选格）、连四**只查刚落的那一格**；检查顺序 / 失败原因文本 / 出错节点路径 / 节点计数与参考实现**逐字一致**。CLI：`<file.jsonl>` 用快速实现、`--ref` 用参考实现、`--both` 双跑比对（不一致即退出码 1） |
| `check-verify-fast.js` | **快速 × 参考的逐项交叉核对**（P9）：A 全夹具（17 条）比较 `ok`/失败原因/出错路径/节点计数；B1/B2 逐节点审计"增量 `avail` === `rules-ref.legalMoves`、增量连四 === `rules-ref.winner`、`sideToMove` 同口径"；B3 胜点集单元一致性（固定种子轨迹 + `limit` 截断）；C **8 项负向对照**（漏 AND 应手 / 改 OR 走法 / 篡改终点 / 篡改攻击方 / 越半回合限制 / `depth-limit` 改成真连四 / 旋转坐标错 / 非法不稳定落点），要求两类核验器**双双拒绝且原因+路径一致**。`--quick` 跳过大证书 |
| `verify-bench.js` | **核验器性能对照**：每项多遍取中位数，报**总核验时间 / 每节点时间 / 访问节点数 / 峰值内存高水位 / 一致性**；JSON 解析单独列（证明收益不来自它）。配 `node --expose-gc` 可测高水位增量 |
| `verify-profile.js` | **参考核验器的阶段剖析**：把 `rules-ref` 原语用计时器临时包起来跑真实大证书，给出 `winner` / `play` / `legalMoves` / `cloneBoard` 的占比（**只在剖析时打补丁**，正式代码热路径不被污染） |
| `inspect-strategy.js` | 打印一棵策略树的形状与统计（节点/AND/深度/覆盖应手数）并顺手核验，便于人工核对证明 |
| `find-support-fork.js` | 搜夹具局面：支撑激活型双威胁、多步连续强杀、含 AND 节点的 PNS 策略树（只搜**真正轮到该方**的棋框） |
| `inject-solver.js` | 把 `solver-core.js` 内联进 `index.html` 主脚本（`--check` 校验同步）；内联而非外链，见该文件头说明 |
| `check-solver-page.js` | 回归：「求解器-精确」档接入页面（内联核心可用 / 落点合法稳定 / 缺核心可回退） |
| `find-fork-position.js` | 复现 `solver-smoke.js` 里「双威胁必胜手」回归局的搜局脚本 |

```bash
node tools/solver-smoke.js                                  # 核心回归（含 P3/P4 与负向对照）
node tools/check-dfpn.js                                    # df-pn 与 PNS 同结论、策略树可核验
node tools/check-dfpn-thresholds.js                         # 只审算法：阈值公式 / 进展不变量 / 手工 AND/OR 图
node tools/check-bounded.js                                 # 有界语义 vs 纯暴力 + 隔离 + 证书篡改负向对照
node tools/check-solver-page.js                             # 页面接入回归
node tools/solver-bench.js --games 20 --diff hard --color both --timeMs 800 --record tools/bench-games.jsonl
node tools/analyze-failures.js tools/bench-games.jsonl --games 4 --refMs 2000   # 定位失败局面
node tools/threat-report.js --random 60 --timeMs 200        # 证明通道覆盖度与开销
node tools/prove-positions.js --records tools/bench-games.jsonl --max 3 --out tools/proofs.jsonl
node tools/verify-strategy.js tools/proofs.jsonl            # 另一进程独立核验策略树
node tools/solve-target.js --records tools/bench-games.jsonl --game "hard|P1#7" --ply 4 --moves "1,-1;0,-2" --attacker both
node tools/bounded-sweep.js --records tools/bench-games.jsonl --game "hard|P1#7" --ply 4 --maxPlies 4,8,12,16
node tools/make-bounded-fixtures.js                         # 重生成 ply4 证书 + 内建核验（两向）
node tools/verify-strategy.js tools/fixtures/bounded-ply4-certs.jsonl   # 另一进程、规则层独立核验
node tools/verify-strategy-fast.js tools/fixtures/bounded-ply4-certs.jsonl --both  # 快速+参考双跑比对
node tools/check-verify-fast.js                             # 逐项交叉核对 + 增量审计 + 8 项负向对照
node --expose-gc tools/verify-bench.js --reps 3             # 性能对照（总时间/每节点时间/峰值内存/一致性）
node tools/verify-profile.js                                # 参考核验器的阶段剖析（时间去哪了）
node tools/analyze-defence.js                               # 防守证书结构统计（观察，不是证明）
node tools/certified-choose.js --fixture tools/fixtures/bounded-ply4.json   # 证书驱动选招（证据表 + 决策）
node tools/cert-follow.js                                   # 跟随机制：整树遍历 + 重建 + 双核验 + 四旋转
node tools/cert-boundary.js --sample 8 --sweep 2,4           # 未终局边界分析与延伸统计
node tools/cert-boundary.js --splice --ply 6 --attacker 2 --N 2 --add 2     # 拼接演示（全部边界续证才拼）
node tools/invariant-probe.js                               # 不变量候选 + 反例搜索（口径已修正）
node tools/cert-scan.js                                     # 策略库价值评估（命中率 / 走法改变 / 决策价值出现率）
node tools/bench-suite.js                                   # 开发集 + 成本剖析（冷/热 boundCache 对照）
node tools/bench-suite.js --suite tools/fixtures/bench-holdout.json --mode order --order none   # 同源确认集基线
node tools/bench-suite.js --mode order --order none,shape,shape-top --repeat 5   # 后继排序对照（交替 + 中位数 + 配对差）
node tools/bench-suite.js --mode order --order none,shape,shape-top --repeat 3 --skip t10-ply4b102-unbounded  # 排除时间盒任务
node tools/check-dfpn-order.js                              # DFPN 后继排序回归（默认路径锚点 + 结论一致 + 两层核验）
node tools/check-bound-reuse.js                             # 有界结论区间复用（L/U）回归
node tools/make-cert-bundle.js --boundCache 1                # 离线流水线（默认，共享缓存 ⇒ 重复查询走复用）
node tools/make-cert-bundle.js --boundCache 0                # 对照组：maxEntries=0 ⇒ 永不复用，只累加节点数
                                                             #   ⇒ 两组对比报"累计展开节点"（确定性），不要只报秒数
node tools/make-cert-bundle.js                              # 生成可嵌入的证书包（含双核验 + 往返校验）
node tools/inject-cert.js                                   # 把证书包内联进 index.html
node tools/cert-loop.js                                     # 在线闭环的事件回放验收（8 个场景）
node tools/inject-solver.js                                 # 改了 solver-core.js 后必须重跑
node tools/inject-solver.js --check                         # 校验 index.html 与核心是否同步
```

页面「AI 强度」里新增 **求解器-精确** 档（`state.aiKind='solver'`），默认档位与其它 AI 均未改动；
核心缺失或落点与页面物理模型不一致时自动回退启发式-hard。
「求解器-精确」档还会**优先使用离线证书**：

- 根局面查询支持**四旋转等价**（本游戏四个重力区在 90° 旋转下互换、固定块不动；镜像**不**等价）；
  命中后把见证坐标**一次**旋转到本局朝向，之后用**精确键**跟随（热路径无额外开销）。
- 日志/状态栏同时给出**两个长度**，且**不可混用**：`选招依据`（判定 horizon，说明"存在更长的防守策略"）与 `当前可执行保证`（真正装载的这份策略覆盖多少半回合）。
- 未命中分两类：**我方偏离**（正常）与**对手合法落子后未命中**（证书在攻击方回合覆盖全部合法走法，故这属于索引/状态同步**异常**，单独计数 `anomalies`）（命中根局面、或仍在跟随中，就直接按证据走，O(1) 查表），
并在状态栏显示「证书保证中：剩 N 半回合」；悔棋/重开/导入/换档位会撤销保证（`?cert=1` 可对任意档位强制启用）。

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
