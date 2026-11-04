# 部署、配置与升级

## 推荐：Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/EvanDbg/mika-cloudflare-relay)

按钮会进入 Cloudflare 官方部署向导。登录后选择自己的 Cloudflare 账户，连接 Git 提供商，选择新仓库和 Worker 名。向导会复制公共代码，配置 Workers Builds，部署 Worker，并根据 Wrangler 配置创建 SQLite Durable Object。

在 Secrets 中填写 `OWNER_KEY`。本仓库通过 `.dev.vars.example` 声明这个提示，并通过 `wrangler.jsonc` 的 `secrets.required` 声明部署依赖。`CHANGE_ME` 只是不能使用的占位符，必须替换成至少 32 字符的随机私有密钥。推荐用密码管理器保存 `npm run keygen` 生成的 43 字符随机值。

密钥应是 **Worker 运行时 Secret**。只填在构建环境变量中不能让 Worker 在运行时读取它。部署完成后，打开 Worker 的 HTTPS 地址，用该密钥登录管理页。如果向导没有显示 Secret 输入，先完成仓库导入，在 Worker 的 **Settings → Variables and Secrets** 添加类型为 **Secret** 的 `OWNER_KEY`，再重新触发部署。

部署后的仓库归部署者所有。以后向该仓库的生产分支推送代码，Workers Builds 会按其设置重新构建部署。GitHub Actions 仅进行检查，不负责保存或使用你的 Cloudflare Token。

## 配置项

| 配置 | 默认值 / 配置位置 | 含义 |
| --- | --- | --- |
| `name` | `mika-relay`，Wrangler 文件 | Worker 名；部署向导可更改 |
| `OWNER_KEY` | 无可用默认值，Worker Secret | 管理密钥，至少 32 字符 |
| `RELAY_TIMEOUT_MS` | `65000`，Wrangler `vars` | 转发等待毫秒数，有效范围 1–65000 |
| `GATEWAY_ORIGIN` | 默认省略 | 可选：限制为固定 HTTPS origin |
| `RELAY` | 自动创建的 DO binding | 单手机配对状态和请求协调 |
| `workers_dev` | `true` | 开启默认 HTTPS 访问域名 |
| `preview_urls` | `false` | 关闭额外版本预览入口 |

不需要添加 Cloudflare Account ID、Zone ID、DO namespace ID、D1 database ID 或公网 IP。模板中没有作者实例的地址、管理员密钥、手机令牌或配对数据。

## 地址自动识别与自定义域名

默认从 Cloudflare Worker 收到的 `Request.url` 获取实际 origin；不会使用 `Host`、`Forwarded` 或 `X-Forwarded-Host` 来选择返回地址。这样更换 Worker 名或账户子域后仍可直接使用。

同一 Worker 绑定的多个入口共享同一个 DO 和同一台手机；它们不是隔离租户。管理页和配对响应返回本次访问入口的地址，Origin 检查也使用本次入口。日常建议统一使用一个入口。

需要固定域名时，先在 Cloudflare 给该 Worker 绑定自己的自定义域名，然后在 `wrangler.jsonc` 的 `vars` 中加入：

```json
{
  "RELAY_TIMEOUT_MS": "65000",
  "GATEWAY_ORIGIN": "https://relay.example.com"
}
```

这个值必须是完整 origin，不带路径、查询字符串、用户信息或 fragment。设置后，访问其他入口会收到 `421 invalid_gateway_origin`；生产仅接受 HTTPS。本地开发允许 `http://localhost`、`http://127.0.0.1` 和 `http://[::1]`。

重新运行 `npm run types`、测试并部署，再让手机使用新地址。必要时撤销旧配对并用新地址重新配对。不要在整个网关前放置需要浏览器交互登录的 Cloudflare Access 门禁，原版手机与 CLI 无法完成这种登录跳转。

## 命令行部署

使用 `.node-version` 指定的 Node.js 版本：

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run keygen
# 把新密钥填入 .dev.vars，替换 CHANGE_ME。
npm run typecheck
npm test
npm run check:deploy
npx wrangler login
npm run deploy -- --secrets-file .dev.vars
```

首次部署需要一个尚未占用的 Worker 名；如账户中已有同名服务，请先修改 `wrangler.jsonc` 的 `name`，避免更新到错误的服务。

`--secrets-file` 会把本地文件中的密钥作为 Worker Secret 与代码一起上传。此模板的 `.dev.vars.example` 只包含 `OWNER_KEY`。不要在该文件额外加入你不想上传为 Secret 的配置。

`npm run check:deploy` 是本地打包检查，不会发布服务，也不需要现有 Cloudflare 账户凭据。它不能代替真实云端配对与网络测试。

如果使用 API Token 自动部署，把 Token 放进执行环境的 Secret 中，只授予目标账户所需的 Worker 部署权限；DO 由该 Worker 管理。不要在 README、Wrangler 文件、命令参数、Issue 或截图中写入 Token。

## 升级与数据保留

后续更新：

```sh
npm ci
npm run types:check
npm run typecheck
npm test
npm run deploy
```

正常代码部署会保留既有 Secret 和 DO 数据。`migrations` 中的 `v1` / `new_sqlite_classes` 是已部署资源的迁移历史，应持续保留。不要为了更新代码而删除、重建 DO namespace 或修改稳定的对象名称，否则原配对状态将无法使用。

更换 `OWNER_KEY`：

```sh
npx wrangler secret put OWNER_KEY
```

根据交互提示填写新随机密钥。该命令会创建并部署新版本；管理员以后使用新密钥，手机的独立隧道凭据不依赖这个密钥。

## 验证与排错

1. 打开根地址：应显示中文管理页。
2. 打开 `/healthz`：正确配置后返回 `status: ok`。
3. 输入管理员密钥：应能查看尚未配对 / 离线状态。
4. 生成配对码，在真实 Mika 手机填写网关根地址与配对码。
5. 等待手机在线，用手机远程访问令牌从 CLI / MCP 执行一个简单任务。

| 现象 | 排查方向 |
| --- | --- |
| `503 gateway_not_configured` | `OWNER_KEY` 缺失、仍为占位符、短于 32 字符，或固定 origin 配置无效 |
| `421 invalid_gateway_origin` | 设置了固定 origin，但访问了不同域名 |
| `401 invalid_owner_key` | 输入的管理员密钥和 Worker Secret 不一致 |
| `device_offline` | 手机隧道未连接；检查手机远程设置、网络和后台运行限制 |
| 手机地址校验失败 | 必须填写 HTTPS 根地址，不含 `/mcp` 或其他路径 |
| 部署提示 missing required secret | 在 Worker 运行时添加 `OWNER_KEY`，或使用 `--secrets-file` 后重试 |
| 部署时 DO migration 报错 | 保留原迁移历史，确认没有复用其他服务的 Worker / DO 配置 |

`/healthz` 成功只说明网关配置和入口可用，不代表手机在线、模型可用或任务执行成功。真实手机测试步骤见 [USER_GUIDE.md](USER_GUIDE.md)。

## 官方参考

- [Deploy to Cloudflare：按钮、Secret 提示、自动资源创建](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Workers Secrets：运行时密钥与随代码部署](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Durable Object class migrations](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/)
- [WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
