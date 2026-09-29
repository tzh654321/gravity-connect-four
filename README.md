# 重力四子棋 · Gravity Connect-4

带重力物理的四子棋：落子后棋子会滚动、凝固，落点不再等于投点，比经典四子棋多一层不确定性。

纯单文件 HTML 实现（零依赖、零构建），另附局域网联机服务端与 Android 打包工具链。

## 在线试玩

**https://tzh654321.github.io/gravity-connect-4/**

## 下载 Android 版

前往 [Releases](https://github.com/tzh654321/gravity-connect-4/releases/latest) 下载 APK 直接安装。

## 玩法

- 模式：人·人 / 人·机（易·普·难）/ 机·机 / 局域网联机
- 辅助：悔棋、危险提示、复制对局记录、导入残局、房规配置

## 目录结构

```
index.html                  游戏本体（规则 / 物理 / AI 全部内嵌，Pages 入口）
server/                     局域网联机服务端（Node ≥ 18，零依赖）
  server.js                    HTTP + WebSocket 房间服务，同时托管 index.html
  start-online.js              一键开房：起服 → 建房 → 复制邀请链接 → 开浏览器
  一键开房.bat                   Windows 双击入口
tools/                      AI 研发与评测工具链（详见 tools/README.md）
  neural/                      神经网络自博弈 / 训练 / 注入
docs/                       文档
android/                    Android APK 打包工具链（无 Gradle，自研 aapt2+d8+apksigner 流程）
```

## 本地运行

单机：直接用浏览器打开 `index.html`。

联机（同一局域网）：

```bash
node server/server.js 8765        # 起服后浏览器打开 http://localhost:8765
node server/start-online.js       # 或一键开房（自动建房 + 复制邀请链接）
```

Windows 下可直接双击 `server/一键开房.bat`。

## AI 说明

- **基线**：启发式评估 —— 静态棋型窗口分 + 一步杀/双威胁计数 + 多层威胁前瞻，按易/普/难分档。
- **困难档**：叠加 16 维叶子价值网络（MLP `16×64×64×32×1`）打分，权重以 `__NNW` 内嵌于 `index.html`。
- 权重调优与自博弈见 `tools/`；各版本对局实测记录见 [docs/05-实验记录.md](docs/05-实验记录.md)。

## 许可

[MIT](LICENSE)
