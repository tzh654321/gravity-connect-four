'use strict';
/* 无限网格重力四子棋：精确稳定落点、三值证明搜索、全宽 alpha-beta。
   Node: require('./solver-core')；浏览器: globalThis.GravitySolver。
   规则：任意空整数格可投子，已有棋子固定，连四立即结束，无额外房规。

   —— 本版相对初版的改动（都是"让相同预算多算"或修正语义，不改规则）——
   1. 胜负距离统一按半回合 ply 计：立即胜 MATE-(ply+1)，双威胁兑胜 MATE-(ply+3)，
      面对双杀 -(MATE-(ply+2))；置换表存取做 mate 归一化，键里不再编入根距离/ply。
   2. 证明结果表 solvedTable 与深度受限搜索表 searchTable 分离：已证胜/败与深度无关，
      按四旋转规范键缓存（见证走法按旋转还原）；searchTable 以"局面+行棋方"为主键，
      深度/上下界/最佳走法存为字段，深度不足时不剪枝但仍用其最佳走法排序。
   3. 统一截止时间：根节点战术扫描也在预算内；双威胁候选循环内检查预算
      —— 中断代表没检查完，不代表不存在双威胁。
   4. 双威胁判定改为**局部计数**（只数穿 p 的 16 个窗口 + 少量新支撑格），不再 O(b²) 全扫。

   —— 一条被实测否掉的优化（保留记录，避免重蹈）——
   曾把"双方胜点集 + 四格窗口贡献"做成 Position 的增量维护（play/undo 带 delta），
   并逐帧验证与全扫描一致。但它**更慢**：play 在搜索里每个节点被调用 b 次，
   维护成本被乘上分支因子，吞吐从原设计掉到约 2k 节点/s，强度也下降。
   ⇒ 结论：热路径上的"每次落子"操作必须保持廉价；
   真正值得优化的是**每个节点**才做一次的扫描，而不是每次落子都做的维护。

   本实现不把未知冒充证明、完整考虑每个正常合法落点，但不保证每局都赢。 */
(function (root) {
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
  const CROSS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  /* 模块级常量：`for (const sign of [-1, 1])` 会在**每次调用**分配一个临时数组，
     而 `line()` 是最热的循环之一 ⇒ 提到模块级（只读）。 */
  const SIGNS = [-1, 1];
  const WEIGHT = [0, 2, 18, 180];
  /* `key` = 位置表示的唯一格式（对外 API、证书、规则层都用它）。字符串拼接与模板字面量
     产生**逐字相同**的字符串，选前者只是因为它在热路径上少一层转换。 */
  const key = (x, y) => x + ',' + y;
  /* ⚠ 只接受**规范键**（构造器已断言 `key(x,y) === k`）。
     原写法 `k.split(',').map(Number)` 每次调用分配 2 个临时数组；改成 indexOf + slice。 */
  const point = k => { const i = k.indexOf(','); return { x: +k.slice(0, i), y: +k.slice(i + 1) }; };
  const MATE = 1000000;
  const DEFAULT_FORK_SCAN = 16;   // 双威胁候选预筛上限（仅"找必胜手"，不删搜索宽度）
  const STOP = Symbol('搜索预算耗尽');
  function gravity(x, y) {
    if (x >= 0 && y >= 1) return [0, -1];
    if (x >= 1 && y <= 0) return [-1, 0];
    if (x <= 0 && y <= -1) return [0, 1];
    if (x <= -1 && y >= 0) return [1, 0];
    return [0, 0];
  }
  // 绕原点 90° 旋转；四次为一轮
  const rotN = (p, n) => {
    let x = p.x, y = p.y;
    for (let i = ((n % 4) + 4) % 4; i > 0; i--) { const nx = -y, ny = x; x = nx; y = ny; }
    return { x, y };
  };
  // 杀分归一化：把"从根到这里的 ply"从分数里剥掉，使表项可跨深度/跨回合复用
  const normScore = (s, ply) => s > MATE / 2 ? s + ply : s < -MATE / 2 ? s - ply : s;
  const denormScore = (s, ply) => s > MATE / 2 ? s - ply : s < -MATE / 2 ? s + ply : s;

  class Position {
    constructor(entries = [['0,0', 3]]) {
      this.board = new Map(entries);
      if (this.board.get('0,0') !== 3) throw new Error('中心必须有固定块 3');
      for (const [k, o] of this.board) {
        const { x, y } = point(k);
        if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) ||
            Math.abs(x) > Number.MAX_SAFE_INTEGER - 1024 ||
            Math.abs(y) > Number.MAX_SAFE_INTEGER - 1024 || key(x, y) !== k ||
            ![1, 2, 3].includes(o) || (o === 3 && k !== '0,0')) {
          throw new Error('棋盘必须使用规范整数坐标和阵营 1/2，固定块仅在中心');
        }
      }
      for (const [k, o] of this.board) {
        if (o !== 3 && !this.supported(point(k))) throw new Error(`存在未稳定棋子：${k}`);
      }
      this.frontier = new Set();
      for (const k of this.board.keys()) this.addNeighbors(point(k));
    }
    at(x, y) { return this.board.get(key(x, y)) || 0; }
    supported(p) {
      const [dx, dy] = gravity(p.x, p.y);
      return !!this.at(p.x + dx, p.y + dy);
    }
    addNeighbors(p, added) {
      /* 热路径：原来每个邻居都 `{x,y}` 建一个对象再交给 `supported()`（内部还要再拼一次键）。
         这里就地算，少一次对象分配；判定与原来完全等价（`supported` 就是"下方那一格有子"）。 */
      for (let i = 0; i < CROSS.length; i++) {
        const qx = p.x + CROSS[i][0], qy = p.y + CROSS[i][1], k = key(qx, qy);
        if (this.board.has(k)) continue;
        const g = gravity(qx, qy);
        if (!this.at(qx + g[0], qy + g[1])) continue;
        if (this.frontier.has(k)) continue;
        this.frontier.add(k);
        if (added) added.push(k);
      }
    }
    /* 热路径：原来先摊开成字符串数组再 map 一遍（两次分配）⇒ 改成单趟 push。
       返回的 `{x,y}` 与**顺序**都与原来一致（`frontier` 是 Set ⇒ 插入序）。 */
    moves() {
      const out = [];
      for (const k of this.frontier) out.push(point(k));
      return out;
    }
    line(p, side) {
      // 索引循环 + 模块级 `SIGNS`：判定顺序与 `for (const sign of [-1,1])` 完全一致
      for (let di = 0; di < DIRS.length; di++) {
        const dx = DIRS[di][0], dy = DIRS[di][1];
        let n = 1;
        for (let si = 0; si < SIGNS.length; si++) {
          const sign = SIGNS[si];
          for (let t = 1; t < 4; t++) {
            if (this.at(p.x + sign * t * dx, p.y + sign * t * dy) !== side) break;
            n++;
          }
        }
        if (n >= 4) return true;
      }
      return false;
    }
    winning(p, side) {
      return this.frontier.has(key(p.x, p.y)) && !this.at(p.x, p.y) && this.line(p, side);
    }
    winner() {
      let winner = 0;
      for (const [k, o] of this.board) {
        if (o !== 3 && this.line(point(k), o)) {
          if (winner && winner !== o) throw new Error('输入局面双方已同时连四');
          winner = o;
        }
      }
      return winner;
    }
    /* ---- 热路径：play/undo 保持廉价（只动 board / frontier / 少量新支撑格）---- */
    play(p, side) {
      const k = key(p.x, p.y);
      if (!this.frontier.has(k) || this.board.has(k)) throw new Error(`非法落点：${k}`);
      this.frontier.delete(k);
      this.board.set(k, side);
      const added = [];
      this.addNeighbors(p, added);
      return { k, added };
    }
    undo(u) {
      for (let i = 0; i < u.added.length; i++) this.frontier.delete(u.added[i]);
      this.board.delete(u.k);
      this.frontier.add(u.k);
    }
    // 穿过 p 的 16 个四格窗口（p 分别位于 0..3 号位）
    _windowIds(p) {
      const out = [];
      for (let di = 0; di < DIRS.length; di++) {
        const dx = DIRS[di][0], dy = DIRS[di][1];
        for (let off = 0; off < 4; off++) out.push(`${p.x - off * dx},${p.y - off * dy}/${di}`);
      }
      return out;
    }
    // 窗口内容：双方子数 / 是否含固定块 / 空格数与其坐标 / 空格中"仍不可落"的个数
    _windowInfo(id) {
      const slash = id.lastIndexOf('/');
      const di = +id.slice(slash + 1);
      const c = id.slice(0, slash).indexOf(',');
      const ax = +id.slice(0, c), ay = +id.slice(c + 1, slash);
      const dx = DIRS[di][0], dy = DIRS[di][1];
      let c1 = 0, c2 = 0, unavail = 0, ex = 0, ey = 0, empty = 0, blocked = false;
      for (let t = 0; t < 4; t++) {
        const x = ax + t * dx, y = ay + t * dy, o = this.board.get(key(x, y)) || 0;
        if (o === 3) { blocked = true; break; }
        if (o === 1) c1++;
        else if (o === 2) c2++;
        else { empty++; ex = x; ey = y; if (!this.frontier.has(key(x, y))) unavail++; }
      }
      return { c1, c2, unavail, empty, ex, ey, blocked };
    }
    // 该窗口唯一空格若是"落子即连四"，返回其归属
    _winPoint(id) {
      const w = this._windowInfo(id);
      if (w.blocked || w.empty !== 1) return null;
      if (w.c1 === 3) return { side: 1, x: w.ex, y: w.ey };
      if (w.c2 === 3) return { side: 2, x: w.ex, y: w.ey };
      return null;
    }
    // 静态评估：按四格窗口计分，区分"可落空格"与"仍缺支撑的空格"，并阻断中心固定块。
    evaluate(side) {
      const seen = new Set();
      let sum = 0;
      for (const [k, o] of this.board) {
        if (o === 3) continue;
        const p = point(k);
        for (let di = 0; di < DIRS.length; di++) {
          const dx = DIRS[di][0], dy = DIRS[di][1];
          for (let off = 0; off < 4; off++) {
            const id = `${p.x - off * dx},${p.y - off * dy}/${di}`;
            if (seen.has(id)) continue;
            seen.add(id);
            const w = this._windowInfo(id);
            if (w.blocked) continue;
            const a = side === 1 ? w.c1 : w.c2, b = side === 1 ? w.c2 : w.c1;
            if (a && b) continue;
            if (a === 4) return MATE / 4;
            if (b === 4) return -MATE / 4;
            sum += ((WEIGHT[a] || 0) - (WEIGHT[b] || 0)) / (1 + w.unavail * 2);
          }
        }
      }
      return Math.max(-MATE / 4, Math.min(MATE / 4, Math.round(sum)));
    }
    // 四旋转规范键 + 用于还原见证走法的旋转次数（R^rot(实际) = 规范）
    canonical(side) {
      let cells = [...this.board].map(([k, o]) => { const p = point(k); return { x: p.x, y: p.y, o }; });
      let best = null, bestRot = 0;
      for (let r = 0; r < 4; r++) {
        const s = cells.map(p => `${p.x},${p.y}:${p.o}`).sort().join(';');
        if (best === null || s < best) { best = s; bestRot = r; }
        cells = cells.map(p => ({ x: -p.y, y: p.x, o: p.o }));
      }
      return { key: side + '|' + best, rot: bestRot };
    }
    signature(side, rotate) {
      if (rotate) return this.canonical(side).key;
      /* 热路径（每次访问一次）：原写法 `[...this.board].map(([k,o]) => \`${k}:${o}\`)`
         会先为每个条目分配一个 `[k,o]` 二元数组，再分配一个字符串数组 ⇒ 改成单趟 push。
         **TT 键逐字不变**：同样是"每个条目 `k:o`、默认字典序 sort、`;` 连接、`side|` 前缀"。 */
      const a = [];
      for (const [k, o] of this.board) a.push(k + ':' + o);
      a.sort();
      return side + '|' + a.join(';');
    }
  }

  class Budget {
    constructor(deadline, limit) { this.deadline = deadline; this.limit = limit; this.nodes = 0; }
    tick() { if (++this.nodes > this.limit || Date.now() >= this.deadline) throw STOP; }
    over() { return this.nodes >= this.limit || Date.now() >= this.deadline; }
  }

  /* 一次遍历即可得到的严格战术判定：
     己方有即时胜点 → 胜；对手有 >=2 个即时胜点 → 败（一子只能占一个）。 */
  function quickTactics(pos, side) {
    const moves = pos.moves();
    for (let i = 0; i < moves.length; i++) {
      if (pos.winning(moves[i], side)) return { value: 1, move: moves[i], moves: [moves[i]], threats: null };
    }
    const threats = [];
    for (let i = 0; i < moves.length; i++) if (pos.winning(moves[i], 3 - side)) threats.push(moves[i]);
    if (threats.length >= 2) return { value: -1, move: null, moves: threats, threats };
    return { value: null, move: null, moves: threats.length ? threats : moves, threats };
  }

  /* 双威胁 / 活三：落 p 后本方 >=2 个即时胜点、且对方 0 个 → 必胜（构造性证明）。
     本方落子前胜点数为 0（否则 quickTactics 已返回），但**胜点分两类**，两类都要算：
       A. 棋型变化：p 参与连线，在"穿 p 的 16 个窗口"里形成新的三子缺口；
       B. 可达性变化（支撑激活）：某个原有三子缺口 q 因 p 的支撑而变成可落，
          而 q 的赢线**根本不必经过 p**（例如 q 在 p 正上方、赢线是水平的）。
     早期版本只在新增支撑格里查了**对手**，漏掉了本方的第 B 类 —— 那正是本游戏
     最有价值的"支撑激活"造双威胁手。对方的计数反之：加一枚我方子不可能让对手的
     窗口变成"3 同色+1 空"，故对手只可能有 A 类的反例（被占）与 B 类的新增。
     证明（被破坏的胜点）：被 p 破坏的胜点窗口其唯一空格必是 p，故对手既有威胁里
     只有 p 自己可能被占掉。 */
  function winsAfter(pos, p, u, side, oppWinsBefore) {
    const opp = 3 - side;
    const mine = new Set();
    const ids = pos._windowIds(p);
    for (let i = 0; i < ids.length; i++) {
      const w = pos._winPoint(ids[i]);
      if (w && w.side === side) {
        const kk = key(w.x, w.y);
        if (pos.frontier.has(kk)) mine.add(kk);   // A 类
      }
    }
    for (let i = 0; i < u.added.length; i++) {
      const kk = u.added[i];
      if (pos.line(point(kk), side)) mine.add(kk);  // B 类（本方，早期遗漏的一支）
    }
    const theirs = new Set();
    for (let i = 0; i < oppWinsBefore.length; i++) {
      const t = oppWinsBefore[i];
      if (t.x === p.x && t.y === p.y) continue;   // 被 p 占掉
      theirs.add(key(t.x, t.y));
    }
    for (let i = 0; i < u.added.length; i++) {
      const kk = u.added[i];
      if (pos.line(point(kk), opp)) theirs.add(kk);
    }
    return { mine, theirs };
  }
  function forkMove(pos, side, moves, threats, budget, scan) {
    const opp = 3 - side;
    const cands = moves.length > scan ? order(pos, moves, side).slice(0, scan) : moves;
    for (let i = 0; i < cands.length; i++) {
      const p = cands[i];
      if (budget && budget.over()) throw STOP;   // 中断代表没检查完，不代表不存在双威胁
      const u = pos.play(p, side);
      let mine = 0, theirs = 0;
      try {
        const w = winsAfter(pos, p, u, side, threats);
        mine = w.mine.size;
        theirs = w.theirs.size;
      } finally { pos.undo(u); }
      if (mine >= 2 && theirs === 0) return p;
    }
    return null;
  }
  function tactics(pos, side, budget, scan) {
    const q = quickTactics(pos, side);
    if (q.value === 1) return { value: 1, move: q.move, delay: 1, moves: q.moves };
    if (q.value === -1) return { value: -1, move: null, moves: q.moves };
    const fork = forkMove(pos, side, q.moves, q.threats, budget, scan);
    if (fork) return { value: 1, move: fork, delay: 3, moves: [fork] };
    return { value: null, move: null, moves: q.moves };
  }
  function order(pos, moves, side, preferred) {
    return moves.map(p => {
      let value = 0;
      for (const [dx, dy] of DIRS) {
        for (const sign of [-1, 1]) {
          for (let t = 1; t < 4; t++) {
            const o = pos.at(p.x + dx * sign * t, p.y + dy * sign * t);
            if (o === 3) break;
            if (o) value += (o === side ? 4 : 3) / t;
          }
        }
      }
      if (preferred && p.x === preferred.x && p.y === preferred.y) value += MATE;
      return { p, value };
    }).sort((a, b) => b.value - a.value || a.p.x - b.p.x || a.p.y - b.p.y).map(v => v.p);
  }

  // 三值 AND/OR 搜索：1 已证胜，-1 已证败，0 未知。未知绝不当和棋。
  // 只有真正的完整证明才写入 solvedTable（子节点返回 0＝未知时不写）。
  function proveNode(pos, side, depth, ctx) {
    ctx.budget.tick(); ctx.st.proofNodes++;
    const t = tactics(pos, side, ctx.budget, ctx.forkScan);
    if (t.value !== null) return { value: t.value, move: t.move };
    if (depth <= 0) return { value: 0, move: null };
    const ck = pos.canonical(side);
    const hit = ctx.solved.get(ck.key);
    if (hit) {
      ctx.st.solvedHits++;
      return { value: hit.outcome, move: hit.move === null ? null : rotN(hit.move, 4 - ck.rot) };
    }
    let unknown = false;
    const ordered = order(pos, t.moves, side);
    for (let i = 0; i < ordered.length; i++) {
      const p = ordered[i];
      const u = pos.play(p, side);
      let child;
      try { child = proveNode(pos, 3 - side, depth - 1, ctx); } finally { pos.undo(u); }
      if (child.value === -1) {
        if (ctx.solved.size < ctx.maxEntries) { ctx.solved.set(ck.key, { outcome: 1, move: rotN(p, ck.rot) }); ctx.st.solvedStores++; }
        return { value: 1, move: p };
      }
      if (child.value === 0) unknown = true;
    }
    const value = (unknown || !ordered.length) ? 0 : -1;
    if (value === -1 && ctx.solved.size < ctx.maxEntries) { ctx.solved.set(ck.key, { outcome: -1, move: null }); ctx.st.solvedStores++; }
    return { value, move: null };
  }

  function alphaBeta(pos, side, depth, qleft, alpha, beta, ply, ctx, collect) {
    ctx.budget.tick(); ctx.st.evalNodes++;
    const t = tactics(pos, side, ctx.budget, ctx.forkScan);
    if (t.value === 1) return { score: MATE - (ply + t.delay), move: t.move };
    if (t.value === -1) return { score: -MATE + (ply + 2), move: t.moves.length ? t.moves[0] : null };
    const forced = t.moves.length === 1 && pos.winning(t.moves[0], 3 - side);
    if (depth <= 0 && (!forced || qleft <= 0)) return { score: pos.evaluate(side), move: null };

    // 置换表只在 depth>0 的正常区读/写；延伸区（depth<=0 的强制应手）不读不写，
    // 避免把 qleft 语义混进"深度"字段。深度不足时仍用表项的最佳走法排序。
    const useTT = depth > 0;
    const originalAlpha = alpha, originalBeta = beta;
    let ck = null, ttMove = null;
    if (useTT) {
      ck = pos.canonical(side);
      const e = ctx.search.get(ck.key);
      if (e) {
        ctx.st.ttHits++;
        ttMove = e.move === null ? null : rotN(e.move, 4 - ck.rot);
        if (e.depth >= depth) {
          const s = denormScore(e.score, ply);
          if (e.flag === 'exact') return { score: s, move: ttMove };
          if (e.flag === 'lower') alpha = Math.max(alpha, s); else beta = Math.min(beta, s);
          if (alpha >= beta) return { score: s, move: ttMove };
        }
      }
    }
    const preferred = ttMove || (ply === 0 ? ctx.preferred : null);
    const moves = order(pos, t.moves, side, preferred);
    if (collect && ply === 0) ctx.rootInfo = new Map();
    let score = -Infinity, move = null;
    for (let i = 0; i < moves.length; i++) {
      const p = moves[i];
      if (collect && ply === 0) ctx.rootInfo.set(key(p.x, p.y), { move: p, idx: i, score: null });
      const u = pos.play(p, side);
      let v;
      try {
        v = -alphaBeta(pos, 3 - side, Math.max(0, depth - 1),
          depth <= 0 ? qleft - 1 : qleft, -beta, -alpha, ply + 1, ctx, false).score;
      } finally { pos.undo(u); }
      if (collect && ply === 0) { const r0 = ctx.rootInfo.get(key(p.x, p.y)); if (r0) r0.score = v; }
      if (v > score) { score = v; move = p; }
      alpha = Math.max(alpha, v);
      if (alpha >= beta) break;
    }
    if (!move) return { score: pos.evaluate(side), move: null };
    if (useTT) {
      const flag = score <= originalAlpha ? 'upper' : score >= originalBeta ? 'lower' : 'exact';
      const prev = ctx.search.get(ck.key);
      if (prev === undefined || prev.depth <= depth) {
        if (ctx.search.size >= ctx.maxEntries) { ctx.search.clear(); ctx.st.ttFull++; }
        ctx.search.set(ck.key, { depth, flag, score: normScore(score, ply), move: rotN(move, ck.rot) });
        ctx.st.ttStores++;
      }
    }
    return { score, move };
  }

  /* ---- P3：固定攻击方的连续强制威胁搜索 ----
     只证明"连续强制威胁"这一类胜法：攻击方每一步都制造即时威胁（逼对手唯一应手），
     直到直接连四或双杀成立。语义严格：
       找到完整强制胜线 → proven-win（带可回放的证明记录）
       未找到 / 超预算 / 超深度 → unknown
     **绝不把"没有连续杀法"写成必败**，也不写进 solvedTable 的 LOSS。
     攻击候选只筛"制造即时威胁"的走法（含由新增支撑激活的威胁），
     因此它不是全局完备求解器 —— 安静布局型的必胜策略不在其覆盖范围内。
     本游戏与普通连子棋的关键差异：**防守方挡住当前杀点的那一子，
     可能正好给攻击方下一个杀点提供支撑**，这条由"每一步都全量重算双方胜点"覆盖。 */
  function winPointsAll(pos, side) {
    const moves = pos.moves(), out = [];
    for (let i = 0; i < moves.length; i++) if (pos.winning(moves[i], side)) out.push(moves[i]);
    return out;
  }
  // 攻击方候选：所有"落子后本方出现 >=1 个即时胜点"的走法（完整：穿 p 窗口 ∪ 新支撑格）
  function threatMoves(pos, side) {
    const moves = pos.moves(), out = [];
    for (let i = 0; i < moves.length; i++) {
      const p = moves[i];
      const u = pos.play(p, side);
      let has = false;
      try {
        const ids = pos._windowIds(p);
        for (let j = 0; j < ids.length; j++) {
          const w = pos._winPoint(ids[j]);
          if (w && w.side === side) {
            const kk = key(w.x, w.y);
            if (pos.frontier.has(kk)) { has = true; break; }
          }
        }
        if (!has) {
          for (let j = 0; j < u.added.length; j++) {
            if (pos.line(point(u.added[j]), side)) { has = true; break; }
          }
        }
      } finally { pos.undo(u); }
      if (has) out.push(p);
    }
    return out;
  }
  function attackNode(pos, attacker, pliesLeft, ctx) {
    ctx.budget.tick(); ctx.nodes++;
    const mine = winPointsAll(pos, attacker);
    if (mine.length) {
      return { status: 'proven-win', move: mine[0],
        steps: [{ side: attacker, move: mine[0] }], terminal: { kind: 'connect4', at: mine[0] } };
    }
    if (pliesLeft <= 0) return { status: 'unknown' };
    // 只在根节点读证明缓存：保证"新找到"的证书总是带完整记录（缓存命中时记录为 null）
    const ck = pos.canonical(attacker);
    if (ctx.root) {
      const hit = ctx.solved.get(ck.key);
      if (hit && hit.outcome === 1) {
        ctx.cacheHits++;
        return { status: 'proven-win', cached: true,
          move: hit.move === null ? null : rotN(hit.move, 4 - ck.rot), steps: null };
      }
    }
    const cands = threatMoves(pos, attacker);
    const ordered = cands.length > ctx.attackScan ? order(pos, cands, attacker).slice(0, ctx.attackScan) : cands;
    for (let i = 0; i < ordered.length; i++) {
      const p = ordered[i];
      ctx.budget.tick();
      const u = pos.play(p, attacker);
      let res;
      try { res = defenseNode(pos, attacker, pliesLeft - 1, ctx); } finally { pos.undo(u); }
      if (res.status === 'proven-win') {
        if (ctx.solved.size < ctx.maxEntries) ctx.solved.set(ck.key, { outcome: 1, move: rotN(p, ck.rot) });
        return { status: 'proven-win', move: p, terminal: res.terminal,
          steps: [{ side: attacker, move: p }].concat(res.steps || []) };
      }
    }
    return { status: 'unknown' };
  }
  function defenseNode(pos, attacker, pliesLeft, ctx) {
    const defender = 3 - attacker;
    if (winPointsAll(pos, defender).length) return { status: 'failed' };   // 防守方能先连四 → 该攻击无效
    const aw = winPointsAll(pos, attacker);
    if (aw.length >= 2) return { status: 'proven-win', steps: [], terminal: { kind: 'double-threat', wins: aw } };
    if (aw.length === 0) return { status: 'unknown' };   // 攻击方已无即时威胁 → 不属连续威胁搜索
    const only = aw[0];
    const u = pos.play(only, defender);
    let res;
    try { res = attackNode(pos, attacker, pliesLeft - 1, ctx); } finally { pos.undo(u); }
    if (res.status !== 'proven-win') return res;
    return { status: 'proven-win', terminal: res.terminal,
      steps: [{ side: defender, move: only, forced: true }].concat(res.steps || []) };
  }
  function threatSearch(entries, attacker, options = {}) {
    if (attacker !== 1 && attacker !== 2) throw new Error('攻击方必须是 1 或 2');
    const cfg = Object.assign({ plies: 12, attackScan: 24, budget: null, timeMs: 1000,
      cache: null, maxEntries: 50000, root: true }, options);
    const pos = new Position(entries);
    if (pos.winner()) return { status: pos.winner() === attacker ? 'proven-win' : 'unknown', steps: null, nodes: 0, cacheHits: 0 };
    const cache = cfg.cache || createCache(cfg.maxEntries);
    const ctx = { budget: cfg.budget || new Budget(Date.now() + cfg.timeMs, Infinity), nodes: 0,
      solved: cache.solved, maxEntries: cfg.maxEntries, attackScan: cfg.attackScan, cacheHits: 0, root: cfg.root };
    let res;
    try { res = attackNode(pos, attacker, cfg.plies, ctx); }
    catch (e) {
      if (e !== STOP) throw e;
      return { status: 'unknown', exhausted: true, nodes: ctx.nodes, cacheHits: ctx.cacheHits };
    }
    if (res.status !== 'proven-win') return { status: 'unknown', nodes: ctx.nodes, cacheHits: ctx.cacheHits };
    return { status: 'proven-win', move: res.move, cached: !!res.cached,
      matePlies: res.steps ? res.steps.length : 0,
      proof: res.steps ? { attacker, steps: res.steps, terminal: res.terminal } : null,
      nodes: ctx.nodes, cacheHits: ctx.cacheHits };
  }
  /* 独立验证器：不使用候选排序、置换表、局部战术快捷判断
     （`_windowIds` / `_winPoint` / `forkMove` 一律不碰）。
     只用完整合法落点生成 + 双方即时胜点全扫描来复核一条连续威胁证明。
     目的：让"证明"能被一个尽量简单的程序独立回放。
     会检查：每步合法且行棋方正确；防守方每次都没有可立即连四的机会（攻击没给对手先赢）；
     防守确实被迫（当时攻击方恰有 1 个胜点且该步占了它）；攻击每步都制造了威胁；
     终止确实是连四或双杀。 */
  function verifyProof(entries, proof) {
    if (!proof || !Array.isArray(proof.steps) || !proof.steps.length) return { ok: false, reason: '缺少证明步骤' };
    const attacker = proof.attacker;
    if (attacker !== 1 && attacker !== 2) return { ok: false, reason: '攻击方非法' };
    const pos = new Position(entries);
    if (pos.winner()) return { ok: false, reason: '起始局面已终局' };
    const steps = proof.steps;
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      const expect = ((pos.board.size - 1) % 2 === 0) ? 1 : 2;
      if (st.side !== expect) return { ok: false, reason: `第${i + 1}步行棋方不符（应 P${expect}）` };
      if (!pos.frontier.has(key(st.move.x, st.move.y))) return { ok: false, reason: `第${i + 1}步落点非法` };
      const isAttack = st.side === attacker, last = i === steps.length - 1;
      if (!isAttack) {
        if (winPointsAll(pos, st.side).length) return { ok: false, reason: `第${i + 1}步防守方本可立即连四（攻击给了对手先赢）` };
        const aw = winPointsAll(pos, attacker);
        if (aw.length !== 1) return { ok: false, reason: `第${i + 1}步防守并非被迫（当时攻击方胜点数 ${aw.length}）` };
        if (aw[0].x !== st.move.x || aw[0].y !== st.move.y) return { ok: false, reason: `第${i + 1}步未占唯一杀点` };
      }
      pos.play(st.move, st.side);
      const w = pos.winner();
      if (w) {
        if (w !== attacker) return { ok: false, reason: `第${i + 1}步后获胜方不是攻击方` };
        if (!last) return { ok: false, reason: `第${i + 1}步已连四但记录未终止` };
        return { ok: true, plies: steps.length, terminal: 'connect4' };
      }
      if (isAttack) {
        if (winPointsAll(pos, 3 - attacker).length) return { ok: false, reason: `第${i + 1}步后防守方有即时胜点（攻击未防住对手）` };
        const aw = winPointsAll(pos, attacker);
        if (last) {
          if (aw.length >= 2) return { ok: true, plies: steps.length, terminal: 'double-threat' };
          return { ok: false, reason: `末步既非连四也非双杀（攻击方胜点数 ${aw.length}）` };
        }
        if (aw.length < 1) return { ok: false, reason: `第${i + 1}步没有制造任何即时威胁` };
      }
    }
    return { ok: false, reason: '记录未给出终止结论' };
  }

  /* ---- P4：PNS（Proof-Number Search，证明数 / 反证数驱动） ----
     ⚠ 命名要说准：本实现是 **PNS**，不是 DFPN。
       PNS：从根反复"选最有希望的分支 → 走到未展开叶子 → 展开 → 沿路径回传 pn/dn"。
       DFPN：还需要证明数/反证数**阈值**，并在阈值约束下递归搜索子树。
       两者都正确，但不是同一算法；本文件不实现阈值递归，故不叫 DFPN。

     固定一个"待证明获胜方" attacker：

       OR 节点（attacker 行棋）：pn = min(child.pn)，dn = Σ child.dn  —— 找到一个成功分支即可
       AND 节点（对手行棋）    ：pn = Σ child.pn， dn = min(child.dn) —— 必须覆盖全部应对

     **走法展开是完整的**：`expand` 枚举 `pos.moves()` 的**全部**合法落点，
     即已经包含"安静布局手"（不制造即时威胁的走法）。这一点常被误读成
     "P4 只搜有威胁的招" —— 那是 P3 `threatSearch` 的限制，不是这里。
     完整的走法展开 ≠ 在有限预算内能解决局面，也 ≠ 能判定无限棋盘的所有局面。

     终点语义（**必须说清**：无限棋盘可能出现无限对局）：
       - attacker 已连四 / 轮到 attacker 且有即时胜点 / attacker 有双威胁且对方无即时胜点
         → 该节点对 attacker「已证胜」(pn=0)
       - 对手已连四 / 轮到对手且对手有即时胜点 / 轮到 attacker 但对方有 >=2 个即时胜点（己方没有）
         → 「attacker 无法强制获胜」(dn=0)

     **根节点 dn=0 只说明 "attacker 无法强制获胜"** —— 可能是对手胜，也可能是无限对局。
     因此绝不把它当作"对手必胜"，也绝不写进普通胜负表的必败。

     证明结构 = **策略树**：OR 节点只留一条走法，AND 节点保留**全部**合法应手。
     就是"对每个对手应手都有回应"的那棵树，可由 verifyStrategy 独立回放核验。 */
  const INF = 1e9;
  function pnsSearch(entries, attacker, options = {}) {
    if (attacker !== 1 && attacker !== 2) throw new Error('攻击方必须是 1 或 2');
    const cfg = Object.assign({ maxNodes: 1500, timeMs: 1000, cache: null, maxEntries: 50000, stats: false }, options);
    const started = Date.now(), deadline = started + cfg.timeMs;
    const cache = cfg.cache || createCache(cfg.maxEntries);
    const st = { nodes: 0, allNodes: 0, expands: 0, iters: 0, keys: new Set(), keysNoRot: new Set() };

    /* ---- 热路径（mk 每个节点都要跑一次）----
       ① 转置统计（canonical + signature）纯属诊断，默认关；只有 opts.stats 才计算。
       ② 子局面的棋盘是引擎自己落子生成的，构造时不必再走一遍**合法性校验**
          （那套校验是给"外部传入的棋盘"用的，热路径上纯属开销）。
       ③ 连四只可能出现在**刚落的那一格**：用 O(24) 的 line() 取代 O(|B|·24) 的全盘
          winner() 扫描。（根局面没有"上一手"，仍走全盘扫描。）
       ④ 双方即时胜点一次遍历求完（frontier 里的格必定为空且合法，可直接 line()）。 */
    const mkPos = (board) => {
      const p = Object.create(Position.prototype);
      p.board = new Map(board);
      p.frontier = new Set();
      for (const k of p.board.keys()) p.addNeighbors(point(k));
      return p;
    };
    const winPointsBoth = (pos, a, b) => {
      const ms = pos.moves(), A = [], B = [];
      for (let i = 0; i < ms.length; i++) {
        const m = ms[i];
        if (pos.line(m, a)) A.push(m);
        if (pos.line(m, b)) B.push(m);
      }
      return [A, B];
    };

    const mk = (board, side, lastMove, lastSide) => {
      const pos = mkPos(board);
      const node = { board, side, children: null, pn: 1, dn: 1, terminal: null };
      // 转置统计：同一局面可能经不同走法序列到达。
      //   allNodes  = 生成过的局面总数（含终点节点）—— 作重复率的分母
      //   keys      = 四旋转规范化后的唯一局面数
      //   keysNoRot = 不做旋转的唯一局面数（与 keys 之差即"旋转折叠"的额外收益）
      // 注意别拿 nodes 作分母：那是预算计数，不含终点节点，会算出负的重复率。
      st.allNodes++;
      if (cfg.stats) {
        st.keys.add(pos.canonical(side).key);
        st.keysNoRot.add(pos.signature(side, false));
      }
      const w = lastMove ? (pos.line(lastMove, lastSide) ? lastSide : 0) : pos.winner();
      if (w === attacker) { node.terminal = { kind: 'connect4' }; node.pn = 0; node.dn = INF; return node; }
      if (w) { node.terminal = { kind: 'defender-win' }; node.pn = INF; node.dn = 0; return node; }
      const both = winPointsBoth(pos, attacker, 3 - attacker), mine = both[0], theirs = both[1];
      if (side === attacker && mine.length) {
        node.terminal = { kind: 'immediate-win', at: mine[0] }; node.pn = 0; node.dn = INF; return node;
      }
      if (mine.length >= 2 && theirs.length === 0) {
        node.terminal = { kind: 'double-threat', wins: mine.slice(0, 6) }; node.pn = 0; node.dn = INF; return node;
      }
      if (side !== attacker && theirs.length) {
        node.terminal = { kind: 'defender-immediate-win', at: theirs[0] }; node.pn = INF; node.dn = 0; return node;
      }
      if (side === attacker && theirs.length >= 2) {
        node.terminal = { kind: 'defender-double-threat' }; node.pn = INF; node.dn = 0; return node;
      }
      if (++st.nodes > cfg.maxNodes) throw STOP;
      return node;
    };
    const select = node => {
      let best = node.children[0];
      for (let i = 1; i < node.children.length; i++) {
        const c = node.children[i];
        if (node.side === attacker) {
          if (c.node.pn < best.node.pn || (c.node.pn === best.node.pn && c.node.dn < best.node.dn)) best = c;
        } else if (c.node.dn < best.node.dn || (c.node.dn === best.node.dn && c.node.pn < best.node.pn)) best = c;
      }
      return best;
    };
    const expand = node => {
      st.expands++;
      const pos = mkPos(node.board);
      const moves = pos.moves();
      const kids = [];
      for (let i = 0; i < moves.length; i++) {
        const u = pos.play(moves[i], node.side);
        const nb = [...pos.board];
        pos.undo(u);
        // 把"刚落的一格"传给 mk：连四只需查这一格，不必全盘扫描
        kids.push({ move: moves[i], node: mk(nb, 3 - node.side, moves[i], node.side) });
      }
      node.children = kids;
    };
    const update = node => {
      if (!node.children || node.terminal) return;
      let pn, dn;
      if (node.side === attacker) {
        pn = INF; dn = 0;
        for (let i = 0; i < node.children.length; i++) {
          const c = node.children[i].node;
          if (c.pn < pn) pn = c.pn;
          dn += c.dn;
        }
      } else {
        pn = 0; dn = INF;
        for (let i = 0; i < node.children.length; i++) {
          const c = node.children[i].node;
          pn += c.pn;
          if (c.dn < dn) dn = c.dn;
        }
      }
      node.pn = pn > INF ? INF : pn;
      node.dn = dn > INF ? INF : dn;
    };
    const extract = node => {
      if (node.terminal) return { side: node.side, terminal: node.terminal, moves: [] };
      if (!node.children) return null;
      if (node.side === attacker) {
        for (let i = 0; i < node.children.length; i++) {
          if (node.children[i].node.pn === 0) {
            const sub = extract(node.children[i].node);
            if (sub) return { side: node.side, terminal: null, moves: [{ move: node.children[i].move, child: sub }] };
          }
        }
        return null;
      }
      const out = [];
      for (let i = 0; i < node.children.length; i++) {
        if (node.children[i].node.pn !== 0) return null;
        const sub = extract(node.children[i].node);
        if (!sub) return null;
        out.push({ move: node.children[i].move, child: sub });
      }
      return { side: node.side, terminal: null, moves: out };
    };

    // 根节点的行棋方必须按**实际轮次**（落子数奇偶）判定，不能想当然等于 attacker：
    // 当"轮到对手走、要证我方仍能强制获胜"时，根是 AND 节点（对手每个应手都必须输）。
    // 早期版本把根写成 attacker，生成的策略树里会出现"该对手走却只有一条走法"的非法棋框
    // —— 被 verifyStrategy 抓出来（记录 1 步 / 合法 9 步）。
    const rootSide = ((new Position(entries).board.size - 1) % 2 === 0) ? 1 : 2;
    const root = mk(entries, rootSide);
    const path = [];
    try {
      while (root.pn !== 0 && root.dn !== 0) {
        if (Date.now() >= deadline) break;
        st.iters++;
        // 可选的进度回调：每 1024 次迭代一次，用于观察 pn/dn 是否在收敛
        // （诊断用，默认关；回调本身不改变搜索轨迹）
        if (cfg.onTick && (st.iters & 1023) === 0) cfg.onTick(st, root);

        path.length = 0;
        let node = root;
        path.push(node);
        while (node.children && !node.terminal) {
          const c = select(node);
          if (!c) break;
          node = c.node;
          path.push(node);
          if (!node.children && !node.terminal) break;
        }
        if (node.children || node.terminal) break;   // 已无新节点可展开：不再空转
        expand(node);
        for (let i = path.length - 1; i >= 0; i--) update(path[i]);
      }
    } catch (e) { if (e !== STOP) throw e; }

    const base = { nodes: st.nodes, expands: st.expands, iters: st.iters, ms: Date.now() - started,
      pn: root.pn, dn: root.dn, rootSide,
      allNodes: st.allNodes, uniqueRot: cfg.stats ? st.keys.size : null,
      uniqueNoRot: cfg.stats ? st.keysNoRot.size : null };
    if (root.pn === 0) {
      const tree = extract(root);
      // —— 缓存写入必须分清两种命题，不能混用 ——
      // 普通胜负表（solved）：键是"棋盘 + 行棋方"，值是**行棋方**的胜负与见证。
      //   ① 根节点行棋方 === attacker（OR 根）：行棋方胜 → outcome 1，见证 = 攻击方那条走法。
      //   ② 根节点行棋方 !== attacker（AND 根，实际轮到防守方）：行棋方**负** → outcome -1，
      //      并且**绝不能用** tree.moves[0].move —— 那是防守方的一种应手，不是攻击方的获胜见证。
      //      早期版本把 ① 的写法套到 ② 上，等于把防守方应手当成攻击方获胜见证，属缓存命题混淆。
      // 固定攻击方证明表（proofs）：键额外带上 attacker，值只记命题状态（不参与普通搜索的剪枝）。
      if (tree && cache) {
        const sideToMove = rootSide;
        if (cache.solved && cache.solved.size < cfg.maxEntries) {
          const ck = new Position(entries).canonical(sideToMove);
          if (sideToMove === attacker) {
            const wit = tree.moves.length ? tree.moves[0].move
              : (tree.terminal && tree.terminal.at ? tree.terminal.at
                : (tree.terminal && tree.terminal.wins && tree.terminal.wins.length ? tree.terminal.wins[0] : null));
            if (wit) cache.solved.set(ck.key, { outcome: 1, move: rotN(wit, ck.rot) });
          } else {
            // 对方（attacker）强制获胜 ⇒ 行棋方必败；无"行棋方获胜见证"可言
            cache.solved.set(ck.key, { outcome: -1, move: null });
          }
        }
        if (cache.proofs && cache.proofs.size < cfg.maxEntries) {
          const pk = sideToMove + '|' + attacker + '|' + new Position(entries).canonical(sideToMove).key.split('|')[1];
          cache.proofs.set(pk, { status: 'proven-win', mateRef: null });
        }
      }
      return Object.assign({ status: 'proven-win', proof: tree ? { attacker, tree } : null, timedOut: false }, base);
    }
    if (root.dn === 0) {
      return Object.assign({ status: 'refuted', timedOut: false,
        note: '仅表示"attacker 无法强制获胜"（可能是对手胜，也可能是无限对局），不等于对手必胜' }, base);
    }
    return Object.assign({ status: 'unknown', timedOut: true }, base);
  }

  /* 策略树独立验证器：不排序、不用置换表、不用任何局部战术快捷判断。
     只用完整合法落点生成 + 全扫描，逐层复核：
       - 行棋方与落子数奇偶一致；
       - OR 节点（attacker 行棋）恰好 1 步，且走子合法、子树成立；
       - AND 节点（对手行棋）**覆盖全部合法应手**，且每个子树都成立；
       - 终点必须是：已连四 / 轮到自己且有即时胜点 / 双威胁（己方 >=2 胜点且对方 0 个）。 */
  function verifyStrategy(entries, attacker, tree) {
    if (!tree) return { ok: false, reason: '缺少策略树' };
    if (attacker !== 1 && attacker !== 2) return { ok: false, reason: '攻击方非法' };
    const pos = new Position(entries);
    let count = 0;
    const walk = (side, node) => {
      if (++count > 500000) return { ok: false, reason: '策略树过大（>50 万节点）' };
      const expect = ((pos.board.size - 1) % 2 === 0) ? 1 : 2;
      if (side !== expect) return { ok: false, reason: `行棋方不符（应 P${expect}，记 P${side}）` };
      const w = pos.winner();
      if (node.terminal) {
        const t = node.terminal;
        if (t.kind === 'connect4') return w === attacker ? null : { ok: false, reason: 'connect4 终点不成立' };
        if (t.kind === 'double-threat') {
          const a = winPointsAll(pos, attacker).length, d = winPointsAll(pos, 3 - attacker).length;
          return (a >= 2 && d === 0) ? null : { ok: false, reason: `double-threat 终点不成立（胜点 ${a}/${d}）` };
        }
        if (t.kind === 'immediate-win') {
          if (side !== attacker) return { ok: false, reason: 'immediate-win 终点出现在对手回合' };
          return pos.winning(t.at, attacker) ? null : { ok: false, reason: 'immediate-win 指向的不是即时胜点' };
        }
        return { ok: false, reason: '未知终点类型：' + t.kind };
      }
      if (w) return { ok: false, reason: w === attacker ? '已连四却仍在展开' : '该子树里防守方已连四' };
      const moves = pos.moves();
      if (side === attacker) {
        if (!node.moves || node.moves.length !== 1) return { ok: false, reason: 'OR 节点必须恰好 1 步' };
        const m = node.moves[0].move;
        if (!pos.frontier.has(key(m.x, m.y))) return { ok: false, reason: 'OR 步非法' };
        const u = pos.play(m, side);
        const err = walk(3 - side, node.moves[0].child);
        pos.undo(u);
        return err;
      }
      if (!node.moves || node.moves.length !== moves.length) {
        return { ok: false, reason: `AND 节点未覆盖全部应手（记录 ${node.moves ? node.moves.length : 0} / 合法 ${moves.length}）` };
      }
      const got = new Set();
      for (const e of node.moves) got.add(key(e.move.x, e.move.y));
      for (const m of moves) if (!got.has(key(m.x, m.y))) return { ok: false, reason: `AND 节点缺少应手 ${m.x},${m.y}` };
      for (const e of node.moves) {
        if (!pos.frontier.has(key(e.move.x, e.move.y))) return { ok: false, reason: 'AND 步非法' };
        const u = pos.play(e.move, side);
        const err = walk(3 - side, e.child);
        pos.undo(u);
        if (err) return err;
      }
      return null;
    };
    const err = walk(((pos.board.size - 1) % 2 === 0) ? 1 : 2, tree);
    if (err) return err;
    return { ok: true, nodes: count };
  }

  /* 把已验证的策略树压缩成 DAG：按"局面（四旋转规范）+ 行棋方"合并相同子树。
     ⚠ 证明的**正确性不依赖**这次压缩：压缩只省空间/便于持久化，
       核验时仍必须逐节点检查 OR/AND 结构与终点（见 verifyStrategyDag）。 */
  function compressStrategy(entries, tree) {
    if (!tree) return null;
    const pos = new Position(entries);
    const nodes = [], index = new Map();
    const intern = (node, key) => {
      if (index.has(key)) return index.get(key);
      const id = nodes.length;
      const rec = { side: node.side, terminal: node.terminal || null, moves: [] };
      nodes.push(rec); index.set(key, id);
      if (!node.terminal) {
        for (let i = 0; i < node.moves.length; i++) {
          const e = node.moves[i];
          const u = pos.play(e.move, node.side);
          const childKey = pos.canonical(3 - node.side).key;
          const cid = intern(e.child, childKey);
          pos.undo(u);
          rec.moves.push({ move: e.move, child: cid });
        }
      }
      return id;
    };
    const root = intern(tree, pos.canonical(tree.side).key);
    return { root, nodes };
  }

  /* DAG 版核验：与 verifyStrategy 同一套判定，但按 DAG 节点 id 记忆化。
     安全性依据：一个 DAG 节点对应唯一局面，局面决定行棋方；因此先断言
     "节点记录的行棋方 === 由落子数奇偶推出的行棋方"，再记忆化，共享子树只需核验一次。 */
  function verifyStrategyDag(entries, attacker, dag) {
    if (!dag || !Array.isArray(dag.nodes) || !dag.nodes.length) return { ok: false, reason: '缺少 DAG' };
    if (attacker !== 1 && attacker !== 2) return { ok: false, reason: '攻击方非法' };
    const pos = new Position(entries);
    if (pos.winner()) return { ok: false, reason: '起始局面已终局' };
    const memo = new Map();
    let visited = 0, memoHits = 0;
    const walk = id => {
      if (memo.has(id)) { memoHits++; return null; }
      const node = dag.nodes[id];
      if (!node) return { ok: false, reason: `DAG 节点 ${id} 不存在` };
      const side = node.side;
      const expect = ((pos.board.size - 1) % 2 === 0) ? 1 : 2;
      if (side !== expect) return { ok: false, reason: `DAG 节点 ${id} 的行棋方与局面不符（应 P${expect}，记 P${side}）` };
      visited++;
      const w = pos.winner();
      if (node.terminal) {
        const t = node.terminal;
        let err = null;
        if (t.kind === 'connect4') { if (w !== attacker) err = { ok: false, reason: `节点 ${id} connect4 终点不成立` }; }
        else if (t.kind === 'double-threat') {
          const a = winPointsAll(pos, attacker).length, d = winPointsAll(pos, 3 - attacker).length;
          if (!(a >= 2 && d === 0)) err = { ok: false, reason: `节点 ${id} double-threat 终点不成立（${a}/${d}）` };
        } else if (t.kind === 'immediate-win') {
          if (side !== attacker) err = { ok: false, reason: `节点 ${id} immediate-win 出现在对手回合` };
          else if (!pos.winning(t.at, attacker)) err = { ok: false, reason: `节点 ${id} immediate-win 指向的不是胜点` };
        } else err = { ok: false, reason: `节点 ${id} 未知终点类型：${t.kind}` };
        if (!err) memo.set(id, true);   // 终点节点也要记忆化，否则共享子树会被反复走
        return err;
      }
      if (w) return { ok: false, reason: `节点 ${id}：${w === attacker ? '已连四却仍展开' : '防守方已连四'}` };
      const legal = pos.moves();
      const moves = node.moves || [];
      if (side === attacker) {
        if (moves.length !== 1) return { ok: false, reason: `节点 ${id}（OR）必须恰好 1 步` };
        const m = moves[0].move;
        if (!pos.frontier.has(key(m.x, m.y))) return { ok: false, reason: `节点 ${id} OR 步非法` };
        const u = pos.play(m, side);
        const err = walk(moves[0].child);
        pos.undo(u);
        if (err) return err;
      } else {
        if (moves.length !== legal.length) return { ok: false, reason: `节点 ${id}（AND）未覆盖全部应手（${moves.length}/${legal.length}）` };
        const got = new Set();
        for (const e of moves) got.add(key(e.move.x, e.move.y));
        for (const m of legal) if (!got.has(key(m.x, m.y))) return { ok: false, reason: `节点 ${id} 缺少应手 ${m.x},${m.y}` };
        if (winPointsAll(pos, side).length) return { ok: false, reason: `节点 ${id}：对手本可立即连四` };
        for (const e of moves) {
          if (!pos.frontier.has(key(e.move.x, e.move.y))) return { ok: false, reason: `节点 ${id} AND 步非法` };
          const u = pos.play(e.move, side);
          const err = walk(e.child);
          pos.undo(u);
          if (err) return err;
        }
      }
      memo.set(id, true);
      return null;
    };
    const err = walk(dag.root);
    if (err) return err;
    return { ok: true, nodes: visited, memoHits, dagNodes: dag.nodes.length };
  }

  /* ---- 反证证书的库内核验器（搜索层独立：不排序、不用置换表、不碰局部战术快捷） ----
     命题：「attacker 无法在 ≤maxPlies 半回合内强制连四」。
     证书是**防守策略**（与获胜策略树对偶）：
       - 攻击方回合：覆盖全部合法走法；
       - 防守方回合：恰好 1 步（见证）；
       - 终点：defender 已连四 / 防守方有即时胜点 / 防守方双杀（攻击方 0 胜点）/ 半回合用尽且未分胜负。
     **判定顺序：先查胜负，再查深度** —— 否则"最后允许的那一步恰好连四"会被误判成"超时未胜"。
     深度用 `rem` 逐层递减，`depth-limit` 终点必须恰好落在 rem===0；由于 rem 单调递减，
     证书深度天然 ≤ maxPlies，不需要额外的高度检查。 */
  function verifyRefutation(entries, attacker, ref) {
    if (!ref || !ref.tree) return { ok: false, reason: '缺少反证证书' };
    if (ref.kind !== 'refutation') return { ok: false, reason: '证书类型不是 refutation' };
    if (!Number.isInteger(ref.maxPlies) || ref.maxPlies <= 0) return { ok: false, reason: '反证证书必须带正整数半回合上限' };
    if (attacker !== 1 && attacker !== 2) return { ok: false, reason: '攻击方非法' };
    const defender = 3 - attacker;
    const pos = new Position(entries);
    let count = 0, attackerNodes = 0, leaves = 0;
    const walk = (side, rem, node) => {
      if (++count > 500000) return { ok: false, reason: '反证证书过大（>50 万节点）' };
      const expect = ((pos.board.size - 1) % 2 === 0) ? 1 : 2;
      if (side !== expect) return { ok: false, reason: `行棋方不符（应 P${expect}，记 P${side}）` };
      const w = pos.winner();
      if (w === attacker) return { ok: false, reason: '证书里出现攻击方已连四（反证不成立）' };
      if (node.terminal) {
        leaves++;
        const t = node.terminal;
        if (t.kind === 'depth-limit') {
          if (w) return { ok: false, reason: 'depth-limit 终点却已终局' };
          return rem === 0 ? null : { ok: false, reason: `depth-limit 终点出现在还有 ${rem} 半回合时` };
        }
        if (t.kind === 'connect4' || t.kind === 'defender-win') {
          return w === defender ? null : { ok: false, reason: 'defender 连四终点不成立' };
        }
        if (t.kind === 'defender-immediate-win') {
          if (side !== defender) return { ok: false, reason: 'defender-immediate-win 出现在攻击方回合' };
          return winPointsAll(pos, defender).length >= 1 ? null : { ok: false, reason: 'defender-immediate-win 不成立' };
        }
        if (t.kind === 'defender-double-threat') {
          if (side !== attacker) return { ok: false, reason: 'defender-double-threat 出现在防守方回合' };
          return (winPointsAll(pos, attacker).length === 0 && winPointsAll(pos, defender).length >= 2)
            ? null : { ok: false, reason: 'defender-double-threat 不成立' };
        }
        return { ok: false, reason: '反证证书里出现非法终点：' + t.kind };
      }
      if (w) return { ok: false, reason: '已终局却仍在展开' };
      if (rem <= 0) return { ok: false, reason: '半回合已用尽却不是 depth-limit 终点' };
      const moves = node.moves || [];
      const legal = pos.moves();
      if (side === attacker) {
        attackerNodes++;
        if (moves.length !== legal.length) {
          return { ok: false, reason: `攻击方节点未覆盖全部走法（${moves.length}/${legal.length}）` };
        }
        const got = new Set(moves.map(e => key(e.move.x, e.move.y)));
        for (const m of legal) if (!got.has(key(m.x, m.y))) return { ok: false, reason: `攻击方节点缺少走法 ${m.x},${m.y}` };
        for (const e of moves) {
          if (!pos.frontier.has(key(e.move.x, e.move.y))) return { ok: false, reason: '攻击方走法非法' };
          const u = pos.play(e.move, side);
          const err = walk(defender, rem - 1, e.child);
          pos.undo(u);
          if (err) return err;
        }
        return null;
      }
      if (moves.length !== 1) return { ok: false, reason: '防守方节点必须恰好 1 步（见证）' };
      const m = moves[0].move;
      if (!pos.frontier.has(key(m.x, m.y))) return { ok: false, reason: '防守方走法非法' };
      const u = pos.play(m, side);
      const err = walk(attacker, rem - 1, moves[0].child);
      pos.undo(u);
      return err;
    };
    const err = walk(((pos.board.size - 1) % 2 === 0) ? 1 : 2, ref.maxPlies, ref.tree);
    return err || { ok: true, nodes: count, attackerNodes, leaves };
  }

  /* 三张表各管一件事，键与命题都不一样：
       tt     ：置换表（局面 + 行棋方）→ 深度受限的搜索界
       solved ：普通胜负表（局面 + 行棋方）→ 该**行棋方**的胜/负 + 见证
       proofs ：固定攻击方证明表（局面 + 行棋方 + attacker）→ 命题状态（不参与剪枝） */
  function createCache(maxEntries) {
    return { tt: new Map(), solved: new Map(), proofs: new Map(), maxEntries: maxEntries || 200000 };
  }

  /* ===================== 有界结论的**区间复用** =====================
     对固定的（规则版本 + 棋盘 + 行棋方 + 攻击方）维护两个**独立**事实：

       L = 已证"无法在 ≤L 半回合内强制连四"的**最大** L
       U = 已证"能在 ≤U 半回合内强制连四"的**最小** U

     单调性（这两条是被区间复用合法性的全部依据）：
       - `refuted` **向下封闭**：N ≤ L 时，同一个 N 也必然 refuted（"≤L 内赢不了" ⇒ "≤N 内赢不了"）。
       - `proven-win` **向上封闭**：N ≥ U 时必然 proven-win（"≤U 内能赢" ⇒ "≤N 内也能赢"）。
       `L < N < U` ⇒ 区间内仍需真搜。**没有 U 不代表永远赢不了；没有 L 不代表小深度能赢。**

     ⚠ 两条硬约束（评审要求，也是这类缓存唯一容易出错的地方）：
       1. **只有已完成、已证明的结论才能写入** L/U。预算耗尽、部分展开、启发式评分**一律不写**。
       2. **查询结论 ≠ 导出证书**，两者分开：
          - 复用**更长**的防守证书回答**更短** horizon：必须**截断**（把深度 > N 的子树换成
            深度恰为 N 的 `depth-limit` 叶子）并**重新核验**（核验器要求 depth-limit 出现在 rem=0）。
          - 复用**更短**的获胜证明回答**更大** horizon：获胜树只含真终点（`connect4`），
            与深度无关 ⇒ 原样可用，但**真实获胜距离**必须保留（不要把 U 说成精确值）。
     证书按 `certMaxNodes` 决定是否随 L/U 一起缓存：**超限就只存结论、不存证书**
     （此时证明类调用会回落到真搜，并在诊断里记为 `verdictOnlyMiss`，便于量化"省不到的那部分"）。 */
  function createBoundCache(maxEntries, certMaxNodes) {
    // ⚠ 用 `== null` 而不是 `||`：`0` 是**有意义**的取值（例如 certMaxNodes=0 表示"只存结论不存证书"），
    //   写成 `x || 默认值` 会把 0 悄悄换成默认值（回归抓到过）。
    return { bounds: new Map(),
      maxEntries: maxEntries == null ? 200000 : maxEntries,
      certMaxNodes: certMaxNodes == null ? 200000 : certMaxNodes,
      // 确定性成本度量（纯诊断，由 dfpnSearch 累加）；`maxEntries = 0` ⇒ 永不写入 = 天然对照组
      searchNodes: 0, searchCalls: 0,
      stores: 0, queries: 0, hitsVerdict: 0, hitsCert: 0, verdictOnlyMiss: 0 };
  }
  const boundKeyOf = (entries, side, attacker, rv) =>
    (rv || RULE_VERSION) + '|' + side + '|' + attacker + '|' + boardKey(new Position(entries));
  const boundSideOf = entries => ((new Position(entries).board.size - 1) % 2 === 0) ? 1 : 2;
  const treeDepth = t => { let d = 0; const w = (x, k) => { if (k > d) d = k; if (!x.terminal) for (const e of x.moves) w(e.child, k + 1); }; w(t, 0); return d; };

  /* **只查结论**（不产出证书）：给"我只要知道这个 N 上是什么"的调用方用。
     注意返回的 `L`/`U` 是**已证区间端点**：`U` 是上界不是精确距离；没有 `U` 不代表永远赢不了。 */
  function boundLookup(cache, entries, attacker, N, rv) {
    if (!cache || !(N > 0)) return { status: 'miss' };
    cache.queries++;
    const side = boundSideOf(entries);
    const rec = cache.bounds.get(boundKeyOf(entries, side, attacker, rv));
    if (!rec) return { status: 'miss', L: null, U: null };
    if (rec.L !== null && N <= rec.L) { cache.hitsVerdict++; return { status: 'refuted', L: rec.L, U: rec.U, source: 'L' }; }
    if (rec.U !== null && N >= rec.U) { cache.hitsVerdict++; return { status: 'proven-win', L: rec.L, U: rec.U, source: 'U' }; }
    return { status: 'miss', L: rec.L, U: rec.U };
  }
  /* 写入：**只接受已完成结论**；status 必须恰好是 'refuted' / 'proven-win'。
     证书分两类各自择优保存（都只在不超过 `certMaxNodes` 时保存）：
       - `refCert`：maxPlies **最大**的那份（能用截断回答任意更短的 N）
       - `winCert`：depth **最小**的那份（能用原样回答任意更大的 N，且报告真实距离）
     ⚠ 两类证书各自带**自己的**距离（`maxPlies` / `depth`）；复用条件必须同时检查距离，
       否则会用"深度 8 的获胜树"去回答"能否在 ≤3 内赢"。 */
  function boundStore(cache, entries, attacker, N, status, rv, proof) {
    if (!cache || !(N > 0)) return null;
    if (status !== 'refuted' && status !== 'proven-win') return null;
    const side = boundSideOf(entries);
    const k = boundKeyOf(entries, side, attacker, rv);
    let rec = cache.bounds.get(k);
    if (!rec) {
      if (cache.bounds.size >= cache.maxEntries) return null;
      rec = { L: null, U: null, refCert: null, winCert: null };
      cache.bounds.set(k, rec);
    }
    if (status === 'refuted') rec.L = rec.L === null ? N : Math.max(rec.L, N);
    else rec.U = rec.U === null ? N : Math.min(rec.U, N);
    if (proof && proof.tree) {
      const nodes = countTreeNodes(proof.tree);
      if (nodes <= cache.certMaxNodes) {
        if (status === 'refuted') {
          if (!rec.refCert || proof.maxPlies > rec.refCert.maxPlies) rec.refCert = proof;
          // 证书本身也收紧区间端点：maxPlies 的防守证书直接证明"≤maxPlies 内赢不了"
          rec.L = rec.L === null ? proof.maxPlies : Math.max(rec.L, proof.maxPlies);
        } else {
          const d = treeDepth(proof.tree);
          if (!rec.winCert || d < rec.winCert.depth) rec.winCert = { proof, depth: d };
          // 获胜树的深度 d 证明"≤d 内能赢" ⇒ U 可收到 d（比搜索用的 horizon 更紧，且仍然可靠）
          rec.U = rec.U === null ? d : Math.min(rec.U, d);
        }
      }
    }
    cache.stores++;
    return rec;
  }
  function countTreeNodes(t) { let n = 0; const w = x => { n++; if (!x.terminal) for (const e of x.moves) w(e.child); }; w(t); return n; }
  /* 把一份 horizon 为 L 的反证证书**截断**到 horizon N（N ≤ L）：
     深度 > N 的子树一律换成"深度恰为 N 的 depth-limit 叶子"。
     核验器要求 `depth-limit` 出现在 rem === 0（即深度恰为 maxPlies），所以必须真的截断，
     不能只改 maxPlies 字段。 */
  function truncateRefutation(ref, N) {
    if (!ref || !ref.tree || !(N > 0)) return null;
    if (!(N <= ref.maxPlies)) return null;
    const walk = (node, depth) => {
      if (node.terminal) return { side: node.side, terminal: node.terminal, moves: [] };
      if (depth >= N) return { side: node.side, terminal: { kind: 'depth-limit' }, moves: [] };
      return { side: node.side, terminal: null,
        moves: node.moves.map(e => ({ move: e.move, child: walk(e.child, depth + 1) })) };
    };
    return { kind: 'refutation', attacker: ref.attacker, maxPlies: N,
      root: ref.root ? ref.root.slice() : undefined, tree: walk(ref.tree, 0) };
  }

  function chooseMove(entries, side, options = {}) {
    if (side !== 1 && side !== 2) throw new Error('行棋方必须是 1 或 2');
    const cfg = { timeMs: 1500, maxNodes: 100000, maxDepth: 8, proofDepth: 10,
      proofFraction: 0.25, qDepth: 8, maxEntries: 50000, forkScan: DEFAULT_FORK_SCAN,
      threatPlies: 12, threatFraction: 0.2, threatScan: 24,
      // P4 的 PNS **默认关闭**：实测在 200ms / 1500ms 预算下新增覆盖为 0~1（且与 P3 重叠），
      // 却要多花 7~63ms/局面。它更适合当**离线证明引擎**（对关键局面出完整策略树再独立核验），
      // 要实时启用就显式传 pnsNodes（见 docs/07 第十节）。
      pnsNodes: 0, pnsFraction: 0.25,
      cache: null, ...options };
    for (const name of ['timeMs', 'maxNodes', 'maxDepth', 'proofDepth', 'qDepth', 'maxEntries',
      'forkScan', 'threatPlies', 'threatScan', 'pnsNodes']) {
      if (!Number.isFinite(cfg[name]) || cfg[name] < 0 ||
          (name !== 'timeMs' && !Number.isInteger(cfg[name]))) throw new Error(`无效预算：${name}`);
    }
    if (!(cfg.proofFraction >= 0 && cfg.proofFraction <= 1)) throw new Error('proofFraction 必须在 0 到 1 之间');
    if (!(cfg.threatFraction >= 0 && cfg.threatFraction <= 1)) throw new Error('threatFraction 必须在 0 到 1 之间');
    if (!(cfg.pnsFraction >= 0 && cfg.pnsFraction <= 1)) throw new Error('pnsFraction 必须在 0 到 1 之间');
    const pos = new Position(entries), started = Date.now();
    const st = { proofNodes: 0, evalNodes: 0, ttHits: 0, ttStores: 0, ttFull: 0,
      solvedHits: 0, solvedStores: 0 };
    const winner = pos.winner();
    if (winner) return { move: null, status: winner === side ? 'proven-win' : 'proven-loss', terminal: true,
      nodes: { proof: 0, eval: 0, total: 0 }, ms: { proof: 0, eval: 0, total: 0 } };
    const cache = cfg.cache || createCache(cfg.maxEntries);
    const ctx = { budget: null, solved: cache.solved, search: cache.tt, maxEntries: cfg.maxEntries,
      forkScan: cfg.forkScan, st, preferred: null, rootInfo: null };
    let exhausted = false;

    // 便宜的严格战术先做（不受预算约束，保证 timeMs=0 也能抓到即时胜/双杀）
    const q = quickTactics(pos, side);
    if (q.value !== null) {
      return { move: q.move || order(pos, pos.moves(), side)[0] || null,
        status: q.value === 1 ? 'proven-win' : 'proven-loss', score: null,
        proofDepth: 0, completedDepth: 0, exhausted: false,
        tactical: q.value === 1 ? 'immediate-win' : 'double-threat-loss',
        nodes: { proof: 0, eval: 0, total: 0 }, ms: { proof: 0, eval: 0, total: Date.now() - started } };
    }

    // —— 阶段 1a：连续强制威胁（独立预算通道，与主搜索共用同一个绝对截止时间）——
    // 只在根局面调用（不在每个叶子调用，避免重复之前的性能问题）；
    // 找到证明就采用，找不到就继续走原来的完整走法 alpha-beta，绝不因此删除安静走法。
    let threatInfo = null;
    if (cfg.threatPlies > 0 && cfg.threatFraction > 0) {
      const share = Math.min(cfg.proofFraction, cfg.threatFraction);
      const tBudget = new Budget(started + Math.floor(cfg.timeMs * share),
        Math.floor(cfg.maxNodes * share));
      const tr = threatSearch(entries, side, { plies: cfg.threatPlies, attackScan: cfg.threatScan,
        budget: tBudget, cache, maxEntries: cfg.maxEntries });
      threatInfo = { calls: 1, nodes: tBudget.nodes, ms: Date.now() - started,
        status: tr.status, matePlies: tr.matePlies || 0, cacheHits: tr.cacheHits || 0,
        timedOut: !!tr.exhausted };
      if (tr.status === 'proven-win') {
        const proofOk = tr.proof ? verifyProof(entries, tr.proof) : null;
        return { move: tr.move, status: 'proven-win', score: null, proof: tr.proof || null,
          proofVerified: proofOk ? proofOk.ok : null, matePlies: tr.matePlies || 0,
          proofDepth: 0, completedDepth: 0, exhausted: false, threat: threatInfo,
          nodes: { proof: tBudget.nodes, eval: 0, total: tBudget.nodes },
          ms: { proof: Date.now() - started, eval: 0, total: Date.now() - started },
          tt: { searchSize: ctx.search.size, searchHits: 0, stores: 0, full: 0,
            solvedSize: ctx.solved.size, solvedHits: 0, solvedStores: 0 } };
      }
    }

    // —— 阶段 1b（P4）：PNS —— 证明数/反证数驱动，比按层加深更会分配预算。
    // 同样只在根局面调用、共用绝对截止时间、有自己的预算上限。
    // 注意：**只采用 proven-win**；'refuted' 仅表示"本方能强制获胜被反证"，
    // 在无限棋盘上不等于"对方必胜"，因此既不据此选招、也不写入 solvedTable 的必败。
    let pnsInfo = null;
    if (cfg.pnsNodes > 0 && cfg.pnsFraction > 0) {
      const share = Math.min(cfg.proofFraction, cfg.pnsFraction);
      const dDeadline = started + Math.floor(cfg.timeMs * share);
      const dr = pnsSearch(entries, side, { maxNodes: cfg.pnsNodes,
        timeMs: Math.max(0, dDeadline - Date.now()), cache, maxEntries: cfg.maxEntries });
      pnsInfo = { calls: 1, nodes: dr.nodes, expands: dr.expands, iters: dr.iters,
        ms: dr.ms, status: dr.status, pn: dr.pn, dn: dr.dn, rootSide: dr.rootSide };
      if (dr.status === 'proven-win') {
        const tree = dr.proof && dr.proof.tree;
        // 根节点直接是终点时（例如双威胁）树里没有 OR 走法，需从终点信息里取一步
        let first = tree && tree.moves.length ? tree.moves[0].move : null;
        if (!first && tree && tree.terminal) {
          const t = tree.terminal;
          if (t.at) first = t.at;
          else if (t.wins && t.wins.length) first = t.wins[0];
        }
        if (first) {
          const v = tree ? verifyStrategy(entries, side, tree) : null;
          return { move: first, status: 'proven-win', score: null,
            proof: dr.proof || null, proofVerified: v ? v.ok : null,
            proofNodes: v && v.ok ? v.nodes : null,
            proofDepth: 0, completedDepth: 0, exhausted: false,
            threat: threatInfo, pns: pnsInfo,
            nodes: { proof: dr.nodes, eval: 0, total: dr.nodes },
            ms: { proof: Date.now() - started, eval: 0, total: Date.now() - started },
            tt: { searchSize: ctx.search.size, searchHits: 0, stores: 0, full: 0,
              solvedSize: ctx.solved.size, solvedHits: 0, solvedStores: 0 } };
        }
      }
    }

    // —— 阶段 1c：证明（根节点战术扫描也在这段预算内）——
    ctx.budget = new Budget(started + Math.floor(cfg.timeMs * cfg.proofFraction),
      Math.max(0, Math.floor(cfg.maxNodes * cfg.proofFraction)
        - (threatInfo ? threatInfo.nodes : 0) - (pnsInfo ? pnsInfo.nodes : 0)));
    let move = order(pos, q.moves, side)[0] || null;
    let proofDepth = 0, proofStatus = 'unknown';
    try {
      for (let d = 1; d <= cfg.proofDepth; d++) {
        const r = proveNode(pos, side, d, ctx);
        proofDepth = d;
        if (r.value !== 0) { proofStatus = r.value === 1 ? 'proven-win' : 'proven-loss'; if (r.move) move = r.move; break; }
      }
    } catch (e) { if (e !== STOP) throw e; exhausted = true; }
    const proofMs = Date.now() - started;
    const proofNodeCount = Math.min(ctx.budget.nodes, ctx.budget.limit);
    const ttInfo = () => ({ searchSize: ctx.search.size, searchHits: st.ttHits, stores: st.ttStores,
      full: st.ttFull, solvedSize: ctx.solved.size, solvedHits: st.solvedHits, solvedStores: st.solvedStores });
    if (proofStatus === 'proven-win') {
      return { move, status: proofStatus, score: null, proofDepth, completedDepth: 0, exhausted, threat: threatInfo, pns: pnsInfo,
        nodes: { proof: proofNodeCount, eval: 0, total: proofNodeCount },
        ms: { proof: proofMs, eval: 0, total: proofMs }, tt: ttInfo() };
    }

    // —— 阶段 2：估值（同一绝对截止时间，用剩余预算）——
    ctx.budget = new Budget(started + cfg.timeMs, Math.max(0, cfg.maxNodes - proofNodeCount));
    let completedDepth = 0, score = null, rootCandidates = null;
    try {
      for (let d = 1; d <= cfg.maxDepth; d++) {
        const r = alphaBeta(pos, side, d, cfg.qDepth, -Infinity, Infinity, 0, ctx, true);
        if (r.move) move = r.move;
        score = r.score;
        completedDepth = d;
        if (ctx.rootInfo) {
          rootCandidates = [...ctx.rootInfo.values()].sort((a, b) => a.idx - b.idx)
            .map(x => ({ move: x.move, idx: x.idx, score: x.score }));
        }
        ctx.preferred = move;
        if (Math.abs(score) > MATE / 2) break;
      }
    } catch (e) { if (e !== STOP) throw e; exhausted = true; }
    const evalNodeCount = Math.min(ctx.budget.nodes, ctx.budget.limit);
    return { move, status: proofStatus, score, completedDepth, proofDepth, exhausted, rootCandidates,
      threat: threatInfo, pns: pnsInfo,
      nodes: { proof: proofNodeCount, eval: evalNodeCount, total: proofNodeCount + evalNodeCount },
      ms: { proof: proofMs, eval: Math.max(0, Date.now() - started - proofMs), total: Date.now() - started },
      tt: ttInfo(), budgetMs: cfg.timeMs };
  }

  /* ============================================================
     df-pn（Depth-First Proof-Number Search，**阈值递归**）+ 置换表

     与上面的 PNS 的区别（这也是它名字不同的原因）：
       - PNS：每轮从根走"最有希望的分支"到未展开叶子 → 展开 → 沿路径回传，**没有阈值**。
       - df-pn：给每个递归调用一对阈值 (thpn, thdn)；节点一旦 `pn >= thpn || dn >= thdn`
         就**立即返回**，把预算全部集中到"最接近被解决"的那条链上。
         子节点阈值由父节点当前值导出：
           OR（attacker 行棋）：子阈值 = (min(thpn, pn - pn_i + 1), thdn - (dn - dn_i))
           AND（对手行棋）    ：子阈值 = (thpn - (pn - pn_i), min(thdn, dn - dn_i + 1))

     **为什么要在这里用它**：本游戏的局面图是 **DAG**（每手只加一子，无环、无重复局面到自身），
     df-pn 在无环局面图上的证明搜索是标准用法。更关键的是它**惰性展开**：
     一个节点被展开时只登记走法（pn=dn=1），**只有真正下潜到某个子节点时才做终局判定**。
     PNS 的 `expand` 则会给全部 b 个子节点各做一次完整的"双方即时胜点全扫描"，
     而其中绝大多数永远不会被访问 —— 这正是 PNS 在大分支局面下空转的原因。

     语义与 PNS 完全一致（终点、pn/dn 的 OR/AND 定义都相同）：
       - `pn === 0` → attacker 已证强制获胜（可导出策略树）
       - `dn === 0` → 「attacker 无法强制获胜」（**不等于对手必胜**）
     证明的正确性最终由 verifyStrategy / verify-strategy.js 独立核验，不依赖本搜索的实现细节。

     已知边界：阈值用饱和算术（求和截断在 INF），因此导出的子阈值偶尔会比理论值更紧，
     只会让搜索**提前返回**（少搜），不会凭空造出 `pn=0`；配合独立核验，安全性不受影响。
     ============================================================ */
  /* df-pn 的**子节点阈值**（纯函数，抽出来是为了能单独审查与单测）。
     记号：父节点 `n`（OR = attacker 行棋 / AND = 对手行棋），选中子节点 `e`；
          `pn2`/`dn2` 是**次小**的 pn / dn（只有一个子节点时为 Infinity）。

     OR（attacker 行棋，pn = min 子、dn = Σ 子）：
        thpn_child = min(thpn, pn2 + 1)   —— 父的 pn 要再降，必须降到"次小值"以下
        thdn_child = thdn - (dn - dn_e)   —— dn 由其余子节点提供，本子只需补差额
     AND（对手行棋，pn = Σ 子、dn = min 子）：
        thdn_child = min(thdn, dn2 + 1)
        thpn_child = thpn - (pn - pn_e)

     ⚠ 早期版本把 OR 的 thpn 写成 `min(thpn, pn - pn_e + 1)`（等价于"强行提高"），
       在 `pn = pn_e = 1` 时得到 1，与展开后 `pn = 子节点数 ≥ 2` 的 AND 子节点冲突 ⇒
       `pn >= thpn` 恒真、一步也搜不动。**次小值写法才是正解**，且不需要任何兜底 max()。
     ⚠ 求和被截断（饱和）时不扣减：把 INF 当成真值去减会算出错误的紧阈值。
     返回的 `progress` 断言"两个阈值都严格大于子节点当前值"，即每次下潜必有进展。 */
  function dfpnChildThresholds(nodeSide, attacker, thpn, thdn, nPn, nDn, ePn, eDn, pn2, dn2, satPn, satDn) {
    let cpn, cdn;
    if (nodeSide === attacker) {
      cpn = Math.min(thpn, pn2 + 1);
      cdn = satDn ? thdn : thdn - (nDn - eDn);
    } else {
      cdn = Math.min(thdn, dn2 + 1);
      cpn = satPn ? thpn : thpn - (nPn - ePn);
    }
    if (!(cpn >= 1)) cpn = 1;
    if (!(cdn >= 1)) cdn = 1;
    if (cpn > INF) cpn = INF;
    if (cdn > INF) cdn = INF;
    return { cpn, cdn, progress: cpn > ePn || cdn > eDn };
  }

  function dfpnSearchBody(entries, attacker, options = {}) {
    if (attacker !== 1 && attacker !== 2) throw new Error('攻击方必须是 1 或 2');
    const cfg = Object.assign({ timeMs: 60000, maxNodes: 400000, maxEntries: 1000000, maxPlies: 0,
      // 后继排序（实验开关，**默认 'none'**）：'block' = 只把"必须挡"的一步提到最前；
      // 'shape' = 再叠加 alpha-beta 已有的棋型分。见 orderKids。
      order: 'none', diag: false }, options);
    // ⚠ `shape-top` 的 2 是**预先固定的实验选择**（不做深度扫描再挑最好看的），见 docs/07 §十四.6
    const TOP_PLIES = 2;
    const orderMode = cfg.order === 'shape' || cfg.order === 'block' || cfg.order === 'shape-top'
      ? cfg.order : 'none';
    const diag = !!cfg.diag;
    const started = Date.now(), deadline = started + cfg.timeMs;
    // maxPlies > 0 时进入"**深度受限**"模式：把"剩 0 半回合"当作伪终点（attacker 无法再赢），
    // 于是整个博弈树有限 ⇒ 可以**穷尽**，`dn === 0` 就有了确切含义：
    //   「attacker 无法在 ≤ maxPlies 半回合内强制连四」——这是关于**有界博弈**的定理，
    //   不是"未知"。注意它与无界搜索的 `refuted`（"无法强制获胜，可能是无限对局"）不同。
    const bounded = cfg.maxPlies > 0;
    const rootPos = new Position(entries);
    const rootSide = ((rootPos.board.size - 1) % 2 === 0) ? 1 : 2;
    const tt = new Map();
    const st = { nodes: 0, expansions: 0, descents: 0, ttHits: 0, iters: 0, maxDepth: 0,
      timedOut: false, nodeLimit: false,
      // 后继生成数与排序开销（实验度量；默认 'none' 时 orderCalls/orderScores 恒为 0）
      successors: 0, orderCalls: 0, orderScores: 0, orderSkipped: 0,
      // 诊断拆分（只在 diag=true 时统计，默认不进热路径）：TT 命中里"节点已有结论值"的那部分
      ttHitsResolved: 0,
      stateKeys: 0, winScans: 0, msExtract: 0 };   // 成本剖析计数（纯诊断，不影响语义）
    const STOPD = Symbol('df-pn 预算耗尽');

    /* —— 有界结论的**区间复用**：先查（只信"已完成结论"写下的区间）——
       ⚠ 查询结论与导出证书是两件事：命中区间但**没有可复用的证书**时，这里只记
         `verdictOnlyMiss` 并继续真搜 —— 绝不因为"知道结论"就返回一个没有证书的证明。 */
    if (bounded && cfg.boundCache) {
      const bc = cfg.boundCache;
      const hit = boundLookup(bc, entries, attacker, cfg.maxPlies);
      if (hit.status !== 'miss') {
        const rec = bc.bounds.get(boundKeyOf(entries, rootSide, attacker));
        const base0 = () => ({ nodes: 0, expansions: 0, descents: 0, ttHits: 0, iters: 0,
          ms: Date.now() - started, maxDepth: 0, pn: 0, dn: 0, rootSide, ttSize: 0,
      maxPlies: cfg.maxPlies, timedOut: false, nodeLimit: false,
      stateKeys: 0, winScans: 0, msExtract: 0, successors: 0, orderCalls: 0, orderScores: 0,
      orderSkipped: 0,
      ttHitsResolved: 0, bound: { L: hit.L, U: hit.U } });
        // ⚠ 两类证书各自带距离条件，缺一不可（否则会用"深度 8 的获胜树"回答"能否在 ≤3 内赢"）
        if (hit.status === 'proven-win' && rec && rec.winCert && rec.winCert.depth <= cfg.maxPlies) {
          const v = verifyStrategy(entries, attacker, rec.winCert.proof.tree);
          if (v.ok) {
            bc.hitsCert++;
            return Object.assign({ status: 'proven-win',
              proof: { attacker, root: entries.slice(), tree: rec.winCert.proof.tree },
              cached: { kind: 'win-proof', fromN: rec.winCert.proof.maxPlies === undefined ? null : rec.winCert.proof.maxPlies,
                treeDepth: rec.winCert.depth, U: hit.U } }, base0());
          }
        }
        if (hit.status === 'refuted' && rec && rec.refCert && rec.refCert.maxPlies >= cfg.maxPlies) {
          // 更长的防守证书回答更短 horizon ⇒ **必须截断**（核验器要求 depth-limit 在 rem=0）并**重新核验**
          const cut = truncateRefutation(rec.refCert, cfg.maxPlies);
          const v = cut ? verifyRefutation(entries, attacker, cut) : { ok: false, reason: '截断失败' };
          if (v.ok) {
            bc.hitsCert++;
            return Object.assign({ status: 'refuted', proof: cut,
              cached: { kind: 'refutation-truncated', fromN: rec.refCert.maxPlies, L: hit.L },
              note: `已穷尽：【attacker 无法在 ≤${cfg.maxPlies} 半回合内强制连四】` +
                `（由 N=${rec.refCert.maxPlies} 的防守证书截断而来，已重新核验）` }, base0());
          }
        }
        bc.verdictOnlyMiss++;   // 区间命中但证书没缓存/距离不符 ⇒ 只能真搜
      }
    }

    // 终局判定在 nodeAt 里做（需要知道该谁走）；连四只可能出现在刚落的一格
    const nodeAt = (p, side, lastMove, lastSide, rem) => {
      st.stateKeys++;                                     // 成本剖析：本函数 = 规范化键 + 终局判定
      // 深度受限模式下，同一局面在不同"剩余半回合"下取值不同，故键里必须带上 rem
      const key = bounded ? (p.signature(side, false) + '@' + rem) : p.signature(side, false);
      let n = tt.get(key);
      // `ttHitsResolved`：命中的那个节点**已经有结论值**（终点、或 pn/dn 已为 0）⇒ 这次命中跳过了它下面的工作。
      //   反过来，非结论命中只省了"重建节点对象 + 重跑一次胜点扫描"，下面的搜索该做还得做
      //   ⇒ 总命中率是"可避开工作量"的**上界**，不是省下的百分比。默认不统计（不进热路径）。
      if (n) { st.ttHits++; if (diag && (n.term || n.pn === 0 || n.dn === 0)) st.ttHitsResolved++; return n; }
      let term = null, pn = 1, dn = 1;
      let blockX = null, blockY = null;                 // 「必须挡」的一手（只在排序开启时填）
      const w = lastMove ? (p.line(lastMove, lastSide) ? lastSide : 0) : p.winner();
      if (w === attacker) { term = { kind: 'connect4' }; pn = 0; dn = INF; }
      else if (w) { term = { kind: 'defender-win' }; pn = INF; dn = 0; }
      else if (bounded && rem <= 0) { term = { kind: 'depth-limit' }; pn = INF; dn = 0; }
      else {
        st.winScans++;                                    // 成本剖析：双方即时胜点的一次遍历
        const ms = p.moves(), A = [], B = [];
        for (let i = 0; i < ms.length; i++) {
          if (p.line(ms[i], attacker)) A.push(ms[i]);
          if (p.line(ms[i], 3 - attacker)) B.push(ms[i]);
        }
        if (side === attacker && A.length) { term = { kind: 'immediate-win', at: A[0] }; pn = 0; dn = INF; }
        else if (A.length >= 2 && B.length === 0) {
          // 双杀：轮到 attacker 需 1 半回合；轮到对手需 2 半回合（挡一个、另一个成四）。
          // ⚠ 只在**深度受限**模式下才用 rem 去否掉它；无界模式下 rem 无意义（是 0），
          //   若漏了 `!bounded` 这一项，就会把双杀必胜误判成"赢不了" —— 回归抓过一次。
          // ⚠ `ply-shortfall`（有战术但来不及兑现）与 `depth-limit`（半回合用尽）**必须分开**：
          //   反证证书的叶子只允许后者，混用会让证书无法被独立核验 —— 被 verifyRefutation 抓过一次。
          if (!bounded || side === attacker || rem >= 2) { term = { kind: 'double-threat', wins: A.slice(0, 6) }; pn = 0; dn = INF; }
          else { term = { kind: 'ply-shortfall' }; pn = INF; dn = 0; }
        }
        else if (side !== attacker && B.length) { term = { kind: 'defender-immediate-win', at: B[0] }; pn = INF; dn = 0; }
        else if (side === attacker && B.length >= 2) { term = { kind: 'defender-double-threat' }; pn = INF; dn = 0; }
        else if (orderMode !== 'none') {
          // 「必须挡」的那一手：这个节点不是终点 ⇒ 对手**至多 1 个**即时胜点（≥2 已经是双杀终点），
          //   所以最多只有一步必须挡。A/B 是上面这趟遍历**已经算出来**的 ⇒ 这里零额外扫描。
          const must = side === attacker ? (B.length === 1 ? B[0] : null)
            : (A.length === 1 ? A[0] : null);
          if (must) { blockX = must.x; blockY = must.y; }
        }
      }
      st.nodes++;
      n = { key, side, pn, dn, term, kids: null, rem };
      if (blockX !== null) { n.blockX = blockX; n.blockY = blockY; }
      if (tt.size < cfg.maxEntries) tt.set(key, n);
      return n;
    };
    const update = n => {
      if (n.term || !n.kids) return;
      const k = n.kids;
      let pn, dn;
      if (n.side === attacker) {
        pn = INF; dn = 0;
        for (let i = 0; i < k.length; i++) { if (k[i].pn < pn) pn = k[i].pn; dn += k[i].dn; }
      } else {
        pn = 0; dn = INF;
        for (let i = 0; i < k.length; i++) { pn += k[i].pn; if (k[i].dn < dn) dn = k[i].dn; }
      }
      // 饱和标记：只要求和被截断过，就把"另一侧"的扣减关掉（否则会把截断后的 INF 当成真值去减）
      n.pnSat = pn > INF; n.dnSat = dn > INF;
      n.pn = pn > INF ? INF : pn;
      n.dn = dn > INF ? INF : dn;
    };
    /* —— DFPN 的后继**排序**（默认 'none'，完全不改现状）——
       ⚠ 它改变的东西**只有** `n.kids` 这个数组的顺序。因此：
         · `step` 里的选中子 `bi` 只看 pn/dn（OR 取 pn 最小 / AND 取 dn 最小），
           顺序**只在 pn/dn 打平时**起作用 ⇒ pn/dn 仍是首要依据（这是硬性要求）；
         · 走法集合、阈值公式、终点语义全都不变 ⇒ **结论必须与未排序时一致**，
           变的只可能是"为了得到这个结论搜了多少"（Π 顺序不同而到不同的见证/不同的树是正常的）；
         · `update` 求和、`extract` 覆盖全部走法都与顺序无关。
       两层，都建立在**已经算出来的数据**之上：
         ① `block`：把"必须挡"的那一手提到最前。**零额外局面扫描**（坐标来自 nodeAt 的终局判定）。
         ② `shape`：再叠加 alpha-beta 已有的 `order()` 棋型分（每次展开算一次，O(走法数 × 24 次查表)）。
         ③ `shape-top`：**只在距本次搜索根 ≤2 个半回合的节点上**用 ②，更深的节点完全按 `none` 的原顺序。
            （2 是预先固定的实验值，不是扫参挑出来的。）
       ⚠ 关于"是不是已经在首次展开排序"：**是** —— `expand` 只在 `!n.kids` 时被调用，且一定把 `kids` 设上，
         所以**每个节点每次搜索只会展开一次**（下面那个断言就是守这条的）。不要把"首次展开才排序"当成新优化。
       视角按**当前行棋方**切换（这是必须的）：攻击方 OR 节点偏向自己的棋型 / 挡住对手的即时胜点；
       防守方 AND 节点偏向挡住攻击方的即时胜点 / 自己的反击棋型。**不是**两边都用"攻击方棋型越好越优先"。
       最后一级是坐标序 ⇒ 结果确定可复现。
       ⚠ 不为排序额外跑造叉（forkMove）或二次胜点扫描 —— 那正是此前"局部维护反而更慢"的覆辙。 */
    const orderKids = (n, p, depth) => {
      if (orderMode === 'none') return p.moves();
      let m = orderMode;
      if (orderMode === 'shape-top') {
        // 深层节点：**完全不付排序成本**（连 block 都不做 ⇒ 与 none 逐位一致的顺序）
        if (depth > TOP_PLIES) { st.orderSkipped++; return p.moves(); }
        m = 'shape';
      }
      st.orderCalls++;
      let ms;
      if (m === 'shape') {
        ms = order(p, p.moves(), n.side, null);
        st.orderScores += ms.length;
        ms = ms.slice();
      } else {
        ms = p.moves().slice();
      }
      if (n.blockX != null) {
        for (let i = 1; i < ms.length; i++) {
          if (ms[i].x === n.blockX && ms[i].y === n.blockY) {
            const t = ms[i]; ms.splice(i, 1); ms.unshift(t); break;
          }
        }
      }
      return ms;
    };
    const expand = (n, p, depth) => {
      if (n.kids) throw new Error('内部错误：同一个节点被展开两次（这会让"首次展开才排序"不再成立）');
      st.expansions++;
      if (st.expansions > cfg.maxNodes) { st.nodeLimit = true; throw STOPD; }
      const ms = orderKids(n, p, depth);            // 'none' 时与改动前逐位相同
      const k = new Array(ms.length);
      for (let i = 0; i < ms.length; i++) k[i] = { move: ms[i], pn: 1, dn: 1, node: null };
      n.kids = k;
      st.successors += ms.length;                   // 生成的后继总数（比较两个版本的实际展开宽度）
      update(n);
    };
    // 一次调用 = 沿"最有希望"的那条链深度优先展开，直到阈值用尽。
    //   阈值语义：本节点在 `pn>0 && dn>0 && pn<thpn && dn<thdn` 期间继续搜。
    //   两条必须遵守的规则（都是实测踩出来的，不是照抄教科书）：
    //   ① **未展开的节点先展开再返回**。它的 pn/dn 还是占位值 (1,1)、不代表真实信息，
    //      不能用阈值去拦它；展开后由调用方的 while 继续推进。
    //   ② 传给子节点的阈值必须**严格大于该子节点当前值**。教科书式写法
    //      `thpn_child = min(thpn, pn - pn_i + 1)` 在 pn=pn_i=1 时给出 1，于是
    //      展开后 pn=子节点数(>=2) 的 AND 子节点满足 `pn >= thpn` —— 一步也搜不动，
    //      主循环只能空转（`tools/check-dfpn.js` 复现过：展开 1 次、下降 640 万次、20s 零进展）。
    //      这里 OR 父节点下传"自身的 pn 需求"、AND 父节点下传"自身的 dn 需求"，
    //      另一侧按"其余子节点已提供的量"扣减，两侧恒大于子节点当前值 ⇒ 每次下潜必有进展。
    const step = (n, p, thpn, thdn, depth) => {
      if (n.term) return;
      if (!n.kids) { expand(n, p, depth); return; }
      st.descents++;
      if (depth > st.maxDepth) st.maxDepth = depth;
      if ((st.descents & 1023) === 0 && Date.now() >= deadline) throw STOPD;
      while (n.pn > 0 && n.dn > 0 && n.pn < thpn && n.dn < thdn) {
        const k = n.kids;
        // 一次遍历同时求：选中子（OR 取 pn 最小 / AND 取 dn 最小）+ pn/dn 的**次小值**
        let bi = 0, pn1 = Infinity, pn2 = Infinity, dn1 = Infinity, dn2 = Infinity;
        for (let i = 0; i < k.length; i++) {
          const p0 = k[i].pn, d0 = k[i].dn;
          if (p0 < pn1) { pn2 = pn1; pn1 = p0; } else if (p0 < pn2) pn2 = p0;
          if (d0 < dn1) { dn2 = dn1; dn1 = d0; } else if (d0 < dn2) dn2 = d0;
          if (i > 0) {
            if (n.side === attacker) { if (k[i].pn < k[bi].pn || (k[i].pn === k[bi].pn && k[i].dn < k[bi].dn)) bi = i; }
            else { if (k[i].dn < k[bi].dn || (k[i].dn === k[bi].dn && k[i].pn < k[bi].pn)) bi = i; }
          }
        }
        const e = k[bi];
        const th = dfpnChildThresholds(n.side, attacker, thpn, thdn, n.pn, n.dn, e.pn, e.dn,
          pn2, dn2, !!n.pnSat, !!n.dnSat);
        if (cfg.assertProgress && !th.progress) {
          throw new Error(`df-pn 阈值未产生进展：cpn=${th.cpn}<=${e.pn} 且 cdn=${th.cdn}<=${e.dn}`);
        }
        const cpn = th.cpn, cdn = th.cdn;
        const u = p.play(e.move, n.side);
        let child;
        try { child = nodeAt(p, 3 - n.side, e.move, n.side, n.rem - 1); } catch (err) { p.undo(u); throw err; }
        try { step(child, p, cpn, cdn, depth + 1); } finally { p.undo(u); }
        e.pn = child.pn; e.dn = child.dn; e.node = child;
        update(n);
      }
    };
    const extract = (n, budget) => {
      if (n.term) return { side: n.side, terminal: n.term, moves: [] };
      if (!n.kids) return null;
      if (--budget.n < 0) return null;
      if (n.side === attacker) {
        for (let i = 0; i < n.kids.length; i++) {
          if (n.kids[i].pn !== 0 || !n.kids[i].node) continue;
          const sub = extract(n.kids[i].node, budget);
          if (sub) return { side: n.side, terminal: null, moves: [{ move: n.kids[i].move, child: sub }] };
        }
        return null;
      }
      const out = [];
      for (let i = 0; i < n.kids.length; i++) {
        if (n.kids[i].pn !== 0 || !n.kids[i].node) return null;
        const sub = extract(n.kids[i].node, budget);
        if (!sub) return null;
        out.push({ move: n.kids[i].move, child: sub });
      }
      return { side: n.side, terminal: null, moves: out };
    };
    /* 反证证书（防守策略）：证明"攻击方在 ≤maxPlies 半回合内无法强制连四"。
       与获胜策略树**对偶** —— 存在性一方保留 1 步、全称一方覆盖全部：
         - 攻击方回合（全称）：必须覆盖**全部**合法走法；
         - 防守方回合（存在性）：只保留**一个**成功防守（见证）。
       终点只允许：defender 已连四 / 防守方即时胜点 / 防守方双杀（攻击方 0 胜点）/ 半回合用尽且未分胜负。
       `dn === 0` 的传播方向与此完全对应：OR 节点（攻击方行棋）dn = Σ，AND 节点（防守方行棋）dn = min。 */
    /* 把**派生终点**展开成显式续着，使证书叶子只剩两类（与核验器的约定一致）：
         ① defender 已连四；② 半回合用尽且未分胜负（`depth-limit`，必须恰好 rem === 0）。
       派生终点本身不是可独立验证的叶子，因为它们的成立要额外论证"剩下的半回合不够兑现"；
       展开成续着后，核验器只需查规则即可。 */
    const buildDerived = (pos, side, rem, kind, depth) => {
      const defender = 3 - attacker;
      if (depth > 64) return null;
      if (kind === 'defender-immediate-win') {                    // 轮到防守方，且有即时胜点
        if (side !== defender) return null;
        const wp = winPointsAll(pos, defender)[0];
        if (!wp) return null;
        const u = pos.play(wp, defender);
        const leaf = { side: attacker, terminal: { kind: 'connect4' }, moves: [] };
        pos.undo(u);
        return { side, terminal: null, moves: [{ move: wp, child: leaf }] };
      }
      if (kind === 'ply-shortfall') {                             // 轮到防守方，攻方双杀但 rem<2
        if (side !== defender || rem !== 1) return null;
        const legal = pos.moves();
        if (!legal.length) return null;
        const m = legal[0];
        const u = pos.play(m, side);                              // 防守方 0 胜点 ⇒ 这一步不会连四
        const leaf = { side: attacker, terminal: { kind: 'depth-limit' }, moves: [] };
        pos.undo(u);
        return { side, terminal: null, moves: [{ move: m, child: leaf }] };
      }
      if (kind === 'defender-double-threat') {                    // 轮到攻击方，攻方 0 胜点、防守方 >=2
        if (side !== attacker) return null;
        const legal = pos.moves();
        const out = [];
        for (const m of legal) {
          const u = pos.play(m, side);                            // 攻方 0 胜点 ⇒ 这一步不会连四
          let child = null;
          if (rem >= 2) {
            const wp = winPointsAll(pos, defender)[0];            // 攻方最多占掉一个胜点，必还剩一个
            if (wp) {
              const u2 = pos.play(wp, defender);
              const leaf = { side: attacker, terminal: { kind: 'connect4' }, moves: [] };
              pos.undo(u2);
              child = { side: defender, terminal: null, moves: [{ move: wp, child: leaf }] };
            }
          } else {
            child = { side: defender, terminal: { kind: 'depth-limit' }, moves: [] };
          }
          pos.undo(u);
          if (!child) return null;
          out.push({ move: m, child });
        }
        return out.length ? { side, terminal: null, moves: out } : null;
      }
      return null;
    };
    const extractRefutation = (pos, side, rem, n, budget) => {
      const defender = 3 - attacker;
      if (n.term) {
        const k = n.term.kind;
        if (k === 'connect4' || k === 'defender-win' || k === 'depth-limit') {
          return { side, terminal: n.term, moves: [] };
        }
        return buildDerived(pos, side, rem, k, 0);
      }
      if (!n.kids) return null;
      if (--budget.n < 0) return null;
      if (side !== attacker) {
        // 防守方（存在性）：保留 1 个成功防守作见证
        for (let i = 0; i < n.kids.length; i++) {
          if (n.kids[i].dn !== 0 || !n.kids[i].node) continue;
          const u = pos.play(n.kids[i].move, side);
          const sub = extractRefutation(pos, attacker, rem - 1, n.kids[i].node, budget);
          pos.undo(u);
          if (sub) return { side, terminal: null, moves: [{ move: n.kids[i].move, child: sub }] };
        }
        return null;
      }
      // 攻击方（全称）：必须覆盖全部合法走法
      const out = [];
      for (let i = 0; i < n.kids.length; i++) {
        if (n.kids[i].dn !== 0 || !n.kids[i].node) return null;
        const u = pos.play(n.kids[i].move, side);
        const sub = extractRefutation(pos, defender, rem - 1, n.kids[i].node, budget);
        pos.undo(u);
        if (!sub) return null;
        out.push({ move: n.kids[i].move, child: sub });
      }
      return { side, terminal: null, moves: out };
    };

    const root = nodeAt(rootPos, rootSide, null, null, cfg.maxPlies);
    try {
      while (!root.term && root.pn !== 0 && root.dn !== 0) {
        if (Date.now() >= deadline) { st.timedOut = true; break; }
        st.iters++;
        if (cfg.onTick && (st.iters & 255) === 0) cfg.onTick(root, st);
        // 根阈值取"当前值 +1"：本轮只要求把 pn（或 dn）推进哪怕 1 格；
        // 推进不动时阈值自然被顶破、循环退出，主循环再用新值重新起一轮（阈值递增）。
        step(root, rootPos, root.pn + 1, root.dn + 1, 0);
      }
    } catch (e) { if (e !== STOPD) throw e; }

    const base = { nodes: st.nodes, expansions: st.expansions, descents: st.descents,
      ttHits: st.ttHits, iters: st.iters, ms: Date.now() - started, maxDepth: st.maxDepth,
      pn: root.pn, dn: root.dn, rootSide, ttSize: tt.size, maxPlies: bounded ? cfg.maxPlies : null,
      timedOut: st.timedOut, nodeLimit: st.nodeLimit,
      successors: st.successors, orderCalls: st.orderCalls, orderScores: st.orderScores,
      orderSkipped: st.orderSkipped,
      ttHitsResolved: st.ttHitsResolved,
      stateKeys: st.stateKeys, winScans: st.winScans, msExtract: st.msExtract };
    /* 只有**已完成**的结论才写进区间表（预算耗尽/部分展开一律不写）；
       证书超过 `certMaxNodes` 就只存结论、不存证书。 */
    const storeBound = (status, proof) => {
      if (!bounded || !cfg.boundCache || !status) return;
      boundStore(cfg.boundCache, entries, attacker, cfg.maxPlies, status, undefined, proof);
    };
    if (root.pn === 0) {
      const t0 = Date.now();
      const tree = extract(root, { n: 400000 });
      st.msExtract += Date.now() - t0;
      base.msExtract = st.msExtract;
      // `root` 让证书**自包含**（跟随器/复核器不必再额外传根局面）。根局面很小，代价可忽略。
      const proof = tree ? { attacker, root: entries.slice(), tree } : null;
      storeBound('proven-win', proof);
      return Object.assign({ status: 'proven-win', proof }, base);
    }
    if (root.dn === 0) {
      // 有界模式下顺带导出**防守策略证书**（可被独立核验）。无界模式的 `refuted`
      // 只表示"无法强制获胜"、不保证有限性（可能是无限对局），因此**不产出**该证书。
      let refProof = null;
      if (bounded) {
        const t0 = Date.now();
        const rtree = extractRefutation(rootPos, rootSide, cfg.maxPlies, root, { n: 600000 });
        st.msExtract += Date.now() - t0;
        base.msExtract = st.msExtract;
        refProof = rtree
          ? { kind: 'refutation', attacker, maxPlies: cfg.maxPlies, root: entries.slice(), tree: rtree }
          : null;
      }
      storeBound('refuted', refProof);
      return Object.assign({ status: 'refuted', proof: refProof,
        note: bounded
          ? `已穷尽：【attacker 无法在 ≤${cfg.maxPlies} 半回合内强制连四】——这是**有界博弈**的确切结论。` +
            `注意它不等于"attacker 永远无法强制获胜"：无界情况下仍可能是对手胜、也可能是无限对局。`
          : '仅表示"attacker 无法强制获胜"（可能是对手胜，也可能是无限对局），不等于对手必胜' }, base);
    }
    return Object.assign({ status: 'unknown' }, base);
  }

  /* **确定性成本度量**（Node 数，不是墙钟）
     为什么需要它：本机墙钟抖动实测可达 ±20%（同一任务、节点数逐位一致的两次运行差到
     23.8s vs 34.9s），用墙钟判断"优化是否有效"会被噪声淹没。节点数在预算不触发时是
     **确定性**的（搜索本身不含随机源），所以：
       · `searchCalls` = 本 cache 参与的 dfpnSearch 次数（含命中复用的那次）
       · `searchNodes` = 这些调用展开的节点数总和（复用命中记 0）
     于是「同一流水线在有/无复用下的 searchNodes 之差」= 确定性省下的节点数。
     ⚠ 纯诊断：这两个字段不参与任何搜索决策，也不影响 status/pn/dn。 */
  function dfpnSearch(entries, attacker, options = {}) {
    const r = dfpnSearchBody(entries, attacker, options);
    const bc = options && options.boundCache;
    if (bc) {
      bc.searchCalls = (bc.searchCalls || 0) + 1;
      // ⚠ 括号不能省：`a + b || 0` 先算 `a+b`，b 为 undefined 时会得到 NaN 再被 `||0` 抹成整段 0
      bc.searchNodes = (bc.searchNodes || 0) + ((r && r.nodes) || 0);
    }
    return r;
  }

  /* ============================================================
     P5：把"已验证的证书"接进实战决策（证据表 / 证书跟随 / 边界拼接）

     —— 步数口径（**全篇统一，必须写清**）——
     所有 `withinPlies` / `horizon` 都以**某局面为起点、按半回合（ply）计**。
     `certifyRoot` 里所有距离的起点是「**走完该根候选之后的局面**」（记作 child），
     不是原始局面。同一张证据表里所有候选共用**同一个 horizon**，
     因此跨候选比较是"同一尺度"的比较，不涉及"把上界当精确距离"。

     —— 只用可证的优劣关系（不要把所有指标硬压成一个分数）——
       1) `ownWin`      ：我方能在 ≤horizon 内强制连四（带获胜策略树）⇒ 越快越好
       2) `survival`    ：对手无法在 ≤horizon 内强制连四（带防守证书）⇒ 有证书者优先
       3) 两者皆无       ：**未知**，交回普通搜索/启发式（未知绝不当作"安全"）
       4) `opponentWin` ：对手能在 ≤horizon 内强制连四（带获胜策略树）⇒ 只能尽量推迟
     跨类型比较只允许一种、且是可证的：B 拿到 `survival`、A 拿到 `opponentWin`（同一 horizon）
     ⇒ A 被证会在 horizon 内输、B 被证不会 ⇒ **B 严格不劣**。
     反向的"距离大小"比较一律不做（两个数都可能只是上界）。
     ============================================================ */

  const boardKey = pos => [...pos.board].map(([k, o]) => `${k}:${o}`).sort().join(';');
  const sameBoard = (a, b) => {
    if (a.board.size !== b.board.size) return false;
    for (const [k, o] of a.board) if (b.board.get(k) !== o) return false;
    return true;
  };
  const rotTerminal = (t, n) => {
    const o = Object.assign({}, t);
    if (t.at) o.at = rotN(t.at, n);
    if (t.wins) o.wins = t.wins.map(w => rotN(w, n));
    return o;
  };
  const rotateEntries = (entries, r) => {
    const n = ((r % 4) + 4) % 4;
    return entries.map(([k, o]) => { const q = rotN(point(k), n); return [key(q.x, q.y), o]; });
  };
  const rotateTree = (tree, r) => {
    const n = ((r % 4) + 4) % 4;
    if (tree.terminal) return { side: tree.side, terminal: rotTerminal(tree.terminal, n), moves: [] };
    return { side: tree.side, terminal: null,
      moves: tree.moves.map(e => ({ move: rotN(e.move, n), child: rotateTree(e.child, r) })) };
  };
  const rotateRefutation = (ref, r) => ({
    kind: 'refutation', attacker: ref.attacker, maxPlies: ref.maxPlies,
    root: ref.root ? rotateEntries(ref.root, r) : undefined, tree: rotateTree(ref.tree, r)
  });

  /* 单个攻击方在**有界**口径下的最快证胜深度。
     先在 maxPlies 上跑一次；只有拿到 proven-win 才去收紧最小 N（避免白花钱）：
       - 升序 N=1..maxPlies-1 试探，第一个 proven-win 即最小 N；
       - 任一次返回 unknown（撞预算）⇒ 无法确定最小 N，如实标 `exact:false, minPlies:null`；
       - 全程超时同样标 inexact。
     refuted 不收紧 —— 要证"更大的 N 也赢不了"得跑更大的 N，不是这里的事。 */
  function tightestWinWithin(child, attacker, maxPlies, budgetOpts, tight) {
    const big = dfpnSearch(child, attacker, Object.assign({ maxPlies }, budgetOpts()));
    if (big.status !== 'proven-win') {
      return { status: big.status, proof: big.proof || null, minPlies: null, exact: false };
    }
    if (!tight) return { status: 'proven-win', proof: big.proof, minPlies: null, exact: false };
    for (let N = 1; N < maxPlies; N++) {
      if (Date.now() >= tight.deadline) return { status: 'proven-win', proof: big.proof, minPlies: null, exact: false };
      const r = dfpnSearch(child, attacker, Object.assign({ maxPlies: N }, tight.probe()));
      if (r.status === 'proven-win') return { status: 'proven-win', proof: r.proof, minPlies: N, exact: true };
      if (r.status !== 'refuted') return { status: 'proven-win', proof: big.proof, minPlies: null, exact: false };
    }
    return { status: 'proven-win', proof: big.proof, minPlies: maxPlies, exact: true };
  }

  /* 根候选**证据表**。对每个根候选，在"走完该手之后的局面"上跑有界证明搜索：
       ownWin         ：我方能在 ≤horizon 内强制连四（`minPlies` 为最快深度，收紧不到则为 null）
       opponentWin    ：对手能在 ≤horizon 内强制连四（上限口径）
       survival       ：对手**无法**在 ≤horizon 内强制连四（含防守证书）
       opponentWinDeeper（可选，`deepHorizon`）：同一候候选**同时**存在更长的强制败证据
                      —— 例如"能防过 16 步，但对手能在 23 步内强制获胜"。
                      这两条**不互斥**，所以各占一个字段，不用互斥标签覆盖原始信息。
     没证据的字段一律 `null` —— **绝不把未知当安全**。
     所有候选共用同一个 horizon ⇒ 同尺度，可直接比较。`side` 是**将要落子的一方**。 */
  function certifyRoot(entries, side, options = {}) {
    if (side !== 1 && side !== 2) throw new Error('行棋方必须是 1 或 2');
    const cfg = Object.assign({ horizon: 16, deepHorizon: 0, maxNodes: 3000000, timeMs: 600000,
      maxMoves: 0, probeSelf: true, tighten: true, tightenNodes: 1500000, tightenMs: 60000,
      boundCache: null }, options);
    if (!Number.isInteger(cfg.horizon) || cfg.horizon <= 0) throw new Error('horizon 必须是正整数');
    if (cfg.deepHorizon && cfg.deepHorizon <= cfg.horizon) throw new Error('deepHorizon 必须大于 horizon');
    const pos = new Position(entries);
    const w = pos.winner();
    if (w) return { side, winner: w, origin: 'after-move', horizon: cfg.horizon, moves: [], terminal: true };
    const opp = 3 - side;
    const deadline = Date.now() + cfg.timeMs;
    // `boundCache` 透传给每次有界查询：同一 (局面, 攻击方, horizon) 在不同候选/不同阶段被重复问到时可直接复用
    //（离线流水线里确实存在这种重复，见 docs/07 §十四）
    const budgetOpts = () => ({ maxNodes: cfg.maxNodes, timeMs: Math.max(0, deadline - Date.now()),
      boundCache: cfg.boundCache });
    const tight = cfg.tighten ? {
      deadline: Date.now() + Math.min(cfg.tightenMs, cfg.timeMs),
      probe: () => ({ maxNodes: Math.min(cfg.maxNodes, cfg.tightenNodes), timeMs: Math.max(0, deadline - Date.now()),
        boundCache: cfg.boundCache })
    } : null;
    let legal = order(pos, pos.moves(), side);
    if (cfg.maxMoves > 0) legal = legal.slice(0, cfg.maxMoves);
    const out = [];
    for (const m of legal) {
      const u = pos.play(m, side);
      let child;
      try { child = [...pos.board]; } finally { pos.undo(u); }
      const rec = { move: m, child, origin: 'after-move', horizon: cfg.horizon,
        heuristicScore: new Position(child).evaluate(side),
        ownWin: null, opponentWin: null, survival: null, opponentWinDeeper: null };
      // 1) 对手（child 上轮对手走）能否强制获胜 / 是否被证书挡在 horizon 之外
      const ro = tightestWinWithin(child, opp, cfg.horizon, budgetOpts, tight);
      if (ro.status === 'proven-win' && ro.proof) {
        rec.opponentWin = { horizon: cfg.horizon, minPlies: ro.minPlies, exact: ro.exact, proof: ro.proof };
      } else if (ro.status === 'refuted' && ro.proof) {
        rec.survival = { horizon: cfg.horizon, proof: ro.proof };
        // 更长 horizon 上的失败证据（与 survival 不互斥）
        if (cfg.deepHorizon > 0) {
          const rd = tightestWinWithin(child, opp, cfg.deepHorizon, budgetOpts, tight);
          if (rd.status === 'proven-win' && rd.proof) {
            rec.opponentWinDeeper = { horizon: cfg.deepHorizon, minPlies: rd.minPlies, exact: rd.exact, proof: rd.proof };
          }
        }
      }
      rec.oppStatus = ro.status;
      // 2) 我方能否强制获胜（child 上轮到对手走 ⇒ 根是 AND 节点）
      if (cfg.probeSelf && !rec.opponentWin) {
        const rs = tightestWinWithin(child, side, cfg.horizon, budgetOpts, tight);
        if (rs.status === 'proven-win' && rs.proof) {
          rec.ownWin = { horizon: cfg.horizon, minPlies: rs.minPlies, exact: rs.exact, proof: rs.proof };
        }
      } else if (rec.opponentWin) {
        rec.selfSkipped = true;      // 对手已证能强制胜 ⇒ 不再浪费预算证自己
      }
      out.push(rec);
    }
    return { side, opponent: opp, origin: 'after-move', horizon: cfg.horizon,
      deepHorizon: cfg.deepHorizon || null, moves: out, exhausted: Date.now() >= deadline };
  }

  /* 限制在 `allowed` 内的根层迭代加深（用于"未知"档的兜底选招；不允许搜索挑到被证必败的招）。 */
  function rootSearchAmong(entries, side, allowed, options = {}) {
    const cfg = Object.assign({ maxDepth: 6, qDepth: 8, timeMs: 1500, maxNodes: 60000,
      maxEntries: 50000, cache: null }, options);
    const pos = new Position(entries);
    if (!allowed.length) return { move: null, score: null, depth: 0, exhausted: true };
    const cache = cfg.cache || createCache(cfg.maxEntries);
    const st = { proofNodes: 0, evalNodes: 0, ttHits: 0, ttStores: 0, ttFull: 0,
      solvedHits: 0, solvedStores: 0 };
    const ctx = { budget: new Budget(Date.now() + cfg.timeMs, cfg.maxNodes),
      solved: cache.solved, search: cache.tt, maxEntries: cfg.maxEntries,
      forkScan: DEFAULT_FORK_SCAN, st, preferred: null, rootInfo: null };
    const allowSet = new Set(allowed.map(p => key(p.x, p.y)));
    let best = allowed[0], bestScore = -Infinity, depth = 0, exhausted = false;
    try {
      for (let d = 1; d <= cfg.maxDepth; d++) {
        let a = -Infinity, move = best, sc = -Infinity;
        for (const p of allowed) {
          const u = pos.play(p, side);
          let v;
          try { v = -alphaBeta(pos, 3 - side, d - 1, cfg.qDepth, -Infinity, -a, 1, ctx, false).score; }
          finally { pos.undo(u); }
          if (v > sc) { sc = v; move = p; }
          if (v > a) a = v;
        }
        best = move; bestScore = sc; depth = d;
        ctx.preferred = best;
        if (Math.abs(bestScore) > MATE / 2) break;
      }
    } catch (e) { if (e !== STOP) throw e; exhausted = true; }
    if (!allowSet.has(key(best.x, best.y))) best = allowed[0];
    return { move: best, score: bestScore, depth, exhausted };
  }

  /* 用证据表选招。返回 `{ move, tier, basis, reason, evidence, alternatives, fallback }`。

     ⚠ **`tier` 不是"完整数学排序"，而是一条明确的策略偏好。** 三层要说清：
       1) `basis:'proven-win'`      —— 我方已被**证明**能强制连四（"赢"这个目标上严格最好）。
       2) `basis:'proven-comparison'`—— 存在**可证**的跨候选优劣：同一 horizon 下，
          有人拿到 `survival`（对手 horizon 内赢不了），有人拿到 `opponentWin`（对手 horizon 内能赢）
          ⇒ 前者严格不劣。**这是唯一允许的跨类型比较。**
       3) `basis:'policy'`          —— 其余情形（如 `survival` vs `unknown`、被证必败之间的推迟排序），
          只是**保守策略偏好**：A 有已知保证、B 没有，所以优先 A。
          **不能**由此推出 A 的真实博弈价值高于 B（B 也许是立即可赢的长期好招，只是还没分析清楚）。

     `alternatives` 保留**原始、非互斥**的证据计数（同一候选可以既有有限防守保证又有更长的强制败证据）。 */
  function chooseMoveCertified(entries, side, options = {}) {
    const cfg = Object.assign({ horizon: 16, certify: {}, fallback: true, fallbackDepth: 6,
      fallbackTimeMs: 1500, fallbackNodes: 60000, cache: null, maxEntries: 50000 }, options);
    const ev = certifyRoot(entries, side, Object.assign({ horizon: cfg.horizon }, cfg.certify));
    if (ev.terminal) return { move: null, tier: 'terminal', basis: 'terminal', winner: ev.winner, evidence: ev };
    const moves = ev.moves;
    const pick = (list, cmp) => list.slice().sort(cmp)[0];
    const byHeur = (a, b) => (b.heuristicScore - a.heuristicScore) ||
      (a.move.x - b.move.x) || (a.move.y - b.move.y);
    // `minPlies` 可能是 null（收紧不到）⇒ 退回该字段的 horizon（一个纯上界），绝不冒充精确值
    const ownP = r => r.ownWin.minPlies == null ? r.ownWin.horizon : r.ownWin.minPlies;
    const oppP = r => r.opponentWin.minPlies == null ? r.opponentWin.horizon : r.opponentWin.minPlies;
    const own = moves.filter(r => r.ownWin);
    const surv = moves.filter(r => r.survival);
    const doomed = moves.filter(r => r.opponentWin);
    const unknown = moves.filter(r => !r.ownWin && !r.survival && !r.opponentWin);
    const alternatives = {
      counts: { ownWin: own.length, survival: surv.length, doomed: doomed.length, unknown: unknown.length,
        withDeeperLoss: moves.filter(r => r.opponentWinDeeper).length },
      // 非互斥：同时有 survival 又有更长强制败证据的候选（"能防过 h，但 d>h 步内必败"）
      survivalAndDeeperLoss: moves.filter(r => r.survival && r.opponentWinDeeper)
        .map(r => ({ move: r.move, surviveWithin: r.survival.horizon,
          losesWithin: r.opponentWinDeeper.minPlies == null ? r.opponentWinDeeper.horizon : r.opponentWinDeeper.minPlies })),
      horizon: ev.horizon, deepHorizon: ev.deepHorizon
    };

    if (own.length) {
      const best = pick(own, (a, b) => (ownP(a) - ownP(b)) || byHeur(a, b));
      return { move: best.move, tier: 'own-win', basis: 'proven-win', evidence: ev, alternatives,
        reason: `我方可在 ≤${ownP(best)} 半回合内强制连四（起点=走完该手后的局面）` };
    }
    if (surv.length) {
      let r = null;
      if (cfg.fallback && surv.length > 1) {
        r = rootSearchAmong(entries, side, surv.map(x => x.move),
          { maxDepth: cfg.fallbackDepth, timeMs: cfg.fallbackTimeMs, maxNodes: cfg.fallbackNodes,
            cache: cfg.cache, maxEntries: cfg.maxEntries });
      }
      const best = r && r.move ? surv.find(x => x.move.x === r.move.x && x.move.y === r.move.y) || pick(surv, byHeur)
        : pick(surv, byHeur);
      // 与"被证必败"的候选同处一个 horizon ⇒ 至少存在一条**可证**的优劣关系（不是纯偏好）
      const basis = doomed.length ? 'proven-comparison' : 'policy';
      const deeper = best.opponentWinDeeper
        ? `；同时已证对手可在 ≤${best.opponentWinDeeper.minPlies == null ? best.opponentWinDeeper.horizon : best.opponentWinDeeper.minPlies} 半回合内强制获胜（更长 horizon 上的失败证据，与上面的保证不矛盾）`
        : '';
      return { move: best.move, tier: 'survival', basis, evidence: ev, alternatives, fallback: r,
        reason: `有防守证书：对手无法在 ≤${best.survival.horizon} 半回合内强制连四` +
          (surv.length > 1 ? `（${surv.length} 个候选都有证书，用受限搜索定序）` : '') + deeper };
    }
    if (unknown.length) {
      let r = null;
      if (cfg.fallback) {
        r = rootSearchAmong(entries, side, unknown.map(x => x.move),
          { maxDepth: cfg.fallbackDepth, timeMs: cfg.fallbackTimeMs, maxNodes: cfg.fallbackNodes,
            cache: cfg.cache, maxEntries: cfg.maxEntries });
      }
      const best = (r && r.move ? unknown.find(x => x.move.x === r.move.x && x.move.y === r.move.y) : null)
        || pick(unknown, byHeur);
      return { move: best.move, tier: 'unknown', basis: 'policy', evidence: ev, alternatives, fallback: r,
        reason: `无证据（${unknown.length} 个候选），交回受限搜索；已排除被证必败的 ${doomed.length} 手` };
    }
    const best = pick(doomed, (a, b) => (oppP(b) - oppP(a)) || byHeur(a, b));
    return { move: best.move, tier: 'doomed', basis: 'policy', evidence: ev, alternatives,
      reason: `全部候选都被证会在 ≤horizon 内被强制击败；取推迟最久者（≤${oppP(best)} 半回合）` };
  }

  /* 证书跟随：给一份反证证书与**当前局面**，返回我方该走哪一步。
     证书里攻击方回合覆盖全部合法走法（轮到对手走 → 等它落子）、防守方回合恰好 1 步。
     ⚠ 当前局面**不必**恰好是证书里的下一个节点（对手可能已经走过若干手）；
       定位方式 = 从根沿"棋子是目标的子集"的路径下潜，直到棋子数相等，再比对是否同一局面。
       由于每手只加一子，棋子数严格标识深度；**同一局面在证书里可能有多个节点（转置）**，
       但每个节点对同一局面给出的答案都是合法的（核验器逐个节点按局面检查过），所以任取其一都对。
     返回：
       { status:'wait',    replies:[...], remaining }  轮到对手走，等它落子（replies 是证书覆盖的应手）
       { status:'defend',  witness, remaining }        轮到我方走，按见证应对
       { status:'terminal', terminal, remaining }      证书已到终点
       { status:'off-certificate', reason }            偏离证书（保证立即失效，须重新求解） */
  function followRefutation(ref, curEntries, rootEntries) {
    if (!ref || !ref.tree) return { status: 'off-certificate', reason: '缺少证书' };
    const base = ref.root || rootEntries;
    if (!base) return { status: 'off-certificate', reason: '证书未携带根局面（无法定位）' };
    const cur = new Position(curEntries);
    const pos = new Position(base);
    if (pos.board.size > cur.board.size) return { status: 'off-certificate', reason: '目标局面比证书根局面的棋子还少' };
    const subset = () => {
      if (pos.board.size > cur.board.size) return false;
      for (const [k, o] of pos.board) if (cur.board.get(k) !== o) return false;
      return true;
    };
    let budget = 300000;
    const dfs = (node, rem) => {
      if (--budget < 0) return null;
      if (!subset()) return null;
      if (pos.board.size === cur.board.size) return sameBoard(pos, cur) ? { node, rem } : null;
      if (node.terminal) return null;
      for (const e of node.moves) {
        const u = pos.play(e.move, node.side);
        const hit = dfs(e.child, rem - 1);
        pos.undo(u);
        if (hit) return hit;
      }
      return null;
    };
    const found = dfs(ref.tree, ref.maxPlies);
    if (!found) return { status: 'off-certificate', reason: '证书未覆盖当前局面（保证失效）' };
    const node = found.node, rem = found.rem;
    if (node.terminal) return { status: 'terminal', terminal: node.terminal, remaining: rem, side: node.side };
    if (node.side === ref.attacker) {
      return { status: 'wait', remaining: rem, side: node.side, replies: node.moves.map(e => e.move) };
    }
    return { status: 'defend', remaining: rem, side: node.side, witness: node.moves[0].move };
  }

  /* 证书校验级别：把导出证书里出现过的**终点种类**汇总（供"对外证书终点纯度"检查）。
     `depth-limit` = 半回合用尽；`connect4`/`defender-win` = 真终局；
     `defender-immediate-win`/`defender-double-threat` = 独立可核验的引理终点；
     `ply-shortfall` 等**搜索内部**标记**不得**出现在对外证书里（核验器会拒）。 */
  function refutationLeafKinds(ref) {
    const seen = {};
    const walk = n => {
      if (n.terminal) { const k = n.terminal.kind; seen[k] = (seen[k] || 0) + 1; return; }
      for (const e of n.moves) walk(e.child);
    };
    if (!ref || !ref.tree) return seen;
    walk(ref.tree);
    return seen;
  }
  const CERT_LEAF_KINDS = ['connect4', 'defender-win', 'depth-limit',
    'defender-immediate-win', 'defender-double-threat'];

  /* 导出反证证书的**未终局边界**：所有 `depth-limit` 叶子对应的（局面, 行棋方, 深度）。
     它们正是"这份见证策略还没有解决的分支"——比从根再冲 N 更值得投预算。 */
  function certBoundaryStates(ref, rootEntries) {
    const out = [];
    if (!ref || !ref.tree) return out;
    const base = ref.root || rootEntries;
    if (!base) return out;
    const pos = new Position(base);
    const walk = (node, depth) => {
      if (node.terminal) {
        if (node.terminal.kind === 'depth-limit') out.push({ board: [...pos.board], side: node.side, depth });
        return;
      }
      for (const e of node.moves) {
        const u = pos.play(e.move, node.side);
        walk(e.child, depth + 1);
        pos.undo(u);
      }
    };
    walk(ref.tree, 0);
    return out;
  }
  const exactStateKey = (board, side) => side + '|' + boardKey(new Position(board));
  const canonStateKey = (board, side) => new Position(board).canonical(side).key;
  /* **只含棋盘**的四旋转规范键（不含行棋方）——用于根局面"旋转等价"匹配。
     取 canonical 的棋盘部分：`canonical(side).key` = `side + '|' + <规范棋盘>`，
     棋盘部分与 side 无关。附加返回 `rot`（R^rot(实际) = 规范），供坐标还原。 */
  const boardCanon = board => {
    const c = new Position(board).canonical(1);
    return { key: c.key.slice(c.key.indexOf('|') + 1), rot: c.rot };
  };
  const boardCanonKey = board => boardCanon(board).key;

  /* 边界去重：`byRotation` 打开时按四旋转规范键合并（同一局面只留一个代表）。 */
  function dedupeBoundaries(list, byRotation) {
    const map = new Map();
    for (const b of list) {
      const k = byRotation ? canonStateKey(b.board, b.side) : exactStateKey(b.board, b.side);
      const e = map.get(k);
      if (e) e.count++;
      else map.set(k, { key: k, board: b.board, side: b.side, count: 1, depth: b.depth });
    }
    return [...map.values()];
  }

  /* 拼接：把每个 `depth-limit` 边界叶子替换成一份**同 attacker、addPlies 上限**的续证书。
     要求**全部**边界都拿到续证书，否则返回 null（部分成功不构成统一保证）。
     合成后命题为「attacker 无法在 ≤(N+addPlies) 半回合内强制连四」：
       原树的 depth-limit 叶子都在深度 N（rem 从 N 逐手递减到 0），
       续证书的 depth-limit 叶子在局部深度 addPlies ⇒ 合起来正好在全局 N+addPlies。 */
  function spliceRefutation(ref, parts, addPlies, rootEntries) {
    if (!ref || !ref.tree || !(addPlies > 0)) return null;
    const base = ref.root || rootEntries;
    if (!base) return null;
    const pos = new Position(base);
    let missing = 0;
    const walk = node => {
      if (node.terminal) {
        if (node.terminal.kind !== 'depth-limit') return node;
        const k = exactStateKey([...pos.board], node.side);
        const sub = parts.get(k);
        if (!sub || !sub.tree || sub.maxPlies !== addPlies || sub.attacker !== ref.attacker) { missing++; return node; }
        return sub.tree;
      }
      return { side: node.side, terminal: null,
        moves: node.moves.map(e => {
          const u = pos.play(e.move, node.side);
          const c = walk(e.child);
          pos.undo(u);
          return { move: e.move, child: c };
        }) };
    };
    const tree = walk(ref.tree);
    if (missing) return null;
    return { kind: 'refutation', attacker: ref.attacker, maxPlies: ref.maxPlies + addPlies,
      root: (ref.root || rootEntries).slice(), tree };
  }

  /* ============================================================
     P6：语义收口 + 可查询的证书索引

     —— 一条可直接当断言的**必要条件**（有界反证）——
     合法的反证证书里，对**防守方节点**，若其见证落子后满足
       ① 未终局 ② 下一步轮到攻击方 ③ 剩余保证半回合 ≥ 1，
     则**攻击方的即时胜点数必须为 0**。
     论证：否则攻击方下一手直接连四 ⇒ 该攻击方节点的 pn = 0 ⇒ 其父（防守方，恰 1 子）dn = INF
     ⇒ 根 dn ≠ 0，与"根已 refuted"矛盾。
     ⚠ 统计时必须**先按这三条筛选**：否则会把"防守方这一手已经连四"（局面已终局）与
       "半回合正好用尽"（攻方虽可能马上赢但没步数了）误当成反例。
     ============================================================ */

  const RULE_VERSION = 'g4-rules-1';   // 规则版本；规则一变就改它，所有缓存/证书键随之失效

  /* 证书的**完整命题键**：规则版本 + 行棋方 + 攻击方 + 剩余保证 + 棋盘。
     只比棋盘是不够的：同一棋盘在不同"剩余保证"下本来就可能采用不同见证。 */
  const certStateKey = (board, side, attacker, remaining, rv) =>
    (rv || RULE_VERSION) + '|' + side + '|' + attacker + '|' + remaining + '|' + boardKey(new Position(board));
  const certCanonKey = (board, side, attacker, remaining, rv) =>
    (rv || RULE_VERSION) + '|' + side + '|' + attacker + '|' + remaining + '|'
      + new Position(board).canonical(side).key;

  /* 反证证书的**不变式检查 + 统计**（返回结构可直接用于回归断言）。
     同时按**完整命题键**统计"同一状态是否出现不同见证"（"唯一决定性"的正确口径）。 */
  function checkRefutationInvariants(ref, entries, ruleVersion) {
    const out = { defenderNodes: 0, checked: 0, skippedTerminal: 0, skippedNoPlies: 0,
      violations: [], states: 0, multiWitness: [], leafKinds: {}, maxDefenderDepth: 0 };
    if (!ref || !ref.tree) return out;
    const base = ref.root || entries;
    if (!base) return out;
    const rv = ruleVersion || RULE_VERSION;
    const attacker = ref.attacker, defender = 3 - attacker;
    const pos = new Position(base);
    const seen = new Map();     // 完整命题键 -> Set(见证)
    const walk = (node, side, rem, depth) => {
      if (node.terminal) {
        const k = node.terminal.kind;
        out.leafKinds[k] = (out.leafKinds[k] || 0) + 1;
        return;
      }
      if (side === defender) {
        out.defenderNodes++;
        if (depth > out.maxDefenderDepth) out.maxDefenderDepth = depth;
        const w = node.moves[0].move;
        const sk = certStateKey([...pos.board], side, attacker, rem, rv);
        if (!seen.has(sk)) seen.set(sk, new Set());
        seen.get(sk).add(key(w.x, w.y));
        const u = pos.play(w, side);
        try {
          if (pos.winner() === defender) out.skippedTerminal++;       // ① 不满足
          else if (rem - 1 < 1) out.skippedNoPlies++;                 // ③ 不满足
          else {
            out.checked++;
            const bad = winPointsAll(pos, attacker);
            if (bad.length) {
              out.violations.push({ board: [...pos.board], side: attacker, remaining: rem - 1,
                attackerWinPoints: bad.map(p => key(p.x, p.y)), witness: w, depth });
            }
          }
        } finally { pos.undo(u); }
        const u2 = pos.play(w, side);
        try { walk(node.moves[0].child, attacker, rem - 1, depth + 1); } finally { pos.undo(u2); }
        return;
      }
      for (const e of node.moves) {
        const u = pos.play(e.move, side);
        try { walk(e.child, defender, rem - 1, depth + 1); } finally { pos.undo(u); }
      }
    };
    walk(ref.tree, ((pos.board.size - 1) % 2 === 0) ? 1 : 2, ref.maxPlies, 0);
    out.states = seen.size;
    for (const [k, s] of seen) if (s.size > 1) out.multiWitness.push({ key: k, witnesses: [...s] });
    return out;
  }

  /* 证书**索引**：把反证证书编译成"状态 → 该走哪一步"的查表结构，供在线跟随查询。
     - 精确键 + 四旋转规范键双索引；规范键额外记下建索引时的朝向 `bRot`，
       查询时用 `rotN(见证, bRot - qRot)` 把坐标还原到**查询方朝向**。
     - 只存跟随必需的信息（`terminal` / `witness`）；攻击方节点的应手集可由规则重算。
     规模参考：`(1,-1)` 的 N=6 证书 1021 节点、N=16 是 76 405 ⇒ 索引只适合**小 horizon** 的证书；
     大证书留在离线工具里用"子集下潜"定位（`followRefutation`）。 */
  function certIndex(ref, entries, ruleVersion) {
    if (!ref || !ref.tree) return null;
    const base = ref.root || entries;
    if (!base) return null;
    const rv = ruleVersion || RULE_VERSION;
    const attacker = ref.attacker, defender = 3 - attacker;
    const pos = new Position(base);
    const byExact = new Map(), byCanon = new Map();
    let nodes = 0;
    const walk = (node, side, rem) => {
      nodes++;
      const rec = { side, remaining: rem, attacker,
        terminal: node.terminal ? node.terminal.kind : null,
        witness: (!node.terminal && side === defender) ? node.moves[0].move : null };
      const ek = certStateKey([...pos.board], side, attacker, rem, rv);
      if (!byExact.has(ek)) byExact.set(ek, rec);
      const ck = pos.canonical(side);
      const ckey = rv + '|' + side + '|' + attacker + '|' + rem + '|' + ck.key;
      if (!byCanon.has(ckey)) byCanon.set(ckey, { rec, bRot: ck.rot });
      if (node.terminal) return;
      for (const e of node.moves) {
        const u = pos.play(e.move, side);
        try { walk(e.child, 3 - side, rem - 1); } finally { pos.undo(u); }
      }
    };
    walk(ref.tree, ((pos.board.size - 1) % 2 === 0) ? 1 : 2, ref.maxPlies);
    return {
      ruleVersion: rv, attacker, maxPlies: ref.maxPlies, nodes, root: base, byExact, byCanon,
      at(boardOrPos, side, remaining) {
        const p = boardOrPos instanceof Position ? boardOrPos : new Position(boardOrPos);
        const ek = certStateKey([...p.board], side, attacker, remaining, rv);
        const hit = byExact.get(ek);
        if (hit) return { status: hit.terminal ? 'terminal' : (side === attacker ? 'wait' : 'defend'),
          remaining, terminal: hit.terminal, witness: hit.witness, orientation: 'exact' };
        const ck = p.canonical(side);
        const c = byCanon.get(rv + '|' + side + '|' + attacker + '|' + remaining + '|' + ck.key);
        if (!c) return { status: 'miss' };
        const w = c.rec.witness ? rotN(c.rec.witness, c.bRot - ck.rot) : null;
        return { status: c.rec.terminal ? 'terminal' : (side === attacker ? 'wait' : 'defend'),
          remaining, terminal: c.rec.terminal, witness: w, orientation: 'rotated', rot: ck.rot };
      }
    };
  }

  /* **统一相同状态的有效见证**：同一**完整命题键**（规则版本+棋盘+行棋方+攻击方+剩余保证）
     若在证书里出现了不同见证，这里统一成**第一次遇到的那一个**（并复用它已验证的子树）。
     好处：① 把"信念选择不唯一"变成**确定性策略**（可在同一状态上固定选一个）；
          ② 为在线跟随提供"状态 → 一步"的单值查表；③ 有可能顺便压小证书。
     ⚠ 只有**命题一致**（完整键相同）才合并；合并后必须重新核验（调用方负责）。
     返回 `{ ref, reused }`，`ref` 为 null 表示无法统一（理论上不应发生）。 */
  function unifyRefutation(ref, entries, ruleVersion) {
    if (!ref || !ref.tree) return null;
    const base = ref.root || entries;
    if (!base) return null;
    const rv = ruleVersion || RULE_VERSION;
    const attacker = ref.attacker, defender = 3 - attacker;
    const pos = new Position(base);
    const first = new Map();       // 完整命题键 -> 该状态首次建立的那个子树（已定见证）
    let reused = 0, nodes = 0;
    const walk = (node, side, rem) => {
      nodes++;
      if (node.terminal) return { side: node.side, terminal: node.terminal, moves: [] };
      if (side === defender) {
        const sk = certStateKey([...pos.board], side, attacker, rem, rv);
        const prev = first.get(sk);
        if (prev) { reused++; return prev; }        // 复用首次见证的子树
        const u = pos.play(node.moves[0].move, side);
        let sub = null;
        try { sub = walk(node.moves[0].child, attacker, rem - 1); } finally { pos.undo(u); }
        const rebuilt = { side, terminal: null, moves: [{ move: node.moves[0].move, child: sub }] };
        first.set(sk, rebuilt);
        return rebuilt;
      }
      const out = [];
      for (const e of node.moves) {
        const u = pos.play(e.move, side);
        let sub = null;
        try { sub = walk(e.child, defender, rem - 1); } finally { pos.undo(u); }
        out.push({ move: e.move, child: sub });
      }
      return { side, terminal: null, moves: out };
    };
    const tree = walk(ref.tree, ((pos.board.size - 1) % 2 === 0) ? 1 : 2, ref.maxPlies);
    return { ref: { kind: 'refutation', attacker, maxPlies: ref.maxPlies, root: base.slice(), tree },
      reused, sourceNodes: nodes };
  }

  const api = { Position, chooseMove, gravity, createCache,
    threatSearch, verifyProof, winPointsAll, pnsSearch, dfpnSearch, verifyStrategy,
    compressStrategy, verifyStrategyDag, verifyRefutation, dfpnChildThresholds,
    certifyRoot, chooseMoveCertified, rootSearchAmong, followRefutation,
    certBoundaryStates, dedupeBoundaries, spliceRefutation, refutationLeafKinds, CERT_LEAF_KINDS,
    rotateEntries, rotateTree, rotateRefutation, exactStateKey, canonStateKey, boardCanon, boardCanonKey,
    RULE_VERSION, certStateKey, certCanonKey, checkRefutationInvariants, certIndex,
    unifyRefutation,
    createBoundCache, boundLookup, boundStore, truncateRefutation };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GravitySolver = api;
})(globalThis);
