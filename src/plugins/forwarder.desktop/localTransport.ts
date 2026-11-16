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
        writeFileSync(descriptor, body);
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
    renameSync(temporary, path);
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

    function root() {
        if (!options) throw new Error("Local transport is not configured");
        return join(options.runtimeDirectory, "spool", "forwarder");
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
                    renameSync(path, join(directory, "quarantine", file));
                    syncDirectory(join(directory, "quarantine"));
                    syncDirectory(join(directory, "pending"));
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
                    renameSync(path, join(directory, "quarantine", file));
                    syncDirectory(join(directory, "quarantine"));
                    syncDirectory(join(directory, "pending"));
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
            lastError = "交接给 Signal-hub 失败，待发送消息仍保存在磁盘中";
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
            if (sending) throw new Error("Wait for the current handoff before changing transport settings");
            options = { ...input, runtimeDirectory: resolve(input.runtimeDirectory) };
            for (const name of ["pending", "acked", "quarantine"]) mkdirSync(join(root(), name), { recursive: true, mode: 0o700 });
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
                    renameSync(path, join(root(), "quarantine", file));
                }
            }
            active = true;
            generation++;
            schedule(0);
            return { ok: true };
        },
        enqueue(event: CaptureEnvelope) {
            if (!active || !validateCapture(event)) throw new Error("Local transport is inactive or capture is invalid");
            event = { ...event, eventId: `${clientId}:${event.eventId}` };
            if (!validateCapture(event)) throw new Error("Invalid namespaced capture event");
            const filename = `${createHash("sha256").update(event.eventId).digest("hex")}.json`;
            if (!existsSync(join(root(), "pending", filename)) && !existsSync(join(root(), "acked", filename))) {
                atomicWrite(join(root(), "pending", filename), JSON.stringify(event));
                syncDirectory(join(root(), "pending"));
            }
            schedule(0);
            return { ok: true, queued: true, eventId: event.eventId };
        },
        status() {
            const count = (folder: string) => options ? readdirSync(join(root(), folder)).filter(file => file.endsWith(".json")).length : 0;
            const pendingFiles = options ? readdirSync(join(root(), "pending")) : [];
            const oldestPendingAt = pendingFiles.reduce<number | null>((oldest, file) => {
                const modifiedAt = statSync(join(root(), "pending", file)).mtimeMs;
                return oldest === null ? modifiedAt : Math.min(oldest, modifiedAt);
            }, null);
            return {
                active, pending: count("pending"), staged: pendingFiles.filter(file => file.endsWith(".tmp")).length,
                acked: count("acked"), quarantined: options ? readdirSync(join(root(), "quarantine")).length : 0,
                oldestPendingAt, lastAttemptAt, lastAcknowledgedAt, consecutiveFailures: failures, lastError,
                runtimeDirectory: options?.runtimeDirectory ?? null,
            };
        },
        async stop() {
            active = false;
            generation++;
            if (timer) clearTimeout(timer);
            timer = undefined;
            await sending;
        },
        drain,
    };
}
