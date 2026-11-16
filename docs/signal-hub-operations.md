# Signal-hub 本地服务运行说明

开发分支：`local`。`iondex/local` 是远端 `iondex` 上 `local` 分支的引用，本地及 GitHub 分支名称均为 `local`。文本链路使用独立 Node 服务，CF 保留配置界面。未在生产 Discord 目标启用发送。

过渡期的 CF 兼容要求约束插件 `remote` 模式：继续使用 legacy payload 与旧版 CF Worker 通信。`local` 使用独立的 v2 采集协议，不模拟旧 Worker，也不自动向 CF 消息入口回退。参考新 CF 架构不改变这个兼容边界。

首次与 transcribe 一起实机测试，见 [联合实机测试方案](signal-hub-live-test.md)，包括私有直播频道规划、生产 route 隔离、设置和分阶段验收。

## 配置和启动脚本

在 Vencord 仓库根目录运行：

```sh
pnpm hub:configure
pnpm hub
```

统一入口为 `signal-hub/scripts/start.sh`，也可从任意目录用绝对路径执行 `bash /absolute/path/Vencord/signal-hub/scripts/start.sh`。脚本检查 Node >=22.13.0 和 pnpm，在缺少服务依赖时执行 frozen-lockfile 安装，首次运行自动初始化。`pnpm hub:configure` 只创建默认 JSON 配置、打印文件位置及插件设置入口，不启动服务；`pnpm hub` 启动服务，首次启动时也会自动初始化，因此 configure 可省略。另支持 `status`、`backup`、`watchdog`。重复运行保留已有配置和 token，部分配置缺失时明确报错；运维子命令不会自动生成新的配对配置。进程通过 exec 启动，SIGTERM/SIGINT 交给服务执行正常退出。

默认运行目录为仓库下的 `signal-hub/var`。可以通过绝对路径环境变量 `SIGNAL_HUB_VAR` 改变位置。目录及私密文件分别使用 0700、0600 权限。`pnpm hub` 首次启动即可接收并归档，但发送 Discord 或请求模型仍须填写业务凭据。

初始化后直接编辑 `signal-hub/var/settings.json`，所有服务配置和凭据均使用 JSON，无需 `.env` 文件。本机默认内容：

```json
{
    "host": "127.0.0.1",
    "port": 49321,
    "cfBaseUrl": "https://forwarder.yufeng.run",
    "excludedServerIds": [],
    "loggerDatabase": "",
    "recoveryAccountId": "",
    "botHistoryEnabled": false
}
```

内网部署时在服务机器将 `host` 改为 `"0.0.0.0"`，按需修改 `port`；在 Discord 的插件设置页填写服务可访问的内网 URL，例如 `http://192.168.1.50:49321/forward`，不要填写 `0.0.0.0`。修改服务监听设置后重启服务；插件连接设置按页面提示重启 Discord。

原有环境变量覆盖仍保留，供临时运维使用；日常配置以 JSON 为准。自定义运行目录时，配置、启动、status、backup 和 watchdog 都应使用相同的 `SIGNAL_HUB_VAR`。

依赖安装和初始化也可分别运行 `pnpm --dir signal-hub install --frozen-lockfile`、`pnpm --dir signal-hub run init`。

初始化产生：

- `var/settings.json`：监听地址、端口、CF 配置源、排除的 Discord server 和历史恢复设置。
- `var/secrets.json`：保留 `pairingToken`、`adminToken` 设置，两者默认均为 `""`，分别表示采集入口、管理 API 无需 token；Discord Bot、模型、CF 及告警凭据默认留空。

不再生成 `plugin-connection.json`。插件连接由 Discord 内的 forwarder 设置页保存，服务不读取该旧文件；已有文件不会被脚本删除。令牌只写入凭据文件，不输出到控制台，也不会因重复 configure 而轮换。

运行命令：

```sh
pnpm hub
pnpm hub:status
pnpm hub:backup
```

三个命令分别是前台运行、查看状态及备份；不要把它们当作单个前台进程依次执行。`status` 直接读取数据库，主进程配置损坏或缺失时仍可执行状态和备份；尚未创建数据库时明确报错。`GET /healthz` 检查进程 HTTP 存活，`GET /api/status` 返回归档/任务状态，仅在 `adminToken` 非空时要求认证。HTTP 存活不代表所有目标都能发送，需一起检查任务与告警。

## 加载 Discord 插件

在已安装根目录依赖的本机 checkout 构建并注入：

```sh
cd /absolute/path/Vencord
pnpm build --dev
pnpm inject
```

`pnpm inject` 是首次安装或切换开发 checkout 时的交互式注入入口，按提示选择实际 Discord 安装。插件随 Discord 加载；构建后完整退出并重新打开 Discord。只重建已有注入时不必每次重新执行注入器。

先运行 `pnpm hub:configure`，在 `signal-hub/var/secrets.json` 填写 Bot、模型和钉钉等所需凭据。打开 Discord 设置 → Vencord → Plugins → forwarder，在插件配置页直接填写：

| 插件设置 | 本机部署的填写内容 |
| --- | --- |
| 本地（Local）标签 | 未设置过模式时默认选中；已保存的模式选择会保留 |
| 本地服务地址（`localServerUrl`） | 默认 `http://127.0.0.1:49321/forward`；服务在内网时填写该机器的可访问 URL |
| 连接令牌（`localPairingToken`） | 默认留空；仅在服务的 `pairingToken` 非空时填写相同值 |
| 排除的服务器（`excludedServerIds`） | 按需填写逗号或空格分隔的 server ID，并与服务的 `settings.json` 保持一致 |

保存后完整退出并重启 Discord。插件配置使用 Vencord 自带的设置存储，无需编辑额外连接文件。本机队列目录自动使用 Vencord 数据目录下的 `signal-hub/var`，本仓库注入器会将数据目录设为 checkout 根目录；未指定数据目录时使用构建文件所在仓库。已有自定义队列目录会沿用，以免遗留待发送消息；界面只读展示实际目录，不再要求填写。服务在内网机器时，发送队列仍在 Discord 采集机。

主服务、watchdog 以及可选 channel-logger 各占一个终端：

| 进程 | 仓库根目录下的命令 |
| --- | --- |
| Signal-hub 主服务 | `pnpm hub` |
| 独立心跳告警 | `pnpm hub:watchdog` |
| 可选频道日志及补采来源 | `pnpm logger -- --dir /absolute/path/Vencord/signal-hub/var/channel-logger` |

主服务会自行维护解析、投递、补发、配置同步和业务告警任务，不需要另外启动投递 worker。watchdog 没有钉钉凭据时启动输出 `notifications disabled`。仅选择 Local 并设置连接地址即可按默认配置采集归档；实际转发需要服务端发送凭据及可用 routes。

可用 `curl --fail http://127.0.0.1:49321/healthz` 检查 HTTP 存活，用 `pnpm hub:status` 查看任务与告警。开发时可使用 `pnpm build --dev --watch` 持续构建，插件设置中标记需重启的连接参数仍应重启 Discord 后生效。

## 本机和内网部署

本机默认设置：`"host": "127.0.0.1"`、`"port": 49321`。在插件设置页填写上述连接信息、选择 Local 模式并重启 Discord。

服务放在内网机器时：

1. 在服务机器安装并初始化 `signal-hub`，把 `settings.json` 的 `host` 改成机器的内网地址，或由运维指定监听地址。
2. 插件的 `localServerUrl` 填成例如 `http://192.168.1.50:49321/forward`；也支持部署了 TLS 的 `https://hub.lan/forward`。
3. `localPairingToken` 默认留空；如果服务配置了非空 `pairingToken`，则填写相同值。
4. 本机发送队列目录自动确定，不需要配置，也不使用内网服务机器上的目录。
5. 两端的 `excludedServerIds` 保持相同集合，可以都为空。服务端当前排除的来源只归档；消息声明来源被插件排除、服务端却未排除时进入 `safety_pending`。其他 server 的名单变化不会阻塞该来源的旧积压。

原生发送器通过 HTTP(S) 调用，支持内网域名/IP，不依赖 renderer CORS。认证令牌只放 Authorization 头，URL 不允许用户名、密码、query 和 fragment；重定向不会携带凭据继续请求。HTTP 传输适合受信内网，跨越不可信网络时使用 TLS 入口。

文字链路的构建 profile 注册 `forwarder`、`channel-logger` 及上游必需的 `_api` / `_core`。两插件默认启用，显式关闭的设置会被保留。当前 `local` 分支另已合入并行任务的 `transcribe` 插件；它有独立的设置和实现，本说明中的 Local/Remote 切换仅指 forwarder。`ChannelLogger` / `channellogger` 的旧设置迁移到 `channel-logger`；新名称已有设置时优先保留新设置。

未设置过 `mode` 时默认使用 Local；已明确保存的 Local/Remote 模式保留。Local 完全独立，不会转回 CF `/forward`。

插件设置为中文，使用“本地（Local）”和“远程（Remote）”两个标签页隔离配置，保存值仍为 `local` / `remote`。排除服务器是两个模式共用的安全设置；Local 不显示 Remote 地址或钉钉选项，Remote 不显示 Local 连接设置。切换标签页会保存模式选择，重启客户端后生效；重启前继续使用当前已启动的模式。

在本地标签点击“检查本地 API 与发送队列”，会使用当前填写的地址和连接令牌，查询服务暂停状态、缓存配置同步时间及可用路由，并显示本机队列。检查本身不会投递消息。选择一条路由后点击“发送路由测试消息”，会向其目标频道真实发送一条中文测试消息。测试复用持久化投递任务、重试、审计和防回流检查，仅验证目标投递链路，不执行内容过滤和信号解析，也不验证真实消息的来源匹配。未确认送达时显示入队、重试、暂缓或待对账状态；查询中断后可手动刷新，不把 HTTP 202 当作送达。提交响应丢失时点击重试会复用同一测试编号，避免重复建任务。

暂停时 API 和归档继续运行，但测试按钮不可用，服务端也拒绝新测试任务。`POST /api/resume` 才恢复投递；暂停状态保存在数据库中，重启不会恢复。恢复前应检查积压和其他转发入口，避免两个实例同时发送。

## 凭据

`secrets.json` 可配置：

| 字段 | 用途 |
| --- | --- |
| `pairingToken` | 插件写入入口；默认 `""` 表示无需 token |
| `adminToken` | 本地运维 API；默认 `""` 表示无需 token |
| `botToken` | 确认发送身份、目标频道归属、发送及可选历史读取 |
| `webhooks` | 可选 `目标频道 ID: webhook URL` 映射；使用前确认 webhook 实际频道 |
| `modelApiKey` | Signal 模型解析 |
| `cfToken` | 配置读取需要 Authorization 时使用 |
| `dingTalkWebhook` | 故障/恢复告警 |

两个入口独立判断 token：可全部留空，也可仅保护其中一个入口。非空 token 沿用至少 24 字符校验，两者均非空时必须不同；插件只发送配对 token，留空时不发送 Authorization 头。修改服务 token 后重启服务，修改插件 token 后重启 Discord。已有配置不会因升级或重复 configure 被自动清空；需要关闭鉴权时将对应字段设为 `""`。

对应业务凭据环境变量：`DISCORD_BOT_TOKEN`、`OPENAI_KEY` / `OPENAI_API_KEY`、`SIGNAL_HUB_CF_TOKEN`、`DINGTALK_WEBHOOK`。这些值只在服务进程读取，不传到插件或写入日志。已从插件源码删除原先内置的钉钉 URL；remote 告警默认关闭，用户已有设置不被重写。

CF 的公开管理接口不返回 Bot、模型和 webhook 的秘密值。优先使用现有授权可读的配置；Workers 已上传 secret 不支持直接读回明文，需要原值或用户补充。这里没有构造 secret 导出接口，也没有向生产发送测试通知。

## 消息流与故障行为

插件只在 `MESSAGE_CREATE` 做基本范围过滤：本人、DM/group DM、optimistic 占位、缺少身份以及显式排除的 server。其余实际收到的消息连同 JSON 安全原始数据交给 native，包含第三方 Bot/webhook、无系统通知、纯附件和纯 Embed 消息。

Native 先原子写入 `spool/forwarder/pending` 并 fsync。每个发送端保存稳定 client ID，以它命名观察事件，避免同账号多台机器的不同采集时间造成 receipt 冲突；重传保留同一 event ID。服务端提交 SQLite 原始接收记录和待处理消息后才返回带 event ID / SHA-256 的 durable ACK。只有精确匹配的 ACK 才能移入 `acked`。失败退避重试，不设置未确认消息 TTL；损坏记录移入 `quarantine`。

当前 ACK 文件无限保留，暂不自动清理，以免还没有独立备份覆盖就删除发送端副本。内网部署时发送端队列和服务端数据库是不同磁盘；同机两份文件仍不能替代异机备份。

服务端处理顺序：原始归档 → 本系统输出/安全检查 → 路由 → 普通转发与 Signal 独立任务。每次观察单独存 receipts，同一 Discord server/channel/message 在多个账号、logger 和补采入口之间共用逻辑消息身份。

CF 每 300 秒后台刷新，完整读取所有分页 routes、Signal 配置及目标 profiles，连续两次完整结果相同后才应用。它是观察一致性检查，不能把 CF 多接口读取当作严格事务快照。任何错误、候选回路或字段校验失败都保留旧配置，归档和缓存路由继续运行；陈旧配置只告警。没有有效缓存时归档为 `waiting_config`。零条 routes 是合法配置。

同步使用一套适配器兼容固定参考的旧 `origin/signal-hub` 和新 `origin/forwarder`：两者的 `/routes` 分页、Signal 配置和公开目标 profiles 接口具有相同读取形状。两分支的消息 Zod schema 只有 import 路径不同，因此 remote 插件继续使用同一 legacy 契约，无需引入按架构切换的第二套协议。此结论经过源代码与离线测试核对；没有执行两套生产环境的真实发送验收。

已支持正文、Reply 当前正文、Embed 文本/链接、附件和音视频链接、贴纸摘要、Poll 摘要、components v2 可见文本。输出安全分段并禁止自动 mentions；未知/临时/无可靠转换的系统类型归档为 `archived_unsupported`。原始 JSON 不裁剪业务字段。当前出站媒体使用链接，不声称已把二进制附件离线归档或原生重建投票/交互组件。

Signal 使用固定参考版本的纯解析模块；普通投送和模型输入共用路由过滤、逐字段文字替换及中文过滤。模型输入限制为 12000 字符，引用正文单独标为 `REPLY CONTEXT`，普通转发不把引用正文拼成当前正文。白名单按期权 underlyingTicker 或股票 ticker 比较；SPY/QQQ/SPX/IWM 按 CF 语义保留主目标，并额外复制到指数目标。成功解析结果先落盘，发送重试不重新请求模型。超过 15 分钟的旧 Signal 进入 `review`，普通消息仍可追赶积压。

## 投递记录、五次重试与定时补发

所有命中启用 route 的消息都会留下 `route_receipts`，包括已排队、关键词/中文拦截、不支持类型、安全拦截和 route 冲突的原因；冲突时保留各 route 的记录并告警。可发送的消息在同一事务内生成持久化 jobs，消息分段和各目标分别记录任务。每次发送前检查或 HTTP 尝试都记录在 `delivery_attempts`，包含开始/结束时间、结果、HTTP 状态和安全错误码。`sink_deliveries` 保留稳定 nonce、发送意图和成功后的 Discord message ID。

确定失败或发送前的失败统一由 SQLite 调度：首次失败后最多再重试 **5 次**，延迟为 **1、2、4、8、16 秒**；429 的服务端等待时间优先取较大值。这里是“首次尝试 + 5 次重试”，最多 6 次。模型 SDK 内部重试关闭，避免隐藏的重试层。网络等待不占用同步 sleep，也不在插件里增加路由或发送逻辑。

本轮耗尽后进入 `retry_wait`，保留完整记录，最早 5 分钟后补发。独立修复任务每 60 秒扫描到期项，增加 `recovery_cycles`、重置本轮计数并交回同一发送池。新任务使用实际入队时间作为到期时间，避免持续新增任务以 `due_at=0` 永久抢在已到期重试前面。进程重启后仍从数据库恢复。修复不会绕过暂停、当前 route 禁用/来源变更/多 route 冲突、当前 Signal 关闭、排除名单及防回流检查。

消息在接收入库时固定当时有效的配置快照，处理及任务继续使用该快照；接收后、规划前的 CF 更新也不会把消息改投新目标。等待首份配置或待修复 route 冲突的消息在安装有效配置后重新绑定；其他已绑定消息不改写。旧数据库缺少接收版本时，只能在迁移时绑定当时有效快照，不能还原过去未记录的版本。已有发送任务的固定快照保持原样。

如果请求已经发出但响应丢失、返回 5xx/408 或 ACK 不可信，结果是 `uncertain`，**不能把它当作确定失败直接补发**。定时对账优先通过 Bot nonce 找到已发送消息并标记成功；无法确认的记录持续保留、持续告警，由人工确认。Webhook 没有关联 nonce 时尤其不能自动声称“没发过”。对账采用持久化游标轮转，早期无法确认的记录不会饿死后面的记录。

这套机制保证每条已归档且命中 route 的消息有处理结论，每个发送任务有持久化追踪；不承诺 Discord 永远可用或外部发送恰好一次。被策略拦截、安全暂停、过期 Signal 和结果不确定的任务不会被定时扫描强行发送。

## 防自循环

`excludedServerIds: []` 是合法且支持的设置，防回流不依赖用户必须屏蔽整个 server。

- 候选配置拒绝同频道和跨频道/跨 server 的闭合路径，包含 Signal 主/指数目标。
- 目标发送前确认 Bot/webhook ID 和频道的 server/parent；不能确认则暂停该目标。当前采用保守策略：目标或其 parent 出现在任一启用来源频道中时暂停发送；sender-only 来源同 server 的目标也暂停。
- 外部发送前将身份、目标、nonce 和发送意图持久化到 `sender_history`、`sink_deliveries`，覆盖消息回流先于 HTTP 响应的情况。
- 已发 message ID，或已知身份/目的频道/nonce 命中时，标记 `self_generated`，业务投递及模型调用为零。
- 已知发送身份在本系统目的频道的模糊消息先进入 `safety_pending`。同一 Bot 在其他合法来源、其他第三方 Bot/webhook 不会被普遍屏蔽。
- 回复丢失、5xx 或连接结果不明确时任务进入 `uncertain`，不会盲目重发。用 Bot 最近消息中的 nonce 尝试对账；无法证实的记录持续保留，需要人工结合 Discord 实际消息处理。
- 所有历史恢复和旧任务执行前应用当前禁用/来源规则、暂停状态、排除名单及防回流检查；投递内容和目标使用固定快照。发送身份历史不因换 token 被删除。

不能承诺外部服务“恰好一次”。尤其 webhook 响应丢失且没有可关联 nonce 时，需要人工对账；程序优先阻止不确定结果继续形成回路，原始消息和工作记录不会删除。

## 运维和恢复

认证后的管理请求支持：

- `GET /api/status`：按状态统计消息、route 决策、投递、隔离原因和配置时间，并提供暂停状态、各类积压的最早接收时间、待执行到期时间、告警级别、提醒到期时间及发送失败次数。
- `GET /api/deliveries`：最近 100 条 route / 目标 / 分段任务及重试、补发、sink 状态，不返回消息正文或凭据。
- `GET /api/deliveries?messageKey=discord:<serverId>:<channelId>:<messageId>`：按原消息定位采集时间、当前处理状态、接收事件/hash 和关联投递；可查询已不在最近 100 条列表中的历史消息，也可检查未命中 route 的消息。
- `GET /api/deliveries?jobId=<64位任务ID>`：该任务最近 100 次发送尝试的详细记录。
- `POST /api/pause`：停止启动新业务任务，继续归档；已经发出的网络请求不能撤销。
- `POST /api/resume`：恢复调度，仍经过当前安全校验。

插件诊断接口使用 `pairingToken`，为空时无需认证，无需另行填写 `adminToken`：

- `GET /api/local/status`：返回 Signal-hub 标识、协议版本、暂停状态、缓存配置同步时间和不含凭据的路由摘要，不发消息。
- `POST /api/local/test`：请求体为 `{"routeId":"选定路由ID","requestId":"UUID"}`，为指定目标创建一个可追踪的测试投递；相同请求编号幂等，暂停、停用或排除来源时拒绝创建。
- `GET /api/local/tests/<requestId>`：查询该测试的任务状态、尝试次数及诊断代码。只有 `sent` 表示 Discord 已确认送达。

`pnpm --dir signal-hub backup` 使用 SQLite `VACUUM INTO` 创建一致快照，包含原始接收、配置、发送身份历史、发送意图及解析结果。备份放在 `var/backups`，应复制到独立磁盘。恢复时停止服务，以该快照替换主库；先保存原有主库和 WAL/SHM，再恢复整个状态，不要只恢复业务消息表。Native 未确认记录会重新上送并去重。

日志在 `var/logs` 下以日期和 10 MiB 文件段轮转，记录接收 ID/hash/大小、启动及故障事件，不打印正文和业务凭据。数据库中的 raw 是敏感审计数据，需要按照使用者自己的保留策略管理。

插件设置页另外显示本机持久化队列的待交接/暂存/隔离数量、连续交接失败次数、最早积压时间和本次进程最后 durable ACK 时间。LAN 模式应同时检查采集机器的这份状态与服务端 `/api/status`。收到错误 ACK 时原记录继续留在本机；400/409/413/422 保留到本机隔离区，服务端按安全原因记录隔离事件，不能静默当作成功。

## 钉钉通知

通知在服务端设置 `secrets.json` 的 `dingTalkWebhook` 或 `DINGTALK_WEBHOOK`，插件不持有业务告警凭据。正常收发和单次快速重试只记录日志及投递记录。配置同步偶发失败且仍有缓存时只记日志，持续超过 15 分钟才升级为配置过旧告警，不影响缓存转发。

| 情况 | 通知时机与重复频率 |
| --- | --- |
| 严重故障：投递结果不明、五次重试耗尽、Discord 拒绝、route 冲突、无有效配置、调度失败 | 创建后由每 10 秒运行的告警任务发送；新严重故障或级别升级可越过普通摘要冷却，严重通知之间至少间隔 30 秒 |
| 严重故障持续 | 每 5 分钟重复提醒，保留具体告警码，合并同一批问题 |
| 普通重要告警：配置过旧、补采覆盖降级、隔离记录、待人工处理等 | 首次进入下一次摘要；普通摘要至少间隔 5 分钟，单项持续问题每 30 分钟提醒 |
| 已通知故障恢复 | 汇总发送一次恢复通知；没有通知过的短暂故障不单独发“恢复”，故障再次出现时取消过时的恢复消息 |

每次最多合并 20 个到期状态，同一告警码去重；发送冷却、级别和提醒到期时间写入 SQLite，重启不会绕过限频。发送期间恢复或升级不会被旧 HTTP 响应错误覆盖。钉钉 HTTP 失败和 HTTP 200 但 `errcode` 非零均保留待发送，按 30/60/120/240/300 秒退避重试；通知失败不阻断消息投递，也不会用钉钉递归报告自身失败。钉钉不可用时及时性受该退避和外部服务可用性约束。

健康检查每 30 秒检查归档积压和已到期投递积压；等待超过一分钟会生成严重告警。暂停状态下不把主动暂停当作投递卡死。某个目标恢复不会替其他尚未恢复的任务解除告警。

进程用系统服务管理器常驻，并设置失败自动重启。`pnpm hub:watchdog` 作为独立进程运行，每 30 秒检查磁盘 heartbeat；heartbeat 超过 120 秒、缺失或损坏且连续三次检查异常后发严重通知，持续异常每 5 分钟提醒，恢复通知一次。其已通知状态与重试/限频保存到 `var/watchdog-state.json`，避免 watchdog 重启导致重复刷屏。磁盘满或状态无法持久化时仍尽力发送通知，当前进程继续以内存限频；此时 watchdog 自身重启后的通知去重无法保证。独立 watchdog 仍与主机共命运；主机完全宕机的告警需要部署在其他机器的外部监控。

channel-logger 服务保持原端口和数据库结构，可把运行目录指定为：

```sh
pnpm logger -- --dir /absolute/path/Vencord/signal-hub/var/channel-logger
```

在 `settings.json` 设置 `loggerDatabase` 为该库的绝对路径，并配置 `recoveryAccountId` 为实际采集账号 ID，即可每分钟只读扫描新增版本；先归档再更新独立 logger checkpoint。更名不移动或清空用户已存在的库，也不自动开启所有频道的 logger。

如需 Bot 历史补采，设置 `botHistoryEnabled: true` 和 `recoveryAccountId`。仅对显式来源频道读取，按固定时间上界向前分页，完成区间后推进 checkpoint，并保留 10 分钟重叠；不把实时最大 snowflake 当连续读取证明。Logger 和 Bot 补采独立调度、独立记录失败，logger 缺失或损坏不会阻断 Bot 补采。Bot 没有来源读取权限时提示覆盖降级，不能用目标发送权限推断来源读取权限。没有配置独立来源时会提示覆盖降级，不扩展插件范围或读取 Discord 用户 token。

当前人工工具只提供状态、暂停/恢复和全库备份；还没有提供一键释放 `safety_pending` / `uncertain`、跨主机 ACK 自动清理、完整附件下载缓存或 target profile 外观重建。这些记录不能通过删除库来“修复”；保留原始状态，由后续有审计记录的对账工具处理。

## 验证

```sh
pnpm test:signal-hub
pnpm test:ts
pnpm build --dev
pnpm buildStandalone --dev
pnpm buildWebStandalone --dev
pnpm generatePluginJson
```

测试使用临时库和 HTTP mocks，不访问真实 Discord/模型/钉钉目标。CF nullable 回归测试包含固定原始契约，并验证四类旧 payload 被拒绝、规范化后通过。生产端到端验收还需要真实 Bot 权限、模型凭据、可用来源和指定测试目标。
