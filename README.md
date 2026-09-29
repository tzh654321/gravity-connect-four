# 重力四子棋 · Gravity Connect-4

带重力物理的四子棋：落子后棋子会滚动、凝固，落点不再等于投点，比经典四子棋多一层不确定性。

纯单文件 HTML 实现（零依赖、零构建），另附联机服务端与 Android 打包工具链。

## 在线试玩

**https://tzh654321.github.io/gravity-connect-four/**

人·人 / 人·机（易·普·难）/ 机·机 可直接玩。
⚠️ **联机不可用** —— 联机需要一个自带接口的服务端，而 Pages 是纯静态托管（原因与替代方案见 [联机对战](#联机对战)）。

## 下载 Android 版

前往 [Releases](https://github.com/tzh654321/gravity-connect-four/releases/latest) 下载 APK 直接安装。

## 玩法

- 模式：人·人 / 人·机（易·普·难）/ 机·机 / 联机对战
- 辅助：悔棋、危险提示、复制对局记录、导入残局、房规配置

## 目录结构

```
index.html                  游戏本体（规则 / 物理 / AI 全部内嵌，Pages 入口）
server/                     联机服务端（Node ≥ 18，零依赖）
  server.js                    HTTP 房间服务（/api/* 长轮询），同时托管 index.html
  start-online.js              一键开房：起服 → 建房 → 复制邀请链接 → 开浏览器
  一键开房.bat                   Windows 双击入口
tools/                      AI 研发与评测工具链（详见 tools/README.md）
  neural/                      神经网络自博弈 / 训练 / 注入
docs/                       文档
android/                    Android APK 打包工具链（无 Gradle，自研 aapt2+d8+apksigner 流程）
```

## 本地运行

单机：直接用浏览器打开 `index.html`。

## 联机对战

联机**不是 P2P**：页面通过**同源**相对接口（`GET /api/poll` 长轮询 + `POST /api/send`）与
`server/server.js` 通信。因此**页面必须由该服务端托管** —— 这是理解下面两种玩法与
「为什么 Pages 版本不能联机」的关键。

### ① 局域网（同一 Wi-Fi）

```bash
node server/server.js 8765        # 起服后浏览器打开 http://localhost:8765
node server/start-online.js       # 或一键开房：自动建房 + 复制邀请链接 + 打开自己的对局页
```

Windows 下直接双击 `server/一键开房.bat`。手机与电脑连同一个 Wi-Fi，用
`http://<电脑局域网IP>:8765/` 打开（**不要用 localhost**）。房主把自动复制到剪贴板的
邀请链接发给对方，对方打开即自动加入。

### ② 公网（朋友不在同一局域网）

把 `server/server.js` 部署到任意支持 Node 的公网平台，或用 frp / cpolar / ngrok 之类做内网穿透
拿到一个 **https 域名**，用该域名打开页面即可开房联机 —— **服务端本身就托管页面，邀请链接直接可用，无需改代码**。

> ⚠️ 必须是 **https**：https 页面无法请求 http 后端（混合内容会被浏览器拦掉）。

### 为什么 GitHub Pages 不能联机

Pages 只做静态文件托管，没有 Node 进程，页面里的 `/api/join`、`/api/poll` 会命中
`tzh654321.github.io` 返回 404（实测三个接口全 404）。想在线联机只能走 ② ——
把服务端放到公网，用它的域名访问。

## AI 说明

- **基线**：启发式评估 —— 静态棋型窗口分 + 一步杀/双威胁计数 + 多层威胁前瞻，按易/普/难分档。
- **困难档**：叠加 16 维叶子价值网络（MLP `16×64×64×32×1`）打分，权重以 `__NNW` 内嵌于 `index.html`。
- 权重调优与自博弈见 `tools/`；各版本对局实测记录见 [docs/05-实验记录.md](docs/05-实验记录.md)。

## 许可

[MIT](LICENSE)
