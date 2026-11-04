# 验证说明

## 可复现的检查

本仓库通过 GitHub Actions 执行以下命令。CI 不访问部署者的 Cloudflare 账户，不使用真实手机或私人密钥。

```sh
npm ci
npm run types:check
npm run typecheck
npm test
npm run check:deploy
```

- 协议测试使用真实 workerd / Miniflare 与 SQLite Durable Object，并通过模拟手机收发 WebSocket 消息。
- 覆盖配对响应字段、管理员和设备鉴权、凭据撤销、重连代际、休眠恢复、并发转发、超时与未知送达状态、正文与消息大小限制、离线响应等行为。
- 公共部署模板还验证自动 origin、固定 origin、伪造转发头、多个入口共享同一设备，以及请求间的 origin 隔离。
- 管理页使用 JSDOM 验证登录、配对、刷新、撤销、锁定及凭据不写入持久化存储。
- Wrangler dry run 验证配置与打包，不执行云端部署。

这是一组服务端协议和 DOM 测试，不是完整浏览器视觉测试或真实 Android APK 实测。手机的系统权限、后台运行、网络可达性、模型调用和实际任务执行仍需部署者按照 [手机验收步骤](USER_GUIDE.md) 检查。

## 可选：自己的空闲网关进行云端模拟测试

`test/live-smoke.mjs` 不属于默认 CI。它会连接真实 HTTPS / WSS 网关并创建临时模拟配对，所以只应对自己允许测试的、尚未配对手机的实例运行。脚本发现已有配对时会拒绝继续。

在仓库外创建一个仅自己可读的 JSON 文件，其中包含 `origin` 和 `ownerKey` 两个字段。`origin` 是你的 HTTPS 网关根地址，`ownerKey` 是该实例的管理员密钥。不要提交此文件或把它粘贴到 Issue。

```sh
node test/live-smoke.mjs /absolute/path/private-deployment-secrets.json
```

测试包括公网健康检查、鉴权、配对字段、WebSocket 子协议、协议 ping/pong、HTTP 往返、短暂空闲后的同连接调用、撤销和离线状态。不会调用真实模型或操纵手机。正常结束会撤销模拟设备；异常时会尝试清理，并在输出中说明清理结果。

结果写入被 Git 忽略的 `test-results/`，无需作为仓库文件提交。脚本只记录检查结果及失败阶段/分类，不输出实例域名、个人时间戳、响应正文、凭据或异常原文。分享排错材料时仍应检查其他工具附加的输出。

## 依赖注意事项

Miniflare 与 Wrangler / workerd 版本一并固定，以匹配已测试的运行时 API。当前使用 Miniflare 5 beta 的转换入口；升级这些依赖应一起检查配置和休眠行为，不能只按版本号认为可直接替换。

少数 WebSocket 关闭测试使用所固定 `ws` 版本的 receiver control-frame 事件，以区分 CLOSE 帧与本地模拟器延迟的 TCP 关闭。代码内有相应说明；更新 `ws` 后应重新运行整套协议测试。
