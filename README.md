# Mika Cloudflare Relay

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/EvanDbg/mika-cloudflare-relay)
[![CI](https://github.com/EvanDbg/mika-cloudflare-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/EvanDbg/mika-cloudflare-relay/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

把 **Mika 安卓 Agent 的远程网关**部署到自己的 Cloudflare 账户。兼容 **Mika v0.1.35 / `mika-relay.v2`**，包含中文管理页、手机配对、WebSocket 隧道和 CLI / MCP 转发。无需购买 VPS，也无需给手机配置公网 IP 或端口映射。

A self-hosted, single-phone Mika relay for Cloudflare Workers and SQLite Durable Objects. This is an independent adaptation, not an official Mika release.

## 一键部署

1. 点击上方 **Deploy to Cloudflare**，登录 Cloudflare，并按页面提示连接你的 GitHub / GitLab 账户。
2. 选择目标账户、仓库名和 Worker 名。Cloudflare 会把代码复制到你自己的仓库，并配置构建部署。
3. 在 **`OWNER_KEY` Secret** 中填入你自己生成的随机管理员密钥，**至少 32 个字符**。不要保留 `CHANGE_ME`。可以用密码管理器生成，或在本地运行下面的命令。
4. 其余配置保持默认，完成部署。所需的 SQLite Durable Object 会自动创建，无需手动填写账户 ID、namespace ID 或数据库 ID。
5. 打开部署结果中的 `https://<worker-name>.<your-subdomain>.workers.dev`，使用刚才的 `OWNER_KEY` 登录管理页，生成配对码。
6. 在 Mika 的远程访问设置里填写**网关根地址**和配对码；外部 MCP 客户端使用管理页显示的 `/mcp` 地址。

```sh
# 在自己的电脑生成随机密钥。只保存到自己的密码管理器或 Secret 配置中。
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

`OWNER_KEY` 是本项目的管理密码，**不是 Cloudflare API Token，也不是手机访问令牌**。每位部署者应生成自己的密钥。示例占位符故意短于最低长度：误用它时服务会返回 `503`，不会开放管理权限。

默认自动采用新 Worker 的实际访问地址；无需预先猜测域名，也不依赖作者的 Cloudflare 账户。按钮流程仍需你登录账户、授权 Git 连接并填写密钥。[部署步骤与自定义域名](docs/DEPLOYMENT.md) · [手机配对与验收](docs/USER_GUIDE.md)

## 需要什么

| 项目 | 要求 |
| --- | --- |
| Cloudflare | 可以创建 Worker 和 SQLite Durable Object 的账户 |
| Git 账户 | 使用部署按钮时，连接自己的 GitHub / GitLab 账户 |
| 安卓手机 | 已安装兼容的 Mika，并在手机本地完成权限、模型和远程访问设置 |
| 网络 | 手机与调用端均能访问你的 Worker HTTPS 域名 |
| 其他服务器 | 不需要 VPS、Docker、独立数据库或反向代理 |

网关不运行大模型，也不提供模型 API Key。Cloudflare 资源用量计入部署者自己的账户，套餐和额度请以 [Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)及 [Durable Objects 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)为准。

## 工作原理与范围

手机主动连接网关的 `/device` WebSocket。外部客户端向 `/mcp` 或 `/api/v1/...` 发起请求；同一个 Durable Object 将请求转给手机，并把对应响应返回客户端。配对状态保存在 DO 内置 SQLite 中。空闲连接使用 WebSocket Hibernation，不用常驻服务器或持续唤醒对象的定时器。

- 一个 Worker 对应一个管理员、一台配对手机。需要多台手机时，部署多个独立 Worker。
- 管理页可以生成配对码、查看设备状态、复制地址、撤销设备。
- 任务执行沿用 Mika CLI / MCP 客户端；管理页不提供实时屏幕视频或人工点击控制。
- 网关不持久化任务正文、任务结果或手机远程访问令牌；配对凭据按摘要保存。
- 网关终止 TLS，因此能读取经它转发的内容。应部署到自己信任的 Cloudflare 账户。

三类凭据分别使用：

| 凭据 | 谁使用 | 用途 |
| --- | --- | --- |
| `OWNER_KEY` | 浏览器中的管理员 | 管理网关、生成配对码和撤销设备 |
| 设备隧道凭据 | Mika 手机自动持有 | 建立 `/device` 隧道 |
| 手机远程访问令牌 | CLI / MCP 调用端 | 由 Mika 手机验证远程调用权限 |

## 本地开发

使用 `.node-version` 指定的 Node.js 版本。依赖锁定在 `package-lock.json`；测试需要支持 workerd 的系统环境。

```sh
git clone https://github.com/EvanDbg/mika-cloudflare-relay.git
cd mika-cloudflare-relay
npm ci
cp .dev.vars.example .dev.vars
npm run keygen
# 将生成的密钥填入 .dev.vars 的 OWNER_KEY，替换 CHANGE_ME。
npm run dev
```

本地管理页为 `http://127.0.0.1:8787`。真实 Android APK 使用 HTTPS 网关；本地 HTTP 地址用于开发。

```sh
npm run types        # 配置变更后重新生成 Worker 类型
npm run types:check  # 检查提交的类型是否与配置一致
npm run typecheck
npm test
npm run check:deploy # 只检查打包，不上传、不需要账户密钥
```

## 使用命令行部署

准备好上述 `.dev.vars` 后：

```sh
npx wrangler login
npm run deploy -- --secrets-file .dev.vars
```

这会同时上传代码和 `OWNER_KEY`，并创建 DO。后续更新可直接运行 `npm run deploy`，已配置的 Secret 会保留。不要把 `.dev.vars`、账户凭据或真实部署结果提交到仓库。[完整部署与升级说明](docs/DEPLOYMENT.md)

## 接口与可靠性

| 接口 | 用途 |
| --- | --- |
| `GET /`、`GET /admin` | 管理页面 |
| `GET /healthz` | 网关健康状态，不代表手机在线 |
| `GET /admin/status` | 管理员查看配对和连接状态 |
| `POST /admin/pair` | 生成有效期 5 分钟的一次性配对码 |
| `POST /admin/revoke` | 撤销配对并关闭设备隧道 |
| `POST /pair` | 手机用配对码换取设备隧道凭据 |
| `GET /device` | 使用 `mika-relay.v2` 子协议建立 WebSocket |
| `DELETE /device` | 手机解除配对 |
| `/mcp`、`/api/v1`、`/api/v1/...` | 转发远程调用 |

正文最大 1 MiB，WebSocket 消息最大 2 MiB，最多 8 个在途请求，默认转发等待上限 65 秒。手机离线时立即返回 `device_offline`，不会把任务排队等到手机恢复后执行。

超时或断线后，`delivery_unknown` 表示请求可能已送达手机。请使用已有任务 ID 查询状态，不要直接重提可能已执行的操作。取消等待也不保证取消手机已经执行的动作。平台更新和网络故障仍可能中断连接。

## 测试、安全与维护

GitHub Actions 在提交和 Pull Request 上运行类型检查、真实 workerd / Miniflare 协议测试、管理页 DOM 测试与部署打包检查，不需要 Cloudflare 账户凭据。模拟手机测试不能替代真实 Android APK 验证，详见 [验证说明](docs/VALIDATION.md)。

密钥只通过 Worker Secret 或本地忽略的文件提供。应用日志不记录任务正文、请求头、凭据或完整异常；默认请求调用日志关闭，查询字符串脱敏。管理页仅在当前页面内存保存管理员密钥。更多信息见 [SECURITY.md](SECURITY.md)。

## 上游与许可

- 上游项目：[wangzan101/Mika](https://github.com/wangzan101/Mika)
- 协议基线：`v0.1.35`，提交 `6661b9e99a9a8f372c93845f5f9572de0711f239`
- 本项目：Apache-2.0，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
- `vendor/mika` 保留用于协议核对的未修改上游参考文件及许可声明。

此移植重新实现了 Cloudflare 运行环境、持久化、休眠恢复和管理 UI。后续 Mika 协议变化需要重新验证兼容性。
