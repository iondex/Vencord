# 参考代码与语音可行性记录

## 固定参考版本

参考 clone 在 `/Users/iondex/dev/forwarder-signal-hub-reference`，checkout 为 `signal-hub`。

| ref | commit | 用途 |
| --- | --- | --- |
| `origin/signal-hub` | `6e240f034bb2ff6e6a105e73057e1a89d8d3706e` | 旧 relay/signal 双 Worker、历史 Node 实验 |
| `origin/forwarder` | `e0305df72b1808d31e31c971e8e9c094caae25b3` | 新单 Worker/D1 管理接口与路由语义 |

`signal-hub/src/reference/signal-model.ts`、`signal-schema.ts` 来自新分支 `apps/forwarder/src`，保留解析规则并使用独立服务的 OpenAI/Zod 依赖。测试中的 `fixtures/cf-contract` 是该 commit 的 `packages/contracts/src/{payload,types}.ts`，用于验证真实 CF 契约，避免在测试中重新发明一个更宽松的 schema。除 import 排序外未重新设计这些参考模块。

2026-11-15 复审核对了旧分支 `packages/contracts/src/discord/forwarderPayload.ts` 与新分支 `packages/contracts/src/payload.ts`：除类型 import 路径外完全相同，单份冻结 schema 同时代表这两个固定版本。`/routes`、`/api/admin/signal-config`、`/api/admin/target-channel-profiles` 的读取路径、分页形状和 snake_case route 字段也相同；保留一个适配器即可。两分支都按 underlyingTicker 做期权白名单，并在主 Signal 目标之外额外复制 SPY/QQQ/SPX/IWM 到指数目标。本地版本已据此修正，详见 `signal-hub-review.md`。

参考版本所有实际执行仍迁移为本地 SQLite 事务/队列；没有把 Worker waitUntil 或 Miniflare 包装当作生产持久化。

## 语音探索结论（2026-11-15）

本轮完成静态代码定位与官方约束核实，没有自动加入真实直播、录制任何会话或承诺已取得桌面接收音轨。语音功能保持独立研究阶段，不增加第三个插件、不阻塞文本转发。

| 环节 | 本仓库证据 | 下一步验证 |
| --- | --- | --- |
| 发现 Go Live | `ApplicationStreamingStore` 导出 `getAllActiveStreamsForChannel`、`getActiveStreamForUser`、`getRTCStream`；`streamerModeOnStream` 使用 `STREAM_CREATE` / `STREAM_DELETE` | 在授权账号可见的目标频道中比对 store 与实际界面，处理启动时已有 stream、删除事件和重连 |
| 进入语音频道 | `userVoiceShow/components.tsx` 使用 `findByPropsLazy("selectVoiceChannel", "selectChannel")` | 进入指定授权频道，验证权限、现有通话优先和手动退出不自动抢回 |
| 观看直播 | streaming store 有 streamKey/viewer/RTC 状态 | 尚未验证稳定的观看 action；通过真实客户端模块定位确认，不能猜 action 名后直接 dispatch |
| 取得解码音频 | `volumeBooster` 在 Web/Vesktop 路径使用 `MediaStream` 和 `createMediaStreamSource` | 确认 Discord Electron native 音频与 WebRTC 音轨是否可达；现有 Web 路径不能证明 native 也可用 |
| 录音 | `voiceMessages` 有桌面/浏览器录制实现 | 那是麦克风录制，不能把它当接收对方音频的证据；需要证明远端音轨真实接收、设备切换与静音语义 |
| 实时转录 | 文本服务已有运行目录、持久化和任务隔离结构 | 单独设计音频 chunk/session/seq、ACK、背压、断点、ASR partial/final、speaker/timecode；先录制验证再接模型 |

建议执行顺序：只读发现 → 手动 join/watch → 30 秒可听录音 → 分段落盘和崩溃恢复 → 流式 ASR → 自动进入策略。整个过程要求指定 server/channel/user，保留人工操作优先级，排除名单统一，断连冷却，默认关闭。服务端承担音频落盘/转录/重试，插件仅承担已验证的可见状态与音轨桥接。

协议方案需要核对当前 DAVE/E2EE 支持，不能假设旧的音频接收库可以工作。候选是授权客户端解码后的音轨桥接，或明确支持当前语音协议的 Bot 接入；不绕过加密和访问权限。本轮外部文档抓取未能取得可验证正文，因此不引用具体强制切换日期，也不把某个接收库记为已经验证可用。

官方来源：

```text
https://docs.discord.com/developers/topics/voice-connections
https://github.com/discord/dave-protocol
```

正式桌面能力测试前读取 `.skills/discord-session.md`，按实际客户端版本留下发现、加入、音轨、录制和中断恢复的证据。本轮没有运行该现场实验，自动观看和录音不能计为已实现能力。
