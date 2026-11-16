# forwarder

设置页使用中文，按“本地（Local）”和“远程（Remote）”标签分开配置。Local 默认启用，将基本过滤后的服务器消息交给本机或内网 Signal-hub；Remote 保持旧版 CF Worker 的通知转发兼容。已保存的模式不变，切换标签后重启客户端生效。

本机持久化队列目录自动确定，已有自定义目录会沿用。Local 标签支持检查 API、暂停状态和缓存路由，选择一条路由真实发送测试消息并查询最终投递结果；测试使用既有持久化投递和防回流检查。暂停期间仍接收保存，但不发送测试或业务消息，需要 `POST /api/resume` 才恢复。

部署、配置、测试按钮和恢复步骤：[Signal-hub 运行说明](../../../docs/signal-hub-operations.md)。

Remote 消息格式与兼容说明：[远程模式](../../../docs/forwarder-remote.md)。

架构和实现范围：[Signal-hub 规划](../../../docs/signal-hub-plan.md)。
