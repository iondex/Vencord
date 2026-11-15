# Forwarder remote 模式

Remote 保留 Discord 通知资格筛选与 legacy `source / notification / metadata / message` 契约。它不会像 Local 一样采集所有符合基本来源边界的 `MESSAGE_CREATE`。

配置字段：`serverUrl` 是主接收接口，`fallbackUrl` 是主接口失败后的备用；当前 CF 入口为 `https://forwarder.yufeng.run/forward`。旧用户的接收地址和启用状态继续保留。新增 Local 的地址、配对和运行目录使用独立字段，切换 Local 后不会自动执行 remote fallback。

Remote 对每个端点最多尝试五次，间隔 1 / 2 / 4 / 5 秒。网络错误、超时、408、429 和 5xx 可以重试；400、401、403、404、422 等永久性请求错误只尝试一次，然后按原有 fallback 配置处理。健康检查独立使用目标 `/healthz`。

`excludedServerIds` 同样约束 remote 来源，保留本人和非 server 消息过滤。Local 服务的路由图/持久化发送意图兜底不应用到 remote CF 执行器；remote 生产路由仍由 CF 原实现负责。

已核对旧 `signal-hub` 和新 `forwarder` 的 schema，除了 import 路径外完全相同，继续共用同一 legacy envelope。已修复以下 serializer 与这两套 CF 契约的不兼容：

- 附件可选 MIME 和 proxy URL 缺少时省略该字段，避免输出 null。
- 作者 globalName 缺少时使用空字符串。
- Embed-only 消息正文缺少时使用空字符串。
- Reply 的引用结构递归执行同样的规范化，并限制递归深度；原始 message 仍保存在 raw。

非 2xx 诊断只保留安全错误码、字段路径、响应长度/状态和 CF Ray ID，不把原始错误正文、消息正文或 token 输出日志。新旧 CF 可能把 schema 错误混为 `invalid json`；不能仅凭 HTTP 400 判定是入口契约还是出站 Discord 限制。

钉钉 webhook 已从源码默认值移除，新设置默认不启用 remote 钉钉通知；已有用户设置保持不变。Local 的故障通知配置在本地服务中。

完整启动、内网部署和验证命令见 `docs/signal-hub-operations.md`。原 README 中 Go receiver 的启动命令已经删除，当前仓库服务使用 Node + TypeScript + SQLite。
