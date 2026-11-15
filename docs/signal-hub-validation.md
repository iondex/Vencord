# Local 分支验证记录

日期：2026-11-15，Asia/Shanghai。

## Git 与范围

- 已从 `signal-hub` 创建并切到临时分支 `local`。
- 开发开始、复审后及分批发布前 fetch 所有 remote；`origin/main` 为 `d07030c0`，已被开发基线 `a276f10a` 包含，本轮无新的上游提交需要合并。
- 按用户授权分批提交并推送到 `iondex/local`：`c6354623` 为构建范围及插件更名，`cc7bcb2d` 为本地服务，`a9a3117a` 为插件 Local 模式与持久化交接。文档单独提交。没有创建 issue 或 PR，没有推送上游 `origin`。
- 界面显示 `Local` / `Remote`，持久化配置值为 `local` / `remote`，分支名为 `local`。
- 工作区另有转录开发改动；相关脚本、私有插件及共享配置中的对应改动不纳入本次提交。
- 用户已有根 `pnpm-lock.yaml` 改动保持原样，SHA-256：`79ffe60a1a390df61582a03e5496b139bd4f11734291e25e8c456107a6e1e6ca`。
- Signal-hub 有独立 workspace、依赖和 lockfile，未向根依赖加入 SQLite/模型 SDK。

## 已通过

- `pnpm test:signal-hub`：forwarder 逻辑/原生发送/本地队列、channel-logger 逻辑与 CLI/存储/HTTP 回归通过；本轮复审与追加需求后独立服务扩展至 41 个测试，全部通过。
- `pnpm test:ts`、`pnpm --dir signal-hub check`。
- `pnpm build --dev`、`pnpm buildStandalone --dev`、`pnpm buildWebStandalone --dev`。
- `pnpm buildReporterDesktop --dev`、`pnpm buildReporter --dev`；验证后恢复普通 dev 构建产物。
- `pnpm generatePluginJson`：仅两个可选插件，名称为 `forwarder`、`channel-logger`，均 `enabledByDefault: true`，另保留必需 core。
- renderer sourcemap 包含两插件与 `_api` / `_core`，以及上游主题设置页静态引用的 `clientTheme` 代码；`clientTheme` 没有注册到插件清单，profile 控制的是注册范围，并未删除上游文件或拆解其 UI 依赖。
- 文档中的初始化命令，以及新增 `signal-hub/scripts/start.sh configure` / 默认启动均在隔离临时运行目录实际执行成功；覆盖内网地址、重复配置保留 token、从其他目录执行和 SIGTERM 正常退出。
- `pnpm fmt:check`、`git diff --check`。

测试覆盖原始事务归档、观察/业务身份去重、未确认磁盘队列、错误 ACK、同账号多机器身份、防发送前响应回流、响应丢失、跨进程/备份恢复、空排除名单、路由闭环、配置分页与刷新失败、未知/nullable 消息、长 Unicode 分段、解析结果复用、HTTP 认证/隔离诊断、DingTalk HTTP 200 业务错误以及缓存离线启动。

CF remote 契约测试使用固定真实 schema：四类 nullable 输入在旧形态下被拒绝，经过当前 serializer 规范化后全部通过。复审比较固定的旧 `signal-hub` 与新 `forwarder` schema，确认除了 import 路径外相同；新增 server/guild 别名、引用回复及富消息字段测试，没有调用真实投递目标。

本轮新增回归覆盖：固定快照投递及当前安全否决、Signal 路由替换与引用上下文、期权 underlyingTicker 白名单及主/指数双目标、每次尝试记录、首次尝试后五次指数退避重试、耗尽后到期补发、对账游标轮转、route 策略拦截/冲突记录、认证后的投递查询、旧任务审计迁移和重启后补发计数。Native 新增关闭覆盖异步 configure、身份文件写入中断及有效身份保留测试。

追加覆盖：钉钉分级合并、严重故障越过普通冷却、持续故障提醒、持久化限频、只恢复已通知事件、通知请求中的恢复与级别升级、watchdog 损坏心跳与跨重启去重/持续提醒、已到期投递积压、部分目标恢复不误解除故障、按原消息定位和隔离状态查询。所有通知均使用 mock，未触达用户真实 webhook。

## 线上只读核对

使用当前 `createConfigSync` 对 `https://forwarder.yufeng.run` 执行两次完整读取，校验成功并得到 51 条 routes、45 条 enabled、Signal 开启、42 个目标 profiles。读取覆盖所有 routes 分页、Signal 配置和目标 profiles，没有写 CF 配置、读取业务 secret、调用生产 `/forward` 或发送 Discord/模型/钉钉测试消息。

## 尚未通过或尚未执行

完整 `pnpm lint` 未通过：仍为广泛存在的 `path-alias/no-relative` 和未改动的 `scripts/runInstaller.test.mjs` 原有文件头错误。没有为消除此问题而重写上游文件或用户 lockfile。使用临时检查配置排除上述两个规则后，本次改动文件的其余风格检查已通过；项目正式 lint 仍应记为未通过。

没有实际接管生产消息、验证真实 Bot 发送权限或请求模型。生产切换需要服务端凭据、指定测试目标和实际客户端采集；Local 模式必须显式配置连接信息，不能仅凭离线测试视作已上线。

语音仅完成静态代码定位与实验设计，未进行真实客户端 join/watch、远端音轨录制或实时转录；外部语音文档抓取未取得可验证正文，未引用未经核实的发布日期/协议强制切换日期。

ACK 自动保留清理、完整二进制媒体归档、目标外观重建和人工安全状态释放工具尚未落地。过渡期兼容范围是插件 remote 向旧 CF Worker 发送；Local 不需要实现旧 Worker 消息入口。真实生产发送验收仍未执行。当前实现边界及运行方法以 `docs/signal-hub-operations.md` 为准。
