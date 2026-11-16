# Signal-hub 与 transcribe 联合实机测试

日期：2026-11-16，Asia/Shanghai。本文件为上线测试准备与执行方案；私有频道、Go Live 串流和真实消息发送尚未执行。

## 当前已核查的状态

两个聊天实际使用同一个 checkout：`/Users/iondex/dev/Vencord`，当前分支为 `local`。transcribe 已提交到该分支，普通开发构建同时包含 forwarder、channel-logger、transcribe，无需合并另一个 worktree，也不要从两个 checkout 分别注入同一份 Discord。

| 项目 | 核查结果 |
| --- | --- |
| 本机 Node / pnpm | 22.13.1 / 9.6.0，满足当前服务要求 |
| Signal-hub | 尚未启动，49321 无监听，尚无业务数据库及配置缓存 |
| 服务 JSON | 已初始化，pairing/admin token 均为空；Bot、模型、CF、钉钉业务凭据均为空 |
| CF 配置 | 51 条 routes，其中 45 条启用；Signal 已启用，42 个目标 profiles；双读完整校验通过 |
| AudioTee 与进程解析工具 | 已安装且可执行，无需重装 |
| ASR 隧道 | 18000 已由现有 SSH 隧道监听，无需重复启动 |
| ASR 服务 | `/health` 返回 ready；WebSocket config 握手确认 PCM 输入，核查没有发送音频 |
| 离线回归 | Signal-hub 54 项服务测试和插件/logger 回归通过；本次追加 transcribe 34 项测试及其定向 lint 通过 |

离线测试、HTTP 健康和 WebSocket 握手不能替代实机验收：仍须验证当前 Discord 的观看动作、macOS 音频权限、实际音频进程以及目标频道权限。

## 首轮测试的范围与隔离

首先做 transcribe 面板预览和 Signal-hub 暂停投递下的采集；普通转发通过后再单独启用 Signal 解析与钉钉故障验收。

当前服务启动后会读取所有启用的 CF routes。它没有“只运行某一条测试 route”的本地开关，`/api/resume` 也会放行全部可执行积压。不要把配置一个测试目标理解为自动隔离已有的 45 条生产 route。

真实投递阶段采用以下任一隔离方式：

- 优先使用只加入测试 server 的采集账号，搭配仅能访问测试 server 的测试 Bot；确认测试消息只命中一个测试 route，且该 route 的 Signal 关闭。首次测试关闭 logger/Bot 历史补采。
- 使用独立测试 CF 配置源，仅包含测试 route，再将 `settings.json` 的 `cfBaseUrl` 指向它。当前没有创建该测试环境。

如果继续使用能收到生产消息的采集账号及当前生产 CF 配置，保持本地投递暂停，先完成采集和字幕预览。需要放行时另安排切换窗口，确认旧 Worker、其他 Remote 客户端或其他 Local 实例不会同时投递相同来源。不要为首轮测试随意修改共享生产 routes。

两类 token 为空只影响本地入口认证；Discord Bot、模型和钉钉仍需要各自业务凭据。

## 私有 server 测试场景规划

在用户控制的 server 新建私有分类 `signal-hub-test`，只允许测试角色和必要 Bot 查看。安排以下频道：

| 频道 | 类型 | 用途 |
| --- | --- | --- |
| `live-audio-test` | 普通语音频道 | 发布者加入并开启带声音的 Go Live |
| `transcript-test` | 文本频道 | 第二阶段接收 transcribe 逐句输出 |
| `forwarder-source-test` | 文本频道 | 发布者账号发送文字、附件、Embed 等测试输入 |
| `forwarder-sink-test` | 文本频道 | 测试 Bot 接收 Signal-hub 普通转发 |

分类中向 `@everyone` 关闭 View Channel，再对测试角色、测试 Bot 明确授权。发布者需要查看、连接和 Video 权限以开启 Go Live；采集账号需要查看及连接语音频道，以及查看、发送目标文本频道。首次不使用 Stage、线程或论坛，减少权限和状态变量。

使用两个不同账号、最好两台设备：

| 角色 | 工作 |
| --- | --- |
| 发布者 A | 在另一台机器的 Discord 桌面端手工加入语音频道，共享本地播放器窗口及声音；在 source 文本频道发送测试消息 |
| 采集者 B | 本机 macOS Discord + 当前 checkout 的 Vencord，运行三个插件；观看 A 的直播并采集已播放的声音 |
| 测试 Bot | Signal-hub 使用的发送身份，只授予测试目标及必要校验权限 |

transcribe 不会选择采集账号自己的直播，避免由同一个账号同时发布和采集。把视频附件上传到文本频道或仅在语音频道开麦，不会触发当前 Go Live 自动发现链路。

Discord 官方说明 Go Live 由语音频道的 Video 权限控制；Windows/macOS 桌面端支持共享应用音频。首次建议由桌面端共享播放器窗口，并先由采集端人工确认可以听到直播声音，再测试自动观看。参考：[Go Live and Screen Share](https://support.discord.com/hc/en-us/articles/360040816151-Go-Live-and-Screen-Share)。

先使用一段有对照文本的清晰英文对白，再加入中英文交替和电影片段。电影可用于背景音乐、多人对话、静音和长时间运行测试；识别准确率基线使用有对照文本的片段。

## 本机构建与服务准备

当前 checkout 已执行开发构建。变更源码后重新构建；首次注入或切换 checkout 才需运行注入器：

```sh
cd /Users/iondex/dev/Vencord
pnpm build --dev
pnpm inject
```

注入器按提示选择实际 Discord 安装。准备好插件设置后完整退出并重新打开 Discord，以同时加载 renderer 与 native helper。网页 Discord 不能代替这次 macOS 桌面采集验收。

Signal-hub 配置位于 `signal-hub/var/settings.json`、`signal-hub/var/secrets.json`。本机测试保持 host 为 `127.0.0.1`，pairing/admin token 均为 `""`。普通转发阶段配置测试 Bot；当前实现即使用 webhook 发送，也需要 Bot 读取目标频道来确认安全边界。模型 key 仅在 Signal 阶段需要。钉钉 webhook 配置在 server，首轮采集不必开启。

在启用插件 Local 前，启动服务并立即进入暂停投递状态：

```sh
# 终端一：前台运行
cd /Users/iondex/dev/Vencord
pnpm hub
```

```sh
# 终端二：暂停发送和模型工作，仍接收、归档及规划消息
curl --fail -X POST http://127.0.0.1:49321/api/pause
curl --fail http://127.0.0.1:49321/healthz
curl --fail http://127.0.0.1:49321/api/status
```

确认 `paused: true`、`configHash` 非空。首次尚无有效缓存时，CF 同步失败仍可归档，但不能据此验证路由；已有缓存后才验证断网续用。暂停无法撤回已经发出的 HTTP 请求，因此应在开始产生测试消息前设置。

ASR 当前可用，不要重复建立隧道。需要恢复时在独立终端运行：

```sh
ssh -N -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -L 127.0.0.1:18000:127.0.0.1:8000 anjie-solana-ct
```

```sh
curl --fail http://127.0.0.1:18000/health
```

channel-logger 的 HTTP 服务是可选的独立进程。需要一起验收频道日志时：

```sh
cd /Users/iondex/dev/Vencord
pnpm logger -- --dir /Users/iondex/dev/Vencord/signal-hub/var/channel-logger
```

在 channel-logger 设置页选择测试频道并匹配服务地址。它记录客户端实际加载的消息，不代表自动获取所有历史。首轮先不配置 Signal-hub 的 `loggerDatabase`、`recoveryAccountId` 和 `botHistoryEnabled`，避免把历史恢复和实时采集问题混在一起。

## 插件设置

forwarder：

| 字段 | 首轮值 |
| --- | --- |
| `mode` | Local |
| `localServerUrl` | `http://127.0.0.1:49321/forward` |
| `localRuntimeDirectory` | `/Users/iondex/dev/Vencord/signal-hub/var` |
| `localPairingToken` | 留空 |
| `excludedServerIds` | 保留已有排除项，与服务一致；不要排除测试来源 server |

transcribe：

| 字段 | 首轮值 |
| --- | --- |
| `channelIds` | 只填 `live-audio-test` 的语音频道 ID |
| `outputChannelId` | 第一阶段留空，仅在设置面板看结果；通过后填 `transcript-test` 文本频道 ID |
| `provider` | WhisperLiveKit |
| `serverUrl` | `ws://127.0.0.1:18000/asr` |
| `language` | 清晰英文用 English；中英文切换阶段用 Auto |
| `captureExecutable` | 留空，使用已安装默认工具 |
| `allowChannelSwitch` | false，避免移动现有语音会话 |
| `muteOnJoin` | true |
| `leaveOnEnd` | true |
| `includeSource` | true |

完整重启 Discord 后确认三个插件都可见。采集账号不要处于其他语音频道，取消耳聋，Discord 输出设备使用系统默认设备，直播音量和相关成员音量可听见。首次真实采集时按 macOS 提示授予系统音频录制权限；若 native helper 缺失，完整重启后再 Resume / Retry。

## 按阶段验收

1. **字幕面板预览，约 5 分钟。** A 开播，B 自动加入并观看，设置面板出现草稿及已确认句子；此时输出频道留空。核对开始时间、首句延迟、结束时末尾句是否保留。
2. **暂停投递下的采集。** A 在 source 频道发送带唯一编号的正文、Reply、附件、纯 Embed、长文本。确认 receipts 增长、原始数据落库、命中 route 的消息有投递记录；此阶段 `paused` 保持 true。
3. **隔离普通转发。** 按上面的账号或配置源方案隔离生产输入，确认只有一个明确测试 route、该 route 的 Signal 关闭，并配置测试 Bot。放行前用状态和投递 API 检查全部积压；只有确认不存在生产积压后才 resume。暂停状态下已规划的任务也会被放行。
4. **字幕发往测试频道。** 填写 `outputChannelId` 并重启，验证每句仅发送已确认文本、未发送草稿、重复说出的同一句仍分别发送、长句可安全拆分。
5. **稳定性测试，约 30–60 分钟。** 播放电影/多人对白片段；下播后重开、手动关闭观看、离开频道、切换监控频道，检查暂停和 Resume / Retry 行为。记录实际识别质量与延迟，不预设电影对白必须达到某个准确率。
6. **故障与恢复。** 停 Signal-hub 后继续发送少量编号文本，确认插件 pending 增长；恢复服务后确认 ACK 和投递记录补齐。确认已有有效 CF 缓存后再测试 CF 暂时不可达。ASR 隧道中断单独测试，确认错误可见、恢复后能继续识别。
7. **可选 Signal 和告警。** 普通链路通过后，再单独启用测试 route 的 Signal 并提供模型 key；钉钉只造一个可控故障及恢复，确认合并/限频。不要用循环错误请求测试机器人。

放行与检查命令：

```sh
curl --fail http://127.0.0.1:49321/api/status
curl --fail http://127.0.0.1:49321/api/deliveries
# 仅在已确认隔离且无生产积压后执行
curl --fail -X POST http://127.0.0.1:49321/api/resume
```

## 两条链路的边界

- forwarder 跳过采集账号自己发送的消息。transcribe 正是使用当前账号发字幕，因此同一客户端不会再次转发自己的字幕。这是预期的防自循环行为，不要为联合测试移除该过滤。
- 测试 forwarder 使用发布者 A 发出的独立文字消息。若以后需要“字幕再进入 Signal-hub”，需另行设计明确的入口或独立采集身份，并处理防循环与去重；当前不把这条链路列为已实现功能。
- transcribe 采集本 Discord 实例已播放的混音，包括直播声音、其他可听见成员和客户端声音；它没有分离单个说话人的音轨。测试期间只观看一路，减少其他声音。
- transcribe 不保存原始音频；字幕发送队列在内存中，关闭插件或客户端会取消待发内容，断流期间音频不承诺补录。Signal-hub 的持久化保证适用于其已接收的文本事件，不能用于推断语音断流零丢失。

## 观测与回退

每个用例记录采集账号、server/channel ID、测试编号、触发/归档/投递时间和 Discord message ID。以编号统计文本是否漏发、重发；字幕记录首句延迟、结束尾句、重复句去重是否正确、错误状态和恢复方式。

- forwarder 设置页：pending、ACK、quarantine、最近错误和 HTTP 存活。
- Signal-hub：`pnpm hub:status`、`/api/status`、`/api/deliveries`，以及 `signal-hub/var/logs/hub-*.jsonl`；`uncertain` 保留待对账，不通过删除数据库重发。
- transcribe 设置页：关注目标、阶段、草稿、最近十句、待发数量、成功发送数量及错误；必要时查看 Discord 开发者工具中的 transcribe 日志。

停止试运行时先暂停 Signal-hub，并在 transcribe 面板暂停跟随或关闭插件。需要回到 Remote 时只启用一个转发入口，设置后完整重启；暂停不清空持久化队列，恢复前仍需复核积压。

测试完成或切换阶段前执行 `pnpm hub:backup` 保存已创建的数据库备份。无需删除已有 JSON、spool 或数据库来回退。

开始真实执行前需要确定：发布者和采集者两个账号、测试 server、一个语音和三个文本频道 ID、隔离方式及测试 Bot 凭据。现有 ASR 使用当前隧道即可。
