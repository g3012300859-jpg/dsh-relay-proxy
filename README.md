# dsh relay 代理（最小转发）

## 这是什么

一个最小的 Node 转发代理，让跑在浏览器来源上的工作台页面能连上 dsh 中继
（`dsh.r2049.cn`）。它不是第二个中继，只是一根“去来源头的传话筒”，且只转
控制信令；真正的会话数据仍走手机与电脑之间的 WebRTC 直连，不经过这里。

## 为什么需要它（已实测，不是推测）

中继的文档（`docs/server.md` §18）写明：浏览器 WebSocket 的 Origin 只允许
中继自己的站点。2026-11-10 的区分性实测（同一枚真实 hello，只换 Origin 头，
测试设备 `542b0ab7`）：

| Origin | 结果 |
|---|---|
| 无 Origin（Node 客户端） | `hello.ack`，连通 |
| `https://dsh.r2049.cn`（中继自己） | `hello.ack`，连通 |
| 外部来源（模拟手机上的工作台页） | 握手 101 后 `close 4010 "origin not allowed"` |

浏览器改不了 WebSocket 的 Origin 头，中继的白名单改不了（作者的服务器），
工件平台搭不起 WebSocket 服务端。所以中间加这个代理：页面连代理（代理不
校验来源），代理连中继时不带 Origin 头（就是上面第一种能通的形态）。

## 它做什么、不做什么

做：

- WS：接受任意来源的 `/ws/v1/connect`，向上游 `wss://dsh.r2049.cn/ws/v1/connect`
  开新连接，**不带 Origin 头**（`ws` 客户端默认就不带）。绝不把 Origin 写成
  中继自己的地址——那是冒充，不走这条路。
- REST：转发 `/api/*` 到中继（测试对等用；工作台生产环境只用 WS 这条腿，
  REST 仍走工件服务端 actions）。
- `GET /health` 返回 `{"ok":true}`，供保活 ping 与 Render 健康检查用。

不做：

- 不绕过任何认证：中继仍会自己校验设备 token 与 Noise 身份密钥；这个代理
  授权不了任何它没有的东西。
- 不解析、不记录任何帧内容、请求头、请求体、token 或密钥。日志只有生命周期
  （连接/断开、关闭码、REST 方法+路径+状态码）。

## 本地运行

```bash
npm install
PORT=8080 node server.js
# 健康检查：curl http://127.0.0.1:8080/health
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8080` | 监听端口（Render 会注入自己的 `PORT`） |
| `RELAY_WS_URL` | `wss://dsh.r2049.cn/ws/v1/connect` | 上游控制通道 |
| `RELAY_HTTP_URL` | `https://dsh.r2049.cn` | 上游 REST |
| `UPSTREAM_TIMEOUT_MS` | `15000` | 上游建连/请求超时 |

## 本地实测（已跑通的步骤，复现用）

在装有测试设备凭据的电脑上（`D:\min-test-device.json`，仅测试用）：

1. 起代理：`set PORT=18080 && node server.js`（或 `PORT=18080 node server.js`）。
2. 区分性复测：把 `../origin-differential-test.mjs` 的 WS 目标指到本地代理
   （`WS_HOST=127.0.0.1 WS_PORT=18080 WS_TLS=0`），外部 Origin 应得
   `HELLO_ACK`——即代理越过了手机上的那个 4010。
3. 全链路：用 2b 的 `node-test.mjs`（oauth 模式），把
   `DSH_TEST_SERVER` 指到 `http://127.0.0.1:18080`，应走完 hello → Noise
   握手 → 能力探测 → `session/list`。

## 部署到 Render（待用户点头再走这一步）

1. 用户注册一个 Render 账号：邮箱即可，**不用信用卡**（免费档）。
2. 新建 Web Service，连这个仓库（或直接上传 `server.js` + `package.json`）：
   `Build Command` 留空（无构建步骤），`Start Command` 填 `node server.js`。
   Node 版本选 22 或更高（`package.json` 的 `engines` 已声明）。
3. 环境变量：一般不用填，默认值就是中继地址；如需改上游再填上表变量。
4. 拿到地址（形如 `https://<名字>.onrender.com`）后，把工作台的控制通道
   URL 从 `wss://dsh.r2049.cn/ws/v1/connect` 改成
   `wss://<名字>.onrender.com/ws/v1/connect`，其余不动。

## 免费档的代价（实话）

- 免费档 15 分钟没人用就休眠，下次连接要等约 1 分钟唤醒。每月 750 小时
  额度够一台 24 小时跑。
- 缓解办法：每 10 分钟 `GET /health`  ping 一次（可由现有的定时任务做），
  让它一直醒着；或工作台连接失败文案写明“正在唤醒中转，约 1 分钟”，
  超时放宽后重试一次。
- 免费档带宽对控制信令来说绰绰有余（会话数据不走这里）。

## 安全说明

- 代理能看到“谁连谁、什么时候连”（与中继能看到的一样），但看不到内容：
  业务全程 Noise 加密，代理只透传字节。
- 这是个人用的单跳点；如果以后要给别人用，应先加一层调用方鉴权（不在
  本轮范围内）。
