import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync,mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { CaptureEnvelope, validateCapture, validateServiceUrl } from "../../../signal-hub/contracts/ingest";

export interface LocalOptions {
    url: string;
    runtimeDirectory: string;
    token: string;
}

function syncDirectory(directory: string) {
    const descriptor = openSync(directory, "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function atomicWrite(path: string, body: string) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
        try {
            writeFileSync(descriptor, body);
            fsyncSync(descriptor);
        } finally {
            closeSync(descriptor);
        }
        renameSync(temporary, path);
    } catch (error) {
        try { unlinkSync(temporary); } catch {}
        throw error;
    }
}

export function createLocalTransport(fetcher: typeof fetch = fetch) {
    let options: LocalOptions | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sending: Promise<void> | undefined;
    let failures = 0;
    let lastError: string | null = null;
    let active = false;
    let generation = 0;
    let clientId = "";
    let lastAttemptAt: number | null = null;
    let lastAcknowledgedAt: number | null = null;
    const uncommitted = new Map<string, { body: string; bytes: number; at: number; }>();
    let uncommittedBytes = 0;
    let persistenceError: string | null = null;
    let rejectedCaptures = 0;
    let lastOverflowReportAt = 0;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let cleaning: Promise<void> | undefined;
    let scheduledCleanupAt: number | null = null;
    let cleanupError: string | null = null;
    let cleanupState = { lastCutoff: 0, lastRunAt: null as number | null, removed: 0, freedBytes: 0, totalRemoved: 0 };

    function cleanupCutoff(now: number) {
        const date = new Date(now);
        date.setUTCHours(12, 0, 0, 0);
        return date.getTime() > now ? date.getTime() - 86_400_000 : date.getTime();
    }

    function cleanup(now = Date.now()) {
        if (cleaning) return cleaning;
        const cutoff = cleanupCutoff(now);
        if (!options || cleanupState.lastCutoff >= cutoff) return Promise.resolve();
        cleaning = cleanupAcknowledged(now, cutoff).finally(() => { cleaning = undefined; });
        return cleaning;
    }

    async function cleanupAcknowledged(now: number, cutoff: number) {
        try {
            let removed = 0;
            let freedBytes = 0;
            const directory = join(root(), "acked");
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
                if (!entry.isFile() || !/^[a-f\d]{64}\.json$/.test(entry.name)) continue;
                const path = join(directory, entry.name);
                const { size } = statSync(path);
                unlinkSync(path);
                removed++;
                freedBytes += size;
                if (removed % 100 === 0) await new Promise<void>(resolveCleanup => setImmediate(resolveCleanup));
            }
            syncDirectory(directory);
            const next = { lastCutoff: cutoff, lastRunAt: now, removed, freedBytes, totalRemoved: cleanupState.totalRemoved + removed };
            atomicWrite(join(root(), "cleanup-state.json"), JSON.stringify(next));
            syncDirectory(root());
            cleanupState = next;
            cleanupError = null;
            console.info(`[forwarder] Daily cleanup completed: ${removed} acknowledged captures, ${freedBytes} bytes`);
        } catch {
            if (!cleanupError) console.warn("[forwarder] Daily cleanup failed; unacknowledged captures remain untouched");
            cleanupError = "已交接副本清理失败，将自动重试。";
        }
    }

    function scheduleCleanup() {
        if (cleanupTimer) clearTimeout(cleanupTimer);
        if (!active) return;
        const delay = cleanupError ? 60_000 : Math.max(1000, cleanupCutoff(Date.now()) + 86_400_000 - Date.now());
        scheduledCleanupAt = Date.now() + delay;
        cleanupTimer = setTimeout(() => { void cleanup().finally(scheduleCleanup); }, delay);
        cleanupTimer.unref();
    }

    function root() {
        if (!options) throw new Error("Local transport is not configured");
        return join(options.runtimeDirectory, "spool", "forwarder");
    }

    function persistCapture(file: string, body: string) {
        const pending = join(root(), "pending");
        if (!existsSync(join(pending, file)) && !existsSync(join(root(), "acked", file))) atomicWrite(join(pending, file), body);
        syncDirectory(pending);
    }

    function persistenceFailed(error: unknown) {
        const raw = (error as { code?: unknown; })?.code;
        const code = typeof raw === "string" && /^[A-Z_]{1,40}$/.test(raw) ? raw : "WRITE_FAILED";
        if (!persistenceError) console.error(`[forwarder] Capture persistence failed (${code}); buffered captures remain in memory until disk recovers`);
        persistenceError = `消息尚未落盘（${code}），进程内暂存 ${uncommitted.size} 条；请恢复磁盘写入，暂勿退出 Discord。`;
    }

    async function flushUncommitted() {
        let recovered = 0;
        for (const [file, capture] of [...uncommitted]) {
            try { persistCapture(file, capture.body); } catch (error) { persistenceFailed(error); throw error; }
            uncommitted.delete(file);
            uncommittedBytes -= capture.bytes;
            recovered++;
            if (recovered % 25 === 0) await new Promise<void>(resolveWrite => setImmediate(resolveWrite));
        }
        if (recovered) console.info(`[forwarder] Capture persistence recovered: ${recovered} buffered captures committed to disk`);
        if (!uncommitted.size) persistenceError = null;
    }

    function quarantine(directory: string, file: string, reason: string, body: string) {
        if (existsSync(join(directory, "quarantine", file))) throw new Error("An existing quarantined capture needs review before replacing it");
        const reasons = join(directory, "quarantine-reasons");
        atomicWrite(join(reasons, `${file}.json`), JSON.stringify({ reason, hash: createHash("sha256").update(body).digest("hex"), at: Date.now() }));
        syncDirectory(reasons);
        renameSync(join(directory, "pending", file), join(directory, "quarantine", file));
        syncDirectory(join(directory, "quarantine"));
        syncDirectory(join(directory, "pending"));
    }

    function quarantineReason(file: string) {
        try {
            const value = JSON.parse(readFileSync(join(root(), "quarantine-reasons", `${file}.json`), "utf8"));
            if (typeof value?.reason === "string" && typeof value?.hash === "string") return value as { reason: string; hash: string; };
        } catch {}
        return { reason: "unknown", hash: "" };
    }

    function quarantineFiles() {
        return readdirSync(join(root(), "quarantine"), { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name);
    }

    function schedule(delay: number) {
        if (!active || timer) return;
        timer = setTimeout(() => {
            timer = undefined;
            void drain();
        }, delay);
        timer.unref();
    }

    async function drain() {
        if (!active || !options || sending) return sending;
        const currentGeneration = generation;
        const currentOptions = options;
        const directory = root();
        sending = (async () => {
            await flushUncommitted();
            const files = readdirSync(join(directory, "pending")).filter(file => file.endsWith(".json")).slice(0, 100);
            for (const file of files) {
                if (!active || generation !== currentGeneration) break;
                const path = join(directory, "pending", file);
                const body = readFileSync(path, "utf8");
                let event: CaptureEnvelope;
                try {
                    event = JSON.parse(body);
                    if (!validateCapture(event)) throw new Error("Invalid persisted capture");
                } catch {
                    quarantine(directory, file, "invalid_capture", body);
                    lastError = "持久化消息格式无效，已移至隔离区";
                    continue;
                }
                const hash = createHash("sha256").update(body).digest("hex");
                lastAttemptAt = Date.now();
                const response = await fetcher(currentOptions.url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", ...(currentOptions.token ? { Authorization: `Bearer ${currentOptions.token}` } : {}) },
                    body,
                    signal: AbortSignal.timeout(10_000),
                    redirect: "error",
                });
                if ([400, 409, 413, 422].includes(response.status)) {
                    quarantine(directory, file, `http_${response.status}`, body);
                    lastError = `Signal-hub 拒绝接收消息（HTTP ${response.status}），记录已保留在隔离区`;
                    continue;
                }
                if (!response.ok) throw new Error(`Signal-hub ingestion HTTP ${response.status}`);
                const ack = await response.json();
                if (ack.eventId !== event.eventId || ack.hash !== hash || ack.durable !== true) {
                    throw new Error("Invalid durable ingestion acknowledgement");
                }
                renameSync(path, join(directory, "acked", file));
                syncDirectory(join(directory, "acked"));
                syncDirectory(join(directory, "pending"));
                lastAcknowledgedAt = Date.now();
            }
            failures = 0;
            if (!readdirSync(join(directory, "quarantine")).length) lastError = null;
        })().catch(() => {
            failures++;
            lastError = uncommitted.size ? "部分消息尚未落盘，请先恢复磁盘写入，暂勿退出 Discord" : "交接给 Signal-hub 失败，待发送消息仍保存在磁盘中";
        }).finally(() => {
            sending = undefined;
            schedule(failures ? Math.min(30_000, 500 * 2 ** Math.min(failures, 6)) * (0.8 + Math.random() * 0.4) : 250);
        });
        return sending;
    }

    return {
        configure(input: LocalOptions) {
            validateServiceUrl(input.url);
            if (!isAbsolute(input.runtimeDirectory) || (input.token !== "" && input.token.length < 24)) {
                throw new Error("Use an absolute runtime directory; leave the pairing token empty or use at least 24 characters");
            }
            if (sending || cleaning) throw new Error("Wait for the current handoff and cleanup before changing transport settings");
            if (uncommitted.size && options && resolve(input.runtimeDirectory) !== options.runtimeDirectory) throw new Error("Commit buffered captures before changing the runtime directory");
            options = { ...input, runtimeDirectory: resolve(input.runtimeDirectory) };
            for (const name of ["pending", "acked", "quarantine", "quarantine-reasons"]) mkdirSync(join(root(), name), { recursive: true, mode: 0o700 });
            const cleanupPath = join(root(), "cleanup-state.json");
            cleanupError = null;
            cleanupState = { lastCutoff: cleanupCutoff(Date.now()), lastRunAt: null, removed: 0, freedBytes: 0, totalRemoved: 0 };
            try {
                if (existsSync(cleanupPath)) {
                    const saved = JSON.parse(readFileSync(cleanupPath, "utf8"));
                    if (![saved.lastCutoff, saved.removed, saved.freedBytes, saved.totalRemoved].every(value => Number.isFinite(value) && value >= 0)
                        || !(saved.lastRunAt === null || Number.isFinite(saved.lastRunAt))) throw new Error("Invalid cleanup state");
                    cleanupState = saved;
                } else {
                    atomicWrite(cleanupPath, JSON.stringify(cleanupState));
                    syncDirectory(root());
                }
            } catch {
                cleanupError = "无法读取或保存清理计划，消息交接继续运行。";
                console.warn("[forwarder] Cleanup state unavailable; message handoff remains active");
            }
            const clientPath = join(root(), "client-id");
            clientId = existsSync(clientPath) ? readFileSync(clientPath, "utf8").trim() : "";
            if (!/^[\da-f-]{36}$/.test(clientId)) {
                const identity = randomUUID();
                atomicWrite(clientPath, identity);
                syncDirectory(root());
                clientId = identity;
            }
            const entries = readdirSync(join(root(), "pending"));
            for (const file of entries.filter(name => name.endsWith(".tmp"))) {
                const path = join(root(), "pending", file);
                try {
                    const event = JSON.parse(readFileSync(path, "utf8"));
                    if (!validateCapture(event)) throw new Error("invalid capture");
                    const name = `${createHash("sha256").update(event.eventId).digest("hex")}.json`;
                    const destination = join(root(), "pending", name);
                    if (!existsSync(destination)) renameSync(path, destination);
                    else unlinkSync(path);
                } catch {
                    quarantine(root(), file, "invalid_capture", readFileSync(path, "utf8"));
                }
            }
            active = true;
            generation++;
            void cleanup().finally(scheduleCleanup);
            schedule(0);
            return { ok: true };
        },
        enqueue(event: CaptureEnvelope) {
            if (!active || !validateCapture(event)) throw new Error("Local transport is inactive or capture is invalid");
            event = { ...event, eventId: `${clientId}:${event.eventId}` };
            if (!validateCapture(event)) throw new Error("Invalid namespaced capture event");
            const filename = `${createHash("sha256").update(event.eventId).digest("hex")}.json`;
            if (!uncommitted.has(filename)) {
                const body = JSON.stringify(event);
                try { persistCapture(filename, body); } catch (error) {
                    const bytes = Buffer.byteLength(body);
                    if (uncommitted.size >= 256 || uncommittedBytes + bytes > 16 * 1024 * 1024) {
                        rejectedCaptures++;
                        persistenceFailed(error);
                        if (!lastOverflowReportAt || Date.now() - lastOverflowReportAt > 30_000) {
                            console.error(`[forwarder] Capture persistence retry buffer is full; ${rejectedCaptures} captures rejected before durable storage`);
                            lastOverflowReportAt = Date.now();
                        }
                        throw new Error("Capture persistence retry buffer is full; restore disk access immediately");
                    }
                    uncommitted.set(filename, { body, bytes, at: Date.now() });
                    uncommittedBytes += bytes;
                    persistenceFailed(error);
                }
            }
            schedule(0);
            return { ok: !uncommitted.has(filename), durable: !uncommitted.has(filename), queued: true, eventId: event.eventId };
        },
        retryQuarantined() {
            if (!active) throw new Error("Local transport is inactive");
            let requeued = 0;
            let held = 0;
            for (const file of quarantineFiles()) {
                const reason = quarantineReason(file);
                try {
                    const path = join(root(), "quarantine", file);
                    const body = readFileSync(path, "utf8");
                    const event = JSON.parse(body);
                    if (!["http_400", "http_413", "http_422"].includes(reason.reason)
                        || createHash("sha256").update(body).digest("hex") !== reason.hash || !validateCapture(event)
                        || `${createHash("sha256").update(event.eventId).digest("hex")}.json` !== file
                        || existsSync(join(root(), "pending", file)) || existsSync(join(root(), "acked", file))) { held++; continue; }
                    renameSync(path, join(root(), "pending", file));
                    syncDirectory(join(root(), "pending"));
                    syncDirectory(join(root(), "quarantine"));
                    requeued++;
                } catch { held++; }
            }
            if (requeued) {
                console.info(`[forwarder] Quarantine recovery requested: ${requeued} requeued, ${held} held for review`);
                schedule(0);
            }
            return { requeued, held };
        },
        status() {
            let queueError: string | null = null;
            const files = (folder: string) => {
                try { return options ? readdirSync(join(root(), folder)) : []; }
                catch { queueError = "无法读取本机队列目录，请检查磁盘和访问权限。"; return []; }
            };
            const pendingFiles = files("pending");
            const oldestPendingAt = pendingFiles.reduce<number | null>((oldest, file) => {
                try {
                    const modifiedAt = statSync(join(root(), "pending", file)).mtimeMs;
                    return oldest === null ? modifiedAt : Math.min(oldest, modifiedAt);
                } catch { return oldest; }
            }, null);
            const quarantineReasons = new Map<string, number>();
            for (const file of files("quarantine")) {
                const { reason } = quarantineReason(file);
                const safeReason = ["http_400", "http_409", "http_413", "http_422", "invalid_capture"].includes(reason) ? reason : "unknown";
                quarantineReasons.set(safeReason, (quarantineReasons.get(safeReason) ?? 0) + 1);
            }
            const acked = files("acked").filter(file => file.endsWith(".json")).length;
            return {
                active, pending: pendingFiles.filter(file => file.endsWith(".json")).length, staged: pendingFiles.filter(file => file.endsWith(".tmp")).length,
                acked, quarantined: [...quarantineReasons.values()].reduce((sum, total) => sum + total, 0),
                retryableQuarantined: ["http_400", "http_413", "http_422"].reduce((sum, reason) => sum + (quarantineReasons.get(reason) ?? 0), 0),
                quarantineReasons: [...quarantineReasons].map(([reason, total]) => ({ reason, total })),
                uncommitted: uncommitted.size, uncommittedBytes, oldestUncommittedAt: uncommitted.values().next().value?.at ?? null, persistenceError, rejectedCaptures, queueError,
                oldestPendingAt, lastAttemptAt, lastAcknowledgedAt, consecutiveFailures: failures, lastError,
                runtimeDirectory: options?.runtimeDirectory ?? null,
                lastCleanupAt: cleanupState.lastRunAt, lastCleanupCount: cleanupState.removed, lastCleanupBytes: cleanupState.freedBytes,
                totalCleaned: cleanupState.totalRemoved, nextCleanupAt: active ? scheduledCleanupAt : options ? cleanupState.lastCutoff + 86_400_000 : null, cleanupError,
            };
        },
        async stop() {
            active = false;
            generation++;
            if (timer) clearTimeout(timer);
            timer = undefined;
            if (cleanupTimer) clearTimeout(cleanupTimer);
            cleanupTimer = undefined;
            scheduledCleanupAt = null;
            await Promise.all([sending, cleaning]);
            if (uncommitted.size) console.error(`[forwarder] Transport stopped with ${uncommitted.size} memory-only captures; exiting Discord before disk recovery will lose them`);
        },
        drain,
        cleanup,
    };
}
