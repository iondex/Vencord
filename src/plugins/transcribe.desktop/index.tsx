import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { Paragraph } from "@components/Paragraph";
import { createSentenceDelivery } from "@plugins/transcribe.desktop/delivery";
import { transcriptionProviders } from "@plugins/transcribe.desktop/providers";
import { createTranscribeRuntime } from "@plugins/transcribe.desktop/runtime";
import { parseChannelIds } from "@plugins/transcribe.desktop/selection";
import type { StreamTarget } from "@plugins/transcribe.desktop/types";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, type PluginNative } from "@utils/types";
import { filters, findByPropsLazy, mapMangledModuleLazy } from "@webpack";
import { ApplicationStreamingStore, ChannelStore, MediaEngineStore, PermissionsBits, PermissionStore, RestAPI, RTCConnectionStore, SelectedChannelStore, useEffect, UserStore, useState, VoiceStateStore } from "@webpack/common";

const logger = new Logger("transcribe");
const Native = VencordNative.pluginHelpers.transcribe as PluginNative<typeof import("@plugins/transcribe.desktop/native")>;
const VoiceActions = findByPropsLazy("selectVoiceChannel", "selectChannel");
const AudioActions = findByPropsLazy("setSelfMute", "toggleSelfDeaf");
const StreamActions = mapMangledModuleLazy(['type:"STREAM_WATCH",streamKey:', "forceMultiple"], {
    watch: filters.byCode('type:"STREAM_WATCH",streamKey:', "forceMultiple"),
    close: filters.byCode('type:"STREAM_CLOSE",streamKey:', "canShowFeedback:")
});
let runtime: ReturnType<typeof createTranscribeRuntime> | undefined;
let delivery: ReturnType<typeof createSentenceDelivery> | undefined;
let monitor: ReturnType<typeof setInterval> | undefined;
let scanTimer: ReturnType<typeof setTimeout> | undefined;
let deliveryError = "";
let delivered = 0;

const validIds = (value: string) => parseChannelIds(value).every(id => /^\d{15,22}$/.test(id)) || "Enter Discord channel IDs, separated by commas or spaces";

const settings = definePluginSettings({
    channelIds: {
        type: OptionType.STRING,
        description: "Voice channel IDs to monitor, separated by commas or spaces; list priority first",
        default: "",
        isValid: validIds,
        restartNeeded: true
    },
    outputChannelId: {
        type: OptionType.STRING,
        description: "Optional Discord channel ID for one message per sentence; empty keeps results in this settings panel",
        default: "",
        isValid: value => typeof value === "string" && (!value.trim() || /^\d{15,22}$/.test(value.trim())) || "Enter one Discord channel ID",
        restartNeeded: true
    },
    provider: {
        type: OptionType.SELECT,
        description: "Realtime transcription backend",
        options: [{ label: "WhisperLiveKit", value: "whisperlivekit", default: true }],
        restartNeeded: true
    },
    serverUrl: {
        type: OptionType.STRING,
        description: "Transcription WebSocket URL; the deployed server is reached through the local SSH tunnel",
        default: "ws://127.0.0.1:18000/asr",
        isValid(value) {
            try { return ["ws:", "wss:"].includes(new URL(String(value)).protocol) || "Use a ws:// or wss:// URL"; }
            catch { return "Enter a valid WebSocket URL"; }
        },
        restartNeeded: true
    },
    language: {
        type: OptionType.SELECT,
        description: "Recognition language; use Auto for Chinese and English switching",
        options: [
            { label: "English", value: "en", default: true },
            { label: "Auto", value: "auto" },
            { label: "Chinese", value: "zh" }
        ],
        restartNeeded: true
    },
    captureExecutable: {
        type: OptionType.STRING,
        description: "AudioTee executable on this Mac; empty uses ~/.local/share/vencord-transcribe/audiotee",
        default: "",
        restartNeeded: true
    },
    allowChannelSwitch: {
        type: OptionType.BOOLEAN,
        description: "Allow automatic joining to move you out of another voice channel",
        default: false,
        restartNeeded: true
    },
    muteOnJoin: {
        type: OptionType.BOOLEAN,
        description: "Mute your microphone before automatically joining a new voice channel",
        default: true,
        restartNeeded: true
    },
    leaveOnEnd: {
        type: OptionType.BOOLEAN,
        description: "Leave after transcription ends, only if transcribe joined the voice channel for you",
        default: true,
        restartNeeded: true
    },
    includeSource: {
        type: OptionType.BOOLEAN,
        description: "Prefix sent sentences with the source channel and streamer names",
        default: true,
        restartNeeded: true
    }
});

function listStreams(channelIds: string[]): StreamTarget[] {
    const selfId = UserStore?.getCurrentUser()?.id;
    if (!selfId) return [];
    const streams = new Map<string, StreamTarget>();
    for (const channelId of channelIds) {
        const channel = ChannelStore.getChannel(channelId);
        if (!channel?.guild_id || !channel.isGuildVocal() || !PermissionStore.can(PermissionsBits.VIEW_CHANNEL, channel)) continue;
        const candidates = ApplicationStreamingStore.getAllApplicationStreamsForChannel(channelId).map(stream => stream.ownerId);
        const states = VoiceStateStore.getVoiceStatesForChannel(channelId);
        for (const state of Object.values(states)) if (state.selfStream) candidates.push(state.userId);
        for (const ownerId of candidates) {
            if (ownerId === selfId || states[ownerId]?.selfStream === false) continue;
            const key = `guild:${channel.guild_id}:${channelId}:${ownerId}`;
            streams.set(key, { key, guildId: channel.guild_id, channelId, ownerId, streamType: "guild" });
        }
    }
    return [...streams.values()];
}

function waitUntil(predicate: () => boolean, signal: AbortSignal, description: string) {
    return new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 20_000;
        let timer: ReturnType<typeof setTimeout>;
        function finish(error?: Error) {
            clearTimeout(timer);
            signal.removeEventListener("abort", cancelled);
            if (error) reject(error);
            else resolve();
        }
        function cancelled() { finish(new Error("Joining was cancelled")); }
        function check() {
            try {
                if (signal.aborted) cancelled();
                else if (predicate()) finish();
                else if (Date.now() >= deadline) finish(new Error(`Timed out ${description}`));
                else timer = setTimeout(check, 200);
            } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
        }
        signal.addEventListener("abort", cancelled, { once: true });
        check();
    });
}

function outputChannel(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel || ![0, 2, 5, 10, 11, 12, 13].includes(channel.type)) throw new Error("The output channel is not an accessible server message channel");
    const permission = channel.isThread() ? PermissionsBits.SEND_MESSAGES_IN_THREADS : PermissionsBits.SEND_MESSAGES;
    if (!PermissionStore.can(PermissionsBits.VIEW_CHANNEL, channel) || !PermissionStore.can(permission, channel)) throw new Error("You do not have permission to send to the output channel");
    return channel;
}

async function joinStream(target: StreamTarget, signal: AbortSignal, config: typeof settings.store) {
    const channel = ChannelStore.getChannel(target.channelId);
    if (!channel || !PermissionStore.can(PermissionsBits.CONNECT, channel)) throw new Error("You cannot connect to the monitored voice channel");
    if (MediaEngineStore.isSelfDeaf()) throw new Error("Disable deafen to receive stream audio, then resume transcribe");
    const currentChannel = SelectedChannelStore.getVoiceChannelId();
    if (currentChannel && currentChannel !== target.channelId && !config.allowChannelSwitch) throw new Error("Already in another voice channel; leave it or enable automatic channel switching");
    const { watch, close } = StreamActions;
    if (typeof watch !== "function" || typeof close !== "function") throw new Error("Discord's stream actions changed; transcribe needs an adapter update");
    const selfId = UserStore.getCurrentUser().id;
    const wasWatching = ApplicationStreamingStore.getViewerIds(target.key).includes(selfId);
    const joined = currentChannel !== target.channelId;
    let startedWatching = false;
    const cleanup = () => {
        try { if (startedWatching) close(target.key, false); }
        finally {
            if (joined && config.leaveOnEnd && SelectedChannelStore.getVoiceChannelId() === target.channelId) VoiceActions.selectVoiceChannel(null);
        }
    };
    try {
        if (joined) {
            if (config.muteOnJoin) AudioActions.setSelfMute("default", true, false);
            VoiceActions.selectVoiceChannel(target.channelId);
        }
        await waitUntil(() => SelectedChannelStore.getVoiceChannelId() === target.channelId && RTCConnectionStore.isConnected(), signal, "connecting to voice");
        if (!wasWatching) {
            watch(target, { forceMultiple: false, noFocus: true });
            startedWatching = true;
        }
        await waitUntil(() => ApplicationStreamingStore.getViewerIds(target.key).includes(selfId), signal, "subscribing to the live stream");
        return cleanup;
    } catch (error) {
        cleanup();
        throw error;
    }
}

function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { void runtime?.scan(); }, 200);
}

function TranscribeStatus() {
    const [snapshot, setSnapshot] = useState(() => runtime?.status());
    const [queue, setQueue] = useState(0);
    const [sent, setSent] = useState(delivered);
    const [error, setError] = useState(deliveryError);
    useEffect(() => {
        const timer = setInterval(() => {
            setSnapshot(runtime?.status());
            setQueue(delivery?.pending() ?? 0);
            setSent(delivered);
            setError(deliveryError);
        }, 500);
        return () => clearInterval(timer);
    }, []);
    return (
        <Flex flexDirection="column" gap="8px">
            <Paragraph>{snapshot?.phase ?? "stopped"}: {snapshot?.detail ?? "Enable transcribe to begin"}</Paragraph>
            <Paragraph>Sentences: {snapshot?.sentences ?? 0} · Sent: {sent} · Queued: {queue}</Paragraph>
            {error && <Paragraph>Delivery error: {error}</Paragraph>}
            <Flex gap="8px">
                <Button disabled={!runtime} onClick={() => void runtime?.pause()}>Pause</Button>
                <Button disabled={!runtime} onClick={() => { deliveryError = ""; delivery?.retry(); void runtime?.resume(); }}>Resume / Retry</Button>
            </Flex>
            {snapshot?.draft && <Paragraph>Draft: {snapshot.draft}</Paragraph>}
            {snapshot?.recent.map((text, index) => <Paragraph key={index}>{text}</Paragraph>)}
            <Paragraph>Captures this Discord instance's playback mix on the default macOS output device. Initial setup: bash scripts/transcribe/setup-capture.sh</Paragraph>
        </Flex>
    );
}

export default definePlugin({
    name: "transcribe",
    description: "Follow Go Live streams in configured voice channels and transcribe sentences to an optional Discord channel.",
    authors: [Devs.iondex],
    tags: ["Voice", "Utility"],
    enabledByDefault: true,
    settings,
    settingsAboutComponent: ErrorBoundary.wrap(TranscribeStatus, { noop: false }),

    start() {
        const config = { ...settings.store };
        const channelIds = parseChannelIds(config.channelIds);
        const targetChannelId = config.outputChannelId.trim();
        const provider = transcriptionProviders[config.provider];
        delivered = 0;
        deliveryError = "";
        let controller: ReturnType<typeof createTranscribeRuntime>;
        const sender = delivery = createSentenceDelivery({
            async send(message) {
                outputChannel(message.channelId);
                const result = await RestAPI.post({
                    url: `/channels/${message.channelId}/messages`,
                    body: { content: message.content, tts: false, allowed_mentions: { parse: [], replied_user: false }, nonce: message.nonce, enforce_nonce: true }
                });
                if (!result.ok) throw Object.assign(new Error(`Discord returned ${result.status}`), { status: result.status });
                if (runtime === controller) delivered++;
            },
            onError(error) {
                if (runtime !== controller) return;
                deliveryError = error.message;
                logger.error(error);
                void controller?.pause();
            }
        });
        runtime = controller = createTranscribeRuntime({
            channelIds,
            listStreams: () => listStreams(channelIds),
            currentChannelId: () => SelectedChannelStore.getVoiceChannelId(),
            isWatching: target => ApplicationStreamingStore.getViewerIds(target.key).includes(UserStore.getCurrentUser().id),
            voiceConnected: () => RTCConnectionStore.isConnected(),
            async prepare() {
                if (!Native?.prepareCapture) throw new Error("Fully quit and restart Discord to load transcribe's native capture helper");
                if (!provider) throw new Error("Unknown transcription provider");
                if (provider.audioFormat.sampleRate !== 16_000 || provider.audioFormat.channels !== 1 || provider.audioFormat.encoding !== "pcm_s16le") throw new Error("The provider must accept 16kHz mono PCM16 audio");
                if (targetChannelId) outputChannel(targetChannelId);
                await Native.prepareCapture({ executable: config.captureExecutable });
            },
            join: (target, signal) => joinStream(target, signal, config),
            createTranscriber: callbacks => provider.createSession({ url: config.serverUrl, language: config.language, ...callbacks }),
            startCapture: id => Native.startCapture(id, { executable: config.captureExecutable }),
            readCapture: id => Native.readCapture(id),
            stopCapture: id => Native.stopCapture(id),
            onSentence(sentence, target, sessionId) {
                const channelName = ChannelStore.getChannel(target.channelId)?.name ?? target.channelId;
                const user = UserStore.getUser(target.ownerId);
                const name = user?.globalName ?? user?.username ?? target.ownerId;
                const prefix = config.includeSource ? `[${channelName} / ${name}] `.slice(0, 200) : "";
                sender.enqueue(sentence, sessionId, targetChannelId, prefix);
            },
            onError: error => logger.error(error)
        });
        void runtime.start();
        monitor = setInterval(() => { void runtime?.scan(); }, 1000);
    },

    stop() {
        clearTimeout(scanTimer);
        clearInterval(monitor);
        delivery?.stop();
        const stopping = runtime;
        runtime = undefined;
        delivery = undefined;
        void stopping?.stop();
    },

    flux: {
        CONNECTION_OPEN: scheduleScan,
        VOICE_STATE_UPDATES: scheduleScan,
        STREAM_CREATE: scheduleScan,
        STREAM_UPDATE: scheduleScan,
        STREAM_DELETE: scheduleScan,
        STREAM_CLOSE: scheduleScan,
        VOICE_CHANNEL_SELECT: scheduleScan
    }
});
