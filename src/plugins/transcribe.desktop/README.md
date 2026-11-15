# transcribe

本机 Discord/Vencord 的私有桌面插件。监控配置的语音频道，发现 Go Live 后自动加入并观看，将实时识别结果按句发送到可选的固定 Discord 频道。未配置输出频道时，只在插件设置面板显示草稿及最近十句。

## 使用

1. 安装本机采集组件：`bash scripts/transcribe/setup-capture.sh`。已在当前 Mac 安装到 `~/.local/share/vencord-transcribe/`；安装过程不采集音频。首次真正转写时，按 macOS 提示允许 Discord/采集程序录制系统音频。
2. 保持服务器隧道运行：`ssh -N -L 127.0.0.1:18000:127.0.0.1:8000 anjie-solana-ct`。现有隧道可继续使用，无需重复启动。
3. 在仓库执行 `pnpm build --dev`，完全退出并重新启动已注入该构建的 Discord。此仓库的构建白名单已纳入 `src/plugins/transcribe.desktop`，未放开其他插件。
4. 在 Vencord → Plugins → `transcribe` 中填写 `channelIds`，以逗号、空格或换行分隔。可选填写一个 `outputChannelId`。修改配置后重新加载 Discord。
5. 保持 `provider=WhisperLiveKit`，`serverUrl=ws://127.0.0.1:18000/asr`。英文为主用 `English`；中英文切换用 `Auto`。

默认静音麦克风后加入新频道，不打断你正在其他频道进行的语音。若需要自动切过去，开启 `allowChannelSwitch`。请取消耳聋，并确保直播、频道成员及 Discord 的输出音量可以听见。

## 跟随与发送行为

- 启动、重连、直播及语音状态变化时检查频道，另有每秒一次的状态检查。只使用当前账号可见的状态与权限，不访问隐藏频道。
- 一次转写一路。多个频道开播时按配置顺序选择；同一频道多人开播时按用户 ID 排序选择，已选直播持续到结束。
- 复用当前客户端的入频道、观看和关闭观看动作；不模拟屏幕坐标点击。观看动作以 `STREAM_WATCH` 和 `forceMultiple` 定位；Discord 更新后若接口变化，设置面板会显示错误。
- 手动切换频道、离开语音或关闭仍在直播的观看窗口后暂停跟随，避免立刻拉回。点击设置面板的 `Resume / Retry` 恢复。
- 下播时停止采集，等待识别后端的最后结果，然后继续监控。只在插件主动加入且 `leaveOnEnd` 开启时离开频道；不会主动退出你原先就加入的频道。
- 仅处理 ASR 已确认文本，不发送草稿。按中英文句子边界及服务端 VAD 停顿断句。末尾尚无下一句时等待停顿确认；超长句拆成符合 Discord 长度限制的消息。
- WhisperLiveKit 的 `lines` 是完整状态快照。按时间段 ID 和已发送字符位置去重；不同时间说出的相同句子会分别发送。
- 通过当前 Discord 账号发送；发送前检查目标频道与权限，禁用消息提及和 TTS。队列串行发送，重试复用相同 nonce，并使用 Discord 的 `enforce_nonce` 防止短期重试重复发消息。
- 发送失败会暂停跟随并保留内存中的待发队列；修复问题后点 `Resume / Retry`。插件关闭后取消待发消息，不持久保存音频和待发队列。已经在网络上的一条请求可能仍会完成。
- 音频连接错误等待 30 秒后重试。服务器不可达时检查 SSH 隧道及 `caption.service`。两端音频缓冲均限制为约五秒，避免网络卡顿后无限积压。

## 采集范围

目前采集适配器仅实现 macOS，复用 AudioTee 的 Core Audio taps。辅助程序只枚举音频进程，不录音；插件将 Discord 主进程及其子进程对应的音频进程交给 AudioTee，输出 16kHz、单声道、PCM16 小端音频。

采集的是这个 Discord 实例在系统默认输出设备上的播放混音，包括所观看直播与可听见的频道语音，不是解密前的网络包，也不是单独某个用户的麦克风轨道。请让 Discord 使用系统默认输出设备；单路字幕建议只观看一路直播。消息前缀中的主播名标识关注的直播，不代表识别出了说话人身份。多实例、非默认设备和独立音轨需要另做采集适配。

AudioTee 固定为提交 `56ac954369a09318e46b88a6eec33c2d2b0d32a3`，安装时校验下载归档 SHA-256。上游：<https://github.com/makeusabrew/audiotee>。

## 更换识别后端

识别协议与 Discord 控制、采集、断句和消息发送分离：

- `types.ts` 的 `TranscriptionProvider` 声明音频格式并创建 `TranscriptionSession`。
- 会话实现 `connect()`、`sendAudio(pcm)`、`finish()`、`abort()`。`finish()` 必须等最后结果到达；`abort()` 必须释放连接并取消等待。
- `onTranscript` 返回规范化的 `TranscriptUpdate`：已确认的 `segments` 加未确认的 `draft`。分段 ID 在同一会话内稳定；已确认文本只能追加，不可改写已发布部分。`final=true` 表示该语音段已结束，可发送末尾没有标点的文本。
- 新适配器加入 `providers/index.ts` 的注册表，并加入设置中的 provider 选项。其他模块无需了解具体供应商协议。适配器应转换为当前采集层的 16kHz mono PCM16 格式。
- `providers/whisperLiveKit.ts` 实现本地部署协议：先等待 PCM 配置，发送二进制音频，解析 `lines` / `buffer_transcription`；结束时发送空二进制帧并等 `ready_to_stop`。

## 验证

```sh
pnpm test:transcribe
pnpm test:ts
pnpm build --dev
pnpm exec oxlint src/plugins/transcribe.desktop scripts/transcribe
pnpm exec tsx scripts/transcribe/smoke.ts /path/to/16khz-mono-pcm16.wav
```

单元测试使用虚拟直播、虚拟采集进程和虚拟发送器，不加入真实频道、不采集麦克风、不发送 Discord 消息。smoke 只向配置的 ASR 发送明确提供的测试文件，也不会发送 Discord 消息。
